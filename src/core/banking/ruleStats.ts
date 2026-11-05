/**
 * N03 (D183), Buchungsregeln that learn: the EVIDENCE a rule carries. Two halves, both pure reads of what
 * the books already say, never edited (N03 §6b Fixed):
 *
 *   1. THE PROVENANCE of a booking (`computeRuleProvenance`): which rule's proposal stood on the line when
 *      it was booked, and whether the booking differed from that rule's own legs. `performBooking` asks it
 *      BEFORE it writes anything (once the booking's own entry is on the bank ledger, rung (a) would
 *      propose matching it) and binds the answer for the one decision writer (`withDecisionProvenance`,
 *      `bankLines.ts`), which stamps it on the decision row as it is inserted. N04's earned autonomy trusts
 *      exactly these two columns, so the comparison is written down once, here, and asserted per door.
 *   2. THE TRACK RECORD of a rule (`ruleStats`): uses, last use, changes, and the health flag over the last
 *      five uses, read off the provenance columns along the rule's version chain (`replaces_id`).
 *
 * WHAT "CHANGED" MEANS (N03 §2, the third paper-critic pass). The booked target's legs against the rule's
 * own legs on this line, as a MULTISET of (account, signed amount, tax code), plus the Durchlaufkonto. Text
 * and order are ignored, and so is a leg's `fx` (its conversion entry). An ASKED amount (and a `same` one)
 * matches any amount of its sign; when the recipe asks anything, its rest leg matches any amount (the rest
 * follows the asks). A computed (`factor`) leg must carry the computed amount: overriding it is a change.
 * A complete rule's rest leg must carry the line. The tax code a foreign-currency line drops is dropped from
 * the rule's legs too. The fee split the proposal offers (`withFeeSplit`) is the proposal as well, so the
 * plain and the split booking are both unchanged. Any other target kind, another rule's `rule` target, and
 * a booking of a line whose rule says "Nicht buchen" are changed.
 *
 * §H-TENANT on every query.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { getSetting } from '../settings/settings.js';
import { readBankTxnDetail } from './bankLines.js';
import type { BankLineLeg, BankTxnRow, BookableBankLineTarget, DecisionProvenance } from './bankLines.js';
import { ruleRungForLine } from './bankProposals.js';
import { factorAmountMinor, readLiveRule, recipeOfRow } from './bankStandards.js';
import type { RecipeLeg } from './bankStandards.js';

// --- 1. The provenance of a booking ------------------------------------------------------------------------

/** One leg the rule expects on a line: an exact signed amount, or any amount (of a sign, or of either). */
export interface ExpectedLeg {
  accountId: string;
  taxCode: string | null;
  /** The exact signed amount (positive in the line's direction), or null for any amount. */
  amountMinor: number | null;
  /** With `amountMinor` null: the sign the amount must have (1 or -1), or 0 for either sign. */
  sign: 1 | -1 | 0;
  /**
   * A `same` leg (critic, finding 3): the index, in the expected list, of the asked leg whose amount it
   * takes. Its booked amount must equal that leg's in size (each with its own sign).
   */
  tie?: number;
}

/** One booked leg, as compared: the account, the signed amount, the code (absent reads as null). */
export interface ComparedLeg {
  accountId: string;
  amountMinor: number;
  taxCode: string | null;
}

/**
 * The rule's own legs on a line of `lineMinor` (positive), or null when the recipe cannot be expanded on it
 * as it stands (a computed amount beyond a safe integer or not positive, a rest of 0: the proposal could only
 * be booked by overriding it, which is a change). Mirrors `expandRule` (`bankBooking.ts`) leg for leg, with
 * the asked amounts left open.
 */
