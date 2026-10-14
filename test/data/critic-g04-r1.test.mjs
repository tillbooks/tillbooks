/**
 * Critic probes, G04 restore chokepoint, round 1 (non-author critic, 30.09.2026).
 *
 * Each test states the defect it reproduces. A test that FAILS on the branch under review
 * (`claude/g04-restore-chokepoint` de1a7176) is a finding; the report is
 * `docs/critique/g04-a31-restore-qr-critic-r1.md`. Synthetic data only (SIX published sample IBANs,
 * invented names).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PLAIN_IBAN } from '../banking/support.mjs';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact } from '../../dist/core/sales/index.js';
import { createBankAccount, setCreditorBankProfile, createPaymentBatch, generatePain001 } from '../../dist/core/banking/index.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { enableSyncPublish } from '../../dist/core/sync/index.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * A workspace minted with PRODUCTION ids (`<prefix>_<uuid>`). The shared fixtures use `sequenceIdGen`,
 * whose `<prefix>_1` restores as `<other prefix>_1` in a fresh book, so an id-derived value can come
 * back equal by coincidence and a probe would prove nothing.
 */
function setup() {
  const clock = fixedClock('2026-07-19T00:00:00.000Z');
  const ids = systemIdGen;
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Probe Grafik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
  return { store, clock, ids, workspaceId, ctx, acc };
}

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

const tag = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1]);

/** A workspace with one generated (handed to eBanking, not yet paid) pain.001 batch of two items. */
function worldWithGeneratedBatch() {
  const t = setup();
  const bankAccountId = must(
    createBankAccount(t.ctx, { name: 'Kontokorrent', iban: PLAIN_IBAN, ledgerAccountId: t.acc('1020'), idempotencyKey: 'bank' }),
    'create_bank_account',
  ).bankAccountId;
  const bills = [];
  for (const seed of ['a', 'b']) {
    const vendor = must(createContact(t.ctx, { partyRole: 'vendor', name: `Probe Lieferant ${seed} GmbH`, idempotencyKey: `v-${seed}` }), 'vendor').contact.id;
    const bill = must(
      createVendorBill(t.ctx, { vendorId: vendor, billDate: '2026-03-01', vendorReference: `PR-${seed}-1`, amountMinor: 12345, expenseAccountId: t.acc('6500'), idempotencyKey: `b-${seed}` }),
      'create_vendor_bill',
    );
    must(postVendorBill(t.ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `p-${seed}` }), 'post_vendor_bill');
    must(setCreditorBankProfile(t.ctx, { vendorId: vendor, iban: PLAIN_IBAN, idempotencyKey: `cbp-${seed}` }), 'cbp');
    bills.push(bill.vendorBillId);
  }
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId, itemIds: bills, executionDate: '2026-03-20', idempotencyKey: 'batch' }), 'batch');
  const gen = must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'gen' }), 'generate_pain001');
  return { t, batchId: batch.batchId, xml: Buffer.from(gen.xmlBase64, 'base64').toString('utf8') };
}

