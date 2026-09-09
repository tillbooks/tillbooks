/**
 * A22, FX revaluation (`/fx`): the exchange-rate register and the period-end unrealised revaluation.
 *
 * TWO PANELS OVER FOUR VERBS, and not one figure derived in the browser. The RATES panel maintains
 * the rate history (`record_exchange_rate` to add, `list_exchange_rates` to show, append-only: an
 * add writes a new dated row, never an edit). The REVALUATION panel computes the closing-rate
 * unrealised gain/loss at a period end (`fx_revaluation`, a pure read model, nothing posted) and
 * posts it as reversing entries on approval (`post_fx_revaluation`). The surface renders exactly the
 * positions and diffs the engine sends; OR Art. 960a's valuation and the reversing-entry posting are
 * the engine's, per the spec's §6b Fixed list.
 *
 * THE ONE WRITE-CAPABILITY GATE (A24). Both writes here (`record_exchange_rate` and
 * `post_fx_revaluation`) require `post` at the engine, so **Add rate** and **Post revaluation** are
 * pre-disabled with a padlock and a "requires bookkeeper" tooltip for an actor without it, never
 * shown and then rejected on submit. The Studio gate is a convenience: the engine gate is the real
 * one (see `lib/capabilities.ts`), so a disabled control here is a courtesy, not the enforcement.
 *
 * THE MONEY UNIT ON EACH FIGURE IS EXPLICIT, because a position is in a FOREIGN currency and its
 * revaluation is in the ledger base. `fcAmountMinor` prints in the position's own `currency`; every
 * CHF figure (book, revalued, diff, total) prints in the workspace base currency, read from the
 * profile rather than assumed. A hardcoded CHF would print the wrong unit on a EUR-base ledger.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 B2, 2026-08-24)
 *
 * The page header is the shared `SurfaceHeader`, and both tables (the rate register and the
 * revaluation positions) are the shared `DataTable`: frame overflow, sticky header, density and the
 * loading/empty/error states in one place, instead of two hand-rolled `<table>`s and their
 * duplicated CSS. The revaluation total moved out of a `<tfoot>` row into a labelled summary line
 * below its table, because `DataTable` is flat-rows-only; it sits with the per-currency subtotals,
 * which already lived outside the table. The add-rate form STAYS inline (it was never an overlay, and
 * B2's rule is to match the current model, not invent a Modal), and the diff-figure rendering, the
 * currency-pair/account cells, the panels and the refusal CTAs are the styling that remains genuinely
 * A22-specific. No `FilterBar`: this surface has no search/filter row, and the period-end picker is a
 * revaluation control, not a surface-level filter.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { LockGlyph } from '../../components/states/glyphs';
import { useCan, CAP } from '../../lib/capabilities';
import { GainGlyph, LossGlyph } from './glyphs';
import {
  parseRates,
  parseRevaluation,
  parsePostResult,
  refusalOf,
  todayIso,
  type RateRow,
  type FxPositionView,
  type FxRevaluationView,
  type PostResultView,
  type FxRefusal,
} from './model';
import './Fx.css';

export function Fx() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  /**
   * THE PADLOCK (A24). Both writes on this surface require `post`, so the add-rate form and the
   * Post-revaluation button are disabled without it. Reading rates and computing the revaluation
   * stay open: they are reads.
   */
  const canPost = useCan(CAP.post);

  const [currency, setCurrency] = useState('CHF');

  // --- the rate history ------------------------------------------------------------------------
  const [rates, setRates] = useState<RateRow[]>([]);
  const [ratesLoading, setRatesLoading] = useState(true);
  const [ratesError, setRatesError] = useState<Err | null>(null);

  const loadRates = useCallback(async () => {
    if (workspaceId === null) {
      setRatesLoading(false);
      return;
    }
    setRatesLoading(true);
    setRatesError(null);
    const { body } = await client.call('list_exchange_rates', { workspaceId });
    if (isErr(body)) {
      setRatesError(body);
      setRatesLoading(false);
      return;
    }
    const parsed = parseRates(body);
    setRates(parsed ?? []);
    setRatesLoading(false);
  }, [client, workspaceId]);

  useEffect(() => {
    void loadRates();
  }, [loadRates]);

  useEffect(() => {
    if (workspaceId === null) return;
    void client.call('get_company_profile', { workspaceId }).then(({ body }) => {
      if (isErr(body)) return;
      const base = (body as { baseCurrency?: unknown }).baseCurrency;
      if (typeof base === 'string' && base.length > 0) setCurrency(base);
    });
  }, [client, workspaceId]);

  // --- add a rate ------------------------------------------------------------------------------
  const [addCurrency, setAddCurrency] = useState('');
  const [addRate, setAddRate] = useState('');
  const [addAsOf, setAddAsOf] = useState(todayIso());
  const [addPending, setAddPending] = useState(false);
  const [addError, setAddError] = useState<Err | null>(null);

  // The key is the exact question the write sends, so a re-click of an UNCHANGED add is one write and
  // a changed value is a new one (see `useIdempotencyKey`). `baseCurrency` here is the FOREIGN
  // currency; the ledger base is the quote side the engine fills in.
  const addKey = useIdempotencyKey({ workspaceId, baseCurrency: addCurrency.toUpperCase(), rate: addRate.trim(), asOf: addAsOf });

  const submitRate = useCallback(async () => {
    if (workspaceId === null) return;
    setAddPending(true);
    setAddError(null);
    const { body } = await client.call('record_exchange_rate', {
      workspaceId,
      baseCurrency: addCurrency.toUpperCase(),
      rate: addRate.trim(),
      asOf: addAsOf,
      source: 'manual',
      idempotencyKey: addKey,
    });
    setAddPending(false);
    if (isErr(body)) {
      setAddError(body);
      return;
    }
    setAddCurrency('');
    setAddRate('');
    await loadRates();
  }, [client, workspaceId, addCurrency, addRate, addAsOf, addKey, loadRates]);

  const addReady = addCurrency.trim().length >= 3 && addRate.trim().length > 0 && addAsOf.length === 10;

  // --- the revaluation -------------------------------------------------------------------------
  const [periodEnd, setPeriodEnd] = useState(todayIso());
  const [view, setView] = useState<FxRevaluationView | null>(null);
  const [computeLoading, setComputeLoading] = useState(false);
  const [computeError, setComputeError] = useState<Err | null>(null);
  const [computed, setComputed] = useState(false);

  const [postPending, setPostPending] = useState(false);
  const [postRefusal, setPostRefusal] = useState<FxRefusal | null>(null);
  const [postError, setPostError] = useState<Err | null>(null);
  const [postResult, setPostResult] = useState<PostResultView | null>(null);

  const resetPost = () => {
    setPostRefusal(null);
    setPostError(null);
    setPostResult(null);
  };

  const compute = useCallback(async () => {
    if (workspaceId === null) return;
    setComputeLoading(true);
    setComputeError(null);
    resetPost();
    const { body } = await client.call('fx_revaluation', { workspaceId, periodEnd });
    setComputeLoading(false);
    setComputed(true);
    if (isErr(body)) {
      setComputeError(body);
      setView(null);
      return;
    }
    const parsed = parseRevaluation(body);
    if (parsed === null) {
      setComputeError({ ok: false, error: 'unexpected_error' } as Err);
      setView(null);
      return;
    }
    setView(parsed);
  }, [client, workspaceId, periodEnd]);

  const postKey = useIdempotencyKey({ workspaceId, periodEnd });

  const post = useCallback(async () => {
    if (workspaceId === null) return;
    setPostPending(true);
    resetPost();
    const { body } = await client.call('post_fx_revaluation', { workspaceId, periodEnd, idempotencyKey: postKey });
    setPostPending(false);
    if (isErr(body)) {
      const named = refusalOf(body);
      if (named !== null) setPostRefusal(named);
      else setPostError(body);
      return;
    }
    const parsed = parsePostResult(body);
    if (parsed === null) {
      setPostError({ ok: false, error: 'unexpected_error' } as Err);
      return;
    }
    // The confirmation stands on the read model already on screen: the Post button is hidden while
    // `postResult` is set, and re-computing here would clear the confirmation (compute resets the
    // post state) for a view that is unchanged, since the revaluation adjustment is a CHF line the
    // FC-scoped read model deliberately excludes. Clicking Compute again is the way back to a fresh
    // pass, and a re-post there answers `already_posted`.
    setPostResult(parsed);
  }, [client, workspaceId, periodEnd, postKey]);

  const movements = useMemo(() => (view === null ? 0 : view.positions.filter((p) => p.diffChfMinor !== 0).length), [view]);
  const postable = view !== null && movements > 0 && view.needsRate.length === 0 && postResult === null;

  if (workspaceId === null) return <NoWorkspaceState />;

  // The rate register, as flat DataTable columns. The rate is a `numeric` column (right-aligned,
  // tabular figures); the currency pair carries its quote side in a faint span, the source is
  // resolved to its localized label.
  const rateColumns: DataTableColumn<RateRow>[] = [
    {
      key: 'pair',
      header: t('fx.currency'),
      render: (r) => (
        <>
          {r.baseCurrency}
          <span className="fx-pair-quote"> / {r.quoteCurrency}</span>
        </>
      ),
    },
    { key: 'rate', header: t('fx.rate'), numeric: true, render: (r) => r.rate },
    { key: 'date', header: t('fx.date'), render: (r) => formatDate(r.asOf) },
    { key: 'source', header: t('fx.source'), render: (r) => t(`fx.sourceKind.${r.source}`) },
  ];

  // The revaluation positions, as flat DataTable columns. Every CHF figure prints in the ledger base
  // (`view.baseCurrency`); the FC amount prints in the position's own currency. `positionBase` falls
  // back to the profile base only so the columns build when `view` is momentarily null; the columns
  // are only rendered when `view` is present, where `positionBase === view.baseCurrency`.
  const positionBase = view?.baseCurrency ?? currency;
  const positionColumns: DataTableColumn<FxPositionView>[] = [
    {
      key: 'account',
      header: t('fx.account'),
      render: (p) => (
        <>
          <span className="fx-acct-number">{p.accountNumber}</span>
          <span className="fx-acct-kind"> {t(`fx.kind.${p.kind}`)}</span>
        </>
      ),
    },
    { key: 'currency', header: t('fx.currency'), render: (p) => p.currency },
    { key: 'fc', header: t('fx.fcAmount'), numeric: true, render: (p) => formatMoney(p.fcAmountMinor, p.currency) },
    { key: 'rate', header: t('fx.rate'), numeric: true, render: (p) => p.rate },
    { key: 'book', header: t('fx.bookValue'), numeric: true, render: (p) => formatMoney(p.bookChfMinor, positionBase) },
    { key: 'revalued', header: t('fx.revalued'), numeric: true, render: (p) => formatMoney(p.revaluedChfMinor, positionBase) },
    {
      key: 'diff',
      header: t('fx.diff'),
      numeric: true,
      render: (p) => <DiffCell minor={p.diffChfMinor} currency={positionBase} t={t} />,
    },
  ];

  return (
    <section className="fx">
      <SurfaceHeader
        title={t('fx.title')}
        subtitle={t('fx.subtitle')}
        help={<SurfaceHelp surface="Fx" />}
      />

      {/* ================= RATES ================= */}
      <div className="fx-block">
        <div className="fx-block-head">
          <h2 className="fx-block-title">{t('fx.rates')}</h2>
        </div>

        {canPost ? (
          <form
            className="fx-addrate"
            onSubmit={(e) => {
              e.preventDefault();
              if (addReady && !addPending) void submitRate();
            }}
          >
            <div className="fx-addrate-fields">
              <label className="fx-field">
                <span className="fx-field-label">{t('fx.currency')}</span>
                <input
                  className="field"
                  value={addCurrency}
                  onChange={(e) => setAddCurrency(e.target.value.toUpperCase().slice(0, 3))}
                  placeholder="EUR"
                  maxLength={3}
                  autoCapitalize="characters"
                  aria-label={t('fx.currency')}
                />
              </label>
              <label className="fx-field">
                <span className="fx-field-label">{t('fx.rate')}</span>
                <input
                  className="field fx-num"
                  value={addRate}
                  onChange={(e) => setAddRate(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.9520"
                  aria-label={t('fx.rate')}
                />
              </label>
              <label className="fx-field">
                <span className="fx-field-label">{t('fx.date')}</span>
                <input
                  className="field"
                  type="date"
                  value={addAsOf}
                  onChange={(e) => setAddAsOf(e.target.value)}
                  aria-label={t('fx.date')}
                />
              </label>
              <button type="submit" className="btn btn--accent btn--sm fx-addrate-submit" disabled={!addReady || addPending}>
                {addPending ? t('fx.adding') : t('fx.addRate')}
              </button>
            </div>
            <p className="fx-addrate-hint">{t('fx.rateQuoteNote', { base: currency })}</p>
            {addError !== null && (
              <div className="fx-inline-error">
                <ErrorBanner error={addError} />
              </div>
            )}
          </form>
        ) : (
          <p className="fx-locked" role="note">
            <LockGlyph className="fx-lock-glyph" size={16} />
            {t('fx.needBookkeeperRates')}
          </p>
        )}

        <DataTable
          columns={rateColumns}
          rows={rates}
          rowKey={(r) => r.id}
          caption={t('fx.rates')}
          loading={ratesLoading}
          error={ratesError ?? undefined}
          onRetry={() => void loadRates()}
          skeletonRows={4}
          emptyState={<EmptyState title={t('fx.ratesEmpty')} hint={canPost ? t('fx.ratesEmptyHint') : t('fx.ratesEmptyReadonly')} />}
        />
      </div>

      {/* ================= REVALUATION ================= */}
      <div className="fx-block">
        <div className="fx-block-head">
          <h2 className="fx-block-title">{t('fx.revaluation')}</h2>
        </div>

        <div className="fx-reval-controls">
          <label className="fx-field">
            <span className="fx-field-label">{t('fx.periodEnd')}</span>
            <input
              className="field"
              type="date"
              value={periodEnd}
              onChange={(e) => {
                setPeriodEnd(e.target.value);
                setComputed(false);
                setView(null);
                resetPost();
              }}
              aria-label={t('fx.periodEnd')}
            />
          </label>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void compute()} disabled={computeLoading}>
            {computeLoading ? t('fx.computing') : t('fx.compute')}
          </button>
        </div>

        {computeLoading && <Skeleton rows={4} height={32} />}

        {!computeLoading && computeError !== null && <ErrorBanner error={computeError} onRetry={() => void compute()} />}

        {!computeLoading && computeError === null && view !== null && (
          <>
            {view.needsRate.length > 0 && (
              <div className="fx-needsrate panel" role="note">
                <p className="fx-needsrate-title">{t('fx.needsRate')}</p>
                <ul className="fx-needsrate-list">
                  {view.needsRate.map((n) => (
                    <li key={n.currency}>
                      {t('fx.needsRateItem', { currency: n.currency })}
                      {n.latestAsOf !== null && (
                        <span className="fx-needsrate-latest"> {t('fx.needsRateLatest', { date: formatDate(n.latestAsOf) })}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {view.positions.length === 0 ? (
              <EmptyState title={t('fx.revalEmpty')} hint={t('fx.revalEmptyHint')} />
            ) : (
              <>
                <DataTable
                  columns={positionColumns}
                  rows={view.positions}
                  rowKey={(p) => `${p.accountId}-${p.currency}`}
                  caption={t('fx.revaluation')}
                />

                {/* The total: out of the table's tfoot (DataTable is flat-rows-only) into a labelled
                    summary line, alongside the per-currency subtotals below. */}
                <div className="fx-total">
                  <span className="fx-total-label">{t('fx.totalUnrealised')}</span>
                  <DiffCell minor={view.totalUnrealisedMinor} currency={view.baseCurrency} t={t} />
                </div>

                {view.byCurrency.length > 1 && (
                  <ul className="fx-bycurrency">
                    {view.byCurrency.map((c) => (
                      <li key={c.currency}>
                        <span className="fx-bycurrency-code">{c.currency}</span>
                        <DiffCell minor={c.diffChfMinor} currency={view.baseCurrency} t={t} />
                      </li>
                    ))}
                  </ul>
                )}

                <div className="fx-reval-actions">
                  {postResult === null && (
                    <button
                      type="button"
                      className="btn btn--primary"
                      onClick={() => void post()}
                      disabled={!postable || !canPost || postPending}
                      title={!canPost ? t('fx.needBookkeeper') : undefined}
                      aria-label={!canPost ? `${t('fx.post')}: ${t('fx.needBookkeeper')}` : t('fx.post')}
                    >
                      {!canPost && <LockGlyph className="fx-lock-glyph" size={14} />}
                      {postPending ? t('fx.posting') : t('fx.post')}
                    </button>
                  )}
                  {movements > 0 && view.needsRate.length === 0 && (
                    <p className="fx-reverses-note">{t('fx.reversesNote', { date: formatDate(nextDay(periodEnd)) })}</p>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {/* refusals and the success confirmation, below the table so the full line is read */}
        {postRefusal !== null && <RefusalPanel refusal={postRefusal} onAddRate={() => setAddCurrency(firstNeededCurrency(postRefusal))} t={t} />}

        {postError !== null && <ErrorBanner error={postError} onRetry={() => void post()} />}

        {postResult !== null && (
          <div className="fx-posted panel" role="note">
            <p className="fx-posted-line">
              {postResult.posted
                ? t('fx.postedConfirm', { date: postResult.reversalDate === null ? '' : formatDate(postResult.reversalDate) })
                : t('fx.postedNothing')}
            </p>
          </div>
        )}

        {computed && !computeLoading && computeError === null && view === null && (
          <EmptyState title={t('fx.revalEmpty')} hint={t('fx.revalEmptyHint')} />
        )}
      </div>
    </section>
  );
}

/**
 * One diff figure: a sign, a glyph and a label, never colour alone. A loss (`minor < 0`) carries the
 * danger colour on the whole cell (which recolours the minus sign and the down glyph it wraps); a
 * gain renders in the normal text colour with an up glyph; an exact zero is a plain figure. The
 * amount itself comes from `formatMoney`, which already prints a leading minus for a negative.
 */
function DiffCell({ minor, currency, t }: { minor: number; currency: string; t: (k: string, p?: Record<string, string | number>) => string }) {
  if (minor === 0) {
    return <span className="fx-diff fx-diff--flat">{formatMoney(0, currency)}</span>;
  }
  const loss = minor < 0;
  return (
    <span className={loss ? 'fx-diff fx-diff--loss' : 'fx-diff fx-diff--gain'}>
      {loss ? <LossGlyph label={t('fx.lossLabel')} /> : <GainGlyph label={t('fx.gainLabel')} />}
      <span>{formatMoney(minor, currency)}</span>
    </span>
  );
}

/** The named-refusal panel: the one place a `post_fx_revaluation` rejection turns into a next step. */
function RefusalPanel({
  refusal,
  onAddRate,
  t,
}: {
  refusal: FxRefusal;
  onAddRate: () => void;
  t: (k: string, p?: Record<string, string | number>) => string;
}) {
  if (refusal.code === 'needs_rate') {
    const list = refusal.currencies.map((c) => c.currency).join(', ');
    return (
      <div className="fx-refusal panel" role="note">
        <p className="fx-refusal-title">{t('fx.needsRate')}</p>
        <p className="fx-refusal-body">{t('fx.needsRateBody', { currencies: list })}</p>
        <button type="button" className="btn btn--secondary btn--sm" onClick={onAddRate}>
          {t('fx.addRateFor', { currency: refusal.currencies[0]?.currency ?? '' })}
        </button>
      </div>
    );
  }
  if (refusal.code === 'period_locked') {
    return (
      <div className="fx-refusal panel" role="note">
        <p className="fx-refusal-title">{t('fx.periodLocked')}</p>
        <p className="fx-refusal-body">{t('fx.periodLockedBody')}</p>
        <Link className="btn btn--secondary btn--sm" to="/periods">
          {t('fx.periodLockedCta')}
        </Link>
      </div>
    );
  }
  if (refusal.code === 'already_posted') {
    return (
      <div className="fx-refusal panel" role="note">
        <p className="fx-refusal-title">{t('fx.alreadyPosted')}</p>
        <p className="fx-refusal-body">{t('fx.alreadyPostedBody')}</p>
      </div>
    );
  }
  // needs_account: the unrealised difference account (6949) is not in the chart.
  return (
    <div className="fx-refusal panel" role="note">
      <p className="fx-refusal-title">{t('fx.needsAccount')}</p>
      <p className="fx-refusal-body">{t('fx.needsAccountBody', { number: refusal.number ?? '6949' })}</p>
    </div>
  );
}

/** The first currency a `needs_rate` refusal names, prefilled into the add-rate form. */
function firstNeededCurrency(refusal: FxRefusal): string {
  return refusal.code === 'needs_rate' ? refusal.currencies[0]?.currency ?? '' : '';
}

/** The calendar day after an ISO date: the day the revaluation reverses on (first day of next period). */
function nextDay(iso: string): string {
  const next = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(next.getTime())) return iso;
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export default Fx;
