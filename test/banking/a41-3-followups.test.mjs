// A41.3 follow-ups (spec "A41.3 follow-ups (as built)"): `assign_beleg_file`, the drop on an open row captured and
// assigned in one act; the "Neue Version, bitte zuordnen" read field; and the two code-critic LOW notes
// (`remapCopiedWorkspaceIds` limited, `holdersForSeat` aligned with the inbox's two read rights).
//
// Each door is probed the way the r1 to r5 critic probes are: the machine channels (an agent over REST and MCP, a
// plugin running as the person, a person approving an agent's draft) refused with nothing written; I-E (a seat
// without a read right); §H-TENANT; idempotent on ROWS; and the hold plan and the receipt guard each driven so
// that dropping its call turns a probe red (`/scratchpad/mutate-followups.mjs` runs those mutations).
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts, dates and bytes.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { makeContext } from '../../dist/core/context.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { reconcileEngineAssignments, assignBelegFile, DROP_ON_OPEN_LINE_SETTING } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { BANK_LINE_READ_CAPABILITY } from '../../dist/core/banking/belegMatch.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { HOLD_BANK_READ_CAPABILITY, holdersForSeat } from '../../dist/core/files/receiptGuard.js';
import { remapCopiedWorkspaceIds, remapNeverWrites } from '../../dist/core/data/portability.js';
import { getFileContent, linkFile } from '../../dist/core/files/index.js';
import { addFilingRowFor } from '../../dist/core/files/files.js';
import { commitStep } from '../../dist/core/migration/steps.js';
import { settingsSet, getSetting } from '../../dist/core/settings/settings.js';
import { ok, err } from '../../dist/core/result.js';
import { must, secondWorkspace, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO, TELCO_IBAN } from './n04-autobook-support.mjs';
import { receipt, confirmedReceipt, assignBeleg, activeOf, assignmentsOf } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';
let seq = 0;

/** A granted world (rule booked three times, autobook on open lines, receipts required) and one open debit line. */
function world(amount = 2340) {
  seq += 1;
  const tag = `fu${seq}`;
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `grant-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'test', idempotencyKey: `rb-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'test', idempotencyKey: `sc-${tag}` }));
  at(t, LATER);
  const [line] = debits(t, [amount], { from: '2026-07-19' });
  return { t, line, tag, ap: autopilot(t) };
}

const person = (w, name, input) => getAction(name).run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId, ...input });
/** Distinct raw bytes per call: a PNG header and a counter, no QR code, so no amount of their own. */
const raw = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, (n >> 8) & 0xff, n & 0xff, 3, 41, 3]).toString('base64');
let up = 0;
/** The drop's first call (D142): `files_upload` of a raw receipt; answers its file id. */
function upload(w, content = raw((up += 1))) {
  up += 1;
  return must(person(w, 'files_upload', { contentBase64: content, mime: 'image/png', filename: `drop-${up}.png`, title: `Drop ${up}`, idempotencyKey: `${w.tag}-up-${up}` })).file.id;
}
/** A hand-written Swiss QR bill (SPC) payload on the N04 sample IBAN, as the bytes of a PDF. */
const spc = (amount) =>
  Buffer.from(
    ['SPC', '0200', '1', TELCO_IBAN, 'S', TELCO, 'Musterweg', '7', '8000', 'Zürich', 'CH', '', '', '', '', '', '', '', (amount / 100).toFixed(2), 'CHF', '', '', '', '', '', '', '', 'NON', '', `Rechnung ${amount}`, 'EPD'].join('\n'),
    'utf8',
  ).toString('base64');

const agentCtxOf = (w) => makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
const rowsOf = (w, line = w.line) => assignmentsOf(w.t, line).map((a) => [a.source, a.state, a.release_reason]);
const snapshot = (w) => ({
  captures: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ?').get(w.t.workspaceId).n,
  assignments: w.t.store.db.prepare('SELECT id, state, release_reason FROM beleg_assignment WHERE workspace_id = ? ORDER BY rowid').all(w.t.workspaceId),
  links: w.t.store.db.prepare('SELECT id, entity_kind, entity_id FROM stored_file WHERE workspace_id = ? ORDER BY rowid').all(w.t.workspaceId),
  fields: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_fields WHERE workspace_id = ?').get(w.t.workspaceId).n,
  overrides: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM receipt_override WHERE workspace_id = ?').get(w.t.workspaceId).n,
  audit: w.t.store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action IN ('beleg_assign', 'beleg_release', 'intake', 'extract')").get(w.t.workspaceId).n,
  decisions: w.t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_line_decision WHERE workspace_id = ?').get(w.t.workspaceId).n,
});
const filedOn = (w, fileId) => w.t.store.db.prepare('SELECT entity_kind, entity_id FROM stored_file WHERE id = ?').get(fileId);
const captureOf = (w, fileId) => w.t.store.db.prepare('SELECT id, status, intake_seat FROM captures WHERE workspace_id = ? AND document_id = ?').get(w.t.workspaceId, fileId);
const inboxLine = (w, ctx = w.t.ctx, line = w.line) => must(listBankInbox(ctx, { bankTxnId: line, status: 'all' })).lines[0];
let ik = 0;
const drop = (w, fileId, extra = {}, line = w.line) => person(w, 'assign_beleg_file', { bankTxnId: line, fileId, idempotencyKey: `${w.tag}-abf-${(ik += 1)}`, ...extra });

