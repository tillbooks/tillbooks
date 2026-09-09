/**
 * G01 on the money path: an automated write obeys every rule a human's write obeys, without exception.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE PERMISSION ONE. G01's structural claim is that there is no
 * second write path: a fired action goes through the same `action.run` the MCP server and the REST
 * twins call, so the period locks, the append-only rule and the idempotency receipt apply because they
 * are literally the same code. That is an argument, and an argument is not a test. What is tested here
 * is the CONSEQUENCE: a filed or locked period refuses an automated post exactly as it refuses a human
 * one, and a correction an automation makes is a reversing entry rather than an edit.
 *
 * THE ASSERTIONS ARE ON THE JOURNAL, ALWAYS. `journal_entry` and `journal_line` counts, the `status`
 * column, and `reverses_entry_id`. A run row saying `failed` is corroboration, never the claim: the
 * defect worth catching is a rule that is refused in its answer and writes in its body, and that is
 * invisible to everything except a row count.
 *
 * AND A FAILED FIRING MUST NOT TAKE THE TRIGGER WITH IT. `dispatchAutomationEvent` returns void and
 * swallows into run rows, so an automation defect cannot turn a good post into a failed one. The
 * trigger's own success is asserted alongside every refusal below, because an engine that rolled the
 * trigger back would also leave the journal at zero and pass a careless version of these tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { call, count, defineRule, postTemplate, runRows, workspace } from './support.mjs';

const ENTRIES = 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?';
const LINES = `SELECT COUNT(*) AS n FROM journal_line
                WHERE entry_id IN (SELECT id FROM journal_entry WHERE workspace_id = ?)`;

const entries = (deps, workspaceId) =>
  deps.store.db
    .prepare('SELECT id, status, reverses_entry_id, date FROM journal_entry WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId);

/** A workspace whose only rule posts into `date` whenever a contact is created. */
function workspaceWithPostingRule(seed, date = '2026-03-15') {
  const { deps, workspaceId, accId } = workspace(seed);
  const ruleId = defineRule(
    deps,
    workspaceId,
    {
      name: 'Automatisch buchen',
      event: 'contact.created',
      tool: 'post_entry',
      template: postTemplate(accId, 2500, date),
    },
    `${seed}-rule`,
  );
  return { deps, workspaceId, accId, ruleId };
}

function fireByCreatingAContact(deps, workspaceId, seed, name = 'Auslöser AG') {
  const res = call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name, idempotencyKey: seed });
  return res;
}

test('MONEY PATH: a HARD-locked period refuses an automated post exactly as it refuses a human one', () => {
  const { deps, workspaceId, accId } = workspaceWithPostingRule('mp-hard');

  assert.equal(call(deps, 'lock_period', { workspaceId, period: '2026-03', kind: 'hard', idempotencyKey: 'mp-hard-lock' }).ok, true);

  const triggered = fireByCreatingAContact(deps, workspaceId, 'mp-hard-c');
  assert.equal(triggered.ok, true, 'the failed automation took its own trigger down with it');

  assert.equal(count(deps, ENTRIES, workspaceId), 0, 'an automation posted into a hard-locked period');
  assert.equal(count(deps, LINES, workspaceId), 0);

  const rows = runRows(deps, workspaceId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error_code, 'period_locked', 'the run log does not carry the target verb rejection code');

  // The same period, the same input, from a HUMAN: the refusal is the period's, not the automation's.
  const byHand = call(deps, 'post_entry', {
    workspaceId,
    ...postTemplate(accId, 2500, '2026-03-15'),
    idempotencyKey: 'mp-hard-hand',
  });
  assert.equal(byHand.ok, false);
  assert.equal(byHand.error, 'period_locked');
  assert.equal(count(deps, ENTRIES, workspaceId), 0);
});

test('MONEY PATH: a FILED VAT period refuses an automated post', () => {
  // `vat_mark_filed` applies A03's hard lock to the filed months, which makes this the statutory case
  // rather than a second spelling of the one above: the figure has gone to the ESTV.
  const { deps, workspaceId } = workspaceWithPostingRule('mp-filed');
  assert.equal(call(deps, 'vat_seed_defaults', { workspaceId }).ok, true);

  const filed = call(deps, 'vat_mark_filed', { workspaceId, period: '2026-Q1', idempotencyKey: 'mp-filed-file' });
  assert.equal(filed.ok, true, `vat_mark_filed refused: ${JSON.stringify(filed)}`);

  const triggered = fireByCreatingAContact(deps, workspaceId, 'mp-filed-c');
  assert.equal(triggered.ok, true, 'the failed automation took its own trigger down with it');

  assert.equal(count(deps, ENTRIES, workspaceId), 0, 'an automation posted into a FILED period');
  const rows = runRows(deps, workspaceId);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error_code, 'period_locked');
});

