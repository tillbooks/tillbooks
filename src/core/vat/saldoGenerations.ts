/**
 * F11: the ONLY module that may name the Saldo approval tables or the method eras in SQL.
 *
 * ## Why the encapsulation is a rule and not a preference
 *
 * The previous attempt at multi-rate Saldo turned `vat_saldo_rate` from a CURRENT-STATE table into a
 * HISTORY table and left the name alone. Three independent reviews later, two queries outside the
 * change were still counting its rows as current state:
 *
 *   - `ech0217.ts` refused a lawful export with `saldo_rates_exceed_form_lines configuredRates=3`
 *     for a workspace that had held exactly ONE Saldosteuersatz in every period of its life, because
 *     it had been re-granted twice;
 *   - `resolveTax.saldoOutputFormLine` read `rates.length === 1` as "one approved rate" and, once a
 *     second generation existed, reported NO Ziffer at all on every preview, while the return it
 *     previewed still filed under 323.
 *
 * Neither was in the diff. Both were silent wrong answers rather than crashes. So generation 5 drops
 * `vat_saldo_rate` outright and `test/vat/saldo-table-encapsulation.test.mjs` refuses any SQL naming
 * the new tables outside this file. A stale reader is now a `no such table` in a test run instead of
 * a wrong figure on a signed form, and a NEW stale reader cannot be written at all.
 *
 * ## The two questions every consumer actually has
 *
 * Not "what is configured" but "what governed THIS period", and "did it change inside it". Both are
 * answered here, both take a date, and neither has a variant that forgets to. `generationsGoverning`
 * and `methodsGoverning` return a LIST precisely so a caller cannot receive one row for a period two
 * approvals govern and file it as though one did.
 *
 * ## The statutory basis, fetched from Fedlex, title checked before quoting
 *
 * MWSTV (SR 641.201), ELI `cc/2009/828`, Stand 1. Januar 2025, AS 2024 485:
 *
 *   Art. 84 Abs. 3  Steuerpflichtige Personen, denen mehrere Saldosteuersätze bewilligt wurden,
 *                   müssen die Erträge für jeden dieser Saldosteuersätze separat verbuchen.
 *   Art. 86 Abs. 1  Für jede Tätigkeit, deren Anteil am Gesamtumsatz aus steuerbaren Leistungen mehr
 *                   als 10 Prozent beträgt, wird der dafür festgelegte Saldosteuersatz bewilligt.
 *   Art. 86 Abs. 3  Die Umsätze von Tätigkeiten mit gleichem Saldosteuersatz sind bei der Abklärung,
 *                   ob die 10-Prozent-Grenze überschritten wird, zusammenzuzählen.
 *   Art. 88 Abs. 1  Die Umsätze aus Tätigkeiten der steuerpflichtigen Person, der mehr als ein
 *                   Saldosteuersatz bewilligt worden ist, sind zum bewilligten Saldosteuersatz zu
 *                   versteuern, der für die betreffende Tätigkeit festgelegt ist.
 *   Art. 88 Abs. 6  Die steuerpflichtige Person kann den gesamten Umsatz aus steuerbaren Leistungen
 *                   freiwillig zum höchsten bewilligten Saldosteuersatz abrechnen.
 *
 * Art. 85 and Art. 87 are both "Aufgehoben durch Ziff. I der V vom 21. Aug. 2024, mit Wirkung seit
 * 1. Jan. 2025", so the old two-rate cap is gone and a third approved rate is reachable config.
 *
 * MWSTG (SR 641.20) Art. 37 Abs. 4, for the method eras: "Wechsel sind jeweils auf Beginn einer
 * Steuerperiode möglich."
 *
 * §H-TENANT: every statement below carries `workspace_id`, including both sides of every join.
 */

import type { WorkspaceContext } from '../context.js';
import { err } from '../result.js';
import type { Result } from '../result.js';

/** The sentinel opening day of a workspace's FIRST approval and FIRST method era. */
export const OPEN_FROM_THE_START = '0001-01-01';

