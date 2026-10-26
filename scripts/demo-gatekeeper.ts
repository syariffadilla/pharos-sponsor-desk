// Policy Gatekeeper demo: 2 ALLOWs that execute + one DENY per rule type (spend limit, allowlist, time window),
// plus a sender-denylist DENY. Prints a decision table, writes an append-only audit log.
//
//   Live (Pharos Atlantic testnet, real transactions):
//     KEYS_FILE=/path/outside/repo/keys.json npm run demo:gatekeeper -- --live
//     keys.json: { sponsor:{privateKey}, user1:{privateKey}, user2:{privateKey}, user3:{privateKey}, user4:{privateKey} }
//     Writes docs/gatekeeper/{audit.jsonl,ledger.jsonl,run.json,decision-table.md}
//   Local (no network, deterministic, in-memory chain, SYNTHETIC hashes):
//     npm run demo:gatekeeper
//     Writes data/gatekeeper-local/{audit.jsonl,...}. Nothing here is a real transaction.
import fs from 'node:fs';
import path from 'node:path';
import { encodeFunctionData, formatEther, parseAbi, parseEventLogs, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainClient } from '../src/chain.js';
import { delegatedTo, loadNetwork, publicClientFor, txUrl, ViemChain } from '../src/chain.js';
import { SponsorDesk } from '../src/desk.js';
import { Ledger } from '../src/ledger.js';
import { AuditLog, auditToMarkdown } from '../src/audit.js';
import { describeRules, loadPolicy } from '../src/policy.js';
import { localClock } from '../src/rules.js';
import { buildSponsorRequest } from '../src/request.js';
import type { Call, Policy } from '../src/types.js';

const LIVE = process.argv.includes('--live');
const policyFile = process.env.DESK_POLICY ?? 'examples/policy.gatekeeper.json';
const policy: Policy = loadPolicy(policyFile);
const net = loadNetwork(policy.network);
if (net.chainId !== 688689) throw new Error('demo is Atlantic-testnet only');
const guestbook = policy.allowlist[0].address;
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const gbAbi = parseAbi([
  'function checkIn(string note)',
  'function setMotto(string m)',
  'function checkIns(address) view returns (uint256)',
  'event CheckedIn(address indexed who, uint256 count, string note)',
]);
const gb = (fn: 'checkIn' | 'setMotto', s: string): Call => ({ to: guestbook, value: '0', data: encodeFunctionData({ abi: gbAbi, functionName: fn, args: [s] }) });
const tz = policy.timeWindow?.timezone ?? 'UTC';

let keys: Record<string, { privateKey: Hex }>;
let chain: ChainClient & { sponsor: Address };
let outDir: string;
let nowFn: (() => number) | undefined;
let mock: any = null;

if (LIVE) {
  keys = JSON.parse(fs.readFileSync(process.env.KEYS_FILE ?? '', 'utf8'));
  for (const k of ['sponsor', 'user1', 'user2', 'user3', 'user4']) if (!keys[k]?.privateKey) throw new Error(`KEYS_FILE missing ${k}`);
  chain = new ViemChain(net, keys.sponsor.privateKey);
  outDir = 'docs/gatekeeper';
} else {
  // Deterministic local run: well-known dev keys + in-memory chain. Hashes are synthetic, never real.
  const h = await import('../test/helpers.js');
  mock = new h.MockChain();
  chain = mock;
  keys = { sponsor: { privateKey: h.SPONSOR_KEY } } as any;
  ['user1', 'user2', 'user3', 'user4'].forEach((k, i) => (keys[k] = { privateKey: h.USER_KEYS[i] }));
  // the local run denylists user3's dev address instead of the live one
  policy.senders = { deny: [privateKeyToAccount(keys.user3.privateKey).address] };
  // user1/user2 are "already delegated" like on Atlantic
  for (const k of ['user1', 'user2']) mock.code.set(privateKeyToAccount(keys[k].privateKey).address.toLowerCase(), '0xef0100' + policy.executor.slice(2).toLowerCase());
  const fixed = Date.UTC(2026, 9, 26, 9, 40, 0); // Mon 16:40 Asia/Jakarta
  let t = fixed;
  nowFn = () => (t += 1000);
  outDir = 'data/gatekeeper-local';
}

