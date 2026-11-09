/**
 * B03, job costing / project P&L: the read model's business rules, proven on worlds seeded through
 * the REAL verbs (B00 project, B01 time, B02 billing, A11 issue), never by hand-written rows on the
 * money path.
 *
 * The P5 claims are MEASURED, not narrated:
 *  - read-only: every verb call is bracketed by a full row census of every table (the A08
 *    `surface.test.mjs` shape); the static half lives in `read-only.test.mjs`.
 *  - reconciliation: drilldown Σ == card figure per component, one code path; cost-to-date equals
 *    B00's own `project_budget_actual` actual; revenue equals the posted invoice's subtotal.
 *  - §H-TENANT: a second workspace's project is `project_not_found` from the first, and the
 *    portfolio list never crosses.
 *  - clean degradation (P9): an empty project answers a ZERO P&L with `marginBp: null`, never an
 *    error; unattributable components answer zero rows plus the flag, never a fabricated figure.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { entryValueMinor } from '../../dist/core/time/index.js';
import { UNATTRIBUTABLE_COMPONENTS } from '../../dist/core/costing/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const COSTING_TOOLS = ['costing_project_pl', 'costing_pl_list', 'costing_budget_vs_actual', 'costing_drilldown'];

/** Dispatch through the registry, `workspaceId` bound, so every call passes the real boundary. */
function caller(deps, workspaceId) {
  return (name, input = {}) => getAction(name).run(deps, { workspaceId, ...input });
}

/**
 * The shared world: a budgeted project with a default rate card, two APPROVED hours billed onto a
 * POSTED invoice, one approved unbilled hour, and one OPEN entry a default read must exclude.
 */
