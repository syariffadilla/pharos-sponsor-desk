// Policy Gatekeeper: three rule types (spend limit, allowlist, time window), allow/deny with the deciding rule,
// denies never executed, append-only audit log.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeFunctionData, parseAbi, type Address } from 'viem';
import { SponsorDesk } from '../src/desk.js';
import { Ledger } from '../src/ledger.js';
import { AuditLog, auditToCsv, auditToMarkdown, requestHash } from '../src/audit.js';
import { describeRules, loadPolicy, normalizePolicy, validatePolicy } from '../src/policy.js';
import { checkTimeWindow, localClock, RULES } from '../src/rules.js';
import { buildSponsorRequest } from '../src/request.js';
import type { Call, Policy } from '../src/types.js';
import { CHAIN_ID, EXECUTOR, GUESTBOOK, MockChain, OTHER, testPolicy, user } from './helpers.js';

const gb = parseAbi(['function checkIn(string note)', 'function setMotto(string m)']);
const checkIn = (note = 'gm'): Call => ({ to: GUESTBOOK, value: '0', data: encodeFunctionData({ abi: gb, functionName: 'checkIn', args: [note] }) });
const setMotto = (): Call => ({ to: GUESTBOOK, value: '0', data: encodeFunctionData({ abi: gb, functionName: 'setMotto', args: ['x'] }) });

// Mon 2026-10-26 03:00 UTC = Mon 10:00 in Asia/Jakarta (UTC+7)
const MON_10_JKT = Date.UTC(2026, 9, 26, 3, 0, 0);
const SAT_10_JKT = Date.UTC(2026, 9, 31, 3, 0, 0);
const MON_20_JKT = Date.UTC(2026, 9, 26, 13, 0, 0);

/** MockChain that counts every call, so tests can prove a deny never reaches signing/broadcast. */
class SpyChain extends MockChain {
  calls: Record<string, number> = { getCode: 0, getTxCount: 0, readExecutorNonce: 0, fees: 0, estimate: 0, send: 0 };
  async getCode(a: Address) {
    this.calls.getCode++;
    return super.getCode(a);
  }
  async getTxCount(a: Address) {
    this.calls.getTxCount++;
    return super.getTxCount(a);
  }
  async readExecutorNonce(a: Address) {
    this.calls.readExecutorNonce++;
    return super.readExecutorNonce(a);
  }
  async fees() {
    this.calls.fees++;
    return super.fees();
  }
  async estimate() {
    this.calls.estimate++;
    return super.estimate();
  }
  async send(tx: Parameters<MockChain['send']>[0]) {
    this.calls.send++;
    return super.send(tx);
  }
  get total() {
    return Object.values(this.calls).reduce((a, b) => a + b, 0);
  }
}

const officeHours = { timezone: 'Asia/Jakarta', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as any, start: '09:00', end: '17:00' };

function gatePolicy(over: Partial<Policy> = {}): Policy {
  return testPolicy({
    allowlist: [{ address: GUESTBOOK, label: 'DeskGuestbook', methods: ['checkIn(string)', 'setMotto(string)'] }],
    maxCostPerTxWei: (10n ** 15n).toString(),
    senders: { deny: [user(5).address] },
    timeWindow: officeHours,
    ...over,
  });
}

async function req(chain: MockChain, i: number, calls: Call[], nowMs: number) {
  const u = user(i);
  return buildSponsorRequest({
    user: u,
    chainId: CHAIN_ID,
    executor: EXECUTOR,
    calls,
    executorNonce: await chain.readExecutorNonce(u.address),
    accountTxNonce: await chain.getTxCount(u.address),
    needsAuthorization: (await chain.getCode(u.address)) === '0x',
    nowSec: Math.floor(nowMs / 1000),
  });
}

function setup(policy = gatePolicy(), nowMs = MON_10_JKT) {
  const chain = new SpyChain();
  const ledger = Ledger.memory();
  const audit = AuditLog.memory();
  let now = nowMs;
  const desk = new SponsorDesk(policy, chain, ledger, { now: () => now, audit });
  return { chain, ledger, audit, desk, setNow: (t: number) => (now = t) };
}

