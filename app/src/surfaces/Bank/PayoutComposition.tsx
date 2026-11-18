/**
 * D195 (owner, v12 point 6): what a settlement payout on the bank is made of, under "Buchen auf" of a line booked
 * by a turnover preset. Each event of the payout is one plain line (a sale with its VAT, the card fee, the money
 * passed on to a third party, the processor's fees, this payout, what the processor holds back), and nothing
 * else on the line repeats those figures.
 *
 * The composition is the ENGINE's: `settlement_payout_for_bank_line` (D193, built by the settlement-pull session,
 * not on develop when this was written). Until that verb answers, or when it answers with no single match, this
 * renders NOTHING: no figure is made up here. A read error is nothing too, never a warning on a line that is
 * otherwise fine.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useT, formatDate, formatMoney } from '../../i18n';

/** One event of a payout, as `settlement_payout_for_bank_line` answers it (`composition.events[]`). */
export interface PayoutEvent {
  eventId: string;
  kind: string;
  day: string;
  amountMinor: number;
  netMinor: number;
  vatMinor: number | null;
}

/** The one match the composition shows: the processor and its payout. */
export interface PayoutMatchView {
  system: string;
  processor: string;
  day: string;
  amountMinor: number;
  events: PayoutEvent[];
  residualMinor: number;
}

/** The answer's single match, or null for none, several, or anything unreadable. */
export function payoutMatchOf(body: unknown): PayoutMatchView | null {
  const r = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
  if (r === null || r.match !== 'one' || !Array.isArray(r.matches) || r.matches.length !== 1) return null;
  const m = r.matches[0] as Record<string, unknown>;
  const c = typeof m.composition === 'object' && m.composition !== null ? (m.composition as Record<string, unknown>) : null;
  if (c === null || !Array.isArray(c.events) || typeof m.amountMinor !== 'number') return null;
  const events: PayoutEvent[] = [];
  for (const raw of c.events as unknown[]) {
    const e = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
    if (e === null || typeof e.kind !== 'string' || typeof e.amountMinor !== 'number' || typeof e.day !== 'string') return null;
    events.push({
      eventId: typeof e.eventId === 'string' ? e.eventId : '',
      kind: e.kind,
      day: e.day,
      amountMinor: e.amountMinor,
      netMinor: typeof e.netMinor === 'number' ? e.netMinor : e.amountMinor,
      vatMinor: typeof e.vatMinor === 'number' ? e.vatMinor : null,
    });
  }
  return {
    system: typeof m.system === 'string' ? m.system : '',
    processor: typeof m.processor === 'string' ? m.processor : '',
    day: typeof m.day === 'string' ? m.day : '',
    amountMinor: m.amountMinor,
    events,
    residualMinor: typeof c.residualMinor === 'number' ? c.residualMinor : 0,
  };
}

/** The kinds the composition names; anything else reads as "Anderes". */
const KNOWN_KINDS: ReadonlySet<string> = new Set(['sale', 'refund', 'processing_fee', 'service_fee', 'third_party_payout', 'third_party_payout_reversal', 'reserve']);

/** More events than this are summed per kind, so a busy payout stays a few lines. */
export const PAYOUT_EVENTS_LISTED = 8;

export function PayoutComposition({ workspaceId, bankTxnId, currency }: { workspaceId: string; bankTxnId: string; currency: string }) {
  const t = useT();
  const client = useClient();
  const [match, setMatch] = useState<{ id: string; view: PayoutMatchView | null } | null>(null);
  useEffect(() => {
    let live = true;
    void client.call('settlement_payout_for_bank_line', { workspaceId, bankTxnId }).then(
      ({ body }) => {
        if (live) setMatch({ id: bankTxnId, view: isErr(body) ? null : payoutMatchOf(body) });
      },
      () => {
        if (live) setMatch({ id: bankTxnId, view: null });
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId, bankTxnId]);
  const view = match !== null && match.id === bankTxnId ? match.view : null;
  if (view === null) return null;

  const figure = (minor: number) => formatMoney(minor, currency, { signed: true }).slice(currency.length + 1);
  // The engine keeps a source's names folded to lower case; a person reads them capitalised.
  const named = view.processor !== '' ? view.processor : view.system;
  const processor = named === '' ? named : named.charAt(0).toUpperCase() + named.slice(1);
  const labelOf = (kind: string, day: string, vatMinor: number | null) => {
    const k = KNOWN_KINDS.has(kind) ? kind : 'other';
    const base = t(`bankInbox.payout.kind.${k}`, { processor, day: formatDate(day) });
    return kind === 'sale' && vatMinor !== null && vatMinor !== 0 ? t('bankInbox.payout.withVat', { label: base, vat: formatMoney(Math.abs(vatMinor), currency).slice(currency.length + 1) }) : base;
  };
  const rows: { key: string; label: string; minor: number }[] = [];
  if (view.events.length <= PAYOUT_EVENTS_LISTED) {
    for (const e of view.events) rows.push({ key: e.eventId || `${e.kind}-${e.day}`, label: labelOf(e.kind, e.day, e.vatMinor), minor: e.amountMinor });
  } else {
    const byKind = new Map<string, { count: number; minor: number; vat: number }>();
    for (const e of view.events) {
      const held = byKind.get(e.kind) ?? { count: 0, minor: 0, vat: 0 };
      byKind.set(e.kind, { count: held.count + 1, minor: held.minor + e.amountMinor, vat: held.vat + (e.vatMinor ?? 0) });
    }
    for (const [kind, sum] of byKind) {
      const k = KNOWN_KINDS.has(kind) ? kind : 'other';
      rows.push({ key: kind, label: t('bankInbox.payout.many', { label: t(`bankInbox.payout.kindPlain.${k}`, { processor }), count: sum.count }), minor: sum.minor });
    }
  }
  return (
    <table className="bank-mini bank-payout" aria-label={t('bankInbox.payout.title', { processor })}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="bank-mini__label">{r.label}</td>
            <td className="bank-mini__num t-num">{figure(r.minor)}</td>
          </tr>
        ))}
        <tr className="bank-mini__this">
          <td className="bank-mini__label">{t('bankInbox.payout.thisPayout')}</td>
          <td className="bank-mini__num t-num">{figure(Math.abs(view.amountMinor))}</td>
        </tr>
        {view.residualMinor !== 0 && (
          <tr>
            <td className="bank-mini__label">{t('bankInbox.payout.held', { processor })}</td>
            <td className="bank-mini__num t-num">{figure(view.residualMinor)}</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
