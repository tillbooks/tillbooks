/**
 * B2 "Eine Zeile Kontext" (the owner's pick of 01.10.2026): the ONE table row under the selected bank
 * line. At rest it is a single line where it fits, never a panel: how sure, why, what the VAT does, and
 * the rare actions as icon buttons with real tooltips. Buchen is NOT here: the row carries it, once.
 *
 * At rest, for an open line: the certainty glyph and word; the reason in one sentence (the model rung
 * says in words that a model on this device made it, its probability, its measured ECE and that nobody
 * has checked it, D144); the VAT split read off the engine's composition of the booking (`compose_entry`,
 * "davon MWST 6.74 auf 1170, netto 83.16"), which with the account and the code in the row is how the Buchungsvorschau
 * MUST-SURVIVE is met in B2 (the full Soll/Haben table lives in the split and link editors); what a
 * settlement does when it is not simply "paid in full"; the agent's pending Vorschlag with its decision;
 * a refusal as a sentence with its fix. A decided line names its decision, who and when, and offers the
 * undo and a Beleg.
 *
 * A person-opened editor (Aufteilen, Abgleichen, Ignorieren, Stornieren, the Belege) expands the strip
 * in place: it may be tall because the person asked for it. Only the resting strip keeps the one line.
 */
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Err } from '../../lib/client';
import { useT, formatDate, formatMoney } from '../../i18n';
import { useSeatNames } from '../../app/useSeatNames';
import { Tooltip } from '../../components/Tooltip';
import { LinkedFiles } from '../Files/LinkedFiles';
import type { BankInboxLine, DraftLeg, DraftTarget, IgnoreReason, LineVorschlag, RemainderMode, RowDraft } from './model';
import { absAmount, bookCapability, isCredit, isModelSuggestion, rowCertainty } from './model';
import { bankComposeRequest, captionKinds, isTaxedLeg, previewBalances, previewLinesOf, vatAccountIdsOf, vatSplitOf } from './bankCompose';
import { useBankCompose } from './useBankCompose';
import type { Lookups } from './lookups';
import { accountLabel, identityTail, plural, satzOf, stripReasonSentence, targetPhrase } from './lookups';
import { useBatch, useEntry } from './panelData';
import type { RefusalAction } from './errors';
import { RefusalNote } from './RefusalNote';
import { SplitEditor } from './SplitEditor';
import { LinkChooser } from './LinkChooser';
import { IgnoreForm } from './IgnoreForm';
import { ReopenForm } from './ReopenForm';
import { VorschlagOnLine } from './VorschlagOnLine';
import { CertaintyMark } from './InboxRow';
import { controlAccountsIn } from './ControlAccountWarning';
import { AgentGlyph, IgnoreGlyph, LinkGlyph, PaperclipGlyph, SplitGlyph } from './glyphs';

export type StripMode = 'details' | 'split' | 'link' | 'ignore' | 'reopen' | 'receipts';

export interface StripCaps {
  post: boolean;
  pay: boolean;
  decideVorschlag: boolean;
  /** May attach a Beleg to a bank line (`manage_files` and the line's own edit right). */
  attach: boolean;
}

export interface ContextStripProps {
  workspaceId: string;
  line: BankInboxLine;
  draft: RowDraft | undefined;
  lookups: Lookups;
  mode: StripMode;
  caps: StripCaps;
  whoamiActor: string | null;
  busy: boolean;
  refusal: Err | null;
  claimedEntryIds: ReadonlySet<string>;
  /** The table's column count: the strip spans all of them. */
  colSpan: number;
  onMode: (mode: StripMode) => void;
  onDraft: (target: DraftTarget | null, source: 'edited' | 'agent' | 'proposal') => void;
  onBook: (target: DraftTarget, opts?: { text?: string }) => void;
  onRefusalAction: (action: RefusalAction) => void;
  onIgnore: (reason: IgnoreReason, note: string) => void;
  onReopen: (reason: string) => void;
  onApprove: (v: LineVorschlag) => void;
  onReject: (v: LineVorschlag, reason: string) => void;
  /** "Agent fragen": the palette, prefilled with the line. */
  onAgent: () => void;
  /** "Beleg anhängen": the file picker, for this line. */
  onAttach: () => void;
  /** A Beleg was attached from the Belege editor; the host recounts the line's receipts. */
  onReceiptsChanged: () => void;
}