/** Build the request first, then reset counters, so only the desk's own chain calls are counted. */
async function evaluate(s: ReturnType<typeof setup>, i: number, calls: Call[], nowMs = MON_10_JKT) {
  const r0 = await req(s.chain, i, calls, nowMs);
  for (const k of Object.keys(s.chain.calls)) s.chain.calls[k] = 0;
  return s.desk.handle(r0);
}

describe('time-window rule type', () => {
  it('allows inside office hours and denies outside them with OUTSIDE_TIME_WINDOW', async () => {
    const s = setup();
    const ok = await evaluate(s, 0, [checkIn()]);
    expect(ok.verdict).toBe('allow');
    s.setNow(SAT_10_JKT);
    const r = await evaluate(s, 1, [checkIn()], SAT_10_JKT);
    expect(r.verdict).toBe('deny');
    expect(r.decidedBy).toMatchObject({ rule: 'time_window.hours', ruleType: 'time_window', code: 'OUTSIDE_TIME_WINDOW' });
    expect(r.decidedBy.message).toContain('Sat 10:00 Asia/Jakarta');
    s.setNow(MON_20_JKT);
    expect((await evaluate(s, 2, [checkIn()], MON_20_JKT)).decidedBy.code).toBe('OUTSIDE_TIME_WINDOW');
  });
  it('evaluates the window in the configured IANA timezone, not UTC', () => {
    // 2026-10-26 23:30 UTC is already Tue 06:30 in Jakarta
    expect(localClock(Date.UTC(2026, 9, 26, 23, 30), 'Asia/Jakarta')).toMatchObject({ day: 'Tue', minutes: 6 * 60 + 30 });
    expect(localClock(Date.UTC(2026, 9, 26, 23, 30), 'UTC')).toMatchObject({ day: 'Mon', minutes: 23 * 60 + 30 });
  });
  it('supports overnight windows (22:00-06:00) using the previous day for the after-midnight part', () => {
    const w = { timezone: 'UTC', days: ['Fri'] as any, start: '22:00', end: '06:00' };
    expect(checkTimeWindow(w, Date.UTC(2026, 9, 30, 23, 0))).toBeNull(); // Fri 23:00
    expect(checkTimeWindow(w, Date.UTC(2026, 9, 31, 5, 0))).toBeNull(); // Sat 05:00 (Fri night)
    expect(checkTimeWindow(w, Date.UTC(2026, 9, 31, 7, 0))?.code).toBe('OUTSIDE_TIME_WINDOW');
    expect(checkTimeWindow(w, Date.UTC(2026, 9, 31, 23, 0))?.code).toBe('OUTSIDE_TIME_WINDOW'); // Sat night not listed
  });
  it('denies inside a blackout window with BLACKOUT_WINDOW even during open hours', async () => {
    const s = setup(gatePolicy({ timeWindow: { ...officeHours, blackouts: [{ start: '2026-10-26T09:30:00+07:00', end: '2026-10-26T11:00:00+07:00', reason: 'maintenance' }] } }));
    const r = await evaluate(s, 0, [checkIn()]);
    expect(r.decidedBy).toMatchObject({ rule: 'time_window.blackout', ruleType: 'time_window', code: 'BLACKOUT_WINDOW' });
    expect(r.decidedBy.message).toContain('maintenance');
  });
  it('applies a per-contract window only to calls hitting that contract', async () => {
    const campaign = { timezone: 'Asia/Jakarta', days: ['Sat', 'Sun'] as any };
    const s = setup(
      gatePolicy({
        timeWindow: undefined,
        allowlist: [
          { address: GUESTBOOK, label: 'DeskGuestbook', methods: ['checkIn(string)'] },
          { address: OTHER, label: 'WeekendCampaign', methods: ['setMotto(string)'], timeWindow: campaign },
        ],
      }),
    );
    expect((await evaluate(s, 0, [checkIn()])).verdict).toBe('allow');
    const r = await evaluate(s, 1, [{ ...setMotto(), to: OTHER }]);
    expect(r.decidedBy.code).toBe('OUTSIDE_TIME_WINDOW');
    expect(r.decidedBy.message).toContain('WeekendCampaign');
  });
  it('supports a method-level window: same contract listed twice, only the windowed method is time-gated', async () => {
    const s = setup(
      gatePolicy({
        timeWindow: undefined,
        allowlist: [
          { address: GUESTBOOK, label: 'check-in', methods: ['checkIn(string)'] },
          { address: GUESTBOOK, label: 'motto (weekend campaign)', methods: ['setMotto(string)'], timeWindow: { timezone: 'Asia/Jakarta', days: ['Sat', 'Sun'] as any } },
        ],
      }),
    );
    expect((await evaluate(s, 0, [checkIn()])).verdict).toBe('allow');
    const r = await evaluate(s, 1, [setMotto()]);
    expect(r.decidedBy).toMatchObject({ code: 'OUTSIDE_TIME_WINDOW', ruleType: 'time_window' });
    expect(r.decidedBy.message).toContain('motto (weekend campaign)');
    s.setNow(SAT_10_JKT);
    expect((await evaluate(s, 2, [setMotto()], SAT_10_JKT)).verdict).toBe('allow');
  });
  it('rejects invalid timezones and times at load', () => {
    expect(() => validatePolicy(gatePolicy({ timeWindow: { timezone: 'Mars/Olympus' } }))).toThrow(/IANA/);
    expect(() => validatePolicy(gatePolicy({ timeWindow: { timezone: 'UTC', start: '25:00' } }))).toThrow(/HH:MM/);
    expect(() => validatePolicy(gatePolicy({ timeWindow: { timezone: 'UTC', days: ['Funday' as any] } }))).toThrow();
    expect(() => validatePolicy(gatePolicy({ timeWindow: { timezone: 'UTC', blackouts: [{ start: '2026-10-27T00:00:00Z', end: '2026-10-26T00:00:00Z' }] } }))).toThrow();
  });
});

