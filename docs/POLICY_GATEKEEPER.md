# Policy Gatekeeper (Pharos Season of AI · Agent Arena)

Sponsor Desk puts a **policy gatekeeper** in front of a sponsor wallet on **Pharos Atlantic testnet (chainId 688689)**.
An agent (or user) hands the desk a signed request; the gatekeeper returns **allow** or **deny** together with the
**specific rule that decided it**. Only an allowed request is ever signed and broadcast by the sponsor key. Every
decision, allow and deny, is appended to a hash-chained JSONL audit log.

Mechanism note: execution uses EIP-7702 (type `0x04` for the first sponsored tx of an account, then `0x02`) via
`contracts/SponsoredExecutor.sol`. It does **not** use Pharos' announced native sponsored-transaction format.

## Requirement map

| # | Requirement | Where it is | Proof |
|---|---|---|---|
| 01 | Policy file with ≥ 3 rule types: spend limit, allowlist, time window | [`examples/policy.gatekeeper.json`](../examples/policy.gatekeeper.json) → `rules.spendLimit`, `rules.allowlist`, `rules.timeWindow`. Parsed by `src/policy.ts` (`normalizePolicy`, `validatePolicy`), time logic in `src/rules.ts` | `npx tsx src/cli.ts rules --policy examples/policy.gatekeeper.json` prints all three; test `policy config shape` |
| 02 | Every request returns allow/deny + the deciding rule | `SponsorDesk.handle()` in `src/desk.ts` returns `{verdict, decidedBy:{rule, ruleType, code, message}, trace}`; rule registry `src/rules.ts` (`RULES`) maps every reason code to a rule id | CLI `check` / `sponsor` output; `docs/gatekeeper/run.json`; test `every reason code maps to a rule id and type` |
| 03 | Denied actions are never executed; ≥ 1 deny per rule type | Gate stages short-circuit in order; `chain.send()` (the only place the sponsor key signs) is reached only after every stage passed | Live run below: 4 denies (spend, allowlist ×2, time window), sponsor nonce stayed at 9 and balance unchanged across all of them. Tests use a `SpyChain` that counts calls: allowlist/time-window denies make **zero** chain calls; spend denies never call `estimate` or `send` |
| 04 | Audit log of all decisions | `src/audit.ts` (`AuditLog`): append-only JSONL, one line per decision with `time`, `requestHash`, `sender`, `verdict`, `decidedBy`, `trace`, `executed`, `txHash`, plus `prevHash`/`hash` chain. CLI `audit` shows / exports (json, jsonl, csv, md) / verifies | [`docs/gatekeeper/audit.jsonl`](gatekeeper/audit.jsonl) (6 entries from the live run), [`audit.csv`](gatekeeper/audit.csv), `audit --verify` → `ok: true`; tests for reload, append-only, tamper detection |

## The three rule types (config)

```jsonc
"rules": {
  "spendLimit": {                       // rule type 1: spend limit
    "maxGasPerTx": 300000,              //   spend_limit.max_gas_per_tx   (GAS_CAP_EXCEEDED)
    "maxCostPerTxWei": "1000000000000000",          // spend_limit.max_cost_per_tx (SPEND_LIMIT_PER_TX)
    "perAddressDaily": { "maxTx": 1, "maxGasWei": "1000000000000000" },  // ADDRESS_DAILY_TX_QUOTA / _GAS_QUOTA
    "globalDaily": { "maxGasWei": "50000000000000000" }                  // GLOBAL_DAILY_BUDGET
  },
  "allowlist": {                        // rule type 2: allowlist
    "contracts": [                      //   allowlist.contract / allowlist.method (contract + 4-byte selector)
      { "address": "0xAdB9…1638", "label": "DeskGuestbook check-in", "methods": ["checkIn(string)"] },
      { "address": "0xAdB9…1638", "label": "DeskGuestbook motto (weekend campaign only)", "methods": ["setMotto(string)"],
        "timeWindow": { "timezone": "Asia/Jakarta", "days": ["Sat", "Sun"] } }   // per-method time window
    ],
    "senders": { "deny": ["0xE5EE…0Bc4"] },          // allowlist.sender_denylist (optional "allow" list too)
    "allowValue": false                               // allowlist.native_value
  },
  "timeWindow": {                       // rule type 3: time window (desk-wide)
    "timezone": "Asia/Jakarta", "days": ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"], "start": "06:00", "end": "23:00",
    "blackouts": [{ "start": "2026-12-31T22:00:00+07:00", "end": "2027-01-01T02:00:00+07:00", "reason": "new-year maintenance freeze" }]
  }
}
```

Time windows are evaluated in the configured IANA timezone (not UTC), support `end: "24:00"`, overnight windows
(`22:00`–`06:00`), absolute blackout ranges (`BLACKOUT_WINDOW`) and per-contract/per-method windows. Invalid
timezones, `HH:MM` values, weekdays and blackout ranges are rejected when the policy loads. The legacy flat policy
format (`examples/policy.atlantic.json`) still loads.

## Evaluation order (deny stops here; nothing after it runs)

1. request validity (chain, deadline, batch size) · 2. **allowlist** (sender deny/allow, contract, method, value) ·
3. **time window** (desk hours, blackouts, per-method) · 4. signature + EIP-7702 authorization + executor nonce ·
5. **spend limit** (per-tx cost, per-address daily quota, global daily budget; worst-case reservation) ·
6. abuse heuristics · 7. simulation (`eth_estimateGas`, gas cap) · 8. execute (sponsor signs + broadcasts).

