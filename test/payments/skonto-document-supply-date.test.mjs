/**
 * D164 (04.10.2026): A14's Skonto VAT correction prices at the date the invoice POSTED at, which the
 * one rule (`lineSupplyDate`) now reads from the document-level Leistungsdatum when the line carries
 * none. An invoice dated 20.12.2023 through its document date posted 7.7%; its Skonto reverses 7.7%.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, transitionDocument } from '../../dist/core/sales/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { setup, legsOf } from './support.mjs';

test('a Skonto on an invoice dated through its document-level Leistungsdatum reverses the VAT at that era', () => {
  const t = setup();
  const created = createDocument(t.ctx, {
    type: 'invoice',
    contactId: t.customerId,
    supplyDate: '2023-12-20',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: 'sd-create',
  });
  assert.ok(created.ok, JSON.stringify(created));
  const issued = transitionDocument(t.ctx, { documentId: created.document.id, to: 'issued', idempotencyKey: 'sd-issue' });
  assert.ok(issued.ok, JSON.stringify(issued));
  assert.equal(issued.document.totalMinor, 107700);

  // 20.00 net Skonto at 7.7% reverses 1.54 of MWST: 1'077.00 - 21.54 = 1'055.46 paid.
  const paid = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 105546,
    bankAccountId: t.bankId,
    allocations: [{ documentId: created.document.id, amountMinor: 105546, skontoMinor: 2000 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'sd-pay',
  });
  assert.ok(paid.ok, JSON.stringify(paid));
  const legs = legsOf(t.store, t.workspaceId, paid.entryId);
  // The VAT correction: 2200 debited 1.54 (7.7%), and the trace on the Skonto leg says the same.
  assert.equal(legs.find((l) => l.number === '2200')?.debit, 154);
  assert.equal(legs.find((l) => l.number === '3800')?.taxAmount, -154);
});
