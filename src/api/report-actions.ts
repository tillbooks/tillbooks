/**
 * A08, the financial-statement verb surface: five reads and not one write.
 *
 * Every tool here is `kind: 'read'`, so every one carries `readOnlyHint` on MCP and none carries an
 * `idempotency_key` (Pattern P4: a read needs none). That is not a stylistic choice, it is the whole
 * capability: A08 owns no table and posts nothing, so there is no conformance scenario to write and
 * nothing an agent could double-apply. `test/reports/surface.test.mjs` holds the claim up by
 * counting rows across every call rather than by trusting this comment.
 *
 * ONE NAMING RULE binds the two faces, as "Ausstellen" does for issuing and "buchen" for payments.
 * The Studio's words for these four reports are **Saldenbilanz**, **Bilanz**, **Erfolgsrechnung**
 * and **Kontoblatt**, so every description below names the German report an accountant would ask
 * for alongside the English. An agent asked "wie war der Gewinn in Q2?" has to be able to find
 * `income_statement` from the word Gewinn, and it can only do that if the word is in the
 * description.
 *
 * THE DESCRIPTIONS SAY WHAT THE RECONCILIATION MEANS, because an agent will quote it. A08 returns
 * `reconciles` plus a per-check breakdown, and a tool description that said "verified" would invite
 * an agent to report a guarantee nobody made. What the flags cover is documented at the top of
 * `core/reports/statements.ts`; what they say here is narrower on purpose.
 *
 * AND THEY SAY WHAT THE STATUTE IS NOT, for the same reason and with more at stake. `balance_sheet`
 * used to open "in the OR Art. 959a minimum structure" while `core/reports/sections.ts` said, at
 * length and in its own docblock, that the article is NOT implemented: A08 models the seven
 * first-level groupings and none of the 24 sub-positions Abs. 1 and Abs. 2 require "einzeln und in
 * der vorgegebenen Reihenfolge". A tool description is read by an AGENT, which repeats it with no
 * human filter, so that sentence put a Swiss statutory conformance claim into every catalogue that
 * listed the tool. The description now states the grouping it does implement AND the sub-positions it
 * does not, and tells the caller not to present the output as conformant. `OR_ARTICLE_COVERAGE` in
 * `sections.ts` and `test/reports/statutory-claims.test.mjs` hold the pair together: a description
 * claiming an Absatz the section tables do not fully model is red.
 *
 * The Erfolgsrechnung needs a much smaller caveat, and gets exactly that one. OR Art. 959b Abs. 2 is
 * a FLAT list of eleven positions with no sub-level, so all eleven are present and in order, which is
 * the one structural claim A08 can make in full. But only TEN of them are account-backed sections
 * carrying the enacted heading. The eleventh, `Jahresgewinn oder Jahresverlust`, is the computed
 * `reingewinnMinor` rather than a section accounts fall into, so the description says that rather
 * than generalising the ten into "every position". The PDF used to head that figure "Reingewinn oder
 * Reinverlust", the conventional Treuhand wording, and the description said so; `export.ts` replaced
 * it on 2026-07-26 with the enacted wording resolved by sign, and the description now says THAT. The
 * Absatzerfolgsrechnung of OR Art. 959b Abs. 3 is a different layout and is not built, which the
 * description says.
 *
 * That correction is why the sentence exists at all. A description is read by an AGENT with no human
 * filter, so a sentence describing the artifact keeps being true only for as long as someone updates
 * it when the artifact moves. No test pins this prose, so nothing went red when it went stale: the
 * guard below checks conformance CLAIMS, not descriptions of output.
 *
 * `groupBy` (§6b) is accepted only on the two WORKING PAPERS. The Bilanz and the Erfolgsrechnung are
 * the filed statements, and their section structure comes from the statute rather than from a caller
 * (OR Art. 959a Abs. 1 and 2, OR Art. 959b Abs. 2), so they do not expose the parameter at all rather
 * than exposing it and refusing it: the schema itself is the answer.
 *
 * Defined here rather than inline in `registry.ts` for the reason §H-FX, A14, A16 and A19 all
 * established: the registry is the one append-only tool list and several agents append to it at
 * once, so the smaller the hunk the cheaper the merge. The helpers arrive as a parameter to keep the
 * module graph acyclic.
 */