/** The ESTV Ziffer of a Saldosteuersatz by 1-based position (form DM_0536_04 / 01.24: 323, 333). */
const SALDO_FORM_LINE_BY_POSITION: readonly string[] = ['323', '333'];

/**
 * The PRE-2025 Ziffer for a rate position, or null past the second.
 *
 * Read A07 §3.1a before using this. Up to 31.12.2024 the ESTV form numbered its Saldo rows by
 * (rate position x rate era): the middle digit is the position (2 = 1. Satz, 3 = 2. Satz) and the
 * last digit is the era. That form stops at two rows, so a third position genuinely has no box and
 * null is the honest answer for a Berichtigungsabrechnung covering such a period.
 *
 * It is NOT the answer for a period from 01.01.2025. There the position dimension does not exist
 * (`saldoDeclarationRegimeForPeriod` below), and reading this function as though it still governed
 * is what put a shipped two-rate return on Ziffer 333, a box the current form does not have.
 */
export function saldoFormLineForPosition(position: number): string | null {
  return SALDO_FORM_LINE_BY_POSITION[position - 1] ?? null;
}

/**
 * The last day the ESTV form numbered its Saldo rows per rate position.
 *
 * The same boundary `methodElementForPeriod` uses to choose `netTaxRateMethod` over
 * `simpleTaxRateMethod`, and deliberately so: the per-Tätigkeit accumulation eCH-0217 requires from
 * 01.01.2025 and the Beiblatt that replaced the second Ziffer are two faces of one regime change.
 */
export const SALDO_PER_POSITION_LAST_DAY = '2024-12-31';

/**
 * How the reported period declares its Saldosteuersätze onto the ESTV form.
 *
 * `per_position` (up to 31.12.2024): one Ziffer per approved rate, and at most two.
 * `beiblatt`    (from 01.01.2025):   ONE Ziffer per rate era carrying every approved rate, with the
 *                                    per-rate split as annex data. No ceiling on the rate count.
 *
 * MWST-Info 12, Stand 01.01.2025, Ziff. 18.1.4, fetched and title-checked: "Ziffer 322: Leistungen
 * bis 31.12.2023 / Ziffer 323: Leistungen ab 01.01.2024. Unter diesen Ziffern wird die MWST auf dem
 * Entgelt aus steuerbaren Leistungen berechnet, das unter Ziffer 299 (Ziff. 200 abzüglich Ziff. 289)
 * gesamthaft deklariert wurde. Die Deklaration erfolgt über das Beiblatt zu den Ziffern 322 und 323,
 * in welchem das Entgelt - sofern die ESTV mehrere SSS bewilligt hat - auf die verschiedenen SSS
 * aufzuteilen ist."
 *
 * The 30.08.2024 edition of the same publication, Ziff. 21.1.4 renumbered to 20.1.4, is the edition
 * that GOVERNED 2024 and it reads: "Ziffer 322: Leistungen bis 31.12.2023 (1. Satz) / Ziffer 323:
 * Leistungen ab 01.01.2024 (1. Satz) / Ziffer 332: Leistungen bis 31.12.2023 (2. Satz) / Ziffer 333:
 * Leistungen ab 01.01.2024 (2. Satz)", splitting the Entgelt "sofern die ESTV ZWEI SSS bewilligt hat
 * ... auf die BEIDEN SSS". Same two rate eras as the 2025 edition, four Ziffern instead of two.
 * `grep -c "33[23]"` over the 01.01.2025 edition returns 0. So this is a change in the FORM, and a
 * pre-2025 correction return must keep declaring the way that period's form did.
 *
 * The period, never today's date: a Berichtigungsabrechnung filed in 2027 for S2/2024 declares on
 * the 2024 form (A07 §3, MWSTG Art. 72).
 *
 * ## A period that STRADDLES the boundary belongs to neither, and says so
 *
 * This used to be a total function on `periodEnd` alone, which quietly assigned a period running
 * 01.07.2024 to 30.06.2025 to the `beiblatt` regime and put all of 2024 on the 2025 form. Its stated
 * twin, `methodElementForPeriod`, refuses that same span with `{ ok: false, straddles: true }`, so
 * the two were not in fact "the same boundary" and A07 §3.1a had no row for the case. Nothing could
 * be FILED, because the export refused, but the screen showed a figure computed under the wrong
 * regime and nothing said so.
 *
 * A straddling period is not a statutory Abrechnungsperiode in the first place (eCH-0217 Kap. 7.3
 * fixes the Saldo period at six months, rejection rule MWST-0003), so `null` here is the honest
 * answer and the caller turns it into a refusal.
 */
