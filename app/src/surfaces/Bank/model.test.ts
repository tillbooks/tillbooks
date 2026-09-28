/**
 * A2, the bank inbox: the pure half of the surface. The balance line's arithmetic (L4), the Soll/Haben
 * preview an accounts booking shows BEFORE it posts, the row's draft (proposal, person, agent), and the
 * small formatters the panel leans on. Every figure below is invented for this file.
 */
import { describe, it, expect } from 'vitest';

import type { BankAccountBalance, BankInboxLine, DraftLeg, LineVorschlag, VatFigures } from './model';
import {
  bookTargetOf,
  composeAccountsPreview,
  draftFromProposal,
  draftFromVorschlag,
  formatIban,
  formatReference,
  isBookable,
  isSureAndUntouched,
  minorToField,
  parseMoneyInput,
  previewBalances,
  rowCertainty,
  trustIdentityHolds,
  trustView,
} from './model';

function balance(over: Partial<BankAccountBalance> = {}): BankAccountBalance {
  return {
    bankAccountId: 'ba_1',
    name: 'Zürichsee Geschäftskonto',
    iban: 'CH5604835012345678009',
    currency: 'CHF',
    ledgerAccountId: 'acc_1026',
    judgeable: true,
    reason: null,
    statementId: 'st_1',
    statementDate: '2026-09-24',
    // bank 10'740.72 = books 11'958.00 + open lines -1'217.28
    bankBalanceMinor: 1_074_072,
    ledgerBalanceMinor: 1_195_800,
    openCount: 8,
    openSumMinor: -121_728,
    differenceMinor: 0,
    ...over,
  };
}

function line(over: Partial<BankInboxLine> = {}): BankInboxLine {
  return {
    bankTxnId: 'bt_1',
    bankAccountId: 'ba_1',
    statementId: 'st_1',
    state: 'open',
    bookingDate: '2026-09-23',
    valueDate: '2026-09-23',
    amountMinor: -8_990,
    currency: 'CHF',
    creditDebit: 'DBIT',
    reversal: false,
    counterparty: { name: 'Alpina Telecom AG', iban: 'CH2089144975321682466' },
    remittance: { text: 'Rechnung 09/2026', referenceKind: 'NON', referenceValue: null, endToEndId: null },
    entryRef: null,
    creditId: null,
    decision: null,
    proposal: null,
    ...over,
  };
}

const FIG_VSTM: VatFigures = { netMinor: 8_316, taxMinor: 674, grossMinor: 8_990, kind: 'input', deductible: true, formLine: '400' };
const VAT_ACCOUNTS = { input: 'acc_1170', investment: 'acc_1171', output: 'acc_2200' };

describe('the balance line (L4)', () => {
  it('reads bank = books + open lines + difference, straight off the engine', () => {
    const b = balance();
    expect(trustIdentityHolds(b)).toBe(true);
    const v = trustView(b);
    expect(v.tone).toBe('pending');
    expect(v.bank).toBe(1_074_072);
    expect(v.books).toBe(1_195_800);
    expect(v.openCount).toBe(8);
    expect(v.openSum).toBe(-121_728);
    expect((v.books ?? 0) + v.openSum + (v.difference ?? 0)).toBe(v.bank);
  });

  it('is "ok" only when no line is open and nothing differs', () => {
    const v = trustView(balance({ bankBalanceMinor: 1_000_000, ledgerBalanceMinor: 1_000_000, openCount: 0, openSumMinor: 0 }));
    expect(v.tone).toBe('ok');
  });

  it('names every gap the open lines do not explain as a difference: an entry no line backs, an ignored line, an accepted difference', () => {
    // An entry of -42.00 on the bank ledger that no line backs: the books are 42.00 lower than the bank says.
    const v = trustView(balance({ ledgerBalanceMinor: 1_195_800 - 4_200, differenceMinor: 4_200 }));
    expect(v.tone).toBe('difference');
    expect(v.difference).toBe(4_200);
  });

  it('cannot judge an account without a statement, and never draws a sum for it', () => {
    const v = trustView(balance({ judgeable: false, reason: 'no_statement', bankBalanceMinor: null, differenceMinor: null }));
    expect(v.tone).toBe('unknown');
  });

  it('refuses a payload whose own figures do not add up, instead of printing a wrong equation', () => {
    // The difference disagrees with bank - books - open: the identity is broken, so "cannot be judged".
    expect(trustIdentityHolds(balance({ differenceMinor: 100 }))).toBe(false);
    expect(trustView(balance({ differenceMinor: 100 })).tone).toBe('unknown');
  });
});

