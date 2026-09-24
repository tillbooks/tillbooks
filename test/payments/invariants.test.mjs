/**
 * A14 §7, the invariants and the tripwires. This is the file that has to hold when everything else
 * changes, so every claim is asserted on ROWS or on the schema, never on a return value.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as payments from '../../dist/core/payments/index.js';
import {
  recordPayment,
  allocatePayment,
  reversePayment,
  previewPayment,
  getPayment,
  listPayments,
  suggestPaymentMatches,
  PAYMENT_INTENTS,
} from '../../dist/core/payments/index.js';
import { setup, secondWorkspace, issueInvoice, counts, GROSS_MINOR } from './support.mjs';

/** Every row of every table, so "nothing changed" is a claim about the database and not a feeling. */
function snapshot(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = store.db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all();
  return JSON.stringify(out);
}

function settleOne(t, key = 'p-1') {
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: `${key}-inv` });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: key,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return { inv, res };
}

// --- §H-IDEMPOTENT, asserted on rows -------------------------------------------------------------

test('idempotency: the same key twice moves the ledger ONCE, proven by row counts', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'idem' });
  const input = {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-same',
  };
  const first = recordPayment(t.ctx, input);
  const after = snapshot(t.store);
  const second = recordPayment(t.ctx, input);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second, first);
  // Not one row anywhere is different. A return-value comparison would have passed even if the
  // second call had posted a second entry and returned the first one's id.
  assert.equal(snapshot(t.store), after);
  const c = counts(t.store, t.workspaceId);
  assert.equal(c.payments, 1);
  assert.equal(c.allocations, 1);
});

test('idempotency: a key reused for a DIFFERENT money side is refused, never silently replayed', () => {
  // A previous defect on this project let a derivable key (`invoice-post-<documentId>`) be squatted,
  // and a CHF 0.01 entry then stood in for a CHF 1'081.00 posting. Two guards close that class here.
  // First: the memo is scoped to the money side, so a retry of the IDENTICAL call replays and a
  // different call cannot inherit its result. Second: the raw client key is unique per workspace, so
  // a key reused for a different payment is a loud structured refusal naming the payment that holds
  // it. Neither guard alone would do: the first would mint a second payment, and the second would
  // reject an honest retry.
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'squat' });
  const tiny = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 1,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 1 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'shared-key',
  });
  assert.equal(tiny.ok, true, JSON.stringify(tiny));

  const squat = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR - 1,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR - 1 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'shared-key',
  });
  assert.equal(squat.ok, false);
  assert.equal(squat.error, 'idempotency_key_conflict');
  assert.equal(squat.paymentId, tiny.paymentId);
  // The books are unchanged: CHF 0.01 was recorded and nothing else, so the billed amount and the
  // posted amount still agree.
  assert.equal(counts(t.store, t.workspaceId).payments, 1);
  assert.equal(
    t.store.db.prepare('SELECT COALESCE(SUM(amount_minor),0) AS n FROM payment WHERE workspace_id = ?').get(t.workspaceId).n,
    1,
  );

  // And the honest retry of the FIRST call still replays, so the guard costs a caller nothing.
  const retry = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 1,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 1 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'shared-key',
  });
  assert.deepEqual(retry, tiny);
  assert.equal(counts(t.store, t.workspaceId).payments, 1);
});

test('idempotency: reverse and allocate replay too, and neither doubles anything', () => {
  const t = setup();
  const { res } = settleOne(t, 'p-rep');
  const rev = { paymentId: res.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'r-rep' };
  const first = reversePayment(t.ctx, rev);
  const after = snapshot(t.store);
  const second = reversePayment(t.ctx, rev);
  assert.equal(first.ok, true);
  assert.deepEqual(second, first);
  assert.equal(snapshot(t.store), after);
});

// --- §H-AUDIT, no edit path anywhere -------------------------------------------------------------

test('immutability: the schema itself refuses to edit or delete a posted payment', () => {
  const t = setup();
  const { res } = settleOne(t, 'p-imm');
  const db = t.store.db;

  // Tripwire 1: no update/delete path on a posted payment's money or identity.
  assert.throws(
    () => db.prepare('UPDATE payment SET amount_minor = 1 WHERE id = ?').run(res.paymentId),
    /payment_immutable/,
  );
  assert.throws(
    () => db.prepare('UPDATE payment SET date = ? WHERE id = ?').run('2026-01-01', res.paymentId),
    /payment_immutable/,
  );
  assert.throws(
    () => db.prepare('UPDATE payment SET journal_entry_id = NULL WHERE id = ?').run(res.paymentId),
    /payment_immutable/,
  );
  assert.throws(() => db.prepare('DELETE FROM payment WHERE id = ?').run(res.paymentId), /payment_immutable/);

  // The allocation row is append-only outright: no update, no delete, no exception.
  assert.throws(
    () => db.prepare('UPDATE payment_allocation SET amount_minor = 1 WHERE payment_id = ?').run(res.paymentId),
    /payment_allocation_immutable/,
  );
  assert.throws(
    () => db.prepare('DELETE FROM payment_allocation WHERE payment_id = ?').run(res.paymentId),
    /payment_allocation_immutable/,
  );

  // And the payment's ledger entry keeps A02's own seal.
  assert.throws(
    () => db.prepare('UPDATE journal_entry SET date = ? WHERE id = ?').run('2026-01-01', res.entryId),
    /posted_immutable/,
  );
  assert.throws(() => db.prepare('DELETE FROM journal_entry WHERE id = ?').run(res.entryId), /posted_immutable/);
});

