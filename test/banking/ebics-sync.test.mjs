// A36 §4.3, ONE SYNC (spec §8 row 2): persist, then process, then receipt. A re-offered container adds no
// member; a crash after the download, after the persist, after the processing and before the receipt each
// ends with EXACTLY ONE statement; the bank sees no receipt before the commit and a negative one after a
// failed commit; an outcome row is appended only when the outcome changes; and the durable TransactionID
// replay refusal the wire asks of the core (wire A36-7, W11).
//
// A crash is simulated the way the process would meet one: a SQLite trigger that aborts the write the
// crash would have stopped before (the exception leaves `bank_sync` exactly where a dying process would),
// or a port that throws after the bank already acted. The bank keeps offering what it has no positive
// receipt for, so the NEXT press is the recovery under test. All fixtures synthetic (`ebics-support.mjs`).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { setup } from './support.mjs';
import { syntheticIban, chain, camt053, container, mockBank, bankCode, sha256Hex } from './ebics-support.mjs';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { connectBankChannel, syncBankChannel, getBankChannelStatus } from '../../dist/core/banking/ebics/index.js';
import { makeContext } from '../../dist/core/context.js';

const HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNER55', userId: 'USER0055' };

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

let seq = 0;
function world(n, { bridged = 1, days = 3 } = {}) {
  const t = setup();
  const bank = mockBank();
  const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ebicsTransport: bank.port });
  const iban = syntheticIban(n);
  const accountId = must(createBankAccount(t.ctx, { name: `Konto ${n}`, iban, ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}` }), 'account').bankAccountId;
  const statements = chain({ iban, firstSeq: 1, firstDate: '2026-10-01', opening: 50000, days: Array.from({ length: days }, (_, k) => [{ minor: 100 * (k + 1) }]) });
  for (const s of statements.slice(0, bridged)) must(importCamt(t.ctx, { bankAccountId: accountId, xml: s.xml, idempotencyKey: `bridge-${s.seq}` }), 'bridge');
  seq += 1;
  const c = must(connectBankChannel(ctx, { host: HOST, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: `c-${seq}` }), 'connect');
  const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch');
  must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'confirm');
  return { t, bank, ctx, accountId, statements, connectionId: c.connectionId };
}

const press = (w, key) => syncBankChannel(w.ctx, { connectionId: w.connectionId, idempotencyKey: key ?? `press-${(seq += 1)}` });
const n = (w, sql, ...p) => w.t.store.db.prepare(sql).get(...p).n;
const statementsOf = (w) => n(w, 'SELECT COUNT(*) AS n FROM bank_statement WHERE workspace_id = ? AND bank_account_id = ?', w.t.workspaceId, w.accountId);
const linesOf = (w) => n(w, 'SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ?', w.t.workspaceId, w.accountId);
const memberRows = (w) => n(w, "SELECT COUNT(*) AS n FROM ebics_order_log WHERE workspace_id = ? AND related_kind = 'ebics_member'", w.t.workspaceId);
const outcomeRows = (w) => n(w, "SELECT COUNT(*) AS n FROM ebics_order_log WHERE workspace_id = ? AND related_kind = 'member_outcome'", w.t.workspaceId);
const files = (w) => n(w, 'SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?', w.t.workspaceId);
const logRows = (w) => n(w, 'SELECT COUNT(*) AS n FROM ebics_order_log WHERE workspace_id = ?', w.t.workspaceId);

function crashOn(w, name, table, when = '1') {
  w.t.store.db.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'simulated crash'); END`);
}
function heal(w, name) {
  w.t.store.db.exec(`DROP TRIGGER ${name}`);
}

test('a re-offered container with other bytes adds no member: members dedupe by payload hash', () => {
  const w = world(1, { bridged: 1, days: 2 });
  const s2 = w.statements[1];
  w.bank.offer(container([s2.xml], { stamp: '20261002' }));
  const first = must(press(w), 'press 1');
  assert.equal(first.download.newMembers, 1);
  assert.equal(statementsOf(w), 2);
  // ZKB names members by pickup date: the same statement again, in a container whose bytes differ.
  w.bank.offer(container([s2.xml], { stamp: '20261003', deflate: false }));
  const second = must(press(w), 'press 2');
  assert.deepEqual([second.download.members, second.download.newMembers], [1, 0]);
  assert.deepEqual(second.statements, [], 'the member is final: nothing to process');
  assert.deepEqual([statementsOf(w), memberRows(w)], [2, 1]);
  assert.deepEqual(w.bank.receipts.map((r) => r.receiptCode), [0, 0], 'each transaction is receipted');
});

