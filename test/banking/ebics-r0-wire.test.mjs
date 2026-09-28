// A36 §7, R0 END TO END: the core, the PRIVATE live wire (contract 2) and the wire's stateful mock bank
// over a real loopback TLS socket, attached exactly as `till up` attaches them (`host-runtime.ts`,
// `TILL_EBICS_RUNTIME`). Nothing here is mocked on the core side: the file keystore, the certificates,
// the INI and HIA legs, HPB with the reviewed pin, the authenticated BTD, persist-process-receipt, and
// the durable TransactionID replay refusal (W11) against a genuinely signed answer served again to a
// FRESH wire instance (the wire's replay record lives for one process only).
//
// THE WIRE IS PRIVATE (D108) and not part of this repository. The suite runs when it finds a built wire
// of contract version 2: `TILL_EBICS_WIRE_DIR`, else `~/ebics-wire`. Without one it SKIPS with a message
// naming what it looked for; it never fails for its absence. Every key, certificate, identifier and
// statement here is synthetic by construction (the mock bank's own keys, `ebics-support.mjs`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { setup } from './support.mjs';
import { syntheticIban, chain, container } from './ebics-support.mjs';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { importCamt } from '../../dist/core/banking/camtReconcile.js';
import { connectBankChannel, syncBankChannel, getBankChannelStatus } from '../../dist/core/banking/ebics/index.js';
import { resolveEbicsRuntime } from '../../dist/api/host-runtime.js';
import { makeContext } from '../../dist/core/context.js';

const WIRE_DIR = process.env.TILL_EBICS_WIRE_DIR ?? join(homedir(), 'ebics-wire');
const WIRE_ENTRY = join(WIRE_DIR, 'dist', 'index.js');
const MOCK_BANK = join(WIRE_DIR, 'test', 'mock-bank', 'mock-bank.mjs');
const TLS_CERT = join(WIRE_DIR, 'test', 'vectors', 'tls', 'cert.pem');
const TLS_KEY = join(WIRE_DIR, 'test', 'vectors', 'tls', 'key.pem');

async function wireStatus() {
  for (const p of [WIRE_ENTRY, MOCK_BANK, TLS_CERT, TLS_KEY]) {
    if (!existsSync(p)) return `the private wire build is absent (${p} not found; set TILL_EBICS_WIRE_DIR to a built @tillbooks/ebics-wire checkout)`;
  }
  const mod = await import(pathToFileURL(WIRE_ENTRY).href);
  if (mod.WIRE_CONTRACT_VERSION !== 2) return `the wire at ${WIRE_DIR} declares contract ${mod.WIRE_CONTRACT_VERSION}, R0 needs 2 (build origin/claude/a36-download-only)`;
  return null;
}
const SKIP = await wireStatus();

const SUBSCRIBER = { hostId: 'ZKBKCHZZ', partnerId: 'PARTNER01', userId: 'USER01' };
const ENV_KEYS = ['TILL_EBICS_RUNTIME', 'TILL_EBICS_KEYSTORE_PATH', 'TILL_EBICS_KEYSTORE_PASSPHRASE', 'TILL_EBICS_CA_FILE'];

