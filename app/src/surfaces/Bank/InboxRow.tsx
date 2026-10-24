/**
 * One bank line, decided on its own row (the judge's outcome 2), in B2's form (the owner's pick of
 * 01.10.2026) reduced to max by D167 (14.10.2026): date, counterparty, the account (with × to clear it
 * and ☆ to make it the counterparty's standard), MWST, the amount, the paperclip, Buchen and ⋯, in ONE
 * row at the density's height (K-20: every control in it is a 32px control). Nothing on the row opens
 * by itself: the row is selected only by the person's act, a click on its body or Enter or Space on the
 * focused row, and then its Details show in the side panel (D177).
 *
 * Buchen is there ONLY when the line has a target, tinted as the commit of a money write (K-08), with the
 * C4 consequence sentence as its real tooltip. A line without a target shows no greyed Buchen: its
 * "Worauf buchen?" picker is the call to action. A line an agent drafted reads "Buchen" like any other
 * (D167: "Prüfen" is gone); the host approves the pinned Vorschlag, or books the person's edited version
 * first and only then closes the Vorschlag.
 *
 * A prefilled account carries ONE small source glyph in normal ink (D167 pick 2A): ★ the person's
 * standard, ↻ past bookings (bank or journal), ◇ the agent. No glyph means "you chose it".
 *
 * A file dropped on the row is attached to the line as its Beleg (D142).
 *
 * D178 N2 (A39 §18.5), CLEAR ROW BUTTONS: every control on a row is a labelled text button, a field, or a
 * vocabulary glyph with its tooltip and name, and Buchen is the one text button. The D177 ★ (an unlabelled
 * Buchungsregel toggle) and × (an unlabelled Ignorieren) left the row for ONE Mehr at its right edge whose
 * items say what they do: "Als Buchungsregel speichern" (or "Buchungsregel öffnen" and "... entfernen"),
 * "Beleg anhängen", and, after a separator, "Ignorieren: <Grund>", still one click each with Rückgängig in
 * the status line. The paperclip shows only when it says something (a count, or "Ohne Beleg").
 */
import { COMMIT_TARGET_CLASS } from '../../lib/motion';
import { useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useT, useI18n, formatMoney } from '../../i18n';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { PickerButton } from '../../components/AccountCombobox';
import { TaxCodeCombobox } from '../../components/TaxCodeCombobox';
import { Tooltip } from '../../components/Tooltip';
import type { BankInboxLine, DraftTarget, IgnoreReason, LineVorschlag, RowCertainty, RowDraft } from './model';
import {
  BANK_LINE_IGNORE_REASONS,
  absAmount,
  bookTargetOf,
  composeVerdictError,
  draftTargetOf,
  isBookable,
  isCredit,
  isModelSuggestion,
  lineStandardId,
  needsRuleChoice,
  prefillSource,
  proposalTarget,
  rowCertainty,
  shortDate,
  lineDate,
} from './model';
import type { Lookups } from './lookups';
import { accountLabel, detailOf, partyOf, plural, targetParts, vatPickerShows } from './lookups';
import { resolvePick, ruleChooserModel, targetPickerModel, type PickResult } from './pickers';
import { AgentGlyph, CheckGlyph, EditedGlyph, LearnedGlyph, OpenGlyph, PaperclipGlyph, StandardGlyph, SureGlyph } from './glyphs';
import { restZeroReason } from './rules';
import { useTargetCompose } from './useBankCompose';
import { needsBookingPreview, previewBookState, useBookingPreview } from './BookingModes';
import { bookStateOf, vatSummaryOf, type SplitState } from './rowState';
import { woherOf } from './DetailsPanel';
import { duplicateFlagOf } from './statementFacts';
import { StatusWarnGlyph } from '../../components/icons';

/** How long the row waits after the last keystroke in an asked amount before it asks `compose_entry`. */
const ASK_COMPOSE_DEBOUNCE_MS = 250;

/** The certainty's glyph and its one word: status is glyph PLUS text. */
export function CertaintyMark({ certainty, withWord = false }: { certainty: RowCertainty; withWord?: boolean }) {
  const t = useT();
  const glyph =
    certainty === 'sure' ? (
      <SureGlyph size={16} />
    ) : certainty === 'learned' ? (
      <LearnedGlyph size={16} />
    ) : certainty === 'check' ? (
      <CheckGlyph size={16} />
    ) : certainty === 'edited' ? (
      <EditedGlyph size={16} />
    ) : certainty === 'agent' ? (
      <AgentGlyph size={16} />
    ) : (
      <OpenGlyph size={16} />
    );
  return (
    <span className="bank-cert" data-certainty={certainty}>
      {glyph}
      {withWord ? <span className="bank-cert__word">{t(`bankInbox.certainty.${certainty}`)}</span> : <span className="visually-hidden">{t(`bankInbox.certainty.${certainty}`)}</span>}
    </span>
  );
}

