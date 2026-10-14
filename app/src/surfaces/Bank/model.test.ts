/**
 * A2, the bank inbox: the pure half of the surface. The balance line's arithmetic (L4), the Soll/Haben
 * preview an accounts booking shows BEFORE it posts (the engine's `compose_entry` answer, read), the row's draft (proposal, person, agent), and the
 * small formatters the panel leans on. Every figure below is invented for this file.
 */
import { describe, it, expect } from 'vitest';

import type { BankAccountBalance, BankInboxLine, DraftLeg, LineVorschlag } from './model';
import {
  bookTargetOf,
  draftFromProposal,
  draftFromVorschlag,
  formatIban,
  formatReference,
  isBookable,
  isSureAndUntouched,
  minorToField,
  parseMoneyInput,
  rowCertainty,
  trustIdentityHolds,
  trustView,
  taxCodeOnChoosing,
  vatCanApply,
} from './model';
import type { ComposeAnswer } from './bankCompose';
import { bankComposeRequest, captionKinds, composeSignature, previewBalances, previewLinesOf, requestIsTaxed, vatAccountIdsOf, vatSplitOf } from './bankCompose';
import { composeEngine } from '../../../test-support/composeEngine';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';

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
    attention: null,
    receiptCount: 0,
    needsReceipt: false,
    ...over,
  };
}

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

/**
 * The preview is the ENGINE's (D152 amendment, the bank follow-up): every Soll/Haben line and VAT split below is
 * what `compose_entry` answers for the request `bankComposeRequest` builds, run on the real engine
 * (`app/test-support/composeEngine.ts`, whose book carries the recorded chart's account ids). The Studio reads
 * it; it computes no figure. The equality with what `book_bank_line` posts is the node suite
 * `test/banking/bank-compose-parity.test.mjs`.
 */
const engine = composeEngine();
const chartId = (number: string): string => {
  const row = listAccountsFixture.accounts.find((a) => a.number === number);
  if (row === undefined) throw new Error(`the recorded chart has no account ${number}`);
  return row.id;
};
const BANK = chartId('1020');
const ACC = { a1170: chartId('1170'), a1171: chartId('1171'), a2200: chartId('2200'), a1520: chartId('1520'), a3400: chartId('3400'), a4200: chartId('4200'), a6500: chartId('6500'), a6570: chartId('6570'), a6900: chartId('6900') };

/** The engine's answer for a line of `lineMinor` (signed, money in positive) booked to `legs`. */
function composed(lineMinor: number, legs: DraftLeg[]): ComposeAnswer {
  const request = bankComposeRequest(line({ amountMinor: lineMinor }), legs, BANK);
  if (request === null) throw new Error('no request');
  const { body } = engine({ workspaceId: 'ws_test', mode: 'expand', date: request.date, lines: request.lines });
  if (body.ok !== true) throw new Error(`compose_entry refused: ${JSON.stringify(body)}`);
  return body as unknown as ComposeAnswer;
}
const splitOf = (answer: ComposeAnswer) => vatSplitOf(previewLinesOf(answer), BANK, vatAccountIdsOf(answer));

