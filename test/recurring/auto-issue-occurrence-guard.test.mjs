/**
 * The A12 tick auto-issues ONLY the occurrence the schedule's approved template describes (D141; the
 * non-author critic's F1 and F2, 28.09.2026).
 *
 * The tick creates each period's draft through `create_document` under the key
 * `recurring:<scheduleId>:<periodKey>`, memoised per (workspace, key, verb), and then issues it through
 * `issue_invoice` as the schedule's author. Both inputs of that issue were open to an agent seat at the
 * default `ask`, with no Vorschlag:
 *
 *  - F1, the key squat: the agent creates its OWN draft under the derivable key first
 *    (`create_document` is ungoverned); the tick's create replays the agent's draft and issues it.
 *    Measured: R-2026-0001 to another customer for CHF 10'810.00, posted.
 *  - F2, the waiting draft: an auto-issue skipped for a locked period keeps its draft; the agent edits
 *    it (`update_document` is ungoverned); the human unlocks the period and the next tick issues it.
 *
 * Round 1 compared a SUBSET of fields with the template and skipped what the template left open;
 * the round-2 critic (R2) put a EUR invoice, an added VAT code and free text through that gap. So the
 * check is by PROVENANCE and FINGERPRINT instead: the tick auto-issues a draft only when it created it
 * in this very call, or when one of this schedule's run rows names that draft with a fingerprint of
 * every column (bar the lifecycle fields and the due date) that the draft still matches. Anything else
 * is `draft_diverged`, left to a human, whose issue or cancel settles the period through the tick's
 * existing rules. The regressions pin that a genuine occurrence, including one that waited out a lock
 * with a negotiated due date, still issues unattended.
 *
 * HOW IT BITES: drop the provenance/fingerprint check in `runOccurrence` and the squat tests (the
 * identical-content one included, which no field comparison can catch) and the edit tests find the
 * agent's invoice issued and posted.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { callTool } from '../../dist/api/mcp.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const mcp = (deps, name, args) => JSON.parse(callTool(deps, name, args).content[0].text);
const human = (deps, name, input) => getAction(name).run({ ...deps, actor: 'studio' }, input);
/**
 * D161: the agent seat's own `run_due_recurring` is a Vorschlag under `issue` (asserted in the first
 * test and in test/agent/dial-covers-d161.test.mjs). The guard under test is the tick's, whoever runs
 * it, so the tick here is the person's (or the scheduler's) door; the squats stay the agent's.
 */
const tick = (deps, input) => human(deps, 'run_due_recurring', input);

