// A41.3 re-cut v2 (D184): the probes the agreed design names (H1 to H8), the security review's QR probe, and
// the positive guard that the autobook receipt verdict reads one input only. Each probe states the attack.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates; the QR bill below is a
// hand-written SPC payload on the published sample IBAN the N04 support uses.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool } from '../../dist/api/mcp.js';
import { makeContext } from '../../dist/core/context.js';
import { withinPluginCall } from '../../dist/core/plugins/callScope.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { ignoreBankLine, reopenBankLine } from '../../dist/core/banking/bankBooking.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { assignBeleg as assignBelegEngine, reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { ok, err } from '../../dist/core/result.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { withinFolderIntake } from '../../dist/core/purchase/intakeSeat.js';
import { must, assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, entryCount, TELCO, TELCO_IBAN } from './n04-autobook-support.mjs';
import { receipt, confirmedReceipt, confirmFigures, assignBeleg, assignmentsOf, activeOf, verb, seenOf } from './a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const LATER = '2026-07-20T08:00:00.000Z';

function granted() {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: 'grant-h' }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'A41 test', idempotencyKey: 'rb-on-h' }));
  at(t, LATER);
  return { ...t, ap: autopilot(t) };
}

const dateOf = (t, line) => t.store.db.prepare('SELECT booking_date FROM bank_txn WHERE id = ?').get(line).booking_date;
const waitingOf = (t, ctx = t.ctx) => must(autobookDigest(ctx, {})).waitingForBeleg.map((w) => [w.bankTxnId, w.reason]);
const agentMcp = (t, name, args) => JSON.parse(callTool({ ...t.deps, actor: 'agent' }, name, { workspaceId: t.workspaceId, ...args }).content[0].text);
const agentRows = (t) => t.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE workspace_id = ? AND actor = 'agent'").get(t.workspaceId).n;
const states = (t, line) => assignmentsOf(t, line).map((a) => [a.source, a.state, a.release_reason]);

test('H1: an agent\'s figures under confirmed never assign; under agent (the owner\'s explicit choice) they do', () => {
  const t = granted();
  const [line] = debits(t, [1400]);
  receipt(t, { amount: 1400, vendor: TELCO, date: dateOf(t, line) });
  for (let i = 0; i < 3; i++) t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], 'agent-read figures back no unattended booking');
  assert.equal(decisionOf(t, line), undefined);
  assert.deepEqual(waitingOf(t), [[line, 'no_beleg']]);
  // The agent can neither confirm the figures nor switch the trust mode.
  const r2 = receipt(t, { amount: 1400, vendor: 'Nebenlieferant AG', date: '2026-03-01' });
  assert.equal(agentMcp(t, 'confirm_capture_figures', { captures: [seenOf(t, r2.captureId)], idempotencyKey: 'ag-c' }).error, 'human_only');
  assert.equal(agentMcp(t, 'settings_set', { key: 'belege.autobook_figure_trust', value: 'agent', reason: 'x', idempotencyKey: 'ag-s' }).error, 'human_only');
  must(settingsSet(t.ctx, { key: 'belege.autobook_figure_trust', value: 'agent', reason: 'owner accepts the risk', idempotencyKey: 'ft-agent' }));
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked', 'under agent the same receipt backs the booking');
});

test('H2: a person releases, the agent edits the figures back and forth, and no assignment comes back', () => {
  const t = granted();
  const [held] = debits(t, [1420]);
  const r2 = confirmedReceipt(t, { amount: 1420, vendor: TELCO, date: dateOf(t, held) });
  // The engine pass alone (no booking yet); a person then says "not this line's".
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, held)?.source, 'engine_unique', 'precondition: the engine assigned the line');
  must(verb(t, 'release_beleg', { bankTxnId: held }));
  // v3 reason table: an explicit "Lösen" of an ENGINE row records person_rejected (it blocks that pair).
  assert.deepEqual(states(t, held).at(-1), ['engine_unique', 'released', 'person_rejected']);
  const edit = (minor, k) =>
    must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId: r2.captureId, source: 'agent', fields: [{ key: 'amount', value: { minor, currency: 'CHF' }, confidence: 'high' }], idempotencyKey: k }));
  edit(1421, 'h2-a');
  t.ap.tick();
  edit(1420, 'h2-b');
  t.ap.tick();
  t.ap.tick();
  assert.equal(activeOf(t, held), undefined, 'only a person re-assigns what a person released');
  assert.equal(decisionOf(t, held), undefined);
  // A person re-assigning lifts it.
  must(assignBeleg(t, held, [r2.fileId]));
  t.ap.tick();
  assert.equal(decisionOf(t, held)?.state, 'booked');
});

