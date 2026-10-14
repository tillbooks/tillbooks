/**
 * "Aufteilen oder manuell buchen": one bank line to several accounts, each with its own VAT code, as a
 * manual journal line is booked (spec A39 §4.3 `accounts` legs; the owner's split, walk B7.1). The
 * running rest is always on screen ("Noch zu verteilen", "Zu viel verteilt", "Vollständig verteilt":
 * a MUST-SURVIVE of the Werkbank), Buchen waits until the positions add up to the line, and the
 * Soll/Haben preview shows exactly what will post. The line books on its own date, never another (spec
 * L5); the text replaces the default "Bank: ..." description.
 */
import { useId, useMemo, useState } from 'react';

import { useT, formatMoney } from '../../i18n';
import { PickerButton, type ComboboxOption } from '../../components/AccountCombobox';
import { TaxCodeCombobox } from '../../components/TaxCodeCombobox';
import type { BankInboxLine, DraftLeg, DraftTarget } from './model';
import { absAmount, isCredit, minorToField, parseMoneyInput } from './model';
import type { Lookups } from './lookups';
import { accountLabel, partyOf, taxCodeFor, vatPickerShows } from './lookups';
import { bankComposeRequest, previewBalances, previewLinesOf } from './bankCompose';
import { useBankCompose } from './useBankCompose';
import { LegsPreview } from './LegsPreview';
import { ControlAccountWarning } from './ControlAccountWarning';
import { RemoveGlyph } from './glyphs';

interface EditLeg {
  key: number;
  accountId: string;
  taxCode: string;
  amount: string;
}

export interface SplitEditorProps {
  workspaceId: string;
  line: BankInboxLine;
  lookups: Lookups;
  /** The row's current draft, the editor's starting point. */
  initial: DraftTarget | null;
  busy: boolean;
  canPost: boolean;
  onBook: (target: DraftTarget, opts: { text?: string }) => void;
  onCancel: () => void;
}

let legSeq = 0;

/** How long the editor waits after the last keystroke before it asks `compose_entry` (the composer's pace). */
const COMPOSE_DEBOUNCE_MS = 120;

