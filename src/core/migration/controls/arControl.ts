/**
 * G11, `ar_control` (US-G11.2): open AR proved against the debtor control account.
 *
 * READS A16'S EXISTING INVARIANT, never a second implementation of it: `listOpenItems` already
 * reports `workspaceBaseTotalOpenMinor`, `receivablesBalanceMinor` and `reconciled` (totalOpen
 * equals the posted balance of 1100 Debitoren as of the same date), and two implementations of one
 * reconciliation is two answers to one question, which is the failure OP11 exists against (spec §6b
 * Fixed). The byte-identity test in the G11 suite holds this module to A16's own figure.
 *
 * The control has two legs: A16's invariant must hold (a divergence is `failed` regardless of any
 * declaration), and the declared source AR total, when stated, must equal what the books hold. AR
 * and AP are TWO controls and never one net figure: OR 958c Abs. 1 Ziff. 7, the Verrechnungsverbot.
 *
 * A ledger-membership control computes on the LIVE run; a trial run with no Testmandant (G12 is not
 * built) reports `not_computable` naming the missing input, never a fabricated pass (P9).
 */

import { listOpenItems } from '../../debtors/index.js';
import type { ControlModule } from './registry.js';

export const arControl: ControlModule = {
  kind: 'ar_control',
  declarable: true,
  appliesTo: (step) => step.data_class === 'opening_balances',
  compute(ctx, plan, _step, env) {
    if (env.against !== 'live') {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'testmandant (G12)' }];
    }
    const asOf = plan.cutover_date ?? undefined;
    const read = listOpenItems(ctx, asOf === undefined ? {} : { asOf });
    if (!read.ok) {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'open_items (A16)' }];
    }
    const totalOpen = read.workspaceBaseTotalOpenMinor as number;
    const ledger = read.receivablesBalanceMinor as number;
    if (read.reconciled !== true) {
      return [
        {
          scope: 'workspace',
          computedMinor: totalOpen,
          inputsPresent: true,
          selfStatus: 'failed',
          detail: `offene Posten ${totalOpen} != Konto 1100 ${ledger} (Differenz ${totalOpen - ledger} Rappen)`,
        },
      ];
    }
    // A16's invariant holds; the declared comparison (or the trivial 0 == 0) is generic in check.ts.
    return [{ scope: 'workspace', computedMinor: totalOpen, inputsPresent: true, detail: `A16: offene Posten == Konto 1100 (${ledger})` }];
  },
};
