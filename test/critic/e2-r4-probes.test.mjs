// CRITIC PROBES, D178 node E2 round 4 (non-author), against the re-cut: coverage first, one-to-one
// matching inside an overlap, covered_period_new_line. A failing probe is the evidence of a defect (see
// docs/critique/bank-parity-e2-critic-r4.md).
//
// SYNTHETIC BY CONSTRUCTION: every statement, name and amount is invented here; the IBAN is the published
// PostFinance sample the A39 suites already use.

import test from 'node:test';
import assert from 'node:assert/strict';

import { importCamt } from '../../dist/core/banking/index.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { world, must, camt } from '../banking/bank-inbox-support.mjs';

let n = 0;
const key = () => `e2r4-${(n += 1)}`;

function lines(t) {
  return t.store.db
    .prepare(
      `SELECT t.id, t.amount_minor AS a, t.booking_date AS b, s.message_type AS f,
              EXISTS (SELECT 1 FROM bank_txn_possible_duplicate p WHERE p.workspace_id = t.workspace_id AND p.bank_txn_id = t.id) AS flagged
         FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id WHERE t.workspace_id = ? ORDER BY t.rowid`,
    )
    .all(t.workspaceId);
}

const day = (statementId, date, openingMinor, entries) =>
  must(importCamt(t0.ctx, { bankAccountId: t0.bankAccountId, xml: camt({ statementId, seqNb: statementId.slice(-1), from: date, to: date, openingMinor, entries }), idempotencyKey: key() }), statementId);
let t0;

test('R4-1: a chained camt that EXTENDS the balance chain over days a CSV already covers never doubles a line unflagged', () => {
  t0 = world();
  // camt for Oct 5: the chain starts (opening 1000.00, one fee).
  day('R4-CAMT-1', '2026-10-05', 100000, [{ ref: 'R4-A1', amountMinor: 500, cd: 'DBIT', date: '2026-10-05' }]);
  // A CSV export of Oct 6 to Oct 9 (no balances): it covers Oct 6 to Oct 8 fully. On Oct 7 the card
  // purchase as the CSV names it.
  must(
    importBankStatement(t0.ctx, {
      bankAccountId: t0.bankAccountId,
      content: ['Datum;Text;Empfänger;Betrag', '06.10.2026;Papeterie;Papeterie Lindenhof;-12.00', '07.10.2026;Kartenkauf;AMZN Mktp DE;-39.90', '09.10.2026;Kaffee;Kaffeebar Seeblick;-4.50'].join('\n'),
      mapping: { columns: { bookingDate: 'Datum', text: 'Text', counterparty: 'Empfänger', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' },
      idempotencyKey: key(),
    }),
    'csv',
  );
  // Then the day-end camts for Oct 6 and Oct 7 arrive, each continuing the balance chain exactly
  // (1000.00 - 5.00 = 995.00; 995.00 - 12.00 = 983.00). Oct 7 carries the same purchase under its legal name.
  day('R4-CAMT-2', '2026-10-06', 99500, [{ ref: 'R4-A2', amountMinor: 1200, cd: 'DBIT', date: '2026-10-06', name: 'Papeterie Lindenhof' }]);
  day('R4-CAMT-3', '2026-10-07', 98300, [{ ref: 'R4-A3', amountMinor: 3990, cd: 'DBIT', date: '2026-10-07', name: 'Amazon EU Sarl' }]);
  const purchases = lines(t0).filter((l) => l.a === 3990);
  assert.equal(purchases.length, 2, 'both formats hold the purchase');
  assert.ok(
    purchases.some((l) => l.flagged === 1),
    `the camt line on a day the CSV covers imported unflagged (a silent double count): ${JSON.stringify(lines(t0))}`,
  );
});
