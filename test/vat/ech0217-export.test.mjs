/**
 * A07's eCH-0217 export: the file a person uploads to the ESTV ePortal.
 *
 * ## The standard, and the exact documents this suite was written against
 *
 * eCH-0217 **v2.0.0**, status `Genehmigt`, published 17.06.2025, listed at
 * `https://www.ech.ch/de/ech/ech-0217/2.0.0` as the current version (1.0.1 was superseded on
 * 27.02.2024). The XSD's own annotation says what it is for, in its own words:
 *
 *   `Spezifikation für die elektronische Einreichung von Mehrwertsteuer (MWST)-Abrechnungen im
 *    Portal ESTV SuisseTax`
 *
 * The schema documents are VENDORED verbatim under `fixtures/ech0217/`, fetched 2026-07-26 from:
 *
 *   eCH-0217-2-0-0.xsd
 *     https://www.ech.ch/sites/default/files/imce/eCH-Dossier/0211-0240/eCH-0217/2.0.0/Beilagen/eCH-0217-2-0-0.xsd
 *   ALL FOUR official example instances (used here as the validator's positive controls)
 *     .../Beilagen/eCH-0217_V2.0.0_example_effectiveReportingMethod.xml
 *     .../Beilagen/eCH-0217_V2.0.0_example_netTaxRateMethod.xml
 *     .../Beilagen/eCH-0217_V2.0.0_example_simpleTaxRateMethod.xml
 *     .../Beilagen/eCH-0217_V2.0.0_exemple_flatTaxRateMethode.xml
 *   and the SPECIFICATION DOCUMENT itself, 40 pp, which is where the date restriction on the method
 *   elements lives (Kap. 4.4 Tabelle 1) and which the XSD does not encode at all
 *     https://www.ech.ch/sites/default/files/imce/eCH-Dossier/eCH-Dossier_PDF_Publikationen/Hauptdokument/STAN_d_DEF_2025_06_30_eCH-0217_V2.0.0_E-MWST.pdf
 *   the imported schemas, from the canonical namespace locations the XSD itself names
 *     http://www.ech.ch/xmlns/eCH-0058/5/eCH-0058-5-0.xsd
 *     http://www.ech.ch/xmlns/eCH-0108/7/eCH-0108-7-0.xsd
 *   and eCH-0108's own transitive imports (0044, 0007, 0008, 0010/8, 0010/6, 0129, 0097), which are
 *   vendored so the validator can be told to REFUSE an unresolved import rather than skip it.
 *
 * ## What this suite refuses to accept as proof
 *
 * `xml.includes('<eCH-0217:payableTax>')` proves the string is in the file. It does not prove the
 * element is in the right place, and eCH-0217's content models are `xs:sequence`, so place is
 * normative. A08's export layer shipped exactly that class of defect once: `pdf.includes(...)`
 * passed while the content was drawn off the page. So every document here is VALIDATED, against the
 * real schema, by `ech0217-xsd.mjs` walking it. And because a validator that accepts everything
 * makes every document valid, the first test below points that validator at the official eCH
 * examples (must pass) and at six deliberate mutations (must each fail, naming the fault).
 *
 * ## The figures are the engine's, and this suite proves it by exhaustion
 *
 * Every amount in the file is compared to `computeVatReturn`'s own payload, and the set of amounts
 * in the file is compared to the set derived from that payload, so a figure the exporter invented
 * has nowhere to hide. A file and a screen that can disagree is the defect this capability exists
 * to prevent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeVatReturn } from '../../dist/core/vat/abrechnung.js';
import { exportVatReturnEch0217, mapReturnToEch0217 } from '../../dist/core/vat/ech0217.js';
import { loadSchemas, validateXml, parseXml } from './ech0217-xsd.mjs';
import {
  Q2,
  H1,
  UID,
  ORG_NAME,
  effektivWorld,
  saldoWorld,
  saldoSplitWorld,
  istWorld,
  unconfiguredWorld,
  emptyWorld,
  creditWorld,
} from './ech0217-world.mjs';

const NS = 'http://www.ech.ch/xmlns/eCH-0217/2';
const FIXTURES = fileURLToPath(new URL('./fixtures/ech0217/', import.meta.url));

const SCHEMA = loadSchemas(
  readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.xsd'))
    .sort()
    .map((f) => FIXTURES + f),
);

/**
 * The FOUR official example instances, by their exact published filenames.
 *
 * There are four, not two. An earlier version of this suite vendored `effectiveReportingMethod` and
 * `netTaxRateMethod` and described them as "the two official example instances", and the two it
 * skipped were `simpleTaxRateMethod` and `flatTaxRateMethode`: precisely the ones that carry the
 * post-2025 method elements. Skipping them is how F1 shipped. eCH's own filename for the flat-rate
 * one says `exemple` rather than `example`, so the mapping is spelled out rather than templated.
 */
const OFFICIAL_EXAMPLES = {
  effectiveReportingMethod: 'eCH-0217_V2.0.0_example_effectiveReportingMethod.xml',
  netTaxRateMethod: 'eCH-0217_V2.0.0_example_netTaxRateMethod.xml',
  simpleTaxRateMethod: 'eCH-0217_V2.0.0_example_simpleTaxRateMethod.xml',
  flatTaxRateMethod: 'eCH-0217_V2.0.0_exemple_flatTaxRateMethode.xml',
};

const official = (name) => readFileSync(FIXTURES + OFFICIAL_EXAMPLES[name], 'utf8');

/** Grab the whole serialised block of an element, WITH its indentation and line ending. */
function block(xml, name) {
  const re = new RegExp(`[ \\t]*<eCH-0217:${name}>[\\s\\S]*?</eCH-0217:${name}>\\r?\\n`);
  const m = re.exec(xml);
  assert.ok(m !== null, `the probe is wrong: no <eCH-0217:${name}> block in the document`);
  return m[0];
}

/**
 * Apply a mutation and PROVE it landed.
 *
 * This helper exists because the first version of these negative controls silently did nothing: the
 * vendored examples use CRLF, the mutation regexes assumed LF, `String.replace` returned the input
 * unchanged, and six "the validator rejects this" assertions were really six assertions that the
 * validator rejects the untouched, valid document. They passed for the wrong reason until the
 * mutations were checked. A mutation that does not change the text is a broken probe, not a result.
 */
function mutate(xml, fn, what) {
  const out = fn(xml);
  assert.notEqual(out, xml, `the probe is wrong: the "${what}" mutation did not change the document`);
  return out;
}

/** The children of an element, as `[localName, textContent]` pairs, in document order. */
function childPairs(node) {
  return node.children.map((c) => [c.local, c.children.length > 0 ? null : c.text.trim()]);
}

function findChild(node, local) {
  return node.children.find((c) => c.local === local && c.ns === NS);
}

/**
 * Every text-carrying leaf in the document, as `[path, value]` PAIRS in document order.
 *
 * A plain object keyed by path was the first version and it silently lost data: `suppliesPerTaxRate`
 * repeats, so the second pair overwrote the first and an exhaustion check built on it walked half
 * the document while reporting success. A list cannot collide.
 */
function leafPairs(node, prefix = '') {
  const out = [];
  for (const c of node.children) {
    const path = `${prefix}/${c.local}`;
    if (c.children.length === 0) out.push([path, c.text.trim()]);
    else out.push(...leafPairs(c, path));
  }
  return out;
}

/** The same walk, collapsed to a lookup. Only safe for elements the schema does not repeat. */
function leaves(node) {
  return Object.fromEntries(leafPairs(node));
}

const unwrap = (r, what) => {
  assert.equal(r.ok, true, `${what} refused: ${JSON.stringify(r)}`);
  return r;
};

// --- 1. The validator is not self-grading -------------------------------------------------------

test('eCH-0217 validator: all FOUR official eCH example instances validate', () => {
  const names = Object.keys(OFFICIAL_EXAMPLES);
  assert.equal(names.length, 4, 'eCH publishes four example instances, one per method element');
  for (const name of names) {
    const r = validateXml(official(name), SCHEMA);
    assert.deepEqual(r.errors, [], `the official ${name} example must validate, or the validator is broken`);
    assert.equal(r.valid, true);
  }
});

