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
 * confirmed as holding nothing, with a reason (`confirm_statement_gap`, a person's act).
 *
 * Built on the existing `Modal` and `FileDrop` (no new primitive). Opened from the attention item, the
 * Übersicht band and the channel panel, all through `/bank-accounts?repair=<account>&gap=<gap>`.
 *
 * ALL GAPS AT ONCE (owner, 18.10.2026: "if we want to close holes, one button must be sufficient"):
 * `gap=all` opens the dialog for every gap of the account. The file drop already takes any number of
 * statements in any order; the confirmation, offered only when every gap chains, confirms each gap with
 * the one reason (`confirm_statement_gap` per gap, each still a person's act with its own rules).
 */
import { useCallback, useEffect, useId, useState } from 'react';

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
  // The gap the dialog was opened for, kept so a partial fill can say what is left of it.
  const [original, setOriginal] = useState<StatementGapDto | null>(null);

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

  const confirm = async () => {
    const targets = load.status === 'ok' ? targetsOf(load.ctx) : [];
    if (targets.length === 0 || busy || reason.trim() === '') return;
    if (targets.some((g) => g.after.statementRowId === null || g.before.statementRowId === null)) return;
    setBusy(true);
    setError(null);
    for (const gap of targets) {
      const res = await client.call('confirm_statement_gap', {
        workspaceId,
        bankAccountId,
        afterStatementId: gap.after.statementRowId,
        beforeStatementId: gap.before.statementRowId,
        reason: reason.trim(),
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
            accept=".xml,text/xml,application/xml"
            label={t('gapRepair.choose')}
            prompt={t('gapRepair.drop')}
            hint={t('gapRepair.hint')}
            disabled={busy}
            onFiles={(files) => void importFiles(files)}
            onReject={() => setRejected(true)}
          />
        ) : (
          <p className="gap-repair__denied">{t('gapRepair.denied')}</p>
        )}
        {rejected && <p className="gap-repair__warn">{t('gapRepair.notXml')}</p>}
        <div className="gap-repair__results" aria-live="polite" role="status">
          {status !== '' && <p className="gap-repair__status">{status}</p>}
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
            <button type="button" className="btn btn--secondary" disabled={busy || reason.trim() === ''} onClick={() => void confirm()}>
              {t('gapRepair.confirm')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  );
}
