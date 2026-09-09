// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import * as ledger from '../../dist/core/ledger/index.js';

// Pattern P3: A02 is the single posting path. Every later spec's "delegates to A02" claim relies on
// there being no second writer of journal_entry / journal_line. This guard fails if a future edit
// leaks a raw entry writer (e.g. writePostedEntry) into the public ledger surface, or renames a verb.
test('P3 guard: the ledger exposes exactly its intended verbs, no raw writer', () => {
  const expected = [
    // A02, the single posting path and its reads.
    'deleteDraft',
    'getEntry',
    'listJournal',
    'postEntry',
    'reverseEntry',
    'saveDraft',
    // A03, audit trail & period locks (verbs, read models, and the port factories that wire them).
    'appendAuditLog',
    'assertPeriodOpen',
    'fiscalYearOf',
    'getAuditLog',
    'hardCloseYear',
    'ledgerPorts',
    'listPeriodLocks',
    'lockPeriod',
    'makeAuditPort',
    'makePeriodPort',
    'reopenMonth',
    'softCloseMonth',
    'unlockPeriod',
    // A04, opening balances. All four go THROUGH postEntry: `setOpeningBalances` builds lines and
    // hands them over, `importMigration` delegates to `setOpeningBalances`, and neither touches
    // journal_entry / journal_line directly. `parseSwissAmount` writes nothing at all.
    'getOpeningBalances',
    'importMigration',
    'parseSwissAmount',
    'setOpeningBalances',
  ].sort();
  const exportedFns = Object.keys(ledger)
    .filter((k) => typeof ledger[k] === 'function')
    .sort();
  assert.deepEqual(exportedFns, expected);
  // The raw journal writers must never be public: A03's year-close posts THROUGH A02 postEntry (P3),
  // it does not open a second writer of journal_entry / journal_line.
  //
  // The directive below is not a suppression, it is the SECOND guard, and it is strictly the earlier
  // of the two. Reading a member the module does not export is a type error, so `@ts-expect-error` is
  // required for this line to compile TODAY. The moment anyone adds `writePostedEntry` to the public
  // surface the read becomes legal, the directive becomes UNUSED, and `tsc` fails the build with
  // TS2578 before the suite is ever run. Removing the directive to "clean up" therefore breaks the
  // build immediately: that is the intended behaviour, not a snag.
  // @ts-expect-error `writePostedEntry` is not exported, and the day it is, this line stops erroring
  assert.equal(ledger.writePostedEntry, undefined, 'the raw entry writer must never be public');
});