function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  assert.equal(human(deps, 'vat_seed_defaults', { workspaceId }).ok, true);
  assert.equal(human(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  const abo = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Abo AG', idempotencyKey: 'c-abo' });
  const other = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Fremd GmbH', idempotencyKey: 'c-fremd' });
  // The HUMAN authors an auto-issuing monthly schedule (CHF 100.00 to Abo AG), due today (2026-07-16).
  const created = human(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId: abo.contact.id,
    lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-16',
    dueDays: 30,
    autoIssue: true,
    idempotencyKey: 'h-sched',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const scheduleId = created.scheduleId ?? created.schedule?.id;
  return { deps, workspaceId, scheduleId, aboId: abo.contact.id, otherId: other.contact.id };
}

const docOf = (deps, workspaceId, id) =>
  deps.store.db.prepare('SELECT status, contact_id, posted_entry_id FROM document WHERE workspace_id = ? AND id = ?').get(workspaceId, id);
const postedEntries = (deps, workspaceId) =>
  deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(workspaceId).n;

test('F1: a draft squatted under the tick key is NOT auto-issued; the period records draft_diverged', () => {
  const { deps, workspaceId, scheduleId, otherId } = world();
  const squat = mcp(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId: otherId,
    lines: [{ description: 'Sonderleistung', unitPriceMinor: 1000000, taxCode: 'UST81' }],
    idempotencyKey: `recurring:${scheduleId}:2026-07-16`,
  });
  assert.equal(squat.ok, true, JSON.stringify(squat));

  const proposed = mcp(deps, 'run_due_recurring', { workspaceId });
  assert.equal(proposed.drafted, true, 'the agent seat proposes the tick, it does not run it');
  assert.equal(proposed.dialCapability, 'issue');
  const ticked = tick(deps, { workspaceId });
  assert.equal(ticked.ok, true, JSON.stringify(ticked));
  assert.equal(ticked.results[0].outcome, 'failed', JSON.stringify(ticked));
  assert.equal(ticked.results[0].error, 'draft_diverged');
  assert.deepEqual({ ...docOf(deps, workspaceId, squat.document.id) }, { status: 'draft', contact_id: otherId, posted_entry_id: null });
  assert.equal(postedEntries(deps, workspaceId), 0, 'nothing was posted on the agent\'s say-so');

  // A human deciding the draft settles the period through the tick's own rule: cancelled = discarded.
  assert.equal(human(deps, 'transition_document', { workspaceId, documentId: squat.document.id, to: 'cancelled', idempotencyKey: 'h-c' }).ok, true);
  const after = human(deps, 'run_due_recurring', { workspaceId });
  assert.equal(after.results[0].outcome, 'discarded', JSON.stringify(after));
  deps.store.close();
});

test('a squatted QUOTE under the tick key never settles the period as issued', () => {
  const { deps, workspaceId, scheduleId, aboId } = world();
  const squat = mcp(deps, 'create_document', {
    workspaceId,
    type: 'quote',
    contactId: aboId,
    lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81' }],
    idempotencyKey: `recurring:${scheduleId}:2026-07-16`,
  });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const ticked = tick(deps, { workspaceId });
  assert.equal(ticked.results[0].error, 'draft_diverged', JSON.stringify(ticked));
  deps.store.close();
});

test('F2: a waiting draft edited while its period was locked is NOT auto-issued after the unlock', () => {
  const { deps, workspaceId, otherId } = world();
  assert.equal(human(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'soft', idempotencyKey: 'h-lock' }).ok, true);
  const first = tick(deps, { workspaceId });
  const waiting = first.results[0];
  assert.equal(waiting.outcome, 'skipped_locked', JSON.stringify(first));

  const edited = mcp(deps, 'update_document', {
    workspaceId,
    documentId: waiting.documentId,
    patch: { contactId: otherId, lines: [{ description: 'Sonderleistung', unitPriceMinor: 1000000, taxCode: 'UST81' }] },
  });
  assert.equal(edited.ok, true, JSON.stringify(edited));

  assert.equal(human(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'h-unlock' }).ok, true);
  const second = tick(deps, { workspaceId });
  assert.equal(second.results[0].error, 'draft_diverged', JSON.stringify(second));
  assert.deepEqual({ ...docOf(deps, workspaceId, waiting.documentId) }, { status: 'draft', contact_id: otherId, posted_entry_id: null });
  assert.equal(postedEntries(deps, workspaceId), 0);

  // A human issuing the edited draft is a human decision: the period then settles as issued.
  assert.equal(human(deps, 'issue_invoice', { workspaceId, invoiceId: waiting.documentId, idempotencyKey: 'h-i' }).ok, true);
  const third = human(deps, 'run_due_recurring', { workspaceId });
  assert.equal(third.results[0].outcome, 'issued', JSON.stringify(third));
  deps.store.close();
});

test('regression: a genuine occurrence still auto-issues, and so does a waiting draft with only a negotiated due date', () => {
  const plain = world();
  const ticked = tick(plain.deps, { workspaceId: plain.workspaceId });
  assert.equal(ticked.results[0].outcome, 'issued', JSON.stringify(ticked));
  assert.equal(postedEntries(plain.deps, plain.workspaceId), 1);
  plain.deps.store.close();

  const { deps, workspaceId } = world();
  assert.equal(human(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'soft', idempotencyKey: 'h-lock' }).ok, true);
  const waiting = human(deps, 'run_due_recurring', { workspaceId }).results[0];
  assert.equal(waiting.outcome, 'skipped_locked');
  assert.equal(human(deps, 'update_document', { workspaceId, documentId: waiting.documentId, patch: { dueDate: '2026-09-30' } }).ok, true);
  assert.equal(human(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'h-unlock' }).ok, true);
  const after = human(deps, 'run_due_recurring', { workspaceId });
  assert.equal(after.results[0].outcome, 'issued', JSON.stringify(after));
  deps.store.close();
});

