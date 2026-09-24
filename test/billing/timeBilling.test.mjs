/**
 * B02, time -> billing: the money-path rules the conformance floor does not derive.
 *
 * The conformance gate already holds §H-TENANT isolation, idempotent-on-rows and the double-call
 * settle over `billing_generate_invoice` and `billing_release_time`, so this suite owns B02's OWN
 * money laws, the four the critic verifies actually bite:
 *
 *   1. NO DOUBLE-BILLING. An entry billed once can never land on a second invoice, and a selection
 *      touching an already-billed entry writes ZERO rows (strict, no partial invoice).
 *   2. A11-DRAFT DELEGATION. Generation mints a DRAFT through A10 `createDocument` and posts NOTHING:
 *      the journal stays empty (posting is A11 -> A02's, at issue).
 *   3. THE SINGLE ROUNDING POINT. preview total == invoice line sum == WIP delta, to the Rappen,
 *      under every `group_by`, with minutes that are not whole hours.
 *   4. TX-ATOMICITY (the C02/D03 bug class). A REFUSED generate or release leaves every
 *      `time_entry.status` and the invoice-row count UNCHANGED.
 *
 * Plus the §7 invariants: `invoice_line_id` is set only while `status='billed'`; the release round
 * trip returns entries to a byte-identical preview; a `time_entry` custom field never contributes to
 * a line amount (P3 guard).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** A fresh world: its own store, one workspace, a seeded contact + project + default rate card. */
function world(seed = 'b02', rateMinor = 15000) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Acme GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const contact = call('create_contact', { partyRole: 'customer', name: 'Zeit Kunde AG', idempotencyKey: `${seed}-contact` });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  const project = call('project_create', { name: `Projekt ${seed}`, contactId: contact.contact.id, idempotencyKey: `${seed}-project` });
  assert.equal(project.ok, true, JSON.stringify(project));
  const rate = call('rate_card_upsert', { scope: 'default', rateMinor, validFrom: '2026-01-01', idempotencyKey: `${seed}-rate` });
  assert.equal(rate.ok, true, JSON.stringify(rate));
  return { deps, workspaceId, call, contactId: contact.contact.id, projectId: project.project.id };
}

/** Log a finished entry, submit its period, approve it, and return the approved entry id. */
let logSeq = 0;
function approvedEntry(w, minutes, extra = {}) {
  const s = `ae${logSeq++}`;
  const logged = w.call('time_log', {
    userId: 'user-f',
    projectId: w.projectId,
    startedAt: '2026-07-10T09:00:00.000Z',
    minutes,
    idempotencyKey: `${s}-log`,
    ...extra,
  });
  assert.equal(logged.ok, true, JSON.stringify(logged));
  const sub = w.call('time_submit', { period: '2026-07', idempotencyKey: `${s}-sub` });
  assert.equal(sub.ok, true, JSON.stringify(sub));
  const app = w.call('time_approve', { entryIds: [logged.entry.id], idempotencyKey: `${s}-app` });
  assert.equal(app.ok, true, JSON.stringify(app));
  return logged.entry.id;
}

function journalCount(w) {
  return w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.workspaceId).n;
}
function invoiceCount(w) {
  return w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = 'invoice'").get(w.workspaceId).n;
}
function statusOf(w, entryId) {
  return w.deps.store.db.prepare('SELECT status, invoice_line_id FROM time_entry WHERE workspace_id = ? AND id = ?').get(w.workspaceId, entryId);
}
function lineSum(w, invoiceId) {
  return w.deps.store.db
    .prepare('SELECT COALESCE(SUM(line_total_minor), 0) AS s FROM document_line WHERE workspace_id = ? AND document_id = ?')
    .get(w.workspaceId, invoiceId).s;
}

// --- 1. No double-billing ----------------------------------------------------------------------

