// Live demo on Pharos Atlantic testnet (chainId 688689). Testnet-only, throwaway keys.
// KEYS_FILE must point to a JSON file {sponsor:{privateKey}, user1:{privateKey}, user2:{privateKey}}
// kept OUTSIDE the repo. Writes docs/live/{ledger.jsonl,report.*,demo-output.json}.
import fs from 'node:fs';
import { encodeFunctionData, formatEther, parseAbi, parseEventLogs, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { delegatedTo, loadNetwork, publicClientFor, txUrl, ViemChain } from '../src/chain.js';
import { SponsorDesk } from '../src/desk.js';
import { Ledger, utcDay } from '../src/ledger.js';
import { loadPolicy } from '../src/policy.js';
import { buildDailyReport, reportToHtml, reportToMarkdown } from '../src/report.js';
import { buildSponsorRequest } from '../src/request.js';
import type { Call } from '../src/types.js';

const keys = JSON.parse(fs.readFileSync(process.env.KEYS_FILE ?? '', 'utf8'));
const policy = loadPolicy(process.env.DESK_POLICY ?? 'examples/policy.atlantic.json');
const net = loadNetwork(policy.network);
if (net.chainId !== 688689) throw new Error('demo is Atlantic-testnet only');
const pub = publicClientFor(net);
const chain = new ViemChain(net, keys.sponsor.privateKey as Hex);
fs.mkdirSync('docs/live', { recursive: true });
const ledgerFile = 'docs/live/ledger.jsonl';
const ledger = new Ledger(ledgerFile);
const desk = new SponsorDesk(policy, chain, ledger);
const guestbook = policy.allowlist[0].address;
const gbAbi = parseAbi([
  'function checkIn(string note)',
  'function setMotto(string m)',
  'function checkIns(address) view returns (uint256)',
  'event CheckedIn(address indexed who, uint256 count, string note)',
]);
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const steps: any[] = [];

async function userRequest(key: Hex, calls: Call[], label: string) {
  const u = privateKeyToAccount(key);
  const [code, txNonce] = await Promise.all([pub.getCode({ address: u.address }), pub.getTransactionCount({ address: u.address })]);
  const d = delegatedTo((code ?? '0x') as Hex);
  const delegated = !!d && d.toLowerCase() === policy.executor.toLowerCase();
  const execNonce = delegated ? await chain.readExecutorNonce(u.address, policy.executor) : 0n;
  return buildSponsorRequest({ user: u, chainId: net.chainId, executor: policy.executor, calls, executorNonce: execNonce, accountTxNonce: txNonce, needsAuthorization: !delegated, label });
}

async function step(name: string, key: Hex, calls: Call[]) {
  const u = privateKeyToAccount(key);
  const sponsorBefore = await pub.getBalance({ address: chain.sponsor });
  const userBefore = await pub.getBalance({ address: u.address });
  const req = await userRequest(key, calls, name);
  const r = await desk.handle(req);
  const sponsorAfter = await pub.getBalance({ address: chain.sponsor });
  const userAfter = await pub.getBalance({ address: u.address });
  const rec: any = {
    step: name,
    account: u.address,
    decision: r.decision,
    reasons: r.reasons,
    authorizationIncluded: !!req.authorization,
    userBalanceBeforeWei: userBefore.toString(),
    userBalanceAfterWei: userAfter.toString(),
    sponsorBalanceDeltaWei: (sponsorBefore - sponsorAfter).toString(),
  };
  if (r.entry.txHash) {
    const tx = await pub.getTransaction({ hash: r.entry.txHash });
    const receipt = await pub.getTransactionReceipt({ hash: r.entry.txHash });
    const logs = parseEventLogs({ abi: gbAbi, logs: receipt.logs, eventName: 'CheckedIn' });
    Object.assign(rec, {
      txHash: r.entry.txHash,
      explorer: txUrl(net, r.entry.txHash),
      txType: tx.type,
      txFrom: tx.from,
      txTo: tx.to,
      status: receipt.status,
      gasLimit: tx.gas.toString(),
      gasUsed: receipt.gasUsed.toString(),
      effectiveGasPrice: receipt.effectiveGasPrice.toString(),
      receiptCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
      blockNumber: receipt.blockNumber.toString(),
      checkedInEvents: logs.map((l) => ({ who: l.args.who, count: l.args.count.toString(), note: l.args.note })),
      delegationAfter: delegatedTo(((await pub.getCode({ address: u.address })) ?? '0x') as Hex),
    });
  }
  steps.push(rec);
  console.log(JSON.stringify(rec, null, 2));
}

const gb = (fn: 'checkIn' | 'setMotto', s: string): Call => ({ to: guestbook, value: '0', data: encodeFunctionData({ abi: gbAbi, functionName: fn, args: [s] }) });
const only = process.env.DEMO_STEPS?.split(',');
const want = (n: string) => !only || only.includes(n);

console.log(`network ${net.name} chainId ${await pub.getChainId()} block ${await pub.getBlockNumber()}`);
console.log(`sponsor ${chain.sponsor} balance ${formatEther(await pub.getBalance({ address: chain.sponsor }))} ${net.nativeToken}`);

// 1. Fresh user with 0 PHRS: first sponsored tx (type 0x04 with the user's 7702 authorization).
if (want('1')) await step('1-sponsored-zero-gas-user', keys.user2.privateKey, [gb('checkIn', 'gm from a 0-PHRS account, gas paid by Sponsor Desk')]);
// 2. Same user again, same UTC day: per-address quota (maxTx=1) rejects it before anything is sent.
if (want('2')) await step('2-rejected-by-quota', keys.user2.privateKey, [gb('checkIn', 'second try today')]);
// 3. Allowlisted contract, non-allowlisted method.
if (want('3')) await step('3-rejected-method-not-allowlisted', keys.user1.privateKey, [gb('setMotto', 'not sponsored')]);
// 4. Target contract not on the allowlist at all.
if (want('4')) await step('4-rejected-target-not-allowlisted', keys.user1.privateKey, [{ to: MULTICALL3, value: '0', data: '0x252dba42' + '0'.repeat(128) as Hex }]);
// 5. A second 0-PHRS user that was previously delegated elsewhere: re-delegates to the executor and is sponsored.
if (want('5')) await step('5-sponsored-redelegation', keys.user1.privateKey, [gb('checkIn', 'second user, also 0 PHRS')]);

const checkIns: Record<string, string> = {};
for (const k of ['user1', 'user2']) {
  const a = privateKeyToAccount(keys[k].privateKey).address;
  checkIns[a] = (await pub.readContract({ address: guestbook, abi: gbAbi, functionName: 'checkIns', args: [a] })).toString();
}
const day = utcDay(Date.now());
const rep = buildDailyReport(ledger, policy, day, net.explorerUrl);
fs.writeFileSync('docs/live/report.json', JSON.stringify(rep, null, 2));
fs.writeFileSync('docs/live/report.md', reportToMarkdown(rep, net.nativeToken));
fs.writeFileSync('docs/live/report.html', reportToHtml(rep, net.nativeToken));
const prev = fs.existsSync('docs/live/demo-output.json') ? JSON.parse(fs.readFileSync('docs/live/demo-output.json', 'utf8')) : { runs: [] };
prev.runs.push({ network: net.name, chainId: net.chainId, sponsor: chain.sponsor, executor: policy.executor, guestbook, steps, guestbookCheckIns: checkIns });
fs.writeFileSync('docs/live/demo-output.json', JSON.stringify(prev, null, 2));
console.log('checkIns', checkIns);
