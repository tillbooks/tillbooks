/**
 * D198 STATELESS CHECK (S1 to S5, with the owner's answer of 12.11.2026, "Just apply an override
 * functionality. Keep it simple"): what the MWST-Abrechnung of a period P should know about the settlement
 * events TILL observed, before anyone files it. A FINDING, never a block (TILL warns, a person decides), and
 * kept OUT of the G22 return hash (`checklists/hash.ts`): it is no figure of the return.
 *
 * A PURE DERIVED READ, computed fresh on every call. It reads, every query scoped by `workspace_id`
 * (§H-TENANT): the observed record (`settlement_feed_event`, the first sighting's day decides the period),
 * the producer's restatements (`restated.ts`: the figures read are the LATEST STATED ones), the import's rows
 * (`settlement_event`), the flags and the test track (`flags.ts`), the person's overrides
 * (`settlement_event_override`, `resolution.ts`), the facts of the reader refusals in the import's log, and
 * the posted journal entries with their reversal chains (`ledger/reversalChain.ts`). The import is the one
 * booking path TILL links to an event: a person's own entry is never linked to it; a person who handled an
 * event outside the import says so with the override (`resolve_settlement_event` `handled_outside`).
 *
 * SCOPE of P: every observed event dated in P whose kind is `sale` or `refund`, or that carries a non-zero
 * VAT; LESS the test-excluded ones under the settings in force (`settlement.test_events` skip, fees under
 * `settlement.test_fees` book excepted); LESS, for an event the import never booked, the kinds the template
 * skips (`templateSkipped`, counted) and the days before the source's from-date (`beforeFromDate`, counted);
 * LESS events that move nothing. PLUS the reader refusals (S3): an id-bearing event the format reader refused
 * and that was never observed, its id, kind, day and amount from the log rows of that id.
 *
 * THE FIGURE of an event: the signed count (`signedCountThrough`) of its import entry's reversal chain,
 * members dated on or before P's end (0 without an import entry). 0 or less: `missing`, unless the event
 * carries an ACTIVE override; then `override_check` when the producer restated it after the override (more
 * `restated` rows than the override saw), else nothing. Exactly 1: booked. 2 or more: `booked_twice`.
 *
 * `amended`: the import entry counts exactly 1 through P's end and the booked figures (its
 * `settlement_event` row) differ from the latest stated ones in kind, day, amount, net or VAT. It clears when
 * the producer states the booked figures again, or when a person reverses the import entry (and books by
 * hand with an override, or lets a later import book it).
 *
 * `bookedTest` (paper critic H1, under `skip`): every test-excluded event dated in or before P whose figure
 * is 1 or more, with its import entry. The test exclusion removes an event from `missing` only.
 *
 * `earlier`: every in-scope event dated BEFORE P that is listed by any reason through P's end.
 *
 * READER REFUSALS (S3): an undated id-bearing refusal is listed `missing`, undated, in EVERY period's check
 * until its id is observed or it carries an active override (paper critic H5). A refusal without an id
 * cannot be named: `unplaceable` counts it per period (its day in P, or undated) from every document, deduped
 * by source, kind, day, amount and code, and it never clears.
 *
 * Sums per kind (`sale`, `refund`, `input`) of the VAT of the `missing` items; CANCELLING GROUPS
 * (`settlement.check_cancelling_groups`) over the `missing` items only; `testActivity`, `testExcluded`,
 * `uncoveredSources` as built in the re-cut.
 *
 * A past period's check is re-read live: it answers from the ledger as it stands now. Intended (the check is a
 * warning for the next act, never a record of the filing).
 */