// --- 1. The drop on an open row: filed, captured, assigned, in one act ----------------------------------------------

test('a raw file dropped on an open line is filed, captured and assigned as the person\'s receipt; the line\'s amount is the person\'s; autobook books it', () => {
  const w = world(1250);
  const fileId = upload(w);
  const res = must(drop(w, fileId));
  assert.equal(res.amountFrom, 'line');
  assert.equal(res.notAssigned, null);
  assert.deepEqual(filedOn(w, fileId), { entity_kind: 'bank_txn', entity_id: w.line });
  const cap = captureOf(w, fileId);
  assert.equal(cap.status, 'needs_review', 'the capture stays under review until the booking closes it');
  assert.equal(cap.intake_seat, 'person');
  const amount = w.t.store.db.prepare("SELECT value, provenance FROM capture_fields WHERE capture_id = ? AND key = 'amount' AND superseded = 0").get(cap.id);
  assert.deepEqual([JSON.parse(amount.value).minor, amount.provenance], [1250, 'operator'], 'the drop states the line amount as the person\'s');
  assert.deepEqual(rowsOf(w), [['person', 'active', null]]);
  assert.equal(inboxLine(w).belegAssignment?.source, 'person', 'the row shows "Von dir zugeordnet"');
  w.ap.tick();
  assert.equal(decisionOf(w.t, w.line)?.state, 'booked', `the person's assignment lets the granted rule book the line ${JSON.stringify(must(autobookDigest(w.t.ctx, {})))}`);
  assert.deepEqual(rowsOf(w), [['person', 'consumed', null]]);
});

test('a QR bill whose own amount differs keeps its amount (amountFrom receipt): the verdict waits, nothing books', () => {
  const w = world(1250);
  const fileId = must(person(w, 'files_upload', { contentBase64: spc(1260), mime: 'application/pdf', filename: 'qr.pdf', title: 'QR', idempotencyKey: `${w.tag}-qr` })).file.id;
  const res = must(drop(w, fileId));
  assert.equal(res.amountFrom, 'receipt');
  const a = activeOf(w.t, w.line);
  assert.equal(w.t.store.db.prepare('SELECT amount_minor FROM beleg_assignment_file WHERE assignment_id = ?').get(a.id).amount_minor, 1260);
  w.ap.tick();
  assert.equal(decisionOf(w.t, w.line), undefined, 'a receipt of 12.60 never books a line of 12.50');
  assert.deepEqual(must(autobookDigest(w.t.ctx, {})).waitingForBeleg.filter((x) => x.bankTxnId === w.line).map((x) => x.reason), ['beleg_amount_differs']);
});

test('idempotent on ROWS: the same key replays the answer and writes nothing; a new key answers alreadyAssigned and writes nothing', () => {
  const w = world();
  const fileId = upload(w);
  const input = { bankTxnId: w.line, fileId, idempotencyKey: `${w.tag}-same` };
  const first = must(person(w, 'assign_beleg_file', input));
  const after = snapshot(w);
  assert.deepEqual(must(person(w, 'assign_beleg_file', input)), first);
  assert.deepEqual(snapshot(w), after);
  const again = must(drop(w, fileId));
  assert.equal(again.alreadyAssigned, true);
  assert.equal(again.assignmentId, first.assignmentId);
  assert.deepEqual(snapshot(w), after);
});

// Author, critic r1 F1: a file the D142 path filed BEFORE is no fresh drop, so it never takes the line's amount.
test('a file the D142 path already filed on the open line is captured in place, but only its own amount assigns it (critic r1 F1)', () => {
  const w = world(1250);
  const fileId = upload(w);
  must(person(w, 'files_link', { fileId, entityKind: 'bank_txn', entityId: w.line, idempotencyKey: `${w.tag}-link` }));
  const res = must(drop(w, fileId));
  assert.equal(res.notAssigned, 'beleg_without_amount', 'a raw file filed before states no amount: filed and captured, the line waits');
  assert.deepEqual(rowsOf(w), []);
  assert.equal(captureOf(w, fileId)?.status, 'needs_review');
  const qr = must(person(w, 'files_upload', { contentBase64: spc(1250), mime: 'application/pdf', filename: 'qr.pdf', title: 'QR', idempotencyKey: `${w.tag}-qr` })).file.id;
  const [other] = debits(w.t, [1250], { from: '2026-07-18' });
  must(person(w, 'files_link', { fileId: qr, entityKind: 'bank_txn', entityId: other, idempotencyKey: `${w.tag}-qrl` }));
  assert.equal(must(drop(w, qr, {}, other)).amountFrom, 'receipt', 'a filed QR bill is assigned on its own amount');
  assert.deepEqual(rowsOf(w, other), [['person', 'active', null]]);
});

// --- 2. The setting (D172) -----------------------------------------------------------------------------------------