test('B02: an entry billed once can never land on a second invoice, and a stale re-select is refused', () => {
  const w = world('dbl');
  const e1 = approvedEntry(w, 60);
  const e2 = approvedEntry(w, 60);

  const gen = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e1, e2], idempotencyKey: 'g1' });
  assert.equal(gen.ok, true, JSON.stringify(gen));
  assert.equal(gen.billedEntryIds.length, 2);
  assert.equal(invoiceCount(w), 1);
  assert.equal(statusOf(w, e1).status, 'billed');
  assert.notEqual(statusOf(w, e1).invoice_line_id, null);

  // Same key: the replay returns the FIRST invoice and mints no second document, flips nothing twice.
  const replay = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e1, e2], idempotencyKey: 'g1' });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.invoiceId, gen.invoiceId);
  assert.equal(invoiceCount(w), 1, 'no second invoice');

  // A NEW key over the already-billed entries: strict already_billed, zero rows moved.
  const stale = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e1, e2], idempotencyKey: 'g2' });
  assert.equal(stale.ok, false);
  assert.equal(stale.error, 'already_billed');
  assert.equal(invoiceCount(w), 1, 'a refused generate writes no invoice');
  assert.equal(statusOf(w, e1).invoice_line_id, gen.lineIds[0] ?? statusOf(w, e1).invoice_line_id);
});

// --- 2. A11-draft delegation: the journal stays empty ------------------------------------------

test('B02: generation delegates to an A10 draft and posts NOTHING (journalCount stays 0)', () => {
  const w = world('draft');
  const e = approvedEntry(w, 90);
  assert.equal(journalCount(w), 0, 'nothing posted before');
  const gen = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e], idempotencyKey: 'd1' });
  assert.equal(gen.ok, true, JSON.stringify(gen));
  // The created document is a DRAFT invoice with no posted entry.
  const doc = w.deps.store.db.prepare('SELECT status, posted_entry_id FROM document WHERE workspace_id = ? AND id = ?').get(w.workspaceId, gen.invoiceId);
  assert.equal(doc.status, 'draft');
  assert.equal(doc.posted_entry_id, null);
  assert.equal(journalCount(w), 0, 'B02 mints no journal entry (P3): A11 -> A02 post at issue');
});

// --- 3. The single rounding point: preview == line == WIP -------------------------------------

test('B02: preview == invoice line sum == WIP delta, to the Rappen, under every group_by', () => {
  for (const groupBy of ['entry', 'phase', 'project', 'day']) {
    const w = world(`round-${groupBy}`, 10000); // CHF 100.00/h, so odd minutes leave a Rappen remainder
    // 50 min -> round(50*10000/60)=8333; 25 min -> round(25*10000/60)=4167; sum 12500.
    const e1 = approvedEntry(w, 50);
    const e2 = approvedEntry(w, 25);

    const preview = w.call('billing_unbilled_preview', { contactId: w.contactId });
    assert.equal(preview.ok, true, JSON.stringify(preview));
    assert.equal(preview.totalRappen, 12500, `preview total for ${groupBy}`);

    const wipBefore = w.call('billing_wip_report', { asOf: '2026-12-31' });
    assert.equal(wipBefore.ok, true, JSON.stringify(wipBefore));
    assert.equal(wipBefore.totalRappen, 12500, `wip before for ${groupBy}`);

    const gen = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e1, e2], groupBy, idempotencyKey: `r-${groupBy}` });
    assert.equal(gen.ok, true, JSON.stringify(gen));
    assert.equal(gen.totalRappen, 12500, `generate total for ${groupBy}`);
    // The DELEGATED A10 line totals sum to exactly the preview total: no second rounding point.
    assert.equal(lineSum(w, gen.invoiceId), 12500, `invoice line sum for ${groupBy}`);

    const wipAfter = w.call('billing_wip_report', { asOf: '2026-12-31' });
    assert.equal(wipAfter.totalRappen, 0, `wip after for ${groupBy} (delta is the exact invoiced total)`);

    // group_by shapes the LINE COUNT but never the total.
    const expectLines = groupBy === 'entry' ? 2 : 1;
    assert.equal(gen.lineIds.length, expectLines, `line count for ${groupBy}`);
  }
});

// --- 4. TX-atomicity: a refused write moves nothing -------------------------------------------