function seeded() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Projekterfolg GmbH', 'cost-ws');
  const call = caller(deps, workspaceId);

  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  call('set_creditor_profile', {
    creditorName: 'Projekterfolg GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const contact = call('create_contact', {
    partyRole: 'customer',
    name: 'Marge AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: 'buchhaltung@marge.example',
    idempotencyKey: 'cost-c1',
  });
  const project = call('project_create', {
    name: 'Relaunch',
    contactId: contact.contact.id,
    budgetMinor: 100000,
    budgetHours: 10,
    idempotencyKey: 'cost-p1',
  });
  assert.equal(project.ok, true, JSON.stringify(project));
  const projectId = project.project.id;
  call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'cost-r1' });

  // Two entries to bill (90 + 30 minutes), one approved-unbilled (45), all in July.
  call('time_log', { userId: 'user-a', projectId, startedAt: '2026-07-01T08:00:00.000Z', minutes: 90, idempotencyKey: 'cost-t1' });
  call('time_log', { userId: 'user-a', projectId, startedAt: '2026-07-02T08:00:00.000Z', minutes: 30, idempotencyKey: 'cost-t2' });
  call('time_log', { userId: 'user-b', projectId, startedAt: '2026-07-03T08:00:00.000Z', minutes: 45, idempotencyKey: 'cost-t3' });
  const submitted = call('time_submit', { period: '2026-07', idempotencyKey: 'cost-sub' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const approved = call('time_approve', { entryIds: submitted.entryIds, idempotencyKey: 'cost-app' });
  assert.equal(approved.ok, true, JSON.stringify(approved));

  // Bill the two user-a entries (their line groups by project) and POST the invoice.
  const billable = deps.store.db
    .prepare("SELECT id FROM time_entry WHERE workspace_id = ? AND user_id = 'user-a' ORDER BY started_at")
    .all(workspaceId)
    .map((r) => r.id);
  const generated = call('billing_generate_invoice', {
    contactId: contact.contact.id,
    timeEntryIds: billable,
    idempotencyKey: 'cost-gen',
  });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const issued = call('issue_invoice', { invoiceId: generated.invoiceId, idempotencyKey: 'cost-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));

  // The OPEN entry, logged after approval so it stays open (excluded by the default slice).
  call('time_log', { userId: 'user-c', projectId, startedAt: '2026-07-10T08:00:00.000Z', minutes: 60, idempotencyKey: 'cost-t4' });

  return { deps, workspaceId, accId, call, projectId, contactId: contact.contact.id, invoiceId: generated.invoiceId };
}

/** Every row in every table, so "nothing was written" is a measurement and not a promise. */
function census(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, store.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
}

// The seeded arithmetic, stated once: 120 approved-billed minutes at 150.00/h = 300.00, plus 45
// approved-unbilled minutes = 112.50. Revenue is the posted invoice's two lines, 225.00 + 75.00.
const BILLED_MINOR = entryValueMinor(90, 15000) + entryValueMinor(30, 15000); // 30000
const UNBILLED_MINOR = entryValueMinor(45, 15000); // 11250
const TIME_MINOR = BILLED_MINOR + UNBILLED_MINOR; // 41250

test('B03 registration: four read verbs, zero writes', () => {
  for (const name of COSTING_TOOLS) {
    const action = ACTIONS.find((a) => a.name === name);
    assert.ok(action !== undefined, `${name} is not in ACTIONS`);
    assert.equal(action.kind, 'read', `${name} must be a read`);
    assert.ok(action.inputSchema.required.includes('workspaceId'), `${name} must require workspaceId (§H-TENANT)`);
  }
  const costingWrites = ACTIONS.filter((a) => a.name.startsWith('costing_') && a.kind === 'write');
  assert.deepEqual(costingWrites, [], 'B03 registered a write verb; it is a pure read model (P5)');
});

test('B03 read-only: every verb leaves the row census of every table untouched', () => {
  const { deps, workspaceId, projectId } = seeded();
  const inputs = {
    costing_project_pl: { workspaceId, projectId },
    costing_pl_list: { workspaceId },
    costing_budget_vs_actual: { workspaceId, projectId },
    costing_drilldown: { workspaceId, projectId, component: 'time' },
  };
  for (const name of COSTING_TOOLS) {
    const before = census(deps.store);
    const res = getAction(name).run(deps, inputs[name]);
    assert.equal(res.ok, true, `${name} failed: ${JSON.stringify(res)}`);
    assert.deepEqual(census(deps.store), before, `${name} changed a row count somewhere`);
  }
});

test('B03 card: time at snapshot rates, revenue from the posted invoice, margin and marginBp round-once', () => {
  const { deps, workspaceId, projectId, invoiceId, call } = seeded();
  const pl = call('costing_project_pl', { projectId });
  assert.equal(pl.ok, true, JSON.stringify(pl));

  assert.equal(pl.costBreakdown.timeMinor, TIME_MINOR);
  assert.equal(pl.costMinor, TIME_MINOR, 'cost == time while no project-tagged bill or PO exists');
  assert.equal(pl.timeMinutes, 165);

  // Revenue reconciles with the ledger-backed document: the posted invoice's own net subtotal.
  const doc = deps.store.db
    .prepare('SELECT subtotal_minor, posted_entry_id FROM document WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, invoiceId);
  assert.ok(doc.posted_entry_id !== null, 'the seed invoice must be posted');
  assert.equal(pl.revenueMinor, doc.subtotal_minor);
  assert.equal(pl.revenueMinor, BILLED_MINOR, 'B02 bills the snapshot value, so revenue == billed time value');

  assert.equal(pl.marginMinor, pl.revenueMinor - pl.costMinor);
  assert.equal(pl.marginBp, Math.round((pl.marginMinor * 10000) / pl.revenueMinor));
  assert.deepEqual(pl.unattributableComponents, [...UNATTRIBUTABLE_COMPONENTS]);
  assert.equal(pl.basis, 'bill');
  assert.equal(pl.basisDegraded, false, 'the bill basis is exact, not degraded');
});

test('B03 slices: the open entry joins only under includeOpenTime; asOf cuts by source date', () => {
  const { call, projectId } = seeded();
  const base = call('costing_project_pl', { projectId });
  assert.equal(base.ok, true);
  assert.equal(base.timeMinutes, 165, 'the OPEN entry must be excluded by default');

  const widened = call('costing_project_pl', { projectId, includeOpenTime: true });
  assert.equal(widened.timeMinutes, 225);
  assert.equal(widened.costBreakdown.timeMinor, TIME_MINOR + entryValueMinor(60, 15000));

  // asOf 2026-07-01: only the first entry (90 min) contributes.
  const cut = call('costing_project_pl', { projectId, asOf: '2026-07-01' });
  assert.equal(cut.ok, true);
  assert.equal(cut.timeMinutes, 90);
  assert.equal(cut.costBreakdown.timeMinor, entryValueMinor(90, 15000));

  const badDate = call('costing_project_pl', { projectId, asOf: '01.07.2026' });
  assert.equal(badDate.ok, false);
  assert.equal(badDate.error, 'invalid_input');
});

test('B03 cost basis: degrades honestly to the bill figures while no cost rate exists', () => {
  const { call, projectId } = seeded();
  const bill = call('costing_project_pl', { projectId });
  const cost = call('costing_project_pl', { projectId, basis: 'cost' });
  assert.equal(cost.ok, true);
  assert.equal(cost.basisDegraded, true, 'the cost basis must SAY it degraded (P9)');
  assert.equal(cost.costMinor, bill.costMinor, 'degraded cost basis answers the bill figure, no invented rate');
  const bad = call('costing_project_pl', { projectId, basis: 'market' });
  assert.equal(bad.error, 'invalid_basis');
});

test('B03 cost basis: values time at the cost-rate snapshot and stops degrading when every entry carries one', () => {
  const { call, deps } = seeded();

  // Version the default card: v2 carries a cost rate. Entries captured AFTER its validFrom
  // snapshot costRateMinor at capture (OP1); the seeded project's older entries stay untouched.
  const v2 = call('rate_card_upsert', {
    scope: 'default',
    rateMinor: 15000,
    costRateMinor: 9000,
    validFrom: '2026-07-15',
    idempotencyKey: 'cost-r3',
  });
  assert.equal(v2.ok, true, JSON.stringify(v2));
  assert.equal(v2.rateCard.costRateMinor, 9000, 'the card echoes its cost rate');

  const contact = call('create_contact', { partyRole: 'customer', name: 'Kostensatz AG', idempotencyKey: 'cost-c6' });
  const project = call('project_create', { name: 'Kostensatz', contactId: contact.contact.id, idempotencyKey: 'cost-p6' });
  const projectId = project.project.id;
  call('time_log', { userId: 'user-k', projectId, startedAt: '2026-07-20T08:00:00.000Z', minutes: 90, idempotencyKey: 'cost-t8' });
  const s = call('time_submit', { period: '2026-07', projectId, idempotencyKey: 'cost-sub5' });
  call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'cost-app5' });

  // The snapshot is ON the row: a later card edit can never reprice it.
  const snap = deps.store.db.prepare('SELECT cost_rate_minor FROM time_entry WHERE project_id = ?').get(projectId);
  assert.equal(snap.cost_rate_minor, 9000);

  const bill = call('costing_project_pl', { projectId });
  assert.equal(bill.ok, true);
  assert.equal(bill.basisDegraded, false);
  assert.equal(bill.costBreakdown.timeMinor, entryValueMinor(90, 15000), 'bill basis prices at the bill rate');

  const cost = call('costing_project_pl', { projectId, basis: 'cost' });
  assert.equal(cost.ok, true);
  assert.equal(cost.basisDegraded, false, 'every contributing entry carries a cost rate: nothing degraded');
  assert.equal(cost.costBreakdown.timeMinor, entryValueMinor(90, 9000), 'cost basis prices at the snapshot cost rate');
  assert.equal(cost.revenueMinor, bill.revenueMinor, 'the basis re-derives only the time component');

  // The drilldown values each row under the same basis, one code path (Σ rows == card).
  const drill = call('costing_drilldown', { projectId, component: 'time', basis: 'cost' });
  assert.equal(drill.basisDegraded, false);
  assert.equal(drill.rows.reduce((acc, r) => acc + r.amountMinor, 0), cost.costBreakdown.timeMinor);
  assert.equal(drill.rows[0].costRateMinor, 9000);
});

test('B03 P9: an empty project answers a ZERO card with marginBp null, never an error', () => {
  const { call } = seeded();
  const contact = call('create_contact', { partyRole: 'customer', name: 'Leer AG', idempotencyKey: 'cost-c2' });
  const empty = call('project_create', { name: 'Leer', contactId: contact.contact.id, idempotencyKey: 'cost-p2' });
  const pl = call('costing_project_pl', { projectId: empty.project.id });
  assert.equal(pl.ok, true, `an empty project must not error: ${JSON.stringify(pl)}`);
  assert.equal(pl.revenueMinor, 0);
  assert.equal(pl.costMinor, 0);
  assert.equal(pl.marginMinor, 0);
  assert.equal(pl.marginBp, null, 'no revenue means marginBp null, never 0-as-break-even');

  const bva = call('costing_budget_vs_actual', { projectId: empty.project.id });
  assert.equal(bva.ok, true);
  assert.equal(bva.budgeted, false, 'no budget fields means budgeted:false, no fake 0-budget overrun');
  assert.equal(bva.remainingMinor, undefined);

  const missing = call('costing_project_pl', { projectId: 'proj_missing' });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'project_not_found');
});

test('B03 budget vs actual: reconciles with B00 and rounds consumedBp once', () => {
  const { call, projectId } = seeded();
  const bva = call('costing_budget_vs_actual', { projectId });
  assert.equal(bva.ok, true, JSON.stringify(bva));
  assert.equal(bva.budgeted, true);
  assert.equal(bva.budgetMinor, 100000);
  assert.equal(bva.costToDateMinor, TIME_MINOR);
  assert.equal(bva.remainingMinor, 100000 - TIME_MINOR);
  assert.equal(bva.consumedBp, Math.round((TIME_MINOR * 10000) / 100000));
  assert.equal(bva.overBudget, false);

  // The B00 cross-check: same project, same base figures. B00's cost seam counts every entry with
  // minutes (any status), so compare against B03's WIDENED slice, which is the same population.
  const b00 = call('project_budget_actual', { projectId });
  assert.equal(b00.ok, true);
  const widened = call('costing_budget_vs_actual', { projectId, includeOpenTime: true });
  assert.equal(widened.costToDateMinor, b00.actualCostMinor, 'B03 cost-to-date must reconcile with B00');

  // Overrun: a small budget flips the flag and remaining goes negative.
  const overContact = call('create_contact', { partyRole: 'customer', name: 'Knapp AG', idempotencyKey: 'cost-c3' });
  const over = call('project_create', { name: 'Knapp', contactId: overContact.contact.id, budgetMinor: 1000, idempotencyKey: 'cost-p3' });
  call('time_log', { userId: 'user-a', projectId: over.project.id, startedAt: '2026-07-04T08:00:00.000Z', minutes: 60, idempotencyKey: 'cost-t5' });
  const s = call('time_submit', { period: '2026-07', projectId: over.project.id, idempotencyKey: 'cost-sub2' });
  call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'cost-app2' });
  const overBva = call('costing_budget_vs_actual', { projectId: over.project.id });
  assert.equal(overBva.overBudget, true);
  assert.ok(overBva.remainingMinor < 0, 'remaining goes negative on overrun, never clamps');
});