/**
 * D144, the AI disclosure on a model's suggestion, a transparency design choice (EU AI Act Art. 50 is
 * our reading, not legal clearance; owner, 30.09.2026): a two-letter tag in text ink, never a colour of
 * its own (the accent stays on posting clicks, D137), with an accessible name that says what it means.
 * The Details panel says the rest in words (the Woher line's tooltip).
 */
export function AiTag() {
  const t = useT();
  return (
    <span className="bank-ai-tag">
      <span aria-hidden="true">{t('bankInbox.ai.tag')}</span>
      <span className="visually-hidden">{t('bankInbox.ai.tagLabel')}</span>
    </span>
  );
}

/** "−89.90": the minus in danger ink (money's semantics), the figure in the text ink, tabular. */
export function SignedAmount({ minor, currency, showCurrency }: { minor: number; currency: string; showCurrency: boolean }) {
  const figure = formatMoney(Math.abs(minor), currency).slice(currency.length + 1);
  return (
    <span className="bank-amount t-money">
      {showCurrency && <span className="bank-amount__currency">{currency}</span>}
      {minor < 0 && (
        <span className="bank-amount__sign" aria-hidden="true">
          {'−'}
        </span>
      )}
      <span className="visually-hidden">{minor < 0 ? '-' : ''}</span>
      {figure}
    </span>
  );
}

/**
 * The Bankkonto a line belongs to, as a small dim tag AFTER the counterparty and its detail, only while
 * lines of several accounts share the list (critic F9): one account in view says it in the header already.
 * The counterparty is what people scan, so the tag is the first thing cut when the cell runs short.
 */
function AccountTag({ name }: { name: string | undefined }) {
  if (name === undefined) return null;
  return <span className="bank-account-tag">{name}</span>;
}

/**
 * D177 (UX judge): the counterparty cuts with an ellipsis where its column runs short, never mid-glyph,
 * and its whole name (with the memo and the Bankkonto) is its tooltip.
 */
function PartyCell({ party, detail, accountName }: { party: string; detail: string; accountName: string | undefined }) {
  const whole = [party, detail, accountName ?? ''].filter((x) => x !== '').join(' · ');
  return (
    <Tooltip content={whole}>
      <span className="bank-party-line" data-party-cell="">
        <span className="bank-party">{party}</span>
        {detail !== '' && <span className="bank-detail">{detail}</span>}
        <AccountTag name={accountName} />
      </span>
    </Tooltip>
  );
}

/** What a row shares between its open and decided forms: selection, keyboard, and a file dropped on it. */
interface RowBehaviour {
  selected: boolean;
  /** The person's act on the row body: select it, or collapse it when it is the selected one. */
  onToggle: () => void;
  /** The files dropped on the row, every one of them; null when the person may not attach one. */
  onDropFiles: ((files: File[]) => void) | null;
  /** The line's Bankkonto, named only in the multi-account view. */
  accountName?: string;
  /**
   * A write just changed this line where it stands (a Beleg attached, a Vorschlag rejected): the row
   * carries `data-just-committed` for the Commit moment's tint (D122 D-I, `useCommitAckState`).
   */
  justCommitted?: boolean;
}

/** True when a pointer event came from the row's own DOM (not a control in it, not a portal above it). */
function isRowBodyClick(event: MouseEvent<HTMLTableRowElement>): boolean {
  const target = event.target as Node;
  if (!event.currentTarget.contains(target)) return false;
  return (target instanceof Element ? target : target.parentElement)?.closest('button, a, input, label, select, textarea, [role="menu"]') === null;
}

/** Arrow keys walk the rows, Enter and Space toggle the focused one, Escape collapses it. */
function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, b: RowBehaviour) {
  if (event.target !== event.currentTarget) return;
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    b.onToggle();
    return;
  }
  if (event.key === 'Escape' && b.selected) {
    event.preventDefault();
    b.onToggle();
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const rows = Array.from(event.currentTarget.closest('tbody')?.querySelectorAll<HTMLTableRowElement>('tr.bank-row') ?? []);
    const at = rows.indexOf(event.currentTarget);
    rows[event.key === 'ArrowDown' ? at + 1 : at - 1]?.focus();
  }
}

