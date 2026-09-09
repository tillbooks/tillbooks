/**
 * F00, dashboards & KPIs: the tile wall's business rules, proven on worlds seeded through the REAL
 * verbs (B00 project, B01 time, B02 billing, A11 issue, A19 bank opening), never by hand-written
 * rows on the money path.
 *
 * The P5 claims are MEASURED, not narrated:
 *  - anti-drift (the capability's whole contract): every tile's value strictly equals its source
 *    verb's answer for the identical filter, called through the same registry boundary.
 *  - read-only: the verb calls are bracketed by a full row census of every table (the B03 shape);
 *    the static half lives in `read-only.test.mjs`.
 *  - §H-TENANT: a second workspace sees only its own zeros, and a saved view minted in workspace A
 *    never resolves against a call for workspace B.
 *  - RBAC (US-F00.6): tiles are omitted server-side exactly where the registry capability set is
 *    missing, `omitted[]` names them, and a saved view never widens access.
 *  - clean degradation (P9): an EMPTY workspace answers ok:true zero states, never an error, and
 *    unavailable modules answer their named codes (`needs_projects`, `needs_stock_items`,
 *    `needs_vat_config`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS, getAction } from '../../dist/api/registry.js';
import { DASHBOARD_TILES } from '../../dist/core/dashboards/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const FROM = '2026-01-01';
const TO = '2026-09-30'; // Q3 end, so the MWST tile lands on the settlement period of the seeded invoice.

/** Dispatch through the registry, `workspaceId` bound, so every call passes the real boundary. */
function caller(deps, workspaceId) {
  return (name, input = {}) => getAction(name).run(deps, { workspaceId, ...input });
}

/**
 * The shared world (the B03 seed plus the cash side): a budgeted project with a default rate card,
 * two APPROVED hours billed onto a POSTED invoice, one approved unbilled hour, one OPEN entry, an
 * effektiv/soll VAT config, and a bank account carrying a posted opening balance so the cash tile
 * has a real Kontoblatt figure to reconcile against.
 */
function seeded() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Übersicht GmbH', 'dash-ws');
  const call = caller(deps, workspaceId);

  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  call('set_creditor_profile', {
    creditorName: 'Übersicht GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const contact = call('create_contact', {
    partyRole: 'customer',
    name: 'Kachel AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: 'buchhaltung@kachel.example',
    idempotencyKey: 'dash-c1',
  });
  const project = call('project_create', {
    name: 'Relaunch',
    contactId: contact.contact.id,
    budgetMinor: 100000,
    budgetHours: 10,
    idempotencyKey: 'dash-p1',
  });
  assert.equal(project.ok, true, JSON.stringify(project));
  const projectId = project.project.id;
  call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'dash-r1' });

  call('time_log', { userId: 'user-a', projectId, startedAt: '2026-07-01T08:00:00.000Z', minutes: 90, idempotencyKey: 'dash-t1' });
  call('time_log', { userId: 'user-a', projectId, startedAt: '2026-07-02T08:00:00.000Z', minutes: 30, idempotencyKey: 'dash-t2' });
  call('time_log', { userId: 'user-b', projectId, startedAt: '2026-07-03T08:00:00.000Z', minutes: 45, idempotencyKey: 'dash-t3' });
  const submitted = call('time_submit', { period: '2026-07', idempotencyKey: 'dash-sub' });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  const approved = call('time_approve', { entryIds: submitted.entryIds, idempotencyKey: 'dash-app' });
  assert.equal(approved.ok, true, JSON.stringify(approved));

  const billable = deps.store.db
    .prepare("SELECT id FROM time_entry WHERE workspace_id = ? AND user_id = 'user-a' ORDER BY started_at")
    .all(workspaceId)
    .map((r) => r.id);
  const generated = call('billing_generate_invoice', {
    contactId: contact.contact.id,
    timeEntryIds: billable,
    idempotencyKey: 'dash-gen',
  });
  assert.equal(generated.ok, true, JSON.stringify(generated));
  const issued = call('issue_invoice', { invoiceId: generated.invoiceId, idempotencyKey: 'dash-issue' });
  assert.equal(issued.ok, true, JSON.stringify(issued));

  // The OPEN entry, logged after approval so it stays open.
  call('time_log', { userId: 'user-c', projectId, startedAt: '2026-07-10T08:00:00.000Z', minutes: 60, idempotencyKey: 'dash-t4' });

  // A second invoice WITH a VAT code, so the MWST tile has a real Q3 liability to reconcile.
  const doc = call('create_document', {
    type: 'invoice',
    contactId: contact.contact.id,
    currency: 'CHF',
    dueDate: '2026-08-15',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'dash-doc',
  });
  assert.equal(doc.ok, true, JSON.stringify(doc));
  const issuedVat = call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'dash-issue2' });
  assert.equal(issuedVat.ok, true, JSON.stringify(issuedVat));

  // The cash side: a bank account whose ledger account (1020) carries a POSTED opening balance.
  call('create_account', { number: '9100', name: 'Eröffnungsbilanz', type: 'equity', idempotencyKey: 'dash-ob' });
  const bank = call('create_bank_account', {
    name: 'Kantonalbank Kontokorrent',
    iban: 'CH93 0076 2011 6238 5295 7',
    currency: 'CHF',
    ledgerAccountId: accId('1020'),
    idempotencyKey: 'dash-bank',
  });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  const opening = call('set_bank_opening_balance', {
    bankAccountId: bank.bankAccountId,
    amountMinor: 1250000,
    date: '2026-01-01',
    idempotencyKey: 'dash-open',
  });
  assert.equal(opening.ok, true, JSON.stringify(opening));

  return { deps, workspaceId, accId, call, projectId };
}

