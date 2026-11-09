// Test support for A34 (payroll hand-off boundary).
//
// Borrows E02's world (the A17 fixture: real ledger ports + the shipped KMU chart), so the wage
// journal posts against real accounts (5000 Löhne, 5700 Sozialversicherungen AG, 2260
// Verbindlichkeiten Personal) and a locked period is a real lock. Employees are seeded through E02's
// own verbs so the export reads exactly what the app would.

import { setup as hrSetup, addEmployee, capCtx } from '../hr/support.mjs';
import { makeContext } from '../../dist/core/context.js';

export { addEmployee, capCtx };
export { secondWorkspace } from '../payments/support.mjs';

export function setup(opts = {}) {
  return hrSetup(opts);
}

/** A ctx for `actor` at a specific ISO day, granting exactly `grants` (real periods stay wired). */
export { fixedClock } from '../../dist/core/clock.js';

/** Row counts across every table an A34 write can touch, so idempotency is asserted on ROWS. */
export function counts(store, workspaceId) {
  const one = (sql, ...p) => store.db.prepare(sql).get(...p).n;
  return {
    exports: one('SELECT COUNT(*) AS n FROM payroll_handoff_exports WHERE workspace_id = ?', workspaceId),
    postings: one('SELECT COUNT(*) AS n FROM wage_journal_posts WHERE workspace_id = ?', workspaceId),
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId),
    journalLines: one(
      'SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ?',
      workspaceId,
    ),
    files: one('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?', workspaceId),
  };
}

/**
 * The canonical balanced wage journal, using ONLY seeded KMU accounts:
 *   Debit  5000 Löhne und Gehälter              5'000.00
 *   Debit  5700 Sozialversicherungsbeiträge AG      500.00
 *   Credit 2260 Verbindlichkeiten gegenüber Personal 5'500.00
 */
export function wageLines() {
  return [
    { accountNumber: '5000', debitMinor: 500000, description: 'Bruttolohn' },
    { accountNumber: '5700', debitMinor: 50000, description: 'AG-Sozialbeitraege' },
    { accountNumber: '2260', creditMinor: 550000, description: 'Nettolohn + Sozialverbindlichkeit' },
  ];
}
