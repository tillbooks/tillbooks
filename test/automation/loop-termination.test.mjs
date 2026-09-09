/**
 * G01's three loop defences, asserted INDEPENDENTLY, so removing any one of them is caught here.
 *
 * WHY INDEPENDENCE IS THE WHOLE POINT OF THIS FILE. A cascade that stops is not evidence that the
 * mechanism you believe stopped it did. There are four things in this engine that can halt a cascade:
 * the static `self_triggering` refusal at save, the per-cascade fired-rule set, `MAX_CASCADE_DEPTH`,
 * and the `automation_run_once` UNIQUE index. A test that just asserts "the cascade terminated" passes
 * with three of the four deleted, and on an engine that writes to an append-only ledger unattended,
 * "something stopped it" is not a property anyone can maintain.
 *
 * So each case below is built so exactly ONE defence can be the thing that fired, and the run log is
 * read to prove which:
 *
 *   SELF-TRIGGERING is a save-time refusal with no cascade at all, and no row anywhere.
 *
 *   THE FIRED SET is isolated by a TWO-rule cycle, and G3 is what made that true. Before the
 *   occurrence key gained its discriminator, the second visit to the first rule reused the FIRST
 *   occurrence's `event_ref`, so the UNIQUE index would have refused the claim anyway and the case
 *   isolated nothing. Now the returning visit carries the derived key of the rule that came back
 *   round, which is a key the index has never seen, AND the return happens at depth 2, which is below
 *   `MAX_CASCADE_DEPTH`. Both other defences are therefore ruled out by construction rather than by
 *   reading a status, and the fired set is the only thing left that can have stopped it.
 *
 *   THE THREE-RULE CYCLE IS THE WEAKER CASE NOW, and it is kept and labelled as such rather than
 *   dropped. Its return lands at depth 3, which is exactly `MAX_CASCADE_DEPTH`, so the depth guard
 *   WOULD have caught it had the fired set been removed. Only the recorded status tells the two
 *   apart. That is still worth asserting (removing the fired set reddens it) but it is a weaker
 *   claim than the two-rule case, and this file says which is which rather than implying both are
 *   equal.
 *
 *   MAX_CASCADE_DEPTH is isolated by a FOUR-rule chain with no repeated rule at all, so the fired set
 *   is empty of the rule that gets suppressed and cannot be the cause.
 *
 * THIS INVERTS WHAT THIS FILE SAID BEFORE G3, deliberately. The earlier version reasoned that only a
 * three-rule cycle could isolate the fired set, and that reasoning was correct against the key as it
 * then stood. The discriminator changed the arithmetic, so the conclusion changed with it.
 *
 * EVERY SUPPRESSION IS ALSO CHECKED TO BE VISIBLE, with one documented exception that is now pinned
 * rather than assumed: a suppression whose `event_ref` the same rule has ALREADY claimed writes no
 * new row, because `recordWithoutFiring` claims through the same UNIQUE index. It bumps that row's
 * redelivery counter instead. `fire.ts` point 6 says "every suppression is logged", which is true of
 * the fact and not of the row, and the difference is asserted below so nobody has to re-derive it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_CASCADE_DEPTH } from '../../dist/core/automation/index.js';
import { call, count, defineRule, runRows, workspace } from './support.mjs';

const RUNS = 'SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ?';

/** The chain every case below is cut from, so the shapes differ only where the claim differs. */
const LINKS = {
  contactToDocument: { event: 'contact.created', tool: 'create_document', template: { type: 'invoice' } },
  documentToClose: { event: 'document.created', tool: 'close_month', template: { period: '2026-03' } },
  closeToReopen: { event: 'period.closed', tool: 'reopen_month', template: { period: '2026-03' } },
  reopenToClose: { event: 'period.reopened', tool: 'close_month', template: { period: '2026-03' } },
  closeToContact: {
    event: 'period.closed',
    tool: 'create_contact',
    template: { partyRole: 'customer', name: 'Kaskade AG' },
  },
  reopenToContact: {
    event: 'period.reopened',
    tool: 'create_contact',
    template: { partyRole: 'customer', name: 'Tiefe AG' },
  },
};

