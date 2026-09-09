/**
 * G08's six verbs, defined here and spread into `ACTIONS` as one line (the `fxActions` precedent).
 *
 * All six are `ctxAction` registrations taking `workspaceId`, and §H-TENANT deserves its explanation
 * here rather than only in the spec: they read and write NO workspace row. The workspace is taken
 * solely so A24 can resolve the caller's capabilities, because `diagnostics.read` gates the calls
 * that read a person's own recorded errors and their own written prose. The files themselves stay
 * machine-scope, and the Studio panel says so on screen rather than letting a user assume a
 * workspace boundary protects a file that it does not.
 *
 * Three call shapes are deliberately UNGATED, each for its own reason (G08 §3): reporting a bug
 * without diagnostics is not a privilege, and gating it would silence the restricted-role user most
 * likely to hit one; changing your own privacy setting is self-determination, not administration;
 * and erasing your own data must never require a permission, the one place an RBAC wall would defeat
 * revDSG Art. 32 rather than support it.
 *
 * As with `fx-actions.ts`, the helpers arrive as a parameter rather than an import, so the module
 * graph stays acyclic: `registry.ts` imports this file and this file must not import it back.
 */

import { release } from 'node:os';
import { fileURLToPath } from 'node:url';

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import type { DiagnosticsPort } from '../core/ports.js';
import {
  clearDiagnostics,
  getDiagnostics,
  listFeedback,
  prepareFeedback,
  previewFeedback,
  recordDiagnostic,
  setDiagnostics,
  supportPaths,
} from '../core/support/index.js';
import type { SupportDeps } from '../core/support/index.js';
import { VERSION } from '../index.js';
import { resolveSupportDir } from './db-path.js';

/** The A24 capability gating every read of stored diagnostics or stored reports. */
export const DIAGNOSTICS_READ = 'diagnostics.read';

/**
 * The package root, so stack frames can be made install-relative.
 *
 * This is load-bearing for privacy, not tidiness: an absolute frame reads `/Users/<name>/...`, and
 * the OS username is exactly the linking identifier G08 §3 excludes.
 */
const INSTALL_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

/**
 * The host implementation of `DiagnosticsPort` (G08 §4), and the reason it lives here.
 *
 * `guarded()` in `registry.ts` calls `deps.diagnostics?.record(...)` in its catch, and the core ships
 * `noDiagnostics`. Until this existed, NO host built one: `makeApiDeps` and the Studio's dev bridge
 * both assembled `{ store, clock, ids, actor }` and nothing else, so the optional chain was always
 * undefined and `diagnostics.jsonl` could never gain a line however loudly the engine failed. The
 * opt-in switch, the journal table and "Clear now" all worked on a file that nothing wrote, which no
 * jsdom component test can see and which the browser flow found on the first run.
 *
 * Reading the preference is deliberately deferred to `recordDiagnostic`, which re-reads it on EVERY
 * call: a person switching capture off stops the recording immediately rather than at the next
 * restart, and the consent check stays in exactly one place.
 */
export function makeDiagnosticsPort(supportDir?: string): DiagnosticsPort {
  const deps: SupportDeps = {
    paths: supportPaths(supportDir ?? resolveSupportDir()),
    now: () => new Date().toISOString(),
    installRoot: INSTALL_ROOT,
    // `recordDiagnostic` reads only `paths` and `installRoot`; the rest of `SupportDeps` describes
    // the report renderer, which this seam never reaches.
    env: {
      version: VERSION,
      runtime: `node ${process.version}`,
      platform: `${process.platform} ${release()}`,
      locale: 'de-CH',
      client: 'engine',
    },
  };
  return { record: (entry) => recordDiagnostic(deps, entry) };
}

export interface ActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
  BOOL: { readonly type: 'boolean' };
  /** Injected in tests; production resolves the same `~/.till/` that `db-path.ts` already owns. */
  supportDir?: string | undefined;
}

function depsFor(ctx: WorkspaceContext, supportDir: string | undefined, locale: unknown): SupportDeps {
  return {
    paths: supportPaths(supportDir ?? resolveSupportDir()),
    now: () => ctx.clock.now(),
    installRoot: INSTALL_ROOT,
    env: {
      version: VERSION,
      runtime: `node ${process.version}`,
      platform: `${process.platform} ${release()}`,
      locale: typeof locale === 'string' && locale !== '' ? locale : 'de-CH',
      client: ctx.actor,
    },
  };
}

/**
 * Gate a call on `diagnostics.read`, but only when it actually reads recorded material.
 *
 * `prepare_feedback` with `includeDiagnostics:false` is a report in the user's own words and needs no
 * capability; the same call with the flag true reads the journal and does.
 */
function requireRead(ctx: WorkspaceContext, needed: boolean): Result | undefined {
  if (!needed) return undefined;
  const allowed = ctx.capabilities.assert(DIAGNOSTICS_READ);
  return allowed.ok ? undefined : allowed;
}

/** The G08 verbs, in append order. */
export function supportActions(h: ActionHelpers): readonly ActionDef[] {
  const { ctxAction, ctxSchema, STR, BOOL, supportDir } = h;
  const OBJ = { type: 'object' } as const;
  const reportFields = {
    kind: STR,
    subject: STR,
    message: STR,
    includeDiagnostics: BOOL,
    clientError: OBJ,
    locale: STR,
  };

  return [
    ctxAction(
      'preview_feedback',
      'read',
      'Render exactly what a feedback report would contain, writing nothing. Use it to show a person what would be sent before it is.',
      ctxSchema(reportFields, ['subject', 'message']),
      (ctx, input) =>
        requireRead(ctx, input.includeDiagnostics === true) ??
        previewFeedback(depsFor(ctx, supportDir, input.locale), input),
    ),
    ctxAction(
      'prepare_feedback',
      'write',
      'Write a feedback report to ~/.till/feedback and return a mailto link for it. TILL cannot send: the report is handed to the operator to send from their own mail client.',
      ctxSchema({ ...reportFields, idempotencyKey: STR }, ['subject', 'message', 'idempotencyKey']),
      (ctx, input) =>
        requireRead(ctx, input.includeDiagnostics === true) ??
        prepareFeedback(depsFor(ctx, supportDir, input.locale), input),
    ),
    ctxAction(
      'list_feedback',
      'read',
      'List the feedback reports written on this computer. Every one reads "prepared": TILL hands a report to a mail client and cannot observe whether it was sent.',
      ctxSchema(),
      (ctx) => requireRead(ctx, true) ?? listFeedback(depsFor(ctx, supportDir, undefined)),
    ),
    ctxAction(
      'get_diagnostics',
      'read',
      'Read the error-recording preference and every recorded entry: the whole of what TILL has kept about this person, readable at any time with no request to make.',
      ctxSchema(),
      (ctx) => requireRead(ctx, true) ?? getDiagnostics(depsFor(ctx, supportDir, undefined)),
    ),
    ctxAction(
      'set_diagnostics',
      'write',
      'Turn error recording on or off for this computer. Off is the default, and turning it off also deletes what was recorded. Set this only when the person asks for it.',
      ctxSchema({ capture: BOOL }, ['capture']),
      (ctx, input) => setDiagnostics(depsFor(ctx, supportDir, undefined), input),
    ),
    ctxAction(
      'clear_diagnostics',
      'write',
      'Delete every recorded error detail. Reports already written are kept.',
      ctxSchema(),
      (ctx) => clearDiagnostics(depsFor(ctx, supportDir, undefined)),
    ),
  ];
}
