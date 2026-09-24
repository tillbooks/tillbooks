/**
 * A07's read models: the return, the periods, the bridge, and the refusals.
 *
 * Every parser here returns `null` on a shape it does not recognise rather than coercing, because a
 * coerced tax figure is a figure a human signs. Nothing in this file invents a number: the one
 * derivation it performs (the bridge) is subtraction over two figures the engine sent, and the one
 * classification it performs (period status) is a reading of two booleans.
 */

import { LEGACY_OF, fallbackLabel, formSections, type FormRowSpec } from './form-lines';

// --- the return ------------------------------------------------------------------------------

export interface ReturnLine {
  code: string;
  label: string;
  baseMinor: number;
  taxMinor: number;
  rateBp: number | null;
  kind: string | null;
  entryIds: string[];
}

export interface VatReturnView {
  method: 'effektiv' | 'saldo';
  timing: string;
  vintage: string;
  periodStart: string;
  periodEnd: string;
  lines: ReturnLine[];
  totalTaxDueMinor: number;
  totalInputTaxMinor: number;
  payableMinor: number;
  creditMinor: number;
  empty: boolean;
  /** `null` on Saldo, where the engine declines the comparison rather than failing it. */
  reconciled: boolean | null;
  /**
   * The Abstimmung bridge, DERIVED BY THE ENGINE (G22, D127: `src/core/vat/bridge.ts`) so the
   * "geprüft" step here and the `abstimmung_resolved` checklist check are one derivation. A payload
   * without it is a shape this surface refuses to read.
   */
  bridge: Bridge;
  reconciliation: {
    applicable: boolean;
    outputVatAccount: string;
    outputVatBookedMinor: number;
    driftMinor: number;
  };
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export function parseVatReturn(body: unknown): VatReturnView | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const method = str(b.method);
  if (method !== 'effektiv' && method !== 'saldo') return null;
  if (!Array.isArray(b.lines)) return null;

  const recon = b.reconciliation;
  if (typeof recon !== 'object' || recon === null) return null;
  const r = recon as Record<string, unknown>;

  const totalTaxDueMinor = num(b.totalTaxDueMinor);
  const totalInputTaxMinor = num(b.totalInputTaxMinor);
  const payableMinor = num(b.payableMinor);
  const creditMinor = num(b.creditMinor);
  const bookedMinor = num(r.outputVatBookedMinor);
  const driftMinor = num(r.driftMinor);
  if (
    totalTaxDueMinor === null ||
    totalInputTaxMinor === null ||
    payableMinor === null ||
    creditMinor === null ||
    bookedMinor === null ||
    driftMinor === null
  ) {
    return null;
  }

  const bridge = parseBridge(b.bridge);
  if (bridge === null) return null;

  const lines: ReturnLine[] = [];
  for (const raw of b.lines) {
    if (typeof raw !== 'object' || raw === null) return null;
    const l = raw as Record<string, unknown>;
    const code = str(l.code);
    const baseMinor = num(l.baseMinor);
    const taxMinor = num(l.taxMinor);
    if (code === null || baseMinor === null || taxMinor === null) return null;
    lines.push({
      code,
      label: str(l.label) ?? fallbackLabel(code, method === 'saldo'),
      baseMinor,
      taxMinor,
      rateBp: num(l.rateBp),
      kind: str(l.kind),
      entryIds: Array.isArray(l.entryIds) ? l.entryIds.filter((x): x is string => typeof x === 'string') : [],
    });
  }

  return {
    method,
    timing: str(b.timing) ?? 'soll',
    vintage: str(b.vintage) ?? 'current',
    periodStart: str(b.periodStart) ?? '',
    periodEnd: str(b.periodEnd) ?? '',
    lines,
    totalTaxDueMinor,
    totalInputTaxMinor,
    payableMinor,
    creditMinor,
    empty: b.empty === true,
    reconciled: typeof b.reconciled === 'boolean' ? b.reconciled : null,
    bridge,
    reconciliation: {
      applicable: r.applicable === true,
      outputVatAccount: str(r.outputVatAccount) ?? '',
      outputVatBookedMinor: bookedMinor,
      driftMinor,
    },
  };
}

// --- the rendered form -----------------------------------------------------------------------

