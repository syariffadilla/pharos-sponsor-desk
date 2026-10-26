import { toFunctionSelector, type Hex } from 'viem';
import fs from 'node:fs';
import type { Ledger } from './ledger.js';
import { utcDay } from './ledger.js';
import type { Policy, Reason, SponsorRequest } from './types.js';

const lc = (a: string) => a.toLowerCase();

export function loadPolicy(file: string): Policy {
  const p = JSON.parse(fs.readFileSync(file, 'utf8')) as Policy;
  validatePolicy(p);
  return p;
}

export function validatePolicy(p: Policy): void {
  const need = ['network', 'executor', 'allowlist', 'perAddressDaily', 'globalDaily', 'maxGasPerTx', 'heuristics'] as const;
  for (const k of need) if ((p as any)[k] === undefined) throw new Error(`policy missing "${k}"`);
  if (!Array.isArray(p.allowlist) || p.allowlist.length === 0) throw new Error('policy allowlist must not be empty');
  for (const a of p.allowlist) if (!/^0x[0-9a-fA-F]{40}$/.test(a.address)) throw new Error(`bad allowlist address ${a.address}`);
}

export function selectorOf(data: Hex): Hex {
  return (data.length >= 10 ? data.slice(0, 10) : '0x') as Hex;
}

/** Map selector -> method signature for every allowlisted method of `to`, or null if target not listed. */
export function allowedSelectors(p: Policy, to: string): Map<string, string> | null {
  const entry = p.allowlist.find((a) => lc(a.address) === lc(to));
  if (!entry) return null;
  const m = new Map<string, string>();
  for (const sig of entry.methods ?? []) m.set(toFunctionSelector(sig).toLowerCase(), sig);
  if (!entry.methods || entry.methods.length === 0) m.set('*', '*');
  return m;
}

/** Checks that need only the request and the clock. */
export function staticChecks(p: Policy, req: SponsorRequest, chainId: number, nowSec: number): Reason[] {
  const r: Reason[] = [];
  if (req.chainId !== chainId) r.push({ code: 'WRONG_CHAIN', message: `request chainId ${req.chainId} != desk chainId ${chainId}` });
  if (req.deadline < nowSec) r.push({ code: 'EXPIRED', message: `deadline ${req.deadline} is in the past` });
  if (req.deadline > nowSec + p.maxDeadlineSec)
    r.push({ code: 'DEADLINE_TOO_FAR', message: `deadline more than ${p.maxDeadlineSec}s ahead` });
  if (!req.calls?.length) r.push({ code: 'NO_CALLS', message: 'request has no calls' });
  if (req.calls?.length > p.maxCallsPerRequest)
    r.push({ code: 'TOO_MANY_CALLS', message: `${req.calls.length} calls > max ${p.maxCallsPerRequest}` });
  for (const [i, c] of (req.calls ?? []).entries()) {
    const sels = allowedSelectors(p, c.to);
    if (!sels) {
      r.push({ code: 'NOT_ALLOWLISTED_TARGET', message: `call ${i}: target ${c.to} is not on the allowlist` });
      continue;
    }
    const sel = selectorOf(c.data).toLowerCase();
    if (!sels.has('*') && !sels.has(sel))
      r.push({ code: 'NOT_ALLOWLISTED_METHOD', message: `call ${i}: selector ${sel} on ${c.to} is not an allowlisted method` });
    if (BigInt(c.value || '0') > 0n && !p.allowValue)
      r.push({ code: 'VALUE_NOT_ALLOWED', message: `call ${i}: native value transfers are not sponsored` });
  }
  return r;
}

export interface QuotaFacts {
  account: SponsorRequest['account'];
  nowMs: number;
  onchainNonce: number; // account tx nonce, used for the "fresh address" heuristic
  worstCaseWei: bigint; // gasLimit * maxFeePerGas for this request
}

/** Quota, budget and abuse heuristics, evaluated against the ledger. */
export function ledgerChecks(p: Policy, ledger: Ledger, f: QuotaFacts): Reason[] {
  const r: Reason[] = [];
  const day = utcDay(f.nowMs);
  const h = p.heuristics;

  // Repeated failures -> cooldown
  const fails = ledger.failuresSince(f.account, f.nowMs - h.failureWindowSec * 1000);
  if (fails >= h.maxFailures)
    r.push({ code: 'REPEATED_FAILURES', message: `${fails} failed requests in the last ${h.failureWindowSec}s (max ${h.maxFailures - 1})` });

  // Per-address burst
  const recent = ledger.requestsSince(f.account, f.nowMs - h.burstWindowSec * 1000);
  if (recent >= h.maxRequestsPerBurst)
    r.push({ code: 'ADDRESS_BURST', message: `${recent} requests in the last ${h.burstWindowSec}s (max ${h.maxRequestsPerBurst})` });

  // Brand-new address bursts (many never-seen, fresh accounts arriving at once)
  const isNew = !ledger.hasSeen(f.account) && f.onchainNonce <= h.freshNonceThreshold;
  if (isNew) {
    const n = ledger.newAccountsSince(f.nowMs - h.newAddressWindowSec * 1000);
    if (n >= h.maxNewAddressesPerWindow)
      r.push({
        code: 'NEW_ADDRESS_BURST',
        message: `${n} new fresh addresses already admitted in the last ${h.newAddressWindowSec}s (max ${h.maxNewAddressesPerWindow})`,
      });
  }

  // Per-address daily quota
  const use = ledger.accountUsage(f.account, day);
  if (use.tx >= p.perAddressDaily.maxTx)
    r.push({ code: 'ADDRESS_DAILY_TX_QUOTA', message: `${use.tx}/${p.perAddressDaily.maxTx} sponsored tx already used today (UTC ${day})` });
  if (use.wei + f.worstCaseWei > BigInt(p.perAddressDaily.maxGasWei))
    r.push({
      code: 'ADDRESS_DAILY_GAS_QUOTA',
      message: `address spend ${use.wei} + worst case ${f.worstCaseWei} > daily cap ${p.perAddressDaily.maxGasWei} wei`,
    });

  // Global daily budget
  const spent = ledger.globalSpend(day);
  if (spent + f.worstCaseWei > BigInt(p.globalDaily.maxGasWei))
    r.push({ code: 'GLOBAL_DAILY_BUDGET', message: `global spend ${spent} + worst case ${f.worstCaseWei} > budget ${p.globalDaily.maxGasWei} wei` });

  return r;
}
