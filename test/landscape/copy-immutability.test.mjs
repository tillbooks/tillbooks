// N00 environment landscape, PHASE B: the copy engine must suspend EVERY immutability / append-only
// guard trigger while it constructs and sanitizes the throwaway building db, not only the five journal
// posted-row guards. A real ledger carries ~60 such guards across 19 schema modules (payment,
// payment-batch, vendor-bill, asset, inventory, payroll, HR, procurement, migration, ...); the sanitize
// pass MUTATES frozen rows (it masks `payment_batch_item.creditor_iban`, a PII column, and scales
// `amount_minor` on an item that already has a posted payment) and the mandate-refresh pass DELETES them,
// both of which the guards ABORT. A source with payment batches therefore aborted env_copy with
// `unexpected_error` / `payment_batch_item_immutable` under the old hardcoded five-trigger list. The unit
// fixtures never seeded a payment batch, so the earlier tests missed it.
//
// These tests are written to BITE: they seed a source that carries a POSTED-payment payment-batch item
// (the exact row the reported abort tripped), run real copies at every scope and sanitization level, and
// assert SUCCESS plus that the target ends with the IDENTICAL full set of immutability guards. Reverting
// the fix (suspending only the five journal triggers) turns the pseudonymize/structure_synthetic and the
// mandate-refresh cases red with `payment_batch_item_immutable` (verified by the author, re-checked by a
// non-author critic). The real ~/.till is never touched: everything lives under a per-test tmp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envCreate, envCopy } from '../../dist/core/landscape/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { createWorkspace } from '../../dist/core/setup/workspace.js';
import { systemIdGen } from '../../dist/core/ids.js';

