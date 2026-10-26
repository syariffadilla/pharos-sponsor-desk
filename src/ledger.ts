import fs from 'node:fs';
import path from 'node:path';
import type { Address } from 'viem';
import type { LedgerEntry } from './types.js';

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** ISO-8601 UTC timestamp built from getUTC* (does not depend on Date#toISOString). */
export function isoUtc(tsMs: number): string {
  const d = new Date(tsMs);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** UTC calendar day, YYYY-MM-DD. Quotas and budgets reset at 00:00 UTC. */
export function utcDay(tsMs: number): string {
  return isoUtc(tsMs).slice(0, 10);
}

const lc = (a: string) => a.toLowerCase();

/** Append-only JSONL spend ledger. Every decision (sponsored, rejected, failed) is one line. */
export class Ledger {
  private entries: LedgerEntry[] = [];

  constructor(private file: string | null = null) {
    if (file && fs.existsSync(file)) {
      this.entries = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    }
  }

  static memory(entries: LedgerEntry[] = []): Ledger {
    const l = new Ledger(null);
    l.entries = [...entries];
    return l;
  }

  append(e: LedgerEntry): void {
    this.entries.push(e);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    }
  }

  all(): LedgerEntry[] {
    return [...this.entries];
  }

  forDay(day: string): LedgerEntry[] {
    return this.entries.filter((e) => e.day === day);
  }

  hasSeen(account: Address): boolean {
    return this.entries.some((e) => lc(e.account) === lc(account));
  }

  /** Sponsored tx count + wei spent by one account on a UTC day. */
  accountUsage(account: Address, day: string): { tx: number; wei: bigint } {
    let tx = 0;
    let wei = 0n;
    for (const e of this.entries) {
      if (e.day !== day || lc(e.account) !== lc(account)) continue;
      if (e.txHash) {
        tx++;
        wei += BigInt(e.costWei ?? e.reservedWei ?? '0');
      }
    }
    return { tx, wei };
  }

  /** Total wei the sponsor spent on a UTC day (receipt cost, or reservation if no receipt). */
  globalSpend(day: string): bigint {
    return this.entries
      .filter((e) => e.day === day && e.txHash)
      .reduce((s, e) => s + BigInt(e.costWei ?? e.reservedWei ?? '0'), 0n);
  }

  /** Number of distinct accounts first seen by the desk since `sinceMs`. */
  newAccountsSince(sinceMs: number): number {
    return this.entries.filter((e) => e.firstSeen && e.ts >= sinceMs).length;
  }

  requestsSince(account: Address, sinceMs: number): number {
    return this.entries.filter((e) => lc(e.account) === lc(account) && e.ts >= sinceMs).length;
  }

  failuresSince(account: Address, sinceMs: number): number {
    return this.entries.filter(
      (e) =>
        lc(e.account) === lc(account) &&
        e.ts >= sinceMs &&
        (e.decision === 'failed' || e.reasons.some((r) => r.code === 'SIMULATION_FAILED' || r.code === 'BAD_SIGNATURE')),
    ).length;
  }
}
