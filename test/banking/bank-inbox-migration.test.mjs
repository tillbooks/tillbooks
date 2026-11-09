// A39 L1: legacy bank-line adoption runs ONCE, as data migration generation 8 (spec §0 L1, §8).
//
// A generation-7 book is built the way develop wrote one (A20 links with no decision row, an A21 credit
// applied with no link, a legacy `confirm_match` payment reversed later, a legacy `mark_batch_paid
// { bankTxnId }` run link, a stored rule on a verb A39 newly denies), written to a file with develop's
// DDL for the link table (its UNIQUE `bank_txn_link_one_per_txn`, none of the A39 tables or triggers)
// and `user_version = 7` (critic H2: a book built on the new schema hid the one DDL change of
// generation 8), and opened by this build: the migration adopts it once, a re-open adopts nothing
// again, a legacy decision whose target is reversed or foreign is adopted superseded, and nothing adopts
// at store open or before a write any more. A generation-8 restore keeps the one-door rule (L2: q3), and a
// pre-A39 backup is refused. SYNTHETIC DATA ONLY; every temp directory is removed.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';

// The registry wires G01's action validation (a rule is saved through it).
import '../../dist/api/registry.js';
import {
  bookBankLine,
  reopenBankLine,
  listBankInbox,
  applyQrMatch,
  overrideQrMatch,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
  markBatchPaid,
} from '../../dist/core/banking/index.js';
import { claimedLegs } from '../../dist/core/banking/bankLines.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { recordPayment, reversePayment, PAYMENT_INTENTS } from '../../dist/core/payments/payment.js';
import { createBackup, restoreBackup } from '../../dist/core/data/portability.js';
import { createAutomationRule } from '../../dist/core/automation/index.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { systemIdGen } from '../../dist/core/ids.js';
import { assertClaimInvariantHolds, excuseClaimInvariant, world, importLines, issueInvoice, postedBill, must, refused, SAVINGS_IBAN } from './bank-inbox-support.mjs';
import { legClaimViolations, multiActiveViolations } from './bank-inbox-invariants.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (ctx, id) => must(listBankInbox(ctx, { status: 'all' })).lines.find((l) => l.bankTxnId === id);

/**
 * A pre-A39 workspace, written underneath the engine the way develop wrote it: a camt entry A20 created
 * from line A, a hand entry line M was matched to, the SAME hand entry also linked to line M2 (walk B9.3),
 * an A21 credit applied with no link (line P), a camt entry whose Storno is on the books (line R), a
 * link whose target does not exist in this workspace (line F), a `confirm_match` payment to a supplier
 * bill that was reversed later (line V), and a run marked paid with the line's `bankTxnId` (line RUN).
 */
