/**
 * D203, THE TURNOVER FROM THE BOOKS: `turnover_summary` and `settlement_periods`, the two reads the Umsatz page's
 * figures stand on (A42 section 16).
 *
 * THE FIGURES ARE THE BOOKS (D203 point 2). Every figure is a sum over POSTED journal entries dated in the
 * window, the year-end close excluded exactly as the Erfolgsrechnung excludes it (`source != 'close'`), so the
 * turnover equals the income statement's 3xxx lines to the Rappen (the invariant
 * `test/settlement/turnover-summary.test.mjs` pins). Nothing here reads a processor payout as turnover, nothing
 * reads the settlement feed, and nothing recomputes an event: an event counts once the import booked it.
 *
 *  - Turnover excl. VAT: credit minus debit on the revenue accounts, the Erfolgsrechnung's own position 1
 *    Nettoerlöse (`erfolgSectionFor` = `netto_erloese`: 30xx to 38xx of type income or expense, so an
 *    Erlösminderung on 38xx lowers it and 39xx Bestandesänderungen stay out; critic r1 L1, one source of truth).
 *  - Output VAT (RE-CUT after critic r3, three FAILs): credit minus debit on 2200 ONLY in the entries attributed
 *    through `settlement_event.entry_id` (its one writer is `import_settlement`) to a `sale` or `refund` event,
 *    plus their reversal chains, which inherit the attribution WITHOUT a sign flip (a reversal's lines are
 *    already mirrored, `reverseEntry.ts`). No other entry is read for it, so neither the MWST-Saldierung (whose
 *    Saldo form books its difference to 3809, a revenue account) nor an invoice reaches it. Its form lines are
 *    those of the tax codes on those entries' revenue lines.
 *  - Fee input VAT: debit minus credit on 1170 and 1171, the same way, over `processing_fee` and `service_fee`
 *    chains only (a `third_party_payout`'s input VAT is no fee). Null under the Saldo or Pauschal method, which
 *    deducts no input VAT (`vatMethod` names the method).
 *  - Sales: ONE set read from `settlement_event` joined to its `journal_entry` (both workspace-fenced, posted,
 *    no close, the window on the ENTRY's date): kind `sale`, carrying a revenue line with a positive revenue net,
 *    and standing through the window's end by its reversal chain (`reversalChainOf` and `signedCountThrough`,
 *    multi-hop, a reversal dated before its target included). Never the feed, a test flag or an inclusion row.
 *    The average is that set's revenue net divided by its count. Refunds and negative nets go to the reductions.
 *  - `settlementTurnoverMinor`: the part of the turnover the settlement sources carry (their `bySource` rows),
 *    by construction at most the turnover's settlement share and summed from the same entries.
 *  - Payouts: what left the saved templates' clearing accounts in entries with no revenue line that the
 *    settlement import did not book (the bank's payout booking, 1020 against 1095), plus an import's own
 *    `bank_payout` booking where a template books one. A reversal nets with the payout it reverses (critic r1
 *    L2): one payout per chain, counted only while it is not zero. Never turnover: a payout-only window sums
 *    to zero.
 *
 * WHERE IT CAME FROM (`bySource`). An entry the import booked is its settlement source (system, processor); an
 * A11/A13 document's entry (or an entry of source `invoice` / `credit_note`) is `invoices`; every other entry is
 * `other`. A reversal belongs where the entry it reverses belongs. The sources and the months each sum to the
 * total by construction (one attribution per entry).
 *
 * WHO BOUGHT (`byCustomer`). A settlement event's payer refs (`refs.counterpartyName`, `refs.counterpartyEmail`,
 * else its counterparty text) or the document's contact. A governed seat sees a settlement payer masked unless
 * `settlement.agent_sees_email` is `shown` (A42 section 3); a contact name needs `read_master_data`.
 *
 * `settlement_periods` answers, per period of a unit, whether TILL observed settlement events there and whether
 * any of them waits (observed, never booked, its latest import outcome refused or waiting for a person, and no
 * active ignore or handled-outside answer): `to_book`, `booked` or `empty`. It reads what an import or a pull
 * recorded; a period nobody pulled yet is `empty` (the review of that period fetches it).
 *
 * Both are reads (capability `read_books`), write nothing, and name the workspace on every query (§H-TENANT).
 * The line query names it ONCE, on the entry (`e.workspace_id = ?`), and joins the account to the entry's own
 * workspace, so that one predicate is the fence a test can watch fail (critic r1 L4).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { isGovernedSeat } from '../access/index.js';
import { computeLineTax } from '../vat/applyVat.js';
import { isRevenueAccount } from './revenueAccounts.js';
import { zurichParts } from '../banking/ebics/autoSync.js';
import { isSettlementDay } from './format.js';
import { reversalChainOf, signedCountThrough } from '../ledger/reversalChain.js';
import { activeOverridesOf } from './overrides.js';
import { agentSeesEmail, emailOf, periodAround, reviewPeriodOf, REVIEW_PERIODS } from './review.js';
import type { ReviewPeriodUnit } from './review.js';

export const TURNOVER_COMPARE = ['previous_period', 'previous_year', 'none'] as const;
export type TurnoverCompare = (typeof TURNOVER_COMPARE)[number];

/** The longest window one summary reads (two years and a day). */
export const TURNOVER_MAX_DAYS = 732;
/** How many customers the summary names before it sums the rest. */
export const TURNOVER_TOP_DEFAULT = 10;
export const TURNOVER_TOP_MAX = 50;