import type { WorkspaceContext } from '../context.js';
import { getSetting } from '../settings/index.js';
import { reversalChainOf, isLiveNowChain, signedCountThrough } from '../ledger/reversalChain.js';
import type { ChainMember } from '../ledger/reversalChain.js';
import { SETTLEMENT_EVENT_REFUSALS, isSettlementDay } from './format.js';
import { listSourceRows, pulledRangesOf } from './source.js';
import { readStoredTemplate } from './template.js';
import type { SettlementTemplate } from './template.js';
import { loadTestIndex, testEventsModeOf, testFeesModeOf, testSkips } from './flags.js';
import { figureChanges, foldStated, restatementsOf } from './restated.js';
import { activeOverridesOf } from './resolution.js';

/** The format reader's own refusal codes (S3): the event's figures were never readable. */
const READER_REFUSAL_CODES: readonly string[] = Object.keys(SETTLEMENT_EVENT_REFUSALS);

/** The most items one list carries (the rest are counted). */
const MAX_LISTED = 500;

const PAYOUT_KINDS: ReadonlySet<string> = new Set(['bank_payout', 'bank_payout_summary']);

/** Why an event is listed (S1). */
export const SETTLEMENT_CHECK_REASONS = ['missing', 'booked_twice', 'amended', 'override_check'] as const;
export type SettlementCheckReason = (typeof SETTLEMENT_CHECK_REASONS)[number];

/** Where the observed record of an event came from: the pull that first saw it, or null for a file import. */
export interface Provenance {
  pullId: string | null;
}

export interface LinkedEntry {
  entryId: string;
  date: string;
  /** `import`: the event's own `settlement_event` entry (the one booking TILL links to an event). */
  link: 'import';
}

export interface AmendmentChange {
  field: string;
  was: unknown;
  now: unknown;
}

export interface CheckItem extends Provenance {
  system: string;
  processor: string;
  eventId: string;
  kind: string | null;
  /** The event's day; null for a reader refusal without a readable day (listed in every period). */
  day: string | null;
  amountMinor: number | null;
  netMinor: number | null;
  vatMinor: number | null;
  reason: SettlementCheckReason;
  /** The signed count of the linked entries through the period's end. */
  figure: number;
  /** The import entry, when there is one. */
  entries: LinkedEntry[];
  /** A reader refusal (S3): the reader's code. */
  code?: string;
  /**
   * `amended`: what differs from the booked figures to the latest stated ones (field, was, now);
   * `override_check`: every restatement that arrived after the override, in arrival order.
   */
  changed?: AmendmentChange[];
}

export interface CountWithVat {
  count: number;
  vatMinor: number;
}

export interface UnplaceableItem {
  system: string;
  processor: string;
  code: string;
  kind: string | null;
  day: string | null;
  amountMinor: number | null;
}

export interface SettlementVatFindings {
  /** The period's in-scope events with no booking standing through its end (figure 0 or less). */
  missing: CheckItem[];
  missingCount: number;
  /** Per kind, never one net figure: output VAT of missing sales, of missing refunds, and input VAT of every other kind. */
  missingVatMinor: { sale: number; refund: number; input: number };
  bookedTwice: CheckItem[];
  amended: CheckItem[];
  /** Events a person overrode (`handled_outside`) that the producer restated after the override. */
  overrideCheck: CheckItem[];
  /** Events dated before the period, with the same reasons. */
  earlier: CheckItem[];
  earlierCount: number;
  beforeFromDate: CountWithVat;
  templateSkipped: CountWithVat;
  /** The cancelling groups hidden under `settlement.check_cancelling_groups`. */
  cancellingGroupsHidden: { groups: number; events: number; setting: string };
  /** Reader refusals without an id: they cannot be linked to an entry and never clear (S3). */
  unplaceable: { count: number; items: UnplaceableItem[] };
  /** Only under `settlement.test_events` skip: test events with a booking standing through the period's end. */
  bookedTest: (Provenance & { system: string; processor: string; eventId: string; kind: string | null; day: string | null; amountMinor: number | null; figure: number; entries: LinkedEntry[] })[];
  /**
   * The period's events carrying VAT that the import left off the books as TEST events (security review,
   * 12.11.2026): a test flag never hides VAT silently, so a crafted flag on a real sale shows here.
   */
  testExcluded: { sale: { events: number; vatMinor: number }; refund: { events: number; vatMinor: number }; input: { events: number; vatMinor: number } };
  /**
   * A42 (paper critic M2): the period's events carrying VAT that a person IGNORED in the Umsatz review
   * (`set_settlement_event_ignored`) and that have no booking standing. An ignore never hides VAT silently:
   * counted per kind, never netted, and counted into `hasFindings` like `testExcluded`.
   */
  ignored: { sale: { events: number; vatMinor: number }; refund: { events: number; vatMinor: number }; input: { events: number; vatMinor: number } };
  testActivity: {
    byKind: Record<string, { count: number; amountMinor: number }>;
    testResidueMinor: number;
    unrefundedTestSales: (Provenance & { system: string; processor: string; eventId: string; day: string; amountMinor: number; refundedMinor: number })[];
    unreversedTestTransfers: (Provenance & { system: string; processor: string; eventId: string; day: string; amountMinor: number; reversedMinor: number })[];
  };
  uncoveredSources: { system: string; processor: string; gaps: { from: string; to: string }[] }[];
  /** True when there is anything for a person to look at. */
  hasFindings: boolean;
}

