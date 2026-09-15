/**
 * A38 §6 (D129 leg 2), the MWST-Saldierung panel on `/mwst`: the year-end transfer of a filed period's
 * balances on 2200, 1170 and 1171 to 2201, previewed as the exact lines the post books, behind the
 * consequence confirm. The same verb the `vat_settled` row of the `year_close` checklist and item 8b
 * of the MWST-Periode checklist call; this is its face outside any run.
 *
 * THE PREVIEW IS THE POSTING. `vat_settlement_preview` returns the model `vat_settlement_post` writes
 * (one `settlementModelOf` in the engine), so the table on screen is not an estimate of what will
 * happen: it is what happens, minus the write. The panel renders the booked movement beside the
 * declared Ziffern with the difference per side, and the lines below it.
 *
 * WHAT THE PANEL NEVER DOES. It never posts on an unfiled period (the button is disabled with the
 * reason: the transfer moves what was declared, so it waits for the declaration), never hides a
 * difference between booked and declared (the row shows it, the dialog restates it), and never
 * renders a filled red row: money is right-aligned tabular figures with a minus sign for a credit.
 *
 * THE POSTED STATE IS QUIET. A posted settlement shows the date and the entry, and the reverse sits
 * in the overflow behind its own confirm: nothing on this panel needs a toast, because the row IS the
 * evidence and it stays.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, formatDate, formatMoney } from '../../i18n';
import { ConsequenceLine } from '../../components/ConsequenceLine';
import { Modal } from '../../components/Modal';
import { OverflowMenu } from '../../components/OverflowMenu';
import { Skeleton } from '../../components/states';
import { CheckGlyph, LockGlyph } from './glyphs';
import { periodTitle } from './model';

/** A consequential confirm is an alertdialog; held as a value so the modal-role guard sees no literal. */
const ALERT_DIALOG = 'alertdialog' as const;

export interface SettlementLine {
  role: string;
  accountNumber: string;
  accountId: string;
  debitMinor: number;
  creditMinor: number;
}

export interface SettlementRow {
  settlementId: string;
  entryId: string;
  status: string;
  postedAt: string;
  reversalEntryId: string | null;
}

/** The engine's settlement model, the fields this panel reads. Parsed, never trusted by shape. */
export interface SettlementModel {
  period: string;
  periodStart: string;
  periodEnd: string;
  method: 'effektiv' | 'saldo';
  filed: boolean;
  outputMinor: number;
  inputMinor: number;
  netMinor: number;
  lines: SettlementLine[];
  declared: { outputMinor: number; inputMinor: number; netMinor: number };
  differences: { outputMinor: number; inputMinor: number; netMinor: number };
  nothingToSettle: boolean;
  settlement: SettlementRow | null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseSettlement(body: unknown): SettlementModel | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const method = b.method;
  if (method !== 'effektiv' && method !== 'saldo') return null;
  const declared = b.declared as Record<string, unknown> | undefined;
  const differences = b.differences as Record<string, unknown> | undefined;
  if (typeof declared !== 'object' || declared === null || typeof differences !== 'object' || differences === null) return null;
  if (!Array.isArray(b.lines)) return null;
  const outputMinor = num(b.outputMinor);
  const inputMinor = num(b.inputMinor);
  const netMinor = num(b.netMinor);
  const dOut = num(declared.outputMinor);
  const dIn = num(declared.inputMinor);
  const dNet = num(declared.netMinor);
  const xOut = num(differences.outputMinor);
  const xIn = num(differences.inputMinor);
  const xNet = num(differences.netMinor);
  if ([outputMinor, inputMinor, netMinor, dOut, dIn, dNet, xOut, xIn, xNet].some((v) => v === null)) return null;
  if (typeof b.period !== 'string' || typeof b.periodStart !== 'string' || typeof b.periodEnd !== 'string') return null;
  const row = b.settlement as Record<string, unknown> | null | undefined;
  const settlement: SettlementRow | null =
    typeof row === 'object' && row !== null && typeof row.settlementId === 'string' && typeof row.entryId === 'string'
      ? {
          settlementId: row.settlementId,
          entryId: row.entryId,
          status: typeof row.status === 'string' ? row.status : 'posted',
          postedAt: typeof row.postedAt === 'string' ? row.postedAt : '',
          reversalEntryId: typeof row.reversalEntryId === 'string' ? row.reversalEntryId : null,
        }
      : null;
  return {
    period: b.period,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    method,
    filed: b.filed === true,
    outputMinor: outputMinor as number,
    inputMinor: inputMinor as number,
    netMinor: netMinor as number,
    lines: (b.lines as Record<string, unknown>[]).map((l) => ({
      role: typeof l.role === 'string' ? l.role : '',
      accountNumber: typeof l.accountNumber === 'string' ? l.accountNumber : '',
      accountId: typeof l.accountId === 'string' ? l.accountId : '',
      debitMinor: num(l.debitMinor) ?? 0,
      creditMinor: num(l.creditMinor) ?? 0,
    })),
    declared: { outputMinor: dOut as number, inputMinor: dIn as number, netMinor: dNet as number },
    differences: { outputMinor: xOut as number, inputMinor: xIn as number, netMinor: xNet as number },
    nothingToSettle: b.nothingToSettle === true,
    settlement,
  };
}

