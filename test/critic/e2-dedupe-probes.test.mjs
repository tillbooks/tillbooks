// CRITIC PROBES, D178 node E2 round 1 (non-author): which bank lines exist after an import.
//
// Each probe asserts the CORRECT outcome; a failing probe is the evidence of a defect (see
// docs/critique/bank-parity-e2-critic-r1.md). A false positive drops a real line silently, a false
// negative counts one twice: both are money-path defects.
//
// SYNTHETIC BY CONSTRUCTION: every statement, name, reference and amount below is invented in this file;
// the account IBAN is the published PostFinance sample the A39 suites already use.

import test from 'node:test';
import assert from 'node:assert/strict';

import { importCamt } from '../../dist/core/banking/index.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { world, must, camt, MAIN_IBAN } from '../banking/bank-inbox-support.mjs';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';

let n = 0;
const key = () => `e2c-${(n += 1)}`;

// ADAPTED to the E2 re-cut (orchestrator ruling, round 3): a re-delivery over covered days is imported FLAGGED
// and answered by the person (one by one, or the delivery at once), never dropped silently and never counted
// twice. "No silent double count" is therefore: every re-delivered line waits flagged, and after the answer the
// lines that STAND (not ignored as a duplicate) are the real movements.
const flagsOf = (res) => res.statements.flatMap((s) => (s.nearDuplicates ?? []).map((d) => d.reason));
function answerDelivery(t, res) {
  for (const s of res.statements) must(resolvePossibleDuplicate(t.ctx, { statementId: s.statementId, scope: 'one_to_one_matches', decision: 'duplicate', idempotencyKey: key() }), 'bulk');
}
function standing(t) {
  return t.store.db
    .prepare(
      `SELECT t.amount_minor AS a, t.credit_debit AS cd FROM bank_txn t WHERE t.workspace_id = ?
          AND NOT EXISTS (SELECT 1 FROM bank_line_decision d WHERE d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id AND d.state = 'ignored' AND d.superseded_at IS NULL)`,
    )
    .all(t.workspaceId);
}

/** Every live line of the world, oldest first, with its format. */
function lines(t) {
  return t.store.db
    .prepare(
      `SELECT t.id, t.amount_minor AS a, t.credit_debit AS cd, t.booking_date AS b, t.value_date AS v, s.message_type AS f
         FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id
        WHERE t.workspace_id = ? ORDER BY COALESCE(t.booking_date, t.value_date), t.rowid`,
    )
    .all(t.workspaceId);
}

/** One MT940 message (balances are not reconciled by the parser; they are only shape here). */
function mt940({ ref, number, page = 1, last = true, open = '260930', close = '261005', lines: ls }) {
  const body = ls.map((l) => `:61:${l.line}\n:86:${l.info}`).join('\n');
  return [
    `:20:${ref}`,
    `:25:${MAIN_IBAN}`,
    `:28C:${number}/${page}`,
    `${page === 1 ? ':60F:' : ':60M:'}C${open}CHF1000,00`,
    body,
    `${last ? ':62F:' : ':62M:'}C${close}CHF900,00`,
    '-',
  ].join('\n');
}

function importText(t, content, extra = {}) {
  return must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, idempotencyKey: key(), ...extra }), 'import_bank_statement');
}

// --- E2-C1: the CSV identity key moves when the mapping changes -------------------------------------

const CSV = [
  'Buchungsdatum;Valuta;Buchungstext;Betrag',
  '05.10.2026;02.10.2026;Kaffeebar Seeblick;-4.50',
  '05.10.2026;05.10.2026;Druckerei Lindenhof;-120.00',
  '06.10.2026;06.10.2026;Gutschrift Kundin Ammann;350.00',
].join('\n');

