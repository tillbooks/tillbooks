/**
 * G13, the Archiv tab on the Journal surface (spec §6): the prior system's journal, read-only,
 * beside the live ledger and NEVER mixed with it.
 *
 * THE FIVE SPECIFIED SAFEGUARDS (canon pass finding 24; they are the spec, not builder taste):
 *  1. A persistent, NON-DISMISSIBLE provenance band: source system, covered range, "nicht Teil der
 *     TILL-Belegkette". It has no close control, and it renders in every non-empty state.
 *  2. Visibly DIFFERENT row treatment: muted ink plus an archive glyph with an accessible name on
 *     every row, never the live journal's row style.
 *  3. NO live-style drill-in: a row expands into a plain read-only detail, carrying the same
 *     provenance band, with no edit, reverse or post affordance anywhere.
 *  4. HARD PARTITION: this component renders `gl_archive_query` results and nothing else. It shares
 *     no list state, no filter state and no row model with the live table, so a mixed result set
 *     cannot exist even transiently.
 *  5. The comparative label lives on `Reports.tsx` (the column header carries it there).
 *
 * The purge lives behind the OVERFLOW on the periods view, with a reason field and a confirm
 * (canon: forgiveness); it is never a button beside the query. `retention_active` renders the date
 * AND the statutory reference. Permission-denied renders A24's padlock naming the capability.
 */
import { useCallback, useEffect, useRef, useState, type SVGProps } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatMoney, formatDate } from '../../i18n';
import { Skeleton, EmptyState, ErrorBanner, PermissionDenied } from '../../components/states';
import { OverflowMenu } from '../../components/OverflowMenu';

interface ArchiveLine {
  sourceAccount: string;
  sourceAccountName: string | null;
  targetNumber: string | null;
  targetName: string | null;
  debitMinor: number;
  creditMinor: number;
  currency: string | null;
  description: string | null;
}

interface ArchiveEntry {
  entryId: string;
  sourceEntryId: string | null;
  date: string;
  description: string | null;
  balanced: boolean;
  lines: ArchiveLine[];
}

interface Provenance {
  system: string | null;
  from: string | null;
  to: string | null;
}

interface ArchivePeriod {
  period: string;
  entryCount: number;
  retentionUntil: string;
  purged: boolean;
}

type QueryState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'denied' }
  | { kind: 'ok'; entries: ArchiveEntry[]; total: number; page: number; provenance: Provenance };

interface Filters {
  from: string;
  to: string;
  sourceAccount: string;
  text: string;
}

const EMPTY_FILTERS: Filters = { from: '', to: '', sourceAccount: '', text: '' };

/** A small archive-box glyph. Decorative beside its text, named for screen readers on rows. */
function ArchiveGlyph(props: SVGProps<SVGSVGElement> & { title?: string }) {
  const { title, ...rest } = props;
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title === undefined ? undefined : 'img'}
      aria-hidden={title === undefined ? 'true' : undefined}
      aria-label={title}
      focusable="false"
      {...rest}
    >
      <rect x="3" y="4" width="18" height="5" rx="1" />
      <path d="M5 9v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9" />
      <path d="M10 13h4" />
    </svg>
  );
}

/** The non-dismissible provenance band (safeguard 1). Text, not styling, so a reader hears it. */
function ProvenanceBand({ provenance }: { provenance: Provenance }) {
  const t = useT();
  return (
    <p className="journal-archive-band" data-testid="archive-provenance">
      <ArchiveGlyph />
      {t('archive.provenance', {
        system: provenance.system ?? '?',
        from: provenance.from === null ? '?' : formatDate(provenance.from),
        to: provenance.to === null ? '?' : formatDate(provenance.to),
      })}
    </p>
  );
}