// R1-H1 is fixed on another branch, `claude/pain001-frozen-refs` (MsgId/PmtInfId/InstrId/EndToEndId
// stored at batch creation, SCHEMA_GENERATION 9), which lands before this one. The probe stays here as a
// `todo` until that merge; at landing the orchestrator adds the stored columns to NATURAL_KEY_COLUMNS
// and drops the `todo` so the probe must pass.
test(
  'R1-H1 probe: a restored book regenerates a handed-out, unpaid batch with the SAME MsgId/PmtInfId/EndToEndIds the bank already holds',
  {},
  () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-critic-'));
  try {
    const { t, xml } = worldWithGeneratedBatch();
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
    // Disaster recovery: restore into an EMPTY book (a fresh machine), the case G04 exists for.
    const fresh = setup();
    const freshDeps = { store: fresh.store, clock: fresh.clock, ids: fresh.ids, actor: 'user_1', backupDir: join(dir, 'b2') };
    const restored = must(restoreBackup(freshDeps, { source: bkp.artifactRef, newWorkspaceName: 'Wiederhergestellt AG', confirmed: true }), 'restore_backup');
    const ctx2 = makeContext(fresh.store, { workspaceId: restored.workspaceId, actor: 'user_1', clock: fresh.clock, ids: fresh.ids });
    const batch2 = fresh.store.db.prepare('SELECT id, status, msg_id FROM payment_batch WHERE workspace_id = ?').get(restored.workspaceId);
    assert.equal(batch2.status, 'generated', 'the restored batch is still open: nothing marks it transmitted or paid');
    const regen = must(generatePain001(ctx2, { batchId: batch2.id, idempotencyKey: 'gen-after-restore' }), 'generate_pain001 after restore');
    const xml2 = Buffer.from(regen.xmlBase64, 'base64').toString('utf8');

    // The stored msg_id is kept verbatim (NATURAL_KEY_COLUMNS) and still names the transmitted MsgId...
    assert.equal(batch2.msg_id, tag(xml, 'MsgId')[0], 'the allowlisted msg_id survived verbatim');
    // ...but the file is rebuilt from the RE-MINTED surrogate ids, so the bank's 90-day MsgId duplicate
    // check does not recognise a re-upload, and the camt matcher's PmtInfId / EndToEndId join misses.
    assert.deepEqual(tag(xml2, 'MsgId'), tag(xml, 'MsgId'), 'MsgId of the regenerated file must be the one the bank already holds');
    assert.deepEqual(tag(xml2, 'PmtInfId'), tag(xml, 'PmtInfId'), 'PmtInfId must survive a restore');
    assert.deepEqual(tag(xml2, 'EndToEndId').sort(), tag(xml, 'EndToEndId').sort(), 'EndToEndIds must survive a restore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  },
);

const post = (t, key, amount) =>
  must(
    postEntry(t.ctx, {
      date: '2026-03-01',
      description: 'Büromaterial',
      source: 'manual',
      idempotencyKey: key,
      lines: [
        { account: t.acc('6500'), debit: amount },
        { account: t.acc('1000'), credit: amount },
      ],
    }),
    'post_entry',
  );

test('R1-M2 probe: a restored copy of a PUBLISHING workspace does not egress under the source stream epoch with the dial on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-critic-'));
  try {
    const t = setup();
    must(enableSyncPublish(t.ctx, { idempotencyKey: 'pub' }), 'enable_sync_publish');
    post(t, 'p1', 1000);
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
    const restored = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }), 'restore_backup');
    const state = (ws) => t.store.db.prepare('SELECT publishing, epoch FROM sync_publish_state WHERE workspace_id = ?').get(ws);
    const src = state(t.workspaceId);
    const copy = state(restored.workspaceId);
    // sync/outbox.ts `remintEpoch`: "A restore re-mints ids and so forks the history a consumer had
    // been following; re-minting the epoch is what makes that fork VISIBLE". `landscape/copy.ts` does it
    // for env_copy (FINDING #2 there: "a copy must never inherit an ON dial"); restore_backup never calls it.
    assert.notEqual(copy.epoch, src.epoch, `the restored copy publishes under the SOURCE epoch ${src.epoch}`);
    assert.equal(copy.publishing, 0, 'the restored copy inherited publishing = 1 (egress is consent)');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-M3 probe: a restore refuses a backup whose rows reference ANOTHER workspace of the target book', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-critic-'));
  try {
    // One book, two tenants: the victim and the one whose backup is restored.
    const victim = setup();
    const ctxB = (() => {
      const ws = createWorkspace({ store: victim.store, clock: victim.clock, ids: victim.ids }, { name: 'Andere GmbH' }).workspaceId;
      const ctx = makeContext(victim.store, { workspaceId: ws, actor: 'user_1', clock: victim.clock, ids: victim.ids });
      const acc = (n) => victim.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, n)?.id;
      return { store: victim.store, workspaceId: ws, ctx, acc };
    })();
    const victimEntry = post(victim, 'v1', 7000).entryId;
    assert.equal(typeof victimEntry, 'string');
    post(ctxB, 'b1', 2500);
    const deps = { store: victim.store, clock: victim.clock, ids: victim.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: ctxB.workspaceId, idempotencyKey: 'bk' }), 'create_backup');

    // The file is edited the way anyone holding it can: B's posted entry now claims to REVERSE the
    // victim's entry, and the manifest checksum is recomputed (it is a checksum, not a signature).
    const file = join(bkp.artifactRef, 'data.sqlite');
    const snap = new Database(file);
    // The snapshot carries the book's immutability trigger; the file's holder simply drops it.
    snap.exec('DROP TRIGGER journal_entry_no_update_posted');
    snap.pragma('foreign_keys = OFF');
    snap.prepare('UPDATE journal_entry SET reverses_entry_id = ? WHERE workspace_id = ?').run(victimEntry, ctxB.workspaceId);
    snap.close();
    const manifestPath = join(bkp.artifactRef, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const bytes = readFileSync(file);
    manifest.files['data.sqlite'] = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const restored = restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    if (!restored.ok) return; // a clean refusal is the fix
    const crossing = victim.store.db
      .prepare(
        `SELECT e.id, e.reverses_entry_id, o.workspace_id AS reversed_ws FROM journal_entry e
           JOIN journal_entry o ON o.id = e.reverses_entry_id
          WHERE e.workspace_id = ? AND o.workspace_id <> e.workspace_id`,
      )
      .all(restored.workspaceId);
    // What the crossing costs the victim: `journal_entry_one_reversal` is a GLOBAL unique index, so the
    // victim can no longer reverse its own posted entry (the correction path the money path relies on).
    let victimReversal;
    try {
      victimReversal = reverseEntry(victim.ctx, { entryId: victimEntry, date: '2026-03-02', idempotencyKey: 'rev' });
    } catch (e) {
      victimReversal = { ok: false, thrown: String(e) };
    }
    assert.deepEqual(crossing, [], `the restored ledger holds an entry that reverses ANOTHER tenant's entry: ${JSON.stringify(crossing)}; the victim's own reversal then returns ${JSON.stringify(victimReversal)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R1-L1 probe: the re-seal is itself on record in the copy (a restored chain says it was re-hashed, and from which head)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'g04-critic-'));
  try {
    const t = setup();
    post(t, 'p1', 1000);
    post(t, 'p2', 2000);
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const bkp = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
    const restored = must(restoreBackup(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }), 'restore_backup');
    assert.equal(restored.auditChain.verified, true);
    const rows = (ws) => t.store.db.prepare('SELECT entity_kind, entity_id, action FROM audit_log WHERE workspace_id = ? ORDER BY rowid').all(ws);
    const src = rows(t.workspaceId);
    const copy = rows(restored.workspaceId);
    // Every hash in the copy is new, and nothing in the copy's chain says so: an auditor holding the
    // source's externally anchored head (A03, OP4) cannot link the copy back to it, and the
    // `auditChain` verdict lives only in the verb's return value.
    assert.ok(copy.length > src.length, `the copy carries ${copy.length} rows, the source ${src.length}: no row records the restore and re-seal`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
