/**
 * Rung B: A18's pain.001 credit-transfer file, validated against the OFFICIAL SIX schema, offline.
 *
 * ## The gap this closes
 *
 * `generatePain001` (src/core/banking/pain001.ts) emits `pain.001.001.09` and ships its own
 * `validatePain001`, which checks the arithmetic (CtrlSum, NbOfTxs), the reference ceilings
 * (Max35Text), the IBANs and the routing shape, all re-derived from the produced string. That
 * function says so in its own words (pain001.ts ~line 770): "THIS IS NOT A FULL XSD VALIDATOR [...]
 * Full XSD conformance against SIX's published schema (`pain.001.001.09.ch.03.xsd`) [...] is out of
 * scope for this landing and is recorded as such rather than silently claimed." This suite closes
 * that gap by walking the file against the VENDORED schema, the same way A07's eCH-0217 export is
 * validated, reusing the shared subset validator in `test/lib/xsd.mjs`.
 *
 * ## The schema, vendored
 *
 * `test/banking/fixtures/xsd/pain.001.001.09.ch.03.xsd`, the SIX CH implementation-guideline schema
 * (see its `PROVENANCE.md` for the source and checksum). It is self-contained (no `xs:import`) and
 * builds nearly every type as `xs:complexType > xs:complexContent > xs:restriction > xs:sequence`,
 * plus the one `xs:simpleContent > xs:extension` amount type (a decimal body with a required `Ccy`
 * attribute) and one `xs:any`. Those three constructs are why the shared validator had to be
 * EXTENDED for this file: eCH-0217 uses only direct `xs:sequence`/`xs:choice`.
 *
 * ## What a substring assertion cannot see, and this can
 *
 * `xml.includes('<PmtId>')` proves a string is present. It cannot see order, and the pain.001 content
 * models are `xs:sequence`, so order is normative. The positive control below is that TILL's own
 * generated file VALIDATES; the negative controls mutate that file (two siblings swapped, a required
 * child dropped, an out-of-facet amount, a negative amount, a corrupt IBAN, a broken and a missing
 * `Ccy`) and prove each is CAUGHT and named. A validator that accepts everything makes every document
 * valid, so its teeth are what is under test as much as the file.
 *
 * ## A real finding about libxml2 and this schema
 *
 * The `xmllint` second opinion that backs the eCH-0217 suite CANNOT load this schema as published:
 * libxml2's regex engine rejects the `SPSText` pattern (XSD line 1555), which uses Unicode block
 * names `\p{IsBasicLatin}` and character-class subtraction `[...-[\p{C}]]`, neither of which libxml2
 * implements. `xmllint --schema` therefore fails at SCHEMA COMPILE, before it ever looks at a
 * document. The house validator translates those constructs (see `xsdPatternToJs`) and does load the
 * schema. The cross-check below still runs libxml2 as an independent opinion on STRUCTURE, against a
 * temp copy in which only that one uncompilable pattern is relaxed, and says out loud what it relaxed
 * and why, so nothing is silently skipped.
 *
 * Not production code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

const NS = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09';
const XSD_DIR = fileURLToPath(new URL('./fixtures/xsd/', import.meta.url));
const XSD_MAIN = join(XSD_DIR, 'pain.001.001.09.ch.03.xsd');

const SCHEMA = loadSchemas(
  readdirSync(XSD_DIR)
    .filter((f) => f.endsWith('.xsd'))
    .sort()
    .map((f) => join(XSD_DIR, f)),
);

const must = (r, what) => {
  assert.equal(r.ok, true, `${what} failed: ${JSON.stringify(r)}`);
  return r;
};

/**
 * A fresh workspace whose ctx uses PRODUCTION ids (`systemIdGen`) and a moving clock, exactly as
 * `recritic-a18.test.mjs` does. Production ids are what a real filer's file carries, and they are
 * longer than the sequence ids a `setup()` ctx hands out, so validating under them is validating the
 * shape a bank actually receives.
 */
function prodEnv() {
  const t = setup();
  let now = '2026-07-19T00:00:00.000Z';
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: { now: () => now }, ids: systemIdGen });
  return { t, ctx, acc: t.acc };
}

