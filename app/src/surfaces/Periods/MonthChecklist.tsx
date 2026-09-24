/**
 * The month-end checklist, inline on `/periods` (F-07, J4.1 ideal step 1).
 *
 * Closing a month used to start on `/reconciliation` and `/open-items` by hand, because the surface
 * that closes a month showed nothing about what was still open in it. The engine already answered
 * the question over MCP (`month_end_checklist`, A26); this panel is the human face of the same read,
 * composed with three sibling reads the story names beside it: `list_reconciliation` (the unmatched
 * bank lines of the month), `review_status` (the Treuhänder's coverage) and `list_vendor_bills` (the
 * supplier bills still open). Every line links to the surface that resolves it, with its count, so
 * the close starts and ends here.
 *
 * WHY THE CREDITOR LINE IS DERIVED HERE AND NOT READ OFF THE CHECKLIST (critic F2, 2026-09-05). The
 * engine's `open_creditors` counts `vendor_bill.status = 'posted'` dated to month end, and `status`
 * is the A17 LIFECYCLE (`draft | posted | void`): a paid bill stays `posted`. On the golden July it
 * answered 38 where `/bills` shows 5 open. So this line counts what `/bills` counts, from the read
 * `/bills` uses: `status === 'posted' && openMinor > 0`, over the bills dated to month end. The
 * engine defect is recorded against A26 by name in its spec's build notes; when `open_creditors`
 * counts settlement, this derivation collapses back to the engine item.
 *
 * WHAT THIS PANEL DOES NOT DO. It informs; it does not gate. `close_month` is a soft, reversible
 * guardrail (A03 US-A03.2), and an open debtor at month end is a normal fact of trade, not a defect,
 * so the close control stays enabled whatever the counts say. The engine grades a line `attention`,
 * never `blocking`, and the Studio invents no stricter rule than the engine holds.
 *
 * The A22 FX line is reported exactly as the engine reports it: `not_available` renders as "nicht
 * geprüft", dim, with no link, rather than being dropped and read as "nothing to do".
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatDate } from '../../i18n';
import { ErrorBanner, Skeleton } from '../../components/states';
import { useCalendarFormat } from '../../lib/format';

/** The engine's checklist item (A26 `ChecklistItem`), parsed defensively off the open `Result`. */
interface EngineItem {
  kind: string;
  count: number;
  status: 'ok' | 'attention' | 'not_available';
  note?: string;
}

/** One rendered line: what it is, how many, where to resolve it. */
export interface ChecklistLine {
  key: 'drafts' | 'bank' | 'debtors' | 'creditors' | 'vat' | 'review' | 'fx';
  /** `null` when the line carries no count (the MWST preview, or a read that did not answer). */
  count: number | null;
  status: 'ok' | 'attention' | 'not_available' | 'info';
  /** The surface that resolves the line, or null when there is nothing to act on (`not_available`). */
  to: string | null;
  /** A figure or ratio rendered beside the label (the MWST preview, the review coverage). */
  detail?: string;
}

type State =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ok'; lines: ChecklistLine[]; attention: number };