export interface FormRow extends FormRowSpec {
  /** The turnover / Leistungen figure, or null when the box is empty (renders `-`). */
  baseMinor: number | null;
  /** The tax figure, or null when the box is empty. */
  taxMinor: number | null;
  /** Contributing entries, for the drill-down. Empty when there is nothing to drill into. */
  entryIds: string[];
  /** True for a `bis 31.12.2023` row rendered beside its current sibling. */
  legacy: boolean;
}

export interface RenderedSection {
  titleKey: string;
  subheadKey?: string;
  rows: FormRow[];
  subRows: FormRow[];
}

/**
 * Fill the form skeleton from the payload.
 *
 * A `line` row with no matching Ziffer renders `-`: the ledger produced nothing of that kind. A
 * `total` row always renders a number, because a filer looking at "Zu bezahlender Betrag" needs to
 * tell zero from unknown, and on a declared box the answer is never unknown. A `uncomputed` row
 * renders `-` whatever the payload says, because TILL does not produce that figure at all.
 */
export function renderForm(view: VatReturnView): RenderedSection[] {
  const byCode = new Map(view.lines.map((l) => [l.code, l]));
  const used = new Set<string>();
  const saldo = view.method === 'saldo';

  const fill = (spec: FormRowSpec): FormRow[] => {
    if (spec.from === 'uncomputed') {
      return [{ ...spec, baseMinor: null, taxMinor: null, entryIds: [], legacy: false }];
    }
    if (spec.from === 'total') {
      const totals: Record<string, number> = {
        '399': view.totalTaxDueMinor,
        '479': view.totalInputTaxMinor,
        '500': view.payableMinor,
        '510': view.creditMinor,
      };
      const value = totals[spec.code] ?? 0;
      // 510 is a declared box the filer only fills when there IS a credit. A zero there is not the
      // same claim as a zero on 500, so it renders `-` rather than a nil credit.
      const show = spec.declared === true || value !== 0;
      return [{ ...spec, baseMinor: null, taxMinor: show ? value : null, entryIds: [], legacy: false }];
    }

    const out: FormRow[] = [];
    const current = byCode.get(spec.code);
    used.add(spec.code);
    out.push({
      ...spec,
      label: current?.label ?? spec.label,
      baseMinor: current === undefined ? (spec.declared === true ? 0 : null) : current.baseMinor,
      taxMinor:
        spec.column === 'turnover'
          ? null
          : current === undefined
            ? spec.declared === true
              ? 0
              : null
            : current.taxMinor,
      entryIds: current?.entryIds ?? [],
      legacy: false,
    });

    const legacyCode = LEGACY_OF[spec.code];
    const legacy = legacyCode === undefined ? undefined : byCode.get(legacyCode);
    if (legacyCode !== undefined) used.add(legacyCode);
    if (legacy !== undefined) {
      out.push({
        ...spec,
        code: legacyCode as string,
        label: legacy.label,
        baseMinor: legacy.baseMinor,
        taxMinor: spec.column === 'turnover' ? null : legacy.taxMinor,
        entryIds: legacy.entryIds,
        legacy: true,
      });
    }
    return out;
  };

  const sections = formSections(view.method, view.periodEnd).map((section) => ({
    titleKey: section.titleKey,
    ...(section.subheadKey === undefined ? {} : { subheadKey: section.subheadKey }),
    rows: section.rows.flatMap(fill),
    subRows: (section.subRows ?? []).flatMap(fill),
  }));

  // A Ziffer the engine sent that the skeleton has no box for is APPENDED rather than dropped. A
  // figure with no box is money silently leaving the form, and the skeleton being out of date is a
  // reason to show the row loudly, not to hide it.
  const orphans = view.lines
    .filter((l) => !used.has(l.code))
    .map<FormRow>((l) => ({
      code: l.code,
      label: l.label || fallbackLabel(l.code, saldo),
      from: 'line',
      column: l.taxMinor === 0 ? 'turnover' : 'both',
      baseMinor: l.baseMinor,
      taxMinor: l.taxMinor === 0 ? null : l.taxMinor,
      entryIds: l.entryIds,
      legacy: false,
    }));
  if (orphans.length > 0) {
    sections.push({ titleKey: 'vat.return.section.unmapped', rows: orphans, subRows: [] });
  }

  return sections;
}

// --- the Abstimmung --------------------------------------------------------------------------