/** The one call every cascade in this file starts from, so the trigger is never the variable. */
function startCascade(deps, workspaceId, seed) {
  const res = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Start AG',
    idempotencyKey: `${seed}-start`,
  });
  assert.equal(res.ok, true, `the cascade's trigger itself failed: ${JSON.stringify(res)}`);
  return res;
}

// --- Defence 1: the static refusal at save time -------------------------------------------------

test('LOOP 1/3: a rule whose action emits its own trigger is refused at SAVE, and writes nothing', () => {
  const { deps, workspaceId } = workspace('lp-self');

  const res = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'Ich selbst',
    trigger: { event: 'journal.posted' },
    action: { tool: 'post_entry', inputTemplate: {} },
    idempotencyKey: 'lp-self-1',
  });
  assert.equal(res.ok, false, 'a self-triggering rule was accepted');
  assert.equal(res.error, 'self_triggering');
  assert.equal(res.event, 'journal.posted');
  assert.equal(res.tool, 'post_entry');

  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ?', workspaceId),
    0,
    'the refused rule was stored anyway, so it would fire the first time its trigger happened',
  );
});

test('LOOP 1/3: the same refusal holds on UPDATE, so a saved rule cannot be edited into a self-loop', () => {
  // The create path and the update path are the two ways a row reaches the table. A guard on one of
  // them is a guard on neither.
  const { deps, workspaceId } = workspace('lp-self-edit');
  const ruleId = defineRule(
    deps,
    workspaceId,
    { name: 'Harmlos', event: 'journal.posted', tool: 'create_document', template: { type: 'invoice' } },
    'lp-self-edit-create',
  );

  const res = call(deps, 'update_automation_rule', {
    workspaceId,
    ruleId,
    patch: { action: { tool: 'post_entry', inputTemplate: {} } },
    idempotencyKey: 'lp-self-edit-1',
  });
  assert.equal(res.ok, false, 'a rule was edited into a self-loop');
  assert.equal(res.error, 'self_triggering');
  assert.equal(
    deps.store.db.prepare('SELECT action_tool FROM automation_rule WHERE id = ?').get(ruleId).action_tool,
    'create_document',
    'the refused patch was written to the row anyway',
  );
});

// --- Defence 2: the per-cascade fired-rule set ---------------------------------------------------

test('LOOP 2/3: a TWO-rule cycle is stopped by the FIRED SET, with both other defences ruled out', () => {
  // THE ISOLATING CASE, and it only became one with G3. Ra claims
  // `period.closed:2026-03:<the human's key>`; the cascade comes back round to Ra on
  // `period.closed:2026-03:auto:<Rb>:<hash>`, which is a key the UNIQUE index has never seen. And the
  // return lands at depth 2, below MAX_CASCADE_DEPTH. Neither of the other two defences could have
  // stopped it, so the fired set is the only candidate left.
  const { deps, workspaceId } = workspace('lp-two');
  const ra = defineRule(deps, workspaceId, { name: 'Ra', ...LINKS.closeToReopen }, 'lp-two-a');
  const rb = defineRule(deps, workspaceId, { name: 'Rb', ...LINKS.reopenToClose }, 'lp-two-b');

  const closed = call(deps, 'close_month', { workspaceId, period: '2026-03', idempotencyKey: 'lp-two-close' });
  assert.equal(closed.ok, true, JSON.stringify(closed));

  const rows = runRows(deps, workspaceId);
  assert.deepEqual(
    rows.map((r) => [r.rule_id, r.status]),
    [
      [ra, 'ok'],
      [rb, 'ok'],
      [ra, 'suppressed_loop'],
    ],
    'the two-rule cycle did not terminate on the fired set',
  );

  // ISOLATION FACT ONE: the suppressed claim carries a key nothing had claimed, so the index is out.
  const suppressed = rows[rows.length - 1];
  assert.equal(
    rows.filter((r) => r.event_ref === suppressed.event_ref).length,
    1,
    'the suppressed occurrence key had been claimed before, so the UNIQUE index could have stopped it',
  );
  assert.notEqual(suppressed.event_ref, rows[0].event_ref, 'the discriminator is not in the key at all');
  assert.equal(rows[0].event_ref, 'period.closed:2026-03:lp-two-close');
  assert.match(suppressed.event_ref, /^period\.closed:2026-03:auto:/);

  // ISOLATION FACT TWO: the cascade only ever reached depth 2, so the depth guard is out. Two fired
  // rules before the suppression is exactly a depth of two, and MAX_CASCADE_DEPTH is three.
  assert.equal(MAX_CASCADE_DEPTH, 3, 'the depth this isolation depends on no longer matches the engine');
  assert.equal(rows.filter((r) => r.status === 'ok').length, 2, 'the cascade ran deeper than this case assumes');
  assert.equal(
    rows.filter((r) => r.status === 'suppressed_depth').length,
    0,
    'the depth guard fired, so this case no longer isolates the fired set',
  );

  // The period settles at whatever the last firing left, and the point is that it settles at all.
  assert.deepEqual(
    deps.store.db.prepare('SELECT period, kind FROM period_lock WHERE workspace_id = ?').all(workspaceId),
    [{ period: '2026-03', kind: 'soft' }],
  );
});