import type { ActionDef, ActionInput, JsonSchema } from './registry.js';
import type { WorkspaceContext } from '../core/context.js';
import type { Result } from '../core/result.js';
import { err } from '../core/result.js';
import {
  computeTrialBalance,
  computeBalanceSheet,
  computeIncomeStatement,
  computeGeneralLedger,
  exportStatement,
  STATEMENT_KINDS,
  EXPORT_FORMATS,
  SUPPORTED_GROUP_BY,
} from '../core/reports/index.js';
// G13 GL archive: the archive-side comparative read model. THIS FILE is the one place the live
// statement and the prior-system archive meet (G13 spec §0 correction 2): `core/reports/` computes
// the live side and never imports the archive; `core/migration/archive.ts` computes the archive
// side and never reads the journal; the join below labels the column and sums NOTHING across the
// wall. The two static walls are asserted in test/migration/archive-walls.test.mjs.
import { archiveComparative, type ArchiveComparativeAccount } from '../core/migration/index.js';

export interface ReportActionHelpers {
  ctxAction(
    name: string,
    kind: 'read' | 'write',
    summary: string,
    inputSchema: JsonSchema,
    call: (ctx: WorkspaceContext, input: ActionInput) => Result,
  ): ActionDef;
  ctxSchema(props?: Record<string, unknown>, required?: string[]): JsonSchema;
  STR: { readonly type: 'string' };
}

