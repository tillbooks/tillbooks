#!/bin/sh
# Critic mutation harness: apply one sed mutation to bankCompose.ts, run the author's parity suite, restore.
set -u
# The repository root, two levels above this script (the critic's own worktree path was hard-coded here).
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
F=$ROOT/app/src/surfaces/Bank/bankCompose.ts
run() {
  name=$1; expr=$2
  cp "$F" "$F.orig"
  sed -i "$expr" "$F"
  if cmp -s "$F" "$F.orig"; then echo "$name: MUTATION DID NOT APPLY"; mv "$F.orig" "$F"; return; fi
  out=$(cd "$ROOT" && timeout 600 node --test test/banking/bank-compose-parity.test.mjs 2>&1 | grep -E "^# (pass|fail)")
  echo "$name: $(echo $out)"
  mv "$F.orig" "$F"
}
run M1-value-date-first 's/const date = line.bookingDate ?? line.valueDate;/const date = line.valueDate ?? line.bookingDate;/'
run M2-no-supplyDate 's/      intent.supplyDate = date;//'
run M3-bank-last 's/lines: \[...bank, ...legLines\]/lines: [...legLines, ...bank]/'
run M4-net-not-gross 's/amount, gross: true }/amount, gross: false }/'
run M5-side-flip 's/side: legIn ? .credit. : .debit./side: legIn ? "debit" : "credit"/'
run M6-drop-zero-check 's/bankSigned === 0 ? \[\] :/false ? [] :/'
run M7-supply-from-value 's/      intent.supplyDate = date;/      intent.supplyDate = line.valueDate ?? date;/'
run M8-none-as-taxed "s/return leg.taxCode !== '' \&\& leg.taxCode !== 'none';/return leg.taxCode !== '';/"