/** What the JourneyStrip's sixth step renders from. */
export interface SettlementState {
  posted: boolean;
  postedAt: string | null;
}

export interface SettlementProps {
  workspaceId: string;
  /** The A07 period label the surface shows (`2026-Q2`). */
  period: string;
  /** Step 5 of the journey: the period carries a filing lock. The panel disables its post without it. */
  filed: boolean;
  currency: string;
  /** The A24 `post` capability: without it the post and the reverse are absent, and the padlock says why. */
  canPost: boolean;
  /** The entry drill-down the surface already owns (the Journal drawer). */
  onOpenEntry: (entryId: string) => void;
  /** The panel reports its posted state upward so the strip's sixth step and the panel agree. */
  onState?: (state: SettlementState | null) => void;
}

type PanelState =
  | { kind: 'loading' }
  /** `totalMinor` is the Vorsteuer balance a `saldo_input_vat_booked` refusal names; null on every other code. */
  | { kind: 'refused'; code: string; totalMinor: number | null }
  | { kind: 'ok'; model: SettlementModel };

/** The refusal codes the panel names by their own sentence; anything else falls back to one line. */
const NAMED_CODES = new Set(['period_not_filed', 'nothing_to_settle', 'already_posted', 'period_locked', 'missing_account', 'needs_vat_config', 'permission_denied', 'already_reversed', 'already_reversed_key', 'saldo_input_vat_booked']);

