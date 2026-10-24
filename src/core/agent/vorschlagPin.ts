/**
 * WHAT YOU APPROVED IS WHAT RUNS (critic N1, orchestrator ruling 11.10.2026): the content pin on a
 * drafted action.
 *
 * A Vorschlag stores the verb and its INPUT, and approving replays that input. For most governed verbs
 * the input names a record (`issue_invoice {invoiceId}`, `po_send {poId}`, `issue_dunning_run
 * {runId}`), so the replay acted on whatever that record held at approval time, not on what the
 * person saw. Measured: an agent proposed issuing a CHF 1,000 draft, rewrote the draft to CHF 99,999
 * through the ungoverned `update_document`, and the person's approval issued and posted CHF 99,999.
 *
 * THE PIN. When a Vorschlag is drafted for a verb in `PIN_FOR_VERB`, the records its input names are
 * read (tenant-scoped, content columns only, with their lines) TOGETHER WITH EVERY ROW THE ACT READS
 * LIVE when it executes (critic round 2, R2-B1/R2-B2): the counterparty contact (the email a send goes
 * to and the address a letter prints), the tax-code rows behind every line's code (the rate the VAT is
 * computed at), the items behind the lines (revenue account, cost, tracking), the employee and payee
 * behind an expense claim, the dunning configuration (fees, fee account, fee tax code), and so on.
 * All of it is reduced to one sha256 over a canonical JSON and stored on the `agent_action` row beside
 * the key figures the card shows (`VorschlagFigures`). At approval the digest is computed again; a
 * mismatch refuses `vorschlag_stale`, runs nothing, and marks the row `stale`.
 *
 * CONTENT COLUMNS, NOT WHOLE ROWS. Each record and each dependency lists the columns that ARE the
 * content of the act. Lifecycle columns a governed act writes itself (status, number, posted entry,
 * sent or generated stamps, recomputed VAT totals) are left out, so approving `issue_invoice` does not
 * make a pending `send_invoice` on the same invoice stale.
 *
 * THE CLASS IS HELD BY CONSTRUCTION, NOT BY REVIEW. `test/agent/vorschlag-pin.test.mjs` traces the
 * SQL every governed verb runs while its approval replays, and every table it reads that a FREE
 * (ungoverned) verb can change must be covered by the verb's pin (`pinnedTablesFor`), be classified
 * in `LIVE_READ_TABLES` with a reason why a free change cannot alter the act, or carry a per-verb
 * reason in `LIVE_READ_WAIVERS`. A new live read of a freely mutable table fails the suite.
 */

import { createHash } from 'node:crypto';
import type { WorkspaceContext } from '../context.js';
import { computeLineTax } from '../vat/applyVat.js';
import { dueDateFor } from '../setup/paymentTerms.js';

type Row = Record<string, unknown>;

/** One child table read with its parent (the lines of a document, the items of a run). */
interface ChildSpec {
  readonly table: string;
  /** The column naming the parent row. */
  readonly fk: string;
  /** The content columns of a line. */
  readonly columns: readonly string[];
  /** The column the lines are ordered by (`id` breaks ties), so the digest never depends on rowid. */
  readonly order: string;
}

/**
 * Where a dependency's keys come from: a column of the record row, a column of one of its child
 * tables (every line), or, for a nested dependency, a column of the parent dependency's rows. D175
 * (critic D175-C2): or a field of every element of a JSON array stored in a column of the record row
 * (a Buchungsregel's `legs_json[].taxCode`), so what a stored recipe names is pinned like a child line.
 */
type KeySource =
  | { readonly row: string }
  | { readonly child: string; readonly column: string }
  | { readonly json: string; readonly field: string };

/**
 * A row set the act reads LIVE when it executes. `key` is the column of `table` the collected keys are
 * matched against (inside the workspace), so EVERY row under a key is read: a tax code's every
 * validity version, a new version inserted after the proposal included.
 */
export interface DepSpec {
  readonly table: string;
  readonly key: string;
  readonly from: KeySource;
  readonly columns: readonly string[];
  readonly deps?: readonly DepSpec[];
  /** The workspace row itself (no `workspace_id` column): read by the context's own tenant id. */
  readonly self?: true;
}

/** Where a figure on the card comes from. Every field is optional: an absent figure is not shown. */
interface FigureSpec {
  /** The record's own number, assigned when it is issued, sent or posted (a draft has none yet). */
  readonly number?: string;
  /** The counterparty: a contact id on the row, or on every line (a dunning run's debtors). */
  readonly contact?: KeySource;
  /** The amount column, on the row or summed over the first child table. */
  readonly amount?: { readonly column: string; readonly from: 'row' | 'children'; readonly basis: 'net' | 'amount' };
  /** The currency column (row or first child), or a fixed currency where the record is CHF base. */
  readonly currency?: { readonly column: string; readonly from: 'row' | 'children' } | { readonly fixed: string };
  /** Count the rows of the first child table as the card's "lines". */
  readonly countLines?: boolean;
  /** The VAT the act will compute: per line through `computeLineTax`, the issue path's own function. */
  readonly vatPreview?: {
    readonly amount: string;
    readonly taxCode: string;
    readonly supplyDate: string;
    /** D164: the record's own date column a line without a date of its own is priced at (`lineSupplyDate`). */
    readonly documentSupplyDate?: string;
  };
  /** VAT and gross stored on the row itself (a vendor bill carries both). */
  readonly vatColumns?: { readonly tax: string; readonly gross: string };
}

export interface RecordSpec {
  readonly table: string;
  /** The column the pinned id is matched against (`id`, or `workspace_id` for a workspace setting). */
  readonly idColumn?: string;
  /** Every row under the id is read (a tax code's validity versions, a workspace's codes). */
  readonly many?: boolean;
  /** The workspace row itself (no `workspace_id` column): read by the context's own tenant id. */
  readonly self?: boolean;
  /** The content columns of the record itself, digested in this order. */
  readonly columns: readonly string[];
  readonly children?: readonly ChildSpec[];
  /** What the act reads live beside the record. */
  readonly deps?: readonly DepSpec[];
  readonly figures?: FigureSpec;
  /**
   * Rewrites the digested row so a column the act itself fills reads the same before and after the
   * act (D163: the due date an issue derives). Runs on the tenant-scoped row; reads only inside it.
   */
  readonly normalize?: (ctx: WorkspaceContext, row: Row) => Row;
}

// --- the dependency building blocks -----------------------------------------------------------------

/**
 * A contact as an act consumes it: who it is, where a letter goes, which email a send goes to, in
 * which language. The CRM tags (`roles`, `segments`) are not content of any act and stay out.
 */
const CONTACT_COLUMNS = [
  'party_role', 'name', 'address_street', 'address_house_no', 'address_zip', 'address_city', 'address_country',
  'vat_number', 'email', 'default_currency', 'payment_terms_days', 'archived', 'kind', 'company_contact_id', 'lang', 'merged_into_id',
] as const;
const contactVia = (from: KeySource): DepSpec => ({ table: 'contact', key: 'id', from, columns: CONTACT_COLUMNS });

/** Every validity version of a tax code: kind, rate, method, form line, active flag, start date. */
const TAX_CODE_COLUMNS = ['code', 'kind', 'rate_bp', 'method', 'esa_form_line', 'active', 'valid_from'] as const;
/** D175: what a Buchungsregel booking reads of an account it moves (a leg's or the Durchlaufkonto). */
const RULE_ACCOUNT_COLUMNS = ['id', 'number', 'type', 'archived'] as const;
const taxCodeVia = (from: KeySource): DepSpec => ({ table: 'tax_code', key: 'code', from, columns: TAX_CODE_COLUMNS });

/** An item as an act consumes it: revenue account, default code, cost, stock tracking. */
const ITEM_COLUMNS = ['name', 'default_tax_code', 'revenue_account_id', 'archived', 'kind', 'cost_price_minor', 'track_stock', 'tracking_mode', 'unit'] as const;
const itemVia = (from: KeySource): DepSpec => ({ table: 'item', key: 'id', from, columns: ITEM_COLUMNS });

/**
 * Critic round 3 (N1): who the books belong to, as an issued invoice, its QR-bill, a reminder, a
 * delivery note, a purchase order or a pain.001 file PRINTS it. The free branches of
 * update_company_profile (name, legal form, UID) and set_creditor_profile (payee name and address) change
 * these without a Vorschlag, so an act that renders or transmits pins them.
 */
export const WORKSPACE_IDENTITY_COLUMNS = ['name', 'legal_form', 'uid', 'mwst_no', 'creditor_name', 'creditor_address', 'creditor_iban', 'email_relay'] as const;
const WORKSPACE_IDENTITY: DepSpec = { table: 'workspace', key: 'id', from: { row: 'workspace_id' }, self: true, columns: WORKSPACE_IDENTITY_COLUMNS };

const DOCUMENT_LINES: ChildSpec = {
  table: 'document_line',
  fk: 'document_id',
  columns: ['position', 'item_id', 'description', 'quantity_milli', 'unit_price_minor', 'line_total_minor', 'tax_code', 'supply_date', 'credited_line_position'],
  order: 'position',
};

/**
 * The content columns of a sales document (subtotal; tax and total are recomputed at issue, A11 B-1).
 * D164: `supply_date`, the document-level Leistungsdatum every undated line is priced and posted at.
 */
const DOCUMENT_COLUMNS = ['type', 'contact_id', 'currency', 'subtotal_minor', 'supply_date', 'due_date', 'notes', 'intro', 'outro', 'valid_until', 'credited_document_id', 'source_document_id', 'deal_id'] as const;

/**
 * D163: the workspace default Zahlungsfrist. An invoice issued without a due date, and a bill or
 * expense recorded without one, falls due after the counterparty's own terms (`contact`, pinned with
 * the contact) else this default, read live at execution. `update_company_profile` changes it freely,
 * so every act that derives a due date pins it.
 */
const WORKSPACE_TERMS: DepSpec = { table: 'workspace', key: 'id', from: { row: 'workspace_id' }, self: true, columns: ['default_payment_terms_days'] };

/**
 * D163: an issue that finds no stored due date on an invoice WRITES the derived one in the same
 * statement as the number (`issueDueDate` in `core/sales/document.ts`), so the act changes a content
 * column the pin digests. Without this, approving `issue_invoice` turned a pending `send_invoice` on
 * the same invoice stale. (It was also argued as crash safety for the issue's own Vorschlag; since D165
 * that is the commit mark's job in `draftedActions.ts`, for every verb, and does not rest on this.)
 * The digest therefore reads the due date as the INTENT the draft carried: on an
 * issued invoice whose stored due date is exactly what the one derivation gives for its issue date
 * (the terms behind it are pinned beside it), the date reads as unset, which is what the draft held.
 * A blank due date reads as unset too, since the issue path treats it so. An explicit due date that
 * happens to equal the derived one reads as unset after the issue: that can only turn a pending OTHER
 * Vorschlag stale (the safe direction), never let a changed one through.
 */