test('belege.drop_on_open_line: assign by default, human-only; assign_if_stated files and captures without an amount; file only files', () => {
  const w = world();
  assert.equal(getSetting(w.t.ctx, DROP_ON_OPEN_LINE_SETTING), 'assign');
  assert.equal(handleRest('settings_set', { workspaceId: w.t.workspaceId, key: DROP_ON_OPEN_LINE_SETTING, value: 'file', reason: 'x', idempotencyKey: `${w.tag}-ag` }, { ...w.t.deps, actor: 'agent' }).body.error, 'human_only');
  must(settingsSet(w.t.ctx, { key: DROP_ON_OPEN_LINE_SETTING, value: 'assign_if_stated', reason: 'test', idempotencyKey: `${w.tag}-s1` }));
  const unstated = upload(w);
  const r1 = must(drop(w, unstated));
  assert.equal(r1.notAssigned, 'beleg_without_amount');
  assert.equal(r1.assignmentId, null);
  assert.deepEqual(filedOn(w, unstated), { entity_kind: 'bank_txn', entity_id: w.line });
  assert.equal(captureOf(w, unstated)?.status, 'needs_review');
  assert.deepEqual(rowsOf(w), []);
  const [other] = debits(w.t, [2350], { from: '2026-07-18' });
  const stated = must(person(w, 'files_upload', { contentBase64: spc(2350), mime: 'application/pdf', filename: 'qr.pdf', title: 'QR', idempotencyKey: `${w.tag}-qr` })).file.id;
  assert.equal(must(drop(w, stated, {}, other)).amountFrom, 'receipt');
  assert.deepEqual(rowsOf(w, other), [['person', 'active', null]]);
  must(settingsSet(w.t.ctx, { key: DROP_ON_OPEN_LINE_SETTING, value: 'file', reason: 'test', idempotencyKey: `${w.tag}-s2` }));
  const [third] = debits(w.t, [2360], { from: '2026-07-17' });
  const filed = upload(w);
  const r3 = must(drop(w, filed, {}, third));
  assert.equal(r3.notAssigned, 'setting_file');
  assert.deepEqual(filedOn(w, filed), { entity_kind: 'bank_txn', entity_id: third });
  assert.equal(captureOf(w, filed), undefined, 'nothing captured under file');
  assert.deepEqual(rowsOf(w, third), []);
});

// --- 3. The machine channels, I-E, tenant: refused with nothing written -------------------------------------------

test('machine channels: an agent (REST and MCP), a plugin running as the person, and a person approving an agent\'s draft are refused; nothing written', () => {
  const w = world();
  const fileId = upload(w);
  const before = snapshot(w);
  const args = (k) => ({ workspaceId: w.t.workspaceId, bankTxnId: w.line, fileId, idempotencyKey: `${w.tag}-${k}` });
  const rest = handleRest('assign_beleg_file', args('rest'), { ...w.t.deps, actor: 'agent' }).body;
  assert.equal(rest.error, 'human_only', JSON.stringify(rest));
  const mcp = JSON.parse(callTool({ ...w.t.deps, actor: 'agent' }, 'assign_beleg_file', args('mcp')).content[0].text);
  assert.equal(mcp.error, 'human_only');
  const plugin = withinPluginCall('user_1', () => getAction('assign_beleg_file').run({ ...w.t.deps, actor: 'user_1' }, args('plugin')));
  assert.equal(plugin.error, 'human_only', JSON.stringify(plugin));
  // The engine's own refusal, beside the registry's prevalidate: a plugin call reaching the core directly.
  const userCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'user_1', clock: w.t.clock, ids: w.t.ids });
  assert.equal(withinPluginCall('user_1', () => assignBelegFile(userCtx, { bankTxnId: w.line, fileId, idempotencyKey: `${w.tag}-core` })).error, 'human_only');
  assert.equal(assignBelegFile(agentCtxOf(w), { bankTxnId: w.line, fileId, idempotencyKey: `${w.tag}-core-agent` }).error, 'human_only');
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  const drafted = enqueueDraftedAction(agentCtx, { actionTool: 'assign_beleg_file', payload: args('draft'), dialCapability: null, idempotencyKey: `${w.tag}-draft` });
  assert.equal(drafted.ok, true, 'precondition: a draft beside the registry\'s prevalidate');
  const approved = getAction('approve_drafted_action').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, actionId: drafted.actionId });
  assert.equal(approved.ok, false, JSON.stringify(approved));
  assert.equal(approved.error, 'human_only', JSON.stringify(approved));
  assert.deepEqual({ ...snapshot(w), audit: before.audit }, before, 'no capture, no assignment, no link, no field');
  assert.deepEqual(filedOn(w, fileId), { entity_kind: null, entity_id: null });
  // A G01 rule can never fire it.
  const rule = getAction('create_automation_rule').run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId, name: `Auto ${w.tag}`, trigger: { event: 'qr_match.needs_review' }, action: { tool: 'assign_beleg_file', inputTemplate: args('rule') }, idempotencyKey: `${w.tag}-rule` });
  assert.equal(rule.ok, false, JSON.stringify(rule));
});