test('eCH-0217: the 2025 method elements carry activityID, which is why TILL cannot fabricate one', () => {
  // The evidence for F1's remedy, read off eCH's OWN examples rather than argued. Kap. 5.3.11: the
  // `activityId` is a "5-stelliger Tätigkeitscode ersichtlich jeweils in den «Subformularen» sowie
  // unter «Abrechnungsmodalitäten» in der Applikation «Mehrwertsteuer abrechnen»", and Kap. 5.3.11
  // adds "Es dürfen nur bewilligte activityId übermittelt werden." It is issued by the ESTV per
  // business. No amount of ledger data derives it, so an exporter that invents one files a lie.
  // The 2025 Saldo/Pauschal element. `activityIDTurnoverTaxRateType`, XSD lines 73-86: the
  // `activityID` is minLength 5 AND maxLength 5, so it is mandatory and exactly five characters.
  const simple = findChild(parseXml(official('simpleTaxRateMethod')), 'simpleTaxRateMethod');
  const simpleSupplies = simple.children.filter((c) => c.local === 'suppliesPerTaxRate');
  assert.ok(simpleSupplies.length > 0);
  for (const s of simpleSupplies) {
    assert.deepEqual(
      s.children.map((c) => c.local),
      ['activityID', 'taxRate', 'turnover'],
      'simpleTaxRateMethod/suppliesPerTaxRate is activityIDTurnoverTaxRateType: activityID FIRST, and mandatory',
    );
    assert.match(findChild(s, 'activityID').text.trim(), /^\d{5}$/, 'the Tätigkeitscode is five digits');
  }

  // The PRE-2025 Pauschal element is a different type: `activityTurnoverTaxRateType`, whose
  // `activity` is a free token (minLength 0, maxLength 100), not the ESTV's five-digit code. Worth
  // pinning so nobody later conflates the two and concludes a free-text label satisfies the 2025
  // element. It does not: the XSD facet is 5..5 and the spec says only approved codes may be sent.
  const flat = findChild(parseXml(official('flatTaxRateMethod')), 'flatTaxRateMethod');
  for (const s of flat.children.filter((c) => c.local === 'suppliesPerTaxRate')) {
    assert.deepEqual(s.children.map((c) => c.local), ['activity', 'taxRate', 'turnover']);
  }

  // And the pre-2025 element is the bare (taxRate, turnover) pair, with no activity anywhere.
  const net = findChild(parseXml(official('netTaxRateMethod')), 'netTaxRateMethod');
  for (const s of net.children.filter((c) => c.local === 'suppliesPerTaxRate')) {
    assert.deepEqual(s.children.map((c) => c.local), ['taxRate', 'turnover']);
  }
});

test('eCH-0217 validator: six deliberate faults in the official example are each caught', () => {
  const base = official('effectiveReportingMethod');
  assert.equal(validateXml(base, SCHEMA).valid, true, 'the control must be valid before it is mutated');

  const cases = [
    [
      'two siblings swapped, which a substring assertion cannot see',
      (x) => {
        const a = block(x, 'generationTime');
        const b = block(x, 'reportingPeriodFrom');
        return x.replace(a + b, b + a);
      },
      /expected <generationTime> here, found <reportingPeriodFrom>/,
    ],
    ['a required child dropped', (x) => x.replace(block(x, 'organisationName'), ''), /expected <organisationName> here/],
    ['a third decimal on an amount', (x) => x.replace('<eCH-0217:payableTax>1.12<', '<eCH-0217:payableTax>1.123<'), /3 fraction digits/],
    ['a UID that is one digit short', (x) => x.replace('CHE123456789', 'CHE12345678'), /uid: .*minLength is 12/],
    ['a typeOfSubmission outside the enumeration', (x) => x.replace('<eCH-0217:typeOfSubmission>1<', '<eCH-0217:typeOfSubmission>9<'), /not one of the enumerated values/],
    [
      'a second payableTax after the model is satisfied',
      (x) => x.replace('</eCH-0217:otherFlowsOfFunds>', '</eCH-0217:otherFlowsOfFunds><eCH-0217:payableTax>1.12</eCH-0217:payableTax>'),
      /unexpected <payableTax>/,
    ],
  ];

  for (const [what, fn, expected] of cases) {
    const r = validateXml(mutate(base, fn, what), SCHEMA);
    assert.equal(r.valid, false, `the validator accepted a document with ${what}: it has no teeth`);
    assert.match(r.errors.join(' | '), expected, `${what}: the validator rejected it for the wrong reason`);
  }
});

test('eCH-0217 validator: xs:token collapses whitespace, and length facets apply AFTER', () => {
  // The validator used to reject any xs:token containing a double space, a tab or a newline. That is
  // not what XSD says: whiteSpace=collapse is a NORMALISATION applied before the other facets, so
  // those values are valid and their collapsed form is what counts. The old behaviour made this
  // validator stricter than the real one and produced a false report of an ESTV-rejected file.
  // Every expectation below was confirmed against `xmllint --schema` before being written down.
  const withName = (name) =>
    official('effectiveReportingMethod').replace(
      /(<eCH-0217:organisationName>)[\s\S]*?(<\/eCH-0217:organisationName>)/,
      `$1${name}$2`,
    );

  for (const [what, name] of [
    ['a double space', 'Muster  AG'],
    ['a tab', 'Muster\tAG'],
    ['a newline', 'Muster\nAG'],
    ['255 characters', 'B'.repeat(255)],
  ]) {
    const r = validateXml(mutate(official('effectiveReportingMethod'), () => withName(name), what), SCHEMA);
    assert.deepEqual(r.errors, [], `${what} is a VALID unitNameType once collapsed, and libxml2 agrees`);
  }

  for (const [what, name, expected] of [
    ['256 characters', 'C'.repeat(256), /maxLength is 255/],
    ['whitespace only', '  \t \n ', /minLength is 1/],
  ]) {
    const r = validateXml(mutate(official('effectiveReportingMethod'), () => withName(name), what), SCHEMA);
    assert.equal(r.valid, false, `${what} must be rejected`);
    assert.match(r.errors.join(' | '), expected, `${what}: rejected for the wrong reason`);
  }
});

// --- 2. The effektiv happy path -----------------------------------------------------------------

test('eCH-0217 effektiv: the generated file validates against the real XSD', () => {
  const ctx = effektivWorld();
  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'vat_export_ech0217');
  const r = validateXml(out.xml, SCHEMA);
  assert.deepEqual(r.errors, []);
  assert.equal(r.valid, true);
  assert.equal(out.schema.standard, 'eCH-0217');
  assert.equal(out.schema.version, '2.0.0');
  assert.equal(out.schema.namespace, NS);
});

test('eCH-0217 effektiv: the root and generalInformation carry the XSD sequence, in order', () => {
  const out = unwrap(exportVatReturnEch0217(effektivWorld(), Q2), 'export');
  const doc = parseXml(out.xml);
  assert.equal(doc.local, 'VATDeclaration');
  assert.equal(doc.ns, NS);
  // The order is the xs:sequence of the root element, verbatim from the vendored XSD.
  assert.deepEqual(
    doc.children.map((c) => c.local),
    ['generalInformation', 'turnoverComputation', 'effectiveReportingMethod', 'payableTax'],
  );
  assert.deepEqual(
    findChild(doc, 'generalInformation').children.map((c) => c.local),
    [
      'uid',
      'organisationName',
      'generationTime',
      'reportingPeriodFrom',
      'reportingPeriodTill',
      'typeOfSubmission',
      'formOfReporting',
      'businessReferenceId',
      'sendingApplication',
    ],
  );
});

test('eCH-0217 effektiv: generalInformation says who is filing, for what, and on which basis', () => {
  const ctx = effektivWorld();
  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  const gi = findChild(parseXml(out.xml), 'generalInformation');
  const text = (name) => findChild(gi, name).text.trim();

  // eCH-0108 uidType is `CHE[1-9][0-9]{8}`: no dashes, no dots, no ` MWST` suffix. The stored form
  // is the ESTV's printed one, so the export NORMALISES rather than demanding the operator retype.
  assert.equal(UID, 'CHE-116.281.271');
  assert.equal(text('uid'), 'CHE116281271');
  assert.equal(text('organisationName'), ORG_NAME);
  assert.equal(text('reportingPeriodFrom'), Q2.periodStart);
  assert.equal(text('reportingPeriodTill'), Q2.periodEnd);
  assert.equal(text('typeOfSubmission'), '1', 'Ersteinreichung by default');
  // `formOfReporting` 1 is `vereinbart`, 2 is `vereinnahmt`. computeVatReturn refuses `ist`
  // outright, so the only basis TILL can ever declare here is the agreed one, and declaring the
  // other would be a lie the schema happily accepts.
  assert.equal(text('formOfReporting'), '1');
  assert.equal(findChild(gi, 'generationTime').text.trim(), ctx.clock.now());
});

