// A19, bank accounts: the register every downstream banking capability hangs off.
//
// The claims that matter here are not "a row was written". They are:
//   - an IBAN is validated by ISO 13616 mod-97 and a QR-IBAN is detected by the SIX QR-IID range,
//   - the opening balance is a REAL posted journal entry, balanced to the Rappen (§H-LEDGER),
//   - re-confirming it does not double-post, proven by COUNTING ROWS (§H-IDEMPOTENT),
//   - no query crosses a workspace boundary (§H-TENANT),
//   - a key field freezes once the account is referenced.
//
// Every idempotency assertion below counts rows. A verb can return `{ok:true}` twice while writing
// twice, and only the row count can tell those two apart.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBankAccount,
  updateBankAccount,
  archiveBankAccount,
  unarchiveBankAccount,
  listBankAccounts,
  getBankAccount,
  setBankOpeningBalance,
  validateIban,
  QR_IID_MIN,
  QR_IID_MAX,
} from '../../dist/core/banking/index.js';

import {
  setup,
  secondWorkspace,
  seedOpeningBalanceAccount,
  seedRate,
  counts,
  legsOf,
  accountBalance,
  PLAIN_IBAN,
  QR_IBAN,
  IID_BOUNDARY,
} from './support.mjs';

const ok = (res) => {
  assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res)}`);
  return res;
};

function addAccount(ctx, t, overrides = {}) {
  return createBankAccount(ctx, {
    name: 'PostFinance Geschäft',
    iban: PLAIN_IBAN,
    currency: 'CHF',
    ledgerAccountId: t.bankLedgerId,
    idempotencyKey: 'ba-1',
    ...overrides,
  });
}

// --- validateIban, the pure predicate A18/A20/A21 reuse ----------------------------------------

test('validateIban accepts a published Swiss IBAN and reports it as not a QR-IBAN', () => {
  const res = ok(validateIban(PLAIN_IBAN));
  assert.equal(res.isQrIban, false);
  // Normalisation is part of the contract: the stored form is spaceless and upper-case.
  assert.equal(res.iban, 'CH9300762011623852957');
});

test('validateIban rejects bad check digits and a wrong length, each as invalid_iban', () => {
  // CH93... with the check digits transposed is structurally fine and mod-97 wrong.
  assert.equal(validateIban('CH39 0076 2011 6238 5295 7').error, 'invalid_iban');
  // A Swiss IBAN is 21 characters; 20 is not a near-miss, it is a different account.
  assert.equal(validateIban('CH930076201162385295').error, 'invalid_iban');
  assert.equal(validateIban('not-an-iban').error, 'invalid_iban');
  assert.equal(validateIban('').error, 'invalid_iban');
});

test('the QR-IID range is exactly 30000 to 31999 at both edges', () => {
  assert.equal(QR_IID_MIN, 30000);
  assert.equal(QR_IID_MAX, 31999);
  assert.equal(ok(validateIban(IID_BOUNDARY[29999])).isQrIban, false, '29999 is below the range');
  assert.equal(ok(validateIban(IID_BOUNDARY[30000])).isQrIban, true, '30000 is the first QR-IID');
  assert.equal(ok(validateIban(IID_BOUNDARY[31999])).isQrIban, true, '31999 is the last QR-IID');
  assert.equal(ok(validateIban(IID_BOUNDARY[32000])).isQrIban, false, '32000 is above the range');
});

// --- US-A19.1, register an account -------------------------------------------------------------

test('createBankAccount validates the IBAN, links the ledger account and stores a normalised row', () => {
  const t = setup();
  const res = ok(addAccount(t.ctx, t));

  const row = t.store.db
    .prepare('SELECT * FROM bank_account WHERE id = ?')
    .get(res.bankAccountId);
  assert.equal(row.workspace_id, t.workspaceId, '§H-TENANT: the row is stamped with the workspace');
  assert.equal(row.iban, 'CH9300762011623852957', 'the IBAN is stored spaceless and upper-case');
  assert.equal(row.is_qr_iban, 0);
  assert.equal(row.currency, 'CHF');
  assert.equal(row.ledger_account_id, t.bankLedgerId);
  assert.equal(row.archived, 0);
});

test('a malformed IBAN is refused with invalid_iban and writes NOTHING', () => {
  const t = setup();
  const before = counts(t.store, t.workspaceId);
  const res = addAccount(t.ctx, t, { iban: 'CH39 0076 2011 6238 5295 7' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_iban');
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'a rejected create must not write a row');
});

test('a missing or unusable ledger account is refused with needs_ledger_account', () => {
  const t = setup();
  assert.equal(addAccount(t.ctx, t, { ledgerAccountId: undefined }).error, 'needs_ledger_account');
  assert.equal(addAccount(t.ctx, t, { ledgerAccountId: 'acc_nope' }).error, 'needs_ledger_account');
  // Money sits on an asset account. Linking a bank account to revenue is not a bank account.
  assert.equal(
    addAccount(t.ctx, t, { ledgerAccountId: t.revenueLedgerId }).error,
    'needs_ledger_account',
  );
});

test('createBankAccount is idempotent on ROWS, not on the returned id', () => {
  const t = setup();
  const first = ok(addAccount(t.ctx, t));
  const second = ok(addAccount(t.ctx, t));
  assert.equal(second.bankAccountId, first.bankAccountId, 'the replay returns the ORIGINAL id');
  assert.equal(
    counts(t.store, t.workspaceId).bankAccounts,
    1,
    '§H-IDEMPOTENT: one key, one row, counted in the database',
  );
});

test('the same IBAN cannot be registered twice under a different key', () => {
  const t = setup();
  ok(addAccount(t.ctx, t));
  const dup = addAccount(t.ctx, t, { idempotencyKey: 'ba-2', name: 'Zweitkonto' });
  assert.equal(dup.error, 'duplicate_iban');
  assert.equal(counts(t.store, t.workspaceId).bankAccounts, 1);
});

// --- US-A19.2, QR-IBAN detection ---------------------------------------------------------------

test('a QR-IBAN is stored with is_qr_iban and flagged receive-only', () => {
  const t = setup();
  const res = ok(addAccount(t.ctx, t, { iban: QR_IBAN }));
  const row = t.store.db.prepare('SELECT is_qr_iban FROM bank_account WHERE id = ?').get(res.bankAccountId);
  assert.equal(row.is_qr_iban, 1);

  // SIX, "Technical information about the QR-IID and QR-IBAN" v1.1 §3.1: "A QR-IBAN can only be
  // used for incoming payments. Payments debiting a QR-IBAN are not anticipated." A18 must never
  // pick this account as a pain.001 debit account, so the read model says so out loud.
  const read = ok(getBankAccount(t.ctx, { bankAccountId: res.bankAccountId }));
  assert.equal(read.bankAccount.isQrIban, true);
  assert.equal(read.bankAccount.receiveOnly, true);

  const plain = ok(addAccount(t.ctx, t, { iban: PLAIN_IBAN, idempotencyKey: 'ba-plain' }));
  const plainRead = ok(getBankAccount(t.ctx, { bankAccountId: plain.bankAccountId }));
  assert.equal(plainRead.bankAccount.isQrIban, false);
  assert.equal(plainRead.bankAccount.receiveOnly, false, 'a plain IBAN can be debited');
});

// --- US-A19.3, the opening balance is a real posted entry --------------------------------------

test('setBankOpeningBalance posts a balanced entry: debit the bank, credit 9100', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));

  const res = ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-1',
    }),
  );
  assert.equal(res.posted, true);

  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  assert.deepEqual(
    legs.map((l) => ({ number: l.number, debit: l.debit, credit: l.credit })),
    [
      { number: '1020', debit: 1250000, credit: 0 },
      { number: '9100', debit: 0, credit: 1250000 },
    ],
    "CHF 12'500.00 debit 1020 against the opening-balance equity account",
  );
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 1250000);
  assert.equal(accountBalance(t.store, t.workspaceId, '9100'), -1250000);
});

test('an opening balance without 9100 in the chart is refused with needs_account, not invented', () => {
  const t = setup(); // 9100 deliberately NOT seeded
  const acct = ok(addAccount(t.ctx, t));
  const before = counts(t.store, t.workspaceId);

  const res = setBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-1',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'needs_account');
  assert.equal(res.number, '9100', 'the rejection names the account to restore');
  assert.equal(counts(t.store, t.workspaceId).entries, before.entries, 'nothing was posted');
});

test('re-confirming the opening balance does NOT double-post, counted in journal rows', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));
  const args = {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-1',
  };
  const first = ok(setBankOpeningBalance(t.ctx, args));
  const after = counts(t.store, t.workspaceId);
  const second = ok(setBankOpeningBalance(t.ctx, args));

  assert.equal(second.entryId, first.entryId, 'the replay returns the ORIGINAL entry');
  assert.deepEqual(counts(t.store, t.workspaceId), after, '§H-IDEMPOTENT on rows: no second entry, no second line');
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 1250000, 'and the balance did not double');
});

test('a DIFFERENT amount under the SAME key replays the first posting, which is why the caller must re-mint', () => {
  // Not a defect report against the engine: it is the engine's contract, written down where the next
  // caller will meet it. `SqliteStore.rememberIdempotent` keys on `(workspace_id, verb, key)` and
  // stores no fingerprint of the input, so a differing call under a recorded key REPLAYS rather than
  // conflicting. The replay is what makes a retry after a lost response safe, and the same property
  // makes a retry of a CHANGED question silently wrong.
  //
  // The Studio met exactly this: its Eröffnungssaldo step minted one key at mount and reused it after
  // the operator edited the amount, so a CHF 250.00 click was answered `ok` with the CHF 100.00 entry
  // and the step closed reporting success. That is fixed at the caller
  // (`app/src/surfaces/BankAccounts/OpeningBalanceStep.tsx`, where the key is derived from the
  // question), and this test is the engine half of the pair: it pins the behaviour the caller has to
  // hold itself against, so a future change here that started rejecting instead cannot pass silently.
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));
  const args = {
    bankAccountId: acct.bankAccountId,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-lost-response',
  };
  const first = ok(setBankOpeningBalance(t.ctx, { ...args, amountMinor: 10000 }));
  const after = counts(t.store, t.workspaceId);

  const replayed = ok(setBankOpeningBalance(t.ctx, { ...args, amountMinor: 25000 }));

  assert.equal(replayed.entryId, first.entryId, 'the CHF 250.00 request is answered with the CHF 100.00 entry');
  assert.deepEqual(counts(t.store, t.workspaceId), after, 'and nothing at all was written for the second request');
  // On ROWS, because a return value that echoes the original id proves nothing about the ledger.
  assert.equal(
    accountBalance(t.store, t.workspaceId, '1020'),
    10000,
    'the ledger holds the FIRST amount, not the one the second caller asked for',
  );
  const row = t.store.db
    .prepare('SELECT opening_balance_minor AS m FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, acct.bankAccountId);
  assert.equal(row.m, 10000, 'and so does the bank_account row');
});

test('a SECOND opening balance under a different key is refused, never silently stacked', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));
  ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-1',
    }),
  );
  const after = counts(t.store, t.workspaceId);
  const res = setBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 999,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-2',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'opening_balance_already_set');
  assert.deepEqual(counts(t.store, t.workspaceId), after);
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), 1250000);
});

test('a zero opening balance posts nothing at all', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));
  const before = counts(t.store, t.workspaceId);
  const res = ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 0,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-0',
    }),
  );
  assert.equal(res.posted, false);
  assert.equal(res.entryId, undefined);
  assert.deepEqual(counts(t.store, t.workspaceId), before, 'CHF 0.00 is not an economic event');
});

test('a negative opening balance (an overdraft) reverses the sides and still balances', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));
  const res = ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: -50000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-neg',
    }),
  );
  assert.deepEqual(
    legsOf(t.store, t.workspaceId, res.entryId).map((l) => ({
      number: l.number,
      debit: l.debit,
      credit: l.credit,
    })),
    [
      { number: '1020', debit: 0, credit: 50000 },
      { number: '9100', debit: 50000, credit: 0 },
    ],
  );
  assert.equal(accountBalance(t.store, t.workspaceId, '1020'), -50000);
});

test('the posted opening entry is immutable: a destructive edit is refused by the ledger', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));
  const res = ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-1',
    }),
  );
  // §H-AUDIT: the entry is a posted journal row, so A02's immutability trigger owns it. A19 adds no
  // exception of its own, and a correction is a reversing entry, never an edit.
  assert.throws(
    () => t.store.db.prepare('UPDATE journal_entry SET date = ? WHERE id = ?').run('2026-02-02', res.entryId),
    /posted_immutable/,
  );
});

// --- US-A19.4, a foreign-currency account (§H-FX) ----------------------------------------------

test('a EUR opening balance stores the transaction amount and its CHF base via the rate', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-01-01' });
  const acct = ok(addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' }));

  const res = ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1000000,
      currency: 'EUR',
      date: '2026-01-01',
      idempotencyKey: 'ob-eur',
    }),
  );
  const legs = legsOf(t.store, t.workspaceId, res.entryId);
  const bank = legs.find((l) => l.number === '1020');
  assert.equal(bank.debit, 1000000, "EUR 10'000.00 in the transaction currency");
  assert.equal(bank.baseDebit, 950000, "CHF 9'500.00 in base, converted once at 0.95 (P2)");
  // §H-LEDGER holds in BASE currency too, or the trial balance would not foot.
  const baseNet = legs.reduce((n, l) => n + l.baseDebit - l.baseCredit, 0);
  assert.equal(baseNet, 0, 'the entry balances in base currency');
});

test('the opening balance currency must match the account currency', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' }));
  const res = setBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1000,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-mismatch',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'currency_mismatch');
});

// --- §H-PERIOD ---------------------------------------------------------------------------------

test('an opening balance into a locked period is refused with period_locked and posts nothing', async () => {
  const t = setup({ realPeriods: true });
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));
  const { lockPeriod } = await import('../../dist/core/ledger/index.js');
  ok(lockPeriod(t.ctx, { period: '2026-01', kind: 'hard', reason: 'Abschluss', idempotencyKey: 'lk' }));

  const before = counts(t.store, t.workspaceId);
  const res = setBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-locked',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'period_locked');
  assert.deepEqual(counts(t.store, t.workspaceId), before);
});

// --- US-A19.5, edit and archive ----------------------------------------------------------------

test('updateBankAccount renames, and freezes the key fields once the account is referenced', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = ok(addAccount(t.ctx, t));

  // Before any reference, the key fields are still open.
  ok(updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, name: 'PostFinance Haupt' }));
  ok(updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, iban: QR_IBAN }));
  const mid = t.store.db.prepare('SELECT name, iban, is_qr_iban FROM bank_account WHERE id = ?').get(acct.bankAccountId);
  assert.equal(mid.name, 'PostFinance Haupt');
  assert.equal(mid.iban, 'CH4431999123000889012');
  assert.equal(mid.is_qr_iban, 1, 'changing the IBAN re-derives the QR flag, never leaves it stale');

  ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-1',
    }),
  );

  // Now it is referenced by a posted entry: the anchor A20/A21/A22 key off freezes.
  assert.equal(
    updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, iban: PLAIN_IBAN }).error,
    'account_in_use',
  );
  assert.equal(
    updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, ledgerAccountId: t.cashLedgerId }).error,
    'account_in_use',
  );
  assert.equal(
    updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, currency: 'EUR' }).error,
    'account_in_use',
  );
  // The name is organisational metadata and stays editable forever (§6b).
  ok(updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, name: 'Immer noch editierbar' }));
});

test('updateBankAccount and archiveBankAccount take an idempotency key and replay it (§H-IDEMPOTENT)', () => {
  const t = setup();
  const acct = ok(addAccount(t.ctx, t));

  // A rename replayed on one key must not become two audit events or two different names.
  ok(updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, name: 'Erster Name', idempotencyKey: 'up-1' }));
  ok(updateBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, name: 'Zweiter Name', idempotencyKey: 'up-1' }));
  assert.equal(
    t.store.db.prepare('SELECT name FROM bank_account WHERE id = ?').get(acct.bankAccountId).name,
    'Erster Name',
    'the replay returns the ORIGINAL result and does not apply the second payload',
  );

  const first = ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, idempotencyKey: 'ar-1' }));
  const second = ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, idempotencyKey: 'ar-1' }));
  assert.deepEqual(second, first);
  assert.equal(counts(t.store, t.workspaceId).bankAccounts, 1, 'still exactly one row, never a delete');
});

test('archiveBankAccount hides the row from pickers and never deletes it', () => {
  const t = setup();
  const acct = ok(addAccount(t.ctx, t));
  ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId }));

  assert.equal(
    counts(t.store, t.workspaceId).bankAccounts,
    1,
    '§H-AUDIT spirit: archiving is a flag, never a DELETE',
  );
  assert.deepEqual(ok(listBankAccounts(t.ctx, {})).bankAccounts, [], 'archived rows leave the picker');
  const all = ok(listBankAccounts(t.ctx, { includeArchived: true })).bankAccounts;
  assert.equal(all.length, 1);
  assert.equal(all[0].archived, true);
  // It stays referenceable by historical statements and entries.
  assert.equal(ok(getBankAccount(t.ctx, { bankAccountId: acct.bankAccountId })).bankAccount.archived, true);
});

// --- US-A19.5, unarchive (finding F12) ---------------------------------------------------------
//
// The verb that was MISSING. `archiveBankAccount` set `archived = 1` and nothing anywhere set it
// back, so retiring a Bankkonto was irreversible from every surface while A01 had shipped
// `unarchiveAccount` since Wave 0. These four tests pin the round trip, the no-op, the rejection and
// the tenant fence, which is the same set A01's suite pins for its own twin.

test('unarchiveBankAccount returns an archived Bankkonto to the picker (round trip)', () => {
  const t = setup();
  const acct = ok(addAccount(t.ctx, t));
  ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId }));
  assert.deepEqual(ok(listBankAccounts(t.ctx, {})).bankAccounts, [], 'precondition: it is out of the picker');

  const back = ok(unarchiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId }));
  assert.equal(back.archived, false, 'the verb reports the state it left the row in');

  const visible = ok(listBankAccounts(t.ctx, {})).bankAccounts;
  assert.equal(visible.length, 1, 'the account is selectable again without includeArchived');
  assert.equal(visible[0].archived, false);
  assert.equal(ok(getBankAccount(t.ctx, { bankAccountId: acct.bankAccountId })).bankAccount.archived, false);
  assert.equal(
    counts(t.store, t.workspaceId).bankAccounts,
    1,
    'the round trip is two flag flips on ONE row: archiving never deleted anything to restore',
  );
});

test('unarchiveBankAccount on a never-archived Bankkonto is a no-op ok, not a rejection', () => {
  const t = setup();
  const acct = ok(addAccount(t.ctx, t));
  // A01's twin has this exact property: putting a row in the state it is already in is success.
  const res = ok(unarchiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId }));
  assert.equal(res.archived, false);
  assert.equal(
    t.store.db.prepare('SELECT archived FROM bank_account WHERE id = ?').get(acct.bankAccountId).archived,
    0,
  );
});

test('unarchiveBankAccount replays its idempotency key and leaves ONE row (§H-IDEMPOTENT)', () => {
  // `realPeriods` wires A03's REAL ports, and the audit port is the half this test needs: the
  // permissive default is `noAudit`, so an audit-row count taken against it would be zero whatever
  // the verb did, which is an assertion that cannot fail.
  const t = setup({ realPeriods: true });
  const acct = ok(addAccount(t.ctx, t));
  ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, idempotencyKey: 'ar-1' }));

  const first = ok(unarchiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, idempotencyKey: 'un-1' }));
  // Archive again UNDER A DIFFERENT KEY, so the row is genuinely back in the archived state before
  // the replay. Without this the second unarchive would be indistinguishable from a no-op and the
  // assertion below would hold for a verb that ignored its key entirely.
  ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, idempotencyKey: 'ar-2' }));
  const second = ok(unarchiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, idempotencyKey: 'un-1' }));

  assert.deepEqual(second, first, 'a replay returns the ORIGINAL result verbatim');
  assert.equal(
    t.store.db.prepare('SELECT archived FROM bank_account WHERE id = ?').get(acct.bankAccountId).archived,
    1,
    'the replay applied NOTHING: the row is still archived, which is where the second archive left it',
  );
  assert.equal(counts(t.store, t.workspaceId).bankAccounts, 1, 'still exactly one row, never a delete');
  assert.equal(
    t.store.db
      .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND action = 'unarchive'")
      .get(t.workspaceId).n,
    1,
    'one unarchive per key, counted in audit ROWS rather than trusted from the return value',
  );
});

test('unarchiveBankAccount replays a completed key BEFORE it looks the row up', () => {
  // The ordering `createBankAccount` and `updateBankAccount` both spell out, and the one case that
  // distinguishes it from letting `rememberIdempotent` do the recall on its own: a retry that
  // carries the SAME key and a revised (here: unusable) bankAccountId must come back as the
  // caller's own original success, not as a rejection describing the revised payload. Without the
  // early recall this returns `bank_account_not_found` and the caller cannot tell its completed
  // call from a genuine miss.
  const t = setup();
  const acct = ok(addAccount(t.ctx, t));
  ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId }));
  const first = ok(unarchiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId, idempotencyKey: 'un-2' }));

  const retry = unarchiveBankAccount(t.ctx, { bankAccountId: 'bank_nope', idempotencyKey: 'un-2' });
  assert.deepEqual(retry, first, 'the key identifies the completed operation, not the payload sent with it');
});

test('unarchiveBankAccount on an unknown id is a structured rejection, not a throw', () => {
  const t = setup();
  const res = unarchiveBankAccount(t.ctx, { bankAccountId: 'bank_nope' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'bank_account_not_found');
  // The same code the whole capability uses for a missing row: an id must not be probeable by way of
  // a different answer for "not here" and "not yours".
  assert.equal(unarchiveBankAccount(t.ctx, { bankAccountId: '' }).error, 'bank_account_not_found');
});

test('§H-TENANT: the neighbour is minted FIRST and still cannot unarchive my Bankkonto', () => {
  // Deliberately ordered. A16/A07 shipped a tenant test that could not bite because each workspace
  // came from its own store and both were minted `ws_1`; here ONE store holds both, and the
  // neighbour exists BEFORE the row under test, so a neutralised `workspace_id` predicate would
  // degenerate to "the first row" and hand the neighbour the account rather than an empty answer.
  const t = setup();
  const other = secondWorkspace(t, 'Zuerst AG');
  const acct = ok(addAccount(t.ctx, t));
  ok(archiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId }));

  const stolen = unarchiveBankAccount(other.ctx, { bankAccountId: acct.bankAccountId });
  assert.equal(stolen.ok, false);
  assert.equal(stolen.error, 'bank_account_not_found');
  assert.equal(
    t.store.db.prepare('SELECT archived FROM bank_account WHERE id = ?').get(acct.bankAccountId).archived,
    1,
    'the refusal is real: the neighbour did not flip the flag on its way to being told no',
  );
  // And the owner can still do it, so the fence rejects only what it must.
  ok(unarchiveBankAccount(t.ctx, { bankAccountId: acct.bankAccountId }));
});

// --- §H-TENANT ---------------------------------------------------------------------------------

test('§H-TENANT: a neighbouring workspace can neither read, list, update nor archive the account', () => {
  const t = setup();
  const acct = ok(addAccount(t.ctx, t));
  const other = secondWorkspace(t);

  assert.equal(getBankAccount(other.ctx, { bankAccountId: acct.bankAccountId }).error, 'bank_account_not_found');
  assert.deepEqual(ok(listBankAccounts(other.ctx, { includeArchived: true })).bankAccounts, []);
  assert.equal(
    updateBankAccount(other.ctx, { bankAccountId: acct.bankAccountId, name: 'Übernommen' }).error,
    'bank_account_not_found',
  );
  assert.equal(
    archiveBankAccount(other.ctx, { bankAccountId: acct.bankAccountId }).error,
    'bank_account_not_found',
  );
  assert.equal(
    setBankOpeningBalance(other.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 100,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-cross',
    }).error,
    'bank_account_not_found',
  );
  // The neighbour's own registration of the SAME IBAN is its own business: uniqueness is per tenant.
  const mine = createBankAccount(other.ctx, {
    name: 'Gleiche IBAN, anderer Mandant',
    iban: PLAIN_IBAN,
    currency: 'CHF',
    ledgerAccountId: other.bankLedgerId,
    idempotencyKey: 'ba-other',
  });
  assert.equal(mine.ok, true, 'IBAN uniqueness is scoped to the workspace, not global');
});

test('listBankAccounts returns only this workspace, ordered, with the QR flag on each row', () => {
  const t = setup();
  ok(addAccount(t.ctx, t));
  ok(addAccount(t.ctx, t, { iban: QR_IBAN, name: 'QR Konto', idempotencyKey: 'ba-qr' }));
  const rows = ok(listBankAccounts(t.ctx, {})).bankAccounts;
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.name, r.isQrIban]),
    [
      ['PostFinance Geschäft', false],
      ['QR Konto', true],
    ],
  );
});
