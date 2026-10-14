/**
 * A2, the bank inbox: every refusal answers WHAT happened, WHY, and the ONE fix, in both locales,
 * never in the engine's English. Each code below runs through `explainRefusal` against the real merged
 * catalogues (a missing key throws here instead of rendering as its dotted path), and the facts the
 * engine sends (both amounts, both IBANs, the period, the other line) must reach the sentence.
 */
import { describe, it, expect } from 'vitest';

import { CATALOG, type Locale } from '../../i18n';
import type { Err } from '../../lib/client';
import { camtReasonKey, explainRefusal } from './errors';

function tFor(locale: Locale) {
  return (key: string, params?: Record<string, string | number>): string => {
    const value = key.split('.').reduce<unknown>((node, part) => (typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[part] : undefined), CATALOG[locale]);
    if (typeof value !== 'string') throw new Error(`${locale}: no message at ${key}`);
    return value.replace(/\{(\w+)\}/g, (whole, name: string) => (params !== undefined && name in params ? String(params[name]) : whole));
  };
}

const err = (error: string, extra: Record<string, unknown> = {}): Err => ({ ok: false, error, ...extra }) as Err;

/** Every code the inbox maps, with the facts the engine attaches to it. */
const MAPPED: [string, Record<string, unknown>][] = [
  ['period_locked', { period: '2026-07', kind: 'soft', reason: null }],
  ['line_not_open', { state: 'booked' }],
  ['amount_mismatch', { lineAmountMinor: -4_200, entryAmountMinor: -4_250 }],
  ['claim_off_account', { journalLineId: 'jl_1' }],
  ['transfer_already_booked', { entryId: 'je_7', otherBankAccountId: 'ba_2' }],
  ['already_batched', { vendorBillId: 'vb_1', batchId: 'pb_1' }],
  ['owned_by', { verb: 'reopen_bank_line', bankTxnId: 'bt_9', entryId: 'je_7' }],
  ['use_bank_inbox', { creditId: 'cr_1', bankTxnId: 'bt_9' }],
  ['camt054_refused', { bankAccountId: 'ba_1' }],
  ['amount_mismatch', { batchId: 'pb_1', batchStatus: 'paid', lineAmountMinor: -4_200, batchTotalMinor: -9_000 }],
  ['amount_mismatch', { batchId: 'pb_1', batchStatus: 'paid', itemId: 'pi_1', lineAmountMinor: -4_200, itemAmountMinor: -4_250 }],
  ['transfer_crosses_period', { entryId: 'je_7', entryDate: '2026-09-30', lineDate: '2026-10-01', otherBankTxnId: 'bt_9' }],
  ['entry_already_linked', { bankTxnId: 'bt_9' }],
  ['batch_already_linked', { bankTxnId: 'bt_9' }],
  ['entry_not_on_bank_account', {}],
  ['entry_is_reversal', {}],
  ['entry_reversed', {}],
  ['legs_do_not_sum', { expectedMinor: 120_000, sumMinor: 90_000 }],
  ['direction_mismatch', { lineAmountMinor: -4_200, entryAmountMinor: 4_200 }],
  ['write_off_above_threshold', { writeOffMinor: 12_000, thresholdMinor: 5_000 }],
  ['vat_split_mismatch', {}],
  ['currency_mismatch', { lineCurrency: 'CHF', documentCurrency: 'EUR' }],
  ['currency_mismatch', { lineCurrency: 'EUR', accountCurrency: 'CHF' }],
  ['wrong_direction', { creditDebit: 'CRDT' }],
  ['already_paid', {}],
  ['not_settleable', { status: 'draft' }],
  ['wrong_bank_account', {}],
  ['needs_generation', {}],
  ['batch_discarded', {}],
  ['batch_payments_not_posted', {}],
  ['account_archived', {}],
  ['unknown_tax_code', { taxCode: 'VST-X' }],
  ['rate_era_unknown', {}],
  ['vat_lines_refused', {}],
  ['needs_bank_account', { fileIban: 'CH4431999123000889012' }],
  ['iban_mismatch', { fileIban: 'CH4431999123000889012', accountIban: 'CH5604835012345678009', matchingBankAccountId: 'ba_2', matchingBankAccountName: 'Sparkonto' }],
  ['bank_account_archived', { name: 'Altes Konto' }],
  ['schema_invalid', { reason: 'camt.052 is an intraday report' }],
  ['statement_amended', { changes: ['closing balance changed from 100000 to 100500', 'entry 3 amount changed from 500 to 600'] }],
  ['permission_denied', {}],
  ['cannot_self_approve', {}],
  ['needs_fx_rate', { currency: 'EUR', baseCurrency: 'CHF', date: '2026-07-20' }],
  ['needs_account', {}],
  ['counterparty_merged', { counterpartyId: 'c_1' }],
  ['already_rejected', { actionId: 'act_1' }],
  ['already_executed', { actionId: 'act_1' }],
  ['vorschlag_stale', { actionId: 'act_1', actionTool: 'book_bank_line' }],
  ['entity_not_found', {}],
  ['invalid_input', { field: 'target' }],
  ['transport_error', {}],
  // A36C-2: the successor rule's refusals on an EBICS-fed account (both doors).
  ['gap_refused', { bankAccountId: 'ba_1', statement: { number: 3, year: 2026, fromDate: '2026-10-03', openingBalanceMinor: 100 }, against: { number: 1, year: 2026 }, differenceMinor: 0, reason: 'balance_does_not_chain' }],
  ['overlap_refused', { bankAccountId: 'ba_1', statement: { number: 2, year: 2026, fromDate: '2026-10-02', toDate: '2026-10-02' }, against: { number: 2, year: 2026 } }],
  ['before_feed_start', { bankAccountId: 'ba_1', statement: { number: 1, year: 2026, fromDate: '2026-01-02' }, first: { number: 5, year: 2026 } }],
  ['not_day_end_statement', { bankAccountId: 'ba_1' }],
  ['unsupported_multipage_statement', { bankAccountId: 'ba_1', electronicSeqNb: '7', pageNumber: 1, lastPage: false }],
];

