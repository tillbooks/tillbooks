// A33 + A36, the EBICS bank channel, download only (spec A36 §4.2, §4.5, §4.6, §5, §8 row 4): the key
// ceremony and its legs, the reviewed pin, the halt on changed bank keys (never over a block), the local
// block and its exit, restore and copy, the routing guards, and the verbs that now refuse (upload,
// schedule), plus the LOAD-BEARING invariants a non-author critic must see bite: A36 POSTS NOTHING, no key
// material ever reaches SQLite or a result, and §H-TENANT. All offline against the in-process bank of
// `ebics-support.mjs` (contract 2). The statement feed itself is `ebics-feed` and `ebics-sync`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setup, secondWorkspace, PLAIN_IBAN, snapshot } from './support.mjs';
import { mockBank, bankCode, container, chain, syntheticIban, BANK_HASHES } from './ebics-support.mjs';
import { createContact } from '../../dist/core/sales/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createBankAccount, setCreditorBankProfile, createPaymentBatch, generatePain001 } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import {
  connectBankChannel,
  syncBankChannel,
  transmitPaymentBatch,
  getBankChannelStatus,
  disconnectBankChannel,
  setBankSyncSchedule,
  formatBankHashLines,
} from '../../dist/core/banking/ebics/index.js';
import { getFileContent } from '../../dist/core/files/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { makeContext } from '../../dist/core/context.js';

const HOST = { url: 'https://ebics.example/ebicsweb', hostId: 'SYNTHHST', partnerId: 'PARTNER01', userId: 'USER0001' };

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}
function refused(res, code, label) {
  assert.equal(res.ok, false, `${label}: expected ${code}, got ${JSON.stringify(res)}`);
  assert.equal(res.error, code, `${label}: ${JSON.stringify(res)}`);
  return res;
}

function ctxWith(t, bank, extra = {}) {
  return makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    ...(bank ? { ebicsTransport: bank.port } : {}),
    ...extra,
  });
}

let n = 0;
function account(t, ctx = t.ctx, iban = syntheticIban(1000 + (n += 1))) {
  return must(createBankAccount(ctx, { name: `Konto ${n}`, iban, ledgerAccountId: t.acc('1020'), idempotencyKey: `ba-${n}` }), 'account').bankAccountId;
}
const stateOf = (t, id) => t.store.db.prepare('SELECT state FROM ebics_connection WHERE id = ?').get(id).state;
const legRows = (t, id) => t.store.db.prepare("SELECT order_type AS leg, status, bank_reason AS reason FROM ebics_order_log WHERE connection_id = ? AND order_type IN ('INI','HIA') ORDER BY rowid").all(id).map((r) => ({ ...r }));

function connect(ctx, accountIds, key, host = HOST) {
  return connectBankChannel(ctx, { host, routeBankAccountIds: accountIds, confirm: true, idempotencyKey: key });
}
function fetchKeys(ctx, connectionId) {
  return connectBankChannel(ctx, { connectionId, confirm: true });
}
function confirmKeys(ctx, connectionId, expectedBankKeyHashes) {
  return connectBankChannel(ctx, { connectionId, confirm: true, confirmBankKeys: true, ...(expectedBankKeyHashes !== undefined ? { expectedBankKeyHashes } : {}) });
}
function activeChannel(t, bank, accountIds = [account(t)]) {
  const ctx = ctxWith(t, bank);
  const c = must(connect(ctx, accountIds, `act-${(n += 1)}`), 'connect');
  const fetched = must(fetchKeys(ctx, c.connectionId), 'fetch');
  must(confirmKeys(ctx, c.connectionId, fetched.bankKeyHashes), 'confirm');
  return { ctx, connectionId: c.connectionId, accountIds, fetched };
}

// --- the ceremony (§3 steps 3 to 6, §4.2) ---------------------------------------------------------

