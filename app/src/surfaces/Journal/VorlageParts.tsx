/**
 * D176 (A39 §15.4): the Buchungssatz composer's VORLAGEN. A Vorlage is a Buchungsregel of scope `manual`
 * (`list_bank_standards { scope: 'manual' }`): a recurring booking whose legs state their side, one leg the
 * rest that balances the entry, the others asked each time under a label or the same as another asked leg.
 *
 * WHAT THIS FILE IS. The composer's pieces for one: the quiet "Vorlage" picker above the lines; the asked
 * amounts as labelled inputs; the preview of what `post_entry { template }` books, read from `compose_entry`
 * with the same template (the engine expands it, D152: the Studio adds no figure of its own); and ☆ "Als
 * Vorlage speichern" on a composed entry, which opens the Buchungsregel form in manual scope with the
 * entry's lines prefilled. Nothing here posts: Buchen in the drawer sends `post_entry` with the template.
 */
import { useEffect, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT, formatMoney } from '../../i18n';
import { Select } from '../../components/Select';
import type { ComposeExpandOk } from '../../../../src/core/ledger/compose';
import { parseStandards, type BankStandard, type ChartAccount, type TaxCode as BankTaxCode } from '../Bank/model';
import { buildLookups, type Lookups } from '../Bank/lookups';
import { RuleEditor, type EditorLeg, type RulePayload } from '../Bank/RuleEditor';
import { ruleInputOf } from '../Bank/rules';
import { parseAmountToMinor } from './money';
import type { Account, TaxCode } from './types';
import '../Bank/Bank.css';

/** One amount a Vorlage asks for: the leg's index in the recipe (the engine's `asks` key) and its label. */
export interface VorlageAsk {
  legIndex: number;
  label: string;
}

/** The asked amounts of a Vorlage, in the recipe's order. */
export function asksOf(v: Pick<BankStandard, 'legs'>): VorlageAsk[] {
  return v.legs.flatMap((leg, legIndex) => (leg.amount.kind === 'ask' ? [{ legIndex, label: leg.amount.label }] : []));
}

/**
 * The `template` `compose_entry` and `post_entry` take, once every asked amount is a positive number of
 * Rappen; null while one is missing (the D152 rule: the Studio checks only that, the rest is the engine's).
 */
export function templateOf(v: Pick<BankStandard, 'id' | 'legs'>, typed: Readonly<Record<number, string>>): { standardId: string; asks: Record<string, number> } | null {
  const asks: Record<string, number> = {};
  for (const a of asksOf(v)) {
    const minor = parseAmountToMinor(typed[a.legIndex] ?? '');
    if (minor === null || minor <= 0) return null;
    asks[String(a.legIndex)] = minor;
  }
  return { standardId: v.id, asks };
}

/** The live Vorlagen of the workspace (`list_bank_standards { scope: 'manual' }`); none on a refused read. */
export function useVorlagen(workspaceId: string | null, enabled: boolean): { vorlagen: BankStandard[]; reload: () => void } {
  const client = useClient();
  const [vorlagen, setVorlagen] = useState<BankStandard[]>([]);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled || workspaceId === null) return;
    let live = true;
    void client.call('list_bank_standards', { workspaceId, scope: 'manual' }).then(({ body }) => {
      if (!live) return;
      // A seat without the bank read right (`read_sales`) simply sees no Vorlage picker.
      setVorlagen(isErr(body) ? [] : parseStandards(body).filter((s) => s.scope === 'manual'));
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId, enabled, nonce]);
  return { vorlagen, reload: () => setNonce((n) => n + 1) };
}

/** The Bank's lookups, built from the composer's own reads, so the shared Buchungsregel form can run here. */
export function composerLookups(accounts: readonly Account[], taxCodes: readonly TaxCode[], bankLedgerIds: ReadonlySet<string>): Lookups {
  const chart: ChartAccount[] = accounts.map((a) => ({ id: a.id, number: a.number, name: a.name, vatCodeDefault: a.vatCodeDefault ?? null, type: a.type ?? null }));
  const codes: BankTaxCode[] = taxCodes
    .filter((c) => c.active)
    .map((c) => ({ code: c.code, kind: c.kind, rateBp: c.rateBp, label: c.label, ...(c.formLine !== null ? { formLine: c.formLine } : {}) }));
  return buildLookups({
    chart,
    taxCodes: codes,
    invoices: [],
    bills: [],
    // Only the ledger ids matter here: the form never offers a Bankkonto's ledger account.
    bankAccounts: [...bankLedgerIds].map((id) => ({ id, name: '', iban: '', currency: '', ledgerAccountId: id })),
    vorschlaege: [],
    dial: null,
  });
}