describe('allowlist rule type (sender allow/deny)', () => {
  it('denies a denylisted sender with SENDER_DENYLISTED', async () => {
    const s = setup();
    const r = await evaluate(s, 5, [checkIn()]);
    expect(r.decidedBy).toMatchObject({ rule: 'allowlist.sender_denylist', ruleType: 'allowlist', code: 'SENDER_DENYLISTED' });
  });
  it('with a sender allowlist, serves only listed senders', async () => {
    const s = setup(gatePolicy({ senders: { allow: [user(0).address] } }));
    expect((await evaluate(s, 0, [checkIn()])).verdict).toBe('allow');
    expect((await evaluate(s, 1, [checkIn()])).decidedBy.code).toBe('SENDER_NOT_ALLOWLISTED');
  });
  it('rejects bad sender addresses at load', () => {
    expect(() => validatePolicy(gatePolicy({ senders: { deny: ['0x123' as Address] } }))).toThrow();
  });
});

describe('spend-limit rule type (per-tx cost, gas cap)', () => {
  it('denies when worst-case cost exceeds maxCostPerTxWei, before simulation or broadcast', async () => {
    const s = setup(gatePolicy({ maxCostPerTxWei: '1000' }));
    const r = await evaluate(s, 0, [checkIn()]);
    expect(r.decidedBy).toMatchObject({ rule: 'spend_limit.max_cost_per_tx', ruleType: 'spend_limit', code: 'SPEND_LIMIT_PER_TX' });
    expect(s.chain.calls.estimate).toBe(0);
    expect(s.chain.calls.send).toBe(0);
  });
  it('denies when estimated gas exceeds maxGasPerTx (GAS_CAP_EXCEEDED) and never broadcasts', async () => {
    const s = setup();
    s.chain.estimateGas = 400_000n;
    const r = await evaluate(s, 0, [checkIn()]);
    expect(r.decidedBy).toMatchObject({ rule: 'spend_limit.max_gas_per_tx', ruleType: 'spend_limit' });
    expect(s.chain.calls.send).toBe(0);
  });
});

