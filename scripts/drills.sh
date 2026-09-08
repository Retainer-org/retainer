#!/usr/bin/env bash
# Drive every state the charge engine can reach, deliberately.
#
# Nine drills: the happy path, a variable (metered) amount computed at charge
# time, all six failure modes, and the crash-recovery path. Each prints its own
# result; the summary at the end is what gets reported.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
export TEST_SMART_WALLET="${TEST_SMART_WALLET:?set TEST_SMART_WALLET}"

CLI="node --env-file=.env apps/cli/src/index.js"
WORKER="node --env-file=.env apps/worker/src/index.js --once"
MK="node --env-file=.env scripts/create-permission.js"
NOW=$(date +%s)
hr() { echo; echo "=============== $* ==============="; }
perm_id() { python3 -c "import sys,json;print(json.load(sys.stdin)['id'])"; }

# Drain the queue until nothing new happens (each --once does one unit of work).
drain() { for _ in 1 2 3 4 5 6; do $WORKER >/dev/null 2>&1; done; $CLI reconcile >/dev/null 2>&1; }

hr "D1  HAPPY PATH — fixed amount"
P1=$($MK --account "$TEST_SMART_WALLET" --allowance 5000000 --period 3600 \
        --start "$NOW" --end "$((NOW+2592000))" | perm_id)
$CLI enqueue --permission "$P1" --amount 1000000 >/dev/null
$WORKER; $CLI reconcile >/dev/null

hr "D2  VARIABLE AMOUNT — computed at charge time from usage"
P2=$($MK --account "$TEST_SMART_WALLET" --allowance 5000000 --period 3600 \
        --start "$NOW" --end "$((NOW+2592000))" | perm_id)
# 3 units at 0.25 USDC. The charge is enqueued with NO fixed amount; the worker
# computes 750000 when it runs, not now.
$CLI record-usage --permission "$P2" --units 3 --price 250000 --note "api calls" >/dev/null
$CLI enqueue --permission "$P2" --usage >/dev/null
$WORKER; $CLI reconcile >/dev/null

hr "D3  ALLOWANCE_EXHAUSTED — request exceeds the period cap"
P3=$($MK --account "$TEST_SMART_WALLET" --allowance 1000000 --period 3600 \
        --start "$NOW" --end "$((NOW+2592000))" | perm_id)
$CLI enqueue --permission "$P3" --amount 2000000 >/dev/null
$WORKER

hr "D4  INSUFFICIENT_BALANCE — cap allows it, wallet cannot fund it"
P4=$($MK --account "$TEST_SMART_WALLET" --allowance 100000000 --period 3600 \
        --start "$NOW" --end "$((NOW+2592000))" | perm_id)
$CLI enqueue --permission "$P4" --amount 50000000 >/dev/null
$WORKER

hr "D5  NOT_STARTED — permission begins in the future"
P5=$($MK --account "$TEST_SMART_WALLET" --allowance 5000000 --period 3600 \
        --start "$((NOW+3600))" --end "$((NOW+2592000))" | perm_id)
$CLI enqueue --permission "$P5" --amount 1000000 >/dev/null
$WORKER

hr "D6  EXPIRED — permission window already closed"
P6=$($MK --account "$TEST_SMART_WALLET" --allowance 5000000 --period 3600 \
        --start "$((NOW-7200))" --end "$((NOW-3600))" --register false | perm_id)
$CLI enqueue --permission "$P6" --amount 1000000 >/dev/null
$WORKER

hr "D7  REVOKED — revoked on-chain, then charged"
P7=$($MK --account "$TEST_SMART_WALLET" --allowance 5000000 --period 3600 \
        --start "$NOW" --end "$((NOW+2592000))" | perm_id)
node --env-file=.env scripts/revoke.js --permission "$P7"
$CLI enqueue --permission "$P7" --amount 1000000 >/dev/null
$WORKER

hr "D8  NOT_APPROVED — signed but never registered on-chain"
P8=$($MK --account "$TEST_SMART_WALLET" --allowance 5000000 --period 3600 \
        --start "$NOW" --end "$((NOW+2592000))" --register false | perm_id)
$CLI enqueue --permission "$P8" --amount 1000000 >/dev/null
$WORKER

hr "D9  CRASH RECOVERY — kill after broadcast, before the row updates"
P9=$($MK --account "$TEST_SMART_WALLET" --allowance 5000000 --period 3600 \
        --start "$NOW" --end "$((NOW+2592000))" | perm_id)
$CLI enqueue --permission "$P9" --amount 1500000 >/dev/null
echo "--- run 1: worker exits hard immediately after eth_sendRawTransaction returns ---"
RETAINER_CRASH_AFTER_BROADCAST=1 $WORKER; echo "worker exit code: $? (137 = deliberate kill)"
echo "--- state after crash: attempt persisted as 'signed', charge still in_flight ---"
$CLI attempts --limit 1
echo "--- run 2: restart. Recovery must resolve to exactly one on-chain spend ---"
$WORKER
$CLI reconcile >/dev/null

hr "SUMMARY"
drain
echo "--- charges ---";  $CLI status --limit 12
echo "--- ledger (confirmed only) ---"; $CLI ledger
echo "--- gas tank ---"; $CLI gas