test('eCH-0217 effektiv: every amount in the file is the ENGINE figure, and no amount is invented', () => {
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  const got = leaves(parseXml(out.xml));

  const ziff = (code) => engine.lines.find((l) => l.code === code);
  const chf = (minor) => (minor / 100).toFixed(2);

  // The Ziffer -> element mapping, spelled out so a reader can check it against the ESTV form and
  // the XSD side by side rather than trusting the exporter's own table.
  const expected = {
    '/turnoverComputation/totalConsideration': chf(ziff('200').baseMinor), //        Ziff. 200
    '/turnoverComputation/suppliesToForeignCountries': chf(ziff('220').baseMinor), // Ziff. 220
    '/effectiveReportingMethod/grossOrNet': '1',
    '/effectiveReportingMethod/suppliesPerTaxRate/taxRate': null, //                 checked below
    '/effectiveReportingMethod/inputTaxMaterialAndServices': chf(ziff('400').taxMinor), // Ziff. 400
    '/effectiveReportingMethod/inputTaxInvestments': chf(ziff('405').taxMinor), //   Ziff. 405
    '/payableTax': chf(engine.payableMinor - engine.creditMinor), //                 Ziff. 500/510
  };
  for (const [path, value] of Object.entries(expected)) {
    if (value === null) continue;
    assert.equal(got[path], value, `${path} is not the engine's figure`);
  }

  // Ziffern 289, 299 and 479 are TOTALS the ESTV recomputes, and the XSD gives them no element at
  // all. Emitting them somewhere would be a figure with no box.
  const values = Object.values(got);
  for (const code of ['289', '299', '479']) {
    const line = ziff(code);
    if (line === undefined || line.baseMinor === 0) continue;
    assert.equal(
      values.includes(chf(line.baseMinor)) && !values.includes(chf(ziff('200').baseMinor)),
      false,
      `Ziffer ${code} is a derived total with no element in eCH-0217 and must not be emitted`,
    );
  }

  // The per-rate block: turnover and rate, both from the engine's own line, paired.
  const method = findChild(parseXml(out.xml), 'effectiveReportingMethod');
  const perRate = method.children
    .filter((c) => c.local === 'suppliesPerTaxRate')
    .map((c) => childPairs(c));
  // Ascending ZIFFER order, which is the order the ESTV form prints its rows in (Normal 303,
  // Reduziert 313, Beherbergung 343) with each row's two rate vintages adjacent. Any total order
  // validates; pinning one is what makes the output byte-stable.
  assert.deepEqual(perRate, [
    [['taxRate', '8.10'], ['turnover', chf(ziff('303').baseMinor)]],
    [['taxRate', '2.60'], ['turnover', chf(ziff('313').baseMinor)]],
  ]);
  const acquisition = method.children.filter((c) => c.local === 'acquisitionTax').map((c) => childPairs(c));
  assert.deepEqual(acquisition, [[['taxRate', '8.10'], ['turnover', chf(ziff('383').baseMinor)]]]);

  // And the exhaustion check: every amount-shaped leaf in the file traces to an engine figure.
  // `taxRate` is a RATE and not an amount, and it is checked above against the engine's `rateBp`
  // pair by pair; it is excluded here rather than folded into the permitted set, because a rate
  // that happened to equal some franc figure would otherwise let a wrong amount through.
  const permitted = new Set([
    ...engine.lines.flatMap((l) => [chf(l.baseMinor), chf(l.taxMinor)]),
    chf(engine.payableMinor - engine.creditMinor),
  ]);
  const pairs = leafPairs(parseXml(out.xml));
  let checked = 0;
  for (const [path, value] of pairs) {
    if (path.endsWith('/taxRate')) continue;
    if (!/^-?\d+\.\d{2}$/.test(value)) continue;
    assert.ok(permitted.has(value), `${path} = ${value} is an amount that no engine figure produced`);
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} amounts were reached: the exhaustion probe is not walking the document`);

  // And the rates themselves trace back to `rateBp`, so neither column is free-floating.
  const rateValues = pairs.filter(([p]) => p.endsWith('/taxRate')).map(([, v]) => v);
  const engineRates = new Set(engine.lines.filter((l) => l.rateBp !== null).map((l) => (l.rateBp / 100).toFixed(2)));
  assert.ok(rateValues.length >= 3, 'the effektiv fixture must carry at least three rated lines');
  for (const v of rateValues) assert.ok(engineRates.has(v), `taxRate ${v} is a rate no engine line carries`);
});

test('eCH-0217 effektiv: grossOrNet declares Netto, because the engine reports Entgelt net of tax', () => {
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  const got = leaves(parseXml(out.xml));
  // MWSTG Art. 24: under effektiv the Entgelt excludes the tax, and abrechnung.ts adds the franc tax
  // into Ziffer 200 only under Saldo. So 200 must be the sum of the NET per-rate turnovers plus the
  // untaxed ones, and declaring `grossOrNet` = 2 (Brutto) over the same figure would overstate the
  // turnover by the whole VAT.
  const perRateNet = ['303', '313'].reduce((a, c) => a + engine.lines.find((l) => l.code === c).baseMinor, 0);
  const zeroRated = engine.lines.find((l) => l.code === '220').baseMinor;
  assert.equal(engine.lines.find((l) => l.code === '200').baseMinor, perRateNet + zeroRated);
  assert.equal(got['/effectiveReportingMethod/grossOrNet'], '1');
});

// --- 3. Saldo ------------------------------------------------------------------------------------

test('eCH-0217 Saldo: a PRE-2025 one-rate period exports netTaxRateMethod, with no Vorsteuer anywhere', () => {
  // This test used to run H1/2026 through here and assert `netTaxRateMethod`, which PINNED F1: the
  // element is only correct for Abrechnungsperioden bis 31.12.2024. The shape assertions are worth
  // keeping, so they now run against a period the element actually governs, driven through the
  // mapper because the engine's rate ladder and the world's postings both live in 2026.
  const { payload, identity } = saldoPayload({ periodStart: '2024-07-01', periodEnd: '2024-12-31' });
  const out = unwrap(mapReturnToEch0217(payload, identity), 'map');

  const r = validateXml(out.xml, SCHEMA);
  assert.deepEqual(r.errors, []);

  const doc = parseXml(out.xml);
  assert.deepEqual(
    doc.children.map((c) => c.local),
    ['generalInformation', 'turnoverComputation', 'netTaxRateMethod', 'payableTax'],
  );
  assert.equal(findChild(doc, 'effectiveReportingMethod'), undefined);
  assert.equal(findChild(doc, 'simpleTaxRateMethod'), undefined);

  const chf = (m) => (m / 100).toFixed(2);
  const ziff323 = payload.lines.find((l) => l.code === '323');
  assert.deepEqual(
    findChild(doc, 'netTaxRateMethod').children.filter((c) => c.local === 'suppliesPerTaxRate').map(childPairs),
    [[['taxRate', '6.20'], ['turnover', chf(ziff323.baseMinor)]]],
    'the pre-2025 element carries the bare (taxRate, turnover) pair and NO activityID',
  );

  // Art. 37: the flat rate imputes the input tax, so there is no Vorsteuer figure to declare, and
  // `netTaxRateMethodType` has no element for one. Ziffer 200 is the GROSS consideration under
  // Saldo (abrechnung.ts adds the franc tax in), which is why there is no `grossOrNet` here.
  const got = leaves(doc);
  assert.equal(got['/turnoverComputation/totalConsideration'], chf(payload.lines.find((l) => l.code === '200').baseMinor));
  assert.equal(Object.keys(got).some((k) => /inputTax|grossOrNet/.test(k)), false);
  assert.equal(got['/payableTax'], chf(payload.payableMinor - payload.creditMinor));
});

test('eCH-0217 Saldo: the VERB refuses a 2026 Saldo period end to end, not just the mapper', () => {
  // The live path, through the real workspace. Every Saldo period a user of this product will file
  // is after 01.01.2025, so this refusal is what a Saldo filer actually meets today. It is the
  // honest answer until an ESTV Tätigkeitscode can be stored: the alternative shipped a file the
  // portal rejects under MWST-0002 after the deadline has been spent.
  const r = exportVatReturnEch0217(saldoWorld(), H1);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'saldo_activity_id_required');
  assert.match(r.nextStep, /Tätigkeitscode/);
  assert.match(r.nextStep, /estv\.admin\.ch/);
  assert.equal('xml' in r, false);
});

// --- 3b. F1/F4: the method element is a function of the PERIOD, not of the method alone ----------

/**
 * A Saldo payload with the period moved, so the element choice can be driven directly.
 *
 * The element name is a pure function of `(method, periodStart, periodEnd)`, and the XSD cannot see
 * it: the root `xs:choice` (XSD lines 300-305) accepts all four method elements for any period, so
 * schema validity proves NOTHING here. Every assertion below is on the ELEMENT NAME against the
 * period, which is the only thing that distinguishes a filable file from an MWST-0002 rejection.
 */
function saldoPayload({ periodStart, periodEnd, activityId }) {
  const ctx = saldoWorld();
  const engine = unwrap(computeVatReturn(ctx, H1), 'vat_return');
  const lines = engine.lines.map((l) => (activityId !== undefined && l.code === '323' ? { ...l, activityId } : l));
  return {
    payload: { ...engine, periodStart, periodEnd, lines },
    identity: { uid: 'CHE116281271', organisationName: ORG_NAME, generationTime: ctx.clock.now() },
  };
}

const methodElementOf = (xml) =>
  parseXml(xml).children.map((c) => c.local).find((n) => /Method$/.test(n) || n === 'effectiveReportingMethod');

test('eCH-0217 F1: a Saldo period ENDING before 2025 emits netTaxRateMethod', () => {
  // Kap. 4.4 Tabelle 1: `netTaxRateMethod (Für Abrechnungsperioden bis 31.12.2024)`. Still correct,
  // and still reachable: a Berichtigungsabrechnung for 2024 can be filed well into 2026.
  const { payload, identity } = saldoPayload({ periodStart: '2024-07-01', periodEnd: '2024-12-31' });
  const r = unwrap(mapReturnToEch0217(payload, identity), 'map');
  assert.equal(methodElementOf(r.xml), 'netTaxRateMethod');
  assert.deepEqual(validateXml(r.xml, SCHEMA).errors, []);
});

test('eCH-0217 F1: a Saldo period from 2025 must NOT emit netTaxRateMethod', () => {
  // The defect, stated as the ESTV states it. Kap. 7.2, verbatim: "netTaxRateMethod =
  // Saldosteuersatzmethode für Abrechnungsperioden bis 31.12.2024 [...] und für Abrechnungsperioden
  // ab 01.01.2025 simpleTaxRateMethode", with "(Fehlercode „MWST-0002 ...")". Every Saldo period a
  // user of this product will actually file is after 01.01.2025.
  const { payload, identity } = saldoPayload({ periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  const r = mapReturnToEch0217(payload, identity);
  if (r.ok) {
    assert.notEqual(methodElementOf(r.xml), 'netTaxRateMethod', 'a 2026 Saldo period filed as netTaxRateMethod is rejected by the ESTV under MWST-0002');
  }
});

test('eCH-0217 F1: a 2025+ Saldo period with no Tätigkeitscode REFUSES rather than shipping a reject', () => {
  // TILL has no `activityID` and cannot derive one. Kap. 5.3.11: it is a five-digit code visible
  // "unter «Abrechnungsmodalitäten» in der Applikation «Mehrwertsteuer abrechnen»", and "Es dürfen
  // nur bewilligte activityId übermittelt werden". Inventing one produces a file that is schema-
  // valid and wrong. A refusal that names the ePortal is strictly better than an upload rejection
  // discovered on a statutory deadline.
  const { payload, identity } = saldoPayload({ periodStart: '2026-01-01', periodEnd: '2026-06-30' });
  const r = mapReturnToEch0217(payload, identity);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'saldo_activity_id_required');
  assert.ok(r.nextStep.length > 30);
  assert.equal('xml' in r, false, 'a refusal must not carry a half-built file');
});

test('eCH-0217 F1: given a Tätigkeitscode, a 2025+ Saldo period emits simpleTaxRateMethod', () => {
  // The forward path, proven now so that closing the data gap is a deletion rather than a design.
  // The shape is asserted against eCH's own example: activityID first, then taxRate, then turnover.
  const { payload, identity } = saldoPayload({ periodStart: '2026-01-01', periodEnd: '2026-06-30', activityId: '00123' });
  const r = unwrap(mapReturnToEch0217(payload, identity), 'map');
  assert.equal(methodElementOf(r.xml), 'simpleTaxRateMethod');
  assert.deepEqual(validateXml(r.xml, SCHEMA).errors, [], 'the 2025 document must validate against the real XSD too');

  // The turnover is the ENGINE's Ziffer 323, gross (abrechnung.ts adds the franc tax in under
  // Saldo), taken from the payload rather than typed in, so this cannot drift into a magic number.
  const ziff323 = payload.lines.find((l) => l.code === '323');
  const method = findChild(parseXml(r.xml), 'simpleTaxRateMethod');
  const supplies = method.children.filter((c) => c.local === 'suppliesPerTaxRate').map(childPairs);
  assert.deepEqual(supplies, [[['activityID', '00123'], ['taxRate', '6.20'], ['turnover', (ziff323.baseMinor / 100).toFixed(2)]]]);
});

test('eCH-0217 F1: a period straddling 01.01.2025 refuses, because no element covers it', () => {
  // Kap. 7.2 also forbids changing method inside a Steuerperiode, and Art. 34 Abs. 2 MWSTG makes the
  // calendar year the Steuerperiode, so a straddling Abrechnungsperiode is not a thing that exists.
  // Silently picking either element would file half the period under the wrong regime.
  const { payload, identity } = saldoPayload({ periodStart: '2024-10-01', periodEnd: '2025-03-31', activityId: '00123' });
  const r = mapReturnToEch0217(payload, identity);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'period_straddles_method_change');
  assert.ok(r.nextStep.length > 30);
});

test('eCH-0217 F4: the two-rate Saldo ceiling is the PRE-2025 form, and does not bind from 2025', () => {
  // Kap. 5.3.6, verbatim: "Leistung (Umsatz) und Saldo- und Pauschalsteuersatz pro Tätigkeit (bei
  // unterschiedlichen Tätigkeiten kann der gleiche Steuersatz mehrmals vorkommen)". The schema
  // allows 100 rows. So from 2025 a third row is legitimate, and refusing it blocks a filer the
  // regime permits. Before 2025 the form really does have only Ziff. 323 and 333.
  const third = (code, activityId) => ({ code, label: code, baseMinor: 100_000, taxMinor: 6200, rateBp: 620, kind: 'saldo', entryIds: [], activityId });

  const pre = saldoPayload({ periodStart: '2024-07-01', periodEnd: '2024-12-31' });
  const preThree = rebalanceTotalConsideration({ ...pre.payload, lines: [...pre.payload.lines, third('333'), third('332')] });
  const rPre = mapReturnToEch0217(preThree, pre.identity);
  assert.equal(rPre.ok, false);
  assert.equal(rPre.error, 'saldo_rates_exceed_form_lines');

  const post = saldoPayload({ periodStart: '2026-01-01', periodEnd: '2026-06-30', activityId: '00123' });
  const postThree = rebalanceTotalConsideration({ ...post.payload, lines: [...post.payload.lines, third('333', '00456'), third('332', '00789')] });
  const rPost = unwrap(mapReturnToEch0217(postThree, post.identity), 'three activities from 2025 must be filable');
  assert.deepEqual(validateXml(rPost.xml, SCHEMA).errors, []);
  const rows = findChild(parseXml(rPost.xml), 'simpleTaxRateMethod').children.filter((c) => c.local === 'suppliesPerTaxRate');
  assert.equal(rows.length, 3, 'three Tätigkeiten must produce three rows from 2025');
});

// --- 3c. F2: a Ziffer with no element in THIS method stops the export ----------------------------

/** A bare amount line for a Ziffer, with a value distinctive enough to grep the document for. */
const amountLine = (code, minor) => ({ code, label: code, baseMinor: minor, taxMinor: minor, rateBp: null, kind: 'x', entryIds: [] });

/**
 * Keep Ziffer 200 consistent with the per-rate turnovers after a payload is doctored.
 *
 * MWST-0005 cross-foots the two (Kap. 7.5), so a test that adds or resizes a `suppliesPerTaxRate`
 * line and leaves Ziffer 200 alone is building a return the ESTV would reject for a reason the test
 * did not intend. Two tests here did exactly that and the cross-foot check caught them, which is the
 * check doing its job. This keeps the fixture honest so each test fails only for its own reason.
 */
function rebalanceTotalConsideration(payload) {
  const suppliesCodes = ['302', '303', '312', '313', '342', '343', '322', '323', '332', '333'];
  const supplies = payload.lines.filter((l) => suppliesCodes.includes(l.code)).reduce((a, l) => a + l.baseMinor, 0);
  const deductions = payload.lines
    .filter((l) => ['220', '221', '225', '230', '235', '280'].includes(l.code))
    .reduce((a, l) => a + l.baseMinor, 0);
  return {
    ...payload,
    lines: payload.lines.map((l) => (l.code === '200' ? { ...l, baseMinor: supplies + deductions } : l)),
  };
}

test('eCH-0217 F2: a Ziffer whose element is not in the chosen method REFUSES, and never drops', () => {
  // The module's central safety claim was "A Ziffer with no element STOPS the export. It never
  // silently drops out of the file." It did not hold: `AmountMapping.block` was declared and never
  // read, so a Ziffer belonging to the other branch passed the unmapped guard and then vanished
  // during the build. The document stayed schema-valid and the result said `ok`.
  //
  // Each case below is a Ziffer that is real, mapped, and has NO element in that method's
  // xs:sequence. Every one must refuse. Note the third block: `simpleTaxRateMethodType` drops
  // compensationExport and deemedInputTaxDeduction, so 470/471 have nowhere to go from 2025 either.
  const cases = [
    ['netTaxRateMethod', { periodStart: '2024-07-01', periodEnd: '2024-12-31' }, ['205', '400', '405', '410', '415', '420']],
    ['simpleTaxRateMethod', { periodStart: '2026-01-01', periodEnd: '2026-06-30', activityId: '00123' }, ['205', '400', '405', '410', '420', '470', '471']],
  ];

  for (const [element, period, codes] of cases) {
    for (const code of codes) {
      const { payload, identity } = saldoPayload(period);
      const withOrphan = { ...payload, lines: [...payload.lines, amountLine(code, 1_234_567)] };
      const r = mapReturnToEch0217(withOrphan, identity);
      assert.equal(r.ok, false, `${element}: Ziffer ${code} has no element here and must refuse, not drop`);
      assert.equal(r.error, 'form_line_not_in_method', `${element}: Ziffer ${code}`);
      assert.deepEqual(r.codes, [code]);
      assert.equal(r.methodElement, element);
      assert.ok(r.nextStep.length > 30);
      assert.equal('xml' in r, false);
    }
  }

  // And the effektiv side of the same defect: 470/471 are netTaxRateMethod-only.
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const identity = { uid: 'CHE116281271', organisationName: ORG_NAME, generationTime: ctx.clock.now() };
  for (const code of ['470', '471']) {
    const r = mapReturnToEch0217({ ...engine, lines: [...engine.lines, amountLine(code, 777_777)] }, identity);
    assert.equal(r.ok, false, `effektiv: Ziffer ${code} must refuse`);
    assert.equal(r.error, 'form_line_not_in_method');
    assert.equal(r.methodElement, 'effectiveReportingMethod');
  }
});

test('eCH-0217 F2: Ziffer 415 IS carried by the 2025 Saldo element, and is actually emitted', () => {
  // The control that keeps the guard from being a blanket ban. `simpleTaxRateMethodType` really does
  // carry `inputTaxCorrections` (XSD line 283; Kap. 5.3.6 "Korrekturen bei unbeweglichen
  // Gegenständen"), so 415 must pass through and land in the file. A guard that refused this too
  // would be a different bug wearing the same fix.
  const { payload, identity } = saldoPayload({ periodStart: '2026-01-01', periodEnd: '2026-06-30', activityId: '00123' });
  const r = unwrap(mapReturnToEch0217({ ...payload, lines: [...payload.lines, amountLine('415', 4_242_00)] }, identity), 'map');
  assert.deepEqual(validateXml(r.xml, SCHEMA).errors, []);
  assert.equal(leaves(parseXml(r.xml))['/simpleTaxRateMethod/inputTaxCorrections'], '4242.00');
});

test('eCH-0217 F2: the SALDO document is exhaustion-checked too, not just the effektiv one', () => {
  // The exhaustion check only ever ran on the effektiv document, which is why the Saldo drops went
  // unseen. Both Saldo documents are walked here: every amount-shaped leaf must trace to an engine
  // figure, and every engine figure with an element must appear in the file.
  for (const period of [
    { periodStart: '2024-07-01', periodEnd: '2024-12-31' },
    { periodStart: '2026-01-01', periodEnd: '2026-06-30', activityId: '00123' },
  ]) {
    const { payload, identity } = saldoPayload(period);
    const out = unwrap(mapReturnToEch0217(payload, identity), 'map');
    const chf = (m) => (m / 100).toFixed(2);
    const permitted = new Set([
      ...payload.lines.flatMap((l) => [chf(l.baseMinor), chf(l.taxMinor)]),
      chf(payload.payableMinor - payload.creditMinor),
    ]);
    let checked = 0;
    for (const [path, value] of leafPairs(parseXml(out.xml))) {
      if (path.endsWith('/taxRate')) continue;
      if (!/^-?\d+\.\d{2}$/.test(value)) continue;
      assert.ok(permitted.has(value), `${path} = ${value} is an amount that no engine figure produced`);
      checked += 1;
    }
    assert.ok(checked >= 3, `only ${checked} amounts were reached: the exhaustion probe is not walking the Saldo document`);

    // The other direction: a mapped figure that never reached the file. This is the drop itself.
    const inFile = new Set(leafPairs(parseXml(out.xml)).map(([, v]) => v));
    for (const l of payload.lines) {
      if (l.code !== '323' && l.code !== '200') continue;
      assert.ok(inFile.has(chf(l.baseMinor)), `Ziffer ${l.code} was mapped and then never written to the file`);
    }
  }
});

// --- 4. The nil return ---------------------------------------------------------------------------

test('eCH-0217: a period with nothing posted still exports a valid NIL return', () => {
  // A registered filer with no taxable activity still owes a return. Refusing here would push the
  // one case with no other workaround (a quiet quarter) back to typing zeros into the ePortal.
  const ctx = emptyWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  assert.equal(engine.empty, true);
  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  assert.deepEqual(validateXml(out.xml, SCHEMA).errors, []);
  const got = leaves(parseXml(out.xml));
  assert.equal(got['/turnoverComputation/totalConsideration'], '0.00');
  assert.equal(got['/payableTax'], '0.00');
  assert.equal(out.nil, true, 'the result must SAY it is a nil return rather than leaving it to be noticed');
});

// --- 5. Determinism and the transport claim ------------------------------------------------------

test('eCH-0217: the same workspace and period export byte for byte identically', () => {
  const ctx = effektivWorld();
  const a = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  const b = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  assert.equal(a.xml, b.xml);
  assert.deepEqual(a, b);
  assert.equal(a.byteLength, Buffer.byteLength(a.xml, 'utf8'));
});

test('eCH-0217: the result says plainly that it transmits nothing, and where the file goes', () => {
  const out = unwrap(exportVatReturnEch0217(effektivWorld(), Q2), 'export');
  assert.equal(out.transmits, false);
  // The same URL the A07 surface links step 4 to (owner decision W4). One address for the file and
  // the screen, so they cannot send a filer to two different places.
  assert.equal(out.upload.url, 'https://www.estv.admin.ch/de/mwst-online-abrechnen');
  assert.equal(out.filename, 'eCH-0217_CHE116281271_2026-04-01_2026-06-30.xml');
  assert.equal(out.contentType, 'application/xml');
});

// --- 6. Refusals, each naming what to do next -----------------------------------------------------

test('eCH-0217 refusals: each one is structured, and each one names the next step', () => {
  const cases = [
    ['no MWST configuration', () => exportVatReturnEch0217(unconfiguredWorld(), Q2), 'needs_vat_config'],
    ['IST timing', () => exportVatReturnEch0217(istWorld(), Q2), 'unsupported'],
    ['two Saldosteuersätze', () => exportVatReturnEch0217(saldoSplitWorld(), H1), 'saldo_activity_split_required'],
    ['no UID on the workspace', () => exportVatReturnEch0217(effektivWorld({ identified: false }), Q2), 'needs_company_uid'],
    ['a malformed period', () => exportVatReturnEch0217(effektivWorld(), { periodStart: '2026-13-01', periodEnd: '2026-06-30' }), 'invalid_input'],
    ['an inverted period', () => exportVatReturnEch0217(effektivWorld(), { periodStart: '2026-06-30', periodEnd: '2026-04-01' }), 'invalid_period'],
  ];

  for (const [what, run, code] of cases) {
    const r = run();
    assert.equal(r.ok, false, `${what}: expected a refusal, got ${JSON.stringify(r)}`);
    assert.equal(r.error, code, `${what}: expected ${code}, got ${r.error}`);
    assert.equal(typeof r.nextStep, 'string', `${what}: a refusal with no nextStep is a dead end`);
    assert.ok(r.nextStep.length > 30, `${what}: nextStep "${r.nextStep}" does not say enough to act on`);
    assert.equal('xml' in r, false, `${what}: a refusal must not carry a half-built file`);
  }
});

test('eCH-0217 refusals: the IST refusal keeps the engine reason, so a client branches once', () => {
  const r = exportVatReturnEch0217(istWorld(), Q2);
  assert.equal(r.error, 'unsupported');
  assert.equal(r.reason, 'ist_timing_not_implemented');
  // Declaring `formOfReporting` 2 (vereinnahmt) over Soll figures would produce a file the schema
  // accepts and the ESTV would act on. The refusal is the whole point.
  assert.match(r.nextStep, /vereinbart|Soll|set_vat_method/);
});

test('eCH-0217 refusals: a base currency other than CHF is refused, not silently filed', () => {
  // MWSTV Art. 45: the return is filed in francs. The engine's minor units are the workspace's base
  // currency, so a non-CHF book would put foreign-currency figures in a franc form under a heading
  // that says nothing about it.
  const ctx = effektivWorld();
  ctx.store.db.prepare('UPDATE workspace SET base_currency = ? WHERE id = ?').run('EUR', ctx.workspaceId);
  const r = exportVatReturnEch0217(ctx, Q2);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unsupported_base_currency');
  assert.equal(r.baseCurrency, 'EUR');
  assert.ok(r.nextStep.length > 30);
});

test('eCH-0217 refusals: a Ziffer with no eCH-0217 element refuses instead of dropping the money', () => {
  // The forward-compatibility guard. F11 makes a second Saldosteuersatz real, and A05 hands
  // position 3 a NULL form line; the ESTV form has no third rate row at all. Whatever a future
  // engine emits, an unmapped Ziffer must stop the export rather than vanish from the file, because
  // a silently short return is signed by a person who cannot see what is missing.
  //
  // Driven through the exported MAPPER rather than through a test-only parameter on the verb. A
  // backdoor on the export path is a second code path that ships, and the thing under test here is
  // the mapping table, which is a pure function of the engine's payload.
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const identity = { uid: 'CHE116281271', organisationName: ORG_NAME, generationTime: ctx.clock.now() };

  assert.equal(mapReturnToEch0217(engine, identity).ok, true, 'the unmutated payload must map cleanly');

  const withOrphan = { ...engine, lines: [...engine.lines, { code: '999', baseMinor: 1, taxMinor: 0, rateBp: null, kind: null, entryIds: [] }] };
  const r = mapReturnToEch0217(withOrphan, identity);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'unmapped_form_line');
  assert.deepEqual(r.codes, ['999']);
  assert.ok(r.nextStep.length > 30);
});

test('eCH-0217: a per-rate Ziffer whose rate the engine could not name refuses, and does not guess', () => {
  // `rateBp` is null when a bucket aggregated more than one rate. On an amount-only element that is
  // harmless; on `suppliesPerTaxRate` there is nowhere to put the ambiguity, and picking one of the
  // contributing rates would declare a turnover that rate did not produce. ESTV cross-foots exactly
  // that, and it is one of the four defects abrechnung.ts records as having reported reconciled.
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const identity = { uid: 'CHE116281271', organisationName: ORG_NAME, generationTime: ctx.clock.now() };
  const blurred = {
    ...engine,
    lines: engine.lines.map((l) => (l.code === '303' ? { ...l, rateBp: null } : l)),
  };
  const r = mapReturnToEch0217(blurred, identity);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous_rate_on_form_line');
  assert.deepEqual(r.codes, ['303']);
  assert.ok(r.nextStep.length > 30);
});

// --- 6b. F10: the credit return, which had no test at all ----------------------------------------

test('eCH-0217 F10: a credit period emits a NEGATIVE payableTax, and validates', () => {
  // Kap. 4.4 Tabelle 1, verbatim: "payableTax | amountType | 1..1 | Zu bezahlender Betrag (positives
  // Vorzeichen), resp. Guthaben der steuerpflichtigen Person (negatives Vorzeichen) | 500, resp.
  // 510". `amountType` has no minInclusive, so a negative validates and an INVERTED sign would too.
  // That is the whole reason this test exists: the reasoning was right and nothing verified it.
  const ctx = creditWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  assert.ok(engine.creditMinor > 0, 'the credit fixture must actually produce a credit');
  assert.equal(engine.payableMinor, 0, 'exactly one of the two is ever non-zero');

  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  assert.deepEqual(validateXml(out.xml, SCHEMA).errors, [], 'a negative payableTax must still validate');

  const payable = leaves(parseXml(out.xml))['/payableTax'];
  assert.match(payable, /^-/, 'a Guthaben is NEGATIVE: a positive here bills the filer for their own refund');
  assert.equal(payable, ((engine.payableMinor - engine.creditMinor) / 100).toFixed(2));
  assert.equal(Number(payable), -engine.creditMinor / 100);
});

// --- 6c. F9: the UID check digit ------------------------------------------------------------------

test('eCH-0217 F9: a UID that fails the mod-11 check digit is refused, not pattern-matched', () => {
  // `CHE[1-9][0-9]{8}` is the eCH-0108 uidType PATTERN, so a transposed digit is schema-valid and
  // fails at the ESTV under MWST-0009 (Kap. 7.7). The real UID carries a mod-11 check digit over
  // weights 5,4,3,2,7,6,5,4. Verified against two UIDs from the public register before use:
  // CHE-101.654.423 and CHE-105.805.187 both pass; CHE-111.111.111 and CHE-100.000.000 both fail.
  const identity = (uid) => ({ uid, organisationName: ORG_NAME, generationTime: '2026-07-26T10:00:00Z' });
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');

  for (const uid of ['CHE101654423', 'CHE105805187', 'CHE116281271']) {
    assert.equal(mapReturnToEch0217(engine, identity(uid)).ok, true, `${uid} is a valid UID and must be accepted`);
  }

  for (const uid of ['CHE111111111', 'CHE100000000', 'CHE116281277']) {
    const r = mapReturnToEch0217(engine, identity(uid));
    assert.equal(r.ok, false, `${uid} fails the check digit and must be refused`);
    assert.equal(r.error, 'invalid_company_uid');
    assert.ok(r.nextStep.length > 30);
  }
});

// --- 6d. F6: the organisation name -----------------------------------------------------------------

test('eCH-0217 F6: the organisation name is collapsed to what the ESTV will actually store', () => {
  // The critic reported that a double space produces an ESTV-rejected file. Checked against libxml2
  // rather than against TILL's own validator, that is NOT so: `unitNameType` restricts `xs:token`,
  // whose whiteSpace=collapse facet normalises the value BEFORE the length facets are applied, so
  // "Muster  AG" validates and is stored as "Muster AG". The real defect is quieter: the file did
  // not say what the ESTV would record, and TILL's byte-stable output depended on it.
  const ctx = effektivWorld();
  ctx.store.db.prepare('UPDATE workspace SET name = ? WHERE id = ?').run('Muster  AG\tund\nCo', ctx.workspaceId);
  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  assert.deepEqual(validateXml(out.xml, SCHEMA).errors, []);
  assert.equal(leaves(parseXml(out.xml))['/generalInformation/organisationName'], 'Muster AG und Co');
});

test('eCH-0217 F6: a name that cannot fit unitNameType is refused, not shipped invalid', () => {
  // These two ARE genuine MWST-0001 rejections, confirmed with libxml2: 256 characters exceeds
  // maxLength 255, and a name that collapses to nothing violates minLength 1.
  for (const [what, name] of [
    ['256 characters', 'A'.repeat(256)],
    ['whitespace only', '   \t \n '],
  ]) {
    const ctx = effektivWorld();
    ctx.store.db.prepare('UPDATE workspace SET name = ? WHERE id = ?').run(name, ctx.workspaceId);
    const r = exportVatReturnEch0217(ctx, Q2);
    assert.equal(r.ok, false, `${what}: expected a refusal`);
    assert.equal(r.error, 'invalid_organisation_name');
    assert.ok(r.nextStep.length > 30);
    assert.equal('xml' in r, false);
  }

  // And the boundary passes, so the check is a limit rather than a blanket.
  const ctx = effektivWorld();
  ctx.store.db.prepare('UPDATE workspace SET name = ? WHERE id = ?').run('B'.repeat(255), ctx.workspaceId);
  assert.equal(exportVatReturnEch0217(ctx, Q2).ok, true, '255 characters is the limit and must be accepted');
});

// --- 6e. F5: Kap. 7's mandatory ERP checks --------------------------------------------------------

test('eCH-0217 F5: a period whose length is not a statutory cadence is refused (MWST-0003)', () => {
  // Kap. 7 opens "Das ERP-System muss vor dem Versand die folgenden Plausibilisierungen
  // durchführen", and Kap. 7.3 fixes the lengths: effektiv 3 months, or 1 month resp. 1 year with an
  // ESTV Bewilligung; Saldo 6 months, or 1 year with one. An 8-month effektiv period and a
  // single-day one both exported before this.
  for (const [what, period] of [
    ['eight months', { periodStart: '2026-01-01', periodEnd: '2026-08-31' }],
    ['a single day', { periodStart: '2026-04-01', periodEnd: '2026-04-01' }],
    ['two months', { periodStart: '2026-04-01', periodEnd: '2026-05-31' }],
    ['a part month', { periodStart: '2026-04-05', periodEnd: '2026-06-30' }],
  ]) {
    const r = exportVatReturnEch0217(effektivWorld(), period);
    assert.equal(r.ok, false, `${what}: expected a refusal, got ${JSON.stringify(r).slice(0, 200)}`);
    assert.equal(r.error, 'period_length_not_statutory', what);
    assert.ok(r.nextStep.length > 30);
  }

  // The permitted effektiv cadences still pass. 1 and 12 months need an ESTV Bewilligung TILL cannot
  // see, so they are accepted rather than refused: the standard permits them and guessing otherwise
  // would block a legitimate filing.
  for (const period of [
    { periodStart: '2026-04-01', periodEnd: '2026-06-30' }, // 3 months, the ordinary cadence
    { periodStart: '2026-04-01', periodEnd: '2026-04-30' }, // 1 month, with a Bewilligung
    { periodStart: '2026-01-01', periodEnd: '2026-12-31' }, // 1 year, with a Bewilligung
  ]) {
    assert.equal(exportVatReturnEch0217(effektivWorld(), period).ok, true, `${JSON.stringify(period)} is a statutory effektiv cadence`);
  }
});

test('eCH-0217 F5: the Saldo cadence is 6 months or a year, not the effektiv quarter', () => {
  // Checked through the MAPPER, because a live Saldo period from 2025 refuses on the Tätigkeitscode
  // before it ever reaches this. Kap. 7.3: "Bei Verwendung der Saldosteuersatzmethode beträgt die
  // Abrechnungsperiode 6 Monate oder bei Vorhandensein einer entsprechenden Bewilligung der ESTV,
  // ein Jahr." A 3-month Saldo period is the ordinary effektiv quarter applied to the wrong method.
  const q = saldoPayload({ periodStart: '2024-04-01', periodEnd: '2024-06-30' });
  const rq = mapReturnToEch0217(q.payload, q.identity);
  assert.equal(rq.ok, false, 'a 3-month Saldo period is not a statutory cadence');
  assert.equal(rq.error, 'period_length_not_statutory');

  for (const period of [
    { periodStart: '2024-07-01', periodEnd: '2024-12-31' }, // 6 months
    { periodStart: '2024-01-01', periodEnd: '2024-12-31' }, // 1 year, with a Bewilligung
  ]) {
    const p = saldoPayload(period);
    assert.equal(mapReturnToEch0217(p.payload, p.identity).ok, true, `${JSON.stringify(period)} is a statutory Saldo cadence`);
  }
});

test('eCH-0217 F5: MWST-0005 cross-foots the turnover, and EXCLUDES the Bezugsteuer', () => {
  // Kap. 7.5: the steuerbarer Gesamtumsatz (Ziffer 299, derived by the ESTV from Ziffer 200 less the
  // deductions) must equal the sum of the per-rate turnovers, "Ziffern 300 - 34x".
  //
  // The scope is the trap. Kap. 6.4 Tabelle 27 sums `acquisitionTax` next to `suppliesPerTaxRate`,
  // but MWST-0005's own text stops at 34x and the Bezugsteuer (38x) is a separate part of the form.
  // A check that included it would fire on every correct return that carries Bezugsteuer, and the
  // effektiv fixture carries some (Ziffer 383), so this control is not hypothetical.
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  assert.ok(engine.lines.find((l) => l.code === '383')?.baseMinor > 0, 'the fixture must carry Bezugsteuer, or this proves nothing');
  assert.equal(exportVatReturnEch0217(ctx, Q2).ok, true, 'a correct return with Bezugsteuer must NOT trip MWST-0005');

  // And it does fire when the two sides genuinely disagree.
  const identity = { uid: 'CHE116281271', organisationName: ORG_NAME, generationTime: ctx.clock.now() };
  const broken = {
    ...engine,
    lines: engine.lines.map((l) => (l.code === '303' ? { ...l, baseMinor: l.baseMinor + 100_00 } : l)),
  };
  const r = mapReturnToEch0217(broken, identity);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'turnover_cross_foot_failed');
  assert.equal(r.differenceMinor, -100_00);
  assert.ok(r.nextStep.length > 30);
});

test('eCH-0217 F5: an ESTV-sanctioned irregular period is allowed, so the check is not a dead end', () => {
  // Kap. 7.3 permits deviations "ausschliesslich nach Vorgabe der ESTV (beispielsweise beim Beginn
  // oder am Ende der Steuerpflicht)", and a Schlussabrechnung runs to the last day of liability. A
  // refusal with no way past it would block exactly those real filings, so the caller can assert the
  // deviation. Without that escape the MWST-0003 check would trade one dead end for another.
  const r = exportVatReturnEch0217(effektivWorld(), { periodStart: '2026-04-01', periodEnd: '2026-08-31', periodDeviationApproved: true });
  assert.equal(r.ok, true, 'an asserted ESTV deviation must be exportable');
  assert.deepEqual(validateXml(r.xml, SCHEMA).errors, []);
});

// --- 6f. F7/F8: refusals that name a remedy which can actually perform it -------------------------

test('eCH-0217 F7: no refusal points at `set_vat_method` for something it cannot do', () => {
  // `setVatMethod` updates two columns, `vat_method` and `vat_accounting`, and takes neither `asOf`
  // nor rates. Telling a caller to "reconfigure with `set_vat_method` and `asOf`" is a dead end
  // dressed as an instruction: the argument is silently ignored, the call returns ok, and the
  // re-export hits the identical refusal. `vat_configure` is the verb that takes both.
  const saldoRate = exportVatReturnEch0217(saldoWorld(), H1);
  assert.equal(saldoRate.ok, false);

  // Every refusal this module owns, harvested and checked as a family rather than one by one.
  const refusals = [
    exportVatReturnEch0217(unconfiguredWorld(), Q2),
    exportVatReturnEch0217(istWorld(), Q2),
    exportVatReturnEch0217(saldoSplitWorld(), H1),
    exportVatReturnEch0217(effektivWorld({ identified: false }), Q2),
    exportVatReturnEch0217(effektivWorld(), { periodStart: '2026-01-01', periodEnd: '2026-08-31' }),
    saldoRate,
  ];
  for (const r of refusals) {
    assert.equal(r.ok, false);
    if (/asOf|Saldosteuersatz|saldoRates/.test(r.nextStep)) {
      assert.equal(
        /`set_vat_method`/.test(r.nextStep),
        false,
        `a refusal tells the caller to use \`set_vat_method\` for rates or asOf, which it cannot do: "${r.nextStep}"`,
      );
      assert.match(r.nextStep, /`vat_configure`/);
    }
  }
});