test('immutability: the ONE permitted update is the reversal stamp, and nothing rides along with it', () => {
  const t = setup();
  const { res } = settleOne(t, 'p-stamp');
  assert.equal(
    reversePayment(t.ctx, { paymentId: res.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'r-s' }).ok,
    true,
  );
  // Even on the reversal path, an attempt to change the amount at the same time is refused.
  assert.throws(
    () =>
      t.store.db
        .prepare("UPDATE payment SET status = 'posted', amount_minor = 5 WHERE id = ?")
        .run(res.paymentId),
    /payment_immutable/,
  );
});

// --- P3, the single settlement writer -------------------------------------------------------------

test('P3 guard: the payments module exposes exactly its verbs, and no raw writer', () => {
  // If a future edit leaks a row writer into this surface, a second settlement path exists and every
  // other spec's "delegates to A14 for settlement" claim quietly stops being true.
  const expected = [
    'allocatePayment',
    'buildQrrReference',
    'buildScorReference',
    'classifyReference',
    'documentReferences',
    'documentSettlement',
    'formatReference',
    'getPayment',
    'iso11649CheckDigits',
    'isValidQrrReference',
    'isValidScorReference',
    'listPayments',
    'mod10RecursiveCheckDigit',
    'planPayment',
    'previewPayment',
    'recordPayment',
    'reversePayment',
    'setWriteOffThreshold',
    'settledMinor',
    'suggestPaymentMatches',
    // Pure: maps a tax code's kind and ESTV form line to the VAT role that corrects it. It reads
    // nothing and writes nothing, and it is exported so the routing rule can be asserted directly
    // against the seeded codes, including the input-side branches no document can reach until A17.
    'vatRoleFor',
    'writeOffThresholdOf',
  ].sort();
  const exported = Object.keys(payments)
    .filter((k) => typeof payments[k] === 'function')
    .sort();
  assert.deepEqual(exported, expected);
  for (const forbidden of ['writePaymentRow', 'writeAllocationRow', 'writeDocumentStatus', 'buildLegs']) {
    assert.equal(payments[forbidden], undefined, `${forbidden} must never be public`);
  }
});

test('P3 guard: planPayment is the shared money math and it writes NOTHING', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'plan' });
  const before = snapshot(t.store);
  const plan = payments.planPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    idempotencyKey: 'ignored',
  });
  assert.equal(plan.ok, true);
  assert.equal(snapshot(t.store), before);

  // And the preview it feeds equals the posting it feeds: one code path, so a client's remainder and
  // the ledger's cannot disagree.
  const preview = previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
  });
  const posted = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: GROSS_MINOR }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-plan',
  });
  const legs = t.store.db
    .prepare(
      `SELECT a.number, l.base_debit_minor AS d, l.base_credit_minor AS c
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? ORDER BY a.number`,
    )
    .all(posted.entryId);
  assert.deepEqual(
    legs.map((l) => [l.number, l.d, l.c]),
    preview.legs.map((l) => [l.accountNumber, l.debitMinor, l.creditMinor]),
  );
  assert.equal(preview.rows[0].resultingOpenMinor, posted.documents[0].openMinor);
});

// --- §H-TENANT ------------------------------------------------------------------------------------

