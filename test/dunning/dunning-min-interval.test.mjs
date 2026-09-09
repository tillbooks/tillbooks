/**
 * A15, Mahnwesen: the minimum-interval escalation gate (finding K-60).
 *
 * THE DEFECT this suite pins: the escalation ladder was gated ONLY by the absolute `daysOverdue`
 * threshold (10/20/30). An invoice that was already past ALL THREE thresholds at once (dunning
 * enabled late, or a migrated open item) therefore satisfied level 1, 2 AND 3 on the same day, and
 * three successive DAILY propose+issue runs advanced it 1 -> 2 -> 3 in three days: three
 * Mahngebühren booked inside three days and the final reminder mailed two days after the first.
 *
 * THE FIX, asserted here: a per-level `minIntervalDays` (default 10) that ADVANCEMENT waits for.
 * To reach level N, in addition to `daysOverdue >= threshold[N]`, at least `minIntervalDays[N]`
 * calendar days must have passed since the PREVIOUS level's letter was ISSUED. Level 1 has no
 * previous issued level, so it is gated by its absolute threshold alone.
 *
 * Everything dispatches through the registry (`getAction(...).run`), never the engine module
 * directly, so every assertion also covers the A24 gate and the boundary type check, exactly as a
 * real caller meets them. The clock is the test's own, because the escalation is a process that
 * lives across days and the only honest way to exercise it is to let time actually pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/** Deps whose clock the TEST can move forward, one day at a time. */
function steppingDeps(startIso) {
  let now = startIso;
  const clock = { now: () => now };
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids: sequenceIdGen(), actor: 'agent' };
  return { deps, setNow: (iso) => (now = iso) };
}

const dayIso = (yyyyMmDd) => `${yyyyMmDd}T00:00:00.000Z`;

/** How many posted dunning-fee entries a workspace's ledger carries (the money-path witness). */
function dunningFeeEntryCount(deps, workspaceId) {
  return deps.store.db
    .prepare(
      "SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning' AND status = 'posted'",
    )
    .get(workspaceId).n;
}

/** The document's current escalation level as A16 reads it back (0 when never issued). */
function currentLevel(deps, workspaceId, documentId) {
  const open = must(call(deps, 'list_open_items', { workspaceId }), 'list_open_items');
  const item = open.items.find((i) => i.documentId === documentId);
  return item === undefined ? null : (item.dunningLevel ?? 0);
}

/**
 * A workspace with one ISSUED CHF 1081.00 invoice due `dueDate`, plus a fee income account.
 * The clock starts at `startIso`, deliberately long AFTER `dueDate` so the invoice is already past
 * every threshold: the exact condition the defect turned into three letters in three days.
 */
function overdueWorld(deps, { dueDate, name, idPrefix }) {
  const res = getAction('create_workspace').run(deps, { name, idempotencyKey: `${idPrefix}-ws` });
  const workspaceId = res.workspaceId;
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  must(
    call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }),
    'set_vat_method',
  );
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Treuhand Muster GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'set_creditor_profile',
  );
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: 'Säumig AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'debitor@kunde.example',
      idempotencyKey: `${idPrefix}-contact`,
    }),
    'create_contact',
  ).contact.id;
  const documentId = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate,
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: `${idPrefix}-doc`,
    }),
    'create_document',
  ).document.id;
  must(
    call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `${idPrefix}-issue` }),
    'issue_invoice',
  );
  const feeAccountId = deps.store.db
    .prepare("SELECT id FROM account WHERE workspace_id = ? AND type = 'income' ORDER BY number LIMIT 1")
    .get(workspaceId).id;
  return { workspaceId, customerId, documentId, feeAccountId };
}

/** Set a three-level policy with booked fees; `minIntervalDays` optional so the default (10) shows. */
function configurePolicy(deps, workspaceId, feeAccountId, { minIntervalDays } = {}) {
  const base = { bookFee: true, feeIncomeAccountId: feeAccountId, showInterest: false, interestBp: 500 };
  const interval = minIntervalDays === undefined ? {} : { minIntervalDays };
  return call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 2000, ...base, ...interval },
      { level: 2, daysOverdue: 20, feeMinor: 3000, ...base, ...interval },
      { level: 3, daysOverdue: 30, feeMinor: 4000, ...base, ...interval },
    ],
    idempotencyKey: `cfg-${workspaceId}-${minIntervalDays ?? 'default'}`,
  });
}