export function reportActions(h: ReportActionHelpers): ActionDef[] {
  const { ctxAction, ctxSchema, STR } = h;

  /**
   * The prior period a comparison column is drawn against (US-A08.5, the Stetigkeit principle of
   * OR Art. 958c). An OBJECT for the two period reports, because a period is two dates and
   * flattening it into `compareStart`/`compareEnd` would let a caller state half of one.
   */
  const COMPARE_PERIOD = {
    type: 'object',
    // `source` (G13, §H-ENUM here at the schema): absent or 'live' draws the column from the live
    // ledger; 'archive' draws it from the prior-system GL archive, labelled as such in the payload
    // and never summed with a TILL-computed figure.
    properties: { periodStart: STR, periodEnd: STR, source: STR },
    required: ['periodStart', 'periodEnd'],
  } as const;

  /**
   * The prior reporting DATE a Bilanz comparison is drawn at. An object carrying one date rather
   * than a bare string, so `compareTo` has ONE declared type across all five tools: the registry's
   * schema gate requires every property to declare a type, and `export_statement` forwards whichever
   * statement's `compareTo` it was handed.
   */
  const COMPARE_AS_OF = { type: 'object', properties: { asOf: STR, source: STR }, required: ['asOf'] } as const;

  return [
    ctxAction(
      'trial_balance',
      'read',
      `Saldenbilanz (trial balance): every account's opening balance, its debit and credit movement in the period, and its closing balance, in the workspace base currency and integer Rappen. Figures are debit-positive, exactly as the ledger holds them, and drafts are excluded. Pass compareTo={periodStart,periodEnd} for the prior-period column and its delta. reconciles reports three checks by name (debit equals credit, the closing column ties to an independently queried ledger balance, and every account the ledger moved was rendered); it is evidence about coverage and the period boundaries, not proof that an account sits in the right section. groupBy accepts '${SUPPORTED_GROUP_BY.join("', '")}' today and refuses anything else, because account-level custom fields are a G00 capability that does not exist yet.`,
      ctxSchema({ periodStart: STR, periodEnd: STR, compareTo: COMPARE_PERIOD, groupBy: STR }, [
        'periodStart',
        'periodEnd',
      ]),
      (ctx, input) => withArchiveComparative(ctx, 'trial', input, computeTrialBalance),
    ),
    ctxAction(
      'balance_sheet',
      'read',
      `Bilanz (balance sheet) as of a date, grouped into the FIRST LEVEL of OR Art. 959a: Umlaufvermögen and Anlagevermögen on the Aktiven, kurzfristiges Fremdkapital, langfristiges Fremdkapital and Eigenkapital on the Passiven, each section carrying its statutory heading in de/fr/it/en, plus one residual section per side (the "weitere Positionen" of OR Art. 959a Abs. 3) so no account can be dropped. Under each section the accounts are listed individually, ordered by account number. Every line is positive on its own side. The running result IS carried as an Eigenkapital position (OR Art. 959a Abs. 2 Ziff. 3 lit. f and lit. g), which is what makes the statement foot before a year-end close has run. WHAT IT IS NOT: the statutory minimum structure. Twenty-four individual sub-positions are prescribed "einzeln und in der vorgegebenen Reihenfolge" (flüssige Mittel, Forderungen aus Lieferungen und Leistungen, aktive Rechnungsabgrenzungen, and so on) and are not modelled: only the seven groupings above are, with raw account lines under them. The two Absätze that prescribe those 24 are OR Art. 959a Abs. 1 and OR Art. 959a Abs. 2, and A08 reaches the grouping level of each and stops there. On the shipped Kontenrahmen KMU the account numbers happen to ascend in the statutory order, so the output looks right by coincidence; on a renamed or renumbered chart it names none of the required positions and may order them arbitrarily, and no reconciliation flag can see the difference because the statement still foots either way. So do not report this output as OR-conformant, as the minimum structure, or as ready to file. Pass compareTo={asOf:'YYYY-MM-DD'} for the prior-date column. This is the filed statement, so it accepts no alternate grouping.`,
      ctxSchema({ asOf: STR, compareTo: COMPARE_AS_OF }, ['asOf']),
      (ctx, input) => withArchiveComparative(ctx, 'balance', input, computeBalanceSheet),
    ),
    ctxAction(
      'income_statement',
      'read',
      `Erfolgsrechnung (income statement) for a period, in the OR Art. 959b Abs. 2 Gesamtkostenverfahren layout: the ten account-backed positions in their prescribed order, each under its statutory wording, plus reingewinnMinor, which is position 11, Jahresgewinn oder Jahresverlust. Unlike the Bilanz this Absatz is a flat list with no sub-level, so all eleven positions are present and in the prescribed order. Two things to say about the eleventh rather than claim: it is the COMPUTED result and not a section of its own, so no account falls into it, and the exported Erfolgsrechnung heads it with the ENACTED wording resolved by sign, Jahresgewinn above zero and Jahresverlust below it, keeping the full Jahresgewinn oder Jahresverlust verbatim at exactly zero. Each single word is the enacted wording with the branch the book did not take dropped, because the oder enumerates the two outcomes a result can have rather than naming one heading. The conventional Treuhand wording Reingewinn oder Reinverlust is not printed. The Bilanz carries the same figure under the same enacted wording as an Eigenkapital position, so the two statements of one Jahresrechnung give one number one name. A RESIDUAL section, \`uebrige_positionen\`, follows the ten and holds anything that fits none of them, so no account is dropped. It is the "weitere Positionen" of OR Art. 959b Abs. 5, which is a different Absatz and not one of the eleven: it is neither position 11 nor a twelfth prescribed position. Every position is signed as its CONTRIBUTION TO PROFIT (revenue positive, expense negative, and the three positions the statute writes as Aufwand AND Ertrag shown net), so a loss is a negative figure and never an absolute value. This is the verb that answers "wie war der Gewinn in Q2?". Pass compareTo={periodStart,periodEnd} for the prior-period column. The Absatzerfolgsrechnung of OR Art. 959b Abs. 3 is not built, and this is the filed statement, so it accepts no alternate grouping.`,
      ctxSchema({ periodStart: STR, periodEnd: STR, compareTo: COMPARE_PERIOD }, ['periodStart', 'periodEnd']),
      (ctx, input) => withArchiveComparative(ctx, 'income', input, computeIncomeStatement),
    ),
    ctxAction(
      'general_ledger',
      'read',
      `Kontoblatt (general ledger) for ONE account: the opening carry, every posted line in the period in date order with its running balance, and the closing balance. Each line carries the entryId to drill into with get_entry. Debit-positive like the Saldenbilanz, with naturalSide naming which way the account is expected to lean. Drafts never appear. groupBy accepts '${SUPPORTED_GROUP_BY.join("', '")}' today and refuses anything else.`,
      ctxSchema({ accountId: STR, periodStart: STR, periodEnd: STR, groupBy: STR }, [
        'accountId',
        'periodStart',
        'periodEnd',
      ]),
      (ctx, input) => computeGeneralLedger(ctx, input as never),
    ),
    ctxAction(
      'export_statement',
      'read',
      `Render any of the four statements as a LOCAL file and hand back its bytes, base64-encoded: kind one of '${STATEMENT_KINDS.join("', '")}', format one of '${EXPORT_FORMATS.join("', '")}', plus that statement's own parameters. The CSV is locale-neutral for re-import (integer Rappen, ISO dates, a record_type column carrying the totals) and the PDF is a print artifact with no PDF/A conformance claimed. The model is computed by the same verb the screen calls, so the file and the screen cannot disagree. Nothing is transmitted: e-filing or publishing the artifact is a cloud-tier concern and is not part of this tool.`,
      ctxSchema(
        {
          kind: STR,
          format: STR,
          periodStart: STR,
          periodEnd: STR,
          asOf: STR,
          accountId: STR,
          // One declared type covering both shapes: `{periodStart,periodEnd}` for the two period
          // statements and `{asOf}` for the Bilanz. That uniformity is why `balance_sheet` takes an
          // object at all: a field that were a string on one verb and an object on three could not
          // be typed here, and the schema gate requires every property to declare a type.
          compareTo: { type: 'object', properties: { periodStart: STR, periodEnd: STR, asOf: STR } },
          groupBy: STR,
        },
        ['kind', 'format'],
      ),
      (ctx, input) => {
        // G13: the archive comparative is a labelled SCREEN column this wave; the export twins
        // refuse it by name rather than silently rendering an unlabelled or live-computed column.
        const compareTo = (input as { compareTo?: { source?: unknown } }).compareTo;
        if (compareTo !== undefined && compareTo.source === 'archive') {
          return err('archive_comparative_not_exportable', {
            reason: 'the Vorsystem comparative renders on screen with its provenance label; the export twin lands with the F01 report sources',
          });
        }
        return exportStatement(ctx, input as never);
      },
    ),
  ];
}

