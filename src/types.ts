import type { Address, Hex } from 'viem';

export interface Call {
  to: Address;
  value: string; // decimal wei string
  data: Hex;
}

/** Signed EIP-7702 authorization, JSON-safe. */
export interface SignedAuth {
  address: Address; // delegate contract (must be the desk's SponsoredExecutor)
  chainId: number;
  nonce: number;
  r: Hex;
  s: Hex;
  yParity: number;
}

/** What a user (or the user's agent) hands to the desk. Contains no private key. */
export interface SponsorRequest {
  version: 1;
  chainId: number;
  account: Address; // the user's EOA; remains msg.sender at the target
  calls: Call[];
  nonce: string; // executor nonce (decimal)
  deadline: number; // unix seconds
  signature: Hex; // EIP-712 Execute signature by `account`
  authorization?: SignedAuth | null; // needed only until the account is delegated to the executor
  label?: string;
}

export interface AllowEntry {
  address: Address;
  label?: string;
  /** Solidity signatures, e.g. "checkIn(string)". Empty or missing = all methods (not recommended). */
  methods?: string[];
}

export interface Policy {
  network: string;
  executor: Address;
  allowlist: AllowEntry[];
  perAddressDaily: { maxTx: number; maxGasWei: string };
  globalDaily: { maxGasWei: string };
  maxGasPerTx: number;
  maxCallsPerRequest: number;
  maxDeadlineSec: number;
  allowValue: boolean;
  heuristics: {
    newAddressWindowSec: number;
    maxNewAddressesPerWindow: number;
    freshNonceThreshold: number;
    burstWindowSec: number;
    maxRequestsPerBurst: number;
    failureWindowSec: number;
    maxFailures: number;
  };
}

export type Decision = 'sponsored' | 'rejected' | 'failed' | 'dry-run';

export type ReasonCode =
  | 'WRONG_CHAIN'
  | 'EXPIRED'
  | 'DEADLINE_TOO_FAR'
  | 'NO_CALLS'
  | 'TOO_MANY_CALLS'
  | 'NOT_ALLOWLISTED_TARGET'
  | 'NOT_ALLOWLISTED_METHOD'
  | 'VALUE_NOT_ALLOWED'
  | 'BAD_SIGNATURE'
  | 'NONCE_MISMATCH'
  | 'NEEDS_AUTHORIZATION'
  | 'BAD_AUTHORIZATION'
  | 'ADDRESS_DAILY_TX_QUOTA'
  | 'ADDRESS_DAILY_GAS_QUOTA'
  | 'GLOBAL_DAILY_BUDGET'
  | 'NEW_ADDRESS_BURST'
  | 'ADDRESS_BURST'
  | 'REPEATED_FAILURES'
  | 'SIMULATION_FAILED'
  | 'REVERTED'
  | 'SEND_ERROR'
  | 'DRY_RUN_PASS';

export interface Reason {
  code: ReasonCode;
  message: string;
}

export interface LedgerEntry {
  id: string;
  ts: number; // unix ms
  day: string; // UTC YYYY-MM-DD
  network: string;
  chainId: number;
  account: Address;
  decision: Decision;
  reasons: Reason[];
  targets: { to: Address; selector: Hex; method?: string }[];
  firstSeen: boolean;
  txHash?: Hex;
  txType?: string;
  gasLimit?: string;
  gasUsed?: string;
  effectiveGasPrice?: string;
  costWei?: string; // gasUsed * effectiveGasPrice (what the sponsor paid, per receipt)
  reservedWei?: string; // worst case gasLimit * maxFeePerGas reserved before sending
  blockNumber?: string;
  label?: string;
}
