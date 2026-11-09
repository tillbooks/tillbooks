// Critic A41.3 follow-ups r2: the bytes' origin (`stored_file.intake_seat`) behind `isFreshPersonDrop` and
// `storedBytesSeat`, attacked at every way an agent's bytes can enter a stored row, plus F2's read-only guard
// under I-E.
//
// SYNTHETIC BY CONSTRUCTION: invented vendor, IBAN (the N04 sample), amounts, dates and bytes.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { handleDropCall } from '../../dist/api/drop-face.js';
import { makeContext } from '../../dist/core/context.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { err, ok } from '../../dist/core/result.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, proposalOf, at, TELCO, TELCO_IBAN } from '../banking/n04-autobook-support.mjs';

afterEach(assertClaimInvariantHolds);

let seq = 0;
function world() {
  seq += 1;
  const tag = `c3r2-${seq}`;
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `${tag}-g` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'test', idempotencyKey: `${tag}-rb` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'test', idempotencyKey: `${tag}-sc` }));
  at(t, '2026-07-20T08:00:00.000Z');
  const agent = (name, input) => handleRest(name, { workspaceId: t.workspaceId, ...input }, { ...t.deps, actor: 'agent' }).body;
  const person = (name, input, actor = 'user_1') => getAction(name).run({ ...t.deps, actor }, { workspaceId: t.workspaceId, ...input });
  const approve = (actionId) => must(getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId }), 'approve');
  const agentCtx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids });
  const draft = (tool, payload, k) => {
    const d = enqueueDraftedAction(agentCtx, { actionTool: tool, payload: { workspaceId: t.workspaceId, ...payload }, dialCapability: null, idempotencyKey: `${tag}-dr-${k}` });
    assert.equal(d.ok, true, `precondition: a draft of ${tool}`);
    return d.actionId;
  };
  return { t, tag, agent, person, approve, draft };
}

const raw = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0e, (n >> 8) & 0xff, n & 0xff, 0x0e, 41]);
const qrBill = (amount) =>
  Buffer.from(['SPC', '0200', '1', TELCO_IBAN, 'S', TELCO, 'Musterweg', '7', '8000', 'Zürich', 'CH', '', '', '', '', '', '', '', (amount / 100).toFixed(2), 'CHF', '', '', '', '', '', '', '', 'NON', '', `Rechnung ${amount}`, 'EPD'].join('\n'), 'utf8');
