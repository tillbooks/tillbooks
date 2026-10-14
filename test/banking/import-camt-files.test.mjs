// A36 §4.7 (D150), THE HAND REPAIR'S DOOR: several camt.053 files at once. Shuffled files and a
// multi-statement file land in number order through `importCamt` (the successor rule decides, as for one
// file), a second drop of the same files imports nothing, a refusal is reported with its amount, and a
// split that would have to guess is refused. ONE ordered pass, no retry loop.
//
// Synthetic fixtures only (`ebics-support.mjs`). Money-path invariant tests are reviewed by a
// non-author (CLAUDE.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, camt053, mockBank } from './ebics-support.mjs';
import { createBankAccount, importCamtFiles, splitCamt053, statementGaps } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { parseCamt } from '../../dist/core/banking/camt.js';
import { connectBankChannel } from '../../dist/core/banking/ebics/index.js';
import { makeContext } from '../../dist/core/context.js';

const HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNER79', userId: 'USER0079' };

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

function activate(t, bankAccountIds) {
  const bank = mockBank();
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port });
  seq += 1;
  const c = must(connectBankChannel(ctx, { host: { ...HOST, partnerId: `PARTNER${70 + seq}` }, routeBankAccountIds: bankAccountIds, confirm: true, idempotencyKey: `conn-${seq}` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
}

/** One message holding several statements: the first file's envelope with every file's `<Stmt>`. */
function multi(...xmls) {
  const stmt = (x) => x.slice(x.indexOf('<Stmt>'), x.indexOf('</Stmt>') + '</Stmt>'.length);
  const first = xmls[0];
  const at = first.indexOf('</Stmt>') + '</Stmt>'.length;
  return first.slice(0, at) + xmls.slice(1).map(stmt).join('') + first.slice(at);
}

function rows(t, id) {
  return t.store.db
    .prepare('SELECT electronic_seq_nb AS nb FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ? ORDER BY CAST(electronic_seq_nb AS INTEGER)')
    .all(t.workspaceId, id)
    .map((r) => Number(r.nb));
}

function counts(t) {
  return ['bank_statement', 'bank_txn', 'journal_entry'].map((x) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${x} WHERE workspace_id = ?`).get(t.workspaceId).n);
}

/** 182 .. 187 with movements that net to zero across 183 to 186, so 187 opens on 182's close. */
function week(iban) {
  const out = {};
  let bal = 100000;
  const moves = { 182: [{ minor: 1000 }], 183: [{ minor: 2500 }], 184: [{ minor: -400 }], 185: [{ minor: -1100 }], 186: [{ minor: -1000 }], 187: [{ minor: 300 }] };
  let day = 22;
  for (const n of [182, 183, 184, 185, 186, 187]) {
    out[n] = camt053({ iban, seq: n, date: `2026-09-${String(day).padStart(2, '0')}`, opening: bal, entries: moves[n] });
    bal += moves[n].reduce((s, e) => s + e.minor, 0);
    day += 1;
  }
  return out;
}

test('shuffled files plus one multi-statement file fill the gap in number order, through the successor rule', () => {
  const t = setup();
  const id = account(t, 51);
  const iban = syntheticIban(51);
  activate(t, [id]);
  const w = week(iban);
  must(importCamt(t.ctx, { bankAccountId: id, xml: w[182], idempotencyKey: 'k182' }), '182');
  // 187 opens on 186's close, which is 183..186 netting to zero from 182's close: a chained jump.
  must(importCamt(t.ctx, { bankAccountId: id, xml: w[187], idempotencyKey: 'k187' }), '187');
  assert.equal(statementGaps(t.ctx).length, 1);

  const res = must(
    importCamtFiles(t.ctx, {
      bankAccountId: id,
      files: [
        { name: 'tag-186.xml', xml: w[186] },
        { name: 'tag-184.xml', xml: w[184] },
        { name: 'tage-183-185.xml', xml: multi(w[185], w[183]) },
      ],
      idempotencyKey: 'drop-1',
    }),
    'drop',
  );
  assert.deepEqual(res.statements.map((s) => [s.number, s.outcome]), [[183, 'imported'], [184, 'imported'], [185, 'imported'], [186, 'imported']]);
  assert.deepEqual(res.statements.map((s) => s.file), ['tage-183-185.xml', 'tag-184.xml', 'tage-183-185.xml', 'tag-186.xml']);
  assert.deepEqual([res.imported, res.alreadyImported, res.refused], [4, 0, 0]);
  assert.deepEqual(rows(t, id), [182, 183, 184, 185, 186, 187]);
  assert.deepEqual(statementGaps(t.ctx), [], 'the gap is closed');

  // Dropping the same files again (a new call key) imports nothing twice.
  const before = counts(t);
  const again = must(importCamtFiles(t.ctx, { bankAccountId: id, files: [{ name: 'tag-186.xml', xml: w[186] }, { name: 'tage-183-185.xml', xml: multi(w[185], w[183]) }], idempotencyKey: 'drop-2' }), 'again');
  assert.deepEqual(again.statements.map((s) => [s.number, s.outcome]), [[183, 'already_imported'], [185, 'already_imported'], [186, 'already_imported']]);
  assert.deepEqual(counts(t), before, 'not a row more');
  // The same call key with the same files replays the first report and writes nothing.
  const sameFiles = [
    { name: 'tag-186.xml', xml: w[186] },
    { name: 'tag-184.xml', xml: w[184] },
    { name: 'tage-183-185.xml', xml: multi(w[185], w[183]) },
  ];
  assert.deepEqual(importCamtFiles(t.ctx, { bankAccountId: id, files: sameFiles, idempotencyKey: 'drop-1' }), res);
  assert.deepEqual(counts(t), before);
});

test('a refusal is reported with its code and amount, and the statements around it still land in order', () => {
  const t = setup();
  const id = account(t, 52);
  const iban = syntheticIban(52);
  activate(t, [id]);
  const s1 = camt053({ iban, seq: 1, date: '2026-10-01', opening: 5000, entries: [{ minor: 100 }] });
  must(importCamt(t.ctx, { bankAccountId: id, xml: s1, idempotencyKey: 's1' }), '1');
  const s2 = camt053({ iban, seq: 2, date: '2026-10-02', opening: 5100 });
  // 4 opens CHF 3.00 above 2's close: 3 is missing and carries money.
  const s4 = camt053({ iban, seq: 4, date: '2026-10-04', opening: 5400 });
  const res = must(importCamtFiles(t.ctx, { bankAccountId: id, files: [{ name: 'b.xml', xml: s4 }, { name: 'a.xml', xml: s2 }], idempotencyKey: 'r-1' }), 'drop');
  assert.deepEqual(res.statements.map((s) => [s.number, s.outcome, s.code ?? null, s.differenceMinor ?? null]), [[2, 'imported', null, null], [4, 'refused', 'gap_refused', 300]]);
  assert.deepEqual(rows(t, id), [1, 2]);
});

test('a split that would have to guess is refused for that file only', () => {
  const t = setup();
  const id = account(t, 53);
  const iban = syntheticIban(53);
  const a = camt053({ iban, seq: 1, date: '2026-10-01', opening: 0 });
  const other = camt053({ iban: syntheticIban(54), seq: 2, date: '2026-10-02', opening: 0 });
  const unnumbered = camt053({ iban, seq: null, date: '2026-10-02', opening: 0 });
  const res = must(
    importCamtFiles(t.ctx, {
      bankAccountId: id,
      files: [
        { name: 'two-accounts.xml', xml: multi(a, other) },
        { name: 'no-number.xml', xml: multi(a, unnumbered) },
        { name: 'good.xml', xml: a },
      ],
      idempotencyKey: 's-1',
    }),
    'drop',
  );
  assert.deepEqual(
    res.statements.map((s) => [s.file, s.outcome, s.code ?? null, s.reason ?? null]),
    [
      ['two-accounts.xml', 'refused', 'camt_split_refused', 'iban_differs'],
      ['no-number.xml', 'refused', 'camt_split_refused', 'no_sequence_number'],
      ['good.xml', 'imported', null, null],
    ],
  );
  assert.equal(importCamtFiles(t.ctx, { bankAccountId: id, files: [], idempotencyKey: 's-2' }).error, 'invalid_input');
  assert.equal(importCamtFiles(t.ctx, { bankAccountId: 'ba_nowhere', files: [{ name: 'g', xml: a }], idempotencyKey: 's-3' }).error, 'needs_bank_account');
});

test('splitCamt053 keeps the envelope, handles a namespace prefix, and leaves a single statement alone', () => {
  const iban = syntheticIban(55);
  const a = camt053({ iban, seq: 7, date: '2026-10-07', opening: 100 });
  const b = camt053({ iban, seq: 8, date: '2026-10-08', opening: 100 });
  assert.deepEqual(must(splitCamt053(a), 'single'), { ok: true, parts: [a], split: false });
  const parts = must(splitCamt053(multi(a, b)), 'two').parts;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((p) => parseCamt(p).statement.electronicSeqNb), ['7', '8']);
  assert.ok(parts.every((p) => p.includes('<GrpHdr>')), 'each part keeps the group header');
  const prefixed = multi(a, b).replace(/<(\/?)(Document|BkToCstmrStmt|GrpHdr|MsgId|CreDtTm|Stmt)([\s>])/g, '<$1ns2:$2$3');
  assert.deepEqual(must(splitCamt053(prefixed), 'prefixed').parts.map((p) => parseCamt(p).statement.electronicSeqNb), ['7', '8']);
});
