/**
 * O00 (D199), the release verbs: What's new. Defined here and spread into
 * `ACTIONS` as ONE line (the `settingsActions` precedent), so several agents appending to the append-only
 * registry at once collide over a line rather than a block.
 *
 * `whats_new` and `whats_new_mark_seen` read and set the INSTALL's seen marker (`ApiDeps.supportDir`); no
 * ledger row moves. O01's upgrade verbs are not built yet (spec O01, held for the owner's design decision).
 */

import type { ActionDef, ActionInput, ApiDeps, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { err, ok } from '../core/result.js';
import { getSetting } from '../core/settings/index.js';
import { TILL_PACKAGE_VERSION } from '../core/version.js';
import { isVersion, compareVersions } from '../core/releases/notes.js';
import { markSeen, whatsNew } from '../core/releases/whatsNew.js';
import type { ActionKind } from './actionKind.js';

export interface ReleasesActionHelpers {
  ctxAction(
    name: string,
    kind: ActionKind,
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

/** Whether the open book holds at least one posted entry (the baseline's "existing install"). */
export function bookHasEntries(deps: ApiDeps): boolean {
  try {
    const row = deps.store.db.prepare('SELECT 1 AS one FROM journal_entry LIMIT 1').get() as { one: number } | undefined;
    return row !== undefined;
  } catch {
    return false;
  }
}

export function releasesActions(h: ReleasesActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;
  return [
    ctxAction(
      'whats_new',
      'read',
      "Read What's new: the running TILL version, the release notes this install has not seen yet (newest first) and the recent ones, each entry {version, date, items[]} with every item's kind (new, improved, fixed), icon, title and one-sentence body. With locale (en or de-CH) the texts come in that language, otherwise both. toast says whether the Studio shows its after-update note (setting releases.whats_new_toast); the lists are capped by releases.whats_new_versions. The notes ship with the build, so this works offline. An agent may read it to tell the person what changed.",
      ctxSchema({ locale: STR }),
      (ctx, input, deps) => {
        const locale = typeof input.locale === 'string' && (input.locale === 'en' || input.locale.startsWith('de')) ? input.locale : undefined;
        const answer = whatsNew({
          running: TILL_PACKAGE_VERSION,
          supportDir: deps.supportDir,
          existingInstall: () => bookHasEntries(deps),
          max: getSetting<number>(ctx, 'releases.whats_new_versions'),
          locale,
        });
        return ok({ ...answer, toast: getSetting<boolean>(ctx, 'releases.whats_new_toast') });
      },
    ),
    ctxAction(
      'whats_new_mark_seen',
      'write:final:ui-state',
      "Mark the release notes of this install as read up to the running version (the Studio calls it when the person closes What's new). It only decides whether the after-update note shows again; no book changes. version, when given, must be the running version. Refused seen_unwritable when the support folder cannot be written; a face without one (stdio MCP) answers persisted: false.",
      ctxSchema({ version: STR }),
      (_ctx, input, deps) => {
        if (input.version !== undefined && (typeof input.version !== 'string' || !isVersion(input.version) || compareVersions(input.version, TILL_PACKAGE_VERSION) !== 0)) {
          return err('invalid_input', { field: 'version' });
        }
        // A face with no support folder (stdio MCP, an embedder) has no install marker to write: nothing to persist.
        if (deps.supportDir === undefined) return ok({ seen: TILL_PACKAGE_VERSION, persisted: false });
        try {
          const marker = markSeen({ running: TILL_PACKAGE_VERSION, supportDir: deps.supportDir });
          return ok({ seen: marker.seen, persisted: true });
        } catch (e) {
          return err('seen_unwritable', { reason: e instanceof Error ? e.message : String(e) });
        }
      },
    ),
  ];
}