const OUTPUT_VAT_NUMBERS = ['2200'];
const INPUT_VAT_NUMBERS = ['1170', '1171'];

export interface TurnoverSummaryInput {
  from?: unknown;
  to?: unknown;
  compare?: unknown;
  top?: unknown;
}

export interface TurnoverFigures {
  turnoverNetMinor: number;
  /** The part of the turnover the settlement sources carry (sum of their `bySource` rows). */
  settlementTurnoverMinor: number;
  /** The VAT on the settlement sources' sales and refunds (2200), never an invoice's or the Saldierung's. */
  outputVat: { amountMinor: number; formLines: string[] };
  /** The input VAT on the processor's fees; null under Saldo or Pauschal, which deducts none. */
  feeInputVat: { amountMinor: number; formLines: string[] } | null;
  sales: { count: number; netMinor: number; averageMinor: number | null };
  /** The revenue net of the entries that lower the turnover (refunds, credit notes, reversals), negative. */
  reductionsMinor: number;
  payouts: { count: number; amountMinor: number };
  /** Posted entries that carry a revenue line. */
  entries: number;
}

export interface TurnoverSourceFigure {
  key: string;
  kind: 'settlement' | 'invoices' | 'other';
  system: string | null;
  processor: string | null;
  turnoverNetMinor: number;
  salesCount: number;
}

export interface TurnoverMonth {
  month: string;
  turnoverNetMinor: number;
  bySource: Record<string, number>;
}

export interface TurnoverCustomer {
  key: string;
  name: string | null;
  email: string | null;
  masked: boolean;
  turnoverNetMinor: number;
  salesCount: number;
}

export type TurnoverSummaryOk = {
  period: { from: string; to: string };
  /** The workspace's VAT method now (`effektiv`, `saldo`, `pauschal`, `none`): the Studio words the VAT tile by it. */
  vatMethod: string;
  compare: { mode: TurnoverCompare; from: string; to: string } | null;
  totals: TurnoverFigures;
  previous: TurnoverFigures | null;
  byMonth: TurnoverMonth[];
  bySource: TurnoverSourceFigure[];
  byCustomer: { top: TurnoverCustomer[]; rest: { customers: number; turnoverNetMinor: number } };
  accounts: { revenue: string; outputVat: string[]; inputVat: string[]; clearing: string[] };
};

function isErr<T>(x: T | Err): x is Err {
  return (x as { ok?: unknown }).ok === false;
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const dayOf = (s: string): Date => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number): string => iso(new Date(dayOf(s).getTime() + n * 86_400_000));
const daysBetween = (a: string, b: string): number => Math.round((dayOf(b).getTime() - dayOf(a).getTime()) / 86_400_000);
const lastOfMonth = (y: number, m0: number): string => iso(new Date(Date.UTC(y, m0 + 1, 0)));

/** The same window a year earlier (29.02 becomes 28.02). */
function minusYear(day: string): string {
  const y = Number(day.slice(0, 4)) - 1;
  const md = day.slice(5);
  if (md === '02-29') return `${y}-02-28`;
  return `${y}-${md}`;
}

/**
 * The comparison window, the same length as the window (D203: each KPI against the previous period):
 * `previous_period` steps back by the window's whole months when it is made of whole months, else by its
 * number of days; `previous_year` is the same dates a year earlier.
 */