// ================================================================================================
// G13 GL archive: the labelled Vorsystem comparative (spec US-G13.2, joined HERE and only here)
// ================================================================================================

type StatementKind = 'trial' | 'balance' | 'income';

interface CompareToInput {
  periodStart?: unknown;
  periodEnd?: unknown;
  asOf?: unknown;
  source?: unknown;
}

/**
 * Draw a statement, and when `compareTo.source === 'archive'`, draw its comparative column from the
 * prior-system GL archive instead of the live ledger.
 *
 * THE JOIN RULES, each one the never-mixed invariant from a different side:
 *  - The live figures are computed WITHOUT any compareTo, so `core/reports/` never sees the archive
 *    request and cannot blend it into a live aggregate.
 *  - The archive figures come wholly from `archiveComparative`, which never reads the journal.
 *  - A window the archive does not wholly cover yields NO figures: `comparative.status` says
 *    `partial` or `no_data` and every compare field is absent, never a zero (a fabricated figure)
 *    and never a partial sum (wrong in the way that is hardest to notice).
 *  - The label rides IN the payload (`comparative.source/system/coveredFrom/coveredTo`), so a
 *    client that drops it has to do so deliberately.
 *  - Archive accounts with no rendered live line are NOT silently dropped: their net lands in
 *    `comparative.unlistedNetMinor`, so the column's sums are honest about what they exclude.
 */
