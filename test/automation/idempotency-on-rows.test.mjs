/**
 * §H-IDEMPOTENT for G01, asserted on ROWS, and for the FIRING asserted on the JOURNAL.
 *
 * WHY NOT ON THE RETURNED RESULT. A verb that returns the same id twice while writing twice is exactly
 * the defect this phrasing exists to catch, and it is invisible to a return-value assertion by
 * construction: `rememberIdempotent` replays a stored answer, so a matching id proves the RECEIPT was
 * replayed and says nothing about what the body did on the way there. Every claim below counts rows in
 * the table the verb writes.
 *
 * AND THE HALF THAT ONLY G01 HAS. Every other capability's idempotency question is "did the caller's
 * retry write twice". G01's is "did a REDELIVERED EVENT post twice", which is a different mechanism
 * (the `automation_run_once` UNIQUE index, claimed before any action is invoked) and a different blast
 * radius: the thing that doubles is not a configuration row, it is a journal entry. So the firing
 * assertions below count `journal_entry` and `journal_line`, never `automation_run`. A run count that
 * held steady while the ledger doubled would be a green test over a corrupt book, and counting the run
 * log to prove the ledger is safe is precisely the substitution this file refuses to make.
 *
 * THE THIRD LAYER IS PROVEN TOO, and it is the one a reader would otherwise have to take on trust: the
 * derived `idempotencyKey` handed to the target verb. It is asserted directly off the stored
 * `action_input`, so "there is a second, independent guard" is a fact about the row rather than a
 * sentence in a docblock.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { handleRest } from '../../dist/api/rest.js';
import { call, count, defineRule, postTemplate, runRows, workspace } from './support.mjs';

const RULES = 'SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ?';
const RUNS = 'SELECT COUNT(*) AS n FROM automation_run WHERE workspace_id = ?';
const ENTRIES = 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?';
const LINES = `SELECT COUNT(*) AS n FROM journal_line
                WHERE entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ?)`;

/** The five rule-management writes, each called twice, each counted on `automation_rule`. */

test('H-IDEMPOTENT: create_automation_rule twice on one key writes ONE rule', () => {
  const { deps, workspaceId } = workspace('ai-create');
  const input = {
    workspaceId,
    name: 'Beleg anlegen',
    trigger: { event: 'contact.created' },
    action: { tool: 'create_document', inputTemplate: { type: 'invoice' } },
    idempotencyKey: 'ai-create-1',
  };

  const first = call(deps, 'create_automation_rule', input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = call(deps, 'create_automation_rule', input);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.rule.ruleId, first.rule.ruleId);

  assert.equal(count(deps, RULES, workspaceId), 1, 'the replay minted a SECOND rule under a new id');
});

test('H-IDEMPOTENT: the SAME create key delivered to the two different doors still writes one rule', () => {
  // The realistic redelivery is not two calls on one face: it is a Studio call the client believes was
  // lost and an agent retry of the same request. The receipt lives in the store, not in an adapter.
  const { deps, workspaceId } = workspace('ai-doors');
  const input = {
    workspaceId,
    name: 'Beide Tueren',
    trigger: { event: 'contact.created' },
    action: { tool: 'create_document', inputTemplate: { type: 'invoice' } },
    idempotencyKey: 'ai-doors-1',
  };

  const viaMcp = JSON.parse(callTool(deps, 'create_automation_rule', input).content[0].text);
  assert.equal(viaMcp.ok, true, JSON.stringify(viaMcp));
  const viaRest = handleRest('create_automation_rule', input, deps);
  assert.equal(viaRest.status, 200);
  assert.equal(viaRest.body.rule.ruleId, viaMcp.rule.ruleId, 'the REST retry minted a new rule');

  assert.equal(count(deps, RULES, workspaceId), 1);
});

test('H-IDEMPOTENT: update_automation_rule twice on one key leaves ONE row with ONE shape', () => {
  const { deps, workspaceId } = workspace('ai-update');
  const ruleId = defineRule(
    deps,
    workspaceId,
    { name: 'Vorher', event: 'contact.created', tool: 'create_document', template: { type: 'invoice' } },
    'ai-update-create',
  );

  const input = {
    workspaceId,
    ruleId,
    patch: { name: 'Nachher', action: { tool: 'create_document', inputTemplate: { type: 'quote' } } },
    idempotencyKey: 'ai-update-1',
  };
  assert.equal(call(deps, 'update_automation_rule', input).ok, true);
  assert.equal(call(deps, 'update_automation_rule', input).ok, true);

  const rows = deps.store.db
    .prepare('SELECT name, action_input FROM automation_rule WHERE workspace_id = ? AND id = ?')
    .all(workspaceId, ruleId);
  assert.equal(rows.length, 1, 'update appended a row instead of updating one');
  assert.equal(rows[0].name, 'Nachher');
  assert.deepEqual(JSON.parse(rows[0].action_input), { type: 'quote' });
  assert.equal(count(deps, RULES, workspaceId), 1);
});

