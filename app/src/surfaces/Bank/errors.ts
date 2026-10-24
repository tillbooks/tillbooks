/**
 * Every refusal the bank inbox can meet, answered in three parts: WHAT happened, WHY, and the ONE
 * action that recovers (the canon's "errors answer three questions"; the bank-process judge's
 * outcome 5). Never "fehlgeschlagen", never "Etwas ist schiefgelaufen", never the engine's own English.
 *
 * The engine returns codes and facts (the two amounts, both IBANs, the first open date, the other
 * line); this file turns them into sentences through `bankInbox.error.*` in both locales and picks the fix
 * the facts make possible. A code with no sentence here falls back to the shared `ErrorBanner`, which
 * carries "Diesen Fehler melden" (G08): an unmapped refusal is exactly the one a person must be able to
 * report. So does any refusal the SHARED catalogue must word (`sharedRefusalKey`: the newer-book
 * refusal, and one raised after the call had already saved part of its work), because only it says
 * truthfully what was left behind. The title comes through `refusalText`, the one path every surface
 * words a refusal on (critic R5-1), with this file's sentence as the code's own key.
 */
import type { Err } from '../../lib/client';
import { refusalText, sharedRefusalKey } from '../../components/states';
import { formatDate, formatMoney } from '../../i18n';
import { formatIban } from './model';
import { plural } from './lookups';

type T = (key: string, params?: Record<string, string | number>) => string;

/** This surface's own refusal sentences: `<OWN>.<key>.title` and `.body`. */
const OWN = 'bankInbox.error';

export type RefusalAction =
  /** A sealed period (spec L5): the money is on the books elsewhere, ignore the line. */
  | { kind: 'ignore' }
  /** The other side of a transfer already booked it: match this line to that entry. */
  | { kind: 'match-entry'; entryId: string }
  /** Match the existing entry anyway, with the reason the person states; the engine records both. */
  | { kind: 'accept-difference' }
  /** A write-off above the threshold: leave the rest open instead and book. */
  | { kind: 'leave-open' }
  /** The line changed under us: read it again. */
  | { kind: 'reload' }
  /** Another line holds the entry or the run: show that line. */
  | { kind: 'show-line'; bankTxnId: string }
  /** The fix lives on another surface. */
  | { kind: 'link'; to: string; label: string }
  /** The file belongs to another registered account: import it there. */
  | { kind: 'import-for'; bankAccountId: string; name: string };

export interface Refusal {
  code: string;
  title: string;
  body: string | null;
  action: RefusalAction | null;
  /** Unknown to this file: render the shared ErrorBanner, which offers "Diesen Fehler melden". */
  unmapped: boolean;
}

/**
 * A36C-2: the successor rule's refusals on an EBICS-fed account (spec §4.4), worded by the channel's own
 * sentences, the same words the /bank-accounts panel says for a statement that waits.
 */
const FEED_TITLE_KEYS: Readonly<Record<string, string>> = {
  gap_refused: 'channel.feed.gapRefused',
  overlap_refused: 'channel.feed.overlapRefused',
  before_feed_start: 'channel.feed.beforeFeedStart',
  not_day_end_statement: 'channel.feed.notDayEnd',
  unsupported_multipage_statement: 'channel.feed.multipage',
};

const s = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const n = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The period a `period_locked` names, "Juli 2026" style from "2026-07", else the raw value. */
function periodText(t: T, period: string | null): string {
  if (period === null) return '';
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m !== null) return t('bankInbox.error.periodMonth', { month: t(`bankInbox.month.${Number(m[2])}`), year: m[1] ?? '' });
  const q = /^(\d{4})-Q([1-4])$/.exec(period);
  if (q !== null) return t('bankInbox.error.periodQuarter', { quarter: q[2] ?? '', year: q[1] ?? '' });
  if (/^\d{4}$/.test(period)) return t('bankInbox.error.periodYear', { year: period });
  return period;
}

