/**
 * The selected line, in full, and the consequence of deciding it (the judge's outcome 4: the line and
 * the consequence before every commit). The panel sits beside the list on a wide screen and right
 * under the selected row on a narrower one; it is the same component in both places.
 *
 * Details, top to bottom: the line itself (date, counterparty, text, amount, IBAN, reference); the
 * agent's Vorschlag when there is one; the proposal's certainty and its reason in words, with who acts
 * next; what the target does (an open item's remainder: paid in full, still open, Verlust, Guthaben; a
 * payment run's bills; an existing entry compared with the bank, figure by figure); the Soll/Haben
 * lines that will post; the refusal of the last attempt with its one fix; and the commit with the
 * engine's consequence sentence under it.
 *
 * A decided line (Gebucht, Ignoriert) shows what was decided, by whom and when, what it posted, and
 * the one undo, which is always `reopen_bank_line` with a reason (Stornieren, Abgleich lösen, Wieder zu
 * buchen).
 */
import type { ReactNode } from 'react';

import type { Err } from '../../lib/client';
import { useT, formatDate, formatMoney } from '../../i18n';
import { useSeatNames } from '../../app/useSeatNames';
import type {
  BankInboxLine,
  DraftLeg,
  DraftTarget,
  IgnoreReason,
  LineVorschlag,
  PreviewLine,
  RemainderMode,
  RowDraft,
} from './model';
import {
  absAmount,
  bookCapability,
  composeAccountsPreview,
  daysBetween,
  formatIban,
  formatReference,
  isBookable,
  isCredit,
  lineDate,
  previewBalances,
  rowCertainty,
} from './model';
import type { Lookups } from './lookups';
import { accountLabel, detailOf, partyOf, plural, reasonSentence, targetPhrase } from './lookups';
import { useBatch, useEntry, useSettlement, useVatFigures } from './panelData';
import type { RefusalAction } from './errors';
import { RefusalNote } from './RefusalNote';
import { LegsPreview } from './LegsPreview';
import { SplitEditor } from './SplitEditor';
import { LinkChooser } from './LinkChooser';
import { IgnoreForm } from './IgnoreForm';
import { ReopenForm } from './ReopenForm';
import { VorschlagOnLine } from './VorschlagOnLine';
import { CertaintyMark, SignedAmount } from './InboxRow';
import { BackGlyph } from './glyphs';
import { ControlAccountWarning } from './ControlAccountWarning';

export type PanelMode = 'details' | 'split' | 'link' | 'ignore' | 'reopen';

export interface PanelCaps {
  post: boolean;
  pay: boolean;
  decideVorschlag: boolean;
}

export interface LinePanelProps {
  workspaceId: string;
  line: BankInboxLine;
  draft: RowDraft | undefined;
  lookups: Lookups;
  mode: PanelMode;
  caps: PanelCaps;
  whoamiActor: string | null;
  busy: boolean;
  refusal: Err | null;
  claimedEntryIds: ReadonlySet<string>;
  onMode: (mode: PanelMode) => void;
  onDraft: (target: DraftTarget | null, source: 'edited' | 'agent' | 'proposal') => void;
  onBook: (target: DraftTarget, opts?: { text?: string }) => void;
  onRefusalAction: (action: RefusalAction) => void;
  onIgnore: (reason: IgnoreReason, note: string) => void;
  onReopen: (reason: string) => void;
  onApprove: (v: LineVorschlag) => void;
  onReject: (v: LineVorschlag, reason: string) => void;
  onClose?: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="bank-panel__section" aria-label={title}>
      <h3 className="bank-section-title">{title}</h3>
      {children}
    </section>
  );
}