export function expectedRuleLegs(legs: readonly RecipeLeg[], lineMinor: number, dropTaxCodes: boolean): ExpectedLeg[] | null {
  const asks = legs.some((l) => l.amount.kind === 'ask' || l.amount.kind === 'same');
  const out: ExpectedLeg[] = [];
  let fixed = 0;
  let restAt = -1;
  for (let i = 0; i < legs.length; i += 1) {
    const leg = legs[i]!;
    const taxCode = dropTaxCodes ? null : leg.taxCode;
    const sign: 1 | -1 = leg.against === true ? -1 : 1;
    if (leg.amount.kind === 'factor') {
      const amount = factorAmountMinor(lineMinor, leg.amount.num, leg.amount.den);
      if (amount === null || amount <= 0) return null;
      out.push({ accountId: leg.accountId, taxCode, amountMinor: sign * amount, sign });
      fixed += sign * amount;
    } else if (leg.amount.kind === 'ask') {
      out.push({ accountId: leg.accountId, taxCode, amountMinor: null, sign });
    } else if (leg.amount.kind === 'same') {
      // The recipe's indexes are the expected list's: one entry per leg, in order.
      out.push({ accountId: leg.accountId, taxCode, amountMinor: null, sign, tie: leg.amount.legIndex });
    } else {
      restAt = out.length;
      out.push({ accountId: leg.accountId, taxCode, amountMinor: null, sign: 0 });
    }
  }
  if (restAt < 0) return null;
  if (!asks) {
    const rest = lineMinor - fixed;
    if (rest === 0) return null;
    out[restAt] = { ...out[restAt]!, amountMinor: rest };
  }
  return out;
}

/**
 * The most pairings `legsMatch` tries before it gives up (security review of 2f9712e45): a give-up answers
 * "no match", which records the booking as CHANGED, the conservative answer. Far above what any real recipe
 * needs: legs on distinct accounts pair without a single retry.
 */
export const LEGS_MATCH_BUDGET = 20_000;

/**
 * Do the booked legs match the expected ones as a multiset? A search over the pairings: each expected leg
 * takes one booked leg of its account and code that fits it (the exact amount; any amount of its sign; any
 * non-zero amount for an open rest), and a `same` leg's booked amount must be its asked leg's in size.
 *
 * BOUNDED (security review of 2f9712e45: a plain search is exponential in the legs). Three things keep it
 * small, and a budget caps it whatever the input: exact legs are placed first, then the asked ones, then the
 * `same` legs, then the open rest; at each step only one booked leg per distinct (account, code, amount) is
 * tried, so identical legs never multiply the search; and a state that failed once is remembered (the next
 * leg to place, the booked legs used, and the sizes the asked legs a `same` copies were given), so no state
 * is searched twice. Past `LEGS_MATCH_BUDGET` steps the answer is no match. At most 20 legs on each side
 * (the recipe's bound), so the used legs fit in one integer mask.
 */
export function legsMatch(expected: readonly ExpectedLeg[], booked: readonly ComparedLeg[]): boolean {
  if (expected.length !== booked.length) return false;
  if (booked.length > 30) return false;
  const fits = (e: ExpectedLeg, b: ComparedLeg): boolean => {
    if (e.accountId !== b.accountId || e.taxCode !== b.taxCode) return false;
    if (e.amountMinor !== null) return b.amountMinor === e.amountMinor;
    if (e.sign !== 0) return Math.sign(b.amountMinor) === e.sign;
    return b.amountMinor !== 0;
  };
  const rank = (e: ExpectedLeg): number => (e.amountMinor !== null ? 0 : e.tie !== undefined ? 2 : e.sign !== 0 ? 1 : 3);
  const order = expected.map((_, i) => i).sort((a, b) => rank(expected[a]!) - rank(expected[b]!) || a - b);
  const sources = [...new Set(expected.flatMap((e) => (e.tie !== undefined ? [e.tie] : [])))];
  const pairedTo = new Array<number>(expected.length).fill(-1);
  const failed = new Set<string>();
  let steps = 0;
  const place = (k: number, used: number): boolean => {
    if (k === order.length) return true;
    steps += 1;
    if (steps > LEGS_MATCH_BUDGET) return false;
    const sizes = sources.map((i) => (pairedTo[i]! < 0 ? '' : String(Math.abs(booked[pairedTo[i]!]!.amountMinor)))).join(',');
    const state = `${k}|${used}|${sizes}`;
    if (failed.has(state)) return false;
    const ei = order[k]!;
    const e = expected[ei]!;
    const tried = new Set<string>();
    for (let bi = 0; bi < booked.length; bi += 1) {
      if ((used & (1 << bi)) !== 0) continue;
      const b = booked[bi]!;
      if (!fits(e, b)) continue;
      const same = `${b.accountId}|${b.taxCode ?? ''}|${b.amountMinor}`;
      if (tried.has(same)) continue;
      tried.add(same);
      if (e.tie !== undefined) {
        // The asked leg it copies is placed before it (rank 1 before rank 2), so its booked amount is known.
        const source = pairedTo[e.tie];
        if (source === undefined || source < 0 || Math.abs(booked[source]!.amountMinor) !== Math.abs(b.amountMinor)) continue;
      }
      pairedTo[ei] = bi;
      if (place(k + 1, used | (1 << bi))) return true;
      pairedTo[ei] = -1;
      if (steps > LEGS_MATCH_BUDGET) return false;
    }
    failed.add(state);
    return false;
  };
  return place(0, 0);
}

