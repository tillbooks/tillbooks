// A39 L7, the import door where the go-live bridge hits it (spec §0 L7, §8): a collective booking whose
// details share one AcctSvcrRef keeps every payment apart (asr:<ref>#<n>, the first unchanged), a batch in
// another currency or with details that do not sum is ONE line of the booking amount, a statement without
// repeats keeps its content hash, a camt.054 is refused at every door (import_camt and the EBICS channel)
// and writes no row, and a camt.053 that is not a day-end statement imports with a warning.
//
// SYNTHETIC DATA ONLY: fixtures/camt053-batch-shared-ref.xml, fixtures/camt053-batch-mixed-currency.xml,
// the existing synthetic zkb-shape fixtures, and statements spelled in this file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseCamt, importCamt } from '../../dist/core/banking/index.js';
import { hashCamtStatement } from '../../dist/core/banking/camt.js';
import { connectBankChannel, syncBankChannel } from '../../dist/core/banking/ebics/index.js';
import { makeContext } from '../../dist/core/context.js';
import { world, camt, must, refused, MAIN_IBAN } from './bank-inbox-support.mjs';
import { mockBank, container } from './ebics-support.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const read = (name) => readFileSync(join(FIXTURES, name), 'utf8');
const count = (t, table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;
const keysOf = (t) => t.store.db.prepare('SELECT entry_key AS k, amount_minor AS a FROM bank_txn WHERE workspace_id = ? ORDER BY rowid').all(t.workspaceId);

test('L7 (a): details sharing one AcctSvcrRef key asr:R, asr:R#1, asr:R#2; R, S, R keys the third asr:R#1', () => {
  const parsed = must(parseCamt(read('camt053-batch-shared-ref.xml')));
  assert.deepEqual(parsed.statement.entries.map((e) => e.entryKey), [
    'asr:COLL-R',
    'asr:COLL-R#1',
    'asr:COLL-R#2',
    'asr:RS-R',
    'asr:RS-S',
    'asr:RS-R#1',
    'asr:COLL-R',
  ], 'the single booking 3 keeps its own reference, which booking 1 already used');
});

test('L7 (a): the import books every payment of the collective debit; the ref from another booking stays duplicate_entry; a re-import adds nothing', () => {
  const t = world();
  const res = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: read('camt053-batch-shared-ref.xml'), idempotencyKey: 'sr' }));
  assert.equal(res.txnCount, 6);
  assert.deepEqual(res.skipped.map((s) => s.reason), ['duplicate_entry'], 'booking 3 only');
  assert.deepEqual(res.warnings, []);
  const rows = keysOf(t);
  assert.equal(rows.filter((r) => r.k.startsWith('asr:COLL-R')).reduce((s, r) => s + r.a, 0), 90000, 'the collective debit is on the books to the Rappen');
  assert.equal(rows.filter((r) => r.k.startsWith('asr:RS-')).reduce((s, r) => s + r.a, 0), 60000);
  // A ref stored from another FILE stays a duplicate too.
  const other = camt({ statementId: 'OTHER-FILE', seqNb: '2', from: '2026-10-01', to: '2026-10-01', entries: [{ ref: 'X', amountMinor: 20000, cd: 'DBIT', date: '2026-10-01' }] })
    .replace('<NtryRef>X</NtryRef>', '<NtryRef>X</NtryRef><AcctSvcrRef>RS-S</AcctSvcrRef>');
  const second = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: other, idempotencyKey: 'other' }));
  assert.equal(second.txnCount, 0);
  assert.deepEqual(second.skipped.map((s) => s.reason), ['duplicate_entry']);
  const before = count(t, 'bank_txn');
  const again = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: read('camt053-batch-shared-ref.xml'), idempotencyKey: 'sr-again' }));
  assert.equal(again.duplicate, true);
  assert.equal(count(t, 'bank_txn'), before, 're-import adds zero rows');
});

test('L7 (b): EUR details under a CHF booking are ONE CHF line of the booking amount; the other entries import', () => {
  const parsed = must(parseCamt(read('camt053-batch-mixed-currency.xml')));
  assert.deepEqual(
    parsed.statement.entries.map((e) => [e.entryKey, e.amountMinor, e.currency, e.batchPmtInfId]),
    [
      ['asr:MIX-1', 95000, 'CHF', 'PRUN-EUR'],
      ['asr:MIX-2', 12000, 'CHF', null],
      ['asr:MIX-3-A', 10000, 'CHF', null],
      ['asr:MIX-3-B', 20000, 'CHF', null],
    ],
  );
  const t = world();
  const res = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: read('camt053-batch-mixed-currency.xml'), idempotencyKey: 'mx' }));
  assert.equal(res.txnCount, 4, 'not a refused file');
  assert.deepEqual(keysOf(t).map((r) => [r.k, r.a]), [['asr:MIX-1', 95000], ['asr:MIX-2', 12000], ['asr:MIX-3-A', 10000], ['asr:MIX-3-B', 20000]]);
});