test('B03 drilldown: Σ rows == card figure per component, pages walk without loss, honesty flags', () => {
  const { call, projectId } = seeded();
  const pl = call('costing_project_pl', { projectId });

  for (const component of ['time', 'revenue']) {
    // One page: the totals and the row sum agree with the card.
    const whole = call('costing_drilldown', { projectId, component });
    assert.equal(whole.ok, true, JSON.stringify(whole));
    const sum = whole.rows.reduce((acc, r) => acc + r.amountMinor, 0);
    const cardFigure = component === 'time' ? pl.costBreakdown.timeMinor : pl.revenueMinor;
    assert.equal(whole.totalMinor, cardFigure, `${component}: totalMinor != card`);
    assert.equal(sum, cardFigure, `${component}: Σ rows != card`);
    assert.equal(whole.nextCursor, null);

    // Keyset pages, limit 1: the union of pages is the same sum, no row lost or doubled.
    let cursor;
    let paged = 0;
    let pages = 0;
    for (;;) {
      const page = call('costing_drilldown', { projectId, component, limit: 1, ...(cursor !== undefined ? { cursor } : {}) });
      assert.equal(page.ok, true);
      paged += page.rows.reduce((acc, r) => acc + r.amountMinor, 0);
      pages += page.rows.length;
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    assert.equal(paged, cardFigure, `${component}: paged Σ != card`);
    assert.equal(pages, whole.rows.length);
  }

  // Traceability (OR 957a): every revenue row resolves to the posted journal entry behind it.
  const revenue = call('costing_drilldown', { projectId, component: 'revenue' });
  for (const row of revenue.rows) {
    assert.ok(typeof row.postedEntryId === 'string' && row.postedEntryId.length > 0, 'a revenue row must carry postedEntryId');
  }

  // A wired component with no contributing rows: an honest empty, ok and never an error (P9).
  // The unattributable flag is GONE since the A17/D02 project tags landed: a zero here is measured.
  const expenses = call('costing_drilldown', { projectId, component: 'expenses' });
  assert.equal(expenses.ok, true);
  assert.deepEqual(expenses.rows, []);
  assert.equal(expenses.unattributable, undefined, 'expenses attributes through vendor_bill.project_id now');
  assert.equal(expenses.totalMinor, 0);

  const bad = call('costing_drilldown', { projectId, component: 'margin' });
  assert.equal(bad.error, 'invalid_component');
});

test('B03 portfolio: margin-sorted, closed behind the filter, §H-TENANT never crosses', () => {
  const { deps, call, projectId } = seeded();

  const list = call('costing_pl_list', {});
  assert.equal(list.ok, true, JSON.stringify(list));
  const mine = list.projects.find((p) => p.projectId === projectId);
  assert.ok(mine !== undefined, 'the seeded project must be listed');
  const card = call('costing_project_pl', { projectId });
  assert.equal(mine.marginMinor, card.marginMinor, 'the list row and the card are one code path');
  const margins = list.projects.filter((p) => p.marginMinor !== undefined).map((p) => p.marginMinor);
  assert.deepEqual(margins, [...margins].sort((a, b) => b - a), 'sorted by margin descending');

  // A SECOND workspace: its project is invisible from the first, in the card and in the list.
  const other = mintWorkspace(deps, 'Fremd GmbH', 'cost-ws2');
  const otherCall = caller(deps, other.workspaceId);
  const oc = otherCall('create_contact', { partyRole: 'customer', name: 'Fremd AG', idempotencyKey: 'cost-oc' });
  const op = otherCall('project_create', { name: 'Fremdprojekt', contactId: oc.contact.id, idempotencyKey: 'cost-op' });
  const cross = call('costing_project_pl', { projectId: op.project.id });
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'project_not_found', 'a cross-tenant project answers not-found, never figures');
  const crossDrill = call('costing_drilldown', { projectId: op.project.id, component: 'time' });
  assert.equal(crossDrill.error, 'project_not_found');
  const listAgain = call('costing_pl_list', {});
  assert.ok(!listAgain.projects.some((p) => p.projectId === op.project.id), 'the portfolio crossed workspaces');

  // Closed projects: reportable (US-B03.5) but behind the filter. The lifecycle demands the
  // draft -> active step first; the close guard passes because every entry is approved or billed
  // except the deliberately OPEN one, which blocks: approve it first.
  const openEntries = call('time_submit', { period: '2026-07', projectId, idempotencyKey: 'cost-close-sub' });
  if (openEntries.ok === true) call('time_approve', { entryIds: openEntries.entryIds, idempotencyKey: 'cost-close-app' });
  call('project_set_status', { projectId, status: 'active', idempotencyKey: 'cost-activate' });
  const preClose = call('costing_project_pl', { projectId });
  const closed = call('project_set_status', { projectId, status: 'closed', idempotencyKey: 'cost-close' });
  assert.equal(closed.ok, true, `closing failed: ${JSON.stringify(closed)}`);
  const defaultList = call('costing_pl_list', {});
  assert.ok(!defaultList.projects.some((p) => p.projectId === projectId), 'closed must leave the default list');
  const closedList = call('costing_pl_list', { status: 'closed' });
  assert.ok(closedList.projects.some((p) => p.projectId === projectId), 'status=closed must include it');
  const closedCard = call('costing_project_pl', { projectId });
  assert.equal(closedCard.ok, true, 'a closed project stays fully readable');
  assert.equal(closedCard.costMinor, preClose.costMinor, 'closing must not move one figure');

  const badStatus = call('costing_pl_list', { status: 'archived' });
  assert.equal(badStatus.error, 'invalid_status');
});

