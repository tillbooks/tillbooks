/**
 * D208 point 4 and 8: what the open line's commit sends, shared by Pendenzen and the Übersicht card.
 *
 *  - NOTHING CHANGED: the agent's Vorschlag is approved as drafted (`approve_drafted_action`), so the booking
 *    stays the agent's, with its pin (what you approved is what runs).
 *  - THE TEXT, THE ACCOUNT OR THE MWST CODE CHANGED: the line is booked with the person's values
 *    (`book_bank_line`, under ONE key minted for this click and reused only by its retry). The decision's own
 *    transaction closes the agent's draft as decided (`line_decided`, D177): it cannot be approved afterwards,
 *    and undoing the booking (`reopen_bank_line`) gives it back. No new verb: the engine's one booking door.
 *  - THE STAR PRESSED: once the booking landed, the Buchungsregel is saved from it: a line that came from a
 *    rule ADAPTS that rule (`standardId`, its name, text filter and next step carried over, its Durchlaufkonto
 *    while the person books its accounts);
 *    otherwise it fills the line's slot. The comment to the agent rides the same save (`note`), only when the
 *    person edited it (critic D208 LOW-2).
 *
 * Critic D208 (MEDIUM-1, 18.11.2026): NEVER A RULE THE PERSON WAS NOT SHOWN. The slot is read again BEFORE
 * anything is booked and compared with the slot the row SHOWED (`ShownSlot`, from the list's context). When a
 * rule stands there that the person did not see (another tab saved it, or the list never held the line), the
 * commit books nothing and answers `reconfirm` with that rule's name: the surface asks by name (D207's
 * `RuleConfirm`), and the confirm commits again pinned to it (`expectSlotStandardId`).
 *
 * Nothing but what the person changed changes the rule. The booking text becomes the leg's description only
 * when the person EDITED it (critic D208 LOW-1: an unedited text is the line's own remittance, a date or a
 * reference that would land on every later entry the rule books). When the person's account and code are the
 * rule's own (the adapted rule, or a slot rule with the same booking), the save sends that rule's own recipe,
 * name, Durchlaufkonto and next step, so a save that only adds a comment answers `unchanged` and writes no new
 * version (no autopilot grant ends, no clean-use count restarts); an edited text lands on its rest leg.
 */
import { isErr, type Err, type TillClient } from '../../lib/client';
import type { VorschlagItem } from '../Agent/vorschlagView';
import { booksLike, editableLeg, parseRules, ruleWords, type RuleInfo, type RuleLeg, type ShownSlot } from './lineContext';
import type { LineCommit } from './PendenzLine';

type T = (key: string, params?: Record<string, string | number>) => string;

/** What saving the rule came to. */
export type LineRuleOutcome =
  | { kind: 'saved'; standardId: string }
  | { kind: 'unchanged' | 'replaced' | 'noted' }
  | { kind: 'failed'; refusal: Err };

export type LineCommitOutcome =
  | { kind: 'refused'; refusal: Err; approved: boolean }
  /** A rule the person was not shown stands in the slot: nothing was booked; ask by name, then commit pinned to it. */
  | { kind: 'reconfirm'; slot: { id: string; name: string } }
  | { kind: 'done'; booked: boolean; bankTxnId: string | null; rule: LineRuleOutcome | null };

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** One key per click; the caller keeps it for that click's retry. */
export function newLineKey(actionId: string): string {
  return `d208-line:${actionId}:${crypto.randomUUID()}`;
}

/** The keys one click holds, and the values they were minted for. */
export interface LineKeys {
  book: string;
  rule: string;
  values: string;
}

/**
 * Critic D208 (4): the keys of a commit. A retry of the SAME values reuses the kept keys (a booking that landed
 * is never booked twice); changed values are a new click with new keys, because the engine memoises a refusal
 * under its key and would answer the corrected commit with the old refusal.
 */
