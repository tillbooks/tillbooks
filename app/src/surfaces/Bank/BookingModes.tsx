/**
 * D178 N3 (A39 §20): the booking modes of the /bank detail area, bexio's four ways to book a bank line.
 *
 *   Konto      one or several accounts (the D177 booking: a Buchungsregel, a split, the MWST), the fee split
 *              E2 proposes, and a counter-leg in the card transaction's currency behind its consequence
 *   Zuordnen   one or several open invoices (money in) or bills (money out) of ONE contact with the cash
 *              per document and the remainder choice, an existing entry, a payment run
 *   Kontakt    bexio's Kundenbuchung: the line parks on a contact as Guthaben (default) or Anzahlung
 *   Spesen     approved expense claims paid by a debit line
 *
 * THE PERSON'S VIEW (D178 point 9, `bank.booking_view`) decides how a mode is chosen: `focus` (default) and
 * `tabs` show the four modes as a switch above the pane, `smart` shows ONE search over every target. The
 * panes are the same components in every view, and none of them books anything on its own: each one sets
 * the line's draft target, and Buchen (the footer) sends it.
 *
 * EVERY FIGURE IS THE ENGINE'S (A39 §17.5). The deviation, what may remain, the documents' open amounts, the
 * contact's account, the claims and the FX conversion come from `compose_entry { mode: expand, bankTxnId,
 * target }` (`booking`), whose verdict is exactly what `book_bank_line` would answer now; a refusal is shown
 * in the engine's own sentence.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, useI18n, formatDate, formatMoney } from '../../i18n';
import { Segmented } from '../../components/Segmented';
import { Tabs } from '../../components/Tabs';
import { IconButton } from '../../components/IconButton';
import { PickerButton, type ComboboxGroup, type ComboboxOption } from '../../components/AccountCombobox';
import type { BankBookingPreview } from '../../../../src/core/banking/bankBooking';
import type { BankInboxLine, ContactBookingMode, DraftAllocation, DraftTarget, RemainderMode } from './model';
import { absAmount, bookTargetOf, isCredit, minorToField, parseMoneyInput } from './model';
import type { Lookups } from './lookups';
import { accountLabel, plural, taxCodeFor } from './lookups';
import type { BankComposeState } from './useBankCompose';
import { useTargetCompose } from './useBankCompose';
import { LegsPreview, type PreviewRow } from './LegsPreview';
import { explainRefusal } from './errors';
import { lineFactsOf } from './statementFacts';
import type { BookState } from './rowState';

type T = (key: string, params?: Record<string, string | number>) => string;

export type BookingView = 'focus' | 'tabs' | 'smart';
export type BookingPane = 'konto' | 'zuordnen' | 'kontakt' | 'spesen';

/** The pane a target belongs to; null for no target (the pane in view stays). */
export function paneOf(target: DraftTarget | null): BookingPane | null {
  if (target === null) return null;
  switch (target.kind) {
    case 'accounts':
    case 'rule':
    case 'ignore':
      return 'konto';
    case 'open_item':
    case 'allocations':
    case 'existing_entry':
    case 'payment_batch':
      return 'zuordnen';
    case 'contact':
      return 'kontakt';
    case 'expense_claims':
      return 'spesen';
  }
}

/** The panes a line offers: Spesen only for money out (the engine settles claims from a debit only). */
export function panesFor(line: Pick<BankInboxLine, 'amountMinor'>): BookingPane[] {
  return isCredit(line) ? ['konto', 'zuordnen', 'kontakt'] : ['konto', 'zuordnen', 'kontakt', 'spesen'];
}

/** The targets whose figures and verdict come from the booking preview (A39 §17.5). */
export function needsBookingPreview(target: DraftTarget | null): boolean {
  if (target === null) return false;
  if (target.kind === 'allocations' || target.kind === 'contact' || target.kind === 'expense_claims') return true;
  return target.kind === 'accounts' && target.legs.some((l) => l.fx !== undefined);
}

export interface BookingPreviewState {
  state: BankComposeState;
  /** The engine's booking preview, once answered for the target on screen. */
  booking: BankBookingPreview | null;
}

/** `compose_entry` for the target on screen, read for the booking preview (only for the targets that need it). */
export function useBookingPreview(workspaceId: string, line: BankInboxLine, target: DraftTarget | null): BookingPreviewState {
  const wanted = needsBookingPreview(target) && target !== null ? bookTargetOf(target) : null;
  const state = useTargetCompose(workspaceId, line.bankTxnId, wanted, { debounceMs: 250 });
  const booking = state.status === 'answered' ? ((state.answer as { booking?: BankBookingPreview }).booking ?? null) : null;
  return { state, booking };
}

/** A refusal in the engine's own sentence (E3 attaches `sentence { en, de-CH }`), else the surface's words. */
export function refusalWords(t: T, locale: string, e: Err, currency: string): string {
  const sentence = (e as { sentence?: Record<string, unknown> }).sentence;
  const own = sentence?.[locale];
  if (typeof own === 'string' && own !== '') return own;
  const said = explainRefusal(t, e, { currency });
  return typeof said === 'string' ? said : said.title;
}

/**
 * Buchen's state for a previewed target (A39 §20.6): disabled with its reason while the preview is out, and
 * while the engine says it would not book (the deviation without a remainder, a missing acknowledgement,
 * a claim that is not approved), in the engine's sentence. A state the host already disabled stays.
 */
