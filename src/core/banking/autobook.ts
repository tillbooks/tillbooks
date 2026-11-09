/**
 * N04 (D183), Autopilot: a Buchungsregel that EARNED the right to book its own lines.
 *
 * WHAT THIS IS. After a person booked a rule's proposal unchanged often enough, TILL offers "künftig
 * automatisch" for that rule only (a `system`-drafted Vorschlag of `grant_rule_autobook`, no dial family).
 * A PERSON grants it (a governed seat is refused `human_only` under every dial, before a Vorschlag is
 * drafted and at execution alike). From then on the scheduler tick (never the import verb) books the rule's
 * NEW lines through `book_bank_line`, as the granter, and only when every one of these holds:
 *
 *   1. the line's FULL-ladder proposal is this rule's own `sure` rung (an existing entry, a reference, an
 *      own-account transfer or another rule outranks it: no double booking, D139 §7 for transfers);
 *   2. the grant is live (not suspended, not revoked, its rule version still the live one, `rules.autobook`
 *      not `off`);
 *   3. the line is in the ceiling's currency and within the ceiling FIXED at grant time;
 *   4. the line's period is open;
 *   5. the granter still holds `post`, live, and is not a governed seat (else the grant is suspended).
 *
 * Anything else leaves the line a normal proposal and records why ("nicht automatisch"). Each (grant,
 * line) pair is decided ONCE (`autobook_run`, UNIQUE), and a line is autobooked at most once EVER (a partial
 * unique index on the booked rows), so a re-run, a reopen and a re-grant never book a line twice. The key
 * is `autobook:<grantId>:<bankTxnId>` (a reserved prefix: no caller can squat it) and the decision row
 * carries the channel `autobook:<ruleId>` (OR 957a: the booking names its rule; `granted_by` the person).
 *
 * WHAT ENDS IT. `reopen_bank_line` or `reverse_payment` on an autobooked line suspends the grant that
 * booked it; a booking of the rule's proposal that CHANGED it suspends its live grant (setting
 * `rules.autobook_suspend_on_change`); an edit of the rule makes a new version, which ends the grant; a
 * person revokes it ("Automatik aus"). A suspension and a changed booking reset the clean count.
 *
 * Everything here is §H-TENANT: every query names `workspace_id`.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Err, Result } from '../result.js';
import { answeredSetting, getSetting } from '../settings/settings.js';
import { isGovernedSeat } from '../access/capability.js';
import { enqueueDraftedAction } from '../agent/draftedActions.js';
import { approvingActionIds } from '../agent/approving.js';
import { requireString } from '../ledger/inputGuards.js';
import { normalizeIban } from '../setup/iban.js';
import { lineBookingDate, lineStateOf, readBankTxnDetail, withDecisionChannel } from './bankLines.js';
import type { BankTxnRow } from './bankLines.js';
import { fullLadderWhereRuleSpeaks, ruleRungAlone, ruleRungContext } from './bankProposals.js';
import type { BankLineProposal } from './bankProposals.js';
import { readLiveRule, readRuleRow, recipeOfRow, restLegIndex, ruleInvalidReason, standardKeyOfLine } from './bankStandards.js';
import type { BankStandardRow } from './bankStandards.js';
import { zurichParts } from './ebics/autoSync.js';
import { STATEMENT_COVERS_SQL } from './bankInbox.js';
import { receiptExpected } from './belegEvidence.js';
import { BELEG_READ_CAPABILITY, holdsRead } from './belegMatch.js';
import { reconcileEngineAssignments } from './belegAssignment.js';
import type { EngineAssignReport } from './belegAssignment.js';
import { activeAssignmentOf, withAssignmentConsumption } from './belegAssignmentStore.js';
import { receiptHolderGuard } from '../files/receiptGuard.js';
import { assignmentVerdict } from './belegVerdict.js';
import type { AutobookWaitReason } from './belegVerdict.js';
export { AUTOBOOK_WAIT_REASONS } from './belegVerdict.js';
export type { AutobookWaitReason } from './belegVerdict.js';

// --- Vocabulary ------------------------------------------------------------------------------------------

/** The actor the step drafts its offers as, and records its own rows under. */
export const AUTOBOOK_SYSTEM_ACTOR = 'system';

/** The reserved idempotency-key prefix of an automatic booking (`RESERVED_IDEMPOTENCY_KEY_PREFIXES`). */
export const AUTOBOOK_KEY_PREFIX = 'autobook:';

/** The key an automatic booking of `bankTxnId` under `grantId` runs `book_bank_line` with. */
export function autobookKey(grantId: string, bankTxnId: string): string {
  return `${AUTOBOOK_KEY_PREFIX}${grantId}:${bankTxnId}`;
}

/** The channel stamped on an automatic booking's decision row: the rule version that booked it. */
export function autobookChannel(ruleId: string): string {
  return `autobook:${ruleId}`;
}

/** Is this decision channel an automatic booking's? */
export function isAutobookChannel(channel: string | null | undefined): boolean {
  return typeof channel === 'string' && channel.startsWith('autobook:');
}

/** The Vorschlag-row key prefix of an offer (only `system` rows answer for it). */
export const AUTOBOOK_OFFER_KEY_PREFIX = 'autobook-offer:';

/** Why a rule can never book on its own (as it stands), stable codes the Studio renders. */
export const AUTOBOOK_INELIGIBLE_REASONS = [
  'not_a_bank_rule',
  'ignore_rule',
  'name_key',
  // D188: a counterparty read from the booking text (`card:`, `bank:`), under `rules.autobook_derived_keys`.
  'derived_key',
  'via_account',
  'own_account',
  'rule_invalid',
  'asks_amount',
  'mode_not_bulk',
] as const;
export type AutobookIneligibleReason = (typeof AUTOBOOK_INELIGIBLE_REASONS)[number];

/** Why a line of a granted rule was NOT booked automatically ("nicht automatisch"). */
export const AUTOBOOK_NOT_BOOKED_REASONS = [
  'outranked',
  'not_sure',
  'currency',
  'over_ceiling',
  'period_locked',
  'refused',
] as const;
export type AutobookNotBookedReason = (typeof AUTOBOOK_NOT_BOOKED_REASONS)[number];

/**
 * A41.3 re-cut v2 (D184 point 2): is `rules.autobook_requires_beleg` on? Then a granted rule books a line that
 * expects a receipt only with the line's ASSIGNED receipt (`belegVerdict.ts`), attached in the booking's own
 * transaction; otherwise the line waits ("wartet auf Beleg") and is never recorded.
 */
export function autobookRequiresBeleg(ctx: WorkspaceContext): boolean {
  return getSetting<string>(ctx, 'rules.autobook_requires_beleg') === 'on';
}

/** Why a grant paused itself. */
export const AUTOBOOK_SUSPEND_REASONS = ['reopened', 'payment_reversed', 'changed_booking', 'granter_lost_capability'] as const;
export type AutobookSuspendReason = (typeof AUTOBOOK_SUSPEND_REASONS)[number];

/** A grant's state, derived (never stored as a word). */
export const AUTOBOOK_GRANT_STATES = ['active', 'suspended', 'revoked', 'ended', 'stopped'] as const;
export type AutobookGrantState = (typeof AUTOBOOK_GRANT_STATES)[number];

const SETTING = 'rules.autobook';
const OFFER_AFTER = 'rules.autobook_offer_after';
/** A41.7: the lowest threshold a person may answer (the setting's own minimum): the card asks from there. */
const OFFER_AFTER_MIN = 3;

/**
 * A41.7 (D184 point 6): `rules.autobook_offer_after` is ASK FIRST. While no person answered it, no offer is
 * drafted and no grant is made (`needs_setting_answer`); the rule card asks the threshold first.
 */
function offerAfterAnswer(ctx: WorkspaceContext): number | null {
  return answeredSetting<number>(ctx, OFFER_AFTER);
}
const HEADROOM = 'rules.autobook_amount_headroom';
const SUSPEND_ON_CHANGE = 'rules.autobook_suspend_on_change';
const SCOPE = 'rules.autobook_scope';

/** Is the autopilot on for this workspace (`rules.autobook` = `offer`)? */
export function autobookOn(ctx: WorkspaceContext): boolean {
  return getSetting<string>(ctx, SETTING) !== 'off';
}

/** The Swiss calendar day of an instant: the digest's day. */
export function swissDay(instant: string): string {
  return zurichParts(instant).date;
}

// --- Rows ----------------------------------------------------------------------------------------------

interface GrantRow {
  id: string;
  workspace_id: string;
  standard_id: string;
  granted_by: string;
  granted_at: string;
  amount_ceiling_minor: number;
  ceiling_currency: string;
  clean_uses: number;
  suspended_at: string | null;
  suspended_reason: string | null;
  revoked_at: string | null;
  revoked_by: string | null;
}

