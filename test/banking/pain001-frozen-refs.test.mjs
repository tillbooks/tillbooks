// A18 pain.001: the four bank references are FROZEN on the rows, never re-derived from a database id.
//
// THE DEFECT (HIGH, a batch could be paid twice): `buildPain001Xml` minted MsgId and PmtInfId from
// `payment_batch.id` and InstrId/EndToEndId from `payment_batch_item.id` on every render. A G04 restore
// and an `env_copy` (which reuses restore) re-mint every surrogate id, so the same batch regenerated in
// the restored book carried a NEW MsgId. SIX IG SPS 2025 v2.2 §3.8: Swiss institutions deduplicate on
// MsgId ("at least 90 days"), so a re-upload of the same payments would NOT be recognised as a duplicate
// and would execute a second time.
//
// Each test below was run against develop 750eb65f FIRST and failed there (the report on branch
// claude/pain001-frozen-refs quotes the failures), then passes with the fix:
//   (a) restore and env_copy regenerate byte-identical XML, all four references included;
//   (b) the generation-9 backfill freezes an existing book at the values its XML already carried,
//       and is idempotent;
//   (c) a batch created after an id-remapping restore never collides with a frozen reference;
//   (d) the append-only and idempotency invariants hold over the new columns;
//   (e) §H-TENANT: the collision check is scoped to the workspace.
//
// SYNTHETIC DATA ONLY: every IBAN below is invented here and given a correct ISO 7064 check digit by
// `synthIban`; every name is invented. No real bank data, no EBICS identifiers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { DATA_MIGRATIONS } from '../../dist/core/store/migrations.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen, systemIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createVendorBill, postVendorBill } from '../../dist/core/purchase/index.js';
import { createContact, updateContact, anonymiseContact } from '../../dist/core/sales/index.js';
import {
  createBankAccount,
  updateBankAccount,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  validatePain001,
  discardPaymentBatch,
} from '../../dist/core/banking/index.js';
import { compactReference } from '../../dist/core/banking/pain001.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { envCreate, envCopy } from '../../dist/core/landscape/index.js';

const AT = '2026-09-30T08:00:00.000Z';
const WS_NAME = 'Synthetik Werkstatt GmbH';

/**
 * Eight bills handed to the batch shuffled, under production (uuid) ids: insertion order is then neither
 * id order nor reference order, so a restore that brings the items back in any other order is caught
 * (critic r1 C2: two sequence-id items happened to sort in insertion order and hid it).
 */
const EIGHT = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const SHUFFLED = [5, 2, 7, 0, 6, 3, 1, 4];

/** SIX IG SPS 2025 v2.2 §3.2 (and the vendored XSD's `Max35Text_pain001_ch`): 1..35, restricted set. */
const SIX_REFERENCE = /^[A-Za-z0-9'()+,\-./:? ]{1,35}$/;

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/** An invented Swiss IBAN with a correct ISO 7064 mod-97 check digit (never a real account). */
function synthIban(iid, account) {
  const bban = `${iid}${account}`;
  const numeric = `${bban}CH00`.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const ch of numeric) rem = (rem * 10 + Number(ch)) % 97;
  return `CH${String(98 - rem).padStart(2, '0')}${bban}`;
}
// IID 09000 is outside the QR-IID range 30000 to 31999, so these are plain IBANs.
const DEBTOR_IBAN = synthIban('09000', '000000000001');
const vendorIban = (n) => synthIban('09000', String(900000000000 + n));

/** A workspace on its own store. `location` makes it a file-backed book. */
function world({ location, ids = sequenceIdGen(), store: shared } = {}) {
  const clock = fixedClock(AT);
  const store = shared ?? new SqliteStore({ clock, ...(location !== undefined ? { location } : {}) });
  const workspaceId = must(createWorkspace({ store, clock, ids }, { name: WS_NAME }), 'create_workspace').workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  const acc = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;
  return { store, clock, ids, workspaceId, ctx, acc };
}

function mkBank(w) {
  return must(
    createBankAccount(w.ctx, { name: 'Zahlkonto', iban: DEBTOR_IBAN, ledgerAccountId: w.acc('1020'), idempotencyKey: 'bank' }),
    'create_bank_account',
  ).bankAccountId;
}

let seq = 0;
/**
 * Posted vendor bills (two unless `parts` says otherwise) with creditor profiles, drafted into one batch
 * in `order` (indexes into the bills, default as created); generated unless told not to.
 */
function seedBatch(ctx, acc, bankAccountId, tag, { generate = true, parts = ['a', 'b'], order } = {}) {
  const bills = [];
  for (const part of parts) {
    const n = ++seq;
    const vendorId = must(
      createContact(ctx, { partyRole: 'vendor', name: `Erfunden ${tag}${part} AG`, idempotencyKey: `v-${tag}-${part}-${n}` }),
      'create_contact',
    ).contact.id;
    const bill = must(
      createVendorBill(ctx, {
        vendorId,
        billDate: '2026-09-01',
        vendorReference: `SYN-${tag}-${part}`,
        amountMinor: 12_345 + n,
        expenseAccountId: acc('6500'),
        idempotencyKey: `bill-${tag}-${part}-${n}`,
      }),
      'create_vendor_bill',
    );
    must(postVendorBill(ctx, { vendorBillId: bill.vendorBillId, idempotencyKey: `post-${tag}-${part}-${n}` }), 'post_vendor_bill');
    must(setCreditorBankProfile(ctx, { vendorId, iban: vendorIban(n), idempotencyKey: `cbp-${tag}-${part}-${n}` }), 'set_creditor_bank_profile');
    bills.push(bill.vendorBillId);
  }
  const batch = must(
    createPaymentBatch(ctx, {
      bankAccountId,
      itemIds: order === undefined ? bills : order.map((i) => bills[i]),
      executionDate: '2026-10-05',
      idempotencyKey: `batch-${tag}`,
    }),
    'create_payment_batch',
  );
  if (!generate) return { batchId: batch.batchId, xml: null };
  const gen = must(generatePain001(ctx, { batchId: batch.batchId, idempotencyKey: `gen-${tag}` }), 'generate_pain001');
  return { batchId: batch.batchId, xml: Buffer.from(gen.xmlBase64, 'base64').toString('utf8') };
}