test('I-E: a person seat without read_master_data, or without read_sales, is refused permission_denied; nothing written', () => {
  for (const denied of ['read_master_data', 'read_sales', 'manage_files']) {
    const w = world();
    const fileId = upload(w);
    const before = snapshot(w);
    const ctx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'user_1', clock: w.t.clock, ids: w.t.ids, capabilities: { assert: (c) => (c === denied ? err('permission_denied', { capability: c }) : ok()) } });
    assert.equal(assignBelegFile(ctx, { bankTxnId: w.line, fileId, idempotencyKey: `${w.tag}-ie` }).error, 'permission_denied', denied);
    assert.deepEqual(snapshot(w), before, denied);
  }
});

test('§H-TENANT: another workspace\'s line or file is not_found, and nothing is written in either', () => {
  const w = world();
  const fileId = upload(w);
  const b = secondWorkspace(w.t);
  const bCtx = makeContext(w.t.store, { workspaceId: b.workspaceId, actor: 'user_1', clock: w.t.clock, ids: w.t.ids });
  const before = snapshot(w);
  assert.equal(assignBelegFile(bCtx, { bankTxnId: w.line, fileId, idempotencyKey: 'tn-1' }).error, 'not_found');
  const bFile = must(getAction('files_upload').run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: b.workspaceId, contentBase64: raw(9001), mime: 'image/png', filename: 'b.png', title: 'B', idempotencyKey: 'tn-up' })).file.id;
  const foreign = assignBelegFile(w.t.ctx, { bankTxnId: w.line, fileId: bFile, idempotencyKey: 'tn-2' });
  assert.equal(foreign.error, 'not_found');
  assert.equal(foreign.field, 'fileId', 'the act\'s own tenant fence answers, before any later door');
  assert.deepEqual(snapshot(w), before);
  assert.equal(w.t.store.db.prepare('SELECT COUNT(*) AS n FROM beleg_assignment WHERE workspace_id = ?').get(b.workspaceId).n, 0);
  assert.equal(w.t.store.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ?').get(b.workspaceId).n, 0);
});

test('refusals decided before any write: a booked line, a line holding an assignment, a file filed elsewhere, a superseded version, bytes already captured', () => {
  const w = world();
  const [booked] = debits(w.t, [1400]);
  bookAsProposed(w.t, booked);
  const f1 = upload(w);
  let before = snapshot(w);
  assert.equal(drop(w, f1, {}, booked).error, 'line_not_open');
  assert.deepEqual(snapshot(w), before);
  must(drop(w, f1));
  const f2 = upload(w);
  before = snapshot(w);
  assert.equal(drop(w, f2).error, 'line_assigned');
  const [other] = debits(w.t, [1500], { from: '2026-07-10' });
  assert.equal(drop(w, f1, {}, other).error, 'file_filed_elsewhere');
  const r = receipt(w.t, { amount: 1500, vendor: TELCO, date: '2026-07-10' });
  const twin = upload(w, must(getFileContent(w.t.ctx, { fileId: r.fileId })).contentBase64);
  before = snapshot(w);
  assert.equal(drop(w, twin, {}, other).error, 'beleg_already_captured', 'the same bytes wait as another capture');
  assert.deepEqual(snapshot(w), before);
  must(person(w, 'files_new_version', { fileId: f2, contentBase64: raw(8888), mime: 'image/png', idempotencyKey: `${w.tag}-nv` }));
  before = snapshot(w);
  assert.equal(drop(w, f2, {}, other).error, 'not_head_version');
  assert.deepEqual(snapshot(w), before);
});

// --- 4. The hold plan and the receipt guard inside the act --------------------------------------------------------

test('hold plan: a person assigns a Belegeingang document TILL paired with another line: TILL\'s row gives way (person_overrode, never blocks)', () => {
  const w = world(2340);
  const [engineLine] = debits(w.t, [90000], { from: '2026-07-19' });
  const r = confirmedReceipt(w.t, { amount: 90000, vendor: TELCO, date: '2026-07-19' });
  reconcileEngineAssignments(w.t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(w.t, engineLine)?.source, 'engine_unique', 'precondition: TILL paired it');
  assert.deepEqual(filedOn(w, r.fileId), { entity_kind: null, entity_id: null }, 'precondition: an engine row files nothing');
  const res = must(drop(w, r.fileId));
  assert.equal(res.released.length, 1);
  assert.deepEqual(rowsOf(w, engineLine), [['engine_unique', 'released', 'person_overrode']]);
  assert.deepEqual(rowsOf(w), [['person', 'active', null]]);
  assert.equal(res.amountFrom, 'receipt');
});

test('hold plan, the act\'s OWN application: a document already filed on this line (state before v3) that TILL paired with another line gives way, released first', () => {
  const w = world(2340);
  const [engineLine] = debits(w.t, [90000], { from: '2026-07-19' });
  const r = confirmedReceipt(w.t, { amount: 90000, vendor: TELCO, date: '2026-07-19' });
  reconcileEngineAssignments(w.t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(w.t, engineLine)?.source, 'engine_unique', 'precondition: TILL paired it');
  // Direct state setup (the r1 B4 precedent): the document filed on THIS open line, so linkFile is not called.
  w.t.store.db.prepare("UPDATE stored_file SET entity_kind = 'bank_txn', entity_id = ? WHERE id = ?").run(w.line, r.fileId);
  const res = must(drop(w, r.fileId));
  assert.deepEqual(res.released.length, 1);
  assert.deepEqual(rowsOf(w, engineLine), [['engine_unique', 'released', 'person_overrode']]);
  assert.deepEqual(rowsOf(w), [['person', 'active', null]]);
});