function legacyWorld() {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'lg' });
  const hand = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Hand 900', idempotencyKey: 'hand', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
  const { lines } = importLines(t, { statementId: 'LG', entries: [
    { ref: 'A', amountMinor: 700, cd: 'DBIT' },
    { ref: 'A2', amountMinor: 700, cd: 'DBIT' },
    { ref: 'P', amountMinor: 108100, cd: 'CRDT' },
    { ref: 'M', amountMinor: 900, cd: 'DBIT' },
    { ref: 'M2', amountMinor: 900, cd: 'DBIT' },
    { ref: 'R', amountMinor: 300, cd: 'DBIT' },
    { ref: 'F', amountMinor: 50, cd: 'DBIT' },
    { ref: 'V', amountMinor: 40000, cd: 'DBIT' },
    { ref: 'RUN', amountMinor: 100000, cd: 'DBIT' },
  ] });
  const camtEntry = must(postEntry(t.ctx, { date: '2026-07-20', source: 'camt', description: 'Bankbuchung A', idempotencyKey: 'camt-a', lines: [{ account: t.acc('6500'), debit: 700 }, { account: t.acc('1020'), credit: 700 }] }));
  const reversed = must(postEntry(t.ctx, { date: '2026-07-20', source: 'camt', description: 'Bankbuchung R', idempotencyKey: 'camt-r', lines: [{ account: t.acc('6500'), debit: 300 }, { account: t.acc('1020'), credit: 300 }] }));
  const pay = must(recordPayment(t.ctx, { direction: 'incoming', date: '2026-07-20', amountMinor: 108100, currency: 'CHF', bankAccountId: t.acc('1020'), counterpartyKind: 'customer', counterpartyId: t.customerId, allocations: [{ documentId: inv.id, amountMinor: 108100 }], source: 'qr', intent: PAYMENT_INTENTS.record, idempotencyKey: 'a21' }));
  const db = t.store.db;
  const link = db.prepare("INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at) VALUES (?, ?, ?, 'journal_entry', ?, 'a20', ?)");
  link.run('legacy-a', t.workspaceId, lines.A, camtEntry.entryId, '2026-07-20T00:00:00.000Z');
  link.run('legacy-m', t.workspaceId, lines.M, hand.entryId, '2026-07-20T00:00:01.000Z');
  link.run('legacy-m2', t.workspaceId, lines.M2, hand.entryId, '2026-07-20T00:00:02.000Z');
  link.run('legacy-r', t.workspaceId, lines.R, reversed.entryId, '2026-07-20T00:00:03.000Z');
  link.run('legacy-f', t.workspaceId, lines.F, 'je_from_another_book', '2026-07-20T00:00:04.000Z');
  // A20 confirm_match { allocations[] } on V: one outgoing payment to a supplier bill, linked by kind
  // 'payment'; the payment was reversed later (critic H2: the reversed-payment clause of the adoption).
  const vb = postedBill(t, { grossMinor: 40000, seed: 'lg-v', vendorName: 'Lieferant V' });
  const vpay = must(recordPayment(t.ctx, { direction: 'outgoing', date: '2026-07-20', amountMinor: 40000, currency: 'CHF', bankAccountId: t.acc('1020'), allocations: [{ vendorBillId: vb.vendorBillId, amountMinor: 40000 }], source: 'camt', intent: PAYMENT_INTENTS.record, idempotencyKey: 'lg-v' }));
  db.prepare("INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at) VALUES ('legacy-v', ?, ?, 'payment', ?, 'a20', '2026-07-20T00:00:05.000Z')").run(t.workspaceId, lines.V, vpay.paymentId);
  must(reversePayment(t.ctx, { paymentId: vpay.paymentId, date: '2026-07-20', intent: PAYMENT_INTENTS.reverse, idempotencyKey: 'lg-v-rev' }));
  // A18 mark_batch_paid { bankTxnId } on RUN: the run's payments posted, the line linked by kind
  // 'payment_batch' (critic H2: the legacy-run claims of the adoption).
  const bills = [60000, 40000].map((a, i) => postedBill(t, { grossMinor: a, seed: `lg-run-${i}`, vendorName: `Lieferant Lauf ${i}` }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: SAVINGS_IBAN, idempotencyKey: `lg-cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-20', idempotencyKey: 'lg-batch' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'lg-gen' }));
  must(markBatchPaid(t.ctx, { batchId: batch.batchId, confirmation: true, valueDate: '2026-07-20', idempotencyKey: 'lg-paid' }));
  db.prepare("INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at) VALUES ('legacy-run', ?, ?, 'payment_batch', ?, 'a18', '2026-07-20T00:00:06.000Z')").run(t.workspaceId, lines.RUN, batch.batchId);
  // The Storno of R was posted after A20 linked it (by the raw tool, before the A39 chokepoint existed).
  must(reverseEntry(t.ctx, { entryId: reversed.entryId, idempotencyKey: 'rv-r' }));
  const credit = db.prepare('SELECT credit_id AS c FROM bank_txn WHERE id = ?').get(lines.P).c;
  db.prepare("UPDATE reconciliation_match SET status = 'applied', invoice_id = ?, payment_id = ?, applied_mode = 'partial', decided_by = 'a21', decided_at = '2026-07-20T00:00:00.000Z' WHERE id = ?").run(inv.id, pay.paymentId, credit);
  // A stored rule a human saved before A39 denied its verb (the rule is re-aimed underneath the save path).
  const rule = must(createAutomationRule(t.ctx, { name: 'vor A39', trigger: { event: 'invoice.issued' }, action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['a'] } }, idempotencyKey: 'rule' }));
  db.prepare("UPDATE automation_rule SET action_tool = 'reverse_payment' WHERE id = ?").run(rule.rule.ruleId);
  return { t, lines, hand, camtEntry, reversed, pay, credit, batchId: batch.batchId, ruleId: rule.rule.ruleId };
}

/**
 * Write the world to a generation-7 file exactly as a pre-A39 build left it, and answer its path: none of
 * A39's tables, triggers or indexes, and develop's UNIQUE `bank_txn_link_one_per_txn` ("one link per line,
 * ever", `camtSchema.ts` on develop 49e5ac1c), which generation 8 must drop.
 */
function asGeneration7(t, dir) {
  const path = join(dir, 'pre-a39.db');
  writeFileSync(path, t.store.db.serialize());
  const raw = new Database(path);
  raw.exec(`
    DROP TRIGGER IF EXISTS bank_txn_link_one_active;
    DROP TRIGGER IF EXISTS bank_txn_link_no_delete;
    DROP TRIGGER IF EXISTS bank_txn_link_no_update;
    DROP INDEX IF EXISTS bank_txn_link_by_txn;
    DROP TABLE IF EXISTS bank_line_claim;
    DROP TABLE IF EXISTS bank_line_decision;
    DROP TABLE IF EXISTS bank_txn_detail;
    CREATE UNIQUE INDEX bank_txn_link_one_per_txn ON bank_txn_link (workspace_id, bank_txn_id);
  `);
  raw.pragma('user_version = 7');
  raw.close();
  return path;
}

test('L1: a generation-7 book with legacy links is adopted ONCE by generation 8, every legacy leg claimed once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a39-mig-'));
  try {
    const { t, lines, hand, camtEntry, batchId, ruleId } = legacyWorld();
    const path = asGeneration7(t, dir);
    const before = new Database(path, { readonly: true });
    assert.ok(before.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'bank_txn_link_one_per_txn'").get(), 'the book carries develop\'s index');
    assert.equal(before.prepare("SELECT 1 FROM sqlite_master WHERE name = 'bank_line_decision'").get(), undefined, 'and none of A39\'s tables');
    before.close();
    const store = new SqliteStore({ location: path, clock: t.clock });
    try {
      assert.equal(store.db.pragma('user_version', { simple: true }), SCHEMA_GENERATION);
      assert.ok(SCHEMA_GENERATION >= 8, 'the book passed generation 8, the A39 adoption');
      assert.equal(store.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'bank_txn_link_one_per_txn'").get(), undefined, 'generation 8 dropped develop\'s one-link-ever index');
      const ctx = makeContext(store, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: systemIdGen });
      assert.equal(lineOf(ctx, lines.A).state, 'booked', 'the camt entry A20 created from the line: booked');
      assert.equal(lineOf(ctx, lines.M).state, 'matched', 'the hand entry: matched');
      assert.equal(lineOf(ctx, lines.P).state, 'booked', 'the A21 apply: booked, found through the declared credit_id');
      assert.equal(lineOf(ctx, lines.M2).state, 'open', 'the second line on the same entry: its leg is taken, it reads open');
      assert.equal(lineOf(ctx, lines.R).state, 'open', 'a reversed target is adopted superseded');
      assert.equal(lineOf(ctx, lines.F).state, 'open', 'a target that does not resolve here is adopted superseded');
      assert.equal(lineOf(ctx, lines.V).state, 'open', 'a legacy payment reversed later is adopted superseded');
      assert.equal(lineOf(ctx, lines.RUN).state, 'booked', 'a legacy run link is adopted live');
      const reasons = Object.fromEntries(
        store.db.prepare("SELECT link_id, supersede_reason FROM bank_line_decision WHERE workspace_id = ? AND target_kind = 'legacy'").all(t.workspaceId).map((r) => [r.link_id, r.supersede_reason]),
      );
      assert.deepEqual(
        { m2: reasons['legacy-m2'], r: reasons['legacy-r'], f: reasons['legacy-f'], a: reasons['legacy-a'], m: reasons['legacy-m'], v: reasons['legacy-v'], run: reasons['legacy-run'] },
        { m2: 'legacy_no_claimable_leg', r: 'legacy_target_reversed', f: 'legacy_target_unresolved', a: null, m: null, v: 'legacy_target_reversed', run: null },
      );
      // A, M and P hold one leg each; the run line holds the bank legs of BOTH its payments.
      assert.equal(claimedLegs(ctx).lineIds.size, 5);
      const runEntries = store.db
        .prepare('SELECT p.journal_entry_id AS e FROM payment_batch_item i JOIN payment p ON p.id = i.posted_payment_id WHERE i.batch_id = ? ORDER BY i.rowid')
        .all(batchId)
        .map((r) => r.e);
      const runClaims = store.db.prepare("SELECT entry_id AS e FROM bank_line_claim WHERE link_id = 'legacy-run' AND released_at IS NULL ORDER BY entry_id").all().map((r) => r.e);
      assert.deepEqual(runClaims, [...runEntries].sort(), 'the legacy run line claims each of its payments once');
      refused(bookBankLine(ctx, { bankTxnId: lines.M2, target: { kind: 'existing_entry', entryId: hand.entryId }, idempotencyKey: 'm2' }), 'entry_already_linked');
      refused(bookBankLine(ctx, { bankTxnId: lines.A2, target: { kind: 'existing_entry', entryId: camtEntry.entryId }, idempotencyKey: 'a2' }), 'entry_already_linked');
      assert.deepEqual(legClaimViolations(store, t.workspaceId), []);
      assert.deepEqual(multiActiveViolations(store, t.workspaceId), []);
      // The same generation disabled the rule on a verb A39 newly denies, with a system audit line.
      assert.equal(store.db.prepare('SELECT enabled FROM automation_rule WHERE id = ?').get(ruleId).enabled, 0);
      assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND actor = 'system' AND action = 'disable'").get(ruleId).n, 1);
    } finally {
      store.close();
    }
    // A re-open adopts nothing again: the generation is recorded, the rows do not move.
    const again = new SqliteStore({ location: path, clock: t.clock });
    try {
      const n = (tbl) => again.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE workspace_id = ?`).get(t.workspaceId).n;
      assert.deepEqual([n('bank_line_decision'), n('bank_line_claim'), n('bank_txn_link')], [8, 5, 8], 'eight adopted decisions, five claims, one link per legacy decision');
      // The upgraded book decides every legacy line again: a reopen and a rebook write a SECOND link on the
      // same line, which develop's one-link-ever index would refuse with a raw UNIQUE error (critic H2).
      const ctx = makeContext(again, { workspaceId: t.workspaceId, actor: 'user_1', clock: t.clock, ids: systemIdGen });
      must(reopenBankLine(ctx, { bankTxnId: lines.A, reason: 'falsch gebucht', idempotencyKey: 'up-a' }));
      must(bookBankLine(ctx, { bankTxnId: lines.A, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 700 }] }, idempotencyKey: 'up-a2' }));
      must(reopenBankLine(ctx, { bankTxnId: lines.M, reason: 'andere Buchung', idempotencyKey: 'up-m' }));
      assert.equal(must(bookBankLine(ctx, { bankTxnId: lines.M, target: { kind: 'existing_entry', entryId: hand.entryId }, idempotencyKey: 'up-m2' })).state, 'matched', 'the released leg is claimed again');
      must(reopenBankLine(ctx, { bankTxnId: lines.RUN, reason: 'prüfen', idempotencyKey: 'up-run' }));
      assert.equal(must(bookBankLine(ctx, { bankTxnId: lines.RUN, target: { kind: 'payment_batch', batchId }, idempotencyKey: 'up-run2' })).state, 'matched', 'the paid run is matched again');
      must(bookBankLine(ctx, { bankTxnId: lines.V, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 40000 }] }, idempotencyKey: 'up-v' }));
      assert.deepEqual(legClaimViolations(again, t.workspaceId), []);
      assert.deepEqual(multiActiveViolations(again, t.workspaceId), []);
    } finally {
      again.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  excuseClaimInvariant(); // the in-memory SOURCE workspace is pre-A39 on purpose (never migrated)
});