// The shape of an immutability / append-only guard trigger: a body that RAISEs ABORT. Mirrors the
// runtime derivation the fix uses (copy.ts IMMUTABILITY_TRIGGER_SHAPE); recomputed independently here so
// the assertion is a genuine cross-check, not a tautology against the code under test.
const GUARD_SHAPE = /RAISE\s*\(\s*ABORT/i;

/** The names of every immutability / append-only guard trigger present in a db file. */
function guardTriggers(dbPath) {
  const store = new SqliteStore({ location: dbPath });
  try {
    return store.db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")
      .all()
      .filter((t) => GUARD_SHAPE.test(t.sql))
      .map((t) => t.name)
      .sort();
  } finally {
    store.close();
  }
}

// --- a rich source seeder that carries a POSTED-payment payment-batch item -------------------------

const BATCH_IBAN = 'ZZQBATCHIBAN_CH99_0001'; // a distinctive creditor IBAN marker (masked at pseudonymize)

/**
 * Seed a workspace (via the real engine) plus: a vendor contact, a bank account, one BALANCED posted
 * journal entry, a posted vendor bill, a posted payment, a paid payment_batch, and a payment_batch_item
 * whose `posted_payment_id` is set. That last row is the reproduction: the sanitize pass masks its
 * `creditor_iban` and (structure_synthetic) scales its `amount_minor`, and the mandate-refresh pass
 * deletes it, all of which the payment-batch guards ABORT unless the copy suspends them. Runs inside
 * envCreate`s build-then-gate, so an inconsistent or unbalanced seed would fail the create itself.
 */
function paymentBatchSeeder(path) {
  const store = new SqliteStore({ location: path });
  const db = store.db;
  const at = '2026-01-01T00:00:00.000Z';
  const created = createWorkspace(
    { store, clock: { now: () => at }, ids: systemIdGen, actor: 'seed' },
    { name: 'ZZQ_BatchCo' },
  );
  if (!created.ok) throw new Error('seed: createWorkspace failed');
  const wsId = created.workspaceId;
  const acct = db.prepare('SELECT id FROM account WHERE workspace_id = ? LIMIT 1').get(wsId).id;

  const vendorId = systemIdGen.next('contact');
  db.prepare(
    `INSERT INTO contact (id, workspace_id, party_role, name, created_at, kind) VALUES (?,?,?,?,?,?)`,
  ).run(vendorId, wsId, 'supplier', 'ZZQ_Vendor', at, 'company');

  const bankId = systemIdGen.next('bank');
  db.prepare(
    `INSERT INTO bank_account (id, workspace_id, name, iban, ledger_account_id, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(bankId, wsId, 'Zahlkonto', 'CH5604835012345678009', acct, at);

  const entryId = systemIdGen.next('entry');
  const billId = systemIdGen.next('vbill');
  const payId = systemIdGen.next('pay');
  const batchId = systemIdGen.next('pbatch');

  db.pragma('defer_foreign_keys = ON');
  db.transaction(() => {
    // A balanced posted entry (so the copy`s invariant gate has real posted rows to re-foot).
    db.prepare(
      `INSERT INTO journal_line (id, entry_id, account_id, currency, base_debit_minor, base_credit_minor) VALUES (?,?,?,?,?,?)`,
    ).run(systemIdGen.next('jl'), entryId, acct, 'CHF', 5000, 0);
    db.prepare(
      `INSERT INTO journal_line (id, entry_id, account_id, currency, base_debit_minor, base_credit_minor) VALUES (?,?,?,?,?,?)`,
    ).run(systemIdGen.next('jl'), entryId, acct, 'CHF', 0, 5000);
    db.prepare(
      `INSERT INTO journal_entry (id, workspace_id, date, status, source, created_at) VALUES (?,?,?,?,?,?)`,
    ).run(entryId, wsId, '2026-01-10', 'posted', 'manual', at);

    // A posted vendor bill (A17 immutability guards fire on its update/delete).
    db.prepare(
      `INSERT INTO vendor_bill (id, workspace_id, contact_id, bill_date, net_minor, gross_minor, payable_minor, expense_account_id, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(billId, wsId, vendorId, '2026-01-05', 5000, 5000, 5000, acct, 'posted', at);

    // A posted payment (A14 payment_immutable guards fire on its money-update/delete).
    db.prepare(
      `INSERT INTO payment (id, workspace_id, direction, date, amount_minor, currency, base_amount_minor, bank_account_id, status, source, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(payId, wsId, 'outgoing', '2026-01-12', 5000, 'CHF', 5000, acct, 'posted', 'manual', at);

    // A paid payment batch.
    db.prepare(
      `INSERT INTO payment_batch (id, workspace_id, bank_account_id, execution_date, status, ctrl_sum_minor, nb_of_txs, cre_dt_tm, idempotency_key, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(batchId, wsId, bankId, '2026-01-12', 'paid', 5000, 1, at, `batch-key-${batchId}`, at);

    // THE reproduction row: a batch item with a POSTED payment, so masking creditor_iban or scaling
    // amount_minor trips `payment_batch_item_no_accounting_update`, and deleting it trips
    // `payment_batch_item_no_delete`.
    db.prepare(
      `INSERT INTO payment_batch_item (id, batch_id, workspace_id, vendor_bill_id, vendor_id, amount_minor, currency, creditor_iban, is_qr_iban, reference_kind, reference_value, posted_payment_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(systemIdGen.next('pbi'), batchId, wsId, billId, vendorId, 5000, 'CHF', BATCH_IBAN, 0, 'qrr', '210000000003139471430009017', payId, at);
  })();

  store.close();
}

// --- helpers ---------------------------------------------------------------------------------------

function tmp() {
  return mkdtempSync(join(tmpdir(), 'till-copy-imm-'));
}

function makeDeps(dir, seeders) {
  return {
    supportDir: dir,
    environmentsRoot: join(dir, 'environments'),
    mainDbPath: join(dir, 'main', 'till.db'),
    actor: 'owner',
    now: () => '2026-09-07T00:00:00.000Z',
    seeders,
    ids: systemIdGen,
    clock: { now: () => '2026-09-07T00:00:00.000Z' },
  };
}

function scanForValue(dbPath, needle) {
  const store = new SqliteStore({ location: dbPath });
  try {
    const db = store.db;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
    const hits = [];
    for (const t of tables) {
      for (const c of db.pragma(`table_info("${t}")`)) {
        try {
          const row = db.prepare(`SELECT 1 FROM "${t}" WHERE CAST("${c.name}" AS TEXT) LIKE ? LIMIT 1`).get(`%${needle}%`);
          if (row) hits.push(`${t}.${c.name}`);
        } catch {
          // not a hiding place for an ASCII marker
        }
      }
    }
    return hits;
  } finally {
    store.close();
  }
}

/** Create a source env seeded with a posted-payment payment batch, plus a bare target env. */
function scenario({ sourceRank = 250, targetRank = 40, targetSeed } = {}) {
  const dir = tmp();
  const seeders = {
    batch: paymentBatchSeeder,
    minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); },
  };
  if (targetSeed) seeders.keeper = targetSeed;
  const deps = makeDeps(dir, seeders);
  const src = envCreate(deps, { name: 'src', policy: 'synthetic', seed: 'batch', tierRank: sourceRank, confirmed: true });
  assert.equal(src.ok, true, `source create: ${JSON.stringify(src)}`);
  const tgt = envCreate(deps, { name: 'dst', policy: 'synthetic', seed: targetSeed ? 'keeper' : 'minimal', tierRank: targetRank, confirmed: true });
  assert.equal(tgt.ok, true, `target create: ${JSON.stringify(tgt)}`);
  return { dir, deps, srcPath: join(dir, 'environments', 'src', 'till.db'), dstPath: join(dir, 'environments', 'dst', 'till.db') };
}

function srcWorkspaceId(srcPath) {
  const s = new SqliteStore({ location: srcPath });
  try {
    return s.db.prepare('SELECT id FROM workspace LIMIT 1').get().id;
  } finally {
    s.close();
  }
}

// --- guard coverage: the derived set is real, larger than the old five, and identical on the target --

test('copy/guards: the schema carries far more than the five journal guards, incl. the payment-batch guards', () => {
  const dir = tmp();
  const deps = makeDeps(dir, { minimal: (p) => { const s = new SqliteStore({ location: p }); s.close(); } });
  try {
    assert.equal(envCreate(deps, { name: 'ref', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true }).ok, true);
    const guards = new Set(guardTriggers(join(dir, 'environments', 'ref', 'till.db')));
    // The five the old hardcoded list covered:
    for (const t of [
      'journal_entry_no_update_posted',
      'journal_entry_no_delete_posted',
      'journal_line_no_insert_posted',
      'journal_line_no_update_posted',
      'journal_line_no_delete_posted',
    ]) {
      assert.ok(guards.has(t), `expected the journal guard ${t} in the derived set`);
    }
    // The guards the old list MISSED (the class the bug lived in):
    for (const t of [
      'payment_batch_item_no_accounting_update',
      'payment_batch_item_no_delete',
      'payment_batch_no_delete',
      'payment_no_delete',
      'payment_allocation_no_delete',
      'vendor_bill_no_delete',
    ]) {
      assert.ok(guards.has(t), `expected the append-only guard ${t} in the derived set`);
    }
    // The set is genuinely broad (a real schema, not a stub): well beyond the old five.
    assert.ok(guards.size >= 40, `expected the schema to carry many immutability guards, found ${guards.size}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- E2E: an instance copy of a payment-batch source succeeds at EVERY sanitization level -----------
// Before the fix, pseudonymize and structure_synthetic aborted here with `payment_batch_item_immutable`
// (the sanitize pass masks the item`s creditor_iban / scales its amount_minor while it has a posted
// payment). This is the exact defect the live PROVE reproduced, at instance scope.

for (const level of ['raw', 'pseudonymize', 'structure_synthetic']) {
  test(`copy/payment-batch instance ${level}: succeeds (no *_immutable abort) and keeps every guard`, () => {
    const { dir, deps, srcPath, dstPath } = scenario();
    try {
      // Sanity: the source really holds a batch item with a posted payment, so the test bites.
      const s = new SqliteStore({ location: srcPath });
      try {
        const item = s.db.prepare('SELECT posted_payment_id, creditor_iban FROM payment_batch_item LIMIT 1').get();
        assert.ok(item, 'source must carry a payment_batch_item');
        assert.notEqual(item.posted_payment_id, null, 'the item must have a POSTED payment for the guard to bite');
        assert.equal(item.creditor_iban, BATCH_IBAN);
      } finally {
        s.close();
      }
      const before = guardTriggers(dstPath); // the fresh target already has the full guard set

      const res = envCopy(deps, { source: 'src', target: 'dst', scope: 'instance', sanitize: level, confirmed: true });
      assert.equal(res.ok, true, `copy must succeed, not abort on an immutability guard: ${JSON.stringify(res)}`);
      assert.equal(res.summary.workspacesCopied, 1);

      // The shipped target ends with the IDENTICAL full set of immutability guards (all recreated).
      assert.deepEqual(guardTriggers(dstPath), before, 'the target must retain the identical full guard set');

      // The batch item survived the copy and its money columns are consistent with the level.
      const d = new SqliteStore({ location: dstPath });
      try {
        const item = d.db.prepare('SELECT amount_minor, creditor_iban, posted_payment_id FROM payment_batch_item LIMIT 1').get();
        assert.ok(item, 'the copied target still carries the batch item (structure kept)');
        assert.notEqual(item.posted_payment_id, null, 'the item still points at its (re-minted) posted payment');
        if (level === 'raw') {
          assert.equal(item.creditor_iban, BATCH_IBAN, 'raw keeps the creditor IBAN verbatim');
          assert.equal(item.amount_minor, 5000, 'raw keeps the amount verbatim');
        } else {
          assert.notEqual(item.creditor_iban, BATCH_IBAN, `${level} masks the creditor IBAN`);
          assert.deepEqual(scanForValue(dstPath, BATCH_IBAN), [], `${level} leaves no trace of the source IBAN`);
          if (level === 'structure_synthetic') {
            assert.equal(item.amount_minor, 5000 * 7, 'structure_synthetic scales the amount by the uniform factor');
          }
        }
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- E2E: a mandate copy of a payment-batch source succeeds at EVERY sanitization level -------------

for (const level of ['raw', 'pseudonymize', 'structure_synthetic']) {
  test(`copy/payment-batch mandate ${level}: a scoped copy succeeds without tripping a guard`, () => {
    const { dir, deps, srcPath, dstPath } = scenario();
    try {
      const srcWs = srcWorkspaceId(srcPath);
      const res = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: level, confirmed: true });
      assert.equal(res.ok, true, `mandate copy must succeed: ${JSON.stringify(res)}`);
      assert.equal(res.summary.workspacesCopied, 1);
      const d = new SqliteStore({ location: dstPath });
      try {
        assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM payment_batch_item').get().n, 1, 'the batch item was copied');
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// --- E2E: the mandate REFRESH (delete-then-recopy) path deletes frozen batch rows without a guard abort
// This is finding #1b generalised: the refresh deletes the prior copy`s workspace, which for a
// payment-batch source means DELETEing a batch item / payment / vendor bill / batch, each guarded by a
// no_delete trigger. The old five-trigger suspension left those guards live, so the delete aborted.

for (const level of ['raw', 'pseudonymize']) {
  test(`copy/payment-batch refresh ${level}: a second mandate copy REPLACES the prior one (delete trips no guard)`, () => {
    const { dir, deps, srcPath, dstPath } = scenario();
    try {
      const srcWs = srcWorkspaceId(srcPath);
      const first = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: level, confirmed: true });
      assert.equal(first.ok, true, `first copy: ${JSON.stringify(first)}`);

      // The REFRESH deletes the prior copy (payment/batch/bill rows and all) then re-copies.
      const second = envCopy(deps, { source: 'src', target: 'dst', scope: `mandate:${srcWs}`, sanitize: level, confirmed: true });
      assert.equal(second.ok, true, `refresh must succeed, not abort deleting frozen batch rows: ${JSON.stringify(second)}`);
      assert.equal(second.summary.workspacesCopied, 1);

      const d = new SqliteStore({ location: dstPath });
      try {
        // Exactly one workspace and one batch item: the prior copy was replaced, not doubled.
        assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n, 1, 'one workspace, undoubled');
        assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM payment_batch_item').get().n, 1, 'one batch item, undoubled');
        assert.equal(d.db.prepare('SELECT COUNT(*) AS n FROM payment').get().n, 1, 'one payment, undoubled');
      } finally {
        d.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