/** The figure without its currency ("6.74"), for a sentence that already names the money. */
function bare(minor: number, currency: string): string {
  return formatMoney(minor, currency).slice(currency.length + 1);
}

/** An icon-only tool of the strip: an accessible name, and the same words as a real tooltip. */
function Tool({ label, deniedReason, onClick, children }: { label: string; deniedReason?: string | null; onClick: () => void; children: ReactNode }) {
  const denied = deniedReason !== undefined && deniedReason !== null;
  return (
    <Tooltip content={denied ? deniedReason : label}>
      <button
        type="button"
        className="btn btn--ghost btn--icon btn--sm bank-strip__tool"
        aria-label={label}
        aria-disabled={denied ? true : undefined}
        onClick={() => {
          if (!denied) onClick();
        }}
      >
        {children}
      </button>
    </Tooltip>
  );
}

export function ContextStrip(props: ContextStripProps) {
  const { line, mode, colSpan } = props;
  const t = useT();
  const editor = mode !== 'details';
  return (
    <tr className="bank-strip" data-strip-for={line.bankTxnId} data-mode={mode}>
      <td colSpan={colSpan} className={`bank-strip__cell${editor ? ' bank-strip__cell--editor' : ''}`}>
        <div className="bank-strip__body" aria-label={t('bankInbox.strip.label')} role="group">
          {line.state === 'open' ? <OpenStrip {...props} /> : <DecidedStrip {...props} />}
        </div>
      </td>
    </tr>
  );
}

/** The Belege of a line, E00's own panel (list, downloads, attach), opened from the strip's count. */
function ReceiptsEditor({ workspaceId, line, onMode, onReceiptsChanged }: ContextStripProps) {
  const t = useT();
  return (
    <div className="bank-strip__editor">
      <LinkedFiles workspaceId={workspaceId} entityKind="bank_txn" entityId={line.bankTxnId} title={t('bankInbox.receipts.title')} attachLabel={t('bankInbox.receipts.attach')} onChanged={onReceiptsChanged} />
      <div className="bank-mode__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onMode('details')}>
          {t('bankInbox.panel.close')}
        </button>
      </div>
    </div>
  );
}

/** The paperclip with the count: opens the line's Belege (and their downloads). */
function ReceiptsCount({ line, onMode }: ContextStripProps) {
  const t = useT();
  if (line.receiptCount === 0) return null;
  return (
    <button type="button" className="btn btn--ghost btn--sm bank-strip__receipts" onClick={() => onMode('receipts')}>
      <PaperclipGlyph size={16} />
      {plural(t, 'bankInbox.strip.receipts', line.receiptCount)}
    </button>
  );
}