/** One event the check reads: an observed row, or a reader refusal's facts (S3). */
interface CheckEvent {
  eventId: string;
  kind: string | null;
  day: string | null;
  amountMinor: number | null;
  netMinor: number | null;
  vatMinor: number | null;
  pullId: string | null;
  /** The reader's code, for a refusal. */
  refusalCode: string | null;
  /** The latest stated day, when the producer restated it (the period stays the first sighting's). */
  latestDay?: string;
}

function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** [from, to] less the union of `covered`, as day ranges. */
function gapsOf(from: string, to: string, covered: { from: string; to: string }[]): { from: string; to: string }[] {
  const gaps: { from: string; to: string }[] = [];
  let cursor = from;
  for (const r of [...covered].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))) {
    if (r.to < cursor) continue;
    if (r.from > to) break;
    if (r.from > cursor) gaps.push({ from: cursor, to: addDays(r.from, -1) < to ? addDays(r.from, -1) : to });
    const next = addDays(r.to, 1);
    if (next > cursor) cursor = next;
    if (cursor > to) break;
  }
  if (cursor <= to) gaps.push({ from: cursor, to });
  return gaps;
}

/** `settlement.check_cancelling_groups`, `hide_test` (the default) when unreadable. */
export function cancellingGroupsModeOf(ctx: WorkspaceContext): 'hide_test' | 'hide_all' | 'show' {
  try {
    const v = getSetting<string>(ctx, 'settlement.check_cancelling_groups');
    return v === 'hide_all' || v === 'show' ? v : 'hide_test';
  } catch {
    return 'hide_test';
  }
}

