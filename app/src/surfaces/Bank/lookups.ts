/**
 * The option reads the inbox names things with, indexed once, and the words a target reads as.
 *
 * A proposal names ids (an account, an invoice, an entry); a person reads numbers and names. Every
 * label is resolved here from the workspace's own records, and a record the Studio could not load
 * (an invoice already settled, a list refused by a role) falls back to the facts the engine attached
 * to the proposal (`reasonParams`), never to an id on screen.
 */
import { formatDate, formatMoney } from '../../i18n';
import type {
  BankAccountOption,
  BankInboxLine,
  BillOption,
  ChartAccount,
  DraftTarget,
  InvoiceOption,
  LineVorschlag,
  TaxCode,
} from './model';
import { isCredit, lineDate } from './model';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface Lookups {
  chart: ChartAccount[];
  chartById: ReadonlyMap<string, ChartAccount>;
  chartByNumber: ReadonlyMap<string, ChartAccount>;
  taxCodes: TaxCode[];
  taxByCode: ReadonlyMap<string, TaxCode>;
  invoices: InvoiceOption[];
  invoiceById: ReadonlyMap<string, InvoiceOption>;
  bills: BillOption[];
  billById: ReadonlyMap<string, BillOption>;
  bankAccounts: BankAccountOption[];
  bankById: ReadonlyMap<string, BankAccountOption>;
  /** Pending agent proposals, per bank line. */
  vorschlaege: ReadonlyMap<string, LineVorschlag[]>;
  /** The stored dial level per capability, when the actor may read the dial. */
  dial: Readonly<Record<string, string>> | null;
}

export function buildLookups(input: {
  chart: ChartAccount[];
  taxCodes: TaxCode[];
  invoices: InvoiceOption[];
  bills: BillOption[];
  bankAccounts: BankAccountOption[];
  vorschlaege: LineVorschlag[];
  dial: Readonly<Record<string, string>> | null;
}): Lookups {
  const byLine = new Map<string, LineVorschlag[]>();
  for (const v of input.vorschlaege) byLine.set(v.bankTxnId, [...(byLine.get(v.bankTxnId) ?? []), v]);
  return {
    ...input,
    chartById: new Map(input.chart.map((a) => [a.id, a])),
    chartByNumber: new Map(input.chart.map((a) => [a.number, a])),
    taxByCode: new Map(input.taxCodes.map((c) => [c.code, c])),
    invoiceById: new Map(input.invoices.map((i) => [i.documentId, i])),
    billById: new Map(input.bills.map((b) => [b.vendorBillId, b])),
    bankById: new Map(input.bankAccounts.map((b) => [b.id, b])),
    vorschlaege: byLine,
  };
}

export const EMPTY_LOOKUPS: Lookups = buildLookups({
  chart: [],
  taxCodes: [],
  invoices: [],
  bills: [],
  bankAccounts: [],
  vorschlaege: [],
  dial: null,
});

/** "6510 Telefon und Internet", or '' for an account the chart does not hold. */
export function accountLabel(l: Lookups, accountId: string): string {
  const a = l.chartById.get(accountId);
  return a === undefined ? '' : `${a.number} ${a.name}`;
}

/** The counterparty a person recognises the line by: the name, else the remittance, else the reference. */
export function partyOf(t: T, line: BankInboxLine): string {
  return line.counterparty.name ?? line.remittance.text ?? line.entryRef ?? t('bankInbox.row.unnamed');
}

/**
 * The second words of a row: the remittance text (else the reference) when a NAME leads. When the
 * line has no name, the remittance text or the bank's entry reference already leads, and repeating
 * it would read twice.
 */
export function detailOf(line: BankInboxLine): string {
  if (line.counterparty.name === null) return '';
  return line.remittance.text ?? line.remittance.referenceValue ?? '';
}

/** A count-dependent key: `<key>.one` for one, `<key>.other` for every other count. */
export function plural(t: T, key: string, count: number, params: Record<string, string | number> = {}): string {
  return t(`${key}.${count === 1 ? 'one' : 'other'}`, { count, ...params });
}

