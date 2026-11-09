/**
 * A12 FINAL PROBES (round 3), part of the D72 rebuild's ACCEPTANCE SUITE, adapted from
 * `origin/claude/a12-critic` (docs/critique/a12-critic.md, round 3 appended 31.07.2026).
 *
 * Round 3 is the file that killed the first build, so the polarity here matters most:
 *
 *  - F1, F2, F3 documented holding properties and are adopted as they stood.
 *  - F4 is FLIPPED: the rebuild's re-assert is conditional on the machine stamp (`due_stamped`,
 *    spec 4b), so a due date a human negotiated on the waiting draft now SURVIVES the issue.
 *  - F5 is FLIPPED: a human who hand-issues the skipped_locked draft no longer strands the
 *    schedule; the next tick reads the document's fate, settles the period as `issued` with that
 *    same document, and advances (invariant I2).
 *  - F6 is FLIPPED: cancelling the skipped_locked draft no longer kills the workspace tick; the
 *    next tick finds the memo's document gone, settles the period as `discarded`, advances, and
 *    the healthy sibling schedule bills normally (invariants I2 and I3).
 *  - F7 is NEW, the round-3 test-integrity demand: the clock-day due anchor is pinned on the
 *    DRAFT path, where no re-assert can mask it (the first build's R1 repair was pinned by
 *    nothing and a mutation proved it).
 *
 * The fixture clock is pinned to 2026-07-16 (test/api/support.mjs AT).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { fixedClock } from '../../dist/core/clock.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { workspaceWhereActorHolds } from '../automation/support.mjs';

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

function schedule(deps, workspaceId, contactId, seed, over = {}) {
  const res = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Retainer', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    dueDays: 10,
    autoIssue: true,
    idempotencyKey: `${seed}-schedule`,
    ...over,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.schedule;
}

// --- F1: the cursor and the invoice date are two different facts ---------------------------------

test('F1: a past asOf still bounds the catch-up exactly, and every invoice is due from the CLOCK day', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('f1');
  const created = schedule(deps, workspaceId, contactId, 'f1', { anchorDate: '2024-02-01', dueDays: 30 });

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2024-06-15' });
  assert.equal(res.ok, true, JSON.stringify(res));
  // THE CURSOR SEMANTICS ARE UNCHANGED: asOf still says how far to catch up, and only that.
  assert.equal(res.generated, 5);
  assert.deepEqual(
    res.results.map((r) => r.periodKey),
    ['2024-02-01', '2024-03-01', '2024-04-01', '2024-05-01', '2024-06-01'],
  );
  const cursor = deps.store.db
    .prepare('SELECT next_run_date, occurrences_done, status FROM recurring_schedule WHERE id = ?')
    .get(created.id);
  assert.deepEqual(cursor, { next_run_date: '2024-07-01', occurrences_done: 5, status: 'active' });

  // THE INVOICE DATE IS THE CLOCK'S, and the due date follows it rather than the cursor.
  const rows = deps.store.db
    .prepare('SELECT issue_date, due_date FROM document WHERE workspace_id = ?')
    .all(workspaceId);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.deepEqual(row, { issue_date: '2026-07-16', due_date: '2026-08-15' });
  }

  // And the period is still carried where it is statutory: on the line's Leistungsdatum.
  const pairs = deps.store.db
    .prepare(
      `SELECT r.period_key, l.supply_date FROM recurring_run_log r
         JOIN document_line l ON l.document_id = r.document_id
        WHERE r.workspace_id = ? ORDER BY r.period_key`,
    )
    .all(workspaceId);
  for (const p of pairs) assert.equal(p.supply_date, p.period_key);
});

// --- F2: the crash retry, and what the re-assert may never touch ---------------------------------

test('F2: the crash-retry replay stays idempotent on rows, and the refused patch changes nothing', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('f2');
  const created = schedule(deps, workspaceId, contactId, 'f2');
  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(first.results[0].outcome, 'issued');
  const documentId = first.results[0].documentId;
  const before = deps.store.db
    .prepare('SELECT number, issue_date, due_date, status, posted_entry_id FROM document WHERE id = ?')
    .get(documentId);
  assert.deepEqual(
    { issue_date: before.issue_date, due_date: before.due_date, status: before.status },
    { issue_date: '2026-07-16', due_date: '2026-07-26', status: 'issued' },
  );

  // The C14 shape: a death between issue_invoice's COMMIT and A12's own two writes. The run-log row
  // and the cursor both vanish; the store is left exactly as that crash would leave it.
  deps.store.db.prepare('DELETE FROM recurring_run_log WHERE workspace_id = ?').run(workspaceId);
  deps.store.db
    .prepare("UPDATE recurring_schedule SET next_run_date = '2026-07-01', occurrences_done = 0 WHERE id = ?")
    .run(created.id);

  // The draft-only patch refuses on an issued document, which is what makes any swallow of it safe.
  const refused = call(deps, 'update_document', { workspaceId, documentId, patch: { dueDate: '2099-01-01' } });
  assert.equal(refused.ok, false, 'the patch must refuse on an issued document, or the swallow is unsafe');
  assert.equal(refused.error, 'illegal_transition');
  assert.equal(refused.reason, 'document_immutable');

  // The rebuild's retry reads the document's FATE off the store (invariant I2, one rule with F5):
  // already issued means the period settles as issued with the SAME document, before any patch or
  // issue call is even attempted.
  const retry = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(retry.ok, true, JSON.stringify(retry));
  assert.equal(retry.results[0].outcome, 'issued');
  assert.equal(retry.results[0].documentId, documentId, 'the retry billed a NEW document');

  // §H-AUDIT: an issued document is immutable, so the retry must leave every field of it exactly as
  // it was.
  const after = deps.store.db
    .prepare('SELECT number, issue_date, due_date, status, posted_entry_id FROM document WHERE id = ?')
    .get(documentId);
  assert.deepEqual(after, before, 'the retry mutated an issued document');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(
    count(
      deps,
      "SELECT COUNT(*) AS n FROM recurring_run_log WHERE workspace_id = ? AND outcome IN ('drafted','issued','discarded')",
      workspaceId,
    ),
    1,
  );
});

// --- F3: can a swallowed patch refusal hide a DIFFERENT failure? ---------------------------------

test('F3: no role can separate the patch from the issue, so a rights refusal cannot issue a stale date', () => {
  // THE STRUCTURAL HALF. The conditional re-assert ignores the draft-only patch's refusal, which is
  // safe against a permission refusal only if the patch and the issue resolve to the SAME
  // capability: otherwise an author holding one but not the other would silently issue a posted
  // invoice carrying the draft-day due date. The day someone re-gates either verb, this goes red.
  assert.deepEqual(
    requiredCapabilitiesFor('update_document'),
    requiredCapabilitiesFor('issue_invoice'),
    'update_document and issue_invoice no longer resolve alike: the swallowed refusal can now hide a rights failure',
  );
  assert.deepEqual(requiredCapabilitiesFor('update_document'), ['issue']);

  // THE MEASURED HALF. A demoted author fails BOTH, so nothing is issued at all rather than issued
  // with a stale date, and no document row is written.
  const { deps, workspaceId } = workspaceWhereActorHolds('owner', 'f3');
  deps.actor = 'studio';
  const contact = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Weg AG',
    idempotencyKey: 'f3-contact',
  });
  deps.actor = 'agent';
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId: contact.contact.id,
    lines: [{ unitPriceMinor: 100000 }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    dueDays: 10,
    autoIssue: true,
    idempotencyKey: 'f3-schedule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  deps.actor = 'studio';
  const seat = call(deps, 'list_members', { workspaceId }).members.find((m) => m.actorId === 'agent');
  assert.equal(call(deps, 'set_role', { workspaceId, memberId: seat.memberId, role: 'viewer' }).ok, true);

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true);
  // The refusal lands on create_document, before the patch is ever reached.
  assert.equal(res.results[0].outcome, 'failed');
  assert.equal(res.results[0].error, 'permission_denied');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 0);
});

// --- F4 (FLIPPED): a negotiated due date on the waiting draft SURVIVES the issue -----------------

test('F4: a hand-set due date on an aging schedule draft survives; only the machine stamp is re-asserted', () => {
  // MEASURED ON THE FIRST BUILD: the unconditional re-assert replaced a negotiated 2026-12-31 with
  // issue day + dueDays, while the placement decision claimed hand-set due dates were never
  // clobbered. The rebuild records what it stamped (due_stamped, spec 4b) and re-asserts ONLY while
  // the draft still carries that stamp, so the human's date wins here.
  const { deps, workspaceId, contactId } = sellerWorkspace('f4');
  schedule(deps, workspaceId, contactId, 'f4');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'f4-close' }).ok, true);
  const first = call(deps, 'run_due_recurring', { workspaceId });
  assert.equal(first.results[0].outcome, 'skipped_locked');
  const documentId = first.results[0].documentId;

  // While the draft waits behind the lock, a person agrees a longer payment term with the customer
  // and patches the draft, which is exactly what a mutable draft is for.
  assert.equal(
    call(deps, 'update_document', {
      workspaceId,
      documentId,
      patch: { dueDate: '2026-12-31' },
      idempotencyKey: 'f4-negotiated',
    }).ok,
    true,
  );

  const later = { ...deps, clock: fixedClock('2026-08-27T00:00:00.000Z') };
  assert.equal(call(later, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'f4-open' }).ok, true);
  assert.equal(call(later, 'run_due_recurring', { workspaceId }).results[0].outcome, 'issued');

  // The negotiated date is KEPT: it differs from the recorded stamp, so the re-assert stands down.
  const row = deps.store.db.prepare('SELECT issue_date, due_date FROM document WHERE id = ?').get(documentId);
  assert.deepEqual(row, { issue_date: '2026-08-27', due_date: '2026-12-31' });
});

// --- F5 (FLIPPED): hand-issuing the skipped draft settles the period and the schedule advances ---

test('F5: a human who issues the skipped_locked draft settles the period; the schedule keeps billing', () => {
  // MEASURED ON THE FIRST BUILD: the retry re-drove issue_invoice into A10's transition guard,
  // illegal_transition on every later tick, cursor frozen forever, every later month lost. The
  // rebuild's invariant I2: an issued document, by whoever's hand, means the period IS billed.
  const { deps, workspaceId, contactId } = sellerWorkspace('f5');
  const created = schedule(deps, workspaceId, contactId, 'f5');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'f5-close' }).ok, true);
  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(first.results[0].outcome, 'skipped_locked');
  const documentId = first.results[0].documentId;

  // The operator reads "Übersprungen, Periode gesperrt" in the Serien history, opens the draft the
  // surface links to, reopens the period and issues it by hand. Nothing about that is unreasonable.
  assert.equal(call(deps, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'f5-open' }).ok, true);
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId, to: 'issued', idempotencyKey: 'f5-hand' }).ok,
    true,
  );
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);

  // The next tick verifies the memo's document against the store, reads `issued`, and settles the
  // period with that SAME document. No re-issue, no illegal_transition, no stranding.
  const second = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.results[0].outcome, 'issued');
  assert.equal(second.results[0].documentId, documentId);

  // The cursor advances, and the store holds exactly one invoice and one settle row for the period.
  const row = deps.store.db
    .prepare('SELECT status, next_run_date, occurrences_done FROM recurring_schedule WHERE id = ?')
    .get(created.id);
  assert.deepEqual(row, { status: 'active', next_run_date: '2026-08-01', occurrences_done: 1 });
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(
    count(
      deps,
      "SELECT COUNT(*) AS n FROM recurring_run_log WHERE workspace_id = ? AND outcome IN ('drafted','issued','discarded')",
      workspaceId,
    ),
    1,
  );

  // And it CONVERGES: further ticks find the cursor past asOf and add not one row anywhere.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 0);
  }
  const listed = call(deps, 'list_recurring_schedules', { workspaceId });
  assert.equal(listed.schedules[0].lastOutcome, 'issued');
  assert.equal(listed.schedules[0].lastError, null);
});

// --- F6 (FLIPPED): cancelling the skipped draft discards the period; the workspace keeps billing --

test('F6: cancelling a skipped_locked draft settles the period as discarded; siblings never notice', () => {
  // MEASURED ON THE FIRST BUILD: the retry inserted a run-log row pointing at the deleted document,
  // the FK rejected it, the throw escaped the per-occurrence handling, and run_due_recurring
  // returned unexpected_error for the WHOLE workspace on every later tick, forever. The rebuild
  // never writes a pointer it has not just verified (invariant I2), and a poisoned schedule can
  // only ever freeze its own cursor (invariant I3).
  const { deps, workspaceId, contactId } = sellerWorkspace('f6');
  const poison = schedule(deps, workspaceId, contactId, 'f6');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'f6-close' }).ok, true);
  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(first.results[0].outcome, 'skipped_locked');
  const documentId = first.results[0].documentId;

  // The obvious operator move: discard the draft the tick told you it could not issue.
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId, to: 'cancelled', idempotencyKey: 'f6-cancel' }).ok,
    true,
  );
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);
  assert.equal(call(deps, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'f6-open' }).ok, true);

  // A SECOND, entirely healthy schedule, sharing nothing with the first but the workspace.
  const healthy = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Gesund', unitPriceMinor: 500000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-05',
    dueDays: 10,
    autoIssue: true,
    idempotencyKey: 'f6-healthy',
  });
  assert.equal(healthy.ok, true);

  // The tick SURVIVES: the memo's document is gone, so the period settles `discarded` and the
  // cursor advances; the healthy sibling bills its own period in the same call.
  const tick = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(tick.ok, true, JSON.stringify(tick));
  const byOutcome = Object.fromEntries(tick.results.map((r) => [r.outcome, r]));
  assert.equal(byOutcome.discarded.scheduleId, poison.id);
  assert.equal(byOutcome.discarded.periodKey, '2026-07-01');
  assert.equal(byOutcome.issued.scheduleId, healthy.schedule.id);
  assert.equal(tick.generated, 1, 'a discard generates nothing; the sibling generates one');

  // THE BLAST RADIUS IS ZERO: the healthy schedule billed, the poisoned one advanced past the
  // period its human discarded, and neither is stranded.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);
  assert.deepEqual(
    deps.store.db.prepare('SELECT status, next_run_date, occurrences_done FROM recurring_schedule WHERE id = ?').get(poison.id),
    { status: 'active', next_run_date: '2026-08-01', occurrences_done: 1 },
  );
  assert.deepEqual(
    deps.store.db.prepare('SELECT status, next_run_date, occurrences_done FROM recurring_schedule WHERE id = ?').get(healthy.schedule.id),
    { status: 'active', next_run_date: '2026-08-05', occurrences_done: 1 },
  );
  // The discarded settle occupies the partial index with a NULL pointer: the period a human
  // discarded is never re-billed, and no row anywhere names the deleted document.
  const settle = deps.store.db
    .prepare("SELECT document_id, outcome FROM recurring_run_log WHERE schedule_id = ? AND outcome = 'discarded'")
    .get(poison.id);
  assert.deepEqual(settle, { document_id: null, outcome: 'discarded' });

  // And it CONVERGES: further ticks are ok and add nothing.
  for (let i = 0; i < 3; i += 1) {
    const again = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
    assert.equal(again.ok, true);
    assert.equal(again.generated, 0);
  }
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
});

// --- F7 (NEW): the clock-day due anchor, pinned on the DRAFT path --------------------------------

test('F7: the draft path anchors the due date on the CLOCK day too, where no re-assert can mask it', () => {
  // The first build's R1 repair was pinned by NOTHING: reverting the clock-day anchor left 49/49
  // green, because the adopted probe used autoIssue and the issue-time re-assert overwrote the
  // create-time date. This probe is the missing pin: review mode, past asOf, no issue call at all.
  const { deps, workspaceId, contactId } = sellerWorkspace('f7');
  const created = schedule(deps, workspaceId, contactId, 'f7', {
    anchorDate: '2024-02-01',
    dueDays: 30,
    autoIssue: false,
  });

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2024-06-15' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.generated, 5);
  for (const r of res.results) assert.equal(r.outcome, 'drafted');

  const dueDates = deps.store.db
    .prepare('SELECT DISTINCT due_date FROM document WHERE workspace_id = ?')
    .all(workspaceId)
    .map((r) => r.due_date);
  // Clock day 2026-07-16 plus 30, never the asOf cursor's 2024-07-15.
  assert.deepEqual(dueDates, ['2026-08-15']);

  // And the stamp is recorded per settle, which is what the issue-time comparison reads (spec 4b).
  const stamps = deps.store.db
    .prepare('SELECT DISTINCT due_stamped FROM recurring_run_log WHERE schedule_id = ?')
    .all(created.id)
    .map((r) => r.due_stamped);
  assert.deepEqual(stamps, ['2026-08-15']);
});
