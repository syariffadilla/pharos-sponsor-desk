---
name: pharos-sponsor-desk
description: >
  Use when an app operator wants to pay gas for their users on Pharos (Atlantic testnet by default):
  "sponsor this user's transaction", "pay gas for my users", "gasless check-in for new users",
  "set a daily gas budget / per-user quota", "only sponsor calls to my contract", "who did we sponsor today",
  "sponsor desk report", "is the sponsor wallet running low". Evaluates a user-signed request against an
  operator policy (allowlisted contracts + methods, per-address daily quota, global daily budget, abuse
  heuristics), then submits it with the sponsor key paying gas while the user stays msg.sender. Writes a
  spend ledger and daily JSON / Markdown / HTML reports. Acts as a Policy Gatekeeper: "would this be allowed?",
  "why was this denied?", "show the audit log" — every request gets allow/deny plus the deciding rule
  (spend limit, allowlist, time window), denies are never executed, and all decisions go to an append-only audit log. Read-only status via JSON-RPC or a Pharos Chain MCP server.
license: MIT
version: 0.2.0
metadata:
  author: syariffadilla
  networks: [atlantic-testnet]
requires:
  anyBins:
    - node
---

# Pharos Sponsor Desk

Gas sponsorship for app operators on Pharos. A user (or the user's agent) signs **what** they want to do;
the operator's desk decides **whether to pay for it** and, if so, submits it with the sponsor wallet as gas payer.
Inside the target contract `msg.sender` is the user's own address.

**Mechanism (be precise when explaining it):** Sponsor Desk uses **EIP-7702** (transaction type `0x04`), which
Pharos Atlantic testnet accepts (verified live, see `docs/LIVE_RUN.md`). The user's EOA delegates to the
`SponsoredExecutor` contract once; the user signs an EIP-712 `Execute` message; the sponsor sends the transaction
and pays gas. Pharos has announced a protocol-level "Sponsored Transactions" feature on testnet, but its
transaction format is not documented publicly as of 2026-10-26, so this skill does **not** claim to use that
native format. See `references/mechanism.md`.

## Prerequisites

1. Node.js >= 20, then `npm install` in this folder.
2. Network config: read `assets/networks.json` (default `atlantic-testnet`, chainId `688689`,
   RPC `https://atlantic.dplabs-internal.com`, explorer `https://atlantic.pharosscan.xyz/`). Re-check against
   https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md before any write. Never rely on memorized values.
3. A policy file (start from `assets/policy.example.json`, or `examples/policy.atlantic.json` for the live demo
   deployment). Point to it with `--policy` or `DESK_POLICY`.
4. Operator key in `SPONSOR_PRIVATE_KEY` (testnet throwaway key). It is read from the environment only and never printed.
   User keys never reach the desk; users sign on their side (`request:build` with `USER_PRIVATE_KEY`, or their wallet).

## Capability Index

All commands print a single JSON object. Run from the skill folder: `npx tsx src/cli.ts <command>`.

| User intent | Command | Writes on-chain? |
|---|---|---|
| "Is the desk healthy / how much budget is left / sponsor balance?" | `status [--account 0x..]` (RPC) or `status --mcp <url>` | No |
| "Show / check the sponsorship rules" | `policy` | No |
| "What are the gatekeeper rules?" (spend limit, allowlist, time window) | `rules` | No |
| "Would this request be allowed? Which rule decides?" | `check --request req.json` | No |
| "Show / export / verify the audit log", "what was denied today?" | `audit [--verify] [--verdict deny] [--format json\|jsonl\|csv\|md] [--out file]` | No |
| "Prepare a sponsored request for user X calling f(...)" (user side) | `request:build --to <contract> --method "f(type name)" --args '[...]' --out req.json` | No (signs only) |
| "Would we sponsor this?" | `sponsor --request req.json --dry-run` | No |
| "Sponsor this request" | `sponsor --request req.json` | **Yes**, sponsor pays gas |
| "Daily spend report" | `report [--day YYYY-MM-DD] --format md\|json\|html [--out file]` | No |
| "Show the ledger" | `ledger [--day YYYY-MM-DD]` | No |
| "Verify sponsored tx 0x.." | `verify <txHash> [--mcp <url>]` | No |
| Deploy executor + demo contract (testnet only) | `npm run deploy` | Yes |

Details: `references/commands.md`. Policy fields and heuristics: `references/policy.md`.

## Policy Gatekeeper

Policy file: `examples/policy.gatekeeper.json`, with the three required rule types named explicitly:
`rules.spendLimit` (per-tx gas cap + max cost, per-address daily tx/wei quota, global daily budget),
`rules.allowlist` (contracts + 4-byte methods, sender allow/deny lists, native value) and `rules.timeWindow`
(allowed days/hours in an IANA timezone, blackout ranges; allowlist entries can carry their own window).

| Requirement | How this skill meets it | Proof |
|---|---|---|
| 01 policy with spend limit, allowlist, time window | `examples/policy.gatekeeper.json`, `src/policy.ts`, `src/rules.ts`, command `rules` | `test/gatekeeper.test.ts` |
| 02 allow/deny + deciding rule | `check` / `sponsor` output `verdict` + `decidedBy {rule, ruleType, code, message}` + `trace` | `docs/gatekeeper/run.json` |
| 03 denies never executed, one per rule type | stages short-circuit before the sponsor signs/broadcasts | live run: sponsor nonce unchanged on 4 denies; `SpyChain` tests |
| 04 audit log | `src/audit.ts`, `data/audit.jsonl` (`--audit` / `DESK_AUDIT`), command `audit` | `docs/gatekeeper/audit.jsonl` (hash chain verifies) |

Live proof (Atlantic, 2026-10-26): ALLOW tx `0x29a2c59ad71a1a7e31762b2dffc2c5799fd19f76a9d625dc34a47c0aeb64cb40`
(https://atlantic.pharosscan.xyz/tx/0x29a2c59ad71a1a7e31762b2dffc2c5799fd19f76a9d625dc34a47c0aeb64cb40). Full table: `docs/POLICY_GATEKEEPER.md`.

When reporting a decision to the operator, always name the deciding rule id (e.g. `time_window.hours`) and its
message, and say "not executed" for every deny.

## Decision flow (what `sponsor` does, in order)

1. Request validity (chainId, deadline window, max calls), then the **allowlist** rule (sender deny/allow, every call's
   target **and** 4-byte selector, no native value), then the **time window** rule (desk hours, blackouts, per-method windows).
2. Signature: EIP-712 `Execute(Call[] calls,uint256 nonce,uint256 deadline)` must recover to the user's address.
3. Delegation: if the account is not yet delegated to the policy's executor, the request must carry a valid
   EIP-7702 authorization for exactly that executor, this chain, and the account's current nonce.
4. Executor nonce must match (replay protection).
5. **Spend limit** with a worst-case reservation (`maxGasPerTx × maxFeePerGas`): per-tx max cost, per-address daily
   tx count + wei cap, global daily budget (UTC days). Then abuse heuristics: repeated-failure cooldown,
   per-address burst, brand-new-address burst.
6. Simulate with `eth_estimateGas` (+30% buffer, capped at `maxGasPerTx`).
7. Send (type `0x04` if an authorization is needed, else type `0x02`) and record receipt cost
   (`gasUsed × effectiveGasPrice`) in the ledger.

Every request, including rejections, is one ledger line and one audit-log line with machine-readable reason codes
and rule ids (`NOT_ALLOWLISTED_TARGET`, `NOT_ALLOWLISTED_METHOD`, `SENDER_DENYLISTED`, `OUTSIDE_TIME_WINDOW`,
`BLACKOUT_WINDOW`, `SPEND_LIMIT_PER_TX`, `ADDRESS_DAILY_TX_QUOTA`, `GLOBAL_DAILY_BUDGET`,
`NEW_ADDRESS_BURST`, `ADDRESS_BURST`, `REPEATED_FAILURES`, `BAD_SIGNATURE`, `BAD_AUTHORIZATION`, ...).
Rejected requests never reach the chain, so they have no transaction hash.

## Write-operation pre-checks (required before `sponsor` without `--dry-run`, and before `deploy`)

1. `SPONSOR_PRIVATE_KEY` is set (check without printing it): `[ -n "$SPONSOR_PRIVATE_KEY" ] && echo set`.
2. Tell the operator the target network and chainId from `assets/networks.json`. This skill is built and tested
   for **Atlantic testnet**. If asked to use mainnet, warn clearly and get explicit confirmation; `deploy` refuses mainnet.
3. Run `status` and confirm the sponsor balance covers at least `maxGasPerTx × maxFeePerGas`.
4. Run `sponsor --dry-run` first and show the decision to the operator.

## Explaining results to the operator

- Sponsored: give the tx hash and explorer link, gas used and cost in PHRS, and the remaining daily budget.
- Rejected: give the reason code(s) in plain language and what would change the outcome (e.g. "quota resets at 00:00 UTC").
- Never describe a rejected request as a transaction, and never invent hashes. Hashes come only from `sponsor` / `verify` output.

## Security

- The desk never needs a user's private key. Users sign EIP-712 messages and (once) an EIP-7702 authorization.
- An EIP-7702 delegation lets the executor code run in the user's account; `SponsoredExecutor` only executes batches the
  account itself signed (nonce + deadline, low-s signatures). Users can re-delegate or clear delegation with their own tx later.
- Keep keys out of git (`.gitignore` covers `keys/`, `.env`, `data/`). Use throwaway keys on testnet.
- Contracts are unaudited demo code. Do not use with real funds without a review.

## Read-only status via Pharos Chain MCP

`status --mcp <url>` and `verify <hash> --mcp <url>` call MCP tools (`get_chain_info`, `get_balance`,
`get_transaction`, `get_transaction_receipt`). The hosted server `https://mcp.pharos.xyz/mcp` serves **Pacific mainnet
(1672)**; the desk flags a chain mismatch. For Atlantic, self-host `github.com/PharosNetwork/pharos-mcp` with
`PHAROS_RPC_URL=https://atlantic.dplabs-internal.com PHAROS_CHAIN_ID=688689 MCP_TRANSPORT=http`.