describe('the Soll/Haben preview of an accounts booking', () => {
  it('splits a paid bill with Vorsteuer into net, Vorsteuer and one bank line, and balances', () => {
    const legs: DraftLeg[] = [{ accountId: 'acc_6500', amountMinor: 8_990, taxCode: 'VST-M' }];
    const lines = composeAccountsPreview(-8_990, legs, 'acc_1026', new Map([[0, FIG_VSTM]]), VAT_ACCOUNTS);
    expect(lines).toEqual([
      { accountId: 'acc_1026', debit: 0, credit: 8_990 },
      { accountId: 'acc_6500', debit: 8_316, credit: 0 },
      { accountId: 'acc_1170', debit: 674, credit: 0 },
    ]);
    expect(previewBalances(lines ?? [])).toBe(true);
  });

  it('waits for a taxed leg\'s figures rather than guessing them', () => {
    const legs: DraftLeg[] = [{ accountId: 'acc_6500', amountMinor: 8_990, taxCode: 'VST-M' }];
    expect(composeAccountsPreview(-8_990, legs, 'acc_1026', new Map(), VAT_ACCOUNTS)).toBeNull();
  });

  it('merges every bank leg of a split into ONE bank line', () => {
    const legs: DraftLeg[] = [
      { accountId: 'acc_6500', amountMinor: 90_000, taxCode: '' },
      { accountId: 'acc_6570', amountMinor: 30_000, taxCode: '' },
    ];
    const lines = composeAccountsPreview(-120_000, legs, 'acc_1026', new Map(), VAT_ACCOUNTS) ?? [];
    expect(lines.filter((l) => l.accountId === 'acc_1026')).toEqual([{ accountId: 'acc_1026', debit: 0, credit: 120_000 }]);
    expect(previewBalances(lines)).toBe(true);
  });

  it('books Vorsteuer on investments to 1171 (ESTV Ziffer 405)', () => {
    const legs: DraftLeg[] = [{ accountId: 'acc_1520', amountMinor: 120_000, taxCode: 'VST-I' }];
    const fig: VatFigures = { netMinor: 111_008, taxMinor: 8_992, grossMinor: 120_000, kind: 'input', deductible: true, formLine: '405' };
    const lines = composeAccountsPreview(-120_000, legs, 'acc_1026', new Map([[0, fig]]), VAT_ACCOUNTS) ?? [];
    expect(lines.find((l) => l.accountId === 'acc_1171')).toEqual({ accountId: 'acc_1171', debit: 8_992, credit: 0 });
  });

  it('credits a sale with Umsatzsteuer on money in', () => {
    const legs: DraftLeg[] = [{ accountId: 'acc_3400', amountMinor: 10_810, taxCode: 'UST81' }];
    const fig: VatFigures = { netMinor: 10_000, taxMinor: 810, grossMinor: 10_810, kind: 'output', deductible: false, formLine: '302' };
    const lines = composeAccountsPreview(10_810, legs, 'acc_1026', new Map([[0, fig]]), VAT_ACCOUNTS) ?? [];
    expect(lines).toEqual([
      { accountId: 'acc_1026', debit: 10_810, credit: 0 },
      { accountId: 'acc_3400', debit: 0, credit: 10_000 },
      { accountId: 'acc_2200', debit: 0, credit: 810 },
    ]);
  });
});