function OpenStrip(props: ContextStripProps) {
  const { workspaceId, line, draft, lookups, mode, caps, busy, refusal } = props;
  const t = useT();
  const target = draft?.target ?? null;

  if (mode === 'split') {
    return (
      <div className="bank-strip__editor">
        <SplitEditor workspaceId={workspaceId} line={line} lookups={lookups} initial={target} busy={busy} canPost={caps.post} onBook={(next, opts) => props.onBook(next, opts)} onCancel={() => props.onMode('details')} />
      </div>
    );
  }
  if (mode === 'link') {
    return (
      <div className="bank-strip__editor">
        <LinkChooser
          workspaceId={workspaceId}
          line={line}
          lookups={lookups}
          claimedEntryIds={props.claimedEntryIds}
          initial={target?.kind === 'existing_entry' ? target.entryId : null}
          busy={busy}
          canPost={caps.post}
          onMatch={(next) => props.onBook(next)}
          onCancel={() => props.onMode('details')}
        />
      </div>
    );
  }
  if (mode === 'ignore') {
    return (
      <div className="bank-strip__editor">
        <IgnoreForm
          line={line}
          lookups={lookups}
          busy={busy}
          canPost={caps.post}
          onIgnore={props.onIgnore}
          onBookInstead={(next) => {
            props.onDraft(next, 'edited');
            props.onMode('details');
          }}
          onCancel={() => props.onMode('details')}
        />
      </div>
    );
  }
  if (mode === 'receipts') return <ReceiptsEditor {...props} />;

  const certainty = rowCertainty(line, draft);
  const vorschlag = lookups.vorschlaege.get(line.bankTxnId)?.[0];
  const agentsBooking = vorschlag !== undefined && draft?.source === 'agent';
  // The model rung's disclosure travels with the suggestion as it stands; once the person changed the
  // target it is their booking, and the engine's reason no longer describes the row.
  const reason = isModelSuggestion(line, draft) || (certainty !== 'edited' && certainty !== 'agent') ? stripReasonSentence(t, lookups, line) : '';
  const needsPost = caps.post ? null : t('bankInbox.row.needsPost');
  const control = target?.kind === 'accounts' ? controlAccountsIn(lookups, target.legs) : [];

  return (
    <>
      <div className="bank-strip__line">
        <p className="bank-strip__text">
          {!agentsBooking && (
            <span className="bank-strip__cert">
              <CertaintyMark certainty={certainty} withWord />
            </span>
          )}
          {reason !== '' && <span className="bank-strip__reason">{reason}</span>}
          {target?.kind === 'accounts' && <AccountsSplit {...props} legs={target.legs} />}
          {target?.kind === 'open_item' && <OpenItemNote {...props} target={target} />}
          {target?.kind === 'payment_batch' && <BatchNote {...props} batchId={target.batchId} />}
          {target?.kind === 'existing_entry' && <EntryNote {...props} target={target} />}
          <IdentityTail line={line} />
        </p>
        <span className="bank-strip__tools">
          <ReceiptsCount {...props} />
          <Tool label={t('bankInbox.strip.split')} deniedReason={needsPost} onClick={() => props.onMode('split')}>
            <SplitGlyph size={16} />
          </Tool>
          <Tool label={t('bankInbox.strip.link')} deniedReason={needsPost} onClick={() => props.onMode('link')}>
            <LinkGlyph size={16} />
          </Tool>
          <Tool label={t('bankInbox.strip.agent')} onClick={props.onAgent}>
            <AgentGlyph size={16} />
          </Tool>
          {caps.attach && (
            <Tool label={t('bankInbox.receipts.attach')} onClick={props.onAttach}>
              <PaperclipGlyph size={16} />
            </Tool>
          )}
          <Tool label={t('bankInbox.strip.ignore')} deniedReason={needsPost} onClick={() => props.onMode('ignore')}>
            <IgnoreGlyph size={16} />
          </Tool>
        </span>
      </div>
      {vorschlag !== undefined && (
        <VorschlagOnLine
          line={line}
          vorschlag={vorschlag}
          lookups={lookups}
          canDecide={caps.decideVorschlag}
          isOwn={props.whoamiActor !== null && vorschlag.actor === props.whoamiActor}
          busy={busy}
          onApprove={() => props.onApprove(vorschlag)}
          onReject={(r) => props.onReject(vorschlag, r)}
        />
      )}
      {control.length > 0 && <p className="bank-mode__warn bank-strip__more">{t('bankInbox.warning.control_account_leg_before', { account: control.join(', ') })}</p>}
      {!agentsBooking && target !== null && !(bookCapability(target) === 'pay' ? caps.pay && caps.post : caps.post) && (
        <p className="bank-mode__note bank-strip__more">{t(bookCapability(target) === 'pay' ? 'bankInbox.row.needsPay' : 'bankInbox.row.needsPost')}</p>
      )}
      {refusal !== null && (
        <div className="bank-strip__more">
          <RefusalNote error={refusal} context={{ currency: line.currency, lineState: line.state }} onAction={props.onRefusalAction} />
        </div>
      )}
    </>
  );
}

/**
 * The line's reference and IBAN as a dim tail (critic F7), only where the row does not show them. A
 * long value is cut to keep the strip on one line; the whole of it is the part's tooltip.
 */
function IdentityTail({ line }: { line: BankInboxLine }) {
  const t = useT();
  const parts = identityTail(t, line);
  if (parts.length === 0) return null;
  return (
    <>
      {parts.map((p) => (
        <Tooltip key={p.label} content={p.full}>
          <span className="bank-strip__id" tabIndex={0}>
            {p.label}
          </span>
        </Tooltip>
      ))}
    </>
  );
}

