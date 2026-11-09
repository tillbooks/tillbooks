/**
 * N04 (D183), Autopilot: rules that earn the right to book, and Dauerbuchungen. Eight verbs (five writes,
 * three reads), defined here and spread into `ACTIONS` as ONE line (the `ruleLearningActions` /
 * `settingsActions` precedent), so several agents appending to the append-only registry at once collide over
 * a line rather than a block. The helpers arrive as a parameter to keep the module graph acyclic.
 *
 * Granting a rule its automatic booking is a PERSON's act: `grant_rule_autobook` refuses a governed seat
 * `human_only` under every dial, before a Vorschlag is drafted (its `prevalidate`) and at execution alike.
 * So does `set_vorlage_schedule` with `mode: post`. The bookings themselves are never a verb: the scheduler
 * tick runs them (`src/api/scheduler.ts`), through `book_bank_line` and `post_entry` as the person.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  autobookCandidates,
  autobookDigest,
  autopilotMarkSeen,
  grantHumanOnly,
  markSeenHumanOnly,
  grantRuleAutobook,
  revokeRuleAutobook,
} from '../core/banking/autobook.js';
import { clearVorlageSchedule, listVorlageSchedules, schedulePostHumanOnly, setVorlageSchedule } from '../core/ledger/vorlageSchedule.js';
import type { ActionKind } from './actionKind.js';

export interface AutopilotActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  withPrevalidate(def: ActionDef, check: (ctx: WorkspaceContext, input: ActionInput) => Result | undefined): ActionDef;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
}

export function autopilotActions(h: AutopilotActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, withPrevalidate, STR, INT } = h;
  const as = <T>(input: ActionInput): T => input as unknown as T;

  return [
    ctxAction(
      'autobook_candidates',
      'read',
      'The autopilot of every live bank Buchungsregel: whether it can ever book on its own (eligible, else ineligibleReason: not_a_bank_rule, ignore_rule, name_key (it needs an iban: counterparty), derived_key (a counterparty read from the booking text, card: or bank:, which rules.autobook_derived_keys does not allow: all (the default) allows both, bank_fees only bank: fee keys, off neither), via_account, own_account, rule_invalid, asks_amount, mode_not_bulk (bank.buchungsregel_mode, or bank.buchungsregel_computed_mode for a computed rule, is not bulk)), cleanUses (live bookings of its current version booked exactly as it proposed, since its last edit, changed booking or paused grant) and humanCleanUses (of them, confirmed by a person), ceilingPreview (what a grant now would fix: the largest person-confirmed clean use times rules.autobook_amount_headroom percent, in that booking\'s currency), grant (the newest one with state active, suspended (with suspendedReason), revoked, ended (the rule was edited or removed since) or stopped (rules.autobook is off)), offerActionId (the pending Vorschlag offering it), grantable, and (A41) asksThreshold: the rule reached the offer stage while rules.autobook_offer_after is unanswered (ask first: no offer and no grant until a person answers it). Also setting, offerAfter (the answer, or the suggestion while unanswered), offerAfterAnswered and headroomPercent. Writes nothing.',
      ctxSchema({}),
      (ctx) => autobookCandidates(ctx),
    ),
    withPrevalidate(
      ctxAction(
        'grant_rule_autobook',
        'write:reversible:human-only',
        'A PERSON switches one Buchungsregel (standardId: its live version) to book its own bank lines ("künftig automatisch"). From then on the scheduler books each NEW line of it through book_bank_line as this person, but only when the line\'s full proposal is exactly this rule\'s sure proposal (an existing entry, a reference or an own-account transfer always wins), the line is in the ceiling\'s currency and within the ceiling fixed now, its period is open, and this person still holds post; every automatic booking is in the daily digest (autobook_digest) and is undone with reopen_bank_line. Refused: human_only for an agent seat under every dial (an agent can neither do it nor propose it), autobook_off (rules.autobook is off), rule_not_found, autobook_not_eligible (with the reason), needs_setting_answer (A41: rules.autobook_offer_after is ask first, and no person answered it yet; the answer names the key and the suggestion), autobook_not_earned (fewer clean uses than rules.autobook_offer_after), autobook_no_human_use (no clean use a person confirmed). A version already switched on answers alreadyGranted. The way back is revoke_rule_autobook.',
        ctxSchema({ standardId: STR, idempotencyKey: STR, offerFacts: { type: 'object' } }, ['standardId', 'idempotencyKey']),
        (ctx, input) => grantRuleAutobook(ctx, as(input)),
      ),
      (ctx) => grantHumanOnly(ctx),
    ),
    ctxAction(
      'revoke_rule_autobook',
      'write:reversible:stop',
      'Switch a Buchungsregel\'s automatic booking off ("Automatik aus"): the rule (standardId: any of its versions) stops booking on its own. Every not yet revoked grant of the rule is revoked (active, paused or ended alike), so nothing of it books again until a person switches it on anew after enough clean uses. Bookings it already made stay (undo one with reopen_bank_line). Refuses no_live_grant when the rule has none, rule_not_found for another workspace\'s id.',
      ctxSchema({ standardId: STR, idempotencyKey: STR }, ['standardId', 'idempotencyKey']),
      (ctx, input) => revokeRuleAutobook(ctx, as(input)),
    ),
    ctxAction(
      'autobook_digest',
      'read',
      'What the automatic booking did on one Swiss day (date YYYY-MM-DD, default today): booked lines (bankTxnId, the rule standardId and ruleLabel, counterparty, amountMinor, currency, direction, lineDate, entryId, stands: false once the booking was undone, grantRevocable) and notBooked lines with their reason: outranked (another proposal stood on the line: an existing entry, a reference, an own-account transfer, another rule), not_sure (the rule\'s proposal was only a check: a reversal, a possible duplicate, the mode), currency (not the ceiling\'s currency), over_ceiling, period_locked, refused (book_bank_line refused; detail names its error). seen says whether a person closed the day in Pendenzen. Writes nothing.',
      ctxSchema({ date: STR }),
      (ctx, input) => autobookDigest(ctx, as(input)),
    ),
    withPrevalidate(
      ctxAction(
        'autopilot_mark_seen',
        'write:final:ui-state',
        'Mark as seen ("Gesehen" in Pendenzen): close one day of the automatic-booking digest (kind digest, ref the ISO day) or one Dauerbuchung note (kind schedule_run, ref the run id from vorlage_schedules) for everyone in the workspace. Only a person does it: an agent seat is refused human_only under every dial. It changes nothing in the books; closing a closed one answers alreadySeen. Refuses invalid_input and not_found (a run of another workspace).',
        ctxSchema({ kind: STR, ref: STR }, ['kind', 'ref']),
        (ctx, input) => autopilotMarkSeen(ctx, as(input)),
      ),
      (ctx) => markSeenHumanOnly(ctx),
    ),
    withPrevalidate(
      ctxAction(
        'set_vorlage_schedule',
        'write:reversible:books',
        'Let a Vorlage book itself on a schedule (a Dauerbuchung): vorlageId (its live version; the schedule follows it through every edit), every month | quarter | year, anchorDay 1 to 31 (31 is the month\'s last day), start and optional end (YYYY-MM-DD), mode propose (default: on each due date a Vorschlag of post_entry with this Vorlage is drafted, dated the due date) or post (books it directly as you; only a person may set it, an agent seat is refused human_only; your post right is checked at each run, and without it the run is proposed instead), and asks { legIndex: amountMinor } for its asked legs (checked now: the Vorlage must book with them). One run per period (the month, quarter or year of the due date), never twice across schedules: a new schedule replaces the Vorlage\'s current one and starts after the period of its latest run. A missed due date is created later, never skipped; in post mode older ones are proposed. A locked period or a Vorlage that no longer books is skipped with a note in Pendenzen. A newer Vorlage version runs as propose until you set the schedule again. Refuses rule_not_found, wrong_scope (a bank rule), the template refusals of post_entry, invalid_input. The way back is clear_vorlage_schedule.',
        ctxSchema(
          { vorlageId: STR, every: STR, anchorDay: INT, start: STR, end: STR, mode: STR, asks: { type: 'object' }, idempotencyKey: STR },
          ['vorlageId', 'every', 'anchorDay', 'start', 'idempotencyKey'],
        ),
        (ctx, input) => setVorlageSchedule(ctx, as(input)),
      ),
      (ctx, input) => schedulePostHumanOnly(ctx, input),
    ),
    ctxAction(
      'clear_vorlage_schedule',
      'write:reversible:stop',
      'End a Dauerbuchung schedule (scheduleId from vorlage_schedules): nothing more is booked or proposed from it. What it already booked or proposed stays. An ended schedule answers alreadyEnded. Refuses not_found. Set a new one with set_vorlage_schedule.',
      ctxSchema({ scheduleId: STR, idempotencyKey: STR }, ['scheduleId', 'idempotencyKey']),
      (ctx, input) => clearVorlageSchedule(ctx, as(input)),
    ),
    ctxAction(
      'vorlage_schedules',
      'read',
      'The Dauerbuchung schedules (of one Vorlage when vorlageId names any of its versions, else all), newest first: cadence (every, anchorDay, start, end), mode and effectiveMode (post only while the version a person confirmed is the live one), asks, status active | ended (endReason replaced, cleared, vorlage_cleared), nextRun, liveVersionId, and every run: period, dueDate, outcome posted (entryId) | proposed (actionId, actionStatus pending, executed, rejected or stale) | skipped, reason (catch_up, no_post_right, vorlage_changed, vorlage_cleared, period_locked, or the refusal of the Vorlage) and seen. Writes nothing.',
      ctxSchema({ vorlageId: STR }),
      (ctx, input) => listVorlageSchedules(ctx, as(input)),
    ),
  ];
}