test('H-IDEMPOTENT: disable, enable and archive are ABSOLUTE, so a replay re-asserts and settles', () => {
  // All three are key-EXEMPT (they are listed in the conformance contract's exemptions), which makes
  // their claim stronger rather than weaker: the second call genuinely runs its body, and the row
  // still must not move.
  const { deps, workspaceId } = workspace('ai-flags');
  const ruleId = defineRule(
    deps,
    workspaceId,
    { name: 'Schalter', event: 'contact.created', tool: 'create_document', template: { type: 'invoice' } },
    'ai-flags-create',
  );

  assert.equal(call(deps, 'disable_automation_rule', { workspaceId, ruleId }).ok, true);
  assert.equal(call(deps, 'disable_automation_rule', { workspaceId, ruleId }).ok, true);
  assert.deepEqual(
    deps.store.db.prepare('SELECT enabled FROM automation_rule WHERE id = ?').all(ruleId),
    [{ enabled: 0 }],
  );

  assert.equal(call(deps, 'enable_automation_rule', { workspaceId, ruleId }).ok, true);
  assert.equal(call(deps, 'enable_automation_rule', { workspaceId, ruleId }).ok, true);
  assert.deepEqual(
    deps.store.db.prepare('SELECT enabled FROM automation_rule WHERE id = ?').all(ruleId),
    [{ enabled: 1 }],
  );

  assert.equal(call(deps, 'archive_automation_rule', { workspaceId, ruleId }).ok, true);
  assert.equal(call(deps, 'archive_automation_rule', { workspaceId, ruleId }).ok, true);
  // Archiving also disables, because a rule hidden from the list and still firing is the exact
  // surprise this capability must never produce.
  assert.deepEqual(
    deps.store.db.prepare('SELECT archived, enabled FROM automation_rule WHERE id = ?').all(ruleId),
    [{ archived: 1, enabled: 0 }],
  );
  assert.equal(count(deps, RULES, workspaceId), 1, 'a flag write appended a row');
});