describe('B2: the strip\'s VAT split, read off the engine\'s composition', () => {
  it('names the tax, its account and the net exactly as the Soll/Haben lines hold them', () => {
    const answer = composed(-8_990, [{ accountId: ACC.a6500, amountMinor: 8_990, taxCode: 'VST-M' }]);
    expect(splitOf(answer)).toEqual({ parts: [{ accountId: ACC.a1170, amountMinor: 674 }], netMinor: 8_316 });
    expect(captionKinds(answer)).toEqual(['input']);
  });

  it('F5: a split that runs both ways (120 revenue incl. 8.1 %, less 20 fees) says the tax and NO netto', () => {
    const answer = composed(10_000, [
      { accountId: ACC.a3400, amountMinor: 12_000, taxCode: 'UST81' },
      { accountId: ACC.a6900, amountMinor: -2_000, taxCode: '' },
    ]);
    expect(previewBalances(previewLinesOf(answer))).toBe(true);
    expect(splitOf(answer)).toEqual({ parts: [{ accountId: ACC.a2200, amountMinor: 899 }], netMinor: null });
  });

  it('F5: a split that runs one way sums its net WITH its side: tax plus net is the line', () => {
    const answer = composed(-10_000, [
      { accountId: ACC.a6500, amountMinor: 8_990, taxCode: 'VST-M' },
      { accountId: ACC.a6900, amountMinor: 1_010, taxCode: '' },
    ]);
    const split = splitOf(answer);
    expect(split).toEqual({ parts: [{ accountId: ACC.a1170, amountMinor: 674 }], netMinor: 9_326 });
    expect((split?.netMinor ?? 0) + 674).toBe(10_000);
  });

  it('says nothing for a booking without a VAT line', () => {
    expect(splitOf(composed(-500, [{ accountId: ACC.a6900, amountMinor: 500, taxCode: '' }]))).toBeNull();
  });

  it('an Einfuhrsteuer: the payment IS the tax, on the account the engine names (its caption)', () => {
    const answer = composed(-7_700, [{ accountId: ACC.a4200, amountMinor: 7_700, taxCode: 'IMPORT' }]);
    expect(captionKinds(answer)).toEqual(['import']);
    expect(splitOf(answer)).toEqual({ parts: [{ accountId: ACC.a1170, amountMinor: 7_700 }], netMinor: 0 });
  });

  it('a code the engine cannot price is its refusal, not a figure: nothing is composed', () => {
    const answer = composed(-8_990, [{ accountId: ACC.a6500, amountMinor: 8_990, taxCode: 'NOPE' }]);
    expect(answer.composed).toBe(false);
    expect(answer.lines).toEqual([]);
  });

  // The composer's predicate table (`Journal/composerPayload.ts isTaxBearing`, C8, owner 01.10.2026), row
  // for row, plus the one exclusion only the Bank can make: a Bankkonto's own ledger account.
  const a = (number: string, type: string | null, vatCodeDefault: string | null = null) => ({ id: `acc_${number}`, number, type, vatCodeDefault });
  const TABLE: [string, ReturnType<typeof a> | undefined, boolean][] = [
    ['an Erfolgskonto (expense)', a('6500', 'expense'), true],
    ['an Erfolgskonto (income)', a('3400', 'income'), true],
    ['Anlagevermögen, lowest (1400 Finanzanlagen)', a('1400', 'asset'), true],
    ['Anlagevermögen (1520 Büromaschinen, VST-I to 1171)', a('1520', 'asset'), true],
    ['Anlagevermögen, highest (1799 immaterielle Werte)', a('1799', 'asset'), true],
    ['Vorräte, lowest (1200 Handelswaren, owner 04.10.2026)', a('1200', 'asset'), true],
    ['Vorräte with its default code', a('1200', 'asset', 'VST-M'), true],
    ['Umlaufvermögen (1100 Forderungen)', a('1100', 'asset'), false],
    ['Umlaufvermögen below the range (1199)', a('1199', 'asset'), false],
    ['Rechnungsabgrenzung (1300: accruals, a code would invite a second Vorsteuer claim)', a('1300', 'asset'), false],
    ['Rechnungsabgrenzung with a default code (a pre-fill, never a reason)', a('1399', 'asset', 'VST-M'), false],
    ['Umlaufvermögen with a default code (a pre-fill, never a reason)', a('1060', 'asset', 'VST-M'), false],
    ['an asset past the range (1800)', a('1800', 'asset'), false],
    ['a 15xx number that is not an asset', a('1500', 'liability'), false],
    ['a liability', a('2000', 'liability'), false],
    ['equity', a('2800', 'equity'), false],
    ['an account of unknown type', a('9999', null), false],
    ['an account of unknown type with a default code', a('6600', null, 'VST-M'), false],
    ['1170 Vorsteuer Material', a('1170', 'asset', 'VST-M'), false],
    ['1171 Vorsteuer Investitionen', a('1171', 'asset', 'VST-I'), false],
    ['2200 Umsatzsteuer', a('2200', 'liability', 'UST-N'), false],
    ['no account', undefined, false],
  ];
  for (const [what, account, expected] of TABLE) {
    it(`MWST applies to ${what}: ${expected}`, () => {
      expect(vatCanApply(account)).toBe(expected);
    });
  }

  it('never offers MWST on a Bankkonto\'s own ledger account, whatever its type (the Bank\'s extra exclusion)', () => {
    expect(vatCanApply(a('1520', 'asset'), new Set(['acc_1520']))).toBe(false);
    expect(vatCanApply(a('6500', 'expense'), new Set(['acc_6500']))).toBe(false);
    expect(vatCanApply(a('1020', 'asset', 'VST-M'), new Set(['acc_1020']))).toBe(false);
  });

  it('pre-fills the default code only on an account that qualifies, and clears the code where none applies', () => {
    expect(taxCodeOnChoosing(a('6500', 'expense', 'VST-M'), '')).toBe('VST-M');
    expect(taxCodeOnChoosing(a('1520', 'asset', 'VST-I'), '')).toBe('VST-I');
    expect(taxCodeOnChoosing(a('6500', 'expense'), 'VST-M')).toBe('VST-M');
    expect(taxCodeOnChoosing(a('1200', 'asset', 'VST-M'), '')).toBe('VST-M');
    expect(taxCodeOnChoosing(a('1060', 'asset', 'VST-M'), '')).toBe('');
    expect(taxCodeOnChoosing(a('1300', 'asset', 'VST-M'), '')).toBe('');
    expect(taxCodeOnChoosing(a('2000', 'liability'), 'VST-M')).toBe('');
    expect(taxCodeOnChoosing(a('9999', null, 'VST-M'), '')).toBe('');
    expect(taxCodeOnChoosing(undefined, 'VST-M')).toBe('');
  });

  it('VST-I on an Anlagekonto books the net to the asset, the tax to 1171 (Ziffer 405) and the gross on the bank', () => {
    const answer = composed(-216_200, [{ accountId: ACC.a1520, amountMinor: 216_200, taxCode: 'VST-I' }]);
    expect(previewLinesOf(answer)).toEqual([
      { accountId: BANK, debit: 0, credit: 216_200 },
      { accountId: ACC.a1520, debit: 200_000, credit: 0 },
      { accountId: ACC.a1171, debit: 16_200, credit: 0 },
    ]);
  });
});

