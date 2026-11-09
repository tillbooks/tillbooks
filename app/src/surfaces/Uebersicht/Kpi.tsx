/**
 * D186 (owner, 09.11.2026): the faces of the Übersicht's key figures, "reduce to max".
 *
 * A key figure is its label, ONE value and at most one line under it: the comparison ("▲ +12.5 % Vorjahr"),
 * or for the turnover the estimate of the open bank lines ("+ 1'422.14 geschätzt"). Explanations are never
 * on the face: the one sentence a derived figure needs sits in the tile's tooltip (DESIGN.md "Words on
 * demand"). A tile the person widened (double width) reveals what its engine answer carries beyond the
 * figure: its twelve-month line, the comparison's base, the parts of a sum.
 *
 * The bank figure is its own face: per Bankkonto ONE number, the money on the bank from the latest
 * statement, named "ZKB Geschäftskonto ·· 2957" with the statement's date. Only when bank and books differ
 * do two more rows appear, Gebucht and Offen, with Buchen, the door to the open lines; an unexplained rest
 * is a third row. Nothing is recounted here: every figure is the engine's (`dashboard_overview`).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { HelpHint } from '../../components/HelpHint';
import { IconButton } from '../../components/IconButton';
import { OverflowMenu } from '../../components/OverflowMenu';
import { formatDate, formatMoney, useT } from '../../i18n';
import { Sparkline } from '../../components/charts/LineChart';
import type { CompareMode } from './layout';

type T = ReturnType<typeof useT>;

export interface Comparison {
  from: string;
  to: string;
  value: number;
  changeBp: number | null;
}

export interface BankAccountFigure {
  bankAccountId: string;
  name: string;
  ibanLast4: string;
  currency: string;
  bankMinor: number | null;
  statementDate: string | null;
  bookedMinor: number;
  openCount: number;
  openMinor: number;
  differenceMinor: number | null;
  reason: 'no_statement' | 'no_balance' | 'currency_differs' | null;
}

/** The parts of a tile this module reads, all optional: an older engine simply shows less. */
export interface KpiTile {
  tile: string;
  valueRappen?: number;
  valueBp?: number | null;
  valueQuantity?: { value: number; decimals: number; unit: 'months' | 'days' } | null;
  currency?: string;
  comparisons?: Partial<Record<'previous_period' | 'previous_year', Comparison | null>>;
  /** The previous period's change, from an engine that predates `comparisons` (D186). */
  trendBp?: number | null;
  changeUnit?: 'points';
  estimate?: { revenueMinor: number; lineCount: number };
  accounts?: BankAccountFigure[];
  detail?: Record<string, unknown>;
}

/** `8250` -> `82.5`: basis points to one display decimal, rounded once. */
export function bpNumber(bp: number): string {
  const tenths = Math.round(Math.abs(bp) / 10);
  const whole = Math.floor(tenths / 10);
  const frac = tenths % 10;
  return `${bp < 0 ? '-' : ''}${whole}${frac === 0 ? '' : `.${frac}`}`;
}

/** A quantity in tenths or units, one decimal at most, de-CH style. */
function quantity(q: { value: number; decimals: number }): string {
  if (q.decimals === 0) return String(q.value);
  const sign = q.value < 0 ? '-' : '';
  const v = Math.abs(q.value);
  return `${sign}${Math.floor(v / 10)}.${v % 10}`;
}

/** The face's value: money, a share, a quantity, or "–" when the engine answered no figure (never a fake zero). */
export function valueOf(t: T, tile: KpiTile): { text: string; money: boolean } {
  if (typeof tile.valueRappen === 'number') return { text: formatMoney(tile.valueRappen, tile.currency ?? 'CHF'), money: true };
  if (typeof tile.valueBp === 'number') return { text: `${bpNumber(tile.valueBp)} %`, money: false };
  if (tile.valueQuantity !== undefined && tile.valueQuantity !== null) {
    return { text: t(`dashboard.unit.${tile.valueQuantity.unit}`, { value: quantity(tile.valueQuantity) }), money: false };
  }
  return { text: '–', money: false };
}