/** A target's legs as compared (text, order and `fx` dropped). */
function comparedLegsOf(legs: readonly BankLineLeg[]): ComparedLeg[] {
  return legs.map((l) => ({ accountId: l.accountId, amountMinor: l.amountMinor, taxCode: l.taxCode ?? null }));
}

/** What `performBooking` is about to book, as provenance reads it. */
export interface BookingIntent {
  /** The target as it books (a `rule` target already expanded to `accounts` by `expandRule`). */
  target: BookableBankLineTarget;
  /** The rule a `rule` target named, when the caller booked through one. */
  ruleId?: string | undefined;
}

/** No rule proposed the booking: both columns NULL. */
const NO_RULE: DecisionProvenance = { proposedRuleId: null, ruleChanged: null };

/**
 * N03: the provenance of booking `row` with `intent`, read BEFORE anything is written. The rule is the one
 * the ladder's rungs a to c2 put on the line now (`ruleRungForLine`, the light evaluator: no history, model,
 * journal or whole-book claim read). Null when an earlier rung speaks, when the line's rung offers several
 * rules (the picker), and when no rule speaks; otherwise the rule and the comparison the header defines.
 */
export function computeRuleProvenance(ctx: WorkspaceContext, row: BankTxnRow, intent: BookingIntent): DecisionProvenance {
  const rung = ruleRungForLine(ctx, row, readBankTxnDetail(ctx, row.id));
  if (rung.standardId === null || rung.proposal === null) return NO_RULE;
  const standardId = rung.standardId;
  const changed = (yes: boolean): DecisionProvenance => ({ proposedRuleId: standardId, ruleChanged: yes });
  // "Nicht buchen" proposed, and the line was booked anyway.
  if (rung.proposal.reasonCode === 'rule_ignore') return changed(true);
  // Booked through ANOTHER rule's `rule` target.
  if (intent.ruleId !== undefined && intent.ruleId !== standardId) return changed(true);
  const target = intent.target;
  if (target.kind !== 'accounts') return changed(true);
  const rule = readLiveRule(ctx, standardId);
  const recipe = rule === undefined ? null : recipeOfRow(rule);
  if (rule === undefined || recipe === null) return changed(true);
  if ((target.viaAccountId ?? null) !== rule.via_account_id) return changed(true);
  const booked = comparedLegsOf(target.legs);
  const expected = expectedRuleLegs(recipe, row.amount_minor, rung.proposal.reasonParams['vatDropped'] === true);
  if (expected !== null && legsMatch(expected, booked)) return changed(false);
  // The fee split the proposal offered (or prefilled) beside it is the proposal too.
  const split = rung.feeSplitLegs;
  if (split !== null && legsMatch(comparedLegsOf(split).map((l) => ({ ...l, sign: 0 as const })), booked)) return changed(false);
  return changed(true);
}

// --- 2. The track record of a rule ------------------------------------------------------------------------

/** One rule's track record, read off the provenance of its versions' bookings. */
export interface BankRuleStats {
  /** The live rule (the head of its version chain). */
  standardId: string;
  /** Every version of the rule, newest first (the head first). */
  versionIds: string[];
  /** Live bookings any version proposed. */
  uses: number;
  /** When the newest of them was booked (its decision's moment), or null when there is none. */
  lastUsedAt: string | null;
  /** How many of them the person changed. */
  changed: number;
  /** The last five uses, and how many of them were changed. */
  lastFive: { uses: number; changed: number };
  /** Uses and changes of the CURRENT version only (what N04's offer counts). */
  currentVersion: { uses: number; changed: number };
  /** `adjust` when at least `rules.health_changed_of_last5` of the last five uses were changed, else `ok`. */
  health: 'ok' | 'adjust';
}