test('B03 §H-FX: a non-base-currency snapshot is loud, never silently mixed', () => {
  const { call } = seeded();
  const contact = call('create_contact', { partyRole: 'customer', name: 'Euro AG', idempotencyKey: 'cost-c4' });
  const project = call('project_create', { name: 'Europrojekt', contactId: contact.contact.id, idempotencyKey: 'cost-p4' });
  // A project-scoped EUR rate card: the entry snapshots EUR, and the base sum must refuse.
  call('rate_card_upsert', {
    scope: 'project',
    scopeRef: project.project.id,
    rateMinor: 10000,
    currency: 'EUR',
    validFrom: '2026-01-01',
    idempotencyKey: 'cost-r2',
  });
  const logged = call('time_log', { userId: 'user-a', projectId: project.project.id, startedAt: '2026-07-05T08:00:00.000Z', minutes: 60, idempotencyKey: 'cost-t6' });
  assert.equal(logged.ok, true, JSON.stringify(logged));
  const s = call('time_submit', { period: '2026-07', projectId: project.project.id, idempotencyKey: 'cost-sub3' });
  call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'cost-app3' });

  const pl = call('costing_project_pl', { projectId: project.project.id });
  assert.equal(pl.ok, false);
  assert.equal(pl.error, 'fx_base_missing');
  assert.ok(Array.isArray(pl.rowIds) && pl.rowIds.length === 1, 'the offending rows are named');

  // The portfolio degrades PER ROW instead of blanking: the EUR project carries the flag.
  const list = call('costing_pl_list', {});
  assert.equal(list.ok, true);
  const row = list.projects.find((p) => p.projectId === project.project.id);
  assert.equal(row.fxBaseMissing, true);
  assert.equal(row.marginMinor, undefined, 'no figures on a degraded row, never a mixed sum');
});

