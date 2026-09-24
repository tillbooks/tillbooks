// Test support for A14 (payments and matching).
//
// A14 sits downstream of A11, and it consumes A11's REAL invoice poster: importing
// `core/sales/index.js` registers it into A10's seam, which is the one place invoicing gains a
// posting path (P3). Nothing about an invoice is faked here, because a receivable written straight
// into a table would not reconcile against a real ledger and every open amount A14 derives from it
// would be meaningless.
//
// The canonical fixture across the whole suite, matching the design's: net CHF 1'000.00 plus 8.1%
// MWST 81.00 equals gross CHF 1'081.00.

import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { configureVat } from '../../dist/core/vat/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { createContact, createDocument, transitionDocument } from '../../dist/core/sales/index.js';
import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';

export const AT = '2026-07-19T00:00:00.000Z';
/** The canonical fixture, in Rappen: net 100000 + 8.1% 8100 = gross 108100. */
export const NET_MINOR = 100000;
export const TAX_MINOR = 8100;
export const GROSS_MINOR = 108100;

function accountId(store, workspaceId, number) {
  return store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(workspaceId, number)?.id;
}

/**
 * A workspace with the KMU chart, VAT configured, and a customer. Nothing is added to the chart.
 *
 * `timing` is `soll` by default and `ist` for the US-A14.5 fixtures. `realPeriods` swaps the
 * permissive default port for A03's real lock check, which the period-lock cases need.
 *
 * `baseCurrency` is left unset by default, so the fixture keeps the Swiss books every existing case
 * was written against. Passing one opens the SAME world in another currency, which is the only way to
 * tell a franc that was read from `workspace.base_currency` apart from a franc somebody typed.
 */
export function setup({ timing = 'soll', realPeriods = false, at = AT, baseCurrency } = {}) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, {
    name: 'Muster Grafik GmbH',
    ...(baseCurrency !== undefined ? { baseCurrency } : {}),
  }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId,
    actor: 'user_1',
    clock,
    ids,
    ...(realPeriods ? ledgerPorts({ store, workspaceId, ids }) : {}),
  });

  const vat = configureVat(ctx, { method: 'effektiv', timing, registered: true, idempotencyKey: 'vat' });
  if (!vat.ok) throw new Error(`vat config failed: ${vat.error}`);

  // 3806, 4900 and 6949 were created here by raw SQL, because A01's core seed did not carry the
  // numbers A14 posts to. That is why no A14 test ever caught a wrong posting account: the whole
  // suite ran against a chart no real user has, and one of the accounts injected here (3806, under
  // the invented name "Rundungsdifferenzen und Debitorenverluste") did not exist in the
  // Kontenrahmen KMU at all. Every assertion about it was true of the fixture and false of the
  // product.
  //
  // The seed now carries all of them, so nothing is created here and the suite is judged on the
  // chart that actually ships. `assertChartIsExactlyTheSeed` below is what stops the blindness
  // coming back: adding an account by hand again fails loudly instead of quietly widening the
  // world the tests run in.
  assertChartIsExactlyTheSeed(store, workspaceId);

  const contact = createContact(ctx, { partyRole: 'customer', name: 'Muster AG', idempotencyKey: 'c1' });
  if (!contact.ok) throw new Error(`contact failed: ${contact.error}`);

  const acc = (number) => accountId(store, workspaceId, number);
  return {
    store,
    deps,
    ctx,
    clock,
    ids,
    workspaceId,
    acc,
    bankId: acc('1020'),
    customerId: contact.contact.id,
    /** The same world seen from a LATER day, so an invoice and its payment can sit on two rates. */
    at: (iso, opts = {}) =>
      makeContext(store, {
        workspaceId,
        actor: 'user_1',
        clock: fixedClock(iso),
        ids,
        ...(opts.realPeriods ? ledgerPorts({ store, workspaceId, ids }) : {}),
      }),
  };
}

/**
 * The chart every A14 case runs against is EXACTLY the shipped seed: same numbers, same names,
 * same types. A14 resolves its posting accounts by number out of this chart, so a fixture that
 * quietly carries one extra account, or one account under a different name, is a fixture that can
 * make a wrong posting look right. That is not hypothetical: it is what happened here.
 */
