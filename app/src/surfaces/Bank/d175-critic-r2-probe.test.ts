/**
 * D175 non-author critic probe, round 2 (critic/d175-r2-2026-10-15). The Studio's money path for a
 * Buchungsregel: the `rule` target, its asks and a Durchlaufkonto reach `book_bank_line` unchanged, and the
 * bulk doors never send an asked rule, a `several_rules` line or a `check` (suggest-mode) rule, even if the
 * engine's `attention` said `sure`. Synthetic ids only.
 */
import { describe, it, expect } from 'vitest';

import type { BankInboxLine } from './model';
import { bookTargetOf, draftTargetOf, isBookable, isSureAndUntouched, proposalTarget } from './model';

function line(proposal: Record<string, unknown> | null, attention = 'sure'): BankInboxLine {
  return { bankTxnId: 'btx_1', state: 'open', amountMinor: 3000, attention, proposal, ruleIds: ['bstd_1'] } as unknown as BankInboxLine;
}

describe('D175 r2: the rule target round trip', () => {
  it('an agent-drafted rule target with filled asks reaches the engine unchanged, odd Rappen and large figures included', () => {
    for (const asks of [{ '0': 21623 }, { '0': 1, '2': 5 }, { '1': 99999999999999 }, { '0': 10, '3': 123456789 }]) {
      const raw = { kind: 'rule', standardId: 'bstd_1', asks };
      const draft = draftTargetOf(raw);
      expect(draft).not.toBeNull();
      expect(isBookable(line(null), draft)).toBe(true);
      expect(bookTargetOf(draft!)).toEqual(raw);
    }
  });

  it('a via accounts target with several legs, one against the line, reaches the engine unchanged', () => {
    const raw = {
      kind: 'accounts',
      legs: [
        { accountId: 'acc_3400', amountMinor: 21623, taxCode: 'UST81' },
        { accountId: 'acc_4400', amountMinor: -18623 },
      ],
      viaAccountId: 'acc_1095',
    };
    expect(bookTargetOf(draftTargetOf(raw)!)).toEqual(raw);
  });
});

describe('D175 r2: the bulk doors never send what a person must decide', () => {
  const asked = { target: { kind: 'rule', standardId: 'bstd_1', asks: {} }, certainty: 'sure', reasonCode: 'rule_needs_amount', reasonParams: { standardId: 'bstd_1', asks: [{ legIndex: 0, label: 'Bruttoumsatz' }] }, vatCode: null };
  const several = { target: null, certainty: 'sure', reasonCode: 'several_rules', reasonParams: { standardIds: ['bstd_1', 'bstd_2'] }, vatCode: null };
  const suggest = { target: { kind: 'accounts', legs: [{ accountId: 'acc_3400', amountMinor: 3000 }] }, certainty: 'check', reasonCode: 'standard', reasonParams: { standardId: 'bstd_1' }, vatCode: null };

  it('an asked rule, even mislabelled sure by the engine, is not bulk-bookable as proposed', () => {
    expect(isSureAndUntouched(line(asked), undefined)).toBe(false);
    expect(isBookable(line(asked), proposalTarget(line(asked)))).toBe(false);
  });
  it('a several_rules line is not bulk-bookable', () => {
    expect(isSureAndUntouched(line(several), undefined)).toBe(false);
  });
  it('a suggest-mode rule (check) is not bulk-bookable', () => {
    expect(isSureAndUntouched(line(suggest, 'needs'), undefined)).toBe(false);
  });
});