export function LinePanel(props: LinePanelProps) {
  const { line, mode, onMode } = props;
  const t = useT();
  const party = partyOf(t, line);
  const detail = detailOf(line);
  const date = lineDate(line);
  const account = props.lookups.bankById.get(line.bankAccountId);

  return (
    <div className="bank-panel__inner">
      <header className="bank-panel__head">
        <p className="bank-panel__date">
          {date === null ? '' : formatDate(date)}
          {account !== undefined && props.lookups.bankAccounts.length > 1 ? ` · ${account.name}` : ''}
        </p>
        <h2 className="bank-panel__party">{party}</h2>
        {detail !== '' && <p className="bank-panel__text">{detail}</p>}
        <p className="bank-panel__amount">
          <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency />
        </p>
        {(line.counterparty.iban !== null || line.remittance.referenceValue !== null) && (
          <dl className="bank-panel__facts">
            {line.counterparty.iban !== null && (
              <div>
                <dt>{t('bankInbox.panel.iban')}</dt>
                <dd className="t-num">{formatIban(line.counterparty.iban)}</dd>
              </div>
            )}
            {line.remittance.referenceValue !== null && (
              <div>
                <dt>{t('bankInbox.panel.reference')}</dt>
                <dd className="t-num">{formatReference(line.remittance.referenceKind, line.remittance.referenceValue)}</dd>
              </div>
            )}
          </dl>
        )}
      </header>
      {mode !== 'details' && (
        <button type="button" className="btn btn--ghost btn--sm bank-panel__back" onClick={() => onMode('details')}>
          <BackGlyph size={16} />
          {t(line.state === 'open' ? 'bankInbox.panel.backToProposal' : 'bankInbox.panel.backToLine')}
        </button>
      )}
      {line.state === 'open' ? <OpenBody {...props} /> : <DecidedBody {...props} />}
    </div>
  );
}