/**
 * "· davon MWST 6.74 auf 1170, netto 83.16", read off the ENGINE's composition of the booking: the lines and
 * captions `compose_entry` answers for the drafted legs (`bankCompose.ts`), the lines `book_bank_line` posts.
 * Nothing shows while the answer for the legs on screen is in flight, and nothing for a person without
 * `read_books` and `read_vat` (no split rather than an error). A taxed leg on a foreign-currency line is
 * never asked about: `book_bank_line` refuses it, so the strip says that sentence instead (critic F1). A
 * read that fails says so in one neutral line (critic L1), never a figure.
 */
function AccountsSplit({ workspaceId, line, lookups, legs }: ContextStripProps & { legs: readonly DraftLeg[] }) {
  const t = useT();
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  // Only a taxed leg carries a split, so a booking without a code asks nothing.
  const request = legs.some(isTaxedLeg) ? bankComposeRequest(line, legs, bankLedger) : null;
  const state = useBankCompose(workspaceId, request, { currency: line.currency });
  if (state.status === 'foreign') return <span className="bank-strip__vat bank-strip__vat--warn">{t('bankInbox.error.vatForeignCurrency.title')}</span>;
  if (state.status === 'failed') {
    return state.error.error === 'permission_denied' ? null : <span className="bank-strip__vat">{t('bankInbox.legs.unavailable')}</span>;
  }
  if (state.status !== 'answered' || bankLedger === null) return null;
  const { answer } = state;
  // A code the engine could not price (unknown, archived, no VAT configuration): its refusal, in words.
  if (!answer.composed) return <span className="bank-strip__vat bank-strip__vat--warn">{t('bankInbox.strip.vatFailed')}</span>;
  const lines = previewLinesOf(answer);
  if (!previewBalances(lines)) return null;
  const split = vatSplitOf(lines, bankLedger, vatAccountIdsOf(answer));
  if (split === null) return null;
  const c = line.currency;
  const number = (id: string) => lookups.chartById.get(id)?.number ?? accountLabel(lookups, id);
  // Bezugsteuer is owed ON TOP of what the bank paid ("dazu"), never "davon". Einfuhrsteuer is neither:
  // the payment IS the tax (A06 `computeLineTax`: an assessed import amount is the tax itself), so the
  // strip says so (critic F4).
  const kinds = captionKinds(answer);
  const accounts = split.parts.map((p) => number(p.accountId)).join(', ');
  const text =
    kinds.length > 0 && kinds.every((k) => k === 'import')
      ? t('bankInbox.strip.vatImport', { account: accounts })
      : kinds.some((k) => k === 'reverse_charge')
        ? t('bankInbox.strip.vatOnTop', { parts: split.parts.map((p) => t('bankInbox.strip.vatPart', { tax: bare(p.amountMinor, c), account: number(p.accountId) })).join(', ') })
        : split.parts.length === 1 && split.parts[0] !== undefined
          ? split.netMinor === null
            ? t('bankInbox.strip.vatOnly', { tax: bare(split.parts[0].amountMinor, c), account: number(split.parts[0].accountId) })
            : t('bankInbox.strip.vatSplit', { tax: bare(split.parts[0].amountMinor, c), account: number(split.parts[0].accountId), net: bare(split.netMinor, c) })
          : split.netMinor === null
            ? t('bankInbox.strip.vatOnlyMany', { tax: bare(split.parts.reduce((s, p) => s + p.amountMinor, 0), c) })
            : t('bankInbox.strip.vatSplitMany', { tax: bare(split.parts.reduce((s, p) => s + p.amountMinor, 0), c), net: bare(split.netMinor, c) });
  return <span className="bank-strip__vat">{text}</span>;
}

/**
 * A settlement's consequence, said only when it is more than "paid in full" (the reason already says
 * the amount matches): a short payment, an overpayment, an amount the Studio could not read. A short
 * credit offers its remainder choice in place; the engine's refusal names it too.
 */
