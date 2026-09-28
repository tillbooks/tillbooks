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
import { absAmount, composeAccountsPreview, isCredit, minorToField, parseMoneyInput, previewBalances } from './model';
import type { Lookups } from './lookups';
import { accountLabel, partyOf } from './lookups';
import { useVatFigures } from './panelData';
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
  const { figures } = useVatFigures(workspaceId, line, draftLegs, lookups);
  const preview = useMemo(() => {
    if (bankLedger === null || draftLegs.length === 0) return null;
    const composed = composeAccountsPreview(line.amountMinor, draftLegs, bankLedger, figures, {
      input: lookups.chartByNumber.get('1170')?.id ?? null,
      investment: lookups.chartByNumber.get('1171')?.id ?? null,
      output: lookups.chartByNumber.get('2200')?.id ?? null,
    });
    return composed !== null && previewBalances(composed) ? composed : null;
  }, [bankLedger, draftLegs, figures, line.amountMinor, lookups]);

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
                    const a = lookups.chartById.get(id);
                    setLeg(leg.key, { accountId: id, taxCode: a?.vatCodeDefault ?? leg.taxCode });
                    setOpenPicker(`vat-${leg.key}`);
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
        note={draftLegs.length === 0 ? t('bankInbox.legs.pickFirst') : t('bankInbox.legs.computing')}
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
