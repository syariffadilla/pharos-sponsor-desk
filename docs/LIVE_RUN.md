# Live run on Pharos Atlantic testnet

Run on 2026-10-25 (UTC), roughly 17:55-18:10 UTC. All keys were throwaway keys generated for this run and kept
outside the repository. No mainnet funds or personal wallets were involved.

## Network used

| Item | Value | Source |
|---|---|---|
| Network | Pharos Atlantic Testnet | https://docs.pharos.xyz/getting-started/network/atlantic-testnet.md |
| Chain ID | 688689 (`eth_chainId` returned `0xa8231`) | docs + live RPC |
| RPC | https://atlantic.dplabs-internal.com (client `portal/1.0.0`) | docs + live RPC |
| Explorer | https://atlantic.pharosscan.xyz/ | docs |
| Native token | PHRS | Pharos Skill Engine `assets/networks.json` |
| Faucet used | https://pharos.faucetme.pro/ (third-party, listed in search results; no captcha, 2 PHRS per claim) | claimed once for the sponsor address |

## Accounts

| Role | Address | Starting balance |
|---|---|---|
| Sponsor (operator) | `0x9074D663D93F3F0B29D3C817c17b94b2d8cE7FE8` | 2 PHRS from the faucet (balance read via `eth_getBalance`; the faucet's payout tx hash was not recorded) |
| User A | `0x58422D77a897F0372ce441EBF72E79120679A25d` | 0 PHRS, never funded |
| User B | `0x3A7E9F7BEae5F603082CCACE3aA49E66936f204A` | 0 PHRS, never funded |
| User C (CLI run) | `0xE5EE78a15A86912df2be98b8F69CC0e932a50Bc4` | 0 PHRS, never funded |

## Contracts deployed (by the sponsor key)

| Contract | Address | Deploy tx |
|---|---|---|
| SponsoredExecutor | `0xb1Ee3cC528fa525b304562549b7716429a0937d5` | [0xcbbe86c9…1f8c](https://atlantic.pharosscan.xyz/tx/0xcbbe86c9d82c579790f0d48f87758ecd6c935c4936e6160c001e63b0d1591f8c) |
| DeskGuestbook (demo app) | `0xAdB97503ad3A8BDA288C0c179818052b2b301638` | [0xb5f564c3…5595](https://atlantic.pharosscan.xyz/tx/0xb5f564c34ce8b94e720ad2ab015d02e4e3c6714853276ec95198d3dd696f5595) |

Policy used: `examples/policy.atlantic.json` (allowlist = DeskGuestbook `checkIn(string)` only; 1 sponsored tx per
address per UTC day; 0.05 PHRS global daily budget; `maxGasPerTx` 300000).

## Results (`npm run demo:live`, raw output in `docs/live/demo-output.json`, ledger in `docs/live/ledger.jsonl`)

| # | Scenario | Account | Result | Tx |
|---|---|---|---|---|
| 1 | Fresh 0-PHRS user checks in; first-time EIP-7702 authorization included | User A | **sponsored**, type `0x04`, status success, gas used 110,563, sponsor paid 0.000110563 PHRS, user balance 0 before and after | [0x5fce28cd…04ef](https://atlantic.pharosscan.xyz/tx/0x5fce28cdd2c1a5da58cf7a134b3d35d12e5389bd97573159ef1784285ca404ef) |
| 2 | Same user, second check-in the same UTC day | User A | **rejected** `ADDRESS_DAILY_TX_QUOTA` ("1/1 sponsored tx already used today"). Nothing sent, sponsor balance unchanged | none (rejected before sending) |
| 3 | Allowlisted contract, method not allowlisted (`setMotto(string)`, selector `0xb8bf81bd`) | User B | **rejected** `NOT_ALLOWLISTED_METHOD`. Nothing sent | none |
| 4 | Target not on the allowlist (Multicall3 `0xcA11…CA11`) | User B | **rejected** `NOT_ALLOWLISTED_TARGET`. Nothing sent | none |
| 5 | Second 0-PHRS user (previously delegated elsewhere, see probe below) re-delegates to the executor and checks in | User B | **sponsored**, type `0x04`, gas used 97,358 | [0x60e99644…04af](https://atlantic.pharosscan.xyz/tx/0x60e99644267865a53470ecfc787af9c09e88763dfcd5110c0d34fe26767c04af) |

Evidence that the original sender is preserved: in tx 1, the transaction `from` is the sponsor
(`0x9074…7FE8`), while the DeskGuestbook event `CheckedIn(who=0x58422D77…A25d, count=1, note="gm from a 0-PHRS account, gas paid by Sponsor Desk")`
names the user. Same for tx 5 (`who=0x3A7E…204A`). After the run, `checkIns(userA) = 1`, `checkIns(userB) = 1`,
and both users' code is the delegation designator `0xef0100b1ee3cc528fa525b304562549b7716429a0937d5`.

### CLI path (`request:build` -> `sponsor`), separate ledger `docs/live/cli-ledger.jsonl`, policy with `maxTx: 3`

| Step | Result | Tx |
|---|---|---|
| `sponsor --dry-run` on User C's first request | passed policy + simulation, not sent | none |
| First request (authorization included) | **sponsored**, type `0x04`, gas used 109,882 | [0x28102411…5abe](https://atlantic.pharosscan.xyz/tx/0x2810241154abff1848084ff503076714f068a2d27266e6be8557b2ae8c955abe) |
| Second request (already delegated, no authorization needed, executor nonce 1) | **sponsored**, type `0x02`, gas used 51,315 | [0x86e5f9b4…2ff2](https://atlantic.pharosscan.xyz/tx/0x86e5f9b436260c5f1ad53f5a72a06d37e2e1b4b9004eb201adf8f252d6932ff2) |

### Probe transaction (before the desk existed)

[0x52ebfea6…ef36](https://atlantic.pharosscan.xyz/tx/0x52ebfea699785dd241762f0690200a9bfa37f81792f75d12ddb8d754e028ef36):
a hand-built type `0x04` tx from the sponsor, with User B's authorization delegating to Multicall3, used only to check
whether Atlantic accepts EIP-7702. It was included with **status 0 (reverted)**, because Multicall3 has no fallback for
empty calldata, but the delegation was applied (User B's code became `0xef0100ca11…ca11`). That is why User B needed a
re-delegation in step 5.

## Read-only status

- `status` over RPC: `docs/live/status-rpc.json` (chainId matches, sponsor balance, both users at 0 PHRS and delegated to the executor, today's spend vs budget).
- `status --mcp` against a **self-hosted** `PharosNetwork/pharos-mcp` (built from GitHub, `PHAROS_RPC_URL=https://atlantic.dplabs-internal.com`, `PHAROS_CHAIN_ID=688689`): `docs/live/status-mcp-atlantic.json`.
- `verify` of tx 1 via RPC and via the self-hosted MCP (`get_transaction`, `get_transaction_receipt`): `docs/live/verify-rpc-step1.json`, `docs/live/verify-mcp-step1.json`.
- The hosted MCP (`https://mcp.pharos.xyz/mcp`) answered `get_chain_info` with chainId 1672 (Pacific mainnet), so the desk reports a chain mismatch for Atlantic; it was not used for testnet data.

## Cost accounting

Sponsor spend for the whole session was 0.001506248 PHRS (2.000000000 -> 1.998493752), which equals the sum of
`gasUsed × 1 gwei` over all 7 transactions (probe 46,046 + deploys 745,072 + 346,012 + sponsored 110,563 + 97,358 +
109,882 + 51,315 = 1,506,248 gas). For these transactions the sponsor was charged by gas used, not by gas limit.

## Reports generated

`docs/live/report.json`, `docs/live/report.md`, `docs/live/report.html` (UTC day 2026-10-25: 5 requests, 2 sponsored,
3 rejected, 0.000207921 PHRS spent, 0.41% of the daily budget).

## What this run does NOT show

- It does not use a Pharos-native "Sponsored Transaction" type. That format is not publicly documented (see
  `references/mechanism.md`); the run uses EIP-7702, which Atlantic accepted.
- The abuse heuristics (`NEW_ADDRESS_BURST`, `ADDRESS_BURST`, `REPEATED_FAILURES`), the global budget cap and the
  per-address wei cap were exercised in unit tests with a mock chain (`test/desk.test.ts`), not on-chain.
- No load testing; the public RPC is rate-limited to 500 requests / 5 min.