/** The one comparison line, or null (no comparison chosen, none answered, or a zero base). */
export function CompareLine({ tile, mode }: { tile: KpiTile; mode: CompareMode }) {
  const t = useT();
  if (mode === 'none') return null;
  // An engine before D186 answered only the previous period's change: said as exactly that.
  const legacy = tile.comparisons === undefined && typeof tile.trendBp === 'number';
  const shown: CompareMode = legacy ? 'previous_period' : mode;
  const bp = legacy ? (tile.trendBp as number) : (tile.comparisons?.[mode]?.changeBp ?? null);
  if (bp === null) return null;
  const glyph = bp > 0 ? '▲' : bp < 0 ? '▼' : '–';
  const number = `${bp > 0 ? '+' : ''}${bpNumber(bp)}`;
  const value = tile.changeUnit === 'points' ? t('dashboard.compare.points', { value: number }) : `${number} %`;
  const against = t(`dashboard.compare.short.${shown}`);
  return (
    <span className="uebersicht-trend" aria-label={t('dashboard.compare.aria', { value, against })}>
      <span aria-hidden="true">{glyph}</span> {t('dashboard.compare.change', { value, against })}
    </span>
  );
}

/** The turnover estimate's one line, shown while it is not zero. */
export function EstimateLine({ tile }: { tile: KpiTile }) {
  const t = useT();
  const e = tile.estimate;
  if (e === undefined || e.lineCount === 0 || e.revenueMinor === 0) return null;
  return (
    <span className="uebersicht-estimate">
      <span className="uebersicht-estimate__mark" aria-hidden="true" />
      {t('dashboard.estimate.line', { amount: formatMoney(e.revenueMinor, tile.currency ?? 'CHF') })}
    </span>
  );
}

/** The estimate's tooltip sentence, or null. */
export function estimateTip(t: T, tile: KpiTile): string | null {
  const e = tile.estimate;
  if (e === undefined || e.lineCount === 0 || e.revenueMinor === 0) return null;
  return t(`dashboard.estimate.tip.${e.lineCount === 1 ? 'one' : 'other'}`, { count: e.lineCount });
}

/**
 * One row of a widened tile's detail: a label and a figure. Spans, not a `<dl>`: the face may sit inside
 * the tile's button, whose content must be phrasing content.
 */
function Row({ label, children, money = true }: { label: string; children: ReactNode; money?: boolean }) {
  return (
    <span className="uebersicht-detail__row">
      <span className="uebersicht-detail__label">{label}</span>
      <span className={money ? 't-money' : 't-num'}>{children}</span>
    </span>
  );
}

/**
 * What a widened tile reveals beyond its figure, from the engine's own answer. Null when the tile carries
 * nothing more: then the wider face is simply roomier.
 */
export function KpiDetail({ tile, mode, trend }: { tile: KpiTile; mode: CompareMode; trend: number[] | null }) {
  const t = useT();
  const cur = tile.currency ?? 'CHF';
  const d = tile.detail ?? {};
  const money = (key: string): string => formatMoney(typeof d[key] === 'number' ? (d[key] as number) : 0, cur);
  let rows: ReactNode = null;
  switch (tile.tile) {
    case 'free_cash':
      rows = (
        <span className="uebersicht-detail">
          <Row label={t('dashboard.detail.bankBooked')}>{money('bankMinor')}</Row>
          <Row label={t('dashboard.detail.payables')}>- {money('payablesMinor')}</Row>
          <Row label={t('dashboard.detail.vat')}>- {money('vatDueMinor')}</Row>
        </span>
      );
      break;
    case 'runway':
      rows = (
        <span className="uebersicht-detail-line">
          {t('dashboard.detail.monthly')} <span className="t-money">{money('monthlyExpenseMinor')}</span>, {t('dashboard.detail.months', { months: Number(d.months ?? 6) })}
        </span>
      );
      break;
    case 'low_point':
      rows = typeof d.lowestDate === 'string' ? <span className="uebersicht-detail-line">{t('dashboard.detail.on', { date: formatDate(d.lowestDate) })}</span> : null;
      break;
    case 'dso':
      rows = typeof d.invoices === 'number' ? <span className="uebersicht-detail-line">{t(`dashboard.detail.invoices.${d.invoices === 1 ? 'one' : 'other'}`, { count: d.invoices })}</span> : null;
      break;
    case 'top_customer':
      rows = typeof d.name === 'string' ? <span className="uebersicht-detail-line">{d.name}</span> : null;
      break;
    case 'auto_rate':
      rows = (
        <span className="uebersicht-detail">
          <Row label={t('dashboard.detail.autopilot')} money={false}>{Number(d.autopilot ?? 0)}</Row>
          <Row label={t('dashboard.detail.byRule')} money={false}>{Number(d.byRule ?? 0)}</Row>
          <Row label={t('dashboard.detail.decided')} money={false}>{Number(d.decided ?? 0)}</Row>
        </span>
      );
      break;
    case 'receipt_rate':
      rows = (
        <span className="uebersicht-detail-line">
          {t('dashboard.detail.missing')} <span className="t-num">{Number(d.missing ?? 0)}</span>
        </span>
      );
      break;
    default: {
      // A compared money figure shows the base it is compared with.
      const c = mode === 'none' ? null : tile.comparisons?.[mode] ?? null;
      if (c !== null && c !== undefined && typeof tile.valueRappen === 'number') {
        rows = (
          <span className="uebersicht-detail-line">
            {t('dashboard.detail.previous', { against: t(`dashboard.compare.short.${mode}`), amount: formatMoney(c.value, cur) })}
          </span>
        );
      }
    }
  }
  return (
    <>
      {rows}
      {trend !== null ? <Sparkline values={trend} /> : null}
    </>
  );
}