/** A trigger's two halves: the code (bold) and the name. */
export interface TargetParts {
  code: string;
  name: string;
}

const p = (line: BankInboxLine): Record<string, unknown> => (line.proposal?.reasonParams ?? {}) as Record<string, unknown>;
const sp = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

export function targetParts(t: T, l: Lookups, line: BankInboxLine, target: DraftTarget | null): TargetParts {
  if (target === null) return { code: '', name: '' };
  switch (target.kind) {
    case 'accounts': {
      if (target.legs.length > 1) return { code: '', name: t('bankInbox.target.split', { count: target.legs.length }) };
      const a = l.chartById.get(target.legs[0]?.accountId ?? '');
      return a === undefined ? { code: '', name: t('bankInbox.target.unknownAccount') } : { code: a.number, name: a.name };
    }
    case 'open_item': {
      if (isCredit(line)) {
        const inv = l.invoiceById.get(target.documentId);
        const params = p(line);
        const number = inv?.number ?? (params.documentId === target.documentId ? sp(params.documentNumber) : null);
        const contact = inv?.contactName ?? (params.documentId === target.documentId ? sp(params.contactName) : null);
        return { code: number ?? t('bankInbox.target.invoice'), name: contact ?? t('bankInbox.target.invoiceName') };
      }
      const bill = l.billById.get(target.documentId);
      return { code: bill?.reference ?? t('bankInbox.target.bill'), name: bill?.vendorName ?? t('bankInbox.target.billName') };
    }
    case 'payment_batch':
      return { code: t('bankInbox.target.batchCode'), name: t('bankInbox.target.batch') };
    case 'existing_entry': {
      const params = p(line);
      const same = params.entryId === target.entryId;
      const date = target.entryDate ?? (same ? sp(params.entryDate) : null);
      const description = target.entryText ?? (same ? sp(params.description) : null);
      return {
        code: date === null ? '' : formatDate(date),
        name: description ?? t('bankInbox.target.entry'),
      };
    }
  }
}

/** The date of an existing-entry target, when the proposal or the pick named it. */
export function entryDateOf(line: BankInboxLine, target: DraftTarget): string | null {
  if (target.kind !== 'existing_entry') return null;
  const params = p(line);
  return target.entryDate ?? (params.entryId === target.entryId ? sp(params.entryDate) : null);
}

/** The whole target as one phrase, for sentences ("auf 6510 Telefon und Internet"). */
export function targetPhrase(t: T, l: Lookups, line: BankInboxLine, target: DraftTarget | null): string {
  const parts = targetParts(t, l, line, target);
  return [parts.code, parts.name].filter((s) => s !== '').join(' ');
}

/** "Vorsteuer Material (VST-M)" or "ohne MWST". */
export function taxPhrase(t: T, l: Lookups, code: string): string {
  if (code === '') return t('bankInbox.vat.none');
  const c = l.taxByCode.get(code);
  return c === undefined ? code : t('bankInbox.vat.phrase', { label: c.label, code: c.code });
}

/**
 * The sentence behind a proposal's reason code, filled from its params and the workspace's records.
 * The engine returns no prose (P11); every code has a sentence in both locales.
 */