fs.mkdirSync(outDir, { recursive: true });
const audit = new AuditLog(path.join(outDir, 'audit.jsonl'));
const ledger = new Ledger(path.join(outDir, 'ledger.jsonl'));
const desk = new SponsorDesk(policy, chain, ledger, { audit, now: nowFn });
const pub = LIVE ? publicClientFor(net) : null;

async function sponsorState() {
  if (!pub) return { nonce: mock.sent.length, balanceWei: 'n/a (local)' };
  const [nonce, bal] = await Promise.all([pub.getTransactionCount({ address: chain.sponsor }), pub.getBalance({ address: chain.sponsor })]);
  return { nonce, balanceWei: bal.toString() };
}

async function buildReq(key: Hex, calls: Call[], label: string) {
  const u = privateKeyToAccount(key);
  const [code, txNonce] = await Promise.all([chain.getCode(u.address), chain.getTxCount(u.address)]);
  const d = delegatedTo((code ?? '0x') as Hex);
  const delegated = !!d && d.toLowerCase() === policy.executor.toLowerCase();
  const execNonce = delegated ? await chain.readExecutorNonce(u.address, policy.executor) : 0n;
  return buildSponsorRequest({
    user: u,
    chainId: net.chainId,
    executor: policy.executor,
    calls,
    executorNonce: execNonce,
    accountTxNonce: txNonce,
    needsAuthorization: !delegated,
    label,
    nowSec: nowFn ? Math.floor(nowFn() / 1000) : undefined,
  });
}

const rows: any[] = [];
async function step(id: string, expect: string, who: string, calls: Call[], what: string) {
  const key = keys[who].privateKey;
  const req = await buildReq(key, calls, id);
  const before = await sponsorState();
  const r = await desk.handle(req);
  const after = await sponsorState();
  const row: any = {
    step: id,
    scenario: what,
    expected: expect,
    sender: req.account,
    senderRole: who,
    verdict: r.verdict,
    rule: r.decidedBy.rule,
    ruleType: r.decidedBy.ruleType,
    code: r.decidedBy.code,
    message: r.decidedBy.message,
    localTime: localClock(r.entry.ts, tz).label,
    requestHash: r.entry.requestHash,
    executed: !!r.entry.txHash,
    txHash: r.entry.txHash ?? null,
    explorer: r.entry.txHash && LIVE ? txUrl(net, r.entry.txHash) : null,
    sponsorNonceBefore: before.nonce,
    sponsorNonceAfter: after.nonce,
    sponsorBalanceBeforeWei: before.balanceWei,
    sponsorBalanceAfterWei: after.balanceWei,
    auditSeq: r.audit?.seq,
    auditHash: r.audit?.hash,
  };
  if (r.entry.txHash && pub) {
    const [tx, rc] = await Promise.all([pub.getTransaction({ hash: r.entry.txHash }), pub.getTransactionReceipt({ hash: r.entry.txHash })]);
    const ev = parseEventLogs({ abi: gbAbi, logs: rc.logs, eventName: 'CheckedIn' });
    Object.assign(row, {
      onchain: {
        status: rc.status,
        type: tx.type,
        from: tx.from,
        to: tx.to,
        blockNumber: rc.blockNumber.toString(),
        gasUsed: rc.gasUsed.toString(),
        effectiveGasPrice: rc.effectiveGasPrice.toString(),
        costWei: (rc.gasUsed * rc.effectiveGasPrice).toString(),
        checkedIn: ev.map((l) => ({ who: l.args.who, count: l.args.count.toString(), note: l.args.note })),
      },
    });
  }
  row.matchesExpectation = expect === 'allow' ? r.verdict === 'allow' && row.executed : r.verdict === 'deny' && r.decidedBy.ruleType === expect && !row.executed;
  rows.push(row);
  const mark = r.verdict === 'allow' ? 'ALLOW' : 'DENY ';
  console.log(`${mark} ${id.padEnd(22)} ${r.decidedBy.rule.padEnd(34)} ${row.executed ? row.txHash : 'not executed'}`);
  console.log(`       ${r.decidedBy.message}`);
}

