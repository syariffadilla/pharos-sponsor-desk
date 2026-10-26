# Policy reference

Policy is one JSON file (`assets/policy.example.json`). All wei amounts are decimal strings. Days are UTC.

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