const seatOf = (t, fileId) => t.store.db.prepare('SELECT intake_seat, uploaded_by FROM stored_file WHERE workspace_id = ? AND id = ?').get(t.workspaceId, fileId);
const captureSeat = (t, fileId) => t.store.db.prepare('SELECT intake_seat FROM captures WHERE workspace_id = ? AND document_id = ?').get(t.workspaceId, fileId)?.intake_seat;
const count = (t, table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;

// --- 1. Can an agent's bytes look like a person's fresh drop? -------------------------------------------------------

test('HOLDS: an agent\'s files_upload, drafted and approved by a person, is a machine row: no line amount, a machine capture', () => {
  const w = world();
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const fileId = w.approve(w.draft('files_upload', { contentBase64: raw(9201).toString('base64'), mime: 'image/png', filename: 'a.png', title: 'A', idempotencyKey: `${w.tag}-up` }, 'up')).result.file.id;
  assert.equal(seatOf(w.t, fileId).intake_seat, 'machine');
  const res = must(w.person('assign_beleg_file', { bankTxnId: line, fileId, idempotencyKey: `${w.tag}-abf` }));
  assert.equal(res.notAssigned, 'beleg_without_amount', 'an approved agent upload never takes the line amount');
  assert.equal(captureSeat(w.t, fileId), 'machine');
});

test('HOLDS: an agent\'s chunked upload (begin, chunk, commit) is a machine row, and so is a person\'s approval of the agent\'s drafted commit', () => {
  const w = world();
  const bytes = qrBill(1250);
  const sha = createHash('sha256').update(bytes).digest('hex');
  const begin = (k) => w.agent('files_upload_begin', { name: `q-${k}.pdf`, mediaType: 'application/pdf', sizeBytes: bytes.byteLength, intent: 'migration_source', idempotencyKey: `${w.tag}-b-${k}` });
  const b1 = begin(1);
  assert.equal(typeof b1.uploadId, 'string', JSON.stringify(b1));
  assert.equal(w.agent('files_upload_chunk', { uploadId: b1.uploadId, seq: 0, contentBase64: bytes.toString('base64'), idempotencyKey: `${w.tag}-c-1` }).ok, true);
  const c1 = w.agent('files_upload_commit', { uploadId: b1.uploadId, sha256: sha, idempotencyKey: `${w.tag}-m-1` });
  const f1 = c1.file?.id ?? w.approve(c1.actionId).result.file.id;
  assert.equal(seatOf(w.t, f1).intake_seat, 'machine', 'the agent committed its own bytes');
  // The agent stages, and drafts the commit; a person approves it.
  const b2 = begin(2);
  const bytes2 = qrBill(1260);
  w.agent('files_upload_chunk', { uploadId: b2.uploadId, seq: 0, contentBase64: bytes2.toString('base64'), idempotencyKey: `${w.tag}-c-2` });
  const f2 = w.approve(w.draft('files_upload_commit', { uploadId: b2.uploadId, sha256: createHash('sha256').update(bytes2).digest('hex'), idempotencyKey: `${w.tag}-m-2` }, 'commit')).result.file.id;
  assert.equal(seatOf(w.t, f2).intake_seat, 'machine', 'an approved agent commit is the agent\'s');
});

test('HOLDS: a twin filing row of an agent\'s bytes and an agent\'s new version carry the machine origin', () => {
  const w = world();
  const [booked] = debits(w.t, [1250], { from: '2026-07-05' });
  bookAsProposed(w.t, booked);
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const fileId = w.agent('files_upload', { contentBase64: raw(9301).toString('base64'), mime: 'image/png', filename: 'b.png', title: 'B', idempotencyKey: `${w.tag}-up` }).file.id;
  assert.equal(seatOf(w.t, fileId).intake_seat, 'machine');
  // An agent's new version of a person's fresh upload is a machine row (and version 2, so never a fresh drop).
  const mine = must(w.person('files_upload', { contentBase64: raw(9302).toString('base64'), mime: 'image/png', filename: 'm.png', title: 'M', idempotencyKey: `${w.tag}-mine` })).file.id;
  assert.equal(seatOf(w.t, mine).intake_seat, 'person');
  const nv = w.agent('files_new_version', { fileId: mine, contentBase64: raw(9303).toString('base64'), mime: 'image/png', idempotencyKey: `${w.tag}-nv` });
  const head = nv.file?.id ?? w.approve(nv.actionId).result.file.id;
  assert.equal(seatOf(w.t, head).intake_seat, 'machine');
  const res = must(w.person('assign_beleg_file', { bankTxnId: line, fileId: head, idempotencyKey: `${w.tag}-abf` }));
  assert.equal(res.notAssigned, 'beleg_without_amount');
  assert.equal(captureSeat(w.t, head), 'machine');
  // A twin row of the agent's bytes (the attach seam onto the booked line) copies the source's origin.
  const twinOf = w.t.store.db.prepare('SELECT id FROM stored_file WHERE workspace_id = ? AND sha256 = (SELECT sha256 FROM stored_file WHERE id = ?) AND id <> ?');
  must(w.person('files_link', { fileId, entityKind: 'bank_txn', entityId: booked, idempotencyKey: `${w.tag}-l` }));
  for (const r of twinOf.all(w.t.workspaceId, fileId, fileId)) assert.equal(seatOf(w.t, r.id).intake_seat, 'machine', 'a twin is the same bytes');
});

test('HOLDS (fail closed): a legacy row with no origin is no fresh drop and is captured as a machine intake', () => {
  const w = world();
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const fileId = must(w.person('files_upload', { contentBase64: qrBill(1250).toString('base64'), mime: 'application/pdf', filename: 'l.pdf', title: 'L', idempotencyKey: `${w.tag}-up` })).file.id;
  w.t.store.db.prepare('UPDATE stored_file SET intake_seat = NULL, uploaded_by = NULL WHERE id = ?').run(fileId);
  const res = must(w.person('assign_beleg_file', { bankTxnId: line, fileId, idempotencyKey: `${w.tag}-abf` }));
  assert.equal(res.amountFrom, 'receipt', 'its own QR amount still assigns it');
  assert.equal(captureSeat(w.t, fileId), 'machine', 'unknown origin is never a person intake');
});

// --- 2. pendingOrigin: a PERSON's drop onto an agent's Vorschlag ---------------------------------------------------

test('NOTE (fail closed, not a defect): a person\'s own drop onto an agent\'s pending Vorschlag is stamped machine on approval', () => {
  const w = world();
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const drafted = w.agent('book_bank_line', { bankTxnId: line, target: proposalOf(w.t, line).target, idempotencyKey: `${w.tag}-bk` });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  const minted = w.agent('files_drop_link', { target: { kind: 'drafted_action', id: drafted.actionId }, idempotencyKey: `${w.tag}-dl` });
  assert.equal(typeof minted.token, 'string', JSON.stringify(minted));
  const dropped = handleDropCall({ ...w.t.deps, actor: 'studio' }, 'redeem', { token: minted.token, contentBase64: raw(9401).toString('base64'), filename: 'quittung.png' });
  assert.equal(dropped.status, 200, JSON.stringify(dropped));
  assert.equal(w.t.store.db.prepare('SELECT source FROM stored_file_pending WHERE id = ?').get(dropped.body.fileId).source, 'drop', 'the engine knows a person dropped it');
  w.approve(drafted.actionId);
  assert.equal(decisionOf(w.t, line)?.state, 'booked');
  // The line is booked and the file evidences it; the machine stamp only withholds the line-amount convenience
  // and QR trust from these bytes later (a reopened line asks for the amount). Fail closed, no money-path hole.
  assert.equal(seatOf(w.t, dropped.body.fileId).intake_seat, 'machine');
});

// --- 3. F2's read-only guard under I-E ----------------------------------------------------------------------------

test('HOLDS: the beleg_in_use listing writes nothing, and a seat without the receipt read right sees only belege_not_readable', () => {
  const w = world();
  const [booked] = debits(w.t, [1250], { from: '2026-07-05' });
  bookAsProposed(w.t, booked);
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const content = raw(9501).toString('base64');
  const up = (k) => must(w.person('files_upload', { contentBase64: content, mime: 'image/png', filename: `${k}.png`, title: k, idempotencyKey: `${w.tag}-${k}` })).file.id;
  must(w.person('files_link', { fileId: up('u1'), entityKind: 'bank_txn', entityId: booked, idempotencyKey: `${w.tag}-l1` }));
  must(w.person('assign_beleg_file', { bankTxnId: line, fileId: up('u2'), bookAgain: true, overrideReason: 'Zweite Rate', idempotencyKey: `${w.tag}-d` }));
  const tables = ['receipt_override', 'audit_log', 'beleg_assignment', 'bank_line_decision', 'idempotency', 'captures', 'stored_file'];
  const before = Object.fromEntries(tables.map((x) => [x, count(w.t, x)]));
  const reader = must(autobookDigest(w.t.ctx, {})).waitingForBeleg.filter((x) => x.bankTxnId === line);
  assert.deepEqual(reader.map((x) => x.reason), ['beleg_in_use']);
  for (const denied of ['read_master_data']) {
    const ctx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'user_1', clock: w.t.clock, ids: w.t.ids, capabilities: { assert: (c) => (c === denied ? err('permission_denied', { capability: c }) : ok()) } });
    const shown = must(autobookDigest(ctx, {})).waitingForBeleg.filter((x) => x.bankTxnId === line);
    assert.deepEqual(shown.map((x) => x.reason), ['belege_not_readable'], denied);
    assert.equal(JSON.stringify(shown).includes(booked), false, 'the holding line is never named');
  }
  assert.deepEqual(Object.fromEntries(tables.map((x) => [x, count(w.t, x)])), before, 'the read-only guard recorded nothing');
  autopilot(w.t).tick();
  assert.equal(decisionOf(w.t, line), undefined, 'and the step still never books the duplicate');
});