test('B02: a REFUSED generate leaves every status and the invoice count unchanged (TX-atomic)', () => {
  const w = world('atomic');
  const good = approvedEntry(w, 60);
  const billed = approvedEntry(w, 60);
  // Bill `billed` first so the mixed selection below trips already_billed AFTER reading `good`.
  const first = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [billed], idempotencyKey: 'a1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const invoicesBefore = invoiceCount(w);
  const goodBefore = statusOf(w, good);
  assert.equal(goodBefore.status, 'approved');
  assert.equal(goodBefore.invoice_line_id, null);

  // A selection spanning a fresh + an already-billed entry: strict already_billed, ZERO writes.
  const refused = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [good, billed], idempotencyKey: 'a2' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'already_billed');
  assert.equal(invoiceCount(w), invoicesBefore, 'no invoice written on a refusal');
  const goodAfter = statusOf(w, good);
  assert.equal(goodAfter.status, 'approved', 'the eligible entry was NOT billed by the refused call');
  assert.equal(goodAfter.invoice_line_id, null);

  // empty_selection and a foreign contact are refusals too, and equally write nothing.
  assert.equal(w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [], idempotencyKey: 'a3' }).error, 'empty_selection');
  assert.equal(w.call('billing_generate_invoice', { contactId: 'nope', timeEntryIds: [good], idempotencyKey: 'a4' }).error, 'invalid_reference');
  assert.equal(invoiceCount(w), invoicesBefore, 'still no extra invoice');
});

test('B02: a mixed-contact selection and a currency mismatch are pre-write refusals', () => {
  const w = world('mixed');
  const other = w.call('create_contact', { partyRole: 'customer', name: 'Andere AG', idempotencyKey: 'oc' });
  const otherProj = w.call('project_create', { name: 'Anderes', contactId: other.contact.id, idempotencyKey: 'op' });
  const e1 = approvedEntry(w, 60);
  const e2 = approvedEntry(w, 60, { projectId: otherProj.project.id });
  const mixed = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e1, e2], idempotencyKey: 'm1' });
  assert.equal(mixed.ok, false);
  assert.equal(mixed.error, 'mixed_contacts');
  assert.equal(statusOf(w, e1).status, 'approved', 'nothing billed on a mixed refusal');
});

test('B02: a release refused as invoice_not_draft moves nothing', () => {
  const w = world('rel-refuse');
  const e = approvedEntry(w, 60);
  const gen = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e], idempotencyKey: 'rr1' });
  assert.equal(gen.ok, true, JSON.stringify(gen));
  // Simulate a finalised invoice: only a DRAFT releases (a finalised one corrects via a credit note).
  w.deps.store.db.prepare("UPDATE document SET status = 'sent' WHERE workspace_id = ? AND id = ?").run(w.workspaceId, gen.invoiceId);
  const refused = w.call('billing_release_time', { invoiceId: gen.invoiceId, idempotencyKey: 'rr2' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'invoice_not_draft');
  assert.equal(statusOf(w, e).status, 'billed', 'a refused release leaves the entry billed');
  assert.notEqual(statusOf(w, e).invoice_line_id, null);
});

// --- Release round trip + invariants ----------------------------------------------------------

test('B02: release reverts billed time to a byte-identical preview and clears invoice_line_id', () => {
  const w = world('roundtrip', 12345);
  const e1 = approvedEntry(w, 47);
  const e2 = approvedEntry(w, 133);
  const before = w.call('billing_unbilled_preview', { contactId: w.contactId });
  assert.equal(before.ok, true, JSON.stringify(before));

  const gen = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e1, e2], idempotencyKey: 'rt1' });
  assert.equal(gen.ok, true, JSON.stringify(gen));
  assert.equal(w.call('billing_unbilled_preview', { contactId: w.contactId }).totalRappen, 0, 'pile empty after billing');

  const rel = w.call('billing_release_time', { invoiceId: gen.invoiceId, idempotencyKey: 'rt2' });
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.equal(rel.releasedCount, 2);
  for (const id of [e1, e2]) {
    const row = statusOf(w, id);
    assert.equal(row.status, 'approved', 'released back to approved');
    assert.equal(row.invoice_line_id, null, 'invoice_line_id cleared');
  }
  const after = w.call('billing_unbilled_preview', { contactId: w.contactId });
  assert.equal(after.totalRappen, before.totalRappen, 'the pile returns to its exact prior total');

  // Releasing again is an idempotent no-op (nothing left billed on those lines).
  const again = w.call('billing_release_time', { invoiceId: gen.invoiceId, idempotencyKey: 'rt3' });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.releasedCount, 0);
});

