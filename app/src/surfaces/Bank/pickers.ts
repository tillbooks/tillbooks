/**
 * The target picker's list: ONE searchable list over every place a bank line can go (the judge's
 * outcome 6, "pick, never type"), in the order a bookkeeper decides in:
 *
 *   Aktuell            the row's current target (hidden while searching)
 *   Vorschläge         the engine's proposal when the person changed it, the agent's Vorschlag
 *   Offene Rechnungen  money in: issued invoices; money out: posted vendor bills; ONLY in the
 *                      line's currency (a EUR bill cannot settle a CHF line; the walk measured
 *                      EUR and USD offered for a CHF line)
 *   Konten             the chart, minus the line's own bank account
 *   Weitere            match an entry already on the books, split across several accounts
 *
 * Option ids carry their source as a prefix, so the same account can be a suggestion and a chart row
 * without two rows sharing an id; `resolvePick` turns an id back into what the row does next.
 */
import { formatMoney } from '../../i18n';
import type { ComboboxGroup, ComboboxOption } from '../../components/AccountCombobox';
import type { BankInboxLine, DraftTarget, LineVorschlag } from './model';
import { accountDraft, draftTargetOf, isCredit, targetKey } from './model';
import type { Lookups } from './lookups';
import { targetParts } from './lookups';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface TargetPickerModel {
  options: ComboboxOption[];
  groups: ComboboxGroup[];
  /** The option id that stands for the current target ('' when there is none). */
  value: string;
}

export type PickResult =
  | { kind: 'target'; target: DraftTarget; source: 'edited' | 'agent' | 'proposal'; chainVat: boolean }
  | { kind: 'mode'; mode: 'link' | 'split' }
  | { kind: 'none' };

/** Every searchable spelling of an amount: "1250.00", "1'250.00", "1250". */
function amountKeywords(minor: number, currency: string): string {
  const plain = (minor / 100).toFixed(2);
  return `${plain} ${formatMoney(minor, currency)} ${Math.floor(minor / 100)}`;
}

export function targetPickerModel(
  t: T,
  l: Lookups,
  line: BankInboxLine,
  current: DraftTarget | null,
  proposal: DraftTarget | null,
  vorschlag: LineVorschlag | undefined,
): TargetPickerModel {
  const options: ComboboxOption[] = [];
  const currentKey = targetKey(current);
  const bankLedger = l.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;

  const labelOf = (target: DraftTarget) => targetParts(t, l, line, target);

  if (current !== null) {
    const parts = labelOf(current);
    options.push({ id: 'cur', code: parts.code, label: parts.name, group: 'current', current: true, meta: t('bankInbox.picker.currentMeta') });
  }

  // Suggestions: the engine's proposal (when the row no longer shows it) and the agent's Vorschlag.
  if (proposal !== null && targetKey(proposal) !== currentKey) {
    const parts = labelOf(proposal);
    options.push({ id: 'sug:proposal', code: parts.code, label: parts.name, group: 'suggested', meta: t('bankInbox.picker.proposalMeta') });
  }
  if (vorschlag !== undefined && vorschlag.actionTool === 'book_bank_line') {
    const agentTarget = draftTargetOf(vorschlag.payload.target);
    if (agentTarget !== null && targetKey(agentTarget) !== currentKey) {
      const parts = labelOf(agentTarget);
      options.push({ id: 'sug:agent', code: parts.code, label: parts.name, group: 'suggested', meta: t('bankInbox.picker.agentMeta') });
    }
  }

  // Open items in the line's own currency, the right side of the ledger for the money's direction.
  if (isCredit(line)) {
    for (const inv of l.invoices) {
      if (inv.currency !== line.currency) continue;
      options.push({
        id: `inv:${inv.documentId}`,
        code: inv.number ?? t('bankInbox.target.invoice'),
        label: inv.contactName ?? t('bankInbox.target.invoiceName'),
        trailing: formatMoney(inv.openMinor, inv.currency),
        keywords: `${inv.number ?? ''} ${inv.contactName ?? ''} ${amountKeywords(inv.openMinor, inv.currency)}`,
        group: 'items',
        current: currentKey === `open_item:${inv.documentId}:` || (current?.kind === 'open_item' && current.documentId === inv.documentId),
      });
    }
  } else {
    for (const bill of l.bills) {
      if (bill.currency !== line.currency) continue;
      options.push({
        id: `bill:${bill.vendorBillId}`,
        code: bill.reference ?? t('bankInbox.target.bill'),
        label: bill.vendorName ?? t('bankInbox.target.billName'),
        trailing: formatMoney(bill.openMinor, bill.currency),
        keywords: `${bill.reference ?? ''} ${bill.vendorName ?? ''} ${amountKeywords(bill.openMinor, bill.currency)}`,
        group: 'items',
        current: current?.kind === 'open_item' && current.documentId === bill.vendorBillId,
      });
    }
  }

  for (const a of l.chart) {
    if (a.id === bankLedger) continue;
    options.push({
      id: `acc:${a.id}`,
      code: a.number,
      label: a.name,
      group: 'accounts',
      current: current?.kind === 'accounts' && current.legs.length === 1 && current.legs[0]?.accountId === a.id,
    });
  }

  options.push({ id: 'more:link', label: t('bankInbox.picker.moreLink'), meta: t('bankInbox.picker.moreLinkMeta'), group: 'more', keywords: t('bankInbox.picker.moreLinkKeywords') });
  options.push({ id: 'more:split', label: t('bankInbox.picker.moreSplit'), meta: t('bankInbox.picker.moreSplitMeta'), group: 'more', keywords: t('bankInbox.picker.moreSplitKeywords') });

  const groups: ComboboxGroup[] = [
    { key: 'current', label: t('bankInbox.picker.groupCurrent'), hideWhileSearching: true },
    { key: 'suggested', label: t('bankInbox.picker.groupSuggested'), hideWhileSearching: true },
    { key: 'items', label: t(isCredit(line) ? 'bankInbox.picker.groupInvoices' : 'bankInbox.picker.groupBills') },
    { key: 'accounts', label: t('bankInbox.picker.groupAccounts') },
    { key: 'more', label: t('bankInbox.picker.groupMore') },
  ];
  return { options, groups, value: current === null ? '' : 'cur' };
}

/** What a picked option id does to the row. */
export function resolvePick(
  l: Lookups,
  line: BankInboxLine,
  id: string,
  proposal: DraftTarget | null,
  vorschlag: LineVorschlag | undefined,
): PickResult {
  if (id === 'cur' || id === '') return { kind: 'none' };
  if (id === 'more:link') return { kind: 'mode', mode: 'link' };
  if (id === 'more:split') return { kind: 'mode', mode: 'split' };
  if (id === 'sug:proposal' && proposal !== null) return { kind: 'target', target: proposal, source: 'proposal', chainVat: false };
  if (id === 'sug:agent' && vorschlag !== undefined) {
    const target = draftTargetOf(vorschlag.payload.target);
    return target === null ? { kind: 'none' } : { kind: 'target', target, source: 'agent', chainVat: false };
  }
  const [prefix, ref] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (prefix === 'inv' || prefix === 'bill') {
    return { kind: 'target', target: { kind: 'open_item', documentId: ref, remainder: null }, source: 'edited', chainVat: false };
  }
  if (prefix === 'acc') {
    const account = l.chartById.get(ref);
    return { kind: 'target', target: accountDraft(line, ref, account?.vatCodeDefault ?? ''), source: 'edited', chainVat: true };
  }
  return { kind: 'none' };
}