test('H-IDEMPOTENT: run_due_automations at one asOf fires once, however often the tick is called', () => {
  const { deps, workspaceId, accId } = workspace('ai-tick');
  defineRule(
    deps,
    workspaceId,
    { name: 'Täglich', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(accId) },
    'ai-tick-create',
  );

  const first = call(deps, 'run_due_automations', { workspaceId, asOf: '2026-03-10T09:00:00.000Z' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the first tick did not post');
  assert.equal(count(deps, RUNS, workspaceId), 1);

  // Key-exempt, so the second tick really runs its body. The bookmark and the UNIQUE index are both
  // in the way, and the row count is what says so.
  const second = call(deps, 'run_due_automations', { workspaceId, asOf: '2026-03-10T17:00:00.000Z' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.occurrences, 0, 'the same day came due twice');
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'a repeated tick posted a second entry');
  assert.equal(count(deps, RUNS, workspaceId), 1);

  // A LATER day is a different occurrence and must fire: a guard that never fires again would pass
  // every assertion above.
  assert.equal(call(deps, 'run_due_automations', { workspaceId, asOf: '2026-03-11T09:00:00.000Z' }).ok, true);
  assert.equal(count(deps, ENTRIES, workspaceId), 2, 'the next day did not come due');
  assert.equal(count(deps, RUNS, workspaceId), 2);
});

test('G01: the tick REPORTS which of the four outcomes each occurrence was', () => {
  // The other half of the G3 finding. `occurrences` counted what the SOURCES produced, which is not
  // what happened to them: a tick whose every occurrence was already accounted for reported the same
  // number as one that fired them all, and "fired nothing and said nothing" is precisely the property
  // that kept the `event_ref` collapse invisible for eleven days. Each of the four counters is driven
  // to a non-zero value below, because a counter that is always zero is indistinguishable from one
  // that is never incremented.
  const { deps, workspaceId, accId } = workspace('af-outcome');

  // FIRED: a plain daily rule with nothing in its way.
  defineRule(
    deps,
    workspaceId,
    { name: 'Fired', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(accId) },
    'af-outcome-fired',
  );
  // SKIPPED: a condition that cannot be answered fails closed.
  defineRule(
    deps,
    workspaceId,
    {
      name: 'Skipped',
      event: 'schedule.daily',
      tool: 'post_entry',
      template: postTemplate(accId),
      condition: { all: [{ field: 'input.nichtVorhanden', op: 'gt', value: 1 }] },
    },
    'af-outcome-skipped',
  );

  const first = call(deps, 'run_due_automations', { workspaceId, asOf: '2026-03-10T09:00:00.000Z' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.fired, 1, 'the unconditional rule did not fire');
  assert.equal(first.skipped, 1, 'the unanswerable condition was not reported as skipped');
  assert.equal(first.alreadyAccounted, 0);
  assert.equal(first.suppressed, 0);
  // `occurrences` keeps its old meaning (what the sources produced), which is why it is not the same
  // number as `fired` and why the four counters had to be added beside it rather than replace it.
  assert.equal(first.occurrences, 2);

  // ALREADY ACCOUNTED: rewind the bookmarks by hand so the same due instant is produced a second
  // time. That is the only way to reach this branch from the tick, and it is exactly the shape a
  // crashed process leaves behind.
  deps.store.db.prepare('UPDATE automation_rule SET last_fired_at = NULL WHERE workspace_id = ?').run(workspaceId);
  const second = call(deps, 'run_due_automations', { workspaceId, asOf: '2026-03-10T17:00:00.000Z' });
  assert.equal(second.ok, true, JSON.stringify(second));
  // ONE, not two, and the asymmetry is the mechanism rather than an off-by-one. The condition check
  // runs BEFORE the claim, so a rule whose condition is false never reaches the UNIQUE index and is
  // reported `skipped` on every delivery. Only the rule that really claimed a row can come back as
  // `already_accounted`.
  assert.equal(second.alreadyAccounted, 1, 'a re-delivered occurrence was not reported as accounted for');
  assert.equal(second.skipped, 1, 'the false condition stopped being reported as skipped');
  assert.equal(second.fired, 0, 'a re-delivered occurrence fired again');
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the re-delivered occurrence posted a second entry');

  // And it left a durable trace rather than an absence: both rows carry a redelivery now.
  assert.deepEqual(
    runRows(deps, workspaceId).map((r) => r.redeliveries),
    [1, 1],
  );
});

test('G01: the tick refuses an asOf in the FUTURE rather than making tomorrow due', () => {
  // A caller naming tomorrow used to make tomorrow due, advance the bookmark to it, and let the next
  // call name the day after: a walking `asOf` drove a schedule rule repeatedly into an append-only
  // ledger. The clock is injected and is the only thing entitled to answer "what time is it".
  const { deps, workspaceId, accId } = workspace('af-future');
  defineRule(
    deps,
    workspaceId,
    { name: 'Täglich', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(accId) },
    'af-future-rule',
  );

  const ahead = call(deps, 'run_due_automations', { workspaceId, asOf: '2027-01-01T00:00:00.000Z' });
  assert.equal(ahead.ok, false, 'a future asOf was accepted');
  assert.equal(ahead.error, 'as_of_in_future');
  assert.equal(count(deps, ENTRIES, workspaceId), 0, 'the refused tick posted anyway');
  assert.equal(count(deps, RUNS, workspaceId), 0);

  // An unreadable `asOf` is refused too, rather than absorbed into a serene `{ occurrences: 0 }` a
  // caller cannot tell apart from "nothing was due".
  const nonsense = call(deps, 'run_due_automations', { workspaceId, asOf: 'irgendwann' });
  assert.equal(nonsense.ok, false, 'an unparseable asOf was absorbed');
  assert.equal(nonsense.error, 'invalid_input');
  assert.equal(count(deps, ENTRIES, workspaceId), 0);

  // A PAST asOf stays legal: it can only ever produce fewer occurrences.
  const past = call(deps, 'run_due_automations', { workspaceId, asOf: '2026-03-10T09:00:00.000Z' });
  assert.equal(past.ok, true, JSON.stringify(past));
  assert.equal(past.fired, 1);
});

test('H-IDEMPOTENT: a schedule that fell a month behind fires ONCE, not thirty times', () => {
  // The authored spec advanced through every missed instant, which means a laptop opened after a month
  // offline fires a daily rule thirty times, in one burst, unattended, against the ledger. Counted on
  // the journal, because that is what a burst would fill.
  const { deps, workspaceId, accId } = workspace('ai-backlog');
  defineRule(
    deps,
    workspaceId,
    { name: 'Täglich', event: 'schedule.daily', tool: 'post_entry', template: postTemplate(accId) },
    'ai-backlog-create',
  );

  assert.equal(call(deps, 'run_due_automations', { workspaceId, asOf: '2026-03-01T09:00:00.000Z' }).ok, true);
  assert.equal(count(deps, ENTRIES, workspaceId), 1);

  const late = call(deps, 'run_due_automations', { workspaceId, asOf: '2026-04-01T09:00:00.000Z' });
  assert.equal(late.ok, true, JSON.stringify(late));
  assert.equal(late.occurrences, 1, 'the tick produced a backlog instead of one occurrence');
  assert.equal(count(deps, ENTRIES, workspaceId), 2, 'thirty-one missed days became thirty-one postings');
});

// --- The firing guarantee, asserted on the JOURNAL ---------------------------------------------

test('G01: a REPLAYED triggering event leaves the journal exactly where it was', () => {
  // The claim under test is that `UNIQUE (workspace_id, rule_id, event_ref)` plus the derived
  // `idempotencyKey` mean a retried trigger cannot double-post. It is asserted on `journal_entry` and
  // `journal_line`, because a run count holding steady while the ledger doubled is the failure this
  // suite exists to catch and it would be invisible to the run log.
  const { deps, workspaceId, accId } = workspace('af-replay');
  defineRule(
    deps,
    workspaceId,
    { name: 'Buchen', event: 'contact.created', tool: 'post_entry', template: postTemplate(accId) },
    'af-replay-rule',
  );

  const trigger = {
    workspaceId,
    partyRole: 'customer',
    name: 'Wiederholung AG',
    idempotencyKey: 'af-replay-contact',
  };

  const first = call(deps, 'create_contact', trigger);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the rule did not fire at all');
  assert.equal(count(deps, LINES, workspaceId), 2);

  // Redelivery one: the same door.
  const replay = call(deps, 'create_contact', trigger);
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.contact.id, first.contact.id, 'the replayed trigger minted a second contact');
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'a replayed trigger posted a SECOND journal entry');
  assert.equal(count(deps, LINES, workspaceId), 2);

  // Redelivery two: the OTHER door. Both adapters resolve the same ActionDef and call the same
  // `action.run`, so the dispatch runs again on a replayed ok Result and the index has to be what
  // stops it.
  const viaRest = handleRest('create_contact', trigger, deps);
  assert.equal(viaRest.status, 200);
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'a REST redelivery posted a second journal entry');
  assert.equal(count(deps, LINES, workspaceId), 2);

  const viaMcp = JSON.parse(callTool(deps, 'create_contact', trigger).content[0].text);
  assert.equal(viaMcp.ok, true);
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'an MCP redelivery posted a second journal entry');

  // One run row, and the guard is not simply "never fires twice": a genuinely NEW contact is a new
  // occurrence and must post again, or every assertion above would hold over a dead engine.
  assert.equal(count(deps, RUNS, workspaceId), 1);
  assert.equal(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: 'Zweite AG',
      idempotencyKey: 'af-replay-contact-2',
    }).ok,
    true,
  );
  assert.equal(count(deps, ENTRIES, workspaceId), 2, 'a NEW occurrence failed to fire');
  assert.equal(count(deps, RUNS, workspaceId), 2);

  // THE OCCURRENCE KEY NOW CARRIES A DISCRIMINATOR (G3): the emitting write's own `idempotencyKey`,
  // appended rather than substituted. Two deliveries of one write share that key and still collapse
  // onto one `event_ref`, which is what the three redeliveries above just proved. Two genuine writes
  // never do. Asserted against the exact composed key rather than a prefix, because "starts with the
  // entity id" is also true of the broken form the discriminator replaced.
  const rows = runRows(deps, workspaceId);
  assert.deepEqual(
    rows.map((r) => [r.event_ref, r.status]),
    [
      ['contact.created:contact_1:af-replay-contact', 'ok'],
      ['contact.created:contact_2:af-replay-contact-2', 'ok'],
    ],
    'the event_ref is the OCCURRENCE key, so two deliveries of one occurrence must share it',
  );

  // AND THE REDELIVERIES ARE COUNTED, which is the half the critic found missing. A refused claim is
  // correct and must stay correct, but it used to leave no trace at all, so "delivered again, already
  // accounted for" was indistinguishable from "never delivered". Occurrence one was delivered FOUR
  // times (the registry, a registry replay, REST and MCP), so three of those were redeliveries; the
  // second occurrence has had none.
  assert.deepEqual(
    rows.map((r) => r.redeliveries),
    [3, 0],
    'a redelivered occurrence left no durable trace, so the silence the critic found is back',
  );
});