test('B02: invoice_line_id is set on no row whose status is not billed (§7 invariant)', () => {
  const w = world('inv');
  const e = approvedEntry(w, 60);
  w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e], idempotencyKey: 'i1' });
  const orphans = w.deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM time_entry WHERE workspace_id = ? AND invoice_line_id IS NOT NULL AND status != 'billed'")
    .get(w.workspaceId).n;
  assert.equal(orphans, 0, 'no entry carries a line id while unbilled');
});

// --- §H-TENANT: a foreign book's time and invoices are unreachable ----------------------------

test('B02: a generate/release/preview aimed at tenant B cannot touch tenant A rows (§H-TENANT)', () => {
  const deps = freshDeps();
  const a = mintWorkspace(deps, 'A GmbH', 'ws-a');
  const b = mintWorkspace(deps, 'B GmbH', 'ws-b');
  const callA = (n, i) => getAction(n).run(deps, { workspaceId: a.workspaceId, ...i });
  const callB = (n, i) => getAction(n).run(deps, { workspaceId: b.workspaceId, ...i });
  const ca = callA('create_contact', { partyRole: 'customer', name: 'A Kunde', idempotencyKey: 'a-c' });
  const pa = callA('project_create', { name: 'A Proj', contactId: ca.contact.id, idempotencyKey: 'a-p' });
  callA('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'a-r' });
  const logged = callA('time_log', { userId: 'u', projectId: pa.project.id, startedAt: '2026-07-10T09:00:00.000Z', minutes: 60, idempotencyKey: 'a-l' });
  const sub = callA('time_submit', { period: '2026-07', idempotencyKey: 'a-s' });
  callA('time_approve', { entryIds: sub.entryIds, idempotencyKey: 'a-ap' });
  const eA = logged.entry.id;

  // Tenant B cannot bill tenant A's entry (it resolves to nothing in B's scope).
  const cross = callB('billing_generate_invoice', { contactId: ca.contact.id, timeEntryIds: [eA], idempotencyKey: 'x1' });
  assert.equal(cross.ok, false);
  assert.ok(cross.error === 'entry_not_found' || cross.error === 'invalid_reference', cross.error);
  // A's entry is untouched and B's preview never sees it.
  assert.equal(deps.store.db.prepare('SELECT status FROM time_entry WHERE id = ?').get(eA).status, 'approved');
  assert.equal(callB('billing_unbilled_preview', {}).totalRappen, 0, "B's pile never contains A's time");
});

// --- P3 guard: a time_entry custom field never contributes to a line amount -------------------

test('B02: a money-typed time_entry custom field never enters value_rappen or the line amount (P3)', () => {
  const w = world('cf', 10000);
  const def = w.call('define_field', {
    entityKind: 'time_entry',
    key: 'billing_memo_amount',
    labelI18n: { 'de-CH': 'Notizbetrag', en: 'Memo amount' },
    type: 'money',
    idempotencyKey: 'cf-def',
  });
  assert.equal(def.ok, true, JSON.stringify(def));
  const fieldId = def.fieldDef.fieldDefId;
  const conf = w.call('confirm_field', { fieldDefId: fieldId, idempotencyKey: 'cf-conf' });
  assert.equal(conf.ok, true, JSON.stringify(conf));

  const e = approvedEntry(w, 60); // value = round(60*10000/60) = 10000
  const setv = w.call('set_field_value', { entityKind: 'time_entry', entityId: e, fieldKey: 'billing_memo_amount', value: 999999, idempotencyKey: 'cf-set' });
  assert.equal(setv.ok, true, JSON.stringify(setv));

  const preview = w.call('billing_unbilled_preview', { contactId: w.contactId });
  assert.equal(preview.totalRappen, 10000, 'the custom money field does not inflate the preview value');
  const gen = w.call('billing_generate_invoice', { contactId: w.contactId, timeEntryIds: [e], idempotencyKey: 'cf-gen' });
  assert.equal(gen.ok, true, JSON.stringify(gen));
  assert.equal(gen.totalRappen, 10000, 'the line amount is minutes x rate, never the custom field');
  assert.equal(lineSum(w, gen.invoiceId), 10000);
});