/** A grant as every read answers it. */
export interface AutobookGrant {
  grantId: string;
  standardId: string;
  state: AutobookGrantState;
  grantedBy: string;
  grantedAt: string;
  ceilingMinor: number;
  currency: string;
  cleanUsesAtGrant: number;
  suspendedAt: string | null;
  suspendedReason: string | null;
  revokedAt: string | null;
}

function grantState(ctx: WorkspaceContext, g: GrantRow, on: boolean): AutobookGrantState {
  if (g.revoked_at !== null) return 'revoked';
  if (g.suspended_at !== null) return 'suspended';
  if (readLiveRule(ctx, g.standard_id) === undefined) return 'ended';
  return on ? 'active' : 'stopped';
}

function grantView(ctx: WorkspaceContext, g: GrantRow, on: boolean): AutobookGrant {
  return {
    grantId: g.id,
    standardId: g.standard_id,
    state: grantState(ctx, g, on),
    grantedBy: g.granted_by,
    grantedAt: g.granted_at,
    ceilingMinor: g.amount_ceiling_minor,
    currency: g.ceiling_currency,
    cleanUsesAtGrant: g.clean_uses,
    suspendedAt: g.suspended_at,
    suspendedReason: g.suspended_reason,
    revokedAt: g.revoked_at,
  };
}

/** The live (not suspended, not revoked) grant on this rule VERSION, or undefined. */
function liveGrantOn(ctx: WorkspaceContext, standardId: string): GrantRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM rule_autobook_grant WHERE workspace_id = ? AND standard_id = ? AND suspended_at IS NULL AND revoked_at IS NULL')
    .get(ctx.workspaceId, standardId) as GrantRow | undefined;
}

/** Every version of a rule, from `standardId` back to its first (`replaces_id`, N03's chain). */
function versionsBack(ctx: WorkspaceContext, standardId: string): string[] {
  const out: string[] = [];
  const step = ctx.store.db.prepare('SELECT replaces_id AS r FROM bank_standard WHERE workspace_id = ? AND id = ?');
  for (let at: string | null = standardId; at !== null && !out.includes(at); ) {
    const row = step.get(ctx.workspaceId, at) as { r: string | null } | undefined;
    if (row === undefined) break;
    out.push(at);
    at = row.r;
  }
  return out;
}

/** The newest grant on any version of the rule (newest version first), or undefined. */
function newestGrantOfRule(ctx: WorkspaceContext, standardId: string): GrantRow | undefined {
  const versions = versionsBack(ctx, standardId);
  if (versions.length === 0) return undefined;
  const marks = versions.map(() => '?').join(', ');
  return ctx.store.db
    .prepare(`SELECT * FROM rule_autobook_grant WHERE workspace_id = ? AND standard_id IN (${marks}) ORDER BY granted_at DESC, rowid DESC LIMIT 1`)
    .get(ctx.workspaceId, ...versions) as GrantRow | undefined;
}

// --- Eligibility ---------------------------------------------------------------------------------------

/** The IBANs of the workspace's own Bankkonten, normalised: a transfer between them never autobooks. */
function ownIbans(ctx: WorkspaceContext): Set<string> {
  const rows = ctx.store.db.prepare('SELECT iban FROM bank_account WHERE workspace_id = ?').all(ctx.workspaceId) as { iban: string | null }[];
  return new Set(rows.flatMap((r) => (typeof r.iban === 'string' && r.iban.length > 0 ? [normalizeIban(r.iban)] : [])));
}

export type AutobookEligibility = { eligible: true; kind: 'complete' | 'computed' } | { eligible: false; reason: AutobookIneligibleReason };

/**
 * Can this rule, as it stands, ever book on its own? A bank rule (not a Vorlage) that books legs (not
 * "Nicht buchen"), keyed by IBAN (a name key could be another business), with no Durchlaufkonto, not an
 * own-account transfer, valid now, asking no amount, and whose rung can be `sure` under the CURRENT
 * settings: a complete rule needs `bank.buchungsregel_mode` = `bulk`, a computed one
 * `bank.buchungsregel_computed_mode` = `bulk`.
 */
export function autobookEligibility(ctx: WorkspaceContext, rule: BankStandardRow): AutobookEligibility {
  if (rule.scope !== 'bank') return { eligible: false, reason: 'not_a_bank_rule' };
  if (rule.outcome !== 'legs') return { eligible: false, reason: 'ignore_rule' };
  // D188 (A39 §21): a DERIVED key (the merchant of a card text, the account's own bank for a fee) books
  // unattended only as `rules.autobook_derived_keys` allows: by default (`all`, the owner's pick) both may,
  // after the person's grant and with every other check below; `bank_fees` only the own bank's fee lines (a
  // merchant text, like a name, could be another business); `off` neither. Every other non-IBAN key is a name
  // and never may.
  if (rule.counterparty_key.startsWith('card:') || rule.counterparty_key.startsWith('bank:')) {
    const allowed = getSetting<string>(ctx, 'rules.autobook_derived_keys');
    const ok = allowed === 'all' || (allowed === 'bank_fees' && rule.counterparty_key.startsWith('bank:'));
    if (!ok) return { eligible: false, reason: 'derived_key' };
  } else if (!rule.counterparty_key.startsWith('iban:')) {
    return { eligible: false, reason: 'name_key' };
  }
  if (rule.via_account_id !== null) return { eligible: false, reason: 'via_account' };
  if (ownIbans(ctx).has(rule.counterparty_key.slice('iban:'.length))) return { eligible: false, reason: 'own_account' };
  const legs = recipeOfRow(rule);
  if (legs === null || legs.length === 0 || ruleInvalidReason(ctx, rule) !== null) return { eligible: false, reason: 'rule_invalid' };
  if (legs.some((l) => l.amount.kind === 'ask' || l.amount.kind === 'same')) return { eligible: false, reason: 'asks_amount' };
  if (legs.some((l) => l.amount.kind === 'factor')) {
    return getSetting<string>(ctx, 'bank.buchungsregel_computed_mode') === 'bulk' ? { eligible: true, kind: 'computed' } : { eligible: false, reason: 'mode_not_bulk' };
  }
  if (legs.length !== 1 || restLegIndex(legs) !== 0) return { eligible: false, reason: 'rule_invalid' };
  return getSetting<string>(ctx, 'bank.buchungsregel_mode') === 'suggest' ? { eligible: false, reason: 'mode_not_bulk' } : { eligible: true, kind: 'complete' };
}

// --- Clean uses and the ceiling ------------------------------------------------------------------------

/** One clean use of a rule version: a live, unchanged booking of its proposal. */
export interface CleanUse {
  bankTxnId: string;
  at: string;
  amountMinor: number;
  currency: string;
  /** Confirmed by a person: no channel, and booked by neither `system` nor a governed seat. */
  human: boolean;
}

/**
 * The CLEAN uses of one rule version, newest first: live booking decisions (a reopened booking is gone)
 * whose `proposed_rule_id` is this version and whose `rule_changed` is 0, made after the RESET point: the
 * later of this version's newest changed use (reopened or not: the change happened) and the end of its
 * newest grant (a suspension or a revocation). Bookings made before N03 carry no provenance and never count.
 */
export function cleanUsesOf(ctx: WorkspaceContext, standardId: string): { uses: CleanUse[]; since: string | null } {
  const changed = ctx.store.db
    .prepare('SELECT MAX(created_at) AS at FROM bank_line_decision WHERE workspace_id = ? AND proposed_rule_id = ? AND rule_changed = 1')
    .get(ctx.workspaceId, standardId) as { at: string | null };
  const ended = ctx.store.db
    .prepare(
      `SELECT MAX(at) AS at FROM (
         SELECT suspended_at AS at FROM rule_autobook_grant WHERE workspace_id = ? AND standard_id = ? AND suspended_at IS NOT NULL
         UNION ALL
         SELECT revoked_at AS at FROM rule_autobook_grant WHERE workspace_id = ? AND standard_id = ? AND revoked_at IS NOT NULL)`,
    )
    .get(ctx.workspaceId, standardId, ctx.workspaceId, standardId) as { at: string | null };
  const since = [changed.at, ended.at].filter((x): x is string => typeof x === 'string').sort().pop() ?? null;
  const rows = ctx.store.db
    .prepare(
      `SELECT d.bank_txn_id AS txn, d.created_at AS at, d.created_by AS by, d.channel AS channel, t.amount_minor AS amount, t.currency AS currency
         FROM bank_line_decision d JOIN bank_txn t ON t.workspace_id = d.workspace_id AND t.id = d.bank_txn_id
        WHERE d.workspace_id = ? AND d.proposed_rule_id = ? AND d.rule_changed = 0 AND d.superseded_at IS NULL
          AND d.state = 'booked' AND (? IS NULL OR d.created_at > ?)
        ORDER BY d.created_at DESC, d.rowid DESC`,
    )
    .all(ctx.workspaceId, standardId, since, since) as { txn: string; at: string; by: string | null; channel: string | null; amount: number; currency: string }[];
  const uses = rows.map((r) => ({
    bankTxnId: r.txn,
    at: r.at,
    amountMinor: r.amount,
    currency: r.currency,
    human: r.channel === null && r.by !== null && r.by !== AUTOBOOK_SYSTEM_ACTOR && !isGovernedSeat(ctx.store, r.by),
  }));
  return { uses, since };
}