function documentDueDateAsIntent(ctx: WorkspaceContext, row: Row): Row {
  const due = row.due_date;
  if (due === '') return { ...row, due_date: null };
  if (row.type !== 'invoice' || typeof due !== 'string' || typeof row.id !== 'string') return row;
  const state = ctx.store.db
    .prepare('SELECT status, issue_date FROM document WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, row.id) as { status: string; issue_date: string | null } | undefined;
  if (state === undefined || state.status === 'draft' || typeof state.issue_date !== 'string' || state.issue_date === '') return row;
  const contactId = typeof row.contact_id === 'string' ? row.contact_id : null;
  return dueDateFor(ctx, { contactId, documentDate: state.issue_date }) === due ? { ...row, due_date: null } : row;
}

/** A document and everything its issue or send reads live: the lines, the contact, the codes, the items. */
const DOCUMENT_DEPS: readonly DepSpec[] = [
  WORKSPACE_IDENTITY,
  WORKSPACE_TERMS,
  contactVia({ row: 'contact_id' }),
  taxCodeVia({ child: 'document_line', column: 'tax_code' }),
  itemVia({ child: 'document_line', column: 'item_id' }),
];

/** The purchase order a receipt or a match is checked against, with its lines and their items. */
const PO_AS_DEP = (from: KeySource): DepSpec => ({
  table: 'purchase_order',
  key: 'id',
  from,
  columns: ['id', 'supplier_contact_id', 'currency', 'total_rappen', 'fx_rate', 'status'],
  deps: [
    {
      table: 'po_line',
      key: 'po_id',
      from: { row: 'id' },
      columns: ['item_id', 'description', 'qty', 'unit_price_rappen', 'unit_price_base_rappen', 'tax_code', 'received_qty', 'billed_qty', 'sort'],
      deps: [itemVia({ row: 'item_id' })],
    },
  ],
});

/**
 * THE RECORDS a pinned verb consumes, keyed by a short kind. Columns were read off the tables' DDL;
 * every table here carries `workspace_id`, which the suite asserts, so §H-TENANT holds on every read.
 */
export const PIN_RECORDS = {
  document: {
    table: 'document',
    columns: DOCUMENT_COLUMNS,
    children: [DOCUMENT_LINES],
    deps: DOCUMENT_DEPS,
    normalize: documentDueDateAsIntent,
    figures: {
      number: 'number',
      contact: { row: 'contact_id' },
      amount: { column: 'subtotal_minor', from: 'row', basis: 'net' },
      currency: { column: 'currency', from: 'row' },
      countLines: true,
      vatPreview: { amount: 'line_total_minor', taxCode: 'tax_code', supplyDate: 'supply_date', documentSupplyDate: 'supply_date' },
    },
  },
  purchase_order: {
    table: 'purchase_order',
    columns: ['supplier_contact_id', 'currency', 'total_rappen', 'fx_rate', 'expected_on', 'note'],
    children: [{ table: 'po_line', fk: 'po_id', columns: ['item_id', 'description', 'qty', 'unit_price_rappen', 'tax_code', 'project_id', 'sort'], order: 'sort' }],
    deps: [
      WORKSPACE_IDENTITY,
      contactVia({ row: 'supplier_contact_id' }),
      itemVia({ child: 'po_line', column: 'item_id' }),
      taxCodeVia({ child: 'po_line', column: 'tax_code' }),
      // What a match consumes: the receipts against the order and their lines (held lines included).
      { table: 'goods_receipt_doc', key: 'po_id', from: { row: 'id' }, columns: ['id', 'status', 'received_at'] },
      {
        table: 'goods_receipt_doc_line',
        key: 'po_id',
        from: { row: 'id' },
        columns: ['gr_id', 'po_line_id', 'item_id', 'qty', 'unit_cost_rappen', 'inspection_status', 'billed_qty', 'over_receipt_qty'],
      },
    ],
    figures: {
      number: 'number',
      contact: { row: 'supplier_contact_id' },
      amount: { column: 'total_rappen', from: 'row', basis: 'net' },
      currency: { column: 'currency', from: 'row' },
      countLines: true,
    },
  },
  goods_receipt: {
    table: 'goods_receipt_doc',
    columns: ['po_id', 'supplier_contact_id', 'received_at', 'default_location_id', 'note'],
    children: [
      {
        table: 'goods_receipt_doc_line',
        fk: 'gr_id',
        columns: ['line_no', 'po_line_id', 'item_id', 'description', 'qty', 'unit_cost_rappen', 'location_id', 'lot_id', 'serial_id', 'inspection_status', 'note'],
        order: 'line_no',
      },
    ],
    deps: [PO_AS_DEP({ row: 'po_id' }), itemVia({ child: 'goods_receipt_doc_line', column: 'item_id' }), contactVia({ row: 'supplier_contact_id' })],
    figures: { number: 'number', contact: { row: 'supplier_contact_id' }, countLines: true },
  },
  payment_batch: {
    table: 'payment_batch',
    // The debtor name and IBAN the file carries are frozen on the batch at creation (A18 critic r1 C2).
    columns: ['bank_account_id', 'execution_date', 'debtor_name', 'debtor_iban'],
    children: [
      {
        table: 'payment_batch_item',
        fk: 'batch_id',
        columns: ['vendor_bill_id', 'vendor_id', 'amount_minor', 'currency', 'creditor_iban', 'reference_kind', 'reference_value', 'creditor_name'],
        order: 'created_at',
      },
    ],
    // The payees' addresses go into the pain.001 file, beside the debtor (the workspace) it names.
    deps: [WORKSPACE_IDENTITY, contactVia({ child: 'payment_batch_item', column: 'vendor_id' })],
    figures: {
      contact: { child: 'payment_batch_item', column: 'vendor_id' },
      amount: { column: 'amount_minor', from: 'children', basis: 'amount' },
      currency: { column: 'currency', from: 'children' },
      countLines: true,
    },
  },
  dunning_run: {
    table: 'dunning_run',
    columns: ['run_date'],
    // principal_minor and demanded_fee_minor are rewritten at issue (D73), so they stay out.
    children: [
      {
        table: 'dunning_item',
        fk: 'run_id',
        columns: ['document_id', 'debtor_id', 'level', 'currency', 'overdue_minor', 'fee_minor', 'interest_minor', 'due_date', 'days_overdue'],
        order: 'document_id',
      },
    ],
    // The debtors (the email a reminder goes to, the address it prints), and the dunning setup the
    // issue reads: fee, fee income account, fee tax code (and that code's rate), interest, template.
    deps: [
      WORKSPACE_IDENTITY,
      contactVia({ child: 'dunning_item', column: 'debtor_id' }),
      // The invoices dunned: issued and frozen, read for the figures the letter restates.
      {
        table: 'document',
        key: 'id',
        from: { child: 'dunning_item', column: 'document_id' },
        columns: ['type', 'number', 'contact_id', 'currency', 'total_minor', 'due_date', 'issue_date'],
      },
      {
        table: 'dunning_config',
        key: 'workspace_id',
        from: { row: 'workspace_id' },
        columns: ['level', 'days_overdue', 'min_interval_days', 'fee_minor', 'book_fee', 'fee_income_account_id', 'tax_code', 'show_interest', 'interest_bp', 'template_key'],
        deps: [taxCodeVia({ row: 'tax_code' })],
      },
    ],
    figures: {
      contact: { child: 'dunning_item', column: 'debtor_id' },
      amount: { column: 'overdue_minor', from: 'children', basis: 'amount' },
      currency: { column: 'currency', from: 'children' },
      countLines: true,
    },
  },
  vendor_bill: {
    table: 'vendor_bill',
    columns: ['contact_id', 'bill_date', 'due_date', 'supply_date', 'vendor_reference', 'currency', 'amount_is_gross', 'net_minor', 'tax_code', 'tax_amount_minor', 'gross_minor', 'payable_minor', 'expense_account_id', 'cost_center_id', 'project_id', 'fx_rate'],
    deps: [contactVia({ row: 'contact_id' }), taxCodeVia({ row: 'tax_code' })],
    figures: {
      contact: { row: 'contact_id' },
      amount: { column: 'net_minor', from: 'row', basis: 'net' },
      currency: { column: 'currency', from: 'row' },
      vatColumns: { tax: 'tax_amount_minor', gross: 'gross_minor' },
    },
  },
  accrual: {
    table: 'accrual',
    columns: ['kind', 'period_end', 'reversal_date', 'amount_minor', 'balance_account_id', 'contra_account_id', 'cost_center_id', 'description', 'source_ref'],
    figures: { amount: { column: 'amount_minor', from: 'row', basis: 'amount' }, currency: { fixed: 'CHF' } },
  },
  provision: {
    table: 'provision',
    columns: ['reason', 'period_end', 'amount_minor', 'provision_account_id', 'expense_account_id', 'description'],
    figures: { amount: { column: 'amount_minor', from: 'row', basis: 'amount' }, currency: { fixed: 'CHF' } },
  },
  expense_claim: {
    table: 'expense_claim',
    columns: ['employee_id', 'title', 'currency'],
    children: [
      {
        table: 'expense_line',
        fk: 'claim_id',
        columns: ['expense_date', 'category', 'description', 'amount_minor', 'currency', 'fx_rate', 'tax_code', 'tax_amount_minor', 'expense_account_id', 'cost_center_id', 'project_id', 'receipt_document_id'],
        order: 'expense_date',
      },
    ],
    // N-c: the reimbursement follows the employee's payee contact live (hr_employee_upsert is free).
    deps: [
      {
        table: 'employee',
        key: 'id',
        from: { row: 'employee_id' },
        columns: ['contact_id', 'actor_ref', 'first_name', 'last_name', 'archived'],
        deps: [contactVia({ row: 'contact_id' })],
      },
      taxCodeVia({ child: 'expense_line', column: 'tax_code' }),
    ],
    figures: {
      amount: { column: 'amount_minor', from: 'children', basis: 'amount' },
      currency: { column: 'currency', from: 'row' },
      countLines: true,
    },
  },
  delivery_note: {
    table: 'delivery_note',
    columns: ['sales_order_id', 'location_id'],
    children: [{ table: 'dn_line', fk: 'delivery_note_id', columns: ['so_line_id', 'qty'], order: 'so_line_id' }],
    // The order the note ships against (its lines, items and customer, whose address the note prints).
    deps: [
      WORKSPACE_IDENTITY,
      {
        table: 'sales_order',
        key: 'id',
        from: { row: 'sales_order_id' },
        columns: ['id', 'contact_id', 'currency', 'status'],
        deps: [
          contactVia({ row: 'contact_id' }),
          {
            table: 'so_line',
            key: 'sales_order_id',
            from: { row: 'id' },
            columns: ['item_id', 'description', 'qty', 'unit_price_rappen', 'tax_code', 'delivered_qty', 'sort'],
            deps: [itemVia({ row: 'item_id' })],
          },
        ],
      },
    ],
    figures: { number: 'number', countLines: true },
  },
  sign_request: {
    table: 'sign_request',
    columns: ['file_id', 'signer_contact_id', 'signature_level', 'message', 'expires_at'],
    deps: [WORKSPACE_IDENTITY, contactVia({ row: 'signer_contact_id' })],
    figures: { contact: { row: 'signer_contact_id' } },
  },
  ebill_delivery: {
    table: 'ebill_deliveries',
    columns: ['document_id', 'artifact_document_id', 'format', 'bc_function', 'pdfa_profile', 'ebill_addressed', 'payload_byte_length'],
    deps: [WORKSPACE_IDENTITY],
    figures: {},
  },
  portal_grant: {
    table: 'portal_grant',
    columns: ['contact_id', 'kind', 'scopes', 'expires_at'],
    // The send mails the link to the contact's email, from the workspace.
    deps: [WORKSPACE_IDENTITY, contactVia({ row: 'contact_id' })],
    figures: { contact: { row: 'contact_id' } },
  },
  automation_rule: {
    table: 'automation_rule',
    columns: ['name', 'trigger_event', 'condition', 'action_tool', 'action_input', 'archived'],
    figures: {},
  },
  stocktake: {
    table: 'stocktake_session',
    columns: ['location_id', 'frozen_at'],
    children: [{ table: 'stocktake_line', fk: 'session_id', columns: ['item_id', 'location_id', 'book_qty', 'counted_qty'], order: 'item_id' }],
    deps: [itemVia({ child: 'stocktake_line', column: 'item_id' })],
    figures: { countLines: true },
  },
  cycle_count: {
    table: 'cycle_count_session',
    columns: ['type', 'warehouse_id', 'freeze_at', 'blind_count', 'selection_hash', 'variance_qty_threshold', 'variance_pct_threshold'],
    // A line's review `status` is left out: approving lines is itself governed, and approving them
    // must not make the pending commit of the same session stale.
    children: [
      {
        table: 'cycle_count_line',
        fk: 'session_id',
        columns: ['item_id', 'location_id', 'lot_id', 'serial_id', 'book_qty', 'counted_qty'],
        order: 'item_id',
      },
    ],
    deps: [itemVia({ child: 'cycle_count_line', column: 'item_id' })],
    figures: { countLines: true },
  },
  inventory_valuation_run: {
    table: 'inventory_valuation_run',
    columns: ['as_of', 'period', 'method', 'total_value_rappen', 'delta_rappen', 'line_count', 'filters_json', 'ledger_fingerprint', 'is_opening'],
    children: [
      {
        table: 'inventory_valuation_line',
        fk: 'run_id',
        columns: ['item_id', 'location_id', 'lot_id', 'serial_id', 'qty', 'unit_cost_rappen', 'value_rappen', 'control_account_id', 'market_value_rappen', 'is_market_write_down'],
        order: 'item_id',
      },
    ],
    figures: { amount: { column: 'delta_rappen', from: 'row', basis: 'amount' }, currency: { fixed: 'CHF' }, countLines: true },
  },
  landed_cost_voucher: {
    table: 'landed_cost_voucher',
    columns: ['currency', 'fx_rate', 'total_cost_minor', 'allocation_method', 'source_bill_ids', 'inventory_account_id', 'clearing_account_id', 'variance_account_id', 'variance_policy', 'effective_date', 'is_estimated'],
    children: [
      { table: 'landed_cost_line', fk: 'voucher_id', columns: ['component_type', 'description', 'amount_minor', 'amount_base_minor', 'vendor_id', 'tax_code_id'], order: 'created_at' },
      {
        table: 'landed_cost_target',
        fk: 'voucher_id',
        columns: ['goods_receipt_line_id', 'item_id', 'location_id', 'base_qty', 'base_value_minor', 'weight_milli', 'volume_milli'],
        order: 'goods_receipt_line_id',
      },
    ],
    deps: [itemVia({ child: 'landed_cost_target', column: 'item_id' })],
    figures: {
      number: 'number',
      amount: { column: 'total_cost_minor', from: 'row', basis: 'amount' },
      currency: { column: 'currency', from: 'row' },
      countLines: true,
    },
  },
  time_entry: {
    table: 'time_entry',
    columns: ['user_id', 'project_id', 'phase_id', 'started_at', 'ended_at', 'minutes', 'billable', 'notes', 'rate_minor', 'rate_currency'],
    figures: {},
  },
  requisition: {
    table: 'requisition',
    columns: ['requester_id', 'needed_by', 'urgency', 'cost_center_id', 'project_id', 'description', 'currency', 'total_estimated_rappen'],
    children: [
      {
        table: 'requisition_line',
        fk: 'requisition_id',
        columns: ['line_no', 'item_id', 'description', 'qty_milli', 'uom', 'estimated_unit_cost_rappen', 'estimated_total_rappen', 'preferred_supplier_id'],
        order: 'line_no',
      },
    ],
    deps: [
      itemVia({ child: 'requisition_line', column: 'item_id' }),
      contactVia({ child: 'requisition_line', column: 'preferred_supplier_id' }),
      { table: 'requisition_approval_task', key: 'requisition_id', from: { row: 'id' }, columns: ['required_capability', 'status', 'step_no', 'decided_by'] },
    ],
    figures: {
      number: 'number',
      amount: { column: 'total_estimated_rappen', from: 'row', basis: 'net' },
      currency: { column: 'currency', from: 'row' },
      countLines: true,
    },
  },
  po_amendment: {
    table: 'po_amendment',
    columns: ['po_id', 'from_version_id', 'reason', 'committed_value_delta_rappen'],
    children: [
      {
        table: 'po_amendment_line',
        fk: 'amendment_id',
        columns: ['op', 'po_line_id', 'item_id', 'after_qty', 'after_unit_price_rappen', 'after_description', 'tax_code', 'sort'],
        order: 'sort',
      },
    ],
    deps: [PO_AS_DEP({ row: 'po_id' })],
    figures: { amount: { column: 'committed_value_delta_rappen', from: 'row', basis: 'amount' }, currency: { fixed: 'CHF' }, countLines: true },
  },
  asset: {
    table: 'asset',
    // The master the posting reads its accounts from; the amounts are in the verb's own input. B-1
    // (column census): an acquisition or opening balance seats the draft's residual value unless its
    // input overrides it, and asset_update changes it freely while the asset is a draft.
    columns: ['number', 'name', 'category_id', 'useful_life_months', 'depreciation_method', 'declining_rate_bp', 'gl_asset_account_id', 'gl_accum_depr_account_id', 'gl_depr_expense_account_id', 'residual_value_rappen'],
    figures: { number: 'number' },
  },
  /** N-d: a stock act that omits its unit cost reads the item's cost (and tracking) live. */
  item: {
    table: 'item',
    columns: ITEM_COLUMNS,
    figures: {},
  },
  /** An adjustment's reason code: its category and whether it needs a note. */
  inventory_reason_code: {
    table: 'inventory_reason_code',
    columns: ['code', 'name', 'category', 'requires_note', 'default_for_stocktake', 'is_active', 'archived_at'],
    figures: {},
  },
  /** Critic round 3 (N1): the workspace's printed identity, for an act with no record of its own. */
  workspace_identity: {
    table: 'workspace',
    self: true,
    columns: WORKSPACE_IDENTITY_COLUMNS,
    figures: {},
  },
  /** A contact a payload names directly (a vendor an expense is booked against). */
  contact: {
    table: 'contact',
    columns: CONTACT_COLUMNS,
    // D163: an expense recorded without a due date falls due after the vendor's terms, else this.
    deps: [WORKSPACE_TERMS],
    figures: { contact: { row: 'id' } },
  },
  /** R2-B2: a tax code a payload names: every validity version of it. */
  tax_code: {
    table: 'tax_code',
    idColumn: 'code',
    many: true,
    columns: TAX_CODE_COLUMNS,
    figures: {},
  },
  /** Every tax code of the workspace, for an act that reads the whole set (the MWST settlement). */
  tax_codes_all: {
    table: 'tax_code',
    idColumn: 'workspace_id',
    many: true,
    columns: TAX_CODE_COLUMNS,
    figures: {},
  },
  /** Every time row of the workspace: a period lock seals whichever rows the period holds then. */
  time_entries_all: {
    table: 'time_entry',
    idColumn: 'workspace_id',
    many: true,
    columns: ['id', 'user_id', 'project_id', 'phase_id', 'started_at', 'ended_at', 'minutes', 'billable', 'notes', 'rate_minor', 'rate_currency', 'status'],
    figures: {},
  },
  /** Every item of the workspace: a valuation run values the stock at the items' costs. */
  items_all: {
    table: 'item',
    idColumn: 'workspace_id',
    many: true,
    columns: ['id', ...ITEM_COLUMNS],
    figures: {},
  },
  /** A recorded payment (frozen) and its counterparty, whose name and address a remittance prints. */
  payment: {
    table: 'payment',
    columns: ['direction', 'date', 'amount_minor', 'currency', 'counterparty_kind', 'counterparty_id', 'status'],
    deps: [WORKSPACE_IDENTITY, contactVia({ row: 'counterparty_id' })],
    figures: {
      contact: { row: 'counterparty_id' },
      amount: { column: 'amount_minor', from: 'row', basis: 'amount' },
      currency: { column: 'currency', from: 'row' },
    },
  },
  /**
   * N-b: a migration step as its commit consumes it, for EVERY data class: the step, its staged rows,
   * the plan's maps and scope, its source files and control totals. The G11 check hash is a function
   * of exactly these, so pinning them pins the check for a master-data class as for a money-path one.
   */
  migration_step: {
    table: 'migration_step',
    columns: ['plan_id', 'data_class', 'depth', 'counts', 'conflict_resolutions'],
    children: [{ table: 'migration_step_row', fk: 'step_id', columns: ['source_row_ref', 'outcome', 'target_kind', 'target_id', 'reason'], order: 'source_row_ref' }],
    deps: [
      { table: 'migration_plan', key: 'id', from: { row: 'plan_id' }, columns: ['source_adapter', 'locale_pack', 'data_class', 'source_system', 'cutover_date'] },
      { table: 'migration_map', key: 'plan_id', from: { row: 'plan_id' }, columns: ['kind', 'entries', 'rule_default'] },
      { table: 'migration_source_file', key: 'plan_id', from: { row: 'plan_id' }, columns: ['file_id', 'adapter', 'sha256', 'as_at', 'superseded_by_file_id', 'data_classes'] },
      { table: 'migration_control_total', key: 'plan_id', from: { row: 'plan_id' }, columns: ['step_id', 'kind', 'scope', 'declared_minor', 'status', 'waiver_reason'] },
    ],
    figures: {},
  },
  /**
   * D172: one workspace setting as a change consumes it: the override row in force under the key (none
   * while the default applies). A person who changes the setting after the agent proposed a change makes
   * the approval refuse `vorschlag_stale`, so an approval never overwrites a value the person did not see.
   */
  /**
   * D175: the Buchungsregel a `book_bank_line` rule target names: its recipe, text, Durchlaufkonto and
   * supersession as they stood when the booking was proposed, with the rest leg's tax code. (The codes of
   * the other legs live inside `legs_json`, which the digest covers by value.)
   */
  bank_standard: {
    table: 'bank_standard',
    // D176: the scope, the outcome (an ignore rule's reason and note) and the follow-up too: a Vorlage a
    // `post_entry { template }` names is pinned exactly as a bank rule a `book_bank_line` names.
    columns: [
      'counterparty_key',
      'direction',
      'account_id',
      'tax_code',
      'label',
      'match_text',
      'legs_json',
      'via_account_id',
      'superseded_at',
      'scope',
      'outcome',
      'ignore_reason',
      'ignore_note',
      'follow_up_standard_id',
    ],
    // Critic D175-C2 (D162): what the rule books with is read LIVE at approval, so it is pinned: every
    // leg's MWST code (the rest leg's on the row, the asked legs' inside the recipe) and the accounts the
    // entry moves (every leg's and the Durchlaufkonto).
    deps: [
      { table: 'tax_code', key: 'code', from: { row: 'tax_code' }, columns: TAX_CODE_COLUMNS },
      { table: 'tax_code', key: 'code', from: { json: 'legs_json', field: 'taxCode' }, columns: TAX_CODE_COLUMNS },
      { table: 'account', key: 'id', from: { json: 'legs_json', field: 'accountId' }, columns: RULE_ACCOUNT_COLUMNS },
      { table: 'account', key: 'id', from: { row: 'via_account_id' }, columns: RULE_ACCOUNT_COLUMNS },
    ],
    figures: {},
  },
  workspace_setting: {
    table: 'workspace_setting',
    idColumn: 'key',
    many: true,
    columns: ['value_json'],
    figures: {},
  },
} as const satisfies Record<string, RecordSpec>;

export type PinRecordKind = keyof typeof PIN_RECORDS;

/**
 * One input field of a pinned verb and the record kind it names. `field` is a path into the input:
 * `invoiceId`, `entryIds` (an array), or `target.legs[].taxCode` (every element of a nested array).
 * `workspace: true` pins a workspace-level record with no input field at all.
 */
export interface PinField {
  readonly field?: string;
  readonly workspace?: true;
  readonly record: PinRecordKind;
  /** Pin only when the payload does NOT carry this field (it then states the value itself). */
  readonly unless?: string;
}

/**
 * THE RESOLVER TABLE: verb -> the input fields that name a record the act consumes. The first field
 * is the PRIMARY record, the one whose figures the card shows. A field absent from a given input (an
 * optional `poId`, `templateDocumentId`) is simply not pinned for that call.
 */
export const PIN_FOR_VERB: Readonly<Record<string, readonly PinField[]>> = {
  // Sales documents: the draft, its lines, its contact, its codes and items.
  issue_invoice: [{ field: 'invoiceId', record: 'document' }],
  // R2-B1: a send reads the recipient's email and address live, so it pins them with the document.
  send_invoice: [{ field: 'invoiceId', record: 'document' }],
  issue_credit_note: [{ field: 'creditNoteId', record: 'document' }],
  transition_document: [{ field: 'documentId', record: 'document' }],
  quotes_send: [{ field: 'quoteId', record: 'document' }],
  quotes_accept: [{ field: 'quoteId', record: 'document' }],
  portal_quote_accept: [{ field: 'quoteId', record: 'document' }],
  create_recurring_schedule: [{ field: 'templateDocumentId', record: 'document' }],
  ebill_transmit: [{ field: 'deliveryId', record: 'ebill_delivery' }],
  delivery_note_issue: [{ field: 'deliveryNoteId', record: 'delivery_note' }],
  // Purchasing (D161): the order after po_upsert, the receipt after goods_receipt_upsert_lines.
  po_send: [{ field: 'poId', record: 'purchase_order' }],
  po_amendment_apply: [{ field: 'amendmentId', record: 'po_amendment' }],
  requisition_approve: [{ field: 'requisitionId', record: 'requisition' }],
  requisition_convert_to_po: [{ field: 'requisitionId', record: 'requisition' }],
  goods_receipt_post: [{ field: 'grId', record: 'goods_receipt' }],
  goods_receipt_accept_lines: [{ field: 'grId', record: 'goods_receipt' }],
  match_bill: [
    { field: 'billId', record: 'vendor_bill' },
    { field: 'poId', record: 'purchase_order' },
  ],
  match_three_way_create: [
    { field: 'billId', record: 'vendor_bill' },
    { field: 'poId', record: 'purchase_order' },
  ],
  match_three_way_override: [
    { field: 'billId', record: 'vendor_bill' },
    { field: 'poId', record: 'purchase_order' },
  ],
  landed_cost_allocate_confirm: [{ field: 'voucherId', record: 'landed_cost_voucher' }],
  // Creditors and payment runs: the bill with its contact and code, the batch with its payees.
  post_vendor_bill: [{ field: 'vendorBillId', record: 'vendor_bill' }],
  generate_pain001: [{ field: 'batchId', record: 'payment_batch' }],
  payment_batch_transmit: [{ field: 'batchId', record: 'payment_batch' }],
  mark_batch_paid: [{ field: 'batchId', record: 'payment_batch' }],
  expense_claim_approve: [{ field: 'claimId', record: 'expense_claim' }],
  expense_claim_reimburse: [{ field: 'claimId', record: 'expense_claim' }],
  // D168: the claim is pinned like approve's, so the card shows the figures the reverse mirrors and a
  // claim moved under the Vorschlag (reimbursed, say) voids it; the D165 crash census covers it.
  expense_claim_reverse: [{ field: 'claimId', record: 'expense_claim' }],
  // Dunning: the run, its items, the debtors and the dunning setup.
  issue_dunning_run: [{ field: 'runId', record: 'dunning_run' }],
  send_dunning_run: [{ field: 'runId', record: 'dunning_run' }],
  // D169: the run is pinned like issue's, so the card shows the fee the reverse mirrors and a run
  // moved under the Vorschlag (sent, say) voids it; the D165 crash census covers it.
  dunning_fee_reverse: [{ field: 'runId', record: 'dunning_run' }],
  // The ledger drafts a capability posts from its own row.
  accrual_post: [{ field: 'accrualId', record: 'accrual' }],
  provision_post: [{ field: 'provisionId', record: 'provision' }],
  inventory_valuation_post: [{ field: 'runId', record: 'inventory_valuation_run' }],
  asset_acquire: [{ field: 'assetId', record: 'asset' }],
  asset_add_capitalisation: [{ field: 'assetId', record: 'asset' }],
  asset_dispose: [{ field: 'assetId', record: 'asset' }],
  asset_opening_balance: [{ field: 'assetId', record: 'asset' }],
  // D170: the asset is pinned like its forward acts', so a master moved under the Vorschlag voids it;
  // the D165 crash census covers it (asserted by name).
  asset_transaction_reverse: [{ field: 'assetId', record: 'asset' }],
  // Stock: the counted lines are the content of a commit; a move without a cost reads the item's.
  stock_stocktake_commit: [{ field: 'sessionId', record: 'stocktake' }],
  inventory_stocktake_commit: [{ field: 'sessionId', record: 'cycle_count' }],
  inventory_stocktake_approve_lines: [{ field: 'sessionId', record: 'cycle_count' }],
  stock_move: [{ field: 'itemId', record: 'item', unless: 'unitCostMinor' }],
  inventory_move: [{ field: 'itemId', record: 'item', unless: 'unitCostMinor' }],
  inventory_transfer: [{ field: 'itemId', record: 'item', unless: 'unitCostMinor' }],
  inventory_adjust: [
    { field: 'itemId', record: 'item', unless: 'unitCostMinor' },
    { field: 'reasonCodeId', record: 'inventory_reason_code' },
  ],
  inventory_adjust_batch: [
    { field: 'lines[].itemId', record: 'item' },
    { field: 'lines[].reasonCodeId', record: 'inventory_reason_code' },
  ],
  receipt_record: [{ field: 'poId', record: 'purchase_order' }],
  // R2-B2: an act that names a tax code posts VAT at that code's rate, read live.
  record_expense: [
    { field: 'vendorId', record: 'contact' },
    { field: 'taxCode', record: 'tax_code' },
  ],
  create_entry_for_txn: [{ field: 'taxCode', record: 'tax_code' }],
  book_bank_line: [
    { field: 'target.legs[].taxCode', record: 'tax_code' },
    // D175: a `rule` target books the Buchungsregel as it stands at approval; pin the rule row (an edit
    // supersedes it, which changes `superseded_at`), so a person who edits the rule after the agent
    // proposed the booking makes the approval refuse `vorschlag_stale`.
    { field: 'target.standardId', record: 'bank_standard' },
    // D178 E3 (A39 §17.9): a contact booking books to the contact as it stands at approval (archived or
    // merged since refuses), and a Spesen booking pays the claims as they stand (a claim rejected,
    // reversed or edited since makes the approval refuse `vorschlag_stale`).
    { field: 'target.contactId', record: 'contact' },
    { field: 'target.claimIds[]', record: 'expense_claim' },
  ],
  // D176 (A39 §15.2, D162): a post from a Vorlage books the recipe as it stands at approval, so the Vorlage
  // is pinned like a bank rule target (every leg's code and account through the recipe deps): an edit or a
  // code change after the agent proposed the post refuses `vorschlag_stale`. A post with typed lines names
  // no record (the field is absent) and pins nothing, exactly as before.
  post_entry: [{ field: 'template.standardId', record: 'bank_standard' }],
  // D176: an ignore that follows a "Nicht buchen" rule names that rule (kept on the decision for its next
  // step); pinned, so a rule edited after the proposal makes the approval refuse rather than record it.
  ignore_bank_line: [{ field: 'standardId', record: 'bank_standard' }],
  vat_settlement_post: [{ workspace: true, record: 'tax_codes_all' }],
  vat_configure: [{ workspace: true, record: 'tax_codes_all' }],
  vendor_portal_remittance_create: [{ field: 'paymentId', record: 'payment' }],
  // Critic round 3 (N1): the EBICS initialisation letter the person signs carries the company identity.
  bank_channel_connect: [{ workspace: true, record: 'workspace_identity' }],
  time_approve: [{ field: 'entryIds', record: 'time_entry' }],
  // A lock seals the rows the period holds at execution, and time_update is free: pin them all.
  time_lock: [{ workspace: true, record: 'time_entries_all' }],
  // A valuation run values stock at the items' costs, and update_item is free.
  stock_run_valuation: [{ workspace: true, record: 'items_all' }],
  // Outbound: what is sent or opened is the record as it stands, to the contact as it stands.
  sign_requests_send: [{ field: 'signRequestId', record: 'sign_request' }],
  portal_grant_send: [{ field: 'grantId', record: 'portal_grant' }],
  enable_automation_rule: [{ field: 'ruleId', record: 'automation_rule' }],
  // N-b: a commit (and the archive import) of a step, for every data class.
  migration_commit_step: [{ field: 'stepId', record: 'migration_step' }],
  gl_archive_import: [{ field: 'stepId', record: 'migration_step' }],
  // D172: the setting's override row in force when the change was proposed.
  settings_set: [{ field: 'key', record: 'workspace_setting' }],
  settings_reset: [{ field: 'key', record: 'workspace_setting' }],
};

/** The closed set of reasons a governed verb with a record id needs no pin. */
export type NotPinnedReason =
  /** The record is posted, issued, imported or frozen in every state the verb accepts. */
  | 'immutable'
  /** The act removes or blanks the record; nothing of its content is carried into an effect. */
  | 'delete'
  /** The payload the card shows states the whole effect; the ids are anchors whose content is not consumed. */
  | 'payload'
  /** The act flips a lifecycle state and consumes no content of the record. */
  | 'state'
  /** The content the act consumes changes only through verbs that are governed themselves. */
  | 'governed'
  /** The verb carries its own content pin (a check hash) that refuses on a change. */
  | 'pinned'
  /** The act deliberately works on the state at execution time, and says so. */
  | 'live';

export interface NotPinned {
  readonly reason: NotPinnedReason;
  /** What the executing code reads live, and why no FREE verb can change it in a way that matters. */
  readonly why: string;
}

const del = (why: string): NotPinned => ({ reason: 'delete', why });
const imm = (why: string): NotPinned => ({ reason: 'immutable', why });
const pay = (why: string): NotPinned => ({ reason: 'payload', why });
const st = (why: string): NotPinned => ({ reason: 'state', why });
const gov = (why: string): NotPinned => ({ reason: 'governed', why });

/**
 * THE EXCLUSIONS: every governed verb whose input carries a record id and needs no pin. Each reason
 * answers the round-2 question: what does the executing code read live that a FREE verb can change?
 * The structural test re-asks it on every run from the SQL the approval actually executes.
 */
export const NOT_PINNED: Readonly<Record<string, NotPinned>> = {
  // delete: the erase family removes or blanks what it names; nothing it reads is carried forward.
  delete_account: del('hard delete of a never-posted account; reads only whether the account is referenced'),
  delete_cost_center: del('hard delete of an unreferenced cost centre; reads only its references'),
  delete_draft: del('hard delete of an unposted journal draft; reads only the draft row'),
  delete_item: del('hard delete of an unreferenced item; reads its references (document lines, custom values) only to refuse'),
  item_categories_delete: del('hard delete of an empty category; reads its items only to refuse'),
  price_lists_unset_price: del('removes dated price rows of the named list and item'),
  price_lists_delete: del('removes the list and its dated prices; reads custom values only to remove them'),
  contacts_merge: del('tombstones the source contact onto the target, both named on the card; the contact rows are what is merged, not content it carries elsewhere'),
  contacts_anonymise: del('blanks the named contact\'s personal data; reads its documents and payment batches only to blank the copies'),
  files_delete: del('removes the file row and its bytes'),
  sign_requests_delete_draft: del('hard delete of an unsent signature request'),
  discard_dunning_run: del('removes a proposed run and frees its day'),
  discard_payment_batch: del('discards the batch; nothing is paid or transmitted'),
  agent_prose_delete: del('deletes the prose of one agent session'),
  migration_abandon_plan: del('abandons the plan and deletes its trial workspace'),
  discard_testmandant: del('deletes the trial workspace of the plan'),
  project_delete: del('hard delete of a draft project and its phases'),
  time_delete: del('hard delete of an open or submitted time row'),
  reports_delete: del('removes a report definition and its run history'),
  mail_reindex: del('drops and rebuilds the local search index of the mail account; no business content is consumed'),
  delete_backup: del('removes the backup file and its history row'),
  uninstall_plugin: del('removes the plugin\'s manifest and grants'),
  // immutable: the verb only accepts a record that can no longer change, and reads nothing else a
  // free verb can change in a way that alters the act.
  reverse_entry: imm('mirrors a posted, append-only entry; the account rows it reads have frozen numbers and types'),
  approve_entry: imm('a review mark on a posted, append-only entry'),
  fx_revaluation_reverse: imm('mirrors a posted revaluation run'),
  accrual_reverse: imm('mirrors a posted accrual'),
  provision_reverse: imm('mirrors a posted provision'),
  provision_release_reverse: imm('mirrors a posted release'),
  vat_settlement_reverse: imm('mirrors a posted MWST settlement'),
  reverse_payment: imm('mirrors a recorded payment; the documents and claims it reopens are read for their status only'),
  void_vendor_bill: imm('voids a posted bill by its reversing entry; the bill\'s accounting columns are frozen by a DB trigger'),
  asset_depreciation_run_reverse: imm('mirrors a posted depreciation run'),
  asset_depreciation_run_post: imm('a run\'s lines and amounts are frozen by DB triggers from the moment it is calculated; a new figure is a new run'),
  liquidity_plan_draft_batches: imm('a payment proposal and its lines are frozen by DB triggers (re-proposed, never edited); the bills it pays are posted'),
  inventory_valuation_reverse: imm('mirrors a posted valuation run'),
  inventory_adjust_reverse: imm('mirrors a posted adjustment; the reason code is read for the mirror\'s label only'),
  landed_cost_reverse: imm('mirrors an allocated landed-cost voucher'),
  // D171: the row is append-only by DB trigger and its entry is posted, so no pin could ever go stale.
  wage_journal_reverse: imm('mirrors a posted wage journal; the wage_journal_posts row is append-only by trigger'),
  goods_receipt_reverse: imm('reverses a posted, frozen goods receipt'),
  match_three_way_reverse: imm('reverses an immutable match header'),
  confirm_statement_gap: imm('the statements on both sides of the gap are imported bank facts'),
  revoke_statement_gap_confirmation: imm('the statements on both sides of the gap are imported bank facts'),
  apply_qr_match: imm('matches an imported incoming credit to an issued invoice; the issued invoice and its contact are read to settle, not to send'),
  override_qr_match: imm('matches an imported incoming credit to an issued invoice'),
  confirm_match: imm('matches an imported bank line to a posted bill or entry'),
  retry_automation_run: imm('re-sends the stored input of a stuck run, key included'),
  // payload: the payload is the effect.
  set_bank_sync_schedule: pay('mode and time are in the payload'),
  provision_release: pay('the released amount and target account are in the payload; the provision is posted'),
  record_payment: pay('amount, date, currency and allocations are in the payload; the counterparty is read for its name on the payment row'),
  allocate_payment: pay('the allocations are in the payload; the issued documents they settle are frozen'),
  create_bank_account: pay('name, IBAN and currency are in the payload'),
  update_bank_account: pay('the changed fields are in the payload'),
  set_bank_opening_balance: pay('amount, currency and date are in the payload'),
  set_role: pay('the new role is in the payload'),
  define_role: pay('the role name and capabilities are in the payload'),
  update_document_template: pay('the patch is in the payload'),
  update_automation_rule: pay('the patch is in the payload'),
  update_recurring_schedule: pay('the patch is in the payload'),
  notifications_deliver: pay('the event and its summary are in the payload; the recipient is a workspace user, whose preferences a governed seat may set only for itself (D161 N4)'),
  attach_receipt: pay('the receipt reference is in the payload; the bill is posted'),
  wage_journal_post: pay('the lines or the stored provider file are in the payload; mappingId is a provenance label only'),
  files_new_version: pay('the new content is in the payload'),
  files_link: pay('the link target is in the payload'),
  sign_requests_complete: pay('the signed content and its hash are in the payload'),
  vendor_portal_grant: pay('scopes and expiry are in the payload; the supplier reads the grant through the portal, nothing is mailed'),
  record_incoming_credit: pay('amount, value date and reference are in the payload'),
  import_camt: pay('the statement XML is in the payload'),
  import_camt_files: pay('the statement files are in the payload'),
  // D178 (D162): the file is in the payload, and a governed seat's CSV import is refused at draft time
  // unless its mapping is too (`prevalidateImportBankStatement`), so the saved mapping, which a person may
  // change before approving, is never what an approved CSV import reads.
  import_bank_statement: pay('the statement file is in the payload, and a drafted CSV import must carry its mapping there too (refused at draft time otherwise)'),
  set_bank_csv_mapping: pay('the whole mapping is in the payload; the Bankkonto is only where it is saved'),
  set_creditor_bank_profile: pay('the new IBAN is in the payload'),
  set_bank_standard: pay('the account and the MWST code are in the payload; the line is an imported bank fact, read only for its counterparty and direction'),
  migration_record_approval: pay('the approval binds the check hash in the payload'),
  migration_waive_control: pay('the waiver reason is in the payload'),
  import_open_items: pay('the open items are in the payload'),
  checklist_item_complete: pay('the evidence is in the payload'),
  inventory_valuation_set_item_method: pay('the method and its date are in the payload'),
  inventory_valuation_opening: pay('the opening lines are in the payload'),
  // state: a lifecycle flip.
  bank_channel_disconnect: st('ends the bank channel and destroys its keys'),
  revoke_member: st('ends a membership'),
  archive_role: st('archives a role'),
  resume_recurring_schedule: st('resumes a paused schedule; what it issues later is governed under issue'),
  end_recurring_schedule: st('ends a schedule'),
  reopen_bank_line: st('returns a bank line to the inbox by reversal'),
  // D178 point 19: the answer is checked against the line's flag and state at approval (not flagged, not
  // open, a candidate it is not named against all refuse), so a stale proposal refuses rather than records.
  resolve_possible_duplicate: st('answers the flag on an imported bank line; the flag, the candidates and the line state are checked again at approval'),
  clear_bank_standard: st('retires a standard; nothing booked changes'),
  migration_rollback_step: st('rolls a committed step back'),
  migration_close_plan: st('closes a finished plan; the steps it closes were committed through governed verbs'),
  implementation_project_close: st('closes an implementation project'),
  checklist_item_skip: st('skips an item, with the reason in the payload'),
  checklist_item_reopen: st('reopens an item'),
  checklist_abandon: st('abandons a run, with the reason in the payload'),
  // governed: what the act consumes only changes through governed verbs.
  set_default_document_template: gov('a template\'s content changes only through update_document_template, governed under customize; archiving is the only free change, and it falls back to the built-in default'),
  enable_plugin: gov('the manifest changes only through install_plugin, governed under plugin-install'),
  refresh_plugin_compat: gov('the manifest changes only through install_plugin, governed under plugin-install'),
  create_payment_batch: gov('the items are posted vendor bills, whose open amounts move only through governed pay verbs; the payee rows are pinned when the batch is generated and transmitted'),
  close_year: gov('sweeps the year\'s ledger, which changes only through governed posting verbs'),
  go_productive: gov('promotes the steps migration_commit_step committed, which is pinned'),
  // live: the act works on the state at execution time by design.
  bank_sync: { reason: 'live', why: 'fetches whatever the bank holds at execution time; that is what a sync is' },
  notifications_run_digest: { reason: 'live', why: 'a digest of the notifications due at execution time, to the user\'s own address' },
};

// --- what the structural test enforces about LIVE reads -----------------------------------------------

/** Why a table that a free verb can change may still be read live without a pin. */
export type LiveReadPolicy =
  /** Engine bookkeeping: the trace, the queue, the idempotency memo, the audit chain head. */
  | 'bookkeeping'
  /** The free changes can only make the act REFUSE (archive, cancel, status), never change what it does. */
  | 'gate-only'
  /** The free changes are presentation (names on screen, a template choice) or a view preference. */
  | 'presentation'
  /** The free writers touch columns no governed act reads (verified per column in the reason). */
  | 'unread-columns';

/**
 * THE TABLE CLASSIFICATION. Every table a governed act reads live that a free verb can change must be
 * here (or be pinned by the verb). `pin` means: an act that reads it must cover it in its pin or carry
 * a per-verb reason in `LIVE_READ_WAIVERS`.
 */
export const LIVE_READ_TABLES: Readonly<
  Record<string, { readonly policy: LiveReadPolicy | 'pin'; readonly why: string; readonly columns?: readonly string[] }>
> = {
  // pin: content an act consumes, freely changeable.
  contact: { policy: 'pin', why: 'email, address, name and language are what a send, a letter or a payment file uses; update_contact is free' },
  item: { policy: 'pin', why: 'revenue account, default code, cost and tracking; update_item is free' },
  document: { policy: 'pin', why: 'a draft document is freely editable (update_document, quotes_update)' },
  document_line: { policy: 'pin', why: 'a draft document\'s lines are freely editable' },
  tax_code: { policy: 'pin', why: 'vat_code_upsert, vat_code_deactivate and vat_code_reactivate are free and change the rate or validity a line is taxed at (R2-B2)' },
  employee: { policy: 'pin', why: 'hr_employee_upsert is free and changes the payee contact of a reimbursement (N-c)' },
  dunning_config: { policy: 'pin', why: 'set_dunning_config is free and sets the fee, the fee income account and the fee tax code an issue books' },
  purchase_order: { policy: 'pin', why: 'a draft order is freely editable (po_upsert), and po_revise reopens one' },
  po_line: { policy: 'pin', why: 'a draft order\'s lines are freely editable' },
  goods_receipt_doc: { policy: 'pin', why: 'a draft receipt is freely editable (goods_receipt_upsert_lines)' },
  goods_receipt_doc_line: { policy: 'pin', why: 'a draft receipt\'s lines are freely editable, and goods_receipt_reject_lines decides held lines' },
  time_entry: { policy: 'pin', why: 'open time rows are freely editable (time_update)' },
  cycle_count_line: { policy: 'pin', why: 'counts are recorded freely (inventory_stocktake_count)' },
  cycle_count_session: { policy: 'pin', why: 'a session is freely recounted or cancelled' },
  stocktake_line: { policy: 'pin', why: 'counts are recorded freely (stock_stocktake_count)' },
  po_amendment: { policy: 'pin', why: 'an amendment is freely submitted, rejected or cancelled' },
  po_amendment_line: { policy: 'pin', why: 'an amendment\'s lines are freely editable' },
  requisition: { policy: 'pin', why: 'a requisition is freely submitted, returned or rejected' },
  requisition_approval_task: { policy: 'pin', why: 'the approval tasks move with the requisition\'s free transitions' },
  delivery_note: { policy: 'pin', why: 'a draft note is freely re-rendered and its order cancelled' },
  sales_order: { policy: 'pin', why: 'an order is freely confirmed, invoiced or cancelled' },
  so_line: { policy: 'pin', why: 'an order\'s lines move with its free transitions' },
  ebill_deliveries: { policy: 'pin', why: 'ebill_prepare is free and rewrites the prepared delivery' },
  sign_request: { policy: 'pin', why: 'a request is freely withdrawn or has events recorded' },
  portal_grant: { policy: 'pin', why: 'a grant is freely revoked, and resolving it stamps it' },
  migration_plan: { policy: 'pin', why: 'the scope is free (migration_set_scope)' },
  migration_step: { policy: 'pin', why: 'trial loads and checks are free and restage a step' },
  migration_control_total: { policy: 'pin', why: 'control totals are declared freely' },
  migration_map: { policy: 'pin', why: 'maps are set freely (migration_set_map, migration_apply_map_template)' },
  inventory_reason_code: { policy: 'pin', why: 'reason codes are freely updated or archived' },
  expense_claim: { policy: 'pin', why: 'a claim is freely submitted or rejected' },
  provision: { policy: 'pin', why: 'a draft provision is freely discarded' },
  accrual: { policy: 'pin', why: 'a draft accrual is freely discarded' },
  recurring_schedule: { policy: 'pin', why: 'a schedule is freely paused' },
  asset: { policy: 'pin', why: 'the asset master (accounts, useful life, method) is freely updated (asset_update) or transferred' },
  // not pinned, with the reason a free change cannot alter the act.
  // Critic round 3 (N1): column-scoped. The free branches of update_company_profile (no mwstNo) and
  // set_creditor_profile (no IBAN) change the printed identity, so an act whose SQL reads those columns
  // pins them (WORKSPACE_IDENTITY); an act that reads the workspace for its tenant check, base currency,
  // VAT method or fiscal year is not bound, and those columns change freely only through
  // set_fiscal_config, which refuses once the ledger holds postings (needs_empty_ledger), archive (every
  // act then refuses) and a trial-workspace link.
  workspace: {
    policy: 'pin',
    columns: WORKSPACE_IDENTITY_COLUMNS,
    why: 'name, legal form, UID, MWST number and the creditor name, address and IBAN are what an issued invoice, its QR-bill, a reminder, a delivery note, a purchase order and a pain.001 file print; the free branches of update_company_profile and set_creditor_profile change them',
  },
  automation_rule: { policy: 'gate-only', why: 'read by the G01 dispatch after the act to fire rules; the free writers only archive or disable a rule, and what a rule may do is governed by its tier (ruleTier.ts)' },
  audit_head: { policy: 'bookkeeping', why: 'the head of the hash-chained audit log, advanced by every audited write' },
  agent_turn: { policy: 'bookkeeping', why: 'the agent trace (A35), read to delete or blank prose; no act books or sends from it' },
  agent_call: { policy: 'bookkeeping', why: 'the agent trace (A35), read to blank a contact\'s traces; no act books or sends from it' },
  agent_session: { policy: 'bookkeeping', why: 'the agent trace (A35), read to delete a session\'s prose; no act books or sends from it' },
  inbox_item: { policy: 'bookkeeping', why: 'the notification inbox; marking read or archiving changes nothing an act consumes' },
  notification_pref: { policy: 'unread-columns', why: 'a governed seat sets only its own preferences (D161 N4); a person\'s channel choice is theirs to change' },
  account: { policy: 'unread-columns', why: 'number and type are frozen; the free writers rename, archive (posting then refuses), flag cost centres (posting refuses a disallowed one), or set vat_code_default, which only proposals and the bank model read, never an executing act' },
  stored_file: { policy: 'unread-columns', why: 'the free writers change name, folder and retention; the bytes are content-addressed (stored_file_blob, which no free verb rewrites)' },
  bank_account: { policy: 'gate-only', why: 'the free writers archive or unarchive an account; an act on an archived account refuses' },
  stock_location: { policy: 'gate-only', why: 'the free writers rename, re-parent, archive or set a warehouse default; every act names its location in its payload or its pinned record, and an archived location refuses' },
  aging_bucket_config: { policy: 'presentation', why: 'a view preference: it re-partitions open items into aging buckets for display; no total, posting or letter depends on it' },
  document_template: { policy: 'presentation', why: 'archiving is the only free change and falls back to the built-in default; a template\'s text changes only through update_document_template, governed under customize' },
  vendor_bill: { policy: 'unread-columns', why: 'capture_commit fills a DRAFT bill; the pinned acts on a bill pin it (post_vendor_bill, the matches), and every other reader takes a posted bill, whose accounting columns a DB trigger freezes' },
  payment_batch: { policy: 'gate-only', why: 'the only free writer is env_create, which writes into a NEW environment\'s data root, not this workspace' },
  bank_line_decision: { policy: 'gate-only', why: 'the only free writer is env_create, which writes into a NEW environment\'s data root, not this workspace' },
  plugin_manifests: { policy: 'gate-only', why: 'disable_plugin, the stop button, is the only free writer; enabling is governed' },
  inventory_config: { policy: 'gate-only', why: 'allow_negative_stock decides whether a move refuses, never what it books' },
  goods_receipt_config: { policy: 'gate-only', why: 'the over-receipt tolerance decides whether a receipt refuses, never what it books when it does not' },
  inventory_valuation_config: { policy: 'gate-only', why: 'enabling or disabling a method decides whether a method change refuses' },
  custom_field_def: { policy: 'gate-only', why: 'archive and confirm of a field definition; define_field is governed under customize' },
  custom_field_value: { policy: 'presentation', why: 'workspace-defined extra fields on a record, read by deletes to remove them; no act books or sends from them' },
  dispatch_texts: {
    policy: 'presentation',
    why: 'dispatch_text_upsert is governed, and since round 3 (N2) so is dispatch_text_reset of a slot holding saved text; the only free reset is of a slot with none, which changes nothing',
  },
  sync_publish_state: { policy: 'gate-only', why: 'the free writer is the stop button (sync_publish_disable)' },
  skonto_term: { policy: 'unread-columns', why: 'read by the payment proposal, whose lines are frozen once proposed (liquidity_plan_draft_batches drafts from the frozen plan)' },
  cost_center: { policy: 'gate-only', why: 'archive and unarchive only; posting to an archived cost centre refuses' },
  project: { policy: 'gate-only', why: 'read by project_delete to refuse a project that is not a draft' },
  project_phase: { policy: 'gate-only', why: 'read by project_delete to remove the phases' },
  saved_reports: { policy: 'gate-only', why: 'read by reports_delete to remove the definition' },
  parallel_run_declaration: { policy: 'gate-only', why: 'read by implementation_project_close as a precondition' },
  checklist_run_item: {
    policy: 'gate-only',
    why: 'an agent-owned step completed freely (checklist_item_complete outside its governed attestation and sign-off branches) only moves a run toward its seal steps, which are governed and re-check their prerequisites; no act books or sends from a step\'s state',
  },
  migration_extraction_manifest: { policy: 'gate-only', why: 'read by the extraction checks before a trial load, not by a commit' },
};

// --- the column census (B-1, independent critic 13.10.2026) -------------------------------------------

/**
 * Why a column an approved act reads of a table its pin covers is NOT digested. The table census holds
 * which TABLES a pin covers; this holds the columns inside them, because a new column on an already
 * pinned table (D164 `document.supply_date` meeting D162's pin) is exactly what a table-level check
 * cannot see. The suite traces every pinned verb's approval and fails on any column it reads that is
 * neither in the pin (`pinnedColumnsFor`) nor named here. `id` and `workspace_id` (row identity and the
 * tenant) are exempt generically; everything else is named, so a column added later fails until
 * someone decides whether it is content.
 */
const STAMP = 'a who or when stamp of the record\'s own lifecycle; no act books, prices, prints or sends from it';
const ROW_KEY = 'an idempotency memo key, a token hash or a partner correlation id; it selects or deduplicates, it carries no content';
const LIFECYCLE = 'lifecycle state (the status and the reason recorded with a transition): the act reads it to refuse outside the state it acts from, so a free change can only make it refuse';
const RESULT = 'a result a governed act writes (its posting, movement, number, artefact or link): read to refuse a second run or to link the result, never as input to what the act books or sends';

function because(why: string, ...columns: string[]): Record<string, string> {
  return Object.fromEntries(columns.map((c) => [c, why]));
}

export const UNPINNED_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  accrual: {
    ...because(STAMP, 'created_at', 'created_by', 'discarded_at', 'posted_at', 'posted_by', 'reversed_at', 'reversed_by', 'updated_at'),
    ...because(ROW_KEY, 'idempotency_key', 'post_idempotency_key', 'reverse_idempotency_key'),
    ...because(LIFECYCLE, 'discard_reason', 'reverse_reason', 'status'),
    ...because(RESULT, 'entry_id', 'reversal_entry_id', 'storno_entry_id', 'storno_reversal_entry_id'),
  },
  asset: {
    ...because(STAMP, 'created_at', 'created_by', 'disposed_at', 'updated_at'),
    ...because(LIFECYCLE, 'status'),
    ...because(
      'the financial baseline and its convenience columns: an acquisition or opening balance seats cost and date from its own input, and once the asset leaves draft asset_update refuses them (financial_fields_locked); only governed acts (acquisition, capitalisation, depreciation, disposal) move them after that',
      'acquisition_cost_rappen', 'acquisition_date', 'accumulated_depr_rappen', 'net_book_value_rappen', 'last_depreciation_period', 'disposal_proceeds_rappen',
    ),
    ...because(
      'descriptive master data read with the row (SELECT *); no acquisition, capitalisation, disposal or opening posting reads it',
      'barcode', 'description', 'location_id', 'manufacturer', 'model', 'notes', 'responsible_user_id', 'serial_number', 'total_estimated_units', 'warranty_until',
    ),
  },
  contact: {
    ...because(STAMP, 'created_at'),
    ...because('CRM tags and the drafting-assistant grounding switch; no act prints, sends or books from them', 'roles', 'segments', 'ledger_grounding_enabled'),
  },
  cycle_count_line: {
    ...because(STAMP, 'counted_at', 'counted_by'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'movement_id'),
  },
  cycle_count_session: {
    ...because(STAMP, 'cancelled_at', 'committed_at', 'committed_by', 'created_at', 'created_by'),
    ...because(LIFECYCLE, 'cancel_reason', 'status'),
    ...because(RESULT, 'inventar_document_id'),
    ...because('a free-text note and a line count of the pinned lines; the commit books from the lines', 'notes', 'total_lines'),
  },
  delivery_note: {
    ...because(STAMP, 'actor', 'created_at', 'issued_at'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'artifact_document_id', 'number'),
  },
  document: {
    ...because(STAMP, 'created_at'),
    ...because(ROW_KEY, 'accept_token_hash'),
    ...because(LIFECYCLE, 'decline_reason', 'status', 'accepted_by'),
    ...because(RESULT, 'number', 'posted_entry_id', 'rendered_template_id', 'rendered_template_snapshot', 'sent_to_email', 'issue_date'),
    ...because('recomputed by the issue from the pinned lines and their codes (A11 B-1); on an issued document frozen with it', 'tax_minor', 'total_minor'),
    ...because('fixed when the document is created (native or migrated, G21); read only by the transition guard', 'origin'),
    ...because('the quote revision chain (quotes_revise writes them on a NEW document); no issue, send or settlement reads them as content', 'supersedes_id', 'version'),
    ...because('written only by the credit-note derivation (the one writer, A13); a dunning run reads it to net credited invoices, which settles issued documents whose figures are frozen', 'credited_document_id'),
  },
  dunning_config: { ...because(STAMP, 'updated_at') },
  ebill_deliveries: {
    ...because(STAMP, 'created_at', 'transmitted_at', 'updated_at'),
    ...because(ROW_KEY, 'business_case_id', 'correlation_id', 'idempotency_key'),
    ...because(LIFECYCLE, 'partner_reason', 'partner_status', 'status'),
  },
  employee: {
    ...because(STAMP, 'created_at', 'created_by', 'updated_at'),
    ...because(ROW_KEY, 'idempotency_key'),
    ...because('HR master data read with the row; a reimbursement pays the employee\'s payee contact (pinned) and reads none of these', 'ahv_nr', 'employment_pct', 'ends_on', 'starts_on'),
  },
  expense_claim: {
    ...because(STAMP, 'approved_at', 'created_at', 'created_by', 'reimbursed_at', 'submitted_at'),
    ...because(ROW_KEY, 'idempotency_key'),
    ...because(LIFECYCLE, 'reject_reason', 'status'),
    ...because(RESULT, 'payment_id', 'posted_entry_id', 'reversal_entry_id'),
    ...because('the snapshot of the pinned lines\' base amounts taken at submit (hr/schema.ts); a change of it needs a change of the lines, which the pin sees', 'total_base_minor'),
  },
  goods_receipt_doc: {
    ...because(STAMP, 'cancelled_at', 'created_at', 'created_by', 'posted_at', 'posted_by', 'reversed_at', 'reversed_by', 'updated_at'),
    ...because(ROW_KEY, 'idempotency_key'),
    ...because(LIFECYCLE, 'cancel_reason', 'status'),
    ...because(RESULT, 'number', 'has_over_receipt'),
    ...because('the expected delivery date, read by the supplier-performance report only', 'expected_at'),
  },
  goods_receipt_doc_line: {
    ...because(STAMP, 'recognised_at', 'rejected_at'),
    ...because(LIFECYCLE, 'reject_reason'),
    ...because(RESULT, 'movement_id', 'reversal_movement_id', 'reversal_trail_line_id', 'trail_line_id', 'over_receipt_qty', 'billed_qty'),
    ...because('the order a line came from (its order line is pinned) and the display position', 'po_id', 'line_no'),
  },
  inventory_reason_code: {
    ...because(STAMP, 'created_at', 'created_by', 'updated_at'),
    ...because('the reason\'s label text for display; the movement books by the code', 'description'),
  },
  item: { ...because('the low-stock threshold an attention notice compares against after a move; nothing booked depends on it', 'reorder_point_qty') },
  migration_map: { ...because('a provenance label of where a map came from (template or hand set); the commit applies the pinned entries', 'provenance') },
  migration_plan: {
    ...because(STAMP, 'closed_at', 'created_at', 'created_by'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'backup_ref'),
    ...because('the plan\'s Testmandant, a sibling workspace a trial load writes into; a commit to this workspace does not read its rows', 'testmandant_workspace_id'),
  },
  migration_step: {
    ...because(STAMP, 'committed_at', 'created_at', 'updated_at'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'last_check_id'),
  },
  po_amendment: {
    ...because(STAMP, 'applied_at', 'applied_by', 'cancelled_at', 'cancelled_by', 'created_at', 'created_by', 'rejected_at', 'rejected_by', 'submitted_at', 'submitted_by'),
    ...because(ROW_KEY, 'idempotency_key'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'to_version_id'),
  },
  po_amendment_line: {
    ...because('the order line as it stood when the amendment was drafted, kept for the diff view; the apply writes the pinned after values onto the order line, which is pinned beside it', 'before_description', 'before_qty', 'before_unit_price_rappen'),
  },
  portal_grant: {
    ...because(STAMP, 'created_at', 'created_by', 'last_resolved_at', 'revoked_at', 'sent_at', 'updated_at'),
    ...because(ROW_KEY, 'minted_draft', 'token_hash'),
    ...because(RESULT, 'local_artifact_json'),
  },
  provision: {
    ...because(STAMP, 'created_at', 'created_by', 'discarded_at', 'posted_at', 'posted_by', 'reversed_at', 'reversed_by'),
    ...because(ROW_KEY, 'idempotency_key', 'post_idempotency_key', 'reverse_idempotency_key'),
    ...because(LIFECYCLE, 'discard_reason', 'reverse_reason', 'status'),
    ...because(RESULT, 'entry_id', 'reversal_entry_id'),
  },
  purchase_order: {
    ...because(STAMP, 'created_at', 'updated_at'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'number', 'sent_artifact_ref', 'revision'),
    ...because('the CHF conversion of the pinned total at the pinned rate (H-FX), stored at creation', 'total_base_rappen'),
    ...because('printed on the order itself (po_send pins them) and copied into its version snapshot; a receipt or a match books quantities and costs from the pinned lines', 'expected_on', 'note'),
    ...because('the source a converted order came from (provenance link)', 'source_document_id', 'source_document_type'),
  },
  requisition: {
    ...because(STAMP, 'approved_at', 'closed_at', 'created_at', 'created_by', 'submitted_at', 'updated_at'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'number'),
  },
  requisition_approval_task: { ...because(STAMP, 'created_at', 'decided_at') },
  sales_order: {
    ...because(STAMP, 'actor', 'created_at'),
    ...because(RESULT, 'number'),
    ...because(
      'read with the order row (SELECT *); a delivery note carries the order\'s number and quantities, never a price, rate, date or note of the order',
      'expected_on', 'fx_rate', 'notes', 'order_date', 'quote_id', 'supply_date',
    ),
  },
  sign_request: {
    ...because(STAMP, 'created_at', 'requested_by', 'sent_at', 'signed_at', 'updated_at', 'viewed_at'),
    ...because(ROW_KEY, 'provider_ref'),
    ...because(LIFECYCLE, 'declined_reason', 'expired_reason', 'status'),
    ...because(RESULT, 'signed_file_id'),
    ...because(
      'the request envelope: the file hash, signer and message frozen from the pinned columns when the draft was created, plus an append-only event trail; the free event recorder only moves a request to a state in which send refuses (`document_sha256` is the file hash it froze, the file itself being pinned)',
      'local_artifact_json', 'document_sha256',
    ),
  },
  so_line: {
    ...because(STAMP, 'created_at'),
    ...because(
      'read with the order lines (SELECT *); a delivery note books quantities by item, never a price, rate or date of the order line',
      'backorder_qty', 'fx_rate', 'invoiced_qty', 'supply_date', 'unit_price_base_rappen',
    ),
  },
  time_entry: {
    ...because(STAMP, 'approved_at', 'approved_by', 'created_at', 'locked_at', 'submitted_at', 'updated_at'),
    ...because(LIFECYCLE, 'status'),
    ...because(RESULT, 'invoice_line_id'),
    ...because('the rate the entry was priced at, read with the row; approve and lock flip the status and price nothing', 'cost_rate_minor', 'rate_card_id', 'rate_scope'),
  },
};

