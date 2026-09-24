/**
 * B01, time tracking: the business rules the conformance floor does not derive.
 *
 * The conformance gate already holds §H-TENANT isolation, idempotent-on-rows and the double-call
 * settle over every registered verb, so nothing here restates those generically. What this suite
 * owns is B01's OWN rules: the resolveRate precedence table and its no_rate_defined contract, the
 * rate-card versioning (end-date the predecessor, never mutate) and overlap refusals, the snapshot
 * immutability under later card edits, the minutes bounds, the single-running-timer guard, the
 * midnight-crossing stop, the submit/approve/lock chain and the frozen-after-approval edits, the
 * cross-tenant rate fence, the B00 close-guard and cost-source registrations, and the timesheet
 * aggregate's round-once derivation.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { fixedClock } from '../../dist/core/clock.js';
import { freshDeps, mintWorkspace, AT } from '../api/support.mjs';

/** A fresh world: its own store, one workspace, a seeded contact + project, a bound call helper. */
function world(seed = 'b01') {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const contact = call('create_contact', {
    partyRole: 'customer',
    name: 'Zeit Kunde AG',
    idempotencyKey: `${seed}-contact`,
  });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  const project = call('project_create', {
    name: `Projekt ${seed}`,
    contactId: contact.contact.id,
    idempotencyKey: `${seed}-project`,
  });
  assert.equal(project.ok, true, JSON.stringify(project));
  return { deps, workspaceId, accId, call, contactId: contact.contact.id, projectId: project.project.id };
}

function card(w, seed, input) {
  const res = w.call('rate_card_upsert', { validFrom: '2026-01-01', idempotencyKey: `${seed}-card`, ...input });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.rateCard;
}

