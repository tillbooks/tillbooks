// A41.3 re-cut v2, the critic r1 fixes (S1/S2, R2, M11): ONE set of capture fields the engine's pairing reads,
// covered whole by a person's confirmation or the QR read, and the re-check under the write lock.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { grantRuleAutobook, runAutobookStep } from '../../dist/core/banking/autobook.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { ENGINE_CAPTURE_KEYS } from '../../dist/core/banking/belegFigures.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { must, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, entryCount, TELCO, TELCO_IBAN } from './n04-autobook-support.mjs';
import { receipt, confirmedReceipt, confirmFigures, assignBeleg, activeOf, assignmentsOf, verb, seenOf } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

function granted(tag) {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `grant-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'test', idempotencyKey: `rb-${tag}` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'test', idempotencyKey: `sc-${tag}` }));
  at(t, '2026-07-20T08:00:00.000Z');
  return { ...t, ap: autopilot(t) };
}
const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const agentEdit = (t, captureId, fields, k) =>
  must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId, source: 'agent', fields, idempotencyKey: k }));
const states = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason]);

test('GUARD: the matcher reads a capture only through the engine field set, and reads no key outside it', () => {
  const src = readFileSync(new URL('../../src/core/banking/belegMatch.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function poolBelegOf'), src.indexOf('// --- The match'));
  assert.match(body, /engineFieldsOf\(fieldsOf\(ctx, r\.capture_id\)\)/, 'the pool reads through engineFieldsOf');
  const read = [...body.matchAll(/fields\.get\('([a-z_]+)'\)/g)].map((m) => m[1]);
  assert.ok(read.length > 0);
  for (const key of read) assert.ok(ENGINE_CAPTURE_KEYS.includes(key), `the matcher reads ${key}, outside ENGINE_CAPTURE_KEYS`);
  // receiptFigures reads its keys from the same restricted map.
  const figures = readFileSync(new URL('../../src/core/banking/belegFigures.ts', import.meta.url), 'utf8');
  const fig = figures.slice(figures.indexOf('export function receiptFigures'), figures.indexOf('/** The field keys'));
  for (const m of fig.matchAll(/fields\.get\('([a-z_]+)'\)/g)) assert.ok(ENGINE_CAPTURE_KEYS.includes(m[1]), m[1]);
  // The trust check covers the same set (one constant, no second list).
  const trust = readFileSync(new URL('../../src/core/banking/belegTrust.ts', import.meta.url), 'utf8');
  assert.match(trust, /ENGINE_CAPTURE_KEYS/);
  assert.doesNotMatch(trust, /\bFIGURE_KEYS\b/);
});

for (const [key, value, label] of [
  ['iban', 'CH9300762011623852957', 'IBAN'],
  ['vendor_uid', 'CHE-109.322.551', 'UID'],
  ['due_date', '2026-07-21', 'due date'],
]) {
  test(`S (${label}): an agent adds or rewrites ${key} after the person confirmed: the trust is void and nothing pairs`, () => {
    const t = granted(`k-${key}`);
    const [line] = debits(t, [1710], { from: '2026-07-19' });
    const r = confirmedReceipt(t, { amount: 1710, vendor: TELCO, date: dateOf(t, line) });
    agentEdit(t, r.captureId, [{ key, value, confidence: 'high' }], `k-${key}-e`);
    t.ap.tick();
    assert.deepEqual(assignmentsOf(t, line), [], `a ${label} the person did not confirm backs no engine pairing`);
    assert.equal(decisionOf(t, line), undefined);
    // A person confirming the new state restores it.
    confirmFigures(t, r);
    t.ap.tick();
    assert.equal(decisionOf(t, line)?.state, 'booked');
  });
}

test('S (hook): an engine row is released figures_changed the moment a governed seat moves a match key; a person row is not', () => {
  const t = granted('hook');
  const [line] = debits(t, [90000], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 90000, vendor: TELCO, date: dateOf(t, line) });
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, line)?.source, 'engine_unique');
  agentEdit(t, r.captureId, [{ key: 'iban', value: TELCO_IBAN, confidence: 'high' }], 'hook-1');
  assert.deepEqual(states(t, line), [['engine_unique', 'released', 'figures_changed']], 'released in capture_extract itself');
  // A person row over the same receipt ignores a governed seat's match-key edit (the person chose the line).
  must(assignBeleg(t, line, [r.fileId]));
  agentEdit(t, r.captureId, [{ key: 'vendor_name', value: 'Anderer Name AG', confidence: 'high' }], 'hook-2');
  assert.equal(activeOf(t, line)?.source, 'person');
});

test('M11: a person releases the assignment between the verdict and the write lock: the re-check under the lock books nothing', () => {
  const t = granted('m11');
  const [line] = debits(t, [1720], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1720, vendor: TELCO, date: dateOf(t, line) });
  must(assignBeleg(t, line, [r.fileId]));
  const entries = entryCount(t);
  const system = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'system', clock: t.clock, ids: t.ids });
  const report = runAutobookStep(system, {
    holdsPost: () => true,
    book: (actor, input) => getAction('book_bank_line').run({ ...t.deps, actor }, input),
    // Another writer in the window: the verdict above saw the person's assignment; it is gone now.
    beforeBooking: (id) => {
      if (id === line) must(verb(t, 'release_beleg', { bankTxnId: line }));
    },
  });
  assert.deepEqual(report.booked, [], 'the step booked a line whose assignment was released before the lock');
  assert.deepEqual(report.waiting.filter((w) => w.bankTxnId === line).map((w) => w.reason), ['no_beleg']);
  assert.equal(decisionOf(t, line), undefined);
  assert.equal(entryCount(t), entries);
});

test('R2 (c): one line whose assignment cannot be written is recorded and skipped; the pass and every other line go on', () => {
  const t = granted('r2c');
  const [a] = debits(t, [1730], { from: '2026-07-19' });
  const [b] = debits(t, [1740], { from: '2026-07-24' });
  confirmedReceipt(t, { amount: 1730, vendor: TELCO, date: dateOf(t, a) });
  confirmedReceipt(t, { amount: 1740, vendor: TELCO, date: dateOf(t, b) });
  // A row on line a that the pass cannot know about, written raw so the insert meets the one-active-per-line index.
  t.store.db.exec('DROP TRIGGER IF EXISTS r2c_probe');
  t.store.db.prepare(`CREATE TEMP TRIGGER r2c_probe BEFORE INSERT ON beleg_assignment WHEN NEW.bank_txn_id = '${a}' BEGIN SELECT RAISE(ABORT, 'probe: this line refuses'); END`).run();
  let thrown = null;
  let report;
  try {
    report = reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  } catch (e) {
    thrown = String(e?.message ?? e);
  }
  t.store.db.exec('DROP TRIGGER IF EXISTS r2c_probe');
  assert.equal(thrown, null);
  assert.deepEqual(report.refused.map((x) => x.bankTxnId), [a], 'the refusal is recorded, not swallowed');
  assert.match(report.refused[0].error, /probe: this line refuses/);
  assert.equal(activeOf(t, b)?.source, 'engine_unique', 'the other line was assigned');
});

// --- Security review of the R2 fix: only a person ends a person's assignment, also by discarding ---------

const discard = (t, captureId, actor, key) =>
  getAction('capture_discard').run({ ...t.deps, actor }, { workspaceId: t.workspaceId, captureId, reason: 'probe', idempotencyKey: key });
const captureStatus = (t, id) => t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(id).status;

test('discard: an agent (direct, plugin, or a person approving its draft) cannot discard a receipt a person assigned; nothing changes', () => {
  const t = granted('dis-ag');
  const [line] = debits(t, [1750], { from: '2026-04-01' });
  const r = confirmedReceipt(t, { amount: 1750, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, line, [r.fileId]));
  const before = JSON.stringify(states(t, line));
  assert.equal(discard(t, r.captureId, 'agent', 'dis-1').error, 'receipt_assigned', 'the agent seat');
  const inPlugin = withinPluginCall('user_1', () => discard(t, r.captureId, 'user_1', 'dis-2'));
  assert.equal(inPlugin.error, 'receipt_assigned', 'a plugin call running as its installer');
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const drafted = must(enqueueDraftedAction(agentCtx, { actionTool: 'capture_discard', payload: { workspaceId: t.workspaceId, captureId: r.captureId, reason: 'agent', idempotencyKey: 'dis-3' }, dialCapability: null, idempotencyKey: 'dis-row' }));
  const approved = getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: drafted.actionId });
  assert.equal(captureStatus(t, r.captureId), 'needs_review', `a person approving the agent's discard does not make it a person's: ${JSON.stringify(approved).slice(0, 160)}`);
  assert.equal(JSON.stringify(states(t, line)), before, 'the person row stands');
  assert.equal(activeOf(t, line)?.source, 'person');
});

test('discard: a person\'s discard releases the person row (capture_discarded); any discard releases an engine row', () => {
  const t = granted('dis-p');
  const [mine] = debits(t, [1760], { from: '2026-04-01' });
  const r1 = confirmedReceipt(t, { amount: 1760, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, mine, [r1.fileId]));
  must(discard(t, r1.captureId, 'user_1', 'dis-p1'));
  assert.deepEqual(states(t, mine), [['person', 'released', 'capture_discarded']]);
  const [eng] = debits(t, [90000], { from: '2026-07-19' });
  const r2 = confirmedReceipt(t, { amount: 90000, vendor: TELCO, date: dateOf(t, eng) });
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, eng)?.source, 'engine_unique');
  must(discard(t, r2.captureId, 'agent', 'dis-p2'));
  assert.deepEqual(states(t, eng), [['engine_unique', 'released', 'capture_discarded']]);
});

test('M10: a person-assigned receipt whose document gets a new version no longer stands: the line waits beleg_changed', () => {
  const t = granted('m10');
  const [line] = debits(t, [1770], { from: '2026-04-01' });
  const r = confirmedReceipt(t, { amount: 1770, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, line, [r.fileId]));
  // v3: a person's new version of an assigned file is refused under the default belege.assigned_move = refuse; the
  // receipt-stands re-check is reached by direct state setup (the assigned file marked for deletion underneath).
  assert.equal(getAction('files_new_version').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, fileId: r.fileId, contentBase64: Buffer.from('eine andere Fassung').toString('base64'), mime: 'image/png', filename: 'v2.png', idempotencyKey: 'm10-v' }).error, 'receipt_assigned');
  t.store.db.prepare('UPDATE stored_file SET pending_delete = 1 WHERE id = ?').run(r.fileId);
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the assigned file is no longer the head of its chain');
  const reasons = must(getAction('autobook_digest').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId })).waitingForBeleg.filter((w) => w.bankTxnId === line).map((w) => w.reason);
  assert.deepEqual(reasons, ['beleg_changed']);
});

test('M15: a receipt a person\'s row holds never enters the engine pool, even when its filing on the line is gone', () => {
  const t = granted('m15');
  const [line] = debits(t, [1780], { from: '2026-07-19' });
  const [other] = debits(t, [1780], { from: '2026-07-24' });
  const r = confirmedReceipt(t, { amount: 1780, vendor: TELCO, date: dateOf(t, other) });
  must(assignBeleg(t, line, [r.fileId]));
  // The filing row is gone (say a restore that dropped the link): only the assignment still holds the receipt.
  t.store.db.prepare('UPDATE stored_file SET entity_kind = NULL, entity_id = NULL WHERE id = ?').run(r.fileId);
  const report = reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.deepEqual({ created: report.created, refused: report.refused ?? [] }, { created: [], refused: [] }, 'the pass never even tries a receipt a person holds');
  assert.equal(activeOf(t, other), undefined);
  assert.equal(activeOf(t, line)?.source, 'person');
});

test('confirm: the agent edits the amount after the person read it; the confirmation with the old expected is refused and nothing is trusted (bulk all or nothing)', () => {
  const t = granted('stale');
  const [line] = debits(t, [1790], { from: '2026-07-19' });
  const r = receipt(t, { amount: 1790, vendor: TELCO, date: dateOf(t, line) });
  const other = receipt(t, { amount: 4242, vendor: 'Nebenlieferant AG', date: '2026-03-01' });
  // The person reads both (the Studio row shows get_capture's engineFields and sha256).
  const seen = [seenOf(t, r.captureId), seenOf(t, other.captureId)];
  const viaRead = must(getAction('get_capture').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: r.captureId })).capture;
  assert.deepEqual({ sha256: viaRead.sha256, fields: viaRead.engineFields }, seen[0].expected, 'the read answers exactly what confirm expects');
  // Between the read and the click, the agent rewrites the amount.
  agentEdit(t, r.captureId, [{ key: 'amount', value: { minor: 1791, currency: 'CHF' }, confidence: 'high' }], 'stale-e');
  const res = verb(t, 'confirm_capture_figures', { captures: seen });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'figures_changed');
  assert.deepEqual(res.captureIds, [r.captureId]);
  const rows = t.store.db.prepare('SELECT COUNT(*) AS n FROM capture_figure_confirmation WHERE workspace_id = ?').get(t.workspaceId).n;
  assert.equal(rows, 0, 'nothing confirmed, not even the unchanged capture');
  for (const id of [r.captureId, other.captureId]) {
    assert.equal(must(getAction('get_capture').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: id })).capture.figuresTrusted, false);
  }
  // Without expected the verb refuses outright.
  assert.equal(verb(t, 'confirm_capture_figures', { captures: [{ captureId: r.captureId }] }).error, 'invalid_input');
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), []);
});

// --- Security review: the engine write refuses hidden characters and broken IBANs -------------------------

test('write guard: an RLO in a vendor name and a zero-width space in an IBAN are refused at capture_extract, nothing lands', () => {
  const t = granted('guard');
  const r = receipt(t, { amount: 1800, vendor: TELCO, date: '2026-07-19' });
  const fields = () => t.store.db.prepare('SELECT key, value FROM capture_fields WHERE capture_id = ? AND superseded = 0 ORDER BY key').all(r.captureId);
  const before = fields();
  const write = (actor, source, f, k) =>
    getAction('capture_extract').run({ ...t.deps, actor }, { workspaceId: t.workspaceId, captureId: r.captureId, source, fields: [f], idempotencyKey: k });
  const rlo = write('agent', 'agent', { key: 'vendor_name', value: '\u202eGA ocleT', confidence: 'high' }, 'g-rlo');
  assert.deepEqual([rlo.error, rlo.key], ['invalid_field_characters', 'vendor_name']);
  const zw = write('user_1', 'operator', { key: 'iban', value: `CH44\u200b31999123000889012` }, 'g-zw');
  assert.deepEqual([zw.error, zw.key], ['invalid_field_characters', 'iban'], 'a person is held to it too');
  const bad = write('agent', 'agent', { key: 'iban', value: 'CH4431999123000889013', confidence: 'high' }, 'g-bad');
  assert.deepEqual([bad.error, bad.key], ['invalid_iban', 'iban']);
  const nl = write('agent', 'agent', { key: 'invoice_date', value: '2026-07-19\n', confidence: 'high' }, 'g-nl');
  assert.equal(nl.error, 'invalid_field_characters');
  assert.deepEqual(fields(), before, 'nothing was written');
  // A valid IBAN (spaces allowed) and a foreign VAT id in any format land.
  must(write('agent', 'agent', { key: 'iban', value: 'CH44 3199 9123 0008 8901 2', confidence: 'high' }, 'g-ok1'));
  must(write('agent', 'agent', { key: 'vendor_uid', value: 'DE 123/456-789 x', confidence: 'high' }, 'g-ok2'));
});

test('write guard: capture_commit corrections meet the same rule', () => {
  const t = granted('guard-c');
  const r = receipt(t, { amount: 1810, vendor: TELCO, date: '2026-07-19' });
  const vendor = must(getAction('create_contact').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, partyRole: 'vendor', name: TELCO, idempotencyKey: 'gc-v' })).contact.id;
  const res = getAction('capture_commit').run({ ...t.deps, actor: 'user_1' }, {
    workspaceId: t.workspaceId,
    captureId: r.captureId,
    target: { kind: 'vendor_bill', vendorId: vendor, billDate: '2026-07-19', expenseAccountId: t.acc('6570') },
    corrections: [{ key: 'vendor_name', value: `${TELCO}\u200d` }],
    idempotencyKey: 'gc-1',
  });
  assert.deepEqual([res.error, res.key], ['invalid_field_characters', 'vendor_name']);
  assert.equal(t.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(r.captureId).status, 'needs_review');
});

// --- Critic r2: the chokepoints ------------------------------------------------------------------------

test('GUARD (r2 M2/M3): the one place that moves an assignment\'s state is closeAssignment, and it holds the person rule', () => {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : e.name.endsWith('.ts') ? [`${dir}/${e.name}`] : []));
  const root = new URL('../../src', import.meta.url).pathname;
  const writers = walk(root).filter((f) => /UPDATE beleg_assignment\s/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(writers.map((f) => f.slice(root.length + 1)), ['core/banking/belegAssignmentStore.ts']);
  const store = readFileSync(`${root}/core/banking/belegAssignmentStore.ts`, 'utf8');
  const close = store.slice(store.indexOf('export function closeAssignment'), store.indexOf('/**', store.indexOf('export function closeAssignment')));
  assert.equal((store.match(/UPDATE beleg_assignment\s/g) ?? []).length, (close.match(/UPDATE beleg_assignment\s/g) ?? []).length, 'every state UPDATE is inside closeAssignment');
  assert.match(close, /row\.source === 'person' && row\.state === 'active' && isMachineAct\(ctx\)/);
  // The per-door copy in capture_discard is gone (the chokepoint covers it).
  assert.doesNotMatch(readFileSync(`${root}/core/purchase/capture.ts`, 'utf8'), /heldByPersonAssignment/);
});

test('r2 M3 (chokepoint): a machine act on ANY door that would end a person row is refused whole: ignore, reopen-free decision, figure edit releases nothing', () => {
  const t = granted('cp');
  const [line] = debits(t, [1820], { from: '2026-04-01' });
  const r = receipt(t, { amount: 1820, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, line, [r.fileId]));
  // An agent (dial open) ignoring the line would release the person row: refused, nothing written.
  must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'cp-dial' }));
  const ign = getAction('ignore_bank_line').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, bankTxnId: line, reason: 'booked_elsewhere', note: 'x', idempotencyKey: 'cp-ign' });
  assert.equal(ign.error, 'receipt_assigned', JSON.stringify(ign).slice(0, 200));
  assert.equal(decisionOf(t, line), undefined, 'the ignore rolled back whole');
  assert.equal(activeOf(t, line)?.source, 'person');
  // A machine figure edit is STORED and releases nothing (the verdict judges the person's snapshot, I-D).
  must(agentEdit(t, r.captureId, [{ key: 'amount', value: { minor: 1821, currency: 'CHF' }, confidence: 'high' }], 'cp-x'));
  assert.equal(activeOf(t, line)?.source, 'person');
  // A person's ignore releases it.
  must(getAction('ignore_bank_line').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, bankTxnId: line, reason: 'booked_elsewhere', note: 'x', idempotencyKey: 'cp-ign-p' }));
  assert.deepEqual(states(t, line), [['person', 'released', 'line_ignored']]);
});

test('r2 F3 (a): an undated receipt whose QR reference matches the line\'s structured reference pairs even where another line of that amount waits', () => {
  const t = granted('f3a');
  const qrr = '210000000003139471430009017';
  const [june] = debits(t, [1840], { from: '2026-06-19' });
  bookAsProposed(t, june);
  const [july] = debits(t, [1840], { from: '2026-07-19' });
  t.store.db.prepare("UPDATE bank_txn SET reference_kind = 'QRR', reference_value = ? WHERE id = ?").run(qrr, july);
  const r = confirmedReceipt(t, { amount: 1840, vendor: TELCO, date: null });
  must(getAction('capture_extract').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: r.captureId, source: 'operator', fields: [{ key: 'reference', value: qrr }], idempotencyKey: 'f3a-ref' }));
  confirmFigures(t, r);
  t.ap.tick();
  assert.equal(decisionOf(t, july)?.state, 'booked', 'the reference proves which line it pays');
});

test('r2 F3 (b): an undated receipt pairs when it is unique within the lookback, and never under belege.undated_lookback_days = 0', () => {
  const t = granted('f3b');
  const [line] = debits(t, [1850], { from: '2026-07-19' });
  confirmedReceipt(t, { amount: 1850, vendor: TELCO, date: null });
  must(settingsSet(t.ctx, { key: 'belege.undated_lookback_days', value: 0, reason: 'test', idempotencyKey: 'ul-0' }));
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], '0: an undated receipt always waits for a person');
  assert.equal(getAction('settings_set').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, key: 'belege.undated_lookback_days', value: 400, reason: 'x', idempotencyKey: 'ul-ag' }).error, 'human_only');
  must(settingsSet(t.ctx, { key: 'belege.undated_lookback_days', value: 120, reason: 'test', idempotencyKey: 'ul-120' }));
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked', 'unique among the receipt-less lines of 120 days');
});

// --- Critic r2 N4 and N7: the backup layers, reached by direct state setup ---------------------------------

test('N4: a re-dropped twin of bytes a person\'s row still holds (a legacy discard that never released it) never enters the pool', () => {
  const t = granted('n4');
  const [held] = debits(t, [1860], { from: '2026-04-01' });
  const [fits] = debits(t, [1860], { from: '2026-07-19' });
  const bytes = Buffer.from('n4 Beleg, synthetische Bytes', 'utf8').toString('base64');
  const intake = (k) => must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: bytes, mime: 'application/pdf', filename: `${k}.pdf`, idempotencyKey: k }));
  const first = intake('n4-a');
  const fields = [{ key: 'amount', value: { minor: 1860, currency: 'CHF' } }, { key: 'vendor_name', value: TELCO }, { key: 'invoice_date', value: dateOf(t, fits) }];
  must(getAction('capture_extract').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: first.captureId, source: 'operator', fields, idempotencyKey: 'n4-f1' }));
  const fileOf = (id) => t.store.db.prepare('SELECT document_id FROM captures WHERE id = ?').get(id).document_id;
  must(assignBeleg(t, held, [fileOf(first.captureId)]));
  // A legacy state: the capture was discarded by a build before the discard hook, so the person row stands.
  t.store.db.prepare("UPDATE captures SET status = 'discarded' WHERE id = ?").run(first.captureId);
  const again = intake('n4-b');
  must(getAction('capture_extract').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: again.captureId, source: 'operator', fields, idempotencyKey: 'n4-f2' }));
  confirmFigures(t, { captureId: again.captureId });
  const report = reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.deepEqual({ created: report.created, refused: report.refused ?? [] }, { created: [], refused: [] }, 'the twin of held bytes is never even tried');
  assert.equal(activeOf(t, held)?.source, 'person');
  assert.equal(activeOf(t, fits), undefined);
});

test('N7: an engine row whose match key moved without the hook (a legacy edit) makes the verdict wait beleg_changed, even under agent trust', () => {
  const t = granted('n7');
  must(settingsSet(t.ctx, { key: 'belege.autobook_figure_trust', value: 'agent', reason: 'test', idempotencyKey: 'n7-trust' }));
  const [line] = debits(t, [1870], { from: '2026-07-19' });
  const r = receipt(t, { amount: 1870, vendor: TELCO, date: dateOf(t, line) });
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, line)?.source, 'engine_unique');
  // The vendor moves underneath (a row written by a build before the hook): figures and trust are unchanged.
  t.store.db.prepare(`UPDATE capture_fields SET value = '"Anderer Absender AG"' WHERE capture_id = ? AND key = 'vendor_name' AND superseded = 0`).run(r.captureId);
  const waiting = must(getAction('autobook_digest').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId })).waitingForBeleg.filter((w) => w.bankTxnId === line).map((w) => w.reason);
  assert.deepEqual(waiting, ['beleg_changed'], 'the verdict re-checks every engine field, not only the figures');
});