export function previewBookState(t: T, locale: string, line: BankInboxLine, preview: BookingPreviewState, held: BookState): BookState {
  if (!held.enabled) return held;
  const { state, booking } = preview;
  if (state.status === 'none') return held;
  if (state.status === 'pending') return { enabled: false, reason: t('bankInbox.legs.computing') };
  // N3-C1: a target whose figures and consequences only the preview shows is never booked unseen. Without
  // the read rights (`read_books`, `read_vat`) or an answer that carries the booking, Buchen waits.
  if (state.status === 'denied') return { enabled: false, reason: t('bankInbox.legs.noRight') };
  if (state.status === 'failed') return { enabled: false, reason: refusalWords(t, locale, state.error, line.currency) };
  if (booking === null) return { enabled: false, reason: t('bankInbox.legs.unavailable') };
  if (booking.bookable) return held;
  const verdict = booking.verdict as Err;
  return { enabled: false, reason: refusalWords(t, locale, verdict, line.currency) };
}

// --- the view's top: the mode switch, or the one smart field -------------------------------------------

export function ModeSwitch({ view, line, pane, onPane, children }: { view: 'focus' | 'tabs'; line: BankInboxLine; pane: BookingPane; onPane: (next: BookingPane) => void; children: ReactNode }) {
  const t = useT();
  const options = panesFor(line).map((p) => ({ value: p, label: t(`bankInbox.mode.${p}`) }));
  if (view === 'tabs') {
    return (
      <div className="bank-modes" data-view="tabs">
        <Tabs tabs={options.map((o) => ({ id: o.value, label: o.label }))} activeId={pane} onChange={(id) => onPane(id as BookingPane)} label={t('bankInbox.mode.label')}>
          <div className="bank-modes__pane" data-pane={pane}>
            {children}
          </div>
        </Tabs>
      </div>
    );
  }
  return (
    <div className="bank-modes" data-view="focus">
      <Segmented<BookingPane> className="bank-modes__switch" label={t('bankInbox.mode.label')} options={options} value={pane} onChange={onPane} />
      <div className="bank-modes__pane" data-pane={pane}>
        {children}
      </div>
    </div>
  );
}

// --- the shared reads: contacts and approved claims, each read once per line ---------------------------

export interface ContactOption {
  id: string;
  name: string;
  partyRole: string | null;
}

function useOnce<V>(workspaceId: string, action: string, input: Record<string, unknown>, parse: (body: unknown) => V, enabled: boolean): { value: V | null; error: Err | null } {
  const client = useClient();
  const [state, setState] = useState<{ value: V | null; error: Err | null }>({ value: null, error: null });
  const key = JSON.stringify([workspaceId, action, input]);
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    void client.call(action, { workspaceId, ...input }).then(
      ({ body }) => {
        if (!live) return;
        if (isErr(body)) setState({ value: null, error: body });
        else setState({ value: parse(body), error: null });
      },
      () => {
        if (live) setState({ value: null, error: { ok: false, error: 'transport_error' } as Err });
      },
    );
    return () => {
      live = false;
    };
    // Keyed on the request itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key, enabled]);
  return state;
}

const rec = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function parseContacts(body: unknown): ContactOption[] {
  const list = rec(body)?.contacts;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const c = rec(raw);
    const id = str(c?.id);
    const name = str(c?.name);
    return id === null || name === null ? [] : [{ id, name, partyRole: str(c?.partyRole) }];
  });
}

export interface ClaimOption {
  id: string;
  title: string;
  employeeName: string | null;
  totalMinor: number;
  currency: string;
  approvedAt: string | null;
}

export function parseClaims(body: unknown): ClaimOption[] {
  const list = rec(body)?.claims;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const c = rec(raw);
    const id = str(c?.id);
    const total = typeof c?.totalBaseMinor === 'number' ? c.totalBaseMinor : null;
    if (c === null || id === null || total === null || c.status !== 'approved') return [];
    return [{ id, title: str(c.title) ?? '', employeeName: str(c.employeeName), totalMinor: total, currency: str(c.currency) ?? 'CHF', approvedAt: str(c.approvedAt) }];
  });
}

export function useContacts(workspaceId: string, enabled: boolean) {
  return useOnce(workspaceId, 'list_contacts', {}, parseContacts, enabled);
}

export function useApprovedClaims(workspaceId: string, enabled: boolean) {
  return useOnce(workspaceId, 'expense_claim_list', { status: 'approved' }, parseClaims, enabled);
}

/** The workspace's `bank.fx_mode` (A20 §11.5), read once; the default while unread or unreadable. */
export function useFxMode(workspaceId: string): string {
  const read = useOnce(workspaceId, 'settings_get', { key: 'bank.fx_mode' }, (body) => str(rec(rec(body)?.setting)?.value) ?? 'propose_split', true);
  return read.value ?? 'propose_split';
}

/**
 * What a pane's picker trigger shows: the chosen value (a code in tabular figures and a name) or the
 * placeholder. The trigger is a button (`PickerButton`), so focusing it never opens the list: the drawer's
 * first-field focus lands on it calmly (a text combobox opened its list on focus).
 */
function TriggerFace({ code, name, placeholder }: { code?: string; name: string | null; placeholder: string }) {
  if (name === null || name === '') return <span className="picker-trigger__placeholder">{placeholder}</span>;
  return (
    <span className="picker-trigger__value">
      {code !== undefined && code !== '' && <span className="picker-trigger__code t-num">{code}</span>}
      <span className="picker-trigger__name">{name}</span>
    </span>
  );
}

// --- the one smart field (D178 point 9, the `smart` view) --------------------------------------------

/**
 * One search over everything a line can be booked to: the chart, the open invoices or bills, the contacts
 * and (money out) the approved Spesen. A pick sets the draft target and the pane of its kind opens under it.
 */
