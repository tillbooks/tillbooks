// @ts-check
/**
 * The A07 STUDIO fixture-versus-engine drift guard.
 *
 * This closes the mechanism behind the defect family this repo has now shipped seven times: "the
 * Studio assumed a shape the engine never sends". The cheapest version is a fixture more generous
 * than the engine, which agrees with the consumer's bug instead of with the product. On a VAT return
 * it is also the most expensive version, because the figures on that screen are figures a human
 * signs and sends to a tax authority.
 *
 * A07 EARNED THIS GUARD THE HARD WAY. It shipped three filing-grade defects to its critic (a
 * duplicated Ziffer, a merged rate vintage, an inverted sign) and every one of them came back
 * `reconciled: true`, because the 2200 total was right the whole time. A total-level check is blind
 * to how the money is distributed across the form, so this file checks the DISTRIBUTION.
 *
 * ## Five halves, and all of them have to hold
 *
 *  1. PRESENT: every recording is the live answer, VALUE for value, through `deepEqual`. Not keys
 *     and kinds. `test/sales/invoice-gui-fixture.test.mjs` is the reason: a keys-and-kinds
 *     comparison let a fixture spelling Zürich in ASCII sit against a seed spelling it with the
 *     umlaut and pass green.
 *  2. ABSENT: the engine does NOT send the six fields the A07 design was tempted to read. The
 *     reconciliation carries no input-tax side, no net side and no causes (§3.2 asks for three
 *     checks and §3.3 for classified causes, and neither exists); a period carries no status word
 *     (F13); no payload carries a currency; and there is no export artifact anywhere. A surface
 *     reading any of them would render `undefined` under a passing reconciliation mark.
 *  3. LOAD-BEARING: the recordings differ in the ways the surface branches on. A "drift" recording
 *     that reconciled, a "saldo" recording whose check was applicable, or an "empty" recording with
 *     figures in it would each leave the hardest state on the surface rendered against a payload
 *     that cannot produce it.
 *  4. THE ESTV FORM LABELS AGREE, STRING FOR STRING, between the engine's transcription and the
 *     Studio's form skeleton. Two copies of a tax-form label with nothing comparing them is how a
 *     screen stops matching the document it exists to reproduce.
 *  5. THE DESIGN'S AND THE SURFACE'S OWN ENGINE CLAIMS, re-proved here rather than trusted. The
 *     surface ships with no primary action on the strength of "there is no export verb", and shows
 *     an IST refusal on the strength of "the engine will not compute one". The day either stops
 *     being true, this file fails loudly instead of the surface staying wrong for a reason that
 *     expired.
 *
 * Every scan asserts its own corpus is non-empty, so a broken path or a renamed file cannot make
 * this file pass by finding nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ESTV_FORM_LINE_LABELS,
  ESTV_FORM_LINE_LABELS_SALDO,
  SALDO_PER_POSITION_LAST_DAY,
} from '../../dist/core/vat/index.js';
import { ACTIONS } from '../../dist/api/registry.js';

import {
  liveEffektivSoll,
  liveDrift,
  liveEmpty,
  liveSaldo,
  liveSaldoSplit,
  liveIstRefusal,
  liveNeedsConfig,
  liveFiled,
} from './studio-vat-return-world.mjs';

const DIR = new URL('../../app/src/surfaces/VatReturn/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, DIR), 'utf8'));
const plain = (value) => JSON.parse(JSON.stringify(value));

const RETURN = read('vat-return.fixture.json');
const PERIODS = read('vat-periods.fixture.json');
const DRIFT = read('vat-return.drift.fixture.json');
const EMPTY = read('vat-return.empty.fixture.json');
const SALDO = read('vat-return.saldo.fixture.json');
const SALDO_PERIODS = read('vat-periods.saldo.fixture.json');
const SALDO_SPLIT = read('vat-return.saldo-split.fixture.json');
const IST = read('vat-return.ist-refusal.fixture.json');
const NEEDS_CONFIG = read('vat-return.needs-config.fixture.json');
const FILED_PERIODS = read('vat-periods.filed.fixture.json');

// --- 1. PRESENT ---------------------------------------------------------------------------------

test('A07 fixtures: every recording is the live engine answer, value for value', () => {
  const healthy = liveEffektivSoll();
  assert.deepEqual(RETURN, plain(healthy.return));
  assert.deepEqual(PERIODS, plain(healthy.periods));

  assert.deepEqual(DRIFT, plain(liveDrift()));
  assert.deepEqual(EMPTY, plain(liveEmpty().return));

  const saldo = liveSaldo();
  assert.deepEqual(SALDO, plain(saldo.return));
  assert.deepEqual(SALDO_PERIODS, plain(saldo.periods));

  assert.deepEqual(SALDO_SPLIT, plain(liveSaldoSplit()));
  assert.deepEqual(IST, plain(liveIstRefusal()));
  assert.deepEqual(NEEDS_CONFIG, plain(liveNeedsConfig().return));
  assert.deepEqual(FILED_PERIODS, plain(liveFiled().periods));
});

// --- 2. ABSENT ----------------------------------------------------------------------------------

test('A07 fixtures: the reconciliation carries ONE check and no causes, whatever the design asked for', () => {
  // §3.2 wants Vorsteuer and Netto comparisons beside the Umsatzsteuer one; §3.3 wants the drift
  // attributed to named causes. Neither exists. The bridge renders one check and puts the whole
  // difference under `ungeklärt`, and it must keep doing that until these keys appear.
  assert.deepEqual(
    Object.keys(RETURN.reconciliation).sort(),
    ['applicable', 'driftMinor', 'outputVatAccount', 'outputVatBookedMinor'],
  );
  for (const absent of ['inputVatBookedMinor', 'inputDriftMinor', 'netDriftMinor', 'causes', 'explained']) {
    assert.equal(absent in RETURN.reconciliation, false, `the engine now sends reconciliation.${absent}`);
    assert.equal(absent in RETURN, false, `the engine now sends ${absent}`);
  }
});

test('A07 fixtures: no payload carries a currency, which is why the surface reads the company profile', () => {
  for (const payload of [RETURN, SALDO, EMPTY, DRIFT]) {
    assert.equal('currency' in payload, false);
    assert.equal('baseCurrency' in payload, false);
  }
});

test('A07 fixtures: a period carries `filed` and no status word (design finding F13)', () => {
  assert.ok(PERIODS.periods.length > 0);
  for (const period of PERIODS.periods) {
    assert.deepEqual(Object.keys(period).sort(), ['filed', 'label', 'months', 'periodEnd', 'periodStart']);
    assert.equal('status' in period, false, 'the engine now sends a status word: move the derivation out of the Studio');
  }
});

test('A07 fixtures: a return line carries no vintage flag, so the Studio derives it from the Ziffer', () => {
  assert.ok(RETURN.lines.length > 0);
  for (const line of RETURN.lines) {
    assert.deepEqual(
      Object.keys(line).sort(),
      ['baseMinor', 'code', 'entryIds', 'kind', 'label', 'rateBp', 'taxMinor'],
    );
  }
});

// --- 3. LOAD-BEARING ----------------------------------------------------------------------------

test('A07 fixtures: each recording really is the state it is named for', () => {
  // Healthy: reconciles, is not empty, and carries more than one rate on each side. A one-rate
  // recording would agree with a "multiply everything by the Normalsatz" mutation.
  assert.equal(RETURN.reconciled, true);
  assert.equal(RETURN.empty, false);
  assert.equal(RETURN.reconciliation.driftMinor, 0);
  const outputRates = new Set(RETURN.lines.filter((l) => l.taxMinor > 0).map((l) => l.rateBp));
  assert.ok(outputRates.size > 1, 'the healthy recording must carry more than one rate');

  // Drift: does NOT reconcile. This is the warn state, and it cannot be recorded from a clean book.
  assert.equal(DRIFT.reconciled, false);
  assert.notEqual(DRIFT.reconciliation.driftMinor, 0);

  // Empty: empty, with the totals at zero and no tax on any line.
  assert.equal(EMPTY.empty, true);
  assert.equal(EMPTY.totalTaxDueMinor, 0);
  assert.equal(EMPTY.payableMinor, 0);

  // Saldo: the check is DECLINED rather than failed, and there is no Vorsteuer at all (Art. 37).
  assert.equal(SALDO.method, 'saldo');
  assert.equal(SALDO.reconciled, null);
  assert.equal(SALDO.reconciliation.applicable, false);
  assert.equal(SALDO.totalInputTaxMinor, 0);
  // AND the payload still carries a large non-zero drift beside it. This is the whole reason the
  // surface must not render that number: it is not an error, it is Art. 37 working as designed.
  assert.notEqual(SALDO.reconciliation.driftMinor, 0);

  // Filed: exactly one period reports filed.
  assert.equal(FILED_PERIODS.periods.filter((p) => p.filed).length, 1);
});

test('A07 fixtures: each refusal really refuses, with the code the surface branches on', () => {
  assert.equal(NEEDS_CONFIG.ok, false);
  assert.equal(NEEDS_CONFIG.error, 'needs_vat_config');

  assert.equal(SALDO_SPLIT.ok, false);
  assert.equal(SALDO_SPLIT.error, 'saldo_activity_split_required');
  assert.equal(SALDO_SPLIT.rates.length, 2, 'the refusal must name the rates back, or the panel has nothing to list');

  assert.equal(IST.ok, false);
  assert.equal(IST.error, 'unsupported');
  assert.equal(IST.reason, 'ist_timing_not_implemented');
});

test('A07 fixtures: the cadences the engine emits are Q and H, and nothing else', () => {
  // MWSTG Art. 35 Abs. 1bis has allowed monthly and annual filing on application since 1.1.2025 and
  // A05 stores no elected-frequency field, so neither can be derived. A monthly or annual filer
  // cannot pick their period at all. The day that changes, this assertion fails and the picker's
  // module comment stops being true in the right direction.
  for (const period of PERIODS.periods) assert.match(period.label, /^\d{4}-Q[1-4]$/);
  for (const period of SALDO_PERIODS.periods) assert.match(period.label, /^\d{4}-H[12]$/);
});

// --- 4. THE FORM LABELS AGREE -------------------------------------------------------------------

/**
 * The Studio's fallback label table, read out of `form-lines.ts` as TEXT.
 *
 * Reading the source rather than importing it: this is a `.mjs` node suite and the module is TSX-era
 * TypeScript that never reaches `dist/`. Parsing the literal is what lets a node test make a claim
 * about a Studio file, and it is the same technique `loading-state-convention.test.ts` uses from the
 * other side.
 */
