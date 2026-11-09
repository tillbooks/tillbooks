/**
 * G11, `bank_control` (US-G11.2): each A19 bank account's opening proved against the statement's
 * own `OPBD`, which A20 §0 verified against the Swiss Payment Standards is MANDATORY on a camt.053.
 * The statement IS the declared side, so this control needs no operator expectation.
 *
 * Which statement: the camt.053 whose period STARTS the day after the Übernahmestichtag carries the
 * Stichtag's closing position as its `OPBD`; one starting ON the Stichtag carries the position at
 * its open. The first is preferred, the second accepted, and a bank account with neither reports
 * `not_computable` naming the missing camt.053 (spec §4 table), never a silent pass. Correcting a
 * statement is not something TILL offers, so it is not offered (US-G11.2 error state).
 */

import type { WorkspaceContext } from '../../context.js';
import type { ControlModule } from './registry.js';

interface BankAccountRow {
  id: string;
  name: string;
  iban: string;
  ledger_account_id: string;
}

/** The posted balance (debit net) of a ledger account as of a date. Integer Rappen, read, never derived. */
function ledgerBalanceAsOf(ctx: WorkspaceContext, ledgerAccountId: string, asOf: string): number {
  const row = ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND e.date <= ? AND l.account_id = ?`,
    )
    .get(ctx.workspaceId, asOf, ledgerAccountId) as { net: number };
  return row.net;
}

/** The day after an ISO date, in UTC so no timezone can move a Stichtag. */
function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export const bankControl: ControlModule = {
  kind: 'bank_control',
  declarable: false,
  appliesTo: (step) => step.data_class === 'opening_balances',
  compute(ctx, plan, _step, env) {
    if (env.against !== 'live') {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'testmandant (G12)' }];
    }
    if (plan.cutover_date === null) {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'cutover_date' }];
    }
    const cutover = plan.cutover_date;
    const accounts = ctx.store.db
      .prepare('SELECT id, name, iban, ledger_account_id FROM bank_account WHERE workspace_id = ? AND archived = 0 ORDER BY name, id')
      .all(ctx.workspaceId) as BankAccountRow[];
    // No bank accounts: nothing to control, and NO finding rather than a fabricated pass.
    if (accounts.length === 0) return [];

    const findings = [];
    for (const account of accounts) {
      // Prefer the statement opening the day AFTER the Stichtag (OPBD == the Stichtag's close),
      // accept one opening ON it. Only a last page carries a genuine OPBD (camt.ts, D81).
      const statement = ctx.store.db
        .prepare(
          `SELECT id, from_date, opening_balance_minor FROM bank_statement
            WHERE workspace_id = ? AND bank_account_id = ? AND last_page_ind = 1
              AND opening_balance_minor IS NOT NULL AND from_date IN (?, ?)
            ORDER BY CASE from_date WHEN ? THEN 0 ELSE 1 END, imported_at DESC LIMIT 1`,
        )
        .get(ctx.workspaceId, account.id, dayAfter(cutover), cutover, dayAfter(cutover)) as
        | { id: string; from_date: string; opening_balance_minor: number }
        | undefined;
      if (statement === undefined) {
        findings.push({
          scope: account.iban,
          computedMinor: null,
          inputsPresent: false,
          missingInput: 'camt053_opbd',
          detail: `${account.name}: kein camt.053 mit OPBD zum Übernahmestichtag ${cutover}`,
        });
        continue;
      }
      const opbd = statement.opening_balance_minor;
      // The ledger side: the balance the books hold as of the Stichtag. The opening entry is dated
      // AT the Stichtag (canon blocker 6), so for either accepted statement start this is the figure
      // the OPBD describes on a book whose only Stichtag-day entry is the opening itself.
      const ledger = ledgerBalanceAsOf(ctx, account.ledger_account_id, cutover);
      const diff = ledger - opbd;
      findings.push({
        scope: account.iban,
        computedMinor: ledger,
        inputsPresent: true,
        selfStatus: diff === 0 ? ('passed' as const) : ('failed' as const),
        detail:
          diff === 0
            ? `${account.name}: Eröffnungssaldo == OPBD (${opbd})`
            : `${account.name}: Eröffnungssaldo ${ledger} != OPBD ${opbd} (Differenz ${diff} Rappen)`,
      });
    }
    return findings;
  },
};
