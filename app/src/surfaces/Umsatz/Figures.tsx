/**
 * D203, the Zahlen tab's figures: six KPI tiles first (pick A), then the months, the sources and the customers.
 *
 * THE FIGURES ARE THE BOOKS. Every figure but "Zu buchen" comes from `turnover_summary`, a sum over posted
 * entries (the revenue accounts 3xxx, 2200, the clearing accounts), never from a processor payout and never a
 * recompute of the feed. "Zu buchen" is the review's own count (`settlement_review`, the import rolled back):
 * what Buchen would add. Each tile names how it is derived on hover, with the MWST Ziffer, and sets itself
 * against the previous period or the previous year.
 *
 * Low cognitive load (DESIGN.md rule 7, "The calm Studio"): the words live on hover, the tiles carry a figure
 * and one comparison line, the breakdowns are ranked bars with their amounts as text.
 */
import type { ReactNode } from 'react';

import { useI18n, formatMoney } from '../../i18n';
import { Tooltip } from '../../components/Tooltip';
import { RankBars } from '../../components/charts/RankBars';

const CURRENCY = 'CHF';

/** One window's figures, as `turnover_summary` answers them. */
export interface TurnoverFigures {
  turnoverNetMinor: number;
  /** The part of the turnover the settlement sources carry (critic r3 re-cut, point e). */
  settlementTurnoverMinor: number;
  /** The VAT on the settlement sources' sales and refunds only. */
  outputVat: { amountMinor: number; formLines: string[] };
  /** The input VAT on the processor's fees; null under Saldo or Pauschal (no input VAT is deducted). */
  feeInputVat: { amountMinor: number; formLines: string[] } | null;
  sales: { count: number; netMinor: number; averageMinor: number | null };
  reductionsMinor: number;
  payouts: { count: number; amountMinor: number };
  entries: number;
}

/** The `turnover_summary` answer, as this tab reads it. */
export interface TurnoverSummary {
  period: { from: string; to: string };
  /** The workspace's VAT method now: under `saldo` (and `pauschal`) the VAT tile is billed VAT, never owed VAT. */
  vatMethod: string;
  compare: { mode: 'previous_period' | 'previous_year' | 'none'; from: string; to: string } | null;
  totals: TurnoverFigures;
  previous: TurnoverFigures | null;
  byMonth: { month: string; turnoverNetMinor: number; bySource: Record<string, number> }[];
  bySource: { key: string; kind: 'settlement' | 'invoices' | 'other'; system: string | null; processor: string | null; turnoverNetMinor: number; salesCount: number }[];
  byCustomer: {
    top: { key: string; name: string | null; email: string | null; masked: boolean; turnoverNetMinor: number; salesCount: number }[];
    rest: { customers: number; turnoverNetMinor: number };
  };
  accounts: { revenue: string; outputVat: string[]; inputVat: string[]; clearing: string[] };
}

