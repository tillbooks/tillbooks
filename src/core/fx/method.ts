/**
 * §H-FX, the MWSTV Art. 45 Abs. 5 method lock.
 *
 * The foundation RECORDED which admissible basis priced a posting (`exchange_rate.method`) and
 * enforced nothing, so a workspace could price January on the Tageskurs, February on the
 * Monatsmittelkurs, and file a return built out of two incompatible bases. This module is the
 * enforcement, and the shape of the enforcement is the interesting part.
 *
 * ## The statute, fetched not recalled (2026-07-25, re-transcribed from source 2026-07-25)
 *
 * MWSTV, SR 641.201, Stand 1.1.2025, fetched from
 * https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/2009/828/20250101/de/html/fedlex-data-admin-ch-eli-cc-2009-828-20250101-de-html.html
 *
 * - **MWSTV Art. 45 Abs. 3** (SR 641.201): conversion happens at the rate published by the ESTV, and
 *   the taxable person chooses between the **Monatsmittelkurs** and the **Tageskurs für den Verkauf
 *   von Devisen**. The SELLING rate: not a buying rate, not a mid-rate.
 * - **Abs. 3bis**: for a currency the ESTV publishes no rate for, a domestic bank's published daily
 *   selling rate applies. That is a MANDATED FALLBACK, not a fourth option on the menu, which is why
 *   `bank` below is admissible under every election and electable under none.
 * - **Abs. 4**: a member of a group may use the group's own conversion rate, on the condition that
 *   it is applied both inside the group and towards third parties.
 * - **Abs. 5**, verbatim: "Das gewählte Vorgehen (Monatsmittel-, Tages- oder Konzernkurs) ist
 *   während mindestens einer Steuerperiode beizubehalten."
 * - **MWSTG Art. 34 Abs. 2** (SR 641.20, Stand 1.1.2025): "Als Steuerperiode gilt das Kalenderjahr."
 *   Abs. 3 (the business-year option) carries the Fedlex footnote "Noch nicht in Kraft", so there is
 *   no configurable period to honour.
 * - **ESTV, "Fremdwährungskurse MWST"** (https://www.estv.admin.ch/de/mwst-fremdwaehrungskurse, the
 *   URL slug is ASCII, the page heading is not), verbatim:
 *   "Das gewählte Vorgehen muss während mindestens einer Steuerperiode beibehalten werden. Es ist
 *   für die Berechnung der Inlandsteuer, der Bezugsteuer und des Vorsteuerabzugs anzuwenden. Ein
 *   Wechsel ist nur auf den Beginn einer neuen Steuerperiode möglich."
 *
 * ## What "cannot be switched" can honestly mean here
 *
 * TILL is local-first and append-only, so the lock cannot be "the setting is immutable": a brand-new
 * workspace has chosen nothing yet, an operator who mistypes the choice before booking anything is
 * fixing a typo rather than switching a basis, and 1 January is the moment the statute itself names
 * as switchable. What must never happen is that books ALREADY MADE get re-based under a claim that
 * was not true when they were made. So:
 *
 *   **An election may be written for a Steuerperiode while that period, and every period after it,
 *   still holds no posted foreign-currency entry.**
 *
 * One rule, and it covers every case the statute cares about. A new workspace is free. A typo before
 * the first EUR bill is free. The year turn is free, because the new year has no postings yet, no
 * matter how full the old one is. And the moment one foreign-currency entry is posted, the basis for
 * its period is settled: re-asserting the same method is still a no-op, and asserting a different one
 * is `fx_method_locked`, naming the earliest period whose basis is still open.
 *
 * An election CARRIES FORWARD. A taxable person does not re-elect annually, so the basis governing a
 * date is the newest election on or before that date's year, and a period before the first election
 * is simply unelected: nothing is enforced there, because the workspace has claimed nothing.
 *
 * ## What the lock can and cannot see
 *
 * It refuses a rate that DECLARES a basis the workspace is not on. It cannot refuse a basis a rate
 * never claimed: a rate recorded without a `method`, and a rate a caller passes explicitly to
 * `postEntry` (a bank advice, a group rate read off a statement), assert nothing, and coercing them
 * into the elected basis would be inventing a claim on the operator's behalf. Those stay legible for
 * exactly what they are, and an ESTV control sees an undeclared rate as undeclared.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result, Err } from '../result.js';

/**
 * The §H-ENUM list of methods a workspace can ELECT: the Art. 45 Abs. 3 choice between the two ESTV
 * series, plus the Abs. 4 group rate.
 *
 * `bank` is deliberately absent. Abs. 3bis makes a domestic bank's daily selling rate the fallback
 * for currencies the ESTV publishes no rate for, which is a per-currency necessity rather than an
 * accounting policy: a workspace on the Monatsmittelkurs that buys in a currency the ESTV does not
 * publish still has to book it, and refusing that rate would make a legitimate transaction
 * unbookable. See `FX_FALLBACK_METHOD`.
 */
export const FX_ELECTABLE_METHODS: readonly string[] = ['daily', 'monthly_avg', 'group'];

