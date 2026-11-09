/**
 * A12 RE-CRITIC PROBES (round 2), part of the D72 rebuild's ACCEPTANCE SUITE, adapted from
 * `origin/claude/a12-critic` (docs/critique/a12-critic.md, round 2 appended 31.07.2026).
 *
 * Semantics identical to the corpus. One comment updated for the rebuild: the R1b re-assert is now
 * CONDITIONAL on the draft still carrying the machine stamp (`due_stamped`, spec 4b), which changes
 * nothing this file asserts (nobody touches the draft here) and is what lets the round-3 F4 probe
 * flip. Every assertion is a ROW.
 *
 * The fixture clock is pinned to 2026-07-16 (test/api/support.mjs AT).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { fixedClock } from '../../dist/core/clock.js';
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

// --- R1 (FLIPPED): the due date anchors on the CLOCK, never on the asOf cursor -------------------

test('R1: a legal past asOf catches up as of that date, but every invoice is due from the CLOCK day', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r1');
  // MEASURED BEFORE THE REPAIR: dueDate anchored on asOfDay while issue_date came from the clock,
  // so run_due_recurring{asOf:'2024-06-15'} auto-issued five posted invoices dated 2026-07-16 and
  // due 2024-07-15, each 731 days overdue at birth. A past asOf is legal by design ("catch up only
  // as far as this date"); the invoice date is the clock's, and the due date follows the invoice.
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Retainer', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2024-02-01',
    dueDays: 30,
    autoIssue: true,
    idempotencyKey: 'r1-schedule',
  });
  assert.equal(created.ok, true, JSON.stringify(created));

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2024-06-15' });
  assert.equal(res.ok, true, JSON.stringify(res));
  // The cursor still governs HOW FAR the catch-up reaches: five periods, 2024-02 .. 2024-06.
  assert.equal(res.generated, 5);

  const rows = deps.store.db
    .prepare('SELECT number, issue_date, due_date FROM document WHERE workspace_id = ? ORDER BY number')
    .all(workspaceId);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.issue_date, '2026-07-16');
    assert.equal(row.due_date, '2026-08-15');
    assert.ok(row.due_date >= row.issue_date, `due ${row.due_date} precedes issue ${row.issue_date}`);
  }
});

// --- R2: can a supplyDate be smuggled back in on any path? --------------------------------------

test('R2: the whitelist strips a template supplyDate on create, on patch, and through a snapshot', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r2');
  const smuggled = { description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2023-05-05' };
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [smuggled],
    interval: 'monthly',
    anchorDate: '2026-05-01',
    autoIssue: true,
    idempotencyKey: 'r2-schedule',
  });
  assert.equal(created.ok, true);
  const storedLines = () =>
    JSON.parse(
      deps.store.db.prepare('SELECT lines_json FROM recurring_schedule WHERE id = ?').get(created.schedule.id).lines_json,
    );
  assert.equal(Object.hasOwn(storedLines()[0], 'supplyDate'), false, 'create stored a template supplyDate');

  // The patch path, which is the one the first round did not cover.
  assert.equal(
    call(deps, 'update_recurring_schedule', {
      workspaceId,
      scheduleId: created.schedule.id,
      patch: { lines: [{ ...smuggled, supplyDate: '2019-01-01' }] },
    }).ok,
    true,
  );
  assert.equal(Object.hasOwn(storedLines()[0], 'supplyDate'), false, 'the patch stored a template supplyDate');

  // The snapshot path: a REAL A10 document line may carry a supply_date, and A12 must not copy it.
  const doc = call(deps, 'create_document', {
    workspaceId,
    type: 'invoice',
    contactId,
    lines: [{ description: 'Vorlage', unitPriceMinor: 55500, taxCode: 'UST81', supplyDate: '2023-05-05' }],
    idempotencyKey: 'r2-doc',
  });
  assert.equal(doc.ok, true);
  assert.equal(
    deps.store.db.prepare('SELECT supply_date FROM document_line WHERE document_id = ?').get(doc.document.id).supply_date,
    '2023-05-05',
    'the fixture document must really carry a supply date, or the probe proves nothing',
  );
  const snapped = call(deps, 'create_recurring_schedule', {
    workspaceId,
    templateDocumentId: doc.document.id,
    interval: 'monthly',
    anchorDate: '2026-05-01',
    idempotencyKey: 'r2-snap',
  });
  assert.equal(snapped.ok, true, JSON.stringify(snapped));
  assert.equal(
    Object.hasOwn(
      JSON.parse(
        deps.store.db.prepare('SELECT lines_json FROM recurring_schedule WHERE id = ?').get(snapped.schedule.id).lines_json,
      )[0],
      'supplyDate',
    ),
    false,
    'the snapshot copied the source line supply date',
  );

  // And every generated line carries ITS period, not the smuggled date.
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.ok(res.generated >= 3);
  const pairs = deps.store.db
    .prepare(
      `SELECT r.period_key, l.supply_date FROM recurring_run_log r
         JOIN document_line l ON l.document_id = r.document_id
        WHERE r.workspace_id = ? AND r.schedule_id = ? ORDER BY r.period_key`,
    )
    .all(workspaceId, created.schedule.id);
  for (const p of pairs) assert.equal(p.supply_date, p.period_key);
});

test('R2b: the stamp WINS over a poisoned lines_json, so the spread order is load-bearing', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r2b');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-06-01',
    autoIssue: true,
    idempotencyKey: 'r2b-schedule',
  });
  assert.equal(created.ok, true);
  // A row shaped the way a pre-whitelist build would have written it (the schema comment argues no
  // migration is needed because the branch never landed; this is the defence-in-depth check that
  // the tick would survive one anyway).
  deps.store.db
    .prepare('UPDATE recurring_schedule SET lines_json = ? WHERE id = ?')
    .run(
      JSON.stringify([{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81', supplyDate: '2019-01-01' }]),
      created.schedule.id,
    );

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.generated, 2);
  const dates = deps.store.db
    .prepare('SELECT DISTINCT supply_date FROM document_line WHERE workspace_id = ? ORDER BY supply_date')
    .all(workspaceId)
    .map((r) => r.supply_date);
  assert.deepEqual(dates, ['2026-06-01', '2026-07-01'], 'a stored supplyDate overrode the tick stamp');
});

// --- R3: the month-end edge, now that the period is also the Leistungsdatum ----------------------

test('R3: a Jan-31 monthly schedule stamps a real, in-month Leistungsdatum for all 12 periods', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r3');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2025-07-31',
    autoIssue: true,
    idempotencyKey: 'r3-schedule',
  });
  assert.equal(created.ok, true);
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.generated, 12);

  const pairs = deps.store.db
    .prepare(
      `SELECT r.period_key, l.supply_date FROM recurring_run_log r
         JOIN document_line l ON l.document_id = r.document_id
        WHERE r.workspace_id = ? ORDER BY r.period_key`,
    )
    .all(workspaceId);
  const periods = pairs.map((p) => p.period_key);
  // The clamp re-anchors from the anchor DAY, so February is the 28th and March returns to the 31st,
  // and no month is billed twice or skipped.
  assert.deepEqual(periods, [
    '2025-07-31', '2025-08-31', '2025-09-30', '2025-10-31', '2025-11-30', '2025-12-31',
    '2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30',
  ]);
  assert.equal(new Set(periods.map((p) => p.slice(0, 7))).size, 12, 'a calendar month was billed twice');
  for (const p of pairs) assert.equal(p.supply_date, p.period_key);
});

// --- R4: the filed figure, end to end through A07 ------------------------------------------------

test('R4: the straddle declares in the CURRENT return, on the LEGACY Ziffer, and cross-foots', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r4');
  assert.equal(
    call(deps, 'create_recurring_schedule', {
      workspaceId,
      contactId,
      lines: [{ description: 'Retainer', unitPriceMinor: 100000, taxCode: 'UST81' }],
      interval: 'monthly',
      anchorDate: '2023-11-01',
      autoIssue: true,
      idempotencyKey: 'r4-schedule',
    }).ok,
    true,
  );
  // 2023-11-01 .. 2025-10-01: two periods in the 7.7% era, twenty-two in the 8.1% era.
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 24);

  // The already-closed 2023 return must be untouched: period membership is the ENTRY date, and every
  // one of these entries is dated 2026-07-16.
  const old = call(deps, 'vat_return', { workspaceId, periodStart: '2023-10-01', periodEnd: '2023-12-31' });
  assert.equal(old.ok, true, JSON.stringify(old));
  assert.equal(old.empty, true, 'a 2023-supply invoice booked in 2026 leaked into the 2023 return');
  assert.equal(old.lines.reduce((n, b) => n + b.taxMinor, 0), 0);

  const ret = call(deps, 'vat_return', { workspaceId, periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ret.ok, true, JSON.stringify(ret));
  const byLine = Object.fromEntries(ret.lines.map((b) => [b.code, b]));
  // Ziffer 302 is the "bis 31.12.2023" Normalsatz column, 303 the "ab 01.01.2024" one.
  assert.ok(byLine['302'] !== undefined, `no legacy Ziffer in ${JSON.stringify(Object.keys(byLine))}`);
  assert.deepEqual(
    { base: byLine['302'].baseMinor, tax: byLine['302'].taxMinor, rateBp: byLine['302'].rateBp },
    { base: 200000, tax: 15400, rateBp: 770 },
    'the two 7.7% periods do not report as 2 x CHF 77.00 on the legacy Ziffer',
  );
  assert.deepEqual(
    { base: byLine['303'].baseMinor, tax: byLine['303'].taxMinor, rateBp: byLine['303'].rateBp },
    { base: 2200000, tax: 178200, rateBp: 810 },
    'the twenty-two 8.1% periods do not report as 22 x CHF 81.00 on the current Ziffer',
  );
  assert.equal(ret.totalTaxDueMinor, 193600);
  assert.equal(ret.reconciled, true, 'the return does not cross-foot against the 2200 balance');
  assert.equal(ret.reconciliation.driftMinor, 0);
});

test('R5: a FILED 2023 period is not disturbed by a 2023-supply catch-up booked today', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r5');
  // File 2023-Q4 first (a hard vat_filed lock), then catch up across it.
  assert.equal(call(deps, 'vat_mark_filed', { workspaceId, period: '2023-Q4', idempotencyKey: 'r5-file' }).ok, true);
  assert.equal(
    call(deps, 'create_recurring_schedule', {
      workspaceId,
      contactId,
      lines: [{ description: 'Retainer', unitPriceMinor: 100000, taxCode: 'UST81' }],
      interval: 'monthly',
      anchorDate: '2023-11-01',
      autoIssue: true,
      idempotencyKey: 'r5-schedule',
    }).ok,
    true,
  );
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  // The lock is on the 2023 PERIOD, and the entries are dated today, so generation is unaffected.
  assert.equal(res.generated, 24, JSON.stringify(res.results.slice(0, 2)));

  const filed = call(deps, 'vat_return', { workspaceId, periodStart: '2023-10-01', periodEnd: '2023-12-31' });
  assert.equal(filed.ok, true);
  assert.equal(filed.empty, true, 'the filed return moved under the operator');
  assert.equal(filed.lines.reduce((n, b) => n + b.taxMinor, 0), 0);
});

// --- R6: C3, the ON DELETE SET NULL repair and the index it must not weaken ----------------------

test('R6: a cancelled draft leaves an intact settled row, and no duplicate can slip past the index', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r6');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 200000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    idempotencyKey: 'r6-schedule',
  });
  assert.equal(created.ok, true);
  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  const documentId = res.results[0].documentId;

  const cancelled = call(deps, 'transition_document', {
    workspaceId,
    documentId,
    to: 'cancelled',
    idempotencyKey: 'r6-cancel',
  });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);

  const row = deps.store.db
    .prepare('SELECT period_key, document_id, outcome, ran_at FROM recurring_run_log WHERE workspace_id = ?')
    .get(workspaceId);
  assert.deepEqual(
    { period_key: row.period_key, document_id: row.document_id, outcome: row.outcome },
    { period_key: '2026-07-01', document_id: null, outcome: 'drafted' },
  );
  assert.ok(typeof row.ran_at === 'string' && row.ran_at.length > 0, 'the timestamp survived');

  // THE ATTACK: does the null pointer let a second settle of the same period through? The partial
  // index keys on (schedule_id, period_key) and ignores document_id, so it must not.
  assert.throws(
    () =>
      deps.store.db
        .prepare(
          `INSERT INTO recurring_run_log (id, workspace_id, schedule_id, period_key, document_id, outcome, error, ran_at)
           VALUES ('dup_1', ?, ?, '2026-07-01', NULL, 'drafted', NULL, '2026-07-16T00:00:00.000Z')`,
        )
        .run(workspaceId, created.schedule.id),
    /UNIQUE constraint failed/,
  );

  // And the tick does not silently re-bill the period a human deliberately discarded.
  const again = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(again.generated, 0);
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 0);
});

// --- R7: C5's list read, across tenants -----------------------------------------------------------

test('R7: lastOutcome/lastError are per schedule and per workspace, with no bleed', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r7');
  const other = mintWorkspace(deps, 'Andere GmbH', 'r7-other');
  const healthy = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    idempotencyKey: 'r7-a',
  });
  assert.equal(healthy.ok, true);
  const untouched = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-12-01',
    idempotencyKey: 'r7-b',
  });
  assert.equal(untouched.ok, true);
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 1);

  const listed = call(deps, 'list_recurring_schedules', { workspaceId });
  const byId = Object.fromEntries(listed.schedules.map((s) => [s.id, s]));
  assert.equal(byId[healthy.schedule.id].lastOutcome, 'drafted');
  assert.equal(byId[healthy.schedule.id].lastError, null);
  // A schedule that has never run reports nothing rather than inheriting its neighbour's row.
  assert.equal(byId[untouched.schedule.id].lastOutcome, null);
  assert.equal(byId[untouched.schedule.id].lastError, null);
  // The other tenant sees nothing at all.
  assert.equal(call(deps, 'list_recurring_schedules', { workspaceId: other.workspaceId }).schedules.length, 0);
});

// --- R8: C4's bound, driven from the other side ---------------------------------------------------

test('R8: the end date bounds the CURRENT occurrence and ends the schedule without a run row', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r8');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-04-01',
    idempotencyKey: 'r8-schedule',
  });
  assert.equal(created.ok, true);
  // Two periods settle, then the operator moves the end date behind the pending third.
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-05-16' }).generated, 2);
  const patched = call(deps, 'update_recurring_schedule', {
    workspaceId,
    scheduleId: created.schedule.id,
    patch: { endDate: '2026-05-31' },
  });
  assert.equal(patched.ok, true, JSON.stringify(patched));

  const res = call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' });
  assert.equal(res.generated, 0, 'a period behind the moved-back end date was billed');
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM document WHERE workspace_id = ?', workspaceId), 2);
  const row = deps.store.db
    .prepare('SELECT status, next_run_date FROM recurring_schedule WHERE id = ?')
    .get(created.schedule.id);
  assert.deepEqual(row, { status: 'ended', next_run_date: '2026-06-01' });
  // No run-log row is written for the period that was never billed: the log records occurrences,
  // not the absence of one.
  assert.equal(count(deps, 'SELECT COUNT(*) AS n FROM recurring_run_log WHERE workspace_id = ?', workspaceId), 2);
  // end_before_anchor is refused on the patched PAIR, not only at create.
  const created2 = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ unitPriceMinor: 1000 }],
    interval: 'monthly',
    anchorDate: '2026-09-01',
    idempotencyKey: 'r8-b',
  });
  assert.equal(
    call(deps, 'update_recurring_schedule', {
      workspaceId,
      scheduleId: created2.schedule.id,
      patch: { endDate: '2026-08-01' },
    }).error,
    'end_before_anchor',
  );
});

// --- R1b (FLIPPED, orchestrator decision 31.07.2026): the due date follows A12's OWN issue call --

test('R1b: a draft that AGED before A12 issues it gets its due date re-asserted at issue', () => {
  // MEASURED BEFORE THE REPAIR: the due date was stamped once, at DRAFT time, so a draft that aged
  // (here: behind a period lock) issued weeks later still carrying the old date
  // ({issue_date:'2026-08-27', due_date:'2026-07-26'}).
  //
  // PLACEMENT (rebuild, spec 4b): A12 re-asserts the due date (issue day + dueDays) on the issue
  // call IT makes, via the draft-only update_document patch before issue_invoice, and ONLY while
  // the draft still carries the machine stamp recorded as due_stamped (nobody touches the draft in
  // this probe, so the re-assert fires). A10's transitionDocument is deliberately untouched: a
  // shared re-derivation at issue would clobber hand-set due dates on manual drafts, and a
  // negotiated date on A12's own draft now survives too (the F4 probe asserts it).
  const { deps, workspaceId, contactId } = sellerWorkspace('r1b');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Retainer', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    dueDays: 10,
    autoIssue: true,
    idempotencyKey: 'r1b-schedule',
  });
  assert.equal(created.ok, true);
  // The target period is locked, so the nightly tick drafts and skips (§H-PERIOD): the draft ages.
  assert.equal(call(deps, 'close_month', { workspaceId, period: '2026-07', idempotencyKey: 'r1b-close' }).ok, true);
  const first = call(deps, 'run_due_recurring', { workspaceId });
  assert.equal(first.results[0].outcome, 'skipped_locked');
  const documentId = first.results[0].documentId;
  assert.equal(
    deps.store.db.prepare('SELECT due_date FROM document WHERE id = ?').get(documentId).due_date,
    '2026-07-26',
    'the draft carries the draft-day due date while it waits',
  );

  // Six weeks pass: same store, a clock that has really moved. The lock lifts, the tick issues.
  const later = { ...deps, clock: fixedClock('2026-08-27T00:00:00.000Z') };
  assert.equal(call(later, 'reopen_month', { workspaceId, period: '2026-07', idempotencyKey: 'r1b-open' }).ok, true);
  const second = call(later, 'run_due_recurring', { workspaceId });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.results[0].periodKey, '2026-07-01');
  assert.equal(second.results[0].outcome, 'issued');

  // The regression the closing round asked for: draft generated, clock advanced, issued, and the
  // due date equals the ISSUE day plus dueDays, not the draft day's stamp.
  const row = deps.store.db.prepare('SELECT issue_date, due_date, status FROM document WHERE id = ?').get(documentId);
  assert.deepEqual(row, { issue_date: '2026-08-27', due_date: '2026-09-06', status: 'issued' });
});

// --- R9: the two open nits, checked rather than assumed -------------------------------------------

test('R9: N2 is cosmetic (a code-less schedule bills in the base currency) and N3 refuses, never hangs', () => {
  const { deps, workspaceId, contactId } = sellerWorkspace('r9');
  const created = call(deps, 'create_recurring_schedule', {
    workspaceId,
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    interval: 'monthly',
    anchorDate: '2026-07-01',
    autoIssue: true,
    idempotencyKey: 'r9-schedule',
  });
  assert.equal(created.ok, true);
  assert.equal(created.schedule.currency, null, 'no currency is stored when none is named');
  assert.equal(call(deps, 'run_due_recurring', { workspaceId, asOf: '2026-07-16' }).generated, 1);
  // N2: the Studio cannot NAME a currency, and the consequence is the workspace base currency, which
  // is right for the overwhelming majority and wrong for nobody. No figure is affected.
  const doc = deps.store.db.prepare('SELECT currency, tax_minor FROM document WHERE workspace_id = ?').get(workspaceId);
  assert.deepEqual(doc, { currency: 'CHF', tax_minor: 8100 });

  // N3: the 100'000-step bound is ~274 years at a one-day cadence. It REFUSES rather than spinning
  // or throwing, and `anchorDate` is a defensible thing to name: the anchor is what is unreachable.
  const patched = call(deps, 'update_recurring_schedule', {
    workspaceId,
    scheduleId: created.schedule.id,
    patch: { interval: 'custom', customDays: 1, anchorDate: '1700-01-01' },
  });
  assert.equal(patched.ok, false);
  assert.equal(patched.error, 'invalid_input');
  assert.equal(patched.field, 'anchorDate');
  // And the refusal changed nothing: the schedule keeps its cadence.
  assert.equal(
    deps.store.db.prepare('SELECT interval FROM recurring_schedule WHERE id = ?').get(created.schedule.id).interval,
    'monthly',
  );
});