test('B03 groupBy: re-buckets the time component without moving one top-level figure', () => {
  const { deps, call, projectId } = seeded();

  // A confirmed select field on time_entry, through G00's own verbs (agent drafts, confirm publishes).
  const field = call('define_field', {
    entityKind: 'time_entry',
    key: 'kostenstelle',
    labelI18n: { 'de-CH': 'Kostenstelle', en: 'Cost centre' },
    type: 'select',
    options: ['Beratung', 'Umsetzung'],
    idempotencyKey: 'cost-f1',
  });
  assert.equal(field.ok, true, JSON.stringify(field));
  const confirmed = call('confirm_field', { fieldDefId: field.fieldDef.fieldDefId, idempotencyKey: 'cost-f1c' });
  assert.equal(confirmed.ok, true, `confirm_field failed: ${JSON.stringify(confirmed)}`);

  const entryId = deps.store.db
    .prepare('SELECT id FROM time_entry WHERE project_id = ? AND minutes = 90')
    .get(projectId).id;
  const set = call('set_field_value', {
    entityKind: 'time_entry',
    entityId: entryId,
    fieldKey: 'kostenstelle',
    value: 'Beratung',
    idempotencyKey: 'cost-f1v',
  });
  assert.equal(set.ok, true, JSON.stringify(set));

  const plain = call('costing_project_pl', { projectId });
  const grouped = call('costing_project_pl', { projectId, groupBy: 'kostenstelle' });
  assert.equal(grouped.ok, true, JSON.stringify(grouped));

  // The invariance contract: every top-level figure byte-identical to the ungrouped call.
  const strip = ({ groupBy, breakdownByGroup, ...rest }) => rest;
  assert.deepEqual(strip(grouped), strip(plain), 'groupBy moved a top-level figure');

  // The buckets: the tagged entry under its value, the rest under null, Σ == component total.
  const groups = grouped.breakdownByGroup.groups;
  const sum = groups.reduce((acc, g) => acc + g.minor, 0);
  assert.equal(sum, plain.costBreakdown.timeMinor, 'bucket Σ != component total');
  const tagged = groups.find((g) => g.value === 'Beratung');
  assert.equal(tagged.minor, entryValueMinor(90, 15000));

  const unknown = call('costing_project_pl', { projectId, groupBy: 'gibtesnicht' });
  assert.equal(unknown.error, 'field_not_found');
});

