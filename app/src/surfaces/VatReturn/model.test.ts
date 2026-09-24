/**
 * A07's read models, tested against the recorded payloads rather than against invented objects.
 *
 * These are the derivations the surface makes on top of what the engine sends, and each one is a
 * place a wrong answer would be invisible on screen: a bridge that reported a difference the engine
 * declined to compute, a period status that flipped a day early, a straddling period whose two rate
 * vintages merged into one row.
 */
import { describe, it, expect } from 'vitest';

import {
  bridgeOf,
  parseVatPeriods,
  parseVatReturn,
  exportRefusalOf,
  parseEch0217,
  periodTitle,
  rateLabel,
  refusalOf,
  renderForm,
  statusOf,
} from './model';

import returnFixture from './vat-return.fixture.json';
import driftFixture from './vat-return.drift.fixture.json';
import saldoFixture from './vat-return.saldo.fixture.json';
import saldoSplitFixture from './vat-return.saldo-split.fixture.json';
import istRefusalFixture from './vat-return.ist-refusal.fixture.json';
import periodsFixture from './vat-periods.fixture.json';

const healthy = parseVatReturn(returnFixture)!;
const drifted = parseVatReturn(driftFixture)!;
const saldo = parseVatReturn(saldoFixture)!;

const allRows = (view: typeof healthy) =>
  renderForm(view).flatMap((section) => [...section.rows, ...section.subRows]);
const rowFor = (view: typeof healthy, code: string) => allRows(view).find((r) => r.code === code);

describe('parseVatReturn', () => {
  it('reads the recorded payload without coercing anything', () => {
    expect(healthy.method).toBe('effektiv');
    expect(healthy.payableMinor).toBe(159620);
    expect(healthy.reconciliation.driftMinor).toBe(0);
  });

  it('returns null rather than a half-read return on a shape it does not recognise', () => {
    // A coerced tax figure is a figure a human signs, so a surprise shape is refused, not patched.
    expect(parseVatReturn({ ok: true })).toBeNull();
    expect(parseVatReturn({ ok: true, method: 'effektiv', lines: [] })).toBeNull();
    expect(parseVatReturn(null)).toBeNull();
  });
});

describe('renderForm', () => {
  it('renders every box on the form, including the ones the ledger never touched', () => {
    const codes = allRows(healthy).map((r) => r.code);
    expect(codes).toContain('303'); // sent by the engine
    expect(codes).toContain('415'); // not sent, and still a box on the form
    expect(codes).toContain('910');
  });

  it('gives a declared total a number and an untouched detail line a null', () => {
    expect(rowFor(healthy, '399')?.taxMinor).toBe(370220);
    expect(rowFor(healthy, '500')?.taxMinor).toBe(159620);
    expect(rowFor(healthy, '415')?.taxMinor).toBeNull();
    expect(rowFor(healthy, '415')?.baseMinor).toBeNull();
  });

  it('leaves 510 empty when there is no credit: a nil credit is a different claim from a nil payable', () => {
    expect(rowFor(healthy, '510')?.taxMinor).toBeNull();
  });

  it('renders the Saldo Steueranrechnung as unknown, never as a nil TILL did not compute', () => {
    for (const code of ['470', '471', '479']) {
      expect(rowFor(saldo, code)?.taxMinor).toBeNull();
      expect(rowFor(saldo, code)?.from).toBe('uncomputed');
    }
  });

  it('renders the Saldo form and not the effektiv one with fields hidden', () => {
    const codes = allRows(saldo).map((r) => r.code);
    expect(codes).toContain('323');
    expect(codes).not.toContain('400'); // no Vorsteuer under Art. 37
    expect(codes).not.toContain('205'); // absent from form DM_0553_03 entirely
    expect(codes).toContain('470');
  });

  it('renders a straddling period as TWO rate rows, never one blended row', () => {
    // The ESTV form prints both vintages side by side and totals them at 399. A single row whose
    // number changes is right by accident for an ordinary period and wrong for a straddle.
    const straddle = parseVatReturn({
      ...returnFixture,
      lines: [
        ...returnFixture.lines,
        { code: '302', label: 'Normal 7,7% (bis 31.12.2023)', baseMinor: 100000, taxMinor: 7700, rateBp: 770, kind: 'output', entryIds: ['e9'] },
      ],
    })!;
    const rows = allRows(straddle).filter((r) => r.code === '303' || r.code === '302');
    expect(rows.map((r) => r.code)).toEqual(['303', '302']);
    expect(rows[1]?.legacy).toBe(true);
    expect(rows[1]?.taxMinor).toBe(7700);
  });

  // Titled without the word "skeleton": `loading-state-convention.test.ts` classifies a block as a
  // LOADING test on that word, and this one has no read to prove. Renaming is the honest fix; an
  // exemption would widen an escape hatch for a test that is not a loading test at all.
  it('appends a Ziffer the form layout does not know rather than dropping its money', () => {
    const odd = parseVatReturn({
      ...returnFixture,
      lines: [
        ...returnFixture.lines,
        { code: '777', label: 'Neue Ziffer', baseMinor: 5000, taxMinor: 400, rateBp: 810, kind: 'output', entryIds: ['e9'] },
      ],
    })!;
    const orphan = allRows(odd).find((r) => r.code === '777');
    expect(orphan).toBeDefined();
    expect(orphan?.taxMinor).toBe(400);
  });

  it('prefers the ENGINE label over the Studio fallback, so the screen matches the form', () => {
    const engineLabel = returnFixture.lines.find((l) => l.code === '303')?.label;
    expect(rowFor(healthy, '303')?.label).toBe(engineLabel);
  });
});

