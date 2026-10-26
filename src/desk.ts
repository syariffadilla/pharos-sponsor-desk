import { encodeFunctionData, type Abi, type Address, type Hex } from 'viem';
import { randomUUID } from 'node:crypto';
import type { ChainClient } from './chain.js';
import { delegatedTo } from './chain.js';
import { Ledger, utcDay } from './ledger.js';
import { allowedSelectors, ledgerChecks, selectorOf, staticChecks } from './policy.js';
import { recoverAuthSigner, recoverRequestSigner } from './request.js';
import type { LedgerEntry, Policy, Reason, SponsorRequest } from './types.js';

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
  reasons: Reason[];
  entry: LedgerEntry;
}

export interface DeskOptions {
  now?: () => number; // ms
  dryRun?: boolean; // evaluate + simulate but never send
}

/**
 * Sponsor Desk: evaluates a user's signed request against the operator policy and, if it
 * passes, submits it with the sponsor key paying gas. Every outcome is written to the ledger.
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
      reasons: [],
      targets,
      firstSeen,
      label: req.label,
    };
    const reject = (reasons: Reason[], decision: LedgerEntry['decision'] = 'rejected'): DeskResult => {
      const entry = { ...base, decision, reasons };
      this.ledger.append(entry);
      return { decision, reasons, entry };
    };

    // 1. Static policy: chain, deadline, allowlisted targets + methods, no value.
    const s = staticChecks(this.policy, req, this.chain.chainId, nowSec);
    if (s.length) return reject(s);

    // 2. Signature: the account itself must have signed this exact batch.
    let signer: Address;
    try {
      signer = await recoverRequestSigner(req);
    } catch {
      return reject([{ code: 'BAD_SIGNATURE', message: 'signature could not be parsed' }]);
    }
    if (signer.toLowerCase() !== req.account.toLowerCase())
      return reject([{ code: 'BAD_SIGNATURE', message: `signature is from ${signer}, not ${req.account}` }]);

    // 3. Delegation state + executor nonce.
    const [code, txCount] = await Promise.all([this.chain.getCode(req.account), this.chain.getTxCount(req.account)]);
    const delegate = delegatedTo(code);
    const isDelegated = !!delegate && delegate.toLowerCase() === this.policy.executor.toLowerCase();
    let authorization = null as SponsorRequest['authorization'];
    if (!isDelegated) {
      if (!req.authorization)
        return reject([{ code: 'NEEDS_AUTHORIZATION', message: 'account is not delegated to the desk executor; include an EIP-7702 authorization' }]);
      const a = req.authorization;
      if (a.address.toLowerCase() !== this.policy.executor.toLowerCase())
        return reject([{ code: 'BAD_AUTHORIZATION', message: `authorization delegates to ${a.address}, not the desk executor` }]);
      if (a.chainId !== this.chain.chainId) return reject([{ code: 'BAD_AUTHORIZATION', message: 'authorization chainId mismatch' }]);
      if (a.nonce !== txCount) return reject([{ code: 'BAD_AUTHORIZATION', message: `authorization nonce ${a.nonce} != account nonce ${txCount}` }]);
      let authSigner: Address;
      try {
        authSigner = await recoverAuthSigner(a);
      } catch {
        return reject([{ code: 'BAD_AUTHORIZATION', message: 'authorization signature could not be parsed' }]);
      }
      if (authSigner.toLowerCase() !== req.account.toLowerCase())
        return reject([{ code: 'BAD_AUTHORIZATION', message: `authorization signed by ${authSigner}, not ${req.account}` }]);
      authorization = a;
    }
    const execNonce = isDelegated ? await this.chain.readExecutorNonce(req.account, this.policy.executor) : 0n;
    if (BigInt(req.nonce) !== execNonce)
      return reject([{ code: 'NONCE_MISMATCH', message: `request nonce ${req.nonce} != executor nonce ${execNonce}` }]);

    // 4. Quota, budget and abuse heuristics with a worst-case cost reservation.
    const fees = await this.chain.fees();
    const gasCap = BigInt(this.policy.maxGasPerTx);
    const worst = gasCap * fees.maxFeePerGas;
    const q = ledgerChecks(this.policy, this.ledger, { account: req.account, nowMs: ts, onchainNonce: txCount, worstCaseWei: worst });
    if (q.length) return reject(q);

    // 5. Simulate.
    const data = encodeExecute(req);
    let gas: bigint;
    try {
      const est = await this.chain.estimate({ to: req.account, data, authorization });
      gas = (est * 13n) / 10n; // +30% buffer (Pharos docs recommend a buffer over estimateGas)
      if (gas > gasCap) gas = gasCap;
      if (est > gasCap) return reject([{ code: 'SIMULATION_FAILED', message: `estimated gas ${est} exceeds maxGasPerTx ${gasCap}` }]);
    } catch (e: any) {
      return reject([{ code: 'SIMULATION_FAILED', message: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) }]);
    }
    const reservedWei = (gas * fees.maxFeePerGas).toString();
    if (this.opts.dryRun) {
      // Not written to the ledger: nothing was sent and no quota was consumed.
      const entry: LedgerEntry = { ...base, decision: 'dry-run', reasons: [{ code: 'DRY_RUN_PASS', message: 'passed policy + simulation; not sent (dry run)' }], gasLimit: gas.toString(), reservedWei };
      return { decision: 'dry-run', reasons: entry.reasons, entry };
    }

    // 6. Send with the sponsor paying gas, then record the receipt cost.
    let hash: Hex;
    try {
      hash = await this.chain.send({ to: req.account, data, gas, authorization, fees });
    } catch (e: any) {
      return reject([{ code: 'SEND_ERROR', message: String(e?.shortMessage ?? e?.message ?? e).slice(0, 300) }], 'failed');
    }
    const r = await this.chain.wait(hash);
    const entry: LedgerEntry = {
      ...base,
      decision: r.status === 'success' ? 'sponsored' : 'failed',
      reasons: r.status === 'success' ? [] : [{ code: 'REVERTED', message: 'transaction reverted on-chain (sponsor still paid gas)' }],
      txHash: hash,
      txType: r.type,
      gasLimit: gas.toString(),
      gasUsed: r.gasUsed.toString(),
      effectiveGasPrice: r.effectiveGasPrice.toString(),
      costWei: (r.gasUsed * r.effectiveGasPrice).toString(),
      reservedWei,
      blockNumber: r.blockNumber.toString(),
    };
    this.ledger.append(entry);
    return { decision: entry.decision, reasons: entry.reasons, entry };
  }
}