test('B03 marginBp: null while revenue is zero even with real cost', () => {
  const { call } = seeded();
  const contact = call('create_contact', { partyRole: 'customer', name: 'Nur Kosten AG', idempotencyKey: 'cost-c5' });
  const project = call('project_create', { name: 'Nur Kosten', contactId: contact.contact.id, idempotencyKey: 'cost-p5' });
  call('time_log', { userId: 'user-a', projectId: project.project.id, startedAt: '2026-07-06T08:00:00.000Z', minutes: 120, idempotencyKey: 'cost-t7' });
  const s = call('time_submit', { period: '2026-07', projectId: project.project.id, idempotencyKey: 'cost-sub4' });
  call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'cost-app4' });

  const pl = call('costing_project_pl', { projectId: project.project.id });
  assert.equal(pl.ok, true);
  assert.equal(pl.revenueMinor, 0);
  assert.ok(pl.costMinor > 0);
  assert.ok(pl.marginMinor < 0);
  assert.equal(pl.marginBp, null);
});

// ------------------------------------------------------------------------------------------------
// The project cost dimension: A17 bills and D02 purchases attribute to a project.
// ------------------------------------------------------------------------------------------------

/** Seed a vendor into the costing world. `record_expense` posts through the REAL A17 path. */
function addVendor(call, key = 'cost-v1', name = 'Lieferant GmbH') {
  const vendor = call('create_contact', { partyRole: 'vendor', name, idempotencyKey: key });
  assert.equal(vendor.ok, true, JSON.stringify(vendor));
  return vendor.contact.id;
}

test('B03 expenses: a project-tagged posted bill populates the cost side; untagged and draft bills do not', () => {
  const { call, projectId, accId } = seeded();
  const before = call('costing_project_pl', { projectId });
  const vendorId = addVendor(call);

  // Gross 1'081.00 at VST-M 8.1% => net 1'000.00: the canonical A17 arithmetic, project-tagged.
  const tagged = call('record_expense', {
    vendorId,
    billDate: '2026-07-05',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    projectId,
    idempotencyKey: 'cost-b1',
  });
  assert.equal(tagged.ok, true, JSON.stringify(tagged));
  // An UNTAGGED posted bill and a TAGGED DRAFT: neither may move the P&L.
  const untagged = call('record_expense', {
    vendorId,
    billDate: '2026-07-05',
    amountMinor: 54050,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    idempotencyKey: 'cost-b2',
  });
  assert.equal(untagged.ok, true, JSON.stringify(untagged));
  const draft = call('create_vendor_bill', {
    vendorId,
    billDate: '2026-07-06',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    projectId,
    idempotencyKey: 'cost-b3',
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));

  const pl = call('costing_project_pl', { projectId });
  assert.equal(pl.ok, true, JSON.stringify(pl));
  assert.equal(pl.costBreakdown.expensesMinor, 100000, 'the tagged POSTED bill, at base net, and nothing else');
  assert.equal(pl.costBreakdown.purchasesMinor, 0, 'no 3-way match: an unmatched bill is an expense');
  assert.equal(pl.costMinor, before.costMinor + 100000, 'the cost side moved by exactly the tagged bill');
  assert.equal(pl.marginMinor, pl.revenueMinor - pl.costMinor);
  assert.deepEqual(pl.unattributableComponents, [], 'every component attributes from a landed source');

  // Drilldown: Σ rows == card figure, each row tracing to its posted journal entry (OR 957a).
  const drill = call('costing_drilldown', { projectId, component: 'expenses' });
  assert.equal(drill.ok, true, JSON.stringify(drill));
  assert.equal(drill.totalMinor, 100000);
  assert.equal(drill.rows.length, 1);
  assert.equal(drill.rows[0].sourceKind, 'vendor_bill');
  assert.equal(drill.rows[0].amountMinor, 100000);
  assert.ok(typeof drill.rows[0].postedEntryId === 'string' && drill.rows[0].postedEntryId.length > 0);

  // asOf before the bill date cuts it back out.
  const cut = call('costing_project_pl', { projectId, asOf: '2026-07-04' });
  assert.equal(cut.costBreakdown.expensesMinor, 0);
});