// --- The picker --------------------------------------------------------------------------------------------

export interface VorlagePickerProps {
  id: string;
  vorlagen: readonly BankStandard[];
  /** The chosen Vorlage's id, or '' for none. */
  value: string;
  disabled?: boolean;
  onChange: (standardId: string) => void;
}

/** The reasons a Vorlage went unusable (`BANK_RULE_INVALID_REASONS`), each with words in both locales. */
const INVALID_WORDS: ReadonlySet<string> = new Set(['account_archived', 'account_not_bookable', 'tax_code_inactive', 'vat_not_applicable', 'recipe_unreadable']);

/** Why a Vorlage cannot book now, in words (critic D176-C1); never its code. */
export function vorlageInvalidText(t: (key: string, params?: Record<string, string | number>) => string, reason: string): string {
  return t(`entry.vorlage.invalid.${INVALID_WORDS.has(reason) ? reason : 'other'}`);
}

/**
 * The one quiet "Vorlage" picker above the lines (A39 §15.4); "Ohne Vorlage" returns to the Buchungssatz.
 * Critic D176-C1: a Vorlage the engine reports invalid (an account archived or now a Bankkonto ledger, a
 * code gone) is listed with its reason in words and cannot be picked; the engine refuses it too.
 */
export function VorlagePicker({ id, vorlagen, value, disabled = false, onChange }: VorlagePickerProps) {
  const t = useT();
  return (
    <div className="journal-field journal-vorlage-picker">
      <label htmlFor={id}>{t('entry.vorlage.label')}</label>
      <Select
        id={id}
        value={value}
        disabled={disabled}
        options={[
          { value: '', label: t('entry.vorlage.none') },
          ...vorlagen.map((v) => {
            const name = v.label ?? t('entry.vorlage.unnamed');
            return v.invalidReason === null
              ? { value: v.id, label: name }
              : { value: v.id, label: t('entry.vorlage.unusable', { name, reason: vorlageInvalidText(t, v.invalidReason) }), disabled: true };
          }),
        ]}
        onChange={onChange}
      />
    </div>
  );
}

// --- The asked amounts and the preview -------------------------------------------------------------------

export interface VorlageFieldsProps {
  idPrefix: string;
  vorlage: BankStandard;
  typed: Readonly<Record<number, string>>;
  onType: (legIndex: number, value: string) => void;
  /** The engine's answer for exactly what is typed, undefined while in flight or incomplete. */
  answer: (ComposeExpandOk & { readonly ok: true; template?: unknown }) | Err | undefined;
  accountLabel: (id: string) => string;
  currency: string;
  disabled?: boolean;
}

/**
 * The Vorlage's asked amounts, each a labelled money input (its label is the Vorlage's word for it), and the
 * lines the engine composed for them: what Buchen posts, verbatim. The refusal the post would answer is said
 * under the inputs in words, and every typed value stays.
 */