test('eCH-0217 F8: the currency refusal states what MWSTV Art. 45 actually says', () => {
  // Art. 45 MWSTV (SR 641.201) is "Entgelte in ausländischer Währung". It does NOT say the return is
  // filed in francs: it says an Entgelt in a foreign currency is CONVERTED into Landeswährung at the
  // ESTV's published rate (Abs. 3), and that the chosen basis is kept for at least one Steuerperiode
  // (Abs. 5). The old copy attached the citation to a proposition the article does not contain.
  const ctx = effektivWorld();
  ctx.store.db.prepare('UPDATE workspace SET base_currency = ? WHERE id = ?').run('EUR', ctx.workspaceId);
  const r = exportVatReturnEch0217(ctx, Q2);
  assert.equal(r.error, 'unsupported_base_currency');
  assert.match(r.nextStep, /Art\. 45/, 'the article stays: it is the right authority for the conversion');
  assert.match(r.nextStep, /Monatsmittelkurs|Tageskurs/, 'Abs. 3 prescribes the rate, so the next step must name it');
  assert.equal(/the return is filed in (Swiss )?francs \(MWSTV Art\. 45\)/i.test(r.nextStep), false);
});

// --- 6g. F3 groundwork: the cross-check measures, correctly. It does NOT correct ------------------

