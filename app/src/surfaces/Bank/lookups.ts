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
  BatchOption,
  BankInboxLine,
  BankStandard,
  BillOption,
  ChartAccount,
  DraftTarget,
  InvoiceOption,
  LineVorschlag,
  TaxCode,
} from './model';
import { formatIban, isCredit, lineDate, proposalRuleId, ruleAsksOf, ruleComputedOf, severalRuleIds, taxCodeOnChoosing, vatCanApply, vatNeverApplies } from './model';
import { routeInWords, ruleName } from './rules';

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
  /** D167: the live standards per counterparty and direction (`list_bank_standards`), by id. */
  standardById: ReadonlyMap<string, BankStandard>;
  /** D177: the generated payment runs a money-out line can settle (the picker's "Zahlungsläufe"). */
  batches: BatchOption[];
}

export function buildLookups(input: {
  chart: ChartAccount[];
  taxCodes: TaxCode[];
  invoices: InvoiceOption[];
  bills: BillOption[];
  bankAccounts: BankAccountOption[];
  vorschlaege: LineVorschlag[];
  dial: Readonly<Record<string, string>> | null;
  standards?: BankStandard[];
  batches?: BatchOption[];
}): Lookups {
  const byLine = new Map<string, LineVorschlag[]>();
  for (const v of input.vorschlaege) byLine.set(v.bankTxnId, [...(byLine.get(v.bankTxnId) ?? []), v]);
  const { standards = [], batches = [], ...rest } = input;
  return {
    ...rest,
    batches,
    standardById: new Map(standards.map((x) => [x.id, x])),
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

/**
 * Whether a one-leg booking shows its MWST picker (B2). A leg that CARRIES a code always shows it, on any
 * account, so the person sees the code and can clear it to "Ohne MWST": nothing hidden ever carries a
 * value (critic R2-2: a history proposal on 1170 with VST-M otherwise booked VAT on top of a VAT leg,
 * unseen). A leg without a code shows the picker only where a code can apply (`vatCanApply`), never on a
 * VAT account or a Bankkonto's ledger account.
 */
export function vatPickerShows(l: Lookups, leg: { accountId: string; taxCode: string }): boolean {
  if (leg.taxCode !== '') return true;
  const account = l.chartById.get(leg.accountId);
  if (account === undefined) return false;
  const bankLedgers = bankLedgersOf(l);
  if (vatNeverApplies(account, bankLedgers)) return false;
  return vatCanApply(account, bankLedgers);
}

/** Every Bankkonto's own ledger account: never a VAT target. */
export function bankLedgersOf(l: Lookups): ReadonlySet<string> {
  return new Set(l.bankAccounts.map((b) => b.ledgerAccountId).filter((id): id is string => id !== null));
}

/** The code a leg takes when the person chooses its account (`taxCodeOnChoosing` with this register). */
export function taxCodeFor(l: Lookups, accountId: string, held: string): string {
  return taxCodeOnChoosing(l.chartById.get(accountId), held, bankLedgersOf(l));
}

/** A posted entry as the Details panel says it: one Buchungssatz, and the whole of it when the line is cut. */
export interface Satz {
  short: string;
  full: string;
  truncated: boolean;
}

/**
 * A posted entry's stored lines as ONE Buchungssatz, Soll an Haben ("6510 83.16 · 1170 6.74 an 1020
 * 89.90"), read straight off the entry (nothing recomputed). A compound entry keeps at most `perSide`
 * accounts a side and names the rest as "+n"; `full` carries every line for the tooltip.
 */
export function satzOf(t: T, l: Lookups, lines: readonly { account: string; debit: number; credit: number }[], currency: string, perSide = 2): Satz {
  const bare = (m: number) => formatMoney(m, currency).slice(currency.length + 1);
  const part = (x: { account: string }, amount: number) => `${l.chartById.get(x.account)?.number ?? t('bankInbox.legs.unknownAccount')} ${bare(amount)}`;
  const debit = lines.filter((x) => x.debit > 0).map((x) => part(x, x.debit));
  const credit = lines.filter((x) => x.credit > 0).map((x) => part(x, x.credit));
  const side = (parts: string[]) =>
    parts.length <= perSide ? parts.join(' · ') : `${parts.slice(0, perSide).join(' · ')} ${t('bankInbox.details.satzMore', { count: parts.length - perSide })}`;
  const truncated = debit.length > perSide || credit.length > perSide;
  return {
    short: t('bankInbox.details.satz', { debit: side(debit), credit: side(credit) }),
    full: t('bankInbox.details.satz', { debit: debit.join(' · '), credit: credit.join(' · ') }),
    truncated,
  };
}

/**
 * D167 polish 10: what a booked line went to, in words for its one row: "auf 6570 Informatik, Software und
 * Lizenzen · Vorsteuer 8.1 %" (the entry's main leg and its code), or "aufgeteilt auf 3 Konten". The main
 * legs are the entry's lines off the Bankkonto ledgers and off the MWST accounts. Null when the entry has
 * none (the row then keeps its kind in words).
 */
export function bookedToPhrase(
  t: T,
  l: Lookups,
  lines: readonly { account: string; taxCode?: string | null }[],
  vatName: (code: string) => string | null,
): string | null {
  const ledgers = bankLedgersOf(l);
  const main = lines.filter((x) => {
    const a = l.chartById.get(x.account);
    return a === undefined ? !ledgers.has(x.account) : !vatNeverApplies(a, ledgers);
  });
  const accounts = [...new Set(main.map((x) => x.account))];
  if (accounts.length === 0) return null;
  if (accounts.length > 1) return plural(t, 'bankInbox.decided.bookedSplit', accounts.length);
  const label = accountLabel(l, accounts[0] as string) || t('bankInbox.legs.unknownAccount');
  const code = main.find((x) => typeof x.taxCode === 'string' && x.taxCode !== '')?.taxCode ?? '';
  const vat = code === '' ? null : vatName(code);
  return vat === null ? t('bankInbox.decided.bookedTo', { account: label }) : t('bankInbox.decided.bookedToVat', { account: label, vat });
}

/** "6510 Telefon und Internet", or '' for an account the chart does not hold. */
export function accountLabel(l: Lookups, accountId: string): string {
  const a = l.chartById.get(accountId);
  return a === undefined ? '' : `${a.number} ${a.name}`;
}

/**
 * The counterparty a person recognises the line by: the name; without one the counterparty's IBAN
 * (critic F7: a credit with only an IBAN was otherwise "Bankzeile ohne Namen"), else the remittance,
 * else the bank's entry reference.
 */
export function partyOf(t: T, line: BankInboxLine): string {
  // B5 judge: a blank name or text is no name (rows read "H.." beside nothing); the bank's own description
  // of the line (D178 facts) is the next best words before the entry reference.
  const words = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const name = words(line.counterparty.name);
  if (name !== null) return name;
  if (words(line.counterparty.iban) !== null) return formatIban(line.counterparty.iban as string);
  const facts = (line as BankInboxLine & { facts?: { bankText?: string | null } | null }).facts;
  return words(line.remittance.text) ?? words(facts?.bankText) ?? words(line.entryRef) ?? t('bankInbox.row.unnamed');
}

/**
 * The second words of a row: the remittance text (else the reference) when a NAME or an IBAN leads.
 * When neither does, the remittance text or the bank's entry reference already leads, and repeating it
 * would read twice.
 */
export function detailOf(line: BankInboxLine): string {
  if (line.counterparty.name === null && line.counterparty.iban === null) return '';
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
    case 'rule':
      // D175: a rule reads by its name; its legs are in the Details' preview.
      return { code: '', name: ruleName(t, l.standardById.get(target.standardId)) };
    case 'ignore':
      // D176: "Nicht buchen: Anderswo gebucht".
      return { code: '', name: t('bankInbox.target.ignore', { reason: t(`bankInbox.ignore.reason.${target.reason}.label`) }) };
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
    case 'allocations': {
      // D178 E3: "2 Rechnungen" and the contact they belong to.
      const first = target.allocations[0]?.documentId ?? '';
      const party = isCredit(line) ? l.invoiceById.get(first)?.contactName : l.billById.get(first)?.vendorName;
      return {
        code: plural(t, isCredit(line) ? 'bankInbox.target.invoices' : 'bankInbox.target.bills', target.allocations.length),
        name: party ?? t(isCredit(line) ? 'bankInbox.target.invoiceName' : 'bankInbox.target.billName'),
      };
    }
    case 'contact':
      return { code: t('bankInbox.target.contactCode'), name: target.contactName ?? t('bankInbox.target.contact') };
    case 'expense_claims':
      return { code: t('bankInbox.target.claimsCode'), name: plural(t, 'bankInbox.target.claims', target.claimIds.length) };
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
  // A string, not the engine's union: the D167 codes (`standard`, `journal_history`) land with its branch.
  const code: string = proposal.reasonCode;
  switch (code) {
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
      return t(`bankInbox.reason.${code}`, { number: bill?.reference ?? t('bankInbox.target.bill'), vendor: bill?.vendorName ?? '' });
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
    case 'standard': {
      // D167: the person's own standard. On a line outside the book's base currency the engine drops the
      // standard's MWST code (`book_bank_line` refuses VAT there) and reads `check`, so the sentence says
      // that and why (critic D167-8): no MWST can be booked on a line in a foreign currency.
      if (params.vatDropped === true) {
        return t('bankInbox.reason.standardVatDropped', { account: account(params.accountId), vat: taxPhrase(t, l, typeof params.taxCode === 'string' ? params.taxCode : ''), currency });
      }
      // D175: a rule that splits or routes says its name and its route, never one account it is not.
      const rule = l.standardById.get(proposalRuleId(line) ?? '');
      if (rule !== undefined && (rule.legs.length > 1 || rule.viaAccountId !== null)) {
        return t('bankInbox.reason.rule', { name: ruleName(t, rule), route: routeInWords(t, l, rule) });
      }
      return t('bankInbox.reason.standard', { account: account(params.accountId), vat: vat(params.taxCode) });
    }
    case 'rule_needs_amount': {
      // D175: one rule fits and asks for what the line cannot say ("Bruttoumsatz"); the rest is the engine's.
      const rule = l.standardById.get(proposalRuleId(line) ?? '');
      const asks = ruleAsksOf(line)
        .map((a) => (a.label !== '' ? a.label : t('bankInbox.rules.askFallback')))
        .join(', ');
      return t('bankInbox.reason.rule_needs_amount', { name: ruleName(t, rule), asks });
    }
    case 'rule_computed': {
      // D177: the rule's computed legs, by label and figure ("Bruttoumsatz 90.80").
      const rule = l.standardById.get(proposalRuleId(line) ?? '');
      const asks = ruleComputedOf(line)
        .map((c) => `${c.label !== '' ? c.label : t('bankInbox.rules.askFallback')} ${formatMoney(c.amountMinor, currency)}`)
        .join(', ');
      return t('bankInbox.reason.rule_computed', { name: ruleName(t, rule), asks });
    }
    case 'several_rules':
      // D175 point 4: two rules fit, or the counterparty has rules and no rule's text decides.
      return t('bankInbox.reason.several_rules', { count: Math.max(severalRuleIds(line).length, 2) });
    case 'rule_ignore': {
      // D176: the person's "Nicht buchen" rule: its name and its reason; the line never reaches the ledger.
      const rule = l.standardById.get(proposalRuleId(line) ?? '');
      const reason = typeof params.reason === 'string' ? t(`bankInbox.ignore.reason.${params.reason}.label`) : '';
      return t('bankInbox.reason.rule_ignore', { name: ruleName(t, rule), reason });
    }
    case 'journal_history':
      return t('bankInbox.reason.journal_history', { date: date(params.date), account: account(params.accountId), vat: vat(params.taxCode) });
    case 'model_suggested':
      // D144: a model's choice among code-built candidates, recorded before it was shown; always `check`.
      return t('bankInbox.reason.model_suggested', {
        account: account(params.accountId),
        percent: modelPercent(params.probability),
        count: Number(params.candidates ?? 0),
      });
    case 'no_proposal':
      return t('bankInbox.reason.no_proposal');
    default:
      return '';
  }
}

/**
 * The model rung's reason in ONE sentence (B2; since D177 the Woher line's tooltip), carrying every word D144 asks for:
 * a model, on this device, its probability, its MEASURED calibration error (ECE), and that nobody has
 * checked it. A decision recorded without a measured error says so rather than inventing one.
 */
export function modelStripSentence(t: T, line: BankInboxLine): string {
  const params = (line.proposal?.reasonParams ?? {}) as Record<string, unknown>;
  const model = typeof params.modelRef === 'string' ? params.modelRef : '';
  const percent = modelPercent(params.probability);
  const ece = params.ece;
  if (typeof ece !== 'number' || !Number.isFinite(ece)) return t('bankInbox.details.modelNoEce', { model, percent });
  return t('bankInbox.details.model', { model, percent, ece: String(Math.round(ece * 1000) / 10) });
}

/** A model probability as a whole percent ("82"), never rounded up to a certainty it did not state. */
export function modelPercent(p: unknown): string {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '';
  // The 1e-9 absorbs binary noise (0.29 * 100 is 28.999...); it never lifts a figure to the next percent.
  return String(Math.min(99, Math.floor(p * 100 + 1e-9)));
}

/** The date a person reads for a line, in full. */
export function lineDateLong(line: BankInboxLine): string {
  const d = lineDate(line);
  return d === null ? '' : formatDate(d);
}
