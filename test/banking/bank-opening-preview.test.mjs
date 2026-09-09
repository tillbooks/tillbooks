// A19, `preview_bank_opening_balance`: what WOULD be posted, in base currency, without posting it.
//
// WHY THIS VERB EXISTS AT ALL, because "the GUI could multiply" is the answer it exists to refuse.
// The click this preview sits in front of is **Buchen**, and Buchen posts an immutable journal entry
// whose only correction is a reversing entry (A02). Sending an operator through an irreversible
// ledger write without having shown them its principal figure is the defect; showing them a figure
// the browser computed is the same defect wearing a number. So the figure comes back from the
// engine, and it comes back from the SAME arithmetic the posting will run.
//
// THE ONE CLAIM THIS SUITE IS FOR. Every other assertion here is scaffolding for this one: for any
// account, amount, date and rate, `previewBankOpeningBalance(...)`.baseAmountMinor equals the
// `base_debit_minor` that `setBankOpeningBalance(...)` then writes. Two implementations of one sum
// is exactly how a preview and its posting come to disagree, and a preview that can disagree with
// its posting is worse than no preview: it is a figure an operator trusted.
//
// The agreement is asserted on ROWS read back out of the ledger, never on the posting verb's return
// value, because a verb that hands back the right number while writing a different one is precisely
// the bug worth catching.
//
// A PREVIEW IS A READ, AND THAT IS ASSERTED AS A WHOLE-DATABASE SNAPSHOT, not as a row count on the
// tables this capability happens to remember. `audit_log` and `audit_head` are an append-only hash
// chain with no uniqueness constraint of any kind, so a "read" that stamped an audit row would leave
// the counts of `journal_entry`, `journal_line` and `bank_account` untouched and still be a write.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBankAccount,
  setBankOpeningBalance,
  previewBankOpeningBalance,
} from '../../dist/core/banking/index.js';

import { getAction } from '../../dist/api/registry.js';

import {
  setup,
  secondWorkspace,
  seedOpeningBalanceAccount,
  seedRate,
  legsOf,
  snapshot,
  withoutCapability,
  PLAIN_IBAN,
} from './support.mjs';

