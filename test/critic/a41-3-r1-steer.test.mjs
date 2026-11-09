// Critic A41.3 r1 (non-author), probe group S: can a governed seat STEER which line a person-confirmed
// receipt pairs with, by editing the match keys (vendor name, invoice date) that the confirmation does not
// cover, and get it booked unattended?
//
// The confirmation (`confirm_capture_figures`) covers amount, currency, VAT and the bytes. The pairing reads
// vendor_name (counterparty words) and invoice_date (the date window) too, and an agent may rewrite both
// with `capture_extract source: agent` after the person confirmed, without voiding the trust. A failing
// test here is a proven defect: an unattended booking carries a receipt a governed seat chose for it.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates; no real export is read.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { confirmedReceipt, activeOf, assignmentsOf } from '../banking/a41-beleg-support.mjs';

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
const agentEdit = (t, captureId, fields, k) =>
  must(getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId, source: 'agent', fields, idempotencyKey: k }));
const filedOnLine = (t, line) => t.store.db.prepare("SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'bank_txn' AND entity_id = ?").all(t.workspaceId, line).map((r) => r.id);

test('S1 (vendor steering): an agent renames the vendor of a person-confirmed receipt of ANOTHER vendor, and the granted line books unattended with it', () => {
  const t = granted('s1');
  const [line] = debits(t, [1610], { from: '2026-07-19' });
  // A person confirmed CHF 16.10 on a receipt from a vendor the line has nothing to do with.
  const foreign = confirmedReceipt(t, { amount: 1610, vendor: 'Wolkenhaus Druckerei GmbH', date: dateOf(t, line) });
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), [], 'precondition: the receipt of another vendor fits no line');
  assert.equal(decisionOf(t, line), undefined, 'precondition: the line waits for its receipt');
  // The agent rewrites only the match key; the confirmed figures are untouched, so the trust stands.
  agentEdit(t, foreign.captureId, [{ key: 'vendor_name', value: TELCO, confidence: 'high' }], 's1-steer');
  t.ap.tick();
  const booked = decisionOf(t, line);
  assert.equal(
    booked,
    undefined,
    `a governed seat chose the Beleg of an unattended booking: line booked ${JSON.stringify(booked)} with file ${JSON.stringify(filedOnLine(t, line))}, assignment ${JSON.stringify(assignmentsOf(t, line).map((a) => [a.source, a.state]))}`,
  );
});

test('S2 (date steering): an agent re-dates a person-confirmed July receipt onto the August line of the same subscription, and August books with July\'s Beleg', () => {
  const t = granted('s2');
  const [july] = debits(t, [1620], { from: '2026-06-20' });
  const [august] = debits(t, [1620], { from: '2026-07-19' });
  const julyReceipt = confirmedReceipt(t, { amount: 1620, vendor: TELCO, date: dateOf(t, july) });
  // The engine pass alone: the July receipt is July's line's, uniquely.
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(activeOf(t, july)?.source, 'engine_unique', 'precondition: the engine paired the July receipt with the July line');
  assert.equal(activeOf(t, august), undefined, 'precondition: the August line has no receipt');
  // The agent moves only the date into the August window; amount, currency and bytes are what the person confirmed.
  agentEdit(t, julyReceipt.captureId, [{ key: 'invoice_date', value: dateOf(t, august), confidence: 'high' }], 's2-steer');
  t.ap.tick();
  const booked = decisionOf(t, august);
  assert.equal(
    booked,
    undefined,
    `the August line booked unattended with the July receipt a governed seat re-dated: ${JSON.stringify(booked)}; august rows ${JSON.stringify(assignmentsOf(t, august).map((a) => [a.source, a.state]))}`,
  );
});

test('S3 (control, held): a person-confirmed receipt whose AMOUNT an agent edits is never assigned', () => {
  const t = granted('s3');
  const [line] = debits(t, [1630], { from: '2026-07-19' });
  const r = confirmedReceipt(t, { amount: 1631, vendor: TELCO, date: dateOf(t, line) });
  agentEdit(t, r.captureId, [{ key: 'amount', value: { minor: 1630, currency: 'CHF' }, confidence: 'high' }], 's3-amt');
  t.ap.tick();
  assert.deepEqual(assignmentsOf(t, line), []);
  assert.equal(decisionOf(t, line), undefined);
});
