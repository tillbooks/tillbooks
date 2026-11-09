/**
 * D188 (A39 §21): the Studio half of card-line rules. A line the bank names nobody on is named by the
 * counterparty TILL read from its text (the row, the facts card, which says so), and a receipt's VAT on an
 * untaxed booking, or in another currency, is a note with its figure. SYNTHETIC DATA ONLY: invented ids,
 * merchants and amounts.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { I18nProvider, useT } from '../../i18n';
import { EvidenceLines } from './VorschlagOnLine';
import { FactsCard } from './FactsCard';
import { EMPTY_LOOKUPS, detailOf, partyOf } from './lookups';
import type { BankInboxLine, VorschlagEvidence } from './model';

const TEXT = 'Online purchase Beispielbank Visa Debit card no. xxxx 4711, RENDER.COM 94107';

const line = (over: Partial<BankInboxLine> = {}): BankInboxLine =>
  ({
    bankTxnId: 'bt_1',
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'open',
    bookingDate: '2026-07-20',
    valueDate: '2026-07-20',
    amountMinor: -1900,
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: null, iban: null },
    derivedCounterparty: { kind: 'card', label: 'RENDER.COM 94107' },
    remittance: { text: TEXT, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: null,
    attention: null,
    receiptCount: 0,
    needsReceipt: false,
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
    belegCandidates: [],
    ...over,
  }) as BankInboxLine;

function Party({ l }: { l: BankInboxLine }) {
  const t = useT();
  return (
    <p>
      <span data-testid="party">{partyOf(t, l)}</span>
      <span data-testid="detail">{detailOf(l)}</span>
    </p>
  );
}
const wrap = (ui: ReactNode) => render(<I18nProvider initialLocale="de-CH">{ui}</I18nProvider>);

describe('D188: the derived counterparty names the line', () => {
  it('a card line is named by its merchant, and its text follows as the second words', () => {
    wrap(<Party l={line()} />);
    expect(screen.getByTestId('party').textContent).toBe('RENDER.COM 94107');
    expect(screen.getByTestId('detail').textContent).toBe(TEXT);
  });

  it('a name the bank stated still leads; without anything the text leads alone, as before', () => {
    wrap(<Party l={line({ counterparty: { name: 'Muster AG', iban: null } })} />);
    expect(screen.getByTestId('party').textContent).toBe('Muster AG');
  });

  it('no derived counterparty: the remittance leads and nothing repeats', () => {
    wrap(<Party l={line({ derivedCounterparty: null })} />);
    expect(screen.getByTestId('party').textContent).toBe(TEXT);
    expect(screen.getByTestId('detail').textContent).toBe('');
  });

  it('the facts card says the counterparty was read from the booking text', () => {
    wrap(<FactsCard line={line({ derivedCounterparty: { kind: 'bank_fee', label: 'Geschäftskonto' } })} lookups={EMPTY_LOOKUPS} titleId="t" showAccount={false} />);
    const dd = document.querySelector('[data-fact="derived"] dd') as HTMLElement | null;
    expect(dd?.textContent).toBe('Geschäftskonto, aus dem Buchungstext gelesen (Bankgebühr)');
  });
});

const evidence = (over: Partial<VorschlagEvidence> = {}): VorschlagEvidence => ({
  certainty: 'check',
  agrees: false,
  reasons: ['no_engine_proposal'],
  engine: { certainty: 'open', reasonCode: 'no_proposal', reasonParams: {}, target: null },
  belege: [],
  vat: null,
  ...over,
});

describe('D188: a receipt VAT that is not booked is a note with its figure', () => {
  it('the booking taxes no leg: the receipt VAT in its own currency, said as a note', () => {
    wrap(
      <EvidenceLines
        line={line()}
        evidence={evidence({
          reasons: ['no_engine_proposal', 'vat_not_booked'],
          vat: { belegMinor: 65, computedMinor: 0, deltaMinor: 65, toleranceMinor: 5, withinTolerance: false, currency: 'USD', untaxed: true },
        })}
        lookups={EMPTY_LOOKUPS}
      />,
    );
    const note = screen.getByText(/Der Beleg weist USD\s?0\.65 MWST aus; diese Buchung bucht keine MWST\./);
    expect(note.getAttribute('data-vat')).toBe('note');
    expect(screen.queryByText(/MWST laut Beleg/)).toBeNull();
  });

  it('a receipt VAT in another currency is shown, never compared', () => {
    wrap(
      <EvidenceLines
        line={line()}
        evidence={evidence({
          reasons: ['agrees', 'vat_not_compared'],
          vat: { belegMinor: 120, computedMinor: 142, deltaMinor: 0, toleranceMinor: 5, withinTolerance: true, currency: 'EUR', notCompared: true },
        })}
        lookups={EMPTY_LOOKUPS}
      />,
    );
    expect(screen.getByText(/EUR\s?1\.20 MWST in einer anderen Währung aus; TILL vergleicht sie nicht mit der gerechneten MWST CHF\s?1\.42\./)).toBeTruthy();
  });
});
