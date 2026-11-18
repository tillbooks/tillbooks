/**
 * D197 (12.11.2026): the facts the Vorschläge screen shows on a row's face, added to `list_drafted_actions`
 * at READ time (the `withEvidence` / `withBelege` precedent in `agent-actions.ts`). Nothing here writes, and
 * the stored payload, the pin and the replay stay exactly what they were: a decorated row approves the very
 * act it approved before.
 *
 *  - `lineFacts` on a bank-line decision (`book_bank_line`, `ignore_bank_line`, `confirm_match`): the line's
 *    booking date, who the money came from or went to (else the bank's text), and its SIGNED amount (credit
 *    positive, debit negative) with its currency. Null when the line is gone, or names another workspace's
 *    line. Only for a caller who may read the bank (`read_sales`, as `list_bank_inbox`): a seat that reads
 *    the books but not the bank gets null, never the bank's words.
 *  - `bankDetail` on a supplier IBAN change (`set_creditor_bank_profile`): the supplier's name, the IBAN it is
 *    paid at NOW (null when none is set) and the payload's new one, so the change is read before it runs.
 *  - `setting` on a settings change (`settings_set`): the setting's name in both languages, the proposed
 *    value and the value in force now (the latter only for a caller who may read settings).
 *  - `batchable` on every row: the engine's batch reach (a pending, unchanged bank-line decision,
 *    `isBatchable`), and `approvalBatchMode` on the answer (the setting `attention.approval_batch_mode`).
 *
 * §H-TENANT: every query binds `ctx.workspaceId`.
 */
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { isBatchable } from '../core/attention/vorschlaege.js';
import { settingDef } from '../core/settings/registry.js';
import { getSetting } from '../core/settings/settings.js';

/** The verbs that decide ONE bank line named by `bankTxnId`, whose line facts the row carries. */
export const LINE_FACT_VERBS: readonly string[] = ['book_bank_line', 'ignore_bank_line', 'confirm_match'];

/** The supplier IBAN change: the one contact bank-detail write the agent can propose. */
export const BANK_DETAIL_VERB = 'set_creditor_bank_profile';

const LINE_FACT_SET: ReadonlySet<string> = new Set(LINE_FACT_VERBS);

export interface VorschlagLineFacts {
  /** The booking date (else the value date), `YYYY-MM-DD`, or null when the bank stated none. */
  date: string | null;
  /** Who the money came from or went to, as the bank reported it, or null. */
  counterparty: string | null;
  /** The bank's remittance text, or null. */
  text: string | null;
  /** Signed: money in positive, money out negative. */
  amountMinor: number;
  currency: string;
}

export interface VorschlagBankDetail {
  contactName: string | null;
  /** The IBAN the supplier is paid at now, or null when none is set. */
  oldIban: string | null;
  /** The IBAN the Vorschlag sets. */
  newIban: string | null;
  /** True when this seat may not read master data: the name and the current IBAN are withheld, not absent. */
  withheld?: true;
}

export interface VorschlagSetting {
  key: string;
  label: { en: string; 'de-CH': string } | null;
  value: unknown;
  /** The value in force now, or undefined when the caller may not read settings. */
  current?: unknown;
}