test('E2-C1: the same CSV re-imported after the mapping gained the Valuta column adds nothing (no silent double count)', () => {
  const t = world();
  const without = { columns: { bookingDate: 'Buchungsdatum', text: 'Buchungstext', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };
  const withValuta = { ...without, columns: { ...without.columns, valueDate: 'Valuta' } };
  const first = importText(t, CSV, { mapping: without });
  assert.equal(first.imported, 3);
  // The person corrects the saved mapping (adds the Valuta column) and drops the same export again,
  // or next month's export that overlaps these days.
  const second = importText(t, CSV, { mapping: withValuta });
  assert.deepEqual(flagsOf(second), Array(second.imported).fill('same_movement'), `every re-imported row waits flagged: ${JSON.stringify(second.statements)}`);
  answerDelivery(t, second);
  const rows = standing(t);
  assert.equal(
    rows.length,
    3,
    `three movements, got ${rows.length}: imported ${second.imported} again, warnings ${JSON.stringify(second.statements.map((s) => s.warnings))}`,
  );
});

// --- E2-C2: MT940 lines without a bank reference collide across statements --------------------------

test('E2-C2a: two MT940 pages of one statement, each with an identical coffee (no // reference): both lines exist', () => {
  const t = world();
  const page1 = mt940({ ref: 'E2C-P1', number: 77, page: 1, last: false, close: '261005', lines: [{ line: '2610051005D4,50NMSCNONREF', info: 'Kaffeebar Seeblick Karte 1' }] });
  const page2 = mt940({ ref: 'E2C-P2', number: 77, page: 2, last: true, open: '261005', close: '261005', lines: [{ line: '2610051005D4,50NMSCNONREF', info: 'Kaffeebar Seeblick Karte 2' }] });
  const res = importText(t, `${page1}\n${page2}`);
  assert.equal(lines(t).length, 2, `two coffees on two pages, got ${lines(t).length}; skipped ${JSON.stringify(res.skipped)}`);
});

test('E2-C2b: two MT940 day statements, a coffee each with the same value date and no entry date or // reference: both lines exist', () => {
  const t = world();
  // Card payments carry the purchase day as value date (Friday 02.10.) and are booked on different days.
  const monday = mt940({ ref: 'E2C-MO', number: 78, close: '261005', lines: [{ line: '261002D4,50NMSCNONREF', info: 'Kaffeebar Seeblick, Karte, Kauf 02.10. 08:10' }] });
  const tuesday = mt940({ ref: 'E2C-TU', number: 79, open: '261005', close: '261006', lines: [{ line: '261002D4,50NMSCNONREF', info: 'Kaffeebar Seeblick, Karte, Kauf 02.10. 16:40' }] });
  importText(t, monday);
  const res = importText(t, tuesday);
  assert.equal(lines(t).length, 2, `two coffees booked on two days, got ${lines(t).length}; skipped ${JSON.stringify(res.skipped)}`);
});

// --- E2-C3: a reference match ignores the date entirely ---------------------------------------------

test('E2-C3: a recurring reference (monthly rent) never absorbs January into February across formats', () => {
  const t = world();
  // February's rent arrived by MT940 first: no // bank reference, the owner's reference in 61-7.
  importText(t, mt940({ ref: 'E2C-FEB', number: 12, open: '260201', close: '260202', lines: [{ line: '2602020202D1500,00NMSCMIETE-4711', info: 'Dauerauftrag Miete Lindenhof' }] }));
  // Then a CSV export for January and February, with the same reference column on both rows.
  const csv = ['Datum;Text;Betrag;Referenz', '02.01.2026;Dauerauftrag Miete Lindenhof;-1500.00;MIETE-4711', '02.02.2026;Dauerauftrag Miete Lindenhof;-1500.00;MIETE-4711'].join('\n');
  const res = importText(t, csv, { mapping: { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag', reference: 'Referenz' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' } });
  const rows = lines(t);
  const days = rows.map((r) => r.b ?? r.v);
  // ROUND 2 (orchestrator ruling, "warn, don't block"): a CSV reference column is never strong identity,
  // so February's CSV row is IMPORTED and NAMED as a possible duplicate of the MT940 line rather than
  // absorbed. The defect this probe guards stays pinned: January is never absorbed into February, and
  // no February line is a silent second count.
  assert.ok(days.includes('2026-01-02'), `January is never absorbed, got ${JSON.stringify(days)}; skipped ${JSON.stringify(res.skipped)}`);
  const feb = rows.filter((r) => (r.b ?? r.v) === '2026-02-02');
  const flags = t.store.db.prepare('SELECT bank_txn_id AS id, existing_bank_txn_id AS of FROM bank_txn_possible_duplicate WHERE workspace_id = ?').all(t.workspaceId);
  const unnamedFeb = feb.filter((r) => !flags.some((f) => f.id === r.id));
  assert.equal(unnamedFeb.length, 1, `February once, any second February line named: ${JSON.stringify({ feb, flags })}`);
  const jan = rows.find((r) => (r.b ?? r.v) === '2026-01-02');
  assert.ok(!flags.some((f) => f.id === jan.id), 'January resembles nothing a month away');
});

// --- E2-C5 (LOW): a CSV carrying the purchase (value) date only, four days before the camt booking ----

test('E2-C5: a CSV whose date is the value date, booked four days later in camt, is at least NAMED as a possible duplicate', () => {
  const t = world();
  // camt: a card payment abroad, bought Thursday 01.10., booked Monday 05.10.
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'E2C-CAMT-C5', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'E2C-C5-1', amountMinor: 8840, cd: 'DBIT', date: '2026-10-05', valueDate: '2026-10-01', ustrd: 'Velowerkstatt Alpenblick' }] }),
      idempotencyKey: key(),
    }),
    'camt',
  );
  // The same movement from a CSV whose only date column is that purchase (value) date.
  const res = importText(t, 'Valuta;Text;Betrag\n01.10.2026;Velowerkstatt Alpenblick;-88.40\n', {
    mapping: { columns: { bookingDate: 'Valuta', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' },
  });
  const named = res.skipped.some((s) => s.reason === 'cross_format_duplicate') || res.statements.some((s) => s.warnings.includes('possible_cross_format_duplicate'));
  assert.ok(named, `imported ${res.imported} with no skip and no warning: a silent double count (${lines(t).length} lines)`);
});

