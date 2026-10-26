// Append-only, hash-chained JSONL audit log of every gatekeeper decision (allow and deny).
// Each line carries prevHash + hash, so editing or deleting a past line breaks `verify()`.
import fs from 'node:fs';
import path from 'node:path';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { isoUtc } from './ledger.js';
import type { DecidedBy, Decision, LedgerEntry, Reason, RuleTrace, SponsorRequest, Verdict } from './types.js';

export const GENESIS: Hex = `0x${'0'.repeat(64)}`;

/** Deterministic JSON (sorted keys) so hashes are reproducible. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(typeof v === 'bigint' ? v.toString() : v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(',')}}`;
}

/** keccak256 of the request's canonical JSON. Identifies exactly what was asked, including its signature. */
export function requestHash(req: SponsorRequest): Hex {
  return keccak256(toHex(stableStringify(req)));
}

export interface AuditEntry {
  seq: number;
  ts: number; // unix ms
  time: string; // ISO-8601 UTC
  requestHash: Hex;
  sender: Address;
  label?: string;
  network: string;
  chainId: number;
  verdict: Verdict;
  decision: Decision;
  decidedBy: DecidedBy;
  reasons: Reason[];
  trace: RuleTrace[];
  targets: { to: Address; selector: Hex; method?: string }[];
  executed: boolean; // true only if a transaction was broadcast
  txHash: Hex | null;
  txType?: string;
  blockNumber?: string;
  gasUsed?: string;
  costWei?: string;
  ledgerId: string;
  prevHash: Hex;
  hash: Hex;
}

export type AuditInput = Omit<AuditEntry, 'seq' | 'time' | 'prevHash' | 'hash'>;

export function hashEntry(e: Omit<AuditEntry, 'hash'>): Hex {
  return keccak256(toHex(stableStringify(e)));
}

export function auditInputFrom(entry: LedgerEntry, trace: RuleTrace[]): AuditInput {
  return {
    ts: entry.ts,
    requestHash: entry.requestHash!,
    sender: entry.account,
    label: entry.label,
    network: entry.network,
    chainId: entry.chainId,
    verdict: entry.verdict!,
    decision: entry.decision,
    decidedBy: entry.decidedBy!,
    reasons: entry.reasons,
    trace,
    targets: entry.targets,
    executed: !!entry.txHash,
    txHash: entry.txHash ?? null,
    txType: entry.txType,
    blockNumber: entry.blockNumber,
    gasUsed: entry.gasUsed,
    costWei: entry.costWei,
    ledgerId: entry.id,
  };
}

export class AuditLog {
  private entries: AuditEntry[] = [];

  constructor(private file: string | null = null) {
    if (file && fs.existsSync(file)) {
      this.entries = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }
  }

  static memory(): AuditLog {
    return new AuditLog(null);
  }

  append(input: AuditInput): AuditEntry {
    const prev = this.entries[this.entries.length - 1];
    const body: Omit<AuditEntry, 'hash'> = {
      seq: (prev?.seq ?? 0) + 1,
      time: isoUtc(input.ts),
      ...input,
      prevHash: prev?.hash ?? GENESIS,
    };
    const e: AuditEntry = { ...body, hash: hashEntry(body) };
    this.entries.push(e);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n'); // append-only: never rewrites earlier lines
    }
    return e;
  }

  all(): AuditEntry[] {
    return [...this.entries];
  }

  /** Recompute the hash chain. Returns the first broken sequence number, if any. */
  verify(): { ok: boolean; entries: number; brokenAt: number | null; problem?: string } {
    let prev: Hex = GENESIS;
    for (const e of this.entries) {
      const { hash, ...body } = e;
      if (e.prevHash !== prev) return { ok: false, entries: this.entries.length, brokenAt: e.seq, problem: 'prevHash does not match previous entry' };
      if (hashEntry(body) !== hash) return { ok: false, entries: this.entries.length, brokenAt: e.seq, problem: 'entry contents changed after it was written' };
      prev = hash;
    }
    return { ok: true, entries: this.entries.length, brokenAt: null };
  }

  summary() {
    const byVerdict = { allow: 0, deny: 0 };
    const byRuleType: Record<string, number> = {};
    let executed = 0;
    for (const e of this.entries) {
      byVerdict[e.verdict]++;
      if (e.verdict === 'deny') byRuleType[e.decidedBy.ruleType] = (byRuleType[e.decidedBy.ruleType] ?? 0) + 1;
      if (e.executed) executed++;
    }
    const deniedButExecuted = this.entries.filter((e) => e.verdict === 'deny' && e.executed).length;
    return { entries: this.entries.length, ...byVerdict, executed, deniedButExecuted, denialsByRuleType: byRuleType };
  }
}

const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-4)}` : '-');

export function auditToCsv(entries: AuditEntry[]): string {
  const cols = ['seq', 'time', 'verdict', 'decision', 'rule', 'ruleType', 'code', 'sender', 'requestHash', 'executed', 'txHash', 'message'];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = entries.map((e) =>
    [e.seq, e.time, e.verdict, e.decision, e.decidedBy.rule, e.decidedBy.ruleType, e.decidedBy.code, e.sender, e.requestHash, e.executed, e.txHash ?? '', e.decidedBy.message]
      .map(esc)
      .join(','),
  );
  return [cols.join(','), ...rows].join('\n') + '\n';
}

export function auditToMarkdown(entries: AuditEntry[], explorerUrl?: string): string {
  const tx = (h: string | null) => (!h ? 'not executed' : explorerUrl ? `[${short(h)}](${explorerUrl.replace(/\/$/, '')}/tx/${h})` : short(h));
  const lines = [
    '| # | Time (UTC) | Verdict | Deciding rule | Sender | Request hash | Tx |',
    '|---|---|---|---|---|---|---|',
    ...entries.map(
      (e) =>
        `| ${e.seq} | ${e.time} | **${e.verdict.toUpperCase()}** | \`${e.decidedBy.rule}\` (${e.decidedBy.code}) | \`${short(e.sender)}\` | \`${short(e.requestHash)}\` | ${tx(e.txHash)} |`,
    ),
  ];
  return lines.join('\n') + '\n';
}
