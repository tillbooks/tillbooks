// NON-AUTHOR critic probes, round 1, for `claude/pain001-frozen-refs` (A18 F9, schema generation 9).
// Report: docs/critique/pain001-frozen-refs-critic-r1.md.
//
// Each probe asserts the property the fix CLAIMS (the frozen references are what the bank saw, and a
// restored or copied book behaves like its source). A red probe is a finding; a green one is a hole the
// critic tried and found closed.
//
// SYNTHETIC DATA ONLY: the IBANs are the published samples and invented numbers bank-inbox-support.mjs
// already uses (valid check digits), every name is invented, every statement is spelled by hand.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import {
  listBankInbox,
  bookBankLine,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
} from '../../dist/core/banking/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import {
  world,
  must,
  importLines,
  postedBill,
  SAVINGS_IBAN,
  assertClaimInvariantHolds,
} from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (ctx, id) => must(listBankInbox(ctx, { status: 'all' })).lines.find((l) => l.bankTxnId === id);

function refsOf(xml) {
  const all = (tag) => [...xml.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]);
  return { MsgId: all('MsgId'), PmtInfId: all('PmtInfId'), InstrId: all('InstrId'), EndToEndId: all('EndToEndId') };
}

/** A generated A18 run of `amounts`, bills handed in `order` (indexes into amounts). */
function run(t, seed, amounts, order = amounts.map((_, i) => i)) {
  const bills = amounts.map((a, i) => postedBill(t, { grossMinor: a, seed: `${seed}-${i}`, vendorName: `Lieferant ${seed} ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `${seed}-cbp-${i}` }));
  const batch = must(
    createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: order.map((i) => bills[i].vendorBillId), executionDate: '2026-07-22', idempotencyKey: `${seed}-batch` }),
  );
  const gen = must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: `${seed}-gen` }));
  return { batchId: batch.batchId, bills, xml: Buffer.from(gen.xmlBase64, 'base64').toString('utf8') };
}

/** Back up `t`'s workspace and restore it beside the original on the same store (ids re-minted as uuids). */
function restoreBeside(t, dir) {
  const deps = { store: t.store, clock: t.clock, ids: systemIdGen, actor: 'user_1', backupDir: join(dir, 'b') };
  const backup = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }), 'create_backup');
  const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Muster Grafik GmbH (R)', confirmed: true }), 'restore_backup');
  const ws = restored.workspaceId;
  const ctx = makeContext(t.store, { workspaceId: ws, actor: 'user_1', clock: t.clock, ids: systemIdGen });
  const bankAccountId = t.store.db.prepare('SELECT id FROM bank_account WHERE workspace_id = ?').get(ws).id;
  const batchId = t.store.db.prepare('SELECT id FROM payment_batch WHERE workspace_id = ? ORDER BY rowid').get(ws).id;
  return { ws, ctx, bankAccountId, batchId };
}

// --- C1: the bank inbox still derives the references from ids -------------------------------------------

test('C1a: after a restore, a camt.053 line naming a frozen EndToEndId is still recognised as that run item', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-f9-c1a-'));
  try {
    const t = world();
    const r = run(t, 'c1a', [60000, 40000]);
    const sent = refsOf(r.xml); // what the bank received, and what its camt.053 reports back
    const R = restoreBeside(t, dir);
    const frozen = t.store.db.prepare('SELECT end_to_end_id FROM payment_batch_item WHERE workspace_id = ? ORDER BY rowid').all(R.ws).map((x) => x.end_to_end_id);
    assert.deepEqual(frozen, sent.EndToEndId, 'premise: the restored items froze the EndToEndIds the bank saw');

    const { lines } = importLines(
      t,
      { statementId: 'C1A', entries: [{ ref: 'I1', amountMinor: 60000, cd: 'DBIT', pmtInfId: sent.PmtInfId[0], e2e: sent.EndToEndId[0] }] },
      { ctx: R.ctx, bankAccountId: R.bankAccountId },
    );
    const p = lineOf(R.ctx, lines.I1).proposal;
    assert.equal(p?.reasonCode, 'payment_batch_item', `the frozen EndToEndId must prove the item; got ${JSON.stringify(p)}`);
    const booked = bookBankLine(R.ctx, { bankTxnId: lines.I1, target: { kind: 'payment_batch', batchId: R.batchId }, idempotencyKey: 'c1a' });
    assert.equal(booked.ok, true, `booking the item line through its run must work; got ${JSON.stringify(booked)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('C1b: after a restore, a camt.053 run-total line naming the frozen PmtInfId is proposed as that run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-f9-c1b-'));
  try {
    const t = world();
    const r = run(t, 'c1b', [60000, 40000]);
    const sent = refsOf(r.xml);
    const R = restoreBeside(t, dir);
    const { lines } = importLines(
      t,
      { statementId: 'C1B', entries: [{ ref: 'RUN', amountMinor: 100000, cd: 'DBIT', pmtInfId: sent.PmtInfId[0] }] },
      { ctx: R.ctx, bankAccountId: R.bankAccountId },
    );
    const p = lineOf(R.ctx, lines.RUN).proposal;
    assert.equal(p?.reasonCode, 'payment_batch_reference', `the frozen PmtInfId must prove the run; got ${JSON.stringify(p)}`);
    assert.equal(p?.certainty, 'sure');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- C2: item order after restore ------------------------------------------------------------------------

test('C2: a run of many items regenerates byte-identical after a restore (CdtTrfTxInf order included)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-f9-c2-'));
  try {
    const t = world();
    const amounts = [11000, 12000, 13000, 14000, 15000, 16000, 17000, 18000, 19000, 20000, 21000, 22000];
    // Hand the bills in a shuffled order, so insertion order is neither id order nor reference order.
    const r = run(t, 'c2', amounts, [7, 2, 11, 0, 9, 4, 1, 10, 5, 3, 8, 6]);
    const R = restoreBeside(t, dir);
    const gen = must(generatePain001(R.ctx, { batchId: R.batchId, idempotencyKey: 'c2-regen' }));
    const again = Buffer.from(gen.xmlBase64, 'base64').toString('utf8');
    assert.deepEqual(refsOf(again).EndToEndId, refsOf(r.xml).EndToEndId, 'the items come back in the order the bank saw');
    assert.equal(again, r.xml, 'byte-identical, the F9 claim');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- C3: the backfill of a book a develop-era restore produced --------------------------------------------

// LOW, and not repairable: a develop-era restore threw the ORIGINAL item ids away, so no backfill can
// recover the InstrId/EndToEndId the bank saw. MsgId (the dedup key) and PmtInfId are recovered. The
// probe stays a `todo` that documents the gap; the fix is to say so in F9 and in the migration comment.
test('C3: the generation-9 backfill of a book restored BEFORE the fix freezes every reference the bank saw (InstrId/EndToEndId included)', { todo: 'LOW, inherent: document the limitation (critic r1 C3)' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'critic-f9-c3-'));
  try {
    const path = join(dir, 'book.db');
    const t = world({ location: path });
    const r = run(t, 'c3', [60000, 40000]);
    const sent = refsOf(r.xml);
    // A develop-era restore: ids re-minted, msg_id copied verbatim, no frozen columns yet.
    const R = restoreBeside(t, dir);
    const ws = R.ws;
    t.store.close();
    const raw = new Database(path);
    for (const x of raw.prepare("SELECT name, type FROM sqlite_master WHERE name LIKE 'payment_batch%frozen%' OR name LIKE 'payment_batch%_ref_unique'").all()) {
      raw.exec(`DROP ${x.type === 'trigger' ? 'TRIGGER' : 'INDEX'} IF EXISTS "${x.name}"`);
    }
    raw.exec('UPDATE payment_batch SET pmt_inf_id = NULL');
    raw.exec('UPDATE payment_batch_item SET instr_id = NULL, end_to_end_id = NULL');
    raw.pragma('user_version = 8');
    raw.close();

    const store = new SqliteStore({ location: path, clock: fixedClock('2026-07-20T08:00:00.000Z') });
    try {
      const ctx = makeContext(store, { workspaceId: ws, actor: 'user_1', clock: fixedClock('2026-07-20T08:00:00.000Z'), ids: systemIdGen });
      const gen = must(generatePain001(ctx, { batchId: R.batchId, idempotencyKey: 'c3-regen' }));
      const again = refsOf(Buffer.from(gen.xmlBase64, 'base64').toString('utf8'));
      assert.deepEqual(again.MsgId, sent.MsgId, 'the MsgId is kept (the author covers this)');
      assert.deepEqual(again.PmtInfId, sent.PmtInfId, 'the PmtInfId follows the original id (the author covers this)');
      assert.deepEqual(again.EndToEndId, sent.EndToEndId, 'the EndToEndIds the bank and the creditors saw');
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
