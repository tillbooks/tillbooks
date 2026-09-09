/**
 * H08, the SIMPLE MAINTENANCE LOG verb surface, spread into `ACTIONS` as ONE line (the
 * `asset-actions` / `item-actions` precedent), so several agents appending to the append-only registry
 * at once collide over a line rather than a block. It is its OWN module rather than an extension of
 * `asset-actions.ts` so the two asset-cluster branches never contend for that file.
 *
 * The five verbs (create / update / cancel / get / list) are the H08 parity set. NON-POSTING: nothing
 * here posts a GL journal; the captured cost is descriptive TCO metadata (H09). Three writes carry
 * `idempotencyKey` (§H-IDEMPOTENT); the two reads advertise `readOnlyHint`. As with the sibling action
 * modules the helpers arrive as a parameter rather than an import, so the module graph stays acyclic:
 * `registry.ts` imports this file and this file must not import it back. Every field is camelCase and
 * maps straight through to the engine verb (the boundary is `additionalProperties: true`).
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import {
  assetMaintenanceLogCreate,
  assetMaintenanceLogUpdate,
  assetMaintenanceLogCancel,
  assetMaintenanceLogGet,
  assetMaintenanceLogList,
} from '../core/assets/index.js';

export interface MaintenanceActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  INT: { readonly type: 'integer' };
  BOOL: { readonly type: 'boolean' };
}

/** Widen an `ActionInput` to the engine's own input shape (the same cast `registry.ts` uses). */
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/** The H08 verbs, in append order (create, update, cancel, get, list). */
export function maintenanceActions(h: MaintenanceActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, INT, BOOL } = h;

  return [
    ctxAction(
      'asset_maintenance_log_create',
      'write',
      'Record a completed maintenance event against a fixed asset (H08): what was done, when, by whom and at what cost. NON-POSTING: it writes ONE asset_maintenance_log row (status=completed) and posts NO GL journal, so the captured cost is descriptive TCO metadata (feeding H09), never an expense or capitalisation booking (use the J expense or OP16 capitalisation flow for that). assetId must name an asset in this workspace that is NOT archived (asset_archived; history stays readable but new entries are blocked). maintenanceType is one of corrective | preventive | inspection | calibration | upgrade | other (invalid_maintenance_type). logDate is a required ISO date no more than 30 days in the future (missing_log_date / log_date_too_far). title is 1-200 chars. Every cost field is optional, integer Rappen, >= 0 (invalid_cost, never a float); when partsCostRappen and labourCostRappen are both given, a supplied costRappen total must equal their sum, otherwise the total is derived from them. Refused with not_found for a foreign asset (§H-TENANT). Idempotent on idempotencyKey: a replay returns the original log and writes no second row.',
      ctxSchema(
        {
          assetId: STR,
          logDate: STR,
          maintenanceType: STR,
          title: STR,
          description: STR,
          performedByUserId: STR,
          externalParty: STR,
          costRappen: INT,
          partsCostRappen: INT,
          labourCostRappen: INT,
          externalReference: STR,
          linkedDocumentId: STR,
          notes: STR,
          idempotencyKey: STR,
        },
        ['assetId', 'logDate', 'maintenanceType', 'title', 'idempotencyKey'],
      ),
      (ctx, input) => assetMaintenanceLogCreate(ctx, as(input)),
    ),
    ctxAction(
      'asset_maintenance_log_update',
      'write',
      'Correct a recent maintenance log entry (H08) through a patch object: title, description, costRappen, partsCostRappen, labourCostRappen, externalReference, notes. Identity fields (assetId, logDate, maintenanceType, the performer) are immutable after create; only the descriptive/cost fields present in patch change. Refused with log_locked once the entry is older than the workspace soft-edit window (default 90 days from creation: after it only cancel is allowed, protecting the historical record), log_cancelled if the entry is already cancelled (correct it with a fresh entry, not an edit), invalid_cost for a negative or non-integer cost, and not_found for a foreign id (§H-TENANT). Posts nothing. Idempotent on idempotencyKey.',
      ctxSchema(
        {
          id: STR,
          patch: {
            type: 'object',
            properties: {
              title: STR,
              description: STR,
              costRappen: INT,
              partsCostRappen: INT,
              labourCostRappen: INT,
              externalReference: STR,
              notes: STR,
            },
          },
          idempotencyKey: STR,
        },
        ['id', 'idempotencyKey'],
      ),
      (ctx, input) => assetMaintenanceLogUpdate(ctx, as(input)),
    ),
    ctxAction(
      'asset_maintenance_log_cancel',
      'write',
      'Soft-cancel a maintenance log entry entered in error (H08): it sets status=cancelled and stores a required non-empty reason. The row is NEVER hard-deleted (append-oriented, OR 957/958): a cancelled entry stays visible under the list "any" status filter for audit, and is excluded from the default completed-only list and the cost roll-up. Idempotent: cancelling an already-cancelled entry is a no-op that keeps the first reason and writes nothing. Refused with invalid_input for an empty reason and not_found for a foreign id (§H-TENANT). Posts nothing.',
      ctxSchema({ id: STR, reason: STR, idempotencyKey: STR }, ['id', 'reason', 'idempotencyKey']),
      (ctx, input) => assetMaintenanceLogCancel(ctx, as(input)),
    ),
    ctxAction(
      'asset_maintenance_log_get',
      'read',
      'Read one maintenance log entry by id (H08), completed or cancelled. A foreign id is not_found (§H-TENANT), never a leak of another workspace row.',
      ctxSchema({ id: STR }, ['id']),
      (ctx, input) => assetMaintenanceLogGet(ctx, as(input)),
    ),
    ctxAction(
      'asset_maintenance_log_list',
      'read',
      'List maintenance log entries (H08), newest first (by logDate then created_at). Optional filters: assetId (scope to one asset, the usual timeline read), maintenanceType, status (completed [default] | cancelled | any), fromDate / toDate (an ISO log-date window), hasCost (true = only entries with a captured cost, false = only those without), performedByUserId, and a case-insensitive search over title, description, externalParty and externalReference. Returns items, total, and totalCostRappen: the SUM of cost_rappen over the COMPLETED entries in the result (a cancelled or costless entry contributes 0), which is the asset TCO roll-up. Accepts a savedViewId (G00 saved-view seam). Read-only.',
      ctxSchema({
        assetId: STR,
        maintenanceType: STR,
        status: STR,
        fromDate: STR,
        toDate: STR,
        hasCost: BOOL,
        performedByUserId: STR,
        search: STR,
        savedViewId: STR,
      }),
      (ctx, input) => assetMaintenanceLogList(ctx, as(input)),
    ),
  ];
}