describe('every bank-inbox refusal answers what, why and the fix', () => {
  for (const locale of ['de-CH', 'en'] as const) {
    const t = tFor(locale);
    it.each(MAPPED)(`${locale}: %s has a title and a body in words`, (code, facts) => {
      const r = explainRefusal(t, err(code, facts), { currency: 'CHF', accountName: 'Zürichsee Geschäftskonto' });
      expect(r.unmapped).toBe(false);
      expect(r.title.length).toBeGreaterThan(0);
      expect(r.body ?? '').not.toBe('');
      // No placeholder is left for the reader to decode, and no engine code leaks into the words.
      expect(`${r.title} ${r.body ?? ''}`).not.toMatch(/\{\w+\}/);
      expect(`${r.title} ${r.body ?? ''}`).not.toContain(code);
    });
  }

  it('never offers another date for a locked period (L5): a soft lock points to Perioden', () => {
    const r = explainRefusal(tFor('de-CH'), err('period_locked', { period: '2026-07', kind: 'soft', reason: null }), { currency: 'CHF', lineState: 'open' });
    expect(r.action).toEqual({ kind: 'link', to: '/periods', label: 'Zu den Perioden' });
    expect(r.title).toContain('Juli 2026');
  });

  it('a sealed period (MWST filed, year closed) offers to ignore an open line, and the journal for a decided one', () => {
    for (const reason of ['vat_filed', 'year_close']) {
      const open = explainRefusal(tFor('de-CH'), err('period_locked', { period: '2026-07', kind: 'hard', reason }), { currency: 'CHF', lineState: 'open' });
      expect(open.action).toEqual({ kind: 'ignore' });
      expect(open.body).toContain('Wird anderswo gebucht');
      const booked = explainRefusal(tFor('de-CH'), err('period_locked', { period: '2026-07', kind: 'hard', reason }), { currency: 'CHF', lineState: 'booked' });
      expect(booked.action).toMatchObject({ kind: 'link', to: '/journal' });
    }
  });

  it('names the owner of an entry: another line (show it) or a payment (go to Zahlungen); any other owner goes to the shared banner', () => {
    const line = explainRefusal(tFor('de-CH'), err('owned_by', { verb: 'reopen_bank_line', bankTxnId: 'bt_9' }), { currency: 'CHF' });
    expect(line.action).toEqual({ kind: 'show-line', bankTxnId: 'bt_9' });
    const payment = explainRefusal(tFor('de-CH'), err('owned_by', { verb: 'reverse_payment' }), { currency: 'CHF' });
    expect(payment.action).toMatchObject({ kind: 'link', to: '/payments' });
    expect(explainRefusal(tFor('de-CH'), err('owned_by', { verb: 'void_document' }), { currency: 'CHF' }).unmapped).toBe(true);
  });

  it('offers to match the entry the other side of a transfer already booked', () => {
    const r = explainRefusal(tFor('de-CH'), err('transfer_already_booked', { entryId: 'je_7' }), { currency: 'CHF' });
    expect(r.action).toEqual({ kind: 'match-entry', entryId: 'je_7' });
  });

  it('tells a run line apart: one payment of the run, the whole run, another currency', () => {
    const t = tFor('de-CH');
    const item = explainRefusal(t, err('amount_mismatch', { batchId: 'pb_1', itemId: 'pi_1', lineAmountMinor: -4_200, itemAmountMinor: -4_250 }), { currency: 'CHF' });
    expect(item.title).toBe('Der Betrag passt nicht zur Zahlung im Zahlungslauf.');
    expect(item.body).toContain('42.50');
    const run = explainRefusal(t, err('amount_mismatch', { batchId: 'pb_1', lineAmountMinor: -4_200, batchTotalMinor: -9_000 }), { currency: 'CHF' });
    expect(run.body).toContain('90.00');
    const eur = explainRefusal(t, err('currency_mismatch', { batchId: 'pb_1', lineCurrency: 'CHF', batchCurrency: 'EUR' }), { currency: 'CHF' });
    expect(eur.body).toContain('EUR');
    expect(eur.action).toMatchObject({ kind: 'link', to: '/creditor-payments' });
  });

  it.each([
    ['gap_refused', { statement: { number: 3, year: 2026, fromDate: '2026-10-03' }, against: { number: 1, year: 2026 } }, /^Auszug 3 schliesst nicht an Auszug 1 an\./],
    ['overlap_refused', { statement: { number: 2, year: 2026, fromDate: '2026-10-02' }, against: { number: 2, year: 2026 } }, /^Auszug 2\/2026 vom 02\.10\.2026 überschneidet sich mit Auszug 2\/2026 im Buch\./],
    ['before_feed_start', { statement: { number: 1, year: 2026, fromDate: '2026-01-02' }, first: { number: 5, year: 2026 } }, /^Auszug 1\/2026 liegt vor dem ersten Auszug im Buch\./],
    ['not_day_end_statement', {}, /^Das ist kein Tagesauszug/],
    ['unsupported_multipage_statement', { electronicSeqNb: '7', pageNumber: 1, lastPage: false }, /^Auszug 7 ist auf mehrere Dateien verteilt\./],
  ] as [string, Record<string, unknown>, RegExp][])('A36C-2: %s at the hand door says the rule\'s sentence and links to the bank accounts', (code, facts, sentence) => {
    const r = explainRefusal(tFor('de-CH'), err(code, { bankAccountId: 'ba_1', ...facts }), { currency: 'CHF' });
    expect(r.unmapped).toBe(false);
    expect(r.title).toMatch(sentence);
    expect(`${r.title} ${r.body ?? ''}`).not.toMatch(/versuche es erneut/);
    expect(r.action).toEqual({ kind: 'link', to: '/bank-accounts', label: 'Zu den Bankkonten' });
  });

  it('refuses a camt.054 with the one file TILL reads', () => {
    const r = explainRefusal(tFor('de-CH'), err('camt054_refused'), { currency: 'CHF' });
    expect(`${r.title} ${r.body ?? ''}`).toContain('camt.053');
  });

  it('leaves a refusal only the shared catalogue may word to the shared banner (the newer book, a part-saved call)', () => {
    expect(explainRefusal(tFor('de-CH'), err('schema_newer_than_runtime'), { currency: 'CHF' }).unmapped).toBe(true);
    expect(explainRefusal(tFor('de-CH'), err('line_not_open', { state: 'booked', partial: true }), { currency: 'CHF' }).unmapped).toBe(true);
  });

  it('puts both amounts in the sentence and offers to accept the difference', () => {
    const r = explainRefusal(tFor('de-CH'), err('amount_mismatch', { lineAmountMinor: -4_200, entryAmountMinor: -4_250 }), { currency: 'CHF' });
    expect(r.action).toEqual({ kind: 'accept-difference' });
    const words = `${r.title} ${r.body ?? ''}`;
    expect(words).toContain('42.00');
    expect(words).toContain('42.50');
  });

  it('names the unregistered IBAN and links to creating the Bankkonto', () => {
    const r = explainRefusal(tFor('de-CH'), err('needs_bank_account', { fileIban: 'CH4431999123000889012' }), { currency: 'CHF' });
    expect(`${r.title} ${r.body ?? ''}`).toContain('CH44 3199 9123 0008 8901 2');
    expect(r.action).toMatchObject({ kind: 'link', to: '/bank-accounts?new=1' });
  });

  it('sends a file for another registered account to that account', () => {
    const r = explainRefusal(
      tFor('en'),
      err('iban_mismatch', { fileIban: 'CH4431999123000889012', accountIban: 'CH5604835012345678009', matchingBankAccountId: 'ba_2', matchingBankAccountName: 'Sparkonto' }),
      { currency: 'CHF', accountName: 'Zürichsee Geschäftskonto' },
    );
    expect(r.action).toEqual({ kind: 'import-for', bankAccountId: 'ba_2', name: 'Sparkonto' });
  });

  it('asks for the reason a difference is accepted, and offers to leave a large rest open', () => {
    const missing = explainRefusal(tFor('de-CH'), err('invalid_input', { field: 'target.differenceReason' }), { currency: 'CHF' });
    expect(missing.title).toBe('Sag, warum der Betrag abweicht.');
    expect(missing.action).toEqual({ kind: 'accept-difference' });
    const big = explainRefusal(tFor('de-CH'), err('write_off_above_threshold', { writeOffMinor: 12_000, thresholdMinor: 5_000 }), { currency: 'CHF' });
    expect(big.action).toEqual({ kind: 'leave-open' });
    expect(`${big.title} ${big.body ?? ''}`).toMatch(/120\.00/);
    expect(`${big.title} ${big.body ?? ''}`).toMatch(/50\.00/);
  });

  it('shows the other line when an entry is already matched to one', () => {
    const r = explainRefusal(tFor('de-CH'), err('entry_already_linked', { bankTxnId: 'bt_9' }), { currency: 'CHF' });
    expect(r.action).toEqual({ kind: 'show-line', bankTxnId: 'bt_9' });
  });

  it('falls back to the shared banner (with "Diesen Fehler melden") for a code it does not know', () => {
    const r = explainRefusal(tFor('de-CH'), err('something_new'), { currency: 'CHF' });
    expect(r.unmapped).toBe(true);
  });

  it('sorts the engine\'s camt prose into a cause a person can act on', () => {
    expect(camtReasonKey('camt.052 is an intraday report, import the camt.053')).toBe('camt052');
    expect(camtReasonKey('input is not a non-empty XML document')).toBe('notXml');
    expect(camtReasonKey('the file carries more than one account')).toBe('multipleAccounts');
    expect(camtReasonKey(null)).toBe('unreadable');
  });
});