/**
 * The ceiling a grant would be fixed at: the largest HUMAN-confirmed clean use in the currency of the newest
 * human-confirmed one, times `rules.autobook_amount_headroom` percent, rounded down. Null without one.
 */
export function ceilingOf(ctx: WorkspaceContext, uses: readonly CleanUse[]): { amountMinor: number; currency: string } | null {
  const human = uses.filter((u) => u.human);
  const newest = human[0];
  if (newest === undefined) return null;
  const currency = newest.currency;
  const largest = Math.max(...human.filter((u) => u.currency === currency).map((u) => u.amountMinor));
  const headroom = getSetting<number>(ctx, HEADROOM);
  const amountMinor = Math.floor((largest * headroom) / 100);
  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) return null;
  return { amountMinor, currency };
}

// --- grant_rule_autobook ------------------------------------------------------------------------------

export interface GrantRuleAutobookInput {
  standardId?: unknown;
  idempotencyKey?: unknown;
  /** The offer's facts, stored in its Vorschlag for Pendenzen; ignored here. */
  offerFacts?: unknown;
}

export type GrantRuleAutobookOk = { grant: AutobookGrant; alreadyGranted: boolean };

/** The refusal every governed seat gets for a grant, under every dial, as a call and as a proposal. */
export function grantHumanOnly(ctx: WorkspaceContext): Err | undefined {
  if (!isGovernedSeat(ctx.store, ctx.actor)) return undefined;
  return err('human_only', { reason: 'only a person switches a rule to book on its own; an agent can neither do it nor propose it' }) as Err;
}

/**
 * A PERSON switches one rule version to book its lines on its own. Refused for a governed seat
 * (`human_only`), while `rules.autobook` is `off` (`autobook_off`), for a rule that is not a live bank rule
 * of this workspace (`rule_not_found`), one that can never be sure (`autobook_not_eligible` with the
 * reason), one that has not earned it (`autobook_not_earned`: fewer clean uses than
 * `rules.autobook_offer_after`), and one with no clean use a person confirmed (`autobook_no_human_use`).
 * A version with a live grant answers it (`alreadyGranted`). The ceiling and its currency are fixed on the
 * row now. Any pending offer for the rule closes.
 */
