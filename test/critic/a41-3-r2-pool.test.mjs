// Critic A41.3 r2 (non-author), probe group P: robustness of the engine pass and the reads that share the
// matcher, against values a governed seat may type into a capture.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { grantRuleAutobook } from '../../dist/core/banking/autobook.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, autopilot, decisionOf, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, confirmedReceipt } from '../banking/a41-beleg-support.mjs';

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
const capture = (fn) => {
  try {
    return { value: fn(), thrown: null };
  } catch (e) {
    return { value: null, thrown: String(e?.message ?? e) };
  }
};

test('P1: one capture an agent dates 2026-13-01 (well-formed, not a day) takes down the engine pass, every autobooking of the workspace, and list_captures', () => {
  const t = granted('p1');
  // Author, r2 fix P1: 14.60, inside the grant's ceiling (1960 was over it, so the line could never autobook).
  const [line] = debits(t, [1460], { from: '2026-07-19' });
  // A line with its own person-confirmed receipt: it must book whatever the agent types elsewhere.
  confirmedReceipt(t, { amount: 1460, vendor: TELCO, date: dateOf(t, line) });
  // The agent's own, untrusted capture: it can never back a booking, only sit in the pool.
  const junk = receipt(t, { amount: 4242, vendor: 'Irgendwer AG', date: '2026-07-01' });
  // Author, r2 fix P1: the engine write now refuses it (invalid_date) ...
  const typed = getAction('capture_extract').run({ ...t.deps, actor: 'agent' }, { workspaceId: t.workspaceId, captureId: junk.captureId, source: 'agent', fields: [{ key: 'invoice_date', value: '2026-13-01', confidence: 'high' }], idempotencyKey: 'p1-x' });
  assert.deepEqual([typed.error, typed.key], ['invalid_date', 'invoice_date']);
  // ... so the probe plants it as a LEGACY row (written before the guard) to keep biting the readers.
  t.store.db.prepare("UPDATE capture_fields SET value = '\"2026-13-01\"' WHERE capture_id = ? AND key = 'invoice_date' AND superseded = 0").run(junk.captureId);
  const pass = capture(() => reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL));
  t.ap.tick();
  const list = capture(() => getAction('list_captures').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId }));
  assert.deepEqual(
    { pass: pass.thrown, booked: decisionOf(t, line)?.state ?? null, listCaptures: list.thrown ?? (list.value.ok ? 'ok' : list.value.error) },
    { pass: null, booked: 'booked', listCaptures: 'ok' },
    'a typed date that is no calendar day must not throw out of the shared matcher',
  );
});