test('L1: nothing adopts at store open or before a write on a generation-8 book: a raw legacy link stays inert', () => {
  const t = world();
  const hand = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'Hand', idempotencyKey: 'h', lines: [{ account: t.acc('6500'), debit: 900 }, { account: t.acc('1020'), credit: 900 }] }));
  const { lines } = importLines(t, { statementId: 'IN', entries: [{ ref: 'X', amountMinor: 900, cd: 'DBIT' }, { ref: 'Z', amountMinor: 50, cd: 'DBIT' }] });
  t.store.db.prepare("INSERT INTO bank_txn_link (id, workspace_id, bank_txn_id, kind, target_id, created_by, created_at) VALUES ('raw-x', ?, ?, 'journal_entry', ?, 'raw', '2026-07-20')").run(t.workspaceId, lines.X, hand.entryId);
  must(bookBankLine(t.ctx, { bankTxnId: lines.Z, target: { kind: 'accounts', legs: [{ accountId: t.acc('6900'), amountMinor: 50 }] }, idempotencyKey: 'z' }));
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM bank_line_decision WHERE link_id = 'raw-x'").get().n, 0, 'the write adopted nothing');
  assert.equal(lineOf(t.ctx, lines.X).state, 'open', 'a link without a decision is inert');
  excuseClaimInvariant(); // the raw link is a deliberate pre-A39 row on a generation-8 book
});