test('L7: a statement without repeated refs keeps its content hash (a pre-fix import still re-imports as a duplicate)', () => {
  // Pinned from the develop parser before A39 L7 (measured equal for every zkb-shape fixture): the key and
  // the hashed fields of an unrepeated statement did not move.
  const pinned = {
    'zkb-shape-camt053-01.xml': 'h1:camt053|2025-11-04|2025-11-04|964235|976082|CHF|asr:TESTREF0100000001:11847:CHF:CRDT:2025-11-04:2025-11-04:0:none::Testpartner AG:',
    'zkb-shape-camt053-02.xml': 'h1:camt053|2026-01-13|2026-01-13|1021493|1012838|CHF|asr:TESTREF0200000001:8655:CHF:DBIT:2026-01-13:2026-01-13:0:qrr:210000000003139471430009017:Testpartner AG:',
  };
  for (const [file, hash] of Object.entries(pinned)) {
    assert.equal(hashCamtStatement(must(parseCamt(read(file))).statement), hash, file);
  }
});

test('L7 (c): a camt.054 is refused camt054_refused through import_camt and writes no row', () => {
  const t = world();
  const res = refused(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'N-1', entries: [{ ref: 'A', amountMinor: 100, cd: 'CRDT' }] }).replace(/BkToCstmrStmt/g, 'BkToCstmrDbtCdtNtfctn').replace(/<(\/?)Stmt>/g, '<$1Ntfctn>'), idempotencyKey: 'n' }), 'camt054_refused');
  assert.match(res.reason, /camt\.053/);
  for (const table of ['bank_statement', 'bank_txn', 'bank_txn_detail', 'reconciliation_match']) assert.equal(count(t, table), 0, table);
});

test('L7 (c): a camt.054 fetched over the EBICS channel is refused the same way, persisted as a file and imported nowhere', () => {
  const t = world();
  const host = { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER01', userId: 'USER0001' };
  const notification = camt({ statementId: 'N-EBICS', entries: [{ ref: 'A', amountMinor: 100, cd: 'CRDT' }] })
    .replace(/BkToCstmrStmt/g, 'BkToCstmrDbtCdtNtfctn')
    .replace(/<(\/?)Stmt>/g, '<$1Ntfctn>');
  // A36 (contract 2): the in-process bank of `ebics-support.mjs`. The channel requests camt.053 only;
  // a camt.054 a bank delivered anyway is persisted as a file and refused by `importCamt` (D140).
  const bank = mockBank();
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port });
  const c1 = must(connectBankChannel(ctx, { host, routeBankAccountIds: [t.bankAccountId], confirm: true, idempotencyKey: 'c1' }));
  const fetched = must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirm: true }));
  must(connectBankChannel(ctx, { connectionId: c1.connectionId, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes, confirm: true }));
  bank.offer(container([notification]));
  const synced = must(syncBankChannel(ctx, { connectionId: c1.connectionId, idempotencyKey: 's1' }));
  const row = synced.statements[0];
  assert.ok(row !== undefined, JSON.stringify(synced));
  assert.equal(row.outcome, 'camt054_refused');
  assert.equal(row.final, false, 'a refusal that is not one of the three final outcomes is re-run at each sync');
  assert.ok(typeof row.documentId === 'string', 'the member is kept as a file');
  for (const table of ['bank_statement', 'bank_txn']) assert.equal(count(t, table), 0, table);
});

test('L7 (c): a camt.053 without ElctrncSeqNb or without CLBD imports with the warning not_day_end_statement', () => {
  const t = world();
  const noSeq = camt({ statementId: 'ADHOC-1', entries: [{ ref: 'A', amountMinor: 100, cd: 'DBIT' }] }).replace(/<ElctrncSeqNb>[^<]*<\/ElctrncSeqNb>/, '');
  const a = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: noSeq, idempotencyKey: 'a' }));
  assert.deepEqual(a.warnings, ['not_day_end_statement']);
  assert.equal(a.txnCount, 1, 'it imports: the warning says to import the day-end statement too');
  const noClbd = camt({ statementId: 'ADHOC-2', seqNb: '9', entries: [{ ref: 'B', amountMinor: 200, cd: 'DBIT' }] }).replace(/<Bal><Tp><CdOrPrtry><Cd>CLBD<\/Cd>.*?<\/Bal>/, '');
  const b = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: noClbd, idempotencyKey: 'b' }));
  assert.deepEqual(b.warnings, ['not_day_end_statement']);
  const day = must(importCamt(t.ctx, { bankAccountId: t.bankAccountId, xml: camt({ statementId: 'DAY-1', seqNb: '10', entries: [{ ref: 'C', amountMinor: 300, cd: 'DBIT' }] }), idempotencyKey: 'c' }));
  assert.deepEqual(day.warnings, [], 'a day-end statement carries no warning');
  assert.equal(MAIN_IBAN.length, 21);
});
