// A41.3 re-cut v2 (D184): with rules.autobook_requires_beleg = on, a granted Buchungsregel books a line that
// expects a receipt ONLY with the line's ASSIGNED receipt (beleg_assignment, the one input the verdict reads),
// attached inside the booking's own transaction, through N04's one chokepoint. The engine assigns a receipt
// group on its own only when it fits exactly one line and that line exactly one group, over trusted figures
// (belege.autobook_figure_trust = confirmed: a person's "Zahlen bestätigen" or a person-brought QR code).
//
// MONEY-PATH INVARIANTS (drafted by the author, for the non-author critic to confirm they bite), each named in
// its test title:
//   I1 idempotent on ROWS: a second tick books, links, settles and assigns nothing a second time; a receipt
//      that fits two lines is assigned to neither;
//   I2 append-only: a waiting line writes no run row, and no run row is ever rewritten;
//   I3 §H-TENANT: another workspace's receipt never assigns or books this workspace's line;
//   I4 no partial state: an attach refused inside the booking rolls the whole booking back, the assignment
//      stays active, and the line waits (beleg_in_use) instead of being refused for good.
//
// PREMISES THE RE-CUT CHANGED (named so the critic can check the rewrite): the waiting reasons several_belege
// and beleg_ambiguous are gone (the verdict reads no pool, so it cannot tell how many receipts fit; a line the
// engine could not pair uniquely simply has no assignment: no_beleg); a receipt filed with files_link is NOT
// an assignment (only assign_beleg is), and the receipts these tests capture are agent-read, so a person
// confirms their figures first (I-F).
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates (n04-autobook-support.mjs,
// a41-beleg-support.mjs).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { grantRuleAutobook, autobookDigest, runAutobookStep } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { getFileContent, uploadFile, linkFile } from '../../dist/core/files/index.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { must, assertClaimInvariantHolds, secondWorkspace } from './bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, runs, decisionOf, at, entryCount, proposalOf, TELCO } from './n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg, assignmentsOf, activeOf, seenOf } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';

/** A granted rule (3 clean uses by a person), the receipt rule switched on, the clock moved on. */
function granted(opts = {}) {
  const t = ruleWorld(opts);
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  const g = must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-1' }), 'grant').grant;
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'A41 test', idempotencyKey: 'rb-on' }));
  at(t, LATER);
  return { ...t, grantId: g.grantId, ap: autopilot(t) };
}

