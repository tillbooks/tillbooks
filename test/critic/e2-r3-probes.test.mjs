// CRITIC PROBES, D178 node E2 round 3 (non-author), against the OWNER's decision (D178 point 19): every
// possible duplicate is imported FLAGGED, a flagged line is not bookable until the person answers
// (`resolve_possible_duplicate`), and only the same format's exact key drops a line.
//
// Each probe asserts the CORRECT outcome; a failing probe is the evidence of a defect (see
// docs/critique/bank-parity-e2-critic-r3.md). Sound checks are marked as such.
//
// SYNTHETIC BY CONSTRUCTION: every statement, name, reference and amount below is invented in this file;
// the IBAN is the published PostFinance sample the A39 suites already use.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { importCamt, listBankInbox, confirmCamtMatch, createEntryForTxn } from '../../dist/core/banking/index.js';
import { importBankStatement } from '../../dist/core/banking/statementImport.js';
import { resolvePossibleDuplicate } from '../../dist/core/banking/duplicateDecision.js';
import { bookBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { world, must, camt, postedBill, secondWorkspace, MAIN_IBAN } from '../banking/bank-inbox-support.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

let n = 0;
const key = () => `e2r3-${(n += 1)}`;

/** Every line of the world with its flag. */
function lines(t) {
  return t.store.db
    .prepare(
      `SELECT t.id, t.amount_minor AS a, t.credit_debit AS cd, t.booking_date AS b, s.message_type AS f, s.statement_id AS sid, p.existing_bank_txn_id AS dupOf, p.reason AS why
         FROM bank_txn t JOIN bank_statement s ON s.id = t.statement_id
         LEFT JOIN bank_txn_possible_duplicate p ON p.workspace_id = t.workspace_id AND p.bank_txn_id = t.id
        WHERE t.workspace_id = ? ORDER BY t.rowid`,
    )
    .all(t.workspaceId);
}

const withAsr = (xml) => xml.replace(/<NtryRef>([^<]+)<\/NtryRef>([\s\S]*?<\/ValDt>)/g, '<NtryRef>$1</NtryRef>$2<AcctSvcrRef>$1</AcctSvcrRef>');

function mt940({ ref, number, page = 1, last = true, open = '261004', close = '261005', body }) {
  return [`:20:${ref}`, `:25:${MAIN_IBAN}`, `:28C:${number}/${page}`, `${page === 1 ? ':60F:' : ':60M:'}C${open}CHF1000,00`, ...body, `${last ? ':62F:' : ':62M:'}C${close}CHF900,00`, '-'].join('\n');
}

const importText = (t, content, extra = {}) => must(importBankStatement(t.ctx, { bankAccountId: t.bankAccountId, content, idempotencyKey: key(), ...extra }), 'import_bank_statement');
const csvMapping = { columns: { bookingDate: 'Datum', text: 'Text', amount: 'Betrag' }, dateFormat: 'dd.mm.yyyy', decimalSeparator: '.' };

/** A debit of CHF 500 by CSV, then the same by camt the same day: the camt line is flagged. Its id. */
function flaggedDebit(t, amountMinor = 50000) {
  importText(t, `Datum;Text;Betrag\n05.10.2026;Druckerei Tannenbach;-${(amountMinor / 100).toFixed(2)}\n`, { mapping: csvMapping });
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: withAsr(camt({ statementId: `R3-CAMT-${key()}`, from: '2026-10-05', to: '2026-10-05', entries: [{ ref: `R3-ASR-${key()}`, amountMinor, cd: 'DBIT', date: '2026-10-05', name: 'Druckerei Tannenbach AG' }] })),
      idempotencyKey: key(),
    }),
  );
  const flagged = lines(t).find((l) => l.dupOf !== null);
  assert.ok(flagged !== undefined, 'the camt line is flagged');
  return flagged.id;
}

// --- R3-1: confirm_match's multi-bill split books a flagged line without the person's answer ----------

test('R3-1: a flagged line is not bookable by ANY path: confirm_match with allocations refuses duplicate_decision_pending', () => {
  const t = world();
  const { vendorBillId } = postedBill(t, { grossMinor: 50000, seed: 'r3-1' });
  const flagged = flaggedDebit(t);
  // The single-bill path goes through performBooking and refuses (sound):
  const single = confirmCamtMatch(t.ctx, { bankTxnId: flagged, vendorBillId, idempotencyKey: key() });
  assert.equal(single.error, 'duplicate_decision_pending', JSON.stringify(single));
  const entry = createEntryForTxn(t.ctx, { bankTxnId: flagged, contraAccountId: t.acc('6500'), idempotencyKey: key() });
  assert.equal(entry.error, 'duplicate_decision_pending', JSON.stringify(entry));
  // The multi-bill split (US-A20.5) writes its payment and line link itself:
  const split = confirmCamtMatch(t.ctx, { bankTxnId: flagged, allocations: [{ vendorBillId, amountMinor: 50000 }], idempotencyKey: key() });
  assert.equal(split.ok, false, `the flagged line was settled without a decision: ${JSON.stringify(split)}`);
  assert.equal(split.error, 'duplicate_decision_pending');
});