function proposeAndIssue(deps, workspaceId, tag) {
  const proposed = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: `${tag}-p` }), `propose ${tag}`);
  if (proposed.runId === null) return { proposed, issued: null };
  const issued = call(deps, 'issue_dunning_run', {
    workspaceId,
    runId: proposed.runId,
    confirmed: true,
    idempotencyKey: `${tag}-i`,
  });
  return { proposed, issued };
}

// --- The default gate: three daily runs no longer become three letters -----------------------------

test('K-60: an invoice past all thresholds does NOT escalate on consecutive daily runs (default 10)', () => {
  // The clock starts 2026-06-16, the invoice fell due 2026-05-01: 46 days overdue, past 10/20/30.
  const { deps, setNow } = steppingDeps(dayIso('2026-06-16'));
  const { workspaceId, documentId, feeAccountId } = overdueWorld(deps, {
    dueDate: '2026-05-01',
    name: 'Acme GmbH',
    idPrefix: 'a',
  });
  // No minIntervalDays in the write: the DEFAULT of 10 must be what gates. (Proves the default too.)
  must(configurePolicy(deps, workspaceId, feeAccountId), 'set_dunning_config');

  // Day 1: level 1 issues (no previous level, gated by the absolute threshold alone).
  setNow(dayIso('2026-06-16'));
  const day1 = proposeAndIssue(deps, workspaceId, 'd1');
  assert.equal(day1.proposed.items[0].level, 1, 'day 1 proposes level 1');
  must(day1.issued, 'day 1 issue');
  assert.equal(currentLevel(deps, workspaceId, documentId), 1);
  assert.equal(dunningFeeEntryCount(deps, workspaceId), 1, 'one fee after level 1');

  // Day 2: the defect would issue level 2 here. The gate holds it: only 1 day since level 1 issued,
  // far short of the 10-day minimum. Propose returns NOTHING to chase.
  setNow(dayIso('2026-06-17'));
  const day2 = proposeAndIssue(deps, workspaceId, 'd2');
  assert.equal(day2.proposed.runId, null, 'day 2 proposes no escalation: the minimum interval blocks it');
  assert.equal(day2.proposed.reason, 'nothing_overdue');
  assert.equal(currentLevel(deps, workspaceId, documentId), 1, 'still level 1 the day after');
  assert.equal(dunningFeeEntryCount(deps, workspaceId), 1, 'no second fee the day after');

  // Day 3: still blocked (2 days since level 1).
  setNow(dayIso('2026-06-18'));
  const day3 = proposeAndIssue(deps, workspaceId, 'd3');
  assert.equal(day3.proposed.runId, null, 'day 3 still blocked');
  assert.equal(dunningFeeEntryCount(deps, workspaceId), 1);

  // Day 11 (10 days after level 1 issued): level 2 is now due.
  setNow(dayIso('2026-06-26'));
  const day11 = proposeAndIssue(deps, workspaceId, 'd11');
  assert.equal(day11.proposed.items[0].level, 2, 'level 2 opens exactly 10 days after level 1 issued');
  must(day11.issued, 'day 11 issue');
  assert.equal(currentLevel(deps, workspaceId, documentId), 2);
  assert.equal(dunningFeeEntryCount(deps, workspaceId), 2, 'the second fee books only now');

  // Day 12: level 3 blocked (1 day since level 2).
  setNow(dayIso('2026-06-27'));
  const day12 = proposeAndIssue(deps, workspaceId, 'd12');
  assert.equal(day12.proposed.runId, null, 'level 3 held one day after level 2');
  assert.equal(dunningFeeEntryCount(deps, workspaceId), 2);

  // Day 21 (10 days after level 2 issued): level 3, the terminal letter.
  setNow(dayIso('2026-07-06'));
  const day21 = proposeAndIssue(deps, workspaceId, 'd21');
  assert.equal(day21.proposed.items[0].level, 3, 'level 3 opens 10 days after level 2 issued');
  must(day21.issued, 'day 21 issue');
  assert.equal(currentLevel(deps, workspaceId, documentId), 3);
  assert.equal(dunningFeeEntryCount(deps, workspaceId), 3);

  // The whole ladder took 20 days, not 2. That is the entire point of the fix.
});