test('crash AFTER THE DOWNLOAD (the bank delivered, the process died): the next press ends with exactly one statement', () => {
  const w = world(2);
  w.bank.offer(container([w.statements[1].xml]));
  w.bank.nextDownload('throw-after-deliver');
  const crashed = press(w);
  assert.equal(crashed.ok, false);
  assert.equal(crashed.error, 'channel_unreachable');
  assert.deepEqual([memberRows(w), statementsOf(w), w.bank.receipts.length], [0, 1, 0], 'nothing persisted, no receipt');
  must(press(w), 'recovery');
  assert.deepEqual([statementsOf(w), memberRows(w), linesOf(w)], [2, 1, 2]);
});

test('crash AFTER THE PERSIST (before processing): the persisted bytes import at the next press, exactly once', () => {
  const w = world(3);
  w.bank.offer(container([w.statements[1].xml]));
  crashOn(w, 'crash_import', 'bank_statement');
  assert.throws(() => press(w), /simulated crash/);
  assert.deepEqual([memberRows(w), outcomeRows(w), statementsOf(w), w.bank.receipts.length], [1, 0, 1, 0], 'persisted, not processed, no receipt');
  heal(w, 'crash_import');
  const recovered = must(press(w), 'recovery');
  assert.equal(recovered.download.newMembers, 0, 'the re-offered member is already persisted');
  assert.deepEqual(recovered.statements.map((s) => s.outcome), ['imported']);
  assert.deepEqual([statementsOf(w), memberRows(w), linesOf(w)], [2, 1, 2]);
  assert.deepEqual(w.bank.receipts.map((r) => r.receiptCode), [0]);
});

test('crash AFTER THE PROCESSING (imported, outcome not yet written): the fixed key replays, exactly one statement', () => {
  const w = world(4);
  w.bank.offer(container([w.statements[1].xml]));
  crashOn(w, 'crash_outcome', 'ebics_order_log', "NEW.related_kind = 'member_outcome'");
  assert.throws(() => press(w), /simulated crash/);
  assert.deepEqual([memberRows(w), outcomeRows(w), statementsOf(w), w.bank.receipts.length], [1, 0, 2, 0], 'imported, no outcome row, no receipt');
  heal(w, 'crash_outcome');
  const recovered = must(press(w), 'recovery');
  assert.deepEqual(recovered.statements.map((s) => s.outcome), ['imported'], 'the fixed key replays the memoised import');
  assert.deepEqual([statementsOf(w), linesOf(w), outcomeRows(w)], [2, 2, 1]);
});

test('crash BEFORE THE RECEIPT (the receipt never reached the bank): the re-offer is a no-op, exactly one statement', () => {
  const w = world(5);
  w.bank.offer(container([w.statements[1].xml]));
  w.bank.state.throwOnAck = true;
  const first = must(press(w), 'press with a lost receipt');
  assert.equal(first.receipt, 'not_sent');
  assert.equal(statementsOf(w), 2);
  w.bank.state.throwOnAck = false;
  const second = must(press(w), 'the bank offers it again');
  assert.deepEqual(second.statements, []);
  assert.deepEqual([statementsOf(w), memberRows(w), linesOf(w)], [2, 1, 2]);
  assert.deepEqual(w.bank.receipts.map((r) => r.receiptCode), [0]);
});

test('no receipt before the commit: when the bank sees the receipt the member, its outcome and the statement are committed', () => {
  const w = world(6, { bridged: 1, days: 3 });
  w.bank.offer(container([w.statements[1].xml, w.statements[2].xml]));
  const seen = [];
  w.bank.state.onAck = (req) => {
    seen.push({ receiptCode: req.receiptCode, members: memberRows(w), outcomes: outcomeRows(w), statements: statementsOf(w) });
  };
  must(press(w), 'press');
  assert.deepEqual(seen, [{ receiptCode: 0, members: 2, outcomes: 2, statements: 3 }]);
  // The receipt carries the reviewed pin (W2: the pin travels on every call, BTD-ACK included).
  const ack = w.bank.log.find((e) => e.kind === 'BTD-ACK');
  assert.ok(ack.pin !== null && typeof ack.pin.authentication === 'string' && ack.pin.authentication.length > 0);
  assert.ok(w.bank.log.filter((e) => e.kind === 'BTD').every((e) => e.pin !== null), 'every download carries the pin');
});

test('a failed commit gets a NEGATIVE receipt: nothing persisted, the bank offers the data again, the next press imports it once', () => {
  const w = world(7);
  w.bank.offer(container([w.statements[1].xml]));
  crashOn(w, 'full_disk', 'stored_file');
  const failed = press(w);
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'commit_failed');
  assert.deepEqual(w.bank.receipts.map((r) => r.receiptCode), [1]);
  assert.deepEqual([memberRows(w), statementsOf(w)], [0, 1]);
  heal(w, 'full_disk');
  must(press(w), 'recovery');
  assert.deepEqual(w.bank.receipts.map((r) => r.receiptCode), [1, 0]);
  assert.deepEqual([statementsOf(w), memberRows(w)], [2, 1]);
});

