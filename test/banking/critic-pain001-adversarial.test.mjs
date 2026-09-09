/**
 * INDEPENDENT CRITIC probe (non-author) for Rung B: does the extended offline XSD validator in
 * `test/lib/xsd.mjs` actually BITE on the SIX pain.001.001.09.ch.03 schema, or does its
 * `xs:complexContent > xs:restriction` handling silently accept anything?
 *
 * The author's own suite (`pain001-zkb-validation.test.mjs`) proves seven faults are caught. This
 * file adds NOVEL, deeper mutations the author did NOT test, targeting exactly the constructs where a
 * subset validator most easily goes vacuous:
 *   - an `xs:enumeration` facet deep in the tree (ChrgBr, PmtMtd),
 *   - an `xs:boolean` primitive (BtchBookg),
 *   - a MANDATORY child dropped deep inside a restriction-derived type (EndToEndId under PmtId),
 *   - two siblings reordered DEEP inside the tree (InstrId/EndToEndId),
 *   - an UNDECLARED element spliced into a satisfied content model (GrpHdr).
 * Plus the other half of "has teeth": three DISTINCT valid variants must all still PASS, so the
 * validator is not merely blessing one exact byte string (a false-positive guard), and validateXml
 * must never throw "not implemented" on the real generated file.
 *
 * Not production code. Written by the reviewing critic, kept as a regression witness.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSchemas, validateXml, parseXml } from '../lib/xsd.mjs';
import { setup, PLAIN_IBAN, QR_IBAN } from './support.mjs';
import { makeContext } from '../../dist/core/context.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import {
  createBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
} from '../../dist/core/banking/index.js';

const XSD_DIR = fileURLToPath(new URL('./fixtures/xsd/', import.meta.url));
const SCHEMA = loadSchemas(
  readdirSync(XSD_DIR).filter((f) => f.endsWith('.xsd')).sort().map((f) => join(XSD_DIR, f)),
);

const must = (r, what) => {
  assert.equal(r.ok, true, `${what} failed: ${JSON.stringify(r)}`);
  return r;
};

function generatePain001Xml() {
  const t = setup();
  let now = '2026-07-19T00:00:00.000Z';
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: { now: () => now }, ids: systemIdGen });
  const acc = t.acc;
  const QRR = '210000000003139471430009017';

  const vQr = must(createContact(ctx, { partyRole: 'vendor', name: 'Lieferant qr', idempotencyKey: 'v-qr' }), 'contact').contact.id;
  const bQr = must(createVendorBill(ctx, { vendorId: vQr, billDate: '2026-03-01', amountMinor: 10000, expenseAccountId: acc('6500'), idempotencyKey: 'bill-qr', vendorReference: QRR }), 'bill').vendorBillId;
  must(postVendorBill(ctx, { vendorBillId: bQr, idempotencyKey: 'post-qr' }), 'post');
  must(setCreditorBankProfile(ctx, { vendorId: vQr, iban: QR_IBAN, idempotencyKey: 'p-qr' }), 'profile');

  const vFt = must(createContact(ctx, { partyRole: 'vendor', name: 'Lieferant ft', idempotencyKey: 'v-ft' }), 'contact').contact.id;
  const bFt = must(createVendorBill(ctx, { vendorId: vFt, billDate: '2026-03-01', amountMinor: 30000, expenseAccountId: acc('6500'), idempotencyKey: 'bill-ft', vendorReference: 'Rechnung 42' }), 'bill').vendorBillId;
  must(postVendorBill(ctx, { vendorBillId: bFt, idempotencyKey: 'post-ft' }), 'post');
  must(setCreditorBankProfile(ctx, { vendorId: vFt, iban: PLAIN_IBAN, idempotencyKey: 'p-ft' }), 'profile');

  const bank = must(createBankAccount(ctx, { name: 'Kontokorrent', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'bank-1' }), 'bank').bankAccountId;
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bQr, bFt], executionDate: '2026-07-20', idempotencyKey: 'batch-1' }), 'batch');
  const gen = must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'gen-1' }), 'generate');
  return Buffer.from(gen.xmlBase64, 'base64').toString('utf8');
}

const mutate = (xml, fn, what) => {
  const out = fn(xml);
  assert.notEqual(out, xml, `broken probe: the "${what}" mutation did not change the document`);
  return out;
};

test('CRITIC: the generated pain.001 is valid, and validateXml never reports "not implemented"', () => {
  const r = validateXml(generatePain001Xml(), SCHEMA);
  assert.equal(r.valid, true, `positive control must pass; errors=${JSON.stringify(r.errors)}`);
  assert.equal(r.errors.join(' | ').includes('not implemented'), false, 'the validator must not choke on a real construct');
});

test('CRITIC: novel deep faults the author did not test are each caught and named', () => {
  const base = generatePain001Xml();
  assert.equal(validateXml(base, SCHEMA).valid, true, 'control must be valid before mutation');

  const cases = [
    [
      'an out-of-enumeration ChrgBr (deep xs:enumeration facet)',
      (x) => x.replace('<ChrgBr>SLEV</ChrgBr>', '<ChrgBr>XXXX</ChrgBr>'),
      /ChrgBr: "XXXX" is not one of the enumerated values/,
    ],
    [
      'an out-of-enumeration PmtMtd (the CH profile fixes it to TRF)',
      (x) => x.replace('<PmtMtd>TRF</PmtMtd>', '<PmtMtd>DD</PmtMtd>'),
      /PmtMtd: "DD" is not one of the enumerated values/,
    ],
    [
      'a non-boolean BtchBookg (xs:boolean primitive)',
      (x) => x.replace('<BtchBookg>true</BtchBookg>', '<BtchBookg>yes</BtchBookg>'),
      /BtchBookg: "yes" is not a valid xs:boolean/,
    ],
    [
      'a mandatory EndToEndId dropped deep inside PmtId',
      (x) => x.replace(/<EndToEndId>[^<]*<\/EndToEndId>/, ''),
      /PmtId: expected <EndToEndId> here, found <(UETR|end of element)|.*>/,
    ],
    [
      'InstrId and EndToEndId reordered deep in the tree (order is normative)',
      (x) => x.replace(
        /(<InstrId>[^<]*<\/InstrId>)(<EndToEndId>[^<]*<\/EndToEndId>)/,
        '$2$1',
      ),
      /unexpected <InstrId>|expected <EndToEndId>/,
    ],
    [
      'an undeclared element spliced into a satisfied GrpHdr',
      (x) => x.replace('</InitgPty>', '</InitgPty><Bogus>x</Bogus>'),
      /unexpected <Bogus>|found <Bogus>/,
    ],
  ];

  for (const [what, fn, expected] of cases) {
    const r = validateXml(mutate(base, fn, what), SCHEMA);
    assert.equal(r.valid, false, `the validator ACCEPTED a document with ${what}: it is vacuous here`);
    assert.match(r.errors.join(' | '), expected, `${what}: rejected for the wrong reason (got ${JSON.stringify(r.errors)})`);
  }
});

test('CRITIC: false-positive guard, three DISTINCT valid variants all still validate', () => {
  const base = generatePain001Xml();
  const variants = [
    ['a different but valid ChrgBr enum value', (x) => x.replace('<ChrgBr>SLEV</ChrgBr>', '<ChrgBr>DEBT</ChrgBr>')],
    ['a different but in-facet amount', (x) => x.replace('Ccy="CHF">100.00<', 'Ccy="CHF">123.45<').replace('<CtrlSum>400.00</CtrlSum>', '<CtrlSum>423.45</CtrlSum>')],
    ['the OPTIONAL InstrId removed (minOccurs=0)', (x) => x.replace(/<InstrId>[^<]*<\/InstrId>/, '')],
  ];
  for (const [what, fn] of variants) {
    const mutated = mutate(base, fn, what);
    const r = validateXml(mutated, SCHEMA);
    assert.equal(r.valid, true, `${what}: a VALID variant was wrongly rejected (errors=${JSON.stringify(r.errors)})`);
  }
});

test('CRITIC: parseXml round-trips the document structure the walk relies on', () => {
  const doc = parseXml(generatePain001Xml());
  assert.equal(doc.local, 'Document');
  // BtchBookg really is a boolean-bearing leaf and ChrgBr really is the enum leaf, so the mutations
  // above target real nodes, not strings that happen to appear elsewhere.
  const grep = (n, name, acc = []) => { if (n.local === name) acc.push(n); for (const c of n.children) grep(c, name, acc); return acc; };
  assert.equal(grep(doc, 'BtchBookg')[0].text.trim(), 'true');
  assert.equal(grep(doc, 'ChrgBr')[0].text.trim(), 'SLEV');
  assert.equal(grep(doc, 'EndToEndId').length, 2, 'two transactions, each with a mandatory EndToEndId');
});
