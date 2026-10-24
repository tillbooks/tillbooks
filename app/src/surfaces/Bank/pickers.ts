/**
 * The target picker's list: ONE searchable list over every place a bank line can go (the judge's
 * outcome 6, "pick, never type"), in the order a bookkeeper decides in:
 *
 *   Statt eines Kontos the three decisions that are not one account (D167): Aufteilen, Mit bestehender
 *                      Buchung abgleichen, Nicht buchen; each opens its editor in the strip
 *   Aktuell            the row's current target (hidden while searching)
 *   Vorschläge         the engine's proposal when the person changed it, the agent's Vorschlag
 *   Offene Rechnungen  money in: issued invoices; money out: posted vendor bills; ONLY in the
 *                      line's currency (a EUR bill cannot settle a CHF line; the walk measured
 *                      EUR and USD offered for a CHF line)
 *   Konten             the chart, minus the line's own bank account
 *
 * Option ids carry their source as a prefix, so the same account can be a suggestion and a chart row
 * without two rows sharing an id; `resolvePick` turns an id back into what the row does next.
 */
import { formatDate, formatMoney } from '../../i18n';
import type { ComboboxGroup, ComboboxOption } from '../../components/AccountCombobox';
import type { BankInboxLine, DraftTarget, LineVorschlag, RuleAsk } from './model';
import { accountDraft, draftTargetOf, isCredit, lineRuleIds, severalRuleIds, targetKey } from './model';
import type { Lookups } from './lookups';
import { plural, targetParts, taxCodeFor, vatPickerShows } from './lookups';
import { routeInWords, ruleName } from './rules';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface TargetPickerModel {
  options: ComboboxOption[];
  groups: ComboboxGroup[];
  /** The option id that stands for the current target ('' when there is none). */
  value: string;
}

