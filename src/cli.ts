#!/usr/bin/env -S npx tsx
// Sponsor Desk CLI. Every command prints one JSON object to stdout so an agent can parse it.
import fs from 'node:fs';
import path from 'node:path';
import { encodeFunctionData, parseAbiItem, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { addrUrl, loadNetwork, txUrl, ViemChain, delegatedTo, publicClientFor } from './chain.js';
import { SponsorDesk } from './desk.js';
import { Ledger, utcDay } from './ledger.js';
import { loadPolicy } from './policy.js';
import { buildDailyReport, reportToHtml, reportToMarkdown } from './report.js';
import { buildSponsorRequest } from './request.js';
import { mcpStatus, rpcStatus, verifyTx } from './status.js';
import type { SponsorRequest } from './types.js';

const argv = process.argv.slice(2);
const cmd = argv[0];
function opt(name: string, def?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
}
const flag = (name: string) => argv.includes(`--${name}`);
const out = (o: unknown) => console.log(JSON.stringify(o, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));

const policyPath = opt('policy', process.env.DESK_POLICY ?? 'policy.json')!;
const ledgerPath = opt('ledger', process.env.DESK_LEDGER ?? 'data/ledger.jsonl')!;

function keyFromEnv(name: string): Hex {
  const k = process.env[name];
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`${name} is not set (expected 0x-prefixed 32-byte hex). It is read from the environment only and never printed.`);
  return k as Hex;
}

async function main() {
  switch (cmd) {
    case 'status': {
      const policy = loadPolicy(policyPath);
      const net = loadNetwork(opt('network', policy.network));
      const ledger = new Ledger(ledgerPath);
      const sponsor = process.env.SPONSOR_PRIVATE_KEY ? privateKeyToAccount(keyFromEnv('SPONSOR_PRIVATE_KEY')).address : (opt('sponsor') as Address | undefined);
      const accounts = argv.flatMap((a, i) => (argv[i - 1] === '--account' ? [a as Address] : []));
      const mcp = opt('mcp');
      return out(mcp ? await mcpStatus(mcp, net.chainId, policy, ledger, sponsor) : await rpcStatus(net, policy, ledger, sponsor, accounts));
    }
    case 'policy': {
      const p = loadPolicy(policyPath);
      return out({ ok: true, policyPath, policy: p });
    }
    case 'request:build': {
      // USER SIDE. Signs with USER_PRIVATE_KEY (or --user-key-env NAME). Output contains no key.
      const policy = loadPolicy(policyPath);
      const net = loadNetwork(opt('network', policy.network));
      const user = privateKeyToAccount(keyFromEnv(opt('user-key-env', 'USER_PRIVATE_KEY')!));
      const to = opt('to') as Address;
      const sig = opt('method');
      if (!to || !sig) throw new Error('need --to <address> --method "fn(type,...)" [--args JSON]');
      const args = JSON.parse(opt('args', '[]')!);
      const item = parseAbiItem(`function ${sig}`) as any;
      const data = encodeFunctionData({ abi: [item], functionName: item.name, args });
      const pub = publicClientFor(net);
      const [code, txNonce] = await Promise.all([pub.getCode({ address: user.address }), pub.getTransactionCount({ address: user.address })]);
      const d = delegatedTo((code ?? '0x') as Hex);
      const delegated = !!d && d.toLowerCase() === policy.executor.toLowerCase();
      const execNonce = delegated
        ? await pub.readContract({ address: user.address, abi: [parseAbiItem('function nonce() view returns (uint256)')], functionName: 'nonce' })
        : 0n;
      const req = await buildSponsorRequest({
        user,
        chainId: net.chainId,
        executor: policy.executor,
        calls: [{ to, value: '0', data }],
        executorNonce: execNonce,
        accountTxNonce: txNonce,
        needsAuthorization: !delegated,
        ttlSec: Number(opt('ttl', '600')),
        label: opt('label'),
      });
      const file = opt('out');
      if (file) fs.writeFileSync(file, JSON.stringify(req, null, 2));
      return out({ ok: true, file: file ?? null, request: req });
    }
    case 'sponsor': {
      // OPERATOR SIDE. Pays gas with SPONSOR_PRIVATE_KEY if the request passes policy.
      const policy = loadPolicy(policyPath);
      const net = loadNetwork(opt('network', policy.network));
      const file = opt('request');
      if (!file) throw new Error('need --request <file.json>');
      const req = JSON.parse(fs.readFileSync(file, 'utf8')) as SponsorRequest;
      const chain = new ViemChain(net, keyFromEnv('SPONSOR_PRIVATE_KEY'));
      const desk = new SponsorDesk(policy, chain, new Ledger(ledgerPath), { dryRun: flag('dry-run') });
      const r = await desk.handle(req);
      return out({
        decision: r.decision,
        reasons: r.reasons,
        account: req.account,
        sponsor: chain.sponsor,
        txHash: r.entry.txHash ?? null,
        explorer: r.entry.txHash ? txUrl(net, r.entry.txHash) : null,
        gasUsed: r.entry.gasUsed ?? null,
        costWei: r.entry.costWei ?? null,
        ledgerId: r.entry.id,
      });
    }
    case 'report': {
      const policy = loadPolicy(policyPath);
      const net = loadNetwork(opt('network', policy.network));
      const day = opt('day', utcDay(Date.now()))!;
      const rep = buildDailyReport(new Ledger(ledgerPath), policy, day, net.explorerUrl);
      const fmt = opt('format', 'json');
      const body = fmt === 'md' ? reportToMarkdown(rep, net.nativeToken) : fmt === 'html' ? reportToHtml(rep, net.nativeToken) : JSON.stringify(rep, null, 2);
      const file = opt('out');
      if (file) {
        fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
        fs.writeFileSync(file, body);
        return out({ ok: true, file, day, totals: rep.totals });
      }
      return fmt === 'json' ? out(rep) : console.log(body);
    }
    case 'ledger': {
      const l = new Ledger(ledgerPath);
      const day = opt('day');
      return out(day ? l.forDay(day) : l.all());
    }
    case 'verify': {
      const policy = loadPolicy(policyPath);
      const net = loadNetwork(opt('network', policy.network));
      const h = argv[1] as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(h ?? '')) throw new Error('usage: verify <txHash> [--mcp url]');
      return out({ ...(await verifyTx(h, net, opt('mcp'))), explorer: txUrl(net, h) });
    }
    case 'explorer': {
      const policy = loadPolicy(policyPath);
      const net = loadNetwork(opt('network', policy.network));
      const v = argv[1];
      return out({ url: v?.length === 66 ? txUrl(net, v) : addrUrl(net, v) });
    }
    default:
      console.log(`pharos-sponsor-desk
Usage: npx tsx src/cli.ts <command> [options]
  status [--mcp <url>] [--account 0x..]      read-only chain + budget status (RPC by default)
  policy                                     validate and print the policy
  request:build --to 0x.. --method "f(t)" --args '[..]' [--out req.json]   (user side, USER_PRIVATE_KEY)
  sponsor --request req.json [--dry-run]     evaluate + send with SPONSOR_PRIVATE_KEY paying gas
  report [--day YYYY-MM-DD] [--format json|md|html] [--out file]
  ledger [--day YYYY-MM-DD]
  verify <txHash> [--mcp <url>]              read-only: gas payer, account, type, status, cost
Common: --policy policy.json (DESK_POLICY)  --ledger data/ledger.jsonl (DESK_LEDGER)`);
  }
}

main().catch((e) => {
  out({ ok: false, error: String(e?.shortMessage ?? e?.message ?? e) });
  process.exit(1);
});
