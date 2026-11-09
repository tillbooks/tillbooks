// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';

import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { setup, withVat } from './support.mjs';
import { at, countOf, id, row, rows as sqlRows } from '../support/narrow.mjs';

// A seeded PRNG (mulberry32) keeps these property runs reproducible: a failure replays identically.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];
const rappen = (rand) => 1 + Math.floor(rand() * 1_000_000);

test('property: every balanced entry posts and every unbalanced entry is rejected', () => {
  const rand = rng(1);
  const { ctx, accounts } = setup();
  const ids = Object.values(accounts);

  for (let i = 0; i < 300; i++) {
    const amount = rappen(rand);
    const debitAcc = pick(rand, ids);
    const creditAcc = pick(rand, ids);

    const balanced = postEntry(ctx, {
      date: '2026-03-01',
      description: 'p',
      source: 'manual',
      idempotencyKey: `b${i}`,
      lines: [
        { account: debitAcc, debit: amount },
        { account: creditAcc, credit: amount },
      ],
    });
    assert.equal(balanced.ok, true, `balanced #${i} (amount ${amount}) must post`);

    const delta = 1 + Math.floor(rand() * 1000);
    const unbalanced = postEntry(ctx, {
      date: '2026-03-01',
      description: 'p',
      source: 'manual',
      idempotencyKey: `u${i}`,
      lines: [
        { account: debitAcc, debit: amount },
        { account: creditAcc, credit: amount + delta },
      ],
    });
    assert.equal(unbalanced.ok, false, `unbalanced #${i} must reject`);
    assert.equal(unbalanced.error, 'unbalanced');
  }
});

test('property: re-posting the same key never double-counts, and the books stay balanced', () => {
  const rand = rng(2);
  const { ctx, store, accounts } = setup();
  const ids = Object.values(accounts);
  let expected = 0;

  for (let i = 0; i < 150; i++) {
    const amount = rappen(rand);
    const input = {
      date: '2026-03-01',
      description: 'p',
      source: 'manual',
      idempotencyKey: `k${i}`,
      lines: [
        { account: at(ids, 0, 'the seeded accounts'), debit: amount },
        { account: at(ids, 1, 'the seeded accounts'), credit: amount },
      ],
    };
    const first = postEntry(ctx, input);
    assert.equal(first.ok, true);
    expected++;

    const retries = Math.floor(rand() * 4);
    for (let r = 0; r < retries; r++) {
      assert.deepEqual(postEntry(ctx, input), first);
    }
  }

  assert.equal(countOf(store.db, 'SELECT COUNT(*) AS c FROM journal_entry'), expected);
  const totals = row(
    store.db.prepare('SELECT SUM(base_debit_minor) AS d, SUM(base_credit_minor) AS c FROM journal_line').get(),
    'the ledger totals',
  );
  assert.equal(totals.d, totals.c);
});

test('property: a random compound entry with cost centers and tax reverses to zero on every dimension', () => {
  const rand = rng(4);

  for (let i = 0; i < 50; i++) {
    const { ctx, store, accounts } = setup();
    const vat = withVat(store);
    store.db.prepare("INSERT INTO cost_center (id, workspace_id, code, name) VALUES ('cc_1', 'ws_1', 'C1', 'D1')").run();
    store.db.prepare("INSERT INTO cost_center (id, workspace_id, code, name) VALUES ('cc_2', 'ws_1', 'C2', 'D2')").run();
    const ids = Object.values(accounts);
    const costCenters = [null, 'cc_1', 'cc_2'];

    // The engine's half-away-from-zero rounding, so a generated tax pair reconciles under the B2 gate.
    const taxOf = (base) => Math.floor((base * 810 + 5000) / 10000);

    const lines = [];
    const pairs = 1 + Math.floor(rand() * 4);
    for (let p = 0; p < pairs; p++) {
      const amount = rappen(rand);
      const debitLine = { account: pick(rand, ids), debit: amount };
      const dcc = pick(rand, costCenters);
      if (dcc) debitLine.costCenter = dcc;
      let creditAmount = amount;
      if (rand() < 0.5) {
        // A B2-reconciled tagged booking: base tagged V81 (8.1%), its tax on 1170, gross credited.
        const tax = taxOf(amount);
        debitLine.taxCode = vat.code;
        debitLine.taxBase = amount;
        debitLine.taxAmount = tax;
        lines.push({ account: vat.vorsteuer, debit: tax });
        creditAmount = amount + tax;
      }
      const creditLine = { account: pick(rand, ids), credit: creditAmount };
      const ccc = pick(rand, costCenters);
      if (ccc) creditLine.costCenter = ccc;
      lines.push(debitLine, creditLine);
    }

    const posted = postEntry(ctx, { date: '2026-03-01', description: 'x', source: 'manual', idempotencyKey: 'p', lines });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.equal(reverseEntry(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'r' }).ok, true);

    const nets = store.db
      .prepare(
        "SELECT account_id, IFNULL(cost_center_id, '') AS cc, SUM(base_debit_minor - base_credit_minor) AS net, SUM(IFNULL(tax_base_minor, 0)) AS txb, SUM(IFNULL(tax_amount_minor, 0)) AS txa FROM journal_line GROUP BY account_id, cc",
      )
      .all();
    for (const n of sqlRows(nets, 'per-account nets')) {
      assert.equal(n.net, 0, `${n.account_id}/${n.cc} GL net`);
      assert.equal(n.txb, 0, `${n.account_id}/${n.cc} tax base net`);
      assert.equal(n.txa, 0, `${n.account_id}/${n.cc} tax amount net`);
    }
  }
});

test('property: an entry and its reversal net to zero on every account', () => {
  const rand = rng(3);

  for (let i = 0; i < 80; i++) {
    const { ctx, store, accounts } = setup();
    const ids = Object.values(accounts);
    const amount = rappen(rand);
    const debitAcc = pick(rand, ids);
    let creditAcc = pick(rand, ids);
    while (creditAcc === debitAcc) creditAcc = pick(rand, ids);

    const posted = postEntry(ctx, {
      date: '2026-03-01',
      description: 'p',
      source: 'manual',
      idempotencyKey: 'p',
      lines: [
        { account: debitAcc, debit: amount },
        { account: creditAcc, credit: amount },
      ],
    });
    assert.equal(reverseEntry(ctx, { entryId: id(posted, 'entryId', 'postEntry'), idempotencyKey: 'r' }).ok, true);

    const nets = store.db
      .prepare('SELECT account_id, SUM(base_debit_minor - base_credit_minor) AS net FROM journal_line GROUP BY account_id')
      .all();
    for (const n of sqlRows(nets, 'per-account nets')) {
      assert.equal(n.net, 0, `account ${n.account_id} must net to zero (amount ${amount})`);
    }
  }
});
