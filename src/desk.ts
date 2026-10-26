import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { randomUUID } from 'node:crypto';
import type { ChainClient } from './chain.js';
import { delegatedTo } from './chain.js';
import { Ledger, utcDay } from './ledger.js';
import { abuseChecks, allowedSelectors, allowlistChecks, requestChecks, selectorOf, spendChecks, timeWindowChecks } from './policy.js';
import { recoverAuthSigner, recoverRequestSigner } from './request.js';
import { reason, withRule } from './rules.js';
import { AuditLog, auditInputFrom, requestHash, type AuditEntry } from './audit.js';
import type { DecidedBy, LedgerEntry, Policy, Reason, RuleTrace, RuleType, SponsorRequest, Verdict } from './types.js';

export const EXECUTE_ABI = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
      { name: 'deadline', type: 'uint256' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const satisfies Abi;

export function encodeExecute(req: SponsorRequest): Hex {
  return encodeFunctionData({
    abi: EXECUTE_ABI,
    functionName: 'execute',
    args: [req.calls.map((c) => ({ to: c.to, value: BigInt(c.value || '0'), data: c.data })), BigInt(req.deadline), req.signature],
  });
}

export interface DeskResult {
  decision: LedgerEntry['decision'];
  /** Gatekeeper verdict: "allow" means every rule passed (the tx was sent, or would be in a dry run). */
  verdict: Verdict;
  /** The specific rule that decided the request. */
  decidedBy: DecidedBy;
  reasons: Reason[];
  trace: RuleTrace[];
  entry: LedgerEntry;
  audit?: AuditEntry;
}

export interface DeskOptions {
  now?: () => number; // ms
  dryRun?: boolean; // evaluate + simulate but never send
  /** Append-only audit log; every decision (allow and deny, including dry runs) is written here. */
  audit?: AuditLog;
}

/** Gate stages in evaluation order. A deny at any stage stops evaluation: nothing after it runs. */
export const STAGES: { stage: string; ruleType: RuleType }[] = [
  { stage: 'request validity', ruleType: 'request' },
  { stage: 'allowlist (sender, contract, method, value)', ruleType: 'allowlist' },
  { stage: 'time window (desk hours, blackouts, per-contract)', ruleType: 'time_window' },
  { stage: 'signature + EIP-7702 authorization + nonce', ruleType: 'signature' },
  { stage: 'spend limit (per-tx cost, daily quota, global budget)', ruleType: 'spend_limit' },
  { stage: 'abuse heuristics', ruleType: 'abuse' },
  { stage: 'simulation (eth_estimateGas, gas cap)', ruleType: 'execution' },
];

/**
 * Sponsor Desk / Policy Gatekeeper: evaluates a user's signed request against the operator policy and, if it
 * passes, submits it with the sponsor key paying gas. Every outcome is written to the ledger and the audit log.
 * Denied requests never reach `chain.send`, so nothing is signed or broadcast for them.
 */
export class SponsorDesk {
  private now: () => number;

  constructor(
    private policy: Policy,
    private chain: ChainClient,
    private ledger: Ledger,
    private opts: DeskOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  async handle(req: SponsorRequest): Promise<DeskResult> {
    const ts = this.now();
    const nowSec = Math.floor(ts / 1000);
    const firstSeen = !this.ledger.hasSeen(req.account);
    const reqHash = requestHash(req);
    const targets = (req.calls ?? []).map((c) => {
      const sel = selectorOf(c.data);
      const m = allowedSelectors(this.policy, c.to)?.get(sel.toLowerCase());
      return { to: c.to, selector: sel, method: m };
    });
    const base: LedgerEntry = {
      id: randomUUID(),
      ts,
      day: utcDay(ts),
      network: this.policy.network,
      chainId: this.chain.chainId,
      account: req.account,
      decision: 'rejected',
      requestHash: reqHash,
      reasons: [],
      targets,
      firstSeen,
      label: req.label,
    };
    let reached = 0; // index into STAGES of the stage being evaluated
    const trace = (failedAt: number | null): RuleTrace[] =>
      STAGES.map((s, i) => ({
        stage: s.stage,
        ruleType: s.ruleType,
        result: failedAt === null ? 'pass' : i < failedAt ? 'pass' : i === failedAt ? 'fail' : 'not_reached',
      }));
    const finish = (entry: LedgerEntry, t: RuleTrace[], toLedger = true): DeskResult => {
      if (toLedger) this.ledger.append(entry);
      const audit = this.opts.audit?.append(auditInputFrom(entry, t));
      return { decision: entry.decision, verdict: entry.verdict!, decidedBy: entry.decidedBy!, reasons: entry.reasons, trace: t, entry, audit };
    };
    const deny = (reasons: Reason[], decision: LedgerEntry['decision'] = 'rejected'): DeskResult => {
      const rs = reasons.map(withRule);
      const first = rs[0];
      const decidedBy: DecidedBy = { verdict: 'deny', rule: first.rule!, ruleType: first.ruleType!, code: first.code, message: first.message };
      return finish({ ...base, decision, verdict: 'deny', decidedBy, reasons: rs }, trace(reached));
    };
    const allowedBy = (message: string): DecidedBy => ({ verdict: 'allow', rule: 'gate.all_rules_passed', ruleType: 'gate', code: 'ALL_RULES_PASSED', message });

    // 1. Request validity: chain, deadline, batch size.
    const v = requestChecks(this.policy, req, this.chain.chainId, nowSec);
    if (v.length) return deny(v);

    // 2. Allowlist rule type: sender allow/deny, contract + selector, no native value.
    reached = 1;
    const a = allowlistChecks(this.policy, req);
    if (a.length) return deny(a);

    // 3. Time-window rule type: desk hours, blackouts, per-contract windows.
    reached = 2;
    const w = timeWindowChecks(this.policy, req, ts);
    if (w.length) return deny(w);

    // 4. Signature: the account itself must have signed this exact batch.
    reached = 3;
    let signer: Address;
    try {
      signer = await recoverRequestSigner(req);
    } catch {
      return deny([reason('BAD_SIGNATURE', 'signature could not be parsed')]);
    }
    if (signer.toLowerCase() !== req.account.toLowerCase()) return deny([reason('BAD_SIGNATURE', `signature is from ${signer}, not ${req.account}`)]);

    // Delegation state + executor nonce.
    const [code, txCount] = await Promise.all([this.chain.getCode(req.account), this.chain.getTxCount(req.account)]);
    const delegate = delegatedTo(code);
    const isDelegated = !!delegate && delegate.toLowerCase() === this.policy.executor.toLowerCase();
    let authorization = null as SponsorRequest['authorization'];
    if (!isDelegated) {
      if (!req.authorization)
        return deny([reason('NEEDS_AUTHORIZATION', 'account is not delegated to the desk executor; include an EIP-7702 authorization')]);
      const au = req.authorization;
      if (au.address.toLowerCase() !== this.policy.executor.toLowerCase())
        return deny([reason('BAD_AUTHORIZATION', `authorization delegates to ${au.address}, not the desk executor`)]);
      if (au.chainId !== this.chain.chainId) return deny([reason('BAD_AUTHORIZATION', 'authorization chainId mismatch')]);
      if (au.nonce !== txCount) return deny([reason('BAD_AUTHORIZATION', `authorization nonce ${au.nonce} != account nonce ${txCount}`)]);
      let authSigner: Address;
      try {
        authSigner = await recoverAuthSigner(au);
      } catch {
        return deny([reason('BAD_AUTHORIZATION', 'authorization signature could not be parsed')]);
      }
      if (authSigner.toLowerCase() !== req.account.toLowerCase())
        return deny([reason('BAD_AUTHORIZATION', `authorization signed by ${authSigner}, not ${req.account}`)]);
      authorization = au;
    }
    const execNonce = isDelegated ? await this.chain.readExecutorNonce(req.account, this.policy.executor) : 0n;
    if (BigInt(req.nonce) !== execNonce) return deny([reason('NONCE_MISMATCH', `request nonce ${req.nonce} != executor nonce ${execNonce}`)]);

    // 5. Spend-limit rule type, with a worst-case cost reservation.
    reached = 4;
    const fees = await this.chain.fees();
    const gasCap = BigInt(this.policy.maxGasPerTx);
    const worst = gasCap * fees.maxFeePerGas;
    const facts = { account: req.account, nowMs: ts, onchainNonce: txCount, worstCaseWei: worst };
    const sp = spendChecks(this.policy, this.ledger, facts);
    if (sp.length) return deny(sp);

    // 6. Abuse heuristics.
    reached = 5;
    const ab = abuseChecks(this.policy, this.ledger, facts);
    if (ab.length) return deny(ab);

    // 7. Simulate.
    reached = 6;
    const data = encodeExecute(req);
    let gas: bigint;
    try {
      const est = await this.chain.estimate({ to: req.account, data, authorization });
      if (est > gasCap) return deny([reason('GAS_CAP_EXCEEDED', `estimated gas ${est} exceeds maxGasPerTx ${gasCap}`)]);
      gas = (est * 13n) / 10n; // +30% buffer (Pharos docs recommend a buffer over estimateGas)
      if (gas > gasCap) gas = gasCap;
    } catch (e: any) {
      return deny([reason('SIMULATION_FAILED', String(e?.shortMessage ?? e?.message ?? e).slice(0, 300))]);
    }
    const reservedWei = (gas * fees.maxFeePerGas).toString();
    const passed = `passed all ${STAGES.length} gate stages (request, allowlist, time window, signature, spend limit, abuse, simulation)`;
    if (this.opts.dryRun) {
      // Not written to the ledger (nothing was sent, no quota consumed), but the decision is audited.
      const entry: LedgerEntry = {
        ...base,
        decision: 'dry-run',
        verdict: 'allow',
        decidedBy: allowedBy(`${passed}; dry run, not sent`),
        reasons: [reason('DRY_RUN_PASS', 'passed policy + simulation; not sent (dry run)')],
        gasLimit: gas.toString(),
        reservedWei,
      };
      return finish(entry, trace(null), false);
    }

    // 8. Execute: only here is anything signed and broadcast (sponsor pays gas). Then record the receipt cost.
    let hash: Hex;
    try {
      hash = await this.chain.send({ to: req.account, data, gas, authorization, fees });
    } catch (e: any) {
      // The gate allowed it; the broadcast itself failed. Nothing landed on chain.
      const rs = [reason('SEND_ERROR', String(e?.shortMessage ?? e?.message ?? e).slice(0, 300))];
      return finish({ ...base, decision: 'failed', verdict: 'allow', decidedBy: allowedBy(`${passed}; broadcast failed`), reasons: rs }, trace(null));
    }
    const r = await this.chain.wait(hash);
    const ok = r.status === 'success';
    const entry: LedgerEntry = {
      ...base,
      decision: ok ? 'sponsored' : 'failed',
      verdict: 'allow',
      decidedBy: allowedBy(ok ? `${passed}; executed` : `${passed}; executed but reverted on-chain`),
      reasons: ok ? [] : [reason('REVERTED', 'transaction reverted on-chain (sponsor still paid gas)')],
      txHash: hash,
      txType: r.type,
      gasLimit: gas.toString(),
      gasUsed: r.gasUsed.toString(),
      effectiveGasPrice: r.effectiveGasPrice.toString(),
      costWei: (r.gasUsed * r.effectiveGasPrice).toString(),
      reservedWei,
      blockNumber: r.blockNumber.toString(),
    };
    return finish(entry, trace(null));
  }
}