/** What the review says Buchen would add (the to_book rows' turnover and VAT). */
export interface ToBook {
  count: number;
  netMinor: number;
  vatMinor: number;
  /** How many of the counted rows the producer dated outside the period (Buchen books them too). */
  outside: number;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The comparison line of a tile: the change against the compare window, in percent and in money. */
export function compareLine(t: T, now: number, before: number | null | undefined, mode: string, money: boolean): string {
  if (before === null || before === undefined) return '';
  const word = t(`umsatz.figures.compareWord.${mode === 'previous_year' ? 'previous_year' : 'previous_period'}`);
  if (before === 0) return now === 0 ? t('umsatz.figures.same', { word }) : t('umsatz.figures.fromZero', { word });
  const pct = Math.round(((now - before) * 100) / Math.abs(before));
  const value = money ? formatMoney(before, CURRENCY) : String(before);
  return t('umsatz.figures.delta', { sign: pct > 0 ? '+' : '', pct, word, value });
}

function Tile({ label, value, hint, compare, sub, onClick, active }: { label: string; value: ReactNode; hint: string; compare: string; sub?: string; onClick?: () => void; active?: boolean }) {
  const body = (
    <>
      <span className="umsatz-kpi-label">{label}</span>
      <span className="umsatz-kpi-value t-money">{value}</span>
      {sub !== undefined && sub !== '' && <span className="umsatz-kpi-compare">{sub}</span>}
      <span className="umsatz-kpi-compare">{compare}</span>
    </>
  );
  return (
    <li className="umsatz-kpi">
      <Tooltip content={<span className="umsatz-lines">{hint.split('\n').map((l, i) => <span key={i}>{l}</span>)}</span>}>
        {onClick !== undefined ? (
          <button type="button" className={`umsatz-kpi-body umsatz-kpi-body--button${active === true ? ' umsatz-kpi-body--active' : ''}`} aria-pressed={active === true} onClick={onClick}>
            {body}
          </button>
        ) : (
          <span className="umsatz-kpi-body" tabIndex={0} role="group" aria-label={`${label}: ${typeof value === 'string' ? value : ''}`}>
            {body}
          </span>
        )}
      </Tooltip>
    </li>
  );
}

/** The six KPI tiles (D203 point 1), each with its comparison and its derivation on hover. */
export function KpiTiles({
  summary,
  toBook,
  onlyToBook,
  onToBook,
}: {
  summary: TurnoverSummary | null;
  toBook: ToBook | null;
  onlyToBook: boolean;
  onToBook: () => void;
}) {
  const { t } = useI18n();
  const a = summary?.totals ?? null;
  const b = summary?.previous ?? null;
  const mode = summary?.compare?.mode ?? 'previous_period';
  const money = (m: number | null | undefined) => (m === null || m === undefined ? '' : formatMoney(m, CURRENCY));
  const ziffer = (lines: string[]) => (lines.length > 0 ? lines.join(', ') : '');
  const clearing = summary?.accounts.clearing.join(', ') || '1095';
  const outLines = ziffer(a?.outputVat.formLines ?? []) || '303';
  const inLines = ziffer(a?.feeInputVat?.formLines ?? []) || '405';
  // D203 re-cut point d: under Saldo or Pauschal the tile is the VAT billed, never "geschuldet", and the
  // fee input VAT is not shown (no input VAT is deducted).
  const saldo = summary !== null && (summary.vatMethod === 'saldo' || summary.vatMethod === 'pauschal');
  return (
    <ul className="umsatz-kpis" aria-label={t('umsatz.figures.kpis')}>
      <Tile
        label={t('umsatz.figures.turnover')}
        value={money(a?.turnoverNetMinor)}
        compare={a === null ? '' : compareLine(t, a.turnoverNetMinor, b?.turnoverNetMinor, mode, true)}
        hint={t('umsatz.figures.hint.turnover')}
        sub={a === null || a.settlementTurnoverMinor === 0 ? '' : t('umsatz.figures.fromSettlement', { amount: money(a.settlementTurnoverMinor) })}
      />
      <Tile
        label={saldo ? t('umsatz.figures.vatBilled') : t('umsatz.figures.vat')}
        value={money(a?.outputVat.amountMinor)}
        compare={a === null ? '' : compareLine(t, a.outputVat.amountMinor, b?.outputVat.amountMinor, mode, true)}
        hint={
          saldo || a?.feeInputVat == null
            ? t('umsatz.figures.hint.vatSaldo', { lines: outLines })
            : t('umsatz.figures.hint.vat', {
                lines: outLines,
                input: money(a.feeInputVat.amountMinor),
                inLines,
                net: money(a.outputVat.amountMinor - a.feeInputVat.amountMinor),
              })
        }
      />
      <Tile
        label={t('umsatz.figures.sales')}
        value={a === null ? '' : String(a.sales.count)}
        compare={a === null ? '' : compareLine(t, a.sales.count, b?.sales.count, mode, false)}
        hint={t('umsatz.figures.hint.sales')}
      />
      <Tile
        label={t('umsatz.figures.average')}
        value={a === null || a.sales.averageMinor === null ? '' : money(a.sales.averageMinor)}
        compare={a === null || a.sales.averageMinor === null ? '' : compareLine(t, a.sales.averageMinor, b?.sales.averageMinor, mode, true)}
        hint={t('umsatz.figures.hint.average')}
      />
      <Tile
        label={t('umsatz.figures.payouts')}
        value={money(a?.payouts.amountMinor)}
        compare={a === null ? '' : compareLine(t, a.payouts.amountMinor, b?.payouts.amountMinor, mode, true)}
        hint={t('umsatz.figures.hint.payouts', { clearing })}
      />
      <Tile
        label={t('umsatz.figures.toBook')}
        value={toBook === null ? '' : t('umsatz.figures.toBookValue', { count: toBook.count })}
        compare={toBook === null || toBook.count === 0 ? '' : t('umsatz.figures.toBookAmount', { net: money(toBook.netMinor), vat: money(toBook.vatMinor) })}
        hint={t('umsatz.figures.hint.toBook')}
        {...(toBook !== null && toBook.count > 0 ? { onClick: onToBook, active: onlyToBook } : {})}
      />
    </ul>
  );
}

/** A source's words: the settlement source by its system and processor, the invoices, the other entries. */
export function sourceLabel(t: T, s: { kind: string; system: string | null; processor: string | null }): string {
  if (s.kind === 'settlement') return `${s.system ?? ''} · ${s.processor ?? ''}`;
  return t(`umsatz.figures.source.${s.kind === 'invoices' ? 'invoices' : 'other'}`);
}

/** The months, the sources and the customers of the window, as ranked bars with their amounts. */
export function Breakdowns({ summary }: { summary: TurnoverSummary }) {
  const { t } = useI18n();
  const months = summary.byMonth.map((m) => ({ key: m.month, label: `${m.month.slice(5)}.${m.month.slice(0, 4)}`, valueMinor: m.turnoverNetMinor }));
  const sources = summary.bySource.map((s) => ({ key: s.key, label: sourceLabel(t, s), valueMinor: s.turnoverNetMinor }));
  const customers = [
    ...summary.byCustomer.top.map((c) => ({
      key: c.key,
      label: c.masked ? t('umsatz.masked') : (c.name ?? c.email ?? t('umsatz.figures.noCustomer')),
      valueMinor: c.turnoverNetMinor,
    })),
    ...(summary.byCustomer.rest.customers > 0
      ? [{ key: 'rest', label: t('umsatz.figures.restCustomers', { count: summary.byCustomer.rest.customers }), valueMinor: summary.byCustomer.rest.turnoverNetMinor }]
      : []),
  ];
  return (
    <div className="umsatz-breakdowns">
      <section className="umsatz-breakdown umsatz-breakdown--months" aria-label={t('umsatz.figures.byMonth')}>
        <h2 className="umsatz-subhead">{t('umsatz.figures.byMonth')}</h2>
        <RankBars rows={months} currency={CURRENCY} label={t('umsatz.figures.byMonth')} />
      </section>
      <section className="umsatz-breakdown" aria-label={t('umsatz.figures.bySource')}>
        <h2 className="umsatz-subhead">{t('umsatz.figures.bySource')}</h2>
        {sources.length === 0 ? <p className="umsatz-none">{t('umsatz.figures.none')}</p> : <RankBars rows={sources} currency={CURRENCY} label={t('umsatz.figures.bySource')} />}
      </section>
      <section className="umsatz-breakdown" aria-label={t('umsatz.figures.byCustomer')}>
        <h2 className="umsatz-subhead">{t('umsatz.figures.byCustomer')}</h2>
        {customers.length === 0 ? <p className="umsatz-none">{t('umsatz.figures.none')}</p> : <RankBars rows={customers} currency={CURRENCY} label={t('umsatz.figures.byCustomer')} />}
      </section>
    </div>
  );
}