// --- E2-C6 (LOW): an MT940 zero line -----------------------------------------------------------------

test('E2-C6: an MT940 :61: of 0,00 is skipped zero_amount like a CSV row, never a zero line in the inbox', () => {
  const t = world();
  const res = importText(t, mt940({ ref: 'E2C-ZERO', number: 81, lines: [{ line: '2610051005D0,00NMSCNONREF//E2C-Z-1', info: 'Saldo-Info' }] }));
  assert.equal(lines(t).length, 0, `a zero line was imported; skipped ${JSON.stringify(res.skipped)}`);
});

// --- Sound checks: scoping of the dedupe lookups (§H-TENANT, per Bankkonto) ---------------------------

test('E2-C7 (sound check): another Bankkonto and another workspace never absorb a line', async () => {
  const { createBankAccount } = await import('../../dist/core/banking/index.js');
  const { secondWorkspace } = await import('../banking/bank-inbox-support.mjs');
  const t = world();
  const csv = 'Datum;Text;Betrag\n05.10.2026;Kaffeebar Seeblick;-4.50\n';
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };
  importText(t, csv, { mapping });
  // A second Bankkonto of the same workspace: the same day, the same coffee, as MT940.
  const savings = must(createBankAccount(t.ctx, { name: 'Sparkonto', iban: 'CH5604835012345678009', currency: 'CHF', ledgerAccountId: t.acc('1020'), idempotencyKey: 'e2c7-sav' }));
  const sta = mt940({ ref: 'E2C-SAV', number: 1, close: '261005', lines: [{ line: '2610051005D4,50NMSCNONREF', info: 'Kaffeebar Seeblick' }] }).replace(`:25:${MAIN_IBAN}`, ':25:CH5604835012345678009');
  const res = must(importBankStatement(t.ctx, { bankAccountId: savings.bankAccountId, content: sta, idempotencyKey: key() }));
  assert.equal(res.imported, 1, 'another Bankkonto is not absorbed');
  // Another workspace: its own Bankkonto, the same CSV, its own mapping row.
  const b = secondWorkspace(t);
  const other = must(createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'e2c7-b' }));
  const resB = must(importBankStatement(b.ctx, { bankAccountId: other.bankAccountId, content: csv, mapping, idempotencyKey: key() }));
  assert.equal(resB.imported, 1, 'another workspace is not absorbed');
  // B cannot import onto A's Bankkonto, nor read its mapping.
  const cross = importBankStatement(b.ctx, { bankAccountId: t.bankAccountId, content: csv, mapping, idempotencyKey: key() });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'needs_bank_account');
});