function OpenItemNote({
  line,
  lookups,
  target,
  onDraft,
}: ContextStripProps & { target: { kind: 'open_item'; documentId: string; remainder: RemainderMode | null } }) {
  const t = useT();
  const baseId = useId();
  const credit = isCredit(line);
  const params = (line.proposal?.reasonParams ?? {}) as Record<string, unknown>;
  const fromProposal = params.documentId === target.documentId;
  const invoice = credit ? lookups.invoiceById.get(target.documentId) : undefined;
  const bill = credit ? undefined : lookups.billById.get(target.documentId);
  const principal = invoice?.openMinor ?? bill?.openMinor ?? (fromProposal && typeof params.openMinor === 'number' ? params.openMinor : null);
  const fees = fromProposal && typeof params.dunningFeeMinor === 'number' ? params.dunningFeeMinor : 0;
  const open = principal === null ? null : principal + fees;
  const name = targetPhrase(t, lookups, line, target);
  const money = (m: number) => formatMoney(m, line.currency);
  const feesText = fees > 0 ? ` ${t('bankInbox.item.fees', { fees: money(fees) })}` : '';
  if (open === null) return <span className="bank-strip__note">{t('bankInbox.item.unknownOpen', { item: name })}</span>;
  const rest = open - absAmount(line);
  if (rest === 0) return feesText === '' ? null : <span className="bank-strip__note">{feesText.trim()}</span>;
  if (rest < 0) return <span className="bank-strip__note">{t(credit ? 'bankInbox.item.surplusCredit' : 'bankInbox.item.surplusDebit', { item: name, rest: money(-rest) })}{feesText}</span>;
  const remainder: RemainderMode = target.remainder === 'write_off' ? 'write_off' : 'leave_open';
  return (
    <span className="bank-strip__note">
      {remainder === 'write_off' ? t('bankInbox.item.shortWriteOff', { item: name, rest: money(rest) }) : t('bankInbox.item.shortOpen', { item: name, rest: money(rest) })}
      {feesText}
      {credit && (
        <span className="bank-strip__choices" role="radiogroup" aria-label={t('bankInbox.item.remainderLegend', { rest: money(rest) })}>
          <label className="bank-strip__choice">
            <input type="radio" name={`${baseId}-remainder`} checked={remainder === 'leave_open'} onChange={() => onDraft({ ...target, remainder: 'leave_open' }, 'edited')} />
            {t('bankInbox.item.leaveOpen')}
          </label>
          <label className="bank-strip__choice">
            <input type="radio" name={`${baseId}-remainder`} checked={remainder === 'write_off'} onChange={() => onDraft({ ...target, remainder: 'write_off' }, 'edited')} />
            {t('bankInbox.item.writeOff')}
          </label>
        </span>
      )}
    </span>
  );
}

function BatchNote({ workspaceId, line, batchId }: ContextStripProps & { batchId: string }) {
  const t = useT();
  const batch = useBatch(workspaceId, batchId);
  if (batch === null) return null;
  const date = batch.executionDate === null ? '' : formatDate(batch.executionDate);
  // The run's bills, named compactly (critic F8: B2 had dropped the old panel's vendor list): the
  // first two vendors and "+n", every bill with its amount in the tooltip.
  const vendor = (it: (typeof batch.items)[number]) => it.vendorName ?? t('bankInbox.target.billName');
  const names = batch.items.length <= 2 ? batch.items.map(vendor).join(', ') : `${batch.items.slice(0, 2).map(vendor).join(', ')}, ${t('bankInbox.strip.satzMore', { count: batch.items.length - 2 })}`;
  const all = batch.items.map((it) => `${vendor(it)} ${formatMoney(it.amountMinor, it.currency)}`).join(', ');
  return (
    <span className="bank-strip__note">
      {plural(t, batch.status === 'paid' ? 'bankInbox.batch.alreadyPaid' : 'bankInbox.batch.markPaid', batch.items.length, { date })}
      {batch.items.length > 0 && (
        <>
          {' '}
          <Tooltip content={all}>
            <span className="bank-strip__bills" tabIndex={0}>
              {plural(t, 'bankInbox.strip.batchBills', batch.items.length, { names })}
            </span>
          </Tooltip>
        </>
      )}
      {batch.totalMinor !== null && batch.totalMinor !== absAmount(line) && (
        <span className="bank-strip__warn">
          {' '}
          {t('bankInbox.batch.totalDiffers', { batch: formatMoney(batch.totalMinor, line.currency), line: formatMoney(absAmount(line), line.currency) })}
        </span>
      )}
    </span>
  );
}