function logHour(w, seed, extra = {}) {
  const res = w.call('time_log', {
    userId: 'user-f',
    projectId: w.projectId,
    startedAt: '2026-07-10T09:00:00.000Z',
    minutes: 60,
    idempotencyKey: `${seed}-log`,
    ...extra,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.entry;
}

// ---------------------------------------------------------------------------------------------
// resolveRate (OP1)
// ---------------------------------------------------------------------------------------------

test('B01: resolveRate answers the most specific scope for every precedence combination', () => {
  const w = world('prec');
  // Build up from least to most specific and re-resolve after each card: the winner must move.
  const resolve = () =>
    w.call('time_resolve_rate', { userId: 'user-f', projectId: w.projectId, contactId: w.contactId });

  assert.equal(resolve().error, 'no_rate_defined');

  card(w, 'prec-d', { scope: 'default', rateMinor: 10000 });
  assert.equal(resolve().rate.sourceScope, 'default');

  card(w, 'prec-e', { scope: 'employee', scopeRef: 'user-f', rateMinor: 11000 });
  assert.equal(resolve().rate.sourceScope, 'employee');

  card(w, 'prec-p', { scope: 'project', scopeRef: w.projectId, rateMinor: 12000 });
  assert.equal(resolve().rate.sourceScope, 'project');

  card(w, 'prec-c', { scope: 'client', scopeRef: w.contactId, rateMinor: 13000 });
  const won = resolve();
  assert.equal(won.rate.sourceScope, 'client');
  assert.equal(won.rate.rateMinor, 13000);

  // A different employee falls through the employee card back to default.
  const other = w.call('time_resolve_rate', { userId: 'user-x' });
  assert.equal(other.rate.sourceScope, 'default');
  assert.equal(other.rate.rateMinor, 10000);
});

test('B01: with zero cards the answer is no_rate_defined, never a 0 or null rate, and capture refuses', () => {
  const w = world('nocard');
  const resolved = w.call('time_resolve_rate', { userId: 'user-f', projectId: w.projectId });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.error, 'no_rate_defined');

  const started = w.call('time_start', { userId: 'user-f', projectId: w.projectId, idempotencyKey: 'nocard-s' });
  assert.equal(started.error, 'no_rate_defined');
  const logged = w.call('time_log', {
    userId: 'user-f',
    projectId: w.projectId,
    startedAt: '2026-07-10T09:00:00.000Z',
    minutes: 60,
    idempotencyKey: 'nocard-l',
  });
  assert.equal(logged.error, 'no_rate_defined');
  const rows = w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM time_entry').get();
  assert.equal(rows.n, 0, 'a refused capture must write no entry');
});

test('B01: a card is resolved by the entry day, not by today (validity windows)', () => {
  const w = world('window');
  card(w, 'win-1', { scope: 'default', rateMinor: 10000, validFrom: '2026-01-01' });
  card(w, 'win-2', { scope: 'default', rateMinor: 14000, validFrom: '2026-07-01' });

  const june = logHour(w, 'win-june', { startedAt: '2026-06-15T09:00:00.000Z' });
  assert.equal(june.rateMinor, 10000, 'back-logged June work prices at the June rate');
  const july = logHour(w, 'win-july', { startedAt: '2026-07-10T09:00:00.000Z' });
  assert.equal(july.rateMinor, 14000);
});

// ---------------------------------------------------------------------------------------------
// Rate-card versioning
// ---------------------------------------------------------------------------------------------

test('B01: upsert end-dates the open predecessor and never mutates it; snapshots stay frozen', () => {
  const w = world('vers');
  const first = card(w, 'vers-1', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01' });
  const entry = logHour(w, 'vers-log');
  assert.equal(entry.rateMinor, 15000);
  assert.equal(entry.rateCardId, first.id);

  const second = w.call('rate_card_upsert', {
    scope: 'default',
    rateMinor: 20000,
    validFrom: '2026-08-01',
    idempotencyKey: 'vers-2',
  });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.closedPredecessorId, first.id);

  const cards = w.call('rate_card_list', {});
  const closed = cards.rateCards.find((c) => c.id === first.id);
  assert.equal(closed.validTo, '2026-08-01', 'the predecessor is end-dated, not deleted');
  assert.equal(closed.rateMinor, 15000, 'the predecessor rate is NEVER mutated');

  const after = w.call('time_list', {});
  assert.equal(after.entries[0].rateMinor, 15000, 'the snapshotted entry did not reprice');
});

test('B01: overlapping validity is refused, in both the closed-history and open-card shapes', () => {
  const w = world('over');
  const open = card(w, 'over-1', { scope: 'default', rateMinor: 15000, validFrom: '2026-06-01' });

  // An open card starting ON or AFTER the new validFrom cannot be closed to a non-empty interval.
  const before = w.call('rate_card_upsert', {
    scope: 'default',
    rateMinor: 16000,
    validFrom: '2026-05-01',
    idempotencyKey: 'over-2',
  });
  assert.equal(before.ok, false);
  assert.equal(before.error, 'rate_card_overlap');

  // Close the open card, then try to start a successor INSIDE the closed window.
  const ended = w.call('rate_card_end', { rateCardId: open.id, validTo: '2026-09-01', idempotencyKey: 'over-3' });
  assert.equal(ended.ok, true, JSON.stringify(ended));
  const inside = w.call('rate_card_upsert', {
    scope: 'default',
    rateMinor: 17000,
    validFrom: '2026-07-01',
    idempotencyKey: 'over-4',
  });
  assert.equal(inside.ok, false);
  assert.equal(inside.error, 'rate_card_overlap');

  // After the window it is free again.
  const after = w.call('rate_card_upsert', {
    scope: 'default',
    rateMinor: 17000,
    validFrom: '2026-09-01',
    idempotencyKey: 'over-5',
  });
  assert.equal(after.ok, true, JSON.stringify(after));
});

test('B01: rate_card_end validates the window and refuses a second end', () => {
  const w = world('end');
  const c = card(w, 'end-1', { scope: 'default', rateMinor: 15000, validFrom: '2026-06-01' });

  const backwards = w.call('rate_card_end', { rateCardId: c.id, validTo: '2026-06-01', idempotencyKey: 'end-2' });
  assert.equal(backwards.error, 'invalid_rate_card');

  assert.equal(w.call('rate_card_end', { rateCardId: c.id, validTo: '2026-12-31', idempotencyKey: 'end-3' }).ok, true);
  const again = w.call('rate_card_end', { rateCardId: c.id, validTo: '2027-06-30', idempotencyKey: 'end-4' });
  assert.equal(again.error, 'rate_card_already_ended');
});

test('B01: the rate-card input fence (scope, scopeRef, rateMinor)', () => {
  const w = world('fence');
  assert.equal(w.call('rate_card_upsert', { scope: 'squad', rateMinor: 1, validFrom: '2026-01-01' }).error, 'invalid_rate_card');
  assert.equal(w.call('rate_card_upsert', { scope: 'client', rateMinor: 1, validFrom: '2026-01-01' }).error, 'invalid_rate_card');
  assert.equal(w.call('rate_card_upsert', { scope: 'default', scopeRef: 'x', rateMinor: 1, validFrom: '2026-01-01' }).error, 'invalid_rate_card');
  assert.equal(w.call('rate_card_upsert', { scope: 'default', rateMinor: 0, validFrom: '2026-01-01' }).error, 'invalid_rate_card');
  assert.equal(w.call('rate_card_upsert', { scope: 'default', rateMinor: -5, validFrom: '2026-01-01' }).error, 'invalid_rate_card');
  assert.equal(w.call('rate_card_upsert', { scope: 'default', rateMinor: 100, validFrom: 'Anfang Juli' }).error, 'invalid_rate_card');
});

// ---------------------------------------------------------------------------------------------
// Capture: timer and manual log
// ---------------------------------------------------------------------------------------------

test('B01: one running timer per user; a second start names the running entry', () => {
  const w = world('timer');
  card(w, 'timer-c', { scope: 'default', rateMinor: 15000 });
  const first = w.call('time_start', { userId: 'user-f', projectId: w.projectId, idempotencyKey: 'timer-1' });
  assert.equal(first.ok, true, JSON.stringify(first));

  const second = w.call('time_start', { userId: 'user-f', projectId: w.projectId, idempotencyKey: 'timer-2' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'timer_already_running');
  assert.equal(second.entryId, first.entry.id);

  // A DIFFERENT user is not blocked: the guard is per user, not per workspace.
  const other = w.call('time_start', { userId: 'user-g', projectId: w.projectId, idempotencyKey: 'timer-3' });
  assert.equal(other.ok, true, JSON.stringify(other));
});

test('B01: stop computes the full elapsed minutes across midnight and keeps the started_at day', () => {
  const w = world('midnight');
  card(w, 'mid-c', { scope: 'default', rateMinor: 15000 });
  const started = w.call('time_start', { userId: 'user-f', projectId: w.projectId, idempotencyKey: 'mid-1' });
  assert.equal(started.ok, true, JSON.stringify(started));

  // The injected clock moves past midnight: 2026-07-16T00:00Z start, 2026-07-17T01:30Z stop.
  w.deps.clock = fixedClock('2026-07-17T01:30:00.000Z');
  const stopped = w.call('time_stop', { entryId: started.entry.id, idempotencyKey: 'mid-2' });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.entry.minutes, 1530, 'the full interval, not the first day slice');
  assert.equal(stopped.entry.startedAt.slice(0, 10), AT.slice(0, 10), 'the entry keeps its start day');
  assert.equal(stopped.entry.status, 'open', 'a stopped entry is still editable');

  const again = w.call('time_stop', { entryId: started.entry.id, idempotencyKey: 'mid-3' });
  assert.equal(again.error, 'timer_not_running');
});

test('B01: a sub-minute stop records one minute, never zero', () => {
  const w = world('subminute');
  card(w, 'sub-c', { scope: 'default', rateMinor: 15000 });
  const started = w.call('time_start', { userId: 'user-f', projectId: w.projectId, idempotencyKey: 'sub-1' });
  const stopped = w.call('time_stop', { entryId: started.entry.id, idempotencyKey: 'sub-2' });
  assert.equal(stopped.ok, true, JSON.stringify(stopped));
  assert.equal(stopped.entry.minutes, 1);
});

test('B01: the minutes bound is 1 to 1440, asserted at both edges', () => {
  const w = world('bound');
  card(w, 'bound-c', { scope: 'default', rateMinor: 15000 });
  const log = (minutes, key) =>
    w.call('time_log', {
      userId: 'user-f',
      projectId: w.projectId,
      startedAt: '2026-07-10T00:00:00.000Z',
      minutes,
      idempotencyKey: key,
    });
  assert.equal(log(0, 'bound-0').error, 'invalid_minutes');
  assert.equal(log(-30, 'bound-neg').error, 'invalid_minutes');
  assert.equal(log(1441, 'bound-1441').error, 'invalid_minutes');
  // A fractional value is refused one layer earlier, by the boundary's integer type validation.
  assert.equal(log(90.5, 'bound-frac').error, 'invalid_input');
  assert.equal(log(1, 'bound-1').ok, true);
  assert.equal(log(1440, 'bound-1440').ok, true);
});

test('B01: capture validates the project, the phase ownership, and the tenant fence on rates', () => {
  const w = world('capture');
  card(w, 'cap-c', { scope: 'default', rateMinor: 15000 });
  assert.equal(
    w.call('time_start', { userId: 'user-f', projectId: 'nope', idempotencyKey: 'cap-1' }).error,
    'project_not_found',
  );
  assert.equal(
    w.call('time_start', { userId: 'user-f', projectId: w.projectId, phaseId: 'nope', idempotencyKey: 'cap-2' }).error,
    'phase_not_found',
  );

  // §H-TENANT on the RATE side: a card in workspace A prices nothing in workspace B.
  const other = mintWorkspace(w.deps, 'Andere GmbH', 'cap-ws2');
  const foreign = getAction('time_resolve_rate').run(w.deps, { workspaceId: other.workspaceId, userId: 'user-f' });
  assert.equal(foreign.error, 'no_rate_defined', 'a rate card must never leak across the tenant fence');
});

// ---------------------------------------------------------------------------------------------
// The submit -> approve -> lock chain
// ---------------------------------------------------------------------------------------------

test('B01: the chain moves period-wise, refuses out-of-order jumps, and freezes edits from approval', () => {
  const w = world('chain');
  card(w, 'chain-c', { scope: 'default', rateMinor: 15000 });
  const entry = logHour(w, 'chain-log');

  // Approve before submit is an illegal transition.
  const early = w.call('time_approve', { entryIds: [entry.id], idempotencyKey: 'chain-early' });
  assert.equal(early.error, 'invalid_transition');
  // Lock before anything is approved has nothing to lock.
  assert.equal(w.call('time_lock', { period: '2026-07', idempotencyKey: 'chain-early2' }).error, 'nothing_to_lock');

  const submitted = w.call('time_submit', { period: '2026-07', idempotencyKey: 'chain-sub' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.deepEqual(submitted.entryIds, [entry.id]);
  // A second submit of the same period finds nothing open (fresh key, same period).
  assert.equal(w.call('time_submit', { period: '2026-07', idempotencyKey: 'chain-sub2' }).error, 'nothing_to_submit');

  // Submitted is still editable (the edit story), approved is not.
  assert.equal(w.call('time_update', { entryId: entry.id, patch: { minutes: 90 }, idempotencyKey: 'chain-up1' }).ok, true);

  const approved = w.call('time_approve', { entryIds: [entry.id], idempotencyKey: 'chain-app' });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.equal(approved.approvalRef, entry.id, 'the occurrence key is the sorted id set');

  const frozenEdit = w.call('time_update', { entryId: entry.id, patch: { minutes: 30 }, idempotencyKey: 'chain-up2' });
  assert.equal(frozenEdit.error, 'entry_locked');
  const frozenDelete = w.call('time_delete', { entryId: entry.id, idempotencyKey: 'chain-del' });
  assert.equal(frozenDelete.error, 'entry_locked');

  const locked = w.call('time_lock', { period: '2026-07', idempotencyKey: 'chain-lock' });
  assert.equal(locked.ok, true, JSON.stringify(locked));
  assert.equal(locked.lockedCount, 1);

  const row = w.deps.store.db.prepare('SELECT status, approved_by, minutes FROM time_entry WHERE id = ?').get(entry.id);
  assert.equal(row.status, 'locked');
  assert.equal(row.approved_by, 'agent', 'the approving session actor is stamped');
  assert.equal(row.minutes, 90, 'the pre-approval edit stood; nothing moved after the freeze');
});

test('B01: submit takes only FINISHED open entries, and a running timer is never swept up', () => {
  const w = world('sweep');
  card(w, 'sweep-c', { scope: 'default', rateMinor: 15000 });
  w.call('time_start', { userId: 'user-f', projectId: w.projectId, idempotencyKey: 'sweep-run' });
  const submitted = w.call('time_submit', { period: '2026-07', idempotencyKey: 'sweep-sub' });
  assert.equal(submitted.error, 'nothing_to_submit', 'a running timer is not submittable time');
});

test('B01: approve is all-or-nothing over the named set', () => {
  const w = world('atomic');
  card(w, 'atomic-c', { scope: 'default', rateMinor: 15000 });
  const a = logHour(w, 'atomic-a', { startedAt: '2026-07-10T09:00:00.000Z' });
  const b = logHour(w, 'atomic-b', { startedAt: '2026-07-11T09:00:00.000Z' });
  w.call('time_submit', { period: '2026-07', idempotencyKey: 'atomic-sub' });
  // b is submitted; a bogus id poisons the whole call and b must stay submitted.
  const mixed = w.call('time_approve', { entryIds: [b.id, 'nope'], idempotencyKey: 'atomic-app' });
  assert.equal(mixed.error, 'entry_not_found');
  const row = w.deps.store.db.prepare('SELECT status FROM time_entry WHERE id = ?').get(b.id);
  assert.equal(row.status, 'submitted', 'a refused approve moves nothing');

  const both = w.call('time_approve', { entryIds: [b.id, a.id], idempotencyKey: 'atomic-app2' });
  assert.equal(both.ok, true, JSON.stringify(both));
  assert.equal(both.approvalRef, [a.id, b.id].sort().join('+'), 'deterministic over the SET, order-free');
});

test('B01: a billed entry (written by B02, simulated here) is frozen exactly like a locked one', () => {
  const w = world('billed');
  card(w, 'billed-c', { scope: 'default', rateMinor: 15000 });
  const entry = logHour(w, 'billed-log');
  w.deps.store.db.prepare("UPDATE time_entry SET status = 'billed' WHERE id = ?").run(entry.id);
  assert.equal(w.call('time_update', { entryId: entry.id, patch: { minutes: 1 }, idempotencyKey: 'billed-up' }).error, 'entry_locked');
  assert.equal(w.call('time_delete', { entryId: entry.id, idempotencyKey: 'billed-del' }).error, 'entry_locked');
});

// ---------------------------------------------------------------------------------------------
// Edits and the re-point re-snapshot
// ---------------------------------------------------------------------------------------------

test('B01: re-pointing an entry to another project re-resolves the snapshot at the capture day', () => {
  const w = world('repoint');
  card(w, 'rep-d', { scope: 'default', rateMinor: 10000 });
  const entry = logHour(w, 'rep-log');
  assert.equal(entry.rateMinor, 10000);

  // A second client with a client-scoped card, and a project of theirs.
  const c2 = w.call('create_contact', { partyRole: 'customer', name: 'Premium AG', idempotencyKey: 'rep-c2' });
  const p2 = w.call('project_create', { name: 'Premium Projekt', contactId: c2.contact.id, idempotencyKey: 'rep-p2' });
  card(w, 'rep-client', { scope: 'client', scopeRef: c2.contact.id, rateMinor: 25000 });

  const moved = w.call('time_update', {
    entryId: entry.id,
    patch: { projectId: p2.project.id },
    idempotencyKey: 'rep-move',
  });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.equal(moved.entry.rateMinor, 25000, 'the explicit re-point re-prices through the new client card');
  assert.equal(moved.entry.rateScope, 'client');
});

// ---------------------------------------------------------------------------------------------
// The timesheet read model and the derived aggregate
// ---------------------------------------------------------------------------------------------

test('B01: time_list filters and derives { totalMinutes, billableMinor } round-once per entry', () => {
  const w = world('list');
  card(w, 'list-c', { scope: 'default', rateMinor: 15000 });
  logHour(w, 'list-1', { minutes: 90 });
  logHour(w, 'list-2', { minutes: 25, billable: false, startedAt: '2026-07-11T09:00:00.000Z' });
  logHour(w, 'list-3', { minutes: 50, userId: 'user-g', startedAt: '2026-07-12T09:00:00.000Z' });

  const all = w.call('time_list', {});
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.equal(all.entries.length, 3);
  assert.equal(all.totalMinutes, 165);
  // 90min * 150.00/h = 225.00; 50min * 150.00/h = 125.00; the non-billable 25min contributes 0.
  assert.equal(all.billableMinor, 22500 + 12500);

  const mine = w.call('time_list', { userId: 'user-f', billable: true });
  assert.equal(mine.entries.length, 1);
  assert.equal(mine.billableMinor, 22500);

  const unknownStatus = w.call('time_list', { status: 'draft' });
  assert.equal(unknownStatus.error, 'invalid_status');
  const unknownProject = w.call('time_list', { projectId: 'nope' });
  assert.equal(unknownProject.error, 'project_not_found');
});

test('B01: the unbilled approved billable slice is exactly what B02 will read', () => {
  const w = world('b02');
  card(w, 'b02-c', { scope: 'default', rateMinor: 12000 });
  const entry = logHour(w, 'b02-log', { minutes: 120 });
  w.call('time_submit', { period: '2026-07', idempotencyKey: 'b02-sub' });
  w.call('time_approve', { entryIds: [entry.id], idempotencyKey: 'b02-app' });

  const slice = w.call('time_list', { projectId: w.projectId, status: 'approved', billable: true, unbilled: true });
  assert.equal(slice.entries.length, 1);
  assert.equal(slice.billableMinor, 24000);

  // Once B02 marks it billed (simulated), the same slice is empty.
  w.deps.store.db.prepare("UPDATE time_entry SET status = 'billed' WHERE id = ?").run(entry.id);
  const after = w.call('time_list', { projectId: w.projectId, unbilled: true });
  assert.equal(after.entries.length, 0);
});

// ---------------------------------------------------------------------------------------------
// The B00 seams: close guard and cost source
// ---------------------------------------------------------------------------------------------

test('B01: closing a project with open or submitted time refuses; frozen time lets it close', () => {
  const w = world('close');
  card(w, 'close-c', { scope: 'default', rateMinor: 15000 });
  const entry = logHour(w, 'close-log');
  w.call('project_set_status', { projectId: w.projectId, status: 'active', idempotencyKey: 'close-act' });

  const blocked = w.call('project_set_status', { projectId: w.projectId, status: 'closed', idempotencyKey: 'close-1' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'project_has_open_time');

  w.call('time_submit', { period: '2026-07', idempotencyKey: 'close-sub' });
  const stillBlocked = w.call('project_set_status', { projectId: w.projectId, status: 'closed', idempotencyKey: 'close-2' });
  assert.equal(stillBlocked.error, 'project_has_open_time', 'submitted is still undecided time');

  w.call('time_approve', { entryIds: [entry.id], idempotencyKey: 'close-app' });
  const closes = w.call('project_set_status', { projectId: w.projectId, status: 'closed', idempotencyKey: 'close-3' });
  assert.equal(closes.ok, true, JSON.stringify(closes), 'approved time is frozen and does not block the close');
});

test('B01: the registered cost source feeds project_budget_actual with derived time cost and hours', () => {
  const w = world('cost');
  card(w, 'cost-c', { scope: 'default', rateMinor: 15000 });
  const phase = w.call('project_phase_add', { projectId: w.projectId, name: 'Bau', idempotencyKey: 'cost-ph' });
  logHour(w, 'cost-1', { minutes: 90, phaseId: phase.phase.id });
  logHour(w, 'cost-2', { minutes: 30, startedAt: '2026-07-11T09:00:00.000Z' });

  const actual = w.call('project_budget_actual', { projectId: w.projectId });
  assert.equal(actual.ok, true, JSON.stringify(actual));
  assert.equal(actual.actualCostMinor, 22500 + 7500);
  assert.equal(actual.actualHours, 2);
  const bau = actual.phases.find((p) => p.phaseId === phase.phase.id);
  assert.equal(bau.actualCostMinor, 22500, 'the phase attribution reaches the phase standing');
});
