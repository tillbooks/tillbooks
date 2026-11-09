/**
 * A02 / A06, `compose_entry`: the engine composes a booking's lines, so no surface does VAT math (D152
 * amendment, owner 02.10.2026).
 *
 * WHY THIS EXISTS. The A1 composer first derived its VAT legs and traces in the Studio, from `vat_preview`
 * figures, and stamped the gross-split rounding hint itself. Three non-author critic rounds each found one
 * more edit path on a reopened draft where that client-side derivation drifted from the engine by a Rappen
 * (a reopened "Aufteilen" draft re-sending a net-forward trace, then the same after a booking-date move).
 * The engine refused every drifted draft, so no wrong money was booked, but the design was wrong: two
 * implementations of one derivation. Now there is one, and it is here.
 *
 * TWO MODES, BOTH READS (nothing is written; conformance rule 4 holds it).
 *
 *  - `expand`: the entry date and its lines, each EITHER an INTENT line (`{account, side, amount, gross,
 *    taxCode?, supplyDate?, costCenter?}`) OR a plain stored line (`account`, `debit`/`credit` and the
 *    optional stored trace), which passes through VERBATIM for the gate to judge. An intent line is
 *    expanded by A06's counter-less builder (`buildVatLineParts`, the one `buildVatLines` is assembled
 *    from) under A06's kind rules (`vatIntentRules`: direction by kind, Bezugsteuer priced on the base;
 *    `mirrorVatLine`: the unnatural side mirrored). The composed set then runs `previewPostingLines`, the
 *    pre-write half of `postEntry` that `postEntry` itself calls, so the answer IS what a post would store
 *    or refuse: the same validation, the same `reconcileAndStampVat` stamping, the same period check, the
 *    same codes and payloads.
 *  - `decompose`: a stored entry (by id, §H-TENANT scoped, draft or posted) or stored lines, read back into
 *    intent: each taxed base line becomes one intent line with its gross, its VAT legs folded back in.
 *    `roundTrips` is true only when `expand` of that intent reproduces the stored lines EXACTLY. Where a base
 *    line cannot be paired with its legs, nothing is guessed: the line stays verbatim and `roundTrips` is
 *    false, so a surface reopens the entry as it was stored and lets the gate decide.
 *
 * The answer is a declared success even when the composed booking would be refused: a refusal is the
 * VERDICT the read reports (`verdict`), not a failure of the read. Malformed input (a line that is neither
 * shape, a bad date) is the read's own `invalid_input`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { requireDate, optionalDate, optionalId } from './inputGuards.js';
import { previewPostingLines } from './postEntry.js';
import type { LineInput, PreparedLine } from './postEntry.js';
import { buildVatLineParts, computeLineTax, mirrorVatLine, vatIntentRules } from '../vat/applyVat.js';
import type { VatJournalLine } from '../vat/applyVat.js';

/** One line as a person or an agent INTENDS it: an amount on a side, gross or net, with its code. */
export interface IntentLine {
  account: string;
  side: 'debit' | 'credit';
  /** Integer Rappen, positive: the gross when `gross`, else the net. Bezugsteuer always reads it as the base. */
  amount: number;
  gross: boolean;
  taxCode?: string;
  /** The Leistungsdatum, when it differs from the entry date. Absent, the entry date prices the line. */
  supplyDate?: string;
  costCenter?: string;
}

/** A line `compose_entry` takes: an intent line, or a plain stored line passed through verbatim. */
export type ComposeLine = IntentLine | LineInput;

export interface ComposeExpandInput {
  mode: 'expand';
  date: string;
  /** The draft a post would promote, so the verdict carries the same promotion checks `post_entry` runs. */
  entryId?: string;
  lines: ComposeLine[];
}

/** A stored line as `get_entry` reports it (the fields decomposition reads). */
export interface StoredLineInput {
  account: string;
  debit?: number | null;
  credit?: number | null;
  costCenter?: string | null;
  taxCode?: string | null;
  taxBase?: number | null;
  taxAmount?: number | null;
  supplyDate?: string | null;
}

