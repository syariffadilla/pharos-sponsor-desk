# Command reference

Run from the skill folder. Env: `DESK_POLICY` (or `--policy`), `DESK_LEDGER` (or `--ledger`, default `data/ledger.jsonl`),
`DESK_AUDIT` (or `--audit`, default `data/audit.jsonl`),
`SPONSOR_PRIVATE_KEY` (operator), `USER_PRIVATE_KEY` (user side only), optional `PHAROS_RPC_URL` override.

```bash
# read-only
npx tsx src/cli.ts status --account 0xUser
npx tsx src/cli.ts status --mcp http://127.0.0.1:3001/mcp        # self-hosted pharos-mcp on Atlantic
npx tsx src/cli.ts policy
npx tsx src/cli.ts rules                                          # spend limit / allowlist / time window as configured
npx tsx src/cli.ts audit --verify                                 # hash chain + allow/deny summary
npx tsx src/cli.ts audit --verdict deny --format md               # also: json (default), jsonl, csv; --out file
npx tsx src/cli.ts report --format md
npx tsx src/cli.ts report --format html --out reports/today.html
npx tsx src/cli.ts verify 0xTxHash

# user side: sign a request (no gas needed)
USER_PRIVATE_KEY=0x... npx tsx src/cli.ts request:build \
  --to 0xAdB97503ad3A8BDA288C0c179818052b2b301638 --method "checkIn(string note)" --args '["gm"]' --out req.json

# operator side
npx tsx src/cli.ts sponsor --request req.json --dry-run
npx tsx src/cli.ts check --request req.json                       # same as --dry-run: gatekeeper decision only
SPONSOR_PRIVATE_KEY=0x... npx tsx src/cli.ts sponsor --request req.json
```

`sponsor` / `check` output: `{verdict: allow|deny, decidedBy: {rule, ruleType, code, message}, decision: sponsored|rejected|failed|dry-run,
reasons[], trace[], account, requestHash, sponsor, executed, txHash, explorer, gasUsed, costWei, ledgerId, auditSeq}`.

Gatekeeper demo: `npm run demo:gatekeeper` (local, synthetic) or `KEYS_FILE=... npm run demo:gatekeeper -- --live` (Atlantic).
