/**
 * B04, retainers & mandates: the money-path laws the conformance floor does not derive.
 *
 * The conformance gate already holds §H-TENANT rejection, idempotent-on-rows and the double-call
 * settle over the five write verbs. This suite owns B04's OWN money laws, the ones the critic verifies
 * actually BITE:
 *
 *   1. NO DOUBLE-INVOICE ON A PERIOD. `run_due` (and `generate_invoice`) twice yields exactly ONE
 *      invoice and ONE fee draw for a period, whatever key or cadence the caller uses.
 *   2. NO DOUBLE-BILLING OF TIME. A consumed entry flips to `billed`; B02's approved-eligibility then
 *      excludes it, so it can never land on a second invoice.
 *   3. DRAWDOWN / CAP INTEGRITY. Coverage is a minute budget capped by a value ceiling; the boundary
 *      entry splits at the exact minute; over-cap minutes become overage lines priced round-once (P2);
 *      the arithmetic is integer Rappen and cannot go inconsistent.
 *   4. ROLLOVER CONSERVATION. Σ(carryover_in) == Σ(carryover_out), tracked in minutes, no drift.
 *   5. A11-DRAFT DELEGATION. Generation mints a DRAFT through A10 `createDocument` and posts NOTHING:
 *      the journal stays empty (journalCount == 0; posting is A11 -> A02's, at issue).
 *   6. §H-TENANT. A foreign retainer id resolves to nothing on every verb.
 *   7. TX-ATOMICITY (the C02/D03 bug class). A REFUSED generate leaves the draw ledger, the invoice
 *      count and every `time_entry.status` UNCHANGED (zero rows written).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { entryValueMinor } from '../../dist/core/time/index.js';

/** A fresh world: its own store, one workspace, a seeded contact + project + default rate card. */
function world(seed = 'b04', rateMinor = 15000) {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps, 'Mandat GmbH', `${seed}-ws`);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const contact = call('create_contact', { partyRole: 'customer', name: 'Mandat Kunde AG', idempotencyKey: `${seed}-contact` });
  assert.equal(contact.ok, true, JSON.stringify(contact));
  const project = call('project_create', { name: `Projekt ${seed}`, contactId: contact.contact.id, idempotencyKey: `${seed}-project` });
  assert.equal(project.ok, true, JSON.stringify(project));
  const rate = call('rate_card_upsert', { scope: 'default', rateMinor, validFrom: '2026-01-01', idempotencyKey: `${seed}-rate` });
  assert.equal(rate.ok, true, JSON.stringify(rate));
  return { deps, workspaceId, call, contactId: contact.contact.id, projectId: project.project.id };
}

/** Log a finished entry in a given month, submit that period, approve it, return the entry id. */
let logSeq = 0;
function approvedEntry(w, minutes, day = '2026-06-10', period = '2026-06') {
  const s = `re${logSeq++}`;
  const logged = w.call('time_log', { userId: 'user-f', projectId: w.projectId, startedAt: `${day}T09:00:00.000Z`, minutes, idempotencyKey: `${s}-log` });
  assert.equal(logged.ok, true, JSON.stringify(logged));
  const sub = w.call('time_submit', { period, idempotencyKey: `${s}-sub` });
  assert.equal(sub.ok, true, JSON.stringify(sub));
  const app = w.call('time_approve', { entryIds: [logged.entry.id], idempotencyKey: `${s}-app` });
  assert.equal(app.ok, true, JSON.stringify(app));
  return logged.entry.id;
}