describe('bridgeOf', () => {
  it('reports a clean book as matching', () => {
    expect(bridgeOf(healthy).kind).toBe('match');
    expect(bridgeOf(healthy).unexplainedMinor).toBe(0);
  });

  it('puts the WHOLE difference under unexplained, because the engine attributes none of it', () => {
    const bridge = bridgeOf(drifted);
    expect(bridge.kind).toBe('open');
    expect(bridge.unexplainedMinor).toBe(14850);
    expect(bridge.returnMinor).toBe(370220);
    expect(bridge.bookedMinor).toBe(355370);
  });

  it('declares the Saldo check inapplicable and reports NO difference at all', () => {
    const bridge = bridgeOf(saldo);
    expect(bridge.kind).toBe('notApplicable');
    // The payload carries driftMinor -53229. Surfacing it would report a discrepancy that Art. 37
    // makes structural, so the bridge zeroes it deliberately rather than passing it through.
    expect(bridge.unexplainedMinor).toBe(0);
    expect(saldo.reconciliation.driftMinor).not.toBe(0);
  });

  it('is the ENGINE field, not a Studio derivation: a payload without `bridge` is a shape the surface refuses', () => {
    // G22 (D127) moved the derivation into `src/core/vat/bridge.ts`; the engine's own suite proves the
    // four kinds. Here the surface proves it no longer invents one when the engine sent none.
    const { bridge: _bridge, ...withoutBridge } = returnFixture as Record<string, unknown>;
    expect(parseVatReturn(withoutBridge)).toBeNull();
    const noAccount = parseVatReturn({
      ...returnFixture,
      bridge: { ...(returnFixture as { bridge: Record<string, unknown> }).bridge, kind: 'noAccount' },
    })!;
    expect(bridgeOf(noAccount).kind).toBe('noAccount');
  });
});

describe('statusOf', () => {
  const periods = parseVatPeriods(periodsFixture)!.periods;
  const q2 = periods.find((p) => p.label === '2026-Q2')!;

  it('reads a period that has ended as ready', () => {
    expect(statusOf(q2, '2026-08-15')).toBe('ready');
  });

  it('reads a period that is still running as open, INCLUDING its last day', () => {
    // The boundary is the defect this pins: a period ending 30.06 is still running ON 30.06, and
    // a filer cannot honestly declare a period that has not finished.
    expect(statusOf(q2, '2026-06-30')).toBe('open');
    expect(statusOf(q2, '2026-07-01')).toBe('ready');
  });

  it('lets a filing lock outrank the calendar', () => {
    expect(statusOf({ ...q2, filed: true }, '2026-05-01')).toBe('filed');
  });
});

describe('refusalOf', () => {
  it('reads the two-rate Saldo refusal and keeps the rates the engine named', () => {
    const refusal = refusalOf(saldoSplitFixture, 422)!;
    expect(refusal.kind).toBe('saldoSplit');
    expect(refusal.rates).toEqual([
      { position: 1, rateBp: 620 },
      { position: 2, rateBp: 530 },
    ]);
  });

  it('reads the IST refusal, which no UX document names', () => {
    expect(refusalOf(istRefusalFixture, 422)?.kind).toBe('istTiming');
  });

  it('does not swallow an unrelated `unsupported`, which would hide a real failure', () => {
    expect(refusalOf({ ok: false, error: 'unsupported', reason: 'something_else' }, 422)).toBeNull();
  });

  it('reads a 403 as denied even when the body says nothing useful', () => {
    expect(refusalOf({}, 403)?.kind).toBe('permissionDenied');
  });

  it('returns null on a rejection it does not recognise, so it lands in the error banner', () => {
    expect(refusalOf({ ok: false, error: 'boom' }, 500)).toBeNull();
  });
});