console.log(`Policy Gatekeeper demo  mode=${LIVE ? 'LIVE Pharos Atlantic testnet' : 'LOCAL in-memory chain (synthetic hashes, nothing on-chain)'}`);
console.log(`policy ${policyFile}  network ${net.name} chainId ${net.chainId}  sponsor ${chain.sponsor}`);
if (pub) console.log(`block ${await pub.getBlockNumber()}  sponsor balance ${formatEther(await pub.getBalance({ address: chain.sponsor }))} ${net.nativeToken}`);
console.log(JSON.stringify(describeRules(policy), null, 2));
console.log('');

await step('A1-allow-fresh-user', 'allow', 'user4', [gb('checkIn', 'gatekeeper: allowed, gas paid by sponsor')], 'fresh 0-PHRS user, allowlisted checkIn, inside desk hours, within quota');
await step('A2-allow-delegated', 'allow', 'user1', [gb('checkIn', 'gatekeeper: allowed again')], 'already-delegated user, allowlisted checkIn');
await step('D1-deny-spend-limit', 'spend_limit', 'user4', [gb('checkIn', 'second today')], 'same user again the same UTC day (perAddressDaily.maxTx = 1)');
await step('D2-deny-allowlist', 'allowlist', 'user2', [{ to: MULTICALL3, value: '0', data: ('0x252dba42' + '0'.repeat(128)) as Hex }], 'target contract (Multicall3) not on the allowlist');
await step('D3-deny-sender-list', 'allowlist', 'user3', [gb('checkIn', 'from a denylisted sender')], 'sender is on rules.allowlist.senders.deny');
await step('D4-deny-time-window', 'time_window', 'user2', [gb('setMotto', 'weekday attempt')], 'setMotto is allowlisted only for the weekend campaign window (Sat-Sun Asia/Jakarta)');

const v = audit.verify();
const summary = audit.summary();
const table = [
  '| Step | Scenario | Verdict | Deciding rule | Code | Executed | Tx |',
  '|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.step} | ${r.scenario} | **${r.verdict.toUpperCase()}** | \`${r.rule}\` | ${r.code} | ${r.executed ? 'yes' : 'no (sponsor nonce ' + r.sponsorNonceBefore + ' -> ' + r.sponsorNonceAfter + ')'} | ${r.explorer ? `[${r.txHash.slice(0, 10)}…](${r.explorer})` : r.txHash ? r.txHash.slice(0, 10) + '… (synthetic)' : '-'} |`,
  ),
].join('\n');
console.log('\n' + table + '\n');
console.log('audit chain', JSON.stringify(v), 'summary', JSON.stringify(summary));
const run = {
  mode: LIVE ? 'live' : 'local-synthetic',
  network: net.name,
  chainId: net.chainId,
  explorer: net.explorerUrl,
  policyFile,
  sponsor: chain.sponsor,
  executor: policy.executor,
  guestbook,
  rules: describeRules(policy),
  steps: rows,
  allMatchExpectation: rows.every((r) => r.matchesExpectation),
  audit: { file: path.join(outDir, 'audit.jsonl'), ...v, summary },
};
const runFile = path.join(outDir, LIVE ? 'run.json' : 'run.local.json');
const prev = fs.existsSync(runFile) ? JSON.parse(fs.readFileSync(runFile, 'utf8')) : { runs: [] };
prev.runs.push(run);
fs.writeFileSync(runFile, JSON.stringify(prev, null, 2));
fs.writeFileSync(path.join(outDir, 'decision-table.md'), `${table}\n\nAudit log (${path.join(outDir, 'audit.jsonl')}):\n\n${auditToMarkdown(audit.all(), LIVE ? net.explorerUrl : undefined)}`);
console.log(`wrote ${runFile}, ${path.join(outDir, 'decision-table.md')}, ${path.join(outDir, 'audit.jsonl')}`);
if (!run.allMatchExpectation) process.exitCode = 2;