let retSeq = 0;
function makeRetainer(w, extra = {}) {
  const s = `rc${retSeq++}`;
  const res = w.call('retainer_create', {
    contactId: w.contactId,
    projectId: w.projectId,
    period: 'monthly',
    feeRappen: 250000,
    includedHours: 1,
    rollover: false,
    startsOn: '2026-06-01',
    idempotencyKey: `${s}-ret`,
    ...extra,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.retainer.id;
}

const journalCount = (w) => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.workspaceId).n;
const invoiceCount = (w) => w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = 'invoice'").get(w.workspaceId).n;
const drawCount = (w) => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM retainer_draws WHERE workspace_id = ?').get(w.workspaceId).n;
const feeDrawCount = (w, retainerId, periodKey) =>
  w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND period_key = ? AND kind = 'fee'").get(w.workspaceId, retainerId, periodKey).n;
const entryStatus = (w, id) => w.deps.store.db.prepare('SELECT status, invoice_line_id FROM time_entry WHERE workspace_id = ? AND id = ?').get(w.workspaceId, id);
const docLineCount = (w, invoiceId) => w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM document_line WHERE workspace_id = ? AND document_id = ?').get(w.workspaceId, invoiceId).n;

// --- 1. NO DOUBLE-INVOICE -----------------------------------------------------------------------

test('B04: generate twice for one period yields ONE invoice and ONE fee draw (idempotent per period)', () => {
  const w = world('dup');
  const r = makeRetainer(w);
  const first = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'g1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.existing, false);
  assert.equal(invoiceCount(w), 1);
  assert.equal(feeDrawCount(w, r, '2026-06'), 1);

  // Same key: rememberIdempotent replays the first result, writes nothing.
  const replay = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'g1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.invoiceId, first.invoiceId);
  // A DIFFERENT key still hits the fee-draw guard and returns the existing invoice, no new write.
  const again = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'g2' });
  assert.equal(again.ok, true);
  assert.equal(again.existing, true);
  assert.equal(again.invoiceId, first.invoiceId);
  assert.equal(invoiceCount(w), 1, 'a second generate must not mint a second invoice');
  assert.equal(feeDrawCount(w, r, '2026-06'), 1, 'exactly one fee draw for the period');
});