function OpenBody(props: LinePanelProps) {
  const { workspaceId, line, draft, lookups, mode, caps, busy, refusal } = props;
  const t = useT();
  const target = draft?.target ?? null;
  const certainty = rowCertainty(line, draft);
  const vorschlag = lookups.vorschlaege.get(line.bankTxnId)?.[0];
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const canBookTarget = target === null ? caps.post : bookCapability(target) === 'pay' ? caps.pay && caps.post : caps.post;

  if (mode === 'split') {
    return (
      <SplitEditor
        workspaceId={workspaceId}
        line={line}
        lookups={lookups}
        initial={target}
        busy={busy}
        canPost={caps.post}
        onBook={(next, opts) => props.onBook(next, opts)}
        onCancel={() => props.onMode('details')}
      />
    );
  }
  if (mode === 'link') {
    return (
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
    );
  }
  if (mode === 'ignore') {
    return (
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
    );
  }

  const reason = reasonSentence(t, lookups, line);
  // The agent's pending booking is on the row: its card above says what, why and who acts next, so
  // the status block would only repeat it (or, worse, say "Kein Vorschlag" under the agent's one).
  const agentsBooking = vorschlag !== undefined && draft?.source === 'agent';
  const showStatus = !agentsBooking && !(vorschlag !== undefined && certainty === 'open');
  const next =
    vorschlag !== undefined
      ? t('bankInbox.next.agent')
      : target === null
        ? t('bankInbox.next.pick')
        : target.kind === 'existing_entry'
          ? t('bankInbox.next.match')
          : t('bankInbox.next.book');

  return (
    <div className="bank-panel__body">
      <div className="bank-panel__col">
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
        {showStatus && (
          <section className="bank-panel__status" aria-label={t('bankInbox.panel.statusLabel')}>
            <p className="bank-panel__chip" data-certainty={certainty}>
              <CertaintyMark certainty={certainty} withWord />
            </p>
            <p className="bank-panel__reason">
              {certainty === 'agent' ? t('bankInbox.panel.agentReason') : certainty === 'edited' ? t('bankInbox.panel.editedReason') : reason}
            </p>
            <p className="bank-panel__next">{next}</p>
          </section>
        )}
        {target?.kind === 'open_item' && <OpenItemConsequence {...props} target={target} bankLedger={bankLedger} />}
        {target?.kind === 'payment_batch' && <BatchConsequence {...props} batchId={target.batchId} />}
        {target?.kind === 'existing_entry' && <EntryComparison {...props} target={target} entryId={target.entryId} />}
        {target?.kind === 'accounts' && bankLedger !== null && <AccountsPreview {...props} legs={target.legs} bankLedger={bankLedger} />}
        {target === null && <LegsPreview title={t('bankInbox.legs.title')} lines={null} currency={line.currency} lookups={lookups} note={t('bankInbox.legs.pickFirst')} />}
      </div>
      <div className="bank-panel__col">
        {refusal !== null && <RefusalNote error={refusal} context={{ currency: line.currency, lineState: line.state }} onAction={props.onRefusalAction} />}
        <div className="bank-panel__commit">
          {target?.kind === 'accounts' && <ControlAccountWarning lookups={lookups} legs={target.legs} />}
          <div className="bank-mode__actions">
            {!agentsBooking && (
              <button
                type="button"
                className="btn btn--secondary bank-touch bank-commit"
                disabled={busy || !isBookable(line, target) || !canBookTarget}
                onClick={() => target !== null && props.onBook(target)}
              >
                {busy
                  ? t('bankInbox.row.busy')
                  : target?.kind === 'existing_entry'
                    ? t(target.acceptDifference ? 'bankInbox.compare.matchWithDifference' : 'bankInbox.row.match')
                    : t('bankInbox.row.book')}
              </button>
            )}
            <button type="button" className="btn btn--secondary bank-touch" onClick={() => props.onMode('split')} disabled={!caps.post}>
              {t('bankInbox.panel.split')}
            </button>
          </div>
          {target?.kind === 'existing_entry' && (
            <button type="button" className="btn btn--ghost btn--sm bank-panel__alt" onClick={() => props.onMode('split')}>
              {t('bankInbox.panel.notSame')}
            </button>
          )}
          {!agentsBooking && target !== null && !canBookTarget && (
            <p className="bank-mode__note">{t(bookCapability(target) === 'pay' ? 'bankInbox.row.needsPay' : 'bankInbox.row.needsPost')}</p>
          )}
          {!agentsBooking && target !== null && canBookTarget && <p className="bank-mode__consequence">{t(`agent.consequence.${bookCapability(target)}`)}</p>}
        </div>
      </div>
    </div>
  );
}

function AccountsPreview({ workspaceId, line, lookups, legs, bankLedger }: LinePanelProps & { legs: readonly DraftLeg[]; bankLedger: string }) {
  const t = useT();
  const { figures, failed } = useVatFigures(workspaceId, line, legs, lookups);
  const composed: PreviewLine[] | null = composeAccountsPreview(line.amountMinor, legs, bankLedger, figures, {
    input: lookups.chartByNumber.get('1170')?.id ?? null,
    investment: lookups.chartByNumber.get('1171')?.id ?? null,
    output: lookups.chartByNumber.get('2200')?.id ?? null,
  });
  const lines = composed !== null && previewBalances(composed) ? composed : null;
  return (
    <LegsPreview
      title={t('bankInbox.legs.title')}
      lines={lines}
      currency={line.currency}
      lookups={lookups}
      note={failed ? t('bankInbox.legs.vatFailed') : t('bankInbox.legs.computing')}
    />
  );
}