export function compareWindowOf(from: string, to: string, mode: TurnoverCompare): { from: string; to: string } | null {
  if (mode === 'none') return null;
  if (mode === 'previous_year') {
    const ty0 = Number(to.slice(0, 4));
    const tm0 = Number(to.slice(5, 7)) - 1;
    // A window that ends on a month's last day ends on that month's last day a year earlier (February).
    return { from: minusYear(from), to: to === lastOfMonth(ty0, tm0) ? lastOfMonth(ty0 - 1, tm0) : minusYear(to) };
  }
  const fy = Number(from.slice(0, 4));
  const fm = Number(from.slice(5, 7)) - 1;
  const ty = Number(to.slice(0, 4));
  const tm = Number(to.slice(5, 7)) - 1;
  if (from.slice(8) === '01' && to === lastOfMonth(ty, tm)) {
    const months = (ty - fy) * 12 + (tm - fm) + 1;
    const start = new Date(Date.UTC(fy, fm - months, 1));
    return { from: iso(start), to: addDays(from, -1) };
  }
  const days = daysBetween(from, to) + 1;
  return { from: addDays(from, -days), to: addDays(from, -1) };
}

interface LineRow {
  entry_id: string;
  date: string;
  source: string;
  reverses_entry_id: string | null;
  number: string;
  type: string;
  account_id: string;
  d: number;
  c: number;
  tax_code: string | null;
}

interface EntryAgg {
  id: string;
  date: string;
  source: string;
  reverses: string | null;
  revenueLines: number;
  turnoverMinor: number;
  outputVatMinor: number;
  inputVatMinor: number;
  clearingMinor: number;
  revenueCodes: Set<string>;
  otherCodes: Set<string>;
}

interface Attribution {
  kind: 'settlement' | 'invoices' | 'other';
  system: string | null;
  processor: string | null;
  eventKind: string | null;
  customer: { key: string; name: string | null; email: string | null; masked: boolean } | null;
}

/** The clearing accounts of every saved settlement template (§H-TENANT). */
function clearingAccountsOf(ctx: WorkspaceContext): { id: string; number: string }[] {
  const rows = ctx.store.db.prepare('SELECT template_json FROM settlement_template WHERE workspace_id = ?').all(ctx.workspaceId) as { template_json: string }[];
  const ids = new Set<string>();
  for (const r of rows) {
    try {
      const t = JSON.parse(r.template_json) as { clearingAccountId?: unknown };
      if (typeof t.clearingAccountId === 'string' && t.clearingAccountId.length > 0) ids.add(t.clearingAccountId);
    } catch {
      // A template that does not parse names no clearing account; the import refuses it on its own.
    }
  }
  const out: { id: string; number: string }[] = [];
  const read = ctx.store.db.prepare('SELECT id, number FROM account WHERE workspace_id = ? AND id = ?');
  for (const id of ids) {
    const a = read.get(ctx.workspaceId, id) as { id: string; number: string } | undefined;
    if (a !== undefined) out.push(a);
  }
  return out.sort((a, b) => a.number.localeCompare(b.number));
}

/**
 * Every posted, non-close line of the window on a result, VAT or clearing account (§H-TENANT on each table). No
 * account NUMBER filter for revenue (critic r2 L1): the Erfolgsrechnung reads a number by its leading integer
 * (`accountNumberValue`, so "03200" and " 3210" are Nettoerlöse there), and a `LIKE '3%'` prefilter dropped them
 * here. Every income or expense line is read; `isRevenueAccount` alone decides.
 */
function linesOf(ctx: WorkspaceContext, from: string, to: string, clearingIds: readonly string[]): LineRow[] {
  return ctx.store.db
    .prepare(
      `SELECT e.id AS entry_id, e.date, e.source, e.reverses_entry_id, a.number, a.type, a.id AS account_id,
              l.base_debit_minor AS d, l.base_credit_minor AS c, l.tax_code
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id AND a.workspace_id = e.workspace_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.source != 'close' AND e.date >= ? AND e.date <= ?
          AND (a.type IN ('income', 'expense')
               OR a.number IN ('2200', '1170', '1171')
               OR a.id IN (SELECT value FROM json_each(?)))
        ORDER BY e.date, e.id`,
    )
    .all(ctx.workspaceId, from, to, JSON.stringify(clearingIds)) as LineRow[];
}

/** A revenue line (`revenueAccounts.ts`): the only thing that decides (the query reads every result line). */
const isRevenue = isRevenueAccount;

