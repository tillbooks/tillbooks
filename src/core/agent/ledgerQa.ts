/**
 * A26 US-A26.6, `ledgerQa`: answer a question from the existing read models (P5), never by
 * recomputing money the statutory owners already compute.
 *
 * It classifies a natural-language question into one of a few intents (Umsatz/turnover, offene
 * Posten/receivables, MWST/VAT) and answers from: a plain turnover aggregate over posted income-account
 * lines (an ordinary sum, not a statutory statement), A16's `listOpenItems` for the OP figure, and
 * A07's `computeVatReturn` for the VAT figure. The last two are COMPOSED rather than reimplemented, so
 * A16 and A07 stay the single owners of their numbers (§4: "the agent never does money math itself").
 * READ-ONLY: it writes nothing and answers the same twice (readOnlyHint).
 */

import type { WorkspaceContext } from '../context.js';
import type { Result } from '../result.js';
import { ok, err } from '../result.js';
import { listOpenItems } from '../debtors/index.js';
import { computeVatReturn } from '../vat/index.js';

export interface LedgerQaInput {
  question?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
}

type Intent = 'revenue' | 'open_items' | 'vat' | 'unknown';

/** Classify a de-CH / en question into an intent. Deterministic keyword match, no model in the core. */
export function classifyQuestion(question: string): Intent {
  const q = question.toLowerCase();
  if (/(umsatz|ertrag|turnover|revenue|einnahmen)/.test(q)) return 'revenue';
  if (/(offene posten|offene rechnungen|debitoren|open items|outstanding|receivab)/.test(q)) return 'open_items';
  if (/(mwst|mehrwertsteuer|vat|steuer|abrechnung)/.test(q)) return 'vat';
  return 'unknown';
}

function fmt(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}CHF ${(abs / 100).toFixed(2)}`;
}

function revenueBetween(ctx: WorkspaceContext, start: string, end: string): { minor: number; entryIds: string[] } {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(jl.base_credit_minor - jl.base_debit_minor), 0) AS minor
         FROM journal_line jl
         JOIN journal_entry je ON je.id = jl.entry_id
         JOIN account a ON a.id = jl.account_id
        WHERE je.workspace_id = ?
          AND je.status = 'posted'
          AND a.type = 'income'
          AND je.date >= ? AND je.date <= ?`,
    )
    .get(ctx.workspaceId, start, end) as { minor: number };
  const ids = ctx.store.db
    .prepare(
      `SELECT DISTINCT je.id AS id
         FROM journal_entry je
         JOIN journal_line jl ON jl.entry_id = je.id
         JOIN account a ON a.id = jl.account_id
        WHERE je.workspace_id = ?
          AND je.status = 'posted'
          AND a.type = 'income'
          AND je.date >= ? AND je.date <= ?
        ORDER BY je.date DESC
        LIMIT 50`,
    )
    .all(ctx.workspaceId, start, end) as { id: string }[];
  return { minor: row.minor, entryIds: ids.map((r) => r.id) };
}

export function ledgerQa(ctx: WorkspaceContext, input: LedgerQaInput): Result {
  if (typeof input.question !== 'string' || input.question.trim().length === 0) {
    return err('invalid_input', { field: 'question' });
  }
  const start = typeof input.periodStart === 'string' ? input.periodStart : '0001-01-01';
  const end = typeof input.periodEnd === 'string' ? input.periodEnd : '9999-12-31';
  const intent = classifyQuestion(input.question);

  if (intent === 'revenue') {
    const { minor, entryIds } = revenueBetween(ctx, start, end);
    return ok({ intent, answer: `Umsatz: ${fmt(minor)}`, figures: { revenueMinor: minor }, entryIds });
  }

  if (intent === 'open_items') {
    const asOf = typeof input.periodEnd === 'string' ? input.periodEnd : undefined;
    const op = listOpenItems(ctx, asOf !== undefined ? { asOf } : {});
    if (!op.ok) return op;
    const totalOpenMinor = typeof op.totalOpenMinor === 'number' ? op.totalOpenMinor : 0;
    const items = Array.isArray(op.items) ? (op.items as { documentId?: string }[]) : [];
    const entryIds = items.map((i) => i.documentId).filter((d): d is string => typeof d === 'string');
    return ok({
      intent,
      answer: `Offene Debitoren: ${fmt(totalOpenMinor)} (${items.length} Positionen)`,
      figures: { totalOpenMinor, count: items.length },
      entryIds,
    });
  }

  if (intent === 'vat') {
    if (typeof input.periodStart !== 'string' || typeof input.periodEnd !== 'string') {
      return err('needs_period', { reason: 'A VAT question needs periodStart and periodEnd (YYYY-MM-DD).' });
    }
    const vat = computeVatReturn(ctx, { periodStart: input.periodStart, periodEnd: input.periodEnd } as never);
    if (!vat.ok) return vat;
    const payableMinor = typeof vat.payableMinor === 'number' ? vat.payableMinor : 0;
    const creditMinor = typeof vat.creditMinor === 'number' ? vat.creditMinor : 0;
    const answer =
      payableMinor > 0
        ? `MWST-Schuld: ${fmt(payableMinor)}`
        : creditMinor > 0
          ? `MWST-Guthaben: ${fmt(creditMinor)}`
          : `MWST: ${fmt(0)}`;
    return ok({ intent, answer, figures: { payableMinor, creditMinor }, entryIds: [] });
  }

  return ok({
    intent,
    answer: 'Diese Frage kann ich noch nicht aus den Zahlen beantworten (Umsatz, offene Posten, MWST).',
    figures: {},
    entryIds: [],
    unresolved: true,
  });
}