export function SmartField({ workspaceId, line, lookups, target, busy, onTarget }: { workspaceId: string; line: BankInboxLine; lookups: Lookups; target: DraftTarget | null; busy: boolean; onTarget: (next: DraftTarget) => void }) {
  const t = useT();
  const id = useId();
  const credit = isCredit(line);
  const contacts = useContacts(workspaceId, true);
  const claims = useApprovedClaims(workspaceId, !credit);
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const money = (m: number, c: string) => formatMoney(m, c);
  const options: ComboboxOption[] = [];
  if (credit) {
    for (const inv of lookups.invoices) {
      if (inv.currency !== line.currency) continue;
      options.push({ id: `inv:${inv.documentId}`, code: inv.number ?? t('bankInbox.target.invoice'), label: inv.contactName ?? t('bankInbox.target.invoiceName'), trailing: money(inv.openMinor, inv.currency), keywords: `${inv.contactName ?? ''} ${(inv.openMinor / 100).toFixed(2)}`, group: 'items' });
    }
  } else {
    for (const bill of lookups.bills) {
      if (bill.currency !== line.currency) continue;
      options.push({ id: `bill:${bill.vendorBillId}`, code: bill.reference ?? t('bankInbox.target.bill'), label: bill.vendorName ?? t('bankInbox.target.billName'), trailing: money(bill.openMinor, bill.currency), keywords: `${bill.vendorName ?? ''} ${(bill.openMinor / 100).toFixed(2)}`, group: 'items' });
    }
  }
  for (const c of contacts.value ?? []) options.push({ id: `contact:${c.id}`, label: c.name, group: 'contacts' });
  for (const c of claims.value ?? []) {
    options.push({ id: `claim:${c.id}`, label: c.employeeName === null ? c.title : `${c.employeeName}: ${c.title}`, trailing: money(c.totalMinor, c.currency), keywords: (c.totalMinor / 100).toFixed(2), group: 'claims' });
  }
  for (const a of lookups.chart) {
    if (a.id === bankLedger) continue;
    options.push({ id: `acc:${a.id}`, code: a.number, label: a.name, group: 'accounts' });
  }
  const groups: ComboboxGroup[] = [
    { key: 'items', label: t(credit ? 'bankInbox.picker.groupInvoices' : 'bankInbox.picker.groupBills') },
    { key: 'contacts', label: t('bankInbox.mode.kontakt') },
    { key: 'claims', label: t('bankInbox.mode.spesen') },
    { key: 'accounts', label: t('bankInbox.picker.groupAccounts') },
  ];
  const value =
    target?.kind === 'accounts' && target.legs.length === 1
      ? `acc:${target.legs[0]?.accountId ?? ''}`
      : target?.kind === 'contact'
        ? `contact:${target.contactId}`
        : target?.kind === 'open_item'
          ? `${credit ? 'inv' : 'bill'}:${target.documentId}`
          : '';
  const pick = (picked: string) => {
    const at = picked.indexOf(':');
    const prefix = picked.slice(0, at);
    const ref = picked.slice(at + 1);
    if (prefix === 'acc') onTarget({ kind: 'accounts', legs: [{ accountId: ref, amountMinor: absAmount(line), taxCode: taxCodeFor(lookups, ref, '') }] });
    if (prefix === 'inv' || prefix === 'bill') onTarget({ kind: 'open_item', documentId: ref, remainder: null });
    if (prefix === 'contact') onTarget({ kind: 'contact', contactId: ref, contactName: contacts.value?.find((c) => c.id === ref)?.name ?? '', mode: null, overrideReason: '' });
    if (prefix === 'claim') onTarget({ kind: 'expense_claims', claimIds: [ref] });
  };
  const chosen = options.find((o) => o.id === value);
  const label = t('bankInbox.mode.smartLabel');
  return (
    <div className="bank-field bank-smart">
      <span className="bank-field__label" id={id} aria-hidden="true">
        {label}
      </span>
      <PickerButton
        label={chosen === undefined ? label : `${label} ${[chosen.code, chosen.label].filter((x) => x !== undefined && x !== '').join(' ')}`}
        options={options.map((o) => ({ ...o, current: o.id === value }))}
        groups={groups}
        value={value}
        onChange={pick}
        searchLabel={t('bankInbox.mode.smartPlaceholder')}
        searchPlaceholder={t('bankInbox.mode.smartPlaceholder')}
        noMatchLabel={t('bankInbox.mode.noMatch')}
        disabled={busy}
        className={`bank-picker bank-pane-picker${chosen === undefined ? ' bank-picker--empty' : ''}`}
        width={400}
      >
        <TriggerFace code={chosen?.code} name={chosen?.label ?? null} placeholder={t('bankInbox.mode.smartPlaceholder')} />
      </PickerButton>
    </div>
  );
}

/** The Konto pane's account field: one account for the whole line (a split stays the row's Aufteilen). */
export function AccountField({ line, lookups, target, busy, onTarget }: { line: BankInboxLine; lookups: Lookups; target: DraftTarget | null; busy: boolean; onTarget: (next: DraftTarget) => void }) {
  const t = useT();
  const id = useId();
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const options = useMemo(() => lookups.chart.filter((a) => a.id !== bankLedger).map((a) => ({ id: a.id, code: a.number, label: a.name })), [lookups.chart, bankLedger]);
  const current = target?.kind === 'accounts' && target.legs.length === 1 && (target.viaAccountId ?? '') === '' ? (target.legs[0]?.accountId ?? '') : '';
  const chosen = lookups.chartById.get(current);
  const label = t('bankInbox.mode.account');
  return (
    <div className="bank-field bank-account-field">
      <span className="bank-field__label" id={id} aria-hidden="true">
        {label}
      </span>
      <PickerButton
        label={chosen === undefined ? label : `${label} ${chosen.number} ${chosen.name}`}
        options={options.map((o) => ({ ...o, current: o.id === current }))}
        value={current}
        disabled={busy}
        searchLabel={t('bankInbox.mode.accountPlaceholder')}
        searchPlaceholder={t('bankInbox.mode.accountPlaceholder')}
        noMatchLabel={t('bankInbox.mode.noMatch')}
        className={`bank-picker bank-pane-picker${chosen === undefined ? ' bank-picker--empty' : ''}`}
        width={400}
        onChange={(accountId) => {
          if (accountId === '' || accountId === current) return;
          const held = target?.kind === 'accounts' ? (target.legs[0]?.taxCode ?? '') : '';
          onTarget({ kind: 'accounts', legs: [{ accountId, amountMinor: absAmount(line), taxCode: taxCodeFor(lookups, accountId, held) }] });
        }}
      >
        <TriggerFace code={chosen?.number} name={chosen?.name ?? null} placeholder={t('bankInbox.mode.accountPlaceholder')} />
      </PickerButton>
    </div>
  );
}

