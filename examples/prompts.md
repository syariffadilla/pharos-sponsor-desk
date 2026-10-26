# Example prompts (natural language -> what the agent runs)

| Prompt | Agent action |
|---|---|
| "How much sponsorship budget is left today and is the sponsor wallet OK?" | `status` -> report `today.remainingWei` in PHRS and `sponsor.balance` |
| "Only pay gas for check-ins on our guestbook contract, 1 per user per day, 0.05 PHRS a day total." | edit policy: allowlist `checkIn(string)` on the guestbook, `perAddressDaily.maxTx=1`, `globalDaily.maxGasWei="50000000000000000"`; then `policy` to validate |
| "This user sent a signed request in req.json. Would we sponsor it?" | `sponsor --request req.json --dry-run` -> explain decision + reasons |
| "OK, sponsor it." | pre-checks, then `sponsor --request req.json` -> hash + explorer link + cost |
| "Prepare a gasless check-in for my test wallet." (user side) | `request:build --to <guestbook> --method "checkIn(string note)" --args '["gm"]' --out req.json` |
| "Why was 0x3A7E... refused?" | `ledger --day <today>` filtered to that account -> reason codes in plain words |
| "Give me today's sponsorship report as Markdown." | `report --format md` |
| "Make a dashboard I can open." | `report --format html --out reports/today.html` |
| "Did tx 0x5fce... really get paid by our sponsor?" | `verify 0x5fce...` -> `gasPayer` vs `account`, type, status, cost |
| "Lots of new wallets are hitting us. Tighten it." | lower `heuristics.maxNewAddressesPerWindow`, raise `newAddressWindowSec`; explain the trade-off |