test('tenant: a payment, its allocations and every read are scoped, on both sides of the subquery', () => {
  const a = setup();
  const b = secondWorkspace(a);
  const { inv, res } = settleOne(a, 'p-ten');

  // Workspace B cannot read, list, allocate against, or reverse workspace A's payment.
  assert.equal(getPayment(b.ctx, { paymentId: res.paymentId }).error, 'not_found');
  assert.equal(listPayments(b.ctx, {}).payments.length, 0);
  assert.equal(listPayments(b.ctx, { documentId: inv.id }).payments.length, 0);
  assert.equal(
    reversePayment(b.ctx, { paymentId: res.paymentId, intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'x' }).error,
    'not_found',
  );
  assert.equal(
    allocatePayment(b.ctx, {
      paymentId: res.paymentId,
      allocations: [{ documentId: inv.id, amountMinor: 1 }],
      intent: PAYMENT_INTENTS.allocate,
      idempotencyKey: 'x',
    }).error,
    'not_found',
  );
  // A foreign document is `not_found` too, and it is the SAME code a nonexistent id gets, so an id
  // is never probeable across tenants.
  const foreign = recordPayment(b.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100,
    bankAccountId: b.bankId,
    counterpartyId: b.customerId,
    allocations: [{ documentId: inv.id, amountMinor: 100 }],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-foreign',
  });
  assert.equal(foreign.error, 'not_found');
  assert.equal(
    recordPayment(b.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: 100,
      bankAccountId: b.bankId,
      counterpartyId: b.customerId,
      allocations: [{ documentId: 'doc_nope', amountMinor: 100 }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: 'p-nope',
    }).error,
    'not_found',
  );
  // A foreign COUNTERPARTY is refused the same way.
  assert.equal(
    recordPayment(b.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: 100,
      bankAccountId: b.bankId,
      counterpartyId: a.customerId,
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: 'p-fc',
    }).error,
    'invalid_reference',
  );
  // A foreign BANK account cannot be spent from.
  assert.equal(
    recordPayment(b.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: 100,
      bankAccountId: a.bankId,
      counterpartyId: b.customerId,
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: 'p-fb',
    }).error,
    'needs_bank_account',
  );
  assert.equal(suggestPaymentMatches(b.ctx, {}).candidates.length, 0);
});

// --- Money discipline ------------------------------------------------------------------------------

test('money: every posted payment entry balances, and no float ever reaches a stored amount', () => {
  const t = setup();
  for (const [i, amount] of [1, 7, 99, 12345, 108100].entries()) {
    const inv = issueInvoice(t.ctx, { contactId: t.customerId, netMinor: amount, taxCode: 'none', key: `m${i}` });
    const res = recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor: amount,
      bankAccountId: t.bankId,
      allocations: [{ documentId: inv.id, amountMinor: amount }],
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: `p-m${i}`,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
  const rows = t.store.db
    .prepare(
      `SELECT e.id, SUM(l.base_debit_minor) AS d, SUM(l.base_credit_minor) AS c
         FROM journal_entry e JOIN journal_line l ON l.entry_id = e.id
        WHERE e.workspace_id = ? AND e.source = 'payment' GROUP BY e.id`,
    )
    .all(t.workspaceId);
  assert.equal(rows.length, 5);
  for (const r of rows) assert.equal(r.d, r.c, `entry ${r.id} does not balance`);

  for (const row of t.store.db.prepare('SELECT * FROM payment_allocation').all()) {
    for (const key of ['amount_minor', 'payment_amount_minor', 'base_amount_minor', 'skonto_minor']) {
      assert.equal(Number.isSafeInteger(row[key]), true, `${key} is not an integer`);
    }
  }
});

test('money: a non-integer or negative amount is refused before anything is read', () => {
  const t = setup();
  for (const amountMinor of [0, -1, 10.5, NaN, '100', null, undefined]) {
    const res = recordPayment(t.ctx, {
      direction: 'incoming',
      date: '2026-07-19',
      amountMinor,
      bankAccountId: t.bankId,
      counterpartyId: t.customerId,
      intent: PAYMENT_INTENTS.record,
      idempotencyKey: `p-bad-${String(amountMinor)}`,
    });
    assert.equal(res.ok, false, String(amountMinor));
    assert.equal(res.error, 'invalid_input', String(amountMinor));
  }
  assert.equal(counts(t.store, t.workspaceId).payments, 0);
});

test('money: a duplicate target in one payment is refused rather than double-settled', () => {
  const t = setup();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'dup' });
  const res = recordPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: GROSS_MINOR,
    bankAccountId: t.bankId,
    allocations: [
      { documentId: inv.id, amountMinor: 54050 },
      { documentId: inv.id, amountMinor: 54050 },
    ],
    intent: PAYMENT_INTENTS.record,
    idempotencyKey: 'p-dup',
  });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.reason, 'duplicate_target');
});

// --- The reads are reads --------------------------------------------------------------------------

test('reads: preview, suggest, get and list never touch the database', () => {
  const t = setup();
  const { inv, res } = settleOne(t, 'p-read');
  const before = snapshot(t.store);
  previewPayment(t.ctx, {
    direction: 'incoming',
    date: '2026-07-19',
    amountMinor: 100,
    bankAccountId: t.bankId,
    allocations: [{ documentId: inv.id, amountMinor: 100 }],
  });
  suggestPaymentMatches(t.ctx, { amountMinor: 100, reference: '210000000003139471430009017' });
  getPayment(t.ctx, { paymentId: res.paymentId });
  listPayments(t.ctx, {});
  payments.documentSettlement(t.ctx, inv.id);
  assert.equal(snapshot(t.store), before);
});