/** Back up `t` and restore it into the SAME store: answers the copy's context. */
function restoredCopy(t, dir) {
  const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
  const backup = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }));
  const restored = must(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true }));
  return makeContext(t.store, { workspaceId: restored.workspaceId, actor: 'user_1', clock: t.clock, ids: systemIdGen });
}

test('L2 q3: after a generation-8 restore the camt credit is decided on the inbox only: apply and override refuse use_bank_inbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a39-q3-'));
  try {
    const t = world();
    issueInvoice(t.ctx, { contactId: t.customerId, key: 'i1' });
    importLines(t, { statementId: 'Q3', entries: [{ ref: 'C', amountMinor: 50000, cd: 'CRDT' }] });
    const ctx2 = restoredCopy(t, dir);
    const ws = ctx2.workspaceId;
    const line = t.store.db.prepare("SELECT id, credit_id FROM bank_txn WHERE workspace_id = ? AND entry_ref = 'C'").get(ws);
    const inv = t.store.db.prepare("SELECT id FROM document WHERE workspace_id = ? AND type = 'invoice'").get(ws).id;
    const acc3400 = t.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '3400'").get(ws).id;
    // Before and after the line is booked, the queue refuses the restored credit (known by credit_id).
    refused(applyQrMatch(ctx2, { creditId: line.credit_id, invoiceId: inv, mode: 'partial', confirmed: true, idempotencyKey: 'a0' }), 'use_bank_inbox');
    must(bookBankLine(ctx2, { bankTxnId: line.id, target: { kind: 'accounts', legs: [{ accountId: acc3400, amountMinor: 50000 }] }, idempotencyKey: 'b' }));
    refused(overrideQrMatch(ctx2, { creditId: line.credit_id, invoiceId: inv, idempotencyKey: 'o' }), 'use_bank_inbox');
    refused(applyQrMatch(ctx2, { creditId: line.credit_id, invoiceId: inv, mode: 'partial', confirmed: true, idempotencyKey: 'a' }), 'use_bank_inbox');
    const bank = t.store.db.prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS n FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id WHERE e.workspace_id = ? AND a.number = '1020' AND e.status = 'posted'`).get(ws).n;
    assert.equal(bank, 50000, 'ONE bank credit, booked once');
    assert.deepEqual(legClaimViolations(t.store, ws), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('L1: a pre-A39 backup (generation 7) is refused by G04 with incompatible_schema_version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a39-bk7-'));
  try {
    const t = world();
    const deps = { store: t.store, clock: t.clock, ids: t.ids, actor: 'user_1', backupDir: join(dir, 'b') };
    const backup = must(createBackup(deps, { workspaceId: t.workspaceId, idempotencyKey: 'bk' }));
    const manifestPath = join(backup.artifactRef, 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, schemaVersion: 7 }));
    const res = refused(restoreBackup(deps, { source: backup.artifactRef, newWorkspaceName: 'Alt AG', confirmed: true }), 'incompatible_schema_version');
    assert.equal(res.currentSchemaVersion, SCHEMA_GENERATION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