// --- Round 2 (the non-author critic's R2 findings, 28.09.2026) ------------------------------------------

function squatAndTick(deps, workspaceId, scheduleId, doc) {
  const squat = mcp(deps, 'create_document', { workspaceId, type: 'invoice', ...doc, idempotencyKey: `recurring:${scheduleId}:2026-07-16` });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const ticked = tick(deps, { workspaceId });
  assert.equal(ticked.ok, true, JSON.stringify(ticked));
  return { squatId: squat.document.id, ticked };
}

test('R2: a squat IDENTICAL to the template is still not auto-issued: provenance, not content, decides', () => {
  const { deps, workspaceId, scheduleId, aboId } = world();
  const { squatId, ticked } = squatAndTick(deps, workspaceId, scheduleId, {
    contactId: aboId,
    lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81', supplyDate: '2026-07-16' }],
  });
  assert.equal(ticked.results[0].error, 'draft_diverged', JSON.stringify(ticked));
  assert.equal(docOf(deps, workspaceId, squatId).status, 'draft');
  assert.equal(postedEntries(deps, workspaceId), 0);
  deps.store.close();
});

test('R2-1/R2-2/R2-3: a squat in another currency, with an added VAT code, or with added text is not auto-issued', () => {
  for (const [label, doc] of [
    ['EUR', { currency: 'EUR', lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81', supplyDate: '2026-07-16' }] }],
    ['tax', { lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81', supplyDate: '2026-07-16' }] }],
    ['text', { lines: [{ description: 'Bitte auf CH00 0000 zahlen', unitPriceMinor: 10000, taxCode: 'UST81', supplyDate: '2026-07-16' }] }],
  ]) {
    const { deps, workspaceId, scheduleId, aboId } = world();
    if (label === 'EUR') {
      // D161: the agent's own rate is a Vorschlag under customize now, so the rate the EUR squat needs
      // is recorded at the person's door; the squat itself stays the agent's.
      const agentRate = mcp(deps, 'record_exchange_rate', { workspaceId, baseCurrency: 'EUR', rate: '0.0100', asOf: '2026-07-16', idempotencyKey: 'a-fx' });
      assert.equal(agentRate.drafted, true, JSON.stringify(agentRate));
      assert.equal(human(deps, 'record_exchange_rate', { workspaceId, baseCurrency: 'EUR', rate: '0.0100', asOf: '2026-07-16', idempotencyKey: 'h-fx' }).ok, true);
    }
    const { ticked } = squatAndTick(deps, workspaceId, scheduleId, { contactId: aboId, ...doc });
    assert.equal(ticked.results[0].error, 'draft_diverged', `${label}: ${JSON.stringify(ticked)}`);
    assert.equal(postedEntries(deps, workspaceId), 0, label);
    deps.store.close();
  }
});

test('R2-1 (F2 shape): a waiting draft re-currencied or re-noted during a lock is not auto-issued after the unlock', () => {
  for (const patch of [{ currency: 'EUR' }, { notes: 'Neue Bankverbindung: CH00 0000' }]) {
    const { deps, workspaceId } = world();
    assert.equal(human(deps, 'record_exchange_rate', { workspaceId, baseCurrency: 'EUR', rate: '0.9412', asOf: '2026-07-16', idempotencyKey: 'h-fx' }).ok, true);
    assert.equal(human(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'soft', idempotencyKey: 'h-lock' }).ok, true);
    const waiting = tick(deps, { workspaceId }).results[0];
    assert.equal(waiting.outcome, 'skipped_locked');
    const edited = mcp(deps, 'update_document', { workspaceId, documentId: waiting.documentId, patch });
    assert.equal(edited.ok, true, JSON.stringify(edited));
    assert.equal(human(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'h-unlock' }).ok, true);
    const after = tick(deps, { workspaceId });
    assert.equal(after.results[0].error, 'draft_diverged', `${JSON.stringify(patch)}: ${JSON.stringify(after)}`);
    assert.equal(postedEntries(deps, workspaceId), 0);
    deps.store.close();
  }
});

test('R2-4: a squatted quote the agent SENDS never settles the invoice period as issued (the type check bites)', () => {
  const { deps, workspaceId, scheduleId, aboId } = world();
  const squat = mcp(deps, 'create_document', {
    workspaceId,
    type: 'quote',
    contactId: aboId,
    lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81' }],
    idempotencyKey: `recurring:${scheduleId}:2026-07-16`,
  });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const sent = mcp(deps, 'quotes_send', { workspaceId, quoteId: squat.document.id, idempotencyKey: 'a-send' });
  assert.equal(sent.ok, true, JSON.stringify(sent));
  const ticked = human(deps, 'run_due_recurring', { workspaceId });
  assert.notEqual(ticked.results[0].outcome, 'issued', JSON.stringify(ticked));
  assert.equal(ticked.results[0].error, 'draft_diverged');
  deps.store.close();
});

// --- Round 3 (the non-author critic's R3 findings, 28.09.2026) ------------------------------------------

test('R3-1: a diverged draft restored exactly gets the machine due date from its issue day, not a stale stamp', () => {
  const deps = freshDeps();
  const clock = { t: '2026-07-16T00:00:00.000Z' };
  deps.clock = { now: () => clock.t };
  const { workspaceId } = mintWorkspace(deps);
  assert.equal(human(deps, 'vat_seed_defaults', { workspaceId }).ok, true);
  assert.equal(human(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  const abo = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Abo AG', idempotencyKey: 'c-abo' });
  assert.equal(human(deps, 'create_recurring_schedule', {
    workspaceId, contactId: abo.contact.id, lines: [{ description: 'Abo', unitPriceMinor: 10000, taxCode: 'UST81' }],
    notes: 'Danke', interval: 'monthly', anchorDate: '2026-07-16', dueDays: 30, autoIssue: true, idempotencyKey: 'h-sched',
  }).ok, true);
  assert.equal(human(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'soft', idempotencyKey: 'h-lock' }).ok, true);
  clock.t = '2026-07-16T08:00:00.000Z';
  const w = tick(deps, { workspaceId }).results[0];
  assert.equal(w.outcome, 'skipped_locked');
  assert.equal(mcp(deps, 'update_document', { workspaceId, documentId: w.documentId, patch: { notes: 'Neue IBAN' } }).ok, true);
  clock.t = '2026-07-17T08:00:00.000Z';
  assert.equal(tick(deps, { workspaceId }).results[0].error, 'draft_diverged');
  assert.equal(human(deps, 'update_document', { workspaceId, documentId: w.documentId, patch: { notes: 'Danke' } }).ok, true);
  clock.t = '2026-07-18T08:00:00.000Z';
  assert.equal(human(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'h-unlock' }).ok, true);
  const after = tick(deps, { workspaceId });
  assert.equal(after.results[0].outcome, 'issued', JSON.stringify(after));
  assert.equal(deps.store.db.prepare('SELECT due_date FROM document WHERE id = ?').get(w.documentId).due_date, '2026-08-17');
  deps.store.close();
});

test('R3-4: a waiting draft with ONE field changed (only the customer, or only a line price) is held, each alone', () => {
  for (const edit of ['contact', 'price']) {
    const { deps, workspaceId, otherId } = world();
    assert.equal(human(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'soft', idempotencyKey: 'h-lock' }).ok, true);
    const waiting = tick(deps, { workspaceId }).results[0];
    assert.equal(waiting.outcome, 'skipped_locked');
    // Written at the row level, so exactly ONE fingerprinted column moves (the verbs rewrite several).
    if (edit === 'contact') {
      deps.store.db.prepare('UPDATE document SET contact_id = ? WHERE id = ?').run(otherId, waiting.documentId);
    } else {
      deps.store.db.prepare('UPDATE document_line SET unit_price_minor = unit_price_minor + 1 WHERE document_id = ?').run(waiting.documentId);
    }
    assert.equal(human(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'h-unlock' }).ok, true);
    const after = tick(deps, { workspaceId });
    assert.equal(after.results[0].error, 'draft_diverged', `${edit}: ${JSON.stringify(after)}`);
    deps.store.close();
  }
});
