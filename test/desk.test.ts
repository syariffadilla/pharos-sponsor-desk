import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, toHex, concat, type Hex } from 'viem';
import { SponsorDesk } from '../src/desk.js';
import { Ledger } from '../src/ledger.js';
import { buildSponsorRequest, executeDigest } from '../src/request.js';
import { buildDailyReport, reportToHtml, reportToMarkdown } from '../src/report.js';
import { validatePolicy } from '../src/policy.js';
import type { Call } from '../src/types.js';
import { CHAIN_ID, EXECUTOR, GUESTBOOK, MockChain, OTHER, testPolicy, user } from './helpers.js';

const gb = parseAbi(['function checkIn(string note)', 'function setMotto(string m)']);
const checkIn = (note = 'gm'): Call => ({ to: GUESTBOOK, value: '0', data: encodeFunctionData({ abi: gb, functionName: 'checkIn', args: [note] }) });
const setMotto = (): Call => ({ to: GUESTBOOK, value: '0', data: encodeFunctionData({ abi: gb, functionName: 'setMotto', args: ['x'] }) });

const T0 = Date.UTC(2026, 9, 26, 3, 0, 0);

async function req(chain: MockChain, i: number, calls: Call[], extra: Partial<Parameters<typeof buildSponsorRequest>[0]> = {}, nowMs = T0) {
  const u = user(i);
  const delegated = (await chain.getCode(u.address)) !== '0x';
  return buildSponsorRequest({
    user: u,
    chainId: CHAIN_ID,
    executor: EXECUTOR,
    calls,
    executorNonce: await chain.readExecutorNonce(u.address),
    accountTxNonce: await chain.getTxCount(u.address),
    needsAuthorization: !delegated,
    nowSec: Math.floor(nowMs / 1000),
    ...extra,
  });
}

function setup(policy = testPolicy(), nowMs = T0) {
  const chain = new MockChain();
  const ledger = Ledger.memory();
  let now = nowMs;
  const desk = new SponsorDesk(policy, chain, ledger, { now: () => now });
  return { chain, ledger, desk, setNow: (t: number) => (now = t) };
}

describe('allowlist + static policy', () => {
  it('rejects a target that is not allowlisted, and sends nothing', async () => {
    const { chain, desk } = setup();
    const r = await desk.handle(await req(chain, 0, [{ ...checkIn(), to: OTHER }]));
    expect(r.decision).toBe('rejected');
    expect(r.reasons[0].code).toBe('NOT_ALLOWLISTED_TARGET');
    expect(chain.sent).toHaveLength(0);
  });
  it('rejects a method that is not allowlisted on an allowlisted target', async () => {
    const { chain, desk } = setup();
    const r = await desk.handle(await req(chain, 0, [setMotto()]));
    expect(r.reasons.map((x) => x.code)).toEqual(['NOT_ALLOWLISTED_METHOD']);
    expect(chain.sent).toHaveLength(0);
  });
  it('rejects native value transfers by default', async () => {
    const { chain, desk } = setup();
    const r = await desk.handle(await req(chain, 0, [{ ...checkIn(), value: '1' }]));
    expect(r.reasons.map((x) => x.code)).toContain('VALUE_NOT_ALLOWED');
  });
  it('rejects expired and too-far deadlines, wrong chain, too many calls', async () => {
    const { chain, desk } = setup();
    const expired = await req(chain, 0, [checkIn()], { nowSec: Math.floor(T0 / 1000) - 5000, ttlSec: 10 });
    expect((await desk.handle(expired)).reasons[0].code).toBe('EXPIRED');
    const far = await req(chain, 0, [checkIn()], { ttlSec: 99999 });
    expect((await desk.handle(far)).reasons[0].code).toBe('DEADLINE_TOO_FAR');
    const wrong = { ...(await req(chain, 0, [checkIn()])), chainId: 1 };
    expect((await desk.handle(wrong)).reasons[0].code).toBe('WRONG_CHAIN');
    const many = await req(chain, 1, [checkIn(), checkIn(), checkIn(), checkIn(), checkIn()]);
    expect((await desk.handle(many)).reasons.map((x) => x.code)).toContain('TOO_MANY_CALLS');
  });
  it('validates policy files', () => {
    expect(() => validatePolicy({ ...testPolicy(), allowlist: [] })).toThrow();
    expect(() => validatePolicy(testPolicy())).not.toThrow();
  });
});

