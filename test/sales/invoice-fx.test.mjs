// A11 US-A11.3 (multi-currency): the floor is LIFTED, and this suite is what holds it up.
//
// The story used to read DEFERRED, and honestly so: §H-FX named an `exchange_rate` store that was
// not in the schema, and `postEntry` hard-coded currency 'CHF' with a NULL `fx_rate`, so the
// txn + base + rate trace could not be stored even if a rate were handed in. Both are built now
// (`src/core/fx/`, and the A02 FX seam), so a EUR invoice genuinely issues, genuinely posts in base
// CHF, and genuinely carries the trace. The tests that asserted the refusal are replaced by tests
// that assert the capability, plus the one refusal that survives on purpose: no rate, no posting.
//
// The §9 DoD is the headline assertion here: **multi-currency stores base CHF**, and it reconciles
// to the Rappen against what was billed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createDocument,
  issueInvoice,
  isQrCurrency,
  buildQrBill,
  transitionDocument,
  QR_IBAN_CHF_ONLY_FROM,
} from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup({ at = AT, qrIban = 'CH4431999123000889012' } = {}) {
  const clock = fixedClock(at);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban,
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, at);
  return { ctx, store, workspaceId };
}

/** The ESTV daily selling rate for the invoice date (MWSTV Art. 45 Abs. 3). */
function recordEurRate(ctx, { asOf = '2026-07-16', rate = '0.9412' } = {}) {
  const res = recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate,
    asOf,
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: `fx-${asOf}-${rate}`,
  });
  assert.ok(res.ok, JSON.stringify(res));
  return res;
}

/** The Swiss QR payload is CRLF-separated; Amt is line 18 and Ccy is line 19 (IG section 4.2.2). */
const qrAmt = (payload) => payload.split('\r\n')[18];
const qrCcy = (payload) => payload.split('\r\n')[19];

function eurInvoice(ctx, { unitPriceMinor = 100000, taxCode = 'UST81' } = {}) {
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'EUR',
    lines: [{ description: 'Beratung', unitPriceMinor, taxCode }],
  });
  assert.ok(doc.ok, JSON.stringify(doc));
  return doc.document.id;
}

test('US-A11.3: a EUR invoice ISSUES, and the ledger posts in base CHF (§9 DoD)', () => {
  const { ctx, store } = setup();
  recordEurRate(ctx);
  const invoiceId = eurInvoice(ctx);

  const issued = issueInvoice(ctx, { invoiceId, idempotencyKey: 'eur-1' });
  assert.ok(issued.ok, JSON.stringify(issued));

  const doc = store.db.prepare('SELECT * FROM document WHERE id = ?').get(invoiceId);
  assert.equal(doc.status, 'issued');
  assert.equal(doc.currency, 'EUR');
  assert.notEqual(doc.number, null, 'a gap-free number was consumed');

  // The document totals are EUR: 1'000.00 net + 81.00 VAT (8.1%) = 1'081.00 gross.
  assert.equal(doc.subtotal_minor, 100000);
  assert.equal(doc.tax_minor, 8100);
  assert.equal(doc.total_minor, 108100);

  const rows = store.db
    .prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(doc.posted_entry_id);
  assert.ok(rows.length >= 3);
  for (const l of rows) {
    assert.equal(l.currency, 'EUR', '§H-FX: the transaction currency on every row');
    assert.equal(l.fx_rate, '0.9412', '§H-FX: the rate on every row');
  }

  // The receivable, reconciled to the Rappen on BOTH sides of the conversion.
  const receivable = rows.filter((l) => l.debit_minor > 0);
  assert.equal(receivable.length, 1);
  assert.equal(receivable[0].debit_minor, 108100, "EUR 1'081.00 billed");
  assert.equal(receivable[0].base_debit_minor, 101744, "CHF 1'017.44 booked (1081.00 * 0.9412)");

  const baseDebit = rows.reduce((s, l) => s + l.base_debit_minor, 0);
  const baseCredit = rows.reduce((s, l) => s + l.base_credit_minor, 0);
  assert.equal(baseDebit, baseCredit, '§H-LEDGER holds in base CHF');
  assert.equal(baseDebit, 101744);
});