/** A camt `schema_invalid` reason (engine prose) sorted into the cause a person can act on. */
export function camtReasonKey(reason: string | null): string {
  const r = (reason ?? '').toLowerCase();
  if (r.includes('camt.052')) return 'camt052';
  if (r.includes('not a non-empty xml')) return 'notXml';
  if (r.includes('more than one')) return 'multipleAccounts';
  if (r.includes('txdtls') && r.includes('sum')) return 'batchSum';
  if (r.includes('no readable amt')) return 'batchAmount';
  if (r.includes('stmt/id') || r.includes('ntfctn/id')) return 'noStatementId';
  if (r.includes('<stmt>') || r.includes('envelope')) return 'notStatement';
  return 'unreadable';
}

/** "2 geändert, 1 neu": the amended statement's changes counted, never the engine's raw keys. */
function amendedSummary(t: T, changes: unknown, currency: string): string {
  const list = Array.isArray(changes) ? changes.filter((c): c is string => typeof c === 'string') : [];
  const parts: string[] = [];
  for (const c of list) {
    const bal = /^(opening|closing) balance changed from (-?\d+|n\/a) to (-?\d+|n\/a)$/.exec(c);
    if (bal !== null) {
      const from = bal[2] === 'n/a' ? t('bankInbox.error.noFigure') : formatMoney(Number(bal[2]), currency);
      const to = bal[3] === 'n/a' ? t('bankInbox.error.noFigure') : formatMoney(Number(bal[3]), currency);
      parts.push(t(bal[1] === 'opening' ? 'bankInbox.error.amendedOpening' : 'bankInbox.error.amendedClosing', { from, to }));
    }
  }
  const changed = list.filter((c) => / amount changed from /.test(c)).length;
  const added = list.filter((c) => / added$/.test(c)).length;
  const removed = list.filter((c) => / removed$/.test(c)).length;
  if (changed > 0) parts.push(plural(t, 'bankInbox.error.amendedChanged', changed));
  if (added > 0) parts.push(plural(t, 'bankInbox.error.amendedAdded', added));
  if (removed > 0) parts.push(plural(t, 'bankInbox.error.amendedRemoved', removed));
  return parts.join(', ');
}

export interface RefusalContext {
  /** The currency of the line (or the account) the refusal is about. */
  currency: string;
  /** The account the import was aimed at, for the IBAN sentences. */
  accountName?: string;
  /** The refused line's state: a sealed period's fix differs for an open line and a decided one. */
  lineState?: string;
}

/**
 * The refusal, explained. `e` is the engine's `Err` exactly as it arrived; the extra facts it carries
 * (`suggestion`, `lineAmountMinor`, `fileIban`, ...) fill the sentence.
 */