/**
 * The bridge, and it is ONE check rather than the three the design asked for.
 *
 * The engine compares Ziff. 399 against the movement on 2200 and sends nothing else: no input-tax
 * comparison, no net comparison, and no attribution of the difference to a cause. The design's §3.2
 * asks for three checks and §3.3 for classified causes. Rendering three headings over one figure, or
 * an "explained" row with nothing behind it, would be the surface claiming work the engine did not
 * do. So the bridge renders the check that exists, and the whole difference lands in `ungeklärt`,
 * which the design itself calls the honest degradation: the operator does more of the looking, and
 * the number they are looking at is real.
 *
 * ON SALDO THERE IS NO CHECK AT ALL, and the payload's `driftMinor` must not be shown. The recorded
 * one-rate Saldo fixture carries `applicable: false` beside a drift of CHF -532.29, which is not an
 * error: under Art. 37 the VAT invoiced and the VAT owed are different figures by construction. A
 * surface that printed that number would be reporting a discrepancy the engine explicitly declined
 * to compute.
 */
export type BridgeKind = 'match' | 'open' | 'notApplicable' | 'noAccount';

export interface Bridge {
  kind: BridgeKind;
  /** The account the engine compared against, for the copy. Empty when it could not find one. */
  account: string;
  returnMinor: number;
  bookedMinor: number;
  /** The part of the difference nothing explains. Zero on a match. */
  unexplainedMinor: number;
}

/**
 * SINCE G22 (D127) THE DERIVATION LIVES IN THE ENGINE (`src/core/vat/bridge.ts`, carried as
 * `vat_return.bridge`), so the checklist check `abstimmung_resolved` and this strip cannot disagree
 * on "geprüft". This accessor is kept for the call sites; it derives nothing.
 */
export function bridgeOf(view: VatReturnView): Bridge {
  return view.bridge;
}

const BRIDGE_KINDS: readonly BridgeKind[] = ['match', 'open', 'notApplicable', 'noAccount'];

function parseBridge(raw: unknown): Bridge | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const b = raw as Record<string, unknown>;
  const kind = str(b.kind);
  const returnMinor = num(b.returnMinor);
  const bookedMinor = num(b.bookedMinor);
  const unexplainedMinor = num(b.unexplainedMinor);
  if (kind === null || !(BRIDGE_KINDS as readonly string[]).includes(kind)) return null;
  if (returnMinor === null || bookedMinor === null || unexplainedMinor === null) return null;
  return { kind: kind as BridgeKind, account: str(b.account) ?? '', returnMinor, bookedMinor, unexplainedMinor };
}

// --- the periods -----------------------------------------------------------------------------

export interface VatPeriod {
  label: string;
  periodStart: string;
  periodEnd: string;
  months: string[];
  filed: boolean;
}

export interface VatPeriodsView {
  method: string;
  year: string;
  periods: VatPeriod[];
}

export function parseVatPeriods(body: unknown): VatPeriodsView | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.periods)) return null;
  const periods: VatPeriod[] = [];
  for (const raw of b.periods) {
    if (typeof raw !== 'object' || raw === null) return null;
    const p = raw as Record<string, unknown>;
    const label = str(p.label);
    const periodStart = str(p.periodStart);
    const periodEnd = str(p.periodEnd);
    if (label === null || periodStart === null || periodEnd === null) return null;
    periods.push({
      label,
      periodStart,
      periodEnd,
      months: Array.isArray(p.months) ? p.months.filter((m): m is string => typeof m === 'string') : [],
      filed: p.filed === true,
    });
  }
  return { method: str(b.method) ?? '', year: str(b.year) ?? '', periods };
}

/**
 * The three words on screen, derived rather than stored.
 *
 * A07 §4 is explicit that a period has no lifecycle of its own beyond A03's lock, so this is a
 * reading of two facts: has the period ended, and does a filing lock exist. `listVatPeriods` sends
 * `filed` but no status word, so the derivation lives here and the agent face cannot speak it. That
 * is a real gap and it belongs in the read model (design finding F13), not a reason to store a state
 * A07 promised not to store.
 */
export type PeriodStatus = 'open' | 'ready' | 'filed';

export function statusOf(period: VatPeriod, todayIso: string): PeriodStatus {
  if (period.filed) return 'filed';
  return period.periodEnd >= todayIso ? 'open' : 'ready';
}

/** Today as an ISO day, in the operator's own timezone rather than UTC. */
export function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/** `2026-Q2` reads as `Q2/2026`, which is how a Swiss filer says it. */
export function periodTitle(label: string): string {
  const m = /^(\d{4})-(Q[1-4]|H[12])$/.exec(label);
  return m === null ? label : `${m[2]}/${m[1]}`;
}

