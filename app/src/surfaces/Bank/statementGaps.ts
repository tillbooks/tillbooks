/**
 * A36 §4.7 (D150): a statement gap as the Studio reads it (`statementGaps` on `bank_channel_status` and
 * on the `bank_inbox` tile) and the ONE wording of it, shared by the Übersicht band, the channel panel
 * and the repair dialog, so the three never explain the same gap differently.
 *
 * A gap is two neighbouring day-end statements whose numbers skip. Chained (the later opens exactly on
 * the earlier's close): no money is missing. Unchained: the difference stands in the missing
 * statements. Pending: a downloaded statement waits behind the gap and names the difference.
 */
import { formatDate, formatMoney } from '../../i18n';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface StatementGapEnd {
  statementRowId: string | null;
  /** Critic M2: a split statement whose pages are not all in the books. */
  incomplete?: boolean;
  /** Critic round 2, N2: copies of this statement with different balances. */
  conflicting?: boolean;
  documentId: string | null;
  number: number;
  year: number;
  fromDate: string | null;
  toDate: string | null;
}

export interface StatementGapDto {
  gapId: string;
  bankAccountId: string;
  source: 'book' | 'pending';
  after: StatementGapEnd;
  before: StatementGapEnd;
  missing: { year: number; from: number; to: number }[];
  oldYearTailUnknown: boolean;
  missingDates: { from: string | null; to: string | null };
  chains: boolean;
  differenceMinor: number;
  currency: string | null;
  confirmable: boolean;
  /** Critic round 2 LOW 1: an earlier confirmation no longer holds. */
  confirmationVoid?: boolean;
  /** Downloaded statements refused inside the gap (critic H1): they prove an unexplained amount. */
  refused?: { number: number; year: number; fromDate: string | null; differenceMinor: number }[];
}

function isEnd(x: unknown): x is StatementGapEnd {
  const e = x as StatementGapEnd | null;
  return e !== null && typeof e === 'object' && typeof e.number === 'number' && typeof e.year === 'number';
}

/** Read the engine's gaps defensively: a row this Studio cannot read is skipped, never guessed. */
export function parseStatementGaps(raw: unknown): StatementGapDto[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((g): g is StatementGapDto => {
    const x = g as Partial<StatementGapDto> | null;
    return (
      x !== null &&
      typeof x === 'object' &&
      typeof x.gapId === 'string' &&
      typeof x.bankAccountId === 'string' &&
      isEnd(x.after) &&
      isEnd(x.before) &&
      Array.isArray(x.missing) &&
      typeof x.differenceMinor === 'number' &&
      x.missingDates !== undefined
    );
  });
}

/** "183–186", "183", or across a year turn "1–2/2026" (an en dash: a real range). */
export function gapRangeText(gap: Pick<StatementGapDto, 'missing' | 'oldYearTailUnknown'>): string {
  return gap.missing.map((r) => `${r.from === r.to ? `${r.from}` : `${r.from}–${r.to}`}${gap.oldYearTailUnknown ? `/${r.year}` : ''}`).join(', ');
}

function missingCount(gap: StatementGapDto): number {
  return gap.missing.reduce((n, r) => n + (r.to - r.from + 1), 0);
}

/** "23.09.2026 bis 28.09.2026", or one day. Empty when the engine knows no dates. */
export function gapDatesText(t: T, gap: Pick<StatementGapDto, 'missingDates'>): string {
  const { from, to } = gap.missingDates;
  if (from === null || to === null) return '';
  return from === to ? formatDate(from) : t('statementGap.dateRange', { from: formatDate(from), to: formatDate(to) });
}

/**
 * Critic LOW 8: the range to FETCH in eBanking, from the earlier statement's day through the later
 * statement's day, inclusive. The two edge days are already in the books and answer
 * `already_imported`, so asking for them costs nothing, while cutting the range too short could miss a
 * statement dated on an edge day.
 */