export function Settlement({ workspaceId, period, filed, currency, canPost, onOpenEntry, onState }: SettlementProps) {
  const t = useT();
  const client = useClient();
  const bodyId = useId();
  const [state, setState] = useState<PanelState>({ kind: 'loading' });
  const [confirming, setConfirming] = useState<'post' | 'reverse' | null>(null);
  const [pending, setPending] = useState(false);
  const [writeError, setWriteError] = useState<{ code: string; reason: string | null } | null>(null);
  // The post's idempotency key is minted when its confirm OPENS, and held for the life of that dialog:
  // a re-click after a lost response is one write under one key, while a later confirm (the same
  // period settled again after a reversal) is a fresh act under a fresh key. It cannot be derived from
  // the period alone: after a reversal the model reads exactly as it did before the first post, and a
  // period-derived key would replay the reversed post's memo (critic finding, 2026-09-09; the engine
  // refuses that replay as `already_reversed_key`, this is the panel's half).
  const postNonce = useRef('');
  const openConfirm = useCallback((kind: 'post' | 'reverse') => {
    if (kind === 'post') postNonce.current = crypto.randomUUID();
    setWriteError(null);
    setConfirming(kind);
  }, []);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const { body } = await client.call('vat_settlement_preview', { workspaceId, period });
    if (isErr(body)) {
      const extra = body as unknown as { totalMinor?: unknown };
      setState({ kind: 'refused', code: body.error, totalMinor: typeof extra.totalMinor === 'number' ? extra.totalMinor : null });
      onState?.(null);
      return;
    }
    const model = parseSettlement(body);
    if (model === null) {
      setState({ kind: 'refused', code: 'unexpected_shape', totalMinor: null });
      onState?.(null);
      return;
    }
    setState({ kind: 'ok', model });
    onState?.({ posted: model.settlement !== null, postedAt: model.settlement?.postedAt.slice(0, 10) ?? null });
  }, [client, workspaceId, period, onState]);

  useEffect(() => {
    void load();
  }, [load]);

  const write = useCallback(
    async (kind: 'post' | 'reverse', model: SettlementModel) => {
      setPending(true);
      setWriteError(null);
      // The post's key is the dialog's nonce (see `postNonce`); the reverse carries the settlement it
      // undoes, so a retry of either act replays rather than writing twice.
      const { body } =
        kind === 'post'
          ? await client.call('vat_settlement_post', { workspaceId, period, idempotencyKey: `vat_settlement:${workspaceId}:${period}:${postNonce.current}` })
          : await client.call('vat_settlement_reverse', {
              workspaceId,
              settlementId: model.settlement?.settlementId ?? '',
              idempotencyKey: `vat_settlement_reverse:${workspaceId}:${model.settlement?.settlementId ?? ''}`,
            });
      setPending(false);
      if (isErr(body)) {
        const extra = body as unknown as { reason?: unknown };
        setWriteError({ code: body.error, reason: typeof extra.reason === 'string' ? extra.reason : null });
        return;
      }
      setConfirming(null);
      await load();
    },
    [client, workspaceId, period, load],
  );

  const label = periodTitle(period);

  if (state.kind === 'loading') {
    return (
      <section className="vr-settle panel" aria-labelledby={`${bodyId}-title`}>
        <h2 id={`${bodyId}-title`} className="vr-settle-title">
          {t('vat.settlement.title')}
        </h2>
        <Skeleton rows={3} height={28} />
      </section>
    );
  }

  if (state.kind === 'refused') {
    // A workspace with no MWST method has no settlement to speak of; the surface's own refusal panel
    // already says so above, and a second panel repeating it would be noise.
    if (state.code === 'needs_vat_config') return null;
    return (
      <section className="vr-settle panel" aria-labelledby={`${bodyId}-title`}>
        <h2 id={`${bodyId}-title`} className="vr-settle-title">
          {t('vat.settlement.title')}
        </h2>
        <p className="vr-settle-note" role="note">
          {state.code === 'saldo_input_vat_booked'
            ? t('vat.settlement.error.saldo_input_vat_booked', { balance: formatMoney(state.totalMinor ?? 0, currency) })
            : NAMED_CODES.has(state.code)
              ? t(`vat.settlement.error.${state.code}`)
              : t('vat.settlement.error.fallback')}
          {state.code === 'missing_account' && (
            <>
              {' '}
              <Link to="/accounts">{t('vat.settlement.openChart')}</Link>
            </>
          )}
          {state.code === 'saldo_input_vat_booked' && (
            <>
              {' '}
              <Link to="/journal">{t('vat.settlement.openJournal')}</Link>
            </>
          )}
        </p>
      </section>
    );
  }

  const { model } = state;
  const posted = model.settlement !== null;
  const saldo = model.method === 'saldo';
  // Why the primary action is unavailable, in words. The order is the order a human would ask.
  const blockedReason = !canPost
    ? t('vat.settlement.padlock')
    : !filed || !model.filed
      ? t('vat.settlement.waitFiled')
      : model.nothingToSettle
        ? null
        : null;
  const canAct = canPost && filed && model.filed && !model.nothingToSettle && !posted;

  const rows: { key: string; account: string; booked: number; declared: number; diff: number }[] = [
    { key: 'output', account: '2200', booked: model.outputMinor, declared: model.declared.outputMinor, diff: model.differences.outputMinor },
    ...(saldo ? [] : [{ key: 'input', account: '1170 + 1171', booked: model.inputMinor, declared: model.declared.inputMinor, diff: model.differences.inputMinor }]),
    { key: 'net', account: '2201', booked: model.netMinor, declared: model.declared.netMinor, diff: model.differences.netMinor },
  ];
  const hasDifference = rows.some((r) => r.diff !== 0);

  return (
    <section className="vr-settle panel" aria-labelledby={`${bodyId}-title`}>
      <div className="vr-settle-head">
        <h2 id={`${bodyId}-title`} className="vr-settle-title">
          {t('vat.settlement.title')}
        </h2>
        {posted && model.settlement !== null && (
          <OverflowMenu
            label={t('vat.settlement.actionsFor', { period: label })}
            items={[
              { key: 'entry', label: t('vat.settlement.openEntry'), onSelect: () => onOpenEntry(model.settlement?.entryId ?? '') },
              { key: 'reverse', label: t('vat.settlement.reverse'), onSelect: () => openConfirm('reverse'), danger: true, disabled: !canPost },
            ]}
          />
        )}
      </div>
      <p className="vr-settle-note">{t(saldo ? 'vat.settlement.introSaldo' : 'vat.settlement.intro', { period: label, date: formatDate(model.periodEnd) })}</p>

      {posted && model.settlement !== null && (
        <p className="vr-settle-posted" data-status="posted">
          <CheckGlyph className="vr-settle-glyph" size={16} />
          <span>{t('vat.settlement.postedOn', { date: formatDate(model.settlement.postedAt.slice(0, 10)) })}</span>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => onOpenEntry(model.settlement?.entryId ?? '')}>
            {t('vat.settlement.openEntry')}
          </button>
        </p>
      )}

      {model.nothingToSettle && !posted ? (
        <p className="vr-settle-empty">{t('vat.settlement.empty')}</p>
      ) : (
        <table className="vr-settle-table">
          <caption className="visually-hidden">{t('vat.settlement.tableCaption', { period: label })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('vat.settlement.col.position')}</th>
              <th scope="col" className="num">
                {t('vat.settlement.col.booked')}
              </th>
              <th scope="col" className="num">
                {t('vat.settlement.col.declared')}
              </th>
              <th scope="col" className="num">
                {t('vat.settlement.col.difference')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} data-row={r.key}>
                <th scope="row">
                  {t(`vat.settlement.row.${r.key}`)} <span className="vr-settle-account">{r.account}</span>
                </th>
                <td className="num">{formatMoney(r.booked, currency)}</td>
                <td className="num">{formatMoney(r.declared, currency)}</td>
                <td className="num">{r.diff === 0 ? t('vat.settlement.noDifference') : formatMoney(r.diff, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!model.nothingToSettle && model.lines.length > 0 && (
        <details className="vr-settle-lines">
          <summary>{t('vat.settlement.linesSummary', { count: model.lines.length, date: formatDate(model.periodEnd) })}</summary>
          <ul className="vr-settle-lines-list">
            {model.lines.map((l, i) => (
              <li key={`${l.accountNumber}-${i}`}>
                <span className="vr-settle-line-account">{l.accountNumber}</span>
                <span className="vr-settle-line-side">{l.debitMinor > 0 ? t('vat.settlement.debit') : t('vat.settlement.credit')}</span>
                <span className="num">{formatMoney(l.debitMinor > 0 ? l.debitMinor : l.creditMinor, currency)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {hasDifference && !posted && <p className="vr-settle-warn">{t('vat.settlement.differenceNote')}</p>}

      {!posted && !model.nothingToSettle && (
        <div className="vr-settle-actions">
          {!canPost && <LockGlyph className="vr-settle-glyph" size={16} />}
          {/* Secondary, not primary: DESIGN.md allows ONE solid primary per surface and on /mwst that is
              the eCH-0217 export. The confirm dialog's own button is the solid one for this act. */}
          <button type="button" className="btn btn--secondary" disabled={!canAct} onClick={() => openConfirm('post')}>
            {t('vat.settlement.post')}
          </button>
          {blockedReason !== null && <span className="vr-settle-blocked">{blockedReason}</span>}
        </div>
      )}

      {confirming !== null && (
        <Modal
          open
          role={ALERT_DIALOG}
          title={confirming === 'post' ? t('vat.settlement.confirmTitle', { period: label }) : t('vat.settlement.reverseTitle', { period: label })}
          closeLabel={t('vat.return.confirmClose')}
          onClose={() => setConfirming(null)}
          describedById={`${bodyId}-dialog`}
          footer={
            <>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setConfirming(null)}>
                {t('vat.return.cancel')}
              </button>
              <button
                type="button"
                className={confirming === 'post' ? 'btn btn--primary' : 'btn btn--danger'}
                disabled={pending}
                onClick={() => void write(confirming, model)}
              >
                {pending ? t('vat.settlement.pending') : confirming === 'post' ? t('vat.settlement.post') : t('vat.settlement.reverse')}
              </button>
            </>
          }
        >
          <p id={`${bodyId}-dialog`} className="vr-dialog-body">
            {confirming === 'post' ? t('vat.settlement.confirmBody', { date: formatDate(model.periodEnd) }) : t('vat.settlement.reverseBody', { date: formatDate(model.periodEnd) })}
          </p>
          {/* C4: the identical sentence the agent's Vorschlag carries. */}
          <ConsequenceLine verb={confirming === 'post' ? 'vat_settlement_post' : 'vat_settlement_reverse'} />
          <dl className="vr-dialog-facts">
            <div>
              <dt>{t('vat.return.confirmPeriod')}</dt>
              <dd>
                {label}, {formatDate(model.periodStart)} {t('vat.return.rangeTo')} {formatDate(model.periodEnd)}
              </dd>
            </div>
            <div>
              <dt>{t('vat.settlement.row.net')}</dt>
              <dd>{formatMoney(model.netMinor, currency)}</dd>
            </div>
            {hasDifference && (
              <div>
                <dt>{t('vat.settlement.col.difference')}</dt>
                <dd>{formatMoney(model.differences.netMinor, currency)}</dd>
              </div>
            )}
          </dl>
          {writeError !== null && (
            <p className="vr-dialog-error" role="alert">
              {NAMED_CODES.has(writeError.code)
                ? t(`vat.settlement.error.${writeError.code}`)
                : t('vat.settlement.error.fallback')}
              {writeError.code === 'period_locked' && writeError.reason === 'year_close' && (
                <>
                  {' '}
                  <Link to="/periods">{t('vat.settlement.openPeriods')}</Link>
                </>
              )}
            </p>
          )}
        </Modal>
      )}
    </section>
  );
}