test('E2-C8 (sound check): a re-export with corrected texts, then the same file plus one appended row, adds exactly that row', () => {
  const t = world();
  const mapping = { columns: { bookingDate: 'Datum', text: 'Text', debit: 'Belastung', credit: 'Gutschrift' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: ',' };
  const rows = ["05.10.2026;Druckerei Lindenhof;1'234,50;", '05.10.2026;Kaffeebar Seeblick;4,50;', '05.10.2026;Kaffeebar Seeblick;4,50;', '06.10.2026;Kundin Ammann;;1234,50'];
  const head = 'Datum;Text;Belastung;Gutschrift';
  assert.equal(importText(t, [head, ...rows].join('\n'), { mapping }).imported, 4);
  const corrected = rows.map((r) => r.replace('Kaffeebar Seeblick', 'KAFFEEBAR SEEBLICK ZÜRICH'));
  const again = importText(t, [head, ...corrected].join('\n'), { mapping });
  assert.deepEqual(flagsOf(again), Array(4).fill('same_movement'), 'corrected texts are the same movements: each matched one to one');
  answerDelivery(t, again);
  const longer = importText(t, [head, ...rows, '06.10.2026;Kaffeebar Seeblick;4,50;'].join('\n'), { mapping });
  assert.equal(longer.imported - flagsOf(longer).length, 1, 'only the appended row is new');
  answerDelivery(t, longer);
  const sum = standing(t).reduce((s, r) => s + (r.cd === 'CRDT' ? r.a : -r.a), 0);
  assert.equal(sum, -123450 - 450 - 450 + 123450 - 450);
});

// --- E2-C4: a stored line absorbs a second movement from a LATER import (value date fallback) ---------

test('E2-C4: camt up to Monday, then MT940 from Tuesday: a second identical card payment booked Tuesday is not absorbed into Monday', () => {
  const t = world();
  // camt for Monday 05.10.: one coffee, purchase (value) Friday 02.10.
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'E2C-CAMT-MO', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'E2C-MO-1', amountMinor: 450, cd: 'DBIT', date: '2026-10-05', valueDate: '2026-10-02', ustrd: 'Kaffeebar Seeblick' }] }),
      idempotencyKey: key(),
    }),
    'camt Monday',
  );
  // The bank switches the delivery to MT940 from Tuesday: the Tuesday statement books a second coffee
  // bought the same Friday. Its :61: has no entry date and no // reference (both optional).
  const res = importText(t, mt940({ ref: 'E2C-TU2', number: 80, open: '261005', close: '261006', lines: [{ line: '261002D4,50NMSCNONREF', info: 'Kaffeebar Seeblick, Kauf 02.10. 16:40' }] }));
  assert.equal(lines(t).length, 2, `the Tuesday coffee is a second movement, got ${lines(t).length}; skipped ${JSON.stringify(res.skipped)}`);
});