describe('signatures + EIP-7702 authorization', () => {
  it('rejects a request whose signature is from another key', async () => {
    const { chain, desk } = setup();
    const r1 = await req(chain, 0, [checkIn()]);
    const forged = { ...r1, account: user(1).address };
    const r = await desk.handle(forged);
    expect(r.reasons[0].code).toBe('BAD_SIGNATURE');
  });
  it('rejects a tampered call (signature no longer matches)', async () => {
    const { chain, desk } = setup();
    const r1 = await req(chain, 0, [checkIn('a')]);
    const r = await desk.handle({ ...r1, calls: [checkIn('b')] });
    expect(r.reasons[0].code).toBe('BAD_SIGNATURE');
  });
  it('requires an authorization for a not-yet-delegated account', async () => {
    const { chain, desk } = setup();
    const r1 = await req(chain, 0, [checkIn()], { needsAuthorization: false });
    expect((await desk.handle(r1)).reasons[0].code).toBe('NEEDS_AUTHORIZATION');
  });
  it('rejects an authorization that delegates somewhere else', async () => {
    const { chain, desk } = setup();
    const r1 = await req(chain, 0, [checkIn()], { executor: OTHER });
    expect((await desk.handle(r1)).reasons[0].code).toBe('BAD_AUTHORIZATION');
  });
  it('rejects an authorization signed by a different key', async () => {
    const { chain, desk } = setup();
    const r0 = await req(chain, 0, [checkIn()]);
    const r1 = await req(chain, 1, [checkIn()]);
    const r = await desk.handle({ ...r0, authorization: r1.authorization });
    expect(r.reasons[0].code).toBe('BAD_AUTHORIZATION');
  });
  it('rejects a stale executor nonce (replay)', async () => {
    const { chain, desk } = setup(testPolicy({ perAddressDaily: { maxTx: 5, maxGasWei: (10n ** 15n).toString() } }));
    const first = await req(chain, 0, [checkIn()]);
    expect((await desk.handle(first)).decision).toBe('sponsored');
    const replay = await desk.handle(first);
    expect(replay.decision).toBe('rejected');
    expect(['NONCE_MISMATCH', 'BAD_AUTHORIZATION']).toContain(replay.reasons[0].code);
  });
});

describe('happy path + quotas + budget', () => {
  it('sponsors a first-time user with a type-4 tx and records the receipt cost', async () => {
    const { chain, desk, ledger } = setup();
    const r = await desk.handle(await req(chain, 0, [checkIn()]));
    expect(r.decision).toBe('sponsored');
    expect(chain.sent).toHaveLength(1);
    expect(chain.sent[0].authorization?.address).toBe(EXECUTOR);
    expect(chain.sent[0].to).toBe(user(0).address);
    expect(r.entry.costWei).toBe((60_000n * 1_000_000_000n).toString());
    expect(BigInt(r.entry.gasLimit!)).toBe((80_000n * 13n) / 10n);
    expect(ledger.all()).toHaveLength(1);
  });
  it('second request from the same address the same UTC day hits the per-address quota', async () => {
    const { chain, desk } = setup();
    expect((await desk.handle(await req(chain, 0, [checkIn()]))).decision).toBe('sponsored');
    const r = await desk.handle(await req(chain, 0, [checkIn()]));
    expect(r.reasons.map((x) => x.code)).toContain('ADDRESS_DAILY_TX_QUOTA');
    expect(chain.sent).toHaveLength(1);
  });
  it('quota resets on the next UTC day', async () => {
    const { chain, desk, setNow } = setup();
    expect((await desk.handle(await req(chain, 0, [checkIn()]))).decision).toBe('sponsored');
    const tomorrow = T0 + 86400_000;
    setNow(tomorrow);
    expect((await desk.handle(await req(chain, 0, [checkIn()], {}, tomorrow))).decision).toBe('sponsored');
  });
  it('enforces the per-address gas cap using a worst-case reservation', async () => {
    const { chain, desk } = setup(testPolicy({ perAddressDaily: { maxTx: 10, maxGasWei: '1000' } }));
    const r = await desk.handle(await req(chain, 0, [checkIn()]));
    expect(r.reasons.map((x) => x.code)).toContain('ADDRESS_DAILY_GAS_QUOTA');
  });
  it('enforces the global daily budget', async () => {
    const worst = 300000n * 1_200_000_000n;
    const { chain, desk } = setup(testPolicy({ globalDaily: { maxGasWei: (worst + 1n).toString() } }));
    expect((await desk.handle(await req(chain, 0, [checkIn()]))).decision).toBe('sponsored');
    const r = await desk.handle(await req(chain, 1, [checkIn()]));
    expect(r.reasons.map((x) => x.code)).toContain('GLOBAL_DAILY_BUDGET');
  });
  it('records an on-chain revert as failed (sponsor still paid)', async () => {
    const { chain, desk } = setup();
    chain.revertNext = true;
    const r = await desk.handle(await req(chain, 0, [checkIn()]));
    expect(r.decision).toBe('failed');
    expect(r.entry.txHash).toBeTruthy();
    expect(r.reasons[0].code).toBe('REVERTED');
  });
  it('dry run never sends', async () => {
    const chain = new MockChain();
    const desk = new SponsorDesk(testPolicy(), chain, Ledger.memory(), { now: () => T0, dryRun: true });
    const r = await desk.handle(await req(chain, 0, [checkIn()]));
    expect(chain.sent).toHaveLength(0);
    expect(r.decision).toBe('dry-run');
    expect(r.reasons[0].code).toBe('DRY_RUN_PASS');
    expect(r.entry.gasLimit).toBeTruthy();
  });
});