function must(res, label) {
  assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`);
  return res;
}

/** Start the mock bank behind loopback HTTPS in its own thread; `call(cmd, extra)` controls it. */
async function startBank(opts = {}) {
  const worker = new Worker(new URL('./fixtures/ebics-r0-bank.worker.mjs', import.meta.url), {
    workerData: { mockBankUrl: pathToFileURL(MOCK_BANK).href, certPath: TLS_CERT, keyPath: TLS_KEY, ...SUBSCRIBER, ...opts },
  });
  const port = await new Promise((resolve, reject) => {
    worker.once('error', reject);
    const onReady = (m) => {
      if (m.ready === true) {
        worker.off('message', onReady);
        resolve(m.port);
      }
    };
    worker.on('message', onReady);
  });
  let next = 0;
  const call = (cmd, extra = {}) =>
    new Promise((resolve) => {
      const id = (next += 1);
      const onMsg = (m) => {
        if (m.id === id) {
          worker.off('message', onMsg);
          resolve(m.value);
        }
      };
      worker.on('message', onMsg);
      worker.postMessage({ id, cmd, ...extra });
    });
  return { port, call, stop: () => worker.terminate() };
}

/** Attach the live wire exactly as `till up` does: env vars, then `resolveEbicsRuntime`. */
async function attachWire(keystorePath) {
  const prior = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    TILL_EBICS_RUNTIME: pathToFileURL(WIRE_ENTRY).href,
    TILL_EBICS_KEYSTORE_PATH: keystorePath,
    TILL_EBICS_KEYSTORE_PASSPHRASE: 'r0-synthetic-passphrase',
    TILL_EBICS_CA_FILE: TLS_CERT,
  });
  try {
    return await resolveEbicsRuntime();
  } finally {
    for (const k of ENV_KEYS) {
      if (prior[k] === undefined) delete process.env[k];
      else process.env[k] = prior[k];
    }
  }
}

test('R0: ceremony, reviewed pin, download, persist-process-receipt and the replay refusal, core to wire to mock bank over loopback TLS', { skip: SKIP ?? false }, async () => {
  const bank = await startBank({ requireActivation: true });
  const dir = mkdtempSync(join(tmpdir(), 'till-a36-r0-'));
  try {
    const t = setup();
    const ports = await attachWire(join(dir, 'keystore.v1'));
    const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ...ports });
    const iban = syntheticIban(4711);
    const accountId = must(createBankAccount(t.ctx, { name: 'ZKB Konto', iban, ledgerAccountId: t.acc('1020'), idempotencyKey: 'r0-ba' }), 'account').bankAccountId;
    const days = chain({ iban, firstSeq: 1, firstDate: '2026-10-01', opening: 250000, days: [[{ minor: 1200 }], [{ minor: -4000 }, { minor: 900 }], [{ minor: 10 }]] });
    // The bridge: statement 1 imported by hand before the channel went live.
    must(importCamt(t.ctx, { bankAccountId: accountId, xml: days[0].xml, idempotencyKey: 'r0-bridge' }), 'bridge');

    // §3 step 3: HEV, three certified pairs (the A005 private key dropped), INI, HIA.
    const url = `https://localhost:${bank.port}/ebicsweb`;
    const host = { url, hostId: SUBSCRIBER.hostId, partnerId: SUBSCRIBER.partnerId, userId: SUBSCRIBER.userId };
    const c = must(connectBankChannel(ctx, { host, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: 'r0-connect' }), 'connect');
    assert.equal(c.state, 'pending_bank_activation', 'both legs confirmed by the bank');
    // §3 step 5: before ZKB activates the subscriber, "Bankschlüssel abrufen" waits in words.
    const early = connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true });
    assert.equal(early.error, 'pending_bank_activation');
    await bank.call('activate');
    // §3 step 6: HPB; the hashes shown equal the bank's own (what ZKB's sheet would print); then the pin.
    const fetched = must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true }), 'fetch bank keys');
    const published = await bank.call('bankHashes');
    assert.equal(fetched.bankKeyHashes.certificateHashes.authentication, published.certificateHashes.authentication);
    assert.equal(fetched.bankKeyHashes.certificateHashes.encryption, published.certificateHashes.encryption);
    assert.equal(fetched.bankKeyHashes.keyHashes.encryption, published.keyHashes.encryption);
    must(connectBankChannel(ctx, { connectionId: c.connectionId, confirm: true, confirmBankKeys: true, expectedBankKeyHashes: fetched.bankKeyHashes }), 'pin');

    // §3 step 7: ZKB offers statements 1 (already bridged) and 2 and 3; one press.
    await bank.call('offer', { containerBase64: container([days[0].xml, days[1].xml, days[2].xml], { dataDescriptor: true }).toString('base64') });
    const s1 = must(syncBankChannel(ctx, { connectionId: c.connectionId, idempotencyKey: 'r0-press-1' }), 'press 1');
    assert.equal(s1.download.outcome, 'downloaded');
    assert.deepEqual(s1.statements.map((s) => [s.position.number, s.outcome]), [[1, 'already_imported'], [2, 'imported'], [3, 'imported']]);
    assert.equal(s1.receipt, 'positive');
    const receipts = await bank.call('receipts');
    assert.deepEqual(receipts.map((r) => r.receiptCode), [0], 'one positive receipt, sent after the commit');
    assert.equal(receipts[0].transactionId, s1.download.transactionId);
    // The second press: the bank has nothing new.
    const s2 = must(syncBankChannel(ctx, { connectionId: c.connectionId, idempotencyKey: 'r0-press-2' }), 'press 2');
    assert.equal(s2.download.outcome, 'no_data');
    const lines = t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_txn WHERE workspace_id = ?').get(t.workspaceId).n;
    assert.equal(lines, 4, 'statement 1 once (bridged), 2 and 3 once each');

    // W11: the genuine initialisation served again to a FRESH wire (a new process) is refused by the core.
    const replayedId = await bank.call('replayLastInit');
    assert.equal(replayedId, s1.download.transactionId);
    const fresh = await attachWire(join(dir, 'keystore.v1'));
    const ctx2 = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ...fresh });
    const files = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(t.workspaceId).n;
    const logRows = () => t.store.db.prepare('SELECT COUNT(*) AS n FROM ebics_order_log WHERE workspace_id = ?').get(t.workspaceId).n;
    const before = { files: files(), log: logRows() };
    const replay = syncBankChannel(ctx2, { connectionId: c.connectionId, idempotencyKey: 'r0-replay' });
    assert.equal(replay.ok, false, JSON.stringify(replay));
    assert.equal(replay.error, 'untrusted_response');
    assert.equal(replay.download.detail, 'replayed_transaction');
    assert.deepEqual({ files: files(), log: logRows() }, before, 'nothing persisted, no log row');
    assert.deepEqual((await bank.call('receipts')).length, 1, 'no receipt for the replay');
    assert.equal(must(getBankChannelStatus(ctx2, {}), 'status').channels[0].state, 'active');
  } finally {
    await bank.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R0: a wrong subscriber answers 091002 on both legs, which the core names init_refused', { skip: SKIP ?? false }, async () => {
  const bank = await startBank();
  const dir = mkdtempSync(join(tmpdir(), 'till-a36-r0b-'));
  try {
    const t = setup();
    const ports = await attachWire(join(dir, 'keystore.v1'));
    const ctx = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: t.ids, ...ports });
    const accountId = must(createBankAccount(t.ctx, { name: 'K', iban: syntheticIban(4712), ledgerAccountId: t.acc('1020'), idempotencyKey: 'r0b-ba' }), 'account').bankAccountId;
    const host = { url: `https://localhost:${bank.port}/ebicsweb`, hostId: SUBSCRIBER.hostId, partnerId: 'PARTNER99', userId: SUBSCRIBER.userId };
    const r = connectBankChannel(ctx, { host, routeBankAccountIds: [accountId], confirm: true, idempotencyKey: 'r0b' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'init_refused');
    assert.deepEqual(r.legs, { ini: '091002', hia: '091002' });
  } finally {
    await bank.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

if (SKIP !== null) {
  test(`R0 skipped: ${SKIP}`, { skip: SKIP }, () => {});
}