test('H3: assign, ignore, reopen, then the next tick assigns again', () => {
  const t = granted();
  // Over the ceiling: the rule never books it, so the assignment itself is what the probe sees.
  const [line] = debits(t, [90000]);
  const r = confirmedReceipt(t, { amount: 90000, vendor: TELCO, date: dateOf(t, line) });
  t.ap.tick();
  assert.equal(activeOf(t, line)?.source, 'engine_unique');
  must(ignoreBankLine(t.ctx, { bankTxnId: line, reason: 'booked_elsewhere', note: 'probe', idempotencyKey: 'h3-ign' }));
  assert.deepEqual(states(t, line), [['engine_unique', 'released', 'line_ignored']]);
  must(reopenBankLine(t.ctx, { bankTxnId: line, reason: 'doch', idempotencyKey: 'h3-re' }));
  t.ap.tick();
  assert.deepEqual(states(t, line), [['engine_unique', 'released', 'line_ignored'], ['engine_unique', 'active', null]], 'an ignore is no person release');
  assert.equal(activeOf(t, line) !== undefined && JSON.stringify(t.store.db.prepare('SELECT file_id FROM beleg_assignment_file WHERE assignment_id = ?').all(activeOf(t, line).id)), JSON.stringify([{ file_id: r.fileId }]));
});

test('H4: assign, then capture_commit to a bill, then a tick: no booking, and the assignment is released', () => {
  const t = granted();
  const [line] = debits(t, [1430]);
  const r = confirmedReceipt(t, { amount: 1430, vendor: TELCO, date: dateOf(t, line) });
  // Assign without booking: the engine pass alone. (A PERSON's assignment files the document on the line,
  // and capture_commit then refuses document_already_linked: a person who assigned it unassigns first.)
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, line)?.source, 'engine_unique');
  void r;
  const vendor = must(getAction('create_contact').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, partyRole: 'vendor', name: TELCO, idempotencyKey: 'h4-v' })).contact.id;
  must(getAction('capture_commit').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: r.captureId, target: { kind: 'vendor_bill', vendorId: vendor, billDate: dateOf(t, line), expenseAccountId: t.acc('6570') }, idempotencyKey: 'h4-c' }));
  assert.deepEqual(states(t, line), [['engine_unique', 'released', 'capture_committed']]);
  const entries = entryCount(t);
  t.ap.tick();
  assert.equal(decisionOf(t, line), undefined, 'the line follows the bill\'s payment, never a second expense');
  assert.equal(entryCount(t), entries);
  assert.deepEqual(waitingOf(t), [[line, 'no_beleg']]);
});

test('H5: the engine assigns G to L2, then a person assigns G to L1, and L1 wins', () => {
  const t = granted();
  // L1 lies far before G's date (no candidate), L2 next to it.
  const [l1] = debits(t, [1440], { from: '2026-04-01' });
  const [l2] = debits(t, [1440], { from: '2026-07-18' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-open' }));
  const g = confirmedReceipt(t, { amount: 1440, vendor: TELCO, date: '2026-07-18' });
  // The engine pass alone, so the probe can look before anything books.
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, l2)?.source, 'engine_unique', 'precondition: the engine paired G with L2');
  must(assignBeleg(t, l1, [g.fileId]));
  // v3 reason table: an assign_beleg replacing an ENGINE row records person_rejected.
  assert.deepEqual(states(t, l2), [['engine_unique', 'released', 'person_rejected']]);
  assert.equal(activeOf(t, l1)?.source, 'person');
  t.ap.tick();
  assert.equal(decisionOf(t, l1)?.state, 'booked', 'L1 books with G');
  assert.equal(decisionOf(t, l2), undefined, 'L2 never gets G back');
  assert.deepEqual(states(t, l2), [['engine_unique', 'released', 'person_rejected']], 'the engine never replaces a person');
});