test('hold plan, machine: the same document through a plugin running as the person is refused and TILL\'s row stands', () => {
  const w = world(2340);
  const [engineLine] = debits(w.t, [90000], { from: '2026-07-19' });
  const r = confirmedReceipt(w.t, { amount: 90000, vendor: TELCO, date: '2026-07-19' });
  reconcileEngineAssignments(w.t.ctx, STATEMENT_COVERS_SQL);
  const before = snapshot(w);
  const plugin = withinPluginCall('user_1', () => getAction('assign_beleg_file').run({ ...w.t.deps, actor: 'user_1' }, { workspaceId: w.t.workspaceId, bankTxnId: w.line, fileId: r.fileId, idempotencyKey: `${w.tag}-pl` }));
  assert.equal(plugin.error, 'human_only');
  assert.deepEqual(snapshot(w), before);
  assert.deepEqual(rowsOf(w, engineLine), [['engine_unique', 'active', null]]);
});

test('receipt guard (N02 book-again rule): bytes a live booking holds are asked for under confirm, refused under refuse, and the confirmation is recorded', () => {
  const w = world(2340);
  const content = raw(4242);
  const [booked] = debits(w.t, [2340], { from: '2026-07-05' });
  bookAsProposed(w.t, booked);
  const onBooked = upload(w, content);
  must(person(w, 'files_link', { fileId: onBooked, entityKind: 'bank_txn', entityId: booked, idempotencyKey: `${w.tag}-ob` }));
  const twin = upload(w, content);
  let before = snapshot(w);
  const asked = drop(w, twin);
  assert.equal(asked.error, 'receipt_already_booked', JSON.stringify(asked));
  assert.equal(typeof asked.override, 'string', 'under confirm the person is asked for a reason');
  assert.deepEqual(snapshot(w), before);
  assert.equal(drop(w, twin, { bookAgain: true }).error, 'reason_required');
  assert.deepEqual(snapshot(w), before);
  must(settingsSet(w.t.ctx, { key: 'files.duplicate_beleg', value: 'refuse', reason: 'test', idempotencyKey: `${w.tag}-dr` }));
  const refused = drop(w, twin, { bookAgain: true, overrideReason: 'Teilzahlung' });
  assert.equal(refused.error, 'receipt_already_booked');
  assert.equal(refused.override, undefined);
  assert.deepEqual(snapshot(w), before);
  must(settingsSet(w.t.ctx, { key: 'files.duplicate_beleg', value: 'confirm', reason: 'test', idempotencyKey: `${w.tag}-dc` }));
  must(drop(w, twin, { bookAgain: true, overrideReason: 'Zweite Rate desselben Belegs' }));
  assert.equal(snapshot(w).overrides, before.overrides + 1, 'the confirmation is recorded once');
  assert.deepEqual(rowsOf(w), [['person', 'active', null]]);
});

// --- 5. "Neue Version, bitte zuordnen" ----------------------------------------------------------------------------

test('a person\'s new version under move leaves the line waiting; the inbox marks it (I-E: not for a seat without a read right); "Zuordnen" assigns it', () => {
  const w = world(1250);
  const r = receipt(w.t, { amount: 1250, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(w.t, w.line, [r.fileId]));
  assert.equal(inboxLine(w).newVersionToAssign, null, 'an assigned line asks nothing');
  must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
  const head = must(person(w, 'files_new_version', { fileId: r.fileId, contentBase64: raw(5151), mime: 'image/png', idempotencyKey: `${w.tag}-nv` })).file.id;
  assert.deepEqual(rowsOf(w), [['person', 'released', 'person_moved']]);
  assert.deepEqual(inboxLine(w).newVersionToAssign, { fileId: head });
  for (const denied of ['read_master_data', 'read_sales']) {
    const ctx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'user_1', clock: w.t.clock, ids: w.t.ids, capabilities: { assert: (c) => (c === denied ? err('permission_denied', { capability: c }) : ok()) } });
    assert.equal(inboxLine(w, ctx).newVersionToAssign, null, `no hint without ${denied}`);
  }
  assert.equal(inboxLine(w).newVersionOrigin, 'person', 'the person\'s own version');
  w.ap.tick();
  assert.equal(decisionOf(w.t, w.line), undefined, 'the line waits for a person');
  assert.equal(captureOf(w, head), undefined, 'no capture for the new version');
  // Author, critic r1 F1: a new version is no fresh drop, so "Zuordnen" captures it (its bytes' origin, the
  // person's) and assigns it only on an amount of its own; the person states it, then assigns it.
  const res = must(drop(w, head));
  assert.equal(res.notAssigned, 'beleg_without_amount');
  assert.equal(captureOf(w, head)?.intake_seat, 'person');
  assert.equal(inboxLine(w).newVersionToAssign, null, 'captured: the hint is gone (it waits for its amount)');
  must(person(w, 'capture_extract', { captureId: res.captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 1250, currency: 'CHF' } }], idempotencyKey: `${w.tag}-amt` }));
  must(person(w, 'assign_beleg', { bankTxnId: w.line, fileIds: [head], idempotencyKey: `${w.tag}-asg` }));
  assert.deepEqual(rowsOf(w).at(-1), ['person', 'active', null]);
  w.ap.tick();
  assert.equal(decisionOf(w.t, w.line)?.state, 'booked', 'and the new version books it');
});