// --- The default reads back as 10, and the interval is configurable --------------------------------

test('K-60: a config with no minIntervalDays reads back 10; an explicit value gates at that value', () => {
  const { deps } = steppingDeps(dayIso('2026-06-16'));
  const { workspaceId, feeAccountId } = overdueWorld(deps, {
    dueDate: '2026-05-01',
    name: 'Default GmbH',
    idPrefix: 'def',
  });

  // No minIntervalDays written: every level must read back 10.
  must(configurePolicy(deps, workspaceId, feeAccountId), 'set default config');
  const defaulted = must(call(deps, 'get_dunning_config', { workspaceId }), 'get_dunning_config');
  for (const level of defaulted.levels) {
    assert.equal(level.minIntervalDays, 10, `level ${level.level} defaults to 10`);
  }

  // Now widen the spacing to 15 and confirm it both persists and gates at 15, not 10.
  must(configurePolicy(deps, workspaceId, feeAccountId, { minIntervalDays: 15 }), 'set 15-day config');
  const widened = must(call(deps, 'get_dunning_config', { workspaceId }), 'get_dunning_config 15');
  for (const level of widened.levels) {
    assert.equal(level.minIntervalDays, 15, `level ${level.level} persists 15`);
  }
});

test('K-60: a wider explicit interval (15 days) holds level 2 until day 15, not day 10', () => {
  const { deps, setNow } = steppingDeps(dayIso('2026-06-16'));
  const { workspaceId, documentId, feeAccountId } = overdueWorld(deps, {
    dueDate: '2026-05-01',
    name: 'Wide GmbH',
    idPrefix: 'wide',
  });
  must(configurePolicy(deps, workspaceId, feeAccountId, { minIntervalDays: 15 }), 'set 15-day config');

  setNow(dayIso('2026-06-16'));
  must(proposeAndIssue(deps, workspaceId, 'w1').issued, 'level 1');

  // Day 11: a 10-day default WOULD open level 2, but this policy waits 15.
  setNow(dayIso('2026-06-26'));
  assert.equal(proposeAndIssue(deps, workspaceId, 'w11').proposed.runId, null, 'day 11 blocked under a 15-day policy');
  assert.equal(currentLevel(deps, workspaceId, documentId), 1);

  // Day 16 (15 days after level 1 issued): level 2 opens.
  setNow(dayIso('2026-07-01'));
  const day16 = proposeAndIssue(deps, workspaceId, 'w16');
  assert.equal(day16.proposed.items[0].level, 2, 'level 2 opens at 15 days');
  must(day16.issued, 'level 2 issue');
});

// --- Money-path invariants: append-only, idempotent-on-rows, §H-TENANT -----------------------------

