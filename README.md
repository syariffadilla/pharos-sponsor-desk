# Pharos Sponsor Desk

An agent skill and small TypeScript CLI that lets an app operator **pay gas for their users on Pharos**, with
guardrails: allowlisted contracts and methods, a per-address daily quota, a global daily budget, simple abuse
heuristics, a spend ledger and daily reports. Built and tested on **Pharos Atlantic testnet (chainId 688689)**.

- The user signs what they want to do (EIP-712). They need **0 PHRS**.
- The desk checks the request against the operator's policy and, if it passes, sends it with the **sponsor wallet as gas payer**.
- The target contract sees the **user as `msg.sender`**.

Live run with transaction hashes: [`docs/LIVE_RUN.md`](docs/LIVE_RUN.md).

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
npm test                       # 25 unit tests, mock chain, no network
npm run compile                # solc 0.8.28 -> contracts/build/*.json

# read-only status on Atlantic (no key needed)
DESK_POLICY=examples/policy.atlantic.json npx tsx src/cli.ts status --sponsor 0x9074D663D93F3F0B29D3C817c17b94b2d8cE7FE8

# deploy your own executor + demo contract (testnet only; writes deployments/ and examples/policy.atlantic.json)
SPONSOR_PRIVATE_KEY=0x... npm run deploy

# user side: sign a gasless request
USER_PRIVATE_KEY=0x... npx tsx src/cli.ts request:build \
  --to <DeskGuestbook> --method "checkIn(string note)" --args '["gm"]' --out req.json

# operator side
npx tsx src/cli.ts sponsor --request req.json --dry-run
SPONSOR_PRIVATE_KEY=0x... npx tsx src/cli.ts sponsor --request req.json
npx tsx src/cli.ts report --format md
```

Full command list: [`references/commands.md`](references/commands.md). Natural-language examples: [`examples/prompts.md`](examples/prompts.md).

## Use as an agent skill

`SKILL.md` follows the layout of the official Pharos Skill Engine (frontmatter, prerequisites, capability index,
write-operation pre-checks, security). Copy or symlink this folder into your agent's skills directory, e.g.
`npx skills add https://github.com/syariffadilla/pharos-sponsor-desk` once the repo is public.

## Policy

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
src/                         desk (policy engine + sender), policy, ledger, request (user-side signing),
                             chain (viem), report (JSON/MD/HTML), status (RPC + MCP), mcp client, cli
scripts/                     compile, deploy (testnet only), demo-live
test/                        vitest suite with an in-memory chain
deployments/                 Atlantic addresses from the live run
docs/LIVE_RUN.md, docs/live/ live run evidence (ledger, reports, status, verify outputs)
references/                  mechanism, policy, commands
examples/                    prompts, live policy
```

## Status and limitations

- Testnet demo code. Contracts are **unaudited**; do not use with real funds without a review.
- Heuristics are simple rate/age rules, not Sybil resistance.
- The ledger is a local JSONL file (single operator process). Run one desk process per ledger.
- The hosted Pharos MCP (`mcp.pharos.xyz`) serves mainnet; for Atlantic MCP status, self-host `PharosNetwork/pharos-mcp`.
- Only the EIP-7702 path is implemented; no ERC-4337 paymaster and no Pharos-native sponsored tx builder yet.

## License

MIT, see [LICENSE](LICENSE).