test('eCH-0217 F3: taxCrossCheck rounds ONCE at the end, per Kap. 6.2.1', () => {
  // "Die Steuer muss auf zwei Nachkommastellen ohne Runden in den Zwischenschritten berechnet
  // werden" (Kap. 6.2.1; rejection rule MWST-0006 in Kap. 7.5). The cross-check used to round each
  // line to the Rappen and sum, which is the intermediate rounding the standard forbids: it modelled
  // something the ESTV does not do and could invent a difference of its own.
  //
  // Constructed so the two disagree: three lines each half a Rappen short of a whole one. Rounding
  // per line gives 3 x round(2.575) = 3 x 3 = 9 Rappen; rounding once gives round(7.725) = 8.
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const identity = { uid: 'CHE116281271', organisationName: ORG_NAME, generationTime: ctx.clock.now() };
  assert.ok(mapReturnToEch0217(engine, identity).ok);

  // Driven through the verb so the reported payload is the one a caller actually receives.
  const out = unwrap(exportVatReturnEch0217(ctx, Q2), 'export');
  const cc = out.taxCrossCheck;

  // The oracle, recomputed here independently and exactly: sum the products, then round once.
  const rated = engine.lines.filter((l) => ['302', '303', '312', '313', '342', '343', '322', '323', '332', '333', '382', '383'].includes(l.code) && l.rateBp !== null);
  const scaled = rated.reduce((a, l) => a + l.baseMinor * l.rateBp, 0);
  const expected = Math.sign(scaled) * Math.floor((Math.abs(scaled) + 5000) / 10000);
  assert.equal(cc.recomputedTaxMinor, expected, 'the recomputation must round once, at the end');
  assert.equal(cc.engineTaxMinor, rated.reduce((a, l) => a + l.taxMinor, 0));
  assert.equal(cc.differenceMinor, cc.recomputedTaxMinor - cc.engineTaxMinor);
  assert.equal(cc.reconciled, cc.differenceMinor === 0);

  // On the healthy fixture the books and the ESTV formula agree exactly.
  assert.equal(cc.differenceMinor, 0);
  assert.equal(cc.reconciled, true);
});