test('K-60 invariant: the gate never mutates posted entries and re-runs are idempotent on rows', () => {
  const { deps, setNow } = steppingDeps(dayIso('2026-06-16'));
  const { workspaceId, feeAccountId } = overdueWorld(deps, {
    dueDate: '2026-05-01',
    name: 'Idem GmbH',
    idPrefix: 'idem',
  });
  must(configurePolicy(deps, workspaceId, feeAccountId), 'config');

  setNow(dayIso('2026-06-16'));
  const proposed = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'im-p' }), 'propose');
  must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: proposed.runId, confirmed: true, idempotencyKey: 'im-i' }),
    'issue',
  );

  // The exact posted state, captured line by line, BEFORE any replay.
  const feeEntryBefore = deps.store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND source = 'dunning' AND status = 'posted'")
    .all(workspaceId);
  assert.equal(feeEntryBefore.length, 1, 'exactly one fee entry after issue');
  const entryId = feeEntryBefore[0].id;
  const linesBefore = deps.store.db
    .prepare('SELECT account_id, debit_minor, credit_minor FROM journal_line WHERE entry_id = ? ORDER BY id')
    .all(entryId);
  const totalPostedBefore = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId).n;

  // Replay the SAME issue key: the completed Result must return byte-identically and post nothing new.
  const replay = call(deps, 'issue_dunning_run', {
    workspaceId,
    runId: proposed.runId,
    confirmed: true,
    idempotencyKey: 'im-i',
  });
  must(replay, 'issue replay');
  // Re-propose the SAME day under a fresh key: the structural per-day slot answers, no rival run.
  const reproposed = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'im-p2' }), 're-propose');
  assert.equal(reproposed.existing, true, 're-propose returns the same run, mints no rival');

  // Append-only: no posted entry was rewritten, none added, and the fee lines are identical.
  const totalPostedAfter = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId).n;
  assert.equal(totalPostedAfter, totalPostedBefore, 'no entry appended by the replay');
  assert.equal(dunningFeeEntryCount(deps, workspaceId), 1, 'idempotent on rows: still one fee, never double-booked');
  const linesAfter = deps.store.db
    .prepare('SELECT account_id, debit_minor, credit_minor FROM journal_line WHERE entry_id = ? ORDER BY id')
    .all(entryId);
  assert.deepEqual(linesAfter, linesBefore, 'the posted fee entry is immutable across the replay');
});

test('K-60 invariant: §H-TENANT: one workspace escalation state never leaks into another', () => {
  // Two tenants share ONE store and clock. Tenant A escalates all the way to level 3; tenant B must
  // start clean at level 1 and see none of A's fees, and A's gate must read only A's issued dates.
  const { deps, setNow } = steppingDeps(dayIso('2026-06-16'));
  const a = overdueWorld(deps, { dueDate: '2026-05-01', name: 'Tenant A GmbH', idPrefix: 'ta' });
  const b = overdueWorld(deps, { dueDate: '2026-05-01', name: 'Tenant B GmbH', idPrefix: 'tb' });
  must(configurePolicy(deps, a.workspaceId, a.feeAccountId), 'config A');
  must(configurePolicy(deps, b.workspaceId, b.feeAccountId), 'config B');

  // Tenant A marches through the full ladder over 20 days (level 1, then +10, then +10).
  setNow(dayIso('2026-06-16'));
  must(proposeAndIssue(deps, a.workspaceId, 'ta1').issued, 'A level 1');
  setNow(dayIso('2026-06-26'));
  must(proposeAndIssue(deps, a.workspaceId, 'ta11').issued, 'A level 2');
  setNow(dayIso('2026-07-06'));
  must(proposeAndIssue(deps, a.workspaceId, 'ta21').issued, 'A level 3');
  assert.equal(currentLevel(deps, a.workspaceId, a.documentId), 3);
  assert.equal(dunningFeeEntryCount(deps, a.workspaceId), 3);

  // Tenant B, only NOW dunned for the first time, is unaffected by A's level-3 history: it proposes
  // level 1 (its own doc has no issued level), and A's three fees are absent from B's ledger.
  const b1 = must(call(deps, 'propose_dunning_run', { workspaceId: b.workspaceId, idempotencyKey: 'tb-p' }), 'B propose');
  assert.equal(b1.items[0].level, 1, "B starts at level 1: A's escalation state is not B's");
  assert.equal(dunningFeeEntryCount(deps, b.workspaceId), 0, "A's fees never touched B's ledger");

  // And the day after B issues level 1, B's own interval gate holds level 2, decided from B's own
  // issued date alone: the tenant boundary is on the gate's read as well.
  must(
    call(deps, 'issue_dunning_run', { workspaceId: b.workspaceId, runId: b1.runId, confirmed: true, idempotencyKey: 'tb-i' }),
    'B issue level 1',
  );
  setNow(dayIso('2026-07-07'));
  const bNext = must(call(deps, 'propose_dunning_run', { workspaceId: b.workspaceId, idempotencyKey: 'tb-p2' }), 'B re-propose');
  assert.equal(bNext.runId, null, "B's level 2 is held by B's own interval, one day after B issued level 1");
});