function OpenItemConsequence({
  workspaceId,
  line,
  lookups,
  target,
  bankLedger,
  onDraft,
}: LinePanelProps & { target: { kind: 'open_item'; documentId: string; remainder: RemainderMode | null }; bankLedger: string | null }) {
  const t = useT();
  const credit = isCredit(line);
  const params = (line.proposal?.reasonParams ?? {}) as Record<string, unknown>;
  const fromProposal = params.documentId === target.documentId;
  const invoice = credit ? lookups.invoiceById.get(target.documentId) : undefined;
  const bill = credit ? undefined : lookups.billById.get(target.documentId);
  const principal = invoice?.openMinor ?? bill?.openMinor ?? (fromProposal && typeof params.openMinor === 'number' ? params.openMinor : null);
  const fees = fromProposal && typeof params.dunningFeeMinor === 'number' ? params.dunningFeeMinor : 0;
  const open = principal === null ? null : principal + fees;
  const { preview } = useSettlement(workspaceId, line, bankLedger, target.documentId, open);
  const abs = absAmount(line);
  const name = targetPhrase(t, lookups, line, target);
  const money = (m: number) => formatMoney(m, line.currency);

  let consequence: ReactNode = null;
  if (open !== null) {
    const rest = open - abs;
    if (rest === 0) consequence = <p className="bank-panel__consequence">{t('bankInbox.item.paidInFull', { item: name })}</p>;
    else if (rest > 0) {
      const mode: RemainderMode = target.remainder === 'write_off' ? 'write_off' : 'leave_open';
      consequence = (
        <>
          <p className="bank-panel__consequence">
            {mode === 'write_off' ? t('bankInbox.item.shortWriteOff', { item: name, rest: money(rest) }) : t('bankInbox.item.shortOpen', { item: name, rest: money(rest) })}
          </p>
          {credit && (
            <fieldset className="bank-fieldset bank-remainder">
              <legend className="bank-field__label">{t('bankInbox.item.remainderLegend', { rest: money(rest) })}</legend>
              <div className="bank-inline-choices">
                <label className="bank-choice bank-choice--inline" data-checked={mode === 'leave_open' ? 'true' : 'false'}>
                  <input type="radio" name={`remainder-${line.bankTxnId}`} checked={mode === 'leave_open'} onChange={() => onDraft({ ...target, remainder: 'leave_open' }, 'edited')} />
                  <span>{t('bankInbox.item.leaveOpen')}</span>
                </label>
                <label className="bank-choice bank-choice--inline" data-checked={mode === 'write_off' ? 'true' : 'false'}>
                  <input type="radio" name={`remainder-${line.bankTxnId}`} checked={mode === 'write_off'} onChange={() => onDraft({ ...target, remainder: 'write_off' }, 'edited')} />
                  <span>{t('bankInbox.item.writeOff')}</span>
                </label>
              </div>
            </fieldset>
          )}
        </>
      );
    } else consequence = <p className="bank-panel__consequence">{t(credit ? 'bankInbox.item.surplusCredit' : 'bankInbox.item.surplusDebit', { item: name, rest: money(-rest) })}</p>;
  }

  const legs: PreviewLine[] | null =
    preview === null ? null : preview.legs.map((l) => ({ accountId: l.accountId, debit: l.debitMinor, credit: l.creditMinor }));

  return (
    <>
      <Section title={t(credit ? 'bankInbox.item.titleInvoice' : 'bankInbox.item.titleBill')}>
        {consequence ?? <p className="bank-panel__consequence">{t('bankInbox.item.unknownOpen', { item: name })}</p>}
        {fees > 0 && <p className="bank-mode__note">{t('bankInbox.item.fees', { fees: money(fees) })}</p>}
      </Section>
      <LegsPreview title={t('bankInbox.legs.title')} lines={legs} currency={line.currency} lookups={lookups} note={t('bankInbox.legs.computing')} />
    </>
  );
}