function studioLabels() {
  const source = readFileSync(new URL('form-lines.ts', DIR), 'utf8');
  const block = /const L = \{([\s\S]*?)\n\} as const;/.exec(source);
  assert.ok(block !== null && block[1] !== undefined, 'the label table in form-lines.ts could not be found: has it been renamed?');
  const body = block[1];
  const out = {};
  const entry = /'([0-9_a-z]+)':\s*\n?\s*'((?:[^'\\]|\\.)*)'/g;
  let match;
  while ((match = entry.exec(body)) !== null) out[match[1]] = match[2];
  assert.ok(Object.keys(out).length > 20, 'the label scan found almost nothing: the probe is wrong, not the code');
  return out;
}

test('A07 form labels: the Studio and the engine transcribe the ESTV form identically', () => {
  const studio = studioLabels();
  let compared = 0;
  for (const [code, engineLabel] of Object.entries(ESTV_FORM_LINE_LABELS)) {
    const mine = studio[code];
    if (mine === undefined) continue;
    assert.equal(mine, engineLabel, `Ziffer ${code} reads differently in the Studio than in the engine`);
    compared += 1;
  }
  assert.ok(compared > 20, `only ${compared} labels were compared: the scan is finding too little`);
});

test('A07 form labels: the SALDO overrides agree too, under the `_saldo` suffix', () => {
  const studio = studioLabels();
  let compared = 0;
  for (const [code, engineLabel] of Object.entries(ESTV_FORM_LINE_LABELS_SALDO)) {
    const mine = studio[`${code}_saldo`] ?? studio[code];
    assert.ok(mine !== undefined, `the Studio has no label for the Saldo Ziffer ${code}`);
    assert.equal(mine, engineLabel, `Saldo Ziffer ${code} reads differently in the Studio than in the engine`);
    compared += 1;
  }
  assert.ok(compared >= 5, `only ${compared} Saldo labels were compared`);
});