export function lineKeysFor(kept: Map<string, LineKeys>, id: string, bankTxnId: string | null, v: LineCommit, pin: string | null, newRuleKey: (bankTxnId: string) => string): LineKeys {
  const values = JSON.stringify([v.text, v.accountId, v.taxCode, v.changed, v.textChanged, v.star, v.note ?? null, pin]);
  const held = kept.get(id);
  if (held !== undefined && held.values === values) return held;
  const fresh = { book: newLineKey(id), rule: newRuleKey(bankTxnId ?? id), values };
  kept.set(id, fresh);
  return fresh;
}

/** The `book_bank_line` input with the person's values, or null when the Vorschlag is no bank booking. */
export function bookingWithEdits(action: Pick<VorschlagItem, 'actionTool' | 'payload'>, v: LineCommit, key: string): Record<string, unknown> | null {
  if (action.actionTool !== 'book_bank_line' || typeof action.payload.bankTxnId !== 'string') return null;
  const target = rec(action.payload.target);
  const leg = editableLeg(action);
  let nextTarget: Record<string, unknown> = target;
  if (leg !== null && v.accountId !== null) {
    const first = rec((target.legs as unknown[] | undefined)?.[0]);
    const { taxCode: _old, account: _alias, ...rest } = first;
    nextTarget = { ...target, legs: [{ ...rest, accountId: v.accountId, ...(v.taxCode !== null ? { taxCode: v.taxCode } : {}) }] };
  }
  return {
    bankTxnId: action.payload.bankTxnId,
    target: nextTarget,
    ...(v.textChanged && v.text !== '' ? { text: v.text } : typeof action.payload.text === 'string' ? { text: action.payload.text } : {}),
    ...(Array.isArray(action.payload.attach) ? { attach: action.payload.attach } : {}),
    idempotencyKey: key,
  };
}

/**
 * The rule standing in the slot of this line NOW (counterparty and direction, no text), read whole so a save
 * can carry it over. `ok: false` when it cannot be read: the caller books nothing then.
 */
export async function readSlotRule(client: TillClient, workspaceId: string, bankTxnId: string): Promise<{ ok: true; rule: RuleInfo | null } | { ok: false }> {
  const inbox = await client.call('list_bank_inbox', { workspaceId, bankTxnId, status: 'all' });
  if (isErr(inbox.body)) return { ok: false };
  const line = ((inbox.body as { lines?: unknown }).lines as Record<string, unknown>[] | undefined)?.find((l) => l?.bankTxnId === bankTxnId);
  if (line === undefined || !Array.isArray(line.ruleIds)) return { ok: false };
  const ids = (line.ruleIds as unknown[]).filter((x): x is string => typeof x === 'string');
  if (ids.length === 0) return { ok: true, rule: null };
  const listed = await client.call('list_bank_standards', { workspaceId, scope: 'bank' });
  if (isErr(listed.body)) return { ok: false };
  const rules = parseRules(listed.body);
  return { ok: true, rule: ids.map((id) => rules.get(id)).find((r): r is RuleInfo => r !== undefined && r.matchText === null) ?? null };
}

/** The legs the save sends: the base rule's own recipe when the person booked as it does, else the person's one leg. */
function legsOf(v: LineCommit, base: RuleInfo | null, text: string | null): { legs: RuleLeg[]; keeps: boolean } | null {
  if (v.accountId === null) return null;
  const own = { accountId: v.accountId, taxCode: v.taxCode };
  if (base !== null && base.recipe.length > 0 && booksLike(base, [own])) {
    const legs = base.recipe.map((l) => ({ ...l }));
    const rest = legs.findIndex((l) => l.amount.kind === 'rest');
    if (text !== null && rest >= 0) legs[rest] = { ...(legs[rest] as RuleLeg), description: text };
    return { legs, keeps: true };
  }
  return { legs: [{ ...own, amount: { kind: 'rest' }, ...(text !== null ? { description: text } : {}) }], keeps: false };
}

