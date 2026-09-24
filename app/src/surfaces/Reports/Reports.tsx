/**
 * A08, Auswertungen (`/reports`): R-S1, the shell that puts four statements one click apart under one
 * set of time controls, with one honest statement about whether they tie to the journal.
 *
 * ONE ROUTE WITH FOUR TABS, not four routes. The four share every control, every state and every
 * export path, and the canon's "a new screen carries a very high bar" applies four times over. A08 §6
 * says the same in its own words: "no per-report screens, one view, four models".
 *
 * WHAT IS NOT HERE, and why each absence is a decision rather than an omission:
 *
 *  - NO GRUPPIERUNG SELECTOR, although A08 §6 specifies one. `SUPPORTED_GROUP_BY` is `['kmu']` and
 *    `requireGroupBy` refuses everything else by design, because account-level custom fields are a G00
 *    capability that does not exist. A control with one option whose only alternative the engine
 *    rejects is not a control. `groupBy` is therefore never sent, and `unsupported_group_by` is
 *    unreachable from this surface: the strongest form of "prevent at the control, not at validation"
 *    is that the control does not exist. Re-proved against the live engine in
 *    `test/reports/studio-reports-fixture.test.mjs`.
 *  - NO "BERICHT SPEICHERN". `saved_reports` is F01's table and F01 is unbuilt.
 *  - NO KENNZAHLEN TILES AND NO CHART. F00 owns dashboards, A08 returns statements rather than series,
 *    and a margin figure would be the browser doing arithmetic on money.
 *  - NO SORTABLE COLUMNS. A statutory statement has a prescribed order, the Saldenbilanz's order is
 *    the chart's, and the Kontoblatt's is chronological by definition.
 *
 * THE COMPARISON IS A PRESET PICKER, NEVER TWO DATE FIELDS (INV-3). `computeTrialBalance` validates
 * `compareTo.periodStart` and then reads only `periodEnd`, computing a cumulative closing balance at
 * it (finding F3). Two date fields would ask the operator for a value that changes nothing, which is
 * worse than asking for nothing: it teaches a false model of what the column means. The presets
 * compute their dates from the dates already on screen, which is calendar arithmetic and not money
 * arithmetic. The column header names the actual DATE, never the preset.
 *
 * DEFAULTS DO THE COMMON THING. The period defaults to the current FISCAL year to date, read from
 * `get_company_profile`, never hardcoded to the calendar year: a workspace whose year starts in July
 * would otherwise open every report on a window that means nothing to it. The Bilanz's Stichtag
 * defaults to the period end, so switching tabs keeps the operator inside one time window (R37). The
 * Kontoblatt inherits the period and has NO default account, because there is no common account and
 * guessing one would be a fabricated choice.
 *
 * THE HEADER STATES THE CURRENCY ONCE AND THE PERIOD NOT AT ALL. Every model returns `baseCurrency`
 * and every figure on every statement is in it, so the currency is a header fact rather than a prefix
 * on 60 rows. The period lives in the toolbar, because that is where you change it, and again in the
 * statement's own heading, because that one prints and is what makes a screenshot self-describing.
 *
 * DURING LOADING AND DURING AN ERROR, NO FIGURE RENDERS AT ALL. Not a header total, not a section
 * subtotal, not a reconciliation verdict, and above all not `CHF 0.00`. An unavailable figure is an
 * explicit muted state, and on a financial statement a plausible number is the most expensive kind of
 * wrong.
 *
 * `needs_chart` IS ITS OWN STATE AND NOT THE ERROR BANNER (R14). The tab set stays live, because
 * switching reports is free and the answer is the same on all four: it is the chart that is missing,
 * not the report.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCan, CAP } from '../../lib/capabilities';
import { useT, useI18n } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Select } from '../../components/Select';
import { Tabs } from '../../components/Tabs';
import { ErrorBanner, NoWorkspaceState, PermissionDenied, Skeleton } from '../../components/states';
import { EntryDrawer } from '../Journal/EntryDrawer';
import { AccountPicker } from './AccountPicker';
import { BalanceSheet } from './BalanceSheet';
import { ExportAction } from './ExportAction';
import { GeneralLedger } from './GeneralLedger';
import { IncomeStatement } from './IncomeStatement';
import { Reconciliation } from './Reconciliation';
import { TrialBalance } from './TrialBalance';
import {
  COMPARE_PRESETS,
  REPORT_TABS,
  VERB_FOR_TAB,
  compareAsOfFor,
  comparePeriodFor,
  comparePresetFrom,
  compareSourceFor,
  defaultPeriod,
  isIsoDate,
  parseBalanceSheet,
  parseGeneralLedger,
  parseIncomeStatement,
  parsePickerAccounts,
  parseTrialBalance,
  tabFrom,
  type BalanceSheetView,
  type GeneralLedgerView,
  type IncomeStatementView,
  type PickerAccount,
  type ReportTab,
  type TrialBalanceView,
} from './model';
import './Reports.css';

const TAB_LABEL: Readonly<Record<ReportTab, string>> = {
  trial: 'reports.tab.trialBalance',
  balance: 'reports.tab.balanceSheet',
  income: 'reports.tab.incomeStatement',
  ledger: 'reports.tab.generalLedger',
};

const COMPARE_LABEL: Readonly<Record<string, string>> = {
  none: 'reports.compare.none',
  period: 'reports.compare.priorPeriod',
  year: 'reports.compare.priorYear',
  // G13: the Vorsystem comparative, drawn from the prior-system GL archive and labelled as such in
  // the column header itself (never mixed with a TILL-computed figure).
  archive: 'reports.compare.archive',
};

type Loaded =
  | { tab: 'trial'; view: TrialBalanceView }
  | { tab: 'balance'; view: BalanceSheetView }
  | { tab: 'income'; view: IncomeStatementView }
  | { tab: 'ledger'; view: GeneralLedgerView };

/**
 * A reply the report parser could not read. The engine answered `ok`, so no code came back; the
 * mismatch between what it sent and what this surface expects is a defect by definition, and naming
 * it as `unexpected_error` (a defect-shaped code) is what lets the banner offer to report it.
 */