describe('every request returns allow/deny with the deciding rule; denies are never executed', () => {
  it('one deny per rule type + one allow, broadcaster called exactly once (for the allow)', async () => {
    const s = setup();
    const results = [
      ['allow', await evaluate(s, 0, [checkIn('first')])],
      ['spend_limit', await evaluate(s, 0, [checkIn('second today')])], // per-address daily quota (maxTx=1)
      ['allowlist', await evaluate(s, 1, [{ ...checkIn(), to: OTHER }])],
      ['time_window', await (async () => {
        s.setNow(SAT_10_JKT);
        return evaluate(s, 2, [checkIn()], SAT_10_JKT);
      })()],
    ] as const;
    expect(results[0][1].verdict).toBe('allow');
    expect(results[0][1].decidedBy.rule).toBe('gate.all_rules_passed');
    expect(results[0][1].entry.txHash).toBeTruthy();
    for (const [type, r] of results.slice(1)) {
      expect(r.verdict).toBe('deny');
      expect(r.decidedBy.ruleType).toBe(type);
      expect(r.decidedBy.rule).toMatch(new RegExp(`^${type}\\.`));
      expect(r.decidedBy.message.length).toBeGreaterThan(5);
      expect(r.entry.txHash).toBeUndefined();
    }
    expect(results[1][1].decidedBy.code).toBe('ADDRESS_DAILY_TX_QUOTA');
    expect(s.chain.sent).toHaveLength(1);
  });
  it('allowlist and time-window denies make zero chain calls (decided before any RPC, signing or broadcast)', async () => {
    const s = setup();
    await evaluate(s, 1, [{ ...checkIn(), to: OTHER }]);
    expect(s.chain.total).toBe(0);
    s.setNow(SAT_10_JKT);
    await evaluate(s, 1, [checkIn()], SAT_10_JKT);
    expect(s.chain.total).toBe(0);
  });
  it('spend-limit deny reads fees for the reservation but never simulates or broadcasts', async () => {
    const s = setup();
    await evaluate(s, 0, [checkIn()]);
    const r = await evaluate(s, 0, [checkIn()]);
    expect(r.decidedBy.ruleType).toBe('spend_limit');
    expect(s.chain.calls).toMatchObject({ estimate: 0, send: 0 });
  });
  it('the trace marks the failing stage and everything after it as not reached', async () => {
    const s = setup();
    s.setNow(SAT_10_JKT);
    const r = await evaluate(s, 0, [checkIn()], SAT_10_JKT);
    expect(r.trace.map((t) => t.result)).toEqual(['pass', 'pass', 'fail', 'not_reached', 'not_reached', 'not_reached', 'not_reached']);
    expect(r.trace[2].ruleType).toBe('time_window');
  });
  it('every reason code maps to a rule id and type', () => {
    for (const [code, m] of Object.entries(RULES)) {
      expect(m.rule, code).toMatch(/^[a-z_]+\.[a-z0-9_+]+$/);
      expect(m.rule.startsWith(m.ruleType + '.'), code).toBe(true);
    }
  });
});