const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const shiftOf = (t, line) => (n) => new Date(Date.parse(`${dateOf(t, line)}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const telcoReceipt = (t, line, amount, extra = {}) => confirmedReceipt(t, { amount, vendor: TELCO, date: dateOf(t, line), ...extra });
const filesOnLine = (t, line) => t.store.db.prepare("SELECT id, sha256 FROM stored_file WHERE workspace_id = ? AND entity_kind = 'bank_txn' AND entity_id = ? ORDER BY rowid").all(t.workspaceId, line);
const captureStatus = (t, captureId) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(captureId).status;
const settlements = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_settlement WHERE workspace_id = ?').get(t.workspaceId).n;
const assignmentRows = (t) => t.store.db.prepare('SELECT COUNT(*) AS n FROM beleg_assignment WHERE workspace_id = ?').get(t.workspaceId).n;
const waitingOf = (t, ctx = t.ctx) => must(autobookDigest(ctx, {})).waitingForBeleg.map((w) => [w.bankTxnId, w.reason]);
const system = (t) => makeContext(t.store, { workspaceId: t.workspaceId, actor: 'system', clock: t.clock, ids: t.ids });

test('I1 idempotent on ROWS: one fitting receipt is assigned, the line books WITH it, and a second tick changes nothing', () => {
  const t = granted();
  const [line] = debits(t, [1400]);
  const r = telcoReceipt(t, line, 1400);
  t.ap.tick();
  const decision = decisionOf(t, line);
  assert.equal(decision?.state, 'booked', 'the line is booked');
  assert.equal(decision.channel, `autobook:${t.ruleId}`, 'through N04, named as automatic');
  const attached = filesOnLine(t, line);
  assert.equal(attached.length, 1, 'its receipt is on the line');
  assert.equal(attached[0].sha256, t.store.db.prepare('SELECT sha256 FROM stored_file WHERE id = ?').get(r.fileId).sha256);
  assert.equal(captureStatus(t, r.captureId), 'committed', 'the capture left Belege ohne Buchung');
  const rows = assignmentsOf(t, line);
  assert.deepEqual(rows.map((a) => [a.source, a.state, a.entry_id]), [['engine_unique', 'consumed', decision.entry_id]], 'the engine assigned it, the booking consumed it');
  const before = { entries: entryCount(t), runs: runs(t).length, files: filesOnLine(t, line).length, settled: settlements(t), assignments: assignmentRows(t) };
  t.ap.tick();
  t.ap.tick();
  assert.deepEqual({ entries: entryCount(t), runs: runs(t).length, files: filesOnLine(t, line).length, settled: settlements(t), assignments: assignmentRows(t) }, before);
});

test('I2 append-only: no receipt, the line WAITS (no run row, digest "wartet auf Beleg"), and books once one arrives', () => {
  const t = granted();
  const [line] = debits(t, [1450]);
  const entries = entryCount(t);
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'not booked');
  assert.equal(runs(t).filter((r) => r.bank_txn_id === line).length, 0, 'a wait is never recorded: a run row is final');
  assert.equal(entryCount(t), entries);
  const digest = must(autobookDigest(t.ctx, {}));
  assert.deepEqual(digest.waitingForBeleg.map((w) => [w.bankTxnId, w.reason, w.amountMinor]), [[line, 'no_beleg', 1450]]);
  const rowsBefore = runs(t);
  telcoReceipt(t, line, 1450);
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked');
  assert.equal(filesOnLine(t, line).length, 1);
  assert.deepEqual(runs(t).slice(0, rowsBefore.length), rowsBefore, 'earlier run rows are untouched');
  assert.deepEqual(must(autobookDigest(t.ctx, {})).waitingForBeleg, []);
});

test('two fitting receipt groups: nothing is assigned and the line waits (no_beleg); off: it books without a receipt as before', () => {
  const t = granted();
  const [line] = debits(t, [1500]);
  // Two groups: the same amount from the same vendor, each within the window of the line (4 days before and
  // 4 days after) but 8 days apart from each other, so they are not one invoice-and-receipt pair.
  const shift = shiftOf(t, line);
  confirmedReceipt(t, { amount: 1500, vendor: TELCO, date: shift(-4) });
  confirmedReceipt(t, { amount: 1500, vendor: TELCO, date: shift(4) });
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  assert.deepEqual(assignmentsOf(t, line), [], 'two groups fit: the engine assigns neither');
  assert.deepEqual(waitingOf(t), [[line, 'no_beleg']]);
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'off', reason: 'A41 test', idempotencyKey: 'rb-off' }));
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked');
  assert.equal(filesOnLine(t, line).length, 0, 'off books exactly as N04 did: no receipt is attached');
});

test('the assigned receipt\'s VAT beyond the tolerance makes the line wait (beleg_vat_differs)', () => {
  const t = granted({ taxCode: 'VST-M' });
  // CHF 10.81 at 8.1 %: the engine computes 0.81; a receipt printing 0.70 is 11 Rappen off.
  const [line] = debits(t, [1081]);
  telcoReceipt(t, line, 1081, { vat: 70 });
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  assert.equal(activeOf(t, line)?.source, 'engine_unique', 'the receipt is the line\'s; its VAT holds the booking');
  assert.deepEqual(waitingOf(t), [[line, 'beleg_vat_differs']]);
});

test('I3 §H-TENANT: a fitting receipt in ANOTHER workspace never assigns or books this workspace\'s line', () => {
  const t = granted();
  const b = secondWorkspace(t);
  const [line] = debits(t, [1550]);
  const r = receipt(t, { amount: 1550, vendor: TELCO, date: dateOf(t, line), ctx: b.ctx });
  // Its own workspace's person confirms it (as they may): it still belongs to that workspace only.
  must(getAction('confirm_capture_figures').run({ ...t.deps, actor: 'user_1' }, { workspaceId: b.workspaceId, captures: [seenOf(t, r.captureId, b.ctx)], idempotencyKey: 'i3-conf' }));
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  assert.deepEqual(assignmentsOf(t, line), []);
  assert.deepEqual(waitingOf(t), [[line, 'no_beleg']]);
  // And this workspace's person cannot assign another workspace's file to its line.
  const res = assignBeleg(t, line, [r.fileId]);
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
});

test('I4 no partial state: an attach the receipt guard refuses inside the booking rolls the booking back', () => {
  const t = granted();
  const [line] = debits(t, [1600]);
  const r = telcoReceipt(t, line, 1600);
  // The engine assigns first (one pass, its own transaction).
  reconcileEngineAssignments(system(t), STATEMENT_COVERS_SQL);
  const assignment = activeOf(t, line);
  assert.equal(assignment?.source, 'engine_unique');
  const before = { entries: entryCount(t), files: t.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n };
  // Between the verdict and the link, the same bytes start evidencing another live booking (a posted entry):
  // the guard refuses the receipt inside book_bank_line's transaction.
  const book = (actor, input) => {
    const content = must(getFileContent(t.ctx, { fileId: r.fileId }));
    const twin = must(uploadFile(t.ctx, { contentBase64: content.contentBase64, mime: 'image/png', filename: 'zwilling.png', title: 'Zwilling' })).file.id;
    const entry = must(postEntry(t.ctx, { date: '2026-02-02', source: 'manual', description: 'Zwilling', idempotencyKey: 'twin-entry', lines: [{ account: t.acc('6570'), debit: 500 }, { account: t.acc('1020'), credit: 500 }] })).entryId;
    must(linkFile(t.ctx, { fileId: twin, entityKind: 'journal_entry', entityId: entry }));
    return getAction('book_bank_line').run({ ...t.deps, actor }, input);
  };
  const report = runAutobookStep(system(t), { holdsPost: () => true, book });
  assert.deepEqual(report.booked, []);
  assert.deepEqual(report.notBooked, [], 'a receipt taken meanwhile is never a final refusal');
  assert.deepEqual(report.waiting.map((w) => [w.bankTxnId, w.reason]), [[line, 'beleg_in_use']], 'the line waits for its receipt');
  assert.equal(runs(t).filter((x) => x.bank_txn_id === line).length, 0, 'no run row: it books on a later tick');
  assert.equal(decisionOf(t, line), undefined, 'no decision');
  assert.equal(entryCount(t), before.entries, 'no entry: neither the booking nor anything written beside it');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n, before.files, 'no filing row survived');
  assert.equal(filesOnLine(t, line).length, 0);
  assert.equal(captureStatus(t, r.captureId), 'needs_review', 'the capture still waits');
  assert.equal(activeOf(t, line)?.id, assignment.id, 'the assignment was not consumed: the consumption rolled back with the booking');
});

test('I1 one receipt, two lines in one tick: exactly one in BOTH directions, so neither is assigned or tried; a re-run changes nothing', () => {
  const t = granted();
  const [a, b] = debits(t, [1700, 1700]);
  // One receipt within the window of both lines (they lie 5 days apart): it fits both.
  const r = confirmedReceipt(t, { amount: 1700, vendor: TELCO, date: shiftOf(t, a)(2) });
  const sha = t.store.db.prepare('SELECT sha256 FROM stored_file WHERE id = ?').get(r.fileId).sha256;
  const calls = [];
  const step = () => runAutobookStep(system(t), { holdsPost: () => true, book: (actor, input) => (calls.push(input.bankTxnId), getAction('book_bank_line').run({ ...t.deps, actor }, input)) });
  const report = step();
  assert.deepEqual(calls, [], 'a receipt that fits two lines is booked with neither');
  assert.deepEqual(report.assignments.created, [], 'and assigned to neither');
  assert.deepEqual(report.waiting.map((w) => [w.bankTxnId, w.reason]).sort(), [[a, 'no_beleg'], [b, 'no_beleg']].sort());
  const links = () => t.store.db.prepare("SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND sha256 = ? AND entity_kind = 'bank_txn'").get(t.workspaceId, sha).n;
  assert.equal(links(), 0);
  assert.equal(runs(t).filter((x) => x.bank_txn_id === a || x.bank_txn_id === b).length, 0, 'waiting lines are unrecorded');
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
  const before = { entries: entryCount(t), runs: runs(t).length, links: links(), assignments: assignmentRows(t) };
  step();
  assert.deepEqual(calls, []);
  assert.deepEqual({ entries: entryCount(t), runs: runs(t).length, links: links(), assignments: assignmentRows(t) }, before, 'a re-run changes nothing');
  // A person books one line with the receipt: the other then waits for its own, and the receipt is linked once.
  must(getAction('book_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: a, target: proposalOf(t, a).target, attach: [{ fileId: r.fileId }], idempotencyKey: 'person-a' }));
  step();
  assert.deepEqual(calls, []);
  assert.equal(links(), 1, 'the receipt evidences one bank line');
  assert.deepEqual(waitingOf(t), [[b, 'no_beleg']]);
});

test('critic r2 R1 (re-cut): ambiguous, then a person ASSIGNS the receipt to one open line: the next tick books that line with it, the other waits; a re-run changes nothing', () => {
  const t = granted();
  const [a, b] = debits(t, [1750, 1750]);
  const r = receipt(t, { amount: 1750, vendor: TELCO, date: shiftOf(t, a)(2) });
  t.ap.tick();
  assert.deepEqual(waitingOf(t).map(([, reason]) => reason), ['no_beleg', 'no_beleg']);
  // "Anhängen" on line a (assign_beleg): the capture stays pending, the line carries it. A person assigns
  // agent-read figures too: the person looked (I-F binds only the engine's own pairing).
  const assigned = must(assignBeleg(t, a, [r.fileId]));
  assert.equal(assigned.alreadyAssigned, false);
  assert.equal(captureStatus(t, r.captureId), 'needs_review');
  assert.deepEqual(filesOnLine(t, a).map((f) => f.id), [r.fileId], 'filed on the open line');
  t.ap.tick();
  assert.equal(decisionOf(t, a)?.state, 'booked', 'the line carrying its receipt books');
  assert.equal(decisionOf(t, a).channel, `autobook:${t.ruleId}`);
  assert.deepEqual(filesOnLine(t, a).map((f) => f.id), [r.fileId], 'the receipt the person filed, not a second row');
  assert.equal(captureStatus(t, r.captureId), 'committed', 'the booking closed the capture in its own transaction');
  assert.deepEqual(assignmentsOf(t, a).map((x) => [x.source, x.state]), [['person', 'consumed']]);
  assert.equal(decisionOf(t, b), undefined);
  assert.deepEqual(waitingOf(t), [[b, 'no_beleg']]);
  const before = { entries: entryCount(t), runs: runs(t).length, files: filesOnLine(t, a).length, settled: settlements(t), assignments: assignmentRows(t) };
  t.ap.tick();
  assert.deepEqual({ entries: entryCount(t), runs: runs(t).length, files: filesOnLine(t, a).length, settled: settlements(t), assignments: assignmentRows(t) }, before);
});

test('files_link NEVER creates an assignment: a receipt a person filed on the open line with files_link leaves the line waiting', () => {
  const t = granted();
  const [line] = debits(t, [1780]);
  const r = telcoReceipt(t, line, 1780);
  must(getAction('files_link').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: 'fl-1' }));
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], 'a filing is not an assignment (and the filed document left the pool)');
  assert.equal(decisionOf(t, line), undefined);
  assert.deepEqual(waitingOf(t), [[line, 'no_beleg']]);
});

test('critic r2 R1: a receipt a person assigned still has to fit the line: another amount waits beleg_amount_differs', () => {
  const t = granted();
  const [line] = debits(t, [1760]);
  const r = receipt(t, { amount: 9760, vendor: TELCO, date: dateOf(t, line) });
  must(assignBeleg(t, line, [r.fileId]));
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  assert.deepEqual(waitingOf(t), [[line, 'beleg_amount_differs']]);
});

test('the engine pass is its own: reconcile run twice in a row assigns once (idempotent on rows)', () => {
  const t = granted();
  const [line] = debits(t, [1790]);
  telcoReceipt(t, line, 1790);
  const first = reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  const second = reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(first.created.length, 1);
  assert.deepEqual(second, { created: [], released: [] });
  assert.equal(assignmentsOf(t, line).length, 1);
});