const UNREADABLE_REPLY: Err = { ok: false, error: 'unexpected_error' };

export function Reports() {
  // A24: the Kontoblatt drawer offers Reverse, so it needs the same answer the Journal reads, from
  // the same place. A08 itself is five reads and gates nothing of its own.
  const canPost = useCan(CAP.post);
  const t = useT();
  const { locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [params, setParams] = useSearchParams();

  const tab = tabFrom(params.get('report'));
  const preset = comparePresetFrom(params.get('compare'));
  const accountParam = params.get('account');
  const entryParam = params.get('entry');
  const pickerOpenParam = params.get('picker') === '1';

  const [fiscalYearStart, setFiscalYearStart] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  // The engine's rejection behind a failed read, so the banner can offer "Diesen Fehler melden" for
  // a defect-shaped code (K-35). A reply the parser cannot read is a defect by definition.
  const [failure, setFailure] = useState<Err | null>(null);
  const [denied, setDenied] = useState(false);
  const [needsChart, setNeedsChart] = useState(false);
  const [accountMissing, setAccountMissing] = useState(false);

  const [accounts, setAccounts] = useState<PickerAccount[] | null>(null);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountsFailed, setAccountsFailed] = useState(false);

  // The fiscal year start is read ONCE. It is a workspace setting, not a per-report parameter, and
  // re-reading it on every tab switch would make four reads of one fact.
  useEffect(() => {
    if (workspaceId === null) return;
    let live = true;
    void (async () => {
      const response = await client.call('get_company_profile', { workspaceId });
      if (!live) return;
      const profile = isErr(response.body) ? null : (response.body.profile as Record<string, unknown> | undefined);
      const start = typeof profile?.fiscalYearStart === 'string' ? profile.fiscalYearStart : '01-01';
      setFiscalYearStart(start);
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);

  const fallback = useMemo(() => defaultPeriod(fiscalYearStart ?? '01-01'), [fiscalYearStart]);

  /** A URL date that is not a real calendar day falls back and names itself, never blanks the screen. */
  const readDate = (key: string, fallbackValue: string): { value: string; invalid: boolean } => {
    const raw = params.get(key);
    if (raw === null || raw === '') return { value: fallbackValue, invalid: false };
    return isIsoDate(raw) ? { value: raw, invalid: false } : { value: fallbackValue, invalid: true };
  };

  const from = readDate('from', fallback.from);
  const to = readDate('to', fallback.to);
  const asOf = readDate('asOf', to.value);
  const periodInverted = from.value > to.value;

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value === null) next.delete(key);
      else next.set(key, value);
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  /** The exact parameter set the screen used, which the export forwards unchanged (R32). */
  const requestFor = useCallback(
    (which: ReportTab): Record<string, unknown> | null => {
      const source = compareSourceFor(preset);
      if (which === 'balance') {
        const compareAsOf = compareAsOfFor(preset, from.value, asOf.value);
        return {
          asOf: asOf.value,
          ...(compareAsOf === null
            ? {}
            : { compareTo: { asOf: compareAsOf, ...(source === undefined ? {} : { source }) } }),
        };
      }
      const compareTo = comparePeriodFor(preset, from.value, to.value);
      const period = {
        periodStart: from.value,
        periodEnd: to.value,
        ...(compareTo === null
          ? {}
          : { compareTo: { ...compareTo, ...(source === undefined ? {} : { source }) } }),
      };
      if (which === 'ledger') {
        if (accountParam === null) return null;
        // `general_ledger` takes no `compareTo`, so the preset is simply not forwarded here rather
        // than being sent and ignored.
        return { accountId: accountParam, periodStart: from.value, periodEnd: to.value };
      }
      return period;
    },
    [preset, from.value, to.value, asOf.value, accountParam],
  );

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    // The engine's `invalid_period` is unreachable from this toolbar: an inverted period is refused
    // here, inline, and no read is issued (R15).
    if (periodInverted) {
      setLoading(false);
      setLoaded(null);
      return;
    }
    const request = requestFor(tab);
    if (request === null) {
      // The Kontoblatt with no account chosen. Not an error and not a failed read: nothing was asked.
      setLoading(false);
      setLoaded(null);
      setAccountMissing(false);
      return;
    }

    setLoading(true);
    setFailed(false);
    setFailure(null);
    setDenied(false);
    setNeedsChart(false);
    setAccountMissing(false);

    const response = await client.call(VERB_FOR_TAB[tab], { workspaceId, ...request });
    if (isErr(response.body)) {
      const code = response.body.error;
      if (code === 'permission_denied' || response.status === 403) setDenied(true);
      else if (code === 'needs_chart') setNeedsChart(true);
      else if (code === 'not_found' && tab === 'ledger') setAccountMissing(true);
      else {
        setFailed(true);
        setFailure(response.body);
      }
      setLoaded(null);
      setLoading(false);
      return;
    }

    const body = response.body as Record<string, unknown>;
    const unreadable = () => {
      setFailed(true);
      setFailure(UNREADABLE_REPLY);
    };
    if (tab === 'trial') {
      const view = parseTrialBalance(body);
      if (view === null) unreadable();
      setLoaded(view === null ? null : { tab, view });
    } else if (tab === 'balance') {
      const view = parseBalanceSheet(body);
      if (view === null) unreadable();
      setLoaded(view === null ? null : { tab, view });
    } else if (tab === 'income') {
      const view = parseIncomeStatement(body);
      if (view === null) unreadable();
      setLoaded(view === null ? null : { tab, view });
    } else {
      const view = parseGeneralLedger(body);
      if (view === null) unreadable();
      setLoaded(view === null ? null : { tab, view });
    }
    setLoading(false);
  }, [client, workspaceId, tab, requestFor, periodInverted]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadAccounts = useCallback(async () => {
    if (workspaceId === null) return;
    setAccountsLoading(true);
    setAccountsFailed(false);
    const response = await client.call('list_accounts', { workspaceId, includeArchived: true });
    if (isErr(response.body)) {
      setAccountsFailed(true);
      setAccountsLoading(false);
      return;
    }
    const parsed = parsePickerAccounts(response.body as Record<string, unknown>);
    if (parsed === null) setAccountsFailed(true);
    setAccounts(parsed);
    setAccountsLoading(false);
  }, [client, workspaceId]);

  const pickerOpen = tab === 'ledger' && (pickerOpenParam || accountParam === null || accountMissing);

  useEffect(() => {
    if (pickerOpen && accounts === null && !accountsLoading && !accountsFailed) void loadAccounts();
  }, [pickerOpen, accounts, accountsLoading, accountsFailed, loadAccounts]);

  if (workspaceId === null) return <NoWorkspaceState body={t('reports.empty.noWorkspaceHint')} />;
  if (denied) return <PermissionDenied body={t('reports.error.permissionDenied')} />;

  const settled = !loading && !failed && loaded !== null;
  const chosen = accounts?.find((account) => account.id === accountParam) ?? null;

  /**
   * The Bilanz drill's window: the fiscal year containing `asOf`, ENDING at `asOf` (R38).
   *
   * The end date is what makes the figure the operator clicked equal the figure they land on, because
   * the Kontoblatt's Schlusssaldo is the cumulative net at `periodEnd` whatever the start date is.
   */
  const drillTo = (accountId: string, window: { from: string; to: string }) => {
    const next = new URLSearchParams(params);
    next.set('report', 'ledger');
    next.set('account', accountId);
    next.set('from', window.from);
    next.set('to', window.to);
    next.delete('picker');
    setParams(next, { replace: false });
  };

  const bilanzDrillWindow = (): { from: string; to: string } => {
    const fyStart = defaultPeriod(fiscalYearStart ?? '01-01', asOf.value).from;
    return { from: fyStart, to: asOf.value };
  };

  const exportParams = (() => {
    const request = requestFor(tab);
    return request === null ? { kind: tab } : { workspaceId, kind: tab, ...request };
  })();

  return (
    <section className="rp" aria-labelledby="rp-title">
      {/*
        SurfaceHeader (D118) owns the page-header treatment: the title, its inline help, and the
        right-pinned action slot (the export controls). The currency note and the reconciliation
        verdict are NOT a plain string subtitle: the note is a skeleton until the read settles and the
        verdict is a live component that becomes a coloured band on failure, so they render in their
        own status block directly under the header rather than through `subtitle`.
      */}
      <SurfaceHeader
        title={t('reports.title')}
        titleId="rp-title"
        help={<SurfaceHelp surface="Reports" />}
        actions={
          <ExportAction
            params={exportParams}
            blockedReason={
              tab === 'ledger' && accountParam === null
                ? t('reports.export.needsAccount')
                : preset === 'archive' && tab !== 'ledger'
                  ? // G13: the Vorsystem comparative is a labelled screen column this wave; the export
                    // twin is blocked at the control rather than refused after the click (R15's rule).
                    t('reports.export.archiveCompare')
                  : null
            }
          />
        }
      />

      <div className="rp-status">
        {settled ? (
          <p className="rp-currency">
            {t('reports.currencyNote', { currency: currencyOf(loaded) })}
          </p>
        ) : (
          <p className="rp-currency rp-currency--pending" aria-hidden="true">
            <span className="rp-line-skeleton" />
          </p>
        )}
        {settled && (
          <Reconciliation
            tab={loaded.tab}
            reconciles={loaded.view.reconciles}
            reconciliation={loaded.view.reconciliation}
          />
        )}
      </div>

      {/* K-11: the four statements are views of one surface, so the shared Tabs; the toolbar and the
          statement are its panel. */}
      <Tabs
        label={t('reports.tablist')}
        tabs={REPORT_TABS.map((value) => ({ id: value, label: t(TAB_LABEL[value]) }))}
        activeId={tab}
        onChange={(id) => setParam('report', id === 'trial' ? null : id)}
      >
      <div className="rp-panel">
      <div className="rp-toolbar">
        {tab === 'balance' ? (
          <label className="rp-field" htmlFor="rp-as-of">
            <span>{t('reports.asOf')}</span>
            <input
              id="rp-as-of"
              className="field"
              type="date"
              value={asOf.value}
              onChange={(event) => setParam('asOf', event.target.value === '' ? null : event.target.value)}
            />
          </label>
        ) : (
          <>
            <label className="rp-field" htmlFor="rp-from">
              <span>{t('reports.period.from')}</span>
              <input
                id="rp-from"
                className="field"
                type="date"
                value={from.value}
                max={to.value}
                onChange={(event) => setParam('from', event.target.value === '' ? null : event.target.value)}
              />
            </label>
            <label className="rp-field" htmlFor="rp-to">
              <span>{t('reports.period.to')}</span>
              {/* Prevented at the control: the end date cannot precede the start date (R15). */}
              <input
                id="rp-to"
                className="field"
                type="date"
                value={to.value}
                min={from.value}
                onChange={(event) => setParam('to', event.target.value === '' ? null : event.target.value)}
              />
            </label>
          </>
        )}

        {tab !== 'ledger' && (
          <label className="rp-field" htmlFor="rp-compare">
            <span>{t('reports.compare.label')}</span>
            <Select
              id="rp-compare"
              value={preset}
              onChange={(val) => setParam('compare', val === 'none' ? null : val)}
              options={COMPARE_PRESETS.map((value) => ({ value, label: t(COMPARE_LABEL[value]) }))}
              ariaLabel={t('reports.compare.label')}
            />
          </label>
        )}

        {tab === 'ledger' && (
          <div className="rp-field">
            <span id="rp-account-label">{t('reports.account')}</span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              aria-expanded={pickerOpen}
              aria-labelledby="rp-account-label"
              onClick={() => setParam('picker', pickerOpen ? null : '1')}
            >
              {chosen === null ? t('reports.picker.pick') : `${chosen.number} ${chosen.name}`}
            </button>
          </div>
        )}
      </div>

      {(from.invalid || to.invalid || asOf.invalid) && <p className="rp-field-error">{t('reports.error.invalidDate')}</p>}
      {periodInverted && <p className="rp-field-error">{t('reports.error.invalidPeriod')}</p>}
      {accountMissing && <p className="rp-field-error">{t('reports.error.accountNotFound')}</p>}

      {pickerOpen && (
        <AccountPicker
          accounts={accounts}
          loading={accountsLoading}
          failed={accountsFailed}
          selectedId={accountParam}
          onPick={(accountId) => {
            const next = new URLSearchParams(params);
            next.set('account', accountId);
            next.delete('picker');
            setParams(next, { replace: false });
          }}
          onRetry={() => {
            void loadAccounts();
          }}
        />
      )}

      {/* K-35: a failed READ, so the read title and never "check your input", and the engine's code
          rides along so a defect-shaped failure can be reported from the banner. */}
      {failed && (
        <ErrorBanner
          error={failure ?? undefined}
          message={t('reports.error.transport')}
          onRetry={() => void load()}
          context="read"
        />
      )}

      {needsChart ? (
        <div className="state-panel panel">
          <h2 className="state-title">{t('reports.tab.balanceSheet')}</h2>
          <p className="state-body">{t('reports.error.needsChart')}</p>
          <Link className="btn btn--secondary" to="/accounts">
            {t('reports.error.needsChartAction')}
          </Link>
        </div>
      ) : loading ? (
        <div className="rp-pending">
          {/* Shaped by the active tab: table rows for the two working papers, taller section blocks
              for the two statutory statements. No figure renders here, not even a zero. */}
          <Skeleton rows={tab === 'balance' || tab === 'income' ? 8 : 6} labelKey="reports.loading" />
        </div>
      ) : failed || periodInverted ? null : loaded === null ? (
        tab === 'ledger' && !accountMissing ? (
          <p className="rp-note">{t('reports.empty.noAccountPicked')}</p>
        ) : null
      ) : loaded.tab === 'trial' ? (
        <TrialBalance
          view={loaded.view}
          locale={locale === 'de-CH' ? 'de' : 'en'}
          onDrill={(accountId) => drillTo(accountId, { from: from.value, to: to.value })}
        />
      ) : loaded.tab === 'balance' ? (
        <BalanceSheet
          view={loaded.view}
          locale={locale === 'de-CH' ? 'de' : 'en'}
          onDrill={(accountId) => drillTo(accountId, bilanzDrillWindow())}
        />
      ) : loaded.tab === 'income' ? (
        <IncomeStatement
          view={loaded.view}
          locale={locale === 'de-CH' ? 'de' : 'en'}
          onDrill={(accountId) => drillTo(accountId, { from: from.value, to: to.value })}
        />
      ) : (
        <GeneralLedger view={loaded.view} onOpenEntry={(entryId) => setParam('entry', entryId)} />
      )}
      </div>
      </Tabs>

      {entryParam !== null && (
        <EntryDrawer
          mode="view"
          entryId={entryParam}
          /*
           * A24's answer, exactly as `Journal.tsx` reads it and for the same recorded reason: no
           * shipped payload carries a `canPost` field, and reading an absent one as `!== false` was
           * the phantom-permission defect that left three affordances permanently enabled. A08 adds
           * no permission signal of its own, so the answer comes from `whoami` through the same hook
           * the Journal uses, rather than from anything on this screen.
           */
          canPost={canPost}
          onClose={() => setParam('entry', null)}
          onWritten={() => {
            // A Reverse from inside the drawer posts a reversing entry that belongs on this
            // account's line list, so the Kontoblatt refetches.
            void load();
          }}
        />
      )}
    </section>
  );
}

/** The base currency of whichever statement is loaded. Stated once, never per figure (R36). */
function currencyOf(loaded: Loaded | null): string {
  return loaded === null ? '' : loaded.view.baseCurrency;
}