test('B04: run_due twice bills each period exactly once', () => {
  const w = world('rundue');
  const r = makeRetainer(w);
  approvedEntry(w, 60);
  const first = w.call('retainer_run_due', { asOf: '2026-07-16' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.generated.length, 1);
  assert.equal(invoiceCount(w), 1);
  const second = w.call('retainer_run_due', { asOf: '2026-07-16' });
  assert.equal(second.ok, true);
  assert.equal(second.generated.length, 0, 'a second tick generates nothing');
  assert.equal(invoiceCount(w), 1, 'run_due is idempotent per period via the fee-draw guard');
  assert.equal(feeDrawCount(w, r, '2026-06'), 1);
});

// --- 2/3. DRAWDOWN, CAP AND OVERAGE -------------------------------------------------------------

test('B04: coverage draws down included hours; over-cap becomes an overage line (round-once, P2)', () => {
  const w = world('overage', 15000); // CHF 150/h
  const r = makeRetainer(w, { includedHours: 1, capRappen: null });
  const entry = approvedEntry(w, 120); // 2h: 1h covered by the fee, 1h overage
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'o1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.overCapMinutes, 60, '60 minutes over the 1h coverage');
  assert.equal(res.overageValueRappen, entryValueMinor(60, 15000), 'overage priced round-once from the entry rate');
  // Invoice: one Pauschale line + one Zusatzaufwand line.
  assert.equal(docLineCount(w, res.invoiceId), 2);
  // The entry is billed exactly once, pointing at its overage line (not NULL).
  const st = entryStatus(w, entry);
  assert.equal(st.status, 'billed');
  assert.notEqual(st.invoice_line_id, null);
  // Draw ledger: fee + covered(time,NULL) + overage(time,line).
  const drawsForEntry = w.deps.store.db
    .prepare("SELECT kind, minutes, invoice_line_id FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND kind = 'time' ORDER BY minutes")
    .all(w.workspaceId, r);
  assert.equal(drawsForEntry.length, 2, 'covered and overage portions are two draw rows');
  const covered = drawsForEntry.find((d) => d.invoice_line_id === null);
  const overage = drawsForEntry.find((d) => d.invoice_line_id !== null);
  assert.equal(covered.minutes, 60);
  assert.equal(overage.minutes, 60);
});

test('B04: the VALUE cap truncates coverage before the minute budget does, split at the exact minute', () => {
  const w = world('cap', 15000); // CHF 2.50/min
  // Included 10h (600min minute budget, not binding) but cap 10000 Rappen (CHF 100).
  const r = makeRetainer(w, { includedHours: 10, capRappen: 10000 });
  approvedEntry(w, 120);
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'c1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  // entryValueMinor(k,15000) = round(k*250). Largest k with round(k*250) <= 10000 is 40.
  const burn = w.call('retainer_burndown', { retainerId: r, periodKey: '2026-06' });
  assert.equal(burn.coveredMinutes, 40, 'the value cap caps covered minutes at 40, not the 600 minute budget');
  assert.equal(burn.overCapMinutes, 80);
  assert.equal(res.overageValueRappen, entryValueMinor(80, 15000));
  // Covered value never exceeds the cap.
  assert.ok(entryValueMinor(40, 15000) <= 10000);
});

// --- 4. ROLLOVER CONSERVATION -------------------------------------------------------------------

test('B04: rollover conserves unused minutes (Σ carryover_in == Σ carryover_out) and opens the next period', () => {
  const w = world('roll', 15000);
  const r = makeRetainer(w, { includedHours: 2, rollover: true }); // 120min coverage
  approvedEntry(w, 60); // 60 used, 60 unused
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'r1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.carriedOverMinutes, 60);
  const rows = w.deps.store.db
    .prepare("SELECT kind, period_key, minutes FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND kind LIKE 'carryover%'")
    .all(w.workspaceId, r);
  const out = rows.filter((x) => x.kind === 'carryover_out').reduce((a, x) => a + x.minutes, 0);
  const inn = rows.filter((x) => x.kind === 'carryover_in').reduce((a, x) => a + x.minutes, 0);
  // Σ conservation ALONE conserves the wrong amount if the basis is wrong. Pin the ABSOLUTE value to
  // truly-unused minutes: 120 coverage - 60 consumed = 60 unused (all 60 were covered, none overage).
  assert.equal(out, 60, 'carryover_out equals the truly-unused 60 minutes, not a wrong basis');
  assert.equal(inn, 60);
  assert.equal(out, inn, 'carryover conservation: nothing minted or lost');
  assert.equal(res.carriedOverMinutes, 60);
  // The next period's burn-down credits the carried-over minutes.
  const nextBurn = w.call('retainer_burndown', { retainerId: r, periodKey: '2026-07' });
  assert.equal(nextBurn.carryoverInMinutes, 60);
  assert.equal(nextBurn.coverageMinutes, 120 + 60);
});

test('B04: a binding VALUE cap does NOT roll cap-pushed minutes forward (billed as overage, carryover_out = 0)', () => {
  // The revenue-loss bug: includedHours 10 = 600-min budget, cap 75000 Rappen, rollover on, rate
  // 15000 Rappen/h (250 Rappen/min). One 600-min entry. The cap binds BELOW the minute budget:
  // entryValueMinor(300,15000) = 75000 exactly, so 300 min are covered and 300 min are pushed to
  // OVERAGE. Those 300 overage minutes consumed real time, so NOTHING is unused: the client is billed
  // the overage AND must not also get those minutes free next period.
  const w = world('caproll', 15000);
  const r = makeRetainer(w, { includedHours: 10, capRappen: 75000, rollover: true });
  approvedEntry(w, 600);
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'cr1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  // Overage IS billed: 300 min over the value cap, priced round-once from the entry rate.
  assert.equal(res.overCapMinutes, 300, '300 minutes pushed over the value cap');
  assert.equal(res.overageValueRappen, entryValueMinor(300, 15000), 'overage billed on the cap-pushed minutes');
  assert.equal(res.overageValueRappen, 75000);
  // And NOTHING rolls forward: all 600 budgeted minutes were consumed (300 covered + 300 overage).
  assert.equal(res.carriedOverMinutes, 0, 'no minutes carried when every budget minute was consumed');
  const carryOut = w.deps.store.db
    .prepare("SELECT COALESCE(SUM(minutes),0) AS m FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND period_key = ? AND kind = 'carryover_out'")
    .get(w.workspaceId, r, '2026-06').m;
  assert.equal(carryOut, 0, 'carryover_out for the period is 0: the client is not double-benefitted');
  // No carryover rows at all: the next period is not credited free minutes.
  const carryRows = w.deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND kind LIKE 'carryover%'")
    .get(w.workspaceId, r).n;
  assert.equal(carryRows, 0, 'no carryover_out/carryover_in rows minted');
  const nextBurn = w.call('retainer_burndown', { retainerId: r, periodKey: '2026-07' });
  assert.equal(nextBurn.carryoverInMinutes, 0, 'next period carries no free minutes forward');
});

test('B04: without rollover, unused minutes are forfeited (no carryover rows)', () => {
  const w = world('noroll', 15000);
  const r = makeRetainer(w, { includedHours: 2, rollover: false });
  approvedEntry(w, 60);
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'nr1' });
  assert.equal(res.ok, true);
  assert.equal(res.carriedOverMinutes, 0);
  const carry = w.deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM retainer_draws WHERE workspace_id = ? AND retainer_id = ? AND kind LIKE 'carryover%'")
    .get(w.workspaceId, r).n;
  assert.equal(carry, 0);
});