/**
 * Per-verb reasons for a `pin` table an act reads live without pinning it: the read is not content
 * of the act (a name on a row, a status check that can only refuse).
 */
const ISSUED = 'settles or reverses ISSUED documents only (a draft refuses), whose figures are frozen; the free writers of `document` edit drafts';
const CONTACT_NAME = 'reads the contact to check it (exists, role, not archived or merged) and for its name on a row; no address or email of it is printed or sent';
const STATUS_GATE = 'reads the row\'s status; the free writer only moves a draft to a state in which this verb refuses';
const MIGRATION_STATE = 'a lifecycle step on the plan; the content it moves was committed through migration_commit_step, which pins the step, its rows, maps and source';
const ENV = 'copies or resets an environment\'s data root wholesale; it consumes no row\'s content as an effect';

export const LIVE_READ_WAIVERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // Settlement of issued documents.
  record_payment: { document: ISSUED, contact: CONTACT_NAME },
  allocate_payment: { document: ISSUED, contact: CONTACT_NAME },
  apply_qr_match: { document: ISSUED, contact: CONTACT_NAME },
  override_qr_match: { document: ISSUED, contact: CONTACT_NAME, expense_claim: 'reads a reimbursed claim to reopen it; claims move freely only between draft, submitted and rejected, where this verb refuses' },
  reverse_payment: { document: ISSUED, expense_claim: 'reads a reimbursed claim to reopen it; claims move freely only between draft, submitted and rejected, where this verb refuses' },
  confirm_match: { contact: CONTACT_NAME },
  // Inert drafts a pinned verb acts on later.
  propose_dunning_run: {
    document: 'a proposed run is inert (it books and sends nothing); issue_dunning_run pins the run, its items, the debtors, the dunned invoices and the dunning setup as they stand when the person approves the issue',
    contact: 'a proposed run is inert; issue_dunning_run and send_dunning_run pin the debtors',
    dunning_config: 'a proposed run is inert; issue_dunning_run pins the dunning setup it books with',
  },
  create_payment_batch: {
    contact: 'the batch is an inert draft; generate_pain001 and payment_batch_transmit pin the batch, its items and its payees',
    workspace: 'freezes the debtor name and IBAN onto the inert draft batch; generate_pain001 and payment_batch_transmit pin those frozen columns and the workspace identity',
  },
  set_creditor_profile: { workspace: 'the new payee name, address and IBAN are the payload; the current row is read to merge them' },
  vat_configure: { workspace: 'reads the VAT columns it sets (method, timing, registration); the identity columns the row read returns are not part of its effect' },
  discard_orphan_testmandant: { workspace: 'deletes a trial workspace; nothing of its identity is carried forward' },
  liquidity_plan_draft_batches: {
    contact: 'drafts inert payment batches from the frozen plan lines; generate_pain001 and payment_batch_transmit pin each batch and its payees',
    workspace: 'freezes the debtor name and IBAN onto inert draft batches; generate_pain001 and payment_batch_transmit pin them',
    document: 'reads open receivables for the liquidity forecast refresh, not for the drafted batches, whose figures come from the frozen plan lines',
    tax_code: 'reads codes for the forecast\'s VAT lines, not for the drafted batches',
    recurring_schedule: 'reads schedules for the forecast, not for the drafted batches',
  },
  requisition_convert_to_po: { purchase_order: 'creates a NEW draft order; po_send pins it, its lines, items and supplier when it is sent' },
  // Ticks: the scheduler's own act, live by design (D161.1: gated for the agent's own call only).
  run_due_recurring: {
    recurring_schedule: 'issues the schedules due at execution; their content is frozen at creation and changes only through governed update_recurring_schedule (pause is free and only skips a schedule)',
    document: 'reads template and prior documents of due schedules; the invoices it issues are built from the frozen schedule lines',
    document_line: 'reads the lines of the documents a due schedule produced before; the new invoice is built from the frozen schedule lines',
    contact: 'the customer of a due schedule, read as every unattended scheduler run reads it (the scheduler keeps running, D161.1)',
  },
  run_due_automations: {
    item: 'the tick fires the rules due at execution; what each rule does is governed by its own tier (ruleTier.ts)',
    migration_plan: 'the tick fires the rules due at execution; what each rule does is governed by its own tier (ruleTier.ts)',
  },
  // Status gates and lifecycle flips.
  accrual_reverse: { accrual: STATUS_GATE },
  provision_release: { provision: STATUS_GATE },
  provision_reverse: { provision: STATUS_GATE },
  provision_release_reverse: { provision: STATUS_GATE },
  sign_requests_complete: { sign_request: STATUS_GATE },
  sign_requests_delete_draft: { sign_request: STATUS_GATE },
  portal_quote_accept: { portal_grant: 'reads the grant to check the token is live; revoking it (free) makes the accept refuse' },
  vendor_portal_grant: { portal_grant: 'reads the supplier\'s existing grants; revoking one (free) changes nothing this grant opens', contact: 'reads the contact to check it is a supplier; the link is returned, not mailed' },
  create_recurring_schedule: { recurring_schedule: 'reads existing schedules for the duplicate check; pausing one (free) changes nothing this schedule holds' },
  update_recurring_schedule: { recurring_schedule: 'reads the schedule the patch applies to; the patch is the payload, and pause (free) only stops it running' },
  resume_recurring_schedule: { recurring_schedule: 'a lifecycle flip on a paused schedule' },
  end_recurring_schedule: { recurring_schedule: 'a lifecycle flip' },
  time_delete: { time_entry: 'a delete of an open row; nothing of it is carried forward' },
  set_creditor_bank_profile: { contact: CONTACT_NAME },
  files_link: { contact: 'reads the link target to check it exists' },
  attach_receipt: { contact: CONTACT_NAME },
  notifications_deliver: { contact: 'reads the entity the notice is about for its name; the notice goes to a workspace user' },
  mail_reindex: { contact: 'rebuilds the search index; it links messages to contacts by address and changes no business row' },
  // Immutable records read for their mirror or reversal.
  void_vendor_bill: { contact: 'voids a posted bill by mirroring its stored entry; the contact is read for the mirror\'s label', tax_code: 'voids a posted bill by mirroring its stored entry; the VAT legs are the posted ones, not recomputed' },
  goods_receipt_reverse: {
    goods_receipt_doc: 'reverses a POSTED receipt, which is frozen (upsert and reject refuse a posted receipt)',
    goods_receipt_doc_line: 'reverses a POSTED receipt\'s lines, which are frozen',
    item: 'reverses the stored movements at their stored costs',
    purchase_order: 'reduces the received quantities by the stored receipt quantities',
  },
  inventory_adjust_reverse: { inventory_reason_code: 'mirrors a posted adjustment; the reason is read for the mirror\'s label', item: 'mirrors the stored movement at its stored cost' },
  landed_cost_reverse: { item: 'mirrors the allocated movements at their stored values' },
  asset_depreciation_run_post: { asset: 'posts a run whose lines and amounts are frozen by DB triggers; the asset is read to roll its accumulated figures forward' },
  asset_depreciation_run_reverse: { asset: 'mirrors a posted run; the asset is read to roll its accumulated figures back' },
  inventory_valuation_opening: { item: 'the opening lines carry their quantities and costs; the item is read to check it exists and is stock-tracked' },
  inventory_valuation_set_item_method: { item: 'the method is the payload; the item is read to check it exists' },
  // Deletes.
  delete_item: { item: 'a delete of an unreferenced item', document_line: 'reads references only to refuse' },
  item_categories_delete: { item: 'reads the category\'s items only to refuse' },
  contacts_merge: { contact: 'the merge consumes both contacts as they are; both are named on the card and the merge is the erase act itself' },
  contacts_anonymise: { contact: 'blanks the contact as it is; anonymising is the erase act itself', document: 'blanks the contact\'s name on its documents; no figure is read' },
  discard_payment_batch: { contact: 'a discard; nothing is paid or transmitted' },
  discard_testmandant: { migration_plan: MIGRATION_STATE, migration_step: MIGRATION_STATE, workspace: 'deletes the trial workspace; nothing of its identity is carried forward' },
  // Migration lifecycle.
  migration_abandon_plan: { migration_plan: MIGRATION_STATE, migration_step: MIGRATION_STATE },
  migration_close_plan: { migration_plan: MIGRATION_STATE, migration_step: MIGRATION_STATE, migration_control_total: MIGRATION_STATE },
  migration_rollback_step: { migration_plan: MIGRATION_STATE, migration_step: MIGRATION_STATE },
  migration_record_approval: {
    migration_plan: 'the approval binds the check hash in the payload; a commit refuses unless the step still checks to exactly that hash',
    migration_step: 'the approval binds the check hash in the payload; a commit refuses unless the step still checks to exactly that hash',
  },
  migration_waive_control: { migration_control_total: 'the waiver and its reason are the payload; the control is read to record it' },
  go_productive: {
    migration_plan: MIGRATION_STATE,
    migration_step: MIGRATION_STATE,
    workspace: 'promotes the trial workspace into the books; the identity stays the workspace\'s own and is not printed by the promotion',
  },
  import_open_items: {
    contact: 'the items carry their contact ids; the contact is read only to check role and existence (contact_unmapped otherwise)',
    document: 'reads existing documents only for the duplicate-number check',
    document_line: 'reads existing lines only for the duplicate check',
    tax_code: 'the items carry their resolved tax as stored values (P6); the code is read to check it exists',
    migration_plan: MIGRATION_STATE,
  },
  // D167: the generation-11 data migration reads `tax_code` when the new data root's store opens.
  env_copy: { portal_grant: ENV, workspace: ENV, tax_code: ENV },
  env_reset: { workspace: ENV, tax_code: ENV },
  // D167: a standard stores its MWST code by value and prices nothing; the code is read only to refuse
  // one that does not exist or is archived, so a free change can only make the act refuse.
  set_bank_standard: { tax_code: 'read only to check the code exists and is active; the standard stores the code by value and computes no tax' },
};

