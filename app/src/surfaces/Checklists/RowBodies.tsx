/**
 * The row bodies of the guided close (design doc §6, S3 to S7; D129 Q6: one long page whose rows open
 * inline). One body per item kind, each rendering ONLY what the engine derived: a choice shows its
 * options and the live answer with its source; a preview shows the read's payload as a table with a
 * total; a posting shows what will post or what posted (entry ids, the reversal date) and the
 * per-period settlement table; a validation shows the result word, the figures, the formula behind a
 * disclosure and the fix link; the statements sign-off shows the A08 totals and the hash it binds.
 * Nothing here derives a state, and nothing here calls a write: the actions are the row's (RunDetail).
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, formatDate, formatMoney } from '../../i18n';
import { Skeleton } from '../../components/states';
import { Status } from '../../components/Status';
import { consequenceKeyOf, formulaKeyOf, isMinorKey, knownKey, type ItemView, type RunView } from './model';

/** Money in the run's base currency; the caller resolves the currency once per run. */
export function useMoney(currency: string): (minor: unknown) => string {
  return (minor: unknown) => (typeof minor === 'number' ? formatMoney(minor, currency) : '');
}

// --- S3: the choice -------------------------------------------------------------------------------

export interface ChoiceBodyProps {
  item: ItemView;
  disabled: boolean;
  onAnswer: (optionId: string) => void;
}

export function ChoiceBody({ item, disabled, onAnswer }: ChoiceBodyProps) {
  const t = useT();
  const current = item.choice?.optionId ?? item.defaultOptionId ?? null;
  const [picked, setPicked] = useState<string | null>(current);
  useEffect(() => setPicked(current), [current]);
  const options = item.options ?? [];
  const unchanged = item.choice !== null && item.choice.source === 'human' && picked === item.choice.optionId;
  const name = `${item.runItemId}-choice`;
  return (
    <div className="chk-body chk-body--choice">
      <fieldset className="chk-choice">
        <legend className="chk-sr">{item.title}</legend>
        {options.map((o) => (
          <label key={o.id} className="chk-choice-option">
            <input type="radio" className="chk-choice-input" name={name} value={o.id} checked={picked === o.id} disabled={disabled} onChange={() => setPicked(o.id)} />
            <span className="chk-choice-label">{knownKey(o.labelKey) ? t(o.labelKey) : o.id}</span>
            <span className="chk-choice-consequence">{knownKey(consequenceKeyOf(o.labelKey)) ? t(consequenceKeyOf(o.labelKey)) : ''}</span>
          </label>
        ))}
      </fieldset>
      {item.choice !== null && (
        <p className="chk-choice-source">
          {item.choice.source === 'derived' ? t('checklists.choice.derived') : t('checklists.choice.human')}
        </p>
      )}
      {item.choice === null && item.defaultOptionId !== null && <p className="chk-choice-source">{t('checklists.choice.preselected')}</p>}
      <button type="button" className="btn btn--primary btn--sm" disabled={disabled || picked === null || unchanged} onClick={() => picked !== null && onAnswer(picked)}>
        {t('checklists.act.answer')}
      </button>
    </div>
  );
}

// --- S4: the preview ------------------------------------------------------------------------------

type Row = Record<string, unknown>;

