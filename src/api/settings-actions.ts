/**
 * D172, the workspace settings registry's four verbs (two reads, two writes), defined here and spread
 * into `ACTIONS` as ONE line (the `fxActions` / `liquidityActions` precedent), so several agents
 * appending to the append-only registry at once collide over a line rather than a block.
 *
 * Every setting is a row of `src/core/settings/registry.ts`; these verbs are generic over it. A change
 * requires the owning capability of the KEY (the A24 map reads it from the input), a reason, and an
 * idempotency key; a governed seat's change drafts under the dial family the key declares (`customize`
 * for a display preference, the money family for a setting that changes what money does).
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { settingsGet, settingsList, settingsReset, settingsSet } from '../core/settings/index.js';
import type { ActionKind } from './actionKind.js';

export interface SettingsActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** A setting's value: the key's own schema (integer, number, boolean, string or enum) decides. */
const VALUE = { type: ['integer', 'number', 'boolean', 'string'] } as const;

export function settingsActions(h: SettingsActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  return [
    ctxAction(
      'settings_list',
      'read',
      'List every workspace setting (Einstellungen) from the registry: its key, the value in force, the default, whether this workspace overrides it (stale: true with ignoredStoredValue when a stored override no longer fits and the default applies), the value schema (type and bounds), the capability needed to change it, the dial family a change drafts under, and an en and de-CH label and description. A setting with no override reads its default.',
      ctxSchema(),
      (ctx) => settingsList(ctx),
    ),
    ctxAction(
      'settings_get',
      'read',
      'Read one workspace setting by key: the value in force, the default, whether it is overridden, who changed it and when. An unknown key is refused unknown_setting.',
      ctxSchema({ key: STR }, ['key']),
      (ctx, input) => settingsGet(ctx, input),
    ),
    ctxAction(
      'settings_set',
      'write:reversible:internal',
      "Change one workspace setting. value must fit the key's schema exactly (invalid_setting_value otherwise; an unknown key is unknown_setting), reason is required (a missing or blank reason is reason_required on every face) and recorded with the old and new value in the setting's history and on the audit trail. Needs the capability that owns the key. A Belegnummer setting is also refused when ledger.belegnummer_prefix is not empty or 1 to 12 characters from A-Z a-z 0-9 . _ / - starting with a letter or digit and not ending in a digit (belegnummer_prefix_invalid), and when the change could hand out a voucher number that already exists (belegnummer_display_clash, naming it). Setting the value already in force changes nothing. The way back is settings_set to the previous value or settings_reset.",
      // `reason` is required by the VERB (reason_required, on every face), not by the schema: a schema-required
      // gap is refused at the registry boundary as invalid_input, which would answer a missing reason
      // differently on REST/MCP than in the engine (critic D172 r1).
      ctxSchema({ key: STR, value: VALUE, reason: STR, idempotencyKey: STR }, ['key', 'value', 'idempotencyKey']),
      (ctx, input) => settingsSet(ctx, input),
    ),
    ctxAction(
      'settings_reset',
      'write:reversible:internal',
      "Return one workspace setting to its default by removing this workspace's override. reason is required (reason_required when missing or blank) and recorded with the old value in the setting's history and on the audit trail. A setting without an override is left as it is. A Belegnummer setting whose default could hand out a voucher number that already exists is refused (belegnummer_display_clash). The way back is settings_set to the previous value.",
      ctxSchema({ key: STR, reason: STR, idempotencyKey: STR }, ['key', 'idempotencyKey']),
      (ctx, input) => settingsReset(ctx, input),
    ),
  ];
}
