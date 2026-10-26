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
  /** Optional time window that applies only to calls hitting this entry (e.g. a campaign-only method). */
  timeWindow?: TimeWindow;
}

export type Weekday = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

/** Blackout: absolute instants (ISO-8601 with offset). Requests inside [start, end) are denied. */
export interface Blackout {
  start: string;
  end: string;
  reason?: string;
}

/**
 * Time-window rule. Requests are allowed only on `days`, between `start` (inclusive) and `end` (exclusive),
 * local time in the IANA `timezone`. `end` may be "24:00"; `end < start` means an overnight window.
 */
export interface TimeWindow {
  id?: string;
  timezone: string;
  days?: Weekday[]; // default: every day
  start?: string; // "HH:MM", default "00:00"
  end?: string; // "HH:MM", default "24:00"
  blackouts?: Blackout[];
}

/** Sender allowlist / denylist. If `allow` is non-empty, only those accounts are served. */
export interface SenderRules {
  allow?: Address[];
  deny?: Address[];
}

export interface Policy {
  network: string;
  executor: Address;
  allowlist: AllowEntry[];
  perAddressDaily: { maxTx: number; maxGasWei: string };
  globalDaily: { maxGasWei: string };
  maxGasPerTx: number;
  /** Spend limit per request: worst-case cost (maxGasPerTx x maxFeePerGas) must not exceed this. Optional. */
  maxCostPerTxWei?: string;
  /** Sender allowlist / denylist (part of the allowlist rule type). Optional. */
  senders?: SenderRules;
  /** Desk-wide time window (time-window rule type). Optional; absent = always open. */
  timeWindow?: TimeWindow;
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
  | 'SENDER_NOT_ALLOWLISTED'
  | 'SENDER_DENYLISTED'
  | 'OUTSIDE_TIME_WINDOW'
  | 'BLACKOUT_WINDOW'
  | 'SPEND_LIMIT_PER_TX'
  | 'GAS_CAP_EXCEEDED'
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

/** The three gatekeeper rule types the task requires, plus the supporting checks the desk also runs. */
export type RuleType = 'spend_limit' | 'allowlist' | 'time_window' | 'request' | 'signature' | 'abuse' | 'execution';

export interface Reason {
  code: ReasonCode;
  message: string;
  /** Stable rule id, e.g. "time_window.hours" (filled by the policy engine). */
  rule?: string;
  ruleType?: RuleType;
}

export type Verdict = 'allow' | 'deny';

/** The rule that decided a request: the first failing rule on deny, or the full gate on allow. */
export interface DecidedBy {
  verdict: Verdict;
  rule: string;
  ruleType: RuleType | 'gate';
  code: ReasonCode | 'ALL_RULES_PASSED';
  message: string;
}

export interface RuleTrace {
  stage: string;
  ruleType: RuleType;
  result: 'pass' | 'fail' | 'not_reached';
}

export interface LedgerEntry {
  id: string;
  ts: number; // unix ms
  day: string; // UTC YYYY-MM-DD
  network: string;
  chainId: number;
  account: Address;
  decision: Decision;
  /** Gatekeeper verdict + the specific deciding rule (absent only in ledgers written before v0.2). */
  verdict?: Verdict;
  decidedBy?: DecidedBy;
  requestHash?: Hex;
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