function assertChartIsExactlyTheSeed(store, workspaceId) {
  const rows = store.db
    .prepare('SELECT number, name, type FROM account WHERE workspace_id = ? ORDER BY number')
    .all(workspaceId);
  const expected = [...KMU_CORE_SEED]
    .map((a) => ({ number: a.number, name: a.name, type: a.type }))
    .sort((x, y) => x.number.localeCompare(y.number));
  assert.deepEqual(
    rows,
    expected,
    'the A14 fixture chart must be the shipped seed and nothing else: no account may be added, ' +
      'renamed or retyped by hand, or the suite stops testing the product',
  );
}

/**
 * Record a rate into the §H-FX store (never a second rate mechanism of A14's own). `rate` is the
 * price of one unit of `currency` in the workspace base currency, as a decimal STRING.
 */
export function seedRate(ctx, { currency, rate, asOf, key }) {
  const res = recordExchangeRate(ctx, {
    baseCurrency: currency,
    rate,
    asOf,
    source: 'manual',
    method: 'daily',
    provenance: 'test fixture',
    idempotencyKey: key ?? `rate-${currency}-${asOf}`,
  });
  if (!res.ok) throw new Error(`rate failed: ${JSON.stringify(res)}`);
  return res;
}

/**
 * A SECOND workspace inside the SAME database, which is the only shape in which a §H-TENANT claim
 * means anything: two separate stores would prove nothing about scoping.
 */
export function secondWorkspace(t, name = 'Nachbar AG') {
  const workspaceId = createWorkspace(t.deps, { name }).workspaceId;
  const ctx = makeContext(t.store, { workspaceId, actor: 'user_2', clock: t.clock, ids: t.ids });
  const vat = configureVat(ctx, { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'vat-2' });
  if (!vat.ok) throw new Error(`vat config failed: ${vat.error}`);
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Zweite AG', idempotencyKey: 'c2' });
  if (!contact.ok) throw new Error(`contact failed: ${contact.error}`);
  const acc = (number) => accountId(t.store, workspaceId, number);
  return { ctx, workspaceId, acc, bankId: acc('1020'), customerId: contact.contact.id };
}

/** A second customer, for the multi-invoice and counterparty cases. */
export function addCustomer(ctx, name, key) {
  const c = createContact(ctx, { partyRole: 'customer', name, idempotencyKey: key });
  if (!c.ok) throw new Error(`contact failed: ${c.error}`);
  return c.contact.id;
}

/**
 * Create AND issue an invoice, returning its row. `netMinor` defaults to the canonical 1'000.00, so
 * the default invoice is exactly the design's gross 1'081.00.
 */
export function issueInvoice(
  ctx,
  { contactId, netMinor = NET_MINOR, taxCode = 'UST81', key, dueDate, currency } = {},
) {
  const seed = key ?? `inv-${Math.random().toString(36).slice(2, 10)}`;
  const created = createDocument(ctx, {
    type: 'invoice',
    contactId,
    lines: [{ description: 'Beratung', unitPriceMinor: netMinor, taxCode }],
    ...(dueDate !== undefined ? { dueDate } : {}),
    ...(currency !== undefined ? { currency } : {}),
    idempotencyKey: `${seed}-create`,
  });
  if (!created.ok) throw new Error(`create invoice failed: ${created.error}`);
  const issued = transitionDocument(ctx, {
    documentId: created.document.id,
    to: 'issued',
    idempotencyKey: `${seed}-issue`,
  });
  if (!issued.ok) throw new Error(`issue invoice failed: ${issued.error} ${JSON.stringify(issued)}`);
  return issued.document;
}

/** Every journal line of an entry, as `{ number, debit, credit }`, for reconciling a posting. */
export function legsOf(store, workspaceId, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS number, l.debit_minor AS debit, l.credit_minor AS credit,
              l.tax_code AS taxCode, l.tax_base_minor AS taxBase, l.tax_amount_minor AS taxAmount
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? AND a.workspace_id = ?
        ORDER BY a.number`,
    )
    .all(entryId, workspaceId);
}

/** The net movement on one account number across every posted entry in the workspace. */
export function accountBalance(store, workspaceId, number) {
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(workspaceId, number);
  return row.net;
}

/** Row counts, so an idempotency claim is asserted on ROWS and never on a return value. */
export function counts(store, workspaceId) {
  const one = (sql, ...params) => store.db.prepare(sql).get(...params).n;
  return {
    payments: one('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?', workspaceId),
    allocations: one('SELECT COUNT(*) AS n FROM payment_allocation WHERE workspace_id = ?', workspaceId),
    entries: one('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?', workspaceId),
    lines: one(
      `SELECT COUNT(*) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ?`,
      workspaceId,
    ),
  };
}
