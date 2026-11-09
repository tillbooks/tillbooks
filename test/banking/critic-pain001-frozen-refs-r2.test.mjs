// NON-AUTHOR critic probes, round 2, for `claude/pain001-frozen-refs` (A18 F9 + D148, generation 9).
// Report: docs/critique/pain001-frozen-refs-critic-r2.md.
//
// Every probe asserts a property the branch CLAIMS: the pain.001 is a pure function of values frozen at
// batch creation, so a restore, an env_copy, a rename or an edit between two generations reproduces the
// identical file. A red probe is a finding; a green one is a hole the critic tried and found closed.
//
// SYNTHETIC DATA ONLY: every IBAN is invented here with a correct ISO 7064 check digit; every name is
// invented. uuid ids (systemIdGen) throughout, so no fixture coincidence of sequence ids can hide an
// ordering or a derivation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact, mergeContacts } from '../../dist/core/sales/index.js';
import {
  createBankAccount,
  updateBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
  discardPaymentBatch,
} from '../../dist/core/banking/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { envCreate, envCopy } from '../../dist/core/landscape/index.js';

const AT = '2026-09-30T08:00:00.000Z';

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function synthIban(iid, account) {
  const bban = `${iid}${account}`;
  const numeric = `${bban}CH00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return `CH${String(98 - rem).padStart(2, '0')}${bban}`;
}
const DEBTOR_IBAN = synthIban('09000', '000000000001');
const OTHER_DEBTOR_IBAN = synthIban('09000', '000000000002');
const vendorIban = (n) => synthIban('09000', String(800000000000 + n));

function world({ location, store: shared, name = 'Erfundene Druckerei GmbH' } = {}) {
  const clock = fixedClock(AT);
  const ids = systemIdGen;
  const store = shared ?? new SqliteStore({ clock, ...(location !== undefined ? { location } : {}) });
  const workspaceId = must(createWorkspace({ store, clock, ids }, { name }), 'create_workspace').workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
  const bank = must(createBankAccount(ctx, { name: 'Zahlkonto', iban: DEBTOR_IBAN, ledgerAccountId: acc('1020'), idempotencyKey: 'bank' }), 'bank').bankAccountId;
  return { store, clock, ids, workspaceId, ctx, acc, bank };
}

let n = 0;
function vendorWithBill(w, tag) {
  const k = ++n;
  const vendorId = must(createContact(w.ctx, { partyRole: 'vendor', name: `Erfunden ${tag} AG`, idempotencyKey: `v-${tag}-${k}` }), 'contact').contact.id;
  const bill = must(
    createVendorBill(w.ctx, { vendorId, billDate: '2026-09-01', vendorReference: `SYN-${tag}`, amountMinor: 10_000 + k * 101, expenseAccountId: w.acc('6500'), idempotencyKey: `bill-${tag}-${k}` }),
    'bill',
  );
  must(postVendorBill(w.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${tag}-${k}` }), 'post');
  must(setCreditorBankProfile(w.ctx, { vendorId, iban: vendorIban(k), idempotencyKey: `cbp-${tag}-${k}` }), 'cbp');
  return { vendorId, billId: bill.vendorBillId };
}

/** A batch of `count` bills handed in a shuffled order; generated unless told not to. */
function seed(w, tag, { count = 8, generate = true } = {}) {
  const bills = Array.from({ length: count }, (_, i) => vendorWithBill(w, `${tag}${i}`).billId);
  const order = [...bills].reverse();
  [order[0], order[Math.floor(count / 2)]] = [order[Math.floor(count / 2)], order[0]];
  const batchId = must(createPaymentBatch(w.ctx, { bankAccountId: w.bank, itemIds: order, executionDate: '2026-10-05', idempotencyKey: `batch-${tag}` }), 'batch').batchId;
  if (!generate) return { batchId, xml: null };
  return { batchId, xml: regen(w.ctx, batchId, `gen-${tag}`) };
}

function regen(ctx, batchId, key) {
  return Buffer.from(must(generatePain001(ctx, { batchId, idempotencyKey: key }), 'generate_pain001').xmlBase64, 'base64').toString('utf8');
}

// --- D1/D2: byte-identity after restore (beside, and into a fresh store) and after env_copy -------------

