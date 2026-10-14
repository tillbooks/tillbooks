/**
 * A36 §4.7 (D150): one statement's outcome from `import_camt_files`, in words, shared by the gap repair
 * dialog and the multi-file import dialog: imported, already in the books, or refused with the reason
 * and, for a gap, the amount that does not chain.
 */
import { formatDate, formatMoney } from '../../i18n';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface FileOutcome {
  file: string;
  number: number | null;
  fromDate: string | null;
  outcome: 'imported' | 'already_imported' | 'refused';
  txnCount?: number;
  code?: string;
  reason?: string;
  differenceMinor?: number;
}

/** Read the engine's outcome list defensively: a row this Studio cannot read is skipped. */
export function parseFileOutcomes(body: unknown): FileOutcome[] {
  const raw = (body as { statements?: unknown } | null)?.statements;
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is FileOutcome => {
    const x = o as Partial<FileOutcome> | null;
    return x !== null && typeof x === 'object' && typeof x.file === 'string' && (x.outcome === 'imported' || x.outcome === 'already_imported' || x.outcome === 'refused');
  });
}

const REFUSED_KEYS: Readonly<Record<string, string>> = {
  gap_refused: 'gapRepair.refused.gap',
  overlap_refused: 'gapRepair.refused.overlap',
  before_feed_start: 'gapRepair.refused.beforeFeedStart',
  not_day_end_statement: 'gapRepair.refused.notDayEnd',
  unsupported_multipage_statement: 'gapRepair.refused.multipage',
  camt_split_refused: 'gapRepair.refused.split',
  iban_mismatch: 'gapRepair.refused.otherAccount',
  needs_bank_account: 'gapRepair.refused.otherAccount',
  camt054_refused: 'gapRepair.refused.camt054',
  schema_invalid: 'gapRepair.refused.unreadable',
  statement_amended: 'gapRepair.refused.amended',
};

export function outcomeText(t: T, o: FileOutcome, currency: string): string {
  const which = o.number !== null ? t('gapRepair.result.statement', { n: o.number, date: o.fromDate !== null ? formatDate(o.fromDate) : '' }) : o.file;
  if (o.outcome === 'imported') return t(`gapRepair.result.imported.${(o.txnCount ?? 0) === 1 ? 'one' : 'other'}`, { which, count: o.txnCount ?? 0 });
  if (o.outcome === 'already_imported') return t('gapRepair.result.already', { which });
  const key = o.code !== undefined ? REFUSED_KEYS[o.code] : undefined;
  const why = key !== undefined ? t(key, { amount: formatMoney(Math.abs(o.differenceMinor ?? 0), currency) }) : t('gapRepair.refused.other', { code: o.code ?? '' });
  return t('gapRepair.result.refused', { which, why });
}