/**
 * A match: which entry, and, when the amounts differ, by how much and why (an accepted difference states
 * its reason, critic A39-12). The reason field keeps its id so a refusal's "Mit Differenz abgleichen"
 * lands on it.
 */
function EntryNote({ workspaceId, line, lookups, target, onDraft }: ContextStripProps & { target: Extract<DraftTarget, { kind: 'existing_entry' }> }) {
  const t = useT();
  const { entry, loading } = useEntry(workspaceId, target.entryId);
  if (loading) return null;
  if (entry === null) return <span className="bank-strip__note">{t('bankInbox.compare.readFailed')}</span>;
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const bankLeg = entry.lines.find((l) => l.account === bankLedger);
  const signed = bankLeg === undefined ? null : bankLeg.debit - bankLeg.credit;
  const differs = signed !== null && signed !== line.amountMinor && Math.sign(signed) === Math.sign(line.amountMinor);
  const what = t('bankInbox.strip.entry', { date: formatDate(entry.entry.date), text: entry.entry.description ?? t('bankInbox.target.entry') });
  if (!differs || signed === null) return <span className="bank-strip__note">{what}</span>;
  const amount = formatMoney(Math.abs(line.amountMinor - signed), line.currency);
  return (
    <span className="bank-strip__note">
      {what} <span className="bank-strip__warn">{t('bankInbox.strip.entryDiffers', { amount })}</span>
      <label className="bank-strip__reason-field" htmlFor={`difference-reason-${line.bankTxnId}`}>
        <span className="visually-hidden">{t('bankInbox.compare.differenceReason', { amount })}</span>
        <input
          id={`difference-reason-${line.bankTxnId}`}
          type="text"
          className="field bank-strip__input"
          maxLength={500}
          value={target.differenceReason ?? ''}
          placeholder={t('bankInbox.compare.differenceReasonHint')}
          onChange={(e) => {
            const reason = e.target.value;
            onDraft(
              reason.trim() === ''
                ? { kind: 'existing_entry', entryId: target.entryId, acceptDifference: false }
                : { kind: 'existing_entry', entryId: target.entryId, acceptDifference: true, differenceReason: reason },
              'edited',
            );
          }}
        />
      </label>
    </span>
  );
}

