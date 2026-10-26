# Pharos Sponsor Desk

An agent skill and small TypeScript CLI that lets an app operator **pay gas for their users on Pharos**, with
guardrails: allowlisted contracts and methods, a per-address daily quota, a global daily budget, simple abuse
heuristics, a spend ledger and daily reports. Built and tested on **Pharos Atlantic testnet (chainId 688689)**.

- The user signs what they want to do (EIP-712). They need **0 PHRS**.
- The desk checks the request against the operator's policy and, if it passes, sends it with the **sponsor wallet as gas payer**.
- The target contract sees the **user as `msg.sender`**.

Live run with transaction hashes: [`docs/LIVE_RUN.md`](docs/LIVE_RUN.md). Policy Gatekeeper live run: [`docs/POLICY_GATEKEEPER.md`](docs/POLICY_GATEKEEPER.md).

## Policy Gatekeeper (Pharos Season of AI · Agent Arena)

Every request goes through a gatekeeper that returns **allow** or **deny** plus the **specific rule that decided it**.
Denied requests are never signed or broadcast. Every decision is written to an append-only, hash-chained audit log.

| # | Requirement | File / command | Proof |
|---|---|---|---|
| 01 | Policy file with ≥ 3 rule types (spend limit, allowlist, time window) | [`examples/policy.gatekeeper.json`](examples/policy.gatekeeper.json) → `rules.spendLimit` · `rules.allowlist` · `rules.timeWindow`; `src/policy.ts`, `src/rules.ts`; `npx tsx src/cli.ts rules --policy examples/policy.gatekeeper.json` | tests in `test/gatekeeper.test.ts` |
| 02 | Allow/deny + deciding rule for every request | `src/desk.ts` → `{verdict, decidedBy:{rule, ruleType, code, message}, trace}`; `npx tsx src/cli.ts check --request req.json` | [`docs/gatekeeper/run.json`](docs/gatekeeper/run.json) |
| 03 | Denies never executed; ≥ 1 deny per rule type | gate stages short-circuit before `chain.send()` (the only place the sponsor key signs) | live: 2 ALLOW txs + 4 DENYs (spend, allowlist ×2, time window), sponsor nonce unchanged on every deny; `SpyChain` tests prove `send` is never called on deny |
| 04 | Audit log of all decisions | `src/audit.ts`; `npx tsx src/cli.ts audit [--verify] [--format csv\|md\|jsonl]` | [`docs/gatekeeper/audit.jsonl`](docs/gatekeeper/audit.jsonl), [`audit.csv`](docs/gatekeeper/audit.csv) |

Live on Pharos Atlantic testnet (2026-10-26 09:35 UTC), `npm run demo:gatekeeper -- --live`:

