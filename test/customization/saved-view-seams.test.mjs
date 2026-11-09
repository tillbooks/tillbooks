/**
 * G00, the saved-view seam, wired through EVERY registered entity kind's list verb (F5 retrofit).
 *
 * WHAT WENT WRONG BEFORE THIS SUITE. `create_saved_view` accepts any registered kind, but only four
 * list verbs called `applySavedView`, so a view over a contact, item, account, cost centre, bank
 * account or journal entry could be STORED and never APPLIED: a stored lie, invisible because
 * nothing measured the seam against the registry. The F5 retrofit wired the six missing seams
 * (`docs/planning/f5-retrofit-survey.md` §3), and this suite is what keeps the wiring complete: the
 * coverage test below reddens the moment a kind is registered whose list verb does not accept
 * `savedViewId`, which is the drift that produced the debt in the first place.
 *
 * The per-kind behavioural tests each assert BOTH halves of the seam's contract: the stored filter
 * applies when only `savedViewId` is named, and an explicit filter wins over the stored one
 * (`applySavedView` merges the view UNDER the request).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { ENTITY_KIND_IDS } from '../../dist/core/customization/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

/**
 * The kind-to-list-verb map, the one hand-written pairing this suite allows itself. The coverage
 * test holds it equal to the registry, so a NEW kind reddens here until its list verb is named AND
 * that verb's schema really carries `savedViewId`.
 */