describe('audit log', () => {
  it('records every decision (allow, deny, dry run) with time, request hash, sender, deciding rule and tx hash', async () => {
    const s = setup();
    const r1 = await evaluate(s, 0, [checkIn()]);
    const r2 = await evaluate(s, 1, [{ ...checkIn(), to: OTHER }]);
    const dry = new SponsorDesk(gatePolicy(), s.chain, s.ledger, { now: () => MON_10_JKT, audit: s.audit, dryRun: true });
    const r3 = await dry.handle(await req(s.chain, 3, [checkIn()], MON_10_JKT));
    const log = s.audit.all();
    expect(log).toHaveLength(3);
    expect(log[0]).toMatchObject({ seq: 1, verdict: 'allow', executed: true, txHash: r1.entry.txHash, sender: user(0).address });
    expect(log[0].time).toBe('2026-10-26T03:00:00Z');
    expect(log[1]).toMatchObject({ verdict: 'deny', executed: false, txHash: null, decidedBy: { rule: 'allowlist.contract' } });
    expect(log[2]).toMatchObject({ verdict: 'allow', decision: 'dry-run', executed: false });
    expect(log[1].requestHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(r2.audit?.hash).toBe(log[1].hash);
    expect(r3.audit?.seq).toBe(3);
    expect(s.audit.summary()).toMatchObject({ entries: 3, allow: 2, deny: 1, executed: 1, deniedButExecuted: 0 });
  });
  it('request hash is deterministic for the same request and differs when anything changes', async () => {
    const chain = new MockChain();
    const a = await req(chain, 0, [checkIn('a')], MON_10_JKT);
    expect(requestHash(a)).toBe(requestHash(JSON.parse(JSON.stringify(a))));
    expect(requestHash(a)).not.toBe(requestHash({ ...a, deadline: a.deadline + 1 }));
  });
  it('is append-only JSONL, reloads, and its hash chain detects tampering', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
    const file = path.join(dir, 'audit.jsonl');
    const chain = new MockChain();
    const desk = new SponsorDesk(gatePolicy(), chain, Ledger.memory(), { now: () => MON_10_JKT, audit: new AuditLog(file) });
    await desk.handle(await req(chain, 0, [checkIn()], MON_10_JKT));
    const firstBytes = fs.readFileSync(file, 'utf8');
    await desk.handle(await req(chain, 1, [{ ...checkIn(), to: OTHER }], MON_10_JKT));
    const all = fs.readFileSync(file, 'utf8');
    expect(all.startsWith(firstBytes)).toBe(true); // earlier lines untouched
    const re = new AuditLog(file);
    expect(re.all()).toHaveLength(2);
    expect(re.verify()).toMatchObject({ ok: true, entries: 2 });
    const lines = all.trim().split('\n');
    const tampered = JSON.parse(lines[1]);
    tampered.verdict = 'allow';
    fs.writeFileSync(file, [lines[0], JSON.stringify(tampered)].join('\n') + '\n');
    expect(new AuditLog(file).verify()).toMatchObject({ ok: false, brokenAt: 2 });
    fs.writeFileSync(file, lines[1] + '\n'); // deleting the first line breaks the chain too
    expect(new AuditLog(file).verify().ok).toBe(false);
  });
  it('exports CSV and Markdown', async () => {
    const s = setup();
    await evaluate(s, 0, [checkIn()]);
    await evaluate(s, 1, [{ ...checkIn(), to: OTHER }]);
    const csv = auditToCsv(s.audit.all());
    expect(csv.split('\n')[0]).toContain('verdict,decision,rule');
    expect(csv).toContain('allowlist.contract');
    const md = auditToMarkdown(s.audit.all(), 'https://atlantic.pharosscan.xyz/');
    expect(md).toContain('**DENY**');
    expect(md).toContain('not executed');
    expect(md).toContain('https://atlantic.pharosscan.xyz/tx/0x');
  });
});

describe('policy config shape', () => {
  it('the gatekeeper example policy names the three rule types and normalizes to the internal policy', () => {
    const raw = JSON.parse(fs.readFileSync('examples/policy.gatekeeper.json', 'utf8'));
    expect(Object.keys(raw.rules)).toEqual(['spendLimit', 'allowlist', 'timeWindow']);
    const p = loadPolicy('examples/policy.gatekeeper.json');
    expect(p.allowlist.length).toBeGreaterThan(0);
    expect(p.timeWindow?.timezone).toBeTruthy();
    expect(p.maxCostPerTxWei).toBeTruthy();
    const d = describeRules(p);
    expect(Object.keys(d)).toEqual(['spend_limit', 'allowlist', 'time_window']);
  });
  it('legacy flat policies still load unchanged', () => {
    const flat = testPolicy();
    expect(normalizePolicy(flat)).toBe(flat);
    expect(() => loadPolicy('examples/policy.atlantic.json')).not.toThrow();
  });
});