// --- Zuordnen: several open items, the remainder, a match or a payment run ------------------------------

interface DocRow {
  documentId: string;
  code: string;
  name: string;
  contactId: string | null;
  openMinor: number;
}

function docsFor(t: T, l: Lookups, line: BankInboxLine): DocRow[] {
  if (isCredit(line)) {
    return l.invoices
      .filter((i) => i.currency === line.currency)
      .map((i) => ({ documentId: i.documentId, code: i.number ?? t('bankInbox.target.invoice'), name: i.contactName ?? t('bankInbox.target.invoiceName'), contactId: i.contactId ?? null, openMinor: i.openMinor }));
  }
  return l.bills
    .filter((b) => b.currency === line.currency)
    .map((b) => ({ documentId: b.vendorBillId, code: b.reference ?? t('bankInbox.target.bill'), name: b.vendorName ?? t('bankInbox.target.billName'), contactId: b.vendorId ?? null, openMinor: b.openMinor }));
}

/** The allocations a target stands for (a single open item is one allocation of the whole line, capped at its open amount). */
export function allocationsOf(target: DraftTarget | null, docs: readonly { documentId: string; openMinor: number }[], lineAbs: number): DraftAllocation[] {
  if (target?.kind === 'allocations') return target.allocations;
  if (target?.kind === 'open_item') {
    const open = docs.find((d) => d.documentId === target.documentId)?.openMinor ?? lineAbs;
    return [{ documentId: target.documentId, amountMinor: Math.min(open, lineAbs) }];
  }
  return [];
}

export interface ZuordnenProps {
  line: BankInboxLine;
  lookups: Lookups;
  target: DraftTarget | null;
  booking: BankBookingPreview | null;
  busy: boolean;
  canPost: boolean;
  onTarget: (next: DraftTarget | null) => void;
  /** "Mit bestehender Buchung abgleichen": the link chooser. */
  onLink: () => void;
  /** The single-document case controls and the match or run facts (the D177 panel's). */
  caseControls: ReactNode;
}

/**
 * N3-C3: the amount field shows what the draft sends. The typed text stays while it stands for the draft's
 * figure (an empty or half-typed field stands for 0); once the target changes under the pane (the one
 * field re-picks the invoice, a Vorschlag), the draft's figure shows.
 */
export function shownAmount(typed: string | undefined, amountMinor: number): string {
  if (typed !== undefined && (parseMoneyInput(typed) ?? 0) === amountMinor) return typed;
  return minorToField(amountMinor);
}