function regenerate(ctx, batchId, key) {
  const gen = must(generatePain001(ctx, { batchId, idempotencyKey: key }), 'generate_pain001 (regen)');
  return Buffer.from(gen.xmlBase64, 'base64').toString('utf8');
}

/** The four references exactly as the produced text carries them. */
function refsOf(xml) {
  const all = (tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);
  return { MsgId: all('MsgId'), PmtInfId: all('PmtInfId'), InstrId: all('InstrId'), EndToEndId: all('EndToEndId') };
}

function batchIdsOf(store, workspaceId) {
  return store.db.prepare('SELECT id FROM payment_batch WHERE workspace_id = ? ORDER BY rowid').all(workspaceId).map((r) => r.id);
}

function tmp(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- (a) restore and env_copy -----------------------------------------------------------------------

test('(a) a G04 restore re-mints every id, and the regenerated pain.001 is byte-identical, all four references included', () => {
  const dir = tmp('pain001-frozen-restore-');
  try {
    const w = world({ ids: systemIdGen });
    const bank = mkBank(w);
    const original = seedBatch(w.ctx, w.acc, bank, 'r', { parts: EIGHT, order: SHUFFLED });

    // systemIdGen for the restore, so every re-minted id is a fresh uuid and the id-derived value moves.
    const deps = { store: w.store, clock: w.clock, ids: systemIdGen, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = must(createBackup(deps, { workspaceId: w.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
    // Under ANOTHER name: the file's InitgPty/Dbtr name is frozen on the batch too (critic r1 C2).
    const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: `${WS_NAME} (Kopie)`, confirmed: true }), 'restore_backup');

    const [restoredBatch] = batchIdsOf(w.store, restored.workspaceId);
    assert.ok(restoredBatch !== undefined && restoredBatch !== original.batchId, 'premise: the restore re-minted the batch id');

    const ctx2 = makeContext(w.store, { workspaceId: restored.workspaceId, actor: 'user_1', clock: w.clock, ids: systemIdGen });
    const again = regenerate(ctx2, restoredBatch, 'regen-after-restore');
    assert.deepEqual(refsOf(again), refsOf(original.xml), 'MsgId/PmtInfId/InstrId/EndToEndId must be the ones the bank already saw');
    assert.equal(again, original.xml, 'the restored book regenerates the identical file, so a re-upload is caught as a duplicate');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(a) an env_copy (instance, raw) regenerates the byte-identical pain.001 in the copy', () => {
  const dir = tmp('pain001-frozen-envcopy-');
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
          const w = world({ location: path, ids: systemIdGen });
          const bank = mkBank(w);
          sourceXml = seedBatch(w.ctx, w.acc, bank, 'e', { parts: EIGHT, order: SHUFFLED }).xml;
          w.store.close();
        },
        minimal: (p) => new SqliteStore({ location: p }).close(),
      },
    };
    must(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'paid', tierRank: 250, confirmed: true }), 'env_create src');
    must(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }), 'env_create dst');
    must(envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: 'raw', confirmed: true }), 'env_copy');
    assert.ok(typeof sourceXml === 'string', 'premise: the source generated a file');

    const store = new SqliteStore({ location: join(dir, 'environments', 'dst', 'till.db'), clock: fixedClock(AT) });
    try {
      const ws = store.db.prepare('SELECT id FROM workspace ORDER BY rowid LIMIT 1').get().id;
      const [batchId] = batchIdsOf(store, ws);
      const ctx = makeContext(store, { workspaceId: ws, actor: 'owner', clock: fixedClock(AT), ids: systemIdGen });
      const again = regenerate(ctx, batchId, 'regen-in-copy');
      assert.deepEqual(refsOf(again), refsOf(sourceXml), 'the copy carries the references the source already handed out');
      assert.equal(again, sourceXml, 'the copy regenerates the identical file');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (b) the backfill ---------------------------------------------------------------------------------

/** Every column of `table` in a raw db. */
function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).map((c) => c.name);
}

/**
 * Rewind a file-backed book to the pre-fix generation-8 shape: the frozen columns empty (where they
 * exist), `msg_id` as develop wrote it (set at generation, NULL on a draft), no generation-9 index or
 * trigger, and `user_version = 8`. On develop itself the new columns do not exist and 8 is current.
 */
function rewindToGeneration8(path, { msgIdOverride } = {}) {
  const raw = new Database(path);
  try {
    for (const t of raw.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'payment_batch%frozen%' OR name LIKE 'payment_batch%_ref_unique'").all()) {
      raw.exec(`DROP ${t.type === 'trigger' ? 'TRIGGER' : 'INDEX'} IF EXISTS "${t.name}"`);
    }
    const bCols = columnsOf(raw, 'payment_batch');
    const iCols = columnsOf(raw, 'payment_batch_item');
    raw.exec("UPDATE payment_batch SET msg_id = NULL WHERE status = 'draft'");
    if (bCols.includes('pmt_inf_id')) raw.exec('UPDATE payment_batch SET pmt_inf_id = NULL');
    if (bCols.includes('debtor_name')) raw.exec('UPDATE payment_batch SET debtor_name = NULL');
    if (bCols.includes('debtor_iban')) raw.exec('UPDATE payment_batch SET debtor_iban = NULL');
    if (bCols.includes('generated_at')) raw.exec('UPDATE payment_batch SET generated_at = NULL');
    if (iCols.includes('instr_id')) raw.exec('UPDATE payment_batch_item SET instr_id = NULL, end_to_end_id = NULL');
    if (iCols.includes('seq')) raw.exec('UPDATE payment_batch_item SET seq = NULL');
    if (iCols.includes('creditor_name')) raw.exec('UPDATE payment_batch_item SET creditor_name = NULL');
    for (const [id, value] of Object.entries(msgIdOverride ?? {})) {
      raw.prepare('UPDATE payment_batch SET msg_id = ? WHERE id = ?').run(value, id);
    }
    raw.pragma('user_version = 8');
  } finally {
    raw.close();
  }
}