const LIST_VERB_FOR_KIND = {
  contact: 'list_contacts',
  item: 'list_items',
  bank_account: 'list_bank_accounts',
  account: 'list_accounts',
  cost_center: 'list_cost_centers',
  document: 'list_documents',
  payment: 'list_payments',
  journal_entry: 'list_journal',
  automation_rule: 'list_automation_rules',
  vendor_bill: 'list_vendor_bills',
  dunning_run: 'list_dunning_runs',
  recurring_schedule: 'list_recurring_schedules',
  reconciliation_match: 'list_unmatched_incoming',
  bank_txn: 'list_reconciliation',
  payment_batch: 'list_payment_batches',
  // A23. The roster read is pre-workspace, so its seam takes `savedViewWorkspaceId` (the book the
  // view is STORED in) alongside savedViewId: the roster it cuts is cross-book by design, so the
  // field is deliberately not called workspaceId (the conformance tenant-declaration rule).
  workspace: 'list_workspaces',
  // A25. `review_status` is the coverage read over `entry_review`; a saved view stores its period and
  // the read applies it (an explicit period wins). period is optional so a view can supply it.
  entry_review: 'review_status',
  // G10. The operator's Zuordnungsvorlagen list; a saved view stores a sourceSystem or kind filter
  // (spec §6b's "Abacus-Vorlagen") and an explicit filter wins through the same applySavedView merge.
  migration_map_template: 'migration_list_map_templates',
  // G09. The plan ROSTER (spec §6b "Offene Freigaben") and the STEP LIST ("Fehlgeschlagene Schritte").
  // `migration_get_plan` is the coverage read over the step list (its `steps[]`), the `review_status`
  // precedent one family over: a saved view stores a dataClass/state filter and an explicit one wins.
  migration_plan: 'migration_list_plans',
  migration_step: 'migration_get_plan',
  // G11. The check HISTORY over a plan (spec §6b's "Nicht bestandene Kontrollen"): a saved view
  // stores a stepId/against filter and an explicit one wins through the same applySavedView merge.
  migration_check: 'migration_list_checks',
  // G19. The extraction checklist (spec §6b's "Offene Exporte", "Blockiert"): `migration_get_manifest`
  // is the coverage read over the manifest's `items[]` (the `migration_get_plan`/`project_get`
  // precedent), and a saved view stores a status filter that an explicit one wins over through the
  // same applySavedView merge.
  migration_extraction_manifest: 'migration_get_manifest',
  // G13. The archive query (spec §6b's "Vorsystem 2023", "Unbalancierte Einträge"): a saved view
  // stores the archive filters and an explicit filter wins through the same applySavedView merge.
  gl_archive_entry: 'gl_archive_query',
  // B00. The Projekte list ("Meine aktiven Projekte", spec §6b); and `project_get` is the coverage
  // read over the phase list (its `phases[]`), the `migration_get_plan` precedent: a saved view
  // stores a phaseDone filter and an explicit one wins through the same applySavedView merge.
  project: 'project_list',
  project_phase: 'project_get',
  // G20. The implementation roster (`implementation_project_list`, "Blockiert" / "Übernahme diese
  // Woche"); and `implementation_project_get` is the coverage read over the task list (its `tasks[]`,
  // the `project_get -> project_phase` precedent) for BOTH the task and the sign-off kinds: a saved
  // view over a task stores a status/phase filter applied to the returned tasks through the same
  // applySavedView merge.
  implementation_project: 'implementation_project_list',
  implementation_task: 'implementation_project_get',
  implementation_signoff: 'implementation_project_get',
  // E03. The queue (spec §6b's "Meine Aufgaben diese Woche"): a saved view stores a bucket/assignee/
  // status filter and an explicit filter wins through the same applySavedView merge.
  task: 'tasks_list',
  // B01. The timesheet (spec §6b's "Meine offene Zeit", "Unverrechnete Zeit pro Projekt"): a saved
  // view stores a project/status/billable/unbilled filter and an explicit filter wins through the
  // same applySavedView merge.
  time_entry: 'time_list',
  // C01. The board read (spec §6b's "My open EUR deals"): a saved view stores a status/contact/
  // includeClosed filter and an explicit filter wins through the same applySavedView merge.
  deal: 'deals_list',
  // D01. The on-hand read model is the list over item x location (it also carries the location
  // picker): a saved view stores an itemId/locationId/asOf filter and an explicit one wins through
  // the same applySavedView merge.
  stock_location: 'stock_on_hand',
  // D01. The stocktake diff read model is the list over a session's lines, the `project_get`
  // coverage-read precedent: a saved view stores a line filter and an explicit one wins.
  stocktake: 'stock_stocktake_report',
  // C02. The Offerten list ("Offene Offerten diese Woche", spec §6b): a saved view stores a
  // status/contact filter and an explicit one wins through the same applySavedView merge, resolved
  // against the `quote` entityKind by `listQuotes` itself. `quote_line` shares the same list verb
  // (its custom-field columns surface in the Offerten list), the `project_phase -> project_get`
  // coverage-read precedent one family over.
  quote: 'quotes_list',
  quote_line: 'quotes_list',
  // D03. The Aufträge list ("Offene Aufträge mit Rückstand", spec §6b): a saved view stores a
  // status/contact filter and an explicit one wins through the same applySavedView merge, resolved
  // against the `sales_order` kind by `listSalesOrders` itself. `delivery_note` shares the order
  // detail read (`sales_order_get`), where its custom-field columns surface, the
  // `project_phase -> project_get` coverage-read precedent one family over.
  sales_order: 'sales_order_list',
  delivery_note: 'sales_order_get',
  // D02. The Einkauf list ("Open POs over CHF 5'000", "Awaiting revision", spec §6b): a saved view
  // stores a status/supplier filter and an explicit filter wins through the same applySavedView merge,
  // resolved against the `po` kind by `poList`/`poOpenLines` themselves.
  po: 'po_list',
  // E02 HR-lite. The roster ("Aktive Mitarbeitende"), the absence list and the Spesen list each apply
  // a stored view through the same applySavedView merge. The absence and claim lists apply the view
  // BENEATH their self-scoping filter, so a view can only ever narrow to the caller's own rows.
  employee: 'hr_employee_list',
  absence: 'hr_absence_list',
  expense_claim: 'expense_claim_list',
  // B04. The Mandate list applies a stored view through the same applySavedView merge (OP10).
  retainer: 'retainer_list',
  // E01. The sign-request list ("My open signatures", "Expiring this week", spec §6b) applies a
  // stored view through the same applySavedView merge; an explicit status/file/signer filter wins.
  sign_request: 'sign_requests_list',
  // F02: the Portal-Zugang list carries the saved-view seam (applySavedView over `portal_grant`).
  portal_grant: 'portal_grant_list',
  // F01. The run history over one report ("Nur fehlgeschlagene Läufe", spec §6b) is the coverage read
  // (`reports_runs`), the `project_get`/`sales_order_get` precedent: a saved view stores a status
  // (ok|failed) filter and an explicit one wins through the same applySavedView merge.
  report_run: 'reports_runs',
  // F03: the remittance-advice history carries the saved-view seam (applySavedView over
  // `remittance_advice`) on `vendor_portal_remittances`; the supplier CONTACT fence the read enforces
  // is never widened by a view.
  remittance_advice: 'vendor_portal_remittances',
  // E04: the Korrespondenz queue (spec §6b's "Antwort nötig von Kunde X"): a saved view stores an
  // account/bucket/contact filter over the computed thread read model and an explicit filter wins
  // through the same applySavedView merge; a view persists filters/sort/columns only, so it can
  // never hold a body (the OP6 leak-safety argument in the spec's own words).
  mail_thread: 'mail_threads_list',
  // G04. The backup history ("Nur fehlgeschlagene Backups", spec §6b's saved presets): a saved view
  // stores a kind/status filter and an explicit one wins through the same applySavedView merge, resolved
  // against the `backup` kind at the list_backups api boundary.
  backup: 'list_backups',
  // G05: the Vorlagen list (spec §6b's "Archivierte Offerten-Vorlagen"): a saved view stores a
  // documentKind/includeArchived filter over `applySavedView('document_template', ...)` and an
  // explicit filter wins through the same merge.
  document_template: 'list_document_templates',
  // G06: the /inbox queue ("Nur ungelesen", "Nur Rechnungen", spec §6b): a saved view stores a
  // status/bucket filter over `applySavedView('inbox_item', ...)` and an explicit filter wins
  // through the same merge; the view is applied BENEATH the structural self-scope, so it can only
  // ever narrow to the caller's own rows (the absence/claim precedent).
  inbox_item: 'notifications_list',
  // G07: a saved GLOBAL search is applied by the search verb itself, which is the kind's one read;
  // its stored {q, entityKinds} merge UNDER the explicit fields through the same applySavedView seam.
  global_search: 'search_global',
  // G02: the Erweiterungen list ("Nur inkompatible", "Nur Berichtsquellen", spec §6b): a saved view
  // stores a status filter over `applySavedView('plugin', ...)` and an explicit status wins through
  // the same merge.
  plugin: 'list_plugins',
  // G05 §10: the Protokoll ("Fehlgeschlagene Sendungen", spec §10.6b): a saved view stores a
  // kind/outcome/contact filter over `applySavedView('dispatch', ...)` and an explicit filter wins
  // through the same merge.
  dispatch: 'list_dispatches',
  // A31: the Belegeingang queue read applies a stored view's filters through the shared applySavedView
  // seam (status/from/to), the list_plugins precedent.
  capture: 'list_captures',
  // A32: the eBill delivery read model applies a stored view's filters through the shared
  // applySavedView seam (invoiceId/status/partnerStatus/from/to), the list_captures precedent.
  ebill_delivery: 'ebill_delivery_status',
  // A34: the payroll hand-off history read applies a stored view's filters (from/to over the
  // export/posting union) through the shared applySavedView seam, the list_captures precedent one
  // capability over; `list_payroll_handoffs` declares savedViewId.
  payroll_handoff: 'list_payroll_handoffs',
  // A33: the channel health read is the list over both channel kinds; a saved view over `ebics_order`
  // stores a status filter ("Awaiting bank release", "Rejected this quarter", spec §6b) applied to the
  // browsable order log through the shared applySavedView seam, and `ebics_connection` shares the same
  // read (the coverage-read precedent, `sales_order_get` over `delivery_note`). Both declare savedViewId.
  ebics_connection: 'bank_channel_status',
  ebics_order: 'bank_channel_status',
  // A37: the managed (bLink) rail rides the SAME merged channel-health read (spec §6b): a saved view
  // over `managed_order` stores a status filter ("Pending release", "Rejected this quarter") applied
  // to the browsable order log through the shared applySavedView seam, and `managed_connection` shares
  // the same read (the EBICS twins one rail over). Both declare savedViewId.
  managed_connection: 'bank_channel_status',
  managed_order: 'bank_channel_status',
  // H00: a saved view over fixed-asset categories stores an active filter or a code/name search
  // (spec §6b) applied through the shared applySavedView seam; `asset_category_list` declares
  // savedViewId.
  asset_category: 'asset_category_list',
  // H01: a saved view over the fixed-asset register stores a category/status/location filter or an
  // acquisition-year (spec §6b) applied through the shared applySavedView seam; `asset_list` declares
  // savedViewId.
  asset: 'asset_list',
  // I00: a saved view over requisitions stores a status/requester/project filter or a needed-by range
  // and a free-text search (spec §6) applied through the shared applySavedView seam; `requisition_list`
  // declares savedViewId.
  requisition: 'requisition_list',
  // J00: a saved view over warehouses stores an active filter or a code/name search applied through
  // the shared applySavedView seam; `warehouse_list` declares savedViewId. Locations ride the
  // extended `stock_location` kind, whose list verb is `stock_on_hand` above.
  warehouse: 'warehouse_list',
  // J01: a saved view over lots or serials stores a status/search filter applied through the shared
  // applySavedView seam; `lot_list` and `serial_list` each declare savedViewId.
  lot: 'lot_list',
  serial: 'serial_list',
  // H05: a saved view over asset locations stores an active/parent filter or a code/name search
  // applied through the shared applySavedView seam; `asset_location_list` declares savedViewId. The
  // transfer history is not a saved-view surface (it rides the `asset` kind), so no verb for it here.
  asset_location: 'asset_location_list',
  // I02: a saved view over goods receipts stores a status/order/supplier filter, a received-on range,
  // an over-receipt-only cut ("Mehrlieferungen", the exception the document now records rather than
  // refuses) or a free-text search, applied through the shared applySavedView seam;
  // `goods_receipt_list` declares savedViewId.
  goods_receipt: 'goods_receipt_list',
};