export interface ComposeDecomposeInput {
  mode: 'decompose';
  /** A stored entry of this workspace. Alternatively `date` and `lines`. */
  entryId?: string;
  date?: string;
  lines?: StoredLineInput[];
}

export type ComposeEntryInput = ComposeExpandInput | ComposeDecomposeInput;

/** One booked line on a VAT account that a derived line carries (2200, 1170, 1171). */
export type ComposeVatLeg = { readonly account: string; readonly debit: number; readonly credit: number };

/**
 * What one taxed line books, for the one-line caption under it ("davon MWST 8.07 auf 1170 · netto 99.63").
 * `derived` is true for an intent line (the figures are the expansion's) and false for a plain coded line
 * (the net-forward figures of its booked amount, the readout the manual path shows).
 */
export type ComposeCaptionOk = {
  readonly ok: true;
  readonly derived: boolean;
  readonly kind: string;
  readonly deductible: boolean;
  readonly rateBp: number;
  readonly formLine: string | null;
  readonly net: number;
  readonly tax: number;
  readonly gross: number;
  /** The single VAT account the tax books to, or null (none, a folded tax, or Bezugsteuer's two legs). */
  readonly vatAccount: string | null;
  readonly vatLegs: readonly ComposeVatLeg[];
  /** The tax books onto the line's own account (the saldo or non-deductible fold). */
  readonly folded: boolean;
  /** False when the expansion books nothing on the line's own account (a deductible Einfuhrsteuer). */
  readonly keepsOwnAccount: boolean;
};
export type ComposeCaption = ComposeCaptionOk | Err;

/** The engine's verdict on the composed booking: what `post_entry` would answer, minus the write. */
export type ComposeVerdict = { readonly ok: true } | Err;

export type ComposeExpandOk = {
  readonly mode: 'expand';
  /** False when an intent line could not be composed at all (`verdict` names it with `line`). */
  readonly composed: boolean;
  /** True when the VAT gate stamped `lines` (always when `verdict.ok`; also on a period-only refusal). */
  readonly stamped: boolean;
  /** The exact `post_entry` lines: stamped by the gate when `stamped`, else as composed. Empty when not composed. */
  readonly lines: readonly LineInput[];
  /** Per INPUT line: the caption of a taxed line, an `Err` for a code that cannot be priced, null otherwise. */
  readonly captions: readonly (ComposeCaption | null)[];
  readonly verdict: ComposeVerdict;
};

export type ComposeDecomposeOk = {
  readonly mode: 'decompose';
  readonly date: string;
  readonly entryId: string | null;
  readonly status: string | null;
  /** The stored lines, verbatim, in the `post_entry` line shape. */
  readonly lines: readonly LineInput[];
  /** The intent: one gross intent line per paired taxed base line, untagged lines as amounts, the rest verbatim. */
  readonly intent: readonly ComposeLine[];
  /** True when every taxed line with an amount found its legs. */
  readonly paired: boolean;
  /** True only when `expand(intent)` reproduces the stored lines exactly (as a multiset). */
  readonly roundTrips: boolean;
};

export type ComposeEntryOk = ComposeExpandOk | ComposeDecomposeOk;

// --- Shapes --------------------------------------------------------------------------------------------

const INTENT_KEYS = ['side', 'amount', 'gross'] as const;
const STORED_ONLY_KEYS = ['debit', 'credit', 'taxBase', 'taxAmount', 'baseAmountMinor'] as const;

function isIntentLine(line: unknown): boolean {
  return typeof line === 'object' && line !== null && INTENT_KEYS.some((k) => k in line);
}

