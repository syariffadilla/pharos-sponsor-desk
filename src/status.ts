import { formatEther, type Address } from 'viem';
import { delegatedTo, publicClientFor, type NetworkInfo } from './chain.js';
import type { Ledger } from './ledger.js';
import { utcDay } from './ledger.js';
import { McpClient } from './mcp.js';
import type { Policy } from './types.js';

export interface DeskStatus {
  source: 'rpc' | 'mcp';
  network: string;
  chainId: number;
  chainIdMatches: boolean;
  latestBlock: string;
  sponsor?: { address: string; balance: string; balanceWei: string };
  executorDeployed?: boolean;
  today: { day: string; spentWei: string; budgetWei: string; remainingWei: string; sponsored: number; rejected: number };
  accounts?: { address: string; balanceWei: string; delegatedTo: string | null }[];
  warning?: string;
}

/** Read-only status via JSON-RPC. Never signs or sends anything. */
export async function rpcStatus(net: NetworkInfo, policy: Policy, ledger: Ledger, sponsor?: Address, accounts: Address[] = []): Promise<DeskStatus> {
  const pub = publicClientFor(net);
  const [chainId, block] = await Promise.all([pub.getChainId(), pub.getBlockNumber()]);
  const out: DeskStatus = {
    source: 'rpc',
    network: net.name,
    chainId,
    chainIdMatches: chainId === net.chainId,
    latestBlock: block.toString(),
    today: todayBlock(ledger, policy),
  };
  if (sponsor) {
    const bal = await pub.getBalance({ address: sponsor });
    out.sponsor = { address: sponsor, balance: formatEther(bal), balanceWei: bal.toString() };
  }
  const code = await pub.getCode({ address: policy.executor }).catch(() => undefined);
  out.executorDeployed = !!code && code !== '0x';
  out.accounts = [];
  for (const a of accounts) {
    const [b, c] = await Promise.all([pub.getBalance({ address: a }), pub.getCode({ address: a })]);
    out.accounts.push({ address: a, balanceWei: b.toString(), delegatedTo: delegatedTo((c ?? '0x') as any) });
  }
  return out;
}

/** Read-only status via a Pharos Chain MCP server (hosted = mainnet; self-host for Atlantic). */
export async function mcpStatus(mcpUrl: string, expectedChainId: number, policy: Policy, ledger: Ledger, sponsor?: Address): Promise<DeskStatus> {
  const m = new McpClient(mcpUrl);
  await m.init();
  const info = await m.call('get_chain_info');
  const out: DeskStatus = {
    source: 'mcp',
    network: String(info.name ?? 'unknown'),
    chainId: Number(info.chainId),
    chainIdMatches: Number(info.chainId) === expectedChainId,
    latestBlock: String(info.latestBlock),
    today: todayBlock(ledger, policy),
  };
  if (!out.chainIdMatches)
    out.warning = `MCP server is on chainId ${out.chainId}, desk expects ${expectedChainId}. The hosted server (mcp.pharos.xyz) serves Pacific mainnet; self-host pharos-mcp with PHAROS_RPC_URL/PHAROS_CHAIN_ID for Atlantic.`;
  if (sponsor) {
    const b = await m.call('get_balance', { address: sponsor });
    const wei = String(b.balanceWei ?? b.wei ?? b.balance ?? '');
    out.sponsor = { address: sponsor, balance: String(b.balance ?? b.formatted ?? ''), balanceWei: wei };
  }
  return out;
}

function todayBlock(ledger: Ledger, policy: Policy) {
  const day = utcDay(Date.now());
  const spent = ledger.globalSpend(day);
  const budget = BigInt(policy.globalDaily.maxGasWei);
  const es = ledger.forDay(day);
  return {
    day,
    spentWei: spent.toString(),
    budgetWei: budget.toString(),
    remainingWei: (budget > spent ? budget - spent : 0n).toString(),
    sponsored: es.filter((e) => e.decision === 'sponsored').length,
    rejected: es.filter((e) => e.decision === 'rejected').length,
  };
}

/** Read-only check of one sponsored tx: who sent it, who it targeted, type, status, gas. */
export async function verifyTx(hash: `0x${string}`, net: NetworkInfo, mcpUrl?: string) {
  if (mcpUrl) {
    const m = new McpClient(mcpUrl);
    await m.init();
    const tx = await m.call('get_transaction', { hash });
    const rc = await m.call('get_transaction_receipt', { hash });
    return { source: 'mcp', hash, tx, receipt: rc };
  }
  const pub = publicClientFor(net);
  const [tx, rc] = await Promise.all([pub.getTransaction({ hash }), pub.getTransactionReceipt({ hash })]);
  return {
    source: 'rpc',
    hash,
    type: tx.type,
    gasPayer: tx.from,
    account: tx.to,
    authorizationList: (tx as any).authorizationList ?? null,
    status: rc.status,
    gasUsed: rc.gasUsed.toString(),
    effectiveGasPrice: rc.effectiveGasPrice.toString(),
    costWei: (rc.gasUsed * rc.effectiveGasPrice).toString(),
    blockNumber: rc.blockNumber.toString(),
  };
}