export function saldoDeclarationRegimeForPeriod(
  periodStart: string,
  periodEnd: string,
): 'per_position' | 'beiblatt' | null {
  if (periodEnd <= SALDO_PER_POSITION_LAST_DAY) return 'per_position';
  if (periodStart > SALDO_PER_POSITION_LAST_DAY) return 'beiblatt';
  return null;
}

export interface SaldoRateRow {
  position: number;
  rateBp: number;
  formLine: string | null;
}

export interface SaldoActivityRow {
  activityId: string;
  /** The Tätigkeit as the ESTV named it in the Bewilligung. */
  name: string;
  /** The ESTV's five-character Tätigkeitscode, required by eCH-0217 from 01.01.2025. Null until known. */
  activityCode: string | null;
  /** The 1-based rate position this Tätigkeit was approved at. */
  position: number;
  rateBp: number;
  formLine: string | null;
  accounts: { accountId: string; number: string; name: string }[];
}

export interface SaldoGeneration {
  validFrom: string;
  validTo: string | null;
  createdAt: string;
  rates: SaldoRateRow[];
  activities: SaldoActivityRow[];
}

export interface MethodEra {
  validFrom: string;
  validTo: string | null;
  method: string;
  timing: string;
}

// --- Method eras ---------------------------------------------------------------------------------
//
// `vat_method_era` holds CLOSED historical eras only, and `workspace.vat_method` remains the CURRENT
// method, exactly as it always was. That is deliberate rather than lazy: making the era table
// authoritative would have required every writer of `workspace.vat_method` (A00 setup, the bootstrap
// verb, the company profile) to learn about eras, and a versioning scheme whose correctness depends
// on four callers remembering to participate is the same shape of defect this file exists to close.
// Here the invariant is local: the tail is whatever the workspace row says, and a row in this table
// exists only because someone recorded a dated change.

interface EraRow {
  valid_from: string;
  valid_to: string | null;
  method: string;
  timing: string;
}

