// D191 money-path invariants for the disposal's proceeds link and its reverse (CLAUDE.md "The money path
// is unforgiving"): posting stays APPEND-ONLY, the link and the reverse are IDEMPOTENT ON ROWS, and
// §H-TENANT holds on every query the feature added. Each assertion here was run against a mutation of
// `dist/` and failed (D191 in DECISIONS.md names them); a non-author critic confirms they bite.
//
// Every fixture here is SYNTHETIC by construction (an invented company, customer and amounts).
import test from 'node:test';
import assert from 'node:assert/strict';

import { issueInvoice, secondWorkspace } from '../payments/support.mjs';
import { createCreditNote, issueCreditNote } from '../../dist/core/sales/index.js';
import { assetLedgerGet, assetTransactionReverse } from '../../dist/core/assets/index.js';
import { world } from './proceeds-support.mjs';

const entryWithLines = (w, id) => ({
  entry: w.store.db.prepare('SELECT * FROM journal_entry WHERE workspace_id = ? AND id = ?').get(w.workspaceId, id),
  lines: w.store.db.prepare('SELECT * FROM journal_line WHERE entry_id = ? ORDER BY rowid').all(id),
});

test('append-only: the reverse leaves the linked disposal row and its posted entry byte-identical and adds exactly one row and one mirror', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'ao1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  const disposalBefore = w.row(d.transaction.id);
  const postedBefore = entryWithLines(w, d.journalEntry.id);
  const before = w.rows();

  const r = w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: true, overrideReason: 'Gutschrift folgt' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(w.row(d.transaction.id), disposalBefore, 'the original disposal row, link included, is never edited');
  assert.deepEqual(entryWithLines(w, d.journalEntry.id), postedBefore, 'the posted disposal entry is never edited');
  const after = w.rows();
  assert.equal(after.assetTransactions, before.assetTransactions + 1, 'one compensating row');
  assert.equal(after.entries, before.entries + 1, 'one reversing entry');
  const mirror = entryWithLines(w, r.reversalEntryId);
  assert.equal(mirror.entry.reverses_entry_id, d.journalEntry.id, 'the correction is a new entry that names the original');

  // The link cannot be rewritten or cleared after the fact: the row is immutable by trigger.
  assert.throws(
    () => w.store.db.prepare('UPDATE asset_transaction SET source_document_id = NULL WHERE workspace_id = ? AND id = ?').run(w.workspaceId, d.transaction.id),
    /immutable|append-only|not allowed|ABORT|asset_transaction/i,
  );
  assert.throws(() => w.store.db.prepare('DELETE FROM asset_transaction WHERE workspace_id = ? AND id = ?').run(w.workspaceId, d.transaction.id));
});

test('idempotent on ROWS: a linked dispose and an overriding reverse, each called twice, write their rows and their audit once', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'id1' });
  const assetId = w.activeAsset();
  const first = w.dispose(assetId, { proceedsInvoiceId: inv.id }, undefined, 'disp-twice');
  assert.equal(first.ok, true, JSON.stringify(first));
  const afterDispose = w.rows();
  const again = w.dispose(assetId, { proceedsInvoiceId: inv.id }, undefined, 'disp-twice');
  assert.deepEqual(again, first, 'the replay answers the original');
  assert.deepEqual(w.rows(), afterDispose, 'a replayed dispose writes no second row, entry or audit');

  const extra = { overrideProceedsCheck: true, overrideReason: 'Gutschrift folgt' };
  const r1 = w.reverse(assetId, first.transaction.id, extra, 'rev-twice');
  assert.equal(r1.ok, true, JSON.stringify(r1));
  const afterReverse = w.rows();
  assert.equal(afterReverse.overrideAudits, 1);
  const r2 = w.reverse(assetId, first.transaction.id, extra, 'rev-twice');
  assert.deepEqual(r2, r1, 'the replay answers the original reverse');
  assert.deepEqual(w.rows(), afterReverse, 'a replayed reverse writes no second row, mirror, audit or override audit');

  // A second reverse under a NEW key is refused, not doubled: one mirror per event whatever the key.
  const r3 = w.reverse(assetId, first.transaction.id, extra, 'rev-new-key');
  assert.equal(r3.error, 'already_reversed', JSON.stringify(r3));
  assert.deepEqual(w.rows(), afterReverse);
});