/** An intent line's shape, or the `invalid_input` naming the line. */
function checkIntent(line: Record<string, unknown>, i: number): Err | null {
  const bad = (reason: string) => err('invalid_input', { field: `lines[${i}]`, reason });
  if (typeof line.account !== 'string' || line.account.length === 0) return bad('an intent line needs an account');
  if (line.side !== 'debit' && line.side !== 'credit') return bad('side is debit or credit');
  if (!Number.isSafeInteger(line.amount) || (line.amount as number) <= 0) return bad('amount is a positive integer Rappen amount');
  if (typeof line.gross !== 'boolean') return bad('gross is true or false');
  if (line.taxCode !== undefined && (typeof line.taxCode !== 'string' || line.taxCode.length === 0)) return bad('taxCode is a non-empty string');
  if (line.costCenter !== undefined && (typeof line.costCenter !== 'string' || line.costCenter.length === 0)) return bad('costCenter is a non-empty string');
  if (optionalDate(line.supplyDate, 'supplyDate') !== null) return bad('supplyDate is a valid YYYY-MM-DD date');
  if (STORED_ONLY_KEYS.some((k) => k in line)) return bad('an intent line carries side and amount, never debit, credit or a trace');
  return null;
}

/** The ids of the KMU VAT accounts by number (A06 §3). */
function vatAccountIds(ctx: WorkspaceContext): Map<string, string> {
  const rows = ctx.store.db
    .prepare("SELECT id, number FROM account WHERE workspace_id = ? AND number IN ('2200', '1170', '1171')")
    .all(ctx.workspaceId) as { id: string; number: string }[];
  return new Map(rows.map((r) => [r.id, r.number]));
}

/** `-0` is a JavaScript artefact of a negated zero trace, never a stored value. */
const norm = (n: number): number => 0 + n;

/** A prepared (gate-stamped) line in the `post_entry` shape, carrying only what the row would store. */
function preparedToLine(l: PreparedLine): LineInput {
  const out: LineInput = { account: l.account };
  if (l.debit > 0) out.debit = l.debit;
  else out.credit = l.credit;
  if (l.costCenter !== null) out.costCenter = l.costCenter;
  if (l.taxCode !== null) {
    out.taxCode = l.taxCode;
    if (l.taxBase !== null) out.taxBase = norm(l.taxBase);
    if (l.taxAmount !== null) out.taxAmount = norm(l.taxAmount);
    if (l.supplyDate !== null) out.supplyDate = l.supplyDate;
  }
  return out;
}

// --- Expanding one intent line ---------------------------------------------------------------------------

type Expanded = { ok: true; own: LineInput[]; caption: ComposeCaptionOk | null } | { ok: false; error: Err };

/**
 * One intent line's own booked lines (never the counter: the entry's other lines are that), with its
 * caption. A line without a code, or with a code of kind 'none', is its amount on its side.
 */