/** MWSTV Art. 45 Abs. 3bis: admissible under every election, electable under none. */
export const FX_FALLBACK_METHOD = 'bank';

/** A Steuerperiode is a calendar year (MWSTG Art. 34 Abs. 2). Nothing finer is representable. */
const TAX_PERIOD_RE = /^\d{4}$/;

/** The Steuerperiode a `YYYY-MM-DD` date falls in. */
export function taxPeriodOf(date: string): string {
  return date.slice(0, 4);
}

interface ElectionRow {
  tax_period: string;
  method: string;
  created_at: string;
}

export interface FxMethodElection {
  /** The method that governs. */
  method: string;
  /** The Steuerperiode the election was actually MADE for, which may precede the one asked about. */
  electedFor: string;
}

/**
 * The election governing `date`, or `null` when the workspace had elected nothing by then.
 *
 * §H-TENANT: workspace-scoped, like every other query in the engine.
 */
export function electedFxMethod(ctx: WorkspaceContext, date: string): FxMethodElection | null {
  const row = ctx.store.db
    .prepare(
      `SELECT tax_period, method FROM fx_method_election
        WHERE workspace_id = ? AND tax_period <= ?
        ORDER BY tax_period DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, taxPeriodOf(date)) as ElectionRow | undefined;
  return row === undefined ? null : { method: row.method, electedFor: row.tax_period };
}

/**
 * The date of the NEWEST posted foreign-currency entry, or null when the ledger has none.
 *
 * A foreign-currency entry is one whose lines carry an `fx_rate`. A base-currency entry stores a NULL
 * rate (a rate of 1 is not FX, §H-FX), so a CHF-only ledger never locks anything, which is right: it
 * has converted nothing and therefore claimed no basis.
 */
function newestFxPosting(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare(
      `SELECT MAX(e.date) AS newest
         FROM journal_entry e
         JOIN journal_line l ON l.entry_id = e.id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND l.fx_rate IS NOT NULL`,
    )
    .get(ctx.workspaceId) as { newest: string | null };
  return row.newest;
}

/** The earliest Steuerperiode whose basis is still open, or null when every period is still open. */
function earliestChangeablePeriod(ctx: WorkspaceContext): string | null {
  const newest = newestFxPosting(ctx);
  return newest === null ? null : String(Number(taxPeriodOf(newest)) + 1);
}

export interface SetFxMethodInput {
  /** One of `FX_ELECTABLE_METHODS`. */
  method: string;
  /** The Steuerperiode as a four-digit calendar year. Defaults to the year of the clock. */
  taxPeriod?: string;
}

/**
 * Elect the MWSTV Art. 45 conversion basis for a Steuerperiode.
 *
 * No idempotency key, and that is a conscious §H-IDEMPOTENT exemption of the same family as
 * `set_vat_method`: this sets ONE field of ONE period to an ABSOLUTE value. A duplicate delivery
 * re-asserts the same election and cannot double-count, so a key would buy replay protection that
 * nothing here needs. Re-electing the same method is reported as `changed: false` and writes nothing
 * at all, which is what makes the re-assertion safe even after the period has locked.
 */
export function setFxMethod(ctx: WorkspaceContext, input: SetFxMethodInput): Result {
  const capable = ctx.capabilities.assert('post');
  if (!capable.ok) return capable;

  if (typeof input.method !== 'string' || !FX_ELECTABLE_METHODS.includes(input.method)) {
    return err('invalid_fx_method', {
      method: input.method,
      allowed: FX_ELECTABLE_METHODS,
      fallbackMethod: FX_FALLBACK_METHOD,
      reason:
        input.method === FX_FALLBACK_METHOD
          ? 'MWSTV Art. 45 Abs. 3bis is the mandated fallback for currencies the ESTV does not publish, not a basis a workspace elects: it stays admissible under every election'
          : 'the electable bases are the Art. 45 Abs. 3 choice (daily | monthly_avg) and the Abs. 4 group rate',
    });
  }
  const taxPeriod = input.taxPeriod ?? taxPeriodOf(ctx.clock.now().slice(0, 10));
  if (typeof taxPeriod !== 'string' || !TAX_PERIOD_RE.test(taxPeriod)) {
    return err('invalid_input', {
      field: 'taxPeriod',
      taxPeriod: input.taxPeriod,
      expected: 'YYYY',
      reason: 'a Steuerperiode is a calendar year (MWSTG Art. 34 Abs. 2)',
    });
  }

  const current = ctx.store.db
    .prepare('SELECT tax_period, method FROM fx_method_election WHERE workspace_id = ? AND tax_period = ?')
    .get(ctx.workspaceId, taxPeriod) as ElectionRow | undefined;

  // Re-asserting the same election changes nothing, so it is never a switch and is decided BEFORE the
  // lock: a retry must stay safe after the period has locked, or the safe way to call this verb would
  // be to not call it.
  if (current !== undefined && current.method === input.method) {
    return ok({ taxPeriod, method: input.method, changed: false });
  }

  // The lock. `>= taxPeriod-01-01` rather than "inside the period" on purpose: an election carries
  // forward, so writing 2025 would silently re-base 2026 too whenever 2026 has no row of its own.
  const newest = newestFxPosting(ctx);
  if (newest !== null && newest >= `${taxPeriod}-01-01`) {
    const governing = electedFxMethod(ctx, `${taxPeriod}-12-31`);
    return err('fx_method_locked', {
      taxPeriod,
      submittedMethod: input.method,
      electedMethod: governing?.method ?? null,
      electedFor: governing?.electedFor ?? null,
      newestForeignCurrencyPosting: newest,
      earliestChangeablePeriod: earliestChangeablePeriod(ctx),
      reason:
        'a foreign-currency entry is already posted in this Steuerperiode: the chosen basis must be kept for at least one Steuerperiode and a change is only possible at the start of a new one (MWSTV Art. 45 Abs. 5, MWSTG Art. 34 Abs. 2)',
    });
  }

  const at = ctx.clock.now();
  ctx.store.db
    .prepare(
      `INSERT INTO fx_method_election (workspace_id, tax_period, method, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, tax_period) DO UPDATE SET method = excluded.method,
                                                            created_at = excluded.created_at,
                                                            created_by = excluded.created_by`,
    )
    .run(ctx.workspaceId, taxPeriod, input.method, at, ctx.actor);
  ctx.audit.record({
    entityKind: 'fx_method_election',
    entityId: `${ctx.workspaceId}:${taxPeriod}`,
    action: 'elect',
    actor: ctx.actor,
    at,
  });
  return ok({ taxPeriod, method: input.method, changed: true, previousMethod: current?.method ?? null });
}

export interface GetFxMethodInput {
  /** A Steuerperiode (`YYYY`). Ignored when `date` is given. */
  taxPeriod?: string;
  /** Any date inside the Steuerperiode to ask about. */
  date?: string;
}

/**
 * Which basis governs a Steuerperiode, whether it is still open, and the full election history.
 *
 * `locked` is reported on the READ so a client can disable the control AT the control instead of
 * letting an operator pick a basis and only learn at save time that the year is settled. That is the
 * same lesson `getCompanyProfile` learned about `ledgerLocked`.
 */
export function getFxMethod(ctx: WorkspaceContext, input: GetFxMethodInput = {}): Result {
  let taxPeriod: string;
  if (typeof input.date === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}/.test(input.date)) return err('invalid_input', { field: 'date', expected: 'YYYY-MM-DD' });
    taxPeriod = taxPeriodOf(input.date);
  } else if (input.taxPeriod !== undefined) {
    if (typeof input.taxPeriod !== 'string' || !TAX_PERIOD_RE.test(input.taxPeriod)) {
      return err('invalid_input', { field: 'taxPeriod', expected: 'YYYY' });
    }
    taxPeriod = input.taxPeriod;
  } else {
    taxPeriod = taxPeriodOf(ctx.clock.now().slice(0, 10));
  }

  const governing = electedFxMethod(ctx, `${taxPeriod}-12-31`);
  const newest = newestFxPosting(ctx);
  const rows = ctx.store.db
    .prepare(
      'SELECT tax_period, method, created_at FROM fx_method_election WHERE workspace_id = ? ORDER BY tax_period DESC',
    )
    .all(ctx.workspaceId) as ElectionRow[];

  return ok({
    taxPeriod,
    method: governing?.method ?? null,
    electedFor: governing?.electedFor ?? null,
    locked: newest !== null && newest >= `${taxPeriod}-01-01`,
    newestForeignCurrencyPosting: newest,
    earliestChangeablePeriod: earliestChangeablePeriod(ctx),
    electableMethods: FX_ELECTABLE_METHODS,
    fallbackMethod: FX_FALLBACK_METHOD,
    elections: rows.map((r) => ({ taxPeriod: r.tax_period, method: r.method, electedAt: r.created_at })),
  });
}

/**
 * The gate both the rate WRITE and the rate RESOLUTION run through: may a rate declaring `method`
 * price `date` in this workspace?
 *
 * Returns `null` when it may, and the refusal otherwise. Three ways to pass, and they are all the
 * same rule read from different sides: the workspace has elected nothing (it has claimed no basis),
 * the rate declares nothing (it claims no basis), or the declared basis is the elected one, or is the
 * Abs. 3bis fallback that no election can exclude.
 */
export function assertFxMethodAdmissible(
  ctx: WorkspaceContext,
  date: string,
  method: string | null | undefined,
  fix: string,
): Err | null {
  if (method === null || method === undefined || method === FX_FALLBACK_METHOD) return null;
  const elected = electedFxMethod(ctx, date);
  if (elected === null || elected.method === method) return null;
  return err('fx_method_not_elected', {
    method,
    electedMethod: elected.method,
    electedFor: elected.electedFor,
    taxPeriod: taxPeriodOf(date),
    date,
    fallbackMethod: FX_FALLBACK_METHOD,
    reason: `this workspace converts on the ${elected.method} basis for this Steuerperiode and the chosen basis must be kept for at least one Steuerperiode (MWSTV Art. 45 Abs. 5): ${fix}`,
  }) as Err;
}