describe("a row's draft", () => {
  const sure = line({
    proposal: {
      target: { kind: 'open_item', documentId: 'doc_1', remainder: 'leave_open' },
      certainty: 'sure',
      reasonCode: 'qr_reference_exact',
      reasonParams: {},
      vatCode: null,
    } as unknown as BankInboxLine['proposal'],
    amountMinor: 4_242,
  });

  it('starts from the engine proposal, and "Alle sicheren buchen" takes only a sure, untouched one', () => {
    const draft = draftFromProposal(sure);
    expect(draft.source).toBe('proposal');
    expect(rowCertainty(sure, draft)).toBe('sure');
    expect(isSureAndUntouched(sure, draft)).toBe(true);
    const edited = { target: { kind: 'accounts' as const, legs: [{ accountId: 'acc_3200', amountMinor: 4_242, taxCode: '' }] }, source: 'edited' as const };
    expect(rowCertainty(sure, edited)).toBe('edited');
    expect(isSureAndUntouched(sure, edited)).toBe(false);
  });

  it("puts the agent's drafted booking on the row, marked as the agent's", () => {
    const v: LineVorschlag = {
      actionId: 'act_1',
      actor: 'till-cli',
      actionTool: 'book_bank_line',
      dialCapability: 'post',
      bankTxnId: 'bt_1',
      payload: { target: { kind: 'accounts', legs: [{ accountId: 'acc_6700', amountMinor: 3_850, taxCode: 'VST-M' }] } },
      createdAt: '2026-09-25T10:00:00Z',
    };
    const draft = draftFromVorschlag(v);
    expect(draft).toEqual({ target: { kind: 'accounts', legs: [{ accountId: 'acc_6700', amountMinor: 3_850, taxCode: 'VST-M' }] }, source: 'agent' });
    expect(rowCertainty(line({ amountMinor: -3_850 }), draft ?? undefined)).toBe('agent');
  });

  it('leaves the row alone for a drafted verb that books nothing', () => {
    const v: LineVorschlag = {
      actionId: 'act_2',
      actor: 'till-cli',
      actionTool: 'ignore_bank_line',
      dialCapability: 'post',
      bankTxnId: 'bt_1',
      payload: { reason: 'duplicate' },
      createdAt: '2026-09-25T10:00:00Z',
    };
    expect(draftFromVorschlag(v)).toBeNull();
    expect(draftFromVorschlag(undefined)).toBeNull();
  });

  it('matches with a difference only with a stated reason, and sends the reason (critic A39-12)', () => {
    const l = line({ amountMinor: -4_250 });
    expect(isBookable(l, { kind: 'existing_entry', entryId: 'je_1', acceptDifference: true })).toBe(false);
    expect(isBookable(l, { kind: 'existing_entry', entryId: 'je_1', acceptDifference: true, differenceReason: '  ' })).toBe(false);
    const withReason = { kind: 'existing_entry' as const, entryId: 'je_1', acceptDifference: true, differenceReason: ' Bankspesen ' };
    expect(isBookable(l, withReason)).toBe(true);
    expect(bookTargetOf(withReason)).toEqual({ kind: 'existing_entry', entryId: 'je_1', acceptDifference: true, differenceReason: 'Bankspesen' });
    expect(bookTargetOf({ kind: 'existing_entry', entryId: 'je_1', acceptDifference: false })).toEqual({ kind: 'existing_entry', entryId: 'je_1' });
  });

  it('is not bookable while an accounts split does not add up to the line', () => {
    const l = line({ amountMinor: -120_000 });
    expect(isBookable(l, { kind: 'accounts', legs: [{ accountId: 'acc_6500', amountMinor: 90_000, taxCode: '' }] })).toBe(false);
    expect(
      isBookable(l, {
        kind: 'accounts',
        legs: [
          { accountId: 'acc_6500', amountMinor: 90_000, taxCode: '' },
          { accountId: 'acc_6570', amountMinor: 30_000, taxCode: '' },
        ],
      }),
    ).toBe(true);
  });
});

describe('the formatters', () => {
  it('reads Swiss money input and writes it back', () => {
    expect(parseMoneyInput("1'234.50")).toBe(123_450);
    expect(parseMoneyInput('1234,5')).toBe(123_450);
    expect(parseMoneyInput('-12')).toBe(-1_200);
    expect(parseMoneyInput('12.345')).toBeNull();
    expect(parseMoneyInput('zwölf')).toBeNull();
    expect(minorToField(-500)).toBe('-5.00');
    expect(minorToField(8_990)).toBe('89.90');
  });

  it('prints a QR reference in blocks of five from the right, an RF reference in fours', () => {
    expect(formatReference('QRR', '210000000003139471430009017')).toBe('21 00000 00003 13947 14300 09017');
    expect(formatReference('SCOR', 'RF18539007547034')).toBe('RF18 5390 0754 7034');
    expect(formatReference('NON', 'Rechnung 4471')).toBe('Rechnung 4471');
    expect(formatIban('CH5604835012345678009')).toBe('CH56 0483 5012 3456 7800 9');
  });
});