test('H6: L1 holds a person assignment, a new G2 fits L1 and L2, and L2 books', () => {
  const t = granted();
  const [l1, l2] = debits(t, [1450, 1450], { from: '2026-07-15' });
  const g1 = receipt(t, { amount: 1450, vendor: TELCO, date: '2026-03-01' });
  must(assignBeleg(t, l1, [g1.fileId]));
  // G2 sits between the two lines: it fits both by amount, date and sender.
  confirmedReceipt(t, { amount: 1450, vendor: TELCO, date: '2026-07-17' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-h6' }));
  t.ap.tick();
  assert.equal(decisionOf(t, l2)?.state, 'booked', 'L1 is no claimant: G2 fits L2 alone');
  assert.equal(decisionOf(t, l1)?.state, 'booked', 'and L1 books with its own person assignment');
  assert.deepEqual(states(t, l1), [['person', 'consumed', null]]);
  assert.deepEqual(states(t, l2), [['engine_unique', 'consumed', null]]);
});

test('H7: the one-time migration turns a person-filed receipt on an open line into a person assignment, and the tick books', () => {
  const t = granted();
  const [mine, agents, legacy] = debits(t, [1460, 1470, 1480], { from: '2026-07-10' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-h7' }));
  const r1 = receipt(t, { amount: 1460, vendor: TELCO, date: '2026-02-01' });
  const r2 = receipt(t, { amount: 1470, vendor: TELCO, date: '2026-02-01' });
  const r3 = receipt(t, { amount: 1480, vendor: TELCO, date: '2026-02-01' });
  const link = (fileId, line, actor) => must(getAction('files_link').run({ ...t.deps, actor }, { workspaceId: t.workspaceId, fileId, entityKind: 'bank_txn', entityId: line, idempotencyKey: `h7-${line}` }));
  link(r1.fileId, mine, 'user_1');
  // The agent files under an open dial (its link records a machine seat).
  must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability: 'close-period', level: 'auto', idempotencyKey: 'h7-dial' }));
  const ag = handleRest('files_link', { workspaceId: t.workspaceId, fileId: r2.fileId, entityKind: 'bank_txn', entityId: agents, idempotencyKey: 'h7-ag' }, { ...t.deps, actor: 'agent' }).body;
  assert.equal(ag.ok, true, JSON.stringify(ag));
  // A row from before this build: no recorded filer.
  link(r3.fileId, legacy, 'user_1');
  t.store.db.prepare('UPDATE stored_file SET linked_by = NULL, linked_by_seat = NULL WHERE id = ?').run(r3.fileId);
  const migration = DATA_MIGRATIONS.find((m) => m.generation === 19);
  // The store runs every data migration inside its open transaction.
  t.store.db.transaction(() => migration.apply(t.store.db))();
  t.store.db.transaction(() => migration.apply(t.store.db))();
  assert.deepEqual(states(t, mine), [['person', 'active', null]], 'a provable person filing becomes the person assignment (once)');
  assert.deepEqual(assignmentsOf(t, agents), [], 'an agent filing stays for a person to assign');
  assert.deepEqual(assignmentsOf(t, legacy), [], 'an unattributable legacy filing stays for a person to assign');
  t.ap.tick();
  assert.equal(decisionOf(t, mine)?.state, 'booked');
  assert.equal(decisionOf(t, agents), undefined);
  assert.equal(decisionOf(t, legacy), undefined);
});

test('H8: an agent calling assign_beleg over REST, MCP, G01 and a plugin is refused human_only, nothing drafted', () => {
  const t = granted();
  const [line] = debits(t, [1490]);
  const r = receipt(t, { amount: 1490, vendor: TELCO, date: dateOf(t, line) });
  const input = { workspaceId: t.workspaceId, bankTxnId: line, fileIds: [r.fileId] };
  for (const [name, extra] of [['assign_beleg', {}], ['release_beleg', { fileIds: undefined }], ['confirm_capture_figures', { captures: [seenOf(t, r.captureId)], bankTxnId: undefined, fileIds: undefined }]]) {
    const args = { ...input, ...extra, idempotencyKey: `h8-${name}` };
    assert.equal(handleRest(name, args, { ...t.deps, actor: 'agent' }).body.error, 'human_only', `REST ${name}`);
    assert.equal(agentMcp(t, name, args).error, 'human_only', `MCP ${name}`);
    for (const capability of ['post', 'close-period', 'customize']) {
      must(getAction('set_agent_dial').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, capability, level: 'auto', idempotencyKey: `h8-dial-${capability}-${name}` }));
      assert.equal(agentMcp(t, name, { ...args, idempotencyKey: `h8-${name}-${capability}` }).error, 'human_only', `MCP ${name} under ${capability}=auto`);
    }
    const inPlugin = withinPluginCall('user_1', () => getAction(name).run({ ...t.deps, actor: 'user_1' }, args));
    assert.equal(inPlugin.error, 'human_only', `plugin ${name}`);
    const rule = getAction('create_automation_rule').run({ ...t.deps, actor: 'user_1' }, {
      workspaceId: t.workspaceId,
      name: `Auto ${name}`,
      trigger: { event: 'qr_match.needs_review' },
      action: { tool: name, inputTemplate: args },
      idempotencyKey: `h8-rule-${name}`,
    });
    assert.equal(rule.error, 'action_not_automatable', `G01 ${name}`);
  }
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  assert.equal(assignBelegEngine(agentCtx, { ...input, idempotencyKey: 'h8-engine' }).error, 'human_only', 'the engine refuses, whatever door');
  assert.equal(agentRows(t), 0, 'no Vorschlag from the agent');
  assert.deepEqual(assignmentsOf(t, line), []);
});