test('G00: every registered kind has a list verb, and that verb accepts savedViewId', () => {
  for (const kind of ENTITY_KIND_IDS) {
    const verb = LIST_VERB_FOR_KIND[kind];
    assert.ok(
      verb !== undefined,
      `entity kind '${kind}' has no list verb in LIST_VERB_FOR_KIND: wire its saved-view seam and name it here`,
    );
    const action = getAction(verb);
    assert.ok(action !== undefined, `${verb} is not a registered action`);
    assert.equal(action.kind, 'read');
    assert.ok(
      Object.hasOwn(action.inputSchema.properties, 'savedViewId'),
      `${verb} does not declare savedViewId, so a saved view over '${kind}' can be stored but never applied`,
    );
  }
});

function workspace(key) {
  const deps = freshDeps();
  deps.actor = 'studio';
  const ws = mintWorkspace(deps, 'Ansichten AG', `svs-${key}`);
  return { deps, workspaceId: ws.workspaceId };
}

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function makeView(deps, workspaceId, entityKind, filters, key) {
  return must(
    call(deps, 'create_saved_view', {
      workspaceId,
      entityKind,
      name: `Ansicht ${key}`,
      filters,
      idempotencyKey: `svs-view-${key}`,
    }),
    'create_saved_view',
  ).savedView.viewId;
}