describe('abuse heuristics', () => {
  it('blocks a burst of brand-new addresses', async () => {
    const { chain, desk } = setup(testPolicy({ heuristics: { ...testPolicy().heuristics, maxNewAddressesPerWindow: 3 } }));
    for (let i = 0; i < 3; i++) expect((await desk.handle(await req(chain, i, [checkIn()]))).decision).toBe('sponsored');
    const r = await desk.handle(await req(chain, 3, [checkIn()]));
    expect(r.reasons.map((x) => x.code)).toContain('NEW_ADDRESS_BURST');
  });
  it('does not count an address with on-chain history as brand-new', async () => {
    const { chain, desk } = setup(testPolicy({ heuristics: { ...testPolicy().heuristics, maxNewAddressesPerWindow: 1 } }));
    expect((await desk.handle(await req(chain, 0, [checkIn()]))).decision).toBe('sponsored');
    chain.txCount.set(user(1).address.toLowerCase(), 50);
    const r = await desk.handle(await req(chain, 1, [checkIn()]));
    expect(r.decision).toBe('sponsored');
  });
  it('blocks per-address request bursts', async () => {
    const { chain, desk } = setup();
    for (let i = 0; i < 3; i++) await desk.handle(await req(chain, 0, [setMotto()])); // 3 rejected requests in the window
    const r = await desk.handle(await req(chain, 0, [checkIn()]));
    expect(r.reasons.map((x) => x.code)).toContain('ADDRESS_BURST');
  });
  it('cools down an address after repeated failures', async () => {
    const { chain, desk, setNow } = setup();
    chain.failEstimate = 'execution reverted';
    for (let i = 0; i < 3; i++) {
      setNow(T0 + i * 120_000); // outside the burst window
      expect((await desk.handle(await req(chain, 0, [checkIn()], {}, T0 + i * 120_000))).reasons[0].code).toBe('SIMULATION_FAILED');
    }
    chain.failEstimate = null;
    setNow(T0 + 10 * 120_000);
    const r = await desk.handle(await req(chain, 0, [checkIn()], {}, T0 + 10 * 120_000));
    expect(r.reasons.map((x) => x.code)).toContain('REPEATED_FAILURES');
  });
});

describe('ledger + reports', () => {
  it('persists to JSONL and reloads', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
    const file = path.join(dir, 'ledger.jsonl');
    const chain = new MockChain();
    const desk = new SponsorDesk(testPolicy(), chain, new Ledger(file), { now: () => T0 });
    await desk.handle(await req(chain, 0, [checkIn()]));
    await desk.handle(await req(chain, 0, [setMotto()]));
    const re = new Ledger(file);
    expect(re.all()).toHaveLength(2);
    expect(re.accountUsage(user(0).address, '2026-10-26').tx).toBe(1);
  });
  it('builds JSON, markdown and HTML daily reports', async () => {
    const { chain, desk, ledger } = setup();
    await desk.handle(await req(chain, 0, [checkIn()]));
    await desk.handle(await req(chain, 0, [checkIn()]));
    await desk.handle(await req(chain, 1, [setMotto()]));
    const rep = buildDailyReport(ledger, testPolicy(), '2026-10-26', 'https://atlantic.pharosscan.xyz/');
    expect(rep.totals).toMatchObject({ requests: 3, sponsored: 1, rejected: 2, failed: 0 });
    expect(rep.rejectionsByReason).toMatchObject({ ADDRESS_DAILY_TX_QUOTA: 1, NOT_ALLOWLISTED_METHOD: 1 });
    expect(rep.transactions[0].url).toMatch(/^https:\/\/atlantic\.pharosscan\.xyz\/tx\/0x/);
    expect(reportToMarkdown(rep)).toContain('| 3 | 1 | 2 | 0 |');
    expect(reportToHtml(rep)).toContain('<html>');
  });
});

describe('EIP-712 encoding matches the Solidity executor', () => {
  it('viem digest == manual encoding mirroring SponsoredExecutor.hashExecute', () => {
    const acct = user(0).address;
    const calls = [checkIn('hello'), checkIn('again')];
    const CALL_T = keccak256(toHex('Call(address to,uint256 value,bytes data)'));
    const EXEC_T = keccak256(toHex('Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address to,uint256 value,bytes data)'));
    const DOM_T = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
    const callHashes = calls.map((c) =>
      keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }], [CALL_T, c.to, BigInt(c.value), keccak256(c.data)])),
    );
    const structHash = keccak256(
      encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'uint256' }], [EXEC_T, keccak256(concat(callHashes as Hex[])), 7n, 1234n]),
    );
    const dom = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
        [DOM_T, keccak256(toHex('SponsorDeskExecutor')), keccak256(toHex('1')), BigInt(CHAIN_ID), acct],
      ),
    );
    const manual = keccak256(concat(['0x1901', dom, structHash]));
    expect(executeDigest(CHAIN_ID, acct, calls, 7n, 1234)).toBe(manual);
  });
});
