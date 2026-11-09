// Critic A41.3 follow-ups r1, probe group 2: the author's own list (book-again, the beleg_already_captured order,
// assignHumanOnly over all four verbs) plus idempotency on ROWS after a refusal.
//
// SYNTHETIC BY CONSTRUCTION: invented vendor, amounts, dates and bytes.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { enqueueDraftedAction } from '../../dist/core/agent/draftedActions.js';
import { grantRuleAutobook, autobookDigest } from '../../dist/core/banking/autobook.js';
import { assignBelegFile, releaseBeleg, confirmCaptureFigures, assignBeleg as assignBelegCore } from '../../dist/core/banking/belegAssignment.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { getFileContent } from '../../dist/core/files/index.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg, seenOf, activeOf } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

let seq = 0;
function world() {
  seq += 1;
  const tag = `c2r1-${seq}`;
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `${tag}-g` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'test', idempotencyKey: `${tag}-rb` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'test', idempotencyKey: `${tag}-sc` }));
  at(t, '2026-07-20T08:00:00.000Z');
  const person = (name, input, actor = 'user_1') => getAction(name).run({ ...t.deps, actor }, { workspaceId: t.workspaceId, ...input });
  return { t, tag, person };
}
const raw = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0d, (n >> 8) & 0xff, n & 0xff, 0x0d, 41]).toString('base64');
const upload = (w, content, k) => must(w.person('files_upload', { contentBase64: content, mime: 'image/png', filename: `${k}.png`, title: k, idempotencyKey: `${w.tag}-${k}` })).file.id;
const count = (t, table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;
const snap = (t) => ({ captures: count(t, 'captures'), assignments: count(t, 'beleg_assignment'), overrides: count(t, 'receipt_override'), fields: count(t, 'capture_fields'), decisions: count(t, 'bank_line_decision') });

// --- 1. Book-again over bytes a live booking holds ----------------------------------------------------------------

/** A person's drop of bytes already booked on another line, confirmed with bookAgain and a reason. */
function bookAgainWorld() {
  const w = world();
  const [booked] = debits(w.t, [1250], { from: '2026-07-05' });
  bookAsProposed(w.t, booked);
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const content = raw(4711);
  must(w.person('files_link', { fileId: upload(w, content, 'u1'), entityKind: 'bank_txn', entityId: booked, idempotencyKey: `${w.tag}-l1` }));
  const res = must(w.person('assign_beleg_file', { bankTxnId: line, fileId: upload(w, content, 'u2'), bookAgain: true, overrideReason: 'Zweite Rate desselben Belegs', idempotencyKey: `${w.tag}-d` }));
  return { ...w, line, res };
}

test('HOLDS (fail-safe): a person\'s book-again drop is recorded, but autobook never posts the duplicate unattended; the person can still book by hand', () => {
  const w = bookAgainWorld();
  assert.equal(w.res.amountFrom, 'line');
  assert.equal(activeOf(w.t, w.line)?.source, 'person');
  const before = snap(w.t);
  const report = autopilot(w.t).tick();
  assert.equal(decisionOf(w.t, w.line), undefined, 'the person\'s bookAgain is not the granter\'s: no unattended duplicate');
  assert.deepEqual({ ...snap(w.t) }, before, 'the refused attempt rolled back whole (no decision, no consumption)');
  assert.equal(activeOf(w.t, w.line)?.source, 'person', 'the assignment stands');
  void report;
});

test('FAIL (LOW): the line that waits beleg_in_use every tick is listed in the person\'s waiting list (autobook_digest waitingForBeleg)', () => {
  const w = bookAgainWorld();
  autopilot(w.t).tick();
  autopilot(w.t).tick();
  assert.equal(decisionOf(w.t, w.line), undefined);
  const waiting = must(autobookDigest(w.t.ctx, {})).waitingForBeleg.filter((x) => x.bankTxnId === w.line);
  assert.deepEqual(
    waiting.map((x) => x.reason),
    ['beleg_in_use'],
    'a person-assigned line that autobook retries and rolls back on every tick is shown nowhere: "Von dir zugeordnet" and never booked, silently',
  );
});

// --- 2. beleg_already_captured before the hold plan and the receipt guard ----------------------------------------

test('HOLDS: bytes already captured elsewhere are refused before any write, even when a person assignment holds them (no ordering hole)', () => {
  const w = world();
  const [held] = debits(w.t, [1250], { from: '2026-07-19' });
  const [other] = debits(w.t, [1250], { from: '2026-07-18' });
  const r = receipt(w.t, { amount: 1250, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(w.t, held, [r.fileId]));
  const bytes = must(getFileContent(w.t.ctx, { fileId: r.fileId })).contentBase64;
  const twin = upload(w, bytes, 'twin');
  const before = snap(w.t);
  const res = w.person('assign_beleg_file', { bankTxnId: other, fileId: twin, idempotencyKey: `${w.tag}-tw` });
  assert.equal(res.error, 'beleg_already_captured', JSON.stringify(res));
  assert.deepEqual(snap(w.t), before);
  assert.equal(activeOf(w.t, held)?.source, 'person', 'the holder is untouched');
  // A plugin or an agent never even reaches this order: human_only answers first.
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  assert.equal(assignBelegFile(agentCtx, { bankTxnId: other, fileId: twin, idempotencyKey: `${w.tag}-ag` }).error, 'human_only');
});

// --- 3. Idempotency on ROWS after a refusal ----------------------------------------------------------------------

test('HOLDS: a refused drop retried with the SAME key and the missing confirmation runs once; a further retry replays and writes nothing', () => {
  const w = world();
  const [booked] = debits(w.t, [1250], { from: '2026-07-05' });
  bookAsProposed(w.t, booked);
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const content = raw(4712);
  must(w.person('files_link', { fileId: upload(w, content, 'b1'), entityKind: 'bank_txn', entityId: booked, idempotencyKey: `${w.tag}-l1` }));
  const twin = upload(w, content, 'b2');
  const key = `${w.tag}-same`;
  const before = snap(w.t);
  assert.equal(w.person('assign_beleg_file', { bankTxnId: line, fileId: twin, idempotencyKey: key }).error, 'receipt_already_booked');
  assert.deepEqual(snap(w.t), before, 'the refusal wrote nothing (and memoised nothing that would replay it)');
  const ok1 = must(w.person('assign_beleg_file', { bankTxnId: line, fileId: twin, idempotencyKey: key, bookAgain: true, overrideReason: 'Teilzahlung' }));
  const after = snap(w.t);
  assert.equal(after.assignments, before.assignments + 1);
  assert.equal(after.overrides, before.overrides + 1);
  const ok2 = must(w.person('assign_beleg_file', { bankTxnId: line, fileId: twin, idempotencyKey: key, bookAgain: true, overrideReason: 'Teilzahlung' }));
  assert.deepEqual(ok2, ok1);
  assert.deepEqual(snap(w.t), after);
});

// --- 4. assignHumanOnly over all four receipt verbs -------------------------------------------------------------

test('HOLDS: assignHumanOnly lets a person run all four verbs, and refuses the system seat and a person approving an agent\'s draft of any of them', () => {
  const w = world();
  const [line] = debits(w.t, [1250], { from: '2026-07-19' });
  const [line2] = debits(w.t, [1250], { from: '2026-07-18' });
  const r = receipt(w.t, { amount: 1250, vendor: TELCO, date: '2026-07-19' });
  const sys = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'system', clock: w.t.clock, ids: w.t.ids });
  const before = snap(w.t);
  assert.equal(assignBelegCore(sys, { bankTxnId: line, fileIds: [r.fileId], idempotencyKey: `${w.tag}-s1` }).error, 'human_only');
  assert.equal(assignBelegFile(sys, { bankTxnId: line, fileId: r.fileId, idempotencyKey: `${w.tag}-s2` }).error, 'human_only');
  assert.equal(releaseBeleg(sys, { bankTxnId: line, idempotencyKey: `${w.tag}-s3` }).error, 'human_only');
  assert.equal(confirmCaptureFigures(sys, { captures: [seenOf(w.t, r.captureId)], idempotencyKey: `${w.tag}-s4` }).error, 'human_only');
  assert.deepEqual(snap(w.t), before);
  const agentCtx = makeContext(w.t.store, { workspaceId: w.t.workspaceId, actor: 'agent', clock: w.t.clock, ids: w.t.ids });
  const approveDraft = (tool, payload, k) => {
    const d = enqueueDraftedAction(agentCtx, { actionTool: tool, payload: { workspaceId: w.t.workspaceId, ...payload }, dialCapability: null, idempotencyKey: `${w.tag}-dr-${k}` });
    assert.equal(d.ok, true, `precondition ${tool}`);
    return getAction('approve_drafted_action').run({ ...w.t.deps, actor: 'studio' }, { workspaceId: w.t.workspaceId, actionId: d.actionId });
  };
  for (const [tool, payload] of [
    ['assign_beleg', { bankTxnId: line, fileIds: [r.fileId], idempotencyKey: `${w.tag}-a1` }],
    ['assign_beleg_file', { bankTxnId: line, fileId: r.fileId, idempotencyKey: `${w.tag}-a2` }],
    ['confirm_capture_figures', { captures: [seenOf(w.t, r.captureId)], idempotencyKey: `${w.tag}-a4` }],
  ]) {
    const res = approveDraft(tool, payload, tool);
    assert.equal(res.error, 'human_only', `${tool}: ${JSON.stringify(res)}`);
  }
  assert.deepEqual({ ...snap(w.t), fields: before.fields }, before);
  // The person's own acts pass, through the Studio seat.
  must(w.person('assign_beleg', { bankTxnId: line, fileIds: [r.fileId], idempotencyKey: `${w.tag}-p1` }, 'studio'));
  const rel = approveDraft('release_beleg', { bankTxnId: line, idempotencyKey: `${w.tag}-a3` }, 'release');
  assert.equal(rel.error, 'human_only', JSON.stringify(rel));
  assert.equal(activeOf(w.t, line)?.source, 'person', 'an approved agent draft never releases a person row');
  must(w.person('release_beleg', { bankTxnId: line, idempotencyKey: `${w.tag}-p2` }, 'studio'));
  must(w.person('confirm_capture_figures', { captures: [seenOf(w.t, r.captureId)], idempotencyKey: `${w.tag}-p3` }, 'studio'));
  const f = upload(w, raw(4713), 'p4');
  must(w.person('assign_beleg_file', { bankTxnId: line2, fileId: f, idempotencyKey: `${w.tag}-p4` }, 'studio'));
  assert.equal(activeOf(w.t, line2)?.source, 'person');
});