function payloadOf(row: Record<string, unknown>): Record<string, unknown> {
  const p = row.payload;
  return p !== null && typeof p === 'object' && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/** The named line's facts, tenant-bound; null when no line of THIS workspace has that id. */
export function lineFactsOf(ctx: WorkspaceContext, bankTxnId: unknown): VorschlagLineFacts | null {
  if (typeof bankTxnId !== 'string' || bankTxnId === '') return null;
  const row = ctx.store.db
    .prepare(
      `SELECT t.amount_minor, t.currency, t.credit_debit, t.booking_date, t.value_date, t.payer_name,
              d.counterparty_name, d.remittance_text
         FROM bank_txn t
         LEFT JOIN bank_txn_detail d ON d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id
        WHERE t.workspace_id = ? AND t.id = ?`,
    )
    .get(ctx.workspaceId, bankTxnId) as
    | {
        amount_minor: number;
        currency: string;
        credit_debit: string;
        booking_date: string | null;
        value_date: string | null;
        payer_name: string | null;
        counterparty_name: string | null;
        remittance_text: string | null;
      }
    | undefined;
  if (row === undefined) return null;
  const abs = Math.abs(row.amount_minor);
  return {
    date: text(row.booking_date) ?? text(row.value_date),
    counterparty: text(row.counterparty_name) ?? text(row.payer_name),
    text: text(row.remittance_text),
    amountMinor: row.credit_debit === 'CRDT' ? abs : -abs,
    currency: row.currency,
  };
}

/** The supplier's name and the IBAN it is paid at now, tenant-bound, beside the payload's new IBAN. */
export function bankDetailOf(ctx: WorkspaceContext, payload: Record<string, unknown>): VorschlagBankDetail {
  const vendorId = typeof payload.vendorId === 'string' ? payload.vendorId : null;
  let contactName: string | null = null;
  let oldIban: string | null = null;
  if (vendorId !== null) {
    const contact = ctx.store.db
      .prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, vendorId) as { name: string | null } | undefined;
    contactName = text(contact?.name);
    const profile = ctx.store.db
      .prepare('SELECT iban FROM creditor_bank_profile WHERE workspace_id = ? AND contact_id = ?')
      .get(ctx.workspaceId, vendorId) as { iban: string | null } | undefined;
    oldIban = text(profile?.iban);
  }
  return { contactName, oldIban, newIban: text(payload.iban) };
}

function settingOf(ctx: WorkspaceContext, payload: Record<string, unknown>): VorschlagSetting | null {
  const key = typeof payload.key === 'string' ? payload.key : null;
  if (key === null) return null;
  const def = settingDef(key);
  const out: VorschlagSetting = { key, label: def === undefined ? null : { en: def.label.en, 'de-CH': def.label['de-CH'] }, value: payload.value };
  if (def !== undefined && ctx.capabilities.assert('read_master_data').ok) {
    try {
      out.current = getSetting(ctx, key);
    } catch {
      // A key the registry knows but cannot read is simply not said.
    }
  }
  return out;
}

function batchModeOf(ctx: WorkspaceContext): string {
  try {
    return getSetting<string>(ctx, 'attention.approval_batch_mode');
  } catch {
    return 'tick';
  }
}

/**
 * The read-time decorator. `listed` is the answer of `listDraftedActions` (already through `withBelege` and
 * `withEvidence`); a refusal passes through untouched.
 */
export function withVorschlagFacts(ctx: WorkspaceContext, listed: Result): Result {
  if (!listed.ok) return listed;
  const actions = (listed as unknown as { actions?: Record<string, unknown>[] }).actions;
  if (!Array.isArray(actions)) return listed;
  const mayReadBank = ctx.capabilities.assert('read_sales').ok;
  // Security review (12.11.2026): the supplier's name and the IBAN it is paid at now are master data
  // (`get_contact` needs `read_master_data`), while this list needs only `read_books`. A seat without the
  // master-data read learns only the new IBAN, which its own Vorschlag payload already carries.
  const mayReadMaster = ctx.capabilities.assert('read_master_data').ok;
  return {
    ...listed,
    approvalBatchMode: batchModeOf(ctx),
    actions: actions.map((row) => {
      const verb = typeof row.actionTool === 'string' ? row.actionTool : '';
      const payload = payloadOf(row);
      const out: Record<string, unknown> = {
        ...row,
        batchable: row.status === 'pending' && row.changedSinceProposal !== true && isBatchable(verb),
      };
      if (LINE_FACT_SET.has(verb)) out.lineFacts = mayReadBank ? lineFactsOf(ctx, payload.bankTxnId) : null;
      else if (verb === BANK_DETAIL_VERB) {
        out.bankDetail = mayReadMaster ? bankDetailOf(ctx, payload) : { contactName: null, oldIban: null, newIban: text(payload.iban), withheld: true };
      }
      else if (verb === 'settings_set') {
        const setting = settingOf(ctx, payload);
        if (setting !== null) out.setting = setting;
      }
      return out;
    }),
  } as Result;
}