/** The drop target: a file dragged over the row is announced by the row's tint, and attached on drop. */
function useRowDrop(onDropFiles: ((files: File[]) => void) | null) {
  const depth = useRef(0);
  const [over, setOver] = useState(false);
  if (onDropFiles === null) return { over: false, handlers: {} };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
  return {
    over,
    handlers: {
      onDragEnter: (e: DragEvent<HTMLTableRowElement>) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setOver(true);
      },
      onDragOver: (e: DragEvent<HTMLTableRowElement>) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer !== null) e.dataTransfer.dropEffect = 'copy';
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      },
      onDrop: (e: DragEvent<HTMLTableRowElement>) => {
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        // Every file dropped, never only the first (critic F9).
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) onDropFiles(files);
      },
    },
  };
}

/** D167 (pick 2A): the one small glyph before a prefilled account, in normal ink; ★ in the accent stroke. */
function SourceMark({ source }: { source: 'standard' | 'history' | 'agent' }) {
  return (
    <span className="bank-src" data-source={source}>
      {source === 'standard' ? <StandardGlyph size={16} /> : source === 'history' ? <LearnedGlyph size={16} /> : <AgentGlyph size={16} />}
    </span>
  );
}

/**
 * D167 item 7: the paperclip, always there on a line the person may attach to. At 0 it is a dim icon
 * button that opens the file picker (the D142 path); above 0 it carries the count and opens the line's
 * Belege. A line with Belege shows its count to a reader without the filing right too.
 */
function ClipButton({ line, party, canAttach, busy, onAttach, onOpenReceipts }: { line: BankInboxLine; party: string; canAttach: boolean; busy: boolean; onAttach: () => void; onOpenReceipts: () => void }) {
  const t = useT();
  const count = line.receiptCount;
  // D167 polish 10: "Ohne Beleg" (D142, a booked line that needs one) is the clip's own state, never a
  // second line under the counterparty: the row stays one line.
  const missing = count === 0 && line.needsReceipt;
  // D178 N2 (A39 §18.5): at 0 the clip says nothing, so it is not drawn; attaching is a drop on the row or
  // "Beleg anhängen" in Mehr. A line that needs one keeps its "Ohne Beleg" clip, inert without the right.
  if (count === 0 && !missing) return null;
  return (
    <Tooltip content={count > 0 ? plural(t, 'bankInbox.receipts.clipSome', count) : missing ? t('bankInbox.receipts.clipMissing') : t('bankInbox.receipts.clipNone')}>
      <button
        type="button"
        className={`btn btn--ghost btn--icon btn--sm bank-clip${count > 0 ? ' bank-clip--has' : ''}${missing ? ' bank-clip--missing' : ''}`}
        data-missing={missing ? 'true' : undefined}
        aria-label={missing ? t('bankInbox.receipts.clipMissingLabel', { party }) : t('bankInbox.receipts.clip', { party })}
        disabled={count === 0 && (busy || !canAttach)}
        onClick={(e) => {
          e.stopPropagation();
          if (count > 0) onOpenReceipts();
          else onAttach();
        }}
      >
        <PaperclipGlyph size={16} />
        {count > 0 && (
          <span className="bank-clip__count t-num" aria-hidden="true">
            {count}
          </span>
        )}
      </button>
    </Tooltip>
  );
}