function BatchConsequence({ workspaceId, line, batchId }: LinePanelProps & { batchId: string }) {
  const t = useT();
  const batch = useBatch(workspaceId, batchId);
  return (
    <Section title={t('bankInbox.batch.title')}>
      {batch === null ? (
        <p className="bank-mode__note" role="status">
          {t('bankInbox.batch.loading')}
        </p>
      ) : (
        <>
          <p className="bank-panel__consequence">
            {plural(t, batch.status === 'paid' ? 'bankInbox.batch.alreadyPaid' : 'bankInbox.batch.markPaid', batch.items.length, {
              date: batch.executionDate === null ? '' : formatDate(batch.executionDate),
            })}
          </p>
          <ul className="bank-batch">
            {batch.items.map((it, i) => (
              <li key={i} className="bank-batch__item">
                <span>{it.vendorName ?? t('bankInbox.target.billName')}</span>
                <span className="t-num">{formatMoney(it.amountMinor, it.currency)}</span>
              </li>
            ))}
          </ul>
          {batch.totalMinor !== null && batch.totalMinor !== absAmount(line) && (
            <p className="bank-mode__warn">{t('bankInbox.batch.totalDiffers', { batch: formatMoney(batch.totalMinor, line.currency), line: formatMoney(absAmount(line), line.currency) })}</p>
          )}
        </>
      )}
    </Section>
  );
}

