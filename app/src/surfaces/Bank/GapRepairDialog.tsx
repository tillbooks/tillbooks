/**
 * A36 §4.7 (D150), "Lücke schliessen": the guided hand repair of a statement gap.
 *
 * The owner kept §4.6 (no ranged EBICS download): a gap is filled by hand, from eBanking. This dialog
 * says exactly which days to fetch, how (for ZKB the eBanking path "Konto & Zahlungen", "Datentransfer",
 * "Datei abholen", camt.053, the account, "Alle erneut abholen" with the range; for any other bank the
 * same in neutral words), and warns, in plain words, never to choose "Alle nicht abgeholten Daten": that
 * marks the days as fetched and can take them away from the automatic fetch.
 *
 * The files go to `import_camt_files` (several at once, dropped in any order: the engine sorts them and
 * imports them through the one statement door). Each statement's outcome is listed in a live region:
 * imported, already there, or refused with the reason and the amount. When the gap is gone the dialog
 * closes and says so; while part of it is still open it names what is left. A chained gap may also be
 * confirmed as holding nothing (`confirm_statement_gap`, a person's act; D204: no reason needed).
 *
 * Built on the existing `Modal` and `FileDrop` (no new primitive). Opened from the attention item, the
 * Übersicht band and the channel panel, all through `/bank-accounts?repair=<account>&gap=<gap>`.
 *
 * ANY EXPORT (A20 §13.2, D205): the one drop zone reads the CONTENT of a file, never its name. XML goes to
 * `import_camt_files` as above; a bank's CSV or Excel export opens the mapping step shared with the import
 * dialog (`CsvMappingStep`), the engine's plan for each gap's missing days (`bank_csv_preview` with `fill`),
 * and then `import_bank_statement` with `fill { from, to }` set to exactly that gap's missing days, ONE call
 * per gap (for `gap=all` too: between daily statements a single span would turn every unheld weekend into a
 * statement of its own). Never `fill {}` here: the days before the feed are not what the person asked for.
 *
 * ALL GAPS AT ONCE (owner, 18.10.2026: "if we want to close holes, one button must be sufficient"):
 * `gap=all` opens the dialog for every gap of the account. The file drop already takes any number of
 * statements in any order; the confirmation, offered only when every gap chains, confirms each gap with
 * the one reason (`confirm_statement_gap` per gap, each still a person's act with its own rules).
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCan } from '../../lib/capabilities';
import { useT } from '../../i18n';
import { Modal } from '../../components/Modal';
import { FileDrop } from '../../components/FileDrop';
import { refusalText } from '../../components/states';
import { announceAttentionChanged } from '../Attention/attentionSummary';
import { outcomeText, parseFileOutcomes, type FileOutcome } from './importOutcomes';
import { gapFetchDatesText, gapExplanation, gapRangeText, gapTitle, parseStatementGaps, type StatementGapDto } from './statementGaps';
import { CsvMappingStep, bytesToBase64, fileBytesOf, sniffBytes, useCsvPreview, useMappingBlocking, type TabularFile } from './CsvMappingStep';
import { ProofMark, problemSentence, readFillView, stretchName, type CsvFillPartView } from './CsvFillStep';
import { formatDate } from '../../i18n';
import { optionalReason, useAskReason } from '../../lib/useAskReason';

export interface GapRepairDialogProps {
  workspaceId: string;
  bankAccountId: string;
  gapId: string;
  onClose: () => void;
  /** The gap is gone (filled or confirmed): the sentence to announce on the page that opened it. */
  onResolved: (message: string) => void;
}

interface Context {
  gap: StatementGapDto | null;
  gaps: StatementGapDto[];
  accountName: string;
  currency: string;
  bankName: string | null;
  fed: boolean;
}

type Load = { status: 'loading' } | { status: 'error' } | { status: 'ok'; ctx: Context };

function newKey(): string {
  return crypto.randomUUID();
}