test('B03 money path untouched: a projectId on the bill changes not one journal figure', () => {
  const { call, deps, workspaceId, projectId, accId } = seeded();
  const vendorId = addVendor(call);
  const input = (key, withProject) => ({
    vendorId,
    billDate: '2026-07-05',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    ...(withProject ? { projectId } : {}),
    idempotencyKey: key,
  });
  const withTag = call('record_expense', input('cost-mp1', true));
  const without = call('record_expense', input('cost-mp2', false));
  assert.equal(withTag.ok, true, JSON.stringify(withTag));
  assert.equal(without.ok, true, JSON.stringify(without));

  const legs = (entryId) =>
    deps.store.db
      .prepare(
        `SELECT a.number, l.debit_minor, l.credit_minor, l.base_debit_minor, l.base_credit_minor
           FROM journal_line l JOIN account a ON a.id = l.account_id
          WHERE l.entry_id = ? AND a.workspace_id = ?
          ORDER BY a.number, l.debit_minor, l.credit_minor`,
      )
      .all(entryId, workspaceId);
  assert.deepEqual(
    legs(withTag.entryId),
    legs(without.entryId),
    'the tag is a reporting dimension: identical accounts, identical amounts, identical base figures',
  );

  const bill = deps.store.db
    .prepare('SELECT project_id, net_minor, gross_minor, payable_minor FROM vendor_bill WHERE id = ?')
    .get(withTag.vendorBillId);
  assert.equal(bill.project_id, projectId, 'the tag is stored on the bill row');
  const untaggedBill = deps.store.db
    .prepare('SELECT net_minor, gross_minor, payable_minor FROM vendor_bill WHERE id = ?')
    .get(without.vendorBillId);
  assert.deepEqual(
    { net: bill.net_minor, gross: bill.gross_minor, payable: bill.payable_minor },
    { net: untaggedBill.net_minor, gross: untaggedBill.gross_minor, payable: untaggedBill.payable_minor },
  );

  // A posted bill's tag is frozen at the DB layer, exactly like cost_center_id (§H-AUDIT).
  assert.throws(
    () =>
      deps.store.db
        .prepare('UPDATE vendor_bill SET project_id = NULL WHERE id = ?')
        .run(withTag.vendorBillId),
    /vendor_bill_immutable/,
  );
});