export type PickResult =
  | { kind: 'target'; target: DraftTarget; source: 'edited' | 'agent' | 'proposal'; chainVat: boolean }
  | { kind: 'mode'; mode: 'link' | 'split' | 'ignore' }
  /** D175: "Anders buchen" on the rule chooser: the row shows the whole "Worauf buchen?" list. */
  | { kind: 'other' }
  /** UX judge round 2, item 5: "Auswahl entfernen", the picker's own way back to "Worauf buchen?". */
  | { kind: 'clear' }
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
  canPost = true,
): TargetPickerModel {
  const options: ComboboxOption[] = [];
  const currentKey = targetKey(current);
  const bankLedger = l.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;

  const labelOf = (target: DraftTarget) => targetParts(t, l, line, target);

  // D167: the three decisions that are not one account, at the top of "Worauf buchen?". Each opens the
  // same editor the strip opens; without the right to post each is listed, disabled, and says why.
  for (const [id, key] of [
    ['act:split', 'Split'],
    ['act:link', 'Link'],
    ['act:ignore', 'Ignore'],
  ] as const) {
    options.push({
      id,
      label: t(`bankInbox.picker.act${key}`),
      keywords: t(`bankInbox.picker.act${key}Keywords`),
      group: 'actions',
      ...(canPost ? {} : { disabled: true, meta: t('bankInbox.picker.actDenied') }),
    });
  }

  // D177: the payer's Buchungsregeln first (every live rule for its counterparty and direction), by name,
  // the route in words beside; a rule picked here books by it (its amounts in the Details).
  for (const id of lineRuleIds(line)) {
    const rule = l.standardById.get(id);
    if (rule === undefined || rule.invalidReason !== null) continue;
    options.push({
      id: `rule:${id}`,
      label: ruleName(t, rule),
      meta: routeInWords(t, l, rule),
      keywords: `${rule.matchText ?? ''} ${rule.counterpartyLabel}`,
      group: 'rules',
      current: current?.kind === 'rule' && current.standardId === id,
    });
  }

  if (current !== null) {
    const parts = labelOf(current);
    options.push({ id: 'cur', code: parts.code, label: parts.name, group: 'current', current: true, meta: t('bankInbox.picker.currentMeta') });
    // The field carries no clear ×: × means Ignorieren only. Clearing is a choice in the list.
    options.push({ id: 'act:clear', label: t('bankInbox.picker.clear'), keywords: t('bankInbox.picker.clearKeywords'), group: 'current' });
  }

  // Suggestions: the engine's proposal (when the row no longer shows it) and the agent's Vorschlag.
  if (proposal !== null && targetKey(proposal) !== currentKey) {
    const parts = labelOf(proposal);
    // The source in words (D167 polish 9): where TILL's suggestion comes from, as the row's glyph says it.
    const code: string = line.proposal?.reasonCode ?? '';
    const meta =
      code === 'standard'
        ? t('bankInbox.source.standard')
        : code === 'history' || code === 'journal_history'
          ? t('bankInbox.source.history')
          : t('bankInbox.picker.proposalMeta');
    options.push({ id: 'sug:proposal', code: parts.code, label: parts.name, group: 'suggested', meta });
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

  // D177: the generated payment runs of this Bankkonto, for money out (the run a debit pays).
  if (!isCredit(line)) {
    for (const b of l.batches) {
      if (b.bankAccountId !== '' && b.bankAccountId !== line.bankAccountId) continue;
      options.push({
        id: `batch:${b.batchId}`,
        code: b.executionDate === null ? t('bankInbox.target.batchCode') : formatDate(b.executionDate),
        label: plural(t, 'bankInbox.picker.batchLabel', b.itemCount),
        ...(b.totalMinor !== null ? { trailing: formatMoney(b.totalMinor, line.currency), keywords: amountKeywords(b.totalMinor, line.currency) } : {}),
        group: 'batches',
        current: current?.kind === 'payment_batch' && current.batchId === b.batchId,
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

  const groups: ComboboxGroup[] = [
    { key: 'actions', label: t('bankInbox.picker.groupActions') },
    { key: 'rules', label: t('bankInbox.picker.groupRules') },
    { key: 'current', label: t('bankInbox.picker.groupCurrent'), hideWhileSearching: true },
    { key: 'suggested', label: t('bankInbox.picker.groupSuggested'), hideWhileSearching: true, defaultActive: true },
    { key: 'items', label: t(isCredit(line) ? 'bankInbox.picker.groupInvoices' : 'bankInbox.picker.groupBills') },
    { key: 'batches', label: t('bankInbox.picker.groupBatches') },
    { key: 'accounts', label: t('bankInbox.picker.groupAccounts') },
  ];
  return { options, groups, value: current === null ? '' : 'cur' };
}

/**
 * D175 point 4 (A39 §14.3, §14.5): the chooser on a `several_rules` line. ONE decision: the rules that
 * match the line, by name (the engine names them; a rule the Studio cannot read still lists, by the
 * counterparty), and "Anders buchen". Nothing else: the full "Worauf buchen?" list is behind "Anders
 * buchen", so twenty rules for one payer never put twenty-one rows in front of a line two of them fit.
 */
export function ruleChooserModel(t: T, l: Lookups, line: BankInboxLine): TargetPickerModel {
  const options: ComboboxOption[] = severalRuleIds(line).map((id) => {
    const rule = l.standardById.get(id);
    return {
      id: `rule:${id}`,
      label: ruleName(t, rule),
      ...(rule !== undefined ? { meta: routeInWords(t, l, rule), keywords: rule.matchText ?? '' } : {}),
      group: 'rules',
    };
  });
  options.push({ id: 'act:other', label: t('bankInbox.rules.chooser.other'), keywords: t('bankInbox.rules.chooser.otherKeywords'), group: 'other' });
  return {
    options,
    groups: [
      { key: 'rules', label: t('bankInbox.rules.chooser.group'), defaultActive: true },
      { key: 'other', label: t('bankInbox.picker.groupActions') },
    ],
    value: '',
  };
}

/**
 * A rule picked from the chooser as the row's target: the rule with an empty field for each amount it
 * asks for, so the row turns into the one-candidate case (A39 §14.5). A rule that asks nothing books as
 * it stands; the engine expands it either way.
 */
export function ruleTargetOf(l: Lookups, standardId: string): DraftTarget {
  const rule = l.standardById.get(standardId);
  // D176: a "Nicht buchen" rule picked from the chooser is its ignore, decided by ignore_bank_line.
  if (rule !== undefined && rule.outcome === 'ignore') {
    return { kind: 'ignore', reason: rule.ignoreReason ?? 'other', note: rule.ignoreNote ?? '', standardId };
  }
  // D177: a computed (`factor`) leg is an ask the engine fills: no figure here, the preview shows it.
  const asks = (rule?.legs ?? []).flatMap((leg, legIndex): RuleAsk[] => {
    if (leg.amount.kind === 'ask') return [{ legIndex, label: leg.amount.label, value: '' }];
    if (leg.amount.kind === 'factor') {
      const { num, den, explain } = leg.amount;
      return [{ legIndex, label: leg.amount.label, value: '', computed: { minor: null, num, den, ...(explain !== undefined ? { explain } : {}) } }];
    }
    return [];
  });
  return { kind: 'rule', standardId, asks };
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
  // D175: the chooser's two answers.
  if (id === 'act:other') return { kind: 'other' };
  if (id === 'act:clear') return { kind: 'clear' };
  if (id.startsWith('rule:')) return { kind: 'target', target: ruleTargetOf(l, id.slice('rule:'.length)), source: 'edited', chainVat: false };
  if (id === 'act:link') return { kind: 'mode', mode: 'link' };
  if (id === 'act:split') return { kind: 'mode', mode: 'split' };
  if (id === 'act:ignore') return { kind: 'mode', mode: 'ignore' };
  if (id === 'sug:proposal' && proposal !== null) return { kind: 'target', target: proposal, source: 'proposal', chainVat: false };
  if (id === 'sug:agent' && vorschlag !== undefined) {
    const target = draftTargetOf(vorschlag.payload.target);
    return target === null ? { kind: 'none' } : { kind: 'target', target, source: 'agent', chainVat: false };
  }
  const [prefix, ref] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
  if (prefix === 'batch') return { kind: 'target', target: { kind: 'payment_batch', batchId: ref }, source: 'edited', chainVat: false };
  if (prefix === 'inv' || prefix === 'bill') {
    return { kind: 'target', target: { kind: 'open_item', documentId: ref, remainder: null }, source: 'edited', chainVat: false };
  }
  if (prefix === 'acc') {
    const taxCode = taxCodeFor(l, ref, '');
    return { kind: 'target', target: accountDraft(line, ref, taxCode), source: 'edited', chainVat: vatPickerShows(l, { accountId: ref, taxCode }) };
  }
  return { kind: 'none' };
}