/** Read the gap, its account and its bank off the `bank_inbox` tile (the engine's own read model). */
function contextOf(body: unknown, bankAccountId: string, gapId: string): Context | null {
  const tile = (body as { tile?: Record<string, unknown> } | null)?.tile;
  if (tile === undefined || tile === null || tile.ok !== true) return null;
  const gaps = parseStatementGaps(tile.statementGaps).filter((g) => g.bankAccountId === bankAccountId);
  const accounts = Array.isArray(tile.accounts) ? (tile.accounts as { bankAccountId: string; name: string; currency: string }[]) : [];
  const account = accounts.find((a) => a.bankAccountId === bankAccountId);
  const channels = Array.isArray(tile.channels) ? (tile.channels as { bankName?: string | null; statementGaps?: unknown }[]) : [];
  const channel = channels.find((c) => parseStatementGaps(c.statementGaps).some((g) => g.bankAccountId === bankAccountId)) ?? null;
  return {
    gap: gapId === ALL ? (gaps[0] ?? null) : (gaps.find((g) => g.gapId === gapId) ?? null),
    gaps,
    accountName: account?.name ?? '',
    currency: account?.currency ?? 'CHF',
    bankName: channel?.bankName ?? null,
    fed: channel !== null,
  };
}

/** The `gap` value that opens the dialog for every gap of the account. */
export const ALL = 'all';

/** One span from the first gap's earlier statement to the last gap's later one, for `gap=all`. */
function spanOf(gaps: StatementGapDto[]): StatementGapDto | null {
  if (gaps.length === 0) return null;
  const pos = (e: { year: number; number: number }) => e.year * 1_000_000 + e.number;
  const sorted = [...gaps].sort((a, b) => pos(a.after) - pos(b.after));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return { ...first, before: last.before, missing: sorted.flatMap((g) => g.missing), missingDates: { from: first.missingDates.from, to: last.missingDates.to } };
}

/** A20 §13.2: the days one gap's fill takes (its missing days), or null when the engine names none. */
function fillOf(gap: StatementGapDto): { from: string; to: string } | null {
  const { from, to } = gap.missingDates;
  return from !== null && to !== null && from <= to ? { from, to } : null;
}

/** What the plan says of one stretch, in one sentence. */
function planSentence(t: ReturnType<typeof useT>, p: CsvFillPartView, currency: string): string {
  if (p.status === 'ready') return t(p.closesTarget ? 'bankInbox.import.fill.closes' : 'bankInbox.import.fill.stays');
  if (p.status === 'already_imported') return t('bankInbox.import.fill.already');
  return problemSentence(t, p, currency) ?? t('gapRepair.export.notReady');
}

/** The gaps still open inside the original one's span (a partial fill splits it). */
function remainingWithin(original: StatementGapDto, gaps: StatementGapDto[]): StatementGapDto[] {
  const pos = (e: { year: number; number: number }) => e.year * 1_000_000 + e.number;
  return gaps.filter((g) => pos(g.after) >= pos(original.after) && pos(g.before) <= pos(original.before));
}