const mkVendor = (ctx, seed) =>
  must(createContact(ctx, { partyRole: 'vendor', name: `Lieferant ${seed}`, idempotencyKey: `v-${seed}` }), 'contact').contact.id;

function mkBill(ctx, acc, vendor, seed, amountMinor, extra = {}) {
  const b = must(createVendorBill(ctx, { vendorId: vendor, billDate: '2026-03-01', amountMinor, expenseAccountId: acc('6500'), idempotencyKey: `bill-${seed}`, ...extra }), 'bill');
  must(postVendorBill(ctx, { vendorBillId: b.vendorBillId, idempotencyKey: `post-${seed}` }), 'post');
  return b.vendorBillId;
}

const mkBank = (ctx, acc) =>
  must(createBankAccount(ctx, { name: 'Kontokorrent', iban: PLAIN_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'bank-1' }), 'bank').bankAccountId;

/**
 * Generate a real two-transaction pain.001: one QR-IBAN payment carrying a QRR reference, one
 * plain-IBAN payment carrying free-text remittance. This exercises both remittance shapes (`Strd`
 * and `Ustrd`) and gives distinct amounts (100.00 and 300.00, CtrlSum 400.00) so a mutation on an
 * `InstdAmt` can target `100.00` without colliding with the control sum.
 */
function generatePain001Xml() {
  const { ctx, acc } = prodEnv();
  const QRR = '210000000003139471430009017';

  const vQr = mkVendor(ctx, 'qr');
  const bQr = mkBill(ctx, acc, vQr, 'qr', 10000, { vendorReference: QRR });
  must(setCreditorBankProfile(ctx, { vendorId: vQr, iban: QR_IBAN, idempotencyKey: 'p-qr' }), 'profile');

  const vFt = mkVendor(ctx, 'ft');
  const bFt = mkBill(ctx, acc, vFt, 'ft', 30000, { vendorReference: 'Rechnung 42' });
  must(setCreditorBankProfile(ctx, { vendorId: vFt, iban: PLAIN_IBAN, idempotencyKey: 'p-ft' }), 'profile');

  const bank = mkBank(ctx, acc);
  const created = must(createPaymentBatch(ctx, { bankAccountId: bank, itemIds: [bQr, bFt], executionDate: '2026-07-20', idempotencyKey: 'batch-1' }), 'batch');
  const gen = must(generatePain001(ctx, { batchId: created.batchId, idempotencyKey: 'gen-1' }), 'generate');
  return Buffer.from(gen.xmlBase64, 'base64').toString('utf8');
}

/**
 * Apply a mutation and PROVE it landed, the way `ech0217-export.test.mjs` does. A mutation that
 * leaves the text unchanged is a broken probe, not a passing negative control: it would assert the
 * validator rejects the untouched, valid document.
 */
function mutate(xml, fn, what) {
  const out = fn(xml);
  assert.notEqual(out, xml, `the probe is wrong: the "${what}" mutation did not change the document`);
  return out;
}

const findChild = (node, local) => node.children.find((c) => c.local === local && c.ns === NS);

// --- 1. The positive control: TILL's own file validates against the real SIX schema -------------

test('pain.001 ZKB: the generated credit-transfer file validates against the vendored SIX XSD', () => {
  const xml = generatePain001Xml();
  const r = validateXml(xml, SCHEMA);
  assert.deepEqual(r.errors, [], 'the generated pain.001 must validate against pain.001.001.09.ch.03.xsd');
  assert.equal(r.valid, true);
});

