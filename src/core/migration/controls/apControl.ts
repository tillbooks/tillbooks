/**
 * G11, `ap_control` (US-G11.2): open AP proved against the creditor control account, through A17's
 * OWN read (`listVendorBills` reports `workspaceBaseTotalOpenMinor`, `onAccountMinor`,
 * `payablesBalanceMinor` and `reconciled` over 2000 Kreditoren), never a second derivation.
 *
 * A17's reconciliation is as-of TODAY by that read's own design; in a fresh migration the books hold
 * only the migrated position, so the figure is the opening one. AP is its OWN control, never netted
 * with AR: OR 958c Abs. 1 Ziff. 7 (Verrechnungsverbot).
 */

import { listVendorBills } from '../../purchase/index.js';
import type { ControlModule } from './registry.js';

export const apControl: ControlModule = {
  kind: 'ap_control',
  declarable: true,
  appliesTo: (step) => step.data_class === 'opening_balances',
  compute(ctx, _plan, _step, env) {
    if (env.against !== 'live') {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'testmandant (G12)' }];
    }
    const read = listVendorBills(ctx, {});
    if (!read.ok) {
      return [{ scope: 'workspace', computedMinor: null, inputsPresent: false, missingInput: 'vendor_bills (A17)' }];
    }
    const totalOpen = read.workspaceBaseTotalOpenMinor as number;
    const ledger = read.payablesBalanceMinor as number;
    if (read.reconciled !== true) {
      const diff = read.reconciliationDifferenceMinor as number;
      return [
        {
          scope: 'workspace',
          computedMinor: totalOpen,
          inputsPresent: true,
          selfStatus: 'failed',
          detail: `offene Kreditoren ${totalOpen} != Konto 2000 ${ledger} (Differenz ${diff} Rappen)`,
        },
      ];
    }
    return [{ scope: 'workspace', computedMinor: totalOpen, inputsPresent: true, detail: `A17: offene Kreditoren == Konto 2000 (${ledger})` }];
  },
};