// --- the snapshot ----------------------------------------------------------------------------------

/** The key figures the card shows for the primary record, frozen at proposal. */
export interface VorschlagFigures {
  readonly record: PinRecordKind;
  /** The record's number, or null. */
  readonly number: string | null;
  /** True when the record carries a number once issued and has none yet: the card says "draft". */
  readonly numberPending: boolean;
  readonly counterparty: string | null;
  /** The email(s) a send goes to (R2-B1: the card shows the recipient). */
  readonly recipient: string | null;
  readonly amountMinor: number | null;
  readonly amountBasis: 'net' | 'amount' | null;
  readonly currency: string | null;
  /** The VAT the act computes and the gross it books, when the record has a VAT figure. */
  readonly taxMinor: number | null;
  readonly grossMinor: number | null;
  readonly lineCount: number | null;
}

/** The pin stored with a drafted action. */
export interface VorschlagPin {
  readonly digest: string;
  readonly figures: VorschlagFigures | null;
}

interface DepSnapshot {
  readonly table: string;
  readonly keys: readonly string[];
  readonly rows: readonly Row[];
  readonly deps: readonly DepSnapshot[];
}

interface RecordSnapshot {
  readonly row: Row | null;
  readonly children: readonly (readonly Row[])[];
  readonly deps: readonly DepSnapshot[];
}