test('§H-TENANT: a foreign payment or invoice cannot be linked, and the link reads answer the same for a foreign id as for an unknown one', () => {
  const w = world();
  const other = secondWorkspace(w);
  const foreignInvoice = issueInvoice(other.ctx, { contactId: other.customerId, key: 'tf1' });
  const foreignPayment = w.pay(other.ctx, { invoiceId: foreignInvoice.id, customerId: other.customerId, bankId: other.bankId, key: 'tfp1' });
  const assetId = w.activeAsset();
  const before = w.rows();
  for (const [link, field] of [
    [{ proceedsPaymentId: foreignPayment }, 'proceedsPaymentId'],
    [{ proceedsInvoiceId: foreignInvoice.id }, 'proceedsInvoiceId'],
  ]) {
    const r = w.dispose(assetId, link);
    assert.equal(r.error, 'invalid_proceeds_document', JSON.stringify(r));
    assert.equal(r.reason, 'not_found', 'a foreign id answers exactly as an unknown one');
    assert.equal(r.field, field);
  }
  assert.deepEqual(w.rows(), before, 'nothing was written');
});

test('§H-TENANT: a credit note in another workspace naming this invoice does not release the proceeds check', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'tc1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));

  // A full credit note in the OTHER workspace, re-pointed at this workspace's invoice id (the only way a
  // foreign row can name it: the API refuses a foreign invoice). Without the workspace filter on the
  // credited-gross read, this invoice would read as fully credited and the reverse would go through.
  const foreignInv = issueInvoice(other.ctx, { contactId: other.customerId, key: 'tc-f' });
  const cn = createCreditNote(other.ctx, { fromInvoiceId: foreignInv.id, mode: 'full', idempotencyKey: 'tc-cn' });
  assert.equal(cn.ok, true, JSON.stringify(cn));
  assert.equal(issueCreditNote(other.ctx, { creditNoteId: cn.document.id, idempotencyKey: 'tc-cn-issue' }).ok, true);
  w.store.db.prepare('UPDATE document SET credited_document_id = ? WHERE workspace_id = ? AND id = ?').run(inv.id, other.workspaceId, cn.document.id);
  assert.equal(
    w.store.db.prepare("SELECT COUNT(*) AS n FROM document WHERE type = 'credit_note' AND credited_document_id = ?").get(inv.id).n,
    1,
    'the foreign credit note now names this invoice',
  );

  assert.equal(assetLedgerGet(w.ctx, { assetId }).events.find((e) => e.type === 'disposal').proceedsDocumentStands, true);
  const r = w.reverse(assetId, d.transaction.id);
  assert.equal(r.error, 'proceeds_settled', 'the foreign credit note is invisible here');
});

test('§H-TENANT: the setting is read per workspace: another workspace switching the check off changes nothing here', () => {
  const w = world();
  const other = secondWorkspace(w);
  w.setCheck(other.ctx, 'off', 'other-off');
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'ts1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(assetLedgerGet(w.ctx, { assetId }).proceedsCheck, 'refuse');
  assert.equal(w.reverse(assetId, d.transaction.id).error, 'proceeds_settled');
});

test('§H-TENANT: a foreign asset or transaction id is not_found on the ledger read and the reverse, writing nothing', () => {
  const w = world();
  const other = secondWorkspace(w);
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 'tx1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(assetLedgerGet(other.ctx, { assetId }).error, 'not_found');
  const before = w.rows();
  const foreign = assetTransactionReverse(other.ctx, {
    assetId, transactionId: d.transaction.id, reason: 'fremd', idempotencyKey: 'tx-foreign',
    overrideProceedsCheck: true, overrideReason: 'fremd',
  });
  assert.equal(foreign.error, 'not_found', JSON.stringify(foreign));
  assert.deepEqual(w.rows(), before, 'nothing was written in the owning workspace');
  assert.equal(w.row(d.transaction.id).source_document_id, inv.id);
});