function withArchiveComparative(
  ctx: WorkspaceContext,
  kind: StatementKind,
  input: ActionInput,
  compute: (ctx: WorkspaceContext, input: never) => Result,
): Result {
  const compareTo = (input as { compareTo?: CompareToInput }).compareTo;
  const source = compareTo?.source;
  if (source !== undefined && source !== 'live' && source !== 'archive') {
    return err('invalid_input', { field: 'compareTo.source', allowed: ['live', 'archive'] });
  }
  if (compareTo === undefined || source !== 'archive') return compute(ctx, input as never);

  // Validate the compare window with the same shape rules the live path applies.
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const asOf = kind === 'balance' ? compareTo.asOf : compareTo.periodEnd;
  const from = kind === 'balance' ? undefined : compareTo.periodStart;
  if (typeof asOf !== 'string' || !ISO.test(asOf)) {
    return err('invalid_input', { field: kind === 'balance' ? 'compareTo.asOf' : 'compareTo.periodEnd' });
  }
  if (kind !== 'balance' && (typeof from !== 'string' || !ISO.test(from))) {
    return err('invalid_input', { field: 'compareTo.periodStart' });
  }

  // The live side, computed with NO comparative at all.
  const { compareTo: _omitted, ...liveInput } = input as Record<string, unknown>;
  void _omitted;
  const live = compute(ctx, liveInput as never);
  if (!live.ok) return live;

  // The archive side. For the Bilanz the window is the compare date's own fiscal year, so the two
  // computed equity lines (Ergebnisvortrag, Jahresergebnis) can be split exactly.
  const fyStart = kind === 'balance' ? fiscalYearStartForDate(ctx, asOf) : (from as string);
  const arch = archiveComparative(ctx, { from: fyStart, to: asOf });
  if (!arch.ok) return arch;
  const status = (arch as unknown as { status: string }).status;
  const label = {
    source: 'archive' as const,
    status,
    system: (arch as unknown as { system?: string | null }).system ?? null,
    coveredFrom: (arch as unknown as { coveredFrom?: string }).coveredFrom ?? null,
    coveredTo: (arch as unknown as { coveredTo?: string }).coveredTo ?? null,
  };
  const compareEcho =
    kind === 'balance' ? { compareTo: asOf } : { compareTo: { start: from as string, end: asOf } };

  if (status !== 'ok') {
    // No figures at all: the column renders as "keine Daten" / "Zeitraum unvollständig im Archiv".
    return { ...live, ...compareEcho, comparative: label } as Result;
  }

  const byAccount = new Map(
    ((arch as unknown as { byAccount: ArchiveComparativeAccount[] }).byAccount ?? []).map((a) => [a.accountId, a]),
  );
  const consumed = new Set<string>();

  if (kind === 'trial') {
    const rows = (live as unknown as { rows: Array<Record<string, unknown>> }).rows.map((row) => {
      const id = (row.account as { id?: string } | null)?.id;
      const hit = id === undefined ? undefined : byAccount.get(id);
      if (hit === undefined) return row;
      consumed.add(hit.accountId);
      const compareClosingMinor = hit.cumulativeNetMinor;
      return { ...row, compareClosingMinor, deltaMinor: (row.closingMinor as number) - compareClosingMinor };
    });
    const unlisted = sumUnlisted(byAccount, consumed);
    return { ...live, rows, ...compareEcho, comparative: { ...label, unlistedNetMinor: unlisted } } as Result;
  }

  if (kind === 'income') {
    let compareReingewinnMinor = 0;
    const sections = (live as unknown as { sections: Array<Record<string, unknown>> }).sections.map((section) => {
      let compareSubtotalMinor = 0;
      const lines = (section.lines as Array<Record<string, unknown>>).map((line) => {
        const id = (line.account as { id?: string } | null)?.id;
        const hit = id === undefined ? undefined : byAccount.get(id);
        if (hit === undefined) return line;
        consumed.add(hit.accountId);
        // Contribution to profit, credit - debit, the live sign convention exactly.
        const compareAmountMinor = -(hit.windowDebitMinor - hit.windowCreditMinor);
        compareSubtotalMinor += compareAmountMinor;
        return { ...line, compareAmountMinor, deltaMinor: (line.amountMinor as number) - compareAmountMinor };
      });
      compareReingewinnMinor += compareSubtotalMinor;
      return { ...section, lines, compareSubtotalMinor };
    });
    const unlisted = sumUnlisted(byAccount, consumed, (a) => a.type === 'income' || a.type === 'expense');
    return {
      ...live,
      sections,
      compareReingewinnMinor,
      ...compareEcho,
      comparative: { ...label, unlistedNetMinor: unlisted },
    } as Result;
  }

  // balance
  const sections = (live as unknown as { sections: Array<Record<string, unknown>> }).sections.map((section): Record<string, unknown> => {
    let compareSubtotalMinor = 0;
    const side = section.side as 'aktiven' | 'passiven';
    const lines = (section.lines as Array<Record<string, unknown>>).map((line) => {
      const account = line.account as { id?: string } | null;
      if (account === null || account.id === undefined) {
        // A computed equity line (Ergebnisvortrag / Jahresergebnis): filled from the archive's
        // income+expense nets, split at the compare date's fiscal year start.
        const value = computedEquityCompare(byAccount, line.key as string);
        if (value === undefined) return line;
        compareSubtotalMinor += value;
        return { ...line, compareBalanceMinor: value, deltaMinor: (line.balanceMinor as number) - value };
      }
      const hit = byAccount.get(account.id);
      if (hit === undefined) return line;
      consumed.add(hit.accountId);
      const compareBalanceMinor = side === 'aktiven' ? hit.cumulativeNetMinor : -hit.cumulativeNetMinor;
      compareSubtotalMinor += compareBalanceMinor;
      return { ...line, compareBalanceMinor, deltaMinor: (line.balanceMinor as number) - compareBalanceMinor };
    });
    return { ...section, lines, compareSubtotalMinor };
  });
  // The result accounts are consumed by the computed equity lines, never listed as balance lines.
  for (const a of byAccount.values()) {
    if (a.type === 'income' || a.type === 'expense') consumed.add(a.accountId);
  }
  const compareAktivenMinor = sections
    .filter((s) => s.side === 'aktiven')
    .reduce((sum, s) => sum + (s.compareSubtotalMinor as number), 0);
  const comparePassivenMinor = sections
    .filter((s) => s.side === 'passiven')
    .reduce((sum, s) => sum + (s.compareSubtotalMinor as number), 0);
  const unlisted = sumUnlisted(byAccount, consumed);
  return {
    ...live,
    sections,
    compareAktivenMinor,
    comparePassivenMinor,
    ...compareEcho,
    comparative: { ...label, unlistedNetMinor: unlisted },
  } as Result;
}