// --- R3-2: an MT940 delivered again under ANOTHER statement number double counts silently -------------

test('R3-2: the same days as an ad-hoc MT940 export (another :28C: number, one statement) never import an unreferenced line silently twice', () => {
  const t = world();
  // Datalink: two day statements, lines without a // reference (61-8 is optional).
  importText(t, mt940({ ref: 'R3-2-41', number: 41, open: '261004', close: '261005', body: [':61:2610051005D4,50NMSCNONREF', ':86:Kaffeebar Seeblick'] }));
  importText(t, mt940({ ref: 'R3-2-42', number: 42, open: '261005', close: '261006', body: [':61:2610061006D120,00NTRFNONREF', ':86:Druckerei Lindenhof Rechnung 2026-118'] }));
  // The person downloads the same two days from e-banking: one ad-hoc statement, numbered 1.
  const res = importText(t, mt940({ ref: 'R3-2-EB', number: 1, open: '261004', close: '261006', body: [
    ':61:2610051005D4,50NMSCNONREF', ':86:Kaffeebar Seeblick',
    ':61:2610061006D120,00NTRFNONREF', ':86:Druckerei Lindenhof Rechnung 2026-118',
  ] }));
  const all = lines(t);
  const silent = all.filter((l) => l.sid === 'mt940:1:2026-10-06' && l.dupOf === null);
  assert.equal(
    silent.length,
    0,
    `${silent.length} of the export's lines are new, unflagged copies of lines already in the books: ${JSON.stringify(all)}; warnings ${JSON.stringify(res.statements.map((s) => s.warnings))}`,
  );
});

// --- R3-3: a re-delivered page's line that matches nothing imports plain (the author's stated gap) ----

test('R3-3: a line on a re-delivered page of a complete statement never imports as a plain, bookable line', () => {
  const t = world();
  // Statement 98 complete in the books: page 1 (a coffee) and page 2, the last (a print bill).
  importText(t, `${mt940({ ref: 'R3-3-P1', number: 98, page: 1, last: false, body: [':61:2610051005D4,50NMSCNONREF', ':86:Kaffeebar Seeblick'] })}\n${mt940({ ref: 'R3-3-P2', number: 98, page: 2, open: '261005', body: [':61:2610051005D120,00NTRFNONREF', ':86:Druckerei Lindenhof'] })}`);
  // The bank sends statement 98 again, paged into three: its page 3 carries the print bill CORRECTED to 125.00.
  const res = importText(t, mt940({ ref: 'R3-3-P3', number: 98, page: 3, open: '261005', body: [':61:2610051005D125,00NTRFNONREF', ':86:Druckerei Lindenhof korrigiert'] }));
  // ADAPTED to the E2 re-cut (orchestrator ruling, round 3): the redelivery rule is gone. Statement 98 is
  // complete in the books with its balances, so its day is COVERED; the re-delivered page does not extend
  // the chain, and its corrected line matches no stored movement on that covered day: it is imported
  // FLAGGED `covered_period_new_line` (no stored line to name), and the warning carries that code.
  assert.ok(res.statements[0].warnings.includes('covered_period_new_line'), JSON.stringify(res.statements));
  const corrected = lines(t).find((l) => l.a === 12500);
  const refusedPage = res.statements[0].outcome === 'refused';
  assert.ok(
    refusedPage || (corrected !== undefined && corrected.why !== null),
    `the corrected line of a statement already complete in the books imported as a plain line: ${JSON.stringify(lines(t))}`,
  );
  if (corrected !== undefined && !refusedPage) {
    const line = must(listBankInbox(t.ctx, { bankTxnId: corrected.id, status: 'all' })).lines[0];
    assert.equal(line.needsDuplicateDecision, true);
  }
});

// --- R3-4 (LOW): the Studio's camt toast drops redelivered_statement --------------------------------

// ADAPTED to the E2 re-cut: `redelivered_statement` is gone; the codes the importer now emits are
// `overlap_same_movement` and `covered_period_new_line`. Bank.tsx is N2's (orchestrator ruling, round 3), so
// this probe stays a todo on E2's branch and turns green when N2 words both codes.
test('R3-4: Bank.tsx words the coverage codes (overlap_same_movement, covered_period_new_line)', { todo: 'N2 owns KNOWN_WARNINGS in Bank.tsx (orchestrator ruling, round 3)' }, () => {
  const bank = readFileSync(join(ROOT, 'app', 'src', 'surfaces', 'Bank', 'Bank.tsx'), 'utf8');
  const known = /const KNOWN_WARNINGS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\)/.exec(bank);
  assert.ok(known !== null);
  for (const code of ['overlap_same_movement', 'covered_period_new_line']) assert.ok(known[1].includes(`'${code}'`), `Bank.tsx onImported drops ${code}: ${known[1]}`);
});

// --- R3-5 (LOW): the decision history is append-only by convention only ------------------------------

