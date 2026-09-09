/**
 * Shared shapes and pure helpers for the VatSettings surface (A05, MWST config §6).
 *
 * These mirror the engine read models (camelCase per the Module 1 interface decision, G00). The
 * browser never imports engine code, so the shapes are re-declared here and kept deliberately
 * tolerant: an unknown extra field is ignored, a missing optional falls back to a safe default.
 *
 * A05 is on the N-rate Saldo model (law change 1.1.2025): the config carries an ORDERED list of
 * Saldosteuersätze, one per business activity over 10% of turnover, with no fixed cap. Each rate must
 * sit on the published ESTV ladder. From 01.01.2025 every one of them declares on the SAME ESTV
 * Ziffer (323), with the per-rate split carried in the Beiblatt: the Ziffer stopped depending on the
 * rate position when that row was abolished (A07 §3.1a). Rates are basis points, never floats.
 */

/**
 * The method choices (MWSTG Art. 36 / 37). `none` is a DECIDED answer: "nicht MWST-pflichtig",
 * posted as `method:'none', registered:false`. It is NOT "not yet configured": a workspace that has
 * never answered reads `method: null` off the wire and decodes to `null` here (G17 §8b / D90's
 * recorded defect). Collapsing the two was what made the first-contact explainer nag a legitimately
 * non-registered freelancer forever, so the distinction is load-bearing, not cosmetic.
 */
export type VatMethod = 'effektiv' | 'saldo' | 'none';
export type VatTiming = 'soll' | 'ist';

/** The tax-code kind enum, single-sourced at §H-ENUM. Snake_case as the engine emits it. */
export type TaxKind =
  | 'output'
  | 'input'
  | 'reverse_charge'
  | 'import'
  | 'exempt'
  | 'zero'
  | 'none';

/** One Saldosteuersatz as read back: 1-based position, rate in bp, ESTV Ziffer (null for 3rd+). */
export interface SaldoRate {
  position: number;
  rateBp: number;
  formLine: string | null;
}

/** One Ertragskonto owned by a Tätigkeit. The number is what a person recognises; the id is the key. */
export interface SaldoAccount {
  accountId: string;
  number: string;
  name: string;
}

/**
 * One Tätigkeit of an ESTV Bewilligung (F11).
 *
 * The ACCOUNTS are the attribution. Under Saldo no rate is ever stamped on a journal line, so MWSTV
 * Art. 84 Abs. 3 ("die Erträge für jeden dieser Saldosteuersätze separat verbuchen") is discharged
 * through the chart: turnover belongs to whichever Tätigkeit owns the Ertragskonto it was booked on.
 * Several Tätigkeiten may share one rate (Art. 86 Abs. 3), which is why this is a row of its own and
 * not a field on `SaldoRate`.
 */
export interface SaldoActivity {
  activityId: string;
  name: string;
  activityCode: string | null;
  position: number;
  rateBp: number;
  formLine: string | null;
  accounts: SaldoAccount[];
}

/** `per_activity` is MWSTV Art. 88 Abs. 1, the default. `highest_rate` is the Abs. 6 election. */
export type SaldoDeclarationBasis = 'per_activity' | 'highest_rate';

/** One recorded ESTV approval, as returned by `vat_saldo_generations`. `validTo === null` is the open one. */
export interface SaldoGeneration {
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  rates: SaldoRate[];
  activities: SaldoActivity[];
}

/** The workspace VAT config, as returned by `vat_config`. `method: null` = the election is UNDECIDED. */
export interface VatConfig {
  method: VatMethod | null;
  timing: VatTiming;
  registered: boolean;
  vatNumber?: string;
  saldoRates: SaldoRate[];
  saldoActivities: SaldoActivity[];
  /** The day the approval in force today began, or null when none is recorded. */
  saldoValidFrom: string | null;
  /** Null means unelected, which under Art. 88 Abs. 1 means the split per Tätigkeit. */
  saldoDeclarationBasis: SaldoDeclarationBasis | null;
  /** The Steuerperiode the basis above belongs to (MWSTG Art. 34 Abs. 2, the calendar year). */
  saldoDeclarationTaxPeriod: string | null;
}

/** One tax code, as returned by `vat_codes`. */
export interface TaxCode {
  code: string;
  kind: TaxKind;
  rateBp: number;
  /** The ESTV Ziffer for the Abrechnung form. */
  formLine: string;
  label: string;
  validFrom?: string;
  archived?: boolean;
}

/**
 * The published ESTV Saldosteuersatz ladder (in basis points), FOR THE ERA IN FORCE TODAY. A saldo
 * rate MUST be one of these; anything else is rejected by the engine as `invalid_saldo_rate`.
 * 10 bp = 0.1%, 680 bp = 6.8%.
 *
 * THIS IS A COPY, and the copy is held true rather than trusted. The law lives in
 * `src/core/vat/rateEras.ts`, which is date-versioned because SR 641.202.62 was REBASED with effect
 * 1.1.2024 and the 2018 ladder differs from this one on six of its ten rungs. This file cannot
 * import that one (the Studio is a separate Vite build with no path into the engine sources), so
 * `test/vat/saldo-ladder-drift.test.mjs` compares the two and goes red if they ever disagree. Before
 * that guard existed a rebase would have moved the engine and left this picker silently offering
 * rungs the engine refuses.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is pick a ladder per period. The surface sends no `asOf` at all,
 * so it only ever configures the era in force, and a picker that offered a choice of eras would be
 * claiming a capability the save path does not have. Configuring a pre-2024 correction return is an
 * engine capability (`vat_configure` takes `asOf`) that this surface does not yet expose.
 */