export type BankRuleStatsOk = { stats: BankRuleStats[]; healthThreshold: number };

interface ChainRow {
  id: string;
  replaces_id: string | null;
  superseded_at: string | null;
  scope: string;
}

/**
 * N03 (D183 §4): every live BANK rule's track record, or one rule's (`standardId`: a live rule of this
 * workspace, else `rule_not_found`). A use is a LIVE booking decision (a reopened booking is gone; its
 * rebooking counts on its own) whose `proposed_rule_id` is a version of the rule, found by following
 * `replaces_id` from the live head back to the first version. Bookings made before N03 carry no provenance
 * and count nowhere. Read-only; the registry's A24 gate asks the read right of `list_bank_standards`.
 */
export function ruleStats(ctx: WorkspaceContext, input: { standardId?: unknown } = {}): Result<BankRuleStatsOk> {
  const wanted = input.standardId;
  if (wanted !== undefined && wanted !== null && (typeof wanted !== 'string' || wanted.length === 0)) return err('invalid_input', { field: 'standardId' });
  const rows = ctx.store.db
    .prepare('SELECT id, replaces_id, superseded_at, scope FROM bank_standard WHERE workspace_id = ?')
    .all(ctx.workspaceId) as ChainRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const heads = rows.filter((r) => r.superseded_at === null && r.scope === 'bank' && (typeof wanted !== 'string' || r.id === wanted));
  if (typeof wanted === 'string' && heads.length === 0) {
    return err('rule_not_found', { standardId: wanted, reason: 'no live bank rule of this workspace has this id (another workspace\'s, a Vorlage, or already superseded)' });
  }
  const versionOf = new Map<string, string>();
  const chains = new Map<string, string[]>();
  for (const head of heads) {
    const chain: string[] = [];
    // A chain only ever points at OLDER rows, so it ends; the seen-set is the belt to that brace.
    for (let at: ChainRow | undefined = head; at !== undefined && !chain.includes(at.id); at = at.replaces_id === null ? undefined : byId.get(at.replaces_id)) {
      chain.push(at.id);
      versionOf.set(at.id, head.id);
    }
    chains.set(head.id, chain);
  }
  const threshold = getSetting<number>(ctx, 'rules.health_changed_of_last5');
  const uses = ctx.store.db
    .prepare(
      `SELECT proposed_rule_id AS ruleId, rule_changed AS changed, created_at AS at
         FROM bank_line_decision
        WHERE workspace_id = ? AND superseded_at IS NULL AND proposed_rule_id IS NOT NULL
        ORDER BY created_at DESC, rowid DESC`,
    )
    .all(ctx.workspaceId) as { ruleId: string; changed: number | null; at: string }[];
  const perHead = new Map<string, { ruleId: string; changed: boolean; at: string }[]>();
  for (const u of uses) {
    const head = versionOf.get(u.ruleId);
    if (head === undefined) continue;
    const list = perHead.get(head) ?? [];
    list.push({ ruleId: u.ruleId, changed: u.changed === 1, at: u.at });
    perHead.set(head, list);
  }
  const stats: BankRuleStats[] = heads.map((head) => {
    const list = perHead.get(head.id) ?? [];
    const lastFive = list.slice(0, 5);
    const lastFiveChanged = lastFive.filter((u) => u.changed).length;
    const current = list.filter((u) => u.ruleId === head.id);
    return {
      standardId: head.id,
      versionIds: chains.get(head.id) ?? [head.id],
      uses: list.length,
      lastUsedAt: list[0]?.at ?? null,
      changed: list.filter((u) => u.changed).length,
      lastFive: { uses: lastFive.length, changed: lastFiveChanged },
      currentVersion: { uses: current.length, changed: current.filter((u) => u.changed).length },
      health: lastFiveChanged >= threshold ? 'adjust' : 'ok',
    };
  });
  return ok<BankRuleStatsOk>({ stats, healthThreshold: threshold });
}
