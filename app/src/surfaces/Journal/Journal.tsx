/**
 * A02 Journal surface (Studio §6): a filterable, newest-first ledger list plus the EntryDrawer for
 * composing, posting, drafting, viewing, and reversing double-entry entries.
 *
 * The list is the primary read (`list_journal`). It renders the five canonical states (loading, empty,
 * error, success, permission-denied). A posted row is immutable: it opens the drawer in read-only
 * `view` mode (Reverse only, never edit); a draft row opens in `edit` mode. Money and dates render
 * through the shared `formatMoney`/`formatDate` helpers; status is glyph plus text, never colour alone.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type SVGProps } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT, formatMoney, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { Select } from '../../components/Select';
import { Status } from '../../components/Status';
import { Tabs } from '../../components/Tabs';
import { EntryDrawer } from './EntryDrawer';
import { COMMIT_TARGET_CLASS, useCommitAck } from '../../lib/motion';
// G13: the Archiv tab, a HARD PARTITION. The archive component owns its own query, state and row
// model end to end; nothing below ever holds live and archive rows in one collection, so the mixed
// list cannot exist even transiently (spec §6 safeguard 4).
import { ArchiveTab } from './ArchiveTab';
import { listedBaseTotal } from './money';
import type { DrawerMode, JournalEntry } from './types';
import './Journal.css';

// The full set of `journal_entry.source` values the read model can carry, so the Quelle filter can
// reach every posted event, not just the eight the composer writes. This mirrors `VALID_SOURCES` in
// `src/core/ledger/postEntry.ts` (the single §H-ENUM source of truth) in its canonical order; the
// eleven after `fx` are engine-only sources (vendor bills, dunning fees, credit notes, camt, stock
// and the asset runs) that only their own posting path writes but that `list_journal` filters on.
// Each value already has a `journal.source.<value>` label in both locales. Kept in step with the
// engine by `test/planning/journal-source-filter-drift.test.mjs`.
const SOURCES = [
  'manual',
  'invoice',
  'payment',
  'import',
  'agent',
  'reversal',
  'close',
  'fx',
  'purchase',
  'dunning',
  'credit_note',
  'camt',
  'stock',
  'landed_cost',
  'expense_claim',
  'asset_acquisition',
  'asset_depreciation',
  'asset_disposal',
  'inventory_valuation',
  // A38, Abgrenzungen und Rückstellungen.
  'accrual',
  'provision',
  'vat_settlement',
];

type ListState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  /* A null workspace is its OWN state, not an empty result. Reporting it as `ok` with no entries
     rendered an invitation to record the first entry whose composer could never post, because
     every ctx verb needs a workspaceId. An empty state that offers an action that cannot work is
     a dead end wearing a friendly face. */
  | { kind: 'noWorkspace' }
  | { kind: 'ok'; entries: readonly JournalEntry[] };

interface Filters {
  from: string;
  to: string;
  account: string;
  source: string;
  status: string;
}

const EMPTY_FILTERS: Filters = { from: '', to: '', account: '', source: '', status: '' };

/** A stable empty list for the non-`ok` states, so the columns hook keeps one identity across renders. */
const EMPTY_ENTRIES: readonly JournalEntry[] = [];

/** The live filters wait this long after the last keystroke before they re-read (K-16, D137). */
const FILTER_DEBOUNCE_MS = 250;

/**
 * Circular arrow for a reversal. Decorative: the adjacent "Storno"/"Storniert" text carries the
 * meaning, so the cross-link never depends on colour or glyph alone.
 */
function ReversalGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M3 10h11a5 5 0 0 1 0 10H8" />
      <path d="M7 6l-4 4 4 4" />
    </svg>
  );
}

/**
 * The ledger list columns for the shared `DataTable` (D118 B2). Split out from `Journal` so the
 * reversal cross-links can be resolved once: a Storno row must be able to name the entry it reverses,
 * and the reversed original must show that it has been corrected. Without both directions a reversal
 * pair reads as two unrelated postings of the same amount, which is exactly the confusion this
 * treatment removes. DataTable owns the frame, overflow, sticky header, density, the five states and
 * the row opener (K-21: the whole row opens the entry, and the reference is the row header in the
 * text ink at 500, never the accent on every row, K-12); these columns own only the Journal-specific
 * cell content (the base-currency second figure, the shared Status word and the reversal links).
 */
