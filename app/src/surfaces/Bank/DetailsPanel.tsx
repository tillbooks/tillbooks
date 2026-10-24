/**
 * D177 (A39 §16.2): the selected bank line's Details, in a side panel beside the table (the owner's pick
 * on the "TILL Bankzeilen" prototype over "under the row"). It replaces B2's context strip. Since D178 N2
 * (A39 §18) it is the BOOKING VIEW inside the detail area's slots: the shell (`DetailArea.tsx`) owns the
 * header, the one scroll container with the facts card on top, and the pinned footer this view's actions
 * go into (`DetailSlots`).
 *
 * NO PROSE AT REST (D177 point 4). The panel holds values, fields and one-line facts; every explanation
 * is a tooltip of a few words. In order, for an open line:
 *
 *   1. (the title, the counterparty and the amount, is the shell's facts card since D178 N2);
 *   2. the amounts a Buchungsregel needs: an ASKED amount is an empty labelled field, a COMPUTED one is
 *      prefilled with the engine's figure and marked "berechnet" (its formula on hover); once edited it
 *      reads "von dir" with "berechnen" to take the engine's figure back;
 *   3. the Buchungstext, a labelled field prefilled with the engine's own default and sent only when the
 *      person changed it (owner amendment a);
 *   4. "So wird gebucht": the Soll/Haben lines `compose_entry` answers for the very target Buchen sends;
 *      while an asked amount is empty, the rule's accounts with "?";
 *   5. Woher, ONE line (owner amendment c): the source glyph and the rule's name as a quiet button that
 *      opens the rule in the rules sheet (its match and route are the name's tooltip), a small switcher
 *      for the payer's other rules and "Anders buchen"; for history, the agent or a reference the same
 *      one line, linked where there is something to open;
 *   6. the case controls: a short payment (Offen lassen, Als Verlust ausbuchen), an overpayment (Als
 *      Guthaben), a match's difference reason, a payment run's bills, the private 2261/2850 offer;
 *   7. ("Bankzeile", the line's own facts, is the shell's facts card since D178 N2);
 *   8. in the footer slot, the actions as icon buttons (owner amendment b): Aufteilen, Abgleichen, Als Regel speichern,
 *      Anhängen; and Buchen, the one labelled commit, which says why when it cannot book.
 *
 * A decided line shows its decision, its Buchungssatz, who and when, the undo, and the same facts.
 * A person-opened editor (Abgleichen, Nicht buchen, Stornieren, the Belege, the rule form) takes the
 * panel's body while it is open.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { TaxCodeCombobox } from '../../components/TaxCodeCombobox';
import { Link } from 'react-router-dom';

import type { Err } from '../../lib/client';
import { useT, useI18n, formatDate, formatMoney } from '../../i18n';
import { usePref } from '../../lib/prefs';
import { useSeatNames } from '../../app/useSeatNames';
import { Tooltip } from '../../components/Tooltip';
import { IconButton } from '../../components/IconButton';
import { OverflowMenu } from '../../components/OverflowMenu';
import { LinkedFiles } from '../Files/LinkedFiles';
import { MatchGlyph } from '../../components/icons';
import type { BankInboxLine, DraftTarget, IgnoreReason, LineVorschlag, RemainderMode, RowDraft } from './model';
import {
  absAmount,
  askMinor,
  bookTargetOf,
  composeVerdictError,
  isComputedAsIs,
  isCredit,
  lineDate,
  lineRuleIds,
  lineVorschlag,
  minorToField,
  prefillSource,
  proposalRuleId,
  draftTargetOf,
  severalRuleIds,
} from './model';
import { bankComposeRequest, previewBalances, previewLinesOf } from './bankCompose';
import { useBankCompose, useTargetCompose } from './useBankCompose';
import { LegsPreview, type PreviewRow } from './LegsPreview';
import { explainRefusal } from './errors';
import type { Lookups } from './lookups';
import { accountLabel, modelStripSentence, partyOf, plural, reasonSentence, satzOf, vatPickerShows } from './lookups';
import { useBatch, useEntry } from './panelData';
import type { RefusalAction } from './errors';
import { RefusalNote } from './RefusalNote';
import { RuleEditor, type RulePayload } from './RuleEditor';
import { LinkChooser } from './LinkChooser';
import { IgnoreForm } from './IgnoreForm';
import { ReopenForm } from './ReopenForm';
import { VorschlagOnLine } from './VorschlagOnLine';
import { MenuButton } from './MenuButton';
import { controlAccountsIn } from './ControlAccountWarning';
import { AgentGlyph, CheckGlyph, LearnedGlyph, StandardGlyph, SureGlyph } from './glyphs';
import { distinctiveToken, howWords, matchInWords, restZeroReason, routeInWords, ruleName, vorlagenOf } from './rules';
import type { BookState } from './rowState';
import { BOOKING_TEXT_MAX, takesBookingText, zeroRestOf } from './rowState';
import { DetailSlots } from './DetailArea';
import {
  AccountField,
  BookingLines,
  FeeSplitOffer,
  FocusBar,
  FootFigures,
  FxLegControl,
  KontaktPane,
  ModeSwitch,
  SmartField,
  SpesenPane,
  ZuordnenPane,
  figuresOf,
  needsBookingPreview,
  paneOf,
  panesFor,
  previewBookState,
  useBookingPreview,
  useFxMode,
  type BookingPane,
  type BookingView,
  type Figures,
  type FocusNav,
} from './BookingModes';

export type PanelMode = 'details' | 'link' | 'ignore' | 'reopen' | 'receipts' | 'rule';

export interface PanelCaps {
  post: boolean;
  pay: boolean;
  decideVorschlag: boolean;
  /** May attach a Beleg to a bank line (`manage_files` and the line's own edit right). */
  attach: boolean;
}

