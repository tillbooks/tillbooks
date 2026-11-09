// Critic D186 (non-author): probes against the revenue estimate's claim "it equals exactly what booking
// adds to the revenue tile". Synthetic by construction: hand-spelled camt statements, invented names.

import test from 'node:test';
import assert from 'node:assert/strict';

const { listBankInbox, bookBankLine, setBankStandard, importCamt } = await import('../../dist/core/banking/index.js');
const { dashboardOverview, dashboardRevenueEstimate } = await import('../../dist/core/dashboards/index.js');
const { createAccount } = await import('../../dist/core/accounts/accounts.js');
const { world, importLines, must, camt } = await import('../banking/bank-inbox-support.mjs');

const RANGE = { from: '2026-07-01', to: '2026-07-31' };
const PAYOUT = 'Zahlwerk Beispiel Ltd';

function payoutWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  const a = importLines(t, {
    statementId: 'CR-A',
    from: '2026-07-01',
    to: '2026-07-10',
    openingMinor: 500000,
    entries: [{ ref: 'P1', amountMinor: 3000, cd: 'CRDT', date: '2026-07-05', name: PAYOUT, ustrd: 'AUSZAHLUNG P1' }],
  });
  const recipe = [
    { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Bruttoumsatz', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } } },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
  must(setBankStandard(t.ctx, { bankTxnId: a.lines.P1, legs: recipe, viaAccountId: t.acc('1095'), label: 'Plattform', idempotencyKey: 'rule' }));
  return { t, a };
}

const revenueOf = (t) => must(dashboardOverview(t.ctx, RANGE)).tiles.find((x) => x.tile === 'revenue');

test('critic D186-1: a line flagged as a possible duplicate counts in the estimate although booking refuses it', () => {
  const { t } = payoutWorld();
  // A second statement for the SAME days carrying the same movement (a re-export under another id): the
  // dedupe flags the new line and booking refuses it until the person decides (D178 point 19).
  must(
    importCamt(t.ctx, {
      bankAccountId: t.bankAccountId,
      xml: camt({ statementId: 'CR-B', from: '2026-07-01', to: '2026-07-10', openingMinor: 500000, entries: [{ ref: 'P1B', amountMinor: 3000, cd: 'CRDT', date: '2026-07-05', name: PAYOUT, ustrd: 'AUSZAHLUNG P1' }] }),
      idempotencyKey: 'imp-crb',
    }),
  );
  const inbox = must(listBankInbox(t.ctx, { status: 'open', limit: 200 })).lines;
  console.log(JSON.stringify(inbox.map((l) => ({ id: l.bankTxnId, dup: l.needsDuplicateDecision, kind: l.proposal?.target?.kind, c: l.proposal?.certainty }))));
  const est = must(dashboardRevenueEstimate(t.ctx, RANGE));
  console.log('estimate', est.revenueMinor, est.lines.length, JSON.stringify(est.excluded));

  const before = revenueOf(t).valueRappen;
  const refusals = [];
  for (const l of inbox) {
    if (!est.lines.some((x) => x.bankTxnId === l.bankTxnId)) continue;
    const r = bookBankLine(t.ctx, { bankTxnId: l.bankTxnId, target: l.proposal.target, idempotencyKey: `b-${l.bankTxnId}` });
    if (!r.ok) refusals.push(r.error);
  }
  const gained = revenueOf(t).valueRappen - before;
  assert.deepEqual(refusals, [], `booking refused a line the estimate counted: estimate ${est.revenueMinor} (${est.lines.length} lines), booking added ${gained}`);
  assert.equal(gained, est.revenueMinor, 'the estimate equals what booking adds');
});

const { createBankAccount } = await import('../../dist/core/banking/index.js');
const { seedRate } = await import('../payments/support.mjs');
const { SAVINGS_IBAN } = await import('../banking/bank-inbox-support.mjs');

function eurWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  seedRate(t.ctx, { currency: 'EUR', rate: '0.95', asOf: '2026-07-19' });
  const eur = must(createBankAccount(t.ctx, { name: 'EUR-Konto', iban: SAVINGS_IBAN, currency: 'EUR', ledgerAccountId: t.acc('1000'), idempotencyKey: 'eur' })).bankAccountId;
  const l = importLines(t, { statementId: 'EUR-F', iban: SAVINGS_IBAN, currency: 'EUR', entries: [{ ref: 'E1', amountMinor: 3000, cd: 'CRDT', name: PAYOUT, ustrd: 'AUSZAHLUNG EUR' }] }, { bankAccountId: eur }).lines;
  return { t, l };
}

