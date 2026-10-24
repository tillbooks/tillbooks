/**
 * `contacts_merge` re-points a recurring schedule onto the survivor (D141 follow-up 4, the round-2
 * critic's note on the governance branch).
 *
 * Measured before the fix: the merge re-pointed `document.contact_id` but not
 * `recurring_schedule.contact_id`. The schedule kept naming the tombstone, so every later tick billed
 * a contact `list_contacts` hides, at the duplicate's address, and `list_recurring_schedules` filtered
 * by the survivor never found it.
 *
 * A schedule row is master data (a template the tick reads), not an append-only financial fact, so the
 * re-point is legal for the same reason the project and deal rows are. A merge that would move an
 * auto-issuing schedule drafts under `issue` for an agent seat (test/agent/merge-retarget-dial.test.mjs),
 * which is what D141.2 asks of a schedule's contact change.
 *
 * HOW IT BITES: drop `{ table: 'recurring_schedule', column: 'contact_id' }` from `MERGE_REPOINT_FKS`
 * (src/core/sales/contactMerge.ts) and every assertion on the survivor below fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { fixture } from '../api/conformance-contract.mjs';

function studio(fx, name, input) {
  return getAction(name).run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, ...input });
}

test('a merge re-points the source contact’s recurring schedule onto the survivor, and the next tick bills the survivor', () => {
  const fx = fixture();
  const source = studio(fx, 'create_contact', { partyRole: 'customer', name: 'Doppelt Serie AG', idempotencyKey: 'mrs-src' });
  const target = studio(fx, 'create_contact', { partyRole: 'customer', name: 'Original Serie AG', idempotencyKey: 'mrs-tgt' });
  assert.equal(source.ok && target.ok, true);
  const created = studio(fx, 'create_recurring_schedule', {
    contactId: source.contact.id,
    lines: [{ description: 'Beratung monatlich', unitPriceMinor: 200000 }],
    interval: 'monthly',
    anchorDate: '2026-01-01',
    idempotencyKey: 'mrs-sched',
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  const scheduleId = created.schedule.id;

  const merged = studio(fx, 'contacts_merge', { sourceId: source.contact.id, targetId: target.contact.id, idempotencyKey: 'mrs-merge' });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.merged.repointed['recurring_schedule.contact_id'], 1, 'the merge reports the re-pointed schedule');

  const row = fx.deps.store.db.prepare('SELECT contact_id FROM recurring_schedule WHERE workspace_id = ? AND id = ?').get(fx.workspaceId, scheduleId);
  assert.equal(row.contact_id, target.contact.id, 'the schedule names the survivor, not the tombstone');

  const listed = studio(fx, 'list_recurring_schedules', { contactId: target.contact.id });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.schedules.map((s) => s.id), [scheduleId], 'the survivor’s schedules include it');

  // The tick bills the survivor.
  const ticked = studio(fx, 'run_due_recurring', {});
  assert.equal(ticked.ok, true, JSON.stringify(ticked));
  const docs = fx.deps.store.db
    .prepare("SELECT contact_id FROM document WHERE workspace_id = ? AND type = 'invoice'")
    .all(fx.workspaceId);
  assert.ok(docs.length > 0, 'premise: the schedule was due and the tick drafted an invoice');
  for (const d of docs) assert.equal(d.contact_id, target.contact.id, 'no invoice is drafted to the merged-away duplicate');
  fx.deps.store.close();
});

test('the merge leaves another contact’s schedule alone (the re-point is scoped to the source)', () => {
  const fx = fixture();
  const source = studio(fx, 'create_contact', { partyRole: 'customer', name: 'Quelle AG', idempotencyKey: 'mro-src' });
  const target = studio(fx, 'create_contact', { partyRole: 'customer', name: 'Ziel AG', idempotencyKey: 'mro-tgt' });
  const other = studio(fx, 'create_contact', { partyRole: 'customer', name: 'Dritte AG', idempotencyKey: 'mro-oth' });
  const sched = studio(fx, 'create_recurring_schedule', {
    contactId: other.contact.id,
    lines: [{ description: 'Wartung', unitPriceMinor: 50000 }],
    interval: 'monthly',
    anchorDate: '2026-08-01',
    idempotencyKey: 'mro-sched',
  });
  assert.equal(sched.ok, true, JSON.stringify(sched));
  const merged = studio(fx, 'contacts_merge', { sourceId: source.contact.id, targetId: target.contact.id, idempotencyKey: 'mro-merge' });
  assert.equal(merged.ok, true, JSON.stringify(merged));
  assert.equal(merged.merged.repointed['recurring_schedule.contact_id'], 0);
  const row = fx.deps.store.db.prepare('SELECT contact_id FROM recurring_schedule WHERE workspace_id = ? AND id = ?').get(fx.workspaceId, sched.schedule.id);
  assert.equal(row.contact_id, other.contact.id);
  fx.deps.store.close();
});