test('I-E: a seat without the receipt read right sees one uniform waiting reason and no assignment row', () => {
  const t = granted();
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-ie' }));
  const [none, vat, amount] = debits(t, [1500, 1081, 1520], { from: '2026-07-12' });
  must(assignBeleg(t, vat, [receipt(t, { amount: 1081, vendor: TELCO, date: '2026-03-01', vat: 10 }).fileId]));
  must(assignBeleg(t, amount, [receipt(t, { amount: 9520, vendor: TELCO, date: '2026-03-01' }).fileId]));
  const denying = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (c === 'read_master_data' ? err('permission_denied', { capability: c }) : ok()) },
  });
  const seen = Object.fromEntries(waitingOf(t, denying));
  assert.equal(new Set([seen[none], seen[amount]]).size, 1, JSON.stringify(seen));
  assert.equal(seen[none], 'belege_not_readable');
  const lines = must(listBankInbox(denying, { status: 'all' })).lines;
  assert.ok(lines.every((l) => l.belegAssignment === null), 'no assignment row reaches the seat');
  assert.equal(assignBelegEngine(denying, { bankTxnId: none, fileIds: ['x'], idempotencyKey: 'ie' }).error, 'permission_denied');
  // A reader sees the assignment.
  assert.equal(must(listBankInbox(t.ctx, { bankTxnId: amount, status: 'all' })).lines[0].belegAssignment?.source, 'person');
});

// --- The security review (07.11.2026): a QR code is only as good as who brought the document in ----------

const spc = (amount, message) =>
  [
    'SPC', '0200', '1', TELCO_IBAN,
    'S', TELCO, 'Musterweg', '7', '8000', 'Zürich', 'CH',
    '', '', '', '', '', '', '',
    (amount / 100).toFixed(2), 'CHF',
    '', '', '', '', '', '', '',
    'NON', '', message, 'EPD',
  ].join('\n');