// --- Critic r1 F1 (I-F): the capture records where the BYTES came from, never who clicked ----------------------------

test('F1: only the person\'s own fresh drop takes the line\'s amount and is a person intake; an agent\'s upload and an approved agent draft\'s are machine intakes', () => {
  const w = world(1250);
  const fresh = upload(w);
  must(drop(w, fresh));
  assert.equal(captureOf(w, fresh).intake_seat, 'person');
  const stored = (id) => w.t.store.db.prepare('SELECT uploaded_by, intake_seat FROM stored_file WHERE id = ?').get(id);
  assert.deepEqual(stored(fresh), { uploaded_by: 'user_1', intake_seat: 'person' });
  // An agent's own upload of raw bytes: never the line's amount, a machine capture.
  const [l2] = debits(w.t, [1260], { from: '2026-07-18' });
  const agentFile = handleRest('files_upload', { workspaceId: w.t.workspaceId, contentBase64: raw(7301), mime: 'image/png', filename: 'a.png', title: 'A', idempotencyKey: `${w.tag}-ag` }, { ...w.t.deps, actor: 'agent' }).body.file.id;
  assert.equal(stored(agentFile).intake_seat, 'machine');
  const r2 = must(drop(w, agentFile, {}, l2));
  assert.equal(r2.notAssigned, 'beleg_without_amount', 'an agent\'s bytes never take the line amount');
  assert.equal(captureOf(w, agentFile).intake_seat, 'machine', 'the person clicked, the bytes are the agent\'s');
  assert.deepEqual(rowsOf(w, l2), []);
  // An approved agent draft's upload is the agent's bytes too (the approval replay).
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  const d = must(enqueueDraftedAction(agentCtx, { actionTool: 'files_upload', payload: { workspaceId: w.t.workspaceId, contentBase64: raw(7302), mime: 'image/png', filename: 'b.png', title: 'B', idempotencyKey: `${w.tag}-dup` }, dialCapability: null, idempotencyKey: `${w.tag}-dup-row` }));
  const approved = must(getAction('approve_drafted_action').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, actionId: d.actionId }));
  const draftFile = approved.result.file.id;
  assert.equal(stored(draftFile).intake_seat, 'machine', 'a person approving an agent\'s upload does not make the bytes the person\'s');
  const [l3] = debits(w.t, [1270], { from: '2026-07-17' });
  assert.equal(must(drop(w, draftFile, {}, l3)).notAssigned, 'beleg_without_amount');
  assert.equal(captureOf(w, draftFile).intake_seat, 'machine');
});

test('F1: a file of unknown origin (before the stamp) fails closed: no line amount, a machine capture; a twin filing row carries its source\'s origin', () => {
  const w = world(1250);
  const legacy = upload(w);
  w.t.store.db.prepare('UPDATE stored_file SET intake_seat = NULL, uploaded_by = NULL WHERE id = ?').run(legacy);
  assert.equal(must(drop(w, legacy)).notAssigned, 'beleg_without_amount');
  assert.equal(captureOf(w, legacy).intake_seat, 'machine');
  const agentFile = handleRest('files_upload', { workspaceId: w.t.workspaceId, contentBase64: raw(7303), mime: 'image/png', filename: 'c.png', title: 'C', idempotencyKey: `${w.tag}-ag` }, { ...w.t.deps, actor: 'agent' }).body.file.id;
  const twin = w.t.store.tx(() => addFilingRowFor(w.t.ctx, agentFile));
  assert.equal(w.t.store.db.prepare('SELECT intake_seat FROM stored_file WHERE id = ?').get(twin).intake_seat, 'machine', 'a person\'s act on a twin keeps the bytes the agent\'s');
});