// --- the bank figure ------------------------------------------------------------------------------

function AccountFigure({ a }: { a: BankAccountFigure }) {
  const t = useT();
  const judged = a.bankMinor !== null;
  const open = judged && a.openCount > 0;
  const unexplained = judged && a.differenceMinor !== null && a.differenceMinor !== 0;
  return (
    <div className="uebersicht-account">
      <p className="uebersicht-account__name">
        <span className="uebersicht-account__label">{t('dashboard.balance.account', { name: a.name, last4: a.ibanLast4 })}</span>
        {a.statementDate !== null && judged ? <span className="t-num">{t('dashboard.balance.asOf', { date: formatDate(a.statementDate) })}</span> : null}
      </p>
      <p className="uebersicht-account__figure t-money">{formatMoney(judged ? (a.bankMinor as number) : a.bookedMinor, a.currency)}</p>
      {!judged ? (
        <p className="uebersicht-account__state">{t(`dashboard.balance.reason.${a.reason ?? 'no_statement'}`)}</p>
      ) : open || unexplained ? (
        <dl className="uebersicht-account__diff">
          <dt>{t('dashboard.balance.booked')}</dt>
          <dd className="t-money">{formatMoney(a.bookedMinor, a.currency)}</dd>
          {open ? (
            <>
              <dt>{t('dashboard.balance.open')}</dt>
              <dd className="t-money">{formatMoney(a.openMinor, a.currency)}</dd>
            </>
          ) : null}
          {unexplained ? (
            <>
              <dt>{t('dashboard.balance.unexplained')}</dt>
              <dd className="t-money">{formatMoney(a.differenceMinor as number, a.currency)}</dd>
            </>
          ) : null}
        </dl>
      ) : (
        <p className="uebersicht-account__state">
          <span className="uebersicht-account__ok" aria-hidden="true">
            ✓
          </span>{' '}
          {t('dashboard.balance.reconciled')}
        </p>
      )}
    </div>
  );
}

/** The bank tile's face: one figure per Bankkonto, and Buchen once, where lines wait. */
export function BankBalanceFace({ tile, bookHere = true }: { tile: KpiTile; bookHere?: boolean }) {
  const t = useT();
  const accounts = tile.accounts ?? [];
  const waiting = accounts.some((a) => a.bankMinor !== null && (a.openCount > 0 || (a.differenceMinor ?? 0) !== 0));
  return (
    <section className="uebersicht-tile uebersicht-tile--bank" aria-labelledby="uebersicht-bank-balance">
      <h2 id="uebersicht-bank-balance" className="uebersicht-tile-head uebersicht-tile-head--title">
        <span aria-hidden="true" className="uebersicht-glyph">
          {(tile as { glyph?: string }).glyph ?? ''}
        </span>
        <span className="uebersicht-label">{t('dashboard.tile.bank_balance')}</span>
      </h2>
      <span className="uebersicht-tile-hint">
        <HelpHint label={t('dashboard.settings.about', { name: t('dashboard.tile.bank_balance') })} title={t('dashboard.tile.bank_balance')} body={t('dashboard.tileTip.bank_balance')} placement="bottom" />
      </span>
      <div className={accounts.length > 1 ? 'uebersicht-accounts uebersicht-accounts--several' : 'uebersicht-accounts'}>
        {accounts.map((a) => (
          <AccountFigure key={a.bankAccountId} a={a} />
        ))}
      </div>
      {/* One door to the open lines (D152 rule 3): only when the Bankeingang is not on the page already. */}
      {waiting && bookHere ? (
        <Link to="/bank?status=open" className="btn btn--secondary uebersicht-account__book">
          {t('dashboard.balance.book')}
        </Link>
      ) : null}
    </section>
  );
}

// --- the library ----------------------------------------------------------------------------------