/** Inclusive ISO first and last day of a `YYYY-MM` period. Pure arithmetic, no wall clock. */
export function monthBounds(period: string): { from: string; to: string } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` };
}

function asItems(body: unknown): EngineItem[] {
  const items = (body as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.filter(
    (i): i is EngineItem =>
      typeof i === 'object' && i !== null && typeof (i as EngineItem).kind === 'string' && typeof (i as EngineItem).count === 'number',
  );
}

/** A `list_vendor_bills` row, parsed defensively: only the three fields the count needs. */
interface BillRow {
  status: string;
  openMinor: number;
  billDate: string;
}

/**
 * The open supplier bills dated to `to`: `/bills`'s own rule (`status === 'posted' && openMinor > 0`),
 * with the month-end date bound re-applied here so the count does not depend on the engine having
 * honoured the `to` filter. Exported for the test.
 */
export function openCreditorCount(body: unknown, to: string): number {
  const rows = (body as { bills?: unknown }).bills;
  if (!Array.isArray(rows)) return 0;
  return rows.filter(
    (b): b is BillRow =>
      typeof b === 'object' &&
      b !== null &&
      (b as BillRow).status === 'posted' &&
      typeof (b as BillRow).openMinor === 'number' &&
      (b as BillRow).openMinor > 0 &&
      typeof (b as BillRow).billDate === 'string' &&
      (b as BillRow).billDate <= to,
  ).length;
}

export interface MonthChecklistProps {
  workspaceId: string;
  /** A valid `YYYY-MM`; the caller validates before rendering. */
  period: string;
  /** Already locked: the panel says so rather than inviting a close that would be a no-op. */
  locked: boolean;
}

export function MonthChecklist({ workspaceId, period, locked }: MonthChecklistProps) {
  const t = useT();
  // K-38: "Monatsabschluss August 2026", never the engine's `2026-08`.
  const cal = useCalendarFormat();
  const client = useClient();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const { from, to } = monthBounds(period);
    const [checklist, recon, review, bills] = await Promise.all([
      client.call('month_end_checklist', { workspaceId, period }),
      client.call('list_reconciliation', { workspaceId, from, to }),
      client.call('review_status', { workspaceId, period }),
      client.call('list_vendor_bills', { workspaceId, status: 'posted', to }),
    ]);
    // The engine checklist is the spine: without it there is nothing honest to render. The three
    // sibling reads degrade to "no count" lines rather than failing the whole panel.
    if (isErr(checklist.body)) {
      setState({ kind: 'error', error: checklist.body });
      return;
    }
    const items = asItems(checklist.body);
    const byKind = new Map(items.map((i) => [i.kind, i]));
    const lines: ChecklistLine[] = [];

    const drafts = byKind.get('dangling_drafts');
    lines.push({ key: 'drafts', count: drafts?.count ?? null, status: drafts?.status ?? 'info', to: '/journal' });

    if (isErr(recon.body)) {
      lines.push({ key: 'bank', count: null, status: 'info', to: '/reconciliation' });
    } else {
      const unmatched = (recon.body as { unmatched?: unknown }).unmatched;
      const n = Array.isArray(unmatched) ? unmatched.length : null;
      lines.push({ key: 'bank', count: n, status: n === null ? 'info' : n > 0 ? 'attention' : 'ok', to: '/reconciliation' });
    }

    // The engine's debtor count is AS OF MONTH END (`listOpenItems(asOf: end)`), while `/open-items`
    // is as of today; the detail names the Stichtag so the two figures are not read as a disagreement.
    const debtors = byKind.get('open_debtors');
    lines.push({
      key: 'debtors',
      count: debtors?.count ?? null,
      status: debtors?.status ?? 'info',
      to: '/open-items',
      detail: debtors === undefined ? undefined : t('period.checklist.asOf', { date: formatDate(to) }),
    });

    // The creditor line is derived from `list_vendor_bills`, never from the engine's `open_creditors`
    // (see the file docblock): a posted bill with nothing left to pay is not open.
    if (isErr(bills.body)) {
      lines.push({ key: 'creditors', count: null, status: 'info', to: '/bills' });
    } else {
      const n = openCreditorCount(bills.body, to);
      lines.push({ key: 'creditors', count: n, status: n > 0 ? 'attention' : 'ok', to: '/bills' });
    }

    // The MWST preview: the engine folds its figures into a unit-less note (minor units, no currency
    // named), and a figure printed under a guessed unit is the defect the base-currency tests exist
    // for. So the line links to the return, where the figure renders with its unit, and says no more.
    const vat = byKind.get('vat_preview');
    lines.push({ key: 'vat', count: null, status: 'info', to: '/mwst', detail: vat === undefined ? undefined : t('period.checklist.vatPreview') });

    if (isErr(review.body)) {
      lines.push({ key: 'review', count: null, status: 'info', to: '/review' });
    } else {
      const total = (review.body as { total?: unknown }).total;
      const approved = (review.body as { approved?: unknown }).approved;
      const open = typeof total === 'number' && typeof approved === 'number' ? total - approved : null;
      lines.push({
        key: 'review',
        count: open,
        status: open === null ? 'info' : open > 0 ? 'attention' : 'ok',
        to: '/review',
        detail:
          typeof total === 'number' && typeof approved === 'number'
            ? t('period.checklist.reviewCoverage', { approved: String(approved), total: String(total) })
            : undefined,
      });
    }

    const fx = byKind.get('fx_revaluation');
    if (fx !== undefined) {
      lines.push({ key: 'fx', count: fx.status === 'not_available' ? null : fx.count, status: fx.status, to: fx.status === 'not_available' ? null : '/fx' });
    }

    setState({ kind: 'ok', lines, attention: lines.filter((l) => l.status === 'attention').length });
  }, [client, workspaceId, period, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="period-checklist panel" aria-labelledby="period-checklist-title" data-period={period}>
      <h2 id="period-checklist-title" className="periods-subtitle">
        {t('period.checklist.title', { period: cal.month(period) })}
      </h2>
      {locked && (
        <>
          <p className="period-checklist-locked">{t('period.checklist.alreadyLocked', { period: cal.month(period) })}</p>
          {/* J8.6 (F-10): the landing named the door (this month is locked) but not the one-line way
              out. Reopening a closed month is the heavy move; changing the entry date to an open month
              is usually what the operator actually wants, so it is stated here. */}
          <p className="period-checklist-wayout">{t('period.checklist.lockedWayOut')}</p>
        </>
      )}
      {state.kind === 'loading' && <Skeleton rows={4} height={18} />}
      {state.kind === 'error' && <ErrorBanner error={state.error} onRetry={() => void load()} />}
      {state.kind === 'ok' && (
        <>
          <p className="period-checklist-summary">
            {state.attention === 0
              ? t('period.checklist.clear')
              : t('period.checklist.attention', { count: String(state.attention) })}
          </p>
          <ul className="period-checklist-lines">
            {state.lines.map((line) => (
              <li key={line.key} className={`period-checklist-line period-checklist-line--${line.status}`} data-line={line.key}>
                <span className="period-checklist-count" aria-hidden={line.count === null}>
                  {line.count === null ? '' : line.count}
                </span>
                {line.to !== null ? (
                  <Link className="period-checklist-link link-inline" to={line.to}>
                    {t(`period.checklist.line.${line.key}`)}
                  </Link>
                ) : (
                  <span className="period-checklist-label">{t(`period.checklist.line.${line.key}`)}</span>
                )}
                <span className="period-checklist-detail">
                  {line.status === 'not_available'
                    ? t('period.checklist.notAvailable')
                    : (line.detail ?? (line.count === null && line.status === 'info' ? t('period.checklist.noCount') : ''))}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