/** Canonical JSON: object keys sorted at every level, so the digest never depends on key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.keys(value as Row)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Row)[key])}`);
  return `{${entries.join(',')}}`;
}

/** Every `field` of the objects in a JSON array stored in `raw` (nothing when it is not one). */
function jsonArrayField(raw: unknown, field: string): unknown[] {
  if (typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map((e) => (e !== null && typeof e === 'object' ? (e as Row)[field] : undefined)) : [];
  } catch {
    return [];
  }
}

function keysFrom(source: KeySource, rows: readonly Row[], children: Readonly<Record<string, readonly Row[]>>): string[] {
  const values =
    'row' in source
      ? rows.map((r) => r[source.row])
      : 'json' in source
        ? rows.flatMap((r) => jsonArrayField(r[source.json], source.field))
        : (children[source.child] ?? []).map((r) => r[source.column]);
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))].sort();
}

function snapshotDep(ctx: WorkspaceContext, dep: DepSpec, keys: readonly string[]): DepSnapshot {
  if (dep.self === true) {
    const row = ctx.store.db.prepare(`SELECT ${dep.columns.join(', ')} FROM ${dep.table} WHERE id = ?`).get(ctx.workspaceId) as Row | undefined;
    return { table: dep.table, keys: [ctx.workspaceId], rows: row === undefined ? [] : [row], deps: [] };
  }
  if (keys.length === 0) return { table: dep.table, keys, rows: [], deps: [] };
  // §H-TENANT: every dependency read is inside the workspace.
  const rows = (
    ctx.store.db
      .prepare(`SELECT ${dep.columns.join(', ')} FROM ${dep.table} WHERE workspace_id = ? AND ${dep.key} IN (${keys.map(() => '?').join(', ')})`)
      .all(ctx.workspaceId, ...keys) as Row[]
  ).sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
  const nested = (dep.deps ?? []).map((d) => snapshotDep(ctx, d, keysFrom(d.from, rows, {})));
  return { table: dep.table, keys, rows, deps: nested };
}