export function ArchiveTab({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const client = useClient();

  const [state, setState] = useState<QueryState>({ kind: 'loading' });
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [openEntry, setOpenEntry] = useState<string | null>(null);
  const [showPeriods, setShowPeriods] = useState(false);
  const [periods, setPeriods] = useState<ArchivePeriod[] | null>(null);
  const [periodsDenied, setPeriodsDenied] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeForm, setPurgeForm] = useState({ from: '', to: '', reason: '' });
  const [purgeResult, setPurgeResult] = useState<string | null>(null);
  const purgeSeq = useRef(0);

  const load = useCallback(
    async (applied: Filters, page: number) => {
      setState({ kind: 'loading' });
      const input: Record<string, unknown> = { workspaceId, page };
      if (applied.from !== '') input.from = applied.from;
      if (applied.to !== '') input.to = applied.to;
      if (applied.sourceAccount !== '') input.sourceAccount = applied.sourceAccount;
      if (applied.text !== '') input.text = applied.text;
      const { body } = await client.call('gl_archive_query', input);
      if (isErr(body)) {
        if (body.error === 'permission_denied') setState({ kind: 'denied' });
        else setState({ kind: 'error', error: body });
        return;
      }
      setState({
        kind: 'ok',
        entries: body.entries as ArchiveEntry[],
        total: body.total as number,
        page: body.page as number,
        provenance: body.provenance as Provenance,
      });
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void load(EMPTY_FILTERS, 1);
  }, [load]);

  const loadPeriods = useCallback(async () => {
    const { body } = await client.call('gl_archive_periods', { workspaceId });
    if (isErr(body)) {
      if (body.error === 'permission_denied') setPeriodsDenied(true);
      return;
    }
    setPeriods(body.periods as ArchivePeriod[]);
  }, [client, workspaceId]);

  useEffect(() => {
    if (showPeriods && periods === null && !periodsDenied) void loadPeriods();
  }, [showPeriods, periods, periodsDenied, loadPeriods]);

  async function submitPurge() {
    purgeSeq.current += 1;
    const { body } = await client.call('gl_archive_purge', {
      workspaceId,
      periodFrom: purgeForm.from,
      periodTo: purgeForm.to,
      reason: purgeForm.reason,
      confirmed: true,
      idempotencyKey: `studio-purge-${workspaceId}-${purgeForm.from}-${purgeForm.to}-${purgeSeq.current}`,
    });
    if (isErr(body)) {
      if (body.error === 'retention_active') {
        setPurgeResult(
          t('archive.err.retentionActive', {
            until: formatDate(String(body.until ?? '')),
            statute: String(body.statutoryRef ?? 'OR 958f'),
          }),
        );
      } else if (body.error === 'permission_denied') {
        setPurgeResult(t('archive.err.purgeDenied'));
      } else {
        setPurgeResult(t('archive.err.purgeFailed', { code: String(body.error) }));
      }
      return;
    }
    setPurgeResult(t('archive.purge.done', { count: Number(body.purgedEntries ?? 0) }));
    setPeriods(null);
    void loadPeriods();
    void load(filters, 1);
  }

  if (state.kind === 'loading') return <Skeleton rows={5} height={40} />;
  if (state.kind === 'denied') return <PermissionDenied body={t('archive.requiresReadBooks')} />;
  if (state.kind === 'error') {
    return <ErrorBanner error={state.error} onRetry={() => void load(filters, 1)} />;
  }

  const empty = state.total === 0 && filters === EMPTY_FILTERS;
  if (empty && state.provenance.system === null) {
    // No archive at all: name what the archive is and point at the plan's scope step.
    return (
      <EmptyState
        title={t('archive.empty')}
        hint={t('archive.emptyBody')}
        action={{ label: t('archive.emptyAction'), to: '/migration' }}
      />
    );
  }

  const pages = Math.max(1, Math.ceil(state.total / 50));

  return (
    <div className="journal-archive" data-testid="archive-tab">
      {/* Safeguard 1: always present, no dismiss control exists. */}
      <ProvenanceBand provenance={state.provenance} />

      <form
        className="journal-filters panel"
        aria-label={t('archive.filters.legend')}
        onSubmit={(e) => {
          e.preventDefault();
          void load(filters, 1);
        }}
      >
        <label className="journal-field">
          {t('journal.filters.from')}
          <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </label>
        <label className="journal-field">
          {t('journal.filters.to')}
          <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </label>
        <label className="journal-field">
          {t('archive.filters.sourceAccount')}
          <input
            type="text"
            value={filters.sourceAccount}
            onChange={(e) => setFilters((f) => ({ ...f, sourceAccount: e.target.value }))}
          />
        </label>
        <label className="journal-field">
          {t('archive.filters.text')}
          <input type="text" value={filters.text} onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value }))} />
        </label>
        <div className="journal-filter-actions">
          <button type="submit" className="btn btn--secondary btn--sm">
            {t('journal.filters.apply')}
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => {
              setFilters(EMPTY_FILTERS);
              void load(EMPTY_FILTERS, 1);
            }}
          >
            {t('archive.query.clearFilters')}
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            aria-expanded={showPeriods}
            onClick={() => setShowPeriods((s) => !s)}
          >
            {t('archive.periods.title')}
          </button>
        </div>
      </form>

      {showPeriods && (
        <section className="panel journal-archive-periods" aria-label={t('archive.periods.title')}>
          {periodsDenied ? (
            <PermissionDenied body={t('archive.requiresReadBooks')} />
          ) : periods === null ? (
            <Skeleton rows={3} height={28} />
          ) : (
            <>
              <div className="journal-archive-periods-head">
                <h2 className="journal-archive-subtitle">{t('archive.periods.title')}</h2>
                {/* The purge lives BEHIND the overflow, never beside the query (spec §6). */}
                <div className="journal-archive-overflow">
                  <OverflowMenu
                    label={t('archive.overflow')}
                    items={[
                      {
                        key: 'purge',
                        label: t('archive.purge.action'),
                        danger: true,
                        onSelect: () => setPurgeOpen(true),
                      },
                    ]}
                  />
                  {purgeOpen && (
                    <div className="journal-archive-purge panel" role="group" aria-label={t('archive.purge.action')}>
                      <label className="journal-field">
                        {t('archive.purge.fromPeriod')}
                        <input
                          type="text"
                          placeholder="YYYY-MM"
                          value={purgeForm.from}
                          onChange={(e) => setPurgeForm((f) => ({ ...f, from: e.target.value }))}
                        />
                      </label>
                      <label className="journal-field">
                        {t('archive.purge.toPeriod')}
                        <input
                          type="text"
                          placeholder="YYYY-MM"
                          value={purgeForm.to}
                          onChange={(e) => setPurgeForm((f) => ({ ...f, to: e.target.value }))}
                        />
                      </label>
                      <label className="journal-field">
                        {t('archive.purge.reason')}
                        <input
                          type="text"
                          value={purgeForm.reason}
                          onChange={(e) => setPurgeForm((f) => ({ ...f, reason: e.target.value }))}
                        />
                      </label>
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={purgeForm.from === '' || purgeForm.to === '' || purgeForm.reason === ''}
                        onClick={() => void submitPurge()}
                      >
                        {t('archive.purge.confirm')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {purgeResult !== null && (
                <p className="journal-archive-purge-result" role="status">
                  {purgeResult}
                </p>
              )}
              <table className="journal-table journal-archive-table">
                <thead>
                  <tr>
                    <th scope="col">{t('archive.periods.period')}</th>
                    <th scope="col" className="journal-num">
                      {t('archive.periods.entries')}
                    </th>
                    <th scope="col">{t('archive.periods.retentionUntil')}</th>
                    <th scope="col">{t('archive.periods.status')}</th>
                  </tr>
                </thead>
                <tbody>
                  {periods.map((p) => (
                    <tr key={p.period} className="journal-archive-row">
                      <td>{p.period}</td>
                      <td className="journal-num">{p.entryCount}</td>
                      <td>{formatDate(`${p.retentionUntil}`)}</td>
                      <td>{p.purged ? t('archive.periods.purged') : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}

      {state.entries.length === 0 ? (
        <EmptyState title={t('archive.query.noHits')} action={{ label: t('archive.query.clearFilters'), onClick: () => { setFilters(EMPTY_FILTERS); void load(EMPTY_FILTERS, 1); } }} />
      ) : (
        <table className="journal-table journal-archive-table">
          <thead>
            <tr>
              <th scope="col">{t('journal.columns.date')}</th>
              <th scope="col">{t('journal.columns.ref')}</th>
              <th scope="col">{t('journal.columns.description')}</th>
              <th scope="col" className="journal-num">
                {t('journal.columns.amount')}
              </th>
              <th scope="col">{t('archive.columns.flags')}</th>
            </tr>
          </thead>
          <tbody>
            {state.entries.map((entry) => {
              const totalMinor = entry.lines.reduce((sum, l) => sum + l.debitMinor, 0);
              const isOpen = openEntry === entry.entryId;
              return [
                <tr key={entry.entryId} className="journal-archive-row">
                  <td className="journal-num">{formatDate(entry.date)}</td>
                  <td>
                    {/* Safeguard 3: a plain read-only expansion, not the live drawer. */}
                    <button
                      type="button"
                      className="journal-row-open journal-archive-open"
                      aria-expanded={isOpen}
                      onClick={() => setOpenEntry(isOpen ? null : entry.entryId)}
                    >
                      <ArchiveGlyph title={t('archive.rowGlyph')} />
                      {entry.sourceEntryId ?? formatDate(entry.date)}
                    </button>
                  </td>
                  <td>{entry.description}</td>
                  <td className="journal-num">{formatMoney(totalMinor, entry.lines[0]?.currency ?? 'CHF')}</td>
                  <td>
                    {!entry.balanced && (
                      <span className="journal-badge journal-archive-flag">{t('archive.row.unbalanced')}</span>
                    )}
                    {entry.lines.some((l) => l.targetNumber === null) && (
                      <span className="journal-badge journal-archive-flag">{t('archive.row.unmapped')}</span>
                    )}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={`${entry.entryId}-detail`} className="journal-archive-row">
                    <td colSpan={5}>
                      <div className="journal-archive-detail">
                        <ProvenanceBand provenance={state.provenance} />
                        <table className="journal-table journal-archive-table">
                          <thead>
                            <tr>
                              <th scope="col">{t('archive.columns.sourceAccount')}</th>
                              <th scope="col">{t('archive.columns.targetAccount')}</th>
                              <th scope="col" className="journal-num">
                                {t('entry.debit')}
                              </th>
                              <th scope="col" className="journal-num">
                                {t('entry.credit')}
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {entry.lines.map((line, i) => (
                              <tr key={i} className="journal-archive-row">
                                <td>
                                  {line.sourceAccount}
                                  {line.sourceAccountName !== null ? ` ${line.sourceAccountName}` : ''}
                                </td>
                                <td>
                                  {line.targetNumber === null
                                    ? t('archive.row.unmapped')
                                    : `${line.targetNumber} ${line.targetName ?? ''}`}
                                </td>
                                <td className="journal-num">
                                  {line.debitMinor === 0 ? '' : formatMoney(line.debitMinor, line.currency ?? 'CHF')}
                                </td>
                                <td className="journal-num">
                                  {line.creditMinor === 0 ? '' : formatMoney(line.creditMinor, line.currency ?? 'CHF')}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
          </tbody>
        </table>
      )}

      {pages > 1 && (
        <nav className="journal-archive-pager" aria-label={t('archive.pager')}>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={state.page <= 1}
            onClick={() => void load(filters, state.page - 1)}
          >
            {t('archive.pagerPrev')}
          </button>
          <span>
            {t('archive.pagerPage', { page: state.page, pages })}
          </span>
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={state.page >= pages}
            onClick={() => void load(filters, state.page + 1)}
          >
            {t('archive.pagerNext')}
          </button>
        </nav>
      )}
    </div>
  );
}