test('G01: a reopened month that is closed AGAIN is a second occurrence, and fires again', () => {
  // THE DEFECT THE DISCRIMINATOR EXISTS FOR, pinned so it cannot come back. `period.closed` keys on
  // `input.period`, which is `2026-03` every single time that month is closed. Before G3 the second
  // real close of a month collapsed onto the first occurrence's `event_ref`, the UNIQUE index refused
  // the claim, and the rule produced no firing, no run row and no trace: a month-end automation
  // silently stopped working after the first correction.
  //
  // THIS IS THE OTHER HALF OF THE TEST ABOVE AND NEITHER IS SUFFICIENT ALONE. That one proves a
  // retried delivery does not double-post; this one proves a genuinely new occurrence still posts. An
  // engine that fired on every delivery passes this and fails that; an engine that fired once ever
  // passes that and fails this. Only both together say the key discriminates.
  const { deps, workspaceId, accId } = workspace('af-reclose');
  defineRule(
    deps,
    workspaceId,
    {
      name: 'Monatsende buchen',
      event: 'period.closed',
      tool: 'post_entry',
      // Deliberately posted OUTSIDE the month being closed. A soft close is a guardrail over its own
      // months, so a rule posting into 2026-03 as 2026-03 closes would be refused `period_locked` and
      // this test would measure A03 rather than the occurrence key.
      template: postTemplate(accId, 2500, '2026-05-01'),
    },
    'af-reclose-rule',
  );

  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-03', idempotencyKey: 'close-1' }).ok, true);
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the first close did not fire');

  // A redelivery of THAT close: same key, so the same occurrence, and nothing may move.
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-03', idempotencyKey: 'close-1' }).ok, true);
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'a redelivered close posted twice');
  assert.equal(count(deps, RUNS, workspaceId), 1);

  // A legitimate correction, and then a SECOND REAL CLOSE of the same month.
  assert.equal(call(deps, 'reopen_month', { workspaceId, period: '2026-03', idempotencyKey: 'reopen-1' }).ok, true);
  const reclosed = call(deps, 'close_month', { workspaceId, period: '2026-03', idempotencyKey: 'close-2' });
  assert.equal(reclosed.ok, true, JSON.stringify(reclosed));

  assert.equal(count(deps, ENTRIES, workspaceId), 2, 'the second real close of the month fired nothing');
  assert.equal(count(deps, LINES, workspaceId), 4);

  const rows = runRows(deps, workspaceId);
  assert.deepEqual(
    rows.map((r) => [r.event_ref, r.status, r.redeliveries]),
    [
      ['period.closed:2026-03:close-1', 'ok', 1],
      ['period.closed:2026-03:close-2', 'ok', 0],
    ],
    'the same entity id under two different write keys must be two occurrences, not one',
  );
});