function aggregateEntries(lines: readonly LineRow[], clearing: ReadonlySet<string>): Map<string, EntryAgg> {
  const out = new Map<string, EntryAgg>();
  for (const l of lines) {
    let e = out.get(l.entry_id);
    if (e === undefined) {
      e = { id: l.entry_id, date: l.date, source: l.source, reverses: l.reverses_entry_id, revenueLines: 0, turnoverMinor: 0, outputVatMinor: 0, inputVatMinor: 0, clearingMinor: 0, revenueCodes: new Set(), otherCodes: new Set() };
      out.set(l.entry_id, e);
    }
    if (isRevenue(l)) {
      e.revenueLines += 1;
      e.turnoverMinor += l.c - l.d;
      if (l.tax_code !== null) e.revenueCodes.add(l.tax_code);
    } else if (OUTPUT_VAT_NUMBERS.includes(l.number)) {
      e.outputVatMinor += l.c - l.d;
    } else if (INPUT_VAT_NUMBERS.includes(l.number)) {
      e.inputVatMinor += l.d - l.c;
    }
    if (clearing.has(l.account_id)) e.clearingMinor += l.c - l.d;
  }
  return out;
}

/** The tax codes on an entry's other lines (a fee's expense line), for the fee input VAT's form lines. */
function otherCodesOf(ctx: WorkspaceContext, entryId: string): string[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT DISTINCT l.tax_code FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND l.entry_id = ? AND l.tax_code IS NOT NULL`,
    )
    .all(ctx.workspaceId, entryId) as { tax_code: string }[];
  return rows.map((r) => r.tax_code);
}

function textOf(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length > 0 && s.length <= max ? s : null;
}

/** Thrown when two settlement events name one entry: the summary refuses rather than guess. */
class AmbiguousAttribution extends Error {
  constructor(readonly entryId: string) {
    super('settlement_event_ambiguous');
  }
}

/** Where each entry came from and who bought, one attribution per entry; a reversal inherits its original's. */
function attributionsOf(ctx: WorkspaceContext, entries: ReadonlyMap<string, EntryAgg>): Map<string, Attribution> {
  const showPayer = !isGovernedSeat(ctx.store, ctx.actor) || agentSeesEmail(ctx);
  const showContact = ctx.capabilities.assert('read_master_data').ok;
  const settlement = ctx.store.db.prepare(
    'SELECT source_system, source_processor, kind, counterparty, refs_json FROM settlement_event WHERE workspace_id = ? AND entry_id = ? LIMIT 2',
  );
  const documentOf = ctx.store.db.prepare(
    `SELECT d.type, c.id AS contact_id, c.name FROM document d
       LEFT JOIN contact c ON c.id = d.contact_id AND c.workspace_id = d.workspace_id
      WHERE d.workspace_id = ? AND d.posted_entry_id = ? LIMIT 1`,
  );
  const entryOf = ctx.store.db.prepare('SELECT source, reverses_entry_id FROM journal_entry WHERE workspace_id = ? AND id = ?');
  const cache = new Map<string, Attribution>();
  const own = (id: string, source: string): Attribution => {
    const found = settlement.all(ctx.workspaceId, id) as { source_system: string; source_processor: string; kind: string; counterparty: string | null; refs_json: string | null }[];
    // One event per entry (the import books one entry per event; critic r3 L, schema.ts has no unique index on
    // the entry): two events on one entry would make every attribution here a guess, so the read refuses.
    if (found.length > 1) throw new AmbiguousAttribution(id);
    const s = found[0];
    if (s !== undefined) {
      let refs: Record<string, unknown> = {};
      try {
        const v = s.refs_json === null ? null : (JSON.parse(s.refs_json) as unknown);
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) refs = v as Record<string, unknown>;
      } catch {
        refs = {};
      }
      const email = emailOf(refs['counterpartyEmail']);
      const name = textOf(refs['counterpartyName'], 200) ?? textOf(s.counterparty, 200);
      const who = email ?? name;
      const customer =
        who === null
          ? null
          : showPayer
            ? { key: `payer:${who.toLowerCase()}`, name, email, masked: false }
            : { key: 'payer:masked', name: null, email: null, masked: true };
      return { kind: 'settlement', system: s.source_system, processor: s.source_processor, eventKind: s.kind, customer };
    }
    const doc = documentOf.get(ctx.workspaceId, id) as { type: string; contact_id: string | null; name: string | null } | undefined;
    if (doc !== undefined || source === 'invoice' || source === 'credit_note') {
      const customer =
        doc?.contact_id == null
          ? null
          : showContact
            ? { key: `contact:${doc.contact_id}`, name: doc.name, email: null, masked: false }
            : { key: 'contact:masked', name: null, email: null, masked: true };
      return { kind: 'invoices', system: null, processor: null, eventKind: null, customer };
    }
    return { kind: 'other', system: null, processor: null, eventKind: null, customer: null };
  };
  const resolve = (id: string, source: string, reverses: string | null, depth: number): Attribution => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    let a = own(id, source);
    if (a.kind === 'other' && reverses !== null && depth < 16) {
      const orig = entryOf.get(ctx.workspaceId, reverses) as { source: string; reverses_entry_id: string | null } | undefined;
      if (orig !== undefined) a = resolve(reverses, orig.source, orig.reverses_entry_id, depth + 1);
    }
    cache.set(id, a);
    return a;
  };
  const out = new Map<string, Attribution>();
  for (const e of entries.values()) out.set(e.id, resolve(e.id, e.source, e.reverses, 0));
  return out;
}

const sourceKeyOf = (a: Attribution): string => (a.kind === 'settlement' ? `settlement:${a.system ?? ''}:${a.processor ?? ''}` : a.kind);

function formLinesOf(ctx: WorkspaceContext, codes: ReadonlySet<string>, day: string): string[] {
  const lines = new Set<string>();
  for (const code of codes) {
    const probe = computeLineTax(ctx, { amountMinor: 10000, amountIsGross: false, taxCode: code, supplyDate: day });
    const line = probe.ok ? ((probe as unknown as { formLine?: string | null }).formLine ?? null) : null;
    if (line !== null && line.length > 0) lines.add(line);
  }
  return [...lines].sort();
}

interface WindowRead {
  figures: TurnoverFigures;
  entries: Map<string, EntryAgg>;
  attributions: Map<string, Attribution>;
  counted: Set<string>;
}

/** The kinds whose 2200 the VAT tile sums, and the kinds whose 1170/1171 is a fee's input VAT. */
const OUTPUT_VAT_KINDS: ReadonlySet<string> = new Set(['sale', 'refund']);
const FEE_KINDS: ReadonlySet<string> = new Set(['processing_fee', 'service_fee']);

/** Saldo and Pauschal deduct no input VAT (MWSTG Art. 37). */
function deductsInputVat(method: string): boolean {
  return method !== 'saldo' && method !== 'pauschal';
}

/** The workspace's VAT method now (§H-TENANT: the workspace row itself). */
function vatMethodOf(ctx: WorkspaceContext): string {
  const row = ctx.store.db.prepare('SELECT vat_method FROM workspace WHERE id = ?').get(ctx.workspaceId) as { vat_method: string | null } | undefined;
  return row?.vat_method ?? 'none';
}

/**
 * THE SALES (module header): one set, read from `settlement_event` joined to its posted, non-close entry dated in
 * the window, kind `sale`, with each entry's lines, so the revenue net is the entry's own. A sale counts when its
 * revenue net is positive and its reversal chain stands through the window's end.
 */
function salesOf(ctx: WorkspaceContext, from: string, to: string): Map<string, number> {
  const rows = ctx.store.db
    .prepare(
      `SELECT s.entry_id, a.number, a.type, l.base_debit_minor AS d, l.base_credit_minor AS c
         FROM settlement_event s
         JOIN journal_entry e ON e.id = s.entry_id AND e.workspace_id = s.workspace_id
         JOIN journal_line l ON l.entry_id = e.id
         JOIN account a ON a.id = l.account_id AND a.workspace_id = e.workspace_id
        WHERE s.workspace_id = ? AND s.kind = 'sale' AND e.status = 'posted' AND e.source != 'close'
          AND e.date >= ? AND e.date <= ?`,
    )
    .all(ctx.workspaceId, from, to) as { entry_id: string; number: string; type: string; d: number; c: number }[];
  const net = new Map<string, { lines: number; minor: number }>();
  for (const r of rows) {
    const x = net.get(r.entry_id) ?? { lines: 0, minor: 0 };
    if (isRevenue(r)) {
      x.lines += 1;
      x.minor += r.c - r.d;
    }
    net.set(r.entry_id, x);
  }
  const out = new Map<string, number>();
  for (const [entryId, x] of net) {
    if (x.lines === 0 || x.minor <= 0) continue;
    const chain = reversalChainOf(ctx, entryId);
    // The chain walk is fenced on this workspace: an entry the join found but the walk does not is a tenant
    // breach, never a sale (critic r3, §H-TENANT on both tables).
    if (chain.length === 0) throw new Error(`settlement sale ${entryId} is not an entry of this workspace`);
    if (signedCountThrough(chain, to) >= 1) out.set(entryId, x.minor);
  }
  return out;
}

/** The figures of one window, from the books (module header). */
function readWindow(ctx: WorkspaceContext, from: string, to: string, clearing: readonly { id: string }[], method: string): WindowRead {
  const clearingIds = new Set(clearing.map((c) => c.id));
  const entries = aggregateEntries(linesOf(ctx, from, to, [...clearingIds]), clearingIds);
  const attributions = attributionsOf(ctx, entries);
  const sales = salesOf(ctx, from, to);
  const outCodes = new Set<string>();
  const inCodes = new Set<string>();
  const counted = new Set<string>(sales.keys());
  // A payout and its reversals net per chain (critic r1 L2): keyed by the entry the chain starts from.
  const payoutChains = new Map<string, number>();
  const feeInputVat = { amountMinor: 0, formLines: [] as string[] };
  const f: TurnoverFigures = {
    turnoverNetMinor: 0,
    settlementTurnoverMinor: 0,
    outputVat: { amountMinor: 0, formLines: [] },
    feeInputVat: null,
    sales: { count: sales.size, netMinor: [...sales.values()].reduce((x, y) => x + y, 0), averageMinor: null },
    reductionsMinor: 0,
    payouts: { count: 0, amountMinor: 0 },
    entries: 0,
  };
  for (const e of entries.values()) {
    const a = attributions.get(e.id) as Attribution;
    if (e.revenueLines > 0) {
      f.entries += 1;
      f.turnoverNetMinor += e.turnoverMinor;
      if (a.kind === 'settlement') f.settlementTurnoverMinor += e.turnoverMinor;
      if (e.turnoverMinor < 0) f.reductionsMinor += e.turnoverMinor;
    }
    // THE VAT IS THE SETTLEMENT EVENTS' OWN (re-cut): only entries attributed to a sale or refund event, or a
    // reversal in such a chain, whose lines are already mirrored (no sign flip here).
    if (a.kind === 'settlement' && a.eventKind !== null && OUTPUT_VAT_KINDS.has(a.eventKind)) {
      f.outputVat.amountMinor += e.outputVatMinor;
      if (e.outputVatMinor !== 0) for (const c of e.revenueCodes) outCodes.add(c);
    }
    if (a.kind === 'settlement' && a.eventKind !== null && FEE_KINDS.has(a.eventKind) && e.inputVatMinor !== 0) {
      feeInputVat.amountMinor += e.inputVatMinor;
      for (const c of otherCodesOf(ctx, e.id)) inCodes.add(c);
    }
    const isPayout = e.revenueLines === 0 && e.clearingMinor !== 0 && (a.kind !== 'settlement' || a.eventKind === 'bank_payout' || a.eventKind === 'bank_payout_summary');
    if (isPayout) {
      const root = e.reverses ?? e.id;
      payoutChains.set(root, (payoutChains.get(root) ?? 0) + e.clearingMinor);
      f.payouts.amountMinor += e.clearingMinor;
    }
  }
  f.payouts.count = [...payoutChains.values()].filter((v) => v !== 0).length;
  f.outputVat.formLines = formLinesOf(ctx, outCodes, to);
  if (deductsInputVat(method)) {
    feeInputVat.formLines = formLinesOf(ctx, inCodes, to);
    f.feeInputVat = feeInputVat;
  }
  f.sales.averageMinor = f.sales.count === 0 ? null : Math.round(f.sales.netMinor / f.sales.count);
  return { figures: f, entries, attributions, counted };
}

function monthsOf(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const endKey = to.slice(0, 7);
  for (let guard = 0; guard < 40; guard += 1) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    out.push(key);
    if (key >= endKey) break;
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

function readDay(v: unknown, field: string): string | Err {
  if (typeof v !== 'string' || !isSettlementDay(v)) return err('invalid_input', { field, reason: 'YYYY-MM-DD' }) as Err;
  return v;
}

/** `turnover_summary` (module header). */
export function turnoverSummary(ctx: WorkspaceContext, input: TurnoverSummaryInput): Result<TurnoverSummaryOk> {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable as Result<TurnoverSummaryOk>;
  const from = readDay(input.from, 'from');
  if (isErr(from)) return from;
  const to = readDay(input.to, 'to');
  if (isErr(to)) return to;
  if (from > to) return err('invalid_input', { field: 'to', reason: 'to lies before from' }) as Err;
  if (daysBetween(from, to) + 1 > TURNOVER_MAX_DAYS) return err('invalid_input', { field: 'to', reason: `at most ${TURNOVER_MAX_DAYS} days` }) as Err;
  const mode = input.compare === undefined || input.compare === null ? 'previous_period' : input.compare;
  if (typeof mode !== 'string' || !(TURNOVER_COMPARE as readonly string[]).includes(mode)) {
    return err('invalid_input', { field: 'compare', reason: `one of ${TURNOVER_COMPARE.join(', ')}` }) as Err;
  }
  let top = TURNOVER_TOP_DEFAULT;
  if (input.top !== undefined && input.top !== null) {
    if (typeof input.top !== 'number' || !Number.isInteger(input.top) || input.top < 0 || input.top > TURNOVER_TOP_MAX) {
      return err('invalid_input', { field: 'top', reason: `an integer from 0 to ${TURNOVER_TOP_MAX}` }) as Err;
    }
    top = input.top;
  }
  const clearing = clearingAccountsOf(ctx);
  const method = vatMethodOf(ctx);
  let now: WindowRead;
  let previous: TurnoverFigures | null;
  const window = compareWindowOf(from, to, mode as TurnoverCompare);
  try {
    now = readWindow(ctx, from, to, clearing, method);
    previous = window === null ? null : readWindow(ctx, window.from, window.to, clearing, method).figures;
  } catch (x) {
    if (x instanceof AmbiguousAttribution) {
      return err('settlement_event_ambiguous', { entryId: x.entryId, reason: 'two settlement events name one journal entry, so the entry cannot be attributed; the import books one entry per event' }) as Err;
    }
    throw x;
  }

  const sources = new Map<string, TurnoverSourceFigure>();
  const months = new Map<string, TurnoverMonth>(monthsOf(from, to).map((m) => [m, { month: m, turnoverNetMinor: 0, bySource: {} }]));
  const customers = new Map<string, TurnoverCustomer>();
  for (const e of now.entries.values()) {
    if (e.revenueLines === 0) continue;
    const a = now.attributions.get(e.id) as Attribution;
    const key = sourceKeyOf(a);
    const s = sources.get(key) ?? { key, kind: a.kind, system: a.system, processor: a.processor, turnoverNetMinor: 0, salesCount: 0 };
    s.turnoverNetMinor += e.turnoverMinor;
    if (now.counted.has(e.id)) s.salesCount += 1;
    sources.set(key, s);
    const month = months.get(e.date.slice(0, 7));
    if (month !== undefined) {
      month.turnoverNetMinor += e.turnoverMinor;
      month.bySource[key] = (month.bySource[key] ?? 0) + e.turnoverMinor;
    }
    const who = a.customer ?? { key: 'none', name: null, email: null, masked: false };
    const c = customers.get(who.key) ?? { ...who, turnoverNetMinor: 0, salesCount: 0 };
    c.turnoverNetMinor += e.turnoverMinor;
    if (now.counted.has(e.id)) c.salesCount += 1;
    customers.set(who.key, c);
  }
  const order = { settlement: 0, invoices: 1, other: 2 } as const;
  const bySource = [...sources.values()].sort((a, b) => order[a.kind] - order[b.kind] || b.turnoverNetMinor - a.turnoverNetMinor || a.key.localeCompare(b.key));
  const ranked = [...customers.values()].sort((a, b) => b.turnoverNetMinor - a.turnoverNetMinor || a.key.localeCompare(b.key));
  const named = ranked.filter((c) => c.key !== 'none');
  const topList = named.slice(0, top);
  const restList = [...named.slice(top), ...ranked.filter((c) => c.key === 'none')];
  return ok<TurnoverSummaryOk>({
    period: { from, to },
    vatMethod: method,
    compare: window === null ? null : { mode: mode as TurnoverCompare, ...window },
    totals: now.figures,
    previous,
    byMonth: [...months.values()],
    bySource,
    byCustomer: { top: topList, rest: { customers: restList.length, turnoverNetMinor: restList.reduce((s, c) => s + c.turnoverNetMinor, 0) } },
    accounts: { revenue: '3xxx', outputVat: [...OUTPUT_VAT_NUMBERS], inputVat: [...INPUT_VAT_NUMBERS], clearing: clearing.map((c) => c.number) },
  });
}

// --- settlement_periods -----------------------------------------------------------------------------------

export interface SettlementPeriodsInput {
  unit?: unknown;
  around?: unknown;
  before?: unknown;
  after?: unknown;
}

export type SettlementPeriodState = 'to_book' | 'booked' | 'empty';

export interface SettlementPeriod {
  from: string;
  to: string;
  state: SettlementPeriodState;
  /** Settlement events booked with a day in the period. */
  booked: number;
  /** Observed events of the period that wait: never booked, refused or left to a person, not ignored. */
  waiting: number;
  /** Events TILL observed in the period (an import or a pull). */
  observed: number;
}

export type SettlementPeriodsOk = { unit: ReviewPeriodUnit; periods: SettlementPeriod[] };

/** The period of `unit` that starts right after (dir 1) or ends right before (dir -1) the given one. */
function stepPeriod(p: { from: string; to: string }, unit: ReviewPeriodUnit, dir: 1 | -1): { from: string; to: string } {
  return periodAround(dir === 1 ? addDays(p.to, 1) : addDays(p.from, -1), unit);
}

function boundedInt(v: unknown, field: string, max: number, fallback: number): number | Err {
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > max) return err('invalid_input', { field, reason: `an integer from 0 to ${max}` }) as Err;
  return v;
}

/** `settlement_periods` (module header). */
export function settlementPeriods(ctx: WorkspaceContext, input: SettlementPeriodsInput): Result<SettlementPeriodsOk> {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable as Result<SettlementPeriodsOk>;
  let unit: ReviewPeriodUnit = reviewPeriodOf(ctx);
  if (input.unit !== undefined && input.unit !== null) {
    if (typeof input.unit !== 'string' || !(REVIEW_PERIODS as readonly string[]).includes(input.unit)) {
      return err('invalid_input', { field: 'unit', reason: `one of ${REVIEW_PERIODS.join(', ')}` }) as Err;
    }
    unit = input.unit as ReviewPeriodUnit;
  }
  let around = zurichParts(ctx.clock.now()).date;
  if (input.around !== undefined && input.around !== null) {
    const d = readDay(input.around, 'around');
    if (isErr(d)) return d;
    around = d;
  }
  const before = boundedInt(input.before, 'before', 36, 8);
  if (isErr(before)) return before;
  const after = boundedInt(input.after, 'after', 12, 4);
  if (isErr(after)) return after;

  const shown = periodAround(around, unit);
  const list: { from: string; to: string }[] = [shown];
  for (let k = 0; k < before; k += 1) list.unshift(stepPeriod(list[0] as { from: string; to: string }, unit, -1));
  for (let k = 0; k < after; k += 1) list.push(stepPeriod(list[list.length - 1] as { from: string; to: string }, unit, 1));
  const first = (list[0] as { from: string }).from;
  const last = (list[list.length - 1] as { to: string }).to;

  const bookedRows = ctx.store.db
    .prepare('SELECT day FROM settlement_event WHERE workspace_id = ? AND day >= ? AND day <= ?')
    .all(ctx.workspaceId, first, last) as { day: string }[];
  const observedRows = ctx.store.db
    .prepare(
      `SELECT f.source_system AS system, f.source_processor AS processor, f.event_id, f.day,
              EXISTS (SELECT 1 FROM settlement_event s
                       WHERE s.workspace_id = f.workspace_id AND s.source_system = f.source_system
                         AND s.source_processor = f.source_processor AND s.event_id = f.event_id) AS booked,
              (SELECT o.outcome || '|' || ifnull(o.code, '') FROM settlement_feed_outcome o
                WHERE o.workspace_id = f.workspace_id AND o.source_system = f.source_system
                  AND o.source_processor = f.source_processor AND o.event_id = f.event_id
                ORDER BY o.rowid DESC LIMIT 1) AS latest
         FROM settlement_feed_event f
        WHERE f.workspace_id = ? AND f.day >= ? AND f.day <= ?`,
    )
    .all(ctx.workspaceId, first, last) as { system: string; processor: string; event_id: string; day: string; booked: number; latest: string | null }[];
  const overrides = new Map<string, ReadonlySet<string>>();
  const overriddenIn = (system: string, processor: string): ReadonlySet<string> => {
    const k = JSON.stringify([system, processor]);
    let s = overrides.get(k);
    if (s === undefined) {
      s = new Set(activeOverridesOf(ctx, system, processor).keys());
      overrides.set(k, s);
    }
    return s;
  };
  const waits = (r: (typeof observedRows)[number]): boolean => {
    if (r.booked === 1) return false;
    if (overriddenIn(r.system, r.processor).has(r.event_id)) return false;
    const [outcome, code] = (r.latest ?? '|').split('|');
    return outcome === 'refused' || (outcome === 'skipped' && code === 'needs_attention');
  };
  const periods = list.map((p) => {
    const inP = (day: string) => day >= p.from && day <= p.to;
    const booked = bookedRows.filter((r) => inP(r.day)).length;
    const obs = observedRows.filter((r) => inP(r.day));
    const waiting = obs.filter(waits).length;
    const state: SettlementPeriodState = waiting > 0 ? 'to_book' : booked > 0 || obs.length > 0 ? 'booked' : 'empty';
    return { from: p.from, to: p.to, state, booked, waiting, observed: obs.length };
  });
  return ok<SettlementPeriodsOk>({ unit, periods });
}