export function GapRepairDialog({ workspaceId, bankAccountId, gapId, onClose, onResolved }: GapRepairDialogProps) {
  const t = useT();
  const client = useClient();
  const canPay = useCan(CAP.pay);
  const baseId = useId();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<FileOutcome[]>([]);
  const [error, setError] = useState<Err | null>(null);
  const [rejected, setRejected] = useState(false);
  const [status, setStatus] = useState('');
  const [reason, setReason] = useState('');
  // D204: the confirmation needs no reason; the note field shows only when the workspace asks for one.
  const askReason = useAskReason();
  // The gap the dialog was opened for, kept so a partial fill can say what is left of it.
  const [original, setOriginal] = useState<StatementGapDto | null>(null);
  // A20 §13.2: a bank's CSV or Excel export, its mapping, the engine's plan per gap, and what was written.
  const [tab, setTab] = useState<TabularFile | null>(null);
  const [plans, setPlans] = useState<{ gapId: string; parts: CsvFillPartView[] }[] | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [filled, setFilled] = useState<CsvFillPartView[]>([]);
  const [ignored, setIgnored] = useState<{ used: string[]; left: string[] } | null>(null);
  const { preview, previewBusy, mapping, setMapping, setLayout, sheet, setSheet, parsed } = useCsvPreview({ client, workspaceId, accountId: bankAccountId, file: tab, onError: setError });
  const { blocking } = useMappingBlocking(preview, mapping, parsed);

  const read = useCallback(async (): Promise<Context | null> => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await client.call('dashboard_tile', { workspaceId, tile: 'bank_inbox', from: today, to: today });
    if (isErr(res.body)) return null;
    return contextOf(res.body, bankAccountId, gapId);
  }, [client, workspaceId, bankAccountId, gapId]);

  useEffect(() => {
    let live = true;
    void read().then((ctx) => {
      if (!live) return;
      if (ctx === null) setLoad({ status: 'error' });
      else {
        setLoad({ status: 'ok', ctx });
        const opened = gapId === ALL ? spanOf(ctx.gaps) : ctx.gap;
        if (opened !== null) setOriginal(opened);
      }
    });
    return () => {
      live = false;
    };
  }, [read, gapId]);

  /** After a write: re-read, and close when nothing of the original gap is left. */
  const settle = async (doneKey: string) => {
    announceAttentionChanged();
    const ctx = await read();
    if (ctx === null || original === null) return;
    const left = remainingWithin(original, ctx.gaps);
    if (left.length === 0) {
      onResolved(t(doneKey, { range: gapId === ALL ? gapRangeText(original) : gapRangeText(original) }));
      onClose();
      return;
    }
    setLoad({ status: 'ok', ctx: { ...ctx, gap: left[0] ?? null } });
    setStatus(t('gapRepair.stillOpen', { range: left.map((g) => gapRangeText(g)).join(', ') }));
  };

  /** The one drop zone: XML is camt, a zip or a text table is an export (A20 §13.2); the content decides. */
  const takeFiles = async (files: File[]) => {
    if (busy || files.length === 0) return;
    setRejected(false);
    setError(null);
    const sniffed = await Promise.all(files.map(async (f) => ({ f, bytes: await fileBytesOf(f) })));
    const kinds = sniffed.map((x) => ({ ...x, kind: sniffBytes(x.bytes) }));
    const table = kinds.find((x) => x.kind === 'xlsx' || x.kind === 'text');
    const xml = kinds.filter((x) => x.kind === 'xml');
    // Critic round 1, L4: a mixed drop says which files it took and which it left, by name.
    const used = table !== undefined ? [table.f] : xml.map((x) => x.f);
    const left = files.filter((f) => !used.includes(f));
    setIgnored(left.length > 0 && used.length > 0 ? { used: used.map((f) => f.name), left: left.map((f) => f.name) } : null);
    if (table === undefined && xml.length > 0) {
      setTab(null);
      await importFiles(xml.map((x) => x.f));
      return;
    }
    if (table === undefined) {
      setRejected(true);
      return;
    }
    setResults([]);
    setFilled([]);
    setPlans(null);
    setStatus('');
    setTab({ name: table.f.name, format: table.kind === 'xlsx' ? 'xlsx' : 'csv', base64: bytesToBase64(table.bytes) });
  };

  const importFiles = async (files: File[]) => {
    if (busy || files.length === 0) return;
    setBusy(true);
    setError(null);
    setRejected(false);
    setStatus(t('gapRepair.busy'));
    const payload = await Promise.all(files.map(async (f) => ({ name: f.name, xml: await f.text() })));
    const res = await client.call('import_camt_files', { workspaceId, bankAccountId, files: payload, idempotencyKey: newKey() });
    setBusy(false);
    if (isErr(res.body)) {
      setError(res.body);
      setStatus('');
      return;
    }
    const statements = parseFileOutcomes(res.body);
    setResults(statements);
    setStatus(t('gapRepair.done', { imported: statements.filter((s) => s.outcome === 'imported').length, total: statements.length }));
    await settle('gapRepair.closed');
  };

  // A20 §13.2: the engine's plan for each gap's missing days, read again whenever the mapping changes.
  const targetsNow = load.status === 'ok' ? targetsOf(load.ctx) : [];
  const fillTargets = useMemo(() => targetsNow.map((g) => ({ gapId: g.gapId, fill: fillOf(g) })).filter((x): x is { gapId: string; fill: { from: string; to: string } } => x.fill !== null), [JSON.stringify(targetsNow.map((g) => [g.gapId, g.missingDates]))]);
  const mappingKey = JSON.stringify(mapping);
  useEffect(() => {
    if (tab === null || mapping === null || blocking.length > 0 || fillTargets.length === 0) {
      setPlans(null);
      return;
    }
    let live = true;
    setPlanBusy(true);
    void Promise.all(
      fillTargets.map((x) =>
        client.call('bank_csv_preview', { workspaceId, bankAccountId, contentBase64: tab.base64, format: tab.format, ...(sheet !== null ? { sheet } : {}), mapping, fill: x.fill }),
      ),
    ).then((responses) => {
      if (!live) return;
      setPlanBusy(false);
      const failed = responses.find((r) => isErr(r.body));
      if (failed !== undefined) {
        setError(failed.body as Err);
        setPlans(null);
        return;
      }
      setPlans(responses.map((r, i) => ({ gapId: fillTargets[i]?.gapId ?? '', parts: readFillView((r.body as { fill?: unknown }).fill)?.parts ?? [] })));
    });
    return () => {
      live = false;
    };
    // The plan follows the file, the worksheet, the mapping and the gaps; `blocking` from the mapping.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, sheet, mappingKey, blocking.length, fillTargets, client, workspaceId, bankAccountId]);

  /** Write each gap's fill, one call per gap, then re-read the gaps. */
  const fillGaps = async () => {
    if (tab === null || mapping === null || busy || plans === null) return;
    setBusy(true);
    setError(null);
    setStatus(t('gapRepair.export.busy'));
    const written: CsvFillPartView[] = [];
    for (const x of fillTargets) {
      const res = await client.call('import_bank_statement', {
        workspaceId,
        bankAccountId,
        contentBase64: tab.base64,
        fileName: tab.name,
        format: tab.format,
        ...(sheet !== null ? { sheet } : {}),
        mapping,
        saveMapping: true,
        fill: x.fill,
        idempotencyKey: newKey(),
      });
      if (isErr(res.body)) {
        setError(res.body);
        break;
      }
      written.push(...(readFillView((res.body as { fill?: unknown }).fill)?.parts ?? []).filter((p) => p.status !== 'not_in_file'));
    }
    setBusy(false);
    setFilled(written);
    setTab(null);
    setPlans(null);
    setStatus('');
    await settle('gapRepair.export.closed');
  };

  const confirm = async () => {
    const targets = load.status === 'ok' ? targetsOf(load.ctx) : [];
    if (targets.length === 0 || busy) return;
    const note = optionalReason(reason);
    if (targets.some((g) => g.after.statementRowId === null || g.before.statementRowId === null)) return;
    setBusy(true);
    setError(null);
    for (const gap of targets) {
      const res = await client.call('confirm_statement_gap', {
        workspaceId,
        bankAccountId,
        afterStatementId: gap.after.statementRowId,
        beforeStatementId: gap.before.statementRowId,
        ...(note === undefined ? {} : { reason: note }),
        confirmed: true,
        idempotencyKey: newKey(),
      });
      if (isErr(res.body)) {
        setBusy(false);
        setError(res.body);
        await settle('gapRepair.confirmed');
        return;
      }
    }
    setBusy(false);
    await settle('gapRepair.confirmed');
  };

  /** What this dialog repairs: the one gap, or with `gap=all` every gap still open in the original span. */
  function targetsOf(ctx: Context): StatementGapDto[] {
    if (gapId !== ALL) return ctx.gap !== null ? [ctx.gap] : [];
    return original === null ? ctx.gaps : remainingWithin(original, ctx.gaps);
  }

  const title = t(gapId === ALL ? 'gapRepair.titleMany' : 'gapRepair.title');
  const close = t('gapRepair.close');

  if (load.status !== 'ok') {
    return (
      <Modal open onClose={onClose} title={title} closeLabel={close}>
        {load.status === 'loading' ? (
          <p aria-busy="true">{t('gapRepair.loading')}</p>
        ) : (
          <p role="alert">{t('gapRepair.loadError')}</p>
        )}
      </Modal>
    );
  }

  const { gap, accountName, currency, bankName, fed } = load.ctx;
  if (gap === null) {
    return (
      <Modal open onClose={onClose} title={title} closeLabel={close}>
        <p>{t('gapRepair.notFound')}</p>
      </Modal>
    );
  }

  const targets = targetsOf(load.ctx);
  const many = gapId === ALL && targets.length > 1;
  const span = many ? spanOf(targets) : null;
  const shown = span ?? gap;
  const dates = gapFetchDatesText(t, shown);
  const allConfirmable = targets.length > 0 && targets.every((g) => g.confirmable);
  const zkb = bankName === 'ZKB';
  const stepKeys = zkb ? ['zkb.1', 'zkb.2', 'zkb.3', 'zkb.4'] : ['other.1', 'other.2', 'other.3'];
  const params = { account: accountName, dates, bank: bankName ?? '' };
  const descId = `${baseId}-desc`;

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      closeLabel={close}
      describedById={descId}
      footer={
        <button type="button" className="btn btn--ghost" onClick={onClose}>
          {close}
        </button>
      }
    >
      <div className="gap-repair">
        <p className="gap-repair__what" id={descId}>
          <strong>{`${accountName}: ${many ? t('gapRepair.titleAll', { ranges: gapRangeText(shown) }) : gapTitle(t, gap)}`}</strong>
        </p>
        <p className="gap-repair__why">{many && targets.every((g) => g.chains) ? t('gapRepair.whyAllChain') : gapExplanation(t, many ? (targets.find((g) => !g.chains) ?? gap) : gap)}</p>
        <p className="gap-repair__lead">{zkb ? t('gapRepair.leadZkb', params) : t('gapRepair.leadOther', params)}</p>
        <ol className="gap-repair__steps">
          {stepKeys.map((k) => (
            <li key={k}>{t(`gapRepair.steps.${k}`, params)}</li>
          ))}
        </ol>
        {(zkb || fed) && (
          <p className="gap-repair__warn" role="note">
            {t(zkb ? 'gapRepair.warnZkb' : 'gapRepair.warnOther', params)}
          </p>
        )}
        {canPay ? (
          <FileDrop
            multiple
            label={t('gapRepair.choose')}
            prompt={t('gapRepair.drop')}
            hint={tab !== null ? tab.name : t('gapRepair.hint')}
            disabled={busy}
            onFiles={(files) => void takeFiles(files)}
            onReject={() => setRejected(true)}
          />
        ) : (
          <p className="gap-repair__denied">{t('gapRepair.denied')}</p>
        )}
        {rejected && <p className="gap-repair__warn">{t('gapRepair.notXml')}</p>}
        {ignored !== null && (
          <p className="gap-repair__warn" role="alert">
            {t('gapRepair.mixed', { used: ignored.used.join(', '), left: ignored.left.join(', ') })}
          </p>
        )}
        {tab !== null && canPay && (
          <section className="bank-field gap-repair__export" aria-labelledby={`${baseId}-export`} aria-busy={previewBusy || planBusy || busy}>
            <h3 className="bank-field__label" id={`${baseId}-export`}>
              {t(`gapRepair.export.title.${tab.format}`)}
            </h3>
            {previewBusy || preview === null || mapping === null ? (
              <p className="bank-mode__lead" role="status">
                {t('bankInbox.import.reading')}
              </p>
            ) : (
              <>
                <CsvMappingStep baseId={baseId} preview={preview} mapping={mapping} onMapping={setMapping} onLayout={setLayout} onSheet={setSheet} parsed={parsed} currency={currency} />
                {blocking.length === 0 && planBusy && (
                  <p className="bank-mode__lead" role="status">
                    {t('bankInbox.import.fill.reading')}
                  </p>
                )}
                {blocking.length === 0 && !planBusy && plans !== null && (
                  <ul className="gap-repair__list">
                    {plans.flatMap((plan) => plan.parts.filter((p) => p.status !== 'not_in_file')).length === 0 && <li className="gap-repair__result">{t('bankInbox.import.fill.none')}</li>}
                    {plans.flatMap((plan) =>
                      plan.parts
                        .filter((p) => p.status !== 'not_in_file')
                        .map((p) => (
                          <li key={`${plan.gapId}-${p.from}`} className={`gap-repair__result is-${p.status === 'ready' ? 'imported' : p.status === 'already_imported' ? 'already_imported' : 'refused'}`}>
                            {`${t('gapRepair.export.days', { from: formatDate(p.from), to: formatDate(p.to) })}: ${planSentence(t, p, currency)}`}
                            {p.proof === 'neighbour_sum' && <ProofMark />}
                          </li>
                        )),
                    )}
                  </ul>
                )}
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={busy || planBusy || blocking.length > 0 || plans === null || !plans.some((plan) => plan.parts.some((p) => p.status === 'ready'))}
                  onClick={() => void fillGaps()}
                >
                  {busy ? t('gapRepair.export.busy') : t('bankInbox.import.fill.commit')}
                </button>
              </>
            )}
          </section>
        )}
        <div className="gap-repair__results" aria-live="polite" role="status">
          {status !== '' && <p className="gap-repair__status">{status}</p>}
          {filled.length > 0 && (
            <ul className="gap-repair__list">
              {filled.map((p) => (
                <li key={`filled-${p.from}-${p.to}`} className={`gap-repair__result is-${p.status === 'refused' ? 'refused' : p.status === 'already_imported' ? 'already_imported' : 'imported'}`}>
                  {p.status === 'refused'
                    ? t('bankInbox.import.fill.result.refused', { range: stretchName(t, p), why: problemSentence(t, p, currency) ?? '' })
                    : p.status === 'already_imported'
                      ? t('bankInbox.import.fill.result.already', { range: stretchName(t, p) })
                      : t(p.closesTarget ? 'bankInbox.import.fill.result.closed' : 'bankInbox.import.fill.result.imported', { range: stretchName(t, p) })}
                </li>
              ))}
            </ul>
          )}
          {results.length > 0 && (
            <ul className="gap-repair__list">
              {results.map((r, i) => (
                <li key={`${r.file}-${r.number ?? 'x'}-${i}`} className={`gap-repair__result is-${r.outcome}`}>
                  {outcomeText(t, r, currency)}
                </li>
              ))}
            </ul>
          )}
        </div>
        {error !== null && (
          <p className="gap-repair__error" role="alert">
            {refusalText(t, error, { own: 'gapRepair.error', fallback: 'gapRepair.error.generic' })}
          </p>
        )}
        {allConfirmable && canPay && (
          <div className="gap-repair__confirm">
            <p className="gap-repair__confirm-lead">{t('gapRepair.confirmLead', { range: gapRangeText(shown) })}</p>
            {askReason && (
              <label className="bank-field" htmlFor={`${baseId}-reason`}>
                <span className="bank-field__label">{t('gapRepair.reason')}</span>
                <input
                  id={`${baseId}-reason`}
                  className="field"
                  type="text"
                  value={reason}
                  placeholder={t('gapRepair.reasonPlaceholder')}
                  disabled={busy}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void confirm()}>
              {t('gapRepair.confirm')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
