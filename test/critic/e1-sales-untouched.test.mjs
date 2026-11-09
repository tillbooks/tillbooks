/**
 * CRITIC PROBES (bank-parity E1, the Belegnummer, D178 point 2). Non-author. Synthetic by construction:
 * an invented customer, creditor and amounts.
 *
 * A test that FAILS here is a finding; a passing one is evidence the claim holds.
 *
 * PROBE: the journal run shares A10's `document_number_seq` (type 'journal'). Invoice numbering must be
 * exactly what it was: R-2026-0001, -0002, -0003 in issue order, its counter alone in its row, while the
 * journal run counts every posting (the invoices' entries among them) in posting order.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { createDocument, issueInvoice } from '../../dist/core/sales/index.js';
import { postEntry } from '../../dist/core/ledger/index.js';

const AT = '2026-07-16T00:00:00.000Z';

test('[PROBE e1-sales] invoice numbers and their counter are unchanged; the journal run counts the invoices’ entries too', () => {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Probe GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll', mwst_no = 'CHE-102.673.386 MWST' WHERE id = ?").run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Probe GmbH',
    address: { street: 'Probeweg', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_p', ?, 'customer', 'Kundin AG', 'Weg', '2', '3000', 'Bern', 'CH', 'k@example.invalid', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  const acc = (n) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, n).id;
  const manual = (k) => {
    const r = postEntry(ctx, { date: '2026-07-16', source: 'manual', idempotencyKey: k, lines: [
      { account: acc('6500'), debit: 1000 },
      { account: acc('1020'), credit: 1000 },
    ] });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.entryId;
  };
  const invoice = (k) => {
    const d = createDocument(ctx, { type: 'invoice', contactId: 'ct_p', currency: 'CHF', lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }] });
    assert.equal(d.ok, true, JSON.stringify(d));
    const r = issueInvoice(ctx, { invoiceId: d.document.id, idempotencyKey: k });
    assert.equal(r.ok, true, JSON.stringify(r));
    return { number: r.document.number, entryId: store.db.prepare('SELECT posted_entry_id FROM document WHERE id = ?').get(d.document.id).posted_entry_id };
  };

  const order = [];
  order.push(manual('m1'));
  const i1 = invoice('i1');
  order.push(i1.entryId);
  order.push(manual('m2'));
  const i2 = invoice('i2');
  order.push(i2.entryId);
  const i3 = invoice('i3');
  order.push(i3.entryId);
  // A replayed post spends nothing on either run.
  assert.equal(postEntry(ctx, { date: '2026-07-16', source: 'manual', idempotencyKey: 'm2', lines: [
    { account: acc('6500'), debit: 1000 },
    { account: acc('1020'), credit: 1000 },
  ] }).entryId, order[2]);

  assert.deepEqual([i1.number, i2.number, i3.number], ['R-2026-0001', 'R-2026-0002', 'R-2026-0003']);
  const counters = store.db.prepare('SELECT type, year, next_value FROM document_number_seq WHERE workspace_id = ? ORDER BY type, year').all(workspaceId);
  assert.deepEqual(counters, [
    { type: 'invoice', year: '2026', next_value: 4 },
    { type: 'journal', year: 'all', next_value: 6 },
  ]);
  const shown = order.map((id) => store.db.prepare('SELECT display FROM journal_entry_number WHERE entry_id = ?').get(id)?.display ?? null);
  assert.deepEqual(shown, ['1', '2', '3', '4', '5'], 'the journal run counts every posting in posting order');
});