| Step | Verdict | Deciding rule | Tx |
|---|---|---|---|
| A1 fresh 0-PHRS user, `checkIn` | **ALLOW** | `gate.all_rules_passed` | [0x29a2c59a…cb40](https://atlantic.pharosscan.xyz/tx/0x29a2c59ad71a1a7e31762b2dffc2c5799fd19f76a9d625dc34a47c0aeb64cb40) (type 0x04) |
| A2 delegated user, `checkIn` | **ALLOW** | `gate.all_rules_passed` | [0x888e7802…eabb](https://atlantic.pharosscan.xyz/tx/0x888e780286b7d06157270ccdc97bf02817c548c7a68141751738a01440ffeabb) (type 0x02) |
| D1 same user again today | **DENY** | `spend_limit.per_address_daily_tx` | not executed |
| D2 target not allowlisted (Multicall3) | **DENY** | `allowlist.contract` | not executed |
| D3 denylisted sender | **DENY** | `allowlist.sender_denylist` | not executed |
| D4 `setMotto` outside its Sat–Sun Asia/Jakarta window | **DENY** | `time_window.hours` | not executed |

No keys? `npm run demo:gatekeeper` runs the same scenario locally against an in-memory chain (synthetic hashes, clearly labeled).

## How it works (and what it is not)

Sponsor Desk uses **EIP-7702** (transaction type `0x04`), which Atlantic testnet accepted in our live run. The user's
account delegates once to `contracts/SponsoredExecutor.sol`; afterwards the sponsor submits
`execute(calls, deadline, userSignature)` to the user's own address and pays the gas.

Pharos has announced protocol-level **Sponsored Transactions** on testnet ("separates the transaction initiator from the
gas payer"). Its transaction format is not publicly documented as of 2026-10-26, so this project does **not** claim to
use that native feature. The policy, ledger and reporting layers sit behind a `ChainClient` interface so a native
transaction builder can be added when the format is published. Details and sources: [`references/mechanism.md`](references/mechanism.md).

```
user / user's agent                         Sponsor Desk (operator)                         Pharos Atlantic
-------------------                         -----------------------                         ---------------
request:build                                sponsor --request req.json
  EIP-712 Execute(calls,nonce,deadline) ──▶   1 static policy (chain, deadline, allowlist, no value)
  + one-time EIP-7702 authorization           2 signature + authorization checks
                                              3 quota / budget / heuristics (ledger)
                                              4 eth_estimateGas
                                              5 send  from=sponsor  to=user  ───────────────▶  user EOA runs SponsoredExecutor
                                              6 ledger: receipt cost                               └─▶ target sees msg.sender = user
```

## Quick start

```bash
npm install
npm test                       # 48 unit tests, mock chain, no network
npm run demo:gatekeeper        # local gatekeeper scenario (allow + one deny per rule type)
npm run compile                # solc 0.8.28 -> contracts/build/*.json

# read-only status on Atlantic (no key needed)
DESK_POLICY=examples/policy.atlantic.json npx tsx src/cli.ts status --sponsor 0x9074D663D93F3F0B29D3C817c17b94b2d8cE7FE8

# deploy your own executor + demo contract (testnet only; writes deployments/ and examples/policy.atlantic.json)
SPONSOR_PRIVATE_KEY=0x... npm run deploy

# user side: sign a gasless request
USER_PRIVATE_KEY=0x... npx tsx src/cli.ts request:build \
  --to <DeskGuestbook> --method "checkIn(string note)" --args '["gm"]' --out req.json

# operator side
npx tsx src/cli.ts check --request req.json        # allow/deny + deciding rule, never sends
SPONSOR_PRIVATE_KEY=0x... npx tsx src/cli.ts sponsor --request req.json
npx tsx src/cli.ts audit --verify                   # append-only decision log
npx tsx src/cli.ts report --format md
```

Full command list: [`references/commands.md`](references/commands.md). Natural-language examples: [`examples/prompts.md`](examples/prompts.md).

## Use as an agent skill

`SKILL.md` follows the layout of the official Pharos Skill Engine (frontmatter, prerequisites, capability index,
write-operation pre-checks, security). Copy or symlink this folder into your agent's skills directory, e.g.
`npx skills add https://github.com/syariffadilla/pharos-sponsor-desk` once the repo is public.

## Policy

The gatekeeper format groups the three rule types explicitly (see [`examples/policy.gatekeeper.json`](examples/policy.gatekeeper.json)
and [`references/policy.md`](references/policy.md)). The original flat format below is still accepted:

```json
{
  "allowlist": [{ "address": "0xAdB9…1638", "label": "DeskGuestbook", "methods": ["checkIn(string)"] }],
  "perAddressDaily": { "maxTx": 1, "maxGasWei": "1000000000000000" },
  "globalDaily": { "maxGasWei": "50000000000000000" },
  "maxGasPerTx": 300000,
  "heuristics": { "maxNewAddressesPerWindow": 5, "newAddressWindowSec": 600, "maxRequestsPerBurst": 3, "burstWindowSec": 60, "maxFailures": 3, "failureWindowSec": 86400 }
}
```

Budgets reserve the worst case (`maxGasPerTx × maxFeePerGas`) before sending and record the receipt cost after.
Days are UTC. Field reference: [`references/policy.md`](references/policy.md).

## Repository layout

```
SKILL.md                     agent entry point
assets/networks.json         Atlantic + mainnet settings (from Pharos docs / Skill Engine)
assets/policy.example.json   policy template
contracts/                   SponsoredExecutor.sol (7702 delegate), DeskGuestbook.sol (demo app), build/
src/                         desk (gatekeeper + sender), policy, rules (rule ids, time windows), audit (hash-chained log),
                             ledger, request (user-side signing), chain (viem), report, status (RPC + MCP), mcp, cli
scripts/                     compile, deploy (testnet only), demo-live, demo-gatekeeper
test/                        vitest suite with an in-memory chain
deployments/                 Atlantic addresses from the live run
docs/LIVE_RUN.md, docs/live/ live run evidence (ledger, reports, status, verify outputs)
docs/POLICY_GATEKEEPER.md,   gatekeeper requirement map + live run (audit log, decision table, receipts)
  docs/gatekeeper/
references/                  mechanism, policy, commands
examples/                    prompts, live policy, gatekeeper policy
```

## Status and limitations

- Testnet demo code. Contracts are **unaudited**; do not use with real funds without a review.
- Heuristics are simple rate/age rules, not Sybil resistance.
- The ledger is a local JSONL file (single operator process). Run one desk process per ledger.
- The hosted Pharos MCP (`mcp.pharos.xyz`) serves mainnet; for Atlantic MCP status, self-host `PharosNetwork/pharos-mcp`.
- Only the EIP-7702 path is implemented; no ERC-4337 paymaster and no Pharos-native sponsored tx builder yet.

## License

MIT, see [LICENSE](LICENSE).