function expandIntent(ctx: WorkspaceContext, date: string, line: IntentLine, vatIds: Map<string, string>, i: number): Expanded {
  const plain = (): LineInput => {
    const out: LineInput = { account: line.account };
    if (line.side === 'debit') out.debit = line.amount;
    else out.credit = line.amount;
    if (line.costCenter !== undefined) out.costCenter = line.costCenter;
    return out;
  };
  if (line.taxCode === undefined) return { ok: true, own: [plain()], caption: null };

  // The kind decides the rules before any figure is computed; the probe's own refusal (an unknown code,
  // an unconfigured workspace, a date before the earliest era) is this line's refusal.
  const pricedAt = line.supplyDate ?? date;
  const probe = computeLineTax(ctx, { amountMinor: line.amount, amountIsGross: true, taxCode: line.taxCode, supplyDate: pricedAt });
  if (!probe.ok) return { ok: false, error: { ...probe, line: i } };
  const kind = probe.kind as string;
  if (kind === 'none') return { ok: true, own: [plain()], caption: null };

  const rules = vatIntentRules(kind);
  let own: VatJournalLine[];
  try {
    own = buildVatLineParts(ctx, {
      revenueOrExpenseAccount: line.account,
      amountMinor: line.amount,
      amountIsGross: line.gross && !rules.pricesOnBase,
      taxCode: line.taxCode,
      direction: rules.direction,
      // Priced at the Leistungsdatum, or the entry date; the trace states a supply date only when the
      // intent stated one (an absent one means "the entry date", exactly as `postEntry` reads it).
      supplyDate: pricedAt,
      ...(line.costCenter !== undefined ? { costCenterId: line.costCenter } : {}),
    }).own;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const missing = /^missing_vat_account: (\d+)$/.exec(message);
    return {
      ok: false,
      error: missing !== null ? err('vat_account_missing', { number: missing[1], line: i }) : err('vat_lines_refused', { reason: message, line: i }),
    };
  }
  if (line.supplyDate === undefined) {
    const base = own[0];
    if (base !== undefined && base.supplyDate !== undefined) {
      const { supplyDate: _dropped, ...rest } = base;
      own[0] = rest;
    }
  }
  // A zero-amount VAT leg (a Rappen whose tax rounds to nothing) books nothing and is not a line.
  own = own.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  // On its unnatural side the line is the same booking mirrored: the tax is reduced, never invented.
  if (line.side !== rules.naturalSide) own = own.map(mirrorVatLine);

  const keepsOwnAccount = own.some((l) => l.account === line.account);
  // Nothing visible is dropped: a cost centre with no line of its own account to ride is refused.
  if (line.costCenter !== undefined && !keepsOwnAccount) {
    return { ok: false, error: err('cost_center_unplaced', { line: i, account: line.account, costCenter: line.costCenter }) };
  }

  const priced = computeLineTax(ctx, {
    amountMinor: line.amount,
    amountIsGross: line.gross && !rules.pricesOnBase,
    taxCode: line.taxCode,
    supplyDate: pricedAt,
  });
  if (!priced.ok) return { ok: false, error: { ...priced, line: i } };
  const legs = own.slice(1).filter((l) => vatIds.has(l.account));
  const vatLegs: ComposeVatLeg[] = legs.map((l) => ({ account: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 }));
  const base = own[0];
  const tax = priced.taxMinor as number;
  const vatAccount =
    kind === 'import' && base !== undefined && vatIds.has(base.account)
      ? base.account
      : vatLegs.length === 1
        ? (vatLegs[0] as ComposeVatLeg).account
        : null;
  return {
    ok: true,
    own,
    caption: {
      ok: true,
      derived: true,
      kind,
      deductible: priced.deductible as boolean,
      rateBp: priced.rateBp as number,
      formLine: (priced.formLine as string | null) ?? null,
      net: priced.netMinor as number,
      tax,
      gross: priced.grossMinor as number,
      vatAccount,
      vatLegs,
      folded: tax !== 0 && vatLegs.length === 0 && kind !== 'import',
      keepsOwnAccount,
    },
  };
}

/**
 * D176: what ONE intent line moves in all, signed (+ debit, - credit): the sum of the lines its expansion
 * books (its own account and its VAT legs). For every kind but a deductible Einfuhrsteuer this is its amount
 * on its side; a Vorlage reads it to find the amount its rest leg must carry. The expansion's own refusal
 * (an unknown code, a missing VAT account) is the answer when it cannot be composed. Reads only.
 */
export function intentLineEffect(ctx: WorkspaceContext, date: string, line: IntentLine, index: number): { ok: true; effect: number } | { ok: false; error: Err } {
  const expanded = expandIntent(ctx, date, line, vatAccountIds(ctx), index);
  if (!expanded.ok) return expanded;
  return { ok: true, effect: expanded.own.reduce((sum, l) => sum + (l.debit ?? 0) - (l.credit ?? 0), 0) };
}

/** A plain coded line's net-forward readout (the manual path's caption), or the code's own refusal. */
function plainCaption(ctx: WorkspaceContext, date: string, line: LineInput): ComposeCaption | null {
  if (line.taxCode === undefined || line.taxCode === 'none') return null;
  const amount = (line.debit ?? 0) > 0 ? (line.debit as number) : (line.credit ?? 0);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const r = computeLineTax(ctx, { amountMinor: amount, amountIsGross: false, taxCode: line.taxCode, supplyDate: line.supplyDate ?? date });
  if (!r.ok) return r;
  if ((r.kind as string) === 'none') return null;
  return {
    ok: true,
    derived: false,
    kind: r.kind as string,
    deductible: r.deductible as boolean,
    rateBp: r.rateBp as number,
    formLine: (r.formLine as string | null) ?? null,
    net: r.netMinor as number,
    tax: r.taxMinor as number,
    gross: r.grossMinor as number,
    vatAccount: null,
    vatLegs: [],
    folded: false,
    keepsOwnAccount: true,
  };
}