export interface DetailsPanelProps {
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
  /** The Buchungstext as it stands (prefilled with the engine's default). */
  text: string;
  /** Buchen's state, shared with the row: enabled, or disabled with its reason. */
  bookState: BookState;
  /** The C4 consequence sentence Buchen carries when it can book. */
  consequence: string | null;
  /** A split is under way in the position rows under the row (the panel offers no second Aufteilen). */
  splitting: boolean;
  /** The reason the ignore editor opens with ("Anderer Grund" from the row's ×). */
  ignorePreset?: IgnoreReason;
  onText: (text: string) => void;
  onMode: (mode: PanelMode) => void;
  onDraft: (target: DraftTarget | null, source: 'edited' | 'agent' | 'proposal') => void;
  /** An asked or computed amount, as typed (kept verbatim); null hands a computed leg back to the engine. */
  onAsk: (legIndex: number, value: string | null) => void;
  /** D177 (UX judge): the MWST of a one-account booking, in the panel while the table hides its column. */
  onVat: (code: string) => void;
  /** Buchen: the host books the row's target (or approves the agent's Vorschlag, D167). */
  onBook: () => void;
  /** A target an editor chose (the link chooser), booked at once. */
  onBookTarget: (target: DraftTarget) => void;
  /** Aufteilen: the position rows open under the row. */
  onSplit: () => void;
  /** ☆ on a one-account booking: saves it as the counterparty's rule at once. */
  onSetStandard: () => void;
  onSaveRule: (payload: RulePayload) => Promise<Err | null>;
  /** The rule's name: the rules sheet opens on that rule. */
  onOpenRule: (standardId: string) => void;
  /** Another rule of the payer, picked from the switcher. */
  onPickRule: (standardId: string) => void;
  /** "Anders buchen": the whole "Worauf buchen?" list. */
  onOther: () => void;
  onRefusalAction: (action: RefusalAction) => void;
  onIgnore: (reason: IgnoreReason, note: string) => void;
  onReopen: (reason: string) => void;
  onApprove: (v: LineVorschlag) => void;
  onReject: (v: LineVorschlag, reason: string) => void;
  onAgent: () => void;
  onAttach: () => void;
  onReceiptsChanged: () => void;
  /** D178 point 9: the focus view's stepper and "Liste ausblenden" (absent in the other views). */
  focus?: FocusNav;
}

/** The figure without its currency ("6.74"). */
function bare(minor: number, currency: string): string {
  return formatMoney(minor, currency).slice(currency.length + 1);
}

/**
 * The selected line's booking, inside the detail area's slots (A39 §18.6): every mode renders ONE
 * `DetailSlots`, its body under the shell's facts card and its actions in the pinned footer. The title (the
 * counterparty and the amount) and the line's facts are the shell's facts card since D178 N2.
 */
export function DetailsPanel(props: DetailsPanelProps) {
  const { line } = props;
  return (
    <div className="bank-panel__body" data-panel-for={line.bankTxnId} data-mode={props.mode}>
      {props.focus !== undefined && <FocusBar nav={props.focus} />}
      {/* Keyed on the line: the mode in view, the dismissed fee offer and the typed amounts are one line's. */}
      {line.state === 'open' ? <OpenPanel key={line.bankTxnId} {...props} /> : <DecidedPanel {...props} />}
    </div>
  );
}

function ReceiptsEditor({ workspaceId, line, onMode, onReceiptsChanged }: DetailsPanelProps) {
  const t = useT();
  return (
    <DetailSlots>
    <div className="bank-panel__editor">
      <LinkedFiles workspaceId={workspaceId} entityKind="bank_txn" entityId={line.bankTxnId} title={t('bankInbox.receipts.title')} attachLabel={t('bankInbox.receipts.attach')} onChanged={onReceiptsChanged} />
      <div className="bank-mode__actions">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => onMode('details')}>
          {t('bankInbox.panel.close')}
        </button>
      </div>
    </div>
    </DetailSlots>
  );
}

function OpenPanel(props: DetailsPanelProps) {
  const { workspaceId, line, draft, lookups, mode, caps, busy } = props;
  const t = useT();
  const target = draft?.target ?? null;
  // The ENGINE's composition of a rule or a via route, read once for the preview, the fields and Buchen:
  // a rest of zero is its refusal, said at the field and on Buchen's tooltip (A39 §16.3 story 3).
  const viaOrRule = target?.kind === 'rule' || (target?.kind === 'accounts' && (target.viaAccountId ?? '') !== '');
  const missing = target?.kind === 'rule' ? target.asks.filter((a) => !isComputedAsIs(a) && askMinor(a) === null) : [];
  const targetCompose = useTargetCompose(workspaceId, line.bankTxnId, viaOrRule && target !== null && missing.length === 0 ? bookTargetOf(target) : null, { debounceMs: 250 });
  const verdict = targetCompose.status === 'answered' ? composeVerdictError(targetCompose.answer) : null;
  const restZero = verdict?.error === 'rest_is_zero';
  const bookState: BookState = restZero && target?.kind === 'rule' ? { enabled: false, reason: restZeroReason(t, lookups, target) } : props.bookState;
  const withState = { ...props, bookState };

  if (mode === 'link') {
    return (
      <DetailSlots>
        <div className="bank-panel__editor">
        <LinkChooser
          workspaceId={workspaceId}
          line={line}
          lookups={lookups}
          claimedEntryIds={props.claimedEntryIds}
          initial={target?.kind === 'existing_entry' ? target.entryId : null}
          busy={busy}
          canPost={caps.post}
          onMatch={(next) => props.onBookTarget(next)}
          onCancel={() => props.onMode('details')}
        />
        </div>
      </DetailSlots>
    );
  }
  if (mode === 'ignore') {
    return (
      <DetailSlots>
        <div className="bank-panel__editor">
        <IgnoreForm
          line={line}
          lookups={lookups}
          busy={busy}
          canPost={caps.post}
          {...(props.ignorePreset !== undefined ? { initialReason: props.ignorePreset } : {})}
          onIgnore={props.onIgnore}
          onBookInstead={(next) => {
            props.onDraft(next, 'edited');
            props.onMode('details');
          }}
          onCancel={() => props.onMode('details')}
        />
        </div>
      </DetailSlots>
    );
  }
  if (mode === 'receipts') return <ReceiptsEditor {...props} />;
  if (mode === 'rule' && target?.kind === 'accounts') {
    return (
      <DetailSlots>
        <div className="bank-panel__editor">
        <RuleEditor
          mode="create"
          party={partyOf(t, line)}
          direction={isCredit(line) ? 'in' : 'out'}
          currency={line.currency}
          initialName={line.counterparty.name ?? partyOf(t, line)}
          initialText={distinctiveToken(line)}
          legs={target.legs.map((l) => ({ accountId: l.accountId, taxCode: l.taxCode, against: l.amountMinor < 0 }))}
          initialRest={target.legs.length === 1 ? 0 : null}
          viaAccountId={target.viaAccountId ?? null}
          lookups={lookups}
          lineAmountMinor={line.amountMinor}
          vorlagen={vorlagenOf(lookups)}
          onSave={async (payload) => {
            const refused = await props.onSaveRule(payload);
            if (refused === null) props.onMode('details');
            return refused;
          }}
          onCancel={() => props.onMode('details')}
        />
        </div>
      </DetailSlots>
    );
  }

  return <BookingBody {...withState} target={target} restZero={restZero} targetCompose={targetCompose} />;
}

/**
 * D178 point 9 (A39 §20): the booking of an open line in the person's view (`bank.booking_view`): the mode
 * switch (focus, tabs) or the one smart field, the pane of the mode in view, the engine's preview, and the
 * footer with Betrag / verteilt / Abweichung and Buchen. Focus docks the facts beside the booking at the
 * bottom (`layout: beside`); the panes are the same components in every view.
 */
