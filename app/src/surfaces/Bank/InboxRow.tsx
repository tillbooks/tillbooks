/**
 * One bank line, decided on its own row (the judge's outcome 2), in B2's form (the owner's pick of
 * 01.10.2026): date, counterparty, what it will be booked to, the VAT, the amount, and Buchen, in ONE
 * row at the density's height (K-20: every control in it is a 32px control). Nothing on the row opens
 * by itself: the row is selected only by the person's act, a click on its body or Enter or Space on the
 * focused row, and then its context strip shows under it.
 *
 * Buchen is there ONLY when the line has a target, tinted as the commit of a money write (K-08), with the
 * C4 consequence sentence as its real tooltip. A line without a target shows no greyed Buchen: its
 * "Worauf buchen?" picker is the call to action. A line an agent Vorschlag names reads "Prüfen" instead,
 * which opens the strip with the Vorschlag and its decision.
 *
 * A file dropped on the row is attached to the line as its Beleg (D142); the count shows beside the
 * counterparty.
 */
import { COMMIT_TARGET_CLASS } from '../../lib/motion';
import { useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';

import { useT, formatMoney } from '../../i18n';
import { OverflowMenu, type OverflowMenuItem } from '../../components/OverflowMenu';
import { PickerButton } from '../../components/AccountCombobox';
import { TaxCodeCombobox } from '../../components/TaxCodeCombobox';
import { Tooltip } from '../../components/Tooltip';
import type { BankInboxLine, DraftTarget, LineVorschlag, RowCertainty, RowDraft } from './model';
import { absAmount, isBookable, isCredit, isModelSuggestion, proposalTarget, rowCertainty, shortDate, lineDate } from './model';
import type { Lookups } from './lookups';
import { detailOf, partyOf, plural, targetParts, vatPickerShows } from './lookups';
import { resolvePick, targetPickerModel, type PickResult } from './pickers';
import { AgentGlyph, CheckGlyph, EditedGlyph, LearnedGlyph, OpenGlyph, PaperclipGlyph, SureGlyph } from './glyphs';

export type RowMenuAction = 'split' | 'link' | 'agent' | 'attach' | 'ignore';

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
 * The strip says the rest in words.
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
 * D142: the line's receipts on its row. A paperclip WITH the count, and on a line booked to accounts
 * without one, the words "Ohne Beleg" (the engine's `needsReceipt`). Nothing on a line that needs no
 * receipt and has none: a quiet row is the common case.
 */
function ReceiptMark({ line }: { line: BankInboxLine }) {
  const t = useT();
  if (line.receiptCount > 0) {
    return (
      <span className="bank-receipts">
        <PaperclipGlyph size={16} />
        <span className="bank-receipts__count" aria-hidden="true">
          {line.receiptCount}
        </span>
        <span className="visually-hidden">{plural(t, 'bankInbox.receipts.count', line.receiptCount)}</span>
      </span>
    );
  }
  if (line.needsReceipt) {
    return (
      <span className="bank-receipts bank-receipts--missing">
        <PaperclipGlyph size={16} />
        {t('bankInbox.receipts.missing')}
      </span>
    );
  }
  return null;
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

export interface OpenRowProps extends RowBehaviour {
  line: BankInboxLine;
  draft: RowDraft | undefined;
  lookups: Lookups;
  /**
   * The line arrived with the import just made: it keeps the accent dot while the import is the latest,
   * and lands with the Commit moment's decaying tint once (`useCommitAck` on `COMMIT_TARGET_CLASS`).
   */
  fresh?: boolean;
  busy: boolean;
  /** Show the currency beside the amount (the list mixes currencies). */
  showCurrency: boolean;
  vorschlag: LineVorschlag | undefined;
  /** The actor may book this target (post, and pay for a settlement). */
  canBook: (target: DraftTarget) => boolean;
  canPost: boolean;
  /** The person may attach a Beleg (the overflow offers it). */
  canAttach: boolean;
  /** The C4 consequence sentence for booking this target, or null when the engine names none. */
  consequence: (target: DraftTarget) => string | null;
  /** Which of the row's pickers is open, so the account pick can hand over to the VAT pick. */
  openPicker: 'target' | 'vat' | null;
  onOpenPicker: (picker: 'target' | 'vat' | null) => void;
  onPick: (result: PickResult) => void;
  onVat: (code: string) => void;
  onBook: () => void;
  onReview: () => void;
  onMenu: (action: RowMenuAction) => void;
  bookRef: (el: HTMLButtonElement | null) => void;
  /** The checkbox shows: a sure line, or any line once a pick is under way. */
  showPick: boolean;
  /** Picked for a bulk action (the leading checkbox), apart from the one row the strip shows. */
  picked: boolean;
  onTogglePick: () => void;
  /** The context strip, rendered as the row right under this one. */
  after?: ReactNode;
}

export function OpenRow({
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
  onVat,
  onBook,
  onReview,
  onMenu,
  bookRef,
  showPick,
  picked,
  onTogglePick,
  after,
}: OpenRowProps) {
  const t = useT();
  const target = draft?.target ?? null;
  const proposal = proposalTarget(line);
  const certainty = rowCertainty(line, draft);
  const party = partyOf(t, line);
  const detail = detailOf(line);
  const model = targetPickerModel(t, lookups, line, target, proposal, vorschlag);
  const parts = targetParts(t, lookups, line, target);
  const bookable = isBookable(line, target);
  const allowed = target === null || canBook(target);
  const singleLeg = target?.kind === 'accounts' && target.legs.length === 1 ? target.legs[0] : undefined;
  const pendingAgent = vorschlag !== undefined;
  const drop = useRowDrop(onDropFiles);
  const behaviour: RowBehaviour = { selected, onToggle, onDropFiles };

  const menu: OverflowMenuItem[] = [
    { key: 'split', label: t('bankInbox.menu.split'), onSelect: () => onMenu('split'), disabled: !canPost },
    { key: 'link', label: t('bankInbox.menu.link'), onSelect: () => onMenu('link'), disabled: !canPost },
    { key: 'agent', label: t('bankInbox.menu.agent'), onSelect: () => onMenu('agent') },
    ...(canAttach ? [{ key: 'attach', label: t('bankInbox.menu.attach'), onSelect: () => onMenu('attach') }] : []),
    { key: 'ignore', label: t('bankInbox.menu.ignore'), onSelect: () => onMenu('ignore'), disabled: !canPost },
  ];

  // MWST: only where a code can apply (an Erfolgskonto, an Anlagekonto, or a leg that already carries
  // one); blank for a settlement, a match, a payment run, a VAT account and a Bankkonto's ledger account.
  // The cell shows the CODE, as the composer's MWST trigger does, so the column never cuts a label; the
  // code's full label is in the picker's accessible name and in a real tooltip. "Ohne MWST" keeps its words.
  const vatCode = singleLeg !== undefined ? lookups.taxCodes.find((c) => c.code === singleLeg.taxCode) : undefined;
  const vatPicker =
    singleLeg !== undefined ? (
      <TaxCodeCombobox
        label={
          vatCode !== undefined
            ? t('bankInbox.row.vatNamed', { party, code: vatCode.code, name: vatCode.label })
            : t('bankInbox.row.vatLabel', { party })
        }
        codes={lookups.taxCodes}
        value={singleLeg.taxCode}
        direction={isCredit(line) ? 'in' : 'out'}
        open={openPicker === 'vat'}
        onOpenChange={(open) => onOpenPicker(open ? 'vat' : null)}
        onChange={onVat}
        className="bank-picker bank-picker--vat"
      />
    ) : null;
  const vatCell =
    singleLeg !== undefined && vatPickerShows(lookups, singleLeg) ? (
      vatCode !== undefined ? (
        <Tooltip content={`${vatCode.code} ${vatCode.label}`}>
          <span className="bank-vat-tip">{vatPicker}</span>
        </Tooltip>
      ) : (
        vatPicker
      )
    ) : target?.kind === 'accounts' && target.legs.length > 1 ? (
      <span className="bank-vat-info">{t('bankInbox.vat.perPosition')}</span>
    ) : null;

  let action: ReactNode = null;
  if (pendingAgent) {
    action = (
      <button
        type="button"
        ref={bookRef}
        className="btn btn--secondary btn--sm bank-row__book"
        disabled={busy}
        onClick={(e) => {
          e.stopPropagation();
          onReview();
        }}
      >
        {t('bankInbox.row.review')}
      </button>
    );
  } else if (target !== null) {
    const match = target.kind === 'existing_entry';
    // A match posts nothing and is undone by "Abgleich lösen": its sentence is the link chooser's own,
    // never the posting one (critic F6). The posting sentences come from the engine's dial map.
    const sentence = !allowed
      ? t(target.kind === 'open_item' || target.kind === 'payment_batch' ? 'bankInbox.row.needsPay' : 'bankInbox.row.needsPost')
      : match
        ? t('bankInbox.link.consequence')
        : consequence(target);
    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
      // A held Enter or Space repeats: the repeat never books (critic F3). Only a fresh press does.
      if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
    };
    const onClick = (e: MouseEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      if (!allowed) return;
      onBook();
    };
    // The tinted accent is ONLY the commit of a money write that posts (K-08, D137): Buchen. Abgleichen
    // links an entry already on the books and posts nothing, so it is the secondary edge.
    const book = match ? (
      <button type="button" ref={bookRef} className="btn btn--secondary btn--sm bank-row__book" disabled={busy || !bookable} aria-disabled={!allowed ? true : undefined} onKeyDown={onKeyDown} onClick={onClick}>
        {busy ? t('bankInbox.row.busy') : t('bankInbox.row.match')}
      </button>
    ) : (
      <button
        type="button"
        ref={bookRef}
        className="btn btn--accent btn--sm bank-row__book"
        data-money-commit="book_bank_line"
        disabled={busy || !bookable}
        aria-disabled={!allowed ? true : undefined}
        onKeyDown={onKeyDown}
        onClick={onClick}
      >
        {busy ? t('bankInbox.row.busy') : t('bankInbox.row.book')}
      </button>
    );
    action = sentence === null ? book : <Tooltip content={sentence}>{book}</Tooltip>;
  }

  return (
    <>
      <tr
        className={fresh ? `bank-row ${COMMIT_TARGET_CLASS}` : 'bank-row'}
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        data-selected={selected ? 'true' : undefined}
        data-just-committed={justCommitted ? '' : undefined}
        data-fresh={fresh ? 'true' : undefined}
        data-drop={drop.over ? 'true' : undefined}
        data-line={line.bankTxnId}
        data-certainty={certainty}
        data-picked={picked ? 'true' : undefined}
        onClick={(e) => {
          if (isRowBodyClick(e)) onToggle();
        }}
        onKeyDown={(e) => onRowKeyDown(e, behaviour)}
        {...drop.handlers}
      >
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
        <td className="bank-cell bank-cell--date t-num">{shortDate(lineDate(line))}</td>
        <td className="bank-cell bank-cell--party">
          <span className="bank-party-line">
            <span className="bank-party">{party}</span>
            {detail !== '' && <span className="bank-detail">{detail}</span>}
            <AccountTag name={accountName} />
          </span>
          <ReceiptMark line={line} />
        </td>
        <td className="bank-cell bank-cell--target">
          <PickerButton
            label={t('bankInbox.row.targetLabel', { party })}
            options={model.options}
            groups={model.groups}
            value={model.value}
            onChange={(id) => onPick(resolvePick(lookups, line, id, proposal, vorschlag))}
            searchLabel={t('bankInbox.picker.search')}
            noMatchLabel={t('bankInbox.picker.noMatch')}
            hint={t('picker.hint')}
            open={openPicker === 'target'}
            onOpenChange={(open) => onOpenPicker(open ? 'target' : null)}
            className={`bank-picker bank-picker--target${target === null ? ' bank-picker--empty' : ''}`}
            width={440}
          >
            {target !== null && <CertaintyMark certainty={certainty} />}
            {target === null ? (
              <span className="picker-trigger__placeholder">{t('bankInbox.row.targetPlaceholder')}</span>
            ) : (
              <>
                {parts.code !== '' && <span className="picker-trigger__code t-num">{parts.code}</span>}
                <span className="picker-trigger__name">{parts.name}</span>
              </>
            )}
            {isModelSuggestion(line, draft) && <AiTag />}
          </PickerButton>
        </td>
        <td className="bank-cell bank-cell--vat">{vatCell}</td>
        <td className="bank-cell bank-cell--amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={showCurrency} />
        </td>
        <td className="bank-cell bank-cell--actions">
          <span className="bank-row__actions">
            {action}
            <OverflowMenu quiet label={t('bankInbox.row.more', { party, amount: formatMoney(absAmount(line), line.currency) })} items={menu} />
          </span>
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
  after?: ReactNode;
}

export function DecidedRow({ line, selected, justCommitted = false, showCurrency, summary, undoLabel, canUndo, canAttach, onUndo, onAttach, onToggle, onDropFiles, accountName, after }: DecidedRowProps) {
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
          <span className="bank-party-line">
            <span className="bank-party">{party}</span>
            {detail !== '' && <span className="bank-detail">{detail}</span>}
            <AccountTag name={accountName} />
          </span>
          <ReceiptMark line={line} />
        </td>
        <td className="bank-cell bank-cell--summary" colSpan={2}>
          <span className="bank-state" data-state={line.state}>
            <span className="bank-state__word">{t(`bankInbox.state.${line.state}`)}</span>
            <span className="bank-state__summary">{summary}</span>
          </span>
        </td>
        <td className="bank-cell bank-cell--amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={showCurrency} />
        </td>
        <td className="bank-cell bank-cell--actions">
          <span className="bank-row__actions">
            <OverflowMenu quiet label={t('bankInbox.row.more', { party, amount: formatMoney(absAmount(line), line.currency) })} items={menu} />
          </span>
        </td>
      </tr>
      {after}
    </>
  );
}