/** Every row in every table, so "nothing was written" is a measurement and not a promise. */
function census(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, store.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n]));
}

function tileOf(overview, id) {
  const tile = overview.tiles.find((t) => t.tile === id);
  assert.ok(tile !== undefined, `the ${id} tile is missing from ${JSON.stringify(overview.tiles.map((t) => t.tile))}`);
  return tile;
}

test('F00 registration: two read verbs, zero writes', () => {
  const mine = ACTIONS.filter((a) => a.name.startsWith('dashboard_'));
  assert.deepEqual(
    mine.map((a) => [a.name, a.kind]).sort(),
    [
      ['dashboard_overview', 'read'],
      ['dashboard_tile', 'read'],
    ],
    'F00 registers exactly its two reads and never a write',
  );
});

test('F00 read-only by census: the overview and the single tile move not one row', () => {
  const { deps, call } = seeded();
  const before = census(deps.store);
  const overview = call('dashboard_overview', { from: FROM, to: TO });
  assert.equal(overview.ok, true, JSON.stringify(overview));
  const single = call('dashboard_tile', { tile: 'ar_aging', from: FROM, to: TO });
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.deepEqual(census(deps.store), before, 'a dashboard read changed the database');
});

test('F00 anti-drift: every tile value strictly equals its source verb for the identical filter', () => {
  const { call } = seeded();
  const overview = call('dashboard_overview', { from: FROM, to: TO });
  assert.equal(overview.ok, true, JSON.stringify(overview));

  // revenue == income_statement's netto_erloese subtotal for the same period.
  const statement = call('income_statement', { periodStart: FROM, periodEnd: TO });
  assert.equal(statement.ok, true, JSON.stringify(statement));
  const erloese = statement.sections.find((s) => s.key === 'netto_erloese');
  const revenue = tileOf(overview, 'revenue');
  assert.ok(revenue.valueRappen > 0, 'the seeded invoice must produce revenue');
  assert.equal(revenue.valueRappen, erloese.subtotalMinor, 'revenue tile drifted from income_statement');
  assert.equal(revenue.trendBp, null, 'the previous window is empty, so a trend would be a fake figure');

  // cash == the Kontoblatt closing balance of the one bank ledger account.
  const banks = call('list_bank_accounts', {});
  assert.equal(banks.bankAccounts.length, 1);
  const konto = call('general_ledger', {
    accountId: banks.bankAccounts[0].ledgerAccountId,
    periodStart: FROM,
    periodEnd: TO,
  });
  assert.equal(konto.ok, true, JSON.stringify(konto));
  const cash = tileOf(overview, 'cash');
  assert.equal(cash.valueRappen, konto.closingMinor, 'cash tile drifted from the Kontoblatt');
  assert.equal(cash.valueRappen, 1250000, 'the posted opening balance is the whole cash position');

  // ar_aging == aging_report at the range end.
  const aging = call('aging_report', { asOf: TO });
  const ar = tileOf(overview, 'ar_aging');
  assert.ok(ar.valueRappen > 0, 'the posted invoice must be open');
  assert.equal(ar.valueRappen, aging.baseTotalOpenMinor, 'AR tile drifted from aging_report');
  assert.deepEqual(ar.detail.baseByBucket, aging.baseByBucket);

  // ap_aging == list_vendor_bills (as of the injected clock's today, A17's own contract).
  const bills = call('list_vendor_bills', {});
  const ap = tileOf(overview, 'ap_aging');
  assert.equal(ap.valueRappen, bills.baseTotalOpenMinor, 'AP tile drifted from list_vendor_bills');
  assert.equal(ap.asOf, bills.asOf);

  // utilisation == the billable share of time_list minutes, rounded once.
  const toExclusive = '2026-10-01';
  const allTime = call('time_list', { from: FROM, to: toExclusive });
  const billableTime = call('time_list', { from: FROM, to: toExclusive, billable: true });
  const utilisation = tileOf(overview, 'utilisation');
  assert.equal(utilisation.detail.totalMinutes, allTime.totalMinutes);
  assert.equal(utilisation.detail.billableMinutes, billableTime.totalMinutes);
  assert.equal(
    utilisation.valueBp,
    allTime.totalMinutes === 0 ? null : Math.round((billableTime.totalMinutes * 10000) / allTime.totalMinutes),
    'utilisation tile drifted from time_list, or rounded twice',
  );

  // project_margin == costing_pl_list summed at the range end.
  const portfolio = call('costing_pl_list', { asOf: TO });
  assert.equal(portfolio.ok, true, JSON.stringify(portfolio));
  const measured = portfolio.projects.filter((p) => p.fxBaseMissing !== true);
  const marginSum = measured.reduce((n, p) => n + p.marginMinor, 0);
  const revenueSum = measured.reduce((n, p) => n + p.revenueMinor, 0);
  const margin = tileOf(overview, 'project_margin');
  assert.equal(margin.valueRappen, marginSum, 'margin tile drifted from costing_pl_list');
  assert.equal(
    margin.detail.marginBp,
    revenueSum === 0 ? null : Math.round((marginSum * 10000) / revenueSum),
  );

  // mwst_due == vat_return's payableMinor for the settlement period containing the range end
  // (the compliance assertion, spec §8: the MWSTG trace intact to the Rappen).
  const vatReturn = call('vat_return', { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(vatReturn.ok, true, JSON.stringify(vatReturn));
  const mwst = tileOf(overview, 'mwst_due');
  assert.ok(vatReturn.payableMinor > 0, 'the issued invoice must owe output VAT in Q3');
  assert.equal(mwst.valueRappen, vatReturn.payableMinor, 'MWST tile drifted from vat_return');
  assert.equal(mwst.detail.period, '2026-Q3');
  assert.equal(mwst.detail.filed, false);

  // stock_value: no track_stock item in this world, so the honest degradation, never a zero.
  const stock = tileOf(overview, 'stock_value');
  assert.equal(stock.ok, false);
  assert.equal(stock.error, 'needs_stock_items');

  // Every tile names its drill: an existing tool and a route, with the tenant in the params.
  for (const tile of overview.tiles) {
    if (tile.ok !== true) continue;
    assert.equal(typeof tile.drill.studioRoute, 'string');
    assert.ok(ACTIONS.some((a) => a.name === tile.drill.mcpTool), `${tile.tile} drills to unknown tool ${tile.drill.mcpTool}`);
    assert.equal(tile.drill.params.workspaceId, overview.workspaceId);
  }
});

test('F00 single tile: dashboard_tile answers the same figure the overview shows, plus detail', () => {
  const { call } = seeded();
  const overview = call('dashboard_overview', { from: FROM, to: TO });
  const single = call('dashboard_tile', { tile: 'project_margin', from: FROM, to: TO });
  assert.equal(single.ok, true, JSON.stringify(single));
  assert.deepEqual(single.tile, tileOf(overview, 'project_margin'), 'the single tile drifted from the overview');
});

test('F00 clean degradation (P9): an empty workspace answers ok:true, zero states, named codes', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Leer GmbH', 'dash-empty');
  const call = caller(deps, workspaceId);

  const overview = call('dashboard_overview', { from: FROM, to: TO });
  assert.equal(overview.ok, true, 'an empty workspace must answer ok:true, never an error');
  assert.deepEqual(overview.omitted, [], 'an unprovisioned workspace omits nothing');

  assert.equal(tileOf(overview, 'revenue').valueRappen, 0);
  assert.equal(tileOf(overview, 'cash').valueRappen, 0);
  assert.equal(tileOf(overview, 'ar_aging').valueRappen, 0);
  assert.equal(tileOf(overview, 'ap_aging').valueRappen, 0);
  assert.equal(tileOf(overview, 'utilisation').valueBp, null, 'no minutes is not a measured 0 %');

  const margin = tileOf(overview, 'project_margin');
  assert.deepEqual([margin.ok, margin.error], [false, 'needs_projects']);
  const mwst = tileOf(overview, 'mwst_due');
  assert.deepEqual([mwst.ok, mwst.error], [false, 'needs_vat_config']);
  const stock = tileOf(overview, 'stock_value');
  assert.deepEqual([stock.ok, stock.error], [false, 'needs_stock_items']);
});

test('F00 range validation: from after to is invalid_range, a malformed date is invalid_input', () => {
  const { call } = seeded();
  const backwards = call('dashboard_overview', { from: '2026-09-30', to: '2026-01-01' });
  assert.deepEqual([backwards.ok, backwards.error], [false, 'invalid_range']);
  const malformed = call('dashboard_overview', { from: 'gestern', to: TO });
  assert.deepEqual([malformed.ok, malformed.error], [false, 'invalid_input']);
  const unknown = call('dashboard_tile', { tile: 'nonsense', from: FROM, to: TO });
  assert.deepEqual([unknown.ok, unknown.error], [false, 'unknown_tile']);
  assert.deepEqual(unknown.known, [...DASHBOARD_TILES], 'the refusal names the enumerable set');
});

test('F00 §H-TENANT: a second workspace sees only its own zeros, and a foreign saved view never resolves', () => {
  const { deps, call: callA } = seeded();
  const { workspaceId: wsB } = mintWorkspace(deps, 'Anders AG', 'dash-b');
  const callB = caller(deps, wsB);

  const overviewA = callA('dashboard_overview', { from: FROM, to: TO });
  const overviewB = callB('dashboard_overview', { from: FROM, to: TO });
  assert.ok(tileOf(overviewA, 'revenue').valueRappen > 0);
  assert.equal(tileOf(overviewB, 'revenue').valueRappen, 0, 'workspace B must never see workspace A revenue');
  assert.equal(tileOf(overviewB, 'ar_aging').valueRappen, 0);
  assert.equal(tileOf(overviewB, 'cash').valueRappen, 0);

  // A saved view minted in A: restricting for A, unresolvable (full fallback) for B.
  const view = callA('create_saved_view', {
    entityKind: 'workspace',
    name: 'Nur Finanzen',
    layout: 'dashboard',
    columns: ['cash', 'revenue'],
    idempotencyKey: 'dash-view',
  });
  assert.equal(view.ok, true, JSON.stringify(view));
  const viewId = view.savedView.viewId;

  const restricted = callA('dashboard_overview', { from: FROM, to: TO, savedViewId: viewId });
  assert.deepEqual(
    restricted.tiles.map((t) => t.tile),
    ['cash', 'revenue'],
    'the saved view restricts and ORDERS the tiles',
  );
  assert.equal(restricted.viewFallback, undefined);
  // A view never changes a value (spec §7).
  assert.equal(restricted.tiles[1].valueRappen, tileOf(overviewA, 'revenue').valueRappen);

  const foreign = callB('dashboard_overview', { from: FROM, to: TO, savedViewId: viewId });
  assert.equal(foreign.ok, true, 'a stale view id must not fail the dashboard (P9)');
  assert.equal(foreign.viewFallback, true, 'a foreign view falls back rather than resolving');
  assert.equal(foreign.tiles.length + foreign.omitted.length, DASHBOARD_TILES.length, 'the fallback is the FULL registry');
});

test('F00 RBAC (US-F00.6): tiles are omitted server-side exactly where the capability set is missing, and a saved view never widens access', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = mintWorkspace(deps, 'Rollen GmbH', 'dash-rbac');
  const call = caller(deps, workspaceId);

  // Provision (the D50 flip seats every D13 actor as owner), mint a narrow role, seat the agent on it.
  const invited = call('invite_member', {
    email: 'zeit@muster.ch',
    role: 'bookkeeper',
    idempotencyKey: 'dash-inv',
  });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const defined = call('define_role', { name: 'Nur Zeit', capabilities: ['time.read'], idempotencyKey: 'dash-role' });
  assert.equal(defined.ok, true, JSON.stringify(defined));
  const seat = call('list_members').members.find((m) => m.actorId === 'agent');
  const moved = call('set_role', { memberId: seat.memberId, role: defined.roleId });
  assert.equal(moved.ok, true, JSON.stringify(moved));

  // A workspace-shared dashboard view naming a financial tile, minted by the owner.
  const view = call('create_saved_view', {
    entityKind: 'workspace',
    name: 'Geteilt',
    layout: 'dashboard',
    columns: ['revenue', 'utilisation'],
    shared: true,
    idempotencyKey: 'dash-shared',
  });
  assert.equal(view.ok, true, JSON.stringify(view));

  deps.actor = 'agent';
  const overview = call('dashboard_overview', { from: FROM, to: TO });
  assert.equal(overview.ok, true, JSON.stringify(overview));
  assert.deepEqual(
    overview.tiles.map((t) => t.tile),
    ['utilisation'],
    'a time.read-only role sees exactly the utilisation tile',
  );
  const omittedTiles = overview.omitted.map((o) => o.tile).sort();
  assert.deepEqual(
    omittedTiles,
    [...DASHBOARD_TILES].filter((t) => t !== 'utilisation').sort(),
    'every other tile is omitted BY NAME, the honest shape',
  );
  assert.ok(overview.omitted.every((o) => o.error === 'permission_denied'));

  // The shared view is honoured for layout and can never widen access: revenue stays omitted.
  const viewed = call('dashboard_overview', { from: FROM, to: TO, savedViewId: view.savedView.viewId });
  assert.deepEqual(viewed.tiles.map((t) => t.tile), ['utilisation']);
  assert.deepEqual(viewed.omitted, [{ tile: 'revenue', error: 'permission_denied', capability: 'read_books' }]);

  // The single-tile ask refuses outright, the same fact stated as a denial.
  const denied = call('dashboard_tile', { tile: 'revenue', from: FROM, to: TO });
  assert.deepEqual([denied.ok, denied.error], [false, 'permission_denied']);
});