/** Save (or adapt) the rule from the booked line. */
async function saveRule(client: TillClient, workspaceId: string, bankTxnId: string, v: LineCommit, rule: RuleInfo | null, slot: RuleInfo | null, key: string): Promise<LineRuleOutcome> {
  const text = v.textChanged && v.text !== '' ? v.text.slice(0, 120) : null;
  const base = rule ?? slot;
  const shaped = legsOf(v, base, text);
  if (shaped === null) return { kind: 'failed', refusal: { ok: false, error: 'invalid_input' } };
  // The comment only when the person edited it; a slot rule replaced by another booking takes its comment
  // with it (critic D208, 6: a comment about the old booking would contradict the new one).
  const replacing = rule === null && slot !== null && !shaped.keeps;
  const note = v.note !== undefined ? { note: v.note === '' ? null : v.note } : replacing && slot.note !== null ? { note: null } : {};
  const carry =
    base === null
      ? {}
      : {
          ...(base.label !== null ? { label: base.label } : {}),
          ...(base.followUpStandardId !== null ? { followUpStandardId: base.followUpStandardId } : {}),
          // The Durchlaufkonto belongs to the booking: kept only while the person books as the rule does (critic
          // D208 r2, LOW-C: changed accounts are booked without it, so the rule is saved without it).
          ...(shaped.keeps && base.viaAccountId !== null ? { viaAccountId: base.viaAccountId } : {}),
        };
  const body =
    rule !== null
      ? { workspaceId, standardId: rule.id, legs: shaped.legs, ...carry, ...(rule.matchText !== null ? { matchText: rule.matchText } : {}), ...note, idempotencyKey: key }
      : { workspaceId, fromBankTxnId: bankTxnId, legs: shaped.legs, ...carry, expectSlotStandardId: slot?.id ?? null, ...note, idempotencyKey: key };
  const res = await client.call('set_bank_standard', body);
  if (isErr(res.body)) return { kind: 'failed', refusal: res.body };
  const answer = res.body as { standard?: { id?: unknown }; supersededId?: unknown; unchanged?: unknown; noteChanged?: unknown };
  if (answer.unchanged === true) return { kind: answer.noteChanged === true ? 'noted' : 'unchanged' };
  if (typeof answer.supersededId === 'string' && answer.supersededId !== '') return { kind: 'replaced' };
  const id = answer.standard?.id;
  return typeof id === 'string' && id !== '' ? { kind: 'saved', standardId: id } : { kind: 'failed', refusal: { ok: false, error: 'invalid_answer' } };
}

/**
 * The commit. `shown` is the slot as the row showed it (a confirm by name passes the rule it named). `keys`
 * belong to the click (`lineKeysFor`). `book` sends the approval or the booking.
 */
export async function commitOpenLine(
  client: TillClient,
  workspaceId: string,
  action: VorschlagItem,
  v: LineCommit,
  rule: RuleInfo | null,
  shown: ShownSlot | { known: true; id: string | null },
  keys: { book: string; rule: string },
  t: T,
): Promise<LineCommitOutcome> {
  const bankTxnId = typeof action.payload.bankTxnId === 'string' ? action.payload.bankTxnId : null;
  // The slot is read BEFORE anything is booked; a rule there the person was not shown books nothing.
  let slot: RuleInfo | null = null;
  if (v.star && rule === null && bankTxnId !== null) {
    const read = await readSlotRule(client, workspaceId, bankTxnId);
    if (!read.ok) return { kind: 'refused', refusal: { ok: false, error: 'slot_unread' }, approved: false };
    slot = read.rule;
    const seen = !shown.known ? undefined : 'id' in shown ? shown.id : (shown.rule?.id ?? null);
    if (slot !== null && seen !== slot.id) return { kind: 'reconfirm', slot: { id: slot.id, name: ruleWords(t, slot) } };
  }
  const booking = v.changed ? bookingWithEdits(action, v, keys.book) : null;
  const res =
    booking !== null
      ? await client.call('book_bank_line', { workspaceId, ...booking })
      : await client.call('approve_drafted_action', { workspaceId, actionId: action.actionId });
  if (isErr(res.body)) return { kind: 'refused', refusal: res.body, approved: booking === null };
  const booked = bankTxnId !== null && (booking !== null || action.actionTool === 'book_bank_line');
  if (!v.star || bankTxnId === null) return { kind: 'done', booked, bankTxnId, rule: null };
  return { kind: 'done', booked, bankTxnId, rule: await saveRule(client, workspaceId, bankTxnId, v, rule, slot, keys.rule) };
}