On allow, `decidedBy` is `gate.all_rules_passed`, and `trace` shows every stage as `pass`. On deny, `decidedBy` is the
first failing rule and `trace` marks that stage `fail` and later stages `not_reached`.

## Live run · Pharos Atlantic testnet · 2026-10-26 09:35:32–09:35:57 UTC (16:35 Asia/Jakarta, Monday)

Command: `KEYS_FILE=<outside repo> npm run demo:gatekeeper -- --live` (policy `examples/policy.gatekeeper.json`).
Raw output: [`docs/gatekeeper/run.json`](gatekeeper/run.json). Receipts re-checked with the CLI `verify` command:
[`docs/gatekeeper/verify-allow-txs.json`](gatekeeper/verify-allow-txs.json). Sponsor `0x9074D663D93F3F0B29D3C817c17b94b2d8cE7FE8`.

| Step | Scenario | Verdict | Deciding rule | Executed | Tx |
|---|---|---|---|---|---|
| A1 | Fresh 0-PHRS user `0xe0B3…4cd1`, allowlisted `checkIn`, inside desk hours, within quota | **ALLOW** | `gate.all_rules_passed` | yes, type `0x04` (EIP-7702), status success, gas 110,455, block 31899336 | [0x29a2c59a…cb40](https://atlantic.pharosscan.xyz/tx/0x29a2c59ad71a1a7e31762b2dffc2c5799fd19f76a9d625dc34a47c0aeb64cb40) |
| A2 | Already-delegated user `0x3A7E…204A`, allowlisted `checkIn` | **ALLOW** | `gate.all_rules_passed` | yes, type `0x02`, status success, gas 50,658, block 31899347 | [0x888e7802…eabb](https://atlantic.pharosscan.xyz/tx/0x888e780286b7d06157270ccdc97bf02817c548c7a68141751738a01440ffeabb) |
| D1 | Same user as A1 again the same UTC day | **DENY** | `spend_limit.per_address_daily_tx` (`ADDRESS_DAILY_TX_QUOTA`: "1/1 sponsored tx already used today (UTC 2026-10-26)") | no | – |
| D2 | Target Multicall3 `0xcA11…CA11` (not allowlisted) | **DENY** | `allowlist.contract` (`NOT_ALLOWLISTED_TARGET`) | no | – |
| D3 | Sender `0xE5EE…0Bc4` is on `senders.deny` | **DENY** | `allowlist.sender_denylist` (`SENDER_DENYLISTED`) | no | – |
| D4 | `setMotto` is allowlisted only Sat–Sun Asia/Jakarta; sent on Monday | **DENY** | `time_window.hours` (`OUTSIDE_TIME_WINDOW`: "Mon 16:35 Asia/Jakarta is outside the allowed window Sat,Sun 00:00-24:00 Asia/Jakarta") | no | – |

Evidence that denies were not executed: the sponsor's on-chain nonce was read before and after every step. It went
7 → 8 (A1) → 9 (A2) and then stayed **9 → 9** for D1, D2, D3 and D4; the sponsor balance was identical before and after
each deny (1.998332639 PHRS). The audit log records `executed: false, txHash: null` for each deny. The user stays
`msg.sender`: the DeskGuestbook `CheckedIn` events name `0xe0B3…4cd1` (A1) and `0x3A7E…204A` (A2) while the tx `from` is the sponsor.

Audit log of this run: [`docs/gatekeeper/audit.jsonl`](gatekeeper/audit.jsonl) (6 lines, hash chain verifies),
also as [`audit.csv`](gatekeeper/audit.csv) and inside [`decision-table.md`](gatekeeper/decision-table.md).

```bash
DESK_AUDIT=docs/gatekeeper/audit.jsonl DESK_POLICY=examples/policy.gatekeeper.json npx tsx src/cli.ts audit --verify
# { "ok": true, "entries": 6, "brokenAt": null, "summary": { "allow": 2, "deny": 4, "executed": 2, "deniedButExecuted": 0,
#   "denialsByRuleType": { "spend_limit": 1, "allowlist": 2, "time_window": 1 } } }
```

The explorer pages are client-rendered (the HTML shell returns HTTP 200); transaction facts above come from the RPC
receipts (`eth_getTransactionByHash` / `eth_getTransactionReceipt` on `https://atlantic.dplabs-internal.com`).

## Reproduce without keys (local, deterministic)

`npm run demo:gatekeeper` runs the same six steps against an in-memory chain with well-known dev keys and a fixed clock
(Mon 16:40 Asia/Jakarta). It writes `data/gatekeeper-local/` (git-ignored). Its hashes are **synthetic** and are labeled
as such; they are not transactions.

## Commands

```bash
npx tsx src/cli.ts rules  --policy examples/policy.gatekeeper.json              # the 3 rule types as configured
npx tsx src/cli.ts check  --request req.json                                     # allow/deny + deciding rule, never sends
SPONSOR_PRIVATE_KEY=0x… npx tsx src/cli.ts sponsor --request req.json            # executes only on allow
npx tsx src/cli.ts audit  [--verify] [--verdict deny] [--format json|jsonl|csv|md] [--out file]
npm test                                                                          # 48 tests (vitest)
```

## Limits (honest)

- Testnet demo; contracts unaudited. Keys used in the live run are throwaway testnet keys kept outside the repo.
- The audit log is a local file; the hash chain makes edits and deletions detectable, not impossible. Anchor the
  latest `hash` somewhere external if you need stronger guarantees.
- The time window uses the desk host's clock.
