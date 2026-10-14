/**
 * The Kreditoren drawer's D152 defaults, held to the ENGINE (cognitive-load pass, B8).
 *
 * The drawer now SHOWS two values before the commit that it used to leave blank: the Fälligkeit (the
 * vendor's Zahlungsfrist from the bill date) and the MWST code (the account's default). Both are sent
 * as ordinary field values. This file proves that doing so changes nothing the engine stores:
 *
 *  1. `defaultDueDate` in `app/src/surfaces/Bills/model.ts` is the engine's own default, day for day:
 *     a bill recorded WITHOUT `dueDate` (develop's payload for a blank field) stores exactly the date
 *     the Studio function computes, across month ends, a leap day, a year end, no terms (null), zero
 *     terms ("due immediately") and, since D163 (04.10.2026), the workspace default Zahlungsfrist set
 *     in the Firmenprofil: unset, 0 and 20 days, each crossed with every vendor term and every date.
 *  2. A bill posted with the Studio's shown defaults (the Fälligkeit filled in, the code the account
 *     brings) stores and books exactly what develop's payload stored and booked for a person who left
 *     the Fälligkeit blank and picked the same code by hand: the same `vendor_bill` row and the same
 *     journal lines, column for column, minus the row's own identity.
 *
 * Synthetic by construction: invented vendors, amounts and dates, in a fresh in-memory workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createContact } from '../../dist/core/sales/index.js';
import { recordExpense } from '../../dist/core/purchase/index.js';
import { updateCompanyProfile, deriveDueDate } from '../../dist/core/setup/index.js';
import { setup, billRow } from './support.mjs';

const MODEL = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Bills/model.ts', import.meta.url))).href;
const { defaultDueDate, dueDateBasis } = await import(MODEL);

function vendorWithTerms(ctx, name, key, paymentTermsDays) {
  const created = createContact(ctx, {
    partyRole: 'vendor',
    name,
    idempotencyKey: key,
    ...(paymentTermsDays === undefined ? {} : { paymentTermsDays }),
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return created.contact.id;
}

/** The bill row without its own identity: what a second, equal bill must reproduce exactly. */
function comparableRow(store, workspaceId, id) {
  const { id: _id, idempotency_key: _key, entry_id: _entry, created_at: _created, posted_at: _posted, ...rest } =
    billRow(store, workspaceId, id);
  return rest;
}

/** The journal lines an entry booked, without their row and entry ids, in insertion order. */
function comparableLines(store, entryId) {
  return store.db
    .prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(entryId)
    .map(({ id: _id, entry_id: _entry, ...rest }) => rest);
}

const DATES = ['2026-01-31', '2026-02-28', '2028-02-28', '2028-02-29', '2026-03-29', '2026-10-25', '2026-12-15', '2026-12-31'];
const TERMS = [undefined, null, 0, 1, 10, 30, 45, 60, 90];
/** D163: the Firmenprofil's Standard-Zahlungsfrist: unset, "due immediately", and 20 days. */
const WORKSPACE_DEFAULTS = [null, 0, 20];

test('defaultDueDate is the engine default for a blank Fälligkeit, day for day, workspace default included', () => {
  const t = setup();
  const vendors = TERMS.map((terms, i) => [terms, vendorWithTerms(t.ctx, `Lieferant ${i}`, `v-${i}`, terms)]);
  let n = 0;
  for (const workspaceDefault of WORKSPACE_DEFAULTS) {
    assert.equal(updateCompanyProfile(t.ctx, { defaultPaymentTermsDays: workspaceDefault }).ok, true);
    for (const [terms, vendor] of vendors) {
      for (const billDate of DATES) {
        n += 1;
        // Develop's payload for a person who left Fällig blank: no `dueDate` key at all.
        const res = recordExpense(t.ctx, {
          vendorId: vendor,
          billDate,
          amountMinor: 10000 + n,
          amountIsGross: true,
          expenseAccountId: t.acc('6500'),
          idempotencyKey: `due-${n}`,
        });
        assert.equal(res.ok, true, JSON.stringify(res));
        const stored = billRow(t.store, t.workspaceId, res.vendorBillId).due_date;
        // An absent `paymentTermsDays` stores null (D163), which is what the vendor read then carries.
        const where = `terms ${String(terms)}, default ${String(workspaceDefault)}, bill date ${billDate}`;
        assert.equal(defaultDueDate(billDate, terms ?? null, workspaceDefault), stored, where);
        // And the Studio's rule order is the engine's: the same source, the same day count.
        const engine = deriveDueDate({ documentDate: billDate, contactTermsDays: terms ?? null, workspaceDefaultDays: workspaceDefault });
        assert.equal(engine.dueDate, stored, where);
        const basis = dueDateBasis(terms ?? null, workspaceDefault);
        assert.equal(basis.source, engine.source, where);
        assert.equal(basis.days, engine.days, where);
      }
    }
  }
  assert.equal(n, WORKSPACE_DEFAULTS.length * TERMS.length * DATES.length);
});