/**
 * The answered lines in the order the DRAFT being promoted stores them, when they are exactly its lines (critic
 * R4 L2). `roundTrips` compares as a multiset, so an untouched reopen expands to the stored lines in the
 * expansion's own order (a Bezugsteuer leg after its base, a counter last); posting that would rewrite an
 * untouched draft's row order for nothing. When the answer IS the draft (every line, trace, cost centre and
 * supply date), it goes back in the draft's order; any difference at all, and the expansion's order stands.
 * Workspace-scoped; a read.
 */
function inStoredOrder(ctx: WorkspaceContext, entryId: string | undefined, lines: LineInput[]): LineInput[] {
  if (entryId === undefined) return lines;
  const rows = ctx.store.db
    .prepare(
      `SELECT l.account_id, l.debit_minor, l.credit_minor, l.cost_center_id, l.tax_code, l.tax_base_minor, l.tax_amount_minor, l.supply_date
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.id = ? AND e.status = 'draft' ORDER BY l.rowid`,
    )
    .all(ctx.workspaceId, entryId) as {
    account_id: string;
    debit_minor: number;
    credit_minor: number;
    cost_center_id: string | null;
    tax_code: string | null;
    tax_base_minor: number | null;
    tax_amount_minor: number | null;
    supply_date: string | null;
  }[];
  if (rows.length !== lines.length) return lines;
  const pool = lines.map((l) => ({ l, key: signature(l) }));
  const ordered: LineInput[] = [];
  for (const r of rows) {
    const stored: LineInput = { account: r.account_id };
    if (r.debit_minor > 0) stored.debit = r.debit_minor;
    if (r.credit_minor > 0) stored.credit = r.credit_minor;
    if (r.cost_center_id !== null) stored.costCenter = r.cost_center_id;
    if (r.tax_code !== null) stored.taxCode = r.tax_code;
    if (r.tax_base_minor !== null) stored.taxBase = r.tax_base_minor;
    if (r.tax_amount_minor !== null) stored.taxAmount = r.tax_amount_minor;
    if (r.supply_date !== null) stored.supplyDate = r.supply_date;
    const at = pool.findIndex((p) => p.key === signature(stored));
    if (at < 0) return lines;
    ordered.push((pool.splice(at, 1)[0] as { l: LineInput }).l);
  }
  return ordered;
}

/**
 * `expand`: intent and plain lines to the exact `post_entry` lines, with the engine's verdict. `opts.currency`
 * is the entry's transaction currency when a caller composes a foreign-currency booking (the bank inbox's
 * preview of a line in its Bankkonto's own foreign currency, D175); absent, the base currency, as always.
 */
export function expandEntry(ctx: WorkspaceContext, input: Omit<ComposeExpandInput, 'mode'>, opts: { currency?: string } = {}): Result<ComposeExpandOk> {
  const guard = requireDate(input.date, 'date') ?? optionalId(input.entryId, 'entryId');
  if (guard) return guard;
  if (!Array.isArray(input.lines)) return err('invalid_input', { field: 'lines', reason: 'lines must be an array' });

  const vatIds = vatAccountIds(ctx);
  const composed: LineInput[] = [];
  const captions: (ComposeCaption | null)[] = [];
  let failure: Err | null = null;
  for (let i = 0; i < input.lines.length; i += 1) {
    const line = input.lines[i] as unknown;
    if (!isIntentLine(line)) {
      // A plain line passes through VERBATIM (a shallow copy, every key it came with), so the gate judges
      // exactly what `post_entry` would receive, unknown keys and stored traces included.
      if (typeof line !== 'object' || line === null) return err('invalid_input', { field: `lines[${i}]`, reason: 'a line is an object' });
      const copy = { ...(line as LineInput) };
      composed.push(copy);
      captions.push(plainCaption(ctx, input.date, copy));
      continue;
    }
    const shape = checkIntent(line as Record<string, unknown>, i);
    if (shape) return shape;
    const expanded = expandIntent(ctx, input.date, line as IntentLine, vatIds, i);
    if (!expanded.ok) {
      failure ??= expanded.error;
      captions.push(expanded.error);
      continue;
    }
    composed.push(...expanded.own);
    captions.push(expanded.caption);
  }

  if (failure !== null) {
    return ok<ComposeExpandOk>({ mode: 'expand', composed: false, stamped: false, lines: [], captions, verdict: failure });
  }

  const preview = previewPostingLines(ctx, {
    date: input.date,
    ...(input.entryId !== undefined ? { entryId: input.entryId } : {}),
    // Every business source previews identically (only the engine-only correction and closing sources
    // are treated differently by the gate), so the composer's own source stands for all of them.
    source: 'manual',
    lines: composed.map((l) => ({ ...l })),
    ...(opts.currency !== undefined ? { currency: opts.currency } : {}),
  });
  if (preview.ok) {
    return ok<ComposeExpandOk>({
      mode: 'expand',
      composed: true,
      stamped: true,
      lines: inStoredOrder(ctx, input.entryId, preview.lines.map(preparedToLine)),
      captions,
      verdict: { ok: true },
    });
  }
  const stamped = preview.stamped;
  return ok<ComposeExpandOk>({
    mode: 'expand',
    composed: true,
    stamped: stamped !== undefined,
    lines: inStoredOrder(ctx, input.entryId, stamped !== undefined ? stamped.map(preparedToLine) : composed),
    captions,
    verdict: preview.error,
  });
}