test('F1: an agent\'s new version a person approved is marked with its origin (machine), and its "Zuordnen" is a machine capture', () => {
  const w = world(1250);
  const r = receipt(w.t, { amount: 1250, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(w.t, w.line, [r.fileId]));
  must(settingsSet(w.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${w.tag}-mv` }));
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  const head = must(person(w, 'files_new_version', { fileId: r.fileId, contentBase64: raw(7304), mime: 'image/png', idempotencyKey: `${w.tag}-nv` })).file.id;
  const d = must(enqueueDraftedAction(agentCtx, { actionTool: 'files_new_version', payload: { workspaceId: w.t.workspaceId, fileId: head, contentBase64: raw(7305), mime: 'image/png', idempotencyKey: `${w.tag}-anv` }, dialCapability: null, idempotencyKey: `${w.tag}-anv-row` }));
  const agentHead = must(getAction('approve_drafted_action').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, actionId: d.actionId })).result.file.id;
  const line = inboxLine(w);
  assert.deepEqual(line.newVersionToAssign, { fileId: agentHead });
  assert.equal(line.newVersionOrigin, 'machine');
  assert.equal(must(drop(w, agentHead)).notAssigned, 'beleg_without_amount');
  assert.equal(captureOf(w, agentHead).intake_seat, 'machine');
});

test('under refuse (the default) the new version is refused, so the line never waits on an unassigned version', () => {
  const w = world(1910);
  const r = receipt(w.t, { amount: 1910, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(w.t, w.line, [r.fileId]));
  const res = person(w, 'files_new_version', { fileId: r.fileId, contentBase64: raw(5252), mime: 'image/png', idempotencyKey: `${w.tag}-nv` });
  assert.equal(res.error, 'receipt_assigned');
  assert.equal(inboxLine(w).newVersionToAssign, null);
});

test('the mark is exactly "a new version a move left": a version after any other release is no such mark; a captured version waiting for its amount is none either', () => {
  // Another release (a person edits the figures: figures_changed) leaves the file on the line; its new version is a
  // filed file like any other ("Abgelegt, nicht zugeordnet"), not the move's mark.
  const w = world(1250);
  const r = receipt(w.t, { amount: 1250, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(w.t, w.line, [r.fileId]));
  must(person(w, 'capture_extract', { captureId: r.captureId, source: 'operator', fields: [{ key: 'amount', value: { minor: 1251, currency: 'CHF' } }], idempotencyKey: `${w.tag}-fx` }));
  assert.deepEqual(rowsOf(w), [['person', 'released', 'figures_changed']]);
  must(person(w, 'files_new_version', { fileId: r.fileId, contentBase64: raw(6161), mime: 'image/png', idempotencyKey: `${w.tag}-nv` }));
  assert.equal(inboxLine(w).newVersionToAssign, null);
  // A move's new version, then "Zuordnen" under assign_if_stated: filed and captured, waiting for its amount.
  const v = world(1250);
  const r2 = receipt(v.t, { amount: 1250, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(v.t, v.line, [r2.fileId]));
  must(settingsSet(v.t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${v.tag}-mv` }));
  const head = must(person(v, 'files_new_version', { fileId: r2.fileId, contentBase64: raw(6262), mime: 'image/png', idempotencyKey: `${v.tag}-nv` })).file.id;
  assert.deepEqual(inboxLine(v).newVersionToAssign, { fileId: head });
  must(settingsSet(v.t.ctx, { key: DROP_ON_OPEN_LINE_SETTING, value: 'assign_if_stated', reason: 'test', idempotencyKey: `${v.tag}-ais` }));
  assert.equal(must(drop(v, head)).notAssigned, 'beleg_without_amount');
  assert.equal(captureOf(v, head)?.status, 'needs_review');
  assert.equal(inboxLine(v).newVersionToAssign, null, 'a captured version waits for its amount, no longer for a new capture');
});

// --- 6. The two code-critic LOW notes ---------------------------------------------------------------------------

test('LOW b: holdersForSeat names an assignment hold only to a seat holding BOTH read rights; any other seat gets one marker', () => {
  assert.equal(HOLD_BANK_READ_CAPABILITY, BANK_LINE_READ_CAPABILITY);
  const w = world();
  const holders = [{ fileId: 'f', entityKind: 'beleg_assignment', entityId: w.line, reservedBy: null, assignmentId: 'basg_x', bankTxnId: w.line, source: 'person' }];
  const seat = (denied) => makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'user_1', clock: w.t.clock, ids: w.t.ids, capabilities: { assert: (c) => (c === denied ? err('permission_denied', { capability: c }) : ok()) } });
  assert.equal(holdersForSeat(seat(null), holders)[0].bankTxnId, w.line);
  for (const denied of ['read_master_data', 'read_sales']) {
    const shown = holdersForSeat(seat(denied), holders);
    assert.deepEqual(shown, [{ entityKind: 'receipt_held', entityId: null, reservedBy: null }], denied);
    assert.equal(JSON.stringify(shown).includes(w.line), false, denied);
  }
});

test('LOW b, end to end: a seat with read_master_data but no read_sales gets the marker in a refusal', () => {
  const w = world(1910);
  const r = receipt(w.t, { amount: 1910, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(w.t, w.line, [r.fileId]));
  const [booked] = debits(w.t, [1910], { from: '2026-05-21' });
  bookAsProposed(w.t, booked);
  const ctx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'user_1', clock: w.t.clock, ids: w.t.ids, capabilities: { assert: (c) => (c === 'read_sales' ? err('permission_denied', { capability: c }) : ok()) } });
  const reading = linkFile(w.t.ctx, { fileId: r.fileId, entityKind: 'bank_txn', entityId: booked });
  assert.equal(reading.error, 'receipt_assigned');
  assert.equal(reading.holders[0].bankTxnId, w.line, 'a seat with both reads sees the line');
  const res = linkFile(ctx, { fileId: r.fileId, entityKind: 'bank_txn', entityId: booked });
  assert.equal(res.error, 'receipt_assigned');
  assert.deepEqual(res.holders, [{ entityKind: 'receipt_held', entityId: null, reservedBy: null }]);
  assert.equal(JSON.stringify(res).includes(w.line), false);
});