test('D163 spot checks: null takes the default, 0 does not, own terms win', () => {
  assert.equal(defaultDueDate('2026-01-31', null, 20), '2026-02-20');
  assert.equal(defaultDueDate('2026-01-31', 0, 20), '2026-01-31');
  assert.equal(defaultDueDate('2026-01-31', 30, 20), '2026-03-02');
  assert.equal(defaultDueDate('2026-01-31', null, null), '2026-01-31');
  assert.equal(defaultDueDate('2026-01-31', null), '2026-01-31');
});

test('critic M1: a legacy out-of-range vendor term falls through to the default in the Studio as in the engine', () => {
  for (const legacy of [366, 3_000_000, 100_000_000]) {
    for (const workspaceDefault of [null, 20]) {
      const engine = deriveDueDate({ documentDate: '2026-01-31', contactTermsDays: legacy, workspaceDefaultDays: workspaceDefault });
      assert.equal(defaultDueDate('2026-01-31', legacy, workspaceDefault), engine.dueDate);
      assert.equal(dueDateBasis(legacy, workspaceDefault).source, engine.source);
    }
  }
  assert.equal(defaultDueDate('2026-01-31', 3_000_000, 20), '2026-02-20');
  assert.equal(defaultDueDate('2026-01-31', 365, 20), '2027-01-31');
});

test('the shown defaults post EXACTLY what develop posted for a blank Fälligkeit and a hand-picked code', () => {
  const t = setup();
  const vendor = vendorWithTerms(t.ctx, 'Lieferant GmbH', 'v1', 30);
  const billDate = '2026-01-31';
  const base = {
    vendorId: vendor,
    billDate,
    vendorReference: 'R-1',
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: t.acc('6500'),
  };

  // Develop: Fällig left blank, the code picked by hand.
  const develop = recordExpense(t.ctx, { ...base, idempotencyKey: 'develop' });
  assert.equal(develop.ok, true, JSON.stringify(develop));
  // This branch: the Fälligkeit the drawer showed is sent, and the code the account brought.
  const shown = recordExpense(t.ctx, {
    ...base,
    vendorReference: 'R-1',
    dueDate: defaultDueDate(billDate, 30),
    idempotencyKey: 'shown',
  });
  assert.equal(shown.ok, true, JSON.stringify(shown));

  assert.equal(defaultDueDate(billDate, 30), '2026-03-02');
  assert.deepEqual(
    comparableRow(t.store, t.workspaceId, shown.vendorBillId),
    comparableRow(t.store, t.workspaceId, develop.vendorBillId),
  );
  const developEntry = billRow(t.store, t.workspaceId, develop.vendorBillId).entry_id;
  const shownEntry = billRow(t.store, t.workspaceId, shown.vendorBillId).entry_id;
  assert.notEqual(developEntry, null);
  assert.notEqual(developEntry, shownEntry);
  const lines = comparableLines(t.store, developEntry);
  assert.ok(lines.length >= 3, 'expense, Vorsteuer and Kreditoren lines');
  assert.deepEqual(comparableLines(t.store, shownEntry), lines);
});

test('a code deleted in the drawer posts as no VAT: the payload carries no taxCode, as a blank always did', () => {
  const t = setup();
  const vendor = vendorWithTerms(t.ctx, 'Lieferant GmbH', 'v1', 0);
  const res = recordExpense(t.ctx, {
    vendorId: vendor,
    billDate: '2026-07-01',
    dueDate: defaultDueDate('2026-07-01', 0),
    amountMinor: 108100,
    amountIsGross: true,
    expenseAccountId: t.acc('6500'),
    idempotencyKey: 'no-vat',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = billRow(t.store, t.workspaceId, res.vendorBillId);
  assert.equal(row.tax_code, null);
  assert.equal(row.tax_amount_minor, 0);
  assert.equal(row.due_date, '2026-07-01');
  const lines = comparableLines(t.store, row.entry_id);
  assert.equal(lines.length, 2, 'the expense and the Kreditoren line, no Vorsteuer');
  assert.ok(lines.every((l) => l.tax_code === null));
});