function BookingBody(props: DetailsPanelProps & { target: DraftTarget | null; restZero: boolean; targetCompose: ReturnType<typeof useTargetCompose> }) {
  const { workspaceId, line, lookups, caps, busy, refusal, target, restZero, targetCompose } = props;
  const t = useT();
  const { locale } = useI18n();
  const [viewPref] = usePref<string>('bank.booking_view');
  const view: BookingView = viewPref === 'tabs' || viewPref === 'smart' ? viewPref : 'focus';
  const fxMode = useFxMode(workspaceId);
  const offered = panesFor(line);
  const [pane, setPane] = useState<BookingPane>(() => paneOf(target) ?? 'konto');
  // Each mode keeps what the person chose in it while they look at another (switching never loses a draft).
  const stash = useRef<Partial<Record<BookingPane, { target: DraftTarget | null; source: 'edited' | 'agent' | 'proposal' }>>>({});
  const kind = paneOf(target);
  useEffect(() => {
    // A target chosen elsewhere (the row's picker, a Vorschlag) brings its own mode into view.
    if (kind !== null && kind !== pane) setPane(kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  const switchTo = (next: BookingPane) => {
    if (next === pane) return;
    stash.current[pane] = { target, source: props.draft?.source ?? 'edited' };
    setPane(next);
    const back = stash.current[next];
    props.onDraft(back?.target ?? null, back?.source ?? 'edited');
  };
  const setTarget = (next: DraftTarget | null) => props.onDraft(next, 'edited');
  const shown: BookingPane = view === 'smart' ? (kind ?? 'konto') : offered.includes(pane) ? pane : 'konto';

  const preview = useBookingPreview(workspaceId, line, target);
  const bookState = needsBookingPreview(target) ? previewBookState(t, locale, line, preview, props.bookState) : props.bookState;
  const figures = figuresOf(line, target, preview.booking);
  const withState = { ...props, bookState };

  const vorschlag = lineVorschlag(line, lookups.vorschlaege);
  const control = target?.kind === 'accounts' ? controlAccountsIn(lookups, target.legs) : [];
  // A proposal that offers nothing to book says its way out in words (a run that differs, a transfer
  // booked in another month): that sentence is the next step, not an explanation.
  const code: string = line.proposal?.reasonCode ?? '';
  const blocked = target === null && line.proposal !== null && line.proposal.target === null && code !== 'no_proposal' && code !== 'several_rules';

  const konto = (
    <>
      {(target === null || (target.kind === 'accounts' && target.legs.length === 1 && (target.viaAccountId ?? '') === '')) && view !== 'smart' && (
        <AccountField line={line} lookups={lookups} target={target} busy={busy || !caps.post} onTarget={setTarget} />
      )}
      {target?.kind === 'rule' && target.asks.length > 0 && <Amounts {...props} target={target} restZero={restZero} />}
      {takesBookingText(target) && <BookingText {...props} />}
      {target?.kind === 'accounts' && <VatField {...props} target={target} />}
      {(fxMode === 'propose_split' || fxMode === 'prefill_split') && <FeeSplitOffer line={line} lookups={lookups} target={target} busy={busy} onTarget={setTarget} />}
      {fxMode === 'transaction_currency' && <FxLegControl line={line} target={target} booking={preview.booking} busy={busy} onTarget={setTarget} />}
      {target?.kind === 'accounts' && needsBookingPreview(target) ? (
        <BookingLines preview={preview} line={line} lookups={lookups} />
      ) : (
        (target?.kind === 'accounts' || target?.kind === 'rule') && <Preview {...props} target={target} targetCompose={targetCompose} />
      )}
    </>
  );
  const paneBody =
    shown === 'konto' ? (
      konto
    ) : shown === 'zuordnen' ? (
      <ZuordnenPane
        line={line}
        lookups={lookups}
        target={target}
        booking={preview.booking}
        busy={busy}
        canPost={caps.post && caps.pay}
        onTarget={setTarget}
        onLink={() => props.onMode('link')}
        caseControls={<CaseControls {...props} target={target} />}
      />
    ) : shown === 'kontakt' ? (
      <KontaktPane workspaceId={workspaceId} line={line} target={target} booking={preview.booking} busy={busy} canPost={caps.post && caps.pay} onTarget={setTarget} withPicker={view !== 'smart'} />
    ) : (
      <SpesenPane workspaceId={workspaceId} line={line} target={target} busy={busy} canPost={caps.post && caps.pay} onTarget={setTarget} />
    );
  const previewed = shown !== 'konto' && needsBookingPreview(target) ? <BookingLines preview={preview} line={line} lookups={lookups} /> : null;

  return (
    <DetailSlots layout={view === 'focus' ? 'beside' : 'stack'} footer={<Actions {...withState} target={target} figures={figures} whyAtField={restZero && target?.kind === 'rule'} />}>
      {view === 'smart' ? (
        <>
          <SmartField workspaceId={workspaceId} line={line} lookups={lookups} target={target} busy={busy || !caps.post} onTarget={setTarget} />
          {target !== null && paneBody}
        </>
      ) : (
        <ModeSwitch view={view} line={line} pane={shown} onPane={switchTo}>
          {paneBody}
        </ModeSwitch>
      )}
      {previewed}
      <Woher {...props} vorschlag={vorschlag} />
      {blocked && <p className="bank-mode__warn bank-panel__line">{reasonSentence(t, lookups, line)}</p>}
      {vorschlag !== undefined && (
        <VorschlagOnLine
          line={line}
          vorschlag={vorschlag}
          lookups={lookups}
          canDecide={caps.decideVorschlag}
          isOwn={props.whoamiActor !== null && vorschlag.actor === props.whoamiActor}
          busy={busy}
          onReject={(r) => props.onReject(vorschlag, r)}
        />
      )}
      {shown === 'konto' && <CaseControls {...props} target={target} />}
      {control.length > 0 && <p className="bank-mode__warn bank-panel__line">{t('bankInbox.warning.control_account_leg_before', { account: control.join(', ') })}</p>}
      {refusal !== null && (
        <div className="bank-panel__line">
          <RefusalNote error={refusal} context={{ currency: line.currency, lineState: line.state }} onAction={props.onRefusalAction} />
        </div>
      )}
    </DetailSlots>
  );
}

/**
 * The amounts a Buchungsregel needs (A39 §16.2): an asked one is an empty labelled field; a computed one
 * is prefilled with the engine's figure, marked "berechnet" with its formula on hover, and once edited
 * reads "von dir" with "berechnen" to take the engine's figure back. The typed text is kept verbatim.
 */
function Amounts({ line, lookups, busy, onAsk, target, restZero }: DetailsPanelProps & { target: Extract<DraftTarget, { kind: 'rule' }>; restZero: boolean }) {
  const t = useT();
  const baseId = useId();
  const noteId = `${baseId}-rest`;
  const rule = lookups.standardById.get(target.standardId);
  return (
    <section className="bank-panel__amounts" aria-label={t('bankInbox.panel.amounts')}>
      {target.asks.map((a) => {
        const label = a.label !== '' ? a.label : t('bankInbox.rules.askFallback');
        const fieldId = `${baseId}-ask-${a.legIndex}`;
        const computed = a.computed;
        const asIs = isComputedAsIs(a);
        const shown = computed !== undefined && asIs ? (computed.minor === null ? '' : minorToField(computed.minor)) : a.value;
        const invalid = !asIs && a.value.trim() !== '' && askMinor(a) === null;
        const leg = rule?.legs[a.legIndex];
        const factor = leg?.amount.kind === 'factor' ? leg.amount : computed?.num !== undefined && computed.den !== undefined ? { num: computed.num, den: computed.den, explain: computed.explain } : undefined;
        // UX judge round 2, item 11: in words ("Bruttoumsatz aus 15.12: MWST 8.1 % und Gebühr 9.9 % vom
        // Netto"), never the fraction.
        const how = factor === undefined ? '' : howWords(t, factor.explain ?? computed?.explain, factor.num, factor.den);
        const formula =
          how === ''
            ? t('bankInbox.panel.computedTip', { label, amount: bare(absAmount(line), line.currency) })
            : t('bankInbox.panel.formulaWords', { label, amount: bare(absAmount(line), line.currency), how });
        return (
          <div key={a.legIndex} className="bank-panel__amount-row">
            <label className="bank-field" htmlFor={fieldId}>
              <span className="bank-field__label">{label}</span>
              <input
                id={fieldId}
                type="text"
                inputMode="decimal"
                className="field t-num bank-money-input bank-ask__input"
                value={shown}
                placeholder={computed !== undefined && computed.minor === null ? t('bankInbox.panel.computed') : ''}
                aria-invalid={invalid || undefined}
                aria-describedby={restZero && !asIs ? noteId : undefined}
                disabled={busy}
                onChange={(e) => onAsk(a.legIndex, e.target.value)}
              />
            </label>
            {computed !== undefined &&
              (asIs ? (
                // Left of its trigger (D177 polish 1): above it covered the header's amount, below the
                // Buchungstext and the rest-of-zero reason; above again only when the left has no room.
                <Tooltip content={formula} placement="left">
                  <span className="bank-panel__computed" tabIndex={0} data-computed="engine">
                    {t('bankInbox.panel.computed')}
                  </span>
                </Tooltip>
              ) : (
                <span className="bank-panel__computed" data-computed="person">
                  <span>{t('bankInbox.panel.byYou')}</span>
                  <Tooltip content={formula} placement="left">
                    <button type="button" className="btn btn--ghost btn--sm bank-panel__recompute" onClick={() => onAsk(a.legIndex, null)}>
                      {t('bankInbox.panel.recompute')}
                    </button>
                  </Tooltip>
                </span>
              ))}
          </div>
        );
      })}
      {restZero && (
        <span id={noteId} className="bank-ask__note" role="status">
          {restZeroReason(t, lookups, target)}
        </span>
      )}
    </section>
  );
}


/**
 * MWST of a one-account booking (D167 item 5): the row's picker, here while the panel is open and the table
 * has stepped its MWST column aside. "Ohne MWST" first, the codes of the money's direction next. Where no
 * code can apply the field is not offered (D152 rule 2).
 */
function VatField({ line, lookups, busy, onVat, target }: DetailsPanelProps & { target: Extract<DraftTarget, { kind: 'accounts' }> }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const leg = target.legs.length === 1 ? target.legs[0] : undefined;
  if (leg === undefined || !vatPickerShows(lookups, leg)) return null;
  const party = partyOf(t, line);
  const code = lookups.taxCodes.find((c) => c.code === leg.taxCode);
  return (
    <div className="bank-field bank-panel__vat">
      <span className="bank-field__label" aria-hidden="true">
        {t('bankInbox.col.vat')}
      </span>
      <TaxCodeCombobox
        label={code !== undefined ? t('bankInbox.row.vatNamed', { party, code: code.code, name: code.label }) : t('bankInbox.row.vatLabel', { party })}
        codes={lookups.taxCodes}
        value={leg.taxCode}
        direction={isCredit(line) ? 'in' : 'out'}
        strictGroups={{ label: t(isCredit(line) ? 'bankInbox.row.vatGroupIn' : 'bankInbox.row.vatGroupOut'), otherLabel: t('bankInbox.row.vatGroupOther') }}
        humanLabels={{ date: lineDate(line) }}
        open={open}
        onOpenChange={setOpen}
        onChange={onVat}
        disabled={busy}
        className="bank-picker bank-picker--vat"
      />
    </div>
  );
}

/** The Buchungstext (owner amendment a): a labelled field from the start, prefilled with the engine's default. */
function BookingText({ line, text, busy, onText }: DetailsPanelProps) {
  const t = useT();
  const id = useId();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // UX judge round 2, item 2: the whole text, never cut. The field grows with its text (one line at rest).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight + 2}px`;
  }, [text]);
  return (
    <label className="bank-field bank-panel__text" htmlFor={id}>
      <span className="bank-field__label">{t('bankInbox.panel.text')}</span>
      <textarea
        id={id}
        ref={ref}
        rows={1}
        className="field bank-panel__text-input"
        value={text}
        maxLength={BOOKING_TEXT_MAX}
        disabled={busy}
        data-booking-text={line.bankTxnId}
        onChange={(e) => onText(e.target.value.replace(/\r?\n/g, ' '))}
        onKeyDown={(e) => {
          // One line of text: Enter never breaks it.
          if (e.key === 'Enter') e.preventDefault();
        }}
      />
    </label>
  );
}

/**
 * "So wird gebucht": the engine's lines for the very target Buchen sends. An accounts target without a
 * Durchlaufkonto asks `compose_entry` with its legs (the strip's old read); a rule or a via route asks with
 * the target itself. While a rule's asked amount is empty, its accounts show with "?".
 */
function Preview({
  workspaceId,
  line,
  lookups,
  target,
  targetCompose,
}: DetailsPanelProps & { target: Extract<DraftTarget, { kind: 'accounts' } | { kind: 'rule' }>; targetCompose: ReturnType<typeof useTargetCompose> }) {
  const t = useT();
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const direct = target.kind === 'accounts' && (target.viaAccountId ?? '') === '';
  const missing = target.kind === 'rule' ? target.asks.filter((a) => !isComputedAsIs(a) && askMinor(a) === null) : [];
  const legsCompose = useBankCompose(workspaceId, direct && target.kind === 'accounts' ? bankComposeRequest(line, target.legs, bankLedger) : null, { currency: line.currency });
  const title = t('bankInbox.legs.title');
  // D177 (owner): the Durchlaufkonto's in and out stay visible, quieter than the legs that matter.
  const via = target.kind === 'accounts' ? (target.viaAccountId ?? '') : (lookups.standardById.get(target.standardId)?.viaAccountId ?? '');
  const transitIds: ReadonlySet<string> = new Set(via !== '' ? [via] : []);

  // A zero rest is said once, at the field (UX judge round 2, item 3). D177 final judge, FAIL 1: the preview
  // keeps its usual lines and sides, the engine's composition of the rule without its rest leg (which is
  // 0), the rest shown as 0.00 on its side.
  const restZero = target.kind === 'rule' && targetCompose.status === 'answered' && composeVerdictError(targetCompose.answer)?.error === 'rest_is_zero';
  const zero = restZero && target.kind === 'rule' ? zeroRestOf(line, lookups.standardById.get(target.standardId), target) : null;
  const zeroCompose = useTargetCompose(workspaceId, line.bankTxnId, zero === null ? null : bookTargetOf(zero.target));
  if (zero !== null && zeroCompose.status === 'answered' && zeroCompose.answer.composed) {
    const rows: PreviewRow[] = [...previewLinesOf(zeroCompose.answer)];
    rows.push({ accountId: zero.restAccountId, debit: 0, credit: 0, zeroSide: zero.restSide });
    if (zero.viaAccountId !== null) rows.push({ accountId: zero.viaAccountId, debit: 0, credit: 0, zeroSide: zero.restSide === 'debit' ? 'credit' : 'debit' });
    return <LegsPreview title={title} lines={rows} currency={line.currency} lookups={lookups} transitIds={transitIds} />;
  }
  if ((missing.length > 0 || restZero) && target.kind === 'rule') {
    // The rule's accounts, the figures not known yet: the bank's side and each leg's account with "?".
    const rule = lookups.standardById.get(target.standardId);
    const credit = isCredit(line);
    const rows: PreviewRow[] = [];
    if (bankLedger !== null) rows.push({ accountId: bankLedger, debit: credit ? absAmount(line) : 0, credit: credit ? 0 : absAmount(line) });
    for (const leg of rule?.legs ?? []) {
      const side: 'debit' | 'credit' = credit === (leg.against === true) ? 'debit' : 'credit';
      rows.push({ accountId: leg.accountId, debit: 0, credit: 0, unknownSide: side });
    }
    return <LegsPreview title={title} lines={rows.length > 0 ? rows : null} currency={line.currency} lookups={lookups} transitIds={transitIds} />;
  }

  const state = direct ? legsCompose : targetCompose;
  if (state.status === 'foreign') return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={t('bankInbox.error.vatForeignCurrency.title')} />;
  // A failed read says so in one neutral line (critic L1), never a figure; a refused booking says why.
  if (state.status === 'failed' && state.error.error !== 'permission_denied') {
    return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={t('bankInbox.legs.unavailable')} />;
  }
  // A typed leg list the engine could not compose: its code could not be priced (the strip's old sentence).
  if (direct && state.status === 'answered' && !state.answer.composed) {
    return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={t('bankInbox.details.vatFailed')} />;
  }
  const refused = state.status === 'failed' ? state.error : state.status === 'answered' && !state.answer.composed ? composeVerdictError(state.answer) : null;
  if (refused !== null && refused.error !== 'permission_denied') {
    const said = explainRefusal(t, refused, { currency: line.currency });
    const note = typeof said === 'string' ? said : said.unmapped ? t('bankInbox.legs.unavailable') : said.title;
    return <LegsPreview title={title} lines={null} currency={line.currency} lookups={lookups} note={note} />;
  }
  const lines = state.status === 'answered' && state.answer.composed ? previewLinesOf(state.answer) : null;
  const note =
    state.status === 'denied' || refused?.error === 'permission_denied'
      ? t('bankInbox.legs.noRight')
      : state.status === 'pending'
        ? t('bankInbox.legs.computing')
        : state.status === 'answered' && !state.answer.composed
          ? t('bankInbox.details.vatFailed')
          : state.status === 'none'
            ? // Nothing to compose yet: say what is missing, never a dead end (UX judge, item 5).
              t('bankInbox.book.why.account')
            : t('bankInbox.legs.unavailable');
  return (
    <LegsPreview
      title={title}
      lines={lines !== null && lines.length > 0 && previewBalances(lines) ? lines : null}
      currency={line.currency}
      lookups={lookups}
      note={note}
      transitIds={transitIds}
    />
  );
}

export interface WoherView {
  glyph: ReactNode;
  /** The glyph's own few words (its tooltip): what kind of source it is. */
  glyphTip: string;
  label: string;
  tip: string;
  /** A quiet button that opens the rule in the rules sheet. */
  ruleId?: string;
  /** A link to what the source names (an entry, the agent's Vorschläge). */
  href?: string;
}

/** The short words for a proposal's reason (Woher), by code; the full sentence is the tooltip. */
const REASON_WORDS: Readonly<Record<string, string>> = {
  existing_entry_reference: 'entryReference',
  existing_entry_amount_date: 'sameAmount',
  qr_reference_exact: 'qrReference',
  qr_reference_amount_differs: 'qrDiffers',
  payment_batch_reference: 'batch',
  payment_batch_item: 'batch',
  payment_batch_total_differs: 'batchDiffers',
  payment_batch_item_amount_differs: 'batchDiffers',
  vendor_bill_reference: 'billReference',
  vendor_bill_amount: 'sameAmount',
  own_account_transfer: 'transfer',
  own_account_transfer_booked: 'transfer',
};

export function woherOf(t: (k: string, p?: Record<string, string | number>) => string, l: Lookups, line: BankInboxLine, draft: RowDraft | undefined, vorschlag: LineVorschlag | undefined): WoherView | null {
  const agentTarget = vorschlag !== undefined && vorschlag.actionTool === 'book_bank_line' ? draftTargetOf(vorschlag.payload.target) : null;
  const target = draft?.target ?? null;
  const source = prefillSource(line, draft, agentTarget);
  const params = (line.proposal?.reasonParams ?? {}) as Record<string, unknown>;
  const code: string = line.proposal?.reasonCode ?? '';
  const date = (v: unknown) => (typeof v === 'string' && v.length >= 10 ? formatDate(v) : '');
  if (source === 'agent') {
    return { glyph: <AgentGlyph size={16} />, glyphTip: t('bankInbox.woher.glyph.agent'), label: t('bankInbox.woher.agent'), tip: vorschlag !== undefined ? t('bankInbox.woher.agentTip') : t('bankInbox.source.agent'), href: '/attention' };
  }
  if (source === 'standard') {
    const ruleId = target?.kind === 'rule' || target?.kind === 'ignore' ? target.standardId : (proposalRuleId(line) ?? '');
    const rule = l.standardById.get(ruleId);
    // A code the engine dropped on a foreign-currency line is the one thing the person must know (critic
    // D167-8): its sentence is the tooltip then, never the route.
    const tip =
      params.vatDropped === true
        ? reasonSentence(t, l, line)
        : rule === undefined
          ? t('bankInbox.source.standard')
          : `${matchInWords(t, rule)}\n${routeInWords(t, l, rule)}`;
    return {
      glyph: <StandardGlyph size={16} />,
      glyphTip: t('bankInbox.woher.glyph.rule'),
      label: rule !== undefined ? t('bankInbox.woher.rule', { name: ruleName(t, rule) }) : t('bankInbox.source.standard'),
      tip,
      ...(ruleId !== '' ? { ruleId } : {}),
    };
  }
  if (source === 'history') {
    const when = date(code === 'journal_history' ? params.date : params.lastDate);
    const entryId = typeof params.entryId === 'string' ? params.entryId : null;
    return {
      glyph: <LearnedGlyph size={16} />,
      glyphTip: t('bankInbox.woher.glyph.history'),
      label: when === '' ? t('bankInbox.source.history') : t('bankInbox.woher.history', { date: when }),
      tip: reasonSentence(t, l, line),
      ...(entryId !== null ? { href: `/journal?entry=${encodeURIComponent(entryId)}` } : {}),
    };
  }
  if (source === 'model') {
    return { glyph: <CheckGlyph size={16} />, glyphTip: t('bankInbox.woher.glyph.model'), label: t('bankInbox.woher.model'), tip: modelStripSentence(t, line) };
  }
  // The person's own choice carries no source; a proposal they left keeps its reason's short words.
  if (target === null || line.proposal === null || draft?.source === 'edited') return null;
  const words = REASON_WORDS[code];
  if (words === undefined) return null;
  const sure = line.proposal.certainty === 'sure';
  const entryId = target.kind === 'existing_entry' ? target.entryId : null;
  return {
    glyph: target.kind === 'existing_entry' ? <MatchGlyph size={16} /> : sure ? <SureGlyph size={16} /> : <CheckGlyph size={16} />,
    glyphTip: t(target.kind === 'existing_entry' ? 'bankInbox.woher.glyph.match' : sure ? 'bankInbox.woher.glyph.sure' : 'bankInbox.woher.glyph.check'),
    label: t(`bankInbox.woher.${words}`),
    tip: reasonSentence(t, l, line),
    ...(entryId !== null ? { href: `/journal?entry=${encodeURIComponent(entryId)}` } : {}),
  };
}

/**
 * Woher, in ONE line (owner amendment c): the glyph, the source's name (a rule's name opens the rule in
 * the sheet; an entry or the agent's Vorschlag is a link), and for a rule the switcher: the payer's other
 * rules and "Anders buchen". The match and the route, or the reason, are the name's tooltip.
 */
function Woher({ line, draft, lookups, vorschlag, onOpenRule, onPickRule, onOther, busy }: DetailsPanelProps & { vorschlag: LineVorschlag | undefined }) {
  const t = useT();
  const view = woherOf(t, lookups, line, draft, vorschlag);
  const code: string = line.proposal?.reasonCode ?? '';
  const current = view?.ruleId ?? null;
  // The payer's rules: every live rule for the counterparty and direction, else the chooser's.
  const others = [...new Set([...lineRuleIds(line), ...severalRuleIds(line)])].filter((id) => id !== current);
  const showSwitch = (view?.ruleId !== undefined || code === 'several_rules') && (others.length > 0 || current !== null);
  if (view === null && !showSwitch) return null;
  const name =
    view === null ? (
      <span className="bank-woher__name">{plural(t, 'bankInbox.woher.several', Math.max(others.length, 2))}</span>
    ) : view.ruleId !== undefined ? (
      <button type="button" className="link-inline bank-woher__name" onClick={() => onOpenRule(view.ruleId as string)}>
        {view.label}
      </button>
    ) : view.href !== undefined ? (
      <Link className="link-inline bank-woher__name" to={view.href}>
        {view.label}
      </Link>
    ) : (
      <span className="bank-woher__name" tabIndex={0}>
        {view.label}
      </span>
    );
  return (
    <div className="bank-woher" data-woher={line.bankTxnId}>
      <Tooltip content={view?.glyphTip ?? t('bankInbox.woher.glyph.rule')}>
        <span className="bank-woher__glyph" data-woher-glyph="">
          {view?.glyph ?? <StandardGlyph size={16} />}
        </span>
      </Tooltip>
      {view !== null && view.tip !== '' ? <Tooltip content={<span className="bank-woher__tip">{view.tip}</span>}>{name}</Tooltip> : name}
      {showSwitch && (
        <MenuButton
          quiet
          portal
          className="bank-woher__switch"
          label={t('bankInbox.woher.switch')}
          disabled={busy}
          items={[
            ...others.map((id) => ({ key: id, label: ruleName(t, lookups.standardById.get(id)), onSelect: () => onPickRule(id) })),
            { key: 'other', label: t('bankInbox.rules.chooser.other'), onSelect: onOther },
          ]}
        />
      )}
    </div>
  );
}

/** The case controls: a short or an over payment, a match's difference, a run's bills, the private offer. */
function CaseControls(props: DetailsPanelProps & { target: DraftTarget | null }) {
  const { target, line, lookups } = props;
  if (target?.kind === 'open_item') return <OpenItemControls {...props} target={target} />;
  if (target?.kind === 'payment_batch') return <BatchFacts {...props} batchId={target.batchId} />;
  if (target?.kind === 'existing_entry') return <EntryFacts {...props} target={target} />;
  if (target === null && line.amountMinor < 0) return <PrivateOffer {...props} lookups={lookups} />;
  return null;
}

/** The owner's private account for a private payment (IgnoreForm's rule): 2261, else 2850. */
const PRIVATE_ACCOUNTS = ['2261', '2850'];

function PrivateOffer({ line, lookups, onDraft, caps }: DetailsPanelProps) {
  const t = useT();
  const account = PRIVATE_ACCOUNTS.map((n) => lookups.chartByNumber.get(n)).find((a) => a !== undefined);
  if (account === undefined || !caps.post) return null;
  return (
    <p className="bank-panel__line">
      <button
        type="button"
        className="link-inline"
        onClick={() => onDraft({ kind: 'accounts', legs: [{ accountId: account.id, amountMinor: absAmount(line), taxCode: '' }] }, 'edited')}
      >
        {t('bankInbox.panel.private', { account: `${account.number} ${account.name}` })}
      </button>
    </p>
  );
}

function OpenItemControls({ line, lookups, target, onDraft }: DetailsPanelProps & { target: Extract<DraftTarget, { kind: 'open_item' }> }) {
  const t = useT();
  const baseId = useId();
  const credit = isCredit(line);
  const params = (line.proposal?.reasonParams ?? {}) as Record<string, unknown>;
  const fromProposal = params.documentId === target.documentId;
  const invoice = credit ? lookups.invoiceById.get(target.documentId) : undefined;
  const bill = credit ? undefined : lookups.billById.get(target.documentId);
  const principal = invoice?.openMinor ?? bill?.openMinor ?? (fromProposal && typeof params.openMinor === 'number' ? params.openMinor : null);
  const fees = fromProposal && typeof params.dunningFeeMinor === 'number' ? params.dunningFeeMinor : 0;
  if (principal === null) return null;
  const rest = principal + fees - absAmount(line);
  if (rest === 0) return null;
  const money = (m: number) => formatMoney(m, line.currency);
  const choose = (remainder: RemainderMode) => onDraft({ ...target, remainder }, 'edited');
  const options: { mode: RemainderMode; label: string }[] =
    rest < 0
      ? [{ mode: 'on_account', label: t('bankInbox.item.onAccount') }]
      : credit
        ? [
            { mode: 'leave_open', label: t('bankInbox.item.leaveOpen') },
            { mode: 'write_off', label: t('bankInbox.item.writeOff') },
          ]
        : [{ mode: 'leave_open', label: t('bankInbox.item.leaveOpen') }];
  const chosen: RemainderMode = target.remainder ?? (rest < 0 ? 'on_account' : 'leave_open');
  const legend = rest < 0 ? t('bankInbox.item.surplusLegend', { rest: money(-rest) }) : t('bankInbox.item.remainderLegend', { rest: money(rest) });
  return (
    <fieldset className="bank-panel__case" data-case={rest < 0 ? 'over' : 'short'}>
      <legend className="bank-field__label">{legend}</legend>
      <span className="bank-panel__choices" role="radiogroup" aria-label={legend}>
        {options.map((o) => (
          <label key={o.mode} className="bank-panel__choice">
            <input type="radio" name={`${baseId}-remainder`} checked={chosen === o.mode} onChange={() => choose(o.mode)} />
            {o.label}
          </label>
        ))}
      </span>
    </fieldset>
  );
}

function BatchFacts({ workspaceId, line, batchId }: DetailsPanelProps & { batchId: string }) {
  const t = useT();
  const batch = useBatch(workspaceId, batchId);
  if (batch === null) return null;
  const vendor = (it: (typeof batch.items)[number]) => it.vendorName ?? t('bankInbox.target.billName');
  const names = batch.items.length <= 2 ? batch.items.map(vendor).join(', ') : `${batch.items.slice(0, 2).map(vendor).join(', ')}, ${t('bankInbox.details.satzMore', { count: batch.items.length - 2 })}`;
  const all = batch.items.map((it) => `${vendor(it)} ${formatMoney(it.amountMinor, it.currency)}`).join(', ');
  return (
    <p className="bank-panel__line">
      {batch.items.length > 0 && (
        <Tooltip content={all}>
          <span className="bank-panel__bills" tabIndex={0}>
            {plural(t, 'bankInbox.details.batchBills', batch.items.length, { names })}
          </span>
        </Tooltip>
      )}
      {batch.totalMinor !== null && batch.totalMinor !== absAmount(line) && (
        <span className="bank-panel__warn">
          {' '}
          {t('bankInbox.batch.totalDiffers', { batch: formatMoney(batch.totalMinor, line.currency), line: formatMoney(absAmount(line), line.currency) })}
        </span>
      )}
    </p>
  );
}

/** A match: the entry, and when the amounts differ, by how much and the reason field (critic A39-12). */
function EntryFacts({ workspaceId, line, lookups, target, onDraft }: DetailsPanelProps & { target: Extract<DraftTarget, { kind: 'existing_entry' }> }) {
  const t = useT();
  const { entry, loading } = useEntry(workspaceId, target.entryId);
  if (loading) return null;
  if (entry === null) return <p className="bank-panel__line">{t('bankInbox.compare.readFailed')}</p>;
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  const bankLeg = entry.lines.find((l) => l.account === bankLedger);
  const signed = bankLeg === undefined ? null : bankLeg.debit - bankLeg.credit;
  const differs = signed !== null && signed !== line.amountMinor && Math.sign(signed) === Math.sign(line.amountMinor);
  const what =
    entry.entry.number != null
      ? t('bankInbox.details.entryNumbered', { number: entry.entry.number, date: formatDate(entry.entry.date), text: entry.entry.description ?? t('bankInbox.target.entry') })
      : t('bankInbox.details.entry', { date: formatDate(entry.entry.date), text: entry.entry.description ?? t('bankInbox.target.entry') });
  if (!differs || signed === null) return <p className="bank-panel__line">{what}</p>;
  const amount = formatMoney(Math.abs(line.amountMinor - signed), line.currency);
  return (
    <div className="bank-panel__case">
      <p className="bank-panel__line">
        {what} <span className="bank-panel__warn">{t('bankInbox.details.entryDiffers', { amount })}</span>
      </p>
      <label className="bank-field" htmlFor={`difference-reason-${line.bankTxnId}`}>
        <span className="bank-field__label">{t('bankInbox.compare.differenceReason', { amount })}</span>
        <input
          id={`difference-reason-${line.bankTxnId}`}
          type="text"
          className="field"
          maxLength={500}
          value={target.differenceReason ?? ''}
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
    </div>
  );
}

/**
 * The actions (owner amendment b): Aufteilen, Abgleichen, Als Regel speichern and Anhängen as icon
 * buttons of the closed vocabulary, "Agent fragen" in words, and Buchen, the one labelled commit. Buchen
 * says why when it cannot book (D177 point 4), and its C4 consequence when it can.
 */
function Actions(props: DetailsPanelProps & { target: DraftTarget | null; figures?: Figures | null; whyAtField?: boolean }) {
  const { line, target, caps, busy, bookState, consequence, splitting } = props;
  const t = useT();
  const party = partyOf(t, line);
  const accounts = target?.kind === 'accounts' && target.legs.length > 0 && target.legs.every((l) => l.accountId !== '') ? target : null;
  const oneLeg = accounts !== null && accounts.legs.length === 1 && (accounts.viaAccountId ?? '') === '';
  const match = target?.kind === 'existing_entry';
  const ignoring = target?.kind === 'ignore';
  const tip = bookState.enabled ? (match ? t('bankInbox.link.consequence') : ignoring ? t('bankInbox.ignore.consequence') : consequence) : bookState.reason;
  const inert = !bookState.enabled || busy;
  const onClick = () => {
    if (inert) return;
    props.onBook();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  };
  // The tinted accent only for a booking that posts (K-08); a match and a "Nicht buchen" post nothing.
  const book =
    match || ignoring ? (
      <button type="button" className="btn btn--secondary bank-panel__book" aria-disabled={inert ? true : undefined} onClick={onClick} onKeyDown={onKeyDown}>
        {busy ? t('bankInbox.row.busy') : t(match ? 'bankInbox.row.match' : 'bankInbox.row.ignoreRule')}
      </button>
    ) : (
      <button
        type="button"
        className="btn btn--accent bank-panel__book"
        data-money-commit="book_bank_line"
        aria-disabled={inert ? true : undefined}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        {busy ? t('bankInbox.row.busy') : t('bankInbox.row.book')}
      </button>
    );
  return (
    <div className="bank-panel__actions bank-panel__foot">
      <span className="bank-panel__tools">
        {/* B5 judge: Aufteilen and Ignorieren in words, the two bexio options the owner named. */}
        {caps.post && !splitting && (
          <button type="button" className="btn btn--ghost btn--sm bank-foot__word" disabled={busy} onClick={props.onSplit}>
            {t('bankInbox.foot.split')}
          </button>
        )}
        {caps.post && (
          <button type="button" className="btn btn--ghost btn--sm bank-foot__word" disabled={busy} onClick={() => props.onMode('ignore')}>
            {t('bankInbox.foot.ignore')}
          </button>
        )}
        {caps.post && <IconButton icon="link" small context={t('bankInbox.panel.linkContext', { party })} disabled={busy} onClick={() => props.onMode('link')} />}
        {caps.post && accounts !== null && (
          <IconButton
            icon="rule"
            small
            context={t('bankInbox.panel.ruleContext', { party })}
            disabled={busy}
            onClick={() => (oneLeg ? props.onSetStandard() : props.onMode('rule'))}
          />
        )}
        {caps.attach && <IconButton icon="attach" small context={t('bankInbox.panel.attachContext', { party })} disabled={busy} onClick={props.onAttach} />}
        {/* D177 (UX judge, item 7): the foot is icons plus Buchen; the rare "Agent fragen" lives under Mehr. */}
        <OverflowMenu quiet portal label={t('bankInbox.panel.more', { party })} items={[{ key: 'agent', label: t('bankInbox.menu.agent'), onSelect: props.onAgent }]} />
      </span>
      {/* D178 N3 (A39 §20.6): Betrag / verteilt / Abweichung beside Buchen, which waits until the deviation is 0. */}
      {props.figures != null && <FootFigures figures={props.figures} currency={line.currency} />}
      {/* B5 judge: a disabled Buchen says why in one line beside it, not only on hover. */}
      {/* A rest of 0 is already said at its field (D177 UX judge round 2, item 3): said once, not twice. */}
      {!bookState.enabled && props.whyAtField !== true && bookState.reason !== null && bookState.reason !== '' && (
        <span className="bank-foot__why" data-book-why="">
          {bookState.reason}
        </span>
      )}
      {tip === null || tip === '' ? book : <Tooltip content={tip}>{book}</Tooltip>}
    </div>
  );
}

function DecidedPanel(props: DetailsPanelProps) {
  const { workspaceId, line, lookups, mode, caps, busy, refusal } = props;
  const t = useT();
  const seatName = useSeatNames();
  const decision = line.decision;
  const { entry } = useEntry(workspaceId, decision?.entryId ?? null);

  if (mode === 'reopen') {
    return (
      <DetailSlots>
        <div className="bank-panel__editor">
          <ReopenForm line={line} busy={busy} canReopen={caps.post && (decision?.paymentId === null || caps.pay)} onReopen={props.onReopen} onCancel={() => props.onMode('details')} />
        </div>
      </DetailSlots>
    );
  }
  if (mode === 'receipts') return <ReceiptsEditor {...props} />;

  const vorschlag = lineVorschlag(line, lookups.vorschlaege);
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
  const satz = entry !== null && entry.lines.length > 0 && line.state !== 'ignored' ? satzOf(t, lookups, entry.lines, line.currency) : null;
  const accountsBooking = decision?.targetKind !== 'existing_entry' && decision?.targetKind !== 'open_item' && decision?.targetKind !== 'payment_batch';

  return (
    <DetailSlots
      footer={
        <div className="bank-panel__actions bank-panel__foot">
          <span className="bank-panel__tools">
            {caps.attach && <IconButton icon="attach" small context={t('bankInbox.panel.attachContext', { party: partyOf(t, line) })} disabled={busy} onClick={props.onAttach} />}
          </span>
          <button type="button" className="btn btn--secondary" disabled={busy || !caps.post} onClick={() => props.onMode('reopen')}>
            {undoLabel}
          </button>
        </div>
      }
    >
      <p className="bank-panel__line bank-panel__decision">
        <span className="bank-state__word">{t(`bankInbox.state.${line.state}`)}</span>
        {!(satz !== null && accountsBooking) && <span className="bank-panel__reason">{summary}</span>}
        {satz !== null &&
          (satz.truncated ? (
            <Tooltip content={satz.full}>
              <span className="bank-panel__satz" tabIndex={0}>
                {satz.short}
              </span>
            </Tooltip>
          ) : (
            <span className="bank-panel__satz">{satz.short}</span>
          ))}
      </p>
      {decision?.note !== null && decision?.note !== undefined && <p className="bank-panel__line">{t('bankInbox.decided.note', { note: decision.note })}</p>}
      {decision?.differenceMinor !== null && decision?.differenceMinor !== undefined && decision.differenceMinor !== 0 && (
        <p className="bank-panel__line bank-panel__warn">{t('bankInbox.decided.difference', { amount: formatMoney(Math.abs(decision.differenceMinor), line.currency) })}</p>
      )}
      <p className="bank-panel__line bank-panel__who">
        {who !== null && when !== null && <span>{t('bankInbox.decided.by', { who: seatName(who).label, date: formatDate(when.slice(0, 10)) })}</span>}
        {entryId !== null && line.state !== 'ignored' && (
          <Link className="link-inline bank-panel__link" to={`/journal?entry=${encodeURIComponent(entryId)}`}>
            {/* D178 point 2: the entry's Belegnummer where the booking shows its entry. */}
            {entry?.entry.number != null ? t('bankInbox.details.openEntryNumber', { number: entry.entry.number }) : t('bankInbox.details.openEntry')}
          </Link>
        )}
      </p>
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
        <div className="bank-panel__line">
          <RefusalNote error={refusal} context={{ currency: line.currency, lineState: line.state }} onAction={props.onRefusalAction} />
        </div>
      )}
    </DetailSlots>
  );
}
