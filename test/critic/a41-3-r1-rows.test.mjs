// Critic A41.3 r1 (non-author), probe group R: idempotent on ROWS, robust engine pass, and a rollback that
// leaves nothing behind.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates; the QR bill is a hand-written SPC payload
// on the published sample IBAN the N04 support already uses.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { grantRuleAutobook, runAutobookStep } from '../../dist/core/banking/autobook.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { wiredContext } from '../../dist/api/registry.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, entryCount, runs, TELCO, TELCO_IBAN } from '../banking/n04-autobook-support.mjs';
import { confirmedReceipt, assignBeleg, activeOf, assignmentsOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';

function granted(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `grant-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'critic', idempotencyKey: `sc-${tag}` }));
  at(t, LATER);
  return { ...t, ap: autopilot(t) };
}

const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const allRows = (t) => t.store.db.prepare('SELECT id, state, release_reason FROM beleg_assignment WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);
const allFileRows = (t) => t.store.db.prepare('SELECT assignment_id, file_id, active FROM beleg_assignment_file WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);

const spc = (amount, message) =>
  [
    'SPC', '0200', '1', TELCO_IBAN,
    'S', TELCO, 'Musterweg', '7', '8000', 'Zürich', 'CH',
    '', '', '', '', '', '', '',
    (amount / 100).toFixed(2), 'CHF',
    '', '', '', '', '', '', '',
    'NON', '', message, 'EPD',
  ].join('\n');

const personCapture = (t, bytes, k) =>
  must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: bytes, mime: 'application/pdf', filename: `${k}.pdf`, idempotencyKey: k }));

test('R1 (held): an engine pair that still stands is neither released nor re-created by later passes; the booked line books once', () => {
  const t = granted('r1');
  const [line] = debits(t, [90000], { from: '2026-07-19' });
  confirmedReceipt(t, { amount: 90000, vendor: TELCO, date: dateOf(t, line) });
  // Over the ceiling: the rule never books it, so the standing assignment is what the passes see.
  for (let i = 0; i < 3; i++) t.ap.tick();
  const again = reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.deepEqual(again, { created: [], released: [] }, 'an unchanged world moves no row');
  assert.deepEqual(allRows(t).map((r) => r.state), ['active'], 'one row, never churned');
  // A bookable line (its own world: a refused over-ceiling line makes the rule's later proposals unsure):
  // three ticks, one entry, one consumed row, one run row.
  const u = granted('r1b');
  const [small] = debits(u, [1640], { from: '2026-07-19' });
  confirmedReceipt(u, { amount: 1640, vendor: TELCO, date: dateOf(u, small) });
  checkBooksOnce(u, small);
});

function checkBooksOnce(t, small) {
  const before = entryCount(t);
  for (let i = 0; i < 3; i++) t.ap.tick();
  assert.equal(decisionOf(t, small)?.state, 'booked', JSON.stringify({ runs: runs(t), rows: assignmentsOf(t, small) }));
  assert.equal(entryCount(t), before + 1);
  assert.deepEqual(assignmentsOf(t, small).map((a) => a.state), ['consumed']);
  assert.equal(runs(t).filter((r) => r.bank_txn_id === small).length, 1);
}

test('R2: a person-assigned receipt discarded and re-dropped (the documented recovery) crashes the engine pass, and every other line of the workspace stops autobooking', () => {
  const t = granted('r2');
  const [old] = debits(t, [1650], { from: '2026-04-01' });
  const [fits] = debits(t, [1650], { from: '2026-07-19' });
  // Author, r1 fix: a later day than the line that fits, so the two lines of one counterparty are no possible
  // duplicate of each other (N04's proposal for a same-day pair is only `not_sure`, which no fix here changes).
  const [other] = debits(t, [1660], { from: '2026-07-24' });
  // An unrelated line with its own trusted receipt: it must keep booking whatever happens to the others.
  confirmedReceipt(t, { amount: 1660, vendor: TELCO, date: dateOf(t, other) });
  const bytes = Buffer.from(spc(1650, 'Rechnung Juli'), 'utf8').toString('base64');
  const first = personCapture(t, bytes, 'r2-a');
  const fileOf = (captureId) => t.store.db.prepare('SELECT document_id FROM captures WHERE id = ?').get(captureId).document_id;
  // A person assigns the receipt to the old line (no rule books that line yet: it is out of the window).
  must(assignBeleg(t, old, [fileOf(first.captureId)]));
  assert.equal(activeOf(t, old)?.source, 'person');
  // The person discards the capture by mistake, then drops the same bytes again: the documented recovery.
  must(getAction('capture_discard').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: first.captureId, reason: 'versehen', idempotencyKey: 'r2-d' }));
  const again = personCapture(t, bytes, 'r2-b');
  assert.notEqual(again.captureId, first.captureId, 'precondition: a fresh capture (recovery)');
  let thrown = null;
  try {
    reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  } catch (e) {
    thrown = String(e?.message ?? e);
  }
  // The step itself, as the scheduler runs it.
  let stepThrown = null;
  try {
    runAutobookStep(wiredContext({ ...t.deps, actor: 'system' }, t.workspaceId), { book: (actor, input) => getAction('book_bank_line').run({ ...t.deps, actor }, input), holdsPost: () => true });
  } catch (e) {
    stepThrown = String(e?.message ?? e);
  }
  t.ap.tick();
  assert.deepEqual(
    { pass: thrown, step: stepThrown, otherLine: decisionOf(t, other)?.state ?? null },
    { pass: null, step: null, otherLine: 'booked' },
    'the engine pass must not throw a raw constraint error, and an unrelated line with its own receipt must still book',
  );
});

test('R3 (held): a booking that throws inside the step rolls back the consumption, the attach and the capture settlement', () => {
  const t = granted('r3');
  const [line] = debits(t, [1670], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1670, vendor: TELCO, date: dateOf(t, line) });
  const realBook = (actor, input) => getAction('book_bank_line').run({ ...t.deps, actor }, input);
  const before = { rows: allRows(t), files: allFileRows(t), entries: entryCount(t) };
  let booked = 0;
  assert.throws(
    () =>
      runAutobookStep(wiredContext({ ...t.deps, actor: 'system' }, t.workspaceId), {
        book: (actor, input) => {
          const res = realBook(actor, input);
          assert.equal(res.ok, true, JSON.stringify(res));
          booked += 1;
          throw new Error('crash after the booking, inside its transaction');
        },
        holdsPost: () => true,
      }),
    /crash after the booking/,
  );
  assert.equal(booked, 1, 'precondition: the real booking ran before the crash');
  void before;
  assert.equal(entryCount(t), before.entries, 'no entry survives');
  assert.equal(decisionOf(t, line), undefined, 'no decision survives');
  assert.deepEqual(assignmentsOf(t, line).map((a) => a.state), ['active'], 'the assignment is active again, never consumed');
  assert.equal(t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(r.captureId).status, 'needs_review', 'the capture is back under review');
  assert.equal(t.store.db.prepare('SELECT entity_kind FROM stored_file WHERE id = ?').get(r.fileId).entity_kind, null, 'the receipt is not filed');
});
