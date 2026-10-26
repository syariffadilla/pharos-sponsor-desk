// Rule registry: every reason code maps to one stable rule id and one rule type.
// The three rule types required by the "Policy Gatekeeper" task are spend_limit, allowlist and time_window.
import type { Reason, ReasonCode, RuleType, TimeWindow, Weekday } from './types.js';

export const RULES: Record<ReasonCode, { rule: string; ruleType: RuleType }> = {
  // spend limit
  SPEND_LIMIT_PER_TX: { rule: 'spend_limit.max_cost_per_tx', ruleType: 'spend_limit' },
  GAS_CAP_EXCEEDED: { rule: 'spend_limit.max_gas_per_tx', ruleType: 'spend_limit' },
  ADDRESS_DAILY_TX_QUOTA: { rule: 'spend_limit.per_address_daily_tx', ruleType: 'spend_limit' },
  ADDRESS_DAILY_GAS_QUOTA: { rule: 'spend_limit.per_address_daily_gas', ruleType: 'spend_limit' },
  GLOBAL_DAILY_BUDGET: { rule: 'spend_limit.global_daily_budget', ruleType: 'spend_limit' },
  // allowlist
  NOT_ALLOWLISTED_TARGET: { rule: 'allowlist.contract', ruleType: 'allowlist' },
  NOT_ALLOWLISTED_METHOD: { rule: 'allowlist.method', ruleType: 'allowlist' },
  SENDER_NOT_ALLOWLISTED: { rule: 'allowlist.sender', ruleType: 'allowlist' },
  SENDER_DENYLISTED: { rule: 'allowlist.sender_denylist', ruleType: 'allowlist' },
  VALUE_NOT_ALLOWED: { rule: 'allowlist.native_value', ruleType: 'allowlist' },
  // time window
  OUTSIDE_TIME_WINDOW: { rule: 'time_window.hours', ruleType: 'time_window' },
  BLACKOUT_WINDOW: { rule: 'time_window.blackout', ruleType: 'time_window' },
  // request validity
  WRONG_CHAIN: { rule: 'request.chain', ruleType: 'request' },
  EXPIRED: { rule: 'request.deadline', ruleType: 'request' },
  DEADLINE_TOO_FAR: { rule: 'request.deadline', ruleType: 'request' },
  NO_CALLS: { rule: 'request.calls', ruleType: 'request' },
  TOO_MANY_CALLS: { rule: 'request.calls', ruleType: 'request' },
  // signature / delegation
  BAD_SIGNATURE: { rule: 'signature.eip712', ruleType: 'signature' },
  NONCE_MISMATCH: { rule: 'signature.nonce', ruleType: 'signature' },
  NEEDS_AUTHORIZATION: { rule: 'signature.eip7702_authorization', ruleType: 'signature' },
  BAD_AUTHORIZATION: { rule: 'signature.eip7702_authorization', ruleType: 'signature' },
  // abuse heuristics
  NEW_ADDRESS_BURST: { rule: 'abuse.new_address_burst', ruleType: 'abuse' },
  ADDRESS_BURST: { rule: 'abuse.address_burst', ruleType: 'abuse' },
  REPEATED_FAILURES: { rule: 'abuse.repeated_failures', ruleType: 'abuse' },
  // execution
  SIMULATION_FAILED: { rule: 'execution.simulation', ruleType: 'execution' },
  REVERTED: { rule: 'execution.receipt', ruleType: 'execution' },
  SEND_ERROR: { rule: 'execution.broadcast', ruleType: 'execution' },
  DRY_RUN_PASS: { rule: 'execution.dry_run', ruleType: 'execution' },
};

/** Build a Reason with its rule id + type attached. */
export function reason(code: ReasonCode, message: string): Reason {
  return { code, message, ...RULES[code] };
}

/** Attach rule ids to reasons that were created without them (e.g. read from an old ledger). */
export function withRule(r: Reason): Reason {
  return r.rule ? r : { ...r, ...RULES[r.code] };
}

const DAYS: Weekday[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function validateTimeWindow(w: TimeWindow, where = 'timeWindow'): void {
  if (!w.timezone) throw new Error(`${where}.timezone is required (IANA name, e.g. "Asia/Jakarta")`);
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: w.timezone });
  } catch {
    throw new Error(`${where}.timezone "${w.timezone}" is not a valid IANA timezone`);
  }
  for (const d of w.days ?? []) if (!DAYS.includes(d)) throw new Error(`${where}.days: "${d}" is not one of ${DAYS.join(',')}`);
  for (const k of ['start', 'end'] as const) {
    const v = w[k];
    if (v !== undefined && !HHMM.test(v)) throw new Error(`${where}.${k}: "${v}" must be HH:MM (00:00-24:00)`);
  }
  for (const [i, b] of (w.blackouts ?? []).entries()) {
    const s = Date.parse(b.start);
    const e = Date.parse(b.end);
    if (Number.isNaN(s) || Number.isNaN(e)) throw new Error(`${where}.blackouts[${i}]: start/end must be ISO-8601 timestamps`);
    if (e <= s) throw new Error(`${where}.blackouts[${i}]: end must be after start`);
  }
}

/** Local weekday + minutes-since-midnight of an instant in an IANA timezone. */
export function localClock(tsMs: number, timezone: string): { day: Weekday; minutes: number; label: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(tsMs));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = get('weekday') as Weekday;
  const h = Number(get('hour')) % 24;
  const m = Number(get('minute'));
  const label = `${day} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${timezone}`;
  return { day, minutes: h * 60 + m, label };
}

export function describeWindow(w: TimeWindow): string {
  const days = w.days?.length ? w.days.join(',') : 'every day';
  return `${days} ${w.start ?? '00:00'}-${w.end ?? '24:00'} ${w.timezone}`;
}

/** Evaluate one time window at `tsMs`. Returns a deny Reason, or null when the instant is inside the window. */
export function checkTimeWindow(w: TimeWindow, tsMs: number, scope = 'desk'): Reason | null {
  for (const b of w.blackouts ?? []) {
    if (tsMs >= Date.parse(b.start) && tsMs < Date.parse(b.end))
      return reason('BLACKOUT_WINDOW', `${scope}: blackout ${b.start} -> ${b.end}${b.reason ? ` (${b.reason})` : ''}`);
  }
  const { day, minutes, label } = localClock(tsMs, w.timezone);
  const start = toMin(w.start ?? '00:00');
  const end = toMin(w.end ?? '24:00');
  const days = w.days?.length ? w.days : DAYS;
  let inside: boolean;
  if (start === end) inside = days.includes(day); // whole day
  else if (start < end) inside = days.includes(day) && minutes >= start && minutes < end;
  else {
    // overnight window, e.g. 22:00-06:00: the part after midnight belongs to the previous day's window
    const prev = DAYS[(DAYS.indexOf(day) + 6) % 7];
    inside = (minutes >= start && days.includes(day)) || (minutes < end && days.includes(prev));
  }
  return inside ? null : reason('OUTSIDE_TIME_WINDOW', `${scope}: ${label} is outside the allowed window ${describeWindow(w)}`);
}