function snapshotRecord(ctx: WorkspaceContext, spec: RecordSpec, id: string): RecordSnapshot {
  const idColumn = spec.idColumn ?? 'id';
  if (spec.self === true) {
    const row = ctx.store.db.prepare(`SELECT ${spec.columns.join(', ')} FROM ${spec.table} WHERE id = ?`).get(ctx.workspaceId) as Row | undefined;
    return { row: row ?? null, children: [], deps: [] };
  }
  if (spec.many === true) {
    // Every row under the key, in a stable order: a version inserted after the proposal changes it.
    const rows = (
      ctx.store.db.prepare(`SELECT ${spec.columns.join(', ')} FROM ${spec.table} WHERE workspace_id = ? AND ${idColumn} = ?`).all(ctx.workspaceId, id) as Row[]
    ).sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
    return { row: { rows }, children: [], deps: [] };
  }
  // §H-TENANT: the workspace is part of every read, so a foreign id reads as absent.
  const row =
    (ctx.store.db
      .prepare(`SELECT ${spec.columns.join(', ')}, id, workspace_id FROM ${spec.table} WHERE workspace_id = ? AND ${idColumn} = ?`)
      .get(ctx.workspaceId, id) as Row | undefined) ?? null;
  if (row === null) return { row: null, children: [], deps: [] };
  const content = spec.normalize === undefined ? row : spec.normalize(ctx, row);
  const byTable: Record<string, readonly Row[]> = {};
  const children = (spec.children ?? []).map((child) => {
    const lines = ctx.store.db
      .prepare(`SELECT ${child.columns.join(', ')} FROM ${child.table} WHERE workspace_id = ? AND ${child.fk} = ? ORDER BY ${child.order}, id`)
      .all(ctx.workspaceId, id) as Row[];
    byTable[child.table] = lines;
    return lines;
  });
  const deps = (spec.deps ?? []).map((d) => snapshotDep(ctx, d, keysFrom(d.from, [row], byTable)));
  return { row: content, children, deps };
}

