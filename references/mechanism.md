# How sponsorship works in Sponsor Desk

## What Pharos has published (checked 2026-10-26)

- Pharos announced (2026-09-30, Agent Native upgrade) that **Sponsored Transactions are live on testnet**:
  they "separate the transaction initiator from the gas payer" while preserving the original sender.
  Source: https://thenextweb.com/news/pharos-agent-native-upgrade-ai-agents-onchain-realfi ,
  https://www.pharos.xyz/agent-native
- The public docs do **not** describe a sponsored-transaction format, sponsor signature fields or RPC method.
  `eth_sendRawTransaction` is documented as supporting legacy, EIP-2930 and EIP-1559 types
  (https://docs.pharos.xyz/api-and-sdk/json-rpc-methods.md). The docs' own assistant
  (`docs.pharos.xyz/index.md?ask=...`) answered that the format is not specified in the docs.
- Canonical contracts on Atlantic include an ERC-4337 EntryPoint v0.7 at `0x0000000071727De22E5E9d8BAf0edAc6f37da032`
  (https://docs.pharos.xyz/getting-started/canonical-contracts.md).

Because the native format is not public, Sponsor Desk does not claim to use it.

## What Sponsor Desk uses: EIP-7702 (type 0x04), verified on Atlantic

We sent EIP-7702 transactions to Atlantic (chainId 688689) and they were included, with the delegation designator
`0xef0100 || executor` written to the user's account (see `docs/LIVE_RUN.md`). That gives the same separation:

| Role | Who |
|---|---|
| Transaction `from` / gas payer | sponsor wallet |
| Transaction `to` | the user's own EOA (delegated to `SponsoredExecutor`) |
| `msg.sender` seen by the target contract | the user's EOA |
| Who authorizes the action | the user, via an EIP-712 `Execute` signature (plus a one-time 7702 authorization) |

### Flow

1. **User side** (`request:build`, or any wallet that can sign typed data and 7702 authorizations):
   - reads `eth_getCode(user)`; if it is not `0xef0100 || executor`, signs an authorization
     `{chainId: 688689, address: executor, nonce: eth_getTransactionCount(user)}`;
   - reads `executor.nonce()` on the user's address (0 if not delegated yet);
   - signs EIP-712 with domain `{name: "SponsorDeskExecutor", version: "1", chainId, verifyingContract: user}` and
     `Execute(Call[] calls,uint256 nonce,uint256 deadline)`, `Call(address to,uint256 value,bytes data)`.
2. **Desk side** (`sponsor`): policy checks, then sends
   `to = user, data = execute(calls, deadline, signature)`; type `0x04` with `authorizationList = [auth]` the first
   time, type `0x02` afterwards. Gas is paid by the sponsor.
3. **On-chain**: `SponsoredExecutor.execute` (running in the user's account) checks the deadline, recovers the
   signer and requires it to equal `address(this)` (the user), bumps the nonce in a namespaced storage slot, then
   performs each call. Targets see `msg.sender == user`.

### Costs observed on Atlantic (5 sponsored txs on 2026-10-25 UTC)

For every sponsored tx in the live run, the sponsor's balance dropped by exactly `gasUsed × effectiveGasPrice`
(effective price 1 gwei). The docs' Gas Model page says fees are "charged by gas_limit at inclusion time"; our
observations did not show that for these transactions. Budgets still reserve the worst case
(`maxGasPerTx × maxFeePerGas`) before sending, so either model stays within the cap.

### Swapping the mechanism later

`SponsorDesk` talks to the chain through the `ChainClient` interface (`src/chain.ts`). If Pharos publishes the native
Sponsored Transaction format, a new client can build that transaction type while the policy engine, ledger and reports
stay the same.