test('connect with NO transport does the local work: certified keys and the INI letter, keys_generated', () => {
  const t = setup();
  const res = must(connect(t.ctx, [account(t)], 'nc-1'), 'connect');
  assert.equal(res.state, 'keys_generated');
  assert.equal(res.reason, 'needs_bank_transport');
  const letter = Buffer.from(must(getFileContent(t.ctx, { fileId: res.iniLetterDocumentId }), 'letter').contentBase64, 'base64').toString('utf8');
  // §3 step 4: host ID, partner ID, user ID, H005, the date, the certificate hashes as uppercase pairs.
  for (const needle of ['Host-ID: SYNTHHST', 'Partner-ID (Kunden-ID): PARTNER01', 'Teilnehmer-ID (User-ID): USER0001', 'EBICS-Version: H005', 'Datum / Date: 2026-07-19', 'Zertifikat / certificate:']) {
    assert.ok(letter.includes(needle), `the letter carries ${needle}`);
  }
  const pairLines = letter.split('\n').filter((l) => /^ {4}([0-9A-F]{2} ){7}[0-9A-F]{2}$/.test(l));
  assert.equal(pairLines.length, 3 * 2 * 4, 'three keys, certificate and key hash each, 4 lines of 8 pairs');
});

test('P8: an unconfirmed connect is refused and writes nothing', () => {
  const t = setup();
  const id = account(t);
  const before = snapshot(t.store);
  refused(connectBankChannel(t.ctx, { host: HOST, routeBankAccountIds: [id], idempotencyKey: 'p8' }), 'needs_confirmation', 'unconfirmed');
  assert.equal(snapshot(t.store), before);
});

test('HEV without H005 is unsupported_ebics_version before any key exists (H004 is never used)', () => {
  const t = setup();
  const bank = mockBank();
  bank.state.hev = { ok: false, reason: 'unsupported_ebics_version', detail: 'H003,H004' };
  const before = snapshot(t.store);
  const r = refused(connect(ctxWith(t, bank), [account(t)], 'hev'), 'unsupported_ebics_version', 'hev');
  assert.equal(r.offered, 'H003,H004');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM ebics_connection').get().n, 0, 'no connection, no key');
  assert.deepEqual(bank.log.map((e) => e.kind), ['HEV'], 'nothing but HEV was sent');
  void before;
});

test('both legs 000000: pending_bank_activation, each leg logged; the reviewed pin then activates', () => {
  const t = setup();
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const c = must(connect(ctx, [account(t)], 'legs'), 'connect');
  assert.equal(c.state, 'pending_bank_activation');
  assert.deepEqual(bank.log.map((e) => e.kind), ['HEV', 'INI', 'HIA'], 'HEV first, then the two legs, separately');
  assert.deepEqual(legRows(t, c.connectionId), [{ leg: 'INI', status: 'ok', reason: null }, { leg: 'HIA', status: 'ok', reason: null }]);
  // HPB shows the bank hashes (and ZKB-sheet lines, 8 pairs per line) but activates nothing.
  const f = must(fetchKeys(ctx, c.connectionId), 'fetch');
  assert.equal(f.awaitingConfirmation, true);
  assert.equal(f.state, 'pending_bank_activation');
  assert.deepEqual(f.bankKeyLines.authentication.certificate, formatBankHashLines(BANK_HASHES.certificateHashes.authentication));
  assert.equal(f.bankKeyLines.authentication.certificate.length, 4);
  const a = must(confirmKeys(ctx, c.connectionId, f.bankKeyHashes), 'confirm');
  assert.equal(a.state, 'active');
  assert.equal(a.activatedConnectionId, c.connectionId, 'the OP8 emit path on the flip into active');
});

test('091002 after the other leg 000000 is pending_bank_activation; with neither confirmed it is init_refused', () => {
  const t = setup();
  const one = mockBank();
  one.nextLeg('HIA', bankCode('091002', 'technical'));
  const c1 = must(connect(ctxWith(t, one), [account(t)], 'one'), 'INI ok, HIA 091002');
  assert.equal(c1.state, 'pending_bank_activation', 'the other leg was confirmed, so both landed');

  const t2 = setup();
  const none = mockBank();
  none.nextLeg('INI', bankCode('091002', 'technical'));
  none.nextLeg('HIA', bankCode('091002', 'technical'));
  const r = refused(connect(ctxWith(t2, none), [account(t2)], 'none'), 'init_refused', 'both 091002');
  assert.equal(stateOf(t2, r.connectionId), 'ini_sent');
  assert.deepEqual(legRows(t2, r.connectionId).map((l) => l.reason), ['091002', '091002']);
  const status = must(getBankChannelStatus(ctxWith(t2, none), {}), 'status').channels[0];
  assert.deepEqual(status.ceremony, { ini: '091002', hia: '091002', refusal: 'init_refused' });
  // An HPB 000000 supersedes it: the bank holds both keys after all.
  const f = must(fetchKeys(ctxWith(t2, none), r.connectionId), 'HPB after init_refused');
  assert.equal(f.state, 'pending_bank_activation');
});