export const ESTV_SALDO_LADDER: readonly number[] = [
  10, 60, 130, 210, 300, 370, 450, 530, 620, 680,
];

/** The kinds offered when adding a code, in a stable order. */
export const TAX_KINDS: readonly TaxKind[] = [
  'output',
  'input',
  'reverse_charge',
  'import',
  'exempt',
  'zero',
];

/**
 * The ESTV Ziffer a configured Saldosteuersatz declares on TODAY, whatever its position.
 *
 * It used to map position 1 to 323, position 2 to 333 and everything beyond to null. That was the
 * pre-2025 form, where the Steuerberechnung block really did number a row per rate position and stop
 * at two. From 01.01.2025 the position dimension is gone: MWST-Info 12 Ziff. 18.1.4 defines only
 * "Ziffer 322: Leistungen bis 31.12.2023" and "Ziffer 323: Leistungen ab 01.01.2024", and "Die
 * Deklaration erfolgt über das Beiblatt zu den Ziffern 322 und 323, in welchem das Entgelt - sofern
 * die ESTV mehrere SSS bewilligt hat - auf die verschiedenen SSS aufzuteilen ist." The publication's
 * own Beispiel 2 has a two-rate filer declaring under Ziffer 323 alone. See A07 §3.1a.
 *
 * This screen configures what applies from now on, so it answers for the current form and takes no
 * period. The engine still resolves the Ziffer per REPORTED period, which is what keeps a
 * Berichtigungsabrechnung for a closed pre-2025 period declaring on 323/333 the way it must.
 *
 * NON-NULL, and the caller owes a valid position. It used to return null past position 2, so both
 * call sites branched on it; now the only way to reach a null would be a position that does not
 * exist, which is a caller bug rather than a fact about the form. The Tätigkeiten panel checks that
 * before it asks, because an activity whose rate is no longer approved has no position at all.
 */
export function saldoZifferForPosition(position: number): string {
  if (!Number.isInteger(position) || position < 1) {
    throw new RangeError(`saldoZifferForPosition needs a 1-based position, got ${position}`);
  }
  return '323';
}

/** Map an engine kind to its camelCased i18n key segment (`reverse_charge` -> `reverseCharge`). */
export function kindKeySegment(kind: string): string {
  return kind.replace(/_([a-z])/g, (_whole, ch: string) => ch.toUpperCase());
}

/**
 * Format a basis-point rate as a percentage string, e.g. 810 -> "8.1%", 620 -> "6.2%", 10 -> "0.1%".
 * Uses a dot decimal to match the spec examples (8.1% / 2.6% / 3.8%) and the house money format.
 */
export function formatRatePct(rateBp: number): string {
  return `${(rateBp / 100).toFixed(1)}%`;
}

/** True when a rate sits on the published ESTV ladder. */
export function isOnLadder(rateBp: number): boolean {
  return ESTV_SALDO_LADDER.includes(rateBp);
}

/** True when the ordered rate list carries the same rate twice (rejected before it reaches the engine). */
export function hasDuplicateRate(rates: readonly number[]): boolean {
  return new Set(rates).size !== rates.length;
}

/** Read the config off a `vat_config` body, tolerating a flat body or a nested `config`. */
export function readConfig(body: Record<string, unknown>): VatConfig {
  const source = isPlainObject(body.config) ? body.config : body;
  const rawRates = (source as Record<string, unknown>).saldoRates;
  const saldoRates: SaldoRate[] = Array.isArray(rawRates)
    ? (rawRates as Record<string, unknown>[]).map((r, i) => ({
        position: typeof r.position === 'number' ? r.position : i + 1,
        rateBp: typeof r.rateBp === 'number' ? r.rateBp : 0,
        formLine: typeof r.formLine === 'string' ? r.formLine : null,
      }))
    : [];
  const method = (source as Record<string, unknown>).method;
  const timing = (source as Record<string, unknown>).timing;
  const vatNumber = (source as Record<string, unknown>).vatNumber;
  const validFrom = (source as Record<string, unknown>).saldoValidFrom;
  const basis = (source as Record<string, unknown>).saldoDeclarationBasis;
  const taxPeriod = (source as Record<string, unknown>).saldoDeclarationTaxPeriod;
  return {
    // `null` (never answered) and `'none'` (answered: not liable) are DIFFERENT states. The engine
    // payload distinguishes them (`workspace.vat_method` is nullable and `getVatConfig` returns it
    // raw); this decode used to destroy the distinction by coercing anything unknown to `'none'`,
    // which made "decided: not liable" byte-identical to "never answered" and the explainer block's
    // predicate unbuildable (G17 design §8b, the critic-confirmed read-model change).
    method: method === 'effektiv' || method === 'saldo' || method === 'none' ? method : null,
    timing: timing === 'ist' ? 'ist' : 'soll',
    registered: (source as Record<string, unknown>).registered === true,
    vatNumber: typeof vatNumber === 'string' ? vatNumber : undefined,
    saldoRates,
    saldoActivities: readActivities((source as Record<string, unknown>).saldoActivities),
    saldoValidFrom: typeof validFrom === 'string' ? validFrom : null,
    saldoDeclarationBasis: basis === 'highest_rate' || basis === 'per_activity' ? basis : null,
    saldoDeclarationTaxPeriod: typeof taxPeriod === 'string' ? taxPeriod : null,
  };
}