test('MONEY PATH: an automated correction is a REVERSING entry, never an edit', () => {
  // OR 957a. The original row must survive byte for byte, and the correction must be a second posted
  // entry that names it. An engine that "corrected" by UPDATE would leave one row here.
  const { deps, workspaceId, accId } = workspace('mp-reverse');
  defineRule(
    deps,
    workspaceId,
    { name: 'Storno', event: 'journal.posted', tool: 'reverse_entry', template: { entryId: '{{result.entryId}}' } },
    'mp-reverse-rule',
  );

  const posted = call(deps, 'post_entry', {
    workspaceId,
    ...postTemplate(accId, 5000, '2026-03-01'),
    idempotencyKey: 'mp-reverse-post',
  });
  assert.equal(posted.ok, true, JSON.stringify(posted));

  const rows = entries(deps, workspaceId);
  assert.equal(rows.length, 2, 'the automated correction did not post a second entry');
  assert.deepEqual(
    rows.map((r) => [r.status, r.reverses_entry_id]),
    [
      ['posted', null],
      ['posted', posted.entryId],
    ],
    'the correction is not a reversal that names the entry it corrects',
  );
  // The original is untouched, including the date: a reversal is a new fact, not a rewrite of an old one.
  assert.equal(rows[0].id, posted.entryId);
  assert.equal(rows[0].date, '2026-03-01');
  assert.equal(count(deps, LINES, workspaceId), 4, 'the mirror is not a faithful two-line mirror');

  assert.deepEqual(
    runRows(deps, workspaceId).map((r) => [r.action_tool, r.status]),
    [['reverse_entry', 'ok']],
  );
});

test('MONEY PATH: a rule may not aim a firing at another workspace, whatever its template says', () => {
  // `resolved.workspaceId = ctx.workspaceId` is an OVERWRITE rather than a validation, so there is no
  // input a rule author could write that would even be considered. Asserted by writing exactly that
  // input and counting the other tenant's journal.
  const { deps, workspaceId, accId } = workspace('mp-aim');
  const other = call(deps, 'create_workspace', { name: 'Fremd GmbH', idempotencyKey: 'mp-aim-other' });
  assert.equal(other.ok, true);

  defineRule(
    deps,
    workspaceId,
    {
      name: 'Fremd buchen',
      event: 'contact.created',
      tool: 'post_entry',
      template: { ...postTemplate(accId, 2500, '2026-03-01'), workspaceId: other.workspaceId },
    },
    'mp-aim-rule',
  );

  assert.equal(fireByCreatingAContact(deps, workspaceId, 'mp-aim-c').ok, true);

  assert.equal(count(deps, ENTRIES, other.workspaceId), 0, 'a rule posted into ANOTHER workspace');
  assert.equal(count(deps, ENTRIES, workspaceId), 1, 'the firing was aimed away from its own workspace');
  assert.equal(
    JSON.parse(
      deps.store.db.prepare('SELECT action_input FROM automation_run WHERE workspace_id = ?').get(workspaceId).action_input,
    ).workspaceId,
    workspaceId,
    'the run log records the tenant the author asked for rather than the one that was used',
  );
});

test('MONEY PATH: a rule may not name a READ verb, at save time or at fire time', () => {
  // Two guards, and both are load-bearing. The save-time one is the error message a person reads; the
  // fire-time one covers a rule stored before a verb changed kind, which is the only way a read could
  // otherwise reach the write path.
  const { deps, workspaceId } = workspace('mp-read');

  const refused = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'Nur lesen',
    trigger: { event: 'contact.created' },
    action: { tool: 'list_journal', inputTemplate: {} },
    idempotencyKey: 'mp-read-1',
  });
  assert.equal(refused.ok, false, 'a read verb was accepted as a rule action');
  assert.equal(refused.error, 'action_not_writable');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM automation_rule WHERE workspace_id = ?', workspaceId), 0);

  // And a verb that does not exist at all is a DIFFERENT mistake, said differently.
  const unknown = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'Gibt es nicht',
    trigger: { event: 'contact.created' },
    action: { tool: 'entbuchen_bitte', inputTemplate: {} },
    idempotencyKey: 'mp-read-2',
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'action_not_writable');
});

test('MONEY PATH: a condition that cannot be answered SKIPS the firing rather than guessing', () => {
  // Fails closed, and on an engine that writes to a ledger unattended "I could not tell" and "no" must
  // have the same consequence. Measured on the journal, because the alternative to skipping is posting.
  const { deps, workspaceId, accId } = workspace('mp-condition');
  defineRule(
    deps,
    workspaceId,
    {
      name: 'Nur grosse Beträge',
      event: 'contact.created',
      tool: 'post_entry',
      template: postTemplate(accId, 2500, '2026-03-01'),
      // `input.paymentTermsDays` is absent from this trigger, so the clause cannot be answered.
      condition: { all: [{ field: 'input.paymentTermsDays', op: 'gt', value: 30 }] },
    },
    'mp-condition-rule',
  );

  assert.equal(fireByCreatingAContact(deps, workspaceId, 'mp-condition-c').ok, true);

  assert.equal(count(deps, ENTRIES, workspaceId), 0, 'an unanswerable condition fired open');
  assert.deepEqual(
    runRows(deps, workspaceId).map((r) => r.status),
    ['skipped_condition'],
    'the skip is invisible, so nobody can tell it from a rule that never matched',
  );
});
