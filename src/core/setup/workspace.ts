/**
 * A00 workspace minting and fiscal config.
 *
 * `createWorkspace` is the one verb that mints a `workspace_id` (§H-TENANT); everything else in TILL
 * references it. It runs before any workspace context exists, so it takes explicit deps rather than a
 * WorkspaceContext. It seeds the chart (A01) and stamps the audit log (A03) once those land; today it
 * mints and configures.
 *
 * `base_currency` and `fiscal_year_start` are locked once any entry is posted (`needs_empty_ledger`):
 * the first protects the §H-FX base amounts already stored on every posted line, the second protects
 * A03's period math.
 */

import type { SqliteStore } from '../store/sqlite-store.js';
import type { Clock } from '../clock.js';
import type { IdGen } from '../ids.js';
import type { WorkspaceContext } from '../context.js';
import { makeContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { seedChartOfAccounts } from '../accounts/index.js';
import { seedDefaultChecklistRules } from '../checklists/autostart.js';
import { appendAuditLog } from '../ledger/auditLog.js';
import { ledgerPorts } from '../ledger/index.js';
import { holdsAnyMembership, seatFirstOwner } from '../access/index.js';
import type { IdentitySource } from '../access/index.js';
import { LEGAL_FORMS, VAT_METHODS, VAT_TIMINGS, CURRENCIES, isFiscalYearStart } from './enums.js';
import { isLedgerLocked } from './ledgerLock.js';

export interface SetupDeps {
  store: SqliteStore;
  clock: Clock;
  ids: IdGen;
  /** The actor to stamp on the workspace-create audit row; defaults to 'system'. */
  actor?: string;
  /**
   * M01/D111: HOW this request's identity was established (`served_subject` in served mode, absent or
   * `local_client` locally). Set per request by the transport, exactly as on `ApiDeps`/`WorkspaceContext`.
   * `createWorkspace` reads it to gate served-mode creation (see the guard there); every existing local
   * caller leaves it absent and is unaffected.
   */
  identitySource?: IdentitySource | undefined;
}

export interface CreateWorkspaceInput {
  name: string;
  baseCurrency?: string;
  fiscalYearStart?: string;
  legalForm?: string;
  idempotencyKey?: string;
}

function validateFiscalFields(input: {
  legalForm?: string;
  baseCurrency?: string;
  fiscalYearStart?: string;
}): Result | null {
  if (input.legalForm !== undefined && !LEGAL_FORMS.has(input.legalForm)) {
    return err('invalid_legal_form', { legalForm: input.legalForm });
  }
  if (input.baseCurrency !== undefined && !CURRENCIES.has(input.baseCurrency)) {
    return err('invalid_currency', { baseCurrency: input.baseCurrency });
  }
  if (input.fiscalYearStart !== undefined && !isFiscalYearStart(input.fiscalYearStart)) {
    return err('invalid_fiscal_year_start', { fiscalYearStart: input.fiscalYearStart });
  }
  return null;
}

export function createWorkspace(deps: SetupDeps, input: CreateWorkspaceInput): Result {
  // D111, served-mode create gate. In served (reverse-proxy) mode `create_workspace` is DENIED to a
  // served STRANGER (a subject seated in NO workspace) and ALLOWED to a served MEMBER (a subject
  // already seated in at least one workspace). After M01 F1 a stranger can no longer ACCESS what it
  // mints, so an ungated create is a spam/DoS door, not a privilege break; this closes it while
  // keeping the Treuhänder remote new-mandate flow (a member creating another mandate). LOCAL/loopback
  // mode is UNAFFECTED: `identitySource` is `served_subject` only when a transport attested a proxy
  // subject, so a local caller (absent or `local_client`) skips this entirely and the first-run
  // create/restore/adopt path is unchanged. Denied FIRST, before input validation and before the
  // idempotency namespace, so a stranger learns nothing about the request it was refused.
  if (deps.identitySource === 'served_subject' && !holdsAnyMembership(deps.store, deps.actor ?? 'system')) {
    return err('permission_denied', { capability: 'create_workspace', role: null });
  }

  if (typeof input.name !== 'string' || input.name.trim().length === 0) {
    return err('invalid_name');
  }
  const invalid = validateFiscalFields(input);
  if (invalid) return invalid;

  const mint = (): Result => {
    const id = deps.ids.next('ws');
    deps.store.db
      .prepare(
        `INSERT INTO workspace (id, name, legal_form, base_currency, fiscal_year_start, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name.trim(),
        input.legalForm ?? null,
        // The one 'CHF' literal in the engine that is a genuine DEFAULT, and it stays. Everywhere
        // else a hardcoded franc is a guess that overwrites a setting: `baseCurrencyOf(ctx)` can
        // always be asked what the book is in, so writing the literal instead stamped francs onto a
        // row in a book that was never in francs. Here there is nothing to ask. This statement MINTS
        // the workspace: it is the row every other path reads, no earlier one exists to inherit from,
        // and the caller is choosing the answer rather than omitting it. A Swiss accounting app
        // opening Swiss books is a defensible starting point, and it is visible and changeable
        // (`updateWorkspace`, until the first posting locks it under `needs_empty_ledger`).
        //
        // Do not "fix" this one to match its neighbours: there is no hidden wrong answer behind it,
        // and replacing a real default with a lookup of the row being inserted would be circular.
        input.baseCurrency ?? 'CHF',
        input.fiscalYearStart ?? '01-01',
        deps.clock.now(),
      );
    // Born with the KMU chart (A01).
    seedChartOfAccounts(makeContext(deps.store, { workspaceId: id, clock: deps.clock, ids: deps.ids }));
    // Born with the two default checklist rules (G22 §10.8, D129): the MWST-Periode and the
    // Monatsabschluss start themselves on the daily tick once a period has ended; the owner disables
    // either on /automations and the seed never re-enables it (it keys on the rule id). The author
    // is the creating actor, the identity the A24 gate runs the firing under; the run the rule starts
    // records the RULE as its creator. Deferred from N1 to the day the month_close template existed.
    seedDefaultChecklistRules(makeContext(deps.store, { workspaceId: id, actor: deps.actor ?? 'system', clock: deps.clock, ids: deps.ids }));
    // Stamp the genesis row of the workspace's A03 audit chain: it anchors the chain and proves when
    // and by whom the workspace was created (§H-AUDIT). Actor is 'system' (no user record exists yet).
    appendAuditLog(
      { store: deps.store, workspaceId: id, ids: deps.ids },
      { entityKind: 'workspace', entityId: id, action: 'create', actor: deps.actor ?? 'system', at: deps.clock.now() },
    );
    // M01/D111, the served creator is SEATED (P3 security critic F6). Locally a bare create leaves the
    // book unprovisioned and A24's step 1 lets the file holder in; a served identity gets no such
    // grant, so a served member's bare `create_workspace` used to mint a tenant nobody could open,
    // invite into or archive: an orphan, and a spam vector for every member. D111 says a member MAY
    // create, and the only reading that makes the result usable is the one `onboard_client` already
    // gives: the creator is the accepted owner from birth. `seatFirstOwner` seats the caller first
    // (and the D50 local seats beside it, exactly as `onboard_client` and the first invite do), on
    // the real A03 audit port so the `claim_owner` rows land on the chain. Local callers are
    // untouched: `identitySource` is `served_subject` only when a transport attested a proxy subject.
    if (deps.identitySource === 'served_subject') {
      seatFirstOwner(
        makeContext(deps.store, {
          workspaceId: id,
          actor: deps.actor ?? 'system',
          clock: deps.clock,
          ids: deps.ids,
          ...ledgerPorts({ store: deps.store, workspaceId: id, ids: deps.ids }),
        }),
      );
    }
    return ok({ workspaceId: id });
  };

  // createWorkspace mints the id, so its idempotency lives in a pre-workspace '_system' namespace.
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return deps.store.rememberIdempotent('_system', input.idempotencyKey, 'create_workspace', mint);
  }
  return mint();
}

/** One row of the workspace picker: what a human needs to recognise their own books. */
export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  legalForm: string | null;
  baseCurrency: string;
  fiscalYearStart: string;
  /** A23: an archived mandate is read-only and hidden from the default picker, never deleted. */
  archived: boolean;
  createdAt: string;
}

/**
 * List every workspace in this database that the calling actor may open (D12, scoped by A23).
 *
 * This is the ONE read that legitimately crosses the tenant boundary (§H-TENANT), because it IS the
 * tenant list: a reloaded Studio has no `workspaceId` yet and must be able to re-find its books
 * rather than mint a duplicate. It carries no ledger data, only the identifying fields a picker
 * shows. Ordering is `created_at DESC, rowid DESC`: newest first, with insertion order as the
 * tiebreak, so a picker does not reshuffle between two identical calls.
 *
 * A23 scopes it two ways:
 *  - PER ACTOR, when the caller supplies one (the registry always does). An UNPROVISIONED workspace
 *    (no `workspace_member` rows) is visible to every D13 actor: it is nobody's yet, and hiding it
 *    would strand the solo book this read exists to re-find. A PROVISIONED one is visible only to
 *    its accepted members, so a Treuhänder revoked from a mandate stops seeing even its name
 *    (revDSG separation; the books inside were already unreachable via A24's D50 read gate).
 *    An actor-less call (an embedder holding the store directly) stays unscoped: a host holding
 *    the SQLite file already holds the tenant list, the same trust boundary `capability.ts` states.
 *  - BY ARCHIVE STATE: an archived mandate drops out unless `includeArchived` asks for it.
 */
export function listWorkspaces(
  deps: { store: SqliteStore; actor?: string },
  input: { includeArchived?: boolean } = {},
): Result {
  const rows = deps.store.db
    .prepare(
      `SELECT w.id, w.name, w.legal_form, w.base_currency, w.fiscal_year_start, w.archived, w.created_at
         FROM workspace w
        WHERE (? IS NULL
               OR NOT EXISTS (SELECT 1 FROM workspace_member m WHERE m.workspace_id = w.id)
               OR EXISTS (SELECT 1
                            FROM workspace_member m
                            JOIN user u ON u.id = m.user_id
                           WHERE m.workspace_id = w.id
                             AND u.actor_id = ?
                             AND m.accepted_at IS NOT NULL))
          AND (w.archived = 0 OR ? = 1)
        ORDER BY w.created_at DESC, w.rowid DESC`,
    )
    .all(deps.actor ?? null, deps.actor ?? null, input.includeArchived === true ? 1 : 0) as {
    id: string;
    name: string;
    legal_form: string | null;
    base_currency: string;
    fiscal_year_start: string;
    archived: number;
    created_at: string;
  }[];

  const workspaces: WorkspaceSummary[] = rows.map((r) => ({
    workspaceId: r.id,
    name: r.name,
    legalForm: r.legal_form,
    baseCurrency: r.base_currency,
    fiscalYearStart: r.fiscal_year_start,
    archived: r.archived === 1,
    createdAt: r.created_at,
  }));
  return ok({ workspaces });
}

/**
 * A23: one workspace's roster metadata, for the switcher header.
 *
 * Deliberately LIGHTER than A00's `getCompanyProfile` (which returns the full fiscal and creditor
 * config), and it carries NO role or permission field: `whoami` is the one verb in this repo that
 * answers a permission question (A24's standing rule), and a switcher header composes the two.
 */
export function getWorkspace(ctx: WorkspaceContext): Result {
  const r = ctx.store.db
    .prepare(
      `SELECT id, name, legal_form, base_currency, fiscal_year_start, archived, created_at
         FROM workspace
        WHERE id = ?`,
    )
    .get(ctx.workspaceId) as
    | {
        id: string;
        name: string;
        legal_form: string | null;
        base_currency: string;
        fiscal_year_start: string;
        archived: number;
        created_at: string;
      }
    | undefined;
  // Unreachable through the registry (the boundary answers workspace_not_found first), kept for an
  // embedder calling the engine directly (P9: return the rejection, never throw).
  if (r === undefined) return err('workspace_not_found', { workspaceId: ctx.workspaceId });
  const workspace: WorkspaceSummary = {
    workspaceId: r.id,
    name: r.name,
    legalForm: r.legal_form,
    baseCurrency: r.base_currency,
    fiscalYearStart: r.fiscal_year_start,
    archived: r.archived === 1,
    createdAt: r.created_at,
  };
  return ok({ workspace });
}

/**
 * A23: archive a finished mandate. A reversible FLAG, never a delete (OR Art. 958f retention is
 * per-client and unaffected: the row and its books stay intact and exportable).
 *
 * The read-only consequence is enforced at the shared `ctxAction` boundary in `src/api/registry.ts`
 * (every write except `archive_workspace` itself refuses an archived tenant with
 * `workspace_archived`), NOT here, so a verb registered next year is read-only-in-archive with no
 * edit anywhere. Idempotent per key; keyless replay re-asserts the same absolute state.
 */
export function archiveWorkspace(ctx: WorkspaceContext, input: { idempotencyKey?: string }): Result {
  return setArchived(ctx, input, true);
}

/** A23: put an archived mandate back in play. The exact mirror of `archiveWorkspace`. */
export function unarchiveWorkspace(ctx: WorkspaceContext, input: { idempotencyKey?: string }): Result {
  return setArchived(ctx, input, false);
}

function setArchived(
  ctx: WorkspaceContext,
  input: { idempotencyKey?: string },
  archived: boolean,
): Result {
  const run = (): Result => {
    ctx.store.db
      .prepare('UPDATE workspace SET archived = ? WHERE id = ?')
      .run(archived ? 1 : 0, ctx.workspaceId);
    // §H-AUDIT: who retired (or revived) the mandate, and when. Same chain as every other act.
    ctx.audit.record({
      entityKind: 'workspace',
      entityId: ctx.workspaceId,
      action: archived ? 'archive' : 'unarchive',
      actor: ctx.actor,
      at: ctx.clock.now(),
    });
    // The result path DISCRIMINATES the automation event pair (`workspace.archived` resolves
    // `result.archivedWorkspaceId`, `workspace.unarchived` resolves `result.unarchivedWorkspaceId`):
    // only one of the two is present per call, so exactly one event fires (the `dunning.proposed`
    // null-collapse in `core/automation/events.ts`, used deliberately).
    return ok({
      workspaceId: ctx.workspaceId,
      archived,
      ...(archived
        ? { archivedWorkspaceId: ctx.workspaceId }
        : { unarchivedWorkspaceId: ctx.workspaceId }),
    });
  };
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(
      ctx.workspaceId,
      input.idempotencyKey,
      archived ? 'archive_workspace' : 'unarchive_workspace',
      run,
    );
  }
  return run();
}

export function setFiscalConfig(
  ctx: WorkspaceContext,
  input: { legalForm?: string; baseCurrency?: string; fiscalYearStart?: string },
): Result {
  const invalid = validateFiscalFields(input);
  if (invalid) return invalid;

  if (input.baseCurrency !== undefined || input.fiscalYearStart !== undefined) {
    // The SAME predicate `getCompanyProfile` reports as `ledgerLocked`, so the control the Studio
    // disables and the write the engine refuses can never disagree.
    if (isLedgerLocked(ctx)) {
      return err('needs_empty_ledger', { field: input.baseCurrency !== undefined ? 'base_currency' : 'fiscal_year_start' });
    }
  }

  const sets: string[] = [];
  const params: string[] = [];
  if (input.legalForm !== undefined) {
    sets.push('legal_form = ?');
    params.push(input.legalForm);
  }
  if (input.baseCurrency !== undefined) {
    sets.push('base_currency = ?');
    params.push(input.baseCurrency);
  }
  if (input.fiscalYearStart !== undefined) {
    sets.push('fiscal_year_start = ?');
    params.push(input.fiscalYearStart);
  }
  if (sets.length > 0) {
    ctx.store.db
      .prepare(`UPDATE workspace SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, ctx.workspaceId);
  }
  return ok();
}

export function setVatMethod(
  ctx: WorkspaceContext,
  input: { vatMethod: string; vatAccounting: string },
): Result {
  if (!VAT_METHODS.has(input.vatMethod)) {
    return err('invalid_vat_method', { vatMethod: input.vatMethod });
  }
  if (!VAT_TIMINGS.has(input.vatAccounting)) {
    return err('invalid_vat_accounting', { vatAccounting: input.vatAccounting });
  }
  ctx.store.db
    .prepare('UPDATE workspace SET vat_method = ?, vat_accounting = ? WHERE id = ?')
    .run(input.vatMethod, input.vatAccounting, ctx.workspaceId);
  return ok();
}