test('R3-5: bank_txn_duplicate_decision refuses UPDATE and DELETE (append-only, like bank_statement_gap_ack)', () => {
  const t = world();
  const flagged = flaggedDebit(t, 3300);
  must(resolvePossibleDuplicate(t.ctx, { bankTxnId: flagged, decision: 'distinct', idempotencyKey: key() }), 'distinct');
  assert.throws(() => t.store.db.prepare("UPDATE bank_txn_duplicate_decision SET decision = 'duplicate' WHERE workspace_id = ?").run(t.workspaceId), /never|append|ABORT|constraint/i, 'an answer can be rewritten in place');
  assert.throws(() => t.store.db.prepare('DELETE FROM bank_txn_duplicate_decision WHERE workspace_id = ?').run(t.workspaceId), /never|append|ABORT|constraint/i, 'an answer can be deleted');
});

// --- Sound checks of the new verb --------------------------------------------------------------------

test('R3-S1 (sound check): resolve_possible_duplicate keeps every answer (the latest in force), is idempotent on rows, reopenable, tenant-bound, and a re-import never touches it', () => {
  const t = world();
  const flagged = flaggedDebit(t, 12000);
  const decisions = () => t.store.db.prepare('SELECT decision FROM bank_txn_duplicate_decision WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId).map((r) => r.decision);
  const rowsOf = () => t.store.db.prepare('SELECT (SELECT COUNT(*) FROM bank_txn_duplicate_decision) AS d, (SELECT COUNT(*) FROM bank_line_decision) AS l').get();
  // Duplicate: the line is ignored with that reason; the same call again writes nothing.
  const k = key();
  must(resolvePossibleDuplicate(t.ctx, { bankTxnId: flagged, decision: 'duplicate', idempotencyKey: k }), 'duplicate');
  const after = rowsOf();
  must(resolvePossibleDuplicate(t.ctx, { bankTxnId: flagged, decision: 'duplicate', idempotencyKey: k }), 'replay');
  assert.deepEqual(rowsOf(), after, 'idempotent on rows');
  // Decided lines refuse a second answer; reopened, the line needs a decision again and stays unbookable.
  assert.equal(resolvePossibleDuplicate(t.ctx, { bankTxnId: flagged, decision: 'distinct', idempotencyKey: key() }).error, 'line_not_open');
  must(reopenBankLine(t.ctx, { bankTxnId: flagged, reason: 'critic probe: decide again', idempotencyKey: key() }), 'reopen');
  let line = must(listBankInbox(t.ctx, { bankTxnId: flagged, status: 'all' })).lines[0];
  assert.equal(line.needsDuplicateDecision, true);
  const target = { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 12000 }] };
  assert.equal(bookBankLine(t.ctx, { bankTxnId: flagged, target, idempotencyKey: key() }).error, 'duplicate_decision_pending');
  // Another workspace can neither read nor answer the line.
  const b = secondWorkspace(t);
  const foreign = resolvePossibleDuplicate(b.ctx, { bankTxnId: flagged, decision: 'distinct', idempotencyKey: key() });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'not_found');
  // Distinct: a normal line, booked once; the history keeps both answers.
  must(resolvePossibleDuplicate(t.ctx, { bankTxnId: flagged, decision: 'distinct', idempotencyKey: key() }), 'distinct');
  must(bookBankLine(t.ctx, { bankTxnId: flagged, target, idempotencyKey: key() }), 'book');
  assert.deepEqual(decisions(), ['duplicate', 'distinct']);
  // A re-import of both files changes no decision and no flag.
  const flagsBefore = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_possible_duplicate').get().n;
  importText(t, 'Datum;Text;Betrag\n05.10.2026;Druckerei Tannenbach;-120.00\n', { mapping: csvMapping });
  assert.deepEqual(decisions(), ['duplicate', 'distinct']);
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn_possible_duplicate').get().n, flagsBefore);
  line = must(listBankInbox(t.ctx, { bankTxnId: flagged, status: 'all' })).lines[0];
  assert.equal(line.state, 'booked');
});

test('R3-S2 (sound check): under ask, the same bank reference on the same day is flagged, never dropped; the stored line is never used up', () => {
  const t = world();
  must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: withAsr(camt({ statementId: 'R3-S2', from: '2026-10-05', to: '2026-10-05', entries: [{ ref: 'R3-S2-A', amountMinor: 450, cd: 'DBIT', date: '2026-10-05' }] })), idempotencyKey: key() }));
  const res = importText(t, mt940({ ref: 'R3-S2-M', number: 7, body: [':61:2610051005D4,50NMSCNONREF//R3-S2-A', ':86:Kaffee', ':61:2610051005D4,50NMSCNONREF//R3-S2-B', ':86:Kaffee'] }));
  assert.equal(res.skipped.length, 0);
  const all = lines(t);
  assert.equal(all.length, 3);
  assert.equal(all.filter((l) => l.dupOf !== null).length, 2, 'both MT940 coffees name the one camt coffee');
});
