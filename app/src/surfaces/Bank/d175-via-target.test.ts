/**
 * D175, critic round 1, C3: the engine proposes a complete Buchungsregel with a Durchlaufkonto as
 * `{ kind: 'accounts', legs, viaAccountId }`, certainty `sure`. Both doors that send it (Buchen on the row,
 * `draftTargetOf` then `bookTargetOf`; and "Alle vorgeschlagenen buchen", `proposalTarget` then
 * `bookTargetOf`) must keep `viaAccountId`, or a rule that says "über 1095" posts straight to the revenue
 * account. Synthetic ids only.
 */
import { describe, it, expect } from 'vitest';

import type { BankInboxLine } from './model';
import { bookTargetOf, draftTargetOf, proposalTarget, targetKey } from './model';

const VIA_TARGET = {
  kind: 'accounts',
  legs: [{ accountId: 'acc_3400', amountMinor: 21620, taxCode: 'UST81' }],
  viaAccountId: 'acc_1095',
};

/** An open line whose proposal is a complete rule routed through the Durchlaufkonto (only what the doors read). */
function sureViaLine(): BankInboxLine {
  return {
    bankTxnId: 'btx_1',
    state: 'open',
    amountMinor: 21620,
    proposal: {
      target: VIA_TARGET,
      certainty: 'sure',
      reasonCode: 'standard',
      reasonParams: { standardId: 'bstd_1', accountId: 'acc_3400', taxCode: 'UST81', viaAccountId: 'acc_1095' },
      vatCode: 'UST81',
    },
  } as unknown as BankInboxLine;
}

describe('D175-C3: the Studio keeps the Durchlaufkonto of a proposed accounts target', () => {
  it('Buchen: draftTargetOf then bookTargetOf carries viaAccountId', () => {
    const draft = draftTargetOf(VIA_TARGET);
    expect(draft).not.toBeNull();
    expect(bookTargetOf(draft!)).toMatchObject({ kind: 'accounts', viaAccountId: 'acc_1095' });
  });

  it('the bulk button: proposalTarget then bookTargetOf carries viaAccountId', () => {
    const target = proposalTarget(sureViaLine());
    expect(target).not.toBeNull();
    expect(bookTargetOf(target!)).toMatchObject({
      kind: 'accounts',
      legs: [{ accountId: 'acc_3400', amountMinor: 21620, taxCode: 'UST81' }],
      viaAccountId: 'acc_1095',
    });
  });

  it('a draft without the Durchlaufkonto is not the proposal: the target keys differ', () => {
    const withVia = draftTargetOf(VIA_TARGET);
    const { viaAccountId: _dropped, ...direct } = VIA_TARGET;
    const withoutVia = draftTargetOf(direct);
    expect(targetKey(withVia)).not.toBe(targetKey(withoutVia));
    expect(bookTargetOf(withoutVia!)).not.toHaveProperty('viaAccountId');
  });
});
