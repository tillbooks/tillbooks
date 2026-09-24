/**
 * A12 REBUILD CRITIC PROBES, non-author, refute-by-default, first-round PASS on new code
 * (docs/critique/a12-rebuild-critic.md, 31.07.2026), adopted permanently the way the three earlier
 * probe files were.
 *
 * The 33-probe acceptance corpus on this branch is the critic's own, adopted. This file is the NEW
 * attack surface: the cells of the memo / run-log / document-fate triangle that the corpus does not
 * reach, and the mechanisms the rebuild invented to close F5 and F6 (`discarded`, `due_stamped`,
 * invariants I2 and I3).
 *
 * ADOPTION POLARITY: X1b and X1c were written in measured-behaviour polarity against the two
 * robustness nits and are FLIPPED here to assert the repaired behaviour (the closing commit gave
 * the I3 catch a stable code plus a failed run row, and the reads a defensive template parse);
 * each keeps the critic's measurement in its comment. X6b stays as measured: the owner recorded it
 * as the irreducible ambiguity of value comparison (spec 4b), so the probe PINS the documented
 * behaviour rather than flagging it.
 *
 * Every assertion is a ROW. The fixture clock is pinned to 2026-07-16.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { fixedClock } from '../../dist/core/clock.js';
import { SETTLED_OUTCOMES, RUN_OUTCOMES } from '../../dist/core/recurring/enums.js';
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

const runRows = (deps, scheduleId) =>
  deps.store.db
    .prepare('SELECT period_key, document_id, outcome, error, due_stamped FROM recurring_run_log WHERE schedule_id = ? ORDER BY rowid')
    .all(scheduleId);

// --- X1: containment against a REAL throw, not only against a handled refusal --------------------

test('X1: a schedule whose stored template cannot even be parsed fails alone; siblings still bill', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x1');
  const poison = schedule(deps, workspaceId, contactId, 'x1');
  const healthy = schedule(deps, workspaceId, contactId, 'x1b', { anchorDate: '2026-07-02' });
  // Not reachable through a verb (the whitelist refuses it), so it is planted the way a corrupted
  // row or a future migration bug would leave it: invariant I3 has to hold against a genuine THROW
  // inside the occurrence, not merely against a Result whose ok is false.
  deps.store.db.prepare('UPDATE recurring_schedule SET lines_json = ? WHERE id = ?').run('{not json', poison.id);

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true, `the verb died on one bad schedule: ${JSON.stringify(res)}`);
  const poisoned = res.results.find((r) => r.scheduleId === poison.id);
  assert.equal(poisoned.outcome, 'failed');
  // The sibling billed in the SAME call.
  const good = res.results.find((r) => r.scheduleId === healthy.id);
  assert.equal(good.outcome, 'issued');
  assert.equal(res.generated, 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);
  // The poisoned cursor is frozen, the healthy one advanced.
  assert.equal(
    deps.store.db.prepare('SELECT next_run_date FROM recurring_schedule WHERE id = ?').get(poison.id).next_run_date,
    '2026-07-01',
  );
  assert.equal(
    deps.store.db.prepare('SELECT next_run_date FROM recurring_schedule WHERE id = ?').get(healthy.id).next_run_date,
    '2026-08-02',
  );
  // And it converges: the verb stays ok on every later tick.
  for (let i = 0; i < 3; i += 1) {
    assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).ok, true);
  }
});

test('X1b (FLIPPED): a thrown occurrence reports a stable code and leaves a failed run row', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x1b');
  const poison = schedule(deps, workspaceId, contactId, 'x1b', { anchorDate: '2026-06-01' });
  // One healthy period settles first, so the list has a prior GOOD outcome the failure must displace.
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-06-16' }).results[0].outcome, 'issued');
  deps.store.db.prepare('UPDATE recurring_schedule SET lines_json = ? WHERE id = ?').run('{not json', poison.id);

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true);
  assert.equal(res.results[0].outcome, 'failed');
  // MEASURED BEFORE THE REPAIR: the I3 catch reported the JS exception's own message
  // ("Expected property name or '}' in JSON at position 1..."). `schema.ts` promises "never a
  // stack trace", and now the throw path keeps that promise with the stable code.
  assert.equal(res.results[0].error, 'unexpected_error');
  assert.equal(res.results[0].periodKey, '2026-07-01');
  // MEASURED BEFORE THE REPAIR: the throw path wrote NO run row, so C5's list signal kept showing
  // the last GOOD outcome for a schedule failing on every tick. Now the poison is on the record.
  assert.deepEqual(
    runRows(deps, poison.id).map((r) => ({ outcome: r.outcome, error: r.error })),
    [
      { outcome: 'issued', error: null },
      { outcome: 'failed', error: 'unexpected_error' },
    ],
  );
  const listed = call(deps, 'list_recurring_schedules', { workspaceId });
  assert.equal(listed.ok, true);
  assert.equal(listed.schedules[0].lastOutcome, 'failed');
  assert.equal(listed.schedules[0].lastError, 'unexpected_error');
  // And the cursor stays frozen: the throw settles nothing.
  assert.equal(
    deps.store.db.prepare('SELECT next_run_date FROM recurring_schedule WHERE id = ?').get(poison.id).next_run_date,
    '2026-07-01',
  );
});

test('X1c (FLIPPED): the LIST and DETAIL reads are contained like the tick; one bad row costs itself', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x1c');
  const poison = schedule(deps, workspaceId, contactId, 'x1c');
  const healthy = schedule(deps, workspaceId, contactId, 'x1c-b', { anchorDate: '2026-07-02' });
  deps.store.db.prepare('UPDATE recurring_schedule SET lines_json = ? WHERE id = ?').run('{not json', poison.id);

  // MEASURED BEFORE THE REPAIR: `mapSchedule` parsed `lines_json` unguarded, so ONE unparseable row
  // took the whole workspace's list read with it (`unexpected_error`) and the healthy schedule was
  // unreachable through the surface that lists it. The defensive parse now costs the corrupt row
  // its own template (an empty lines array) and nothing else.
  const listed = call(deps, 'list_recurring_schedules', { workspaceId });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.equal(listed.schedules.length, 2);
  const byId = Object.fromEntries(listed.schedules.map((row) => [row.id, row]));
  assert.deepEqual(byId[poison.id].lines, [], 'the corrupt template reads as empty, never as a throw');
  assert.equal(byId[healthy.id].lines.length, 1, 'the healthy template is untouched');
  // The detail reads hold too, on both rows.
  assert.deepEqual(call(deps, 'get_recurring_schedule', { workspaceId, scheduleId: poison.id }).schedule.lines, []);
  assert.equal(call(deps, 'get_recurring_schedule', { workspaceId, scheduleId: healthy.id }).ok, true);
  // The TICK deliberately does NOT read defensively: a corrupt template must fail the occurrence
  // visibly (X1b's run row), never bill an empty invoice. The X1 probe holds that half.
  //
  // REACHABILITY, stated plainly: no A12 verb can write this row. `normalizeTemplateLines` stores
  // through `JSON.stringify` on create, on patch and on snapshot alike, so the state needs direct
  // database corruption or a future migration bug. This was robustness, not a live defect.
});

// --- X2: the discarded settle, attacked ----------------------------------------------------------

test('X2: discarded is a SETTLED outcome, occupies the index, and is never re-billed', () => {
  assert.deepEqual([...SETTLED_OUTCOMES], ['drafted', 'issued', 'discarded']);
  assert.deepEqual([...RUN_OUTCOMES], ['drafted', 'issued', 'discarded', 'skipped_locked', 'failed']);

  const { deps, workspaceId, contactId } = sellerWorkspace('x2');
  const created = schedule(deps, workspaceId, contactId, 'x2');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'x2-close' }).ok, true);
  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  const documentId = first.results[0].documentId;
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId, to: 'cancelled', idempotencyKey: 'x2-cancel' }).ok,
    true,
  );
  assert.equal(call(deps, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'x2-open' }).ok, true);
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].outcome, 'discarded');

  // The index really holds it: a hand-written second settle of that period is refused, whichever
  // settled outcome is attempted.
  for (const outcome of ['drafted', 'issued', 'discarded']) {
    assert.throws(
      () =>
        deps.store.db
          .prepare(
            `INSERT INTO recurring_run_log (id, workspace_id, schedule_id, period_key, document_id, outcome, error, due_stamped, ran_at)
             VALUES (?, ?, ?, '2026-07-01', NULL, ?, NULL, NULL, '2026-07-16T00:00:00.000Z')`,
          )
          .run(`dup_${outcome}`, workspaceId, created.id, outcome),
      /UNIQUE constraint failed/,
      `${outcome} slipped past the settled index`,
    );
  }
});

test('X2b: a discarded period is unrecoverable by design, and the Studio SAYS so', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x2b');
  const created = schedule(deps, workspaceId, contactId, 'x2b');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'x2b-close' }).ok, true);
  const documentId = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].documentId;
  call(deps, 'transition_document', { workspaceId, documentId, to: 'cancelled', idempotencyKey: 'x2b-cancel' });
  call(deps, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'x2b-open' });
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].outcome, 'discarded');

  // The owner changes their mind: they DID want July billed after all. Every route is closed.
  // 1. A re-tick will not revisit the period (the cursor moved and the index holds it).
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 0);
  // 2. Re-anchoring the cadence back onto that period does not re-bill it either: the settle stands.
  const patched = call(deps, 'update_recurring_schedule', {
    workspaceId,
    scheduleId: created.id,
    patch: { anchorDate: '2026-07-01' },
  });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  const after = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(after.ok, true, JSON.stringify(after));
  assert.equal(
    count(deps, "SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND status != 'cancelled'", workspaceId),
    0,
    'the period was re-billed after a deliberate discard',
  );
  // 3. There is no A12 verb that re-opens, un-settles or re-bills a period.
  const verbs = call(deps, 'list_recurring_schedules', { workspaceId }).ok;
  assert.equal(verbs, true);
  assert.equal(getAction('rebill_recurring_period'), undefined);
  assert.equal(getAction('reopen_recurring_period'), undefined);
  // AND IT IS DISCLOSED. `messages.en.json` recurring.history.skippedHint, rendered beside the
  // waiting draft: "A waiting draft is yours: issue it by hand or discard it. Either way the
  // schedule carries on by itself, and a discarded period is never billed again." Every clause of
  // that sentence is measured true by this probe, by X2 and by F5. The remaining route is a
  // hand-made invoice, which is the right answer for a period nobody scheduled.
});

// --- X3: the OTHER document fates the triangle can present ---------------------------------------

test('X3: a draft ISSUED then CANCELLED (reversed) settles as issued, and is never re-billed', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x3');
  const created = schedule(deps, workspaceId, contactId, 'x3');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'x3-close' }).ok, true);
  const documentId = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].documentId;
  assert.equal(call(deps, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'x3-open' }).ok, true);

  // A human issues the waiting draft and then reverses it, which is A10's correction path.
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId, to: 'issued', idempotencyKey: 'x3-issue' }).ok,
    true,
  );
  assert.equal(
    call(deps, 'transition_document', { workspaceId, documentId, to: 'cancelled', idempotencyKey: 'x3-cancel' }).ok,
    true,
  );
  assert.equal(
    deps.store.db.prepare('SELECT status FROM document WHERE id = ?').get(documentId).status,
    'cancelled',
  );

  // The tick sees a non-draft document and settles `issued`: the billing DID happen, and its
  // reversal is the human's correction. Re-billing it would silently undo that correction.
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.results[0].outcome, 'issued');
  assert.equal(res.results[0].documentId, documentId);
  assert.equal(
    deps.store.db.prepare('SELECT next_run_date FROM recurring_schedule WHERE id = ?').get(created.id).next_run_date,
    '2026-08-01',
  );
  // One document total: the reversal did not become a second invoice.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
  // The run log tells the truth on the join: outcome issued, document status cancelled.
  const detail = call(deps, 'get_recurring_schedule', { workspaceId, scheduleId: created.id });
  const settled = detail.runs.find((r) => r.outcome === 'issued');
  assert.equal(settled.documentStatus, 'cancelled');
});

test('X4: ending a schedule with a locked draft outstanding leaves an orphan draft and an open period', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x4');
  const created = schedule(deps, workspaceId, contactId, 'x4');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'x4-close' }).ok, true);
  const first = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(first.results[0].outcome, 'skipped_locked');

  // The operator gives up on the series and ends it while the draft still waits behind the lock.
  assert.equal(call(deps, 'end_recurring_schedule', { workspaceId, scheduleId: created.id }).ok, true);
  assert.equal(call(deps, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'x4-open' }).ok, true);

  // The tick no longer selects the schedule, so the draft is never issued and never discarded.
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 0);
  // MEASURED: an unnumbered draft with no ledger effect survives, and the period's only run row is
  // the OPEN observation. Nothing is wrong in the books; the draft is simply left for a human.
  assert.equal(
    count(deps, "SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND status = 'draft'", workspaceId),
    1,
  );
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 0);
  assert.deepEqual(
    runRows(deps, created.id).map((r) => r.outcome),
    ['skipped_locked'],
  );
  // And it IS discoverable: the detail view names the period, the outcome and the draft.
  const detail = call(deps, 'get_recurring_schedule', { workspaceId, scheduleId: created.id });
  assert.equal(detail.schedule.status, 'ended');
  assert.equal(detail.runs[0].outcome, 'skipped_locked');
  assert.equal(detail.runs[0].documentStatus, 'draft');
});

test('X5: a cadence edit that re-anchors ONTO a settled period converges instead of double billing', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x5');
  const created = schedule(deps, workspaceId, contactId, 'x5', { anchorDate: '2026-07-16' });
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].outcome, 'issued');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);

  // Re-anchor onto today, which is the period that just settled: the cursor walks back onto it.
  const patched = call(deps, 'update_recurring_schedule', {
    workspaceId,
    scheduleId: created.id,
    patch: { anchorDate: '2026-07-16', interval: 'monthly' },
  });
  assert.equal(patched.ok, true, JSON.stringify(patched));
  assert.equal(patched.schedule.nextRunDate, '2026-07-16', 'the cursor did not walk back, so this probe is stale');

  // The settled index refuses the second settle and the tick CONVERGES by advancing (invariant I3),
  // rather than throwing or minting a second invoice.
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId), 1);
  assert.equal(
    count(deps, "SELECT COUNT(*) AS n FROM recurring_run_log WHERE schedule_id = ? AND outcome IN ('drafted','issued','discarded')", created.id),
    1,
    'a second settle row exists for one period',
  );
  assert.equal(
    deps.store.db.prepare('SELECT next_run_date FROM recurring_schedule WHERE id = ?').get(created.id).next_run_date,
    '2026-08-16',
  );
});

// --- X6: due_stamped, the exact edit that flips it -----------------------------------------------

test('X6: only the due-date VALUE decides the re-assert; an unrelated patch does not protect it', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x6');
  const created = schedule(deps, workspaceId, contactId, 'x6');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'x6-close' }).ok, true);
  const documentId = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].documentId;
  assert.equal(
    deps.store.db.prepare('SELECT due_date FROM document WHERE id = ?').get(documentId).due_date,
    '2026-07-26',
  );

  // A patch that touches something ELSE leaves the machine stamp in place, so the re-assert fires.
  assert.equal(
    call(deps, 'update_document', { workspaceId, documentId, patch: { notes: 'Bitte bis Ende Monat' }, idempotencyKey: 'x6-notes' }).ok,
    true,
  );
  const later = { ...deps, clock: fixedClock('2026-08-27T00:00:00.000Z') };
  assert.equal(call(later, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'x6-open' }).ok, true);
  assert.equal(call(later, 'run_due_recurring', { workspaceId }).results[0].outcome, 'issued');
  assert.deepEqual(
    deps.store.db.prepare('SELECT issue_date, due_date FROM document WHERE id = ?').get(documentId),
    { issue_date: '2026-08-27', due_date: '2026-09-06' },
  );
});

test('X6b (RECORDED, spec 4b): re-typing the SAME date the machine stamped is indistinguishable and is re-asserted', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x6b');
  schedule(deps, workspaceId, contactId, 'x6b');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'x6b-close' }).ok, true);
  const documentId = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].documentId;

  // The operator deliberately confirms the very date the tick stamped. Value comparison cannot tell
  // that apart from an untouched stamp, so the intent is indistinguishable and is overwritten.
  // Recorded in spec 4b (accepted costs) as the irreducible ambiguity of the due_stamped design:
  // this probe PINS the documented behaviour, so a silent change in either direction goes red.
  assert.equal(
    call(deps, 'update_document', { workspaceId, documentId, patch: { dueDate: '2026-07-26' }, idempotencyKey: 'x6b-same' }).ok,
    true,
  );
  const later = { ...deps, clock: fixedClock('2026-08-27T00:00:00.000Z') };
  call(later, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'x6b-open' });
  assert.equal(call(later, 'run_due_recurring', { workspaceId }).results[0].outcome, 'issued');
  assert.equal(
    deps.store.db.prepare('SELECT due_date FROM document WHERE id = ?').get(documentId).due_date,
    '2026-09-06',
    'the deliberately re-typed date survived, so this nit is closed',
  );
});

test('X6c: the crash-window fallback re-derives the stamp from the document, and still protects a human date', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x6c');
  const created = schedule(deps, workspaceId, contactId, 'x6c');
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'x6c-close' }).ok, true);
  const documentId = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].documentId;
  // The crash window: the run row that recorded due_stamped is gone, so the fallback must derive it
  // from the document's own creation day.
  deps.store.db.prepare('DELETE FROM recurring_run_log WHERE schedule_id = ?').run(created.id);
  assert.equal(
    call(deps, 'update_document', { workspaceId, documentId, patch: { dueDate: '2026-12-31' }, idempotencyKey: 'x6c-neg' }).ok,
    true,
  );
  const later = { ...deps, clock: fixedClock('2026-08-27T00:00:00.000Z') };
  call(later, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'x6c-open' });
  assert.equal(call(later, 'run_due_recurring', { workspaceId }).results[0].outcome, 'issued');
  // The negotiated date survives even with no recorded stamp to compare against.
  assert.deepEqual(
    deps.store.db.prepare('SELECT issue_date, due_date FROM document WHERE id = ?').get(documentId),
    { issue_date: '2026-08-27', due_date: '2026-12-31' },
  );
});

// --- X7: tenancy on the new reads ----------------------------------------------------------------

test('X7: the fate verification and the stamp lookup never see another tenant', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x7');
  const other = mintWorkspace(deps, 'Fremd GmbH', 'x7-other');
  const created = schedule(deps, workspaceId, contactId, 'x7', { autoIssue: false });
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).results[0].outcome, 'drafted');

  // The other tenant's tick sees nothing of this workspace at all.
  const foreign = call(deps, 'run_due_recurring', { workspaceId: other.workspaceId, asOf: '2026-07-16' });
  assert.equal(foreign.ok, true);
  assert.equal(foreign.generated, 0);
  assert.deepEqual(foreign.results, []);
  assert.equal(call(deps, 'list_recurring_schedules', { workspaceId: other.workspaceId }).schedules.length, 0);
  assert.equal(call(deps, 'get_recurring_schedule', { workspaceId: other.workspaceId, scheduleId: created.id }).error, 'not_found');
  // The document the tick generated stays in its own workspace.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', other.workspaceId), 0);
  // The run-log rows carry the owning workspace, so the correlated last-run reads cannot bleed.
  const rows = deps.store.db.prepare('SELECT DISTINCT workspace_id FROM recurring_run_log').all().map((r) => r.workspace_id);
  assert.deepEqual(rows, [workspaceId]);
});

// --- X8: the statutory set, re-measured on THIS head ---------------------------------------------

test('X8: the straddle still declares in the current return on the legacy Ziffer, and cross-foots', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x8');
  schedule(deps, workspaceId, contactId, 'x8', { anchorDate: '2023-11-01', dueDays: 30 });
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 24);

  const ret = call(deps, 'vat_return', { workspaceId, periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ret.ok, true, JSON.stringify(ret));
  const byLine = Object.fromEntries(ret.lines.map((b) => [b.code, b]));
  assert.deepEqual(
    { base: byLine['302'].baseMinor, tax: byLine['302'].taxMinor, rateBp: byLine['302'].rateBp },
    { base: 200000, tax: 15400, rateBp: 770 },
  );
  assert.deepEqual(
    { base: byLine['303'].baseMinor, tax: byLine['303'].taxMinor, rateBp: byLine['303'].rateBp },
    { base: 2200000, tax: 178200, rateBp: 810 },
  );
  assert.equal(ret.totalTaxDueMinor, 193600);
  assert.equal(ret.reconciled, true);
  assert.equal(ret.reconciliation.driftMinor, 0);
  // The already-closed 2023 return is untouched: period membership is the ENTRY date.
  assert.equal(call(deps, 'vat_return', { workspaceId, periodStart: '2023-10-01', periodEnd: '2023-12-31' }).empty, true);
});

// --- X9: what the rebuild dropped from the first build's schema ----------------------------------

test('X9: the schedule idempotency key is enforced by the memo alone now, and it still holds', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x9');
  // The first build carried an `idempotency_key` COLUMN with its own partial UNIQUE index, so the
  // guarantee survived a process boundary. The rebuild dropped both and relies on the store's
  // idempotency memo. The boundary still REQUIRES the key, and a replay still returns the first
  // schedule rather than minting a second.
  const cols = deps.store.db.prepare('PRAGMA table_info(recurring_schedule)').all().map((c) => c.name);
  assert.equal(cols.includes('idempotency_key'), false, 'the column is back, so this probe is stale');
  assert.deepEqual(
    getAction('create_recurring_schedule').inputSchema.required,
    ['workspaceId', 'interval', 'anchorDate', 'idempotencyKey'],
  );

  const first = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ unitPriceMinor: 100000 }],
    interval: 'monthly',
    anchorDate: '2026-08-01',
    idempotencyKey: 'x9-same',
  });
  const second = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ unitPriceMinor: 999999 }],
    interval: 'yearly',
    anchorDate: '2027-01-01',
    idempotencyKey: 'x9-same',
  });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.schedule.id, first.schedule.id, 'a repeated key minted a second schedule');
  assert.equal(second.schedule.interval, 'monthly', 'the replay returned the SECOND call shape');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM recurring_schedule WHERE workspace_id = ?', workspaceId), 1);
});

test('X9b: the negative-price refusal is PARITY with A10, not an A12 restriction', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('x9b');
  // The hypothesis was that A12's whitelist adds `< 0` and so forbids a discount position the
  // manual path allows. REFUTED: A10 refuses it too, with its own reasoned message. The two agree.
  const line = { description: 'Rabatt', unitPriceMinor: -10000, taxCode: 'UST81' };
  const manual = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }, line],
    idempotencyKey: 'x9b-doc',
  });
  assert.equal(manual.ok, false);
  assert.equal(manual.error, 'invalid_line');

  const scheduled = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }, line],
    interval: 'monthly',
    anchorDate: '2026-08-01',
    idempotencyKey: 'x9b-sched',
  });
  assert.equal(scheduled.ok, false);
  assert.equal(scheduled.error, 'invalid_input');
  assert.equal(scheduled.field, 'unitPriceMinor');
  assert.equal(scheduled.position, 2, 'the refusal names the position, as A10 does');
});
