import { toFunctionSelector, type Hex } from 'viem';
import fs from 'node:fs';
import type { Ledger } from './ledger.js';
import { utcDay } from './ledger.js';
import { checkTimeWindow, describeWindow, reason, validateTimeWindow } from './rules.js';
import type { AllowEntry, Policy, Reason, SponsorRequest } from './types.js';

const lc = (a: string) => a.toLowerCase();
const isAddr = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * Policy files come in two shapes. The gatekeeper shape groups the three rule types explicitly:
 *   { network, executor, rules: { spendLimit: {...}, allowlist: {...}, timeWindow: {...} }, maxCallsPerRequest, ... }
 * The legacy flat shape ({ allowlist: [...], perAddressDaily, globalDaily, maxGasPerTx, ... }) is still accepted.
 * Both normalize to the same internal Policy.
 */
export function normalizePolicy(raw: any): Policy {
  if (!raw?.rules) return raw as Policy;
  const { rules, ...rest } = raw;
  const sl = rules.spendLimit ?? {};
  const al = rules.allowlist ?? {};
  const p: any = {
    ...rest,
    allowlist: al.contracts,
    senders: al.senders,
    allowValue: al.allowValue ?? rest.allowValue ?? false,
    maxGasPerTx: sl.maxGasPerTx,
    maxCostPerTxWei: sl.maxCostPerTxWei,
    perAddressDaily: sl.perAddressDaily,
    globalDaily: sl.globalDaily,
    timeWindow: rules.timeWindow,
  };
  for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];
  return p as Policy;
}

export function loadPolicy(file: string): Policy {
  const p = normalizePolicy(JSON.parse(fs.readFileSync(file, 'utf8')));
  validatePolicy(p);
  return p;
}

export function validatePolicy(p: Policy): void {
  const need = ['network', 'executor', 'allowlist', 'perAddressDaily', 'globalDaily', 'maxGasPerTx', 'heuristics'] as const;
  for (const k of need) if ((p as any)[k] === undefined) throw new Error(`policy missing "${k}"`);
  if (!Array.isArray(p.allowlist) || p.allowlist.length === 0) throw new Error('policy allowlist must not be empty');
  for (const a of p.allowlist) {
    if (!isAddr(a.address)) throw new Error(`bad allowlist address ${a.address}`);
    if (a.timeWindow) validateTimeWindow(a.timeWindow, `allowlist[${a.label ?? a.address}].timeWindow`);
  }
  for (const k of ['allow', 'deny'] as const)
    for (const a of p.senders?.[k] ?? []) if (!isAddr(a)) throw new Error(`bad senders.${k} address ${a}`);
  if (p.maxCostPerTxWei !== undefined && !/^\d+$/.test(p.maxCostPerTxWei)) throw new Error('maxCostPerTxWei must be a decimal wei string');
  if (p.timeWindow) validateTimeWindow(p.timeWindow);
}

/** Human/agent-readable summary of the three gatekeeper rule types in a policy. */
export function describeRules(p: Policy) {
  return {
    spend_limit: {
      'spend_limit.max_gas_per_tx': p.maxGasPerTx,
      'spend_limit.max_cost_per_tx': p.maxCostPerTxWei ?? null,
      'spend_limit.per_address_daily_tx': p.perAddressDaily.maxTx,
      'spend_limit.per_address_daily_gas': p.perAddressDaily.maxGasWei,
      'spend_limit.global_daily_budget': p.globalDaily.maxGasWei,
    },
    allowlist: {
      'allowlist.contract+method': p.allowlist.map((a) => ({ address: a.address, label: a.label, methods: a.methods ?? ['*'] })),
      'allowlist.sender': p.senders?.allow?.length ? p.senders.allow : 'any',
      'allowlist.sender_denylist': p.senders?.deny ?? [],
      'allowlist.native_value': p.allowValue ? 'allowed' : 'denied',
    },
    time_window: {
      'time_window.hours (desk)': p.timeWindow ? describeWindow(p.timeWindow) : 'always open',
      'time_window.blackout (desk)': p.timeWindow?.blackouts ?? [],
      'time_window.hours (per contract)': p.allowlist
        .filter((a) => a.timeWindow)
        .map((a) => ({ address: a.address, label: a.label, window: describeWindow(a.timeWindow!), blackouts: a.timeWindow!.blackouts ?? [] })),
    },
  };
}