test('US-A11.3: the QR bills the TRANSACTION currency, and Amt == 1100 == document.total_minor', () => {
  const { ctx, store } = setup();
  recordEurRate(ctx);
  const invoiceId = eurInvoice(ctx);
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'eur-qr' }).ok);

  const qr = buildQrBill(ctx, invoiceId);
  assert.ok(qr.ok, JSON.stringify(qr));
  assert.equal(qrCcy(qr.qr.swissQrPayload), 'EUR');
  assert.equal(qrAmt(qr.qr.swissQrPayload), '1081.00', 'the QR Amt is what the customer pays, in what they were billed');

  const doc = store.db.prepare('SELECT * FROM document WHERE id = ?').get(invoiceId);
  const posted1100 = store.db
    .prepare(
      `SELECT SUM(l.debit_minor) AS txn FROM journal_line l
        JOIN account a ON a.id = l.account_id
       WHERE l.entry_id = ? AND a.number = '1100'`,
    )
    .get(doc.posted_entry_id).txn;
  assert.equal(posted1100, doc.total_minor, 'posted receivable == document total, to the Rappen');
  assert.equal(
    Math.round(Number(qrAmt(qr.qr.swissQrPayload)) * 100),
    doc.total_minor,
    'QR Amt == document total',
  );
});

test('US-A11.3: with NO admissible rate the issue is refused TOTALLY, and says how to fix it', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = eurInvoice(ctx);

  const res = issueInvoice(ctx, { invoiceId, idempotencyKey: 'no-rate' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_fx_rate');
  assert.equal(res.currency, 'EUR');
  assert.equal(res.baseCurrency, 'CHF');
  assert.match(res.reason, /record_exchange_rate|fxRate/);
  // The deferral is GONE: this is a configuration state, not a floor.
  assert.equal(res.deferred, undefined, 'nothing about multi-currency is deferred any more');

  const row = store.db.prepare('SELECT * FROM document WHERE id = ?').get(invoiceId);
  assert.equal(row.status, 'draft', 'the document never left draft');
  assert.equal(row.number, null, 'no gap-free number was consumed');
  assert.equal(row.posted_entry_id, null);
  assert.equal(row.tax_minor, 0, 'the poster wrote no VAT');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM document_number_seq WHERE workspace_id = ?').get(workspaceId).n,
    0,
  );
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 0);

  // And the fix really is one call: record the rate, issue again, done.
  recordEurRate(ctx);
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'no-rate-2' }).ok);
});

test('US-A11.3: issuing a EUR invoice twice posts ONCE (asserted on ROWS)', () => {
  const { ctx, store } = setup();
  recordEurRate(ctx);
  const invoiceId = eurInvoice(ctx);

  const first = issueInvoice(ctx, { invoiceId, idempotencyKey: 'twice' });
  const second = issueInvoice(ctx, { invoiceId, idempotencyKey: 'twice' });
  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 1, 'ONE entry');
  assert.equal(
    store.db.prepare('SELECT SUM(base_debit_minor) AS d FROM journal_line').get().d,
    101744,
    'the CHF receivable was booked once, not twice',
  );
});

test('US-A11.3: cancelling a EUR invoice REVERSES it to exactly zero in both currencies', () => {
  const { ctx, store } = setup();
  recordEurRate(ctx);
  const invoiceId = eurInvoice(ctx);
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'to-cancel' }).ok);

  const cancelled = transitionDocument(ctx, { documentId: invoiceId, to: 'cancelled', idempotencyKey: 'cx-1' });
  assert.ok(cancelled.ok, JSON.stringify(cancelled));

  const nets = store.db
    .prepare(
      `SELECT account_id,
              SUM(debit_minor - credit_minor) AS txn,
              SUM(base_debit_minor - base_credit_minor) AS base
         FROM journal_line GROUP BY account_id`,
    )
    .all();
  for (const n of nets) {
    assert.equal(n.txn, 0, `${n.account_id} nets to zero in EUR`);
    assert.equal(n.base, 0, `${n.account_id} nets to zero in CHF`);
  }
  // §H-AUDIT: corrected by a REVERSING entry, never a delete.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 2);
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE reverses_entry_id IS NOT NULL').get().n,
    1,
  );
});

test('a CHF invoice is byte-for-byte what it was before the FX work', () => {
  const { ctx, store } = setup();
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  assert.ok(issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: 'chf-1' }).ok);
  const row = store.db.prepare('SELECT * FROM document WHERE id = ?').get(doc.document.id);
  for (const l of store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ?').all(row.posted_entry_id)) {
    assert.equal(l.currency, 'CHF');
    assert.equal(l.fx_rate, null, 'no rate is stamped on a base-currency invoice');
    assert.equal(l.base_debit_minor, l.debit_minor);
    assert.equal(l.base_credit_minor, l.credit_minor);
  }
});

