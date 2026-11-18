/**
 * D207 point 3 (owner, 16.11.2026, pick A): "Freigeben und künftig automatisch" in ONE click.
 *
 * On a bank booking Vorschlag of the whole line to one account (`ruleRecipeOf`) the third icon first approves
 * the Vorschlag the way Freigeben does (the surface's own approval path: the booking, its refusals and its
 * book-again confirm stay exactly as they are), and only when that booking landed it saves a Buchungsregel:
 * `set_bank_standard { fromBankTxnId, legs }`. The line gives the counterparty and direction; the legs are the
 * APPROVED Vorschlag's account and MWST code, sent explicitly (critic D207 F1: a save that re-read the booked
 * entry could carry another code than the one approved). A retry sends the same legs. Then one line says:
 *
 *  - saved: "Gebucht. Regel gespeichert." with Rückgängig, which removes THAT rule (`clear_bank_standard`; the
 *    booking stays and follows the normal reversal rules, it is never reversed here);
 *  - the same rule already stood (`unchanged`): said so, and no Rückgängig (it would remove a rule this click
 *    did not make);
 *  - it replaced another rule of the counterparty (`supersededId`): said so, and no Rückgängig either (removing
 *    the new rule would not bring the old one back);
 *  - refused: "Gebucht. Regel nicht gespeichert" with the reason and "Erneut versuchen". The booking is never
 *    pretended away and the rule never pretended saved.
 *
 * `attention.auto_rule_confirm` (D172, default `never`): `always` keeps the confirm step the owner did not pick;
 * the surface then opens the row with `RuleConfirm` in its details, and the second click runs the same path.
 *
 * NEVER A SILENT REPLACE (critic D207 F3). Before anything is booked the slot the rule would fill (the line's
 * counterparty and direction, no text) is read (`readRuleSlot`). When a rule already stands there (a "Nicht
 * buchen" rule, a hand-built split), the confirm ALWAYS shows and names it, whatever the setting, and the save
 * pins it (`expectSlotStandardId`): if the slot changed after the person saw it, the engine refuses
 * `rule_slot_changed` and the card says so. A slot that cannot be read books nothing.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err, type TillClient } from '../../lib/client';
import { refusalText } from '../../components/states';
import { useT } from '../../i18n';
import { ruleRecipeOf, type RuleRecipe } from '../Agent/vorschlagDetails';
import type { DraftedAction } from '../Agent/model';

/** What saving the rule came to, after the booking landed. */
export type RuleOutcome =
  | { kind: 'saved'; standardId: string }
  | { kind: 'unchanged' }
  | { kind: 'replaced' }
  | { kind: 'failed'; refusal: Err };

/** How the rule's refusals are worded: the ones a person can act on have their own sentence. */
const RULE_WORDING = {
  own: 'attention.autoRule.error',
  known: new Set(['no_counterparty', 'not_booked_to_accounts', 'permission_denied', 'invalid_account', 'vat_not_applicable', 'invalid_tax_code', 'rule_slot_changed']),
  fallback: 'attention.autoRule.error.generic',
} as const;

/** The rule's refusal in words. */
export function ruleRefusalText(t: (key: string, params?: Record<string, string | number>) => string, refusal: Err): string {
  return refusalText(t, refusal, RULE_WORDING);
}

/** Save the Buchungsregel from the line the approval just booked, under the click's one key. */
export async function saveRuleFromBooking(client: TillClient, workspaceId: string, plan: RulePlan): Promise<RuleOutcome> {
  const res = await client.call('set_bank_standard', {
    workspaceId,
    fromBankTxnId: plan.bankTxnId,
    legs: plan.legs,
    ...(plan.viaAccountId !== null ? { viaAccountId: plan.viaAccountId } : {}),
    // The slot as the person saw it (null: empty); a rule set there since refuses rule_slot_changed.
    expectSlotStandardId: plan.expectSlotStandardId,
    // Critic D207 F5: ONE key per click, the same on every retry, so a save that ran but whose answer was lost
    // answers its real outcome (and its Rückgängig) instead of a second rule.
    idempotencyKey: plan.idempotencyKey,
  });
  if (isErr(res.body)) return { kind: 'failed', refusal: res.body };
  const body = res.body as { standard?: { id?: unknown }; supersededId?: unknown; unchanged?: unknown };
  if (body.unchanged === true) return { kind: 'unchanged' };
  if (typeof body.supersededId === 'string' && body.supersededId !== '') return { kind: 'replaced' };
  const id = body.standard?.id;
  return typeof id === 'string' && id !== '' ? { kind: 'saved', standardId: id } : { kind: 'failed', refusal: { ok: false, error: 'invalid_answer' } };
}