export function selectorOf(data: Hex): Hex {
  return (data.length >= 10 ? data.slice(0, 10) : '0x') as Hex;
}

/**
 * Map selector -> method signature for every allowlisted method of `to`, or null if target not listed.
 * A contract may appear in several allowlist entries (e.g. one per method group with its own time window).
 */
export function allowedSelectors(p: Policy, to: string): Map<string, string> | null {
  const entries = p.allowlist.filter((a) => lc(a.address) === lc(to));
  if (!entries.length) return null;
  const m = new Map<string, string>();
  for (const entry of entries) {
    for (const sig of entry.methods ?? []) m.set(toFunctionSelector(sig).toLowerCase(), sig);
    if (!entry.methods || entry.methods.length === 0) m.set('*', '*');
  }
  return m;
}

/** The allowlist entries a call matches (same address, and the selector is listed or the entry allows all). */
export function matchingEntries(p: Policy, to: string, data: Hex): AllowEntry[] {
  const sel = selectorOf(data).toLowerCase();
  return p.allowlist.filter(
    (a) => lc(a.address) === lc(to) && (!a.methods?.length || a.methods.some((sig) => toFunctionSelector(sig).toLowerCase() === sel)),
  );
}

/** Request validity: chain, deadline window, batch size. */
export function requestChecks(p: Policy, req: SponsorRequest, chainId: number, nowSec: number): Reason[] {
  const r: Reason[] = [];
  if (req.chainId !== chainId) r.push(reason('WRONG_CHAIN', `request chainId ${req.chainId} != desk chainId ${chainId}`));
  if (req.deadline < nowSec) r.push(reason('EXPIRED', `deadline ${req.deadline} is in the past`));
  if (req.deadline > nowSec + p.maxDeadlineSec) r.push(reason('DEADLINE_TOO_FAR', `deadline more than ${p.maxDeadlineSec}s ahead`));
  if (!req.calls?.length) r.push(reason('NO_CALLS', 'request has no calls'));
  if (req.calls?.length > p.maxCallsPerRequest) r.push(reason('TOO_MANY_CALLS', `${req.calls.length} calls > max ${p.maxCallsPerRequest}`));
  return r;
}

/** Allowlist rule type: sender allow/deny, contract + 4-byte selector, native value. */
export function allowlistChecks(p: Policy, req: SponsorRequest): Reason[] {
  const r: Reason[] = [];
  const who = lc(req.account ?? '');
  if (p.senders?.deny?.some((a) => lc(a) === who)) r.push(reason('SENDER_DENYLISTED', `sender ${req.account} is on the denylist`));
  if (p.senders?.allow?.length && !p.senders.allow.some((a) => lc(a) === who))
    r.push(reason('SENDER_NOT_ALLOWLISTED', `sender ${req.account} is not on the sender allowlist`));
  for (const [i, c] of (req.calls ?? []).entries()) {
    const sels = allowedSelectors(p, c.to);
    if (!sels) {
      r.push(reason('NOT_ALLOWLISTED_TARGET', `call ${i}: target ${c.to} is not on the allowlist`));
      continue;
    }
    const sel = selectorOf(c.data).toLowerCase();
    if (!sels.has('*') && !sels.has(sel))
      r.push(reason('NOT_ALLOWLISTED_METHOD', `call ${i}: selector ${sel} on ${c.to} is not an allowlisted method`));
    if (BigInt(c.value || '0') > 0n && !p.allowValue) r.push(reason('VALUE_NOT_ALLOWED', `call ${i}: native value transfers are not sponsored`));
  }
  return r;
}

/** Time-window rule type: desk-wide window + blackouts, then per-contract windows. */
export function timeWindowChecks(p: Policy, req: SponsorRequest, nowMs: number): Reason[] {
  const r: Reason[] = [];
  if (p.timeWindow) {
    const d = checkTimeWindow(p.timeWindow, nowMs, 'desk');
    if (d) r.push(d);
  }
  const seen = new Set<AllowEntry>();
  for (const c of req.calls ?? []) {
    for (const entry of matchingEntries(p, c.to, c.data)) {
      if (!entry.timeWindow || seen.has(entry)) continue;
      seen.add(entry);
      const d = checkTimeWindow(entry.timeWindow, nowMs, entry.label ?? entry.address);
      if (d) r.push(d);
    }
  }
  return r;
}

