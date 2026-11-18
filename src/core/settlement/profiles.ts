/**
 * A43 §2, THE SETTLEMENT TABLE PROFILES: `till-import-profile/v1` entries of kind `settlement_table` (the
 * envelope of A20 §13.4), a typed catalogue that `tableMapping.ts` checks at first use. DATA ONLY: this module
 * imports nothing at runtime, so the catalogue never sits in an import cycle.
 *
 * CLEAN-ROOM. A named profile ships ONLY for a source whose export columns are publicly documented, and it
 * is built from that documentation alone (the URL is on the entry), never from anyone's real export and
 * never from another product's code. Each ships with a SYNTHETIC fixture (`test/settlement/tabular-fixtures/`,
 * invented from scratch) and the label "check on your own export": a source may rename a column, add one,
 * or let a person pick the columns, so the person confirms the mapping on their own file before booking.
 *
 * Sources looked for (15.11.2026):
 *  - Stripe: the itemized "Balance change from activity" report, columns documented per name
 *    (docs.stripe.com/reports/balance) and the `reporting_category` values (docs.stripe.com/reports/reporting-categories).
 *  - Shopify Payments: the transactions export (per payout, or "Items by date"), its eleven columns documented by
 *    Shopify's help centre. It documents no transaction id, so the profile composes one from the order, the type
 *    and the transaction day (A43 §2, event identity: a day column in a composed id is its parsed ISO day).
 *  - SumUp, Twint: no public documentation of the export's columns was found (SumUp names the report and
 *    its contents, Twint names two total columns only), so no named profile ships: the generic profile (a
 *    guess from the headers, which the person corrects and saves) and an agent-drafted mapping cover them.
 *
 * A profile's mapping may name an OPTIONAL column the export carries only sometimes (a column a person adds,
 * a newer export's field): applied to a file without that header, the optional column is dropped, never a
 * mismatch. Its `match.headers` are the columns every such export carries.
 */

import type { SettlementKind } from './format.js';

/** The profile file format (A20 §13.4), shared with the bank statement profiles. */
export const IMPORT_PROFILE_SCHEMA = 'till-import-profile/v1';
export const SETTLEMENT_TABLE_PROFILE_KIND = 'settlement_table';
/** The id of the generic profile: the mapping guessed from the headers. */
export const GENERIC_PROFILE_ID = 'generic';
/** The label every named profile carries. */
export const PROFILE_NOTE = 'check on your own export';

/** A profile's mapping as data (the shape `readTableMapping` reads). */
export interface ProfileMappingData {
  columns: Record<string, string | string[]>;
  kindMap?: Record<string, SettlementKind>;
  kindDefault?: { positive: SettlementKind; negative: SettlementKind };
  vat?: { mode: 'from_template' | 'stated' | 'none' };
  dateFormat?: string;
  decimalSeparator?: '.' | ',';
  feeSign?: 'deducted' | 'signed';
  amountSign?: 'as_stated' | 'by_kind';
  idDayPrecision?: 'day' | 'second';
}

export interface SettlementTableProfileData {
  schema: typeof IMPORT_PROFILE_SCHEMA;
  kind: typeof SETTLEMENT_TABLE_PROFILE_KIND;
  id: string;
  label: string;
  match: { headers: string[] };
  mapping: ProfileMappingData;
  /** The public page the columns were read from. */
  docsUrl: string;
  note: typeof PROFILE_NOTE;
}

export const SETTLEMENT_TABLE_PROFILE_DATA: readonly SettlementTableProfileData[] = [
  {
    schema: IMPORT_PROFILE_SCHEMA,
    kind: SETTLEMENT_TABLE_PROFILE_KIND,
    id: 'stripe_balance_change_itemized',
    label: 'Stripe: Balance change from activity (itemized)',
    // The report's default columns (balance_change_from_activity.itemized).
    match: { headers: ['balance_transaction_id', 'created', 'available_on', 'currency', 'gross', 'fee', 'net', 'reporting_category', 'description'] },
    mapping: {
      columns: {
        id: 'balance_transaction_id',
        day: 'created',
        amount: 'gross',
        fee: 'fee',
        kind: 'reporting_category',
        currency: 'currency',
        description: 'description',
        // Optional columns a person may add to the export.
        counterparty: 'customer_name',
        documentNumber: 'invoice_number',
        payoutId: 'automatic_payout_id',
      },
      kindMap: {
        charge: 'sale',
        refund: 'refund',
        partial_capture_reversal: 'refund',
        fee: 'processing_fee',
        payout: 'bank_payout',
        transfer: 'third_party_payout',
        transfer_reversal: 'third_party_payout_reversal',
        risk_reserved_funds: 'reserve',
        connect_reserved_funds: 'reserve',
        dispute: 'other',
        dispute_reversal: 'other',
        payout_reversal: 'other',
        other_adjustment: 'other',
      },
      kindDefault: { positive: 'sale', negative: 'refund' },
      vat: { mode: 'from_template' },
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      // `gross` is signed (a refund is negative); `fee` is what was paid, net = gross - fee.
      feeSign: 'deducted',
      amountSign: 'as_stated',
    },
    docsUrl: 'https://docs.stripe.com/reports/balance',
    note: PROFILE_NOTE,
  },
  {
    schema: IMPORT_PROFILE_SCHEMA,
    kind: SETTLEMENT_TABLE_PROFILE_KIND,
    id: 'shopify_payments_transactions',
    label: 'Shopify Payments: transactions (by date or per payout)',
    match: { headers: ['Transaction Date', 'Type', 'Order', 'Payout Status', 'Payout Date', 'Available On', 'Amount', 'Fee', 'Net'] },
    mapping: {
      columns: {
        // No transaction id is documented: the order, the type and the transaction time (the day column, parsed, to
        // the second, its zone suffix dropped) compose one, the same in the per-payout and the by-date export.
        id: ['Order', 'Type', 'Transaction Date'],
        day: 'Transaction Date',
        kind: 'Type',
        amount: 'Amount',
        fee: 'Fee',
        documentNumber: 'Order',
        // Optional columns a newer export may carry.
        currency: 'Currency',
        payoutId: 'Payout ID',
      },
      kindMap: {
        charge: 'sale',
        refund: 'refund',
        payout: 'bank_payout',
        adjustment: 'other',
        chargeback: 'other',
        dispute: 'other',
      },
      kindDefault: { positive: 'sale', negative: 'refund' },
      vat: { mode: 'from_template' },
      dateFormat: 'yyyy-mm-dd',
      decimalSeparator: '.',
      // The documented columns do not say how a refund is signed, so the sign follows the kind.
      feeSign: 'deducted',
      amountSign: 'by_kind',
      // L1: the transaction time tells two transactions of one order on one day apart (two partial refunds).
      idDayPrecision: 'second',
    },
    docsUrl: 'https://help.shopify.com/en/manual/payments/shopify-payments/getting-paid-with-shopify-payments/view-payouts/view-details',
    note: PROFILE_NOTE,
  },
];

/** The mapping fields a profile may name optionally (all but the ones every mapping needs). */
export const PROFILE_REQUIRED_FIELDS: readonly string[] = ['day', 'amount'];
