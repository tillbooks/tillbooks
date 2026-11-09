// Critic A41.3 follow-ups r1, probe group 1: I-F (the intake seat) at the new capture door.
//
// I-F (`purchase/intakeSeat.ts`, `banking/belegTrust.ts`): a Swiss QR code backs an UNATTENDED booking only on a
// document a PERSON brought in, because an agent can make a PDF carrying a QR bill of its own; "a person
// approving an agent's upload approves it, the bytes are still the agent's". `captures.intake_seat` records it.
//
// `assign_beleg_file` adds a new capture writer (`captureStoredDocument`) that captures bytes ALREADY STORED and
// stamps `intake_seat = intakeSeatOf(ctx)`, i.e. the seat of the person who clicked "Zuordnen", never the seat
// that brought the bytes in. So an agent's QR bill, captured by this door, reads as person-brought, and once the
// person's own assignment is released (an explicit "Lösen" blocks only that one line/file pair), TILL's engine
// pairs it with another line and autobook posts that line unattended on the agent's word.
//
// SYNTHETIC BY CONSTRUCTION: invented vendor, IBAN (the N04 sample), amounts, dates and bytes.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { listBankInbox } from '../../dist/core/banking/index.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO, TELCO_IBAN } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

let seq = 0;
function world() {
  seq += 1;
  const tag = `c1r1-${seq}`;
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(grantRuleAutobook(t.ctx, { standardId: t.ruleId, idempotencyKey: `${tag}-g` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'test', idempotencyKey: `${tag}-rb` }));
  must(settingsSet(t.ctx, { key: 'rules.autobook_scope', value: 'open_lines', reason: 'test', idempotencyKey: `${tag}-sc` }));
  at(t, '2026-07-20T08:00:00.000Z');
  const agent = (name, input) => handleRest(name, { workspaceId: t.workspaceId, ...input }, { ...t.deps, actor: 'agent' }).body;
  const person = (name, input) => getAction(name).run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, ...input });
  const approve = (actionId) => must(getAction('approve_drafted_action').run({ ...t.deps, actor: 'studio' }, { workspaceId: t.workspaceId, actionId }), 'approve');
  return { t, tag, agent, person, approve };
}

/** A hand-written Swiss QR bill (SPC) the AGENT made, on the sample IBAN, as the bytes of a PDF. */
const agentQrBill = (amount) =>
  Buffer.from(
    ['SPC', '0200', '1', TELCO_IBAN, 'S', TELCO, 'Musterweg', '7', '8000', 'Zürich', 'CH', '', '', '', '', '', '', '', (amount / 100).toFixed(2), 'CHF', '', '', '', '', '', '', '', 'NON', '', `Rechnung ${amount}`, 'EPD'].join('\n'),
    'utf8',
  ).toString('base64');