test('contact: the stored partyRole filter applies, and an explicit one wins', () => {
  const { deps, workspaceId } = workspace('contact');
  must(
    call(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Kundin AG', idempotencyKey: 'svs-c1' }),
    'create_contact customer',
  );
  must(
    call(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'svs-c2' }),
    'create_contact vendor',
  );
  const viewId = makeView(deps, workspaceId, 'contact', { partyRole: 'vendor' }, 'contact');

  const viewed = must(call(deps, 'list_contacts', { workspaceId, savedViewId: viewId }), 'list via view');
  assert.deepEqual(viewed.contacts.map((c) => c.name), ['Lieferant GmbH']);

  const overridden = must(
    call(deps, 'list_contacts', { workspaceId, savedViewId: viewId, partyRole: 'customer' }),
    'explicit filter over view',
  );
  assert.deepEqual(overridden.contacts.map((c) => c.name), ['Kundin AG']);
});

test('item: the stored query filter applies, and an explicit one wins', () => {
  const { deps, workspaceId } = workspace('item');
  must(
    call(deps, 'create_item', { workspaceId, name: 'Alpha Beratung', defaultUnitPriceMinor: 10000, idempotencyKey: 'svs-i1' }),
    'create_item Alpha',
  );
  must(
    call(deps, 'create_item', { workspaceId, name: 'Beta Support', defaultUnitPriceMinor: 20000, idempotencyKey: 'svs-i2' }),
    'create_item Beta',
  );
  const viewId = makeView(deps, workspaceId, 'item', { query: 'Alpha' }, 'item');

  const viewed = must(call(deps, 'list_items', { workspaceId, savedViewId: viewId }), 'list via view');
  assert.deepEqual(viewed.items.map((i) => i.name), ['Alpha Beratung']);

  const overridden = must(
    call(deps, 'list_items', { workspaceId, savedViewId: viewId, query: 'Beta' }),
    'explicit filter over view',
  );
  assert.deepEqual(overridden.items.map((i) => i.name), ['Beta Support']);
});