// --- 5. A11-DRAFT DELEGATION (posts nothing) ----------------------------------------------------

test('B04: generation posts NOTHING (journal stays empty); the invoice is an A10 draft', () => {
  const w = world('draft');
  const r = makeRetainer(w);
  approvedEntry(w, 90);
  assert.equal(journalCount(w), 0);
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'd1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(journalCount(w), 0, 'B04 mints no journal entry (P3): posting is A11 -> A02, at issue');
  const doc = w.deps.store.db.prepare('SELECT type, status FROM document WHERE workspace_id = ? AND id = ?').get(w.workspaceId, res.invoiceId);
  assert.equal(doc.type, 'invoice');
  assert.equal(doc.status, 'draft', 'generation always stops at a draft (P8)');
});

test('B04: an empty period still bills the full fee (availability, OR 394 ff.)', () => {
  const w = world('empty');
  const r = makeRetainer(w, { includedHours: 5, feeRappen: 300000 });
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'e1' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.feeRappen, 300000);
  assert.equal(res.overCapMinutes, 0);
  assert.equal(docLineCount(w, res.invoiceId), 1, 'just the Pauschale line');
});

// --- 6. §H-TENANT -------------------------------------------------------------------------------

test('B04: a foreign retainer id resolves to nothing on every verb (§H-TENANT)', () => {
  const a = world('tenA');
  const b = world('tenB');
  const r = makeRetainer(a);
  // b cannot see, generate, close or burn-down a's retainer.
  assert.equal(b.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'x1' }).error, 'retainer_not_found');
  assert.equal(b.call('retainer_close', { retainerId: r, idempotencyKey: 'x2' }).error, 'retainer_not_found');
  assert.equal(b.call('retainer_burndown', { retainerId: r }).error, 'retainer_not_found');
  assert.equal(b.call('retainer_update', { retainerId: r, patch: { feeRappen: 1 }, idempotencyKey: 'x3' }).error, 'retainer_not_found');
  // b's list never contains a's retainer.
  const list = b.call('retainer_list', {});
  assert.equal(list.ok, true);
  assert.equal(list.retainers.find((x) => x.id === r), undefined);
});

// --- 7. TX-ATOMICITY: a refused generate writes ZERO rows ---------------------------------------