test('a currency the QR-bill cannot carry still ISSUES and POSTS; only the payment part is absent', () => {
  const { ctx, store } = setup();
  assert.ok(
    recordExchangeRate(ctx, {
      baseCurrency: 'USD',
      rate: '0.8010',
      asOf: '2026-07-16',
      source: 'manual',
      method: 'daily',
      idempotencyKey: 'fx-usd',
    }).ok,
  );
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'USD',
    lines: [{ description: 'Consulting', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: 'usd-1' });
  assert.ok(issued.ok, JSON.stringify(issued));
  assert.equal(issued.qr.available, false, 'the QR-bill permits CHF and EUR only (SIX IG)');
  assert.equal(issued.qr.reason, 'unsupported_currency');

  const row = store.db.prepare('SELECT * FROM document WHERE id = ?').get(doc.document.id);
  assert.notEqual(row.posted_entry_id, null, 'the books are complete even where SIX cannot bill it');
  assert.equal(
    store.db.prepare('SELECT SUM(base_debit_minor) AS d FROM journal_line WHERE entry_id = ?').get(row.posted_entry_id).d,
    86588,
    "USD 1'081.00 * 0.8010 = CHF 865.88",
  );
  assert.equal(isQrCurrency('USD'), false);
});

test('the QR encoder still accepts EUR, because the GUIDELINE does', () => {
  assert.equal(isQrCurrency('EUR'), true);
  assert.equal(isQrCurrency('CHF'), true);
  assert.equal(isQrCurrency('USD'), false);
});

// --- SIX IG v2.4: the QR-IBAN goes CHF-only on 14.11.2026 ----------------------------------------

test('BEFORE the v2.4 cutover a EUR bill against a QR-IBAN still carries a QRR reference', () => {
  const { ctx } = setup({ at: '2026-11-13T09:00:00.000Z' });
  recordEurRate(ctx, { asOf: '2026-11-13' });
  const invoiceId = eurInvoice(ctx);
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'pre-cutover' }).ok);

  const qr = buildQrBill(ctx, invoiceId);
  assert.ok(qr.ok, JSON.stringify(qr));
  assert.equal(qr.qr.referenceType, 'QRR', 'v2.3 ties the reference type to the IBAN kind alone');
  assert.equal(qrCcy(qr.qr.swissQrPayload), 'EUR');
});

test('FROM the v2.4 cutover a EUR bill against a QR-IBAN is refused, and names the remedy', () => {
  const { ctx, store } = setup({ at: '2026-11-14T09:00:00.000Z' });
  recordEurRate(ctx, { asOf: '2026-11-14' });
  const invoiceId = eurInvoice(ctx);

  // The INVOICE is unaffected: it issues and posts. Only the payment part is unavailable.
  const issued = issueInvoice(ctx, { invoiceId, idempotencyKey: 'post-cutover' });
  assert.ok(issued.ok, JSON.stringify(issued));
  assert.equal(issued.qr.available, false);
  assert.equal(issued.qr.reason, 'qr_iban_chf_only');
  const row = store.db.prepare('SELECT posted_entry_id, status FROM document WHERE id = ?').get(invoiceId);
  assert.equal(row.status, 'issued');
  assert.notEqual(row.posted_entry_id, null, 'the books were made; only SIX cannot carry the slip');

  const qr = buildQrBill(ctx, invoiceId);
  assert.equal(qr.ok, false);
  assert.equal(qr.error, 'qr_iban_chf_only');
  assert.equal(qr.effectiveFrom, QR_IBAN_CHF_ONLY_FROM);
  assert.equal(QR_IBAN_CHF_ONLY_FROM, '2026-11-14');
  assert.match(qr.remedy, /plain IBAN/, 'the user is told what to do, not merely what failed');
  assert.match(qr.guideline, /v2\.4/);
});

test('FROM the cutover a EUR bill against a PLAIN IBAN is fine: SCOR is the conformant pairing', () => {
  const { ctx } = setup({ at: '2026-11-20T09:00:00.000Z', qrIban: 'CH9300762011623852957' });
  recordEurRate(ctx, { asOf: '2026-11-20' });
  const invoiceId = eurInvoice(ctx);
  assert.ok(issueInvoice(ctx, { invoiceId, idempotencyKey: 'plain-iban' }).ok);

  const qr = buildQrBill(ctx, invoiceId);
  assert.ok(qr.ok, JSON.stringify(qr));
  assert.equal(qr.qr.referenceType, 'SCOR');
  assert.equal(qrCcy(qr.qr.swissQrPayload), 'EUR');
});

test('a CHF bill against a QR-IBAN is untouched by the cutover, before AND after', () => {
  for (const at of ['2026-11-13T09:00:00.000Z', '2027-01-05T09:00:00.000Z']) {
    const { ctx } = setup({ at });
    const doc = createDocument(ctx, {
      type: 'invoice',
      contactId: 'ct_1',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    });
    assert.ok(issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: `chf-${at}` }).ok);
    const qr = buildQrBill(ctx, doc.document.id);
    assert.ok(qr.ok, `${at}: ${JSON.stringify(qr)}`);
    assert.equal(qr.qr.referenceType, 'QRR');
  }
});

