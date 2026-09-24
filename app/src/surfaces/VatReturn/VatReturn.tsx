/**
 * A07, MWST-Abrechnung (`/mwst`): the VAT return for one filing period.
 *
 * THE CEILING ON THIS WHOLE CAPABILITY, stated first because everything below is shaped by it.
 * There is no ESTV submission API and there never has been. eCH-0217 v2.0.0 is a file FORMAT for
 * upload, not a transport, and the ESTV instructs the filer to export from their accounting software
 * and upload the file themselves. So the journey leaves the product at step 4 of 5 and comes back,
 * and no control anywhere on this surface, in any state or either language, says "An ESTV senden".
 *
 * THE PRIMARY ACTION IS THE EXPORT, AND THE SLOT THAT WAS HELD OPEN FOR IT IS NOW FILLED. Owner
 * decision W3 settles the emphasis: the export takes `.btn--primary` and "Als eingereicht markieren"
 * stays `.btn--secondary` behind a confirm, matching the law `Periods.tsx` already set (the
 * reversible `closeMonth` is primary, the irreversible `closeYear` is secondary plus a confirm).
 *
 * This surface shipped deliberately WITHOUT that button, and said so on step 3 of the journey,
 * because `vat_export_ech0217` did not exist: a disabled button in the accent slot advertises a
 * capability by shape while withholding it, and the operator cannot tell "not yet built" from "not
 * allowed here". The verb landed (eCH-0217 v2.0.0, validated against the vendored XSD), so the
 * apology on step 3 became false copy the same hour and is replaced by what the button does. The
 * surface's own suite asserted the verb's ABSENCE so it would fail on exactly this day; that test is
 * now an assertion of the new truth rather than a deletion.
 *
 * FIVE REFUSALS, ONE OF WHICH THE DESIGN NEVER NAMED. `computeVatReturn` refuses an IST workspace
 * outright (`unsupported` / `ist_timing_not_implemented`) rather than handing an Ist filer the Soll
 * figures, which would be a wrong return that looks right. Every refusal replaces the table, because
 * the engine returns the refusal INSTEAD of a payload: there are no figures to leave on screen.
 *
 * AND THEY ARRIVE ON EITHER OF TWO READS, which is the correction that made `needsConfig` visible.
 * `listVatPeriods` shares the `needs_vat_config` gate with `computeVatReturn` and is called first,
 * so on an unconfigured workspace the return read never happens: the surface has to be able to name
 * a refusal that came back on the PERIOD list, or the state a new operator lands in has no words.
 * Measured against the built engine on 2026-07-29: a workspace that never configured MWST answers
 * `needs_vat_config` on `vat_periods` and on `vat_return` alike, and a workspace put into `saldo`
 * with no Saldosteuersatz (which `set_vat_method` permits and `vat_configure` refuses) answers
 * `vat_periods` with 2026-H1/H2 and then refuses the return with the same code.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate, formatMoney } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { useCan, CAP } from '../../lib/capabilities';
import { EntryDrawer } from '../Journal/EntryDrawer';
import { Abstimmung } from './Abstimmung';
import { FormLineTable, type DrillEntry, type DrillState } from './FormLineTable';
import { JourneyStrip } from './JourneyStrip';
import { useChecklistRun } from './useChecklistRun';
import { MarkFiledDialog } from './MarkFiledDialog';
import { PeriodPicker } from './PeriodPicker';
import { RefusalPanel } from './Refusal';
import { Settlement, type SettlementState } from './Settlement';
import { useVatExport, VatExportButton, VatExportOutcome } from './VatExport';
import { LockGlyph } from './glyphs';
import {
  bridgeOf,
  parseVatPeriods,
  parseVatReturn,
  periodTitle,
  refusalOf,
  renderForm,
  statusOf,
  todayIso,
  type Refusal,
  type VatPeriod,
  type VatReturnView,
} from './model';
import './VatReturn.css';

/** The drill-down cap. Twenty rows is a scan; a thousand is a second screen wearing a disclosure. */
const DRILL_CAP = 20;