function useJournalColumns(
  entries: readonly JournalEntry[],
  onOpen: (entry: JournalEntry) => void,
): DataTableColumn<JournalEntry>[] {
  const t = useT();
  return useMemo(() => {
    const label = (e: JournalEntry) => e.ref ?? formatDate(e.date);
    // original id -> the entry that reverses it, and the reverse lookup for a Storno row's target.
    const byId = new Map(entries.map((e) => [e.id, e]));
    const reversalOf = new Map<string, JournalEntry>();
    for (const e of entries) {
      if (e.reversesEntryId != null) reversalOf.set(e.reversesEntryId, e);
    }
    return [
      {
        key: 'date',
        header: t('journal.columns.date'),
        render: (entry) => formatDate(entry.date),
      },
      {
        key: 'ref',
        header: t('journal.columns.ref'),
        // The row header: the reference names the row, and the row itself opens it (K-21).
        rowHeader: true,
        render: (entry) => entry.ref ?? label(entry),
      },
      {
        key: 'description',
        header: t('journal.columns.description'),
        render: (entry) => entry.description,
      },
      {
        key: 'amount',
        header: t('journal.columns.amount'),
        numeric: true,
        // `total` is the TRANSACTION amount, rendered under the currency the engine says it is
        // denominated in (`list_journal`, `mapJournalEntry`), never a hardcoded CHF, and never as
        // money without a currency. The second line is the base-currency total the ENGINE derived
        // from the posted rows at the rate the POSTING used, so a mixed-currency ledger stays
        // comparable without the browser multiplying a rate out (see `listedBaseTotal`).
        render: (entry) => {
          const baseTotal = listedBaseTotal(entry);
          return (
            <>
              {typeof entry.total === 'number' && typeof entry.currency === 'string'
                ? formatMoney(entry.total, entry.currency)
                : ''}
              {baseTotal !== null && (
                <span className="journal-base-total">
                  {/* Screen readers hear "Booked CHF 1'526.16" rather than two bare amounts. */}
                  <span className="visually-hidden">{t('journal.booked')} </span>
                  {formatMoney(baseTotal.baseTotal, baseTotal.baseCurrency)}
                </span>
              )}
            </>
          );
        },
      },
      {
        key: 'source',
        header: t('journal.columns.source'),
        render: (entry) => t(`journal.source.${entry.source}`),
      },
      {
        key: 'status',
        header: t('journal.columns.status'),
        render: (entry) => {
          const posted = entry.status === 'posted';
          const reverses =
            entry.reversesEntryId != null ? byId.get(entry.reversesEntryId) : undefined;
          const isReversal = entry.reversesEntryId != null;
          const reversedBy = reversalOf.get(entry.id);
          // The cross-links sit inside a row that opens on click, so they keep their own click: a
          // press on "Storno" opens the OTHER half of the pair, never also this row.
          const openOther = (event: MouseEvent, other: JournalEntry) => {
            event.stopPropagation();
            onOpen(other);
          };
          return (
            <span className="journal-status">
              {/* K-22: the shared Status word, glyph plus word. */}
              <Status
                kind={posted ? 'success' : 'neutral'}
                label={posted ? t('entry.status.posted') : t('entry.status.draft')}
              />
              {/* Glyph AND word on both cross-links, in the quiet ink: a reversal is a fact about
                  the pair, not an alarm, so it takes no status colour and no chip (K-22). */}
              {isReversal &&
                (reverses !== undefined ? (
                  <button
                    type="button"
                    className="journal-xref"
                    aria-label={t('journal.openReversed', { label: label(reverses) })}
                    onClick={(event) => openOther(event, reverses)}
                  >
                    <ReversalGlyph />
                    {t('journal.reversalTag')}
                  </button>
                ) : (
                  <span className="journal-xref">
                    <ReversalGlyph />
                    {t('journal.reversalTag')}
                  </span>
                ))}
              {reversedBy !== undefined && (
                <button
                  type="button"
                  className="journal-xref"
                  aria-label={t('journal.openReversal', { label: label(reversedBy) })}
                  onClick={(event) => openOther(event, reversedBy)}
                >
                  <ReversalGlyph />
                  {t('journal.reversedTag')}
                </button>
              )}
            </span>
          );
        },
      },
    ];
  }, [entries, onOpen, t]);
}