test('B04: a REFUSED generate (period not closed) writes ZERO rows and creates no invoice', () => {
  const w = world('atom1');
  const r = makeRetainer(w);
  approvedEntry(w, 60, '2026-07-10', '2026-07');
  const before = { draws: drawCount(w), invoices: invoiceCount(w) };
  // Period 2026-07 has NOT ended at the pinned clock (2026-07-16).
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-07', idempotencyKey: 'a1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_not_closed');
  assert.equal(drawCount(w), before.draws, 'no draw rows written on a refusal');
  assert.equal(invoiceCount(w), before.invoices, 'no invoice created on a refusal');
});

test('B04: a REFUSED generate (currency mismatch) writes ZERO rows and does not flip any entry', () => {
  const w = world('atom2');
  const r = makeRetainer(w, { currency: 'EUR' }); // retainer in EUR, time priced in CHF
  const entry = approvedEntry(w, 90);
  const before = { draws: drawCount(w), invoices: invoiceCount(w) };
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'a2' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'currency_mismatch');
  assert.equal(drawCount(w), before.draws);
  assert.equal(invoiceCount(w), before.invoices);
  assert.equal(entryStatus(w, entry).status, 'approved', 'the entry is untouched, not flipped to billed');
});

test('B04: generate on an ended retainer is refused and writes nothing', () => {
  const w = world('atom3');
  const r = makeRetainer(w, { startsOn: '2026-07-01' }); // no ended period -> close succeeds
  const closed = w.call('retainer_close', { retainerId: r, idempotencyKey: 'cl1' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  const before = drawCount(w);
  const res = w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'a3' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'retainer_not_active');
  assert.equal(drawCount(w), before);
});

// --- create-time refusals and warnings ----------------------------------------------------------

test('B04: create refuses a non-positive fee and a negative included-hours (P9, never a 500)', () => {
  const w = world('valid');
  assert.equal(w.call('retainer_create', { contactId: w.contactId, period: 'monthly', feeRappen: 0, startsOn: '2026-06-01', idempotencyKey: 'v1' }).error, 'invalid_fee');
  assert.equal(w.call('retainer_create', { contactId: w.contactId, period: 'monthly', feeRappen: 1000, includedHours: -1, startsOn: '2026-06-01', idempotencyKey: 'v2' }).error, 'invalid_hours');
});

test('B04: create warns cap_below_included when the cap undercuts the included hours at the resolved rate', () => {
  const w = world('warn', 15000); // 10h included = 150000 Rappen of coverage value
  const res = w.call('retainer_create', {
    contactId: w.contactId,
    projectId: w.projectId,
    period: 'monthly',
    feeRappen: 250000,
    includedHours: 10,
    capRappen: 100000, // below 150000
    startsOn: '2026-06-01',
    idempotencyKey: 'w1',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.warning, 'cap_below_included');
});

// --- close: OR 404 terminability ----------------------------------------------------------------

test('B04: close refuses a pending unbilled period, but skipFinal always ends the mandate (OR 404)', () => {
  const w = world('close');
  const r = makeRetainer(w); // starts 2026-06-01, so 2026-06 has ended and is unbilled
  const refused = w.call('retainer_close', { retainerId: r, idempotencyKey: 'c1' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'period_pending');
  const forced = w.call('retainer_close', { retainerId: r, skipFinal: true, idempotencyKey: 'c2' });
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.equal(forced.retainer.status, 'ended');
});

test('B04: close succeeds once the pending period is generated', () => {
  const w = world('close2');
  const r = makeRetainer(w);
  w.call('retainer_generate_invoice', { retainerId: r, periodKey: '2026-06', idempotencyKey: 'cg1' });
  const closed = w.call('retainer_close', { retainerId: r, idempotencyKey: 'cc1' });
  assert.equal(closed.ok, true, JSON.stringify(closed));
  assert.equal(closed.retainer.status, 'ended');
});