const ok = (res) => {
  assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res)}`);
  return res;
};

const refused = (res, code) => {
  assert.equal(res.ok, false, `expected a refusal, got ${JSON.stringify(res)}`);
  assert.equal(res.error, code);
  return res;
};

function addAccount(ctx, t, overrides = {}) {
  return ok(
    createBankAccount(ctx, {
      name: 'PostFinance Geschäft',
      iban: PLAIN_IBAN,
      currency: 'CHF',
      ledgerAccountId: t.bankLedgerId,
      idempotencyKey: 'ba-1',
      ...overrides,
    }),
  );
}

/** The bank leg's base amount as the LEDGER holds it, which is the only figure that counts. */
function postedBaseDebit(t, entryId) {
  const bank = legsOf(t.store, t.workspaceId, entryId).find((leg) => leg.number === '1020');
  return { debit: bank.baseDebit, credit: bank.baseCredit };
}

// --- the claim: the preview and the posting are one arithmetic ---------------------------------

test('a base-currency preview answers the amount itself and states no conversion basis', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);

  const preview = ok(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
  );
  assert.equal(preview.baseCurrency, 'CHF');
  assert.equal(preview.baseAmountMinor, 1250000);
  assert.equal(preview.posts, true);
  // A base-currency posting converted nothing, so it states no basis. Stamping a literal 1 here
  // would make an ordinary franc opening balance read as a converted one.
  assert.equal('fxRate' in preview, false);
});

test('a EUR preview converts on the stored rate, and the posting then writes the SAME Rappen', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-01-01' });
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });

  const preview = ok(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1000000,
      currency: 'EUR',
      date: '2026-01-01',
    }),
  );
  // EUR 10'000.00 at 0.95 is CHF 9'500.00. The one figure pinned by hand in this file.
  assert.equal(preview.baseAmountMinor, 950000);
  assert.equal(preview.fxRate, '0.95');
  assert.equal(preview.fxRateAsOf, '2026-01-01');

  const posted = ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1000000,
      currency: 'EUR',
      date: '2026-01-01',
      idempotencyKey: 'ob-eur',
    }),
  );
  assert.deepEqual(postedBaseDebit(t, posted.entryId), { debit: 950000, credit: 0 });
  assert.equal(postedBaseDebit(t, posted.entryId).debit, preview.baseAmountMinor);
});

test('the preview and the posting agree to the Rappen on a rate that does NOT round cleanly', () => {
  // 0.943712 against 12'345.67 is chosen because the product is not a whole Rappen: this is where a
  // second implementation drifts, and where a browser multiplying two decimals drifts hardest.
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  seedRate(t.ctx, { currency: 'EUR', rate: '0.943712', asOf: '2026-01-01' });
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });

  const shared = { bankAccountId: acct.bankAccountId, amountMinor: 1234567, currency: 'EUR', date: '2026-01-01' };
  const preview = ok(previewBankOpeningBalance(t.ctx, shared));
  const posted = ok(setBankOpeningBalance(t.ctx, { ...shared, idempotencyKey: 'ob-odd' }));

  assert.equal(postedBaseDebit(t, posted.entryId).debit, preview.baseAmountMinor);
  // And it is the engine's rounding, not the float one: a naive `Math.round(a * r)` is what this
  // verb exists so that no browser ever performs.
  assert.equal(Number.isInteger(preview.baseAmountMinor), true);
});

test('an OVERDRAFT previews as the same entry with the sides swapped, and the posting agrees', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  seedRate(t.ctx, { currency: 'EUR', rate: '0.943712', asOf: '2026-01-01' });
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });

  const shared = { bankAccountId: acct.bankAccountId, amountMinor: -1234567, currency: 'EUR', date: '2026-01-01' };
  const preview = ok(previewBankOpeningBalance(t.ctx, shared));
  const posted = ok(setBankOpeningBalance(t.ctx, { ...shared, idempotencyKey: 'ob-neg' }));

  // The SIGN travels: a negative opening balance is an overdraft, and the readout must not show a
  // positive figure for money the business owes.
  assert.ok(preview.baseAmountMinor < 0);
  assert.equal(postedBaseDebit(t, posted.entryId).credit, -preview.baseAmountMinor);
});

test('an explicit rate previews and posts identically: the GUI sends the rate it showed', () => {
  // This is the Studio's real sequence. The step prefills the rate from `get_exchange_rate`, the
  // operator may overtype it, and the preview must be priced on the rate that will actually post.
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });

  const shared = {
    bankAccountId: acct.bankAccountId,
    amountMinor: 999999,
    currency: 'EUR',
    date: '2026-01-01',
    fxRate: '0.9137',
  };
  const preview = ok(previewBankOpeningBalance(t.ctx, shared));
  assert.equal(preview.fxRate, '0.9137');
  assert.equal(preview.fxRateSource, 'explicit');

  const posted = ok(setBankOpeningBalance(t.ctx, { ...shared, idempotencyKey: 'ob-explicit' }));
  assert.equal(postedBaseDebit(t, posted.entryId).debit, preview.baseAmountMinor);
});

test('the preview names both legs, so the readout can say WHERE the money lands', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);

  const preview = ok(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 500000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
  );
  assert.deepEqual(
    preview.lines.map((line) => ({
      number: line.accountNumber,
      debit: line.debitMinor,
      credit: line.creditMinor,
      baseDebit: line.baseDebitMinor,
      baseCredit: line.baseCreditMinor,
    })),
    [
      { number: '1020', debit: 500000, credit: 0, baseDebit: 500000, baseCredit: 0 },
      { number: '9100', debit: 0, credit: 500000, baseDebit: 0, baseCredit: 500000 },
    ],
  );
});

// --- a preview is a read ------------------------------------------------------------------------

test('the preview writes NOTHING, on the happy path and on every refusing one', () => {
  const t = setup({ realPeriods: true });
  seedOpeningBalanceAccount(t.ctx);
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-01-01' });
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });

  const before = snapshot(t.store);
  previewBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1000000,
    currency: 'EUR',
    date: '2026-01-01',
  });
  previewBankOpeningBalance(t.ctx, { bankAccountId: 'bank_nope', amountMinor: 1, date: '2026-01-01' });
  previewBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1,
    currency: 'CHF',
    date: '2026-01-01',
  });
  previewBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1000000,
    currency: 'EUR',
    date: '2029-01-01',
  });
  previewBankOpeningBalance(t.ctx, { bankAccountId: acct.bankAccountId, amountMinor: 0, date: '2026-01-01' });
  // The WHOLE database, audit tables included: a stamped audit row is a write however small.
  assert.equal(snapshot(t.store), before, 'a preview changed the database');
});

test('the preview takes no idempotency key, because there is nothing to replay', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);
  const input = {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
  };
  // Called twice, it answers the same thing twice and burns no key: a key on a read is a promise
  // about a write that never happens.
  assert.deepEqual(previewBankOpeningBalance(t.ctx, input), previewBankOpeningBalance(t.ctx, input));
});

// --- the refusals, which are the posting's own -------------------------------------------------

test('a MISSING 9100 previews as needs_account, the same refusal the posting gives', () => {
  const t = setup();
  const acct = addAccount(t.ctx, t);
  const preview = refused(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
    'needs_account',
  );
  assert.equal(preview.role, 'openingBalance');
  assert.equal(preview.number, '9100');
  assert.equal(preview.reason, 'missing');

  const posted = setBankOpeningBalance(t.ctx, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 1250000,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'ob-missing',
  });
  // Same code, same reason: a preview that came back clean and then met a refusal would be worse
  // than no preview at all.
  assert.equal(posted.error, preview.error);
  assert.equal(posted.reason, preview.reason);
});

test('an ARCHIVED 9100 previews as needs_account with reason archived, a different recovery', async () => {
  const t = setup();
  const openingAccountId = seedOpeningBalanceAccount(t.ctx);
  const { archiveAccount } = await import('../../dist/core/accounts/index.js');
  ok(archiveAccount(t.ctx, { accountId: openingAccountId }));
  const acct = addAccount(t.ctx, t);

  const preview = refused(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
    'needs_account',
  );
  assert.equal(preview.reason, 'archived');
});

test('a second opening balance previews as opening_balance_already_set, before the click', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);
  ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'ob-1',
    }),
  );
  refused(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 500000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
    'opening_balance_already_set',
  );
});

test('a locked period previews as period_locked: the refusal arrives BEFORE the irreversible click', async () => {
  const t = setup({ realPeriods: true });
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);
  const { lockPeriod } = await import('../../dist/core/ledger/index.js');
  ok(lockPeriod(t.ctx, { period: '2026-01', kind: 'hard', reason: 'Abschluss', idempotencyKey: 'lk' }));

  // It reads the SAME `ctx.periods.assertOpen` the posting reads, so the two cannot disagree about
  // which dates are open.
  const preview = refused(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
    'period_locked',
  );
  assert.equal(preview.period, '2026-01');
});

test('when a locked period AND a missing rate are both true, both faces name the SAME one', async () => {
  // The set of refusals agreeing is not enough: the ORDER is part of the agreement. A preview that
  // said `period_locked` while the posting would say `needs_fx_rate` sends the operator to fix the
  // wrong thing first, comes back, and meets the other one. `postEntry` converts before it checks
  // the period, so the preview does too.
  const t = setup({ realPeriods: true });
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });
  const { lockPeriod } = await import('../../dist/core/ledger/index.js');
  ok(lockPeriod(t.ctx, { period: '2026-01', kind: 'hard', reason: 'Abschluss', idempotencyKey: 'lk' }));

  const shared = { bankAccountId: acct.bankAccountId, amountMinor: 1000000, currency: 'EUR', date: '2026-01-01' };
  const preview = previewBankOpeningBalance(t.ctx, shared);
  const posted = setBankOpeningBalance(t.ctx, { ...shared, idempotencyKey: 'ob-both' });

  assert.equal(preview.ok, false);
  assert.equal(posted.ok, false);
  assert.equal(preview.error, posted.error, 'the two faces must name the same refusal first');
  assert.equal(preview.error, 'needs_fx_rate');
});

test('a missing rate previews as needs_fx_rate, naming the currency and the date', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });
  const preview = refused(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1000000,
      currency: 'EUR',
      date: '2026-01-01',
    }),
    'needs_fx_rate',
  );
  assert.equal(preview.currency, 'EUR');
  assert.equal(preview.date, '2026-01-01');
});

test('the currency must match the account, and an unreadable amount is refused as invalid_input', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t, { currency: 'EUR', name: 'EUR Konto' });
  refused(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
    'currency_mismatch',
  );
  const bad = refused(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 12.5,
      currency: 'EUR',
      date: '2026-01-01',
    }),
    'invalid_input',
  );
  assert.equal(bad.field, 'amountMinor');
});

test('a zero opening balance previews as posting NOTHING, with no lines and no rate', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);
  const preview = ok(
    previewBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 0,
      currency: 'CHF',
      date: '2026-01-01',
    }),
  );
  assert.equal(preview.posts, false);
  assert.equal(preview.baseAmountMinor, 0);
  assert.deepEqual(preview.lines, []);
});

// --- the AGENT-FACING description, measured rather than proofread -------------------------------
//
// A tool description is the only thing an agent has to pick a verb with, and it has no human filter
// in front of it. This one enumerated the refusals it shares with the posting and then promised
// that "a clean preview is not followed by a surprise", which is false in the one case that is not
// a race: `permission_denied`, which the preview by design never answers. The engine's own docstring
// said so plainly, so the two documents describing one verb disagreed and an agent read the wrong
// one. That is the A07 `reconciled: true` and A08 family.
//
// Most of a prose claim cannot be tested. THIS part can, because it is a claim about a SET: which
// refusals the two verbs can each produce. So the asymmetry is measured on the real engine, and the
// description is required to match the measurement in BOTH directions. If A24 later gates reads and
// the preview starts refusing `permission_denied` too, the second branch fails and the description
// has to drop the exception rather than keeping a caveat that is no longer true.

/**
 * The verb's agent-facing description, off the registry itself.
 *
 * It is `summary` on `ActionDef`, and reading `.description` gives `undefined`: a `doesNotMatch`
 * against `undefined ?? ''` passes over EVERY description ever written, which is how a guard against
 * an overclaim becomes a guard against nothing. So the string is asserted non-empty here, once, and
 * both tests below read it through this function.
 */
function registryDescription() {
  const action = getAction('preview_bank_opening_balance');
  assert.notEqual(action, undefined, 'preview_bank_opening_balance is not in the registry');
  assert.equal(typeof action.summary, 'string');
  assert.ok(action.summary.length > 100, 'the description read back empty or near-empty');
  return action.summary;
}

/**
 * THE GUARD IS DRIVEN AT THE BOUNDARY, because the first version of it was not and that is exactly
 * how the replacement overclaim got through.
 *
 * The previous round removed a false sentence about shared refusals and wrote a new one asserting
 * `permission_denied` at the posting, then measured it at a single comfortable input
 * (`amountMinor: 1250000`). At `amountMinor: 0` the posting took a branch that never reached
 * `postEntry`, answered `ok`, and MUTATED `bank_account`: the claim was false at precisely the input
 * the test did not drive. So the amounts below are a list, and zero is in it, because zero is a
 * different code path in both verbs rather than a smaller version of the same one.
 */
const CAPABILITY_AMOUNTS = [
  { label: 'zero, which books no entry and takes its own branch in both verbs', amountMinor: 0 },
  { label: 'a real figure, which posts', amountMinor: 1250000 },
  { label: 'an overdraft, which posts the other way round', amountMinor: -50000 },
];

test('the description tells the truth about the ONE refusal the preview cannot answer, at EVERY amount', () => {
  const description = registryDescription();

  for (const { label, amountMinor } of CAPABILITY_AMOUNTS) {
    const t = setup();
    seedOpeningBalanceAccount(t.ctx);
    const acct = addAccount(t.ctx, t);
    const denied = withoutCapability(t, 'post');

    const input = { bankAccountId: acct.bankAccountId, amountMinor, currency: 'CHF', date: '2026-01-01' };
    const previewed = previewBankOpeningBalance(denied, { ...input });
    const posted = setBankOpeningBalance(denied, { ...input, idempotencyKey: `denied-${amountMinor}` });

    const previewRefuses = previewed.ok === false && previewed.error === 'permission_denied';

    if (previewRefuses) {
      // A24 has come and gated reads. The description's CLAIM, not one token of it, is what has to
      // go: "it checks no capability" is now false, and a correct description of a gated preview
      // might very well still mention permission_denied. Asserting on the token in this direction
      // would force a true sentence out, which is the mirror image of the defect being guarded.
      assert.doesNotMatch(
        description,
        /checks no capability/i,
        `the preview now refuses permission_denied at ${label}, so the description must stop saying it checks none`,
      );
      continue;
    }

    // The asymmetry is real at this amount, so the description must NAME it. An enumeration of
    // shared refusals that quietly omits the unshared one is the overclaim, whatever the prose says.
    assert.equal(previewed.ok, true, `the preview refused at ${label}, so this measurement is not the asymmetry`);
    assert.equal(posted.ok, false, `the posting answered ok at ${label} to a caller A24 denied post`);
    assert.equal(
      posted.error,
      'permission_denied',
      `the posting refused ${posted.error} rather than permission_denied at ${label}`,
    );
    assert.match(
      description,
      /permission_denied/,
      `the preview answers a caller who cannot post at ${label}, so the description must say a permission_denied still arrives at the posting`,
    );
    // The row, because a refusal returned after a write is the defect wearing the fix's clothes.
    const row = t.store.db
      .prepare('SELECT opening_balance_minor AS m, opening_balance_date AS d FROM bank_account WHERE workspace_id = ? AND id = ?')
      .get(t.workspaceId, acct.bankAccountId);
    assert.deepEqual(row, { m: null, d: null }, `the refused call at ${label} still wrote to bank_account`);
  }

  // The description hedges the refusal with "not always the FIRST one", and the hedge has to be
  // earned rather than decorative: above zero a missing 9100 really does answer before the
  // capability, and at zero it cannot, because the zero branch never resolves 9100 at all.
  const bare = setup();
  const bareAcct = addAccount(bare.ctx, bare); // 9100 deliberately NOT seeded
  const bareDenied = withoutCapability(bare, 'post');
  const shared = { bankAccountId: bareAcct.bankAccountId, currency: 'CHF', date: '2026-01-01' };
  assert.equal(
    setBankOpeningBalance(bareDenied, { ...shared, amountMinor: 1250000, idempotencyKey: 'bare-nonzero' }).error,
    'needs_account',
  );
  assert.equal(
    setBankOpeningBalance(bareDenied, { ...shared, amountMinor: 0, idempotencyKey: 'bare-zero' }).error,
    'permission_denied',
  );
  assert.match(description, /above zero only/i, 'the description states the precedence it was measured to have');
});

// --- the boundary the guard above used to be blind to ------------------------------------------
//
// A19's zero path writes `opening_balance_minor` and `opening_balance_date` and books no entry, so it
// never reaches `postEntry`, which is the ONLY place the `post` capability was asserted. A caller A24
// deliberately did not trust with posting could therefore write into `bank_account` and get `ok`.
//
// The concrete failure is not hypothetical: an agent with a read-and-reconcile grant calls
// `set_bank_opening_balance` with `amountMinor: 0` to "confirm the account opens at zero", it
// succeeds, `openingAlreadySet` is now true, and the REAL opening balance can no longer be recorded
// without a correction. A capability bypass on a write, in a repo whose conformance gate exists to
// stop exactly this shape.
//
// The PERIOD half of the same bypass is deliberately left open and is A03's: whether writing a dated
// field into a sealed period is a lock violation when no journal entry exists at all is a policy call
// about what a lock covers, and A19 is not the capability that gets to make it. The CAPABILITY half
// is not an A03 question and is fixed here.

test('a caller without the post capability cannot write the zero opening balance either', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);
  const denied = withoutCapability(t, 'post');

  const before = t.store.db
    .prepare('SELECT opening_balance_minor AS m, opening_balance_date AS d FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, acct.bankAccountId);

  const res = setBankOpeningBalance(denied, {
    bankAccountId: acct.bankAccountId,
    amountMinor: 0,
    currency: 'CHF',
    date: '2026-01-01',
    idempotencyKey: 'denied-zero',
  });

  refused(res, 'permission_denied');
  assert.equal(res.capability, 'post', 'the refusal names the capability, as every other one does');
  // On the ROW, because a refusal that returns cleanly after mutating is the defect itself.
  const after = t.store.db
    .prepare('SELECT opening_balance_minor AS m, opening_balance_date AS d FROM bank_account WHERE workspace_id = ? AND id = ?')
    .get(t.workspaceId, acct.bankAccountId);
  assert.deepEqual(after, before, 'the refused zero call wrote nothing at all');

  // And the workspace is not left half-confirmed: a capable actor can still record the real figure.
  const allowed = ok(
    setBankOpeningBalance(t.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'allowed-after-denied-zero',
    }),
  );
  assert.equal(allowed.posted, true);
});

test('the description does not carry the two sentences that promised no surprise', () => {
  // Even setting `permission_denied` aside, the preview holds no state and the world moves: a period
  // that locks, a 9100 archived, another actor posting first. Each was measured as a clean preview
  // followed by a refusal, so a blanket promise of no surprise is wrong in four ways.
  //
  // WHAT THIS TEST DOES AND DOES NOT CATCH, stated plainly because the claim made for it was wrong.
  // The commit that added it said the sentence "cannot come back by paraphrase". It can, and the
  // second critic did it with the whole suite green, using "exactly the same set of refusals ...
  // including permission_denied, so a clean preview GUARANTEES the posting will succeed". Both
  // patterns below miss that: the words of the first are not adjacent, and the second says the same
  // false thing in different words.
  //
  // So: this is a KEYWORD CHECK ON TWO SENTENCES, and that is all it is. It stops the two exact
  // formulations that shipped, and it forces a revisit when either is edited. It cannot decide
  // whether a rewritten description is true, and no assertion over prose could. The claim above it
  // is withdrawn rather than the guard removed, because a modest guard is worth having and a guard
  // whose stated reach exceeds its actual reach is worse than none: it invites the next author to
  // stop reading. The assertion that carries real weight is the measured one above, which drives the
  // engine at three amounts and compares the answer to the string.
  const description = registryDescription();
  assert.doesNotMatch(description, /not followed by a surprise/i);
  assert.doesNotMatch(description, /identical refusals/i);
});

// --- §H-TENANT ----------------------------------------------------------------------------------

test('§H-TENANT: a neighbour workspace cannot preview this workspace ledger position', () => {
  const t = setup();
  seedOpeningBalanceAccount(t.ctx);
  const acct = addAccount(t.ctx, t);
  const neighbour = secondWorkspace(t);

  // Same database, a different tenant: the row must be invisible, not merely refused later.
  refused(
    previewBankOpeningBalance(neighbour.ctx, {
      bankAccountId: acct.bankAccountId,
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
    }),
    'bank_account_not_found',
  );
});