export function Journal() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();

  const [state, setState] = useState<ListState>({ kind: 'loading' });
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // The filters that produced the CURRENT result set (not the draft `filters`, which change as the
  // user edits the form before applying). The empty state branches on these so a filtered miss reads
  // as "no match, clear filters" rather than the first-run "record your first entry" invitation.
  const [appliedFilters, setAppliedFilters] = useState<Filters>(EMPTY_FILTERS);
  const [drawer, setDrawer] = useState<{ mode: DrawerMode; entryId?: string } | null>(null);
  // The Commit moment (D122 D-I): the entry the composer just wrote. Its row lands from above with
  // the decaying tint once the refetch has rendered it; the drawer closing is not the ack, the row is.
  const [justWrittenId, setJustWrittenId] = useState<string | null>(null);
  // F-05 (friction ledger, Phase 2): the home's "Buchen" door lands here as `/journal?new=1` and
  // opens the composer at once, one act from the Übersicht. The flag is consumed (replaced out of
  // the URL) so a reload or a back-step does not reopen the composer.
  const [searchParams, setSearchParams] = useSearchParams();
  const openNew = searchParams.get('new') === '1';
  useEffect(() => {
    if (!openNew) return;
    setDrawer({ mode: 'create' });
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [openNew, searchParams, setSearchParams]);
  // G13: which face of the surface is showing. The archive is a TAB, not a filter value, so the
  // two worlds can never appear in one result set (spec §6 safeguard 4).
  const [view, setView] = useState<'live' | 'archive'>('live');
  const readSeq = useRef(0);

  const load = useCallback(
    async (applied: Filters) => {
      if (workspaceId === null) {
        setState({ kind: 'noWorkspace' });
        return;
      }
      setState({ kind: 'loading' });
      setAppliedFilters(applied);
      // Live filters (K-16) can put two reads in flight; only the latest one may land, so a slow
      // answer for an older filter never overwrites the list the current filter asked for.
      readSeq.current += 1;
      const mine = readSeq.current;
      const input: Record<string, unknown> = { workspaceId };
      if (applied.from !== '') input.from = applied.from;
      if (applied.to !== '') input.to = applied.to;
      if (applied.account !== '') input.account = applied.account;
      if (applied.source !== '') input.source = applied.source;
      if (applied.status !== '') input.status = applied.status;
      const { body } = await client.call('list_journal', input);
      if (mine !== readSeq.current) return;
      if (isErr(body)) {
        setState({ kind: 'error', error: body });
        return;
      }
      setState({
        kind: 'ok',
        // The cast stays, and it is NOT laundering: `list_journal` declares `readonly
        // JournalListEntry[]`, and the Studio's `JournalEntry` is deliberately STRICTER about the
        // §H-FX triple. The engine types `baseTotal`/`fxRate`/`baseCurrency` as three independent
        // optionals, so its type admits `{ baseCurrency, baseTotal, fxRate: null }` and even a
        // `baseTotal` with no currency to denominate it; `JournalEntryFx` in `./types` is a
        // three-arm union that makes those unrepresentable. Only `mapJournalEntry` builds the
        // triple correctly, at runtime, so the two types genuinely disagree and the direct
        // assignment is TS2322. Narrowing the engine's own declaration is A02's call, not this
        // surface's. The `?? []` that stood here is gone: `entries` is a required field of the
        // declared payload, so the fallback was for a response the engine cannot send.
        entries: body.entries as readonly JournalEntry[],
      });
    },
    [client, workspaceId],
  );

  useEffect(() => {
    void load(EMPTY_FILTERS);
  }, [load]);

  // K-16: the filters are live. A change re-reads 250ms after the last keystroke, so typing an account
  // number is one read and not five; there is no "Filter anwenden" to remember. A filter set that is
  // already the one on screen reads nothing.
  const filtersKey = JSON.stringify(filters);
  const appliedKey = JSON.stringify(appliedFilters);
  useEffect(() => {
    if (filtersKey === appliedKey) return undefined;
    const timer = window.setTimeout(() => void load(filters), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `filters` is read through its key: the effect runs when the VALUES change, not the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, appliedKey, load]);

  /**
   * A24 RESOLVED THIS. The history is worth keeping because the shape of the defect is the lesson.
   *
   * This used to be `body.canPost !== false`, read off `list_journal`. That verb has never carried
   * a `canPost`, so the expression was `undefined !== false` and the gate below (Post, Save draft
   * and Reverse in `EntryDrawer`, plus the `requiresBookkeeper` tooltip) stood open in every build
   * that ever shipped. Declaring the payload turned it into TS2339, which is how it was found, and
   * it was replaced with a literal `true` and a note deferring the real source to A24.
   *
   * The answer A24 gave is that a permission answer never rides on a list read. It comes from
   * `whoami`, the one verb whose job is that question, read once per workspace in `Shell.tsx`. So
   * `ListState` no longer carries a `canPost` field at all: there is nothing for a future author to
   * be tempted to populate from a response body.
   *
   * `useCan` returns TRUE while `whoami` is unresolved, deliberately. The Studio gate is a courtesy
   * that saves an operator a refused click; the engine gate at `ctxAction` is the one that decides,
   * and it does not consult this line.
   */
  const canPost = useCan(CAP.post);

  const refetch = useCallback(() => void load(filters), [load, filters]);

  const openEntry = useCallback((entry: JournalEntry) => {
    setDrawer({ mode: entry.status === 'posted' ? 'view' : 'edit', entryId: entry.id });
  }, []);

  // Columns are built unconditionally (rules of hooks), off whatever the current state holds. An empty
  // list on a non-`ok` state is fine: DataTable renders loading/error/empty and never reads the rows.
  const entries = state.kind === 'ok' ? state.entries : EMPTY_ENTRIES;
  useCommitAck(justWrittenId, entries);
  const columns = useJournalColumns(entries, openEntry);
  const anyFilterActive =
    appliedFilters.from !== '' ||
    appliedFilters.to !== '' ||
    appliedFilters.account !== '' ||
    appliedFilters.source !== '' ||
    appliedFilters.status !== '';
  const anyFilterSet = filtersKey !== JSON.stringify(EMPTY_FILTERS);
  const clearFilters = () => {
    setFilters(EMPTY_FILTERS);
    void load(EMPTY_FILTERS);
  };
  const entryLabel = (entry: JournalEntry) => entry.ref ?? formatDate(entry.date);

  // No workspace: the filter bar and the composer would both be dead, so say so once and point at
  // the way out instead of rendering a page of controls that cannot do anything.
  if (state.kind === 'noWorkspace') {
    return (
      <section aria-labelledby="journal-title">
        <SurfaceHeader title={t('journal.title')} titleId="journal-title" />
        <NoWorkspaceState body={t('journal.noWorkspaceHint')} />
      </section>
    );
  }

  return (
    <section aria-labelledby="journal-title">
      <SurfaceHeader
        title={t('journal.title')}
        titleId="journal-title"
        help={<SurfaceHelp surface="Journal" />}
        // Always opens the composer; the write controls INSIDE are what a missing capability disables
        // (A24: disable the action, do not hide the surface). On the ARCHIVE face it does not render
        // at all: the archive has no write, and a surface must not offer the forbidden thing.
        actions={
          view === 'live' ? (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setDrawer({ mode: 'create' })}
            >
              {t('journal.newEntry')}
            </button>
          ) : undefined
        }
      />

      {/* G13: the two faces, on the shared Tabs (K-11). A tab is a hard partition, not a filter
          value (spec §6 safeguard 4): the archive face mounts its own query and the live list is
          unmounted, so the two never share a result set. */}
      <Tabs
        label={t('journal.tablist')}
        tabs={[
          { id: 'live', label: t('journal.tab.live') },
          { id: 'archive', label: t('archive.tab') },
        ]}
        activeId={view}
        onChange={(id) => setView(id === 'archive' ? 'archive' : 'live')}
      >
      {view === 'archive' ? (
        <ArchiveTab workspaceId={workspaceId as string} />
      ) : (
        <>
      {/* K-16: live filters, no apply button. Enter still reads at once. */}
      <form
        className="journal-filters panel"
        aria-label={t('journal.filters.legend')}
        onSubmit={(e) => {
          e.preventDefault();
          void load(filters);
        }}
      >
        <label className="journal-field">
          {t('journal.filters.from')}
          <input
            className="field"
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          />
        </label>
        <label className="journal-field">
          {t('journal.filters.to')}
          <input
            className="field"
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          />
        </label>
        <label className="journal-field">
          {t('journal.filters.account')}
          <input
            className="field"
            type="text"
            value={filters.account}
            onChange={(e) => setFilters((f) => ({ ...f, account: e.target.value }))}
          />
        </label>
        <div className="journal-field">
          {t('journal.filters.source')}
          <Select
            value={filters.source}
            onChange={(value) => setFilters((f) => ({ ...f, source: value }))}
            options={[
              { value: '', label: t('journal.filters.all') },
              ...SOURCES.map((s) => ({ value: s, label: t(`journal.source.${s}`) })),
            ]}
            ariaLabel={t('journal.filters.source')}
          />
        </div>
        <div className="journal-field">
          {t('journal.filters.status')}
          <Select
            value={filters.status}
            onChange={(value) => setFilters((f) => ({ ...f, status: value }))}
            options={[
              { value: '', label: t('journal.filters.all') },
              { value: 'draft', label: t('entry.status.draft') },
              { value: 'posted', label: t('entry.status.posted') },
            ]}
            ariaLabel={t('journal.filters.status')}
          />
        </div>
        {/* Five fields have no cross each, so the way back to the whole journal is one quiet
            ghost, shown only while a filter is set. */}
        {anyFilterSet && (
          <div className="journal-filter-actions">
            <button type="button" className="btn btn--ghost btn--sm" onClick={clearFilters}>
              {t('journal.filters.clear')}
            </button>
          </div>
        )}
      </form>

      {/* A24: a refused read hides the table and states why, never a table shell behind an error.
          Every other state (loading, empty, error-with-retry, and the rows) is the shared DataTable,
          so the Journal stops hand-rolling the frame, overflow, sticky header, density and states. */}
      {state.kind === 'error' && state.error.error === 'permission_denied' ? (
        <PermissionDenied body={t('entry.requiresBookkeeper')} />
      ) : (
        <DataTable
          columns={columns}
          rows={state.kind === 'ok' ? entries.slice() : []}
          rowKey={(entry) => entry.id}
          caption={t('journal.title')}
          loading={state.kind === 'loading'}
          error={state.kind === 'error' ? state.error : undefined}
          onRetry={refetch}
          onRowClick={openEntry}
          rowLabel={(entry) => t('journal.openEntry', { label: entryLabel(entry) })}
          rowClassName={(entry) =>
            [
              entry.reversesEntryId != null ? 'journal-row-reversal' : '',
              entry.id === justWrittenId ? COMMIT_TARGET_CLASS : '',
            ]
              .filter(Boolean)
              .join(' ') || undefined
          }
          emptyState={
            anyFilterActive ? (
              <EmptyState
                title={t('journal.noMatch')}
                hint={t('journal.noMatchHint')}
                filtered={{ onClear: clearFilters, clearLabel: t('journal.filters.clear') }}
              />
            ) : (
              <EmptyState
                title={t('journal.empty')}
                hint={t('journal.emptyHint')}
                action={{
                  label: t('journal.emptyAction'),
                  onClick: () => setDrawer({ mode: 'create' }),
                }}
              />
            )
          }
        />
      )}
        </>
      )}
      </Tabs>

      {drawer !== null && (
        <EntryDrawer
          mode={drawer.mode}
          entryId={drawer.entryId}
          canPost={canPost}
          onClose={() => setDrawer(null)}
          onWritten={(entryId) => {
            setJustWrittenId(entryId ?? null);
            refetch();
          }}
        />
      )}
    </section>
  );
}

export default Journal;