test('LOOP 2/3: a THREE-rule cycle also terminates on the fired set, confounded with depth', () => {
  // Kept, and labelled honestly. The return lands at depth 3, which IS MAX_CASCADE_DEPTH, so the
  // depth guard would have caught it too had the fired set been removed. The fired check runs first,
  // so the recorded STATUS is the only thing that tells the two apart, and that is a weaker claim
  // than the two-rule case above makes. It still reddens if the fired set is removed, which is why
  // it stays.
  const { deps, workspaceId } = workspace('lp-three');
  const r1 = defineRule(deps, workspaceId, { name: 'R1', ...LINKS.contactToDocument }, 'lp-three-1');
  const r2 = defineRule(deps, workspaceId, { name: 'R2', ...LINKS.documentToClose }, 'lp-three-2');
  const r3 = defineRule(deps, workspaceId, { name: 'R3', ...LINKS.closeToContact }, 'lp-three-3');

  startCascade(deps, workspaceId, 'lp-three');

  const rows = runRows(deps, workspaceId);
  assert.deepEqual(
    rows.map((r) => [r.rule_id, r.status]),
    [
      [r1, 'ok'],
      [r2, 'ok'],
      [r3, 'ok'],
      [r1, 'suppressed_loop'],
    ],
    'the three-rule cycle did not terminate on the fired set',
  );

  // The occurrence keys are all distinct, and the first link's is the human's own call.
  assert.equal(new Set(rows.map((r) => r.event_ref)).size, 4, 'two links of the cascade share an occurrence key');
  assert.equal(rows[0].event_ref, 'contact.created:contact_1:lp-three-start');
  assert.match(rows[3].event_ref, /^contact\.created:contact_2:auto:/);

  // The status is what distinguishes the two defences here, so it is asserted as the claim rather
  // than as a detail.
  assert.equal(
    rows[3].status,
    'suppressed_loop',
    'the depth guard fired instead, which this case cannot rule out on structure alone',
  );

  // And the cycle really was a cycle: the second contact exists, so R1 genuinely had a live trigger.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ?', workspaceId), 2);
});