test('account: the stored search filter applies through the seeded chart', () => {
  const { deps, workspaceId } = workspace('account');
  const viewId = makeView(deps, workspaceId, 'account', { search: '1020' }, 'account');

  const viewed = must(call(deps, 'list_accounts', { workspaceId, savedViewId: viewId }), 'list via view');
  assert.ok(viewed.accounts.length > 0, 'the seeded chart carries 1020');
  for (const account of viewed.accounts) {
    assert.ok(
      account.number.includes('1020') || account.name.includes('1020'),
      `the view's search leaked a non-matching account: ${account.number} ${account.name}`,
    );
  }
});

test('cost_center: a view storing includeArchived reveals what the bare list hides', () => {
  const { deps, workspaceId } = workspace('cc');
  const minted = must(
    call(deps, 'create_cost_center', { workspaceId, code: 'KST1', name: 'Werkstatt', idempotencyKey: 'svs-cc1' }),
    'create_cost_center',
  );
  must(
    call(deps, 'archive_cost_center', { workspaceId, costCenterId: minted.costCenterId }),
    'archive_cost_center',
  );
  const viewId = makeView(deps, workspaceId, 'cost_center', { includeArchived: true }, 'cc');

  const bare = must(call(deps, 'list_cost_centers', { workspaceId }), 'bare list');
  assert.deepEqual(bare.costCenters, [], 'an archived cost centre must not appear bare');

  const viewed = must(call(deps, 'list_cost_centers', { workspaceId, savedViewId: viewId }), 'list via view');
  assert.deepEqual(viewed.costCenters.map((c) => c.code), ['KST1']);
});