test('B03 purchases and the accrual: committed -> accrued -> purchases, each Franken counted once', () => {
  const { call, projectId, accId } = seeded();
  const vendorId = addVendor(call, 'cost-v2', 'Material AG');
  const before = call('costing_project_pl', { projectId });

  // A 4 x 100.00 project-tagged PO: committed while ordered, nothing accrued, nothing booked.
  const po = call('po_upsert', {
    supplierContactId: vendorId,
    lines: [{ description: 'Material', qty: 4, unitPriceRappen: 10000, projectId }],
    idempotencyKey: 'cost-po1',
  });
  assert.equal(po.ok, true, JSON.stringify(po));
  const sent = call('po_send', { poId: po.poId, idempotencyKey: 'cost-po1-send' });
  assert.equal(sent.ok, true, JSON.stringify(sent));

  const ordered = call('costing_project_pl', { projectId });
  assert.equal(ordered.committedMinor, 40000, 'the open order balance reports beside the P&L');
  assert.equal(ordered.costBreakdown.accruedPurchasesMinor, 0);
  assert.equal(ordered.costMinor, before.costMinor, 'an obligation is not a cost incurred');

  // Receive the goods: the value moves committed -> accrued (still no posting anywhere).
  const location = call('stock_location_upsert', { name: 'Lager', idempotencyKey: 'cost-loc1' });
  assert.equal(location.ok, true, JSON.stringify(location));
  const receipt = call('receipt_record', {
    poId: po.poId,
    locationId: location.location.id,
    lines: [{ poLineId: po.lines[0].id, qty: 4 }],
    idempotencyKey: 'cost-rec1',
  });
  assert.equal(receipt.ok, true, JSON.stringify(receipt));

  const received = call('costing_project_pl', { projectId });
  assert.equal(received.costBreakdown.accruedPurchasesMinor, 40000);
  assert.equal(received.committedMinor, 0, 'fully received: no open order balance left');
  assert.equal(received.costMinor, before.costMinor + 40000);

  const accrualDrill = call('costing_drilldown', { projectId, component: 'accrued_purchases' });
  assert.equal(accrualDrill.totalMinor, 40000);
  assert.equal(accrualDrill.rows.length, 1);
  assert.equal(accrualDrill.rows[0].sourceKind, 'po_line');
  assert.equal(accrualDrill.rows[0].qty, 4);

  // The matched bill (net 400.00, tagged): the accrual leaves as purchases enters, Σ constant.
  const bill = call('record_expense', {
    vendorId,
    billDate: '2026-07-08',
    amountMinor: 40000,
    amountIsGross: false,
    expenseAccountId: accId('6500'),
    projectId,
    idempotencyKey: 'cost-pb1',
  });
  assert.equal(bill.ok, true, JSON.stringify(bill));
  const match = call('match_bill', { poId: po.poId, billId: bill.vendorBillId, idempotencyKey: 'cost-m1' });
  assert.equal(match.ok, true, JSON.stringify(match));

  const matched = call('costing_project_pl', { projectId });
  assert.equal(matched.costBreakdown.purchasesMinor, 40000, 'the matched bill books as purchases');
  assert.equal(matched.costBreakdown.accruedPurchasesMinor, 0, 'the accrual dropped with the match');
  assert.equal(matched.costBreakdown.expensesMinor, 0, 'a matched bill never doubles as an expense');
  assert.equal(
    matched.costMinor,
    received.costMinor,
    'no-double-count: the Franken moved between components, the total did not move',
  );

  const purchasesDrill = call('costing_drilldown', { projectId, component: 'purchases' });
  assert.equal(purchasesDrill.totalMinor, 40000);
  assert.equal(purchasesDrill.rows[0].sourceKind, 'vendor_bill');
});

test('B03 §H-TENANT: the new project tags never cross a workspace fence', () => {
  const { deps, call, projectId, accId } = seeded();
  const vendorId = addVendor(call);

  // A second workspace cannot tag ITS bill with the first workspace's project.
  const other = mintWorkspace(deps, 'Fremd GmbH', 'cost-ws3');
  const otherCall = caller(deps, other.workspaceId);
  otherCall('vat_seed_defaults', {});
  const otherVendor = otherCall('create_contact', { partyRole: 'vendor', name: 'Fremdlieferant', idempotencyKey: 'cost-ov' });
  const crossTag = otherCall('record_expense', {
    vendorId: otherVendor.contact.id,
    billDate: '2026-07-05',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: other.accId('6500'),
    projectId,
    idempotencyKey: 'cost-ob1',
  });
  assert.equal(crossTag.ok, false);
  assert.equal(crossTag.error, 'invalid_reference', 'a cross-tenant project tag is refused at capture');

  // The same fence on a PO line.
  const crossPo = otherCall('po_upsert', {
    supplierContactId: otherVendor.contact.id,
    lines: [{ description: 'Fremd', qty: 1, unitPriceRappen: 1000, projectId }],
    idempotencyKey: 'cost-opo',
  });
  assert.equal(crossPo.ok, false);
  assert.equal(crossPo.error, 'invalid_reference');

  // And the first workspace's P&L never reads another book's rows: its own bill stays its own.
  const own = call('record_expense', {
    vendorId,
    billDate: '2026-07-05',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    projectId,
    idempotencyKey: 'cost-b4',
  });
  assert.equal(own.ok, true, JSON.stringify(own));
  const pl = call('costing_project_pl', { projectId });
  assert.equal(pl.costBreakdown.expensesMinor, 100000, 'exactly the own-workspace bill, nothing foreign');
});

test('B03 budget vs actual: cost-to-date carries the bill and reconciles with B00 seam for seam', () => {
  const { call, projectId, accId } = seeded();
  const vendorId = addVendor(call);
  call('record_expense', {
    vendorId,
    billDate: '2026-07-05',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: accId('6500'),
    projectId,
    idempotencyKey: 'cost-b5',
  });

  const bva = call('costing_budget_vs_actual', { projectId });
  assert.equal(bva.ok, true, JSON.stringify(bva));
  assert.equal(bva.costToDateMinor, TIME_MINOR + 100000, 'time at snapshot rates plus the posted project bill');

  // B00's own budget actual reads the SAME facts through its cost-source seam (a17_bills).
  const b00 = call('project_budget_actual', { projectId });
  assert.equal(b00.ok, true, JSON.stringify(b00));
  const widened = call('costing_budget_vs_actual', { projectId, includeOpenTime: true });
  assert.equal(widened.costToDateMinor, b00.actualCostMinor, 'B03 and B00 cannot disagree about budget burn');
});