export interface OpenRowProps extends RowBehaviour {
  /** The workspace the row's `compose_entry` read asks in (D175: a rule's asked amounts). */
  workspaceId: string;
  line: BankInboxLine;
  draft: RowDraft | undefined;
  lookups: Lookups;
  /**
   * The line arrived with the import just made: it keeps the accent dot while the import is the latest,
   * and lands with the Commit moment's decaying tint once (`useCommitAck` on `COMMIT_TARGET_CLASS`).
   */
  fresh?: boolean;
  /** A booking or a standard call on this line is in flight: its pickers, ×, ☆ and Buchen are inert. */
  busy: boolean;
  /** Show the currency beside the amount (the list mixes currencies). */
  showCurrency: boolean;
  vorschlag: LineVorschlag | undefined;
  /** The actor may book this target (post, and pay for a settlement). */
  canBook: (target: DraftTarget) => boolean;
  canPost: boolean;
  /** The person may attach a Beleg (the paperclip offers it). */
  canAttach: boolean;
  /** The C4 consequence sentence for booking this target, or null when the engine names none. */
  consequence: (target: DraftTarget) => string | null;
  /** Which of the row's pickers is open, so the account pick can hand over to the VAT pick. */
  openPicker: 'target' | 'vat' | null;
  onOpenPicker: (picker: 'target' | 'vat' | null) => void;
  onPick: (result: PickResult) => void;
  /** × in the account field: the line goes back to "Worauf buchen?". */
  onClear: () => void;
  onVat: (code: string) => void;
  /** Buchen: the host decides whether that approves the agent's Vorschlag or books the person's version. */
  onBook: () => void;
  /** D177 point 5, D178 N2: an "Ignorieren: <Grund>" item in Mehr ignores the line with that reason. */
  onIgnore: (reason: IgnoreReason) => void;
  /** "Anderer Grund": the Details panel asks for the note. */
  onIgnoreOther: () => void;
  /** The paperclip at 0: pick a file for this line. */
  onAttach: () => void;
  /** D167: "Als Buchungsregel speichern" on a one-account booking saves the rule from the line at once. */
  onSetStandard: () => void;
  /** D175: on a split or a via route it opens the rule form in the detail area instead. */
  onRuleForm: () => void;
  /** "Buchungsregel öffnen": the rules sheet, on the line's rule. */
  onOpenRule: (standardId: string) => void;
  /** "Buchungsregel entfernen": later lines of the counterparty are no longer prefilled by it. */
  onClearStandard: (standardId: string) => void;
  /** The paperclip with a count: the line's Belege. */
  onOpenReceipts: () => void;
  bookRef: (el: HTMLButtonElement | null) => void;
  /** The checkbox shows: a sure line, or any line once a pick is under way. */
  showPick: boolean;
  /** Picked for a bulk action (the leading checkbox). */
  picked: boolean;
  onTogglePick: () => void;
  /** D177: a split under way on this line (its position rows render under the row). */
  split?: SplitState | null;
  /** D177: the Details panel is open beside the table: the MWST and paperclip columns step aside. */
  compact?: boolean;
  /** The position rows, rendered right under this one. */
  after?: ReactNode;
}

/**
 * D178 N2 (A39 §18.5): the row's ONE Mehr, the vocabulary's three dots with its tooltip, holding in words
 * what the D177 ★ and × did without a word. The ignore reasons come last, after the menu's separator, one
 * click each (D177 point 5); "Anderer Grund" asks for its note in the detail area. Nothing to offer, no
 * trigger.
 */
function RowMenu({ party, amount, busy, items }: { party: string; amount: string; busy: boolean; items: OverflowMenuItem[] }) {
  const t = useT();
  if (items.length === 0) return null;
  return (
    <OverflowMenu
      quiet
      portal
      icon="more"
      className="bank-row-menu"
      label={t('bankInbox.row.more', { party, amount })}
      tooltip={t('bankInbox.row.moreTip')}
      items={items}
      disabled={busy}
    />
  );
}