// --- refusals --------------------------------------------------------------------------------

/**
 * The blocked states, each a code the engine really sends.
 *
 * `istTiming` is NOT in the UX design: the slice assumes an Ist return computes, and
 * `abrechnung.ts` refuses with `unsupported` / `ist_timing_not_implemented` before reading a row,
 * because handing an Ist filer the Soll figures would be a wrong return that looks right. The
 * recorded fixture is the proof.
 *
 * `saldoRateNotValidForPeriod` is the code the engine actually emits. The design's copy deck names
 * `saldo_rate_off_ladder`, which no code path produces.
 */
export type RefusalKind =
  | 'needsConfig'
  | 'saldoSplit'
  | 'saldoRateNotValidForPeriod'
  | 'istTiming'
  | 'permissionDenied';

export interface Refusal {
  kind: RefusalKind;
  /** The configured Saldosteuersätze, on the split refusal only. */
  rates: { position: number; rateBp: number }[];
  /** The configured rate, on the ladder refusal only, in basis points. */
  rateBp: number | null;
}

export function refusalOf(body: unknown, status: number): Refusal | null {
  if (status === 403) return { kind: 'permissionDenied', rates: [], rateBp: null };
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (b.ok !== false) return null;
  switch (b.error) {
    case 'permission_denied':
      return { kind: 'permissionDenied', rates: [], rateBp: null };
    case 'needs_vat_config':
      return { kind: 'needsConfig', rates: [], rateBp: null };
    case 'saldo_activity_split_required': {
      const rates = Array.isArray(b.rates)
        ? b.rates.flatMap((r) => {
            if (typeof r !== 'object' || r === null) return [];
            const rec = r as Record<string, unknown>;
            const position = num(rec.position);
            const rateBp = num(rec.rateBp);
            return position === null || rateBp === null ? [] : [{ position, rateBp }];
          })
        : [];
      return { kind: 'saldoSplit', rates, rateBp: null };
    }
    case 'saldo_rate_not_valid_for_period':
      return { kind: 'saldoRateNotValidForPeriod', rates: [], rateBp: num(b.rateBp) };
    case 'unsupported':
      return b.reason === 'ist_timing_not_implemented'
        ? { kind: 'istTiming', rates: [], rateBp: null }
        : null;
    default:
      return null;
  }
}

/** `620` reads as `6.2`, the way the ESTV ladder is published. */
export function rateLabel(rateBp: number): string {
  return (rateBp / 100).toFixed(1);
}

// --- the eCH-0217 export ---------------------------------------------------------------------

/**
 * The file the ESTV upload takes, as `vat_export_ech0217` returns it.
 *
 * THE ENGINE SENDS THE XML AS TEXT, not base64. `export_statement` (A08) base64-encodes because it
 * ships PDF bytes; eCH-0217 is a UTF-8 document, so the response carries the markup itself and the
 * browser builds the Blob straight from the string. The saving half of the pattern is identical and
 * deliberately so: the ENGINE's `filename` and the ENGINE's `contentType`, never one this surface
 * invented, so the artifact has one naming scheme.
 */
export interface Ech0217Artifact {
  filename: string;
  contentType: string;
  xml: string;
  byteLength: number;
  /**
   * The ESTV's own recomputation, run by the engine and reported WITH the file.
   *
   * eCH-0217 carries no per-rate tax figure at all: each rate line is a bare (rate, turnover) pair
   * and `payableTax` is the only tax in the document, so the authority multiplies and compares. Any
   * gap between that and the booked tax is real, and it is the engine's whole reason for sending
   * this: a filer should meet it here rather than at the ESTV.
   */
  crossCheck: TaxCrossCheck | null;
}

export interface TaxCrossCheck {
  recomputedTaxMinor: number;
  engineTaxMinor: number;
  differenceMinor: number;
}

export function parseEch0217(body: unknown): Ech0217Artifact | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const filename = str(b.filename);
  const xml = str(b.xml);
  if (filename === null || xml === null || filename === '' || xml === '') return null;
  return {
    filename,
    contentType: str(b.contentType) ?? 'application/xml',
    xml,
    byteLength: num(b.byteLength) ?? xml.length,
    crossCheck: parseCrossCheck(b.taxCrossCheck),
  };
}

