/**
 * A41.8 (D193): the MWST cell's one mark. `differs` and `unread` show a glyph whose words (in a real tooltip and the
 * accessible name) say the receipt's VAT and what TILL proposes; `match` and `none` show nothing. The engine decides
 * (`vatCheck`, `receiptVat`); the row only says it. SYNTHETIC DATA ONLY: invented ids and amounts.
 */
import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { I18nProvider } from '../../i18n';
import { VatCheckMark } from './InboxRow';
import type { BankInboxLine } from './model';

const line = (over: Partial<BankInboxLine> = {}): BankInboxLine =>
  ({
    bankTxnId: 'bt_1',
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'open',
    bookingDate: '2026-07-20',
    valueDate: '2026-07-20',
    amountMinor: -10260,
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: 'Wolkenhaus AG', iban: null },
    remittance: { text: null, referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: { target: { kind: 'accounts', legs: [{ accountId: 'acc_4200', amountMinor: 10260, taxCode: 'VST-M' }] }, certainty: 'sure', reasonCode: 'standard', reasonParams: {}, vatCode: 'VST-M' },
    attention: 'sure',
    receiptCount: 0,
    needsReceipt: false,
    standardId: null,
    ruleIds: [],
    followUp: null,
    vorschlagActionId: null,
    belegCandidates: [],
    ...over,
  }) as BankInboxLine;

const receiptVat = (over: Partial<NonNullable<BankInboxLine['receiptVat']>> = {}): NonNullable<BankInboxLine['receiptVat']> => ({
  source: 'candidate',
  captureId: 'cap_1',
  fileId: 'file_1',
  receipts: 1,
  trusted: true,
  covers: true,
  rateBp: 260,
  amountMinor: 260,
  currency: 'CHF',
  comparison: { belegMinor: 260, computedMinor: 769, deltaMinor: -509, toleranceMinor: 5, withinTolerance: false },
  ...over,
});

const wrap = (ui: ReactNode, locale: 'de-CH' | 'en' = 'de-CH') => render(<I18nProvider initialLocale={locale}>{ui}</I18nProvider>);

describe('A41.8: the receipt VAT mark in the MWST cell', () => {
  it('differs: the warn glyph says the receipt rate and figure beside the proposed code and figure', () => {
    wrap(<VatCheckMark line={line({ vatCheck: 'differs', receiptVat: receiptVat() })} />);
    const mark = screen.getByRole('img');
    expect(mark.getAttribute('data-vat-check')).toBe('differs');
    expect(mark.getAttribute('aria-label')).toMatch(/^Beleg 2\.6 % = CHF\s?2\.60, vorgeschlagen VST-M = CHF\s?7\.69$/);
    // A real tooltip, on focus as on hover (never a `title`).
    expect(mark.getAttribute('title')).toBeNull();
    fireEvent.focus(mark);
    expect(screen.getByRole('tooltip').textContent).toMatch(/Beleg 2\.6 % = CHF\s?2\.60/);
  });

  it('differs on an untaxed proposal, and a receipt without VAT beside a taxed one', () => {
    const untaxed = receiptVat({ rateBp: 810, amountMinor: 769, comparison: { belegMinor: 769, computedMinor: 0, deltaMinor: 769, toleranceMinor: 5, withinTolerance: false, untaxed: true } });
    const { unmount } = wrap(<VatCheckMark line={line({ vatCheck: 'differs', receiptVat: untaxed, proposal: null })} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Beleg 8\.1 % = CHF\s?7\.69, vorgeschlagen ohne MWST$/);
    unmount();
    wrap(<VatCheckMark line={line({ vatCheck: 'differs', receiptVat: receiptVat({ rateBp: 0, amountMinor: 0, comparison: { belegMinor: 0, computedMinor: 769, deltaMinor: -769, toleranceMinor: 5, withinTolerance: false } }) })} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Beleg ohne MWST, vorgeschlagen VST-M = CHF\s?7\.69$/);
  });

  it('several receipts are said as several, their VAT summed (critic r3 F3)', () => {
    const two = receiptVat({ receipts: 2, rateBp: null, amountMinor: 520, covers: false, comparison: { belegMinor: 520, computedMinor: 769, deltaMinor: -249, toleranceMinor: 5, withinTolerance: false } });
    wrap(<VatCheckMark line={line({ vatCheck: 'differs', receiptVat: two })} />);
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^2 Belege, zusammen CHF\s?5\.20, vorgeschlagen VST-M = CHF\s?7\.69$/);
  });

  it('unread: the neutral glyph says the figures are not confirmed', () => {
    wrap(<VatCheckMark line={line({ vatCheck: 'unread', receiptVat: receiptVat({ trusted: false, comparison: null }) })} />, 'en');
    const mark = screen.getByRole('img');
    expect(mark.getAttribute('data-vat-check')).toBe('unread');
    expect(mark.getAttribute('aria-label')).toContain('not confirmed');
  });

  it('match and none show nothing', () => {
    const { container, unmount } = wrap(<VatCheckMark line={line({ vatCheck: 'match', receiptVat: receiptVat() })} />);
    expect(container.querySelector('[data-vat-check]')).toBeNull();
    unmount();
    const none = wrap(<VatCheckMark line={line({ vatCheck: 'none', receiptVat: null })} />);
    expect(none.container.querySelector('[data-vat-check]')).toBeNull();
    // A line from before A41.8 carries no field at all.
    none.unmount();
    expect(wrap(<VatCheckMark line={line()} />).container.querySelector('[data-vat-check]')).toBeNull();
  });
});