test('workspace: a roster view storing includeArchived reveals the archived mandate the bare list hides', () => {
  const { deps, workspaceId } = workspace('ws-roster');
  const retired = must(
    call(deps, 'onboard_client', { name: 'Altes Mandat AG', idempotencyKey: 'svs-ws1' }),
    'onboard_client',
  );
  must(
    call(deps, 'archive_workspace', { workspaceId: retired.workspaceId, archived: true, idempotencyKey: 'svs-ws2' }),
    'archive_workspace',
  );
  const viewId = makeView(deps, workspaceId, 'workspace', { includeArchived: true }, 'ws');

  const bare = must(call(deps, 'list_workspaces', {}), 'bare roster');
  assert.ok(
    !bare.workspaces.some((w) => w.workspaceId === retired.workspaceId),
    'an archived mandate must not appear on the bare roster',
  );

  const viewed = must(
    call(deps, 'list_workspaces', { savedViewWorkspaceId: workspaceId, savedViewId: viewId }),
    'roster via view',
  );
  assert.ok(
    viewed.workspaces.some((w) => w.workspaceId === retired.workspaceId && w.archived === true),
    'the stored includeArchived filter did not apply through the seam',
  );

  // An explicit filter still wins over the stored one (the applySavedView merge contract).
  const overridden = must(
    call(deps, 'list_workspaces', { savedViewWorkspaceId: workspaceId, savedViewId: viewId, includeArchived: false }),
    'roster via view, overridden',
  );
  assert.ok(!overridden.workspaces.some((w) => w.workspaceId === retired.workspaceId));
});

test('bank_account: a view storing includeArchived reveals what the bare list hides', () => {
  const { deps, workspaceId } = workspace('bank');
  const accounts = must(call(deps, 'list_accounts', { workspaceId, search: '1020' }), 'find 1020');
  const ledgerAccountId = accounts.accounts[0].id;
  const minted = must(
    call(deps, 'create_bank_account', {
      workspaceId,
      name: 'Altes Konto',
      iban: 'CH9300762011623852957',
      ledgerAccountId,
      idempotencyKey: 'svs-b1',
    }),
    'create_bank_account',
  );
  must(
    call(deps, 'archive_bank_account', { workspaceId, bankAccountId: minted.bankAccountId, idempotencyKey: 'svs-b2' }),
    'archive_bank_account',
  );
  const viewId = makeView(deps, workspaceId, 'bank_account', { includeArchived: true }, 'bank');

  const bare = must(call(deps, 'list_bank_accounts', { workspaceId }), 'bare list');
  assert.deepEqual(bare.bankAccounts, [], 'an archived Bankkonto must not appear bare');

  const viewed = must(call(deps, 'list_bank_accounts', { workspaceId, savedViewId: viewId }), 'list via view');
  assert.deepEqual(viewed.bankAccounts.map((b) => b.name), ['Altes Konto']);
});

test('journal_entry: the stored status filter applies, and an explicit one wins', () => {
  const { deps, workspaceId } = workspace('journal');
  const accounts = must(call(deps, 'list_accounts', { workspaceId }), 'list accounts').accounts;
  const kasse = accounts.find((a) => a.number === '1000');
  const aufwand = accounts.find((a) => a.number === '6500');
  assert.ok(kasse !== undefined && aufwand !== undefined, 'the seeded chart carries 1000 and 6500');
  const lines = [
    { account: aufwand.accountId ?? aufwand.id, debit: 5000 },
    { account: kasse.accountId ?? kasse.id, credit: 5000 },
  ];
  must(
    call(deps, 'post_entry', {
      workspaceId,
      date: '2026-03-01',
      lines,
      source: 'manual',
      description: 'Bar',
      idempotencyKey: 'svs-j1',
    }),
    'post_entry',
  );
  must(
    call(deps, 'save_draft', { workspaceId, date: '2026-03-02', lines, description: 'Entwurf', idempotencyKey: 'svs-j2' }),
    'save_draft',
  );
  const viewId = makeView(deps, workspaceId, 'journal_entry', { status: 'draft' }, 'journal');

  const viewed = must(call(deps, 'list_journal', { workspaceId, savedViewId: viewId }), 'list via view');
  assert.deepEqual(viewed.entries.map((e) => e.status), ['draft']);

  const overridden = must(
    call(deps, 'list_journal', { workspaceId, savedViewId: viewId, status: 'posted' }),
    'explicit filter over view',
  );
  assert.deepEqual(overridden.entries.map((e) => e.status), ['posted']);
});