describe('exportRefusalOf: twelve codes, four remedies', () => {
  const band = (error: string, extra: Record<string, unknown> = {}, status = 422) =>
    exportRefusalOf({ ok: false, error, ...extra }, status).band;

  it('puts both UID codes on the one remedy that fixes them', () => {
    expect(band('needs_company_uid')).toBe('uid');
    expect(band('invalid_company_uid')).toBe('uid');
  });

  it('sends the ambiguous rate to the ledger, not to a settings screen', () => {
    expect(band('ambiguous_rate_on_form_line', { codes: ['303'] })).toBe('rateSplit');
    expect(exportRefusalOf({ ok: false, error: 'ambiguous_rate_on_form_line', codes: ['303', '313'] }, 422).codes).toEqual([
      '303',
      '313',
    ]);
  });

  it('groups the three unfilable causes, which differ in cause and agree on the next step', () => {
    expect(band('unmapped_form_line', { codes: ['415'] })).toBe('byHand');
    expect(band('saldo_rates_exceed_form_lines', { configuredRates: 3 })).toBe('byHand');
    expect(band('unsupported_base_currency', { baseCurrency: 'EUR' })).toBe('byHand');
    // The detail each cause line needs is carried through rather than flattened away.
    expect(exportRefusalOf({ ok: false, error: 'unsupported_base_currency', baseCurrency: 'EUR' }, 422).baseCurrency).toBe('EUR');
    expect(exportRefusalOf({ ok: false, error: 'saldo_rates_exceed_form_lines', configuredRates: 3 }, 422).configuredRates).toBe(3);
  });

  it('routes all six inherited compute refusals to a re-read, so the form panel says them once', () => {
    for (const code of [
      'needs_vat_config',
      'unsupported',
      'saldo_activity_split_required',
      'saldo_rate_not_valid_for_period',
      'invalid_input',
      'invalid_period',
    ]) {
      expect(band(code), code).toBe('recompute');
    }
  });

  it('does not dress an unknown rejection, or a 403, as a remedy the reader cannot perform', () => {
    expect(band('boom', {}, 500)).toBe('failed');
    expect(exportRefusalOf({}, 403)).toMatchObject({ band: 'failed', code: 'permission_denied' });
  });
});

describe('parseEch0217: the artifact and the cross-check that ships with it', () => {
  const payload = {
    ok: true,
    filename: 'eCH-0217_CHE116281277_2026-04-01_2026-06-30.xml',
    contentType: 'application/xml',
    xml: '<?xml version="1.0" encoding="UTF-8"?>\n<eCH-0217:VATDeclaration/>\n',
    byteLength: 66,
    transmits: false,
    taxCrossCheck: { recomputedTaxMinor: 370223, engineTaxMinor: 370220, differenceMinor: 3 },
  };

  it('takes the filename, the media type and the markup from the ENGINE, never from the surface', () => {
    const artifact = parseEch0217(payload)!;
    expect(artifact.filename).toBe('eCH-0217_CHE116281277_2026-04-01_2026-06-30.xml');
    expect(artifact.contentType).toBe('application/xml');
    expect(artifact.xml).toBe(payload.xml);
    expect(artifact.crossCheck).toEqual({ recomputedTaxMinor: 370223, engineTaxMinor: 370220, differenceMinor: 3 });
  });

  it('refuses a payload with no markup rather than saving an empty file', () => {
    expect(parseEch0217({ ...payload, xml: '' })).toBeNull();
    expect(parseEch0217({ ...payload, filename: undefined })).toBeNull();
    expect(parseEch0217('nope')).toBeNull();
  });

  it('keeps the file when the cross-check is absent: the check is a disclosure, not a gate', () => {
    const artifact = parseEch0217({ ...payload, taxCrossCheck: undefined })!;
    expect(artifact.xml).toBe(payload.xml);
    expect(artifact.crossCheck).toBeNull();
  });
});

describe('formatting helpers', () => {
  it('reads a period label the way a Swiss filer says it', () => {
    expect(periodTitle('2026-Q2')).toBe('Q2/2026');
    expect(periodTitle('2026-H1')).toBe('H1/2026');
    expect(periodTitle('nonsense')).toBe('nonsense');
  });

  it('renders a rate in the percent form the ESTV ladder is published in', () => {
    expect(rateLabel(620)).toBe('6.2');
    expect(rateLabel(10)).toBe('0.1');
  });
});