function currentMethod(ctx: WorkspaceContext): { method: string; timing: string } {
  const ws = ctx.store.db
    .prepare('SELECT vat_method, vat_accounting FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { vat_method: string | null; vat_accounting: string | null } | undefined;
  return { method: ws?.vat_method ?? 'none', timing: ws?.vat_accounting ?? 'soll' };
}

/** Every recorded historical era, oldest first. The current method is NOT among them. */
function closedEras(ctx: WorkspaceContext): MethodEra[] {
  const rows = ctx.store.db
    .prepare(
      'SELECT valid_from, valid_to, method, timing FROM vat_method_era WHERE workspace_id = ? ORDER BY valid_from',
    )
    .all(ctx.workspaceId) as EraRow[];
  return rows.map((r) => ({ validFrom: r.valid_from, validTo: r.valid_to, method: r.method, timing: r.timing }));
}

/**
 * The method eras overlapping `[from, to]`, oldest first. Never empty.
 *
 * A caller that receives more than one is looking at a period the law does not let it file as a
 * unit: MWSTG Art. 37 Abs. 4 puts a method change at the start of a Steuerperiode, so a period
 * spanning one spans two tax regimes and there is no single correct figure for it.
 */
export function methodsGoverning(ctx: WorkspaceContext, from: string, to: string): MethodEra[] {
  const closed = closedEras(ctx);
  const current = currentMethod(ctx);
  const tailFrom = closed.length === 0 ? OPEN_FROM_THE_START : nextDay(closed[closed.length - 1]!.validTo as string);
  const all: MethodEra[] = [...closed, { validFrom: tailFrom, validTo: null, ...current }];
  return all.filter((e) => e.validFrom <= to && (e.validTo === null || e.validTo >= from));
}

/** The method governing one day. Never null: an unconfigured workspace answers `none`. */
export function methodOn(ctx: WorkspaceContext, day: string): MethodEra {
  const governing = methodsGoverning(ctx, day, day);
  return governing[governing.length - 1] as MethodEra;
}

/**
 * Close the current method at `validFrom - 1` and let the workspace row carry the new one.
 *
 * Called by `configureVat` when a caller states a `methodChange`. Writing the CLOSED era before the
 * workspace row is updated is what preserves the old method for the days it governed; the caller
 * updates the row afterwards.
 *
 * Returns a refusal, or `null` when the era was written (or was already there).
 *
 * ## The two guards, and the state they exist to make unreachable
 *
 * `saldoGrant` has had an ordering guard since F11 landed; this had none, and the asymmetry was not
 * a judgement, it was an omission. The era's start is DERIVED (`nextDay` of the previous era's end)
 * while its end is the caller's, so a date earlier than the previous era produced a row with
 * `valid_from > valid_to`: a negative era that `methodsGoverning` matches against nothing sane, so
 * every period around it answers `period_straddles_method_change` and NO VERB IN THIS ENGINE CAN
 * REPAIR IT. A previously filable period became permanently unfilable from one accepted call.
 *
 * Plain replay produced the same wreck by a different route. The `ON CONFLICT (workspace_id,
 * valid_from)` clause cannot fire on a second call, because the second call derives a DIFFERENT
 * `valid_from` from the era the first one wrote, so an operator re-saving the settings panel under a
 * fresh idempotency key appended a second, negative era rather than updating the first. That is why
 * the replay is caught by identity here and not left to the conflict clause.
 */
export function recordMethodChange(
  ctx: WorkspaceContext,
  input: { validFrom: string },
): Result | null {
  const closed = closedEras(ctx);
  const last = closed[closed.length - 1];
  const newValidTo = previousDay(input.validFrom);

  // ALREADY RECORDED, so this is a no-op rather than a refusal. Re-saving the settings panel with
  // the method change still on it must not be an error: the row it asks for is the row already
  // there, and the state afterwards is the state it wanted.
  if (last !== undefined && last.validTo === newValidTo) return null;

  const from = last === undefined ? OPEN_FROM_THE_START : nextDay(last.validTo as string);
  if (newValidTo < from) {
    return err('vat_method_change_out_of_order', {
      validFrom: input.validFrom,
      earliestValidFrom: nextDay(from),
      previousEraValidTo: last?.validTo ?? null,
      reason:
        'A method change starts after the era it supersedes. Dating it earlier would leave a method era ending before it begins, and every period around it would then refuse as straddling a method change.',
      hint: 'MWSTG Art. 37 Abs. 4 puts a method change at the start of a Steuerperiode. Record it from a day after the previous era ends, or leave the recorded history alone if it is already correct.',
    });
  }

  const current = currentMethod(ctx);
  ctx.store.db
    .prepare(
      `INSERT INTO vat_method_era (workspace_id, valid_from, valid_to, method, timing, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, valid_from) DO UPDATE SET
         valid_to = excluded.valid_to, method = excluded.method, timing = excluded.timing`,
    )
    .run(
      ctx.workspaceId,
      from,
      newValidTo,
      current.method,
      current.timing,
      ctx.clock.now(),
      ctx.actor ?? null,
    );
  return null;
}

// --- Saldo approval generations ------------------------------------------------------------------

/** Every recorded Bewilligung, oldest first, with its rates and Tätigkeiten. */
export function listGenerations(ctx: WorkspaceContext): SaldoGeneration[] {
  const gens = ctx.store.db
    .prepare(
      'SELECT valid_from, valid_to, created_at FROM vat_saldo_generation WHERE workspace_id = ? ORDER BY valid_from',
    )
    .all(ctx.workspaceId) as { valid_from: string; valid_to: string | null; created_at: string }[];
  return gens.map((g) => hydrate(ctx, g.valid_from, g.valid_to, g.created_at));
}

/**
 * The Bewilligungen overlapping `[from, to]`, oldest first. EMPTY means the workspace never recorded
 * one, which under Saldo is `needs_vat_config` and never a guess.
 */
export function generationsGoverning(ctx: WorkspaceContext, from: string, to: string): SaldoGeneration[] {
  const gens = ctx.store.db
    .prepare(
      `SELECT valid_from, valid_to, created_at FROM vat_saldo_generation
        WHERE workspace_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to >= ?)
        ORDER BY valid_from`,
    )
    .all(ctx.workspaceId, to, from) as { valid_from: string; valid_to: string | null; created_at: string }[];
  return gens.map((g) => hydrate(ctx, g.valid_from, g.valid_to, g.created_at));
}

/** The Bewilligung governing one day, or null when none does. */
export function generationOn(ctx: WorkspaceContext, day: string): SaldoGeneration | null {
  return generationsGoverning(ctx, day, day)[0] ?? null;
}

/** The open (unclosed) Bewilligung, or null. There is at most one, by construction of `openGeneration`. */
export function openGeneration(ctx: WorkspaceContext): SaldoGeneration | null {
  const row = ctx.store.db
    .prepare(
      `SELECT valid_from, valid_to, created_at FROM vat_saldo_generation
        WHERE workspace_id = ? AND valid_to IS NULL ORDER BY valid_from DESC LIMIT 1`,
    )
    .get(ctx.workspaceId) as { valid_from: string; valid_to: string | null; created_at: string } | undefined;
  return row === undefined ? null : hydrate(ctx, row.valid_from, row.valid_to, row.created_at);
}

/** The newest recorded `valid_from`, open or closed. Used to refuse an out-of-order approval. */
export function latestGenerationFrom(ctx: WorkspaceContext): string | null {
  const row = ctx.store.db
    .prepare('SELECT MAX(valid_from) AS m FROM vat_saldo_generation WHERE workspace_id = ?')
    .get(ctx.workspaceId) as { m: string | null };
  return row.m;
}

function hydrate(
  ctx: WorkspaceContext,
  validFrom: string,
  validTo: string | null,
  createdAt: string,
): SaldoGeneration {
  const rates = ctx.store.db
    .prepare(
      `SELECT position, rate_bp, form_line FROM vat_saldo_generation_rate
        WHERE workspace_id = ? AND valid_from = ? ORDER BY position`,
    )
    .all(ctx.workspaceId, validFrom) as { position: number; rate_bp: number; form_line: string | null }[];

  const byPosition = new Map(rates.map((r) => [r.position, r]));

  const activities = ctx.store.db
    .prepare(
      `SELECT activity_id, name, activity_code, position FROM vat_saldo_activity
        WHERE workspace_id = ? AND valid_from = ? ORDER BY position, activity_id`,
    )
    .all(ctx.workspaceId, validFrom) as {
    activity_id: string;
    name: string;
    activity_code: string | null;
    position: number;
  }[];

  // The account rows join `account` for the number and name a person recognises. Both sides of the
  // join carry the workspace (§H-TENANT): `m.workspace_id = ?` selects the mapping and
  // `a.workspace_id = m.workspace_id` keeps the account on the same tenant, so neither half can leak.
  const accounts = ctx.store.db
    .prepare(
      `SELECT m.activity_id AS activity_id, m.account_id AS account_id, a.number AS number, a.name AS name
         FROM vat_saldo_activity_account m
         JOIN account a ON a.id = m.account_id AND a.workspace_id = m.workspace_id
        WHERE m.workspace_id = ? AND m.valid_from = ?
        ORDER BY a.number`,
    )
    .all(ctx.workspaceId, validFrom) as {
    activity_id: string;
    account_id: string;
    number: string;
    name: string;
  }[];

  const accountsByActivity = new Map<string, { accountId: string; number: string; name: string }[]>();
  for (const a of accounts) {
    const list = accountsByActivity.get(a.activity_id);
    const entry = { accountId: a.account_id, number: a.number, name: a.name };
    if (list === undefined) accountsByActivity.set(a.activity_id, [entry]);
    else list.push(entry);
  }

  return {
    validFrom,
    validTo,
    createdAt,
    rates: rates.map((r) => ({ position: r.position, rateBp: r.rate_bp, formLine: r.form_line })),
    activities: activities.map((a) => {
      const rate = byPosition.get(a.position);
      return {
        activityId: a.activity_id,
        name: a.name,
        activityCode: a.activity_code,
        position: a.position,
        rateBp: rate?.rate_bp ?? 0,
        formLine: rate?.form_line ?? null,
        accounts: accountsByActivity.get(a.activity_id) ?? [],
      };
    }),
  };
}

export interface WriteGenerationInput {
  validFrom: string;
  rates: { rateBp: number }[];
  activities: {
    activityId: string;
    name: string;
    activityCode?: string | null;
    position: number;
    accountIds: string[];
  }[];
}

/**
 * Write one Bewilligung, replacing whatever is stored at that `validFrom`.
 *
 * REPLACING AT ONE `validFrom` IS NOT THE OLD WHOLESALE DELETE. The old code deleted every row for
 * the workspace; this deletes only the generation being written, so no other generation can be
 * touched by a save and the history cannot be lost to a re-save. The caller decides WHICH
 * `validFrom` it is writing (a correction rewrites the open one, a new grant opens a new one), which
 * is the fork MWSTV Art. 84 Abs. 2 makes real: an ESTV Neuzuteilung is a new approval, a typo is not.
 */
export function writeGeneration(ctx: WorkspaceContext, input: WriteGenerationInput): void {
  const { validFrom } = input;
  const db = ctx.store.db;
  db.prepare('DELETE FROM vat_saldo_activity_account WHERE workspace_id = ? AND valid_from = ?').run(
    ctx.workspaceId,
    validFrom,
  );
  db.prepare('DELETE FROM vat_saldo_activity WHERE workspace_id = ? AND valid_from = ?').run(
    ctx.workspaceId,
    validFrom,
  );
  db.prepare('DELETE FROM vat_saldo_generation_rate WHERE workspace_id = ? AND valid_from = ?').run(
    ctx.workspaceId,
    validFrom,
  );
  db.prepare('DELETE FROM vat_saldo_generation WHERE workspace_id = ? AND valid_from = ?').run(
    ctx.workspaceId,
    validFrom,
  );

  if (input.rates.length === 0) return;

  db.prepare(
    `INSERT INTO vat_saldo_generation (workspace_id, valid_from, valid_to, created_at, created_by)
     VALUES (?, ?, NULL, ?, ?)`,
  ).run(ctx.workspaceId, validFrom, ctx.clock.now(), ctx.actor ?? null);

  for (let i = 0; i < input.rates.length; i += 1) {
    const position = i + 1;
    db.prepare(
      `INSERT INTO vat_saldo_generation_rate (workspace_id, valid_from, position, rate_bp, form_line)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, validFrom, position, input.rates[i]!.rateBp, saldoFormLineForPosition(position));
  }

  for (const a of input.activities) {
    db.prepare(
      `INSERT INTO vat_saldo_activity (workspace_id, valid_from, activity_id, position, name, activity_code)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ctx.workspaceId, validFrom, a.activityId, a.position, a.name, a.activityCode ?? null);
    for (const accountId of a.accountIds) {
      // The PRIMARY KEY (workspace_id, valid_from, account_id) refuses a second Tätigkeit claiming an
      // account this generation already mapped. That is a real constraint failure and not something
      // to swallow: two Tätigkeiten owning one Ertragskonto would double-count its turnover.
      db.prepare(
        `INSERT INTO vat_saldo_activity_account (workspace_id, valid_from, account_id, activity_id)
         VALUES (?, ?, ?, ?)`,
      ).run(ctx.workspaceId, validFrom, accountId, a.activityId);
    }
  }
}

/** Close every open generation older than `validFrom` at the day before it. */
export function closeGenerationsBefore(ctx: WorkspaceContext, validFrom: string): void {
  ctx.store.db
    .prepare(
      `UPDATE vat_saldo_generation SET valid_to = ?
        WHERE workspace_id = ? AND valid_from < ? AND valid_to IS NULL`,
    )
    .run(previousDay(validFrom), ctx.workspaceId, validFrom);
}

/** Drop every recorded Bewilligung. Used only when a workspace leaves the Saldo method entirely. */
export function clearOpenGeneration(ctx: WorkspaceContext, validFrom: string): void {
  closeGenerationsBefore(ctx, validFrom);
}

// --- The MWSTV Art. 88 Abs. 6 election ------------------------------------------------------------

export type SaldoDeclarationBasis = 'per_activity' | 'highest_rate';

/**
 * The declaration basis a workspace elected for a Steuerperiode, or null.
 *
 * Unlike the FX conversion basis this does NOT carry forward. Art. 88 Abs. 1 is the default the
 * ordinance states, and Abs. 6 is a voluntary departure from it: carrying a voluntary simplification
 * silently into the next year would file a person's turnover at the highest approved rate because
 * they once chose to, which is a decision they did not make. An unelected year splits per Tätigkeit.
 */
export function electedDeclarationBasis(ctx: WorkspaceContext, taxPeriod: string): SaldoDeclarationBasis | null {
  const row = ctx.store.db
    .prepare('SELECT basis FROM vat_saldo_declaration_election WHERE workspace_id = ? AND tax_period = ?')
    .get(ctx.workspaceId, taxPeriod) as { basis: string } | undefined;
  if (row === undefined) return null;
  return row.basis === 'highest_rate' ? 'highest_rate' : 'per_activity';
}

/** Every recorded election, newest Steuerperiode first. */
export function listDeclarationElections(
  ctx: WorkspaceContext,
): { taxPeriod: string; basis: SaldoDeclarationBasis; electedAt: string }[] {
  const rows = ctx.store.db
    .prepare(
      `SELECT tax_period, basis, created_at FROM vat_saldo_declaration_election
        WHERE workspace_id = ? ORDER BY tax_period DESC`,
    )
    .all(ctx.workspaceId) as { tax_period: string; basis: string; created_at: string }[];
  return rows.map((r) => ({
    taxPeriod: r.tax_period,
    basis: r.basis === 'highest_rate' ? 'highest_rate' : 'per_activity',
    electedAt: r.created_at,
  }));
}

/** Record (or replace) the elected basis for one Steuerperiode. */
export function writeDeclarationElection(
  ctx: WorkspaceContext,
  input: { taxPeriod: string; basis: SaldoDeclarationBasis },
): void {
  ctx.store.db
    .prepare(
      `INSERT INTO vat_saldo_declaration_election (workspace_id, tax_period, basis, created_at, created_by)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, tax_period) DO UPDATE SET
         basis = excluded.basis, created_at = excluded.created_at, created_by = excluded.created_by`,
    )
    .run(ctx.workspaceId, input.taxPeriod, input.basis, ctx.clock.now(), ctx.actor ?? null);
}

// --- Day arithmetic ------------------------------------------------------------------------------
//
// UTC only, on ISO days. `Date.UTC` is used rather than string surgery because month lengths and
// leap years are exactly where hand-rolled date maths goes wrong, and a boundary landing one day out
// moves a whole period into the wrong generation.

function shiftDay(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map((n) => Number(n));
  const t = Date.UTC(y as number, (m as number) - 1, (d as number) + delta);
  const shifted = new Date(t);
  const yy = String(shifted.getUTCFullYear()).padStart(4, '0');
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** The day before `day`. The predecessor generation's NEW LAST DAY, which the Studio teaches with. */
export function previousDay(day: string): string {
  return shiftDay(day, -1);
}

function nextDay(day: string): string {
  return shiftDay(day, 1);
}