export function VorlageFields({ idPrefix, vorlage, typed, onType, answer, accountLabel, currency, disabled = false }: VorlageFieldsProps) {
  const t = useT();
  const asks = asksOf(vorlage);
  const verdict = answer === undefined ? undefined : answer.ok ? answer.verdict : answer;
  // A template's own refusal is said here; any other (a locked period, VAT that does not reconcile) is the
  // drawer's, said where it says it for typed lines.
  const refusal = verdict !== undefined && !verdict.ok && TEMPLATE_REFUSALS.has(verdict.error) ? verdict : null;
  const composed = answer !== undefined && answer.ok && answer.composed ? answer.lines : [];
  return (
    <div className="journal-vorlage">
      <div className="journal-vorlage-asks">
        {asks.map((a) => {
          const fieldId = `${idPrefix}-ask-${a.legIndex}`;
          const value = typed[a.legIndex] ?? '';
          const invalid = value.trim() !== '' && (parseAmountToMinor(value) ?? 0) <= 0;
          return (
            <label key={a.legIndex} className="journal-field" htmlFor={fieldId}>
              {a.label}
              <input
                id={fieldId}
                className="field t-money"
                type="text"
                inputMode="decimal"
                value={value}
                disabled={disabled}
                aria-invalid={invalid || undefined}
                onChange={(e) => onType(a.legIndex, e.target.value)}
              />
            </label>
          );
        })}
      </div>
      {refusal !== null && (
        <p role="alert" className="journal-drawer-requires">
          <span aria-hidden="true">! </span>
          {vorlageRefusal(t, refusal)}
        </p>
      )}
      {composed.length > 0 && (
        <table className="journal-drawer-lines journal-vorlage-preview">
          <caption>{t('entry.vorlage.preview')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('entry.account')}</th>
              <th scope="col">{t('entry.mwst')}</th>
              <th scope="col" className="journal-drawer-view-amount">
                {t('entry.debit')}
              </th>
              <th scope="col" className="journal-drawer-view-amount">
                {t('entry.credit')}
              </th>
            </tr>
          </thead>
          <tbody>
            {composed.map((l, i) => (
              <tr key={`${l.account}-${i}`}>
                <td>{accountLabel(l.account)}</td>
                <td className="journal-drawer-view-code">{l.taxCode ?? ''}</td>
                <td className="journal-drawer-view-amount t-money">{(l.debit ?? 0) > 0 ? formatMoney(l.debit ?? 0, currency) : ''}</td>
                <td className="journal-drawer-view-amount t-money">{(l.credit ?? 0) > 0 ? formatMoney(l.credit ?? 0, currency) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The template refusals in the composer's words; any other refusal reads as the general sentence. */
export const TEMPLATE_REFUSALS: ReadonlySet<string> = new Set(['rule_not_found', 'rule_invalid', 'wrong_scope', 'ask_missing', 'rest_is_zero', 'rest_changes_side']);

export function vorlageRefusal(t: (key: string, params?: Record<string, string | number>) => string, e: Err): string {
  return TEMPLATE_REFUSALS.has(e.error) ? t(`entry.vorlage.refusal.${e.error}`) : t('entry.vorlage.refusal.other');
}

// --- ☆ Als Vorlage speichern -----------------------------------------------------------------------------

/** One line of the composed entry the save form starts from (an intent line of the composer's request). */
export interface ComposedIntent {
  account: string;
  side: 'debit' | 'credit';
  taxCode?: string;
}

export interface SaveAsVorlageProps {
  workspaceId: string;
  lines: readonly ComposedIntent[];
  lookups: Lookups;
  currency: string;
  disabled?: boolean;
  /** A Vorlage was saved: the picker re-reads the list. */
  onSaved: (name: string) => void;
}

/**
 * ☆ "Als Vorlage speichern" on a composed entry (A39 §15.4): the Buchungsregel form in manual scope, the
 * entry's lines as its legs (account, side, code), the last line the rest and every other asked under its
 * account's name. Speichern sends `set_bank_standard { scope: 'manual' }`; it posts nothing.
 */
export function SaveAsVorlage({ workspaceId, lines, lookups, currency, disabled = false, onSaved }: SaveAsVorlageProps) {
  const t = useT();
  const client = useClient();
  const [open, setOpen] = useState(false);
  const legs = useMemo<EditorLeg[]>(
    () => lines.map((l) => ({ accountId: l.account, taxCode: l.taxCode ?? '', against: false, side: l.side })),
    [lines],
  );
  const save = async (payload: RulePayload): Promise<Err | null> => {
    const { body } = await client.call('set_bank_standard', { workspaceId, ...ruleInputOf(payload), idempotencyKey: crypto.randomUUID() });
    if (isErr(body)) return body;
    setOpen(false);
    onSaved(payload.label);
    return null;
  };
  if (!open) {
    return (
      <button type="button" className="btn btn--ghost btn--sm journal-vorlage-save" disabled={disabled || lines.length < 2} onClick={() => setOpen(true)}>
        {t('entry.vorlage.save')}
      </button>
    );
  }
  return (
    <div className="journal-vorlage-form">
      <RuleEditor
        mode="create"
        scope="manual"
        party=""
        direction="out"
        currency={currency}
        initialName=""
        initialText=""
        legs={legs}
        initialRest={legs.length - 1}
        viaAccountId={null}
        lookups={lookups}
        onSave={save}
        onCancel={() => setOpen(false)}
      />
    </div>
  );
}