/** The observed events of one source, then its reader refusals that were never observed (S3). */
function eventsOf(ctx: WorkspaceContext, system: string, processor: string): CheckEvent[] {
  const db = ctx.store.db;
  const observed = (
    db
      .prepare(
        `SELECT event_id, kind, day, amount_minor, net_minor, vat_minor, pull_id FROM settlement_feed_event
          WHERE workspace_id = ? AND source_system = ? AND source_processor = ? ORDER BY day, rowid`,
      )
      .all(ctx.workspaceId, system, processor) as {
      event_id: string;
      kind: string;
      day: string;
      amount_minor: number;
      net_minor: number;
      vat_minor: number | null;
      pull_id: string | null;
    }[]
  ).map(
    (o): CheckEvent => ({
      eventId: o.event_id,
      kind: o.kind,
      day: o.day,
      amountMinor: o.amount_minor,
      netMinor: o.net_minor,
      vatMinor: o.vat_minor,
      pullId: o.pull_id,
      refusalCode: null,
    }),
  );
  // S3: the facts of a refusal come from the log rows of its id; when several rows carry them, any one (they
  // describe the same arrival): the first that carries each field. Observed beats refused; a booked event
  // (a `settlement_event` row) is no refusal.
  const rows = db
    .prepare(
      `SELECT o.event_id, o.code, o.kind, o.day, o.amount_minor, o.pull_id FROM settlement_feed_outcome o
        WHERE o.workspace_id = ? AND o.source_system = ? AND o.source_processor = ? AND o.event_id IS NOT NULL
          AND o.outcome = 'refused' AND o.code IN (${READER_REFUSAL_CODES.map(() => '?').join(', ')})
          AND NOT EXISTS (SELECT 1 FROM settlement_feed_event f
                           WHERE f.workspace_id = o.workspace_id AND f.source_system = o.source_system
                             AND f.source_processor = o.source_processor AND f.event_id = o.event_id)
          AND NOT EXISTS (SELECT 1 FROM settlement_event b
                           WHERE b.workspace_id = o.workspace_id AND b.source_system = o.source_system
                             AND b.source_processor = o.source_processor AND b.event_id = o.event_id)
        ORDER BY o.rowid`,
    )
    .all(ctx.workspaceId, system, processor, ...READER_REFUSAL_CODES) as {
    event_id: string;
    code: string;
    kind: string | null;
    day: string | null;
    amount_minor: number | null;
    pull_id: string | null;
  }[];
  const refused = new Map<string, CheckEvent>();
  for (const r of rows) {
    const day = r.day !== null && isSettlementDay(r.day) ? r.day : null;
    const e = refused.get(r.event_id);
    if (e === undefined) {
      refused.set(r.event_id, { eventId: r.event_id, kind: r.kind, day, amountMinor: r.amount_minor, netMinor: null, vatMinor: null, pullId: r.pull_id, refusalCode: r.code });
      continue;
    }
    e.kind ??= r.kind;
    e.day ??= day;
    e.amountMinor ??= r.amount_minor;
  }
  return [...observed, ...refused.values()];
}