test('an outcome row is appended only when the outcome changes (a gap waiting across presses logs once)', () => {
  const w = world(8, { bridged: 1, days: 3 });
  w.bank.offer(container([w.statements[2].xml]));
  const first = must(press(w), 'press 1');
  assert.deepEqual(first.statements.map((s) => s.outcome), ['gap_refused']);
  must(press(w), 'press 2 (090005)');
  must(press(w), 'press 3 (090005)');
  assert.equal(outcomeRows(w), 1, 'still gap_refused: no second row');
  must(importCamt(w.t.ctx, { bankAccountId: w.accountId, xml: w.statements[1].xml, idempotencyKey: 'hand-2' }), 'hand import of 2');
  const after = must(press(w), 'press 4');
  assert.deepEqual(after.statements.map((s) => s.outcome), ['imported']);
  assert.equal(outcomeRows(w), 2, 'the change to imported is the second row');
});

test('a download whose TransactionID the order log already holds is untrusted_response, nothing persisted, no receipt', () => {
  const w = world(9);
  w.bank.offer(container([w.statements[1].xml]));
  must(press(w), 'the genuine download, committed and receipted');
  const before = { files: files(w), log: logRows(w), receipts: w.bank.receipts.length, statements: statementsOf(w) };
  // The same genuine initialisation served again (a fresh wire keeps no replay record of its own).
  w.bank.nextDownload('replay-last');
  const replay = press(w);
  assert.equal(replay.ok, false);
  assert.equal(replay.error, 'untrusted_response');
  assert.equal(replay.download.detail, 'replayed_transaction');
  assert.deepEqual({ files: files(w), log: logRows(w), receipts: w.bank.receipts.length, statements: statementsOf(w) }, before);
  // The TransactionID is stored uppercase, once, beside its container.
  const txRows = w.t.store.db.prepare("SELECT order_ref FROM ebics_order_log WHERE workspace_id = ? AND related_kind = 'ebics_container'").all(w.t.workspaceId);
  assert.equal(txRows.length, 1);
  assert.match(txRows[0].order_ref, /^btd-[0-9A-F]{32}$/);
});

test('the §4.3 table: each BTD answer maps to its outcome, the raw code carried, no state change on a refusal', () => {
  const cases = [
    [bankCode('090003'), 'download_refused', 'not_granted'],
    [bankCode('091005', 'technical'), 'download_refused', 'not_granted'],
    [bankCode('091006', 'technical'), 'download_refused', 'not_granted'],
    [bankCode('091119', 'technical'), 'download_refused', 'busy'],
    [bankCode('091117', 'technical'), 'download_refused', 'too_large'],
    [bankCode('061099', 'technical'), 'download_refused', 'other'],
    [{ ok: false, reason: 'transport_error', detail: 'ECONNRESET' }, 'channel_unreachable', null],
  ];
  for (const [answer, error, kind] of cases) {
    const w = world(20 + cases.indexOf(cases.find((c) => c[0] === answer)));
    w.bank.nextDownload(answer);
    const r = press(w);
    assert.equal(r.ok, false, JSON.stringify(answer));
    assert.equal(r.error, error);
    if (kind !== null) {
      assert.equal(r.kind, kind);
      assert.equal(r.code, answer.codes.technical !== '000000' ? answer.codes.technical : answer.codes.business);
      assert.deepEqual(r.btf, { serviceName: 'EOP', msgName: 'camt.053', scope: 'CH', msgVersion: '08', containerType: 'ZIP' });
    }
    const state = w.t.store.db.prepare('SELECT state, last_sync_at FROM ebics_connection WHERE id = ?').get(w.connectionId);
    assert.deepEqual([state.state, state.last_sync_at], ['active', null], 'a refusal changes no state and stamps no sync');
  }
  // 090005 is quiet: ok, nothing new, the sync stamped.
  const quiet = world(30);
  const r = must(press(quiet), '090005');
  assert.equal(r.download.outcome, 'no_data');
  assert.equal(typeof r.lastSyncAt, 'string');
});