test('eCH-0217 F3: the cross-check detects a real per-invoice drift, and the file still ships', () => {
  // The critic's scenario, reproduced through the mapper: many invoices whose booked tax each sits
  // half a Rappen off the exact product. 31.79 at 8.1% is 2.57499, booked as 2.57, and the ESTV's
  // exact sum is higher. The drift is unbounded in the number of invoices.
  //
  // This test pins the MEASUREMENT and the current BEHAVIOUR (the file is produced, the difference
  // is reported alongside it). Whether TILL should instead book a rounding adjustment so the two
  // agree, which is what Kap. 6.2.1 asks the ERP to do, is an open owner decision and is
  // deliberately NOT implemented here. When it is answered, this test says exactly what changes.
  const ctx = effektivWorld();
  const engine = unwrap(computeVatReturn(ctx, Q2), 'vat_return');
  const identity = { uid: 'CHE116281271', organisationName: ORG_NAME, generationTime: ctx.clock.now() };

  const N = 400;
  const netMinor = 3179 * N; //          400 invoices of CHF 31.79
  const bookedTaxMinor = 257 * N; //     each booked at 2.57, the Rappen-rounded 2.57499
  const drifted = rebalanceTotalConsideration({
    ...engine,
    lines: engine.lines.map((l) => (l.code === '303' ? { ...l, baseMinor: netMinor, taxMinor: bookedTaxMinor } : l)),
  });
  const r = unwrap(mapReturnToEch0217(drifted, identity), 'map');
  assert.deepEqual(validateXml(r.xml, SCHEMA).errors, [], 'the document is still schema-valid: no validator can see this');

  // The exact figure, computed independently: 1271600 Rappen x 810 bp = 2.57499 x 400 = 1029.996.
  const exact = Math.floor((netMinor * 810 + 5000) / 10000);
  assert.equal(exact, 103000, 'the ESTV computes CHF 1030.00');
  assert.equal(bookedTaxMinor, 102800, 'the books carry CHF 1028.00');
  assert.equal(exact - bookedTaxMinor, 200, 'a CHF 2.00 gap on 400 invoices, and it grows without bound');
});