test('a lost answer is ini_sent; the resend skips the confirmed leg; a reviewed HPB then moves ini_sent to active', () => {
  const t = setup();
  const bank = mockBank();
  bank.nextLeg('HIA', 'throw');
  const ctx = ctxWith(t, bank);
  const r = refused(connect(ctx, [account(t)], 'lost'), 'channel_unreachable', 'HIA answer lost');
  assert.equal(stateOf(t, r.connectionId), 'ini_sent');
  // The retry resends only HIA (same keys), then fetches the bank keys.
  const f = must(fetchKeys(ctx, r.connectionId), 'retry');
  assert.deepEqual(bank.log.filter((e) => e.kind === 'INI' || e.kind === 'HIA').map((e) => e.kind), ['INI', 'HIA', 'HIA'], 'INI was not resent');
  assert.equal(f.state, 'pending_bank_activation');
  must(confirmKeys(ctx, r.connectionId, f.bankKeyHashes), 'confirm');
  assert.equal(stateOf(t, r.connectionId), 'active');

  // After a lost first answer the letter still works even when the resend itself answers 091002.
  const t2 = setup();
  const b2 = mockBank();
  b2.nextLeg('INI', 'throw');
  const ctx2 = ctxWith(t2, b2);
  const r2 = refused(connect(ctx2, [account(t2)], 'lost2'), 'channel_unreachable', 'INI answer lost');
  b2.nextLeg('INI', bankCode('091002', 'technical'));
  const f2 = must(fetchKeys(ctx2, r2.connectionId), 'resend 091002, HPB ok');
  must(confirmKeys(ctx2, r2.connectionId, f2.bankKeyHashes), 'reviewed HPB');
  assert.equal(stateOf(t2, r2.connectionId), 'active');
});

test('091201 to 091219 is certificate_refused; any other leg code is shown raw, never success', () => {
  const t = setup();
  const bank = mockBank();
  bank.nextLeg('INI', bankCode('091210', 'technical'));
  const r = refused(connect(ctxWith(t, bank), [account(t)], 'cert'), 'certificate_refused', '091210');
  assert.deepEqual([r.leg, r.code], ['INI', '091210']);
  const t2 = setup();
  const b2 = mockBank();
  b2.nextLeg('HIA', bankCode('061099', 'technical'));
  const r2 = refused(connect(ctxWith(t2, b2), [account(t2)], 'raw'), 'key_exchange_refused', 'raw code');
  assert.deepEqual([r2.leg, r2.codes.technical], ['HIA', '061099']);
});

test('the pin comes only from a reviewed set equal to a fresh HPB', () => {
  const t = setup();
  const bank = mockBank();
  const ctx = ctxWith(t, bank);
  const c = must(connect(ctx, [account(t)], 'pin'), 'connect');
  const f = must(fetchKeys(ctx, c.connectionId), 'fetch');
  refused(confirmKeys(ctx, c.connectionId), 'invalid_input', 'no reviewed set');
  const wrong = structuredClone(f.bankKeyHashes);
  wrong.certificateHashes.encryption = '0'.repeat(64);
  refused(confirmKeys(ctx, c.connectionId, wrong), 'bank_keys_mismatch', 'a set nobody was shown');
  assert.equal(t.store.db.prepare('SELECT bank_key_hashes FROM ebics_connection WHERE id = ?').get(c.connectionId).bank_key_hashes, null, 'nothing pinned');
  // Case and spacing as copied from the screen do not matter.
  const typed = structuredClone(f.bankKeyHashes);
  typed.certificateHashes.authentication = formatBankHashLines(typed.certificateHashes.authentication).join(' ');
  must(confirmKeys(ctx, c.connectionId, typed), 'the reviewed set');
  assert.equal(stateOf(t, c.connectionId), 'active');
});