test('LOW a: remapCopiedWorkspaceIds re-maps a workspace id in an ordinary cell, and refuses a file link or an assignment cell before writing', () => {
  assert.equal(remapNeverWrites('stored_file', 'entity_id'), true);
  assert.equal(remapNeverWrites('stored_file', 'entity_kind'), true);
  assert.equal(remapNeverWrites('beleg_assignment', 'bank_txn_id'), true);
  assert.equal(remapNeverWrites('beleg_assignment_file', 'file_id'), true);
  assert.equal(remapNeverWrites('stored_file', 'title'), false);
  const w = world();
  const fileId = upload(w);
  const db = w.t.store.db;
  const sibling = 'ws_101';
  db.prepare('UPDATE stored_file SET title = ? WHERE id = ?').run(sibling, fileId);
  const changed = remapCopiedWorkspaceIds(db, { [sibling]: 'ws_202' }, [w.t.workspaceId]);
  assert.ok(changed >= 1);
  assert.equal(db.prepare('SELECT title FROM stored_file WHERE id = ?').get(fileId).title, 'ws_202', 'an ordinary cell is re-mapped');
  db.prepare("UPDATE stored_file SET entity_kind = 'workspace', entity_id = ? WHERE id = ?").run(sibling, fileId);
  const run = db.transaction(() => remapCopiedWorkspaceIds(db, { [sibling]: 'ws_202' }, [w.t.workspaceId]));
  assert.throws(run, /receipt link or assignment/);
  assert.deepEqual(filedOn(w, fileId), { entity_kind: 'workspace', entity_id: sibling }, 'the link is not re-pointed');
  db.prepare('UPDATE stored_file SET entity_kind = NULL, entity_id = NULL WHERE id = ?').run(fileId);
});

test('LOW b, the bexio documents step: the skipped file names its line only to a seat with both read rights', () => {
  const w = world(1910);
  const r = receipt(w.t, { amount: 1910, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(w.t, w.line, [r.fileId]));
  const call = (name, input) => getAction(name).run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, ...input });
  const content = must(getFileContent(w.t.ctx, { fileId: r.fileId }));
  const twin = must(call('files_upload', { contentBase64: content.contentBase64, mime: 'text/csv', filename: 'a.csv', title: 'Beleg a', idempotencyKey: `${w.tag}-bx` })).file.id;
  const planId = must(call('migration_create_plan', { sourceSystem: 'csv', cutoverDate: '2024-01-01', localePack: 'ch', idempotencyKey: `${w.tag}-plan` })).planId;
  must(call('migration_discover_source', { fileIds: [twin], planId }));
  w.t.store.db.prepare("UPDATE migration_source_file SET data_classes = '[\"documents\"]' WHERE plan_id = ?").run(planId);
  const scope = must(call('migration_set_scope', { planId, classes: [{ dataClass: 'documents', include: true }], idempotencyKey: `${w.tag}-scope` }));
  const stepId = scope.steps.find((x) => x.dataClass === 'documents').stepId;
  must(call('migration_trial_load_step', { planId, stepId, idempotencyKey: `${w.tag}-trial` }));
  const noBank = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'studio', clock: w.t.clock, ids: w.t.ids, capabilities: { assert: (c) => (c === 'read_sales' ? err('permission_denied', { capability: c }) : ok()) } });
  const committed = must(commitStep(noBank, { planId, stepId, idempotencyKey: `${w.tag}-commit` }));
  assert.deepEqual(committed.skippedAssigned, [{ fileId: twin }]);
  assert.equal(JSON.stringify(committed).includes(w.line), false);
});

test('F1: a file once filed and taken off again (linked_by set) is no fresh drop either', () => {
  const w = world(1250);
  const once = upload(w);
  // Direct state setup: the row a release leaves behind (unlinked, but a link was written once).
  w.t.store.db.prepare("UPDATE stored_file SET linked_by = 'user_1', linked_by_seat = 'person' WHERE id = ?").run(once);
  assert.equal(must(drop(w, once)).notAssigned, 'beleg_without_amount');
  assert.deepEqual(rowsOf(w), []);
});

test('F2: a person-assigned line whose receipt evidences another live booking waits beleg_in_use, and the digest lists it', () => {
  const w = world(1250);
  const content = raw(7401);
  const [booked] = debits(w.t, [1250], { from: '2026-07-05' });
  bookAsProposed(w.t, booked);
  must(person(w, 'files_link', { fileId: upload(w, content), entityKind: 'bank_txn', entityId: booked, idempotencyKey: `${w.tag}-ob` }));
  must(drop(w, upload(w, content), { bookAgain: true, overrideReason: 'Zweite Rate' }));
  assert.equal(activeOf(w.t, w.line)?.source, 'person');
  w.ap.tick();
  assert.equal(decisionOf(w.t, w.line), undefined);
  assert.deepEqual(must(autobookDigest(w.t.ctx, {})).waitingForBeleg.filter((x) => x.bankTxnId === w.line).map((x) => x.reason), ['beleg_in_use']);
  // Under files.duplicate_beleg = allow the booking's guard passes, so the line is no longer listed as waiting: it books.
  must(settingsSet(w.t.ctx, { key: 'files.duplicate_beleg', value: 'allow', reason: 'test', idempotencyKey: `${w.tag}-al` }));
  assert.deepEqual(must(autobookDigest(w.t.ctx, {})).waitingForBeleg.filter((x) => x.bankTxnId === w.line), []);
  w.ap.tick();
  assert.equal(decisionOf(w.t, w.line)?.state, 'booked');
});