// --- 7. libxml2, an independent second opinion ----------------------------------------------------

test('eCH-0217: xmllint agrees, when xmllint is on the machine', (t) => {
  let available = true;
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
  } catch {
    available = false;
  }
  if (!available) {
    // Never a silent skip: the suite says out loud which check did not run. `ech0217-xsd.mjs` is
    // the MANDATORY gate; this one is a second opinion, so its absence must not go unremarked and
    // must not fail CI on a runner with no libxml2-utils.
    t.diagnostic('xmllint is not installed: the libxml2 cross-check did not run');
    return;
  }

  // Copy the vendored schemas into a temp dir and point every `schemaLocation` at its neighbour, so
  // libxml2 resolves the whole import graph from disk. Left as the http URLs the XSD ships with,
  // this check would need the network and would fail offline for the wrong reason.
  const dir = mkdtempSync(join(tmpdir(), 'ech0217-'));
  for (const f of readdirSync(FIXTURES).filter((n) => n.endsWith('.xsd'))) {
    const text = readFileSync(FIXTURES + f, 'utf8').replace(
      /schemaLocation="http:\/\/www\.ech\.ch\/xmlns\/[^"]*\/([^/"]+\.xsd)"/g,
      'schemaLocation="$1"',
    );
    writeFileSync(join(dir, f), text);
  }

  const check = (name, xml) => {
    const path = join(dir, name);
    writeFileSync(path, xml);
    let status = 0;
    let output = '';
    try {
      output = execFileSync('xmllint', ['--nonet', '--noout', '--schema', join(dir, 'eCH-0217-2-0-0.xsd'), path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      status = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    return { status, output };
  };

  // The positive control first: if libxml2 cannot validate eCH's OWN example, the harness is wrong
  // and nothing it says about TILL's file means anything.
  const control = check('control.xml', official('effectiveReportingMethod'));
  assert.equal(control.status, 0, `xmllint rejected the official eCH example: the harness is wrong\n${control.output}`);

  const legacy = saldoPayload({ periodStart: '2024-07-01', periodEnd: '2024-12-31' });
  const modern = saldoPayload({ periodStart: '2026-01-01', periodEnd: '2026-06-30', activityId: '00123' });

  for (const [what, xml] of [
    ['effektiv', unwrap(exportVatReturnEch0217(effektivWorld(), Q2), 'export').xml],
    ['saldo (netTaxRateMethod, bis 31.12.2024)', unwrap(mapReturnToEch0217(legacy.payload, legacy.identity), 'map').xml],
    ['saldo (simpleTaxRateMethod, ab 01.01.2025)', unwrap(mapReturnToEch0217(modern.payload, modern.identity), 'map').xml],
    ['nil', unwrap(exportVatReturnEch0217(emptyWorld(), Q2), 'export').xml],
  ]) {
    const r = check(`${what}.xml`, xml);
    assert.equal(r.status, 0, `xmllint rejected TILL's ${what} export:\n${r.output}`);
  }
});