export function reasonSentence(t: T, l: Lookups, line: BankInboxLine): string {
  const proposal = line.proposal;
  if (proposal === null) return '';
  const params = proposal.reasonParams as Record<string, unknown>;
  const currency = line.currency;
  const money = (v: unknown) => (typeof v === 'number' ? formatMoney(v, currency) : '');
  const date = (v: unknown) => (typeof v === 'string' && v.length >= 10 ? formatDate(v) : '');
  const account = (v: unknown) => (typeof v === 'string' ? accountLabel(l, v) : '');
  const vat = (v: unknown) => (typeof v === 'string' && v.length > 0 ? t('bankInbox.reason.withVat', { vat: taxPhrase(t, l, v) }) : t('bankInbox.reason.withoutVat'));
  switch (proposal.reasonCode) {
    case 'existing_entry_reference':
      return t('bankInbox.reason.existing_entry_reference', { date: date(params.entryDate), description: sp(params.description) ?? t('bankInbox.target.entry') });
    case 'existing_entry_amount_date': {
      const days = Number(params.daysApart ?? 0);
      const base = days === 0 ? t('bankInbox.reason.existing_entry_same_day', { date: date(params.entryDate) }) : plural(t, 'bankInbox.reason.existing_entry_amount_date', days, { date: date(params.entryDate), days });
      const count = Number(params.candidates ?? 1);
      return count > 1 ? `${base} ${t('bankInbox.reason.candidates', { count })}` : base;
    }
    case 'qr_reference_exact':
      return t('bankInbox.reason.qr_reference_exact', { number: sp(params.documentNumber) ?? t('bankInbox.target.invoice'), contact: sp(params.contactName) ?? '' });
    case 'qr_reference_amount_differs':
      return t('bankInbox.reason.qr_reference_amount_differs', {
        number: sp(params.documentNumber) ?? t('bankInbox.target.invoice'),
        contact: sp(params.contactName) ?? '',
        delta: money(typeof params.deltaMinor === 'number' ? Math.abs(params.deltaMinor) : null),
      });
    case 'payment_batch_reference':
      return t('bankInbox.reason.payment_batch_reference', { total: money(params.batchTotalMinor) });
    case 'payment_batch_total_differs':
      // Re-critic L2: a run already marked paid cannot be discarded; its way out differs.
      return t(params.batchStatus === 'paid' ? 'bankInbox.reason.payment_batch_total_differs_paid' : 'bankInbox.reason.payment_batch_total_differs', {
        batch: money(params.batchTotalMinor),
        line: money(params.lineAmountMinor),
      });
    case 'payment_batch_item':
      return t('bankInbox.reason.payment_batch_item', { amount: money(params.itemAmountMinor) });
    case 'payment_batch_item_amount_differs':
      return t(params.batchStatus === 'paid' ? 'bankInbox.reason.payment_batch_item_amount_differs_paid' : 'bankInbox.reason.payment_batch_item_amount_differs', {
        item: money(params.itemAmountMinor),
        line: money(params.lineAmountMinor),
      });
    case 'vendor_bill_reference':
    case 'vendor_bill_amount': {
      const bill = l.billById.get(sp(params.documentId) ?? '');
      return t(`bankInbox.reason.${proposal.reasonCode}`, { number: bill?.reference ?? t('bankInbox.target.bill'), vendor: bill?.vendorName ?? '' });
    }
    case 'own_account_transfer': {
      const other = l.bankById.get(sp(params.otherBankAccountId) ?? '');
      return t('bankInbox.reason.own_account_transfer', { name: other?.name ?? account(params.accountId) });
    }
    case 'own_account_transfer_booked': {
      // The transfer is already on the books from the other account's side: match it, do not book twice.
      const other = l.bankById.get(sp(params.otherBankAccountId) ?? '');
      const days = Number(params.daysApart ?? 0);
      const name = other?.name ?? t('bankInbox.target.otherAccount');
      // Re-critic L3: side one is booked in another month, so nothing is offered to book (the match refuses).
      if (params.crossesMonth === true) return t('bankInbox.reason.own_account_transfer_booked_other_month', { name, date: date(params.entryDate) });
      return days === 0
        ? t('bankInbox.reason.own_account_transfer_booked_same_day', { name, date: date(params.entryDate) })
        : plural(t, 'bankInbox.reason.own_account_transfer_booked', days, { name, date: date(params.entryDate), days });
    }
    case 'history':
      return t('bankInbox.reason.history', { date: date(params.lastDate), account: account(params.accountId), vat: vat(params.taxCode), count: Number(params.count ?? 1) });
    case 'no_proposal':
      return t('bankInbox.reason.no_proposal');
    default:
      return '';
  }
}

/** The date a person reads for a line, in full. */
export function lineDateLong(line: BankInboxLine): string {
  const d = lineDate(line);
  return d === null ? '' : formatDate(d);
}