/** Checks that need only the request and the clock (request validity + allowlist). Kept for compatibility. */
export function staticChecks(p: Policy, req: SponsorRequest, chainId: number, nowSec: number): Reason[] {
  return [...requestChecks(p, req, chainId, nowSec), ...allowlistChecks(p, req)];
}

export interface QuotaFacts {
  account: SponsorRequest['account'];
  nowMs: number;
  onchainNonce: number; // account tx nonce, used for the "fresh address" heuristic
  worstCaseWei: bigint; // gasLimit * maxFeePerGas for this request
}

/** Spend-limit rule type: per-tx worst-case cost, per-address daily tx + wei quota, global daily budget. */
export function spendChecks(p: Policy, ledger: Ledger, f: QuotaFacts): Reason[] {
  const r: Reason[] = [];
  const day = utcDay(f.nowMs);
  if (p.maxCostPerTxWei !== undefined && f.worstCaseWei > BigInt(p.maxCostPerTxWei))
    r.push(reason('SPEND_LIMIT_PER_TX', `worst-case cost ${f.worstCaseWei} wei > per-tx limit ${p.maxCostPerTxWei} wei`));
  const use = ledger.accountUsage(f.account, day);
  if (use.tx >= p.perAddressDaily.maxTx)
    r.push(reason('ADDRESS_DAILY_TX_QUOTA', `${use.tx}/${p.perAddressDaily.maxTx} sponsored tx already used today (UTC ${day})`));
  if (use.wei + f.worstCaseWei > BigInt(p.perAddressDaily.maxGasWei))
    r.push(reason('ADDRESS_DAILY_GAS_QUOTA', `address spend ${use.wei} + worst case ${f.worstCaseWei} > daily cap ${p.perAddressDaily.maxGasWei} wei`));
  const spent = ledger.globalSpend(day);
  if (spent + f.worstCaseWei > BigInt(p.globalDaily.maxGasWei))
    r.push(reason('GLOBAL_DAILY_BUDGET', `global spend ${spent} + worst case ${f.worstCaseWei} > budget ${p.globalDaily.maxGasWei} wei`));
  return r;
}

/** Abuse heuristics: repeated failures, per-address burst, brand-new-address burst. */
export function abuseChecks(p: Policy, ledger: Ledger, f: QuotaFacts): Reason[] {
  const r: Reason[] = [];
  const h = p.heuristics;
  const fails = ledger.failuresSince(f.account, f.nowMs - h.failureWindowSec * 1000);
  if (fails >= h.maxFailures)
    r.push(reason('REPEATED_FAILURES', `${fails} failed requests in the last ${h.failureWindowSec}s (max ${h.maxFailures - 1})`));
  const recent = ledger.requestsSince(f.account, f.nowMs - h.burstWindowSec * 1000);
  if (recent >= h.maxRequestsPerBurst)
    r.push(reason('ADDRESS_BURST', `${recent} requests in the last ${h.burstWindowSec}s (max ${h.maxRequestsPerBurst})`));
  const isNew = !ledger.hasSeen(f.account) && f.onchainNonce <= h.freshNonceThreshold;
  if (isNew) {
    const n = ledger.newAccountsSince(f.nowMs - h.newAddressWindowSec * 1000);
    if (n >= h.maxNewAddressesPerWindow)
      r.push(reason('NEW_ADDRESS_BURST', `${n} new fresh addresses already admitted in the last ${h.newAddressWindowSec}s (max ${h.maxNewAddressesPerWindow})`));
  }
  return r;
}

/** Quota, budget and abuse heuristics, evaluated against the ledger. Kept for compatibility. */
export function ledgerChecks(p: Policy, ledger: Ledger, f: QuotaFacts): Reason[] {
  return [...abuseChecks(p, ledger, f), ...spendChecks(p, ledger, f)];
}
