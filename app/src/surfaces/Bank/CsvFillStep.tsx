/**
 * A20 §12: "Was importieren?" in the CSV step of the import dialog, and what a GAP FILL would write.
 *
 * Three answers (`Segmented`): only the days the books miss (the default on an account fed over EBICS,
 * where it is the only one), one date range (still only its days without a statement), or the whole file
 * (the plain import, not offered on an EBICS account). For a fill the engine's own plan
 * (`bank_csv_preview` with `fill`) is shown stretch by stretch: its days, how many rows are new and how
 * many the books already hold, and the one sentence per end that says whether the bank's running balance
 * meets the statement (or the books) there. A stretch that cannot be proven says why in one sentence and
 * is not imported. Every figure is the engine's; nothing is recounted here.
 */
import { useId } from 'react';

import { useT, formatDate, formatMoney } from '../../i18n';
import { Segmented } from '../../components/Segmented';
import { plural } from './lookups';

/** How much of a CSV the import takes (`all` is the plain import of A20 §11). */
export type CsvFillMode = 'gaps' | 'range' | 'all';

/** One end of a stretch, as the engine answers it (`FillTie`). */
export type CsvFillTieView =
  | { kind: 'statement'; number: number | null; date: string; balanceMinor: number; csvMinor: number | null; differenceMinor: number | null }
  | { kind: 'books'; date: string; ledgerMinor: number; csvMinor: number | null; differenceMinor: number | null }
  | { kind: 'none'; csvMinor: number | null };

export interface CsvFillPartView {
  status: 'ready' | 'blocked' | 'not_in_file' | 'imported' | 'already_imported' | 'refused';
  kind: 'gap' | 'before_feed' | 'range';
  targetFrom: string;
  targetTo: string;
  from: string;
  to: string;
  rows: number;
  alreadyInBooks: number;
  /** Written lines that wait for the person as possible duplicates. */
  flagged?: number;
  imported: number;
  before: CsvFillTieView;
  after: CsvFillTieView;
  problems: { code: string; row?: number; side?: 'before' | 'after'; differenceMinor?: number }[];
  closesTarget: boolean;
  closedGapIds: string[];
}

export interface CsvFillView {
  parts: CsvFillPartView[];
}

/** The engine's `fill` answer, read defensively (unknown statuses and kinds are dropped). */
export function readFillView(raw: unknown): CsvFillView | null {
  const r = raw as { parts?: unknown } | null | undefined;
  if (r === null || r === undefined || typeof r !== 'object' || !Array.isArray(r.parts)) return null;
  const STATUSES = ['ready', 'blocked', 'not_in_file', 'imported', 'already_imported', 'refused'];
  const KINDS = ['gap', 'before_feed', 'range'];
  const parts = (r.parts as Record<string, unknown>[]).filter(
    (p) => p !== null && typeof p === 'object' && STATUSES.includes(p.status as string) && KINDS.includes(p.kind as string) && typeof p.from === 'string' && typeof p.to === 'string',
  ) as unknown as CsvFillPartView[];
  return { parts: parts.map((p) => ({ ...p, problems: Array.isArray(p.problems) ? p.problems : [], closedGapIds: Array.isArray(p.closedGapIds) ? p.closedGapIds : [] })) };
}

type T = ReturnType<typeof useT>;

/** The stretch's name: "Lücke 24.03.2026 bis 27.03.2026", "Vor dem ersten Auszug: …", or the range. */
export function stretchName(t: T, p: Pick<CsvFillPartView, 'kind' | 'from' | 'to'>): string {
  return t(`bankInbox.import.fill.kind.${p.kind}`, { from: formatDate(p.from), to: formatDate(p.to) });
}

/** One sentence per end of a stretch: does the CSV's balance meet its neighbour there? */
function tieSentence(t: T, tie: CsvFillTieView, currency: string): string | null {
  if (tie.kind === 'statement') {
    if (tie.differenceMinor === null) return null;
    return tie.differenceMinor === 0
      ? t('bankInbox.import.fill.tieStatement', { date: formatDate(tie.date), amount: formatMoney(tie.balanceMinor, currency) })
      : t('bankInbox.import.fill.tieStatementDiff', { date: formatDate(tie.date), amount: formatMoney(Math.abs(tie.differenceMinor), currency) });
  }
  if (tie.kind === 'books') {
    if (tie.differenceMinor === null) return null;
    return tie.differenceMinor === 0
      ? t('bankInbox.import.fill.tieBooks', { date: formatDate(tie.date), amount: formatMoney(tie.ledgerMinor, currency) })
      : t('bankInbox.import.fill.tieBooksDiff', { date: formatDate(tie.date), amount: formatMoney(Math.abs(tie.differenceMinor), currency) });
  }
  return null;
}

/** Why a stretch is not imported, in one sentence (its first problem). */
export function problemSentence(t: T, p: CsvFillPartView, currency: string): string | null {
  const first = p.problems[0];
  if (first === undefined) return null;
  switch (first.code) {
    case 'chain_broken':
      return t('bankInbox.import.fill.problem.chain_broken', { row: first.row ?? '' });
    case 'untied':
      return t('bankInbox.import.fill.problem.untied', { amount: formatMoney(Math.abs(first.differenceMinor ?? 0), currency) });
    case 'open_end':
      return t('bankInbox.import.fill.problem.open_end', { date: formatDate(p.to) });
    case 'no_balance_column':
    case 'not_in_file':
      return t(`bankInbox.import.fill.problem.${first.code}`);
    default:
      return null;
  }
}