export function VatReturn() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  /**
   * THE PADLOCK (A24, F5 retrofit). The ONE write here, `vat_mark_filed`, is the statutory
   * statement gated on `vat_file` (owner and Treuhänder by default), so its affordance is absent
   * without it. Computing and exporting the return stay: they are reads.
   */
  const canFile = useCan(CAP.vatFile);

  const [periods, setPeriods] = useState<VatPeriod[]>([]);
  const [periodsLoading, setPeriodsLoading] = useState(true);
  const [periodsFailed, setPeriodsFailed] = useState(false);
  /**
   * THE PERIOD LIST CAN BE REFUSED FOR A REASON THE SURFACE CAN NAME, and it used to throw that
   * reason away.
   *
   * `listVatPeriods` refuses an unconfigured workspace with the SAME `needs_vat_config` code
   * `computeVatReturn` uses, and it refuses FIRST: with no period selected, `loadReturn` returns at
   * its `period === null` guard and never calls `vat_return` at all. So flattening this read's
   * rejection into `periodsFailed` left the commonest first-run state on the surface with a title, a
   * journey strip and no explanation, while the one sentence that existed sat inside a menu the
   * operator had to open. Carrying the code through is what lets `RefusalPanel` say it out loud and
   * hand over the route to /vat.
   */
  const [periodsRefusal, setPeriodsRefusal] = useState<Refusal | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [view, setView] = useState<VatReturnView | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [currency, setCurrency] = useState('CHF');

  const [expanded, setExpanded] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrillState | null>(null);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  const [confirming, setConfirming] = useState(false);
  const [filingPending, setFilingPending] = useState(false);
  const [filingFailed, setFilingFailed] = useState(false);
  // A38 (D129 leg 2): the settlement panel's posted state, lifted so the strip's sixth step and the
  // panel read one fact. Null until the panel has answered (or when its read refused).
  const [settlementState, setSettlementState] = useState<SettlementState | null>(null);
  const canPost = useCan(CAP.post);

  const year = (selected ?? todayIso()).slice(0, 4);

  // --- the period list -------------------------------------------------------------------------
  const loadPeriods = useCallback(async () => {
    if (workspaceId === null) {
      setPeriodsLoading(false);
      return;
    }
    setPeriodsLoading(true);
    setPeriodsFailed(false);
    setPeriodsRefusal(null);
    const { body, status } = await client.call('vat_periods', { workspaceId, year });
    if (isErr(body)) {
      // BOTH, and they are not redundant. `periodsFailed` stays true so the picker keeps its own
      // scoped error row: without it the menu would fall through to "no periods defined", which is
      // a different and untrue statement. The refusal is the surface-level answer, and it is the one
      // that carries the way out.
      setPeriodsFailed(true);
      setPeriodsRefusal(refusalOf(body, status));
      setPeriodsLoading(false);
      return;
    }
    const parsed = parseVatPeriods(body);
    if (parsed === null) {
      setPeriodsFailed(true);
      setPeriodsLoading(false);
      return;
    }
    setPeriods(parsed.periods);
    // Land on the most recent period that has ENDED, which is the one a filer opens this screen to
    // file. Falling back to the first is what a workspace mid-January gets, and it is right there
    // too: nothing has ended yet.
    setSelected((current) => {
      if (current !== null) return current;
      const today = todayIso();
      const ended = parsed.periods.filter((p) => p.periodEnd < today);
      const pick = ended.length > 0 ? ended[ended.length - 1] : parsed.periods[0];
      return pick?.label ?? null;
    });
    setPeriodsLoading(false);
  }, [client, workspaceId, year]);

  useEffect(() => {
    void loadPeriods();
  }, [loadPeriods]);

  // The base currency is a workspace fact, read rather than assumed: a hardcoded CHF would print
  // the wrong unit on the one screen whose figures go to a tax authority.
  useEffect(() => {
    if (workspaceId === null) return;
    void client.call('get_company_profile', { workspaceId }).then(({ body }) => {
      if (isErr(body)) return;
      const base = (body as { baseCurrency?: unknown }).baseCurrency;
      if (typeof base === 'string' && base.length > 0) setCurrency(base);
    });
  }, [client, workspaceId]);

  // --- the return ------------------------------------------------------------------------------
  const period = useMemo(() => periods.find((p) => p.label === selected) ?? null, [periods, selected]);

  const loadReturn = useCallback(async () => {
    if (workspaceId === null || period === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setRefusal(null);
    const { body, status } = await client.call('vat_return', {
      workspaceId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    });
    if (isErr(body)) {
      const known = refusalOf(body, status);
      if (known === null) setFailed(true);
      setRefusal(known);
      setView(null);
      setLoading(false);
      return;
    }
    const parsed = parseVatReturn(body);
    if (parsed === null) setFailed(true);
    setView(parsed);
    setLoading(false);
  }, [client, workspaceId, period]);

  useEffect(() => {
    void loadReturn();
  }, [loadReturn]);

  // --- S3, the drill-down ----------------------------------------------------------------------
  const toggleZiffer = useCallback(
    async (code: string) => {
      if (expanded === code) {
        setExpanded(null);
        setDrill(null);
        return;
      }
      setExpanded(code);
      const line = view?.lines.find((l) => l.code === code);
      const ids = (line?.entryIds ?? []).slice(0, DRILL_CAP);
      setDrill({ loading: true, failed: false, entries: [], total: line?.entryIds.length ?? 0 });
      if (workspaceId === null || ids.length === 0) {
        setDrill({ loading: false, failed: false, entries: [], total: 0 });
        return;
      }
      const responses = await Promise.all(
        ids.map((entryId) => client.call('get_entry', { workspaceId, entryId })),
      );
      const entries: DrillEntry[] = [];
      let anyFailed = false;
      for (const { body } of responses) {
        if (isErr(body)) {
          anyFailed = true;
          continue;
        }
        const entry = (body as { entry?: Record<string, unknown> }).entry;
        if (entry === undefined) continue;
        entries.push({
          id: String(entry.id ?? ''),
          date: String(entry.date ?? ''),
          ref: typeof entry.ref === 'string' ? entry.ref : null,
          description: typeof entry.description === 'string' ? entry.description : null,
        });
      }
      setDrill({
        loading: false,
        failed: anyFailed && entries.length === 0,
        entries,
        total: line?.entryIds.length ?? entries.length,
      });
    },
    [client, expanded, view, workspaceId],
  );

  // --- filing ----------------------------------------------------------------------------------
  const confirmFiling = useCallback(async () => {
    if (workspaceId === null || selected === null) return;
    setFilingPending(true);
    setFilingFailed(false);
    const { body } = await client.call('vat_mark_filed', {
      workspaceId,
      period: selected,
      // Derived from the period, so a replay from a second window is the same key and the engine
      // collapses it to the existing lock rather than minting a second one.
      idempotencyKey: `vat_filed:${workspaceId}:${selected}`,
    });
    setFilingPending(false);
    if (isErr(body)) {
      setFilingFailed(true);
      return;
    }
    setConfirming(false);
    await loadPeriods();
    await loadReturn();
  }, [client, loadPeriods, loadReturn, selected, workspaceId]);

  // --- S7, the export ---------------------------------------------------------------------------
  // Called unconditionally, with the empty string standing in until a workspace and a period exist:
  // the BUTTON is what is conditional, and it renders only once the return has computed.
  // G22 (D127): the checklist run behind this period, for the strip's "exportiert am" / "bestätigt am"
  // and for completing the export item after a successful export.
  const canManageChecklists = useCan(CAP.manageChecklists);
  const checklist = useChecklistRun(workspaceId, period?.periodStart ?? null, canManageChecklists);
  const exportState = useVatExport({
    workspaceId: workspaceId ?? '',
    periodStart: period?.periodStart ?? '',
    periodEnd: period?.periodEnd ?? '',
    onExported: checklist.completeExport,
  });

  if (workspaceId === null) return <NoWorkspaceState />;

  const bridge = view === null ? null : bridgeOf(view);
  const status = period === null ? null : statusOf(period, todayIso());
  const filed = status === 'filed';
  const sections = view === null ? [] : renderForm(view);

  // Only ever ONE of these is set. The two reads are sequential and the second cannot start until
  // the first named a period, so the return's own refusal is preferred purely for reading order.
  const shownRefusal = refusal ?? periodsRefusal;

  return (
    <section className="vr">
      <SurfaceHeader
        title={t('vat.return.title')}
        subtitle={
          view === null || period === null
            ? t('vat.return.subtitlePending')
            : t('vat.return.subtitle', {
                method: t(`vat.return.method.${view.method}`),
                timing: t(`vat.return.timing.${view.timing}`),
                from: formatDate(period.periodStart),
                to: formatDate(period.periodEnd),
              })
        }
        help={<SurfaceHelp surface="VatReturn" />}
        actions={
          <>
            <PeriodPicker
              periods={periods}
              loading={periodsLoading}
              failed={periodsFailed}
              selected={selected}
              onSelect={(label) => {
                setSelected(label);
                setExpanded(null);
                setDrill(null);
              }}
              onRetry={() => void loadPeriods()}
            />
            {/* `.btn--secondary` and NOT `.btn--primary`, per owner decision W3: this applies an
                irreversible A03 hard lock, and the solid accent fill belongs to the export beside it. */}
            {!filed && view !== null && canFile && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={status === 'open'}
                onClick={() => setConfirming(true)}
              >
                {t('vat.return.markFiled')}
              </button>
            )}
            {/* LAST in the row and the one solid `.btn--primary` here (W3). It renders only once the
                return has computed, because a file can only be built from figures that exist, and it
                stays available on a FILED period: the lock does not stop you fetching the file again. */}
            {view !== null && period !== null && (
              <VatExportButton working={exportState.working} onRun={() => void exportState.run()} />
            )}
          </>
        }
      />

      {/* The active period, stated large at the top of the body. The picker in the header still
          switches it; this is the prominence, not a second control. It reads the SAME period the
          picker selected and carries no figures of its own: only the label, the range and the status
          word (with the lock glyph on a filed period), all already on screen elsewhere in smaller
          type. Presentation only. */}
      {period !== null && (
        <div className="vr-period">
          <p className="vr-period-eyebrow">{t('vat.return.activePeriodLabel')}</p>
          <p className="vr-period-title">{periodTitle(period.label)}</p>
          <p className="vr-period-meta">
            <span className="vr-period-range">
              {formatDate(period.periodStart)} {t('vat.return.rangeTo')} {formatDate(period.periodEnd)}
            </span>
            {status !== null && (
              <span className="vr-period-status">
                {status === 'filed' && <LockGlyph size={14} />}
                {t(`vat.return.period.${status}`)}
              </span>
            )}
          </p>
        </div>
      )}

      {/* The outcome renders in the body rather than under the toolbar: a refusal that names an ESTV
          Ziffer and a next step needs the full measure to be read, not a right-aligned column. */}
      <VatExportOutcome
        refusal={exportState.refusal}
        crossCheck={exportState.crossCheck}
        currency={currency}
        onReload={() => void loadReturn()}
        onInvestigate={(code) => void toggleZiffer(code)}
        onRetry={() => void exportState.run()}
      />

      {status === 'open' && !filed && <p className="lock-note">{t('vat.return.periodNotEnded')}</p>}

      {filed && period !== null && (
        <div className="vr-filed panel" role="note">
          <LockGlyph className="vr-filed-glyph" />
          <div>
            <p className="vr-filed-title">{t('vat.return.filedBanner', { period: periodTitle(period.label) })}</p>
            {/* A07 persists no return: the figures below are recomputed. Saying so is not filler,
                it is the honest disclosure of a real property of the read model. */}
            <p className="vr-filed-body">{t('vat.return.filedRecomputed')}</p>
            <p className="vr-filed-body">{t('vat.return.filedCorrection')}</p>
          </div>
        </div>
      )}

      <JourneyStrip
        computed={view !== null}
        checked={bridge !== null && (bridge.kind === 'match' || bridge.kind === 'notApplicable')}
        marked={filed}
        run={checklist.run}
        settlement={settlementState}
      />
      <p className="vr-journey-note">{t('vat.return.exportNote')}</p>

      {failed && <ErrorBanner onRetry={() => void loadReturn()} />}

      {/* The skeleton covers BOTH reads. `vat_return` cannot start until `vat_periods` has said
          which period exists, so a surface that only tracked the second read would show a bare page
          for the whole first one. */}
      {(loading || periodsLoading) && (
        <div className="vr-form">
          <Skeleton rows={8} height={32} />
          <Skeleton rows={5} height={32} />
        </div>
      )}

      {!loading && !periodsLoading && shownRefusal !== null && <RefusalPanel refusal={shownRefusal} />}

      {!loading && !periodsLoading && shownRefusal === null && view !== null && (
        <>
          <div className="vr-payable panel">
            <p className="vr-payable-label">
              {view.creditMinor > 0 ? t('vat.return.credit') : t('vat.return.payable')}
            </p>
            <p className="vr-payable-figure t-money">
              {formatMoney(view.creditMinor > 0 ? view.creditMinor : view.payableMinor, currency)}
            </p>
          </div>

          {bridge !== null && (
            <Abstimmung
              bridge={bridge}
              currency={currency}
              onInvestigate={() => void toggleZiffer(firstDrillable(view))}
            />
          )}

          {view.empty && (
            <EmptyState title={t('vat.return.empty')} hint={t('vat.return.emptyHint')} action={{ label: t('vat.return.emptyCta'), to: '/journal' }} />
          )}

          <FormLineTable
            sections={sections}
            currency={currency}
            expanded={expanded}
            drill={drill}
            onToggle={(code) => void toggleZiffer(code)}
            onOpenEntry={(entryId) => setOpenEntryId(entryId)}
            saldo={view.method === 'saldo'}
          />

          {/* A38 §6 (D129 leg 2): the MWST-Saldierung under the period. The same verb the year_close
              checklist's vat_settled row calls; its face outside any run. Keyed on the period so a
              period change remounts the panel with a fresh read. */}
          {period !== null && (
            <Settlement
              key={period.label}
              workspaceId={workspaceId}
              period={period.label}
              filed={filed}
              currency={currency}
              canPost={canPost}
              onOpenEntry={(entryId) => setOpenEntryId(entryId)}
              onState={setSettlementState}
            />
          )}
        </>
      )}

      {confirming && view !== null && period !== null && (
        <MarkFiledDialog
          period={period.label}
          periodStart={period.periodStart}
          periodEnd={period.periodEnd}
          payableMinor={view.payableMinor}
          creditMinor={view.creditMinor}
          currency={currency}
          unexplainedMinor={bridge === null ? 0 : bridge.unexplainedMinor}
          pending={filingPending}
          failed={filingFailed}
          onConfirm={() => void confirmFiling()}
          onCancel={() => setConfirming(false)}
        />
      )}

      {openEntryId !== null && (
        <EntryDrawer
          mode="view"
          entryId={openEntryId}
          canPost={false}
          onClose={() => setOpenEntryId(null)}
          onWritten={() => setOpenEntryId(null)}
        />
      )}
    </section>
  );
}

/**
 * The Ziffer the "check the VAT account entries" control opens.
 *
 * The bridge's difference lives on the OUTPUT side, so the first output Ziffer carrying entries is
 * where the operator's investigation starts. It is not a filtered list of exactly the unattributed
 * movements: the engine attributes nothing, so no such list exists to build. Sending the operator to
 * the entries behind the figure the check compared is the honest approximation, and the copy asks
 * them to check the VAT-account entries rather than promising a pre-filtered answer.
 */
function firstDrillable(view: VatReturnView): string {
  const output = view.lines.find((l) => l.taxMinor !== 0 && l.entryIds.length > 0);
  return output?.code ?? view.lines[0]?.code ?? '';
}

export default VatReturn;
