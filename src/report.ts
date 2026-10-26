import { formatEther } from 'viem';
import { isoUtc, type Ledger } from './ledger.js';
import type { LedgerEntry, Policy } from './types.js';

export interface DailyReport {
  day: string; // UTC
  network: string;
  generatedAt: string;
  totals: { requests: number; sponsored: number; rejected: number; failed: number; spentWei: string; spent: string; budgetWei: string; budgetUsedPct: number };
  rejectionsByReason: Record<string, number>;
  byAccount: { account: string; sponsored: number; rejected: number; failed: number; spentWei: string }[];
  byTarget: { to: string; method: string; sponsored: number }[];
  transactions: { txHash: string; account: string; decision: string; gasUsed?: string; costWei?: string; url?: string }[];
}

export function buildDailyReport(ledger: Ledger, policy: Policy, day: string, explorerUrl?: string): DailyReport {
  const es = ledger.forDay(day);
  const spent = ledger.globalSpend(day);
  const budget = BigInt(policy.globalDaily.maxGasWei);
  const byReason: Record<string, number> = {};
  const accts = new Map<string, { sponsored: number; rejected: number; failed: number; wei: bigint }>();
  const tgts = new Map<string, { to: string; method: string; sponsored: number }>();
  for (const e of es) {
    const a = accts.get(e.account.toLowerCase()) ?? { sponsored: 0, rejected: 0, failed: 0, wei: 0n };
    if (e.decision !== 'dry-run') a[e.decision]++;
    if (e.txHash) a.wei += BigInt(e.costWei ?? e.reservedWei ?? '0');
    accts.set(e.account.toLowerCase(), a);
    if (e.decision === 'rejected') for (const r of e.reasons) byReason[r.code] = (byReason[r.code] ?? 0) + 1;
    if (e.decision === 'sponsored')
      for (const t of e.targets) {
        const k = `${t.to.toLowerCase()}:${t.selector}`;
        const v = tgts.get(k) ?? { to: t.to, method: t.method ?? t.selector, sponsored: 0 };
        v.sponsored++;
        tgts.set(k, v);
      }
  }
  const count = (d: LedgerEntry['decision']) => es.filter((e) => e.decision === d).length;
  const base = explorerUrl?.replace(/\/$/, '');
  return {
    day,
    network: policy.network,
    generatedAt: isoUtc(Date.now()),
    totals: {
      requests: es.length,
      sponsored: count('sponsored'),
      rejected: count('rejected'),
      failed: count('failed'),
      spentWei: spent.toString(),
      spent: formatEther(spent),
      budgetWei: budget.toString(),
      budgetUsedPct: budget > 0n ? Number((spent * 10000n) / budget) / 100 : 0,
    },
    rejectionsByReason: byReason,
    byAccount: [...accts.entries()].map(([account, v]) => ({ account, sponsored: v.sponsored, rejected: v.rejected, failed: v.failed, spentWei: v.wei.toString() })),
    byTarget: [...tgts.values()],
    transactions: es
      .filter((e) => e.txHash)
      .map((e) => ({ txHash: e.txHash!, account: e.account, decision: e.decision, gasUsed: e.gasUsed, costWei: e.costWei, url: base ? `${base}/tx/${e.txHash}` : undefined })),
  };
}

export function reportToMarkdown(r: DailyReport, symbol = 'PHRS'): string {
  const L: string[] = [];
  L.push(`# Sponsor Desk daily report: ${r.day} (UTC)`, '');
  L.push(`Network: \`${r.network}\` | generated ${r.generatedAt}`, '');
  L.push('| Requests | Sponsored | Rejected | Failed | Spent | Budget used |', '|---|---|---|---|---|---|');
  L.push(`| ${r.totals.requests} | ${r.totals.sponsored} | ${r.totals.rejected} | ${r.totals.failed} | ${r.totals.spent} ${symbol} | ${r.totals.budgetUsedPct}% |`, '');
  if (Object.keys(r.rejectionsByReason).length) {
    L.push('## Rejections by reason', '', '| Reason | Count |', '|---|---|');
    for (const [k, v] of Object.entries(r.rejectionsByReason)) L.push(`| ${k} | ${v} |`);
    L.push('');
  }
  if (r.byAccount.length) {
    L.push('## By account', '', '| Account | Sponsored | Rejected | Failed | Spent (wei) |', '|---|---|---|---|---|');
    for (const a of r.byAccount) L.push(`| \`${a.account}\` | ${a.sponsored} | ${a.rejected} | ${a.failed} | ${a.spentWei} |`);
    L.push('');
  }
  if (r.transactions.length) {
    L.push('## Transactions', '', '| Tx | Account | Result | Gas used | Cost (wei) |', '|---|---|---|---|---|');
    for (const t of r.transactions) L.push(`| ${t.url ? `[${t.txHash.slice(0, 12)}…](${t.url})` : t.txHash} | \`${t.account}\` | ${t.decision} | ${t.gasUsed ?? ''} | ${t.costWei ?? ''} |`);
    L.push('');
  }
  return L.join('\n');
}

/** Tiny static dashboard: one self-contained HTML file rendering the report JSON. */
export function reportToHtml(r: DailyReport, symbol = 'PHRS'): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const rows = r.transactions
    .map((t) => `<tr><td>${t.url ? `<a href="${esc(t.url)}">${esc(t.txHash.slice(0, 14))}…</a>` : esc(t.txHash)}</td><td><code>${esc(t.account)}</code></td><td>${esc(t.decision)}</td><td>${esc(t.gasUsed ?? '')}</td></tr>`)
    .join('');
  const rej = Object.entries(r.rejectionsByReason).map(([k, v]) => `<li><code>${esc(k)}</code>: ${v}</li>`).join('') || '<li>none</li>';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Sponsor Desk ${esc(r.day)}</title>
<style>body{font:14px system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}h1{font-size:1.3rem}.k{display:flex;gap:1rem;flex-wrap:wrap}.k div{border:1px solid #ddd;border-radius:8px;padding:.6rem 1rem}.k b{display:block;font-size:1.3rem}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:.35rem;text-align:left}code{font-size:12px}</style></head>
<body><h1>Sponsor Desk: ${esc(r.day)} (UTC), ${esc(r.network)}</h1>
<div class="k"><div><b>${r.totals.requests}</b>requests</div><div><b>${r.totals.sponsored}</b>sponsored</div><div><b>${r.totals.rejected}</b>rejected</div><div><b>${r.totals.failed}</b>failed</div><div><b>${esc(r.totals.spent)}</b>${symbol} spent</div><div><b>${r.totals.budgetUsedPct}%</b>of daily budget</div></div>
<h2>Rejections</h2><ul>${rej}</ul><h2>Transactions</h2><table><tr><th>Tx</th><th>Account</th><th>Result</th><th>Gas used</th></tr>${rows}</table>
<p><small>Generated ${esc(r.generatedAt)} from the desk ledger.</small></p></body></html>`;
}
