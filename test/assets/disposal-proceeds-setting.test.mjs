// D191 + D172: `assets.proceeds_check` decides what `asset_transaction_reverse` does with a disposal whose
// linked proceeds document still stands: `refuse` (default, the owner's Q4 rule), `warn` (reverse and
// name the document in `warnings`) or `off` (no check). The per-call `overrideProceedsCheck` stays the
// single differing case under `refuse`; under `warn` or `off` it bypasses nothing and is not recorded.
//
// Every fixture here is SYNTHETIC by construction (an invented company, customer and amounts).
import test from 'node:test';
import assert from 'node:assert/strict';

import { issueInvoice } from '../payments/support.mjs';
import { settingDef } from '../../dist/core/settings/registry.js';
import { settingsReset } from '../../dist/core/settings/index.js';
import { assetLedgerGet } from '../../dist/core/assets/index.js';
import { world, PROCEEDS_CHECK } from './proceeds-support.mjs';

test('D191 registry: assets.proceeds_check is refuse | warn | off, default refuse, owned by post, drafted under post', () => {
  const s = settingDef(PROCEEDS_CHECK);
  assert.deepEqual(s.schema, { type: 'enum', values: ['refuse', 'warn', 'off'] });
  assert.equal(s.default, 'refuse');
  assert.equal(s.owningCapability, 'post', 'the capability asset_transaction_reverse asserts');
  assert.equal(s.dialCapability, 'post', 'the family asset_transaction_reverse drafts under, never cheaper');
  assert.ok(s.label['de-CH'].length > 0 && s.description['de-CH'].length > 0);
});

test('D191 setting default: with no stored value the reverse refuses proceeds_settled and asset_ledger_get reports refuse', () => {
  const w = world();
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 's1' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(assetLedgerGet(w.ctx, { assetId }).proceedsCheck, 'refuse');
  assert.equal(w.reverse(assetId, d.transaction.id).error, 'proceeds_settled');
});

test('D191 setting warn: the reverse goes ahead, names the standing document in warnings, and records no override', () => {
  const w = world();
  w.setCheck(w.ctx, 'warn');
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 's2' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(assetLedgerGet(w.ctx, { assetId }).proceedsCheck, 'warn');
  const r = w.reverse(assetId, d.transaction.id, { overrideProceedsCheck: true, overrideReason: 'nicht nötig' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].code, 'proceeds_document_stands');
  assert.equal(r.warnings[0].proceedsDocumentType, 'invoice');
  assert.equal(r.warnings[0].proceedsDocumentId, inv.id);
  assert.equal(r.proceedsCheckOverridden, false, 'under warn nothing was refused, so nothing was overridden');
  assert.doesNotMatch(w.row(r.reversalTransactionId).description, /übersteuert/);
  assert.equal(w.audits.some((e) => e.action === 'override_proceeds_check'), false);
});

test('D191 setting off: the reverse does not check, carries no warning, and the link stays a reported fact', () => {
  const w = world();
  w.setCheck(w.ctx, 'off');
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 's3' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.row(d.transaction.id).source_document_id, inv.id, 'the link is stored whatever the setting says');
  const ledger = assetLedgerGet(w.ctx, { assetId });
  assert.equal(ledger.proceedsCheck, 'off');
  assert.equal(ledger.events.find((e) => e.type === 'disposal').proceedsDocumentStands, true);
  const r = w.reverse(assetId, d.transaction.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.warnings, []);
  assert.equal(r.proceedsCheckOverridden, false);
});

test('D191 setting: a reset returns to refuse, and the in-transaction re-read sees a change made after the friendly check', () => {
  const w = world();
  w.setCheck(w.ctx, 'off');
  const reset = settingsReset(w.ctx, { key: PROCEEDS_CHECK, reason: 'Testfall', idempotencyKey: 'pc-reset' });
  assert.equal(reset.ok, true, JSON.stringify(reset));
  const inv = issueInvoice(w.ctx, { contactId: w.customerId, key: 's4' });
  const assetId = w.activeAsset();
  const d = w.dispose(assetId, { proceedsInvoiceId: inv.id });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(w.reverse(assetId, d.transaction.id, {}, 'after-reset').error, 'proceeds_settled');

  // D12: the friendly pre-check reads `off`; the setting moves to `refuse` before the write lock; the
  // re-read inside the transaction refuses, writing nothing.
  w.setCheck(w.ctx, 'off', 'pc-off-2');
  const before = w.rows();
  const store = w.store;
  const realTx = store.tx;
  let flipped = false;
  store.tx = function (fn) {
    store.tx = realTx;
    flipped = true;
    store.db.prepare("UPDATE workspace_setting SET value_json = '\"refuse\"' WHERE workspace_id = ? AND key = ?").run(w.workspaceId, PROCEEDS_CHECK);
    return realTx.call(store, fn);
  };
  let raced;
  try {
    raced = w.reverse(assetId, d.transaction.id, {}, 'raced');
  } finally {
    store.tx = realTx;
  }
  assert.equal(flipped, true, 'the setting moved between the friendly check and the write transaction');
  assert.equal(raced.error, 'proceeds_settled', JSON.stringify(raced));
  const after = w.rows();
  assert.equal(after.assetTransactions, before.assetTransactions);
  assert.equal(after.entries, before.entries);
});