test('QR probe: an agent uploads a QR-bill PDF whose amount fits an open line; under confirmed nothing is assigned and nothing books', () => {
  const t = granted();
  const [line] = debits(t, [1530], { from: '2026-07-19' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-qr' }));
  const up = agentMcp(t, 'capture_document', { contentBase64: Buffer.from(spc(1530, 'Rechnung des Agenten'), 'utf8').toString('base64'), mime: 'application/pdf', filename: 'agent.pdf', idempotencyKey: 'qr-ag' });
  assert.equal(up.ok, true, JSON.stringify(up));
  const live = t.store.db.prepare("SELECT key, provenance FROM capture_fields WHERE capture_id = ? AND key = 'amount' AND superseded = 0").get(up.captureId);
  assert.equal(live?.provenance, 'qr', 'precondition: the engine read the amount off the agent\'s QR bill');
  for (let i = 0; i < 3; i++) t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], 'an agent-brought QR code backs no engine assignment');
  assert.equal(decisionOf(t, line), undefined, 'nothing books');
  const row = must(getAction('get_capture').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: up.captureId })).capture;
  assert.equal(row.figuresTrusted, false);
  // Control: the same kind of bill brought in by a PERSON is trusted, assigned and booked.
  t.store.db.prepare("UPDATE captures SET status = 'discarded', discard_reason = 'probe' WHERE id = ?").run(up.captureId);
  const mine = must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from(spc(1530, 'Rechnung'), 'utf8').toString('base64'), mime: 'application/pdf', filename: 'mine.pdf', idempotencyKey: 'qr-me' }));
  assert.equal(must(getAction('get_capture').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, captureId: mine.captureId })).capture.figuresTrust, 'qr');
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked', 'a person-brought QR bill backs the booking');
});

test('QR probe: a legacy capture with no recorded intake seat fails closed', () => {
  const t = granted();
  const [line] = debits(t, [1540], { from: '2026-07-19' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-qr2' }));
  const mine = must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from(spc(1540, 'Alt'), 'utf8').toString('base64'), mime: 'application/pdf', filename: 'alt.pdf', idempotencyKey: 'qr-old' }));
  t.store.db.prepare('UPDATE captures SET intake_seat = NULL WHERE id = ?').run(mine.captureId);
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), []);
  // A person's confirmation is the way in.
  confirmFigures(t, { captureId: mine.captureId });
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked');
});

test('a confirmation is voided by a later figure change (a person must confirm the new figures)', () => {
  const t = granted();
  const [line] = debits(t, [1550], { from: '2026-07-19' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-cv' }));
  const r = receipt(t, { amount: 9999, vendor: TELCO, date: '2026-07-19' });
  confirmFigures(t, r);
  // The agent rewrites the amount to fit the line after the person confirmed another figure.
  must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId: r.captureId, source: 'agent', fields: [{ key: 'amount', value: { minor: 1550, currency: 'CHF' }, confidence: 'high' }], idempotencyKey: 'cv-ex' }));
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], 'the confirmation named 99.99, not 15.50');
  assert.equal(decisionOf(t, line), undefined);
});

test('QR probe (a): an agent DRAFTS a QR-bill upload, a person approves it, and under confirmed nothing is assigned', () => {
  const t = granted();
  const [line] = debits(t, [1560], { from: '2026-07-19' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-qa' }));
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const drafted = must(
    enqueueDraftedAction(agentCtx, {
      actionTool: 'capture_document',
      payload: { workspaceId: t.workspaceId, contentBase64: Buffer.from(spc(1560, 'Vorschlag des Agenten'), 'utf8').toString('base64'), mime: 'application/pdf', filename: 'vorschlag.pdf', idempotencyKey: 'qa-draft' },
      dialCapability: null,
      idempotencyKey: 'qa-row',
    }),
  );
  // The person approves: the replay runs as the person, but the bytes are still the agent's.
  const approved = must(getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId: drafted.actionId }));
  const captureId = t.store.db.prepare("SELECT id FROM captures WHERE workspace_id = ? AND status = 'needs_review' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(t.workspaceId).id;
  assert.equal(t.store.db.prepare('SELECT intake_seat FROM captures WHERE id = ?').get(captureId).intake_seat, 'machine', JSON.stringify(approved).slice(0, 200));
  for (let i = 0; i < 2; i++) t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], 'an approved agent upload is still the agent\'s QR code');
  assert.equal(decisionOf(t, line), undefined);
});