test('R2-D1: uuid ids, shuffled items, restored under ANOTHER workspace name beside the original and into a fresh store: byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-r2-d1-'));
  try {
    const w = world();
    const { xml } = seed(w, 'd1');
    const deps = { store: w.store, clock: w.clock, ids: systemIdGen, actor: 'user_1', backupDir: join(dir, 'b') };
    const bk = must(createBackup(deps, { workspaceId: w.workspaceId, idempotencyKey: 'bk' }), 'backup');
    for (const target of [w.store, new SqliteStore({ clock: w.clock })]) {
      const r = must(restoreBackup({ ...deps, store: target }, { source: bk.artifactRef, newWorkspaceName: 'Ganz Anderer Name AG', confirmed: true }), 'restore');
      const ctx = makeContext(target, { workspaceId: r.workspaceId, actor: 'user_1', clock: w.clock, ids: systemIdGen });
      const batchId = target.db.prepare('SELECT id FROM payment_batch WHERE workspace_id = ?').get(r.workspaceId).id;
      assert.equal(regen(ctx, batchId, 'd1-regen'), xml);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-D2: uuid ids, shuffled items, instance env_copy (raw): the copy regenerates byte-identical', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-r2-d2-'));
  try {
    let sourceXml = null;
    const deps = {
      supportDir: dir,
      environmentsRoot: join(dir, 'environments'),
      mainDbPath: join(dir, 'main', 'till.db'),
      actor: 'owner',
      now: () => AT,
      ids: systemIdGen,
      clock: { now: () => AT },
      seeders: {
        paid: (path) => {
          const w = world({ location: path });
          sourceXml = seed(w, 'd2').xml;
          w.store.close();
        },
        minimal: (p) => new SqliteStore({ location: p }).close(),
      },
    };
    must(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'paid', tierRank: 250, confirmed: true }), 'env src');
    must(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }), 'env dst');
    must(envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: 'raw', confirmed: true }), 'env_copy');
    const store = new SqliteStore({ location: join(dir, 'environments', 'dst', 'till.db'), clock: fixedClock(AT) });
    try {
      const ws = store.db.prepare('SELECT id FROM workspace ORDER BY rowid LIMIT 1').get().id;
      const batchId = store.db.prepare('SELECT id FROM payment_batch WHERE workspace_id = ?').get(ws).id;
      const ctx = makeContext(store, { workspaceId: ws, actor: 'owner', clock: fixedClock(AT), ids: systemIdGen });
      assert.equal(regen(ctx, batchId, 'd2-regen'), sourceXml);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- D3: the last value the file still reads live ---------------------------------------------------------

test('R2-D3: editing the debtor account IBAN after generation never yields a second, different file under the same MsgId', () => {
  const w = world();
  const { batchId, xml } = seed(w, 'd3', { count: 2 });
  // The account has no opening balance, so update_bank_account accepts an IBAN change.
  const upd = updateBankAccount(w.ctx, { bankAccountId: w.bank, iban: OTHER_DEBTOR_IBAN, idempotencyKey: 'd3-iban' });
  if (!upd.ok) return; // refusing the edit while a generated batch names the account also closes the hole
  const again = generatePain001(w.ctx, { batchId, idempotencyKey: 'd3-regen' });
  if (!again.ok) return; // refusing to regenerate under a changed debtor also closes it
  const text = Buffer.from(again.xmlBase64, 'base64').toString('utf8');
  assert.equal(text, xml, `same MsgId, different DbtrAcct: ${text.match(/<DbtrAcct>.*?<\/DbtrAcct>/)?.[0]}`);
});

// --- D4/D5: the creditor-name rule at creation and in the backfill ----------------------------------------

test('R2-D4: a merged-away vendor is paid under its SURVIVOR name, snapshotted at creation', () => {
  const w = world();
  const a = vendorWithBill(w, 'd4a');
  const survivor = must(createContact(w.ctx, { partyRole: 'vendor', name: 'Überlebende Holding AG', idempotencyKey: 'd4-surv' }), 'survivor').contact.id;
  const merged = mergeContacts(w.ctx, { sourceId: a.vendorId, targetId: survivor, idempotencyKey: 'd4-merge' });
  must(merged, 'merge');
  // The merge re-points the bill; the survivor needs its own creditor profile to be batched.
  must(setCreditorBankProfile(w.ctx, { vendorId: survivor, iban: vendorIban(9999), idempotencyKey: 'd4-cbp' }), 'survivor cbp');
  const res = createPaymentBatch(w.ctx, { bankAccountId: w.bank, itemIds: [a.billId], executionDate: '2026-10-05', idempotencyKey: 'd4-batch' });
  must(res, 'create_payment_batch after merge');
  const name = w.store.db.prepare('SELECT creditor_name FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?').get(w.workspaceId, res.batchId).creditor_name;
  assert.equal(name, 'Überlebende Holding AG');
});

/** Rewind a file-backed book to the generation-8 shape for the D148/C2 columns and the generation-9 DDL. */
function rewind(path, fn) {
  const raw = new Database(path);
  try {
    raw.pragma('foreign_keys = OFF');
    for (const x of raw.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'payment_batch%frozen%' OR name LIKE 'payment_batch%_ref_unique'").all()) {
      raw.exec(`DROP ${x.type === 'trigger' ? 'TRIGGER' : 'INDEX'} IF EXISTS "${x.name}"`);
    }
    raw.exec("UPDATE payment_batch SET msg_id = NULL WHERE status = 'draft' OR (status = 'discarded' AND ctrl_sum_minor IS NULL)");
    raw.exec('UPDATE payment_batch SET pmt_inf_id = NULL, debtor_name = NULL');
    raw.exec('UPDATE payment_batch_item SET instr_id = NULL, end_to_end_id = NULL, seq = NULL, creditor_name = NULL');
    fn?.(raw);
    raw.pragma('user_version = 8');
  } finally {
    raw.close();
  }
}

test('R2-D5: the backfill never freezes an EMPTY creditor name on a draft: generation refuses creditor_name_missing, as creation would', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-r2-d5-'));
  try {
    const path = join(dir, 'book.db');
    const w = world({ location: path });
    const { batchId } = seed(w, 'd5', { count: 2, generate: false });
    const ws = w.workspaceId;
    const vendor = w.store.db.prepare('SELECT vendor_id FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ? LIMIT 1').get(ws, batchId).vendor_id;
    w.store.close();
    rewind(path, (raw) => raw.prepare("UPDATE contact SET name = '  ' WHERE id = ?").run(vendor));
    const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
    try {
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
      const res = generatePain001(ctx, { batchId, idempotencyKey: 'd5-gen' });
      assert.equal(res.ok, false, 'a whitespace creditor name must not reach a file');
      assert.equal(res.error, 'creditor_name_missing');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-D6: generation 9 on a book with draft, generated, paid and discarded runs: every value frozen, seq dense 1..n per batch, each file unchanged, idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-r2-d6-'));
  try {
    const path = join(dir, 'book.db');
    const w = world({ location: path });
    const draft = seed(w, 'd6d', { count: 3, generate: false });
    const gen = seed(w, 'd6g', { count: 5 });
    const paid = seed(w, 'd6p', { count: 3 });
    must(markBatchPaid(w.ctx, { batchId: paid.batchId, confirmation: true, valueDate: '2026-10-05', idempotencyKey: 'd6-paid' }), 'paid');
    const disc = seed(w, 'd6x', { count: 2, generate: false });
    must(discardPaymentBatch(w.ctx, { batchId: disc.batchId, idempotencyKey: 'd6-disc' }), 'discard');
    const ws = w.workspaceId;
    const paidXml = paid.xml;
    w.store.close();
    rewind(path);

    const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
    try {
      const rows = () => store.db.prepare('SELECT batch_id, seq, instr_id, end_to_end_id, creditor_name FROM payment_batch_item WHERE workspace_id = ? ORDER BY batch_id, seq').all(ws);
      const before = rows();
      for (const r of before) for (const k of ['seq', 'instr_id', 'end_to_end_id', 'creditor_name']) assert.notEqual(r[k], null, `${k} frozen`);
      const byBatch = new Map();
      for (const r of before) byBatch.set(r.batch_id, [...(byBatch.get(r.batch_id) ?? []), r.seq]);
      for (const [, seqs] of byBatch) assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq is dense 1..n');
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
      assert.equal(regen(ctx, gen.batchId, 'd6-g'), gen.xml, 'the generated run renders what it rendered before');
      assert.match(regen(ctx, draft.batchId, 'd6-d'), /<Cdtr><Nm>Erfunden d6d\d AG<\/Nm><\/Cdtr>/, 'the draft generates under its vendor names');
      assert.equal(store.db.prepare('SELECT debtor_name FROM payment_batch WHERE workspace_id = ? AND id = ?').get(ws, paid.batchId).debtor_name, 'Erfundene Druckerei GmbH');
      assert.ok(paidXml.includes('<Dbtr><Nm>Erfundene Druckerei GmbH</Nm></Dbtr>'), 'premise');
      const step = DATA_MIGRATIONS.find((m) => m.generation === 9);
      store.db.transaction(() => step.apply(store.db))();
      assert.deepEqual(rows(), before, 'a second apply is a no-op');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