test('changed bank keys halt an active channel; the reviewed rotation resumes it; a halt never overwrites a block', () => {
  const t = setup();
  const bank = mockBank();
  const ch = activeChannel(t, bank);
  bank.rotateKeys();
  // An active channel fetches nothing without a confirm (idempotent, nothing sent).
  assert.equal(must(fetchKeys(ch.ctx, ch.connectionId), 'fetch while active').bankKeyHashes, undefined);
  // Re-confirming the OLD reviewed set against the rotated bank: halt, nothing pinned.
  refused(confirmKeys(ch.ctx, ch.connectionId, ch.fetched.bankKeyHashes), 'bank_keys_mismatch', 'rotation');
  assert.equal(stateOf(t, ch.connectionId), 'bank_keys_changed');
  refused(syncBankChannel(ch.ctx, { connectionId: ch.connectionId, idempotencyKey: 's' }), 'bank_keys_changed', 'the feed halts');
  // "Bankschlüssel abrufen" on the halted channel shows the new set, and the pin is unchanged by it.
  const f = must(fetchKeys(ch.ctx, ch.connectionId), 'fetch while halted');
  assert.equal(f.state, 'bank_keys_changed');
  refused(confirmKeys(ch.ctx, ch.connectionId), 'bank_keys_mismatch', 'no resume without the reviewed set');
  assert.equal(stateOf(t, ch.connectionId), 'bank_keys_changed');
  // The owner compares the new set with the current ZKB sheet and confirms it: active again.
  must(confirmKeys(ch.ctx, ch.connectionId, f.bankKeyHashes), 'reviewed rotation');
  assert.equal(stateOf(t, ch.connectionId), 'active');

  // A local block, then the bank keys change: a mismatch keeps it BLOCKED (never bank_keys_changed).
  const t2 = setup();
  const b2 = mockBank();
  const ch2 = activeChannel(t2, b2);
  must(disconnectBankChannel(ch2.ctx, { connectionId: ch2.connectionId, mode: 'block', confirm: true, idempotencyKey: 'blk' }), 'block');
  b2.rotateKeys();
  refused(confirmKeys(ch2.ctx, ch2.connectionId, ch2.fetched.bankKeyHashes), 'bank_keys_mismatch', 'old set on a blocked channel');
  assert.equal(stateOf(t2, ch2.connectionId), 'blocked');
});

test('block is LOCAL (nothing sent); its one exit is the reviewed confirm', () => {
  const t = setup();
  const bank = mockBank();
  const ch = activeChannel(t, bank);
  const sent = bank.log.length;
  const b = must(disconnectBankChannel(ch.ctx, { connectionId: ch.connectionId, mode: 'block', confirm: true, idempotencyKey: 'b1' }), 'block');
  assert.deepEqual([b.state, b.bankBlock], ['blocked', 'not_sent']);
  assert.equal(bank.log.length, sent, 'no SPR, nothing at all went to the bank');
  refused(syncBankChannel(ch.ctx, { connectionId: ch.connectionId, idempotencyKey: 'b-s' }), 'channel_blocked', 'blocked');
  const f = must(fetchKeys(ch.ctx, ch.connectionId), 'fetch while blocked');
  assert.equal(f.state, 'blocked');
  refused(confirmKeys(ch.ctx, ch.connectionId), 'invalid_input', 'leaving a block needs the reviewed set');
  assert.equal(stateOf(t, ch.connectionId), 'blocked');
  must(confirmKeys(ch.ctx, ch.connectionId, f.bankKeyHashes), 'the reviewed confirm');
  assert.equal(stateOf(t, ch.connectionId), 'active');
});

test('retire is terminal and destroys the key locator', () => {
  const t = setup();
  const ch = activeChannel(t, mockBank());
  must(disconnectBankChannel(ch.ctx, { connectionId: ch.connectionId, mode: 'retire', confirm: true, idempotencyKey: 'r1' }), 'retire');
  assert.equal(stateOf(t, ch.connectionId), 'retired');
  assert.equal(t.store.db.prepare('SELECT key_ref FROM ebics_connection WHERE id = ?').get(ch.connectionId).key_ref, null);
  refused(fetchKeys(ch.ctx, ch.connectionId), 'invalid_state', 'retired');
});

// --- the routing guards and the one live connection (§4.5, §4.6) ---------------------------------