function estimateVsBooking(t, lineId) {
  const est = must(dashboardRevenueEstimate(t.ctx, RANGE));
  const line = must(listBankInbox(t.ctx, { status: 'open', limit: 200 })).lines.find((x) => x.bankTxnId === lineId);
  const before = revenueOf(t).valueRappen;
  const r = bookBankLine(t.ctx, { bankTxnId: lineId, target: line.proposal.target, idempotencyKey: `b-${lineId}` });
  const gained = revenueOf(t).valueRappen - before;
  return { est, booked: r.ok ? 'ok' : r.error, gained, proposal: line.proposal };
}

test('critic D186-6a: a taxed computed rule on a foreign-currency line (booking refuses unsupported)', () => {
  const { t, l } = eurWorld();
  const recipe = [
    { accountId: t.acc('3400'), taxCode: 'UST81', amount: { kind: 'factor', label: 'Bruttoumsatz', num: 1081, den: 180, explain: { vatBp: 810, feeBp: 990 } } },
    { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
  ];
  must(setBankStandard(t.ctx, { bankTxnId: l.E1, legs: recipe, idempotencyKey: 'eur-set' }));
  const r = estimateVsBooking(t, l.E1);
  console.log(JSON.stringify({ est: r.est.revenueMinor, excluded: r.est.excluded, booked: r.booked, gained: r.gained, c: r.proposal.certainty }));
  assert.equal(r.gained, r.est.revenueMinor);
});

test('critic D186-6b: an untaxed fixed-share rule on a foreign-currency line', () => {
  const { t, l } = eurWorld();
  must(setBankStandard(t.ctx, { bankTxnId: l.E1, accountId: t.acc('3400'), taxCode: null, idempotencyKey: 'eur-set2' }));
  const r = estimateVsBooking(t, l.E1);
  console.log(JSON.stringify({ est: r.est.revenueMinor, lines: r.est.lines, excluded: r.est.excluded, booked: r.booked, gained: r.gained, c: r.proposal.certainty, k: r.proposal.target.kind }));
  assert.equal(r.gained, r.est.revenueMinor);
});

test('critic D186-6c: a CHF debit line a rule books to revenue (a refund) counts negative, equal to booking', () => {
  const t = world();
  const a = importLines(t, { statementId: 'RF', entries: [{ ref: 'R1', amountMinor: 2000, cd: 'DBIT', name: 'Muster Kundin', ustrd: 'RÜCKERSTATTUNG' }] });
  must(setBankStandard(t.ctx, { bankTxnId: a.lines.R1, accountId: t.acc('3400'), taxCode: 'UST81', idempotencyKey: 'rf-set' }));
  const r = estimateVsBooking(t, a.lines.R1);
  console.log(JSON.stringify({ est: r.est.revenueMinor, excluded: r.est.excluded, booked: r.booked, gained: r.gained }));
  assert.equal(r.gained, r.est.revenueMinor);
});

test('critic D186-6d: a reversal line (RvslInd) a rule books', () => {
  const t = world();
  const a = importLines(t, { statementId: 'RV', entries: [{ ref: 'V1', amountMinor: 2000, cd: 'CRDT', reversal: true, name: PAYOUT, ustrd: 'STORNO' }] });
  must(setBankStandard(t.ctx, { bankTxnId: a.lines.V1, accountId: t.acc('3400'), taxCode: 'UST81', idempotencyKey: 'rv-set' }));
  const r = estimateVsBooking(t, a.lines.V1);
  console.log(JSON.stringify({ est: r.est.revenueMinor, excluded: r.est.excluded, booked: r.booked, gained: r.gained }));
  assert.equal(r.gained, r.est.revenueMinor);
});