export function grantRuleAutobook(ctx: WorkspaceContext, input: GrantRuleAutobookInput): Result<GrantRuleAutobookOk> {
  const human = grantHumanOnly(ctx);
  if (human !== undefined) return human;
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input.standardId, 'standardId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const standardId = input.standardId as string;
  const scopedKey = JSON.stringify(['grant_rule_autobook', standardId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<GrantRuleAutobookOk>>(ctx.workspaceId, scopedKey, 'grant_rule_autobook');
  if (replayed !== undefined) return replayed;
  if (!autobookOn(ctx)) return err('autobook_off', { setting: SETTING, reason: 'automatic booking is switched off for this workspace (rules.autobook = off)' });
  const rule = readLiveRule(ctx, standardId);
  if (rule === undefined || rule.scope !== 'bank') {
    return err('rule_not_found', { standardId, reason: 'no live bank rule of this workspace has this id (another workspace\'s, a Vorlage, or already edited or removed)' });
  }
  const eligibility = autobookEligibility(ctx, rule);
  if (!eligibility.eligible) return err('autobook_not_eligible', { standardId, reason: eligibility.reason });
  const standing = liveGrantOn(ctx, standardId);
  if (standing !== undefined) return ok<GrantRuleAutobookOk>({ grant: grantView(ctx, standing, true), alreadyGranted: true });
  // The refusals are answered BEFORE the memo: a rule that earns its grant later is granted under the same key.
  const { uses } = cleanUsesOf(ctx, standardId);
  const needed = offerAfterAnswer(ctx);
  if (needed === null) {
    return err('needs_setting_answer', {
      key: OFFER_AFTER,
      suggestion: getSetting<number>(ctx, OFFER_AFTER),
      reason: 'a person first decides after how many unchanged bookings a rule may book on its own (settings_set, human only)',
    });
  }
  if (uses.length < needed) return err('autobook_not_earned', { standardId, cleanUses: uses.length, needed });
  const ceiling = ceilingOf(ctx, uses);
  if (ceiling === null) return err('autobook_no_human_use', { standardId, reason: 'no unchanged booking of this rule was confirmed by a person, so there is no amount to fix a ceiling from' });
  // Critic N04 F2: what the person saw is what they grant. An offer (or the rule card's switch) carries the
  // ceiling it showed; when the ceiling now differs, the grant refuses `offer_stale` and the next tick
  // re-drafts the offer with the fresh figures. Never a higher (or another currency's) ceiling than shown.
  const shown = storedOfferFacts(input as Record<string, unknown>);
  if (shown !== null && (shown.standardId !== standardId || shown.ceilingMinor !== ceiling.amountMinor || shown.currency !== ceiling.currency)) {
    return err('offer_stale', {
      standardId,
      shownCeilingMinor: shown.ceilingMinor,
      shownCurrency: shown.currency,
      ceilingMinor: ceiling.amountMinor,
      currency: ceiling.currency,
      reason: 'the ceiling changed since it was shown; nothing was switched on, and a fresh offer follows',
    });
  }
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'grant_rule_autobook', () => {
    // Under the write lock: another window may have granted it meanwhile (the partial unique index would refuse a second).
    const existing = liveGrantOn(ctx, standardId);
    if (existing !== undefined) return ok<GrantRuleAutobookOk>({ grant: grantView(ctx, existing, true), alreadyGranted: true });
    const id = ctx.ids.next('agrant');
    const at = ctx.clock.now();
    ctx.store.db
      .prepare(
        `INSERT INTO rule_autobook_grant (id, workspace_id, standard_id, granted_by, granted_at, amount_ceiling_minor, ceiling_currency, clean_uses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, ctx.workspaceId, standardId, ctx.actor, at, ceiling.amountMinor, ceiling.currency, uses.length);
    ctx.audit.record({ entityKind: 'rule_autobook_grant', entityId: id, action: 'create', actor: ctx.actor, at });
    voidOffers(ctx, (s) => s === standardId);
    const row = ctx.store.db.prepare('SELECT * FROM rule_autobook_grant WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, id) as GrantRow;
    return ok<GrantRuleAutobookOk>({ grant: grantView(ctx, row, true), alreadyGranted: false });
  });
}

// --- revoke_rule_autobook -----------------------------------------------------------------------------

export interface RevokeRuleAutobookInput {
  standardId?: unknown;
  idempotencyKey?: unknown;
}

export type RevokeRuleAutobookOk = { revokedGrantIds: string[] };

/**
 * "Automatik aus": revoke every not-yet-revoked grant on the rule (`standardId`: any version; its chain
 * back to the first version is read), live, suspended or ended alike, so nothing of it can book again. Any
 * pending offer for that version closes. `no_live_grant` when there is nothing to revoke.
 */
export function revokeRuleAutobook(ctx: WorkspaceContext, input: RevokeRuleAutobookInput): Result<RevokeRuleAutobookOk> {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;
  const guard = requireString(input.standardId, 'standardId') ?? requireString(input.idempotencyKey, 'idempotencyKey');
  if (guard) return guard;
  const standardId = input.standardId as string;
  const scopedKey = JSON.stringify(['revoke_rule_autobook', standardId, input.idempotencyKey]);
  const replayed = ctx.store.recallIdempotent<Result<RevokeRuleAutobookOk>>(ctx.workspaceId, scopedKey, 'revoke_rule_autobook');
  if (replayed !== undefined) return replayed;
  if (readRuleRow(ctx, standardId) === undefined) return err('rule_not_found', { standardId });
  const versions = versionsBack(ctx, standardId);
  const marks = versions.map(() => '?').join(', ');
  const open = ctx.store.db
    .prepare(`SELECT id FROM rule_autobook_grant WHERE workspace_id = ? AND standard_id IN (${marks}) AND revoked_at IS NULL`)
    .all(ctx.workspaceId, ...versions) as { id: string }[];
  if (open.length === 0) return err('no_live_grant', { standardId, reason: 'this rule has no automatic booking to switch off' });
  return ctx.store.rememberIdempotent(ctx.workspaceId, scopedKey, 'revoke_rule_autobook', () => {
    const at = ctx.clock.now();
    const stamp = ctx.store.db.prepare('UPDATE rule_autobook_grant SET revoked_at = ?, revoked_by = ? WHERE workspace_id = ? AND id = ? AND revoked_at IS NULL');
    const revoked: string[] = [];
    for (const g of open) {
      if (stamp.run(at, ctx.actor, ctx.workspaceId, g.id).changes === 1) {
        revoked.push(g.id);
        ctx.audit.record({ entityKind: 'rule_autobook_grant', entityId: g.id, action: 'close', actor: ctx.actor, at });
      }
    }
    voidOffers(ctx, (s) => versions.includes(s));
    return ok<RevokeRuleAutobookOk>({ revokedGrantIds: revoked });
  });
}

// --- Suspension (the hooks) ----------------------------------------------------------------------------

/** Pause one live grant with its reason; true when this call paused it. Inside the caller's transaction. */
export function suspendGrant(ctx: WorkspaceContext, grantId: string, reason: AutobookSuspendReason): boolean {
  const at = ctx.clock.now();
  const changed = ctx.store.db
    .prepare('UPDATE rule_autobook_grant SET suspended_at = ?, suspended_reason = ? WHERE workspace_id = ? AND id = ? AND suspended_at IS NULL AND revoked_at IS NULL')
    .run(at, reason, ctx.workspaceId, grantId).changes;
  if (changed !== 1) return false;
  ctx.audit.record({ entityKind: 'rule_autobook_grant', entityId: grantId, action: 'update', actor: ctx.actor, at });
  return true;
}

/** The grant that autobooked this line, when one did. */
function grantThatBooked(ctx: WorkspaceContext, bankTxnId: string): string | undefined {
  const row = ctx.store.db
    .prepare("SELECT grant_id AS g FROM autobook_run WHERE workspace_id = ? AND bank_txn_id = ? AND outcome = 'booked'")
    .get(ctx.workspaceId, bankTxnId) as { g: string } | undefined;
  return row?.g;
}

/**
 * HOOK (`reopen_bank_line`, after the decision was superseded): undoing an AUTOMATIC booking pauses the
 * grant that booked it, with the reason `reopened`, which also resets the rule's clean count. A manual
 * booking's undo changes nothing here. Inside the reopen's own transaction.
 */
export function autobookAfterReopen(ctx: WorkspaceContext, supersededLinkId: string | null): void {
  if (supersededLinkId === null) return;
  const decision = ctx.store.db
    .prepare('SELECT bank_txn_id AS txn, channel FROM bank_line_decision WHERE workspace_id = ? AND link_id = ?')
    .get(ctx.workspaceId, supersededLinkId) as { txn: string; channel: string | null } | undefined;
  if (decision === undefined || !isAutobookChannel(decision.channel)) return;
  const grantId = grantThatBooked(ctx, decision.txn);
  if (grantId !== undefined) suspendGrant(ctx, grantId, 'reopened');
}

/**
 * HOOK (`reverse_payment`): reversing a payment an automatic booking created pauses the grant that booked
 * it (`payment_reversed`). A rule books accounts, never a payment, so today this finds nothing; it is the
 * spec's second undo door, kept so a future settling rule cannot slip past it. Inside the reversal's own
 * transaction.
 */
export function autobookAfterPaymentReversed(ctx: WorkspaceContext, paymentId: string): void {
  const rows = ctx.store.db
    .prepare("SELECT DISTINCT bank_txn_id AS txn FROM bank_line_decision WHERE workspace_id = ? AND payment_id = ? AND channel LIKE 'autobook:%'")
    .all(ctx.workspaceId, paymentId) as { txn: string }[];
  for (const r of rows) {
    const grantId = grantThatBooked(ctx, r.txn);
    if (grantId !== undefined) suspendGrant(ctx, grantId, 'payment_reversed');
  }
}

/**
 * HOOK (`performBooking`, after a booking wrote its decision): a person booked a line the rule proposed,
 * and CHANGED it (N03 `rule_changed`): the rule's live grant pauses (`changed_booking`) while
 * `rules.autobook_suspend_on_change` is `on`. The changed use resets the clean count either way (derived).
 */
export function autobookAfterBooking(ctx: WorkspaceContext, provenance: { proposedRuleId: string | null; ruleChanged: boolean | null }): void {
  if (provenance.proposedRuleId === null || provenance.ruleChanged !== true) return;
  if (getSetting<string>(ctx, SUSPEND_ON_CHANGE) !== 'on') return;
  const live = liveGrantOn(ctx, provenance.proposedRuleId);
  if (live !== undefined) suspendGrant(ctx, live.id, 'changed_booking');
}

// --- The offer ------------------------------------------------------------------------------------------

/** The facts an offer's Vorschlag carries for Pendenzen (read when drafted, stored in its payload). */
export interface AutobookOfferFacts {
  standardId: string;
  counterparty: string;
  label: string | null;
  cleanUses: number;
  ceilingMinor: number;
  currency: string;
}

/** The offer facts stored in a payload, or null when absent or malformed. */
export function storedOfferFacts(payload: Readonly<Record<string, unknown>>): AutobookOfferFacts | null {
  const f = payload['offerFacts'];
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return null;
  const r = f as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (typeof r['standardId'] !== 'string' || typeof r['counterparty'] !== 'string' || typeof r['currency'] !== 'string') return null;
  return {
    standardId: r['standardId'],
    counterparty: r['counterparty'],
    label: typeof r['label'] === 'string' ? r['label'] : null,
    cleanUses: num(r['cleanUses']),
    ceilingMinor: num(r['ceilingMinor']),
    currency: r['currency'],
  };
}

/** Is this drafted act an autobook offer (`grant_rule_autobook` drafted by `system`, carrying its facts)? */
export function isAutobookOffer(tool: string, payload: Readonly<Record<string, unknown>>, actor: unknown): boolean {
  return tool === 'grant_rule_autobook' && actor === AUTOBOOK_SYSTEM_ACTOR && storedOfferFacts(payload) !== null;
}

/**
 * Void (`stale`) every PENDING offer whose rule id `which` accepts. Answers the ids. An offer whose approval
 * is running right now (`approvingActionIds`: approving it IS this grant) is left to that approval, which
 * marks it executed; voiding it under its own approval would roll the grant back.
 */
function voidOffers(ctx: WorkspaceContext, which: (standardId: string) => boolean): string[] {
  const busy = new Set(approvingActionIds());
  const rows = ctx.store.db
    .prepare(
      "SELECT id, payload_json FROM agent_action WHERE workspace_id = ? AND action_tool = 'grant_rule_autobook' AND actor = ? AND status = 'pending' AND committed_at IS NULL",
    )
    .all(ctx.workspaceId, AUTOBOOK_SYSTEM_ACTOR) as { id: string; payload_json: string }[];
  const stale = ctx.store.db.prepare(
    "UPDATE agent_action SET status = 'stale', resolved_at = ?, resolved_by = ? WHERE workspace_id = ? AND id = ? AND status = 'pending' AND committed_at IS NULL",
  );
  const out: string[] = [];
  for (const r of rows) {
    let standardId: unknown;
    try {
      standardId = (JSON.parse(r.payload_json) as { standardId?: unknown }).standardId;
    } catch {
      continue;
    }
    if (typeof standardId !== 'string' || !which(standardId) || busy.has(r.id)) continue;
    if (stale.run(ctx.clock.now(), AUTOBOOK_SYSTEM_ACTOR, ctx.workspaceId, r.id).changes === 1) out.push(r.id);
  }
  return out;
}

/** The live BANK rules that book legs, newest first. */
function liveLegRules(ctx: WorkspaceContext): BankStandardRow[] {
  const ids = ctx.store.db
    .prepare("SELECT id FROM bank_standard WHERE workspace_id = ? AND superseded_at IS NULL AND scope = 'bank' ORDER BY set_at DESC, rowid DESC")
    .all(ctx.workspaceId) as { id: string }[];
  return ids.flatMap((r) => {
    const rule = readLiveRule(ctx, r.id);
    return rule === undefined ? [] : [rule];
  });
}

/**
 * Draft the offers that are due, and void the ones that are not any more. A rule is offered when it is
 * eligible, has no live grant, has at least `rules.autobook_offer_after` clean uses and a ceiling. Its
 * Vorschlag row is keyed `autobook-offer:<version>:<grants made on it>:<ceiling><currency>`: a rejected offer
 * is never asked again for that version until a grant on it ends, and a pending one whose figures moved is
 * voided and re-drafted with the fresh ones (critic N04 F2). Answers the drafted action ids.
 */
export function draftAutobookOffers(ctx: WorkspaceContext): string[] {
  const system: WorkspaceContext = { ...ctx, actor: AUTOBOOK_SYSTEM_ACTOR };
  const needed = offerAfterAnswer(ctx);
  // A41.7: no offer while the threshold is unanswered (the rule card asks it first).
  if (needed === null) return [];
  const due = new Map<string, { rule: BankStandardRow; uses: CleanUse[]; ceiling: { amountMinor: number; currency: string } }>();
  for (const rule of liveLegRules(ctx)) {
    if (!autobookEligibility(ctx, rule).eligible) continue;
    if (liveGrantOn(ctx, rule.id) !== undefined) continue;
    const { uses } = cleanUsesOf(ctx, rule.id);
    if (uses.length < needed) continue;
    const ceiling = ceilingOf(ctx, uses);
    if (ceiling === null) continue;
    due.set(rule.id, { rule, uses, ceiling });
  }
  voidOffers(system, (standardId) => !due.has(standardId));
  const drafted: string[] = [];
  for (const { rule, uses, ceiling } of due.values()) {
    const made = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM rule_autobook_grant WHERE workspace_id = ? AND standard_id = ?').get(ctx.workspaceId, rule.id) as { n: number };
    // The ROUND key (version, grants made) decides "never asked again after a rejection"; the row key adds the
    // shown figures, so an offer whose ceiling moved is voided and re-drafted (critic N04 F2).
    const round = `${AUTOBOOK_OFFER_KEY_PREFIX}${rule.id}:${made.n}`;
    const key = `${round}:${ceiling.amountMinor}${ceiling.currency}`;
    const rows = ctx.store.db
      .prepare("SELECT id, status, idempotency_key AS k FROM agent_action WHERE workspace_id = ? AND action_tool = 'grant_rule_autobook' AND actor = ? AND (idempotency_key = ? OR idempotency_key LIKE ? ESCAPE '\\')")
      .all(ctx.workspaceId, AUTOBOOK_SYSTEM_ACTOR, round, `${round.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`) as { id: string; status: string; k: string }[];
    // A person answered this round (rejected, or approved and executed): never asked again.
    if (rows.some((r) => r.status !== 'stale' && r.status !== 'pending')) continue;
    if (rows.some((r) => r.status === 'pending' && r.k === key)) continue;
    const outdated = rows.filter((r) => r.status === 'pending').map((r) => r.id);
    if (outdated.length > 0) {
      const busy = new Set(approvingActionIds());
      const stale = ctx.store.db.prepare(
        "UPDATE agent_action SET status = 'stale', resolved_at = ?, resolved_by = ? WHERE workspace_id = ? AND id = ? AND status = 'pending' AND committed_at IS NULL",
      );
      for (const id of outdated) if (!busy.has(id)) stale.run(ctx.clock.now(), AUTOBOOK_SYSTEM_ACTOR, ctx.workspaceId, id);
    }
    const facts: AutobookOfferFacts = {
      standardId: rule.id,
      counterparty: rule.counterparty_label,
      label: rule.label,
      cleanUses: uses.length,
      ceilingMinor: ceiling.amountMinor,
      currency: ceiling.currency,
    };
    const payload: Record<string, unknown> = {
      workspaceId: ctx.workspaceId,
      standardId: rule.id,
      offerFacts: facts,
      // MINTED (K1): the grant runs under a key nobody can know; the Vorschlag ROW carries the offer key.
      idempotencyKey: ctx.ids.next('agrantk'),
    };
    // The same figures offered and voided before (the rule left and re-entered the offer) cannot reuse the
    // row key, so they are offered under a fresh suffix.
    const reused = rows.some((r) => r.k === key);
    const rowKey = reused ? `${key}:${ctx.ids.next('aoffer')}` : key;
    const result = enqueueDraftedAction(system, { actionTool: 'grant_rule_autobook', payload, dialCapability: null, idempotencyKey: rowKey });
    if (result.ok && result['replayed'] !== true) drafted.push(String(result['actionId']));
  }
  return drafted;
}

// --- The step -------------------------------------------------------------------------------------------

/** What the scheduler hands the step: the registry's own `book_bank_line`, and the granter's live right. */
export interface AutobookStepPorts {
  /** Book through the shared dispatch's `book_bank_line` as `actor` (A24 checked against them, live). */
  book(actor: string, input: Record<string, unknown>): Result;
  /** Does `actor` hold `post` in this workspace now? */
  holdsPost(actor: string): boolean;
  /**
   * The window between the verdict (read without the lock) and the booking's own transaction, where another
   * process may write (critic N04 F4, A41.3 r1 M11). The scheduler passes nothing; a test passes a writer here
   * to prove the step re-checks under the write lock rather than trusting what it read before.
   */
  beforeBooking?(bankTxnId: string): void;
}

export interface AutobookStepReport {
  offered: string[];
  booked: { grantId: string; bankTxnId: string; entryId: string | null }[];
  notBooked: { grantId: string; bankTxnId: string; reason: AutobookNotBookedReason; detail: string | null }[];
  suspended: { grantId: string; reason: AutobookSuspendReason }[];
  /** A41.3: the lines that wait for their receipt this tick (nothing recorded). */
  waiting: { grantId: string; bankTxnId: string; reason: AutobookWaitReason }[];
  /** A41.3: what the engine's assignment pass created and released this tick (I-B.1). */
  assignments: EngineAssignReport;
}

/** Carries a refused booking out of the transaction it rolls back. */
class AutobookRefused {
  constructor(readonly result: Result) {}
}

/** Another tick decided the pair, or the line was booked, between the read and the write lock. */
class AutobookRaced {}

/** Has this (grant, line) pair a run row, or has the line been autobooked or decided by anyone? */
function decidedAlready(ctx: WorkspaceContext, grantId: string, bankTxnId: string): boolean {
  const run = ctx.store.db
    .prepare("SELECT 1 AS r FROM autobook_run WHERE workspace_id = ? AND bank_txn_id = ? AND (grant_id = ? OR outcome = 'booked') LIMIT 1")
    .get(ctx.workspaceId, bankTxnId, grantId);
  if (run !== undefined) return true;
  const decision = ctx.store.db
    .prepare('SELECT 1 AS d FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND superseded_at IS NULL LIMIT 1')
    .get(ctx.workspaceId, bankTxnId);
  return decision !== undefined;
}

interface RunRow {
  grantId: string;
  bankTxnId: string;
  outcome: 'booked' | 'not_booked';
  entryId: string | null;
  reason: AutobookNotBookedReason | null;
  detail: string | null;
}

function insertRun(ctx: WorkspaceContext, run: RunRow): void {
  const at = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO autobook_run (id, workspace_id, run_at, day, bank_txn_id, grant_id, outcome, entry_id, reason, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(ctx.ids.next('abrun'), ctx.workspaceId, at, swissDay(at), run.bankTxnId, run.grantId, run.outcome, run.entryId, run.reason, run.detail);
}

/**
 * The candidate lines of one grant: open, in the rule's direction, never looked at under this grant, never
 * autobooked under any grant, never reopened (a line whose booking anybody undid is a person's for good,
 * critic N04 F1), and (under `rules.autobook_scope` = `new_lines`) imported after the grant.
 * Oldest first. The counterparty and text are matched by the ladder itself afterwards.
 */
function candidateLines(ctx: WorkspaceContext, g: GrantRow, rule: BankStandardRow): BankTxnRow[] {
  const direction = rule.direction === 'in' ? 'CRDT' : 'DBIT';
  const newOnly = getSetting<string>(ctx, SCOPE) !== 'open_lines';
  return ctx.store.db
    .prepare(
      `SELECT t.* FROM bank_txn t
        WHERE t.workspace_id = ? AND t.credit_debit = ? AND (? = 0 OR t.created_at > ?)
          AND NOT EXISTS (SELECT 1 FROM bank_line_decision d WHERE d.workspace_id = t.workspace_id AND d.bank_txn_id = t.id AND d.superseded_at IS NULL)
          -- Critic N04 F1: a line that ever had a decision someone undid was reopened by a person; it stays theirs.
          AND NOT EXISTS (SELECT 1 FROM bank_line_decision s WHERE s.workspace_id = t.workspace_id AND s.bank_txn_id = t.id AND s.superseded_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM autobook_run r WHERE r.workspace_id = t.workspace_id AND r.bank_txn_id = t.id AND (r.grant_id = ? OR r.outcome = 'booked'))
        ORDER BY COALESCE(t.booking_date, t.value_date, t.created_at), t.rowid`,
    )
    .all(ctx.workspaceId, direction, newOnly ? 1 : 0, g.granted_at, g.id) as BankTxnRow[];
}

/** Why the full-ladder proposal does not let this grant book the line, or null when it does. */
function proposalVerdict(full: BankLineProposal | null, ruleId: string): { reason: AutobookNotBookedReason; detail: string | null } | null {
  if (full === null) return { reason: 'outranked', detail: null };
  const named = full.reasonParams['standardId'];
  if (named !== ruleId || (full.reasonCode !== 'standard' && full.reasonCode !== 'rule_computed') || full.target === null || full.target.kind === 'ignore') {
    return { reason: 'outranked', detail: full.reasonCode };
  }
  if (full.certainty !== 'sure') return { reason: 'not_sure', detail: full.reasonCode };
  return null;
}

/** A41.3: the line's receipt verdict waits; raised inside the booking's transaction to roll it back. */
class AutobookWaits {
  constructor(readonly reason: AutobookWaitReason) {}
}

/** What the step does with one candidate line of one grant (the step and the digest share it). */
type LineVerdict =
  | { kind: 'skip' }
  | { kind: 'not_booked'; reason: AutobookNotBookedReason; detail: string | null }
  | { kind: 'wait'; reason: AutobookWaitReason }
  | { kind: 'book'; target: BankLineProposal['target']; beleg: { assignmentId: string; files: { fileId: string }[] } | null };

/**
 * The step's verdict on one line under one live grant, with nothing written. N04's own checks first (a
 * not_booked reason is final and recorded); then, under `rules.autobook_requires_beleg = on` and only where a
 * receipt is expected (critic r1 P1/P2: a debit line not covered by the statement), the A41.3 receipt
 * verdict, which reads ONE input: the line's assignment (`belegVerdict.ts`).
 */
function autobookVerdict(ctx: WorkspaceContext, g: GrantRow, rule: BankStandardRow, line: BankTxnRow, requiresBeleg: boolean): LineVerdict {
  const detail = readBankTxnDetail(ctx, line.id);
  // Not this rule's counterparty at all: nothing to record.
  if (standardKeyOfLine(ctx, line, detail) !== `${rule.counterparty_key}|${rule.direction}`) return { kind: 'skip' };
  if (lineStateOf(ctx, line).state !== 'open') return { kind: 'skip' };
  const own = ruleRungAlone(ctx, ruleRungContext(ctx), line, detail);
  const ownIds = own === null ? [] : own.reasonCode === 'several_rules' ? ((own.reasonParams['standardIds'] as readonly string[] | undefined) ?? []) : [own.reasonParams['standardId']];
  // The rule's text does not take this line (another rule of the counterparty does): not its line.
  if (!ownIds.includes(rule.id)) return { kind: 'skip' };
  const full = fullLadderWhereRuleSpeaks(ctx, line, detail);
  let verdict = proposalVerdict(full, rule.id);
  if (verdict === null && line.currency !== g.ceiling_currency) verdict = { reason: 'currency', detail: line.currency };
  if (verdict === null && line.amount_minor > g.amount_ceiling_minor) verdict = { reason: 'over_ceiling', detail: String(line.amount_minor) };
  if (verdict === null) {
    const open = ctx.periods.assertOpen(lineBookingDate(line));
    if (!open.ok) verdict = { reason: 'period_locked', detail: lineBookingDate(line) };
  }
  if (verdict !== null) return { kind: 'not_booked', reason: verdict.reason, detail: verdict.detail };
  const target = (full as BankLineProposal).target;
  if (!requiresBeleg || !receiptExpected(ctx, line, target)) return { kind: 'book', target, beleg: null };
  const beleg = assignmentVerdict(ctx, line, target);
  if (beleg.kind === 'wait') return { kind: 'wait', reason: beleg.reason };
  return { kind: 'book', target, beleg: { assignmentId: beleg.assignmentId, files: beleg.files } };
}

/**
 * THE STEP, once per tick per workspace (never inside an import verb). `ctx` is a wired context acting as
 * `system` (real period and audit ports); every booking itself runs through `ports.book` as the granter.
 * Each line is its own transaction: its booking and its run row commit together or not at all.
 *
 * A41.3 re-cut v2: with `rules.autobook_requires_beleg = on`, the engine's assignment pass runs first, under
 * the write lock (I-B.1); a line that expects a receipt books only with its assignment's receipt, re-checked
 * under the write lock, attached inside `book_bank_line`'s own transaction and consumed with it (I-C).
 */
export function runAutobookStep(ctx: WorkspaceContext, ports: AutobookStepPorts): AutobookStepReport {
  const report: AutobookStepReport = { offered: [], booked: [], notBooked: [], suspended: [], waiting: [], assignments: { created: [], released: [] } };
  if (!autobookOn(ctx)) {
    // Off: nothing books and nothing is offered; a pending offer could only be refused, so it closes.
    ctx.store.tx(() => voidOffers({ ...ctx, actor: AUTOBOOK_SYSTEM_ACTOR }, () => true));
    return report;
  }
  report.offered = ctx.store.tx(() => draftAutobookOffers(ctx));
  const requiresBeleg = autobookRequiresBeleg(ctx);
  // I-B.1: the engine's assignment pass, in its own transaction (the write lock), before any line is judged.
  if (requiresBeleg) report.assignments = reconcileEngineAssignments(ctx, STATEMENT_COVERS_SQL);
  const grants = ctx.store.db
    .prepare('SELECT * FROM rule_autobook_grant WHERE workspace_id = ? AND suspended_at IS NULL AND revoked_at IS NULL ORDER BY granted_at, rowid')
    .all(ctx.workspaceId) as GrantRow[];
  for (const g of grants) {
    const rule = readLiveRule(ctx, g.standard_id);
    // The version was edited or cleared since: the grant has ended.
    if (rule === undefined) continue;
    // The granter is checked LIVE, every tick: a seat that lost `post` (or turned out governed) ends the run.
    if (isGovernedSeat(ctx.store, g.granted_by) || !ports.holdsPost(g.granted_by)) {
      if (ctx.store.tx(() => suspendGrant(ctx, g.id, 'granter_lost_capability'))) report.suspended.push({ grantId: g.id, reason: 'granter_lost_capability' });
      continue;
    }
    for (const line of candidateLines(ctx, g, rule)) {
      const v = autobookVerdict(ctx, g, rule, line, requiresBeleg);
      if (v.kind === 'skip') continue;
      if (v.kind === 'wait') {
        // A41.3: a wait is never recorded (a run row is final): the line books on a later tick.
        report.waiting.push({ grantId: g.id, bankTxnId: line.id, reason: v.reason });
        continue;
      }
      if (v.kind === 'not_booked') {
        ctx.store.tx(() => insertRun(ctx, { grantId: g.id, bankTxnId: line.id, outcome: 'not_booked', entryId: null, reason: v.reason, detail: v.detail }));
        report.notBooked.push({ grantId: g.id, bankTxnId: line.id, reason: v.reason, detail: v.detail });
        continue;
      }
      const target = v.target;
      const beleg = v.beleg;
      ports.beforeBooking?.(line.id);
      try {
        const entryId = ctx.store.tx(() => {
          // Critic N04 F4: re-checked under the write lock: another tick (a second process) may have decided
          // this (grant, line) pair, or anybody may have booked the line, since it was read above.
          if (decidedAlready(ctx, g.id, line.id)) throw new AutobookRaced();
          // A41.3 I-C: the receipt verdict again, under the write lock: the assignment it books with is the
          // one standing NOW, with the same receipt, figures and tolerances.
          if (beleg !== null) {
            const again = assignmentVerdict(ctx, line, target);
            if (again.kind === 'wait') throw new AutobookWaits(again.reason);
            if (again.assignmentId !== beleg.assignmentId) throw new AutobookWaits('beleg_changed');
          }
          const book = (): Result =>
            withDecisionChannel(ctx, line.id, autobookChannel(rule.id), () =>
              ports.book(g.granted_by, {
                workspaceId: ctx.workspaceId,
                bankTxnId: line.id,
                target,
                idempotencyKey: autobookKey(g.id, line.id),
                // A41.3: the receipt rides INSIDE book_bank_line's own transaction (its attach seam), so a
                // refused attach rolls the booking back with it, and the decision writer consumes the
                // assignment it was booked with (`withAssignmentConsumption`).
                ...(beleg !== null ? { attach: beleg.files } : {}),
              }),
            );
          const res = beleg === null ? book() : withAssignmentConsumption(ctx, line.id, beleg.assignmentId, book);
          if (!res.ok) {
            // The receipt guard refused the assigned receipt inside the booking (another booking took the
            // bytes since): the booking rolled back, the line waits, never a final refusal.
            if (beleg !== null && res.error === 'receipt_already_booked') throw new AutobookWaits('beleg_in_use');
            throw new AutobookRefused(res);
          }
          const booked = typeof res['entryId'] === 'string' ? (res['entryId'] as string) : null;
          insertRun(ctx, { grantId: g.id, bankTxnId: line.id, outcome: 'booked', entryId: booked, reason: null, detail: null });
          return booked;
        });
        report.booked.push({ grantId: g.id, bankTxnId: line.id, entryId });
      } catch (e) {
        if (e instanceof AutobookRaced) continue;
        if (e instanceof AutobookWaits) {
          report.waiting.push({ grantId: g.id, bankTxnId: line.id, reason: e.reason });
          continue;
        }
        const detail = e instanceof AutobookRefused ? String(e.result.ok ? 'unexpected' : e.result.error) : 'unexpected_error';
        // Never a second run row for a pair another tick recorded meanwhile.
        ctx.store.tx(() => {
          if (!decidedAlready(ctx, g.id, line.id)) insertRun(ctx, { grantId: g.id, bankTxnId: line.id, outcome: 'not_booked', entryId: null, reason: 'refused', detail });
        });
        report.notBooked.push({ grantId: g.id, bankTxnId: line.id, reason: 'refused', detail });
        if (!(e instanceof AutobookRefused)) throw e;
      }
    }
  }
  return report;
}

// --- Reads ---------------------------------------------------------------------------------------------

/** One rule as the rule card and an agent see its autopilot. */
export interface AutobookCandidate {
  standardId: string;
  label: string | null;
  counterparty: string;
  eligible: boolean;
  /** Why it can never book on its own as it stands, or null while eligible. */
  ineligibleReason: AutobookIneligibleReason | null;
  /** Clean uses of the current version since the reset point. */
  cleanUses: number;
  /** Of them, confirmed by a person (what a ceiling is fixed from). */
  humanCleanUses: number;
  /** What a grant now would fix as the ceiling, or null. */
  ceilingPreview: { amountMinor: number; currency: string } | null;
  /** The newest grant on any version of the rule, with its state, or null. */
  grant: AutobookGrant | null;
  /** The pending offer's Vorschlag id, or null. */
  offerActionId: string | null;
  /** Granting now would succeed (a person, setting on, eligible, earned, a ceiling, no live grant). */
  grantable: boolean;
  /**
   * A41.7: the rule reached the offer stage (eligible, no live grant, a ceiling, at least the lowest possible
   * threshold of clean uses) while the threshold is unanswered: the card asks it before anything is offered.
   * The engine always sets it; optional in the type only for Studio fixtures written before it.
   */
  asksThreshold?: boolean;
}

export type AutobookCandidatesOk = {
  setting: 'offer' | 'off';
  /** The answered threshold, or the suggestion a question pre-selects while `offerAfterAnswered` is false. */
  offerAfter: number;
  /** A41.7: has a person answered `rules.autobook_offer_after` (ask first)? */
  offerAfterAnswered: boolean;
  headroomPercent: number;
  rules: AutobookCandidate[];
};

/** `autobook_candidates`: every live bank rule's autopilot state. Read-only. */
export function autobookCandidates(ctx: WorkspaceContext): Result<AutobookCandidatesOk> {
  const on = autobookOn(ctx);
  const answered = offerAfterAnswer(ctx);
  const needed = answered ?? getSetting<number>(ctx, OFFER_AFTER);
  const offers = new Map<string, string>();
  for (const r of ctx.store.db
    .prepare("SELECT id, payload_json FROM agent_action WHERE workspace_id = ? AND action_tool = 'grant_rule_autobook' AND actor = ? AND status = 'pending'")
    .all(ctx.workspaceId, AUTOBOOK_SYSTEM_ACTOR) as { id: string; payload_json: string }[]) {
    try {
      const s = (JSON.parse(r.payload_json) as { standardId?: unknown }).standardId;
      if (typeof s === 'string') offers.set(s, r.id);
    } catch {
      // A malformed payload names no rule.
    }
  }
  const rules: AutobookCandidate[] = liveLegRules(ctx).map((rule) => {
    const eligibility = autobookEligibility(ctx, rule);
    const { uses } = cleanUsesOf(ctx, rule.id);
    const ceiling = ceilingOf(ctx, uses);
    const newest = newestGrantOfRule(ctx, rule.id);
    const grant = newest === undefined ? null : grantView(ctx, newest, on);
    const live = grant !== null && (grant.state === 'active' || grant.state === 'stopped') && grant.standardId === rule.id;
    return {
      standardId: rule.id,
      label: rule.label,
      counterparty: rule.counterparty_label,
      eligible: eligibility.eligible,
      ineligibleReason: eligibility.eligible ? null : eligibility.reason,
      cleanUses: uses.length,
      humanCleanUses: uses.filter((u) => u.human).length,
      ceilingPreview: ceiling,
      grant,
      offerActionId: offers.get(rule.id) ?? null,
      grantable: on && answered !== null && eligibility.eligible && !live && uses.length >= needed && ceiling !== null,
      asksThreshold: on && answered === null && eligibility.eligible && !live && uses.length >= OFFER_AFTER_MIN && ceiling !== null,
    };
  });
  return ok<AutobookCandidatesOk>({ setting: on ? 'offer' : 'off', offerAfter: needed, offerAfterAnswered: answered !== null, headroomPercent: getSetting<number>(ctx, HEADROOM), rules });
}

/** One line of a digest day. */
export interface AutobookDigestLine {
  runId: string;
  bankTxnId: string;
  grantId: string;
  standardId: string;
  ruleLabel: string | null;
  counterparty: string;
  amountMinor: number;
  currency: string;
  direction: 'in' | 'out';
  lineDate: string;
  runAt: string;
  /** Booked lines only: the entry, and whether the booking still stands (false once reopened). */
  entryId: string | null;
  stands: boolean;
  /** Not-booked lines only: why. */
  reason: AutobookNotBookedReason | null;
  detail: string | null;
  /** The grant can still be switched off ("Automatik aus"): not yet revoked. */
  grantRevocable: boolean;
}

/** A41.3: one line a granted rule would book, waiting for its receipt (computed at read time, never stored). */
export interface AutobookWaitingLine {
  bankTxnId: string;
  grantId: string;
  standardId: string;
  ruleLabel: string | null;
  counterparty: string;
  amountMinor: number;
  currency: string;
  lineDate: string;
  reason: AutobookWaitReason;
}

export type AutobookDigestOk = {
  date: string;
  booked: AutobookDigestLine[];
  notBooked: AutobookDigestLine[];
  seen: boolean;
  /**
   * A41.3: the lines that wait for their receipt NOW (any day), empty unless `rules.autobook_requires_beleg` is
   * on. The engine always sets it; optional in the type only for Studio fixtures written before it.
   */
  waitingForBeleg?: AutobookWaitingLine[];
};

/**
 * Critic A41.3 follow-ups r1 F2: would the booking's own receipt guard refuse the line's assigned receipt? The step
 * books inside `book_bank_line`, whose attach seam meets the guard as the GRANTER (a person, no `bookAgain`), and a
 * refusal there rolls the booking back and the line waits `beleg_in_use` on every tick. The same guard, read-only
 * (nothing is recorded): true when any assigned file's bytes evidence another live booking and
 * `files.duplicate_beleg` is not `allow`.
 */
function assignedReceiptInUse(ctx: WorkspaceContext, lineId: string, grantedBy: string): boolean {
  const a = activeAssignmentOf(ctx, lineId);
  if (a === undefined) return false;
  const granter: WorkspaceContext = { ...ctx, actor: grantedBy };
  return a.files.some((f) => {
    const judged = receiptHolderGuard(granter, f.sha256, { kind: 'bank_txn', id: lineId }, { exceptFileIds: [f.fileId], override: {} });
    return (judged as { ok?: unknown }).ok === false && (judged as { error?: unknown }).error === 'receipt_already_booked';
  });
}

/**
 * A41.3: every line a live grant would book but that waits for its receipt, by the step's own verdict (which
 * reads the line's assignment, never the pool). Read-only: the engine's assignment pass runs only in the step.
 * Critic r1 F2: a line the verdict would book but whose assigned receipt the booking's guard refuses waits
 * `beleg_in_use` here too, so it is never invisible.
 */
export function autobookWaiting(ctx: WorkspaceContext): AutobookWaitingLine[] {
  if (!autobookOn(ctx) || !autobookRequiresBeleg(ctx)) return [];
  const out: AutobookWaitingLine[] = [];
  const grants = ctx.store.db
    .prepare('SELECT * FROM rule_autobook_grant WHERE workspace_id = ? AND suspended_at IS NULL AND revoked_at IS NULL ORDER BY granted_at, rowid')
    .all(ctx.workspaceId) as GrantRow[];
  for (const g of grants) {
    const rule = readLiveRule(ctx, g.standard_id);
    if (rule === undefined) continue;
    for (const line of candidateLines(ctx, g, rule)) {
      const verdict = autobookVerdict(ctx, g, rule, line, true);
      const reason: AutobookWaitReason | null =
        verdict.kind === 'wait' ? verdict.reason : verdict.kind === 'book' && verdict.beleg !== null && assignedReceiptInUse(ctx, line.id, g.granted_by) ? 'beleg_in_use' : null;
      if (reason === null) continue;
      out.push({
        bankTxnId: line.id,
        grantId: g.id,
        standardId: rule.id,
        ruleLabel: rule.label,
        counterparty: rule.counterparty_label,
        amountMinor: line.amount_minor,
        currency: line.currency,
        lineDate: lineBookingDate(line),
        reason,
      });
    }
  }
  return out;
}

/** `autobook_digest`: what the step did on one Swiss day (default today). Read-only. */
export function autobookDigest(ctx: WorkspaceContext, input: { date?: unknown } = {}): Result<AutobookDigestOk> {
  const date = input.date === undefined || input.date === null ? swissDay(ctx.clock.now()) : input.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return err('invalid_input', { field: 'date', reason: 'an ISO date YYYY-MM-DD' });
  const rows = ctx.store.db
    .prepare(
      `SELECT r.id AS runId, r.bank_txn_id AS txn, r.grant_id AS grantId, r.outcome, r.entry_id AS entryId, r.reason, r.detail, r.run_at AS runAt,
              g.standard_id AS standardId, g.revoked_at AS revokedAt, s.label AS label, s.counterparty_label AS counterparty,
              t.amount_minor AS amount, t.currency, t.credit_debit AS cd, COALESCE(t.booking_date, t.value_date, substr(t.created_at, 1, 10)) AS lineDate
         FROM autobook_run r
         JOIN rule_autobook_grant g ON g.workspace_id = r.workspace_id AND g.id = r.grant_id
         JOIN bank_standard s ON s.workspace_id = g.workspace_id AND s.id = g.standard_id
         JOIN bank_txn t ON t.workspace_id = r.workspace_id AND t.id = r.bank_txn_id
        WHERE r.workspace_id = ? AND r.day = ?
        ORDER BY r.run_at, r.rowid`,
    )
    .all(ctx.workspaceId, date) as {
    runId: string;
    txn: string;
    grantId: string;
    outcome: 'booked' | 'not_booked';
    entryId: string | null;
    reason: string | null;
    detail: string | null;
    runAt: string;
    standardId: string;
    revokedAt: string | null;
    label: string | null;
    counterparty: string;
    amount: number;
    currency: string;
    cd: string;
    lineDate: string;
  }[];
  const stands = ctx.store.db.prepare(
    "SELECT 1 AS s FROM bank_line_decision WHERE workspace_id = ? AND bank_txn_id = ? AND entry_id = ? AND superseded_at IS NULL AND channel LIKE 'autobook:%' LIMIT 1",
  );
  const lines = rows.map<AutobookDigestLine>((r) => ({
    runId: r.runId,
    bankTxnId: r.txn,
    grantId: r.grantId,
    standardId: r.standardId,
    ruleLabel: r.label,
    counterparty: r.counterparty,
    amountMinor: r.amount,
    currency: r.currency,
    direction: r.cd === 'CRDT' ? 'in' : 'out',
    lineDate: r.lineDate,
    runAt: r.runAt,
    entryId: r.entryId,
    stands: r.outcome === 'booked' && r.entryId !== null && stands.get(ctx.workspaceId, r.txn, r.entryId) !== undefined,
    reason: r.outcome === 'not_booked' ? (r.reason as AutobookNotBookedReason) : null,
    detail: r.detail,
    grantRevocable: r.revokedAt === null,
  }));
  const seen = ctx.store.db.prepare("SELECT 1 AS s FROM autopilot_seen WHERE workspace_id = ? AND kind = 'digest' AND ref = ?").get(ctx.workspaceId, date) !== undefined;
  // I-E (critic r1 P3): a seat without the receipt read right sees one uniform reason, never a receipt fact.
  const readsBelege = holdsRead(ctx, BELEG_READ_CAPABILITY);
  const waitingForBeleg = autobookWaiting(ctx).map((w) => (readsBelege ? w : { ...w, reason: 'belege_not_readable' as const }));
  return ok<AutobookDigestOk>({ date, booked: lines.filter((l) => l.entryId !== null), notBooked: lines.filter((l) => l.entryId === null), seen, waitingForBeleg });
}

/** The Swiss days with a digest nobody marked seen, newest first, within the last `days` days. */
export function unseenDigestDays(ctx: WorkspaceContext, days = 30): { day: string; booked: number; notBooked: number }[] {
  const today = swissDay(ctx.clock.now());
  const from = new Date(Date.parse(`${today}T12:00:00.000Z`) - days * 86_400_000).toISOString().slice(0, 10);
  return ctx.store.db
    .prepare(
      `SELECT r.day AS day, SUM(CASE WHEN r.outcome = 'booked' THEN 1 ELSE 0 END) AS booked, SUM(CASE WHEN r.outcome = 'not_booked' THEN 1 ELSE 0 END) AS notBooked
         FROM autobook_run r
        WHERE r.workspace_id = ? AND r.day >= ?
          AND NOT EXISTS (SELECT 1 FROM autopilot_seen s WHERE s.workspace_id = r.workspace_id AND s.kind = 'digest' AND s.ref = r.day)
        GROUP BY r.day ORDER BY r.day DESC`,
    )
    .all(ctx.workspaceId, from) as { day: string; booked: number; notBooked: number }[];
}

// --- autopilot_mark_seen --------------------------------------------------------------------------------

/**
 * Critic N04 F3: "Gesehen" closes a card for EVERY person in the workspace, so it is a person's act: an agent
 * seat that read the digest must not make the people's card disappear. Refused under every dial.
 */
export function markSeenHumanOnly(ctx: WorkspaceContext): Err | undefined {
  if (!isGovernedSeat(ctx.store, ctx.actor)) return undefined;
  return err('human_only', { reason: 'only a person closes a digest or a schedule note for the workspace; an agent reads them' }) as Err;
}

export const AUTOPILOT_SEEN_KINDS = ['digest', 'schedule_run'] as const;
export type AutopilotSeenKind = (typeof AUTOPILOT_SEEN_KINDS)[number];

/**
 * "Gesehen": close a digest day (`kind: digest`, `ref`: the ISO day) or a schedule note (`kind:
 * schedule_run`, `ref`: the run id) in Pendenzen, for everyone in the workspace. Idempotent by nature:
 * closing a closed thing changes nothing. A schedule run of another workspace is `not_found`.
 */
export function autopilotMarkSeen(ctx: WorkspaceContext, input: { kind?: unknown; ref?: unknown }): Result<{ kind: AutopilotSeenKind; ref: string; alreadySeen: boolean }> {
  const human = markSeenHumanOnly(ctx);
  if (human !== undefined) return human;
  if (typeof input.kind !== 'string' || !(AUTOPILOT_SEEN_KINDS as readonly string[]).includes(input.kind)) {
    return err('invalid_input', { field: 'kind', allowed: [...AUTOPILOT_SEEN_KINDS] });
  }
  const guard = requireString(input.ref, 'ref');
  if (guard) return guard;
  const kind = input.kind as AutopilotSeenKind;
  const ref = input.ref as string;
  if (kind === 'digest' && !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return err('invalid_input', { field: 'ref', reason: 'a digest is closed by its ISO day' });
  if (kind === 'schedule_run') {
    const run = ctx.store.db.prepare('SELECT 1 AS r FROM vorlage_schedule_run WHERE workspace_id = ? AND id = ?').get(ctx.workspaceId, ref);
    if (run === undefined) return err('not_found', { ref });
  }
  const written = ctx.store.db
    .prepare('INSERT OR IGNORE INTO autopilot_seen (workspace_id, kind, ref, seen_by, seen_at) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.workspaceId, kind, ref, ctx.actor, ctx.clock.now()).changes;
  return ok({ kind, ref, alreadySeen: written === 0 });
}