export function OpenRow({
  workspaceId,
  line,
  draft,
  lookups,
  selected,
  fresh = false,
  justCommitted = false,
  busy,
  showCurrency,
  vorschlag,
  canBook,
  canPost,
  canAttach,
  consequence,
  openPicker,
  onOpenPicker,
  onToggle,
  onDropFiles,
  accountName,
  onPick,
  onClear,
  onVat,
  onBook,
  onIgnore,
  onIgnoreOther,
  onAttach,
  onSetStandard,
  onRuleForm,
  onOpenRule,
  onClearStandard,
  onOpenReceipts,
  bookRef,
  showPick,
  picked,
  onTogglePick,
  split = null,
  compact = false,
  after,
}: OpenRowProps) {
  const t = useT();
  const target = draft?.target ?? null;
  const proposal = proposalTarget(line);
  const certainty = rowCertainty(line, draft);
  const source = prefillSource(line, draft, vorschlag !== undefined && vorschlag.actionTool === 'book_bank_line' ? draftTargetOf(vorschlag.payload.target) : null);
  const party = partyOf(t, line);
  const detail = detailOf(line);
  // D175 point 4: several rules fit and the text does not decide. The row asks ONE question, which rule
  // (or "Anders buchen"), until the person answered it.
  const choosing = needsRuleChoice(line, draft);
  const model = choosing ? ruleChooserModel(t, lookups, line) : targetPickerModel(t, lookups, line, target, proposal, vorschlag, canPost);
  const parts = targetParts(t, lookups, line, target);
  // D175: a rule's amounts. Once every ask is a positive number (or a computed leg left as figured) the
  // ENGINE composes the booking; a rest of zero is its refusal, said on Buchen's tooltip and at the field.
  const ruleTarget = target?.kind === 'rule' ? target : null;
  const ruleCompose = useTargetCompose(workspaceId, line.bankTxnId, ruleTarget !== null && isBookable(line, ruleTarget) ? bookTargetOf(ruleTarget) : null, {
    debounceMs: ASK_COMPOSE_DEBOUNCE_MS,
  });
  const ruleRefusal = ruleCompose.status === 'answered' ? composeVerdictError(ruleCompose.answer) : ruleCompose.status === 'failed' ? ruleCompose.error : null;
  const restZero = ruleRefusal?.error === 'rest_is_zero';
  const allowed = target === null || canBook(target);
  const ruleBook = bookStateOf(t, line, target, { allowed, restZero: restZero && ruleTarget !== null ? restZeroReason(t, lookups, ruleTarget) : false, split });
  // N3-C2: a target only the engine's preview can judge (several documents, a contact, Spesen, an FX leg)
  // holds the row's Buchen exactly as it holds the pane's: while the preview is out, refused or denied.
  const { locale } = useI18n();
  const preview = useBookingPreview(workspaceId, line, target);
  const computedBook = needsBookingPreview(target) ? previewBookState(t, locale, line, preview, ruleBook) : ruleBook;
  // A line waiting for its rule to be chosen says that, not "Konto wählen".
  // D178 point 19: a line flagged as a possible duplicate waits for the person's answer before any booking.
  const duplicate = duplicateFlagOf(line);
  const book =
    duplicate !== null
      ? { enabled: false, reason: t('bankInbox.duplicate.bookWhy') }
      : choosing && computedBook.reason !== null
        ? { ...computedBook, reason: t('bankInbox.book.why.rule') }
        : computedBook;
  const singleLeg = split === null && target?.kind === 'accounts' && target.legs.length === 1 ? target.legs[0] : undefined;
  const drop = useRowDrop(onDropFiles);
  const behaviour: RowBehaviour = { selected, onToggle, onDropFiles };
  const standardId = lineStandardId(line);
  const amountWords = formatMoney(absAmount(line), line.currency);

  // The glyph before the account: ONE per line. A prefill names its source (★ ↻ ◇), the model's
  // suggestion keeps its check glyph and "KI" tag (D144), the person's own choice carries none, and every
  // other proposal keeps its certainty glyph (a `check` draws in ink, D177).
  // D178 N2: the ★ toggle left the row, so a line on the person's Buchungsregel shows the ★ source glyph in
  // its field (D167 pick 2A) and the rule's acts are words in Mehr.
  const mark: ReactNode =
    target === null || split !== null ? null : source === 'standard' || source === 'history' || source === 'agent' ? (
      <SourceMark source={source} />
    ) : certainty === 'edited' || certainty === 'agent' || certainty === 'open' ? null : (
      <CertaintyMark certainty={certainty} />
    );
  // D177: the source in a few words (the Woher line's name), never the reason paragraph.
  const woher = target === null ? null : woherOf(t, lookups, line, draft, vorschlag);
  const sourceTip = woher === null ? null : woher.label;

  const picker = (
    <PickerButton
      label={choosing ? t('bankInbox.rules.chooser.label', { party }) : t('bankInbox.row.targetLabel', { party })}
      options={model.options}
      groups={model.groups}
      value={model.value}
      onChange={(id) => {
        const result = resolvePick(lookups, line, id, proposal, vorschlag);
        if (result.kind === 'clear') onClear();
        else onPick(result);
      }}
      searchLabel={choosing ? t('bankInbox.rules.chooser.search') : t('bankInbox.picker.search')}
      noMatchLabel={t('bankInbox.picker.noMatch')}
      hint={t('picker.hint')}
      open={openPicker === 'target'}
      onOpenChange={(open) => onOpenPicker(open ? 'target' : null)}
      disabled={busy}
      className={`bank-picker bank-picker--target${target === null ? ' bank-picker--empty' : ''}`}
      width={440}
    >
      {mark}
      {target === null ? (
        <span className="picker-trigger__placeholder">{t(choosing ? 'bankInbox.rules.chooser.placeholder' : 'bankInbox.row.targetPlaceholder')}</span>
      ) : (
        <>
          {parts.code !== '' && <span className="picker-trigger__code t-num">{parts.code}</span>}
          <span className="picker-trigger__name">{parts.name}</span>
        </>
      )}
      {isModelSuggestion(line, draft) && <AiTag />}
    </PickerButton>
  );

  // MWST (D167 item 5, D177): a one-leg booking keeps the picker; a rule or a split says its MWST in short
  // ("MWST 8.1 %", "gemischt") as a quiet button that opens the line's Details. A settlement, a match and
  // a run stay blank; without an account the cell is blank (D167 polish 7).
  const vatCode = singleLeg !== undefined ? lookups.taxCodes.find((c) => c.code === singleLeg.taxCode) : undefined;
  const locked = (text: string, reason: string) => (
    <Tooltip content={reason}>
      <button type="button" className="picker-trigger bank-picker bank-picker--vat bank-picker--locked" aria-disabled="true" aria-label={t('bankInbox.row.vatOffLabel', { party })}>
        <span className="picker-trigger__value">
          <span className="picker-trigger__name">{text}</span>
        </span>
      </button>
    </Tooltip>
  );
  const summary = vatSummaryOf(t, lookups, target);
  let vatCell: ReactNode = null;
  if (target === null) {
    vatCell = null;
  } else if (singleLeg !== undefined && vatPickerShows(lookups, singleLeg)) {
    const vatPicker = (
      <TaxCodeCombobox
        label={vatCode !== undefined ? t('bankInbox.row.vatNamed', { party, code: vatCode.code, name: vatCode.label }) : t('bankInbox.row.vatLabel', { party })}
        codes={lookups.taxCodes}
        value={singleLeg.taxCode}
        direction={isCredit(line) ? 'in' : 'out'}
        strictGroups={{ label: t(isCredit(line) ? 'bankInbox.row.vatGroupIn' : 'bankInbox.row.vatGroupOut'), otherLabel: t('bankInbox.row.vatGroupOther') }}
        humanLabels={{ date: lineDate(line) }}
        open={openPicker === 'vat'}
        onOpenChange={(open) => onOpenPicker(open ? 'vat' : null)}
        onChange={onVat}
        disabled={busy}
        className="bank-picker bank-picker--vat"
      />
    );
    vatCell = vatCode !== undefined ? <Tooltip content={`${vatCode.code} ${vatCode.label}`}>{vatPicker}</Tooltip> : vatPicker;
  } else if (singleLeg !== undefined) {
    vatCell = locked(t('taxCode.none'), t('bankInbox.row.vatNotApplicable', { account: accountLabel(lookups, singleLeg.accountId) || parts.name }));
  } else if (summary !== null && split === null) {
    // D178 N2 (A39 §18.5): a value, not a second text button on the row. A click on it is a click on the
    // row body: the line's details open, where MWST shows per position.
    vatCell = (
      <span className="bank-vat-summary" data-vat-summary="">
        {summary}
      </span>
    );
  }

  // D175: a Buchungsregel can be saved from any accounts booking whose legs all name an account. One leg
  // straight to an account saves at once (D167); a split or a route through a Durchlaufkonto opens the rule
  // form in the detail area, prefilled.
  const accountsTarget = target?.kind === 'accounts' ? target : null;
  const canSetRule = accountsTarget !== null && accountsTarget.legs.length > 0 && accountsTarget.legs.every((l) => l.accountId !== '') && (split === null || split.complete);
  const recipeShaped = accountsTarget !== null && (accountsTarget.legs.length > 1 || (accountsTarget.viaAccountId ?? '') !== '');
  const menu: OverflowMenuItem[] = [];
  if (canPost && standardId !== null) {
    menu.push({ key: 'rule-open', label: t('bankInbox.row.menu.ruleOpen'), onSelect: () => onOpenRule(standardId) });
    menu.push({ key: 'rule-clear', label: t('bankInbox.row.menu.ruleClear'), onSelect: () => onClearStandard(standardId) });
  } else if (canPost && canSetRule) {
    menu.push({ key: 'rule-save', label: t('bankInbox.row.menu.ruleSave'), onSelect: () => (recipeShaped ? onRuleForm() : onSetStandard()) });
  }
  if (canAttach) menu.push({ key: 'attach', label: t('bankInbox.menu.attach'), onSelect: onAttach });
  if (canPost) {
    for (const r of BANK_LINE_IGNORE_REASONS) {
      menu.push({
        key: `ignore-${r}`,
        label: t('bankInbox.row.menu.ignoreAs', { reason: t(`bankInbox.ignore.reason.${r}.label`) }),
        danger: true,
        onSelect: () => (r === 'other' ? onIgnoreOther() : onIgnore(r)),
      });
    }
  }

  // D177 (UX judge, item 10): every open row shows Buchen; without a target it is disabled and says
  // what is missing ("Konto wählen"), so no row is a missing button.
  let action: ReactNode = null;
  {
    const match = target?.kind === 'existing_entry';
    const ignoring = target?.kind === 'ignore';
    // A match posts nothing and is undone by "Abgleich lösen": its sentence is the link chooser's own,
    // never the posting one (critic F6). The posting sentences come from the engine's dial map. A disabled
    // Buchen always says why, in a few words (D177 point 4).
    const sentence = !book.enabled
      ? book.reason
      : match
        ? t('bankInbox.link.consequence')
        : ignoring
          ? t('bankInbox.ignore.consequence')
          : target === null
            ? null
            : consequence(target);
    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
      // A held Enter or Space repeats: the repeat never books (critic F3). Only a fresh press does.
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
    };
    const inert = busy || !book.enabled;
    const onClick = (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (inert) return;
      onBook();
    };
    // The tinted accent is ONLY the commit of a money write that posts (K-08, D137). Abgleichen and a
    // "Nicht buchen" proposal post nothing: the secondary edge, in their own words. A Buchen that cannot
    // book stays focusable and hoverable (`aria-disabled`), so its reason is reachable.
    const button =
      match || ignoring ? (
        <button type="button" ref={bookRef} className="btn btn--secondary btn--sm bank-row__book" aria-disabled={inert ? true : undefined} onKeyDown={onKeyDown} onClick={onClick}>
          {busy ? t('bankInbox.row.busy') : t(match ? 'bankInbox.row.match' : 'bankInbox.row.ignoreRule')}
        </button>
      ) : (
        <button
          type="button"
          ref={bookRef}
          className="btn btn--accent btn--sm bank-row__book"
          data-money-commit="book_bank_line"
          aria-disabled={inert ? true : undefined}
          onKeyDown={onKeyDown}
          onClick={onClick}
        >
          {busy ? t('bankInbox.row.busy') : t('bankInbox.row.book')}
        </button>
      );
    // D177 polish 3: below Buchen, its left edge at Buchen's, so it never lies over the row above or over
    // another row's amount (the amount column ends left of Buchen).
    action =
      sentence === null || sentence === '' ? (
        button
      ) : (
        <Tooltip content={sentence} placement="bottom" align="start">
          {button}
        </Tooltip>
      );
  }

  return (
    <>
      <tr
        className={fresh ? `bank-row ${COMMIT_TARGET_CLASS}` : 'bank-row'}
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        aria-busy={busy ? true : undefined}
        data-selected={selected ? 'true' : undefined}
        data-just-committed={justCommitted ? '' : undefined}
        data-fresh={fresh ? 'true' : undefined}
        data-drop={drop.over ? 'true' : undefined}
        data-line={line.bankTxnId}
        data-certainty={certainty}
        data-source={source ?? undefined}
        data-picked={picked ? 'true' : undefined}
        data-splitting={split !== null ? 'true' : undefined}
        data-duplicate={duplicate !== null ? 'true' : undefined}
        onClick={(e) => {
          if (isRowBodyClick(e)) onToggle();
        }}
        onKeyDown={(e) => onRowKeyDown(e, behaviour)}
        {...drop.handlers}
      >
        {!compact && (
        <td className="bank-cell bank-cell--pick">
          {showPick && (
            <label className="check-cell">
              <input
                type="checkbox"
                checked={picked}
                onChange={onTogglePick}
                aria-label={t('bankInbox.pick.row', { party, amount: formatMoney(line.amountMinor, line.currency) })}
              />
            </label>
          )}
        </td>
        )}
        <td className="bank-cell bank-cell--date t-num">{shortDate(lineDate(line))}</td>
        <td className="bank-cell bank-cell--party">
          {/* D178 point 19: one warn glyph names the open question; the answer is in the line's details. */}
          {duplicate !== null && (
            // B5 judge: the warning glyph carries its words; the full question stays its accessible name.
            <span className="bank-dup-mark" role="img" aria-label={t('bankInbox.duplicate.mark')} data-duplicate="">
              <StatusWarnGlyph size={16} />
              <span className="bank-dup-mark__word">{t('bankInbox.duplicate.short')}</span>
            </span>
          )}
          <PartyCell party={party} detail={detail} accountName={accountName} />
        </td>
        <td className="bank-cell bank-cell--target">
          {split !== null ? (
            <span className="bank-target bank-target--split">{plural(t, 'bankInbox.split.rowLabel', split.positions)}</span>
          ) : (
            <span className="bank-target">
              {sourceTip !== null && sourceTip !== '' ? <Tooltip content={sourceTip}>{picker}</Tooltip> : picker}
            </span>
          )}
        </td>
        {!compact && <td className="bank-cell bank-cell--vat">{vatCell}</td>}
        <td className="bank-cell bank-cell--amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={showCurrency} />
        </td>
        {!compact && (
          <td className="bank-cell bank-cell--clip">
            <ClipButton line={line} party={party} canAttach={canAttach} busy={busy} onAttach={onAttach} onOpenReceipts={onOpenReceipts} />
          </td>
        )}
        {/* UX judge round 2, item 12: one Buchen per line on screen. While the Details panel beside the
            table shows this line, its Buchen is the panel's; the cell keeps its width. */}
        <td className="bank-cell bank-cell--book">{compact && selected ? null : action}</td>
        {/* D178 N2 (A39 §18.5): the row's one Mehr in the fixed last column (the D177 ignore column). */}
        <td className="bank-cell bank-cell--ignore">
          <RowMenu party={party} amount={amountWords} busy={busy} items={menu} />
        </td>
      </tr>
      {after}
    </>
  );
}