function DecidedStrip(props: ContextStripProps) {
  const { workspaceId, line, lookups, mode, caps, busy, refusal } = props;
  const t = useT();
  const seatName = useSeatNames();
  const decision = line.decision;
  const { entry } = useEntry(workspaceId, decision?.entryId ?? null);

  if (mode === 'reopen') {
    return (
      <div className="bank-strip__editor">
        <ReopenForm line={line} busy={busy} canReopen={caps.post && (decision?.paymentId === null || caps.pay)} onReopen={props.onReopen} onCancel={() => props.onMode('details')} />
      </div>
    );
  }
  if (mode === 'receipts') return <ReceiptsEditor {...props} />;

  const vorschlag = lookups.vorschlaege.get(line.bankTxnId)?.[0];
  // A booking to accounts names its accounts once the entry is in: the lines that are neither the
  // bank's own ledger account nor a VAT account (the Vorsteuer or Umsatzsteuer leg follows the code).
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const vatIds = new Set(['1170', '1171', '2200'].map((n) => lookups.chartByNumber.get(n)?.id).filter((id): id is string => id !== undefined));
  const booked = entry === null ? [] : [...new Set(entry.lines.filter((l) => l.account !== bankLedger && !vatIds.has(l.account)).map((l) => l.account))];
  const summary =
    line.state === 'ignored'
      ? t('bankInbox.decided.ignored', { reason: t(`bankInbox.ignore.reason.${decision?.ignoreReason ?? 'other'}.label`) })
      : decision?.targetKind === 'existing_entry'
        ? t('bankInbox.decided.matched')
        : decision?.targetKind === 'open_item'
          ? t('bankInbox.decided.settled')
          : decision?.targetKind === 'payment_batch'
            ? t('bankInbox.decided.batch')
            : booked.length === 1
              ? t('bankInbox.decided.bookedTo', { account: accountLabel(lookups, booked[0] ?? '') })
              : booked.length > 1
                ? plural(t, 'bankInbox.decided.bookedSplit', booked.length)
                : t('bankInbox.decided.booked');
  const who = decision?.decidedBy ?? null;
  const when = decision?.decidedAt ?? null;
  const undoLabel = t(line.state === 'matched' ? 'bankInbox.decided.unmatch' : line.state === 'ignored' ? 'bankInbox.decided.unignore' : 'bankInbox.decided.reopen');
  const entryId = decision?.entryId ?? null;
  // The posted entry, as one Buchungssatz off its stored lines (critic F2): what "Gebucht" booked, on the
  // line itself. A booking to accounts says it all in the satz; a settlement, a match and a run keep
  // their word before it.
  const satz = entry !== null && entry.lines.length > 0 && line.state !== 'ignored' ? satzOf(t, lookups, entry.lines, line.currency) : null;
  const accountsBooking = decision?.targetKind !== 'existing_entry' && decision?.targetKind !== 'open_item' && decision?.targetKind !== 'payment_batch';

  return (
    <>
      <div className="bank-strip__line">
        <p className="bank-strip__text bank-strip__text--one">
          <span className="bank-state__word">{t(`bankInbox.state.${line.state}`)}</span>
          {!(satz !== null && accountsBooking) && <span className="bank-strip__reason">{summary}</span>}
          {satz !== null &&
            (satz.truncated ? (
              <Tooltip content={satz.full}>
                <span className="bank-strip__satz" tabIndex={0}>
                  {satz.short}
                </span>
              </Tooltip>
            ) : (
              <span className="bank-strip__satz">{satz.short}</span>
            ))}
          {decision?.note !== null && decision?.note !== undefined && (
            <Tooltip content={t('bankInbox.decided.note', { note: decision.note })}>
              <span className="bank-strip__note bank-strip__cut" tabIndex={0}>
                {t('bankInbox.decided.note', { note: decision.note })}
              </span>
            </Tooltip>
          )}
          {decision?.differenceMinor !== null && decision?.differenceMinor !== undefined && decision.differenceMinor !== 0 && (
            <span className="bank-strip__warn">{t('bankInbox.decided.difference', { amount: formatMoney(Math.abs(decision.differenceMinor), line.currency) })}</span>
          )}
          {entryId !== null && line.state !== 'ignored' && (
            <Link className="link-inline bank-strip__link" to={`/journal?entry=${encodeURIComponent(entryId)}`}>
              {t('bankInbox.strip.openEntry')}
            </Link>
          )}
          {who !== null && when !== null && (
            <Tooltip content={t('bankInbox.decided.by', { who: seatName(who).label, date: formatDate(when.slice(0, 10)) })}>
              <span className="bank-strip__note bank-strip__note--dim bank-strip__cut" tabIndex={0}>
                {t('bankInbox.decided.by', { who: seatName(who).label, date: formatDate(when.slice(0, 10)) })}
              </span>
            </Tooltip>
          )}
          <IdentityTail line={line} />
        </p>
        <span className="bank-strip__tools">
          <ReceiptsCount {...props} />
          {caps.attach && (
            <Tool label={t('bankInbox.receipts.attach')} onClick={props.onAttach}>
              <PaperclipGlyph size={16} />
            </Tool>
          )}
          <button type="button" className="btn btn--secondary btn--sm" disabled={busy || !caps.post} onClick={() => props.onMode('reopen')}>
            {undoLabel}
          </button>
        </span>
      </div>
      {vorschlag !== undefined && (
        <VorschlagOnLine
          line={line}
          vorschlag={vorschlag}
          lookups={lookups}
          canDecide={caps.decideVorschlag}
          isOwn={props.whoamiActor !== null && vorschlag.actor === props.whoamiActor}
          busy={busy}
          onApprove={() => props.onApprove(vorschlag)}
          onReject={(r) => props.onReject(vorschlag, r)}
        />
      )}
      {refusal !== null && (
        <div className="bank-strip__more">
          <RefusalNote error={refusal} context={{ currency: line.currency, lineState: line.state }} onAction={props.onRefusalAction} />
        </div>
      )}
    </>
  );
}