// --- Decomposing stored lines back into intent -----------------------------------------------------------

interface Stored {
  index: number;
  account: string;
  side: 'debit' | 'credit' | null;
  amount: number;
  costCenter: string | null;
  taxCode: string | null;
  taxBase: number | null;
  taxAmount: number | null;
  supplyDate: string | null;
  verbatim: LineInput;
}

function normaliseStored(lines: readonly StoredLineInput[]): Stored[] | Err {
  const out: Stored[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    const bad = (reason: string) => err('invalid_input', { field: `lines[${i}]`, reason });
    if (typeof l !== 'object' || l === null || typeof l.account !== 'string' || l.account.length === 0) return bad('a stored line needs an account');
    const int = (v: unknown): number | null => (v === undefined || v === null ? null : Number.isSafeInteger(v) ? (v as number) : NaN);
    const debit = int(l.debit) ?? 0;
    const credit = int(l.credit) ?? 0;
    const taxBase = int(l.taxBase);
    const taxAmount = int(l.taxAmount);
    if ([debit, credit, taxBase ?? 0, taxAmount ?? 0].some((n) => Number.isNaN(n)) || debit < 0 || credit < 0) return bad('amounts are integer Rappen');
    const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
    const verbatim: LineInput = { account: l.account };
    if (debit > 0) verbatim.debit = debit;
    if (credit > 0) verbatim.credit = credit;
    const costCenter = str(l.costCenter);
    const taxCode = str(l.taxCode);
    const supplyDate = str(l.supplyDate);
    if (costCenter !== null) verbatim.costCenter = costCenter;
    if (taxCode !== null) verbatim.taxCode = taxCode;
    if (taxBase !== null) verbatim.taxBase = norm(taxBase);
    if (taxAmount !== null) verbatim.taxAmount = norm(taxAmount);
    if (supplyDate !== null) verbatim.supplyDate = supplyDate;
    out.push({
      index: i,
      account: l.account,
      side: debit > 0 && credit === 0 ? 'debit' : credit > 0 && debit === 0 ? 'credit' : null,
      amount: debit > 0 ? debit : credit,
      costCenter,
      taxCode,
      taxBase,
      taxAmount,
      supplyDate,
      verbatim,
    });
  }
  return out;
}

/** The exact identity of a line, the trace and the supply date included. */
function signature(l: LineInput): string {
  return JSON.stringify([
    l.account,
    l.debit ?? 0,
    l.credit ?? 0,
    l.costCenter ?? null,
    l.taxCode ?? null,
    l.taxBase === undefined ? null : norm(l.taxBase),
    l.taxAmount === undefined ? null : norm(l.taxAmount),
    l.supplyDate ?? null,
  ]);
}