/**
 * The three states of the MWST election (G17 §8b): never answered, answered positively (the
 * workspace accounts for VAT), answered negatively ("nicht MWST-pflichtig"). The explainer block
 * renders IFF `undecided`; the negative answer removes it for the ordinary reason (the decision
 * exists) and stays reversible from the same surface. Three fixtures decode to three states, gated
 * in VatSettings.test.tsx.
 */
export type VatElectionState = 'undecided' | 'registered' | 'not_liable';

export function vatElection(config: VatConfig): VatElectionState {
  if (config.method === null) return 'undecided';
  return config.registered ? 'registered' : 'not_liable';
}

/** Read a `saldoActivities` array off any engine payload that carries one. */
export function readActivities(raw: unknown): SaldoActivity[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((a, i) => ({
    activityId: String(a.activityId ?? ''),
    name: String(a.name ?? ''),
    activityCode: typeof a.activityCode === 'string' ? a.activityCode : null,
    position: typeof a.position === 'number' ? a.position : i + 1,
    rateBp: typeof a.rateBp === 'number' ? a.rateBp : 0,
    formLine: typeof a.formLine === 'string' ? a.formLine : null,
    accounts: Array.isArray(a.accounts)
      ? (a.accounts as Record<string, unknown>[]).map((x) => ({
          accountId: String(x.accountId ?? ''),
          number: String(x.number ?? ''),
          name: String(x.name ?? ''),
        }))
      : [],
  }));
}

/** Read the approval history off a `vat_saldo_generations` body. */
export function readGenerations(body: Record<string, unknown>): SaldoGeneration[] {
  const raw = body.generations;
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((g) => ({
    validFrom: String(g.validFrom ?? ''),
    validTo: typeof g.validTo === 'string' ? g.validTo : null,
    createdAt: String(g.createdAt ?? ''),
    rates: Array.isArray(g.rates)
      ? (g.rates as Record<string, unknown>[]).map((r, i) => ({
          position: typeof r.position === 'number' ? r.position : i + 1,
          rateBp: typeof r.rateBp === 'number' ? r.rateBp : 0,
          formLine: typeof r.formLine === 'string' ? r.formLine : null,
        }))
      : [],
    activities: readActivities(g.activities),
  }));
}

/**
 * The day before an ISO day, which is the predecessor approval's NEW LAST DAY (D44 R3).
 *
 * This is the whole teaching device on the save dialog. "Past periods are unaffected" only asks to be
 * believed; "gilt neu bis 30.06.2026" is a fact the operator can check against their own filings. UTC
 * arithmetic rather than string surgery, because month lengths and leap years are exactly where a
 * hand-rolled date lands one day out, and one day out moves a whole period into the wrong approval.
 *
 * The engine computes the same day in `newLastDayOfPredecessor`; this is the browser's copy, because
 * the Studio must render the sentence BEFORE the save it is asking the operator to confirm.
 */
export function previousDayIso(day: string): string {
  const [y, m, d] = day.split('-').map((n) => Number(n));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return day;
  const shifted = new Date(Date.UTC(y as number, (m as number) - 1, (d as number) - 1));
  const yy = String(shifted.getUTCFullYear()).padStart(4, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * Read the tax codes off a `vat_codes` body. The engine's key is `taxCodes` and NOTHING else is
 * tolerated: this function used to accept `codes` and `vatCodes` (keys the engine never sends),
 * which is exactly how the register rendered empty against a live engine while the fixtures, wrong
 * in the same way, kept jsdom green. The shape is pinned by test/vat/tax-codes-fixture.test.mjs.
 * `archived` derives from the engine's `active` flag; there is no `archived` key on the wire.
 */
export function readCodes(body: Record<string, unknown>): TaxCode[] {
  const raw = body.taxCodes;
  if (!Array.isArray(raw)) return [];
  return (raw as Record<string, unknown>[]).map((c) => ({
    code: String(c.code ?? ''),
    kind: (c.kind as TaxKind) ?? 'none',
    rateBp: typeof c.rateBp === 'number' ? c.rateBp : 0,
    formLine: c.formLine == null ? '' : String(c.formLine),
    label: String(c.label ?? c.code ?? ''),
    validFrom: typeof c.validFrom === 'string' ? c.validFrom : undefined,
    archived: c.active === false,
  }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short, stable idempotency key for agent-safe writes (P8/§H-IDEMPOTENT). */
export function idemKey(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