function rowsOf(payload: Record<string, unknown> | null, verb: string | null): { rows: Row[]; columns: string[]; totalMinor: number | null } {
  if (payload === null) return { rows: [], columns: [], totalMinor: null };
  switch (verb) {
    case 'fx_revaluation': {
      const rows = Array.isArray(payload.positions) ? (payload.positions as Row[]) : [];
      return { rows, columns: ['accountNumber', 'currency', 'fcAmountMinor', 'bookChfMinor', 'revaluedChfMinor', 'diffChfMinor'], totalMinor: typeof payload.totalUnrealisedMinor === 'number' ? payload.totalUnrealisedMinor : null };
    }
    case 'asset_depreciation_preview': {
      const rows = Array.isArray(payload.results) ? (payload.results as Row[]) : [];
      const total = rows.reduce((s, r) => s + (typeof r.amountRappen === 'number' ? r.amountRappen : 0), 0);
      return { rows: rows.map((r) => ({ ...r, amountMinor: r.amountRappen })), columns: ['assetNumber', 'amountMinor'], totalMinor: total };
    }
    case 'accrual_list': {
      const rows = Array.isArray(payload.accruals) ? (payload.accruals as Row[]) : [];
      return { rows, columns: ['description', 'kind', 'contraAccountNumber', 'balanceAccountNumber', 'amountMinor', 'reversalDate'], totalMinor: typeof payload.totalMinor === 'number' ? payload.totalMinor : null };
    }
    case 'provision_list': {
      const rows = Array.isArray(payload.provisions) ? (payload.provisions as Row[]) : [];
      const total = rows.reduce((s, r) => s + (typeof r.amountMinor === 'number' ? r.amountMinor : 0), 0);
      return { rows, columns: ['description', 'reason', 'provisionAccountNumber', 'expenseAccountNumber', 'amountMinor'], totalMinor: total };
    }
    default:
      return { rows: [], columns: [], totalMinor: null };
  }
}