test('A07 §3.1a: the Studio draws the Saldo regime boundary on the engine\'s day, not a day either side', () => {
  // The Studio cannot import engine modules, so `SALDO_PER_POSITION_LAST_DAY` exists twice. A day of
  // drift between the two copies is invisible in both suites and shows up as a 333 box rendered
  // beside a figure the engine has already folded into 323, on a statutory screen.
  const source = readFileSync(new URL('form-lines.ts', DIR), 'utf8');
  const match = /export const SALDO_PER_POSITION_LAST_DAY = '(\d{4}-\d{2}-\d{2})';/.exec(source);
  assert.ok(match !== null, 'form-lines.ts no longer declares SALDO_PER_POSITION_LAST_DAY: has it been renamed?');
  assert.equal(
    match[1],
    SALDO_PER_POSITION_LAST_DAY,
    'the Studio and the engine disagree about the last day the ESTV form numbered Saldo rows per rate position',
  );
  // The probe is reading a real date rather than matching an empty capture.
  assert.match(SALDO_PER_POSITION_LAST_DAY, /^\d{4}-\d{2}-\d{2}$/);
});

test('A07 form labels: every Ziffer the engine can emit has a box in the Studio form', () => {
  const studio = studioLabels();
  for (const code of Object.keys(ESTV_FORM_LINE_LABELS)) {
    assert.ok(
      studio[code] !== undefined,
      `Ziffer ${code} exists in the engine and has no box in form-lines.ts: its figure would be appended as an orphan`,
    );
  }
});

