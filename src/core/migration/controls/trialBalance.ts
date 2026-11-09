/**
 * G11, the two trial-balance controls (US-G11.1).
 *
 * `trial_balance_balanced` (Sigma debit equals Sigma credit) is a STRUCTURAL property, always
 * computable, and it is reported SEPARATELY from the per-account control because passing it proves
 * much less: A04 §10 says in terms that `balanced: true` "cannot see two accounts transposed, a
 * position missing from both sides, a figure short by the same amount on each side, or the wrong
 * file entirely." Reporting the two as one figure is exactly the overstatement that warning names.
 *
 * `trial_balance_matches_source` compares PER ACCOUNT, never only the total. On the trial run the
 * computed side is the STAGED position (the parsed source rows, which is what the commit would
 * post; the Testmandant's books once G12 provisions one); on the live run it is A08's
 * `trial_balance` closing as of the Übernahmestichtag. The declared side is the operator's per-
 * account expectation from the old system's own export (scope = the account number).
 */

import type { WorkspaceContext } from '../../context.js';
import { computeTrialBalance } from '../../reports/index.js';
import { buildOpeningLines } from '../openingLines.js';
import type { PlanRow } from '../plan.js';
import type { ControlEnv, ControlFinding, ControlModule } from './registry.js';

/**
 * The staged position from the source rows, read through the SAME `buildOpeningLines` builder the
 * commit posts through (`steps.ts` commitRoute), so check and commit see one number: the signed-Saldo
 * split, the explicit debit/credit shape, and the group / non-postable skip are all decided in one
 * place instead of mirrored here by hand.
 */
function parsedNets(ctx: WorkspaceContext, rows: ControlEnv['rows']): Map<string, number> {
  const net = new Map<string, number>();
  for (const line of buildOpeningLines(ctx, rows).lines) {
    net.set(line.account, (net.get(line.account) ?? 0) + line.debitMinor - line.creditMinor);
  }
  return net;
}

/** A08's closing per account for the one-day window at the Stichtag, or undefined when unreadable. */
function ledgerNets(ctx: WorkspaceContext, cutover: string): Map<string, number> | undefined {
  const tb = computeTrialBalance(ctx, { periodStart: cutover, periodEnd: cutover });
  if (!tb.ok) return undefined;
  const rows = tb.rows as Array<{ account: { number: string }; closingMinor: number }>;
  const net = new Map<string, number>();
  for (const row of rows) {
    if (row.closingMinor !== 0) net.set(row.account.number, row.closingMinor);
  }
  return net;
}

/** The computed side for the run: staged rows on the trial run, A08's books on the live run. */
function computedSide(ctx: WorkspaceContext, plan: PlanRow, env: ControlEnv): { net: Map<string, number>; source: string } | undefined {
  if (env.against === 'live') {
    if (plan.cutover_date === null) return undefined;
    const net = ledgerNets(ctx, plan.cutover_date);
    return net === undefined ? undefined : { net, source: 'A08 trial_balance' };
  }
  return { net: parsedNets(ctx, env.rows), source: 'Quelldatei (Testmandant: G12 noch nicht gebaut)' };
}

export const trialBalanceBalanced: ControlModule = {
  kind: 'trial_balance_balanced',
  declarable: false,
  appliesTo: (step) => step.data_class === 'opening_balances',
  compute(ctx, plan, _step, env): ControlFinding[] {
    const side = computedSide(ctx, plan, env);
    if (side === undefined) {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'trial_balance' }];
    }
    let imbalance = 0;
    for (const value of side.net.values()) imbalance += value;
    return [
      {
        scope: 'workspace',
        computedMinor: imbalance,
        inputsPresent: true,
        selfStatus: imbalance === 0 ? 'passed' : 'failed',
        detail: imbalance === 0 ? `ausgeglichen (${side.source})` : `Differenz Soll/Haben: ${imbalance} Rappen (${side.source})`,
      },
    ];
  },
};

export const trialBalanceMatchesSource: ControlModule = {
  kind: 'trial_balance_matches_source',
  declarable: true,
  appliesTo: (step) => step.data_class === 'opening_balances',
  compute(ctx, plan, _step, env): ControlFinding[] {
    const side = computedSide(ctx, plan, env);
    if (side === undefined) {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'trial_balance' }];
    }
    if (side.net.size === 0) {
      // An empty class ties out trivially and says so (US-G11.1 empty state).
      return [{ scope: 'workspace', computedMinor: 0, inputsPresent: true, detail: `leer, 0 == 0 (${side.source})` }];
    }
    // One finding PER ACCOUNT with movement; check.ts widens the set with every DECLARED scope, so a
    // declared account the import never touched still reports (a position missing from the import).
    const findings: ControlFinding[] = [];
    for (const [account, computedMinor] of [...side.net.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      findings.push({ scope: account, computedMinor, inputsPresent: true, detail: side.source });
    }
    return findings;
  },
};
