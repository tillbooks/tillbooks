// Critic A41.3 r2 (non-author), probe group F: the one engine field set, the confirmation of what a person
// SAW, the QR intake-day dating, and the probes the r1 rewrites weakened (D3 tenant with a REAL expected,
// and B2's M10 bite, which the new discard release no longer reaches).
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates; the QR bill is a hand-written SPC payload on
// the published sample IBAN the N04 support already uses.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { confirmCaptureFigures, confirmableStateOf } from '../../dist/core/banking/belegAssignment.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO, TELCO_IBAN } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg, assignmentsOf, verb } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

function granted(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `grant-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: `rb-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'critic', idempotencyKey: `sc-${tag}` }));
  at(t, '2026-07-20T08:00:00.000Z');
  return { ...t, ap: autopilot(t) };
}
const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const agentEdit = (t, captureId, fields, k) =>
  must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId, source: 'agent', fields, idempotencyKey: k }));
const spc = (amount, message) =>
  [
    'SPC', '0200', '1', TELCO_IBAN,
    'S', TELCO, 'Musterweg', '7', '8000', 'Zürich', 'CH',
    '', '', '', '', '', '', '',
    (amount / 100).toFixed(2), 'CHF',
    '', '', '', '', '', '', '',
    'NON', '', message, 'EPD',
  ].join('\n');
const personQr = (t, amount, message, k) =>
  must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from(spc(amount, message), 'utf8').toString('base64'), mime: 'application/pdf', filename: `${k}.pdf`, idempotencyKey: k }));
const getCapture = (t, captureId) => must(getAction('get_capture').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId })).capture;

test('F1 (held, TOCTOU): the person reads get_capture, the agent re-dates the receipt, the person\'s click is refused figures_changed and nothing is trusted', () => {
  const t = granted('f1');
  const [line] = debits(t, [1580], { from: '2026-07-19' });
  const r = receipt(t, { amount: 1580, vendor: TELCO, date: '2026-05-01' });
  const seen = getCapture(t, r.captureId);
  agentEdit(t, r.captureId, [{ key: 'invoice_date', value: dateOf(t, line), confidence: 'high' }], 'f1-x');
  const res = verb(t, 'confirm_capture_figures', { captures: [{ captureId: r.captureId, expected: { sha256: seen.sha256, fields: seen.engineFields } }] });
  assert.equal(res.error, 'figures_changed', JSON.stringify(res));
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined);
  // Control: confirming exactly what get_capture answers NOW works (the read and the check agree).
  const now = getCapture(t, r.captureId);
  must(verb(t, 'confirm_capture_figures', { captures: [{ captureId: r.captureId, expected: { sha256: now.sha256, fields: now.engineFields } }] }));
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked');
});

test('F2 (held): an agent cannot move a person-brought QR receipt\'s intake day by discarding and re-dropping its bytes', () => {
  const t = granted('f2');
  const bytes = Buffer.from(spc(2220, 'Rechnung'), 'utf8').toString('base64');
  const mine = personQr(t, 2220, 'Rechnung', 'f2-in');
  void mine;
  // Later, the line it would fit only from a new intake day.
  at(t, '2026-09-10T08:00:00.000Z');
  const [line] = debits(t, [2220], { from: '2026-09-09' });
  must(getAction('capture_discard').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId: mine.captureId, reason: 'x', idempotencyKey: 'f2-d' }));
  const again = must(getAction('capture_document').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, contentBase64: bytes, mime: 'application/pdf', filename: 'again.pdf', idempotencyKey: 'f2-re' }));
  assert.equal(t.store.db.prepare('SELECT intake_seat FROM captures WHERE id = ?').get(again.captureId).intake_seat, 'machine');
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), []);
  assert.equal(decisionOf(t, line), undefined);
});

test('F3 (I-F, QR intake-day dating): a person scans June\'s QR bill of a monthly subscription late; dated by its intake day it pairs with JULY\'s line, which books unattended with June\'s Beleg', () => {
  const t = granted('f3');
  // June's line: booked by a person, its receipt still to come.
  const [june] = debits(t, [1590], { from: '2026-06-19' });
  bookAsProposed(t, june);
  const [july] = debits(t, [1590], { from: '2026-07-19' });
  // 20 July: the person catches up on the paper stack and drops June's bill (a QR bill carries no date).
  personQr(t, 1590, 'Abo Juni 2026', 'f3-june');
  t.ap.tick();
  const julyRows = assignmentsOf(t, july).map((a) => [a.source, a.state]);
  assert.deepEqual(
    { july: decisionOf(t, july)?.state ?? null, rows: julyRows },
    { july: null, rows: [] },
    'an undated receipt (its only date is when it was scanned) must not uniquely back an unattended booking of a recurring amount',
  );
});

test('F4 (held, D3 strengthened): another workspace sending the REAL expected state of this workspace\'s capture is refused not_found', () => {
  const t = granted('f4');
  const r = receipt(t, { amount: 2240, vendor: TELCO, date: '2026-05-01' });
  const b = secondWorkspace(t);
  const bCtx = makeContext(t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids });
  const res = confirmCaptureFigures(bCtx, { captures: [{ captureId: r.captureId, expected: confirmableStateOf(t.ctx, r.captureId) }], idempotencyKey: 'f4-c' });
  assert.equal(res.error, 'not_found');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_figure_confirmation WHERE capture_id = ?').get(r.captureId).n, 0);
});

test('F5 (held, M10 bite): a person-assigned receipt whose file gets a new version waits beleg_changed; nothing books', () => {
  const t = granted('f5');
  const [line] = debits(t, [2250], { from: '2026-07-19' });
  const r = receipt(t, { amount: 2250, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, line, [r.fileId]));
  // Author, v3: a person's new version of an ASSIGNED file changes the line's receipt, so under the default
  // belege.assigned_move = refuse it is refused (Lösen first); the receipt-stands re-check this probe bites is
  // reached by direct state setup (the assigned file superseded underneath).
  const v = getAction('files_new_version').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, contentBase64: Buffer.from('other bytes f5').toString('base64'), mime: 'application/pdf', idempotencyKey: 'f5-v' });
  assert.equal(v.error, 'receipt_assigned');
  t.store.db.prepare('UPDATE stored_file SET pending_delete = 1 WHERE id = ?').run(r.fileId);
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the assigned receipt no longer stands');
  assert.deepEqual(assignmentsOf(t, line).map((a) => [a.source, a.state]), [['person', 'active']], 'the engine never releases a person row');
});
