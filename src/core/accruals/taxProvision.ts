/**
 * A38, the Steuerrückstellung helper: Kanton Zürich ZStB 27/1, as a PURE READ with no poster of its own.
 *
 * The Steuerbuch's rule (fetched 2026-09-09, spec §3): the provision for direct taxes is the
 * Reingewinn VOR Steueraufwand times s / (1 + s), s being the estimated total tax rate (20 % in the
 * Steuerbuch's own example), minus the provisorische Bezüge already booked as tax expense in the
 * year. Its example 2: profit 900, rate 20 % gives 900 × 20/120 = 150; 100 already paid; 50 to
 * provide. `test/accruals/a38-provisions.test.mjs` reproduces it to the Rappen.
 *
 * WHY THE RATE IS AN INPUT AND NOT A CONSTANT. The rate is cantonal and communal and changes every
 * year; a constant here would be wrong for every canton but one and stale within twelve months.
 * `rateBp` defaults to 2000 (the Steuerbuch's illustration) and is the caller's to set.
 *
 * WHY IT POSTS NOTHING. The figures hand off to `provision_create` as a ready draft (`proposedDraft`,
 * reason `steuern`, Dr 8900 / Cr 2330); a second poster would be a second posting path (P3). On an
 * Einzelfirma the owner is taxed personally and no provision is booked, so the read answers
 * `applicable: false` with the reason rather than a zero that reads like "nothing owed".
 *
 * WHAT "PROFIT BEFORE TAX" IS HERE. The P&L result over the fiscal year to `periodEnd` (every
 * posted income and expense line, contribution `credit - debit`), EXCLUDING the `close` entries
 * (A08's own rule: the closing entry is machinery, not trade) and EXCLUDING the lines on 8900, which
 * are the instalments the formula subtracts separately. Read straight off `journal_line` rather
 * than through A08's sectioned statement, so the helper depends on the ledger and not on a report
 * layout (P5).
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { requireDate } from '../ledger/inputGuards.js';
import { DIRECT_TAX_ACCOUNT, SHORT_TERM_PROVISION_ACCOUNT, accountByNumber } from './lines.js';

/** The Steuerbuch's illustrative rate, 20 %, in basis points. An input's default, never a statute. */
export const DEFAULT_TAX_RATE_BP = 2000;

export interface TaxProvisionPreviewInput {
  periodEnd: string;
  /** The estimated total direct-tax rate in basis points (2000 = 20 %). */
  rateBp?: number;
}

/** The first day of the fiscal year `date` falls in, given the workspace's `MM-DD` start. */
export function fiscalYearStartFor(date: string, fiscalYearStart: string): string {
  const year = Number(date.slice(0, 4));
  const candidate = `${year}-${fiscalYearStart}`;
  return candidate <= date ? candidate : `${year - 1}-${fiscalYearStart}`;
}

/** `profit × s / (1 + s)` in integer minor units, rounded once, half away from zero (P2). */
export function grossTaxProvisionMinor(profitBeforeTaxMinor: number, rateBp: number): number {
  if (profitBeforeTaxMinor <= 0) return 0;
  const exact = (profitBeforeTaxMinor * rateBp) / (10000 + rateBp);
  return Math.round(exact);
}

export function taxProvisionPreview(ctx: WorkspaceContext, input: TaxProvisionPreviewInput): Result {
  const capable = ctx.capabilities.assert('read_books');
  if (!capable.ok) return capable;
  const guard = requireDate(input.periodEnd, 'periodEnd');
  if (guard) return guard;
  const rateBp = input.rateBp ?? DEFAULT_TAX_RATE_BP;
  if (!Number.isSafeInteger(rateBp) || rateBp < 0 || rateBp > 10000) {
    return err('invalid_rate', { rateBp: input.rateBp, reason: 'basis points between 0 and 10000' });
  }

  const ws = ctx.store.db
    .prepare('SELECT legal_form, fiscal_year_start FROM workspace WHERE id = ?')
    .get(ctx.workspaceId) as { legal_form: string | null; fiscal_year_start: string } | undefined;
  if (ws === undefined) return err('workspace_not_found', { workspaceId: ctx.workspaceId });
  if (ws.legal_form === 'einzelfirma') {
    return ok({
      applicable: false,
      reason: 'einzelfirma',
      periodEnd: input.periodEnd,
      rateBp,
      detail: 'the owner of an Einzelfirma is taxed personally; the business books no Steuerrückstellung',
    });
  }

  const fiscalYearStart = fiscalYearStartFor(input.periodEnd, ws.fiscal_year_start);
  const taxAccount = accountByNumber(ctx, DIRECT_TAX_ACCOUNT);
  const provisionAccount = accountByNumber(ctx, SHORT_TERM_PROVISION_ACCOUNT);

  // The P&L result of the fiscal year to date, the close entries and the tax account excluded.
  const profit = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_credit_minor - l.base_debit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ?
          AND e.status = 'posted'
          AND e.source <> 'close'
          AND e.date >= ? AND e.date <= ?
          AND a.type IN ('income', 'expense')
          AND a.number <> ?`,
    )
    .get(ctx.workspaceId, fiscalYearStart, input.periodEnd, DIRECT_TAX_ACCOUNT) as { net: number };

  // The instalments already charged: the year's net DEBIT on 8900.
  const instalments =
    taxAccount === undefined
      ? 0
      : (
          ctx.store.db
            .prepare(
              `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
                 FROM journal_line l
                 JOIN journal_entry e ON e.id = l.entry_id
                WHERE e.workspace_id = ?
                  AND e.status = 'posted'
                  AND e.source <> 'close'
                  AND e.date >= ? AND e.date <= ?
                  AND l.account_id = ?`,
            )
            .get(ctx.workspaceId, fiscalYearStart, input.periodEnd, taxAccount.id) as { net: number }
        ).net;

  const profitBeforeTaxMinor = profit.net;
  const grossProvisionMinor = grossTaxProvisionMinor(profitBeforeTaxMinor, rateBp);
  const proposedMinor = Math.max(0, grossProvisionMinor - instalments);
  const missingAccounts = [
    ...(taxAccount === undefined ? [DIRECT_TAX_ACCOUNT] : []),
    ...(provisionAccount === undefined ? [SHORT_TERM_PROVISION_ACCOUNT] : []),
  ];

  return ok({
    applicable: true,
    periodEnd: input.periodEnd,
    fiscalYearStart,
    rateBp,
    profitBeforeTaxMinor,
    grossProvisionMinor,
    instalmentsMinor: instalments,
    proposedMinor,
    missingAccounts,
    // A ready `provision_create` input, or null when there is nothing to provide or an account is
    // missing (the caller seeds it through A01 first: the read never invents an account).
    proposedDraft:
      proposedMinor > 0 && missingAccounts.length === 0
        ? {
            reason: 'steuern',
            periodEnd: input.periodEnd,
            amountMinor: proposedMinor,
            provisionAccount: SHORT_TERM_PROVISION_ACCOUNT,
            expenseAccount: DIRECT_TAX_ACCOUNT,
            description: `Steuerrückstellung Geschäftsjahr per ${input.periodEnd} (${(rateBp / 100).toFixed(2)} %)`,
          }
        : null,
  });
}