/** The library's groups, in order; a tile in no group falls to the last. */
export const LIBRARY_GROUPS: readonly { id: string; tiles: readonly string[] }[] = [
  { id: 'money', tiles: ['bank_balance', 'free_cash', 'runway', 'low_point', 'mwst_due', 'cash', 'bank_inbox'] },
  { id: 'result', tiles: ['revenue', 'expense', 'result', 'margin', 'revenue_ltm'] },
  { id: 'parties', tiles: ['ar_aging', 'dso', 'top_customer', 'ap_aging'] },
  { id: 'books', tiles: ['auto_rate', 'receipt_rate'] },
  { id: 'operations', tiles: ['utilisation', 'project_margin', 'stock_value'] },
];

/** One key figure's row of choices on the settings screen. */
export interface KpiSettingRow {
  id: string;
  on: boolean;
  double: boolean;
  trend: boolean;
  compare: CompareMode | undefined;
  /** The one sentence the figure needs, shown on hover or focus of its (?) only. */
  tip: string | null;
  comparable: boolean;
  trendable: boolean;
  /** The bank item has its own size choices on the Übersicht (Kachel, Karte oben, Schmale Leiste). */
  sizable: boolean;
}

/**
 * D186 (owner, 09.11.2026): the key-figure settings, their own screen. KISS: per figure a checkbox and its
 * name, and icons for the rest (Vergleichen opens a menu below it, Verlauf and Grösse ändern are pressed or
 * not); words only on hover or focus. Every change is written at once (the `overview.tiles` preference).
 */
export function KpiSettings({
  rows,
  name,
  onToggle,
  onCompare,
  onTrend,
  onResize,
}: {
  rows: readonly KpiSettingRow[];
  name: (id: string) => string;
  onToggle: (id: string) => void;
  onCompare: (id: string, mode: CompareMode | null) => void;
  onTrend: (id: string) => void;
  onResize: (id: string) => void;
}) {
  const t = useT();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const grouped = new Set(LIBRARY_GROUPS.flatMap((g) => g.tiles));
  const groups = LIBRARY_GROUPS.map((g) => ({ ...g, tiles: g.tiles.filter((id) => byId.has(id)) }));
  const loose = rows.filter((r) => !grouped.has(r.id)).map((r) => r.id);
  if (loose.length > 0) groups[groups.length - 1] = { ...groups[groups.length - 1]!, tiles: [...groups[groups.length - 1]!.tiles, ...loose] };
  return (
    <div className="uebersicht-settings">
      {groups
        .filter((g) => g.tiles.length > 0)
        .map((g) => (
          <fieldset key={g.id} className="uebersicht-settings__group">
            <legend>{t(`dashboard.library.groups.${g.id}`)}</legend>
            {g.tiles.map((id) => {
              const r = byId.get(id)!;
              const label = name(id);
              return (
                <div key={id} className="uebersicht-settings__row">
                  <label className="uebersicht-settings__name">
                    <input type="checkbox" checked={r.on} onChange={() => onToggle(id)} />
                    {label}
                  </label>
                  {/* Four fixed slots, so every icon stands in its own column down the list. */}
                  <span className="uebersicht-settings__slot">
                    {r.tip !== null ? <HelpHint label={t('dashboard.settings.about', { name: label })} title={label} body={r.tip} placement="bottom" /> : null}
                  </span>
                  <span className="uebersicht-settings__slot">
                    {r.comparable ? (
                      <OverflowMenu
                        icon="compare"
                        quiet
                        portal
                        label={t('dashboard.settings.compare', { name: label })}
                        tooltip={r.compare === undefined ? t('dashboard.edit.comparePage') : t(`dashboard.settings.modes.${r.compare}`)}
                        items={[
                          { key: 'page', label: t('dashboard.edit.comparePage'), onSelect: () => onCompare(id, null), checked: r.compare === undefined },
                          ...(['previous_year', 'previous_period', 'none'] as const).map((m) => ({
                            key: m,
                            label: t(`dashboard.settings.modes.${m}`),
                            onSelect: () => onCompare(id, m),
                            checked: r.compare === m,
                          })),
                        ]}
                      />
                    ) : null}
                  </span>
                  <span className="uebersicht-settings__slot">
                    {r.trendable ? <IconButton icon="trend" small context={label} aria-pressed={r.trend} onClick={() => onTrend(id)} /> : null}
                  </span>
                  <span className="uebersicht-settings__slot">
                    {r.sizable ? <IconButton icon="resize" small context={label} aria-pressed={r.double} onClick={() => onResize(id)} /> : null}
                  </span>
                </div>
              );
            })}
          </fieldset>
        ))}
    </div>
  );
}