/** Rückgängig: remove the rule this click saved. The booking stays. */
export async function clearSavedRule(client: TillClient, workspaceId: string, standardId: string): Promise<Err | null> {
  const res = await client.call('clear_bank_standard', { workspaceId, standardId, idempotencyKey: `d207-rule-undo:${standardId}` });
  return isErr(res.body) ? res.body : null;
}

/**
 * The workspace's `attention.auto_rule_confirm`, read once. FAILS CLOSED (critic D207 F2): only an answer that
 * says `never` makes the one click book and save at once; while the read is in flight, when it is refused, and
 * for any value this build does not know, the rule is confirmed first (`always`).
 */
export function useAutoRuleConfirm(workspaceId: string | null): 'never' | 'always' {
  const client = useClient();
  const [value, setValue] = useState<'never' | 'always'>('always');
  useEffect(() => {
    setValue('always');
    if (workspaceId === null) return undefined;
    let live = true;
    void (async () => {
      const res = await client.call('settings_get', { workspaceId, key: 'attention.auto_rule_confirm' });
      if (!live || isErr(res.body)) return;
      const setting = (res.body as { setting?: { value?: unknown } }).setting;
      setValue(setting?.value === 'never' ? 'never' : 'always');
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return value;
}

/** The rule in words before it is saved (`always`): who for, onto what, the MWST as the booking has it. */
export function RuleConfirm({
  counterparty,
  accounts,
  replaces = null,
  busy,
  onConfirm,
  onCancel,
}: {
  counterparty: string;
  accounts: string;
  /** The rule this one replaces, in words; the confirm always names it (critic D207 F3). */
  replaces?: string | null;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div className="vorschlag-rule" role="group" aria-label={t('agent.line.automate')}>
      <span className="vorschlag-rule-text">
        {t('attention.autoRule.confirm', { counterparty, accounts })}
        {replaces !== null && (
          <>
            {' '}
            <strong className="vorschlag-rule-replaces">{t('attention.autoRule.replaces', { name: replaces })}</strong>
          </>
        )}
      </span>
      <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={onConfirm}>
        {t('attention.autoRule.confirmYes')}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={onCancel}>
        {t('attention.autoRule.confirmNo')}
      </button>
    </div>
  );
}

/** The rule one click saves: the line, who it is for, the approved legs, and the slot as the person saw it. */
export interface RulePlan extends RuleRecipe {
  bankTxnId: string;
  counterparty: string;
  /** The live rule of the slot the save replaces, or null for an empty slot (`readRuleSlot`). */
  expectSlotStandardId: string | null;
  /** That rule in words, for the confirm that names it; null for an empty slot. */
  replaces: string | null;
  /** One key per click (`newRuleKey`), reused by every retry of that click. */
  idempotencyKey: string;
}

/** The key of one click of the third icon. */
export function newRuleKey(bankTxnId: string): string {
  return `d207-rule:${bankTxnId}:${crypto.randomUUID()}`;
}

/** A live rule of the slot, as `list_bank_standards` answers it (the fields the confirm names it by). */
interface SlotRule {
  id: string;
  label: string | null;
  outcome: string;
  matchText: string | null;
  accountNumber: string | null;
  accountName: string | null;
  taxCode: string | null;
}

/** The rule in the slot in words: its name, else "Nicht buchen", else its account and code. */
function slotRuleWords(t: (key: string, params?: Record<string, string | number>) => string, r: SlotRule): string {
  if (r.label !== null && r.label.trim() !== '') return r.label.trim();
  if (r.outcome === 'ignore') return t('attention.autoRule.ignoreRule');
  return [r.accountNumber, r.accountName, r.taxCode].filter((x): x is string => typeof x === 'string' && x !== '').join(' ');
}

/**
 * The rule standing in the slot this line's rule would fill (counterparty and direction, no text), read BEFORE
 * anything is booked. `ok: false` when it cannot be read: the caller books nothing then.
 */
export async function readRuleSlot(
  client: TillClient,
  workspaceId: string,
  bankTxnId: string,
  t: (key: string, params?: Record<string, string | number>) => string,
): Promise<{ ok: true; existing: { id: string; name: string } | null } | { ok: false; refusal: Err }> {
  const inbox = await client.call('list_bank_inbox', { workspaceId, bankTxnId, status: 'all' });
  if (isErr(inbox.body)) return { ok: false, refusal: inbox.body };
  const line = ((inbox.body as { lines?: unknown }).lines as Record<string, unknown>[] | undefined)?.find((l) => l?.bankTxnId === bankTxnId);
  if (line === undefined || !Array.isArray(line.ruleIds)) return { ok: false, refusal: { ok: false, error: 'not_found' } };
  const ids = (line.ruleIds as unknown[]).filter((x): x is string => typeof x === 'string');
  if (ids.length === 0) return { ok: true, existing: null };
  const listed = await client.call('list_bank_standards', { workspaceId, scope: 'bank' });
  if (isErr(listed.body)) return { ok: false, refusal: listed.body };
  const standards = ((listed.body as { standards?: unknown }).standards as SlotRule[] | undefined) ?? [];
  const slot = standards.find((s) => s !== null && typeof s === 'object' && ids.includes(s.id) && (s.matchText === null || s.matchText === undefined || s.matchText === ''));
  return { ok: true, existing: slot === undefined ? null : { id: slot.id, name: slotRuleWords(t, slot) } };
}

/** The plan of a Vorschlag the third icon may automate, or null (`ruleRecipeOf`); its slot is read on the click. */
export function rulePlanOf(action: Pick<DraftedAction, 'actionTool' | 'payload'>, counterparty: string): RulePlan | null {
  const recipe = ruleRecipeOf(action);
  return recipe === null ? null : { ...recipe, bankTxnId: String(action.payload.bankTxnId), counterparty, expectSlotStandardId: null, replaces: null, idempotencyKey: '' };
}

/** One rule that did not save after its booking landed: said in place, with its retry of the SAME plan. */
export interface PendingRule extends RulePlan {
  refusal: Err;
  /**
   * After `rule_slot_changed` (critic D207 re-check, LOW 1): the slot read again, re-pinned to the rule standing
   * there now; the person confirms it by name before the save runs again. Absent otherwise.
   */
  reconfirm?: RulePlan;
}

/**
 * The retry of a rule refused `rule_slot_changed`: the same pin would refuse forever, so the slot is read again
 * and a new plan pinned to what stands there now (a new key: it is a new confirm). `null` when the slot cannot
 * be read.
 */
export async function repinAfterSlotChange(
  client: TillClient,
  workspaceId: string,
  plan: RulePlan,
  t: (key: string, params?: Record<string, string | number>) => string,
): Promise<RulePlan | null> {
  const slot = await readRuleSlot(client, workspaceId, plan.bankTxnId, t);
  if (!slot.ok) return null;
  return { ...plan, expectSlotStandardId: slot.existing?.id ?? null, replaces: slot.existing?.name ?? null, idempotencyKey: newRuleKey(plan.bankTxnId) };
}

/** A plan's accounts in words, with their MWST code, for a confirm shown away from its Vorschlag row. */
export function planAccountsWords(t: (key: string, params?: Record<string, string | number>) => string, plan: RulePlan, names: ReadonlyMap<string, string>): string {
  return plan.legs.map((l) => [names.get(l.accountId) ?? t('agent.field.accountId'), l.taxCode].filter((x): x is string => x !== null && x !== '').join(' ')).join(', ');
}
