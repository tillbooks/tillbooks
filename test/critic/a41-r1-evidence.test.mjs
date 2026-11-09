// A41 critic round 1 (non-author), probe group 6: A41.2 evidence edges and A41.6 bulk.
//
// E1 a receipt captured with an amount but no currency (capture_extract accepts `{ minor }`) is matched by
//    the POOL in the base currency, but the EVIDENCE skips it as "nothing to compare": an agent attaching a
//    receipt of CHF 999.00 to a CHF 61.00 line keeps the engine's `sure`, and the line is bulk-bookable.
// E2 (sound) the same receipt with its currency: check, not bulk-bookable.
// E3 (sound) bulk: a learned line bulks only at or above an ANSWERED threshold; a check line never.
//
// SYNTHETIC BY CONSTRUCTION: invented counterparties, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { captureIntake, captureExtract } from '../../dist/core/purchase/index.js';
import { setBankStandard } from '../../dist/core/banking/bankStandards.js';
import { evidenceContext, vorschlagEvidenceOf } from '../../dist/core/banking/belegEvidence.js';
import { isBulkBookable } from '../../dist/core/banking/bankInbox.js';
import { must, world, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { receipt, lines } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const raster = (n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, n & 0xff, 41, 41]).toString('base64');

function noCurrencyReceipt(t, amount, vendor, date) {
  const intake = must(captureIntake(t.ctx, { contentBase64: raster(amount % 251), mime: 'image/png', filename: 'ohne-waehrung.png', idempotencyKey: `nc-${amount}` }));
  must(
    captureExtract(t.ctx, {
      captureId: intake.captureId,
      source: 'agent',
      fields: [
        { key: 'amount', value: { minor: amount }, confidence: 'high' },
        { key: 'vendor_name', value: vendor, confidence: 'high' },
        { key: 'invoice_date', value: date, confidence: 'high' },
      ],
      idempotencyKey: `nc-ex-${amount}`,
    }),
  );
  return t.store.db.prepare('SELECT document_id FROM captures WHERE id = ?').get(intake.captureId).document_id;
}

function ruled() {
  const t = world();
  const cp = { name: 'Netzwerk Beispiel AG', iban: 'CH4431999123000889012' };
  const [first] = lines(t, [{ amount: 1000, date: '2026-07-02', ...cp }]);
  must(setBankStandard(t.ctx, { bankTxnId: first, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'r-e' }));
  const [line] = lines(t, [{ amount: 6100, date: '2026-07-14', ...cp }]);
  const payload = (fileId) => ({ bankTxnId: line, target: { kind: 'accounts', legs: [{ accountId: t.acc('6570'), amountMinor: 6100 }] }, attach: [{ fileId }] });
  const ev = (fileId) => vorschlagEvidenceOf(t.ctx, evidenceContext(t.ctx), payload(fileId));
  return { t, cp, line, ev };
}

test('E1 fixed: a receipt of CHF 999.00 stated without its currency is read in the base currency and makes the evidence check', () => {
  const { t, cp, ev } = ruled();
  const fileId = noCurrencyReceipt(t, 99900, cp.name, '2026-07-14');
  const e = ev(fileId);
  const bulk = isBulkBookable(null, 6100, { evidence: e }, null);
  assert.equal(e.certainty, 'check', `evidence ${JSON.stringify({ certainty: e.certainty, reasons: e.reasons, belege: e.belege })}; bulkBookable ${bulk}`);
});

test('E2 sound: the same receipt with its currency is check and never bulks', () => {
  const { t, cp, ev } = ruled();
  const r = receipt(t, { amount: 99900, vendor: cp.name, date: '2026-07-14' });
  const e = ev(r.fileId);
  assert.equal(e.certainty, 'check');
  assert.ok(e.reasons.includes('beleg_amount_differs'));
  assert.equal(isBulkBookable(null, 6100, { evidence: e }, 5), false);
});

test('E3 sound: learned bulks only at or above an answered threshold; check never', () => {
  const learned = (count) => ({ certainty: 'learned', reasonCode: 'history', reasonParams: { count }, target: { kind: 'accounts', legs: [{ accountId: 'a', amountMinor: 100 }] } });
  assert.equal(isBulkBookable(learned(5), 100, null, null), false, 'unanswered');
  assert.equal(isBulkBookable(learned(5), 100, null, 0), false, 'Nur sichere');
  assert.equal(isBulkBookable(learned(4), 100, null, 5), false);
  assert.equal(isBulkBookable(learned(5), 100, null, 5), true);
  assert.equal(isBulkBookable({ ...learned(9), certainty: 'check' }, 100, null, 1), false);
});