/** The identity of a line for PAIRING: what it books, without the trace (the full check comes after). */
function bookingKey(account: string, side: 'debit' | 'credit', amount: number, costCenter: string | null | undefined, taxCode: string | null | undefined): string {
  return JSON.stringify([account, side, amount, costCenter ?? null, taxCode ?? null]);
}

function sameMultiset(a: readonly LineInput[], b: readonly LineInput[]): boolean {
  if (a.length !== b.length) return false;
  const x = a.map(signature).sort();
  const y = b.map(signature).sort();
  return x.every((s, i) => s === y[i]);
}

/** Two claims on the same stored lines (by index), in any order. */
function sameKeys(a: readonly Stored[], b: readonly Stored[]): boolean {
  const x = a.map((s) => s.index).sort((m, n) => m - n);
  const y = b.map((s) => s.index).sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** `decompose`: stored lines back into intent, and whether that intent reproduces them exactly. */
export function decomposeEntry(ctx: WorkspaceContext, input: Omit<ComposeDecomposeInput, 'mode'>): Result<ComposeDecomposeOk> {
  let date: string;
  let raw: StoredLineInput[];
  let entryId: string | null = null;
  let status: string | null = null;
  if (input.entryId !== undefined) {
    const guard = optionalId(input.entryId, 'entryId');
    if (guard) return guard;
    // §H-TENANT: the entry is read only inside this workspace; an id of another book is `not_found`.
    const entry = ctx.store.db
      .prepare('SELECT id, date, status FROM journal_entry WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, input.entryId) as { id: string; date: string; status: string } | undefined;
    if (entry === undefined) return err('not_found', { entryId: input.entryId });
    entryId = entry.id;
    status = entry.status;
    date = entry.date;
    raw = (
      ctx.store.db
        .prepare(
          'SELECT account_id, debit_minor, credit_minor, cost_center_id, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? ORDER BY rowid',
        )
        .all(entry.id) as {
        account_id: string;
        debit_minor: number;
        credit_minor: number;
        cost_center_id: string | null;
        tax_code: string | null;
        tax_base_minor: number | null;
        tax_amount_minor: number | null;
        supply_date: string | null;
      }[]
    ).map((r) => ({
      account: r.account_id,
      debit: r.debit_minor,
      credit: r.credit_minor,
      costCenter: r.cost_center_id,
      taxCode: r.tax_code,
      taxBase: r.tax_base_minor,
      taxAmount: r.tax_amount_minor,
      supplyDate: r.supply_date,
    }));
  } else {
    const guard = requireDate(input.date, 'date');
    if (guard) return guard;
    if (!Array.isArray(input.lines)) return err('invalid_input', { field: 'lines', reason: 'pass entryId, or date and lines' });
    date = input.date as string;
    raw = input.lines;
  }

  const stored = normaliseStored(raw);
  if (!Array.isArray(stored)) return stored;
  const verbatim = stored.map((s) => s.verbatim);
  const vatIds = vatAccountIds(ctx);

  // Stored lines already claimed: a paired base line, or a VAT leg it was paired with.
  const used = new Set<number>();

  const intentAt = new Map<number, ComposeLine>();
  let paired = true;
  for (const t of stored) {
    if (t.taxCode === null || t.side === null) continue;
    // A tagged line on a VAT account (a deductible Einfuhrsteuer's 1170 line, or a stranded tag) has no
    // own account to be the intent of: it stays verbatim.
    if (vatIds.has(t.account)) {
      paired = false;
      continue;
    }
    const side = t.side;
    /** The intent for `amount` (gross or net), and the untagged stored lines it claims, when it fits. */
    const tryIntent = (amount: number, gross: boolean): { intent: IntentLine; legs: Stored[]; booked: number } | null => {
      if (amount <= 0) return null;
      const intent: IntentLine = {
        account: t.account,
        side,
        amount,
        gross,
        taxCode: t.taxCode as string,
        ...(t.supplyDate !== null ? { supplyDate: t.supplyDate } : {}),
        ...(t.costCenter !== null ? { costCenter: t.costCenter } : {}),
      };
      const expanded = expandIntent(ctx, date, intent, vatIds, t.index);
      if (!expanded.ok) return null;
      const [base, ...rest] = expanded.own;
      if (base === undefined) return null;
      const baseSide = (base.debit ?? 0) > 0 ? 'debit' : 'credit';
      const baseAmount = baseSide === 'debit' ? (base.debit as number) : (base.credit as number);
      if (bookingKey(base.account, baseSide, baseAmount, base.costCenter, base.taxCode) !== bookingKey(t.account, side, t.amount, t.costCenter, t.taxCode)) return null;
      // Every other line the expansion books must be an untagged stored line not yet claimed.
      const claimed: Stored[] = [];
      for (const l of rest) {
        const lSide = (l.debit ?? 0) > 0 ? 'debit' : 'credit';
        const key = bookingKey(l.account, lSide, lSide === 'debit' ? (l.debit as number) : (l.credit as number), l.costCenter, null);
        const hit = stored.find(
          (s) => !used.has(s.index) && !claimed.includes(s) && s.taxCode === null && s.side !== null && bookingKey(s.account, s.side, s.amount, s.costCenter, null) === key,
        );
        if (hit === undefined) return null;
        claimed.push(hit);
      }
      // What the line books in all, on its own side: the amount the entry's other lines balance.
      const booked = Math.abs(expanded.own.reduce((sum, l) => sum + (l.debit ?? 0) - (l.credit ?? 0), 0));
      return { intent, legs: claimed, booked };
    };
    // The candidates, most specific first: the gross the stored trace states (net + tax); the booked amount
    // read as gross (a fold, an import, Bezugsteuer's base); and the booked amount read as NET, which is
    // then restated as the gross it books whenever that gross expands to the very same lines (a surface
    // that composes in gross, the A1 composer, can only say a gross). A net intent stays net only when no
    // gross says the same booking.
    let found: { intent: IntentLine; legs: Stored[] } | null = null;
    if (t.taxBase !== null && t.taxAmount !== null) found = tryIntent(Math.abs(t.taxBase) + Math.abs(t.taxAmount), true);
    found ??= tryIntent(t.amount, true);
    if (found === null) {
      const net = tryIntent(t.amount, false);
      if (net !== null) {
        const asGross = tryIntent(net.booked, true);
        found = asGross !== null && sameKeys(asGross.legs, net.legs) ? asGross : net;
      }
    }
    if (found === null) {
      paired = false;
      continue;
    }
    used.add(t.index);
    for (const l of found.legs) used.add(l.index);
    intentAt.set(t.index, found.intent);
  }

  const intent: ComposeLine[] = [];
  for (const s of stored) {
    if (intentAt.has(s.index)) {
      intent.push(intentAt.get(s.index) as IntentLine);
      continue;
    }
    if (used.has(s.index)) continue;
    if (s.taxCode === null && s.side !== null && s.supplyDate === null) {
      // An untagged line with an amount is that amount on its side.
      intent.push({ account: s.account, side: s.side, amount: s.amount, gross: true, ...(s.costCenter !== null ? { costCenter: s.costCenter } : {}) });
      continue;
    }
    // Everything else (an amount-less draft line, an unpaired tagged line) stays exactly as stored.
    intent.push({ ...s.verbatim });
  }

  let roundTrips = false;
  if (paired) {
    const again = expandEntry(ctx, { date, lines: intent.map((l) => ({ ...l })) });
    roundTrips = again.ok && again.composed && sameMultiset(again.lines, verbatim);
  }
  return ok<ComposeDecomposeOk>({ mode: 'decompose', date, entryId, status, lines: verbatim, intent, paired, roundTrips });
}

/** The verb: `mode` selects `expand` or `decompose`. Reads only. */
export function composeEntry(ctx: WorkspaceContext, input: ComposeEntryInput): Result<ComposeEntryOk> {
  if (typeof input !== 'object' || input === null) return err('invalid_input', { field: 'mode' });
  if (input.mode === 'expand') return expandEntry(ctx, input);
  if (input.mode === 'decompose') return decomposeEntry(ctx, input);
  return err('invalid_input', { field: 'mode', reason: 'mode is expand or decompose' });
}