describe('the Soll/Haben preview of an accounts booking (the engine\'s lines)', () => {
  it('splits a paid bill with Vorsteuer into net, Vorsteuer and one bank line, and balances', () => {
    const lines = previewLinesOf(composed(-8_990, [{ accountId: ACC.a6500, amountMinor: 8_990, taxCode: 'VST-M' }]));
    expect(lines).toEqual([
      { accountId: BANK, debit: 0, credit: 8_990 },
      { accountId: ACC.a6500, debit: 8_316, credit: 0 },
      { accountId: ACC.a1170, debit: 674, credit: 0 },
    ]);
    expect(previewBalances(lines)).toBe(true);
  });

  it('merges every bank leg of a split into ONE bank line', () => {
    const lines = previewLinesOf(
      composed(-120_000, [
        { accountId: ACC.a6500, amountMinor: 90_000, taxCode: '' },
        { accountId: ACC.a6570, amountMinor: 30_000, taxCode: '' },
      ]),
    );
    expect(lines.filter((l) => l.accountId === BANK)).toEqual([{ accountId: BANK, debit: 0, credit: 120_000 }]);
    expect(previewBalances(lines)).toBe(true);
  });

  it('books Vorsteuer on investments to 1171 (ESTV Ziffer 405)', () => {
    const lines = previewLinesOf(composed(-120_000, [{ accountId: ACC.a1520, amountMinor: 120_000, taxCode: 'VST-I' }]));
    expect(lines.find((l) => l.accountId === ACC.a1171)).toEqual({ accountId: ACC.a1171, debit: 8_992, credit: 0 });
  });

  it('credits a sale with Umsatzsteuer on money in', () => {
    const lines = previewLinesOf(composed(10_810, [{ accountId: ACC.a3400, amountMinor: 10_810, taxCode: 'UST81' }]));
    expect(lines).toEqual([
      { accountId: BANK, debit: 10_810, credit: 0 },
      { accountId: ACC.a3400, debit: 0, credit: 10_000 },
      { accountId: ACC.a2200, debit: 0, credit: 810 },
    ]);
  });
});