test('LOOP: a suppression on an ALREADY-CLAIMED occurrence bumps the redelivery instead of a new row', () => {
  // The documented exception to "every suppression is logged", pinned rather than assumed.
  // `recordWithoutFiring` claims through the same UNIQUE index, so when the suppressed occurrence is
  // one this rule has already claimed, no second row can exist and none should: the occurrence
  // already has its row. What must not happen is the event vanishing, and the redelivery counter is
  // what stops that.
  //
  // The shape is a rule that triggers on the very event its own action's SIBLING rule emits, driven
  // twice on one occurrence, so the second delivery meets a claimed row.
  const { deps, workspaceId } = workspace('lp-claimed');
  const ra = defineRule(deps, workspaceId, { name: 'Ra', ...LINKS.closeToReopen }, 'lp-claimed-a');
  defineRule(deps, workspaceId, { name: 'Rb', ...LINKS.reopenToClose }, 'lp-claimed-b');

  const key = 'lp-claimed-close';
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-03', idempotencyKey: key }).ok, true);
  const afterFirst = runRows(deps, workspaceId);
  assert.equal(afterFirst.length, 3);

  // The SAME close again, same key, so the same occurrence reaches Ra a second time.
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-03', idempotencyKey: key }).ok, true);

  const afterSecond = runRows(deps, workspaceId);
  assert.equal(afterSecond.length, 3, 'a redelivered occurrence minted a second run row');
  const raFirst = afterSecond.find((r) => r.rule_id === ra && r.status === 'ok');
  assert.ok(raFirst !== undefined);
  assert.equal(
    raFirst.redeliveries,
    1,
    'the redelivered occurrence left no trace, which is the silence G3 was raised about',
  );
});

// --- Defence 3: MAX_CASCADE_DEPTH ---------------------------------------------------------------

test('LOOP 3/3: a FOUR-rule chain with no repeat is stopped by MAX_CASCADE_DEPTH', () => {
  // Four DISTINCT rules, so the fired set contains none of the rule that gets suppressed and cannot
  // be the cause. Each link carries its own `event_ref`, so the index cannot be either. Depth is the
  // only defence left, and the recorded status says so.
  assert.equal(MAX_CASCADE_DEPTH, 3, 'the depth this case is cut to no longer matches the engine');

  const { deps, workspaceId } = workspace('lp-depth');
  const d1 = defineRule(deps, workspaceId, { name: 'D1', ...LINKS.contactToDocument }, 'lp-depth-1');
  const d2 = defineRule(deps, workspaceId, { name: 'D2', ...LINKS.documentToClose }, 'lp-depth-2');
  const d3 = defineRule(deps, workspaceId, { name: 'D3', ...LINKS.closeToReopen }, 'lp-depth-3');
  const d4 = defineRule(deps, workspaceId, { name: 'D4', ...LINKS.reopenToContact }, 'lp-depth-4');

  startCascade(deps, workspaceId, 'lp-depth');

  const rows = runRows(deps, workspaceId);
  assert.deepEqual(
    rows.map((r) => [r.rule_id, r.status]),
    [
      [d1, 'ok'],
      [d2, 'ok'],
      [d3, 'ok'],
      [d4, 'suppressed_depth'],
    ],
    'the chain did not stop at MAX_CASCADE_DEPTH',
  );

  assert.equal(
    rows.filter((r) => r.rule_id === d4).length,
    1,
    'D4 appears more than once, so the fired set could have been what suppressed it',
  );
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM contact WHERE workspace_id = ?', workspaceId),
    1,
    'the fourth link ran: it was supposed to be suppressed BEFORE it wrote anything',
  );
});

test('LOOP: every suppression leaves a row a human can read, never a silent stop', () => {
  // The property that makes the other three debuggable. A cascade that halts with no trace is
  // indistinguishable, from the operator's chair, from a rule that was never written.
  const { deps, workspaceId } = workspace('lp-visible');
  defineRule(deps, workspaceId, { name: 'D1', ...LINKS.contactToDocument }, 'lp-visible-1');
  defineRule(deps, workspaceId, { name: 'D2', ...LINKS.documentToClose }, 'lp-visible-2');
  defineRule(deps, workspaceId, { name: 'D3', ...LINKS.closeToReopen }, 'lp-visible-3');
  defineRule(deps, workspaceId, { name: 'D4', ...LINKS.reopenToContact }, 'lp-visible-4');

  startCascade(deps, workspaceId, 'lp-visible');

  const listed = call(deps, 'list_automation_runs', { workspaceId });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const suppressed = listed.runs.filter((r) => r.status === 'suppressed_depth');
  assert.equal(suppressed.length, 1, 'the suppression is invisible through the read verb operators use');
  // A suppression is terminal: it never sits at `running`, which is the status a stuck row wears.
  assert.equal(count(deps, `${RUNS} AND status = 'running'`, workspaceId), 0);
});