export function SplitEditor({ workspaceId, line, lookups, initial, busy, canPost, onBook, onCancel }: SplitEditorProps) {
  const t = useT();
  const baseId = useId();
  const total = absAmount(line);
  const [text, setText] = useState('');
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [legs, setLegs] = useState<EditLeg[]>(() => {
    if (initial?.kind === 'accounts') {
      return initial.legs.map((l) => ({ key: (legSeq += 1), accountId: l.accountId, taxCode: l.taxCode, amount: minorToField(l.amountMinor) }));
    }
    return [{ key: (legSeq += 1), accountId: '', taxCode: '', amount: minorToField(total) }];
  });

  const parsed = legs.map((l) => parseMoneyInput(l.amount));
  const used = parsed.reduce<number>((s, v) => s + (v ?? 0), 0);
  const rest = total - used;
  const allValid = parsed.every((v) => v !== null && v !== 0);
  const allCoded = legs.every((l) => l.accountId !== '');
  const complete = rest === 0 && allValid && allCoded;

  const draftLegs: DraftLeg[] = legs
    .map((l, i) => ({ accountId: l.accountId, amountMinor: parsed[i] ?? 0, taxCode: l.taxCode }))
    .filter((l) => l.accountId !== '' && l.amountMinor !== 0);
  const bankLedger = lookups.bankById.get(line.bankAccountId)?.ledgerAccountId ?? null;
  // The Soll/Haben table is the ENGINE's composition of the legs on screen (`compose_entry`, the lines
  // `book_bank_line` posts), asked once the typing settles; while that answer is in flight it shows the
  // "wird berechnet" note, never the lines of an earlier split.
  const compose = useBankCompose(workspaceId, bankComposeRequest(line, draftLegs, bankLedger), { debounceMs: COMPOSE_DEBOUNCE_MS, currency: line.currency });
  const composedLines = compose.status === 'answered' && compose.answer.composed ? previewLinesOf(compose.answer) : null;
  const preview = composedLines !== null && composedLines.length > 0 && previewBalances(composedLines) ? composedLines : null;
  // "wird berechnet" only while an answer is really on its way (critic L1): every other state that has no
  // table says which one it is, and a state that can never become a table never reads as "computing".
  const previewNote =
    draftLegs.length === 0
      ? t('bankInbox.legs.pickFirst')
      : compose.status === 'denied' || (compose.status === 'failed' && compose.error.error === 'permission_denied')
        ? t('bankInbox.legs.noRight')
        : compose.status === 'foreign'
          ? `${t('bankInbox.error.vatForeignCurrency.title')} ${t('bankInbox.error.vatForeignCurrency.body')}`
          : compose.status === 'answered' && !compose.answer.composed
            ? t('bankInbox.strip.vatFailed')
            : compose.status === 'pending'
              ? t('bankInbox.legs.computing')
              : t('bankInbox.legs.unavailable');

  const accountOptions = useMemo<ComboboxOption[]>(
    () => lookups.chart.filter((a) => a.id !== bankLedger).map((a) => ({ id: a.id, code: a.number, label: a.name })),
    [lookups.chart, bankLedger],
  );

  const setLeg = (key: number, patch: Partial<EditLeg>) => setLegs((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const restText =
    rest > 0
      ? t('bankInbox.split.restOpen', { amount: formatMoney(rest, line.currency) })
      : rest < 0
        ? t('bankInbox.split.restOver', { amount: formatMoney(-rest, line.currency) })
        : !allCoded
          ? t('bankInbox.split.accountMissing')
          : t('bankInbox.split.complete');

  return (
    <form
      className="bank-mode bank-split"
      aria-labelledby={`${baseId}-title`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!complete || busy) return;
        onBook({ kind: 'accounts', legs: draftLegs }, text.trim() !== '' ? { text: text.trim() } : {});
      }}
    >
      <h3 id={`${baseId}-title`} className="bank-mode__title">
        {t('bankInbox.split.title')}
      </h3>
      <div className="bank-split__meta">
        <label className="bank-field bank-field--grow" htmlFor={`${baseId}-text`}>
          <span className="bank-field__label">{t('bankInbox.split.text')}</span>
          <input
            id={`${baseId}-text`}
            type="text"
            className="field"
            value={text}
            maxLength={500}
            placeholder={t('bankInbox.split.textPlaceholder', { party: partyOf(t, line) })}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      </div>
      <p className="bank-split__bank t-num">
        <span>{t('bankInbox.split.bankLine', { account: bankLedger === null ? '' : accountLabel(lookups, bankLedger), side: t(isCredit(line) ? 'bankInbox.legs.debit' : 'bankInbox.legs.credit') })}</span>
        <span className="bank-split__bank-amount">{formatMoney(total, line.currency)}</span>
      </p>
      <ol className="bank-split__legs">
        {legs.map((leg, i) => {
          const invalid = parsed[i] === null || parsed[i] === 0;
          const account = lookups.chartById.get(leg.accountId);
          return (
            <li key={leg.key} className="bank-split__leg">
              <div className="bank-split__leg-head">
                <span className="bank-split__leg-title">{t('bankInbox.split.position', { n: i + 1 })}</span>
                <button
                  type="button"
                  className="btn btn--ghost btn--icon btn--sm"
                  aria-label={t('bankInbox.split.remove', { n: i + 1 })}
                  disabled={legs.length < 2}
                  onClick={() => setLegs((ls) => ls.filter((l) => l.key !== leg.key))}
                >
                  <RemoveGlyph size={16} />
                </button>
              </div>
              <div className="bank-field">
                <span className="bank-field__label" id={`${baseId}-acc-${leg.key}`}>
                  {t('bankInbox.split.account')}
                </span>
                <PickerButton
                  label={t('bankInbox.split.accountOf', { n: i + 1 })}
                  options={accountOptions.map((o) => ({ ...o, current: o.id === leg.accountId }))}
                  value={leg.accountId}
                  searchLabel={t('bankInbox.picker.searchAccount')}
                  noMatchLabel={t('bankInbox.picker.noMatch')}
                  hint={t('picker.hint')}
                  open={openPicker === `acc-${leg.key}`}
                  onOpenChange={(open) => setOpenPicker(open ? `acc-${leg.key}` : null)}
                  onChange={(id) => {
                    const taxCode = taxCodeFor(lookups, id, leg.taxCode);
                    setLeg(leg.key, { accountId: id, taxCode });
                    setOpenPicker(vatPickerShows(lookups, { accountId: id, taxCode }) ? `vat-${leg.key}` : null);
                  }}
                  className="bank-picker"
                  width={360}
                >
                  {account === undefined ? (
                    <span className="picker-trigger__placeholder">{t('bankInbox.split.accountPlaceholder')}</span>
                  ) : (
                    <>
                      <span className="picker-trigger__code t-num">{account.number}</span>
                      <span className="picker-trigger__name">{account.name}</span>
                    </>
                  )}
                </PickerButton>
              </div>
              <div className="bank-split__leg-row">
                {/* MWST only where a code can apply, or where the leg already carries one (the composer's rule). */}
                {account === undefined || vatPickerShows(lookups, leg) ? (
                <div className="bank-field bank-field--grow">
                  <span className="bank-field__label">{t('bankInbox.split.vat')}</span>
                  <TaxCodeCombobox
                    label={t('bankInbox.split.vatOf', { n: i + 1 })}
                    codes={lookups.taxCodes}
                    value={leg.taxCode}
                    direction={isCredit(line) ? 'in' : 'out'}
                    open={openPicker === `vat-${leg.key}`}
                    onOpenChange={(open) => setOpenPicker(open ? `vat-${leg.key}` : null)}
                    onChange={(code) => setLeg(leg.key, { taxCode: code })}
                    className="bank-picker"
                  />
                </div>
                ) : (
                  <span className="bank-field bank-field--grow" aria-hidden="true" />
                )}
                <label className="bank-field bank-field--amount" htmlFor={`${baseId}-amt-${leg.key}`}>
                  <span className="bank-field__label">{t('bankInbox.split.amount')}</span>
                  <input
                    id={`${baseId}-amt-${leg.key}`}
                    type="text"
                    inputMode="decimal"
                    className="field t-num bank-money-input"
                    value={leg.amount}
                    aria-invalid={invalid || undefined}
                    onChange={(e) => setLeg(leg.key, { amount: e.target.value })}
                  />
                </label>
              </div>
            </li>
          );
        })}
      </ol>
      <div className="bank-split__foot">
        <button
          type="button"
          className="btn btn--secondary bank-touch"
          onClick={() => setLegs((ls) => [...ls, { key: (legSeq += 1), accountId: '', taxCode: '', amount: minorToField(Math.max(rest, 0)) }])}
        >
          {t('bankInbox.split.add')}
        </button>
        <p className="bank-split__rest t-num" data-complete={complete ? 'true' : 'false'} role="status">
          {restText}
        </p>
      </div>
      <LegsPreview
        title={t('bankInbox.legs.title')}
        lines={preview}
        currency={line.currency}
        lookups={lookups}
        note={previewNote}
      />
      <ControlAccountWarning lookups={lookups} legs={draftLegs} />
      <div className="bank-mode__actions">
        <button type="submit" className="btn btn--secondary bank-touch bank-commit" disabled={!complete || busy || !canPost}>
          {busy ? t('bankInbox.row.busy') : t('bankInbox.row.book')}
        </button>
        <button type="button" className="btn btn--ghost bank-touch" onClick={onCancel}>
          {t('bankInbox.panel.cancel')}
        </button>
      </div>
    </form>
  );
}
