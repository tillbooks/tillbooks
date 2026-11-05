/**
 * N03 (D183), Buchungsregeln that learn: three verbs (one write, two reads), defined here and spread into
 * `ACTIONS` as ONE line (the `bankInboxActions` / `fxActions` precedent), so several agents appending to the
 * append-only registry at once collide over a line rather than a block. The helpers arrive as a parameter to
 * keep the module graph acyclic: `registry.ts` imports this file and this file must not import it back.
 *
 * `mine_rules` writes only Vorschläge (drafted as `system`, approved by a person through
 * `approve_drafted_action`, rejected for good through `reject_drafted_action`); it never writes a rule. The
 * two reads derive evidence and edit nothing. The fourth N03 action is a field, not a verb:
 * `set_bank_standard { fromBankTxnId }` (`bank-inbox-actions.ts`).
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { backtestRule, mineRules, ruleStats } from '../core/banking/index.js';
import type { ActionKind } from './actionKind.js';

export interface RuleLearningActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
}

export function ruleLearningActions(h: RuleLearningActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT } = h;
  const as = <T>(input: ActionInput): T => input as unknown as T;

  /** A recipe leg, exactly as `set_bank_standard` takes it (bank scope). */
  const RECIPE_LEG = {
    type: 'object',
    properties: {
      accountId: STR,
      taxCode: STR,
      amount: {
        type: 'object',
        properties: { kind: STR, label: STR, legIndex: INT, num: INT, den: INT, explain: { type: 'object', properties: { vatBp: INT, feeBp: INT } } },
        required: ['kind'],
      },
      against: { type: 'boolean' },
      description: STR,
    },
    required: ['accountId', 'amount'],
  };

  return [
    ctxAction(
      'mine_rules',
      'write:correctable:derived',
      'Look for Buchungsregeln worth having: the bank lines booked to accounts in the last rules.miner_lookback_days (default 365) are grouped by counterparty (IBAN, else name), direction and leg shape (every account with its MWST code and side, and the Durchlaufkonto; amounts may differ). A group of at least rules.miner_min_repeats (default 3) lines whose counterparty no live rule speaks for becomes ONE Vorschlag of set_bank_standard (from the newest line, the largest leg the rest and every other leg asked), drafted as system so the person who ran this may approve it; reject it and the same counterparty and shape is never offered again (its Vorschlag key mine:<counterparty key>:<shape hash> answers every later run). At most rules.miner_max_open (default 10) mined Vorschläge wait at once, the newest evidence first. Never writes a rule itself. With the setting rules.miner off it reads nothing (ran: false). Runs once a day on its own while till up runs. Answers since, considered (lines grouped), groups [{ counterpartyKey, direction, shapeHash, repeats, bankTxnId, outcome drafted | open | rejected | made, actionId }] and capped.',
      ctxSchema({}),
      (ctx) => mineRules(ctx),
    ),
    ctxAction(
      'bank_rule_stats',
      'read',
      'The track record of the Buchungsregeln, read off what each booking recorded (N03 provenance): for every live bank rule (or the one standardId), uses (live bank bookings any version of the rule proposed; a reopened booking no longer counts, its rebooking does), lastUsedAt, changed (how many of them the person booked differently from the rule: another account, code, amount of a computed or complete leg, Durchlaufkonto, or another kind of booking), lastFive { uses, changed }, currentVersion { uses, changed } (since the last edit) and health: adjust when at least the setting rules.health_changed_of_last5 (default 2) of the last five uses were changed, else ok. versionIds lists the rule\'s versions, newest first (an edit replaces a rule and keeps the chain). Bookings made before this was recorded count nowhere; an ignore by a "Nicht buchen" rule is not a use. Refuses rule_not_found for an id that is no live bank rule of this workspace. Writes nothing.',
      ctxSchema({ standardId: STR }),
      (ctx, input) => ruleStats(ctx, as(input)),
    ),
    ctxAction(
      'backtest_bank_rule',
      'read',
      'Test a Buchungsregel against the bank lines already there, before saving it: recipe names the rule (standardId) or the line a new one is saved from (bankTxnId), and may change legs (as set_bank_standard takes them), or accountId with taxCode, matchText and viaAccountId. Every line of that counterparty and direction since the date since (YYYY-MM-DD, default rules.miner_lookback_days back) whose remittance carries the match text is a hit: hits counts the booked ones, identical those booked exactly as the recipe books them (the same journal lines, VAT included; a recipe that asks an amount compares accounts, codes, sides and the Durchlaufkonto), openLines and ignoredLines the rest; lines lists the newest 20 with date, signed amount, state, identical and entryId. recipe.fromBankTxnId names a line already booked to accounts instead: without legs its booked legs are the recipe (as set_bank_standard fromBankTxnId saves them), and the answer names the recipe tested as recipe { legs, viaAccountId, matchText }, ready to prefill a rule. Refuses invalid_input, invalid_recipe (the checks of set_bank_standard), rule_not_found, not_found, no_counterparty, not_booked_to_accounts. Writes nothing.',
      ctxSchema({ recipe: { type: 'object', properties: { standardId: STR, bankTxnId: STR, fromBankTxnId: STR, legs: { type: 'array', items: RECIPE_LEG }, accountId: STR, taxCode: STR, matchText: STR, viaAccountId: STR } }, since: STR }, ['recipe']),
      (ctx, input) => backtestRule(ctx, as(input)),
    ),
  ];
}