/** Net (debit-positive) of every archive account the merge did not place anywhere. Honesty, not chrome. */
function sumUnlisted(
  byAccount: ReadonlyMap<string, ArchiveComparativeAccount>,
  consumed: ReadonlySet<string>,
  filter?: (a: ArchiveComparativeAccount) => boolean,
): number {
  let sum = 0;
  for (const a of byAccount.values()) {
    if (consumed.has(a.accountId)) continue;
    if (filter !== undefined && !filter(a)) continue;
    sum += a.cumulativeNetMinor;
  }
  return sum;
}

/**
 * The two computed Eigenkapital compare lines, from the archive's income+expense nets: the window
 * (the compare date's fiscal year) is the Jahresergebnis, everything before it the Ergebnisvortrag.
 * Signs follow the live convention: a profit is credit-heavy, so the position is `-(net)`.
 */
function computedEquityCompare(
  byAccount: ReadonlyMap<string, ArchiveComparativeAccount>,
  key: string,
): number | undefined {
  if (key !== 'ergebnisvortrag' && key !== 'jahresergebnis') return undefined;
  let windowNet = 0;
  let cumulativeNet = 0;
  for (const a of byAccount.values()) {
    if (a.type !== 'income' && a.type !== 'expense') continue;
    windowNet += a.windowDebitMinor - a.windowCreditMinor;
    cumulativeNet += a.cumulativeNetMinor;
  }
  return key === 'jahresergebnis' ? -windowNet : -(cumulativeNet - windowNet);
}

/** The fiscal year start containing `date`, from the workspace's own MM-DD setting. Calendar only. */
function fiscalYearStartForDate(ctx: WorkspaceContext, date: string): string {
  const row = ctx.store.db
    .prepare('SELECT fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { fiscal_year_start: string } | undefined;
  const mmdd = row?.fiscal_year_start ?? '01-01';
  const year = Number.parseInt(date.slice(0, 4), 10);
  const startThisYear = `${year}-${mmdd}`;
  return date >= startThisYear ? startThisYear : `${year - 1}-${mmdd}`;
}