/** The pre-filing findings of one period (module header). */
export function settlementVatFindings(ctx: WorkspaceContext, periodStart: string, periodEnd: string): SettlementVatFindings {
  const testModes = { events: testEventsModeOf(ctx), fees: testFeesModeOf(ctx) };
  const groupsMode = cancellingGroupsModeOf(ctx);
  const chains = new Map<string, ChainMember[]>();
  const chainOf = (entryId: string): ChainMember[] => {
    let c = chains.get(entryId);
    if (c === undefined) {
      c = reversalChainOf(ctx, entryId);
      chains.set(entryId, c);
    }
    return c;
  };
  const countThrough = (entryId: string): number => signedCountThrough(chainOf(entryId), periodEnd);

  const missing: CheckItem[] = [];
  const bookedTwice: CheckItem[] = [];
  const amended: CheckItem[] = [];
  const overrideCheck: CheckItem[] = [];
  const earlier: CheckItem[] = [];
  const beforeFromDate: CountWithVat = { count: 0, vatMinor: 0 };
  const templateSkipped: CountWithVat = { count: 0, vatMinor: 0 };
  const bookedTest: SettlementVatFindings['bookedTest'] = [];
  const byKind: Record<string, { count: number; amountMinor: number }> = {};
  let residue = 0;
  const unrefunded: SettlementVatFindings['testActivity']['unrefundedTestSales'] = [];
  const unreversed: SettlementVatFindings['testActivity']['unreversedTestTransfers'] = [];
  const testExcludedVat = { sale: { events: 0, vatMinor: 0 }, refund: { events: 0, vatMinor: 0 }, input: { events: 0, vatMinor: 0 } };
  const ignoredVat = { sale: { events: 0, vatMinor: 0 }, refund: { events: 0, vatMinor: 0 }, input: { events: 0, vatMinor: 0 } };
  const keysByItem = new Map<CheckItem, readonly string[]>();
  const testItems = new Set<CheckItem>();
  const unplaceable = new Map<string, UnplaceableItem>();

  // Every source the workspace observed an event of, or logged a refusal for.
  const sources = ctx.store.db
    .prepare(
      `SELECT source_system, source_processor FROM settlement_feed_event WHERE workspace_id = ?
       UNION SELECT source_system, source_processor FROM settlement_feed_outcome WHERE workspace_id = ?
       ORDER BY source_system, source_processor`,
    )
    .all(ctx.workspaceId, ctx.workspaceId) as { source_system: string; source_processor: string }[];

  for (const src of sources) {
    const system = src.source_system;
    const processor = src.source_processor;
    const db = ctx.store.db;
    const fromDate =
      (db.prepare('SELECT from_date FROM settlement_source WHERE workspace_id = ? AND source_system = ? AND source_processor = ?').get(ctx.workspaceId, system, processor) as
        | { from_date: string }
        | undefined)?.from_date ?? null;
    const template: SettlementTemplate | null = readStoredTemplate(ctx, system, processor)?.template ?? null;
    const templateKinds = (template?.kinds as Record<string, { action?: string }> | undefined) ?? null;
    const test = loadTestIndex(ctx, system, processor);
    // The import's rows: the entry and the figures it was booked from.
    const importRows = new Map(
      (
        db
          .prepare('SELECT event_id, entry_id, kind, day, amount_minor, net_minor, vat_minor FROM settlement_event WHERE workspace_id = ? AND source_system = ? AND source_processor = ?')
          .all(ctx.workspaceId, system, processor) as {
          event_id: string;
          entry_id: string;
          kind: string;
          day: string;
          amount_minor: number;
          net_minor: number;
          vat_minor: number | null;
        }[]
      ).map((r) => [r.event_id, r]),
    );
    // The producer's restatements, in arrival order, and the person's active overrides.
    const restatements = restatementsOf(ctx, system, processor);
    const overrides = activeOverridesOf(ctx, system, processor);
    // Every observed event, its figures the LATEST STATED ones (its day stays the first sighting's: the
    // period is decided once).
    const events = eventsOf(ctx, system, processor).map((e): CheckEvent => {
      const lists = restatements.get(e.eventId);
      if (e.refusalCode !== null || lists === undefined || e.kind === null || e.day === null || e.amountMinor === null || e.netMinor === null) return e;
      const latest = foldStated({ kind: e.kind, day: e.day, amountMinor: e.amountMinor, netMinor: e.netMinor, vatMinor: e.vatMinor }, lists);
      return { ...e, kind: latest.kind, amountMinor: latest.amountMinor, netMinor: latest.netMinor, vatMinor: latest.vatMinor, latestDay: latest.day };
    });
    const byKey = new Map<string, CheckEvent[]>();
    for (const e of events) if (e.refusalCode === null) for (const k of test.keysOf(e.eventId)) byKey.set(k, [...(byKey.get(k) ?? []), e]);

    for (const e of events) {
      const inQ = e.day !== null && e.day >= periodStart && e.day <= periodEnd;
      const isTest = test.isTest(e.eventId);
      const importRow = importRows.get(e.eventId);
      const importEntryId = importRow?.entry_id ?? null;
      const importChain = importEntryId === null ? [] : chainOf(importEntryId);
      const base = { system, processor, eventId: e.eventId, kind: e.kind, day: e.day, amountMinor: e.amountMinor, pullId: e.pullId };

      // TEST ACTIVITY of the period (every observed test event, whatever the modes), as built.
      if (inQ && isTest && e.refusalCode === null && e.kind !== null && !PAYOUT_KINDS.has(e.kind) && e.day !== null && e.amountMinor !== null) {
        const amount = e.amountMinor;
        const k = (byKind[e.kind] ??= { count: 0, amountMinor: 0 });
        k.count += 1;
        k.amountMinor += amount;
        if (!(importEntryId !== null && isLiveNowChain(importChain))) residue -= amount;
        const partners = (kinds: string[]): CheckEvent[] => {
          const seen = new Map<string, CheckEvent>();
          for (const key of test.keysOf(e.eventId)) for (const o of byKey.get(key) ?? []) if (o.kind !== null && kinds.includes(o.kind) && test.isTest(o.eventId)) seen.set(o.eventId, o);
          return [...seen.values()];
        };
        if (e.kind === 'sale') {
          const refunded = partners(['refund']).reduce((s, o) => s + (o.amountMinor ?? 0), 0);
          if (amount + refunded > 0) unrefunded.push({ ...base, day: e.day, amountMinor: amount, refundedMinor: refunded });
        }
        if (e.kind === 'third_party_payout') {
          const reversed = partners(['third_party_payout_reversal']).reduce((s, o) => s + (o.amountMinor ?? 0), 0);
          if (amount + reversed < 0) unreversed.push({ ...base, day: e.day, amountMinor: amount, reversedMinor: reversed });
        }
      }

      if (e.day !== null && e.day > periodEnd) continue;
      // A42 (code critic r1 L3): an event a person ignored is skipped `ignored` before the test check (import step 2
      // runs before step 4), so it is counted under `ignored`, never also under `testExcluded`.
      const testExcluded = e.kind !== null && isTest && testSkips(e.kind, testModes) && overrides.get(e.eventId)?.source !== 'ignored';
      const vat = e.vatMinor ?? 0;
      // Every test-excluded event of the period carrying VAT, whatever its kind (security review: the same
      // candidate set as the VAT path; a transfer or fee goes to `input`).
      if (inQ && testExcluded && importEntryId === null && vat !== 0) {
        const bucket = e.kind === 'sale' ? testExcludedVat.sale : e.kind === 'refund' ? testExcludedVat.refund : testExcludedVat.input;
        bucket.events += 1;
        bucket.vatMinor += vat;
      }

      // THE IMPORT ENTRY: the one booking TILL links to an event.
      const entries: LinkedEntry[] = importEntryId !== null ? [{ entryId: importEntryId, date: importChain[0]?.date ?? '', link: 'import' }] : [];
      const figure = importEntryId !== null ? countThrough(importEntryId) : 0;
      const override = overrides.get(e.eventId);
      const restatedLists = restatements.get(e.eventId) ?? [];

      // BOOKED TEST (paper critic H1): the test exclusion removes an event from `missing` only.
      if (testModes.events === 'skip' && testExcluded && figure >= 1) bookedTest.push({ ...base, figure, entries });

      const candidate = e.refusalCode !== null || e.kind === 'sale' || e.kind === 'refund' || vat !== 0;
      if (testExcluded) continue;
      // Code critic G1 (12.11.2026): the scope and zero filters read the LATEST STATED figures, so they apply only
      // to events the import never booked. A booked event the producer restated to 0.00, or to a kind without
      // VAT, stays in the check and reaches the `amended` and `booked_twice` tests below (its VAT is still in the
      // books).
      if (importEntryId === null && !candidate) continue;
      if (importEntryId === null && e.refusalCode === null && e.amountMinor === 0 && e.netMinor === 0 && vat === 0) continue;
      if (importEntryId === null) {
        if (e.kind !== null && templateKinds?.[e.kind]?.action === 'skip') {
          if (inQ) {
            templateSkipped.count += 1;
            templateSkipped.vatMinor += vat;
          }
          continue;
        }
        if (fromDate !== null && e.day !== null && e.day < fromDate) {
          if (inQ) {
            beforeFromDate.count += 1;
            beforeFromDate.vatMinor += vat;
          }
          continue;
        }
      }

      const item = (reason: SettlementCheckReason, list: LinkedEntry[], extra: Partial<CheckItem> = {}): CheckItem => ({
        ...base,
        netMinor: e.netMinor,
        vatMinor: e.vatMinor,
        reason,
        figure,
        entries: list,
        ...(e.refusalCode !== null ? { code: e.refusalCode } : {}),
        ...extra,
      });

      // AN UNDATED REFUSAL (paper critic H5): listed in every period until it is observed or overridden.
      if (e.day === null) {
        if (override === undefined) missing.push(item('missing', entries));
        continue;
      }

      const found: CheckItem[] = [];
      if (figure <= 0) {
        // THE OVERRIDE: an event a person handled outside the import is not missing; restated after the
        // override, it is listed again for a person to check.
        if (override === undefined) found.push(item('missing', entries));
        else if (override.source === 'ignored' && inQ && vat !== 0) {
          // A42 (paper critic M2): an ignored event's VAT is counted, never hidden.
          const bucket = e.kind === 'sale' ? ignoredVat.sale : e.kind === 'refund' ? ignoredVat.refund : ignoredVat.input;
          bucket.events += 1;
          bucket.vatMinor += vat;
        }
        if (override !== undefined && restatedLists.length > override.amendmentsSeen) found.push(item('override_check', entries, { changed: restatedLists.slice(override.amendmentsSeen).flat() }));
      }
      if (figure >= 2) found.push(item('booked_twice', entries));
      // AMENDED: the import booking stands exactly once and does not carry the latest stated figures.
      if (importRow !== undefined && figure === 1 && e.kind !== null && e.amountMinor !== null && e.netMinor !== null) {
        const latest = { kind: e.kind, day: e.latestDay ?? e.day, amountMinor: e.amountMinor, netMinor: e.netMinor, vatMinor: e.vatMinor };
        const booked = { kind: importRow.kind, day: importRow.day, amountMinor: importRow.amount_minor, netMinor: importRow.net_minor, vatMinor: importRow.vat_minor };
        const changed = figureChanges(booked, latest);
        if (changed.length > 0) found.push(item('amended', entries, { changed }));
      }

      for (const f of found) {
        if (!inQ) {
          earlier.push(f);
          continue;
        }
        if (f.reason === 'missing') {
          missing.push(f);
          keysByItem.set(f, test.keysOf(e.eventId));
          if (isTest) testItems.add(f);
        } else if (f.reason === 'booked_twice') bookedTwice.push(f);
        else if (f.reason === 'amended') amended.push(f);
        else overrideCheck.push(f);
      }
    }

    // UNPLACEABLE (S3): reader refusals without an id, from every document, their day in P or undated.
    const idless = db
      .prepare(
        `SELECT code, kind, day, amount_minor FROM settlement_feed_outcome
          WHERE workspace_id = ? AND source_system = ? AND source_processor = ? AND event_id IS NULL AND outcome = 'refused'
            AND code IN (${READER_REFUSAL_CODES.map(() => '?').join(', ')}) ORDER BY rowid`,
      )
      .all(ctx.workspaceId, system, processor, ...READER_REFUSAL_CODES) as { code: string; kind: string | null; day: string | null; amount_minor: number | null }[];
    for (const r of idless) {
      const day = r.day !== null && isSettlementDay(r.day) ? r.day : null;
      if (day !== null && (day < periodStart || day > periodEnd)) continue;
      const key = JSON.stringify([system, processor, r.kind, day, r.amount_minor, r.code]);
      if (!unplaceable.has(key)) unplaceable.set(key, { system, processor, code: r.code, kind: r.kind, day, amountMinor: r.amount_minor });
    }
  }

  // CANCELLING GROUPS among the period's missing sales and refunds (setting, recomputed on every read).
  let hiddenGroups = 0;
  const hidden = new Set<CheckItem>();
  if (groupsMode !== 'show') {
    const pool = missing.filter((i) => (i.kind === 'sale' || i.kind === 'refund') && i.netMinor !== null && i.amountMinor !== null && i.day !== null);
    const parent = new Map<CheckItem, CheckItem>();
    const find = (x: CheckItem): CheckItem => {
      let r = x;
      while (parent.get(r) !== undefined && parent.get(r) !== r) r = parent.get(r) as CheckItem;
      return r;
    };
    for (const i of pool) parent.set(i, i);
    const byKey = new Map<string, CheckItem>();
    for (const i of pool) {
      for (const k of keysByItem.get(i) ?? []) {
        const key = JSON.stringify([i.system, i.processor, k]);
        const other = byKey.get(key);
        if (other === undefined) byKey.set(key, i);
        else parent.set(find(i), find(other));
      }
    }
    const groups = new Map<CheckItem, CheckItem[]>();
    for (const i of pool) groups.set(find(i), [...(groups.get(find(i)) ?? []), i]);
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      const sum = (f: (i: CheckItem) => number): number => members.reduce((s, i) => s + f(i), 0);
      if (sum((i) => i.amountMinor ?? 0) !== 0 || sum((i) => i.netMinor ?? 0) !== 0 || sum((i) => i.vatMinor ?? 0) !== 0) continue;
      const allTest = members.every((i) => testItems.has(i));
      if (groupsMode === 'hide_all' || allTest) {
        hiddenGroups += 1;
        for (const m of members) hidden.add(m);
      }
    }
  }
  const visible = missing.filter((i) => !hidden.has(i));
  const missingVatMinor = { sale: 0, refund: 0, input: 0 };
  for (const i of visible) {
    const v = i.vatMinor ?? 0;
    if (i.kind === 'sale') missingVatMinor.sale += v;
    else if (i.kind === 'refund') missingVatMinor.refund += v;
    else missingVatMinor.input += v;
  }

  const uncovered: SettlementVatFindings['uncoveredSources'] = [];
  for (const source of listSourceRows(ctx)) {
    if (source.from_date > periodEnd) continue;
    const from = source.from_date > periodStart ? source.from_date : periodStart;
    const gaps = gapsOf(from, periodEnd, pulledRangesOf(ctx, source.id));
    if (gaps.length > 0) uncovered.push({ system: source.source_system, processor: source.source_processor, gaps });
  }

  const unplaceableItems = [...unplaceable.values()];
  const hasFindings =
    visible.length > 0 ||
    bookedTwice.length > 0 ||
    amended.length > 0 ||
    overrideCheck.length > 0 ||
    earlier.length > 0 ||
    bookedTest.length > 0 ||
    unrefunded.length > 0 ||
    unreversed.length > 0 ||
    // Counts, never a signed VAT sum: a test sale and its refund of equal VAT must not hide each other.
    testExcludedVat.sale.events + testExcludedVat.refund.events + testExcludedVat.input.events > 0 ||
    ignoredVat.sale.events + ignoredVat.refund.events + ignoredVat.input.events > 0 ||
    unplaceableItems.length > 0 ||
    uncovered.length > 0;
  return {
    missing: visible.slice(0, MAX_LISTED),
    missingCount: visible.length,
    missingVatMinor,
    bookedTwice: bookedTwice.slice(0, MAX_LISTED),
    amended: amended.slice(0, MAX_LISTED),
    overrideCheck: overrideCheck.slice(0, MAX_LISTED),
    earlier: earlier.slice(0, MAX_LISTED),
    earlierCount: earlier.length,
    beforeFromDate,
    templateSkipped,
    cancellingGroupsHidden: { groups: hiddenGroups, events: hidden.size, setting: groupsMode },
    unplaceable: { count: unplaceableItems.length, items: unplaceableItems.slice(0, MAX_LISTED) },
    bookedTest: bookedTest.slice(0, MAX_LISTED),
    testExcluded: testExcludedVat,
    ignored: ignoredVat,
    testActivity: { byKind, testResidueMinor: residue, unrefundedTestSales: unrefunded.slice(0, MAX_LISTED), unreversedTestTransfers: unreversed.slice(0, MAX_LISTED) },
    uncoveredSources: uncovered,
    hasFindings,
  };
}

export { gapsOf as settlementCoverageGaps };