function EntryComparison({
  workspaceId,
  line,
  lookups,
  entryId,
  target,
  onDraft,
}: LinePanelProps & { entryId: string; target: Extract<DraftTarget, { kind: 'existing_entry' }> }) {
  const t = useT();
  const { entry, loading } = useEntry(workspaceId, entryId);
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  if (loading || entry === null) {
    return (
      <Section title={t('bankInbox.compare.title')}>
        <p className="bank-mode__note" role={loading ? 'status' : undefined}>
          {loading ? t('bankInbox.compare.loading') : t('bankInbox.compare.readFailed')}
        </p>
      </Section>
    );
  }
  const bankLeg = entry.lines.find((l) => l.account === bankLedger);
  const entrySigned = bankLeg === undefined ? null : bankLeg.debit - bankLeg.credit;
  const lineDay = lineDate(line) ?? entry.entry.date;
  const days = daysBetween(entry.entry.date, lineDay);
  const rows: { label: string; bank: ReactNode; books: ReactNode; verdict: string; tone: 'ok' | 'warn' | 'dim'; kind: 'figure' | 'text' }[] = [
    {
      label: t('bankInbox.compare.amount'),
      bank: <SignedAmount minor={line.amountMinor} currency={line.currency} showCurrency={false} />,
      books: entrySigned === null ? t('bankInbox.compare.none') : <SignedAmount minor={entrySigned} currency={line.currency} showCurrency={false} />,
      verdict: entrySigned === line.amountMinor ? t('bankInbox.compare.same') : t('bankInbox.compare.differs'),
      tone: entrySigned === line.amountMinor ? 'ok' : 'warn',
      kind: 'figure',
    },
    {
      label: t('bankInbox.compare.date'),
      bank: formatDate(lineDay),
      books: formatDate(entry.entry.date),
      verdict: days === 0 ? t('bankInbox.compare.same') : plural(t, 'bankInbox.compare.days', days, { days }),
      tone: days === 0 ? 'ok' : 'dim',
      kind: 'figure',
    },
    {
      label: t('bankInbox.compare.text'),
      bank: partyOf(t, line),
      books: entry.entry.description ?? t('bankInbox.compare.none'),
      verdict: '',
      tone: 'dim',
      kind: 'text',
    },
  ];
  const legs: PreviewLine[] = entry.lines.map((l) => ({ accountId: l.account, debit: l.debit, credit: l.credit }));
  return (
    <>
      <Section title={t('bankInbox.compare.title')}>
        <table className="bank-compare">
          <caption className="visually-hidden">{t('bankInbox.compare.title')}</caption>
          <thead>
            <tr>
              <td />
              <th scope="col">{t('bankInbox.compare.bank')}</th>
              <th scope="col">{t('bankInbox.compare.books')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} data-kind={r.kind}>
                <th scope="row">{r.label}</th>
                <td className={r.kind === 'figure' ? 't-num' : undefined}>{r.bank}</td>
                <td className={r.kind === 'figure' ? 't-num' : undefined}>
                  {r.books}
                  {r.verdict !== '' && (
                    <span className="bank-compare__verdict" data-tone={r.tone}>
                      {r.verdict}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entrySigned !== null && entrySigned !== line.amountMinor && Math.sign(entrySigned) === Math.sign(line.amountMinor) && (
          // The amounts differ: matching anyway records the difference, and the engine wants to know why.
          <label className="bank-field" htmlFor={`difference-reason-${line.bankTxnId}`}>
            <span className="bank-field__label">
              {t('bankInbox.compare.differenceReason', { amount: formatMoney(Math.abs(line.amountMinor - entrySigned), line.currency) })}
            </span>
            <textarea
              id={`difference-reason-${line.bankTxnId}`}
              className="field bank-textarea"
              rows={2}
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
        )}
      </Section>
      <LegsPreview
        title={t('bankInbox.compare.entryTitle')}
        subtitle={t('bankInbox.compare.entryUnchanged', { date: formatDate(entry.entry.date) })}
        lines={legs}
        currency={line.currency}
        lookups={lookups}
      />
    </>
  );
}

function DecidedBody(props: LinePanelProps) {
  const { workspaceId, line, lookups, mode, caps, busy, refusal } = props;
  const t = useT();
  const seatName = useSeatNames();
  const decision = line.decision;
  const { entry } = useEntry(workspaceId, decision?.entryId ?? null);

  if (mode === 'reopen') {
    return <ReopenForm line={line} busy={busy} canReopen={caps.post && (decision?.paymentId === null || caps.pay)} onReopen={props.onReopen} onCancel={() => props.onMode('details')} />;
  }

  const who = decision?.decidedBy ?? null;
  const when = decision?.decidedAt ?? null;
  // An agent's pending Vorschlag on a DECIDED line (a drafted reopen_bank_line) shows here too, with its
  // decision (critic L7 lean): only its approval carries it out.
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
  const legs: PreviewLine[] | null = entry === null ? null : entry.lines.map((l) => ({ accountId: l.account, debit: l.debit, credit: l.credit }));

  return (
    <div className="bank-panel__body">
      <div className="bank-panel__col">
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
        <section className="bank-panel__status" aria-label={t('bankInbox.panel.statusLabel')}>
          <p className="bank-panel__chip" data-state={line.state}>
            <span className="bank-state__word">{t(`bankInbox.state.${line.state}`)}</span>
          </p>
          <p className="bank-panel__reason">{summary}</p>
          {decision?.note !== null && decision?.note !== undefined && <p className="bank-panel__reason">{t('bankInbox.decided.note', { note: decision.note })}</p>}
          {decision?.differenceMinor !== null && decision?.differenceMinor !== undefined && decision.differenceMinor !== 0 && (
            <p className="bank-mode__warn">{t('bankInbox.decided.difference', { amount: formatMoney(Math.abs(decision.differenceMinor), line.currency) })}</p>
          )}
          {who !== null && when !== null && (
            <p className="bank-panel__provenance">{t('bankInbox.decided.by', { who: seatName(who).label, date: formatDate(when.slice(0, 10)) })}</p>
          )}
        </section>
        {line.state !== 'ignored' && (
          <LegsPreview
            title={t('bankInbox.decided.postedTitle')}
            lines={legs}
            currency={line.currency}
            lookups={lookups}
            note={decision?.entryId === null || decision === null ? t('bankInbox.decided.noEntry') : t('bankInbox.legs.computing')}
          />
        )}
      </div>
      <div className="bank-panel__col">
        {refusal !== null && <RefusalNote error={refusal} context={{ currency: line.currency, lineState: line.state }} onAction={props.onRefusalAction} />}
        <div className="bank-panel__commit">
          <div className="bank-mode__actions">
            <button type="button" className="btn btn--secondary bank-touch bank-commit" disabled={busy || !caps.post} onClick={() => props.onMode('reopen')}>
              {t(line.state === 'matched' ? 'bankInbox.decided.unmatch' : line.state === 'ignored' ? 'bankInbox.decided.unignore' : 'bankInbox.decided.reopen')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
