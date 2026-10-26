| Step | Scenario | Verdict | Deciding rule | Code | Executed | Tx |
|---|---|---|---|---|---|---|
| A1-allow-fresh-user | fresh 0-PHRS user, allowlisted checkIn, inside desk hours, within quota | **ALLOW** | `gate.all_rules_passed` | ALL_RULES_PASSED | yes | [0x29a2c59a…](https://atlantic.pharosscan.xyz/tx/0x29a2c59ad71a1a7e31762b2dffc2c5799fd19f76a9d625dc34a47c0aeb64cb40) |
| A2-allow-delegated | already-delegated user, allowlisted checkIn | **ALLOW** | `gate.all_rules_passed` | ALL_RULES_PASSED | yes | [0x888e7802…](https://atlantic.pharosscan.xyz/tx/0x888e780286b7d06157270ccdc97bf02817c548c7a68141751738a01440ffeabb) |
| D1-deny-spend-limit | same user again the same UTC day (perAddressDaily.maxTx = 1) | **DENY** | `spend_limit.per_address_daily_tx` | ADDRESS_DAILY_TX_QUOTA | no (sponsor nonce 9 -> 9) | - |
| D2-deny-allowlist | target contract (Multicall3) not on the allowlist | **DENY** | `allowlist.contract` | NOT_ALLOWLISTED_TARGET | no (sponsor nonce 9 -> 9) | - |
| D3-deny-sender-list | sender is on rules.allowlist.senders.deny | **DENY** | `allowlist.sender_denylist` | SENDER_DENYLISTED | no (sponsor nonce 9 -> 9) | - |
| D4-deny-time-window | setMotto is allowlisted only for the weekend campaign window (Sat-Sun Asia/Jakarta) | **DENY** | `time_window.hours` | OUTSIDE_TIME_WINDOW | no (sponsor nonce 9 -> 9) | - |

Audit log (docs/gatekeeper/audit.jsonl):

| # | Time (UTC) | Verdict | Deciding rule | Sender | Request hash | Tx |
|---|---|---|---|---|---|---|
| 1 | 2026-10-26T09:35:32Z | **ALLOW** | `gate.all_rules_passed` (ALL_RULES_PASSED) | `0xe0B382f2…4cd1` | `0xef1a44af…0eee` | [0x29a2c59a…cb40](https://atlantic.pharosscan.xyz/tx/0x29a2c59ad71a1a7e31762b2dffc2c5799fd19f76a9d625dc34a47c0aeb64cb40) |
| 2 | 2026-10-26T09:35:42Z | **ALLOW** | `gate.all_rules_passed` (ALL_RULES_PASSED) | `0x3A7E9F7B…204A` | `0xc3f50673…9b6d` | [0x888e7802…eabb](https://atlantic.pharosscan.xyz/tx/0x888e780286b7d06157270ccdc97bf02817c548c7a68141751738a01440ffeabb) |
| 3 | 2026-10-26T09:35:52Z | **DENY** | `spend_limit.per_address_daily_tx` (ADDRESS_DAILY_TX_QUOTA) | `0xe0B382f2…4cd1` | `0x007aaf6c…c22c` | not executed |
| 4 | 2026-10-26T09:35:54Z | **DENY** | `allowlist.contract` (NOT_ALLOWLISTED_TARGET) | `0x58422D77…A25d` | `0x2fba3dff…92b0` | not executed |
| 5 | 2026-10-26T09:35:56Z | **DENY** | `allowlist.sender_denylist` (SENDER_DENYLISTED) | `0xE5EE78a1…0Bc4` | `0xab33aec8…c429` | not executed |
| 6 | 2026-10-26T09:35:57Z | **DENY** | `time_window.hours` (OUTSIDE_TIME_WINDOW) | `0x58422D77…A25d` | `0x3767895a…db89` | not executed |