test('pain.001 ZKB: the walker descends the real structure, in the XSD sequence order', () => {
  // Proof the validator is not passing vacuously: the document really does carry the root, the group
  // header and the payment instruction in the order the XSD's xs:sequence fixes, and the walker sees
  // it. If the validator silently accepted an unknown content model, this shape would still be here
  // but the negative controls below would not bite. Both together are the teeth.
  const doc = parseXml(generatePain001Xml());
  assert.equal(doc.local, 'Document');
  assert.equal(doc.ns, NS);
  const init = findChild(doc, 'CstmrCdtTrfInitn');
  assert.deepEqual(init.children.map((c) => c.local), ['GrpHdr', 'PmtInf']);
  assert.deepEqual(
    findChild(init, 'GrpHdr').children.map((c) => c.local),
    ['MsgId', 'CreDtTm', 'NbOfTxs', 'CtrlSum', 'InitgPty'],
  );
  const pmtInf = findChild(init, 'PmtInf');
  // The B-level sequence, verbatim from PaymentInstruction30_pain001_ch (optionals present skipped).
  assert.deepEqual(
    pmtInf.children.map((c) => c.local),
    ['PmtInfId', 'PmtMtd', 'BtchBookg', 'NbOfTxs', 'CtrlSum', 'ReqdExctnDt', 'Dbtr', 'DbtrAcct', 'DbtrAgt', 'ChrgBr', 'CdtTrfTxInf', 'CdtTrfTxInf'],
  );
  // The amount type is the simpleContent-with-Ccy case: a decimal body with a required attribute.
  const firstTx = pmtInf.children.find((c) => c.local === 'CdtTrfTxInf');
  const instdAmt = findChild(findChild(firstTx, 'Amt'), 'InstdAmt');
  assert.equal(instdAmt.attrs.Ccy, 'CHF', 'the amount carries its currency as an attribute, not an element');
  assert.match(instdAmt.text.trim(), /^\d+\.\d{2}$/);
});

// --- 2. The validator has teeth: each deliberate fault is caught, and named ----------------------

test('pain.001 ZKB: deliberate faults in the generated file are each caught and named', () => {
  const base = generatePain001Xml();
  assert.equal(validateXml(base, SCHEMA).valid, true, 'the control must be valid before it is mutated');

  const cases = [
    [
      'two siblings swapped, which a substring assertion cannot see',
      (x) => {
        const a = /<MsgId>[^<]*<\/MsgId>/.exec(x)[0];
        const b = /<CreDtTm>[^<]*<\/CreDtTm>/.exec(x)[0];
        return x.replace(a + b, b + a);
      },
      /GrpHdr: expected <MsgId> here, found <CreDtTm>/,
    ],
    [
      'a required child dropped (PmtId out of a transaction)',
      (x) => x.replace(/<PmtId>.*?<\/PmtId>/, ''),
      /CdtTrfTxInf: expected <PmtId> here, found <Amt>/,
    ],
    [
      // The eCH-0217 analogue was "a third decimal". Here the SIX amount type is fractionDigits=5,
      // NOT 2, so a third decimal is perfectly valid: the honest fault is a SIXTH fraction digit.
      'more fraction digits than the amount type permits',
      (x) => x.replace('Ccy="CHF">100.00<', 'Ccy="CHF">100.000000<'),
      /InstdAmt: "100\.000000" has 6 fraction digits, fractionDigits is 5/,
    ],
    [
      // ActiveOrHistoricCurrencyAndAmount_SimpleType has minInclusive 0, so a negative amount on the
      // instructed side is invalid (a payment out is not a negative number here).
      'a negative instructed amount',
      (x) => x.replace('Ccy="CHF">100.00<', 'Ccy="CHF">-100.00<'),
      /InstdAmt: "-100\.00" is below minInclusive 0/,
    ],
    [
      'a corrupt IBAN (lower-case country prefix)',
      (x) => x.replace('CH4431999123000889012', 'ch4431999123000889012'),
      /IBAN: "ch4431999123000889012" does not match pattern/,
    ],
    [
      // The simpleContent attribute path: a broken Ccy must be caught on its own pattern facet.
      'a Ccy attribute outside its pattern',
      (x) => x.replace('Ccy="CHF">100.00<', 'Ccy="chf">100.00<'),
      /InstdAmt\/@Ccy: "chf" does not match pattern \[A-Z\]\{3,3\}/,
    ],
    [
      'the required Ccy attribute removed entirely',
      (x) => x.replace(' Ccy="CHF">100.00<', '>100.00<'),
      /InstdAmt: missing required attribute @Ccy/,
    ],
  ];

  for (const [what, fn, expected] of cases) {
    const r = validateXml(mutate(base, fn, what), SCHEMA);
    assert.equal(r.valid, false, `the validator accepted a document with ${what}: it has no teeth`);
    assert.match(r.errors.join(' | '), expected, `${what}: the validator rejected it for the wrong reason (got ${JSON.stringify(r.errors)})`);
  }
});