const raw = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x0c, (n >> 8) & 0xff, n & 0xff, 0x0c, 41]).toString('base64');
const captureOf = (t, fileId) => t.store.db.prepare('SELECT id, intake_seat FROM captures WHERE workspace_id = ? AND document_id = ?').get(t.workspaceId, fileId);
const rows = (t) => t.store.db.prepare('SELECT bank_txn_id, source, state, release_reason FROM beleg_assignment WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);

test('CONTROL (holds): an agent\'s own capture of its QR bill is a machine intake, and TILL never books a line on it unattended', () => {
  const { t, tag, agent } = world();
  const [b] = debits(t, [1250], { from: '2026-07-18' });
  const ci = agent('capture_document', { contentBase64: agentQrBill(1250), mime: 'application/pdf', filename: 'rechnung.pdf', idempotencyKey: `${tag}-ci` });
  assert.equal(ci.ok, true, JSON.stringify(ci));
  assert.equal(t.store.db.prepare('SELECT intake_seat FROM captures WHERE id = ?').get(ci.captureId).intake_seat, 'machine');
  autopilot(t).tick();
  assert.equal(decisionOf(t, b), undefined, 'the agent\'s QR bill backs no unattended booking');
  assert.deepEqual(rows(t), []);
});

test('FAIL (I-F): an agent\'s QR bill a person "Zuordnen"s on line A, then releases, is paired by TILL with line B and booked UNATTENDED', () => {
  const { t, tag, agent, person, approve } = world();
  const [a] = debits(t, [1260], { from: '2026-07-19' });
  const [b] = debits(t, [1250], { from: '2026-07-18' });
  // The agent uploads a QR bill of its own making and files it on the open line A (its link is drafted; the
  // person approves the filing, an ordinary Vorschlag: a file on a line).
  const fileId = agent('files_upload', { contentBase64: agentQrBill(1250), mime: 'application/pdf', filename: 'rechnung.pdf', title: 'Rechnung', idempotencyKey: `${tag}-up` }).file.id;
  const drafted = agent('files_link', { fileId, entityKind: 'bank_txn', entityId: a, idempotencyKey: `${tag}-ln` });
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  approve(drafted.actionId);
  // The Studio's "Zuordnen" of the line's ONE filed file (spec point 3) is assign_beleg_file.
  const res = must(person('assign_beleg_file', { bankTxnId: a, fileId, idempotencyKey: `${tag}-abf` }));
  assert.equal(res.amountFrom, 'receipt');
  // The figures differ from line A (12.50 against 12.60): the person sees "Betrag weicht ab" and clicks "Lösen".
  must(person('release_beleg', { bankTxnId: a, idempotencyKey: `${tag}-rel` }));
  autopilot(t).tick();
  assert.deepEqual(rows(t).filter((r) => r.bank_txn_id === b), [], `TILL must not pair the agent's QR bill with another line on its own: ${JSON.stringify(rows(t))}`);
  assert.equal(decisionOf(t, b), undefined, 'line B was posted UNATTENDED on a QR bill the agent made: the same bytes the control above never books');
});

test('FAIL (I-F): the capture assign_beleg_file makes of an AGENT\'s stored bytes records the person\'s seat, not the bytes\' origin', () => {
  const { t, tag, agent, person, approve } = world();
  const [a] = debits(t, [1250], { from: '2026-07-19' });
  const fileId = agent('files_upload', { contentBase64: agentQrBill(1250), mime: 'application/pdf', filename: 'rechnung.pdf', title: 'Rechnung', idempotencyKey: `${tag}-up` }).file.id;
  approve(agent('files_link', { fileId, entityKind: 'bank_txn', entityId: a, idempotencyKey: `${tag}-ln` }).actionId);
  must(person('assign_beleg_file', { bankTxnId: a, fileId, idempotencyKey: `${tag}-abf` }));
  assert.equal(captureOf(t, fileId).intake_seat, 'machine', 'the bytes are the agent\'s: a person\'s click on them is no person intake (I-F)');
});

test('FAIL (I-F, via the new-version mark): "Neue Version, bitte zuordnen" names an AGENT\'s version, and its "Zuordnen" captures it as a person intake', () => {
  const { t, tag, agent, person, approve } = world();
  const [a] = debits(t, [1250], { from: '2026-07-19' });
  const r = receipt(t, { amount: 1250, vendor: TELCO, date: '2026-07-19' });
  must(assignBeleg(t, a, [r.fileId]));
  must(settingsSet(t.ctx, { key: 'belege.assigned_move', value: 'move', reason: 'test', idempotencyKey: `${tag}-mv` }));
  const personHead = must(person('files_new_version', { fileId: r.fileId, contentBase64: raw(5101), mime: 'image/png', idempotencyKey: `${tag}-nv` })).file.id;
  // The released line holds an unassigned head; an agent proposes a further version of it, the person approves.
  const nv = agent('files_new_version', { fileId: personHead, contentBase64: raw(5102), mime: 'image/png', idempotencyKey: `${tag}-ag-nv` });
  assert.equal(nv.drafted, true, JSON.stringify(nv));
  const agentHead = approve(nv.actionId).result.file.id;
  const mark = must(listBankInbox(t.ctx, { bankTxnId: a, status: 'all' })).lines[0].newVersionToAssign;
  assert.deepEqual(mark, { fileId: agentHead }, 'observed: the mark names the agent\'s version as the person\'s "new version"');
  must(person('assign_beleg_file', { bankTxnId: a, fileId: agentHead, idempotencyKey: `${tag}-abf` }));
  assert.equal(captureOf(t, agentHead).intake_seat, 'machine', 'the agent\'s bytes are captured as a person intake');
});