function idsOf(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return [];
}

/** The values a path names in the input: `a`, `a[]`, `a.b`, `a.b[].c` (every element of an array). */
function valuesAt(payload: unknown, path: string): unknown[] {
  let current: unknown[] = [payload];
  for (const raw of path.split('.')) {
    const each = raw.endsWith('[]');
    const key = each ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const node of current) {
      if (node === null || typeof node !== 'object') continue;
      const v = (node as Row)[key];
      if (each) {
        if (Array.isArray(v)) next.push(...(v as unknown[]));
      } else if (v !== undefined) next.push(v);
    }
    current = next;
  }
  return current;
}

/** The ids a pin field names in this payload (the workspace itself for a workspace-level record). */
function fieldIds(ctx: WorkspaceContext, f: PinField, payload: Readonly<Record<string, unknown>>): string[] {
  if (f.workspace === true) return [ctx.workspaceId];
  if (f.field === undefined) return [];
  return [...new Set(valuesAt(payload, f.field).flatMap(idsOf))].sort();
}

/** The fields of `verb` this payload actually pins (present, and not overridden by an `unless` field). */
function activeFields(ctx: WorkspaceContext, verb: string, payload: Readonly<Record<string, unknown>>): PinField[] {
  return (PIN_FOR_VERB[verb] ?? []).filter((f) => fieldIds(ctx, f, payload).length > 0 && (f.unless === undefined || payload[f.unless] === undefined));
}