function seedCamt054Line(t, bankAccountId) {
  // A book from before A39 refused camt.054 at every door: such lines can only be there from an older build.
  const at = t.clock.now();
  t.store.db.prepare(
    `INSERT INTO bank_statement (id, workspace_id, bank_account_id, message_type, statement_id, content_hash, txn_count, imported_at)
     VALUES ('bstmt_054', ?, ?, 'camt054', 'N-1', 'h', 1, ?)`,
  ).run(t.workspaceId, bankAccountId, at);
  t.store.db.prepare(
    `INSERT INTO bank_txn (id, workspace_id, bank_account_id, statement_id, entry_key, amount_minor, currency, credit_debit, classification, created_at)
     VALUES ('btxn_054', ?, ?, 'bstmt_054', 'k054', 100, 'CHF', 'CRDT', 'incoming_credit', ?)`,
  ).run(t.workspaceId, bankAccountId, at);
}

test('routing an account with camt.054 lines is refused before any key, also under an existing connection', () => {
  const t = setup();
  const bank = mockBank();
  const withLines = account(t);
  seedCamt054Line(t, withLines);
  refused(connect(ctxWith(t, bank), [withLines], 'c054'), 'camt054_lines_refused', 'new ceremony');
  assert.deepEqual(bank.log, [], 'refused before HEV: no key, nothing sent');
  const ch = activeChannel(t, bank);
  refused(connectBankChannel(ch.ctx, { connectionId: ch.connectionId, routeBankAccountIds: [withLines], confirm: true }), 'camt054_lines_refused', 'routing under it');
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM ebics_connection_account WHERE bank_account_id = ?').get(withLines).n, 0);
});

test('a sandbox or demo workspace is trial_workspace_refused', () => {
  const t = setup();
  t.store.db.prepare("UPDATE workspace SET kind = 'sandbox' WHERE id = ?").run(t.workspaceId);
  refused(connect(ctxWith(t, mockBank()), [account(t)], 'trial'), 'trial_workspace_refused', 'sandbox');
  t.store.db.prepare("UPDATE workspace SET kind = 'demo' WHERE id = ?").run(t.workspaceId);
  refused(connect(ctxWith(t, mockBank()), [account(t)], 'trial2'), 'trial_workspace_refused', 'demo');
});

test('one live connection per subscriber in the database: another workspace is live_connection_exists', () => {
  const t = setup();
  activeChannel(t, mockBank());
  const other = secondWorkspace(t);
  const otherCtx = makeContext(t.store, { workspaceId: other.workspaceId, actor: 'user_2', clock: t.clock, ids: t.ids, ebicsTransport: mockBank().port });
  const otherAccount = must(createBankAccount(other.ctx, { name: 'N', iban: syntheticIban(7777), ledgerAccountId: other.acc('1020'), idempotencyKey: 'n' }), 'b').bankAccountId;
  refused(connectBankChannel(otherCtx, { host: HOST, routeBankAccountIds: [otherAccount], confirm: true, idempotencyKey: 'dup' }), 'live_connection_exists', 'second feed');
  // The index itself holds the line even for a writer that skips the verb.
  assert.throws(() =>
    t.store.db.prepare(
      `INSERT INTO ebics_connection (id, workspace_id, host_url, host_id, partner_id, user_id_ebics, state, created_at, updated_at)
       VALUES ('ebconn_raw', ?, 'https://x', ?, ?, ?, 'pending_bank_activation', 'now', 'now')`,
    ).run(other.workspaceId, HOST.hostId, HOST.partnerId, HOST.userId),
  /UNIQUE/);
});

// --- the verbs that refuse (§5) -------------------------------------------------------------------