// --- decided rows ---------------------------------------------------------------------------------

export interface DecidedRowProps extends RowBehaviour {
  line: BankInboxLine;
  showCurrency: boolean;
  /** What the line was booked to, in words. */
  summary: string;
  /** The undo's label: Stornieren, Abgleich lösen, Wieder zu buchen. */
  undoLabel: string;
  canUndo: boolean;
  canAttach: boolean;
  onUndo: () => void;
  onAttach: () => void;
  /** The paperclip with a count: the line's Belege. */
  onOpenReceipts: () => void;
  /** D176: the Vorlage the rule that decided the line names as its next step, or null. */
  followUp?: { standardId: string; label: string } | null;
  /** D176: where the next step opens: the composer prefilled with that Vorlage. */
  followUpHref?: (standardId: string) => string;
  /** D177: the Details panel is open beside the table (no MWST and paperclip columns). */
  compact?: boolean;
  after?: ReactNode;
}

export function DecidedRow({
  line,
  selected,
  justCommitted = false,
  showCurrency,
  summary,
  undoLabel,
  canUndo,
  canAttach,
  onUndo,
  onAttach,
  onOpenReceipts,
  onToggle,
  onDropFiles,
  accountName,
  followUp = null,
  followUpHref,
  compact = false,
  after,
}: DecidedRowProps) {
  const t = useT();
  const party = partyOf(t, line);
  const detail = detailOf(line);
  const drop = useRowDrop(onDropFiles);
  const behaviour: RowBehaviour = { selected, onToggle, onDropFiles };
  const menu: OverflowMenuItem[] = [
    { key: 'undo', label: undoLabel, onSelect: onUndo, disabled: !canUndo },
    ...(canAttach ? [{ key: 'attach', label: t('bankInbox.menu.attach'), onSelect: onAttach }] : []),
  ];
  return (
    <>
      <tr
        className="bank-row bank-row--decided"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        data-just-committed={justCommitted ? '' : undefined}
        data-drop={drop.over ? 'true' : undefined}
        data-line={line.bankTxnId}
        data-state={line.state}
        onClick={(e) => {
          if (isRowBodyClick(e)) onToggle();
        }}
        onKeyDown={(e) => onRowKeyDown(e, behaviour)}
        {...drop.handlers}
      >
        <td className="bank-cell bank-cell--date t-num">{shortDate(lineDate(line))}</td>
        <td className="bank-cell bank-cell--party">
          <PartyCell party={party} detail={detail} accountName={accountName} />
        </td>
        <td className="bank-cell bank-cell--summary" colSpan={compact ? 1 : 2}>
          <span className="bank-state" data-state={line.state}>
            <span className="bank-state__word">{t(`bankInbox.state.${line.state}`)}</span>
            <span className="bank-state__summary">{summary}</span>
            {followUp !== null && followUpHref !== undefined && (
              // D176 (A39 §15.4): the two-step route made visible: the next step opens the composer prefilled.
              <Link className="bank-state__next" to={followUpHref(followUp.standardId)} onClick={(e) => e.stopPropagation()}>
                {t('bankInbox.rules.next.link', { name: followUp.label })}
              </Link>
            )}
          </span>
        </td>
        <td className="bank-cell bank-cell--amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={showCurrency} />
        </td>
        {!compact && (
          <td className="bank-cell bank-cell--clip">
            <ClipButton line={line} party={party} canAttach={canAttach} busy={false} onAttach={onAttach} onOpenReceipts={onOpenReceipts} />
          </td>
        )}
        <td className="bank-cell bank-cell--book" />
        <td className="bank-cell bank-cell--ignore">
          <RowMenu party={party} amount={formatMoney(absAmount(line), line.currency)} busy={false} items={menu} />
        </td>
      </tr>
      {after}
    </>
  );
}
