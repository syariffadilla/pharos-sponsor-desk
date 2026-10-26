# Policy reference

Policy is one JSON file. All wei amounts are decimal strings. Quota/budget days are UTC.

## Gatekeeper format (three rule types)

`examples/policy.gatekeeper.json` groups the rules under `rules`:

| Rule type | Field | Rule id (reason code) |
|---|---|---|
| spend limit | `rules.spendLimit.maxGasPerTx` | `spend_limit.max_gas_per_tx` (`GAS_CAP_EXCEEDED`) |
| spend limit | `rules.spendLimit.maxCostPerTxWei` (optional) | `spend_limit.max_cost_per_tx` (`SPEND_LIMIT_PER_TX`): worst case `maxGasPerTx × maxFeePerGas` above this is denied |
| spend limit | `rules.spendLimit.perAddressDaily.{maxTx,maxGasWei}` | `spend_limit.per_address_daily_tx` / `_gas` |
| spend limit | `rules.spendLimit.globalDaily.maxGasWei` | `spend_limit.global_daily_budget` |
| allowlist | `rules.allowlist.contracts[]` `{address,label,methods[],timeWindow?}` | `allowlist.contract` / `allowlist.method`. A contract may appear in several entries (e.g. one per method group with its own window) |
| allowlist | `rules.allowlist.senders.{allow[],deny[]}` (optional) | `allowlist.sender` (`SENDER_NOT_ALLOWLISTED`) / `allowlist.sender_denylist` (`SENDER_DENYLISTED`) |
| allowlist | `rules.allowlist.allowValue` | `allowlist.native_value` |
| time window | `rules.timeWindow` `{timezone, days[], start, end, blackouts[]}` (optional; absent = always open) | `time_window.hours` (`OUTSIDE_TIME_WINDOW`), `time_window.blackout` (`BLACKOUT_WINDOW`) |
| time window | `rules.allowlist.contracts[].timeWindow` | same ids, scoped to calls matching that entry |

Time window fields: `timezone` IANA name (required); `days` subset of `Mon..Sun` (default all); `start`/`end` `HH:MM`
local time, `end` exclusive, `"24:00"` allowed, `end < start` = overnight window; `blackouts[]` `{start,end,reason}`
ISO-8601 instants with offset. All validated at load.

The flat format below (`assets/policy.example.json`, `examples/policy.atlantic.json`) is still accepted; the gatekeeper
fields map to `maxCostPerTxWei`, `senders`, `timeWindow` and `allowlist[].timeWindow` there.

## Flat format

| Field | Meaning |
|---|---|
| `network` | key in `assets/networks.json` (default `atlantic-testnet`) |
| `executor` | deployed `SponsoredExecutor` address; authorizations must delegate to exactly this |
| `allowlist[]` | `{address, label, methods[]}`; `methods` are Solidity signatures like `checkIn(string)`. Every call in a request must hit a listed address **and** a listed selector. An empty `methods` list allows all methods of that address (not recommended) |
| `perAddressDaily.maxTx` | sponsored transactions per account per UTC day (counts on-chain reverts too, since the sponsor paid) |
| `perAddressDaily.maxGasWei` | wei per account per UTC day (spent + worst case of the new request) |
| `globalDaily.maxGasWei` | total wei per UTC day across all accounts |
| `maxGasPerTx` | gas cap per sponsored tx; also the basis of the worst-case reservation |
| `maxCallsPerRequest` | batch size cap |
| `maxDeadlineSec` | requests may not be valid for longer than this |
| `allowValue` | if false (default) any call with native value is rejected |

## Abuse heuristics (`heuristics`)

| Field | Rule | Reason code |
|---|---|---|
| `newAddressWindowSec`, `maxNewAddressesPerWindow`, `freshNonceThreshold` | An account the desk has never seen **and** whose on-chain nonce is <= `freshNonceThreshold` counts as brand-new. If `maxNewAddressesPerWindow` new accounts were already seen in the window, further brand-new accounts are refused. Accounts with on-chain history are not counted | `NEW_ADDRESS_BURST` |
| `burstWindowSec`, `maxRequestsPerBurst` | Requests from one account in the window (all outcomes count) | `ADDRESS_BURST` |
| `failureWindowSec`, `maxFailures` | Failed simulations, bad signatures and on-chain reverts in the window; at the limit the account is cooled down | `REPEATED_FAILURES` |

These are simple heuristics, not Sybil resistance. A determined attacker with aged addresses can pass them; pair them
with app-level signals (login, KYA, captcha) for production.