function generatedBatch(ctx, t, bankAccountId, seed) {
  const vendor = must(createContact(ctx, { partyRole: 'vendor', name: `Lief ${seed}`, idempotencyKey: `v-${seed}` }), 'vendor').contact.id;
  const bill = must(createVendorBill(ctx, { vendorId: vendor, billDate: '2026-03-01', vendorReference: `LG-${seed}`, amountMinor: 100000, expenseAccountId: t.acc('6500'), idempotencyKey: `bill-${seed}` }), 'bill');
  must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${seed}` }), 'post');
  must(setCreditorBankProfile(ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `cbp-${seed}` }), 'cbp');
  const batch = must(createPaymentBatch(ctx, { bankAccountId, itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: `batch-${seed}` }), 'batch');
  must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: `gen-${seed}` }), 'gen');
  return batch.batchId;
}

test('payment_batch_transmit: upload_disabled only for a batch routed over EBICS; the degrade stays; nothing is sent', () => {
  const t = setup();
  const bank = mockBank();
  const ch = activeChannel(t, bank);
  const sent = bank.log.length;
  const routedBatch = generatedBatch(ch.ctx, t, ch.accountIds[0], 'r');
  refused(transmitPaymentBatch(ch.ctx, { batchId: routedBatch, confirm: true, idempotencyKey: 'tx-r' }), 'upload_disabled', 'routed');
  assert.equal(bank.log.length, sent, 'no port call');
  const unrouted = generatedBatch(ch.ctx, t, account(t), 'u');
  const degrade = must(transmitPaymentBatch(ch.ctx, { batchId: unrouted, confirm: true, idempotencyKey: 'tx-u' }), 'unrouted');
  assert.deepEqual([degrade.transmitted, degrade.reason], [false, 'needs_bank_channel']);
});

test('generate_pain001 tells the truth for an EBICS-routed account: upload_in_ebanking, never a transmit the channel refuses', () => {
  const t = setup();
  const bank = mockBank();
  const ch = activeChannel(t, bank);
  const vendor = must(createContact(ch.ctx, { partyRole: 'vendor', name: 'Lief G', idempotencyKey: 'v-g' }), 'vendor').contact.id;
  const bill = must(createVendorBill(ch.ctx, { vendorId: vendor, billDate: '2026-03-01', vendorReference: 'LG-g', amountMinor: 5000, expenseAccountId: t.acc('6500'), idempotencyKey: 'bill-g' }), 'bill');
  must(postVendorBill(ch.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: 'post-g' }), 'post');
  must(setCreditorBankProfile(ch.ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: 'cbp-g' }), 'cbp');
  const routed = must(createPaymentBatch(ch.ctx, { bankAccountId: ch.accountIds[0], itemIds: [bill.vendorBillId], executionDate: '2026-03-20', idempotencyKey: 'batch-g' }), 'batch');
  const generated = must(generatePain001(ch.ctx, { batchId: routed.batchId, idempotencyKey: 'gen-g' }), 'generate');
  assert.deepEqual([generated.transmitted, generated.reason], [false, 'upload_in_ebanking'], 'the file goes to the bank through eBanking');
  assert.ok(typeof generated.xmlBase64 === 'string' && generated.xmlBase64.length > 0, 'the file is there to download');

  const unroutedBatch = generatedBatch(ch.ctx, t, account(t), 'g2');
  const again = must(generatePain001(ch.ctx, { batchId: unroutedBatch, idempotencyKey: 'gen-g2' }), 'regenerate unrouted');
  assert.equal(again.reason, 'no_channel', 'an account without a channel keeps the plain file path');
});

test('set_bank_sync_schedule refuses a rule; bank_sync is on the G01 denylist (on demand only)', () => {
  const t = setup();
  const ch = activeChannel(t, mockBank());
  refused(setBankSyncSchedule(ch.ctx, { connectionId: ch.connectionId, ruleId: 'arule_x', idempotencyKey: 'sch' }), 'sync_schedule_parked', 'a rule');
  must(setBankSyncSchedule(ch.ctx, { connectionId: ch.connectionId, idempotencyKey: 'unl' }), 'the unlink');
  assert.equal(NOT_AUTOMATABLE.has('bank_sync'), true);
  for (const v of ['bank_channel_connect', 'bank_channel_disconnect', 'payment_batch_transmit']) assert.equal(NOT_AUTOMATABLE.has(v), true, v);
});

test('the bridge import_camt keeps working on a refused connection (never activated: no rule), and on a blocked one (the rule)', () => {
  const t = setup();
  const refusedBank = mockBank();
  refusedBank.nextLeg('INI', bankCode('091002', 'technical'));
  refusedBank.nextLeg('HIA', bankCode('091002', 'technical'));
  const id = account(t);
  refused(connect(ctxWith(t, refusedBank), [id], 'br'), 'init_refused', 'refused ceremony');
  const iban = t.store.db.prepare('SELECT iban FROM bank_account WHERE id = ?').get(id).iban;
  const days = chain({ iban, firstSeq: 7, firstDate: '2026-10-07', opening: 1000, days: [[{ minor: 1 }], [{ minor: 2 }]] });
  const hand = must(importCamt(t.ctx, { bankAccountId: id, xml: days[1].xml, idempotencyKey: 'br-1' }), 'hand import, no rule');
  assert.equal(hand.feed, undefined, 'the account is not EBICS-fed (never activated)');

  const t2 = setup();
  const b2 = mockBank();
  const ch = activeChannel(t2, b2);
  must(disconnectBankChannel(ch.ctx, { connectionId: ch.connectionId, mode: 'block', confirm: true, idempotencyKey: 'blk' }), 'block');
  const iban2 = t2.store.db.prepare('SELECT iban FROM bank_account WHERE id = ?').get(ch.accountIds[0]).iban;
  const d2 = chain({ iban: iban2, firstSeq: 1, firstDate: '2026-10-01', opening: 5, days: [[{ minor: 1 }]] });
  const blocked = must(importCamt(t2.ctx, { bankAccountId: ch.accountIds[0], xml: d2[0].xml, idempotencyKey: 'br-2' }), 'hand import on a blocked channel');
  assert.equal(blocked.feed.rule, 'feed_start', 'the rule still holds while the channel is blocked');
});

// --- restore and copy (§4.2) ----------------------------------------------------------------------

test('a G04 restore lands an active connection in bank_keys_changed with keys and pin kept; beside its live twin, retired', () => {
  const t = setup();
  const bank = mockBank();
  const ch = activeChannel(t, bank);
  const src = t.store.db.prepare('SELECT key_ref, bank_key_hashes, activated_at FROM ebics_connection WHERE id = ?').get(ch.connectionId);
  const backupDir = mkdtempSync(join(tmpdir(), 'till-a36-restore-'));
  try {
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir };
    const bkp = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bkp' }), 'backup');

    // Disaster recovery: a fresh database. Keys and pin kept; the reviewed confirm resumes it.
    const fresh = new SqliteStore({ clock: t.clock });
    try {
      const r = must(restoreBackup({ ...deps, store: fresh }, { source: bkp.artifactRef, newWorkspaceName: 'Wiederhergestellt', confirmed: true }), 'restore');
      const row = fresh.db.prepare('SELECT state, key_ref, bank_key_hashes, activated_at FROM ebics_connection WHERE workspace_id = ?').get(r.workspaceId);
      assert.deepEqual({ ...row }, { state: 'bank_keys_changed', key_ref: src.key_ref, bank_key_hashes: src.bank_key_hashes, activated_at: src.activated_at });
    } finally {
      fresh.close();
    }

    // Beside the live original (the same database): the copy can never feed, so it lands retired.
    const beside = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie', confirmed: true }), 'restore beside');
    const twin = t.store.db.prepare('SELECT state, key_ref FROM ebics_connection WHERE workspace_id = ?').get(beside.workspaceId);
    assert.deepEqual({ ...twin }, { state: 'retired', key_ref: null });
    assert.equal(stateOf(t, ch.connectionId), 'active', 'the original is untouched');
  } finally {
    rmSync(backupDir, { recursive: true, force: true });
  }
});

// --- the invariants a critic must see bite ----------------------------------------------------------

test('A36 POSTS NOTHING: a sync that imports statements moves no journal_entry and no payment row', () => {
  const t = setup();
  const bank = mockBank();
  const ch = activeChannel(t, bank);
  const iban = t.store.db.prepare('SELECT iban FROM bank_account WHERE id = ?').get(ch.accountIds[0]).iban;
  bank.offer(container(chain({ iban, firstSeq: 1, firstDate: '2026-10-01', opening: 1000, days: [[{ minor: 500 }, { minor: -200 }], [{ minor: 70 }]] }).map((d) => d.xml)));
  const count = (table) => t.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).get(t.workspaceId).n;
  const before = { journal: count('journal_entry'), payment: count('payment') };
  const s = must(syncBankChannel(ch.ctx, { connectionId: ch.connectionId, idempotencyKey: 'np' }), 'sync');
  assert.deepEqual(s.statements.map((x) => x.outcome), ['imported', 'imported']);
  assert.ok(count('bank_txn') >= 3, 'the loop really ran (the check is not vacuous)');
  assert.deepEqual({ journal: count('journal_entry'), payment: count('payment') }, before);
});

test('no key material EVER reaches SQLite or any verb result (tripwire 3)', () => {
  const t = setup();
  const bank = mockBank();
  const id = account(t);
  const ctx = ctxWith(t, bank);
  const c = must(connect(ctx, [id], 'k'), 'connect');
  const f = must(fetchKeys(ctx, c.connectionId), 'fetch');
  const a = must(confirmKeys(ctx, c.connectionId, f.bankKeyHashes), 'confirm');
  const iban = t.store.db.prepare('SELECT iban FROM bank_account WHERE id = ?').get(id).iban;
  bank.offer(container([chain({ iban, firstSeq: 1, firstDate: '2026-10-01', opening: 0, days: [[{ minor: 1 }]] })[0].xml]));
  const s = must(syncBankChannel(ctx, { connectionId: c.connectionId, idempotencyKey: 'k-s' }), 'sync');
  const status = must(getBankChannelStatus(ctx, {}), 'status');
  const dump = snapshot(t.store);
  const results = JSON.stringify({ c, f, a, s, status });
  for (const marker of ['PRIVATE KEY', 'BEGIN RSA', 'BEGIN PRIVATE', 'privatePem', '-----BEGIN']) {
    assert.equal(dump.includes(marker), false, `DB dump must not contain ${marker}`);
    assert.equal(results.includes(marker), false, `a verb result must not contain ${marker}`);
  }
  assert.match(t.store.db.prepare('SELECT key_ref FROM ebics_connection WHERE id = ?').get(c.connectionId).key_ref, /^ebicskey-/);
});

test('§H-TENANT: a channel in workspace A is invisible to workspace B', () => {
  const t = setup();
  const ch = activeChannel(t, mockBank());
  const other = secondWorkspace(t);
  assert.equal(must(getBankChannelStatus(other.ctx, {}), 'status-B').channels.length, 0);
  assert.equal(must(getBankChannelStatus(other.ctx, { bankAccountId: ch.accountIds[0] }), 'cross').channels.length, 0);
  refused(syncBankChannel(other.ctx, { connectionId: ch.connectionId, idempotencyKey: 'x' }), 'needs_bank_channel', 'B cannot sync A');
  refused(disconnectBankChannel(other.ctx, { connectionId: ch.connectionId, mode: 'retire', confirm: true, idempotencyKey: 'x' }), 'not_found', 'B cannot retire A');
  assert.equal(stateOf(t, ch.connectionId), 'active');
});

test('the status names per account the newest statement and each waiting statement with its message', () => {
  const t = setup();
  const bank = mockBank();
  const ch = activeChannel(t, bank);
  const iban = t.store.db.prepare('SELECT iban FROM bank_account WHERE id = ?').get(ch.accountIds[0]).iban;
  const days = chain({ iban, firstSeq: 41, firstDate: '2026-10-01', opening: 900, days: [[{ minor: 1 }], [{ minor: 2 }], [{ minor: 3 }]] });
  must(importCamt(t.ctx, { bankAccountId: ch.accountIds[0], xml: days[0].xml, idempotencyKey: 'st-1' }), 'first by hand');
  bank.offer(container([days[2].xml, chain({ iban: syntheticIban(9191), firstSeq: 1, firstDate: '2026-10-01', opening: 0, days: [[]] })[0].xml]));
  must(syncBankChannel(ch.ctx, { connectionId: ch.connectionId, idempotencyKey: 'st-s' }), 'sync');
  const c = must(getBankChannelStatus(ch.ctx, {}), 'status').channels[0];
  assert.deepEqual(c.accounts[0].newestStatement, { number: 41, year: 2026, fromDate: '2026-10-01', toDate: '2026-10-01', openingBalanceMinor: 900, closingBalanceMinor: 901, currency: 'CHF' });
  const byCode = Object.fromEntries(c.pendingStatements.map((p) => [p.code, p]));
  assert.equal(byCode.gap_refused.details.against.number, 41);
  assert.equal(byCode.unmatched_account.statement.iban, syntheticIban(9191));
  assert.equal(c.pendingIniLetter, null, 'no letter pending once active');
  assert.equal('pendingRelease' in c || 'inDoubt' in c || 'rejected' in c, false, 'no upload fields');
});