function frozenRows(store, workspaceId) {
  const b = store.db.prepare('SELECT * FROM payment_batch WHERE workspace_id = ? ORDER BY rowid').all(workspaceId);
  const i = store.db.prepare('SELECT * FROM payment_batch_item WHERE workspace_id = ? ORDER BY rowid').all(workspaceId);
  return {
    batches: b.map((r) => ({ id: r.id, msg_id: r.msg_id, pmt_inf_id: r.pmt_inf_id, debtor_name: r.debtor_name, debtor_iban: r.debtor_iban, generated_at: r.generated_at })),
    items: i.map((r) => ({ id: r.id, batch_id: r.batch_id, vendor_id: r.vendor_id, instr_id: r.instr_id, end_to_end_id: r.end_to_end_id, seq: r.seq, creditor_name: r.creditor_name })),
  };
}

test('(b) the generation-9 backfill freezes every existing batch at the values its XML already carried, and is idempotent', () => {
  const dir = tmp('pain001-frozen-backfill-');
  try {
    const path = join(dir, 'book.db');
    const w = world({ location: path });
    const bank = mkBank(w);
    const sent = seedBatch(w.ctx, w.acc, bank, 'sent');
    const draft = seedBatch(w.ctx, w.acc, bank, 'draft', { generate: false });
    const ws = w.workspaceId;
    w.store.close();

    rewindToGeneration8(path);

    const reopened = new SqliteStore({ location: path, clock: fixedClock(AT) });
    let after;
    try {
      assert.equal(reopened.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
      after = frozenRows(reopened, ws);
      const byId = Object.fromEntries(after.batches.map((b) => [b.id, b]));
      assert.equal(byId[sent.batchId]?.msg_id, compactReference('M', sent.batchId), 'a sent batch keeps the MsgId the bank saw');
      assert.equal(byId[sent.batchId]?.pmt_inf_id, compactReference('P', sent.batchId));
      assert.equal(byId[draft.batchId]?.msg_id, compactReference('M', draft.batchId), 'a draft is frozen too, before any id can move');
      assert.equal(byId[draft.batchId]?.pmt_inf_id, compactReference('P', draft.batchId));
      assert.equal(byId[sent.batchId]?.debtor_name, WS_NAME, 'the debtor name is frozen by the renderer\'s own rule');
      assert.equal(byId[sent.batchId]?.debtor_iban, DEBTOR_IBAN, 'the debtor IBAN is frozen from the account row (critic r2 R2-1)');
      assert.ok(byId[sent.batchId]?.generated_at !== null, 'a generated batch is stamped as having had a file (critic r3 R3-2)');
      assert.equal(byId[draft.batchId]?.generated_at, null, 'a draft is not');
      const position = new Map();
      for (const it of after.items) {
        assert.equal(it.instr_id, compactReference('I', it.id));
        assert.equal(it.end_to_end_id, compactReference('E', it.id));
        const expected = (position.get(it.batch_id) ?? 0) + 1;
        position.set(it.batch_id, expected);
        assert.equal(it.seq, expected, 'the position is frozen at the rowid order the renderer used (critic r1 C2)');
        const vendorName = reopened.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(ws, it.vendor_id).name;
        assert.equal(it.creditor_name, vendorName, 'the creditor name is frozen by the renderer\'s own rule (D148)');
      }

      const ctx = makeContext(reopened, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
      assert.equal(regenerate(ctx, sent.batchId, 'regen-after-backfill'), sent.xml, 'the backfilled book renders the file it rendered before');

      // Idempotent: applying the generation-9 step again changes nothing.
      const step = DATA_MIGRATIONS.find((m) => m.generation === 9);
      assert.ok(step !== undefined, 'generation 9 is the frozen-references backfill');
      reopened.db.transaction(() => step.apply(reopened.db))();
      assert.deepEqual(frozenRows(reopened, ws), after, 'a second backfill is a no-op');
    } finally {
      reopened.close();
    }

    const third = new SqliteStore({ location: path, clock: fixedClock(AT) });
    try {
      assert.deepEqual(frozenRows(third, ws), after, 'a re-open does not re-run the backfill');
    } finally {
      third.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(b) the backfill keeps a stored MsgId the id no longer derives (a book restored before this fix), and replaces a pre-F2 one', () => {
  const dir = tmp('pain001-frozen-backfill-kept-');
  try {
    const path = join(dir, 'book.db');
    const w = world({ location: path });
    const bank = mkBank(w);
    const restoredEarlier = seedBatch(w.ctx, w.acc, bank, 'kept');
    const preF2 = seedBatch(w.ctx, w.acc, bank, 'legacy');
    const ws = w.workspaceId;
    w.store.close();

    // A develop-era restore copied msg_id verbatim while it re-minted the id: the stored value is the
    // MsgId the ORIGINAL book handed to the bank. Its core is the original id's base36 encoding.
    const originalMsg = compactReference('M', 'pbatch_0f4c2d6e-9a1b-4c3d-8e7f-a1b2c3d4e5f6');
    rewindToGeneration8(path, { msgIdOverride: { [restoredEarlier.batchId]: originalMsg, [preF2.batchId]: `PB-${preF2.batchId}` } });

    const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
    try {
      const byId = Object.fromEntries(frozenRows(store, ws).batches.map((b) => [b.id, b]));
      assert.equal(byId[restoredEarlier.batchId]?.msg_id, originalMsg, 'the MsgId already transmitted survives the backfill');
      assert.equal(byId[restoredEarlier.batchId]?.pmt_inf_id, `P${originalMsg.slice(1)}`, 'its PmtInfId follows the same original id');
      assert.equal(byId[preF2.batchId]?.msg_id, compactReference('M', preF2.batchId), 'a pre-F2 value is not a reference the XML ever carried; the derived one is');
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
      assert.deepEqual(refsOf(regenerate(ctx, restoredEarlier.batchId, 'regen-kept')).MsgId, [originalMsg]);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (c) no collision after an id remap -------------------------------------------------------------

test('(c) a batch created after an id-remapping restore never shares a reference with a frozen one', () => {
  const dir = tmp('pain001-frozen-collision-');
  try {
    // The source book: sequence ids, so its batch is `pbatch_1` and its MsgId is "M1".
    const src = world();
    const srcBank = mkBank(src);
    const frozen = seedBatch(src.ctx, src.acc, srcBank, 'c1');
    assert.deepEqual(refsOf(frozen.xml).MsgId, ['M1'], 'premise: the source batch carries MsgId M1');

    // Restored into a fresh store whose id generator starts over: the restore re-mints the batch as
    // `payment_batch_1`, and the next batch the restored book creates is `pbatch_1` again, whose
    // id-derived MsgId is "M1": exactly the collision the frozen reference must not allow.
    const ids = sequenceIdGen();
    const dst = new SqliteStore({ clock: src.clock });
    const deps = { store: dst, clock: src.clock, ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = must(createBackup({ ...deps, store: src.store, ids: systemIdGen }, { workspaceId: src.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
    const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: WS_NAME, confirmed: true }), 'restore_backup');
    const ws = restored.workspaceId;
    const ctx = makeContext(dst, { workspaceId: ws, actor: 'user_1', clock: src.clock, ids });
    const acc = (number) => dst.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws, number)?.id;
    const bank = dst.db.prepare('SELECT id FROM bank_account WHERE workspace_id = ?').get(ws).id;
    const [restoredBatch] = batchIdsOf(dst, ws);

    const fresh = seedBatch(ctx, acc, bank, 'c2');
    assert.equal(fresh.batchId, 'pbatch_1', 'premise: the new batch reuses the id the source batch had');

    const oldRefs = refsOf(regenerate(ctx, restoredBatch, 'regen-restored'));
    const newRefs = refsOf(fresh.xml);
    assert.deepEqual(oldRefs.MsgId, ['M1'], 'the restored batch keeps the MsgId the bank saw');
    assert.notDeepEqual(newRefs.MsgId, oldRefs.MsgId, 'two different batches never share a MsgId');
    assert.notDeepEqual(newRefs.PmtInfId, oldRefs.PmtInfId);
    for (const kind of ['InstrId', 'EndToEndId']) {
      const both = [...oldRefs[kind], ...newRefs[kind]];
      assert.equal(new Set(both).size, both.length, `${kind} is unique across both batches: ${both}`);
    }
    for (const v of Object.values(newRefs).flat()) assert.match(v, SIX_REFERENCE, `SIX IG §3.2 charset and Max35Text: ${v}`);
    assert.ok(validatePain001(fresh.xml).ok);

    // The stored columns agree with the text, and the workspace holds each value once.
    const stored = dst.db.prepare('SELECT msg_id, pmt_inf_id FROM payment_batch WHERE workspace_id = ?').all(ws);
    assert.equal(new Set(stored.map((r) => r.msg_id)).size, stored.length, 'msg_id is unique per workspace');
    assert.equal(new Set(stored.map((r) => r.pmt_inf_id)).size, stored.length, 'pmt_inf_id is unique per workspace');

    // The database floor behind the mint: a second row claiming a frozen MsgId is refused.
    assert.throws(
      () =>
        dst.db
          .prepare(
            `INSERT INTO payment_batch (id, workspace_id, bank_account_id, execution_date, status, msg_id, cre_dt_tm, idempotency_key, created_at)
             VALUES ('pbatch_dup', ?, ?, '2026-10-05', 'draft', 'M1', ?, 'dup-key', ?)`,
          )
          .run(ws, bank, AT, AT),
      /UNIQUE/,
    );
    dst.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (d) append-only and idempotency ----------------------------------------------------------------

test('(d) the references are frozen at creation: a replay, a regeneration and a raw UPDATE all leave them as they were', () => {
  const w = world();
  const bank = mkBank(w);
  const { batchId } = seedBatch(w.ctx, w.acc, bank, 'd', { generate: false });

  const atCreation = frozenRows(w.store, w.workspaceId);
  const [b] = atCreation.batches;
  assert.equal(b?.msg_id, compactReference('M', batchId), 'MsgId is stamped when the batch is drafted, like CreDtTm');
  assert.equal(b?.pmt_inf_id, compactReference('P', batchId));
  assert.ok(atCreation.items.every((i) => i.instr_id !== null && i.end_to_end_id !== null), 'every item is stamped at creation');
  assert.deepEqual(atCreation.items.map((i) => i.seq), [1, 2], 'and given its position in the batch');

  // Idempotent create: the replay returns the same batch and writes no row.
  const count = () => w.store.db.prepare('SELECT (SELECT COUNT(*) FROM payment_batch) + (SELECT COUNT(*) FROM payment_batch_item) AS n').get().n;
  const before = count();
  const itemIds = w.store.db.prepare('SELECT vendor_bill_id FROM payment_batch_item WHERE workspace_id = ? ORDER BY rowid').all(w.workspaceId).map((r) => r.vendor_bill_id);
  const replay = must(createPaymentBatch(w.ctx, { bankAccountId: bank, itemIds, executionDate: '2026-10-05', idempotencyKey: 'batch-d' }), 'replay');
  assert.equal(replay.batchId, batchId);
  assert.equal(count(), before, 'a replay writes nothing');

  // Generating twice renders from the stored values and never rewrites them.
  const x1 = regenerate(w.ctx, batchId, 'g1');
  const x2 = regenerate(w.ctx, batchId, 'g2');
  assert.equal(x1, x2);
  assert.deepEqual(refsOf(x1).MsgId, [b.msg_id]);
  // The first generation stamps generated_at (critic r3 R3-2) and writes no reference.
  const afterGen = frozenRows(w.store, w.workspaceId);
  assert.equal(afterGen.batches[0].generated_at, AT, 'the first generation stamps generated_at once');
  assert.deepEqual(afterGen, { ...atCreation, batches: atCreation.batches.map((x) => ({ ...x, generated_at: AT })) }, 'generation reads the references, it does not write them');
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch SET generated_at = NULL WHERE id = ?").run(batchId), /payment_batch_refs_frozen/);
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch SET ctrl_sum_minor = NULL WHERE id = ?').run(batchId), /payment_batch_refs_frozen/);

  // The database floor: once set, a reference cannot be changed or cleared, on the batch or an item.
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch SET msg_id = 'Mother' WHERE id = ?").run(batchId), /payment_batch_refs_frozen/);
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch SET pmt_inf_id = NULL WHERE id = ?').run(batchId), /payment_batch_refs_frozen/);
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch SET debtor_name = 'Andere AG' WHERE id = ?").run(batchId), /payment_batch_refs_frozen/);
  const itemId = atCreation.items[0].id;
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch_item SET end_to_end_id = 'Eother' WHERE id = ?").run(itemId), /payment_batch_item_refs_frozen/);
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch_item SET instr_id = NULL WHERE id = ?').run(itemId), /payment_batch_item_refs_frozen/);
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch_item SET seq = 99 WHERE id = ?').run(itemId), /payment_batch_item_refs_frozen/);
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch_item SET creditor_name = 'Andere AG' WHERE id = ?").run(itemId), /payment_batch_item_refs_frozen/);
  assert.throws(() => w.store.db.prepare('DELETE FROM payment_batch WHERE id = ?').run(batchId), /payment_batch_immutable/);
  assert.deepEqual(frozenRows(w.store, w.workspaceId), afterGen);
});

// --- (e) §H-TENANT ------------------------------------------------------------------------------------

test('(e) §H-TENANT: another workspace holding the same reference does not disambiguate this one, and is never touched', () => {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const a = world({ store });
  const bankA = mkBank(a);
  const inA = seedBatch(a.ctx, a.acc, bankA, 'ta');
  const aBefore = frozenRows(store, a.workspaceId);
  assert.equal(aBefore.batches[0]?.msg_id, 'M1', 'premise: workspace A froze M1');

  // Workspace B mints ids of another shape whose numeric suffix, and so whose derived reference, is
  // the same as A's: `pbatchx_1` derives "M1" too.
  const counters = new Map();
  const idsB = {
    next(prefix) {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return `${prefix}x_${n}`;
    },
  };
  const b = world({ store, ids: idsB });
  const bankB = mkBank(b);
  const inB = seedBatch(b.ctx, b.acc, bankB, 'tb', { generate: false });
  assert.equal(inB.batchId, 'pbatchx_1', 'premise: B\'s batch id derives the same M1 as A\'s');

  const bRow = store.db.prepare('SELECT msg_id FROM payment_batch WHERE workspace_id = ? AND id = ?').get(b.workspaceId, inB.batchId);
  assert.equal(bRow.msg_id, compactReference('M', inB.batchId), 'uniqueness is per workspace: B is not pushed off a value only A holds');
  assert.deepEqual(frozenRows(store, a.workspaceId), aBefore, 'minting in B reads and writes nothing of A');
  assert.equal(regenerate(a.ctx, inA.batchId, 'ta-regen'), inA.xml);
  store.close();
});

// --- (f) D148: the creditor name is snapshotted like the IBAN -----------------------------------------

/** The vendor contact behind each item of `batchId`, in file order. */
function vendorsOf(w, batchId) {
  return w.store.db
    .prepare('SELECT vendor_id FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ? ORDER BY seq')
    .all(w.workspaceId, batchId)
    .map((r) => r.vendor_id);
}

test('(f) D148: renaming a vendor between two generations of one batch leaves the file byte-identical', () => {
  const w = world();
  const bank = mkBank(w);
  const { batchId, xml } = seedBatch(w.ctx, w.acc, bank, 'fr');
  const [vendorId] = vendorsOf(w, batchId);
  const before = w.store.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(w.workspaceId, vendorId).name;
  assert.ok(xml.includes(`<Cdtr><Nm>${before}</Nm></Cdtr>`), 'premise: the file names the vendor');

  must(updateContact(w.ctx, { contactId: vendorId, patch: { name: 'Umbenannt Nachher AG' } }), 'update_contact');
  const again = regenerate(w.ctx, batchId, 'fr-regen');
  assert.equal(again, xml, 'the generated file names the creditor the bank was sent');
  assert.ok(!again.includes('Umbenannt Nachher AG'));
});

test('(f) D148: a C00 erasure of the vendor between two generations leaves the file byte-identical, and the report names the retained snapshot', () => {
  const store = new SqliteStore({ clock: fixedClock(AT) });
  const w = world({ store });
  const bank = mkBank(w);
  const { batchId, xml } = seedBatch(w.ctx, w.acc, bank, 'fe');
  const [vendorId, otherVendor] = vendorsOf(w, batchId);

  // A second workspace on the same store with its own run, so the report's count is shown to be tenant scoped.
  let n = 0;
  const other = world({ store, ids: { next: (prefix) => `${prefix}y_${++n}` } });
  const otherBank = mkBank(other);
  const otherRun = seedBatch(other.ctx, other.acc, otherBank, 'fo');
  // A row of the OTHER workspace that names this workspace's vendor (a hand-edited or cross-tenant
  // anomaly): an erasure here must neither count it nor, by extension, speak for it.
  const otherBill = store.db.prepare('SELECT vendor_bill_id FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?').get(other.workspaceId, otherRun.batchId).vendor_bill_id;
  store.db
    .prepare(
      `INSERT INTO payment_batch (id, workspace_id, bank_account_id, execution_date, status, cre_dt_tm, idempotency_key, created_at)
       VALUES ('pbatch_cross', ?, ?, '2026-10-05', 'draft', ?, 'cross', ?)`,
    )
    .run(other.workspaceId, otherBank, AT, AT);
  store.db
    .prepare(
      `INSERT INTO payment_batch_item (id, batch_id, workspace_id, vendor_bill_id, vendor_id, amount_minor, currency, creditor_iban, is_qr_iban, reference_kind, created_at)
       VALUES ('pbitem_cross', 'pbatch_cross', ?, ?, ?, 100, 'CHF', ?, 0, 'none', ?)`,
    )
    .run(other.workspaceId, otherBill, vendorId, vendorIban(999), AT);

  // §H-TENANT for the owner's "refuse, discard first" rule too: the other workspace's DRAFT naming this
  // vendor must not refuse this workspace's erasure.
  const erased = must(anonymiseContact(w.ctx, { contactId: vendorId, idempotencyKey: 'fe-erase' }), 'contacts_anonymise');
  const kept = erased.retained.find((r) => r.table === 'payment_batch_item');
  assert.deepEqual(kept?.columns, ['creditor_name', 'creditor_iban'], 'the report names the retained fields');
  assert.equal(kept?.rows, 1, 'one item of THIS workspace names the erased vendor; the other workspace is not counted');
  assert.match(kept?.reason ?? '', /business_record/);
  assert.equal(w.store.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(w.workspaceId, vendorId).name, 'Anonymisiert');

  assert.equal(regenerate(w.ctx, batchId, 'fe-regen'), xml, 'the payment file is a retained record: it regenerates as sent');
  assert.notEqual(otherVendor, vendorId);
  store.close();
});

// --- (g) D148 / G04 merge note: a surrogate id never becomes a creditor name ---------------------------

test('(g) creating a batch for a vendor with no name is refused (creditor_name_missing) and writes nothing', () => {
  const w = world();
  const bank = mkBank(w);
  const { batchId } = seedBatch(w.ctx, w.acc, bank, 'gn', { generate: false });
  const bills = w.store.db.prepare('SELECT vendor_bill_id, vendor_id FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?').all(w.workspaceId, batchId);
  // Free the bills again and blank one vendor's name (a hand-edited or imported contact).
  must(discardPaymentBatch(w.ctx, { batchId, idempotencyKey: 'gn-discard' }), 'discard_payment_batch');
  w.store.db.prepare("UPDATE contact SET name = '   ' WHERE workspace_id = ? AND id = ?").run(w.workspaceId, bills[0].vendor_id);

  const count = () => w.store.db.prepare('SELECT COUNT(*) AS n FROM payment_batch WHERE workspace_id = ?').get(w.workspaceId).n;
  const before = count();
  const res = createPaymentBatch(w.ctx, { bankAccountId: bank, itemIds: bills.map((b) => b.vendor_bill_id), executionDate: '2026-10-05', idempotencyKey: 'gn-again' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'creditor_name_missing');
  assert.equal(res.vendorId, bills[0].vendor_id);
  assert.equal(res.reason, 'vendor_unnamed');
  assert.equal(count(), before, 'nothing was written');
});

test('(g) the backfill keeps the id a GENERATED file already carried, and leaves a DRAFT unnamed so it cannot be generated', () => {
  const dir = tmp('pain001-frozen-noname-');
  try {
    const path = join(dir, 'book.db');
    const w = world({ location: path });
    const bank = mkBank(w);
    const sent = seedBatch(w.ctx, w.acc, bank, 'gs');
    const draft = seedBatch(w.ctx, w.acc, bank, 'gd', { generate: false });
    const ws = w.workspaceId;
    const [sentVendor] = vendorsOf(w, sent.batchId);
    const [draftVendor] = vendorsOf(w, draft.batchId);
    w.store.close();

    // A book whose vendor contacts no longer resolve: the pre-D148 renderer printed the vendor id.
    rewindToGeneration8(path);
    const raw = new Database(path);
    raw.pragma('foreign_keys = OFF');
    raw.prepare('DELETE FROM contact WHERE id IN (?, ?)').run(sentVendor, draftVendor);
    raw.close();

    const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
    try {
      const nameOf = (vendorId) => store.db.prepare('SELECT creditor_name FROM payment_batch_item WHERE workspace_id = ? AND vendor_id = ?').get(ws, vendorId).creditor_name;
      assert.equal(nameOf(sentVendor), sentVendor, 'a generated file carried the id; the snapshot keeps exactly that');
      assert.equal(nameOf(draftVendor), null, 'a draft sent nothing, so no id is written');
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
      const refused = generatePain001(ctx, { batchId: draft.batchId, idempotencyKey: 'gd-gen' });
      assert.equal(refused.ok, false);
      assert.equal(refused.error, 'creditor_name_missing');
      assert.equal(refused.reason, 'draft_needs_rebatch', 'the guidance for a draft names discarding it first (critic r2 R2-3)');
      assert.match(regenerate(ctx, sent.batchId, 'gs-regen'), new RegExp(`<Cdtr><Nm>${sentVendor}</Nm></Cdtr>`));
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- (h) critic r2 R2-1: the debtor IBAN is frozen, and the account's IBAN is locked while a batch names it --

test('(h) the debtor IBAN is a snapshot: update_bank_account refuses account_in_use while a live batch names the account, and a forced change does not reach the file', () => {
  const w = world();
  const bank = mkBank(w);
  const { batchId, xml } = seedBatch(w.ctx, w.acc, bank, 'hi');
  const otherIban = synthIban('09000', '000000000077');

  const refused = updateBankAccount(w.ctx, { bankAccountId: bank, iban: otherIban, idempotencyKey: 'hi-iban' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'account_in_use');
  assert.equal(refused.reason, 'payment_batch');
  assert.equal(refused.batchId, batchId);
  must(updateBankAccount(w.ctx, { bankAccountId: bank, name: 'Zahlkonto neu', idempotencyKey: 'hi-name' }), 'a rename stays allowed');

  // Even an IBAN changed underneath (a hand edit) never reaches the file: it renders the snapshot.
  w.store.db.prepare('UPDATE bank_account SET iban = ? WHERE workspace_id = ? AND id = ?').run(otherIban, w.workspaceId, bank);
  assert.equal(regenerate(w.ctx, batchId, 'hi-regen'), xml, 'same MsgId, same DbtrAcct and DbtrAgt');
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch SET debtor_iban = ? WHERE id = ?').run(otherIban, batchId), /payment_batch_refs_frozen/);
});

test('(h) a discarded batch no longer locks the account IBAN', () => {
  const w = world();
  const bank = mkBank(w);
  const { batchId } = seedBatch(w.ctx, w.acc, bank, 'hd', { generate: false });
  must(discardPaymentBatch(w.ctx, { batchId, idempotencyKey: 'hd-discard' }), 'discard_payment_batch');
  must(updateBankAccount(w.ctx, { bankAccountId: bank, iban: synthIban('09000', '000000000078'), idempotencyKey: 'hd-iban' }), 'update_bank_account');
});

// --- (i) owner decision 01.10.2026 (critic r2 R2-5): erasure clears a never-filed snapshot only -------------

test('(i) erasure REFUSES while a live draft names the vendor; after the discard it CLEARS the never-filed snapshots and RETAINS the filed one', () => {
  const w = world();
  const bank = mkBank(w);
  const vendorId = must(createContact(w.ctx, { partyRole: 'vendor', name: 'Erfunden Einzel AG', idempotencyKey: 'i-v' }), 'create_contact').contact.id;
  must(setCreditorBankProfile(w.ctx, { vendorId, iban: vendorIban(4242), idempotencyKey: 'i-cbp' }), 'set_creditor_bank_profile');
  const bill = (k, amount) => {
    const b = must(
      createVendorBill(w.ctx, { vendorId, billDate: '2026-09-01', vendorReference: `SYN-i-${k}`, amountMinor: amount, expenseAccountId: w.acc('6500'), idempotencyKey: `i-bill-${k}` }),
      'create_vendor_bill',
    );
    must(postVendorBill(w.ctx, { vendorBillId: b.vendorBillId, idempotencyKey: `i-post-${k}` }), 'post_vendor_bill');
    return b.vendorBillId;
  };
  const batch = (k, billId) =>
    must(createPaymentBatch(w.ctx, { bankAccountId: bank, itemIds: [billId], executionDate: '2026-10-05', idempotencyKey: `i-batch-${k}` }), 'create_payment_batch').batchId;

  const filed = batch('filed', bill('filed', 11_000));
  const filedXml = regenerate(w.ctx, filed, 'i-gen');
  const dropped = batch('dropped', bill('dropped', 12_000));
  must(discardPaymentBatch(w.ctx, { batchId: dropped, idempotencyKey: 'i-discard' }), 'discard_payment_batch');
  const live = batch('live', bill('live', 13_000));
  const itemOf = (batchId) =>
    w.store.db.prepare('SELECT id, creditor_name, creditor_iban FROM payment_batch_item WHERE workspace_id = ? AND batch_id = ?').get(w.workspaceId, batchId);

  // The trigger admits no other change to a snapshot, on any of the three.
  for (const b of [filed, dropped, live]) {
    assert.throws(() => w.store.db.prepare("UPDATE payment_batch_item SET creditor_name = 'Andere AG' WHERE id = ?").run(itemOf(b).id), /payment_batch_item_refs_frozen/);
  }
  assert.throws(() => w.store.db.prepare('UPDATE payment_batch_item SET creditor_name = NULL WHERE id = ?').run(itemOf(filed).id), /payment_batch_item_refs_frozen/, 'a filed snapshot cannot be cleared');
  assert.throws(() => w.store.db.prepare("UPDATE payment_batch_item SET creditor_iban = '' WHERE id = ?").run(itemOf(live).id), /payment_batch_item_refs_frozen/, 'nor a live draft one');

  // Owner decision 01.10.2026 ("refuse, discard first"): the live draft refuses the erasure and is named.
  const nameBefore = w.store.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(w.workspaceId, vendorId).name;
  const refused = anonymiseContact(w.ctx, { contactId: vendorId, idempotencyKey: 'i-erase-refused' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'contact_in_open_payment_batch');
  assert.deepEqual(refused.batches, [{ batchId: live, executionDate: '2026-10-05', items: 1 }], 'the draft is named, the discarded and the filed batch are not');
  assert.equal(w.store.db.prepare('SELECT name FROM contact WHERE workspace_id = ? AND id = ?').get(w.workspaceId, vendorId).name, nameBefore, 'nothing was erased');
  assert.equal(itemOf(dropped).creditor_name, 'Erfunden Einzel AG', 'nor cleared');

  // Discard the draft, erase again: both never-filed snapshots are cleared, the filed one retained.
  must(discardPaymentBatch(w.ctx, { batchId: live, idempotencyKey: 'i-discard-live' }), 'discard_payment_batch');
  const erased = must(anonymiseContact(w.ctx, { contactId: vendorId, idempotencyKey: 'i-erase' }), 'contacts_anonymise');
  const kept = erased.retained.find((r) => r.table === 'payment_batch_item');
  assert.equal(kept.rows, 1, 'only the filed item is retained under the retention duty');
  assert.equal('draftRows' in kept, false, 'a lingering draft can no longer occur');
  assert.deepEqual(erased.paymentSnapshotsCleared, { items: 2 });

  for (const b of [dropped, live]) {
    const cleared = itemOf(b);
    assert.equal(cleared.creditor_name, null, 'the never-filed snapshot name is cleared');
    assert.equal(cleared.creditor_iban, '', 'and its IBAN');
  }
  assert.equal(itemOf(filed).creditor_name, 'Erfunden Einzel AG', 'the filed snapshot is retained');
  assert.equal(regenerate(w.ctx, filed, 'i-regen'), filedXml, 'and the filed batch still regenerates as sent');
});

// --- (j) critic r2 R2-6: the two tests the critic's mutations N12 and N14 survived ----------------------------

test('(j) the debtor-name backfill takes the company profile creditor name over the workspace name, as the renderer did', () => {
  const dir = tmp('pain001-frozen-creditorname-');
  try {
    const path = join(dir, 'book.db');
    const w = world({ location: path });
    // The company profile's creditor name, distinct from the workspace name (both invented).
    w.store.db.prepare("UPDATE workspace SET creditor_name = 'Synthetik Zahlstelle AG' WHERE id = ?").run(w.workspaceId);
    const bank = mkBank(w);
    const sent = seedBatch(w.ctx, w.acc, bank, 'jn');
    assert.ok(sent.xml.includes('<Dbtr><Nm>Synthetik Zahlstelle AG</Nm></Dbtr>'), 'premise: the file names the creditor name');
    const ws = w.workspaceId;
    w.store.close();
    rewindToGeneration8(path);

    const store = new SqliteStore({ location: path, clock: fixedClock(AT) });
    try {
      const row = store.db.prepare('SELECT debtor_name FROM payment_batch WHERE workspace_id = ? AND id = ?').get(ws, sent.batchId);
      assert.equal(row.debtor_name, 'Synthetik Zahlstelle AG', 'not the workspace name');
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock(AT), ids: systemIdGen });
      assert.equal(regenerate(ctx, sent.batchId, 'jn-regen'), sent.xml);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('(j) a sanitized env_copy (pseudonymize) masks every frozen PII snapshot: creditor_name, creditor_iban, debtor_name, debtor_iban', () => {
  const dir = tmp('pain001-frozen-sanitize-');
  try {
    let source = null;
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
          const w = world({ location: path, ids: systemIdGen });
          const bank = mkBank(w);
          const { batchId } = seedBatch(w.ctx, w.acc, bank, 'js');
          source = {
            batch: w.store.db.prepare('SELECT debtor_name, debtor_iban FROM payment_batch WHERE id = ?').get(batchId),
            items: w.store.db.prepare('SELECT creditor_name, creditor_iban FROM payment_batch_item WHERE batch_id = ? ORDER BY seq').all(batchId),
          };
          w.store.close();
        },
        minimal: (p) => new SqliteStore({ location: p }).close(),
      },
    };
    must(envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'paid', tierRank: 250, confirmed: true }), 'env_create src');
    must(envCreate(deps, { name: 'dst', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }), 'env_create dst');
    must(envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: 'pseudonymize', confirmed: true }), 'env_copy');
    assert.ok(source !== null && source.items.length === 2, 'premise: the source froze a batch');

    const store = new SqliteStore({ location: join(dir, 'environments', 'dst', 'till.db'), clock: fixedClock(AT) });
    try {
      const batch = store.db.prepare('SELECT debtor_name, debtor_iban FROM payment_batch').get();
      const items = store.db.prepare('SELECT creditor_name, creditor_iban FROM payment_batch_item ORDER BY seq').all();
      assert.notEqual(batch.debtor_name, source.batch.debtor_name, 'debtor_name is masked');
      assert.notEqual(batch.debtor_iban, source.batch.debtor_iban, 'debtor_iban is masked');
      for (const [i, it] of items.entries()) {
        assert.notEqual(it.creditor_name, source.items[i].creditor_name, 'creditor_name is masked');
        assert.notEqual(it.creditor_iban, source.items[i].creditor_iban, 'creditor_iban is masked');
      }
      const copied = JSON.stringify({ batch, items });
      for (const real of [source.batch.debtor_name, source.batch.debtor_iban, ...source.items.flatMap((x) => [x.creditor_name, x.creditor_iban])]) {
        assert.ok(!copied.includes(real), `no source value survives: ${real}`);
      }
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
