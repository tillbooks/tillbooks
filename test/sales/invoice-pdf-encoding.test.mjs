// A11: the invoice PDF font dictionary must name /WinAnsiEncoding, or the latin1 umlauts corrupt.
//
// Filed by A15's critic as the verified twin of the dunning defect (C9 there): `buildMinimalPdf`
// in `src/core/sales/invoice.ts` writes a latin1 content stream, and a base-14 Type1 font with NO
// /Encoding resolves through StandardEncoding, where 0xFC is `ae`. Every ü in "Zürich", a customer
// name or a line description mis-renders on an outward-facing Swiss invoice. Same assertion shape
// as `test/dunning/a15-critic-adversarial.test.mjs` (C9); the correct pattern lives in
// `src/core/reports/export.ts` and `src/core/dunning/pdf.ts`. The credit note (Gutschrift) shares
// `renderInvoicePdf`, so this pins both document types.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice, renderInvoicePdf } from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll', posting_auto_issue = 1 WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Müller AG', 'Musterstrasse', '5', '8000', 'Zürich', 'CH', 'billing@mueller.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx };
}

test('the invoice PDF font dictionary names /WinAnsiEncoding over its latin1 stream', () => {
  const { ctx } = setup();
  const doc = createDocument(ctx, {
    type: 'invoice',
    contactId: 'ct_1',
    currency: 'CHF',
    lines: [{ description: 'Beratung für Zürich', unitPriceMinor: 100000, taxCode: 'UST81' }],
  });
  const invoiceId = doc.document.id;
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));

  const pdf = renderInvoicePdf(ctx, invoiceId);
  assert.equal(pdf.ok, true, JSON.stringify(pdf));
  const text = Buffer.from(pdf.pdf.base64, 'base64').toString('latin1');

  assert.ok(text.includes('/BaseFont /Helvetica'), 'the invoice uses the base-14 Helvetica');
  assert.ok(text.includes('Zürich'), 'the umlaut rides as a latin1 byte');
  assert.ok(
    /\/BaseFont \/Helvetica[^>]*\/Encoding \/WinAnsiEncoding/.test(text),
    'the font dictionary names no /Encoding, so 0xFC renders as the StandardEncoding glyph (ae), ' +
      'not as u-umlaut: "Zürich", "Müller" and every umlaut in a line description corrupt on an ' +
      'outward-facing Swiss invoice (and on its Gutschrift twin, which shares this renderer)',
  );
});