export interface CsvFillStepProps {
  mode: CsvFillMode;
  onMode: (mode: CsvFillMode) => void;
  range: { from: string; to: string };
  onRange: (range: { from: string; to: string }) => void;
  /** The Bankkonto is fed over EBICS: the whole file is not offered. */
  fedAccount: boolean;
  /** The mapping names a balance column. */
  hasBalance: boolean;
  /** The engine's plan for the chosen fill, or null while it is read (or for `all`). */
  plan: CsvFillView | null;
  planBusy: boolean;
  currency: string;
  disabled: boolean;
}

export function CsvFillStep({ mode, onMode, range, onRange, fedAccount, hasBalance, plan, planBusy, currency, disabled }: CsvFillStepProps) {
  const t = useT();
  const id = useId();
  const options = [
    { value: 'gaps' as const, label: t('bankInbox.import.fill.gaps') },
    { value: 'range' as const, label: t('bankInbox.import.fill.range') },
    ...(fedAccount ? [] : [{ value: 'all' as const, label: t('bankInbox.import.fill.all') }]),
  ];
  const shown = plan?.parts.filter((p) => p.status !== 'not_in_file') ?? [];
  return (
    <section className="bank-field bank-fill" aria-labelledby={`${id}-title`}>
      <h3 className="bank-field__label" id={`${id}-title`}>
        {t('bankInbox.import.fill.title')}
      </h3>
      <Segmented options={options} value={mode} onChange={onMode} labelledBy={`${id}-title`} disabled={disabled} />
      {fedAccount && <p className="bank-import__match">{t('bankInbox.import.fill.allFed')}</p>}
      {mode !== 'all' && <p className="bank-mode__lead">{t(mode === 'gaps' ? 'bankInbox.import.fill.gapsHint' : 'bankInbox.import.fill.rangeHint')}</p>}
      {mode === 'range' && (
        <div className="bank-fill__range">
          <label className="bank-field" htmlFor={`${id}-from`}>
            <span className="bank-field__label">{t('bankInbox.import.fill.from')}</span>
            <input id={`${id}-from`} className="field t-num" type="date" value={range.from} disabled={disabled} onChange={(e) => onRange({ ...range, from: e.target.value })} />
          </label>
          <label className="bank-field" htmlFor={`${id}-to`}>
            <span className="bank-field__label">{t('bankInbox.import.fill.to')}</span>
            <input id={`${id}-to`} className="field t-num" type="date" value={range.to} disabled={disabled} onChange={(e) => onRange({ ...range, to: e.target.value })} />
          </label>
        </div>
      )}
      {mode !== 'all' && !hasBalance && (
        <p className="bank-mode__warn" role="alert">
          {t('bankInbox.import.fill.needsBalance')}
        </p>
      )}
      {mode !== 'all' && hasBalance && (
        <div aria-live="polite" role="status">
          {planBusy ? (
            <p className="bank-mode__lead">{t('bankInbox.import.fill.reading')}</p>
          ) : plan !== null && shown.length === 0 ? (
            <p className="bank-mode__lead">{t('bankInbox.import.fill.none')}</p>
          ) : (
            <ul className="gap-repair__list">
              {shown.map((p) => {
                const why = p.status === 'blocked' || p.status === 'refused' ? problemSentence(t, p, currency) : null;
                const ties = [tieSentence(t, p.before, currency), tieSentence(t, p.after, currency)].filter((s): s is string => s !== null);
                return (
                  <li key={`${p.from}-${p.to}`} className={`gap-repair__result is-${p.status === 'ready' || p.status === 'imported' ? 'imported' : p.status === 'already_imported' ? 'already_imported' : 'refused'}`}>
                    <p className="bank-fill__name">{stretchName(t, p)}</p>
                    <p className="bank-fill__facts">
                      {p.status === 'already_imported'
                        ? t('bankInbox.import.fill.already')
                        : [p.rows - p.alreadyInBooks > 0 ? plural(t, 'bankInbox.import.fill.rows', p.rows - p.alreadyInBooks) : t('bankInbox.import.fill.noRows'), ...(p.alreadyInBooks > 0 ? [plural(t, 'bankInbox.import.fill.inBooks', p.alreadyInBooks)] : []), ...((p.flagged ?? 0) > 0 ? [plural(t, 'bankInbox.import.fill.flagged', p.flagged ?? 0)] : [])].join(' · ')}
                    </p>
                    {ties.map((s) => (
                      <p key={s} className="bank-fill__tie">
                        {s}
                      </p>
                    ))}
                    {why !== null ? <p className="bank-fill__why">{why}</p> : <p className="bank-fill__tie">{t(p.closesTarget ? 'bankInbox.import.fill.closes' : 'bankInbox.import.fill.stays')}</p>}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