test('G01: the derived idempotencyKey really reaches the target verb, and is stable per occurrence', () => {
  // The second, independent layer. Asserted off the stored `action_input`, which is what was really
  // sent, so "there is a second guard" is a fact about the row rather than a sentence in a docblock.
  const { deps, workspaceId, accId } = workspace('af-key');
  const ruleId = defineRule(
    deps,
    workspaceId,
    { name: 'Buchen', event: 'contact.created', tool: 'post_entry', template: postTemplate(accId) },
    'af-key-rule',
  );

  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'A AG', idempotencyKey: 'af-key-1' }).ok,
    true,
  );
  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'B AG', idempotencyKey: 'af-key-2' }).ok,
    true,
  );

  const sent = deps.store.db
    .prepare('SELECT event_ref, action_input FROM automation_run WHERE workspace_id = ? ORDER BY started_at, id')
    .all(workspaceId)
    .map((r) => ({ eventRef: r.event_ref, input: JSON.parse(r.action_input) }));
  assert.equal(sent.length, 2);

  for (const row of sent) {
    assert.match(
      row.input.idempotencyKey,
      /^auto:arule_\d+:[0-9a-f]{16}$/,
      'the fired action carried no derived key, so the row constraint is the ONLY guard',
    );
    assert.ok(row.input.idempotencyKey.startsWith(`auto:${ruleId}:`));
    // The tenant is overwritten rather than templated, so no rule author can aim a firing elsewhere.
    assert.equal(row.input.workspaceId, workspaceId);
  }
  assert.notEqual(
    sent[0].input.idempotencyKey,
    sent[1].input.idempotencyKey,
    'two DIFFERENT occurrences derived the same key, which would make the second a silent no-op',
  );
});