// --- 5. THE SURFACE'S OWN ENGINE CLAIMS ---------------------------------------------------------

test('A07 claims: the export verb EXISTS, so the primary-action slot is now claimable', () => {
  // THIS TEST USED TO ASSERT THE OPPOSITE, and it was right to.
  //
  // A07's GUI landed against owner decision D43/W3, which makes the export the ONE primary action on
  // the MWST-Abrechnung surface. No export verb existed, so rather than ship a disabled button in
  // the accent slot the surface shipped with no primary action at all, and this test asserted the
  // verb's ABSENCE precisely so that it would go red the moment one landed and tell the next agent
  // to claim the slot. It has now done its job: `vat_export_ech0217` is registered.
  //
  // WHAT IS STILL OPEN, said here because a test is where a reader looks. The ENGINE side is done
  // (verb, MCP tool, REST twin, conformance scenario). The SURFACE has not moved: app/src/surfaces/
  // VatReturn/ still renders no primary action and its own test still pins the copy "TILL erstellt
  // die eCH-0217-Datei noch nicht", which is now FALSE. Closing that is a Studio change and belongs
  // to whoever claims the slot.
  const names = ACTIONS.map((a) => a.name);
  assert.ok(names.length > 50, 'the action scan found almost nothing: the probe is wrong');
  // A07's four now. The wider `vat_*` family belongs to A05 and A06 and is deliberately not pinned
  // here: this test is about what A07 can and cannot do.
  for (const verb of ['vat_return', 'vat_periods', 'vat_mark_filed', 'vat_export_ech0217']) {
    assert.ok(names.includes(verb), `${verb} is gone: the surface reads it`);
  }
  // A07's eCH-0217 machine file (the surface's primary-action slot) is one of two VAT-named export
  // verbs now: A25 (Treuhänder review & export) added `export_vat`, the fiduciary filing extract of
  // the same figures, which is a DIFFERENT artifact for a different surface and gated on `export`
  // rather than being A07's. Both must exist; neither is the other. A07's slot still reads the
  // eCH-0217 verb, pinned above.
  const exportVerbs = names.filter((n) => /export/.test(n) && /vat|mwst|ech/.test(n)).sort();
  assert.deepEqual(
    exportVerbs,
    ['export_vat', 'vat_export_ech0217'],
    "A07's eCH-0217 export plus A25 review & export's export_vat: two distinct VAT export verbs",
  );
});

test('A07 claims: `vat_mark_filed` is a write and `vat_return` a read, which is what the gating assumes', () => {
  const byName = new Map(ACTIONS.map((a) => [a.name, a]));
  const kindOf = (name) => {
    const action = byName.get(name);
    assert.ok(action !== undefined, `${name} is not registered at all`);
    return action.kind;
  };
  assert.equal(kindOf('vat_return'), 'read');
  assert.equal(kindOf('vat_periods'), 'read');
  assert.equal(kindOf('vat_mark_filed'), 'write');
  // The export is a READ: it produces a file and persists nothing. That is what lets the surface put
  // it in the primary slot without the confirm-and-lock treatment `vat_mark_filed` needs, and it is
  // asserted rather than assumed because the gating branches on `kind`.
  assert.equal(kindOf('vat_export_ech0217'), 'read');
});