function parseCrossCheck(raw: unknown): TaxCrossCheck | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const c = raw as Record<string, unknown>;
  const recomputedTaxMinor = num(c.recomputedTaxMinor);
  const engineTaxMinor = num(c.engineTaxMinor);
  const differenceMinor = num(c.differenceMinor);
  if (recomputedTaxMinor === null || engineTaxMinor === null || differenceMinor === null) return null;
  return { recomputedTaxMinor, engineTaxMinor, differenceMinor };
}

/**
 * TWELVE REFUSAL CODES, FOUR REMEDIES. The grouping is by what the person does next, not by code.
 *
 * Twelve panels would be twelve ways of saying one of four things, and a filer on a statutory
 * deadline reads the remedy, not the taxonomy. The bands are:
 *
 *   uid        `needs_company_uid`, `invalid_company_uid`
 *              eCH-0217 names the UID on every declaration. Fix it on the company profile, export
 *              again. The only band where the export succeeds on the next click.
 *
 *   rateSplit  `ambiguous_rate_on_form_line`
 *              A per-rate Ziffer aggregated more than one rate and the schema has one slot for it.
 *              Fixed in the LEDGER (the tax codes behind those entries), so the band ends in the
 *              drill-down rather than in a settings link.
 *
 *   byHand     `unmapped_form_line`, `saldo_rates_exceed_form_lines`, `unsupported_base_currency`
 *              Three different causes, one true next step: this period cannot be expressed in
 *              eCH-0217 v2.0.0 at all, and the fallback (typing the figures into the ePortal) is
 *              always open. The cause line differs per code, the remedy does not.
 *
 *   recompute  `needs_vat_config`, `unsupported`, `saldo_activity_split_required`,
 *              `saldo_rate_not_valid_for_period`, `invalid_input`, `invalid_period`
 *              The six the export inherits from `computeVatReturn`. They are UNREACHABLE from a
 *              settled screen, because the button only exists once the return computed, and the same
 *              refusal would have replaced the whole form. Reaching one means the workspace changed
 *              underneath (a rate reconfigured in another tab). So the band does not restate the
 *              refusal in a second voice: it re-reads the return, and `RefusalPanel` then says it
 *              once, authoritatively.
 *
 * Anything else, including a transport failure, is `failed`: the file was not built and nothing was
 * changed. A retry is the whole remedy.
 */
export type ExportBand = 'uid' | 'rateSplit' | 'byHand' | 'recompute' | 'failed';

export interface ExportRefusal {
  band: ExportBand;
  /** The engine's own error code, which the `byHand` band needs to name the cause. */
  code: string;
  /** The Ziffern the refusal named, on the bands that name any. */
  codes: string[];
  /** The workspace's base currency, on `unsupported_base_currency` only. */
  baseCurrency: string | null;
  /** The configured Saldosteuersatz count, on `saldo_rates_exceed_form_lines` only. */
  configuredRates: number | null;
}

const RECOMPUTE_CODES = new Set([
  'needs_vat_config',
  'unsupported',
  'saldo_activity_split_required',
  'saldo_rate_not_valid_for_period',
  'invalid_input',
  'invalid_period',
]);

export function exportRefusalOf(body: unknown, status: number): ExportRefusal {
  const blank: ExportRefusal = { band: 'failed', code: '', codes: [], baseCurrency: null, configuredRates: null };
  if (typeof body !== 'object' || body === null) return blank;
  const b = body as Record<string, unknown>;
  const code = str(b.error) ?? '';
  const codes = Array.isArray(b.codes) ? b.codes.filter((c): c is string => typeof c === 'string') : [];
  const base = { code, codes, baseCurrency: str(b.baseCurrency), configuredRates: num(b.configuredRates) };

  // A 403 is the shell's own refusal and never carries an export code. It reads as a plain failure
  // here rather than being folded into a band that would offer a remedy the reader cannot perform.
  if (status === 403) return { ...blank, code: 'permission_denied' };
  if (code === 'needs_company_uid' || code === 'invalid_company_uid') return { band: 'uid', ...base };
  if (code === 'ambiguous_rate_on_form_line') return { band: 'rateSplit', ...base };
  if (code === 'unmapped_form_line' || code === 'saldo_rates_exceed_form_lines' || code === 'unsupported_base_currency') {
    return { band: 'byHand', ...base };
  }
  if (RECOMPUTE_CODES.has(code)) return { band: 'recompute', ...base };
  return { ...blank, code };
}