export function gapFetchDatesText(t: T, gap: Pick<StatementGapDto, 'after' | 'before' | 'missingDates'>): string {
  const from = gap.after.fromDate;
  const to = gap.before.fromDate;
  if (from === null || to === null) return gapDatesText(t, gap);
  return from.slice(0, 10) === to.slice(0, 10) ? formatDate(from) : t('statementGap.dateRange', { from: formatDate(from), to: formatDate(to) });
}

/** "Auszüge 183–186 fehlen (23.09.2026 bis 28.09.2026)". */
export function gapTitle(t: T, gap: StatementGapDto): string {
  const range = gapRangeText(gap);
  const dates = gapDatesText(t, gap);
  // Critic M1 / LOW 4: a year turn with no knowable number names the statement it follows, never an empty range.
  const incompleteEnd = gap.after.incomplete === true ? gap.after : gap.before.incomplete === true ? gap.before : undefined;
  const conflictEnd = gap.after.conflicting === true ? gap.after : gap.before.conflicting === true ? gap.before : undefined;
  if (gap.missing.length === 0 && conflictEnd !== undefined && !gap.oldYearTailUnknown) {
    return t('statementGap.titleConflicting', { n: `${conflictEnd.number}/${conflictEnd.year}` });
  }
  if (gap.missing.length === 0 && incompleteEnd !== undefined && !gap.oldYearTailUnknown) {
    return t('statementGap.titleIncomplete', { n: `${incompleteEnd.number}/${incompleteEnd.year}` });
  }
  if (gap.missing.length === 0) {
    const after = `${gap.after.number}/${gap.after.year}`;
    return dates === '' ? t('statementGap.titleUnknownNoDates', { after }) : t('statementGap.titleUnknown', { after, dates });
  }
  const key = missingCount(gap) === 1 ? 'statementGap.titleOne' : 'statementGap.titleMany';
  return dates === '' ? t(`${key}NoDates`, { range }) : t(key, { range, dates });
}

/** The explanation: no money missing, or the amount that is, plus the year turn when it applies. */
export function gapExplanation(t: T, gap: StatementGapDto): string {
  const amount = formatMoney(gap.differenceMinor, gap.currency ?? 'CHF');
  const range = gapRangeText(gap);
  const inside = gap.source === 'book' ? gap.refused?.[0] : undefined;
  const incomplete = gap.after.incomplete === true ? gap.after : gap.before.incomplete === true ? gap.before : undefined;
  const conflict = gap.after.conflicting === true ? gap.after : gap.before.conflicting === true ? gap.before : undefined;
  const main =
    gap.source === 'pending'
      ? t('statementGap.pending', { before: gap.before.number, amount })
      : conflict !== undefined
        ? t('statementGap.conflicting', { n: conflict.number })
        : incomplete !== undefined
        ? t('statementGap.incomplete', { n: incomplete.number })
        : inside !== undefined
        ? t('statementGap.waitingInside', { waiting: inside.number, amount: formatMoney(inside.differenceMinor, gap.currency ?? 'CHF') })
        : gap.chains && gap.missing.length === 0
        ? t('statementGap.chainedUnknown', { after: gap.after.number, before: gap.before.number })
        : gap.chains
        ? t('statementGap.chained', { after: gap.after.number, before: gap.before.number, range })
        : t('statementGap.unchained', { amount });
  const withTurn = gap.oldYearTailUnknown ? `${main} ${t('statementGap.yearTurn', { year: gap.after.year })}` : main;
  return gap.confirmationVoid === true ? `${withTurn} ${t('statementGap.confirmationVoid')}` : withTurn;
}

/** The repair dialog's address: `/bank-accounts?repair=<account>&gap=<gap>`. */
export function gapRepairHref(gap: Pick<StatementGapDto, 'bankAccountId' | 'gapId'>): string {
  const qs = new URLSearchParams({ repair: gap.bankAccountId, gap: gap.gapId });
  return `/bank-accounts?${qs.toString()}`;
}