// --- 3. libxml2, an independent second opinion (on structure) ------------------------------------

test('pain.001 ZKB: xmllint agrees on structure, when xmllint is on the machine', (t) => {
  let available = true;
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
  } catch {
    available = false;
  }
  if (!available) {
    t.diagnostic('xmllint is not installed: the libxml2 cross-check did not run');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'pain001-'));

  // First, the finding, proven rather than asserted: libxml2 cannot COMPILE this schema as SIX
  // published it, because of the SPSText pattern (Unicode block names + class subtraction).
  const asIs = join(dir, 'pain.as-is.xsd');
  writeFileSync(asIs, readFileSync(XSD_MAIN, 'utf8'));
  const doc = join(dir, 'doc.xml');
  writeFileSync(doc, generatePain001Xml());
  const asIsRun = runXmllint(asIs, doc);
  if (!/failed to compile|not a valid regular expression/.test(asIsRun.output)) {
    // If a future libxml2 gains the missing regex support, this branch fires and we learn the finding
    // no longer holds, rather than silently keeping a relaxed schema no longer needed.
    t.diagnostic(`libxml2 compiled the schema as-is: the SPSText regex limitation may be gone (status ${asIsRun.status})`);
  } else {
    t.diagnostic('confirmed: libxml2 cannot compile pain.001.001.09.ch.03.xsd as published (SPSText regex, XSD line 1555)');
  }

  // So the second opinion runs against a temp copy in which ONLY that one uncompilable pattern is
  // relaxed to `.+`. Everything libxml2 asserts below (sequence order, required children, the IBAN
  // and Ccy patterns) is UNTOUCHED by the relaxation, so its agreement is a genuine cross-check of
  // the house validator's structural verdicts. The SPSText pattern itself is checked only by the
  // house validator, and that caveat is stated out loud rather than buried.
  const SPS = String.raw`[\p{IsBasicLatin}\p{IsLatin-1Supplement}\p{IsLatinExtended-A}` + '€ȘșȚț' + String.raw`-[\p{C}]]+`;
  const relaxedText = readFileSync(XSD_MAIN, 'utf8');
  assert.ok(relaxedText.includes(SPS), 'the SPSText pattern to relax was not found: the vendored XSD changed');
  const relaxed = join(dir, 'pain.relaxed.xsd');
  writeFileSync(relaxed, relaxedText.split(SPS).join('.+'));

  const base = generatePain001Xml();
  const check = (name, xml) => {
    const path = join(dir, name);
    writeFileSync(path, xml);
    return runXmllint(relaxed, path);
  };

  // The positive control: if libxml2 rejects TILL's own file, either the harness or the file is wrong.
  const control = check('control.xml', base);
  assert.equal(control.status, 0, `xmllint rejected the generated pain.001:\n${control.output}`);

  // And it must reject the same structural and pattern faults the house validator rejects.
  const negatives = [
    ['swapped siblings', (x) => {
      const a = /<MsgId>[^<]*<\/MsgId>/.exec(x)[0];
      const b = /<CreDtTm>[^<]*<\/CreDtTm>/.exec(x)[0];
      return x.replace(a + b, b + a);
    }],
    ['dropped PmtId', (x) => x.replace(/<PmtId>.*?<\/PmtId>/, '')],
    ['corrupt IBAN', (x) => x.replace('CH4431999123000889012', 'ch4431999123000889012')],
    ['broken Ccy', (x) => x.replace('Ccy="CHF">100.00<', 'Ccy="chf">100.00<')],
  ];
  for (const [what, fn] of negatives) {
    const r = check(`neg-${what.replace(/\s+/g, '-')}.xml`, mutate(base, fn, what));
    assert.notEqual(r.status, 0, `xmllint accepted a document with ${what}: the cross-check has no teeth`);
  }
});

function runXmllint(schemaPath, docPath) {
  let status = 0;
  let output = '';
  try {
    output = execFileSync('xmllint', ['--nonet', '--noout', '--schema', schemaPath, docPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    status = e.status ?? 1;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  return { status, output };
}