describe('the compose_entry request a bank line makes (bankComposeRequest)', () => {
  it('states each leg as an intent line on the side the money puts it, the bank leg plain and first, on the booking date', () => {
    expect(
      bankComposeRequest(
        line({ amountMinor: 10_000 }),
        [
          { accountId: ACC.a3400, amountMinor: 12_000, taxCode: 'UST81' },
          { accountId: ACC.a6900, amountMinor: -2_000, taxCode: '' },
        ],
        BANK,
      ),
    ).toEqual({
      date: '2026-09-23',
      lines: [
        { account: BANK, debit: 10_000 },
        { account: ACC.a3400, side: 'credit', amount: 12_000, gross: true, taxCode: 'UST81', supplyDate: '2026-09-23' },
        { account: ACC.a6900, side: 'debit', amount: 2_000, gross: true },
      ],
    });
  });

  it('asks no zero bank line for legs that cancel out, and reads the reserved code "none" as no VAT (critic mutants M6, M8)', () => {
    // A half-typed split whose legs net to nothing moves no money on the bank: no `{debit: 0}` line is asked for.
    expect(
      bankComposeRequest(
        line({ amountMinor: -1_000 }),
        [
          { accountId: ACC.a6500, amountMinor: 1_000, taxCode: '' },
          { accountId: ACC.a6900, amountMinor: -1_000, taxCode: '' },
        ],
        BANK,
      )?.lines.filter((l) => l.account === BANK),
    ).toEqual([]);
    // 'none' is `book_bank_line`'s "no code": no taxCode, no Leistungsdatum, and not a taxed request (so a
    // foreign-currency line with it is not held back as VAT).
    const none = bankComposeRequest(line(), [{ accountId: ACC.a6900, amountMinor: 8_990, taxCode: 'none' }], BANK);
    expect(none?.lines[1]).toEqual({ account: ACC.a6900, side: 'debit', amount: 8_990, gross: true });
    expect(none === null ? null : requestIsTaxed(none)).toBe(false);
  });

  it('asks nothing while a leg has no account or no amount, or the Bankkonto has no ledger account', () => {
    expect(bankComposeRequest(line(), [{ accountId: '', amountMinor: 8_990, taxCode: '' }], BANK)).toBeNull();
    expect(bankComposeRequest(line(), [{ accountId: ACC.a6500, amountMinor: 0, taxCode: '' }], BANK)).toBeNull();
    expect(bankComposeRequest(line(), [{ accountId: ACC.a6500, amountMinor: 8_990, taxCode: '' }], null)).toBeNull();
  });

  it('keys an answer on everything the request carries', () => {
    const one = bankComposeRequest(line(), [{ accountId: ACC.a6500, amountMinor: 8_990, taxCode: 'VST-M' }], BANK);
    const other = bankComposeRequest(line(), [{ accountId: ACC.a6500, amountMinor: 8_990, taxCode: 'VST-I' }], BANK);
    expect(composeSignature('ws_test', one)).not.toBe(composeSignature('ws_test', other));
    expect(composeSignature('ws_test', one)).not.toBe(composeSignature('ws_other', one));
    expect(composeSignature('ws_test', null)).toBe('');
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

describe('modelPercent (D144, critic C5b)', () => {
  it('floors to a whole percent, absorbs binary noise, and never reads 100', async () => {
    const { modelPercent } = await import('./lookups');
    expect(modelPercent(0.8249)).toBe('82');
    expect(modelPercent(0.29)).toBe('29');
    expect(modelPercent(0.99996)).toBe('99');
    expect(modelPercent(1)).toBe('99');
    expect(modelPercent(null)).toBe('');
  });
});
