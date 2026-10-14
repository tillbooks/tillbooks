// A36 §4.7 (D150), THE STATEMENT GAP READ MODEL: a hole between two day-end statements of one
// Bankkonto is a fact about the BOOK, so it survives the next fetch and a partial fill, shows for a
// hand-imported account too, names the money that stands in the missing statements, and never crosses a
// workspace. The read is pure: it adds no row and changes no statement.
//
// Every fixture is SYNTHETIC by construction (`ebics-support.mjs`): invented IBANs over the unused
// clearing number 09999, invented amounts and ids.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, camt053, container, mockBank } from './ebics-support.mjs';
import { createBankAccount, statementGaps } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { connectBankChannel, syncBankChannel, getBankChannelStatus, readStatementGaps } from '../../dist/core/banking/ebics/index.js';
import { dashboardTile } from '../../dist/core/dashboards/index.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { makeContext } from '../../dist/core/context.js';

const HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNER78', userId: 'USER0078' };

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
function account(t, n) {
  seq += 1;
  return must(
    createBankAccount(t.ctx, { name: `Konto ${n}`, iban: syntheticIban(n), ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}-${seq}` }),
    'create_bank_account',
  ).bankAccountId;
}

function imp(t, bankAccountId, xml) {
  seq += 1;
  return importCamt(t.ctx, { bankAccountId, xml, idempotencyKey: `imp-${seq}` });
}

function ctxWith(t, bank) {
  return makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port });
}

/** Run the real ceremony against the in-process bank, so the account is EBICS-fed (the successor rule holds). */
function activate(t, bank, bankAccountIds) {
  const ctx = ctxWith(t, bank);
  seq += 1;
  const c = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: bankAccountIds, confirm: true, idempotencyKey: `conn-${seq}` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch bank keys');
  must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
  return c.connectionId;
}

/** One statement day: number, date, opening, the day's movements. */
function day(iban, number, date, opening, entries = []) {
  return { xml: camt053({ iban, seq: number, date, opening, entries }), closing: opening + entries.reduce((s, e) => s + e.minor, 0) };
}

function count(t, table) {
  return t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;
}

test('the jump 182 to 187 stays a gap after 188 arrives, with the missing numbers, the days and "no money missing"', () => {
  const t = setup();
  const id = account(t, 31);
  const iban = syntheticIban(31);
  const bank = mockBank();
  activate(t, bank, [id]);
  const s182 = day(iban, 182, '2026-09-22', 100000, [{ minor: 2500 }]);
  const s187 = day(iban, 187, '2026-09-29', s182.closing, [{ minor: -700 }]);
  const s188 = day(iban, 188, '2026-09-30', s187.closing, [{ minor: 100 }]);
  must(imp(t, id, s182.xml), '182');
  const jumped = must(imp(t, id, s187.xml), '187');
  assert.ok(jumped.warnings.includes('statement_number_jump'), 'rule 2 imports the chained jump with its notice');

  const gapsAfterJump = statementGaps(t.ctx);
  assert.equal(gapsAfterJump.length, 1);
  const [g] = gapsAfterJump;
  assert.deepEqual(
    { source: g.source, after: g.after.number, before: g.before.number, missing: g.missing, dates: g.missingDates, chains: g.chains, diff: g.differenceMinor, confirmable: g.confirmable, tail: g.oldYearTailUnknown, currency: g.currency },
    { source: 'book', after: 182, before: 187, missing: [{ year: 2026, from: 183, to: 186 }], dates: { from: '2026-09-23', to: '2026-09-28' }, chains: true, diff: 0, confirmable: true, tail: false, currency: 'CHF' },
  );

  // The next ordinary fetch (188) used to make the notice vanish; the gap stays.
  must(imp(t, id, s188.xml), '188');
  const after188 = statementGaps(t.ctx);
  assert.deepEqual(after188.map((x) => [x.after.number, x.before.number]), [[182, 187]]);
  // The old jump notice is gone at that point (it is not the durable model), the gap is not.
  const status = must(getBankChannelStatus(t.ctx, {}), 'status').channels[0];
  assert.equal(status.accounts[0].lastNumberJump, null);
  assert.deepEqual(status.accounts[0].statementGaps.map((x) => x.gapId), [g.gapId]);
});

test('a partial fill keeps the lower and the upper hole, and moves the difference to the one still open', () => {
  const t = setup();
  const id = account(t, 32);
  const iban = syntheticIban(32);
  const bank = mockBank();
  activate(t, bank, [id]);
  const s182 = day(iban, 182, '2026-09-22', 50000);
  // 184 carries +500 that 185 and 186 take away again: 187 still opens on 182's close.
  const s184 = day(iban, 184, '2026-09-24', s182.closing, [{ minor: 50000 }]);
  const s187 = day(iban, 187, '2026-09-29', s182.closing);
  must(imp(t, id, s182.xml), '182');
  must(imp(t, id, s187.xml), '187');
  assert.equal(must(imp(t, id, s184.xml), '184').feed.rule, 'hole_filler');

  const gaps = statementGaps(t.ctx);
  assert.deepEqual(
    gaps.map((x) => ({ after: x.after.number, before: x.before.number, missing: x.missing, chains: x.chains, diff: x.differenceMinor, confirmable: x.confirmable })),
    [
      { after: 182, before: 184, missing: [{ year: 2026, from: 183, to: 183 }], chains: true, diff: 0, confirmable: true },
      { after: 184, before: 187, missing: [{ year: 2026, from: 185, to: 186 }], chains: false, diff: -50000, confirmable: false },
    ],
  );
  // The missing days are exact: 23.09 between 182 and 184, 25.09 to 28.09 between 184 and 187.
  assert.deepEqual(gaps.map((x) => x.missingDates), [{ from: '2026-09-23', to: '2026-09-23' }, { from: '2026-09-25', to: '2026-09-28' }]);
});

test('a hand-imported account shows its gap too, unchained with the amount, and a year turn says the old tail is unknown', () => {
  const t = setup();
  const id = account(t, 33);
  const iban = syntheticIban(33);
  // No channel: the successor rule does not apply at the hand door, so a non-chaining jump imports.
  must(imp(t, id, day(iban, 10, '2026-03-02', 1000).xml), '10');
  must(imp(t, id, day(iban, 12, '2026-03-04', 1300).xml), '12');
  const yearAcc = account(t, 34);
  const iban2 = syntheticIban(34);
  const s250 = day(iban2, 250, '2025-12-30', 7000);
  must(imp(t, yearAcc, s250.xml), '250/2025');
  must(imp(t, yearAcc, day(iban2, 3, '2026-01-06', s250.closing).xml), '3/2026');

  const gaps = statementGaps(t.ctx);
  const hand = gaps.find((g) => g.bankAccountId === id);
  assert.deepEqual([hand.missing, hand.chains, hand.differenceMinor, hand.confirmable], [[{ year: 2026, from: 11, to: 11 }], false, 300, false]);
  const turn = gaps.find((g) => g.bankAccountId === yearAcc);
  assert.deepEqual([turn.missing, turn.oldYearTailUnknown, turn.chains], [[{ year: 2026, from: 1, to: 2 }], true, true]);
  // Narrowed to one account, only that account's gap.
  assert.deepEqual(statementGaps(t.ctx, { bankAccountId: id }).map((g) => g.bankAccountId), [id]);
});

test('a downloaded statement refused as gap_refused is a pending gap with its unexplained amount, never confirmable', () => {
  const t = setup();
  const id = account(t, 35);
  const iban = syntheticIban(35);
  const bank = mockBank();
  const connectionId = activate(t, bank, [id]);
  const s3 = day(iban, 3, '2026-10-03', 20000);
  must(imp(t, id, s3.xml), '3');
  // ZKB delivers 5, which opens CHF 5.00 above 3's close: something happened on day 4.
  bank.offer(container([day(iban, 5, '2026-10-05', s3.closing + 500).xml]));
  const ctx = ctxWith(t, bank);
  const press = must(syncBankChannel(ctx, { connectionId, idempotencyKey: 'press-1' }), 'press');
  assert.deepEqual(press.statements.map((s) => s.outcome), ['gap_refused']);

  const gaps = readStatementGaps(ctx);
  assert.equal(gaps.length, 1);
  const [g] = gaps;
  assert.deepEqual(
    { source: g.source, after: g.after.number, before: g.before.number, beforeInBook: g.before.statementRowId, missing: g.missing, chains: g.chains, diff: g.differenceMinor, confirmable: g.confirmable, refused: g.refused.map((r) => [r.number, r.differenceMinor]) },
    { source: 'pending', after: 3, before: 5, beforeInBook: null, missing: [{ year: 2026, from: 4, to: 4 }], chains: false, diff: 500, confirmable: false, refused: [[5, 500]] },
  );
  assert.equal(typeof g.before.documentId, 'string');
  // The plain book read (no channel facts) sees no gap: 5 is not in the books.
  assert.deepEqual(statementGaps(ctx), []);
  // The Übersicht tile carries the same gap, in total and on its channel.
  const tile = must(dashboardTile(ctx, { tile: 'bank_inbox', from: '2026-10-05', to: '2026-10-05' }), 'tile').tile;
  assert.deepEqual(tile.statementGaps.map((x) => x.gapId), [g.gapId]);
  assert.deepEqual(tile.channels[0].statementGaps.map((x) => x.gapId), [g.gapId]);
});

test('the read is pure and fenced by workspace (§H-TENANT): another book sees none of it', () => {
  const t = setup();
  const id = account(t, 36);
  const iban = syntheticIban(36);
  must(imp(t, id, day(iban, 1, '2026-05-01', 0).xml), '1');
  must(imp(t, id, day(iban, 4, '2026-05-04', 0).xml), '4');
  const before = ['bank_statement', 'bank_txn', 'bank_statement_gap_ack'].map((x) => count(t, x));
  assert.equal(statementGaps(t.ctx).length, 1);
  assert.equal(readStatementGaps(t.ctx).length, 1);
  assert.deepEqual(['bank_statement', 'bank_txn', 'bank_statement_gap_ack'].map((x) => count(t, x)), before, 'reading writes nothing');

  const other = createWorkspace(t.deps, { name: 'Andere Synthetik AG' }).workspaceId;
  const otherCtx = makeContext(t.store, { workspaceId: other, actor: 'user_1', clock: t.clock, ids: t.ids });
  assert.deepEqual(statementGaps(otherCtx), []);
  assert.deepEqual(statementGaps(otherCtx, { bankAccountId: id }), [], 'naming a foreign account reads nothing');
});
