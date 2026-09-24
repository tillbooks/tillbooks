/**
 * A12's own unit suite: what the adopted critic corpus does not already pin.
 *
 * The corpus (a12-critic-probes / a12-recritic-probes / a12-final-probes) owns the triangle, the
 * supply-date law, the due-date law and the idempotency rows. This file owns the plainer floor:
 * the date arithmetic as pure functions, the lifecycle verbs' own semantics, the tick's boundary
 * refusals, the bounds (endDate, maxOccurrences), tenancy on the reads, and the snapshot path.
 *
 * The fixture clock is pinned to 2026-07-16 (test/api/support.mjs AT).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { occurrenceAt, nextOccurrenceAfter, firstOccurrenceOnOrAfter, addDays } from '../../dist/core/recurring/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);
const count = (deps, sql, ...args) => deps.store.db.prepare(sql).get(...args).n;

function world(seed) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Serie GmbH', `${seed}-ws`);
  assert.equal(call(deps, 'vat_seed_defaults', { workspaceId }).ok, true);
  const contact = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Muster AG',
    idempotencyKey: `${seed}-contact`,
  });
  assert.equal(contact.ok, true);
  return { deps, workspaceId, accId, contactId: contact.contact.id };
}

function mkSchedule(deps, workspaceId, contactId, seed, over = {}) {
  const res = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    idempotencyKey: `${seed}-schedule`,
    ...over,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.schedule;
}

// --- The date arithmetic, as pure functions ------------------------------------------------------

test('dates: the month-end clamp re-anchors from the anchor day, and custom strides are plain days', () => {
  // Anchored on the 31st: shorter months clamp, longer months return to the 31st.
  assert.equal(occurrenceAt('2026-01-31', 'monthly', null, 1), '2026-02-28');
  assert.equal(occurrenceAt('2026-01-31', 'monthly', null, 2), '2026-03-31');
  assert.equal(occurrenceAt('2026-01-31', 'monthly', null, 3), '2026-04-30');
  // A leap February keeps the 29th.
  assert.equal(occurrenceAt('2028-01-31', 'monthly', null, 1), '2028-02-29');
  // Quarterly and yearly are month math too, with the same clamp.
  assert.equal(occurrenceAt('2026-11-30', 'quarterly', null, 1), '2027-02-28');
  assert.equal(occurrenceAt('2024-02-29', 'yearly', null, 1), '2025-02-28');
  // Custom is a day stride, no month semantics at all.
  assert.equal(occurrenceAt('2026-07-01', 'custom', 10, 3), '2026-07-31');
  // The next-after walk lands on the series, never off it.
  assert.equal(nextOccurrenceAfter('2026-01-31', 'monthly', null, '2026-02-28'), '2026-03-31');
  assert.equal(firstOccurrenceOnOrAfter('2026-01-31', 'monthly', null, '2026-03-01'), '2026-03-31');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});

// --- Create: validation and the snapshot path ----------------------------------------------------

test('create: refusals name their field, and no refusal writes a row', () => {
  const { deps, workspaceId, contactId } = world('c-val');
  const base = { workspaceId, contactId, lines: [{ unitPriceMinor: 1000 }], idempotencyKey: 'v-1' };
  assert.equal(call(deps, 'create_recurring_schedule', { ...base, interval: 'fortnightly', anchorDate: '2026-07-01' }).error, 'invalid_input');
  assert.equal(call(deps, 'create_recurring_schedule', { ...base, interval: 'custom', anchorDate: '2026-07-01' }).error, 'invalid_input');
  assert.equal(call(deps, 'create_recurring_schedule', { ...base, interval: 'monthly', anchorDate: '2026-02-30' }).error, 'invalid_input');
  assert.equal(call(deps, 'create_recurring_schedule', { ...base, interval: 'monthly', anchorDate: '01.07.2026' }).error, 'invalid_input');
  assert.equal(call(deps, 'create_recurring_schedule', { ...base, interval: 'monthly', anchorDate: '2026-07-01', dueDays: -1 }).error, 'invalid_input');
  assert.equal(call(deps, 'create_recurring_schedule', { ...base, interval: 'monthly', anchorDate: '2026-07-01', maxOccurrences: 0 }).error, 'invalid_input');
  // No customer, and no positions, are their own P9 codes (US-A12.1).
  assert.equal(call(deps, 'create_recurring_schedule', { workspaceId, lines: [{ unitPriceMinor: 1000 }], interval: 'monthly', anchorDate: '2026-07-01', idempotencyKey: 'v-2' }).error, 'needs_customer');
  assert.equal(call(deps, 'create_recurring_schedule', { workspaceId, contactId, interval: 'monthly', anchorDate: '2026-07-01', idempotencyKey: 'v-3' }).error, 'needs_positions');
  assert.equal(call(deps, 'create_recurring_schedule', { workspaceId, contactId, lines: [], interval: 'monthly', anchorDate: '2026-07-01', idempotencyKey: 'v-4' }).error, 'needs_positions');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM recurring_schedule WHERE workspace_id = ?', workspaceId), 0);
});

test('create: a snapshot from a real document copies the whitelist and never the supply date', () => {
  const { deps, workspaceId, contactId } = world('c-snap');
  const doc = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId,
    currency: 'CHF',
    notes: 'Vorlage',
    lines: [
      { description: 'Beratung', quantityMilli: 2000, unitPriceMinor: 50000, taxCode: 'UST81', supplyDate: '2026-01-15' },
      { description: 'Spesen', unitPriceMinor: 12000 },
    ],
    idempotencyKey: 'snap-doc',
  });
  assert.equal(doc.ok, true);
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    templateDocumentId: doc.document.id,
    interval: 'quarterly',
    anchorDate: '2026-10-01',
    idempotencyKey: 'snap-1',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.schedule.contactId, contactId, 'the contact came from the snapshot');
  assert.equal(created.schedule.lines.length, 2);
  assert.deepEqual(created.schedule.lines[0], {
    description: 'Beratung',
    quantityMilli: 2000,
    unitPriceMinor: 50000,
    taxCode: 'UST81',
  });
  for (const line of created.schedule.lines) {
    assert.equal(Object.hasOwn(line, 'supplyDate'), false, 'the snapshot copied a Leistungsdatum');
  }
  // And the snapshot is a COPY: editing the source document later changes nothing on the schedule.
  assert.equal(
    call(deps, 'update_document', { workspaceId, documentId: doc.document.id, patch: { lines: [{ unitPriceMinor: 1 }] } }).ok,
    true,
  );
  const after = call(deps, 'get_recurring_schedule', { workspaceId, scheduleId: created.schedule.id });
  assert.equal(after.schedule.lines[0].unitPriceMinor, 50000);
});

test('create: replaying the same idempotencyKey returns the SAME schedule, never a second one', () => {
  const { deps, workspaceId, contactId } = world('c-idem');
  const first = mkSchedule(deps, workspaceId, contactId, 'idem');
  const replay = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    idempotencyKey: 'idem-schedule',
  });
  assert.equal(replay.ok, true);
  assert.equal(replay.schedule.id, first.id);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM recurring_schedule WHERE workspace_id = ?', workspaceId), 1);
});

// --- The lifecycle verbs -------------------------------------------------------------------------

test('lifecycle: active <-> paused -> ended; ended is terminal; every transition settles idempotently', () => {
  const { deps, workspaceId, contactId } = world('lc');
  const s = mkSchedule(deps, workspaceId, contactId, 'lc');
  assert.equal(call(deps, 'pause_recurring_schedule', { workspaceId, scheduleId: s.id }).schedule.status, 'paused');
  // Already paused settles to the same answer.
  assert.equal(call(deps, 'pause_recurring_schedule', { workspaceId, scheduleId: s.id }).schedule.status, 'paused');
  assert.equal(call(deps, 'resume_recurring_schedule', { workspaceId, scheduleId: s.id }).schedule.status, 'active');
  assert.equal(call(deps, 'end_recurring_schedule', { workspaceId, scheduleId: s.id }).schedule.status, 'ended');
  // Terminal: pause and resume refuse, a replayed end answers what the first call made true.
  assert.equal(call(deps, 'pause_recurring_schedule', { workspaceId, scheduleId: s.id }).error, 'schedule_ended');
  assert.equal(call(deps, 'resume_recurring_schedule', { workspaceId, scheduleId: s.id }).error, 'schedule_ended');
  assert.equal(call(deps, 'end_recurring_schedule', { workspaceId, scheduleId: s.id }).schedule.status, 'ended');
  // An ended schedule refuses edits too.
  assert.equal(
    call(deps, 'update_recurring_schedule', { workspaceId, scheduleId: s.id, patch: { name: 'Neu' } }).error,
    'schedule_ended',
  );
  // A paused sibling is simply not selected by the tick.
  const paused = mkSchedule(deps, workspaceId, contactId, 'lc-b', { anchorDate: '2026-06-01' });
  assert.equal(call(deps, 'pause_recurring_schedule', { workspaceId, scheduleId: paused.id }).ok, true);
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true);
  assert.equal(res.results.length, 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);
});

// --- The tick's boundary -------------------------------------------------------------------------

test('tick: a future asOf is refused, an unparseable one is invalid_input, and neither writes', () => {
  const { deps, workspaceId, contactId } = world('tk');
  mkSchedule(deps, workspaceId, contactId, 'tk');
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-17' }).error, 'as_of_in_future');
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: 'morgen' }).error, 'invalid_input');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM recurring_run_log WHERE workspace_id = ?', workspaceId), 0);
  // Default asOf is the clock: the July occurrence is due today.
  const res = call(deps, 'run_due_recurring', { workspaceId });
  assert.equal(res.generated, 1);
  assert.equal(res.results[0].outcome, 'drafted');
});

test('tick: maxOccurrences ends the schedule at exactly the cap, and the cap-th settle is billed', () => {
  const { deps, workspaceId, contactId } = world('mx');
  const s = mkSchedule(deps, workspaceId, contactId, 'mx', { anchorDate: '2026-03-01', maxOccurrences: 3 });
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  // March, April, May settle; the schedule ends at the cap; June and July are never billed.
  assert.equal(res.generated, 3);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 3);
  const row = deps.store.db
    .prepare('SELECT status, occurrences_done FROM recurring_schedule WHERE id = ?')
    .get(s.id);
  assert.deepEqual(row, { status: 'ended', occurrences_done: 3 });
  // And the tick converges: a second call adds nothing.
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 0);
});

test('tick: a failed occurrence freezes only its own schedule; the sibling still bills', () => {
  const { deps, workspaceId, contactId } = world('iso');
  // A schedule whose contact vanishes underneath it: create_document will refuse per occurrence.
  const broken = mkSchedule(deps, workspaceId, contactId, 'iso-a');
  const other = call(deps, 'create_contact', {
    workspaceId,
    partyRole: 'customer',
    name: 'Zweite AG',
    idempotencyKey: 'iso-contact-2',
  });
  const healthy = mkSchedule(deps, workspaceId, other.contact.id, 'iso-b', { anchorDate: '2026-07-05' });
  // Remove the first contact out from under its schedule (no FK from schedule to contact by design;
  // the document layer is what refuses).
  deps.store.db.prepare('DELETE FROM contact WHERE workspace_id = ? AND id = ?').run(workspaceId, contactId);

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const byId = Object.fromEntries(res.results.map((r) => [r.scheduleId, r]));
  assert.equal(byId[broken.id].outcome, 'failed');
  assert.equal(byId[healthy.id].outcome, 'drafted');
  // The broken schedule's cursor is frozen and VISIBLE on the list; the sibling advanced.
  const listed = call(deps, 'list_recurring_schedules', { workspaceId });
  const listById = Object.fromEntries(listed.schedules.map((s) => [s.id, s]));
  assert.equal(listById[broken.id].nextRunDate, '2026-07-01');
  assert.equal(listById[broken.id].lastOutcome, 'failed');
  assert.equal(listById[healthy.id].nextRunDate, '2026-08-05');
});

// --- Update ------------------------------------------------------------------------------------

test('update: a cadence change restarts the series at the next occurrence on or after today', () => {
  const { deps, workspaceId, contactId } = world('up');
  const s = mkSchedule(deps, workspaceId, contactId, 'up', { anchorDate: '2026-01-15' });
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-03-01' }).generated, 2);
  // Move the anchor day: the cursor recomputes from TODAY (2026-07-16), not from the old cursor.
  const patched = call(deps, 'update_recurring_schedule', {
    workspaceId,
    scheduleId: s.id,
    patch: { anchorDate: '2026-01-20' },
  });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.equal(patched.schedule.nextRunDate, '2026-07-20');
  // Settled history is untouched by the cursor move.
  assert.equal(
    count(deps, "SELECT COUNT(*) AS n FROM recurring_run_log WHERE workspace_id = ? AND outcome = 'drafted'", workspaceId),
    2,
  );
  // A non-cadence patch leaves the cursor alone.
  const named = call(deps, 'update_recurring_schedule', { workspaceId, scheduleId: s.id, patch: { name: 'Retainer' } });
  assert.equal(named.schedule.nextRunDate, '2026-07-20');
});

// --- Tenancy on the reads and the controls -------------------------------------------------------

test('tenant: a schedule is invisible and untouchable from another workspace', () => {
  const { deps, workspaceId, contactId } = world('tn');
  const s = mkSchedule(deps, workspaceId, contactId, 'tn');
  const other = mintWorkspace(deps, 'Fremd GmbH', 'tn-other');
  assert.equal(call(deps, 'get_recurring_schedule', { workspaceId: other.workspaceId, scheduleId: s.id }).error, 'not_found');
  assert.equal(call(deps, 'pause_recurring_schedule', { workspaceId: other.workspaceId, scheduleId: s.id }).error, 'not_found');
  assert.equal(call(deps, 'end_recurring_schedule', { workspaceId: other.workspaceId, scheduleId: s.id }).error, 'not_found');
  assert.equal(
    call(deps, 'update_recurring_schedule', { workspaceId: other.workspaceId, scheduleId: s.id, patch: { name: 'X' } }).error,
    'not_found',
  );
  assert.equal(call(deps, 'list_recurring_schedules', { workspaceId: other.workspaceId }).schedules.length, 0);
  // The other tenant's tick selects nothing here either.
  assert.equal(call(deps, 'run_due_recurring', { workspaceId: other.workspaceId, asOf: '2026-07-16' }).results.length, 0);
  assert.equal(deps.store.db.prepare('SELECT status FROM recurring_schedule WHERE id = ?').get(s.id).status, 'active');
});

test('get: the run log carries the document number where it exists and survives where it does not', () => {
  const { deps, workspaceId, contactId } = world('gt');
  const s = mkSchedule(deps, workspaceId, contactId, 'gt', { anchorDate: '2026-06-01' });
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 2);
  const view = call(deps, 'get_recurring_schedule', { workspaceId, scheduleId: s.id });
  assert.equal(view.ok, true);
  assert.equal(view.runs.length, 2);
  for (const run of view.runs) {
    assert.equal(run.outcome, 'drafted');
    assert.equal(typeof run.documentId, 'string');
    assert.equal(run.documentNumber, null, 'a draft is unnumbered');
    assert.equal(run.documentStatus, 'draft');
  }
  // Cancel one draft: the run row survives with a released pointer, and the read does not throw.
  const documentId = view.runs[0].documentId;
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId, to: 'cancelled', idempotencyKey: 'gt-cancel' }).ok,
    true,
  );
  const after = call(deps, 'get_recurring_schedule', { workspaceId, scheduleId: s.id });
  const released = after.runs.find((r) => r.documentId === null);
  assert.ok(released !== undefined, 'the cancelled draft left no released row');
  assert.equal(released.documentStatus, null);
});