export function explainRefusal(t: T, e: Err, ctx: RefusalContext): Refusal {
  const code = e.error;
  const f = e as Record<string, unknown>;
  const money = (v: unknown) => (n(v) === null ? '' : formatMoney(n(v) as number, ctx.currency));
  const make = (key: string, params: Record<string, string | number> = {}, action: RefusalAction | null = null): Refusal => ({
    code,
    title: refusalText(t, e, { keys: { [code]: `${OWN}.${key}.title` }, params }),
    body: t(`${OWN}.${key}.body`, params),
    action,
    unmapped: false,
  });

  if (sharedRefusalKey(e) !== undefined) return { code, title: t('bankInbox.error.fallbackTitle'), body: null, action: null, unmapped: true };

  switch (code) {
    case 'period_locked': {
      // Spec L5: a line books, and its booking is reversed, on its own date. A soft lock is lifted
      // under Perioden; a sealed period (MWST filed, year closed) takes nothing more.
      const period = periodText(t, s(f.period));
      if (f.kind === 'hard') {
        const action: RefusalAction =
          ctx.lineState === 'open' ? { kind: 'ignore' } : { kind: 'link', to: '/journal', label: t('bankInbox.error.toJournal') };
        return make('periodSealed', { period }, action);
      }
      return make('periodLocked', { period }, { kind: 'link', to: '/periods', label: t('bankInbox.error.toPeriods') });
    }
    case 'line_not_open':
      return make('lineNotOpen', { state: t(`bankInbox.state.${s(f.state) ?? 'booked'}`) }, { kind: 'reload' });
    case 'amount_mismatch': {
      // Re-critic L2: a run already marked paid cannot be discarded; its sentence names the path that holds.
      const paidRun = f.batchStatus === 'paid' ? 'Paid' : '';
      if (n(f.itemAmountMinor) !== null) {
        return make(`batchItemMismatch${paidRun}`, { line: money(f.lineAmountMinor), item: money(f.itemAmountMinor) });
      }
      if (s(f.batchId) !== null) {
        return make(`batchAmountMismatch${paidRun}`, { line: money(f.lineAmountMinor), batch: money(f.batchTotalMinor) });
      }
      return make('entryAmountMismatch', { line: money(f.lineAmountMinor), entry: money(f.entryAmountMinor) }, { kind: 'accept-difference' });
    }
    case 'entry_already_linked': {
      const other = s(f.bankTxnId);
      return make('entryAlreadyLinked', {}, other !== null ? { kind: 'show-line', bankTxnId: other } : null);
    }
    case 'direction_mismatch':
      return make('directionMismatch', { line: money(f.lineAmountMinor), entry: money(f.entryAmountMinor) });
    case 'write_off_above_threshold':
      return make('writeOffAboveThreshold', { rest: money(f.writeOffMinor), threshold: money(f.thresholdMinor) }, { kind: 'leave-open' });
    case 'batch_already_linked': {
      const other = s(f.bankTxnId);
      return make('batchAlreadyLinked', {}, other !== null ? { kind: 'show-line', bankTxnId: other } : null);
    }
    case 'entry_not_on_bank_account':
    case 'claim_off_account':
      return make('entryNotOnBank');
    case 'transfer_already_booked': {
      const entryId = s(f.entryId);
      return make('transferAlreadyBooked', {}, entryId !== null ? { kind: 'match-entry', entryId } : null);
    }
    case 'transfer_crosses_period': {
      const other = s(f.otherBankTxnId);
      return make(
        'transferCrossesPeriod',
        { entryDate: s(f.entryDate) === null ? '' : formatDate(s(f.entryDate) as string), lineDate: s(f.lineDate) === null ? '' : formatDate(s(f.lineDate) as string) },
        other !== null ? { kind: 'show-line', bankTxnId: other } : null,
      );
    }
    case 'already_batched':
      return make('alreadyBatched', {}, { kind: 'link', to: '/creditor-payments', label: t('bankInbox.error.toCreditorPayments') });
    case 'owned_by': {
      // Spec §4.4, L3: the entry is released only by its owner's own undo.
      const holder = s(f.bankTxnId);
      if (f.verb === 'reopen_bank_line') return make('ownedByLine', {}, holder !== null ? { kind: 'show-line', bankTxnId: holder } : null);
      if (f.verb === 'reverse_payment') return make('ownedByPayment', {}, { kind: 'link', to: '/payments', label: t('bankInbox.error.toPayments') });
      return { code, title: t('bankInbox.error.fallbackTitle'), body: null, action: null, unmapped: true };
    }
    case 'use_bank_inbox': {
      const holder = s(f.bankTxnId);
      return make('useBankInbox', {}, holder !== null ? { kind: 'show-line', bankTxnId: holder } : null);
    }
    case 'camt054_refused':
      return make('camt054');
    case 'entry_is_reversal':
      return make('entryIsReversal');
    case 'entry_reversed':
      return make('entryReversed');
    case 'legs_do_not_sum':
      return make('legsDoNotSum', { expected: money(f.expectedMinor), sum: money(f.sumMinor) });
    case 'vat_split_mismatch':
      return make('vatSplitMismatch');
    case 'currency_mismatch':
      if (s(f.batchCurrency) !== null) {
        return make(
          'batchCurrency',
          { line: s(f.lineCurrency) ?? ctx.currency, batch: s(f.batchCurrency) ?? '' },
          { kind: 'link', to: '/creditor-payments', label: t('bankInbox.error.toCreditorPayments') },
        );
      }
      if (s(f.accountCurrency) !== null && s(f.documentCurrency) === null) {
        // A line in another currency than its Bankkonto (critic L5 lean): no invoice choice fixes it.
        return make(
          'currencyMismatchAccount',
          { line: s(f.lineCurrency) ?? ctx.currency, other: s(f.accountCurrency) ?? '' },
          { kind: 'link', to: '/journal', label: t('bankInbox.error.toJournal') },
        );
      }
      return make('currencyMismatch', {
        line: s(f.lineCurrency) ?? ctx.currency,
        other: s(f.documentCurrency) ?? s(f.accountCurrency) ?? '',
      });
    case 'wrong_direction':
      return make(f.creditDebit === 'CRDT' ? 'wrongDirectionIn' : 'wrongDirectionOut');
    case 'already_paid':
      return make('alreadyPaid', {}, { kind: 'reload' });
    case 'not_settleable':
      return make('notSettleable', { status: t(`bankInbox.billStatus.${s(f.status) ?? 'draft'}`) });
    case 'wrong_bank_account':
      return make('wrongBankAccount');
    case 'needs_generation':
      return make('needsGeneration', {}, { kind: 'link', to: '/creditor-payments', label: t('bankInbox.error.toCreditorPayments') });
    case 'batch_discarded':
      return make('batchDiscarded');
    case 'batch_payments_not_posted':
      return make('batchPaymentsNotPosted', {}, { kind: 'link', to: '/payments', label: t('bankInbox.error.toPayments') });
    case 'account_archived':
      return make('accountArchived', {}, { kind: 'link', to: '/accounts', label: t('bankInbox.error.toAccounts') });
    case 'unknown_tax_code':
    case 'archived_tax_code':
      return make('taxCodeInactive', { code: s(f.taxCode) ?? '' }, { kind: 'link', to: '/vat', label: t('bankInbox.error.toVat') });
    case 'rate_era_unknown':
      return make('rateEraUnknown');
    case 'vat_lines_refused':
      return make('vatLinesRefused');
    case 'unsupported': {
      const reason = s(f.reason);
      if (reason === 'vat_on_foreign_currency_bank_line') return make('vatForeignCurrency');
      if (reason === 'write_off_only_on_incoming_invoice_payments') return make('writeOffOnlyInvoices');
      if (reason === 'write_off_books_to_the_a14_role_account') return make('writeOffAccount');
      return { code, title: t('bankInbox.error.unsupported.title'), body: null, action: null, unmapped: true };
    }
    case 'needs_bank_account': {
      const fileIban = s(f.fileIban);
      if (fileIban !== null) {
        return make('ibanUnregistered', { iban: formatIban(fileIban) }, { kind: 'link', to: '/bank-accounts?new=1', label: t('bankInbox.error.createBankAccount') });
      }
      return make('noBankAccount', {}, { kind: 'link', to: '/bank-accounts?new=1', label: t('bankInbox.error.createBankAccount') });
    }
    case 'iban_mismatch': {
      const id = s(f.matchingBankAccountId);
      const name = s(f.matchingBankAccountName) ?? '';
      return make(
        'ibanMismatch',
        {
          fileIban: formatIban(s(f.fileIban) ?? ''),
          accountIban: formatIban(s(f.accountIban) ?? ''),
          name,
          chosen: ctx.accountName ?? '',
        },
        id !== null ? { kind: 'import-for', bankAccountId: id, name } : null,
      );
    }
    // A36C-2: a hand import the successor rule refuses (the account runs over EBICS). A retry never
    // helps: the title is the rule's sentence with the statements it names, the fix is on /bank-accounts.
    case 'gap_refused':
    case 'overlap_refused':
    case 'before_feed_start':
    case 'not_day_end_statement':
    case 'unsupported_multipage_statement': {
      const statement = (typeof f.statement === 'object' && f.statement !== null ? f.statement : {}) as Record<string, unknown>;
      const against = (typeof f.against === 'object' && f.against !== null ? f.against : {}) as Record<string, unknown>;
      const from = s(statement.fromDate);
      const params: Record<string, string | number> = {
        n: n(statement.number) ?? s(f.electronicSeqNb) ?? '',
        year: n(statement.year) ?? '',
        date: from === null ? '' : formatDate(from),
        m: n(against.number) ?? '',
      };
      return {
        code,
        title: refusalText(t, e, { keys: { [code]: FEED_TITLE_KEYS[code] as string }, params }),
        body: t(`${OWN}.feedRule.body`),
        action: { kind: 'link', to: '/bank-accounts', label: t('bankInbox.error.toBankAccounts') },
        unmapped: false,
      };
    }
    case 'bank_account_archived':
      return make('bankAccountArchived', { name: s(f.name) ?? '' }, { kind: 'link', to: '/bank-accounts?archived=1', label: t('bankInbox.error.toBankAccounts') });
    case 'schema_invalid':
      return make(`camt.${camtReasonKey(s(f.reason))}`);
    case 'statement_amended':
      return make('statementAmended', { changes: amendedSummary(t, f.changes, ctx.currency) });
    case 'permission_denied':
      return make('permissionDenied');
    case 'cannot_self_approve':
      return make('cannotSelfApprove');
    case 'needs_fx_rate':
      return make(
        'needsFxRate',
        { currency: s(f.currency) ?? ctx.currency, date: s(f.date) === null ? '' : formatDate(s(f.date) as string) },
        { kind: 'link', to: '/fx', label: t('bankInbox.error.toFx') },
      );
    case 'needs_account':
      return make('needsAccount', {}, { kind: 'link', to: '/accounts', label: t('bankInbox.error.toAccounts') });
    case 'counterparty_merged':
      return make('counterpartyMerged', {}, { kind: 'reload' });
    case 'already_rejected':
      return make('vorschlagRejected', {}, { kind: 'reload' });
    case 'already_executed':
      return make('vorschlagExecuted', {}, { kind: 'reload' });
    // Critic N1: the record behind the Vorschlag changed after the proposal; nothing ran.
    case 'vorschlag_stale':
      return make('vorschlagStale', {}, { kind: 'reload' });
    // D167: the standard verbs' refusals (`set_bank_standard`), each with what the person can do instead.
    case 'no_counterparty':
      return make('noCounterparty');
    case 'invalid_account':
      return make('invalidAccount');
    case 'invalid_tax_code':
      return make('invalidTaxCode', {}, { kind: 'link', to: '/vat', label: t('bankInbox.error.toVat') });
    case 'vat_not_applicable':
      return make('vatNotApplicable');
    // D175 (A39 §14.1, §14.2): a recipe the engine will not store, and the rule target's refusals. The
    // engine's `detail` is its own English, so it is never shown: the sentence names what a rule needs.
    case 'invalid_recipe': {
      // D176: the four new rules each say what to change.
      const detail = s(f.detail);
      if (detail === 'same_target') return make('invalidRecipeSame');
      if (detail === 'side') return make('invalidRecipeSide');
      if (detail === 'ignore_outcome') return make('invalidRecipeIgnore');
      if (detail === 'follow_up') return make('invalidRecipeFollowUp');
      return make('invalidRecipe');
    }
    case 'rule_not_found':
      return make('ruleNotFound', {}, { kind: 'reload' });
    case 'rule_not_applicable':
      return make('ruleNotApplicable');
    case 'ask_missing':
      return make('askMissing');
    case 'rest_is_zero':
      return make('restIsZero');
    // D176 (A39 §15.2): a Vorlage on a bank line or a bank rule as a template; a "Nicht buchen" rule booked;
    // a Vorlage whose amounts would put its rest on the other side.
    case 'wrong_scope':
      return make('wrongScope');
    // Critic D176-C2: the form says it at the name field with "Ersetzen"; this is the sentence elsewhere.
    case 'label_taken':
      return make('labelTaken');
    case 'wrong_outcome':
      return make('wrongOutcome');
    case 'rest_changes_side':
      return make('restChangesSide');
    case 'entity_not_found':
      return make('notFound', {}, { kind: 'reload' });
    case 'not_found':
      return make('notFound', {}, { kind: 'reload' });
    case 'invalid_input':
      if (s(f.field) === 'target.differenceReason') return make('differenceReasonMissing', {}, { kind: 'accept-difference' });
      return make('invalidInput', { field: s(f.field) ?? '' });
    case 'transport_error':
      return make('transport');
    default:
      return { code, title: t('bankInbox.error.fallbackTitle'), body: null, action: null, unmapped: true };
  }
}