/** The scalar figures of a payload, `Minor` keys as money: the tax helper's shape and the fallback. */
function figuresOf(payload: Record<string, unknown> | null, skip: ReadonlySet<string>): Array<[string, unknown]> {
  if (payload === null) return [];
  return Object.entries(payload).filter(([k, v]) => !skip.has(k) && (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean'));
}

const PREVIEW_SKIP = new Set(['ok', 'baseCurrency', 'periodEnd', 'period', 'periodStart', 'year', 'applicable', 'missingAccounts', 'proposedDraft', 'fiscalYearStart']);

export interface PreviewBodyProps {
  item: ItemView;
  run: RunView;
  currency: string;
  disabled: boolean;
  onSeen: () => void;
}

export function PreviewBody({ item, run, currency, disabled, onSeen }: PreviewBodyProps) {
  const t = useT();
  const money = useMoney(currency);
  const p = item.previewResult;
  const governing = item.excludedBy?.itemId ?? run.items.find((i) => i.itemId === item.previewOf)?.itemId ?? null;
  if (p === null) return null;
  if (!p.ok) {
    return (
      <div className="chk-body chk-body--preview">
        <p className="chk-dialog-error" role="alert">
          {t('checklists.preview.refused', { code: p.error ?? 'refused' })}
        </p>
        {item.deepLink !== null && (
          <Link className="btn btn--secondary btn--sm" to={item.deepLink}>
            {t('checklists.act.open')}
          </Link>
        )}
      </div>
    );
  }
  const { rows, columns, totalMinor } = rowsOf(p.payload, item.verb);
  const figures = rows.length === 0 ? figuresOf(p.payload, PREVIEW_SKIP) : [];
  const cell = (key: string, v: unknown): string => {
    if (isMinorKey(key)) return money(v);
    if (key === 'reversalDate' && typeof v === 'string') return formatDate(v);
    if (key === 'kind' && typeof v === 'string') return knownKey(`checklists.previewValue.${v}`) ? t(`checklists.previewValue.${v}`) : v;
    return typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  };
  return (
    <div className="chk-body chk-body--preview">
      {p.empty && (
        <p className="chk-preview-empty">
          {t('checklists.preview.empty')}
          {governing !== null && <span className="chk-preview-governing"> {t('checklists.preview.changeAnswer')}</span>}
        </p>
      )}
      {rows.length > 0 && (
        <div className="chk-table-frame">
          <table className="chk-table">
            <caption className="chk-sr">{item.title}</caption>
            <thead>
              <tr>
                {columns.map((c) => (
                  <th key={c} scope="col" className={isMinorKey(c) ? 't-num' : undefined}>
                    {knownKey(`checklists.previewCol.${c}`) ? t(`checklists.previewCol.${c}`) : c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={typeof r.id === 'string' ? r.id : i}>
                  {columns.map((c) => (
                    <td key={c} className={isMinorKey(c) ? 't-num' : undefined}>
                      {cell(c, r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {totalMinor !== null && (
              <tfoot>
                <tr>
                  <th scope="row" colSpan={Math.max(1, columns.length - 1)}>
                    {t('checklists.preview.total')}
                  </th>
                  <td className="t-num t-money">{money(totalMinor)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {rows.length === 0 && figures.length > 0 && (
        <dl className="chk-figures">
          {figures.map(([k, v]) => (
            <div key={k} className="chk-figure">
              <dt>{knownKey(`checklists.figure.${k}`) ? t(`checklists.figure.${k}`) : k}</dt>
              <dd className={isMinorKey(k) ? 't-num t-money' : undefined}>{isMinorKey(k) ? money(v) : String(v)}</dd>
            </div>
          ))}
        </dl>
      )}
      <p className="chk-provenance">
        {t('checklists.preview.provenance', { verb: item.verb ?? '', hash: (p.hash ?? '').slice(0, 8) })}
        {p.postedBelow && <> {t('checklists.preview.postedBelow')}</>}
      </p>
      {!p.postedBelow && !p.empty && item.status === 'open' && (
        <button type="button" className="btn btn--primary btn--sm" disabled={disabled} onClick={onSeen}>
          {t('checklists.act.seen')}
        </button>
      )}
    </div>
  );
}

// --- S5: the posting ------------------------------------------------------------------------------

export interface SettlementRow {
  label: string;
  filed: boolean;
  settled: boolean;
  nothingToSettle: boolean;
  settlementId: string | null;
  netMinor: number | null;
}

export function settlementRowsOf(item: ItemView): SettlementRow[] {
  const raw = item.probeResult?.detail.periods;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      label: typeof r.label === 'string' ? r.label : '',
      filed: r.filed === true,
      settled: r.settled === true,
      nothingToSettle: r.nothingToSettle === true,
      settlementId: typeof r.settlementId === 'string' ? r.settlementId : null,
      netMinor: typeof r.netMinor === 'number' ? r.netMinor : null,
    }));
}

export interface PostingBodyProps {
  item: ItemView;
  run: RunView;
  currency: string;
  /** The primary action (the domain verb), already decided by the row; null when the row links out. */
  primary: ReactNode;
  /** The per-period settlement controls, keyed by period label (the year run's `vat_settled` row). */
  perPeriod?: (row: SettlementRow) => ReactNode;
  /** The consequence sentence the seal row carries (identical on the confirm and the Vorschlag card). */
  consequence?: string;
}

export function PostingBody({ item, run, currency, primary, perPeriod, consequence }: PostingBodyProps) {
  const t = useT();
  const money = useMoney(currency);
  const probe = item.probeResult;
  const paired = item.previewOf === null ? null : run.items.find((i) => i.itemId === item.previewOf) ?? null;
  const pairedTotal = paired?.previewResult?.payload === undefined ? null : rowsOf(paired?.previewResult?.payload ?? null, paired?.verb ?? null).totalMinor;
  const settlements = settlementRowsOf(item);
  return (
    <div className="chk-body chk-body--posting">
      {consequence !== undefined && <p className="chk-consequence chk-consequence--seal">{consequence}</p>}
      {probe !== null && probe.found === null && (
        <p className="chk-dialog-error" role="alert">
          {t('checklists.posting.unavailable', { reason: probe.reason ?? '' })}
        </p>
      )}
      {probe?.found === true && (
        <p className="chk-posting-posted">
          {probe.detail.nothingToSettle === true
            ? t('checklists.posting.nothingToSettle')
            : t('checklists.posting.posted', { entries: probe.entryIds.join(', ') || t('checklists.posting.noEntry') })}
          {probe.reversalDate !== null && <> {t('checklists.posting.reversalOn', { date: formatDate(probe.reversalDate) })}</>}
        </p>
      )}
      {probe?.found === false && pairedTotal !== null && <p className="chk-posting-will">{t('checklists.posting.willPost', { total: money(pairedTotal) })}</p>}
      {settlements.length > 0 && (
        <div className="chk-table-frame">
          <table className="chk-table">
            <caption className="chk-sr">{item.title}</caption>
            <thead>
              <tr>
                <th scope="col">{t('checklists.settlement.period')}</th>
                <th scope="col">{t('checklists.settlement.state')}</th>
                <th scope="col" className="t-num">{t('checklists.settlement.net')}</th>
                <th scope="col" className="chk-sr">{t('checklists.settlement.action')}</th>
              </tr>
            </thead>
            <tbody>
              {settlements.map((s) => (
                <tr key={s.label} data-period={s.label}>
                  <td>{s.label}</td>
                  <td>
                    {!s.filed ? (
                      <Link className="link-inline" to="/checklisten">{t('checklists.settlement.notFiled')}</Link>
                    ) : s.nothingToSettle ? (
                      t('checklists.settlement.nothing')
                    ) : s.settled ? (
                      t('checklists.settlement.settled')
                    ) : (
                      t('checklists.settlement.unsettled')
                    )}
                  </td>
                  <td className="t-num t-money">{money(s.netMinor)}</td>
                  <td>{perPeriod === undefined ? null : perPeriod(s)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {primary}
    </div>
  );
}

// --- S6: the validation ---------------------------------------------------------------------------

export interface ValidationBodyProps {
  item: ItemView;
  currency: string;
  /** The acknowledge control of a warn row, decided by the row. */
  acknowledge: ReactNode;
  onRecheck: () => void;
}

const FIGURE_SKIP = new Set(['months', 'locked', 'missing', 'accounts', 'assets', 'exceeding', 'flagged', 'bands', 'prior', 'adjustments', 'nonZero', 'provisionIds', 'lastSettlement', 'output', 'input', 'source', 'typedItemId', 'unfiledPeriods', 'refusedPeriods', 'mismatched']);

export function ValidationBody({ item, currency, acknowledge, onRecheck }: ValidationBodyProps) {
  const t = useT();
  const money = useMoney(currency);
  const v = item.validationResult;
  if (v === null) return null;
  const word = v.result === 'pass' ? t('checklists.validationWord.pass') : v.result === 'unavailable' ? t('checklists.validationWord.unavailable') : item.severity === 'warn' ? t('checklists.validationWord.warn') : t('checklists.validationWord.fail');
  const figures = Object.entries(v.figures).filter(([k, val]) => !FIGURE_SKIP.has(k) && (typeof val === 'number' || typeof val === 'string' || typeof val === 'boolean'));
  const lists = Object.entries(v.figures).filter(([k, val]) => ['missing', 'exceeding', 'flagged', 'nonZero', 'unfiledPeriods', 'mismatched'].includes(k) && Array.isArray(val) && (val as unknown[]).length > 0);
  const source = typeof v.figures.source === 'string' ? v.figures.source : null;
  return (
    <div className="chk-body chk-body--validation" data-result={v.result}>
      <p className="chk-validation-word" data-result={v.result}>
        {/* K-22: the shared Status glyph plus the word, never ✓/?/! text marks. */}
        <Status
          kind={v.result === 'pass' ? 'success' : v.result === 'unavailable' ? 'neutral' : item.severity === 'warn' ? 'warn' : 'danger'}
          label={word}
        />
        {v.result === 'fail' && item.severity === 'warn' && item.status === 'open' && <span className="chk-validation-hint"> {t('checklists.validation.warnHint')}</span>}
      </p>
      {v.result === 'unavailable' && (
        <p className="chk-validation-reason">
          {t('checklists.validation.unavailable', { reason: knownKey(`checklists.validationReason.${v.reason ?? ''}`) ? t(`checklists.validationReason.${v.reason ?? ''}`) : (v.reason ?? '') })}
        </p>
      )}
      {source !== null && knownKey(`checklists.validationSource.${source}`) && <p className="chk-validation-source">{t(`checklists.validationSource.${source}`)}</p>}
      {figures.length > 0 && (
        <dl className="chk-figures">
          {figures.map(([k, val]) => (
            <div key={k} className="chk-figure">
              <dt>{knownKey(`checklists.figure.${k}`) ? t(`checklists.figure.${k}`) : k}</dt>
              <dd className={isMinorKey(k) ? 't-num t-money' : undefined}>{isMinorKey(k) ? money(val) : String(val)}</dd>
            </div>
          ))}
        </dl>
      )}
      {lists.map(([k, val]) => (
        <p key={k} className="chk-validation-list">
          {knownKey(`checklists.figure.${k}`) ? t(`checklists.figure.${k}`) : k}: {(val as unknown[]).map(String).join(', ')}
        </p>
      ))}
      <details className="chk-formula">
        <summary>{t('checklists.validation.formula')}</summary>
        <p>{knownKey(formulaKeyOf(v.key)) ? t(formulaKeyOf(v.key)) : v.explanation}</p>
      </details>
      <div className="chk-body-actions">
        {v.result !== 'pass' && item.fixLink !== null && (
          <Link className={v.result === 'fail' && item.severity === 'block' ? 'btn btn--primary btn--sm' : 'btn btn--secondary btn--sm'} to={item.fixLink}>
            {t('checklists.act.fix')}
          </Link>
        )}
        {v.result === 'unavailable' && (
          <button type="button" className="btn btn--secondary btn--sm" onClick={onRecheck}>
            {t('checklists.act.recheck')}
          </button>
        )}
        {acknowledge}
      </div>
    </div>
  );
}

// --- S7: the statements sign-off ------------------------------------------------------------------

type StatementsState =
  | { status: 'loading' }
  | { status: 'error'; code: string }
  | { status: 'loaded'; aktivenMinor: number; passivenMinor: number; reingewinnMinor: number; currency: string };

export interface StatementsBodyProps {
  item: ItemView;
  run: RunView;
  workspaceId: string;
  /** The sign-off control, decided by the row. */
  sign: ReactNode;
}

export function StatementsBody({ item, run, workspaceId, sign }: StatementsBodyProps) {
  const t = useT();
  const client = useClient();
  const [state, setState] = useState<StatementsState>({ status: 'loading' });
  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    void (async () => {
      const bs = await client.call('balance_sheet', { workspaceId, asOf: run.periodEnd });
      const is = await client.call('income_statement', { workspaceId, periodStart: run.periodStart, periodEnd: run.periodEnd });
      if (!alive) return;
      if (isErr(bs.body)) return setState({ status: 'error', code: bs.body.error });
      if (isErr(is.body)) return setState({ status: 'error', code: is.body.error });
      const b = bs.body as Record<string, unknown>;
      const i = is.body as Record<string, unknown>;
      setState({
        status: 'loaded',
        aktivenMinor: typeof b.aktivenMinor === 'number' ? b.aktivenMinor : 0,
        passivenMinor: typeof b.passivenMinor === 'number' ? b.passivenMinor : 0,
        reingewinnMinor: typeof i.reingewinnMinor === 'number' ? i.reingewinnMinor : 0,
        currency: typeof b.baseCurrency === 'string' ? b.baseCurrency : 'CHF',
      });
    })();
    return () => {
      alive = false;
    };
  }, [client, workspaceId, run.periodStart, run.periodEnd, run.anchorHash]);
  return (
    <div className="chk-body chk-body--statements">
      {state.status === 'loading' && <Skeleton rows={3} height={18} labelKey="checklists.statements.loading" />}
      {state.status === 'error' && (
        <p className="chk-dialog-error" role="alert">
          {t('checklists.error.refused', { code: state.code })}
        </p>
      )}
      {state.status === 'loaded' && (
        <dl className="chk-figures">
          <div className="chk-figure">
            <dt>{t('checklists.statements.aktiven')}</dt>
            <dd className="t-num t-money">{formatMoney(state.aktivenMinor, state.currency)}</dd>
          </div>
          <div className="chk-figure">
            <dt>{t('checklists.statements.passiven')}</dt>
            <dd className="t-num t-money">{formatMoney(state.passivenMinor, state.currency)}</dd>
          </div>
          <div className="chk-figure">
            <dt>{t('checklists.statements.reingewinn')}</dt>
            <dd className="t-num t-money">{formatMoney(state.reingewinnMinor, state.currency)}</dd>
          </div>
        </dl>
      )}
      <p className="chk-provenance">
        {t('checklists.statements.stand', { hash: (run.anchorHash ?? '').slice(0, 8) })}
        {item.stale && <> {t('checklists.statements.stale')}</>}
      </p>
      <div className="chk-body-actions">
        <Link className="btn btn--secondary btn--sm" to="/reports">
          {t('checklists.statements.open')}
        </Link>
        {sign}
      </div>
    </div>
  );
}