test('QR probe (b): a folder receipt\'s QR counts under belege.qr_trust_folder = on (default), not under off', () => {
  const t = granted();
  const [line] = debits(t, [1570], { from: '2026-07-19' });
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'probe', idempotencyKey: 'scope-qb' }));
  must(settingsSet(t.ctx, { key: 'belege.qr_trust_folder', value: 'off', reason: 'probe', idempotencyKey: 'qtf-off' }));
  // The Belegeingang scan's own intake (`scanBelegeingang` wraps every capture in withinFolderIntake).
  const folder = withinFolderIntake(() =>
    must(getAction('capture_document').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from(spc(1570, 'Ordner'), 'utf8').toString('base64'), mime: 'application/pdf', filename: 'ordner.pdf', idempotencyKey: 'qb-in' })),
  );
  assert.equal(t.store.db.prepare('SELECT intake_seat FROM captures WHERE id = ?').get(folder.captureId).intake_seat, 'folder');
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], 'off: a folder receipt needs Zahlen bestätigen');
  assert.equal(agentMcp(t, 'settings_set', { key: 'belege.qr_trust_folder', value: 'on', reason: 'x', idempotencyKey: 'ag-qtf' }).error, 'human_only');
  must(settingsSet(t.ctx, { key: 'belege.qr_trust_folder', value: 'on', reason: 'probe', idempotencyKey: 'qtf-on' }));
  t.ap.tick();
  assert.equal(decisionOf(t, line)?.state, 'booked', 'on: the owner\'s own channel counts');
  const scan = readFileSync(new URL('../../src/core/files/belegeingang.ts', import.meta.url), 'utf8');
  assert.match(scan, /withinFolderIntake\(\(\) =>\s*opts\.capture!/, 'the scan marks its intakes');
});

// --- I-B: the positive chokepoint guard -----------------------------------------------------------------

test('I-A/I-B chokepoint: the autobook receipt verdict reads no pool and no filing rows, only the assignment', () => {
  const src = readFileSync(new URL('../../src/core/banking/belegVerdict.ts', import.meta.url), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const banned of ['belegPool', 'belegMatchContext', 'belegCandidatesFor', 'bankLineCandidatesFor', 'filedReceipts', 'liveReceiptHolders', 'entity_kind', 'entity_id', 'capture_settlement', 'linked_by']) {
    assert.equal(code.includes(banned), false, `the verdict reads ${banned}`);
  }
  assert.match(code, /activeAssignmentOf\(ctx, line\.id\)/, 'the verdict starts from the line\'s assignment');
  // Its stored_file and captures reads are by the ids the assignment names, never by a filing link.
  for (const m of code.matchAll(/FROM (stored_file|captures) \w+ WHERE ([^`]*)/g)) assert.match(m[2], /\.id = \?|id = \?/, m[0]);
  // And the only writers of an assignment are the engine pass and the person's verb (plus the store's
  // one-time migration and the lifecycle, which only CLOSE rows).
  const writers = [];
  for (const file of ['banking/belegAssignment.ts', 'banking/belegAssignmentStore.ts', 'banking/autobook.ts', 'files/files.ts', 'files/attach.ts', 'banking/bankLines.ts', 'purchase/capture.ts']) {
    const text = readFileSync(new URL(`../../src/core/${file}`, import.meta.url), 'utf8');
    if (text.includes('INSERT INTO beleg_assignment ')) writers.push(file);
  }
  assert.deepEqual(writers, ['banking/belegAssignmentStore.ts'], 'one insert, in the store leaf');
  const store = readFileSync(new URL('../../src/core/banking/belegAssignment.ts', import.meta.url), 'utf8');
  const callers = [...store.matchAll(/insertAssignment\(/g)].length;
  // Author, A41.3 follow-ups: a third PERSON writer, assign_beleg_file (a filed file captured and assigned in one act).
  assert.equal(callers, 3, 'insertAssignment is called by exactly the engine pass, assign_beleg and assign_beleg_file');
});
