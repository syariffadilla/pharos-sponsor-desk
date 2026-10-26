# Command reference

Run from the skill folder. Env: `DESK_POLICY` (or `--policy`), `DESK_LEDGER` (or `--ledger`, default `data/ledger.jsonl`),
`SPONSOR_PRIVATE_KEY` (operator), `USER_PRIVATE_KEY` (user side only), optional `PHAROS_RPC_URL` override.

```bash
# read-only
npx tsx src/cli.ts status --account 0xUser
npx tsx src/cli.ts status --mcp http://127.0.0.1:3001/mcp        # self-hosted pharos-mcp on Atlantic
npx tsx src/cli.ts policy
npx tsx src/cli.ts report --format md
npx tsx src/cli.ts report --format html --out reports/today.html
npx tsx src/cli.ts verify 0xTxHash

# user side: sign a request (no gas needed)
USER_PRIVATE_KEY=0x... npx tsx src/cli.ts request:build \
  --to 0xAdB97503ad3A8BDA288C0c179818052b2b301638 --method "checkIn(string note)" --args '["gm"]' --out req.json

# operator side
npx tsx src/cli.ts sponsor --request req.json --dry-run
SPONSOR_PRIVATE_KEY=0x... npx tsx src/cli.ts sponsor --request req.json
```

`sponsor` output: `{decision: sponsored|rejected|failed|dry-run, reasons[], account, sponsor, txHash, explorer, gasUsed, costWei, ledgerId}`.