function figuresOf(ctx: WorkspaceContext, kind: PinRecordKind, snapshot: RecordSnapshot, id: string): VorschlagFigures | null {
  const spec: RecordSpec = PIN_RECORDS[kind];
  const f = spec.figures ?? {};
  if (snapshot.row === null) return null;
  const extra = new Set<string>();
  if (f.number !== undefined) extra.add(f.number);
  if (f.vatColumns !== undefined) {
    extra.add(f.vatColumns.tax);
    extra.add(f.vatColumns.gross);
  }
  const row: Row =
    extra.size === 0
      ? snapshot.row
      : {
          ...snapshot.row,
          ...(ctx.store.db
            .prepare(`SELECT ${[...extra].join(', ')} FROM ${spec.table} WHERE workspace_id = ? AND ${spec.idColumn ?? 'id'} = ?`)
            .get(ctx.workspaceId, id) as Row),
        };
  const lines = snapshot.children[0] ?? [];
  const firstChild = spec.children?.[0];
  const text = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  // The counterparty and the recipient, from the contacts the pin itself read.
  let counterparty: string | null = null;
  let recipient: string | null = null;
  if (f.contact !== undefined) {
    const contactIds = keysFrom(f.contact, [row], firstChild === undefined ? {} : { [firstChild.table]: lines });
    if (contactIds.length > 0) {
      const contacts = ctx.store.db
        .prepare(`SELECT id, name, email FROM contact WHERE workspace_id = ? AND id IN (${contactIds.map(() => '?').join(', ')}) ORDER BY id`)
        .all(ctx.workspaceId, ...contactIds) as { id: string; name: string | null; email: string | null }[];
      const names = contacts.map((c) => text(c.name)).filter((n): n is string => n !== null);
      const emails = [...new Set(contacts.map((c) => text(c.email)).filter((e): e is string => e !== null))];
      counterparty = names.length === 0 ? null : names.length === 1 ? (names[0] as string) : `${names[0] as string} +${names.length - 1}`;
      recipient = emails.length === 0 ? null : emails.length <= 3 ? emails.join(', ') : `${emails.slice(0, 3).join(', ')} +${emails.length - 3}`;
    }
  }

  let amountMinor: number | null = null;
  if (f.amount !== undefined) {
    const column = f.amount.column;
    if (f.amount.from === 'row') amountMinor = num(row[column]);
    else if (lines.length > 0) amountMinor = lines.reduce((sum, l) => sum + (num(l[column]) ?? 0), 0);
  }
  let currency: string | null = null;
  if (f.currency !== undefined) {
    if ('fixed' in f.currency) currency = f.currency.fixed;
    else if (f.currency.from === 'row') currency = text(row[f.currency.column]);
    else currency = text(lines[0]?.[f.currency.column]);
  }

  // R2 (critic note): VAT and gross beside the net. For a document, computed per line through the
  // same `computeLineTax` the issue path calls, at the rate the pinned tax-code rows give.
  let taxMinor: number | null = null;
  let grossMinor: number | null = null;
  if (f.vatPreview !== undefined && amountMinor !== null) {
    let tax = 0;
    let known = true;
    for (const line of lines) {
      const code = text(line[f.vatPreview.taxCode]);
      const amount = num(line[f.vatPreview.amount]);
      if (code === null || amount === null) continue;
      // D164: the one rule (`lineSupplyDate`): the line's own date, else the record's, else none.
      const docDate = f.vatPreview.documentSupplyDate !== undefined ? text(row[f.vatPreview.documentSupplyDate]) : null;
      const lineDate = text(line[f.vatPreview.supplyDate]) ?? docDate;
      const computed = computeLineTax(ctx, { amountMinor: amount, amountIsGross: false, taxCode: code, supplyDate: lineDate });
      if (!computed.ok || typeof computed.taxMinor !== 'number') {
        known = false;
        break;
      }
      tax += computed.taxMinor;
    }
    if (known) {
      taxMinor = tax;
      grossMinor = amountMinor + tax;
    }
  } else if (f.vatColumns !== undefined) {
    taxMinor = num(row[f.vatColumns.tax]);
    grossMinor = num(row[f.vatColumns.gross]);
  }

  return {
    record: kind,
    number: f.number !== undefined ? text(row[f.number]) : null,
    numberPending: f.number !== undefined && text(row[f.number]) === null,
    counterparty,
    recipient,
    amountMinor,
    amountBasis: amountMinor !== null && f.amount !== undefined ? f.amount.basis : null,
    currency: amountMinor !== null ? (currency ?? 'CHF') : currency,
    taxMinor,
    grossMinor,
    lineCount: f.countLines === true ? lines.length : null,
  };
}

function emptyFigures(record: PinRecordKind): VorschlagFigures {
  return {
    record,
    number: null,
    numberPending: false,
    counterparty: null,
    recipient: null,
    amountMinor: null,
    amountBasis: null,
    currency: null,
    taxMinor: null,
    grossMinor: null,
    lineCount: null,
  };
}

/**
 * The pin for a call: undefined when the verb is not in the table, or when its input names none of
 * the pinned records (an optional field left out). The digest covers every named record and every
 * row it reads live; the figures are the primary (first named) record's.
 */
export function pinFor(ctx: WorkspaceContext, verb: string, payload: Readonly<Record<string, unknown>>): VorschlagPin | undefined {
  const fields = activeFields(ctx, verb, payload);
  if (fields.length === 0) return undefined;
  const parts: unknown[] = [];
  let figures: VorschlagFigures | null = null;
  let figuresTaken = false;
  for (const f of fields) {
    const { record } = f;
    const field = f.field ?? 'workspace';
    const ids = fieldIds(ctx, f, payload);
    const spec: RecordSpec = PIN_RECORDS[record];
    const snapshots = ids.map((id) => ({ id, snapshot: snapshotRecord(ctx, spec, id) }));
    for (const { id, snapshot } of snapshots) parts.push({ field, record, id, snapshot });
    if (!figuresTaken) {
      figuresTaken = true;
      const only = snapshots.length === 1 ? snapshots[0] : undefined;
      figures =
        spec.many === true
          ? emptyFigures(record)
          : only !== undefined
            ? figuresOf(ctx, record, only.snapshot, only.id)
            : { ...emptyFigures(record), lineCount: ids.length };
    }
  }
  const digest = createHash('sha256').update(canonical({ verb, parts })).digest('hex');
  return { digest, figures };
}

/** Every table a verb's pin covers (records, lines and live dependencies), for the structural test. */
export function pinnedTablesFor(verb: string): Set<string> {
  const tables = new Set<string>();
  const addDep = (dep: DepSpec): void => {
    tables.add(dep.table);
    for (const d of dep.deps ?? []) addDep(d);
  };
  for (const { record } of PIN_FOR_VERB[verb] ?? []) {
    const spec: RecordSpec = PIN_RECORDS[record];
    tables.add(spec.table);
    for (const c of spec.children ?? []) tables.add(c.table);
    for (const d of spec.deps ?? []) addDep(d);
  }
  return tables;
}

/**
 * The columns a verb's pin digests, per table (the record, its children and every dependency, with the
 * key columns that select the rows). The column census in the suite holds every column an approved act
 * reads of a pinned table to this set or to a named reason in `UNPINNED_COLUMNS`.
 */
export function pinnedColumnsFor(verb: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (table: string, columns: readonly string[]): void => {
    const set = out.get(table) ?? new Set<string>();
    for (const c of columns) set.add(c);
    out.set(table, set);
  };
  const addDep = (dep: DepSpec): void => {
    add(dep.table, [...dep.columns, dep.key]);
    for (const d of dep.deps ?? []) addDep(d);
  };
  for (const { record } of PIN_FOR_VERB[verb] ?? []) {
    const spec: RecordSpec = PIN_RECORDS[record];
    add(spec.table, [...spec.columns, spec.idColumn ?? 'id']);
    for (const c of spec.children ?? []) add(c.table, [...c.columns, c.fk, c.order]);
    for (const d of spec.deps ?? []) addDep(d);
  }
  return out;
}

/** Every table any pin reads, with the columns, for the schema test. */
export function pinReadShapes(): { table: string; columns: readonly string[]; self?: true }[] {
  const out: { table: string; columns: readonly string[]; self?: true }[] = [];
  const addDep = (dep: DepSpec): void => {
    out.push({ table: dep.table, columns: [...dep.columns, dep.key], ...(dep.self === true ? { self: true as const } : {}) });
    for (const d of dep.deps ?? []) addDep(d);
  };
  for (const spec of Object.values(PIN_RECORDS) as RecordSpec[]) {
    out.push({ table: spec.table, columns: [...spec.columns, spec.idColumn ?? 'id'], ...(spec.self === true ? { self: true as const } : {}) });
    for (const c of spec.children ?? []) out.push({ table: c.table, columns: [...c.columns, c.fk, c.order] });
    for (const d of spec.deps ?? []) addDep(d);
  }
  return out;
}

/** The refusal sentence, in both languages the product speaks (EN and de-CH, `du`). */
export const VORSCHLAG_STALE_MESSAGE = {
  en: 'The record behind this proposal changed after the agent made it, so nothing ran. Ask the agent to propose it again.',
  'de-CH':
    'Die Daten hinter diesem Vorschlag haben sich geändert, nachdem der Agent ihn gemacht hat. Darum wurde nichts ausgeführt. Bitte den Agenten, ihn neu vorzuschlagen.',
} as const;
