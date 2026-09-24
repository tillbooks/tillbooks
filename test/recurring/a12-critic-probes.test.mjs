/**
 * A12 CRITIC PROBES (round 1), the D72 rebuild's ACCEPTANCE SUITE, adapted from
 * `origin/claude/a12-critic` (docs/critique/a12-critic.md, 30.07.2026).
 *
 * The critic wrote these against the FIRST build; the rebuild must pass every one, semantics
 * identical. Adaptation for the rebuild's schema: the run-log settled outcome set gained
 * `discarded` (spec 4b), so C13 additionally asserts that a duplicate `discarded` settle is
 * refused by the same partial UNIQUE index. Every assertion is a ROW read back out of the store.
 *
 * The fixture clock is pinned to 2026-07-16 (test/api/support.mjs AT).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

function sellerWorkspace(seed, actor = 'agent') {
  const deps = freshDeps();
  deps.actor = actor;
  const { workspaceId, accId } = mintWorkspace(deps, 'Serie GmbH', `${seed}-ws`);
  assert.equal(call(deps, 'vat_seed_defaults', { workspaceId }).ok, true);
  assert.equal(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }).ok, true);
  assert.equal(
    call(deps, 'vat_configure', { workspaceId, method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: `${seed}-vat` }).ok,
    true,
  );
  assert.equal(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Serie GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }).ok,
    true,
  );
  const contact = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Muster AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    idempotencyKey: `${seed}-contact`,
  });
  assert.equal(contact.ok, true);
  return { deps, workspaceId, accId, contactId: contact.contact.id };
}

// --- C1 (FLIPPED): each catch-up period books at ITS OWN era, dated by one rule ------------------

test('C1: catch-up prices each period at its own VAT era, stamps the Leistungsdatum, and is not born overdue', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c1');
  // A retainer running since October 2023, auto-issuing, ticked today. MEASURED BEFORE THE REPAIR:
  // all 24 periods booked 8.1% (CHF 81.00 on 1000.00), supply_date NULL, due_date years before
  // issue_date. The statutory rule (ESTV, MWSTG Art. 25): massgebend is the Zeitpunkt der
  // Leistungserbringung, so a 2023 period books 7.7%.
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Retainer', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2023-10-01',
    dueDays: 30,
    autoIssue: true,
    idempotencyKey: 'c1-schedule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.generated, 24);
  assert.equal(res.results[0].periodKey, '2023-10-01');
  assert.equal(res.results[23].periodKey, '2025-09-01');

  const rows = deps.store.db
    .prepare(
      `SELECT r.period_key, d.issue_date, d.due_date, d.number, d.tax_minor,
              (SELECT jl.supply_date FROM journal_line jl WHERE jl.entry_id = d.posted_entry_id
                 AND jl.tax_code IS NOT NULL LIMIT 1) AS supply_date
         FROM recurring_run_log r JOIN document d ON d.id = r.document_id
        WHERE r.workspace_id = ? AND r.period_key IN ('2023-10-01','2023-12-01','2024-01-01','2024-02-01')
        ORDER BY r.period_key`,
    )
    .all(workspaceId);
  assert.equal(rows.length, 4);

  for (const row of rows) {
    // The Leistungsdatum IS the period, stamped by the tick onto every generated line.
    assert.equal(row.supply_date, row.period_key, `period ${row.period_key} carries its own Leistungsdatum`);
    // Each period at its own era: 7.7% before 2024-01-01, 8.1% from it.
    const statutory = row.period_key < '2024-01-01' ? 7700 : 8100;
    assert.equal(row.tax_minor, statutory, `period ${row.period_key} books its own era's rate`);
    // C1b, the one-rule decision: payment terms run from the Rechnungsdatum, so a catch-up invoice
    // is due dueDays after the day it was ISSUED, never years before it.
    assert.equal(row.issue_date, '2026-07-16');
    assert.equal(row.due_date, '2026-08-15');
    assert.ok(row.due_date >= row.issue_date, `due ${row.due_date} precedes issue ${row.issue_date}`);
    // Numbered in the issue year, consistently with the issue-anchored rule.
    assert.ok(row.number.startsWith('R-2026-'), row.number);
  }

  // The burst still posts on one day's ledger: that is the C1b rule stated from the other side.
  const dates = deps.store.db
    .prepare('SELECT DISTINCT date FROM journal_entry WHERE workspace_id = ?')
    .all(workspaceId)
    .map((r) => r.date);
  assert.deepEqual(dates, ['2026-07-16']);
});

test('C2: the honest 2023 configuration (a workspace 7.7% code) generates every period at its own era', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c2');
  // MEASURED BEFORE THE REPAIR: needs_supply_date on every tick, forever, pointer frozen at
  // 2023-10-01, one orphan draft. A11's era-ambiguity refusal was right to fire; the tick simply
  // never said which period it was billing.
  const code = call(deps, 'vat_code_upsert', {
    workspaceId,
    code: 'UST77',
    kind: 'output',
    rateBp: 770,
    formLine: '302',
    label: 'Umsatzsteuer 7.7% (Normalsatz, bis 2023)',
    idempotencyKey: 'c2-code',
  });
  assert.equal(code.ok, true, JSON.stringify(code));

  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Retainer 2023', unitPriceMinor: 100000, taxCode: 'UST77' }],
    interval: 'monthly',
    anchorDate: '2023-10-01',
    autoIssue: true,
    idempotencyKey: 'c2-schedule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.generated, 24, JSON.stringify(first.results[0]));
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 24);

  const taxes = deps.store.db
    .prepare(
      `SELECT r.period_key, d.tax_minor FROM recurring_run_log r JOIN document d ON d.id = r.document_id
        WHERE r.workspace_id = ? AND r.period_key IN ('2023-10-01','2024-01-01') ORDER BY r.period_key`,
    )
    .all(workspaceId);
  assert.deepEqual(taxes, [
    { period_key: '2023-10-01', tax_minor: 7700 },
    { period_key: '2024-01-01', tax_minor: 8100 },
  ]);

  const row = deps.store.db
    .prepare('SELECT next_run_date, occurrences_done, status FROM recurring_schedule WHERE id = ?')
    .get(created.schedule.id);
  assert.deepEqual(
    { next_run_date: row.next_run_date, occurrences_done: row.occurrences_done, status: row.status },
    { next_run_date: '2025-10-01', occurrences_done: 24, status: 'active' },
  );
});

// --- C3 (FLIPPED): a generated draft is cancellable; the log keeps the period, not the pointer ---

test('C3: a schedule-generated draft cancels cleanly; the settled log row survives with a null pointer', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c3');
  // MEASURED BEFORE THE REPAIR: the run log's bare FK made the delete fail with a raw
  // 'FOREIGN KEY constraint failed' surfaced as unexpected_error.
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 200000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    idempotencyKey: 'c3-schedule',
  });
  assert.equal(created.ok, true);
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.results[0].outcome, 'drafted');
  const documentId = res.results[0].documentId;

  const cancelled = call(deps, 'transition_document', {
    workspaceId,
    documentId,
    to: 'cancelled',
    idempotencyKey: 'c3-cancel',
  });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);

  // ON DELETE SET NULL: the period, outcome and timestamp survive; only the pointer goes.
  const log = deps.store.db
    .prepare('SELECT period_key, document_id, outcome FROM recurring_run_log WHERE workspace_id = ?')
    .all(workspaceId);
  assert.deepEqual(log, [{ period_key: '2026-07-01', document_id: null, outcome: 'drafted' }]);

  // And the settled row still occupies the partial UNIQUE index: a period whose draft a human
  // deliberately discarded is NOT re-billed by the next tick, which would undo that decision.
  const again = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(again.generated, 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);
});

// --- C4 (FLIPPED): the end date bounds the series on both sides ----------------------------------

test('C4: endDate before anchorDate is refused, and a pending period behind a moved-back end date is not billed', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c4');
  // MEASURED BEFORE THE REPAIR: the impossible pair was accepted silently and the excluded anchor
  // period was billed once before the schedule ended.
  const refused = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ unitPriceMinor: 1000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-06-01',
    endDate: '2026-05-31',
    idempotencyKey: 'c4-a',
  });
  assert.equal(refused.error, 'end_before_anchor');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM recurring_schedule WHERE workspace_id = ?', workspaceId), 0);

  // The live variant: settle June, then move the end date behind the pending July occurrence.
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 200000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-06-01',
    idempotencyKey: 'c4-b',
  });
  assert.equal(created.ok, true);
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-06-30' }).generated, 1);

  const patched = call(deps, 'update_recurring_schedule', {
    workspaceId,
    scheduleId: created.schedule.id,
    patch: { endDate: '2026-06-20' },
  });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  // The patch itself refuses the impossible pair too.
  assert.equal(
    call(deps, 'update_recurring_schedule', {
      workspaceId,
      scheduleId: created.schedule.id,
      patch: { endDate: '2026-05-01' },
    }).error,
    'end_before_anchor',
  );

  // The pending 2026-07-01 occurrence sits BEHIND the end date: it is not billed, the schedule ends.
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.generated, 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(
    deps.store.db.prepare('SELECT status FROM recurring_schedule WHERE id = ?').get(created.schedule.id).status,
    'ended',
  );
});

// --- C5 (FLIPPED): a dead author is visible on the LIST ------------------------------------------

test('C5: a REVOKED author stops the schedule, and the LIST says so via lastOutcome/lastError', () => {
  const { deps, workspaceId } = (() => {
    const d = freshDeps();
    d.actor = 'studio';
    const { workspaceId } = mintWorkspace(d, 'Weg GmbH', 'c5-ws');
    const invited = call(d, 'invite_member', {
      workspaceId,
      email: 'c5@muster.ch',
      role: 'owner',
      idempotencyKey: 'c5-invite',
    });
    assert.equal(invited.ok, true);
    return { deps: d, workspaceId };
  })();

  const contact = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Weg AG',
    idempotencyKey: 'c5-contact',
  });
  assert.equal(contact.ok, true);

  deps.actor = 'agent';
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId: contact.contact.id,
    lines: [{ unitPriceMinor: 1000 }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    idempotencyKey: 'c5-schedule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  // The author leaves the company: their seat is revoked outright, not demoted.
  deps.actor = 'studio';
  const seat = call(deps, 'list_members', { workspaceId }).members.find((m) => m.actorId === 'agent');
  assert.equal(call(deps, 'revoke_member', { workspaceId, memberId: seat.memberId }).ok, true);

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  // The tick refuses to generate, per occurrence, and writes no document. This half always held.
  assert.equal(res.ok, true);
  assert.equal(res.results[0].outcome, 'failed');
  assert.equal(res.results[0].error, 'permission_denied');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);

  // MEASURED BEFORE THE REPAIR: the list said only `active`, with no failure signal anywhere on it.
  const listed = call(deps, 'list_recurring_schedules', { workspaceId });
  assert.equal(listed.ok, true);
  assert.equal(listed.schedules[0].status, 'active');
  assert.equal(listed.schedules[0].lastOutcome, 'failed');
  assert.equal(listed.schedules[0].lastError, 'permission_denied');
});

// --- C6 (KEPT, decided): D66 keeps the three lifecycle verbs automatable -------------------------

test('C6 (D66): a rule may resume a paused schedule, and the catch-up then fires, on the record', () => {
  // The critic put this to the owner; D66 (30.07.2026, DECISIONS.md) keeps pause, resume AND end
  // automatable: the run log records every generated occurrence, the 24-period cap bounds the
  // burst, and the fire-time denylist still refuses the three A12 writer verbs. This probe now
  // ASSERTS the decided behaviour, so a future denylist edit that silently revokes D66 goes red.
  const { deps, workspaceId, contactId } = sellerWorkspace('c6', 'studio');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 500000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-04-01',
    autoIssue: true,
    idempotencyKey: 'c6-schedule',
  });
  assert.equal(created.ok, true);
  assert.equal(call(deps, 'pause_recurring_schedule', { workspaceId, scheduleId: created.schedule.id }).ok, true);

  const rule = call(deps, 'create_automation_rule', {
    workspaceId,
    name: 'Serie wieder starten',
    trigger: { event: 'contact.created' },
    action: { tool: 'resume_recurring_schedule', inputTemplate: { scheduleId: created.schedule.id } },
    idempotencyKey: 'c6-rule',
  });
  assert.equal(rule.ok, true, `resume_recurring_schedule was refused at save, against D66: ${JSON.stringify(rule)}`);

  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Neu AG', idempotencyKey: 'c6-new' }).ok,
    true,
  );
  assert.equal(
    deps.store.db.prepare('SELECT status FROM recurring_schedule WHERE id = ?').get(created.schedule.id).status,
    'active',
    'the rule did not fire; the probe needs a different trigger',
  );

  // The accepted cost D66 states plainly: the next tick bills the pause window, auditable per row.
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.generated, 4);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 4);
});

// --- C7: the 24 cap does not drop, but a long pause floods one day --------------------------------

test('C7: a 30-month backlog converges over ticks (nothing dropped), all dated the same day', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c7');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2024-01-01',
    idempotencyKey: 'c7-schedule',
  });
  assert.equal(created.ok, true);

  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(first.generated, 24, 'the cap admits 24 in one tick');
  const second = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  // Period 25+ is NOT dropped: the same day's second tick picks it up.
  assert.equal(second.generated, 7, '2026-01-01 .. 2026-07-01 remain and settle on the next tick');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 31);
  const row = deps.store.db
    .prepare('SELECT next_run_date, occurrences_done FROM recurring_schedule WHERE id = ?')
    .get(created.schedule.id);
  assert.deepEqual(row, { next_run_date: '2026-08-01', occurrences_done: 31 });
});

// --- C8: partial failure mid-catch-up -------------------------------------------------------------

test('C8: five periods settle once, and five further ticks add not one row anywhere', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c8');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-03-01',
    autoIssue: true,
    idempotencyKey: 'c8-schedule',
  });
  assert.equal(created.ok, true);
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 5);

  const docs = count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId);
  const entries = count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId);
  assert.equal(docs, 5);
  assert.equal(entries, 5);

  for (let i = 0; i < 5; i += 1) call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), docs);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), entries);
  assert.equal(
    count(
      deps,
      "SELECT COUNT(*) AS n FROM recurring_run_log WHERE workspace_id = ? AND outcome IN ('drafted','issued')",
      workspaceId,
    ),
    5,
  );
});

// --- C9 (FLIPPED): the template cannot pin a Leistungsdatum --------------------------------------

test('C9: a supplyDate on a template line is STRIPPED at store; every generated line carries its period', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c9');
  // MEASURED BEFORE THE REPAIR: the smuggled date survived the additionalProperties boundary into
  // lines_json and every generated period claimed the same January Leistungsdatum.
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2026-01-15' }],
    interval: 'monthly',
    anchorDate: '2026-05-01',
    autoIssue: true,
    idempotencyKey: 'c9-schedule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  // The whitelist store: no supplyDate key survives into the template.
  const stored = JSON.parse(
    deps.store.db.prepare('SELECT lines_json FROM recurring_schedule WHERE id = ?').get(created.schedule.id).lines_json,
  );
  assert.equal(Object.hasOwn(stored[0], 'supplyDate'), false, 'the template stored a Leistungsdatum');

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.generated, 3);
  const supplyDates = deps.store.db
    .prepare('SELECT DISTINCT supply_date FROM document_line WHERE workspace_id = ? ORDER BY supply_date')
    .all(workspaceId)
    .map((r) => r.supply_date);
  // May, June and July each carry their OWN period as the Leistungsdatum.
  assert.deepEqual(supplyDates, ['2026-05-01', '2026-06-01', '2026-07-01']);
});

// --- C10: the denylist at FIRE time, not only at save time (the F5 four-layer pattern) -----------

test('C10: a rule stored BEFORE leg (e) existed is still refused at fire time, on rows', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c10', 'studio');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-04-01',
    autoIssue: true,
    idempotencyKey: 'c10-schedule',
  });
  assert.equal(created.ok, true);

  for (const tool of ['run_due_recurring', 'create_recurring_schedule', 'update_recurring_schedule']) {
    // Saved with a legal action, then its column rewritten: exactly the row `createAutomationRule`
    // would have written one commit before the denylist entry existed.
    const rule = call(deps, 'create_automation_rule', {
      workspaceId,
      name: `alt ${tool}`,
      trigger: { event: 'contact.created' },
      action: { tool: 'contacts_tag', inputTemplate: { contactId, segments: ['a'] } },
      idempotencyKey: `c10-${tool}`,
    });
    assert.equal(rule.ok, true, JSON.stringify(rule));
    deps.store.db
      .prepare('UPDATE automation_rule SET action_tool = ?, action_input = ? WHERE workspace_id = ? AND id = ?')
      .run(tool, JSON.stringify({}), workspaceId, rule.rule.ruleId);
  }

  assert.equal(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Auslöser AG', idempotencyKey: 'c10-c' }).ok,
    true,
  );
  const rows = deps.store.db
    .prepare('SELECT action_tool, status, error_code FROM automation_run WHERE workspace_id = ? ORDER BY id')
    .all(workspaceId);
  assert.equal(rows.length, 3, JSON.stringify(rows));
  for (const row of rows) {
    assert.equal(row.status, 'failed', `the fire path executed ${row.action_tool}`);
    assert.equal(row.error_code, 'action_not_automatable');
  }
  // And nothing was generated or minted by the refused firings.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM recurring_schedule WHERE workspace_id = ?', workspaceId), 1);
});

// --- C11: numbering interleaves with hand-issued invoices, gap-free ------------------------------

test('C11: auto-issued numbers interleave with manual ones, gap-free and without a duplicate', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c11');
  // One invoice issued by hand FIRST, so the sequence is already in motion.
  const manualA = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId,
    lines: [{ description: 'Handarbeit', unitPriceMinor: 10000, taxCode: 'UST81' }],
    idempotencyKey: 'c11-man-a',
  });
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId: manualA.document.id, to: 'issued', idempotencyKey: 'c11-iss-a' }).ok,
    true,
  );

  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Serie', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-05-01',
    autoIssue: true,
    idempotencyKey: 'c11-schedule',
  });
  assert.equal(created.ok, true);
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 3);

  const manualB = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId,
    lines: [{ description: 'Handarbeit 2', unitPriceMinor: 10000, taxCode: 'UST81' }],
    idempotencyKey: 'c11-man-b',
  });
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId: manualB.document.id, to: 'issued', idempotencyKey: 'c11-iss-b' }).ok,
    true,
  );

  const numbers = deps.store.db
    .prepare("SELECT number FROM document WHERE workspace_id = ? AND number IS NOT NULL ORDER BY number")
    .all(workspaceId)
    .map((r) => r.number);
  assert.deepEqual(numbers, ['R-2026-0001', 'R-2026-0002', 'R-2026-0003', 'R-2026-0004', 'R-2026-0005']);
  assert.equal(new Set(numbers).size, numbers.length, 'a number was issued twice');
});

// --- C12: §H-TENANT on the template references ---------------------------------------------------

test('C12: a schedule cannot reference a contact or a template document from another workspace', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c12');
  const other = mintWorkspace(deps, 'Fremd GmbH', 'c12-other');
  const foreignDoc = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId,
    lines: [{ description: 'Fremd', unitPriceMinor: 1000 }],
    idempotencyKey: 'c12-doc',
  });
  assert.equal(foreignDoc.ok, true);

  const byContact = call(deps, 'create_recurring_schedule', {
    workspaceId: other.workspaceId,
    contactId,
    lines: [{ unitPriceMinor: 1000 }],
    interval: 'monthly',
    anchorDate: '2026-08-01',
    idempotencyKey: 'c12-a',
  });
  assert.equal(byContact.error, 'needs_customer');

  const byTemplate = call(deps, 'create_recurring_schedule', {
    workspaceId: other.workspaceId,
    templateDocumentId: foreignDoc.document.id,
    interval: 'monthly',
    anchorDate: '2026-08-01',
    idempotencyKey: 'c12-b',
  });
  assert.equal(byTemplate.error, 'not_found');
  assert.equal(
    count(deps, 'SELECT COUNT(*) AS n FROM recurring_schedule WHERE workspace_id = ?', other.workspaceId),
    0,
  );
});

// --- C13: the partial UNIQUE index, on both halves ------------------------------------------------

test('C13: the settled half of the run-log index refuses a duplicate; the retryable half admits many', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c13');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    idempotencyKey: 'c13-schedule',
  });
  assert.equal(created.ok, true);
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.results[0].outcome, 'drafted');
  const scheduleId = created.schedule.id;

  const insert = (outcome, id, documentId = null) =>
    deps.store.db
      .prepare(
        `INSERT INTO recurring_run_log (id, workspace_id, schedule_id, period_key, document_id, outcome, error, ran_at)
         VALUES (?, ?, ?, '2026-07-01', ?, ?, NULL, '2026-07-16T00:00:00.000Z')`,
      )
      .run(id, workspaceId, scheduleId, documentId, outcome);

  assert.throws(() => insert('drafted', 'dup_1'), /UNIQUE constraint failed/);
  assert.throws(() => insert('issued', 'dup_2'), /UNIQUE constraint failed/);
  // The rebuild's third settled outcome (spec 4b): a discarded period is settled exactly like a
  // drafted or issued one, so it can never settle twice either.
  assert.throws(() => insert('discarded', 'dup_3'), /UNIQUE constraint failed/);
  // The retryable half is deliberately outside the index: many observations of one period are legal.
  insert('failed', 'obs_1');
  insert('failed', 'obs_2');
  insert('skipped_locked', 'obs_3');
  assert.equal(
    count(deps, "SELECT COUNT(*) AS n FROM recurring_run_log WHERE schedule_id = ? AND period_key = '2026-07-01'", scheduleId),
    4,
  );
});

// --- C14: the crash between the invoked verb's commit and the run log's write --------------------

test('C14: a lost run-log write does not re-bill: the invoked verb replays its memo', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('c14');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    autoIssue: true,
    idempotencyKey: 'c14-schedule',
  });
  assert.equal(created.ok, true);
  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(first.results[0].outcome, 'issued');
  const documentId = first.results[0].documentId;

  // Simulate the death between `issue_invoice`'s COMMIT and A12's own two writes: the run-log row
  // and the pointer advance both vanish, and the store is left exactly as that crash would leave it.
  deps.store.db.prepare('DELETE FROM recurring_run_log WHERE workspace_id = ?').run(workspaceId);
  deps.store.db
    .prepare("UPDATE recurring_schedule SET next_run_date = '2026-07-01', occurrences_done = 0 WHERE id = ?")
    .run(created.schedule.id);

  const retry = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.results[0].outcome, 'issued');
  assert.equal(retry.results[0].documentId, documentId, 'the retry billed a NEW document');
  // The row-level proof: one document, one number, one journal entry, one settle row.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(
    count(
      deps,
      "SELECT COUNT(*) AS n FROM recurring_run_log WHERE workspace_id = ? AND outcome IN ('drafted','issued')",
      workspaceId,
    ),
    1,
  );
});

// --- C15 (FLIPPED): the taxless-template shape still exists on the WIRE, and stays legal ---------

test('C15: a code-less template bills zero VAT BY EXPLICIT CHOICE on the wire; the Studio now always offers the picker', () => {
  // The surface half of the repair lives in `app/src/surfaces/Recurring/`: every position row
  // mounts the A06 TaxCodePicker (asserted by the component suite), so the Studio can no longer
  // build this shape by omission. The WIRE keeps accepting it, deliberately: a code-less line is
  // how a non-registered seller or an exempt supply is expressed, exactly as on `create_document`.
  // This probe pins that boundary so the engine half is never "fixed" into refusing it.
  const { deps, workspaceId, contactId } = sellerWorkspace('c15');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', quantityMilli: 1000, unitPriceMinor: 200000 }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    autoIssue: true,
    idempotencyKey: 'c15-schedule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.results[0].outcome, 'issued');
  const doc = deps.store.db
    .prepare('SELECT number, subtotal_minor, tax_minor, total_minor FROM document WHERE workspace_id = ?')
    .get(workspaceId);
  assert.equal(doc.tax_minor, 0);
  assert.equal(doc.total_minor, 200000);
  assert.ok(doc.number.startsWith('R-2026-'));
  assert.equal(
    count(
      deps,
      `SELECT COUNT(*) AS n FROM journal_line jl JOIN journal_entry je ON je.id = jl.entry_id
        WHERE je.workspace_id = ? AND jl.tax_code IS NOT NULL`,
      workspaceId,
    ),
    0,
  );
});