test('091008 or an untrusted answer runs one HPB: keys unequal to the pin halt the channel in bank_keys_changed', () => {
  const w = world(31);
  w.bank.rotateKeys();
  w.bank.nextDownload(bankCode('091008', 'technical'));
  const r = press(w);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'bank_keys_changed');
  assert.equal(w.t.store.db.prepare('SELECT state FROM ebics_connection WHERE id = ?').get(w.connectionId).state, 'bank_keys_changed');
  // The next press refuses before anything is sent.
  const before = w.bank.log.length;
  assert.equal(press(w).error, 'bank_keys_changed');
  assert.equal(w.bank.log.length, before, 'nothing sent while halted');

  // An untrusted answer with UNCHANGED keys: the HPB compare holds, the channel stays active.
  const u = world(32);
  u.bank.nextDownload({ ok: false, reason: 'untrusted_response', detail: 'signature_invalid', phase: 'Initialisation' });
  const ur = press(u);
  assert.equal(ur.error, 'untrusted_response');
  assert.equal(u.t.store.db.prepare('SELECT state FROM ebics_connection WHERE id = ?').get(u.connectionId).state, 'active');
  assert.ok(u.bank.log.some((e) => e.kind === 'HPB' && e.pin !== null), 'the compare ran HPB');
});

test('a dateRange is refused before anything is sent; a W2 contract break (no TransactionID) is not used or receipted', () => {
  const w = world(33);
  const before = w.bank.log.length;
  assert.equal(syncBankChannel(w.ctx, { connectionId: w.connectionId, dateRange: { from: '2026-10-01' }, idempotencyKey: 'dr' }).error, 'unsupported_date_range');
  assert.equal(w.bank.log.length, before);
  // A W2 contract break: a success without a TransactionID is not used and not receipted.
  w.bank.offer(container([w.statements[1].xml]));
  w.bank.nextDownload({ ok: true, containerBase64: 'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', files: [] });
  const broken = press(w);
  assert.equal(broken.error, 'channel_unreachable');
  assert.equal(broken.reason, 'ebics_wire_contract_error');
  assert.deepEqual([memberRows(w), w.bank.receipts.length], [0, 0]);
  void sha256Hex;
});

test('a number jump whose balances chain imports WITH its notice: the sync names the skipped numbers, the status keeps naming them until the next import (critic A36C-1)', () => {
  const w = world(12, { bridged: 1, days: 1 });
  const iban = syntheticIban(12);
  const s1 = w.statements[0];
  // Statement 2 never reaches TILL (picked up in eBanking): its +X and -X net to zero, so 3 opens on 1's close.
  const s3 = camt053({ iban, seq: 3, date: '2026-10-03', opening: s1.closing, entries: [{ minor: 300 }] });
  w.bank.offer(container([s3]));
  const sync = must(press(w), 'press');
  assert.equal(sync.statements.length, 1);
  const [st] = sync.statements;
  assert.deepEqual([st.outcome, st.final, st.notice], ['imported', true, 'statement_number_jump']);
  const expected = { after: { number: 1, year: 2026 }, statement: { number: 3, year: 2026 }, skipped: [{ year: 2026, from: 2, to: 2 }] };
  assert.deepEqual(st.jump, expected, 'the sync answer names the skipped numbers');

  const accountOf = (status) => status.channels.find((c) => c.connectionId === w.connectionId).accounts.find((a) => a.bankAccountId === w.accountId);
  assert.deepEqual(accountOf(must(getBankChannelStatus(w.ctx, {}), 'status')).lastNumberJump, expected, 'the status still names it after the toast is gone');

  // The owner imports the missing day by hand (a hole filler): the notice is gone.
  const s2 = camt053({ iban, seq: 2, date: '2026-10-02', opening: s1.closing, entries: [{ minor: 500 }, { minor: -500 }] });
  must(importCamt(w.t.ctx, { bankAccountId: w.accountId, xml: s2, idempotencyKey: 'hand-2' }), 'hand import of 2');
  assert.equal(accountOf(must(getBankChannelStatus(w.ctx, {}), 'status after the fill')).lastNumberJump, null);
});

test('a jump the owner never fills (the number does not exist as a day-end statement) stops being named at the next ordinary import', () => {
  const w = world(13, { bridged: 1, days: 1 });
  const iban = syntheticIban(13);
  const s1 = w.statements[0];
  const s3 = camt053({ iban, seq: 3, date: '2026-10-03', opening: s1.closing, entries: [{ minor: 300 }] });
  const s4 = camt053({ iban, seq: 4, date: '2026-10-04', opening: s1.closing + 300, entries: [{ minor: 400 }] });
  w.bank.offer(container([s3]));
  must(press(w), 'press 1');
  w.bank.offer(container([s4]));
  const second = must(press(w), 'press 2');
  assert.deepEqual(second.statements.map((x) => [x.outcome, x.notice ?? null]), [['imported', null]], 'an ordinary successor carries no notice');
  const status = must(getBankChannelStatus(w.ctx, {}), 'status');
  const account = status.channels.find((c) => c.connectionId === w.connectionId).accounts.find((a) => a.bankAccountId === w.accountId);
  assert.equal(account.lastNumberJump, null);
});