export function ZuordnenPane({ line, lookups, target, booking, busy, canPost, onTarget, onLink, caseControls }: ZuordnenProps) {
  const t = useT();
  const baseId = useId();
  const docs = useMemo(() => docsFor(t, lookups, line), [t, lookups, line]);
  const lineAbs = absAmount(line);
  const chosen = allocationsOf(target, docs, lineAbs);
  const [texts, setTexts] = useState<Record<string, string>>(() => Object.fromEntries(chosen.map((a) => [a.documentId, minorToField(a.amountMinor)])));
  const [query, setQuery] = useState('');
  const contactId = chosen.length === 0 ? null : (docs.find((d) => d.documentId === chosen[0]?.documentId)?.contactId ?? null);
  const remainder: RemainderMode | null = target?.kind === 'allocations' || target?.kind === 'open_item' ? target.remainder : null;
  const emit = (next: DraftAllocation[], rest: RemainderMode | null = remainder) => onTarget(next.length === 0 ? null : { kind: 'allocations', allocations: next, remainder: rest });
  const toggle = (doc: DocRow) => {
    if (chosen.some((a) => a.documentId === doc.documentId)) {
      emit(chosen.filter((a) => a.documentId !== doc.documentId));
      return;
    }
    const used = chosen.reduce((s, a) => s + a.amountMinor, 0);
    const amount = Math.max(0, Math.min(doc.openMinor, lineAbs - used)) || doc.openMinor;
    setTexts((x) => ({ ...x, [doc.documentId]: minorToField(amount) }));
    emit([...chosen, { documentId: doc.documentId, amountMinor: amount }]);
  };
  const setAmount = (documentId: string, text: string) => {
    setTexts((x) => ({ ...x, [documentId]: text }));
    const minor = parseMoneyInput(text) ?? 0;
    emit(chosen.map((a) => (a.documentId === documentId ? { ...a, amountMinor: minor } : a)));
  };
  const q = query.trim().toLowerCase();
  const shown = docs.filter((d) => (contactId === null || d.contactId === null || d.contactId === contactId || chosen.some((a) => a.documentId === d.documentId)) && (q === '' || `${d.code} ${d.name} ${(d.openMinor / 100).toFixed(2)}`.toLowerCase().includes(q)));
  const options = booking?.remainderOptions ?? [];
  const offered = target?.kind === 'allocations' && options.length > 0 && (booking?.deviationMinor !== 0 || booking.documents.some((d) => d.openAfterMinor > 0));
  const batches = isCredit(line) ? [] : lookups.batches.filter((b) => b.bankAccountId === '' || b.bankAccountId === line.bankAccountId);
  const docView = (id: string) => booking?.documents.find((d) => d.documentId === id);
  return (
    <div className="bank-zuordnen">
      {docs.length === 0 ? (
        <p className="bank-panel__line bank-panel__muted">{t(isCredit(line) ? 'bankInbox.zuordnen.noInvoices' : 'bankInbox.zuordnen.noBills')}</p>
      ) : (
        <fieldset className="bank-docs" disabled={busy || !canPost}>
          <legend className="bank-field__label">{t(isCredit(line) ? 'bankInbox.zuordnen.invoices' : 'bankInbox.zuordnen.bills')}</legend>
          {docs.length > 6 && (
            <input type="search" className="field bank-docs__search" aria-label={t('bankInbox.zuordnen.search')} placeholder={t('bankInbox.zuordnen.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
          )}
          <ul className="bank-docs__list">
            {shown.map((d) => {
              const picked = chosen.find((a) => a.documentId === d.documentId);
              const view = docView(d.documentId);
              const fieldId = `${baseId}-${d.documentId}`;
              return (
                <li key={d.documentId} className="bank-doc" data-doc={d.documentId} data-picked={picked !== undefined ? 'true' : undefined}>
                  <label className="bank-doc__pick">
                    <input type="checkbox" checked={picked !== undefined} onChange={() => toggle(d)} />
                    <span className="bank-doc__code">{d.code}</span>
                    <span className="bank-doc__name">{d.name}</span>
                  </label>
                  <span className="bank-doc__open t-money" title={t('bankInbox.zuordnen.openTip')}>
                    {formatMoney(d.openMinor, line.currency)}
                  </span>
                  {picked !== undefined && (
                    <span className="bank-doc__amount">
                      <label className="visually-hidden" htmlFor={fieldId}>
                        {t('bankInbox.zuordnen.amountFor', { code: d.code })}
                      </label>
                      <input
                        id={fieldId}
                        type="text"
                        inputMode="decimal"
                        className="field t-num bank-money-input bank-doc__input"
                        value={shownAmount(texts[d.documentId], picked.amountMinor)}
                        aria-invalid={picked.amountMinor <= 0 || picked.amountMinor > d.openMinor || undefined}
                        onChange={(e) => setAmount(d.documentId, e.target.value)}
                      />
                      {view !== undefined && view.openAfterMinor > 0 && <span className="bank-doc__after">{t('bankInbox.zuordnen.openAfter', { amount: formatMoney(view.openAfterMinor, line.currency) })}</span>}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}
      {offered && (
        <fieldset className="bank-panel__case" data-case="allocations">
          <legend className="bank-field__label">{t('bankInbox.zuordnen.remainderLegend')}</legend>
          <span className="bank-panel__choices" role="radiogroup" aria-label={t('bankInbox.zuordnen.remainderLegend')}>
            {(['leave_open', 'write_off', 'on_account'] as const)
              .filter((m) => options.includes(m))
              .map((m) => (
                <label key={m} className="bank-panel__choice">
                  <input type="radio" name={`${baseId}-remainder`} checked={remainder === m || (remainder === null && m === 'leave_open' && booking?.deviationMinor === 0)} onChange={() => emit(chosen, m)} />
                  {t(m === 'on_account' ? 'bankInbox.item.onAccount' : m === 'write_off' ? 'bankInbox.item.writeOff' : 'bankInbox.item.leaveOpen')}
                </label>
              ))}
          </span>
        </fieldset>
      )}
      {caseControls}
      <p className="bank-panel__line bank-zuordnen__more">
        <button type="button" className="link-inline" disabled={busy || !canPost} onClick={onLink}>
          {t('bankInbox.zuordnen.link')}
        </button>
      </p>
      {batches.length > 0 && (
        <fieldset className="bank-panel__case" data-case="batches" disabled={busy || !canPost}>
          <legend className="bank-field__label">{t('bankInbox.picker.groupBatches')}</legend>
          <span className="bank-panel__choices">
            {batches.map((b) => (
              <label key={b.batchId} className="bank-panel__choice">
                <input type="radio" name={`${baseId}-batch`} checked={target?.kind === 'payment_batch' && target.batchId === b.batchId} onChange={() => onTarget({ kind: 'payment_batch', batchId: b.batchId })} />
                {b.executionDate === null ? t('bankInbox.target.batchCode') : formatDate(b.executionDate)} {plural(t, 'bankInbox.picker.batchLabel', b.itemCount)}
                {b.totalMinor !== null && <span className="t-money"> {formatMoney(b.totalMinor, line.currency)}</span>}
              </label>
            ))}
          </span>
        </fieldset>
      )}
    </div>
  );
}

// --- Kontakt: bexio's Kundenbuchung ---------------------------------------------------------------------

export function KontaktPane({
  workspaceId,
  line,
  target,
  booking,
  busy,
  canPost,
  onTarget,
  withPicker = true,
}: {
  workspaceId: string;
  line: BankInboxLine;
  target: DraftTarget | null;
  booking: BankBookingPreview | null;
  busy: boolean;
  canPost: boolean;
  onTarget: (next: DraftTarget | null) => void;
  /** The one-field view picked the contact already: no second contact field. */
  withPicker?: boolean;
}) {
  const t = useT();
  const id = useId();
  const contacts = useContacts(workspaceId, true);
  const contact = target?.kind === 'contact' ? target : null;
  const party = (line.counterparty.name ?? '').trim().toLowerCase();
  const options: ComboboxOption[] = (contacts.value ?? []).map((c) => ({
    id: c.id,
    label: c.name,
    group: party !== '' && c.name.toLowerCase() === party ? 'match' : 'all',
    ...(c.partyRole !== null ? { meta: t(`bankInbox.kontakt.role.${c.partyRole === 'vendor' ? 'vendor' : c.partyRole === 'both' ? 'both' : 'customer'}`) } : {}),
  }));
  const settingMode: ContactBookingMode = booking?.contact?.settingMode ?? 'guthaben';
  const mode: ContactBookingMode = contact?.mode ?? settingMode;
  const pick = (contactId: string) => {
    const name = contacts.value?.find((c) => c.id === contactId)?.name ?? '';
    onTarget({ kind: 'contact', contactId, contactName: name, mode: contact?.mode ?? null, overrideReason: contact?.overrideReason ?? '' });
  };
  const setMode = (next: ContactBookingMode) => {
    if (contact === null) return;
    onTarget({ ...contact, mode: next === settingMode ? null : next });
  };
  if (contacts.error !== null) return <p className="bank-panel__line bank-panel__muted">{t('bankInbox.kontakt.unreadable')}</p>;
  const view = booking?.contact ?? null;
  return (
    <div className="bank-kontakt">
      {withPicker && (
        <div className="bank-field">
          <span className="bank-field__label" aria-hidden="true">
            {t('bankInbox.kontakt.contact')}
          </span>
          <PickerButton
            label={contact === null ? t('bankInbox.kontakt.contact') : `${t('bankInbox.kontakt.contact')} ${contact.contactName ?? ''}`.trim()}
            options={options.map((o) => ({ ...o, current: o.id === contact?.contactId }))}
            groups={[
              { key: 'match', label: t('bankInbox.kontakt.match'), defaultActive: true },
              { key: 'all', label: t('bankInbox.kontakt.all') },
            ]}
            value={contact?.contactId ?? ''}
            onChange={pick}
            disabled={busy || !canPost || contacts.value === null}
            searchLabel={t('bankInbox.kontakt.placeholder')}
            searchPlaceholder={t('bankInbox.kontakt.placeholder')}
            noMatchLabel={t('bankInbox.mode.noMatch')}
            className={`bank-picker bank-pane-picker${contact === null ? ' bank-picker--empty' : ''}`}
            width={400}
          >
            <TriggerFace name={contact?.contactName ?? null} placeholder={contacts.value === null ? t('bankInbox.kontakt.loading') : t('bankInbox.kontakt.placeholder')} />
          </PickerButton>
        </div>
      )}
      {contact !== null && (
        <>
          <Segmented<ContactBookingMode>
            className="bank-kontakt__mode"
            label={t('bankInbox.kontakt.modeLabel')}
            options={(['guthaben', 'anzahlung'] as const).map((m) => ({ value: m, label: m === settingMode ? t('bankInbox.kontakt.modeDefault', { mode: t(`bankInbox.kontakt.mode.${m}`) }) : t(`bankInbox.kontakt.mode.${m}`) }))}
            value={mode}
            onChange={setMode}
            disabled={busy || !canPost}
          />
          {contact.mode !== null && (
            <label className="bank-field" htmlFor={`${id}-why`}>
              <span className="bank-field__label">{t('bankInbox.kontakt.reason')}</span>
              <input id={`${id}-why`} type="text" className="field" maxLength={500} value={contact.overrideReason} aria-required="true" aria-invalid={contact.overrideReason.trim() === '' || undefined} onChange={(e) => onTarget({ ...contact, overrideReason: e.target.value })} />
            </label>
          )}
          {view !== null && (
            <p className="bank-panel__line" data-contact-side={view.counterpartyKind}>
              {t(`bankInbox.kontakt.lands.${view.mode}`, { account: view.accountNumber ?? '', side: t(`bankInbox.kontakt.side.${view.counterpartyKind}`) })}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// --- Spesen: approved claims --------------------------------------------------------------------------

export function SpesenPane({ workspaceId, line, target, busy, canPost, onTarget }: { workspaceId: string; line: BankInboxLine; target: DraftTarget | null; busy: boolean; canPost: boolean; onTarget: (next: DraftTarget | null) => void }) {
  const t = useT();
  const claims = useApprovedClaims(workspaceId, true);
  const chosen = target?.kind === 'expense_claims' ? target.claimIds : [];
  if (claims.error !== null) {
    return <p className="bank-panel__line bank-panel__muted">{claims.error.error === 'permission_denied' ? t('bankInbox.spesen.noRight') : t('bankInbox.spesen.unreadable')}</p>;
  }
  if (claims.value === null) return <p className="bank-panel__line bank-panel__muted">{t('bankInbox.spesen.loading')}</p>;
  if (claims.value.length === 0) return <p className="bank-panel__line bank-panel__muted">{t('bankInbox.spesen.none')}</p>;
  const toggle = (id: string) => {
    const next = chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id];
    const totalMinor = (claims.value ?? []).filter((c) => next.includes(c.id)).reduce((s, c) => s + c.totalMinor, 0);
    onTarget(next.length === 0 ? null : { kind: 'expense_claims', claimIds: next, totalMinor });
  };
  return (
    <fieldset className="bank-docs bank-spesen" disabled={busy || !canPost}>
      <legend className="bank-field__label">{t('bankInbox.spesen.legend')}</legend>
      <ul className="bank-docs__list">
        {claims.value.map((c) => (
          <li key={c.id} className="bank-doc" data-claim={c.id} data-picked={chosen.includes(c.id) ? 'true' : undefined}>
            <label className="bank-doc__pick">
              <input type="checkbox" checked={chosen.includes(c.id)} onChange={() => toggle(c.id)} />
              <span className="bank-doc__code">{c.employeeName ?? t('bankInbox.spesen.someone')}</span>
              <span className="bank-doc__name">{c.title}</span>
            </label>
            <span className="bank-doc__open t-money">{formatMoney(c.totalMinor, c.currency === '' ? line.currency : c.currency)}</span>
          </li>
        ))}
      </ul>
    </fieldset>
  );
}

// --- Konto: the fee split (E2) and the FX counter-leg (E3, behind its consequence) ----------------------

/**
 * The fee split E2 proposes on a card payment (A20 §11.5, `bank.fx_mode`): `propose_split` offers it,
 * `prefill_split` has it filled in already. The person applies it, takes it back, or dismisses the offer
 * for this line; nothing books by itself.
 */
export function FeeSplitOffer({ line, lookups, target, busy, onTarget }: { line: BankInboxLine; lookups: Lookups; target: DraftTarget | null; busy: boolean; onTarget: (next: DraftTarget) => void }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(false);
  const split = line.proposal?.feeSplit;
  if (split === undefined || split.feeAccountId === null) return null;
  const fee = formatMoney(split.feeMinor, split.currency);
  const feeAccount = accountLabel(lookups, split.feeAccountId);
  const legs = target?.kind === 'accounts' ? target.legs : [];
  const applied = legs.length === 2 && legs.some((l) => l.accountId === split.feeAccountId && l.amountMinor === split.feeMinor);
  if (applied) {
    const rest = legs.find((l) => l.accountId !== split.feeAccountId);
    return (
      <p className="bank-panel__line bank-fee" data-fee="applied">
        <span>{t('bankInbox.fee.applied', { fee, account: feeAccount })}</span>{' '}
        {rest !== undefined && (
          <button type="button" className="link-inline" disabled={busy} onClick={() => onTarget({ kind: 'accounts', legs: [{ ...rest, amountMinor: absAmount(line) }] })}>
            {t('bankInbox.fee.undo')}
          </button>
        )}
      </p>
    );
  }
  if (dismissed) return null;
  const one = legs.length === 1 && (target?.kind === 'accounts' && (target.viaAccountId ?? '') === '') ? legs[0] : undefined;
  return (
    <p className="bank-panel__line bank-fee" data-fee="offer">
      <span>{t('bankInbox.fee.offer', { fee, account: feeAccount })}</span>{' '}
      {one !== undefined ? (
        <button
          type="button"
          className="link-inline"
          disabled={busy}
          onClick={() =>
            onTarget({
              kind: 'accounts',
              legs: [
                { ...one, amountMinor: absAmount(line) - split.feeMinor },
                { accountId: split.feeAccountId as string, amountMinor: split.feeMinor, taxCode: '' },
              ],
            })
          }
        >
          {t('bankInbox.fee.apply')}
        </button>
      ) : (
        <span className="bank-panel__muted">{t('bankInbox.fee.pickFirst')}</span>
      )}{' '}
      <button type="button" className="link-inline bank-fee__dismiss" onClick={() => setDismissed(true)}>
        {t('bankInbox.fee.dismiss')}
      </button>
    </p>
  );
}

/**
 * The counter-leg in the card transaction's currency (D178 point 3, `bank.fx_mode` `transaction_currency`):
 * offered on a base-currency line whose statement names an instructed amount in another currency. Choosing
 * it puts `fx` on the expense leg (the leg that is not the fee), and Buchen waits for the person to confirm
 * the engine's consequence sentence (`acknowledgeFx`).
 */
export function FxLegControl({ line, target, booking, busy, onTarget }: { line: BankInboxLine; target: DraftTarget | null; booking: BankBookingPreview | null; busy: boolean; onTarget: (next: DraftTarget) => void }) {
  const t = useT();
  const { locale } = useI18n();
  const id = useId();
  const facts = lineFactsOf(line);
  const instructed = facts?.instructed ?? null;
  if (instructed === null || instructed.currency === line.currency || target?.kind !== 'accounts' || target.legs.length === 0) return null;
  const feeId = line.proposal?.feeSplit?.feeAccountId ?? null;
  const index = target.legs.findIndex((l) => l.accountId !== feeId);
  if (index < 0) return null;
  const on = target.legs.some((l) => l.fx !== undefined);
  const foreign = formatMoney(Math.abs(instructed.amountMinor), instructed.currency);
  const rate = facts?.exchange?.rate ?? facts?.exchange?.effectiveRate ?? null;
  const fee = facts?.fee ?? (facts?.chargesTotal != null ? facts.chargesTotal : null);
  const toggle = () => {
    const legs = target.legs.map((l, i) => {
      if (on) {
        const { fx: _fx, ...rest } = l;
        return rest;
      }
      return i === index ? { ...l, taxCode: '', fx: { currency: instructed.currency, amountMinor: Math.abs(instructed.amountMinor) } } : l;
    });
    onTarget({ kind: 'accounts', legs, ...(target.viaAccountId !== undefined ? { viaAccountId: target.viaAccountId } : {}) });
  };
  const consequence = booking?.consequences.find((c) => c.code === 'fx_counter_leg');
  const sentence = consequence === undefined ? null : ((consequence as unknown as Record<string, string>)[locale] ?? null);
  return (
    <div className="bank-fx" data-fx={on ? 'on' : 'off'}>
      <label className="bank-panel__choice" htmlFor={id}>
        <input id={id} type="checkbox" checked={on} disabled={busy} onChange={toggle} />
        {t('bankInbox.fx.counterLeg', { amount: foreign })}
      </label>
      {on && (
        <div className="bank-fx__warning" role="note">
          {/* B5 judge: the card's facts stay beside the tick, whichever way the area scrolls. */}
          <p className="bank-fx__facts t-num" data-fx-facts="">
            {[
              foreign,
              rate !== null ? t('bankInbox.fx.rate', { rate }) : null,
              fee !== null ? t('bankInbox.fx.fee', { fee: formatMoney(Math.abs(fee.amountMinor), fee.currency) }) : null,
            ]
              .filter((x): x is string => x !== null)
              .join(' · ')}
          </p>
          {/* N3-C1: the acknowledgement exists only beside the engine's own consequence sentence. B5 judge: the
              sentence on one line, the whole of it behind (i). */}
          {sentence !== null ? (
            <>
              <p className="bank-fx__consequence">
                <span className="bank-mode__warn bank-fx__sentence">{sentence}</span>
                <IconButton icon="info" small context={sentence} />
              </p>
              <label className="bank-panel__choice">
                <input type="checkbox" checked={target.acknowledgeFx === true} disabled={busy} onChange={(e) => onTarget({ ...target, acknowledgeFx: e.target.checked })} />
                {t('bankInbox.fx.acknowledge')}
              </label>
            </>
          ) : (
            <p className="bank-panel__muted">{t('bankInbox.fx.noConsequence')}</p>
          )}
        </div>
      )}
    </div>
  );
}

// --- what the booking posts, and the footer's figures --------------------------------------------------

/** The entries a previewed booking would post (a conversion entry in the foreign currency, one per claim). */
export function BookingLines({ preview, line, lookups }: { preview: BookingPreviewState; line: BankInboxLine; lookups: Lookups }) {
  const t = useT();
  const { locale } = useI18n();
  const title = t('bankInbox.legs.title');
  const { state, booking } = preview;
  if (state.status === 'none') return null;
  if (state.status === 'denied') return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={t('bankInbox.legs.noRight')} />;
  if (state.status === 'pending') return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={t('bankInbox.legs.computing')} />;
  if (state.status === 'failed') return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={refusalWords(t, locale, state.error, line.currency)} />;
  // A booking the engine would refuse posts nothing: its sentence says what is missing (never "unavailable").
  if (booking !== null && !booking.bookable && booking.entries.length === 0) {
    return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={refusalWords(t, locale, booking.verdict as Err, line.currency)} />;
  }
  if (booking === null || booking.entries.length === 0) return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={t('bankInbox.legs.unavailable')} />;
  return (
    <div className="bank-booking-lines">
      {booking.entries.map((entry, i) => {
        const rows: PreviewRow[] = entry.lines.map((l) => ({ accountId: l.account, debit: l.debit ?? 0, credit: l.credit ?? 0 }));
        return (
          <LegsPreview
            key={i}
            title={i === 0 ? title : ''}
            {...(booking.entries.length > 1 ? { subtitle: t('bankInbox.legs.entryOf', { n: i + 1, count: booking.entries.length, currency: entry.currency }) } : {})}
            lines={rows}
            currency={entry.currency}
            lookups={lookups}
          />
        );
      })}
    </div>
  );
}

export interface Figures {
  amount: number;
  distributed: number | null;
  deviation: number | null;
}

/** Betrag / verteilt / Abweichung: typed legs sum locally; a previewed target reads the engine's deviation. */
export function figuresOf(line: BankInboxLine, target: DraftTarget | null, booking: BankBookingPreview | null): Figures | null {
  const amount = absAmount(line);
  if (target === null) return null;
  if (target.kind === 'accounts') {
    const sum = target.legs.reduce((s, l) => s + l.amountMinor, 0);
    return { amount, distributed: sum, deviation: amount - sum };
  }
  if (needsBookingPreview(target)) {
    // The engine's deviation once its preview answers; until then (B5 judge: never "…" beside a disabled
    // Buchen) the figures the draft itself states: the whole line on a contact, the allocations' sum, the
    // claims' total. The engine checks them again before anything books.
    const dev = booking?.deviationMinor ?? null;
    if (dev !== null) return { amount, distributed: amount - dev, deviation: dev };
    const local =
      target.kind === 'contact'
        ? amount
        : target.kind === 'allocations'
          ? target.allocations.reduce((s, a) => s + a.amountMinor, 0)
          : target.kind === 'expense_claims'
            ? (target.totalMinor ?? null)
            : null;
    return local === null ? { amount, distributed: null, deviation: null } : { amount, distributed: local, deviation: amount - local };
  }
  return null;
}

export function FootFigures({ figures, currency }: { figures: Figures; currency: string }) {
  const t = useT();
  const bare = (m: number) => formatMoney(m, currency).slice(currency.length + 1);
  const off = figures.deviation !== null && figures.deviation !== 0;
  return (
    <dl className="bank-figures" data-deviation={off ? 'true' : undefined}>
      <div className="bank-figures__item">
        <dt>{t('bankInbox.figures.amount')}</dt>
        <dd className="t-money">{bare(figures.amount)}</dd>
      </div>
      <div className="bank-figures__item">
        <dt>{t('bankInbox.figures.distributed')}</dt>
        <dd className="t-money">{figures.distributed === null ? '…' : bare(figures.distributed)}</dd>
      </div>
      <div className="bank-figures__item" data-figure="deviation">
        <dt>{t('bankInbox.figures.deviation')}</dt>
        <dd className="t-money">{figures.deviation === null ? '…' : bare(figures.deviation)}</dd>
      </div>
    </dl>
  );
}

// --- the focus view's own bar: the line stepper and "Liste ausblenden" ---------------------------------

export interface FocusNav {
  /** 0-based place of the line in the list in view, or -1 when it is not in view. */
  index: number;
  count: number;
  onStep: (delta: -1 | 1) => void;
  listHidden: boolean;
  onListHidden: (hidden: boolean) => void;
}

export function FocusBar({ nav }: { nav: FocusNav }) {
  const t = useT();
  const { index, count } = nav;
  return (
    <div className="bank-focusbar" data-focusbar="">
      <span className="bank-focusbar__steps">
        <button type="button" className="btn btn--ghost btn--sm" disabled={index <= 0} onClick={() => nav.onStep(-1)}>
          {t('bankInbox.focus.previous')}
        </button>
        <span className="bank-focusbar__place t-num" aria-live="polite">
          {index < 0 ? t('bankInbox.focus.outside', { count }) : t('bankInbox.focus.place', { n: index + 1, count })}
        </span>
        <button type="button" className="btn btn--ghost btn--sm" disabled={index < 0 || index >= count - 1} onClick={() => nav.onStep(1)}>
          {t('bankInbox.focus.next')}
        </button>
      </span>
      <label className="bank-focusbar__hide">
        <input type="checkbox" checked={nav.listHidden} onChange={(e) => nav.onListHidden(e.target.checked)} />
        {t('bankInbox.focus.hideList')}
      </label>
    </div>
  );
}
