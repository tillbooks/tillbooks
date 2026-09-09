/**
 * A15, Mahnwesen: the engine suite.
 *
 * Everything here dispatches through the registry (`getAction(...).run`), never the engine module
 * directly, so every assertion also covers the A24 gate, the boundary type check and the throw
 * guard, exactly as a real caller would meet them. The world is the fixture clock's (2026-07-16),
 * so "overdue" is a stated fact and not a race with the wall clock.
 *
 * The one property the capability exists for is asserted twice, at both moments it could break:
 * a FULLY PAID invoice never appears in a proposed run, and an invoice paid BETWEEN propose and
 * issue drops out at issue.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { AUTOMATION_EVENTS } from '../../dist/core/automation/index.js';
import { interestNoteMinor } from '../../dist/core/dunning/index.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace, recordingRelay } from '../api/support.mjs';

const TODAY = '2026-07-16';

const call = (deps, name, input) => getAction(name).run(deps, input);

/**
 * Deps whose clock the TEST can move forward. The escalation is a process that lives across weeks
 * (issue in May, escalate in June), and the D64 discipline means a backdated `asOf` correctly sees
 * nothing that was POSTED later, so the only honest way to exercise a multi-run history is to let
 * time actually pass. Same store-and-ids shape as `freshDeps`, plus `setNow`.
 */
function steppingDeps(startIso = '2026-05-01T00:00:00.000Z') {
  let now = startIso;
  const clock = { now: () => now };
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids: sequenceIdGen(), actor: 'agent' };
  return { deps, setNow: (iso) => (now = iso) };
}

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

/**
 * A workspace with VAT seeded, a QR-IBAN creditor profile, one customer with a postal address and
 * email, and one ISSUED CHF 1081.00 invoice due `dueDate`.
 */
function world({ dueDate = '2026-06-01', email = 'debitor@kunde.example' } = {}) {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Treuhand Muster GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'set_creditor_profile',
  );
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: 'Säumig AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      ...(email === null ? {} : { email }),
      idempotencyKey: 'w-contact',
    }),
    'create_contact',
  ).contact.id;
  const documentId = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate,
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'w-doc',
    }),
    'create_document',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: 'w-issue' }), 'issue_invoice');
  return { deps, workspaceId, accId, customerId, documentId };
}

/** An income account for the fee: the KMU seed's own first income account, read back by type. */
function feeAccount(deps, workspaceId) {
  const row = deps.store.db
    .prepare(`SELECT id FROM account WHERE workspace_id = ? AND type = 'income' ORDER BY number LIMIT 1`)
    .get(workspaceId);
  assert.ok(row !== undefined, 'the KMU seed carries no income account');
  return row.id;
}

/** The three-level policy with booked fees (20/30/40) and the interest note on at every level. */
function bookedFeePolicy(deps, workspaceId, feeAccountId) {
  const base = { bookFee: true, feeIncomeAccountId: feeAccountId, showInterest: true, interestBp: 500 };
  return must(
    call(deps, 'set_dunning_config', {
      workspaceId,
      levels: [
        { level: 1, daysOverdue: 10, feeMinor: 2000, ...base },
        { level: 2, daysOverdue: 20, feeMinor: 3000, ...base },
        { level: 3, daysOverdue: 30, feeMinor: 4000, ...base },
      ],
      idempotencyKey: 'w-config',
    }),
    'set_dunning_config',
  );
}

// --- Config ---------------------------------------------------------------------------------------

test('the shipped defaults are three levels at 10/20/30 days, no fee, interest floored at Art. 104', () => {
  const { deps, workspaceId } = world();
  const config = must(call(deps, 'get_dunning_config', { workspaceId }), 'get_dunning_config');
  assert.equal(config.configured, false);
  assert.deepEqual(
    config.levels.map((l) => [l.level, l.daysOverdue, l.feeMinor, l.bookFee]),
    [
      [1, 10, 0, false],
      [2, 20, 0, false],
      [3, 30, 0, false],
    ],
  );
  assert.equal(config.interestFloorBp, 500);
  for (const level of config.levels) assert.equal(level.interestBp, 500);
});

test('the policy validates: the interest floor, increasing thresholds, and the fee account', () => {
  const { deps, workspaceId, accId } = world();
  const below = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, showInterest: true, interestBp: 400 },
      { level: 2, daysOverdue: 20 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'cfg-low',
  });
  // Art. 104 Abs. 1 OR: only a HIGHER contractual rate is legal, so 4% is refused by name.
  assert.equal(below.error, 'interest_below_statutory_floor');

  const shuffled = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 20 },
      { level: 2, daysOverdue: 10 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'cfg-shuffled',
  });
  assert.equal(shuffled.error, 'invalid_input');

  const bookedWithoutAccount = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 2000, bookFee: true },
      { level: 2, daysOverdue: 20 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'cfg-noacc',
  });
  assert.equal(bookedWithoutAccount.error, 'needs_fee_income_account');

  // C6: a positive fee that does not book would be demanded by nothing (or demanded and never
  // recognised). The letter demands exactly what books, so the configuration is refused by name.
  const demandedUnbooked = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 2000, bookFee: false },
      { level: 2, daysOverdue: 20 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'cfg-noteonly',
  });
  assert.equal(demandedUnbooked.error, 'invalid_input');
  assert.equal(demandedUnbooked.reason, 'a_demanded_fee_must_book');

  // D69: the fee's VAT follows the chased invoice, so a per-level tax code is refused by name
  // rather than silently ignored.
  const staleTaxCode = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, taxCode: 'UST81' },
      { level: 2, daysOverdue: 20 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'cfg-taxcode',
  });
  assert.equal(staleTaxCode.error, 'invalid_input');
  assert.equal(staleTaxCode.reason, 'd69_fee_vat_follows_the_invoice');

  const nonRevenue = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 2000, bookFee: true, feeIncomeAccountId: accId('1000') },
      { level: 2, daysOverdue: 20 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'cfg-kasse',
  });
  assert.equal(nonRevenue.error, 'invalid_input');
});

// --- Propose --------------------------------------------------------------------------------------

test('propose reads A16, assigns level 1, groups the debtor, and is one run per day', () => {
  const { deps, workspaceId, customerId, documentId } = world();
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'p-1' }), 'propose');
  assert.equal(run.proposed, true);
  assert.equal(run.status, 'proposed');
  assert.equal(run.runDate, TODAY);
  assert.equal(run.items.length, 1);
  assert.equal(run.items[0].documentId, documentId);
  assert.equal(run.items[0].level, 1);
  assert.equal(run.items[0].debtorId, customerId);
  assert.equal(run.items[0].daysOverdue, 45);
  assert.equal(run.items[0].overdueMinor, 108100);
  assert.equal(run.debtors.length, 1);

  // A FRESH key on the same day returns the SAME run: the structural per-day identity, not the
  // idempotency table, is what answers.
  const again = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'p-2' }), 'repropose');
  assert.equal(again.existing, true);
  assert.equal(again.runId, run.runId);
  const count = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM dunning_run WHERE workspace_id = ?')
    .get(workspaceId).n;
  assert.equal(count, 1);
});

test('a future asOf is refused: a letter never chases a day that has not happened', () => {
  const { deps, workspaceId } = world();
  const future = call(deps, 'propose_dunning_run', { workspaceId, asOf: '2026-08-01', idempotencyKey: 'p-f' });
  assert.equal(future.error, 'invalid_input');
  assert.equal(future.reason, 'asOf_in_future');
});

test('nothing overdue is an empty answer, not an error and not a row', () => {
  const { deps, workspaceId } = world({ dueDate: '2026-08-30' });
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'p-none' }), 'propose');
  assert.equal(run.runId, null);
  assert.equal(run.proposed, false);
  assert.equal(run.reason, 'nothing_overdue');
  const count = deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM dunning_run WHERE workspace_id = ?')
    .get(workspaceId).n;
  assert.equal(count, 0);
});

test('a partial payment shrinks the proposed item to the remainder', () => {
  const { deps, workspaceId, accId, customerId, documentId } = world();
  must(
    call(deps, 'record_payment', {
      workspaceId,
      direction: 'incoming',
      date: '2026-07-01',
      amountMinor: 8100,
      bankAccountId: accId('1020'),
      counterpartyKind: 'customer',
      counterpartyId: customerId,
      allocations: [{ documentId, amountMinor: 8100 }],
      intent: 'post_payment',
      idempotencyKey: 'pay-part',
    }),
    'partial payment',
  );
  const partial = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'p-part' }), 'propose');
  assert.equal(partial.items.length, 1);
  assert.equal(partial.items[0].overdueMinor, 100000);
});

test('a fully paid invoice never appears in a proposed run', () => {
  const { deps, workspaceId, accId, customerId, documentId } = world();
  must(
    call(deps, 'record_payment', {
      workspaceId,
      direction: 'incoming',
      date: '2026-07-12',
      amountMinor: 108100,
      bankAccountId: accId('1020'),
      counterpartyKind: 'customer',
      counterpartyId: customerId,
      allocations: [{ documentId, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'pay-full',
    }),
    'settling payment',
  );
  const settled = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'p-settled' }), 'propose');
  assert.equal(settled.runId, null, 'a settled invoice must never be proposed');
});

/** The stepping world: an issued invoice due 2026-05-11, watched across three months. */
function steppingWorld() {
  const { deps, setNow } = steppingDeps('2026-05-01T00:00:00.000Z');
  const { workspaceId, accId } = mintWorkspace(deps);
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat_seed_defaults');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Treuhand Muster GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'set_creditor_profile',
  );
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: 'Säumig AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'debitor@kunde.example',
      idempotencyKey: 'sw-contact',
    }),
    'create_contact',
  ).contact.id;
  const documentId = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate: '2026-05-11',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'sw-doc',
    }),
    'create_document',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: 'sw-issue' }), 'issue_invoice');
  return { deps, setNow, workspaceId, accId, customerId, documentId };
}

test('the level advances 1 to 2 to 3 across issued runs as time passes, and level 3 is terminal', () => {
  const { deps, setNow, workspaceId, documentId } = steppingWorld();

  // Late May: 14 days overdue, first reminder.
  setNow('2026-05-25T00:00:00.000Z');
  const first = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'lv-1' }), 'propose 1');
  assert.equal(first.items[0].level, 1);
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: first.runId, confirmed: true, idempotencyKey: 'lv-1i' }), 'issue 1');

  // Mid June: past the level-2 threshold.
  setNow('2026-06-15T00:00:00.000Z');
  const second = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'lv-2' }), 'propose 2');
  assert.equal(second.items[0].level, 2, 'the second reminder escalates');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: second.runId, confirmed: true, idempotencyKey: 'lv-2i' }), 'issue 2');

  // Mid July: the third and last.
  setNow('2026-07-15T00:00:00.000Z');
  const third = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'lv-3' }), 'propose 3');
  assert.equal(third.items[0].level, 3);
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: third.runId, confirmed: true, idempotencyKey: 'lv-3i' }), 'issue 3');

  // Terminal: the next step is Betreibung, not a fourth letter.
  setNow('2026-08-15T00:00:00.000Z');
  const fourth = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'lv-4' }), 'propose 4');
  assert.equal(fourth.runId, null, 'an invoice at level 3 is never proposed again');

  // A16 reads the state back: the open item carries level 3.
  const open = must(call(deps, 'list_open_items', { workspaceId }), 'list_open_items');
  const item = open.items.find((i) => i.documentId === documentId);
  assert.equal(item.dunningLevel, 3);
});

test('a proposed-but-never-issued run asserts nothing: the level does not advance', () => {
  const { deps, setNow, workspaceId } = steppingWorld();
  setNow('2026-05-25T00:00:00.000Z');
  must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'na-1' }), 'propose 1');
  // Never issued. A later proposal starts again at level 1: no letter was ever produced.
  setNow('2026-06-15T00:00:00.000Z');
  const second = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'na-2' }), 'propose 2');
  assert.equal(second.items[0].level, 1);
});

// --- Issue ----------------------------------------------------------------------------------------

test('issue is P8-gated and needs the creditor block', () => {
  const { deps, workspaceId } = world();
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'i-p' }), 'propose');
  const unconfirmed = call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, idempotencyKey: 'i-1' });
  assert.equal(unconfirmed.error, 'needs_confirmation');

  // A workspace with no creditor profile refuses with the A00 CTA, before any write.
  const bare = freshDeps();
  const ws2 = mintWorkspace(bare);
  must(call(bare, 'vat_seed_defaults', { workspaceId: ws2.workspaceId }), 'vat_seed_defaults');
  must(call(bare, 'set_vat_method', { workspaceId: ws2.workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'set_vat_method');
  const c = must(
    call(bare, 'create_contact', { workspaceId: ws2.workspaceId, partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'b-c' }),
    'create_contact',
  ).contact.id;
  const doc = must(
    call(bare, 'create_document', {
      workspaceId: ws2.workspaceId,
      type: 'invoice',
      contactId: c,
      currency: 'CHF',
      dueDate: '2026-06-01',
      lines: [{ description: 'Beratung', unitPriceMinor: 50000, taxCode: 'UST81' }],
      idempotencyKey: 'b-d',
    }),
    'create_document',
  ).document.id;
  must(call(bare, 'issue_invoice', { workspaceId: ws2.workspaceId, invoiceId: doc, idempotencyKey: 'b-i' }), 'issue_invoice');
  const proposed = must(call(bare, 'propose_dunning_run', { workspaceId: ws2.workspaceId, idempotencyKey: 'b-p' }), 'propose');
  const refused = call(bare, 'issue_dunning_run', {
    workspaceId: ws2.workspaceId,
    runId: proposed.runId,
    confirmed: true,
    idempotencyKey: 'b-issue',
  });
  assert.equal(refused.error, 'needs_creditor_address');
});

test('issue books the Mahngebühr once: balanced entry, 1100 debit, reconciled A16, frozen note', () => {
  const { deps, workspaceId, accId, documentId } = world();
  bookedFeePolicy(deps, workspaceId, feeAccount(deps, workspaceId));

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'f-p' }), 'propose');
  assert.equal(run.items[0].feeMinor, 2000);

  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'f-i' }),
    'issue',
  );
  assert.equal(issued.status, 'issued');
  assert.ok(issued.feeEntryId, 'the fee entry id is on the run');
  assert.equal(issued.feeSkippedReason, null);

  // The entry: balanced, source 'dunning', 1100 debited by exactly the fee.
  const entry = must(call(deps, 'get_entry', { workspaceId, entryId: issued.feeEntryId }), 'get_entry');
  assert.equal(entry.entry.source, 'dunning');
  const receivableId = accId('1100');
  const receivableLines = entry.lines.filter((l) => l.account === receivableId);
  assert.equal(receivableLines.reduce((n, l) => n + (l.debit ?? 0), 0), 2000);
  const debits = entry.lines.reduce((n, l) => n + (l.debit ?? 0), 0);
  const credits = entry.lines.reduce((n, l) => n + (l.credit ?? 0), 0);
  assert.equal(debits, credits, 'the fee entry balances');

  // Idempotency on ROWS: the same key again mints no second entry.
  const replay = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'f-i' }),
    'issue replay',
  );
  assert.equal(replay.feeEntryId, issued.feeEntryId);
  const entries = deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning'`)
    .get(workspaceId).n;
  assert.equal(entries, 1);

  // A16 carries the fee ON the document's open item and still reconciles to 1100.
  const open = must(call(deps, 'list_open_items', { workspaceId }), 'list_open_items');
  const item = open.items.find((i) => i.documentId === documentId);
  assert.equal(item.dunningFeeMinor, 2000);
  assert.equal(item.openMinor, 110100);
  assert.equal(item.dunningLevel, 1);
  assert.equal(open.reconciled, true, `A16 must still tie to 1100: ${JSON.stringify(open, null, 2).slice(0, 400)}`);

  // The Verzugszins note froze on the item: 108100 x 5% x 45/360, rounded once.
  const view = must(call(deps, 'get_dunning_run', { workspaceId, runId: run.runId }), 'get_dunning_run');
  assert.equal(view.items[0].interestMinor, interestNoteMinor(108100, 500, 45));
});

test('reversing the fee entry takes the fee back out of A16, still reconciled (H-AUDIT)', () => {
  const { deps, workspaceId, documentId } = world();
  bookedFeePolicy(deps, workspaceId, feeAccount(deps, workspaceId));
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'r-p' }), 'propose');
  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'r-i' }),
    'issue',
  );
  must(call(deps, 'reverse_entry', { workspaceId, entryId: issued.feeEntryId, idempotencyKey: 'r-rev' }), 'reverse');
  const open = must(call(deps, 'list_open_items', { workspaceId }), 'list_open_items');
  const item = open.items.find((i) => i.documentId === documentId);
  assert.equal(item.dunningFeeMinor, 0);
  assert.equal(item.openMinor, 108100);
  assert.equal(open.reconciled, true);
});

test('a locked period skips the fee by name, the run still issues, and the fee is RECOVERABLE (H-PERIOD, C8)', () => {
  const { deps, workspaceId, customerId } = world();
  bookedFeePolicy(deps, workspaceId, feeAccount(deps, workspaceId));
  must(call(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'lock' }), 'lock_period');
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'lk-p' }), 'propose');
  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'lk-i' }),
    'issue',
  );
  assert.equal(issued.status, 'issued');
  assert.equal(issued.feeEntryId, null);
  assert.equal(issued.feeSkippedReason, 'period_locked');
  // The claim is DEFERRED, not destroyed: the item keeps its fee, unbooked (C8), and the letter
  // demands nothing for it until it books (C6).
  assert.equal(issued.items[0].feeMinor, 2000);
  assert.equal(issued.items[0].feeBooked, false);
  const skippedPdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  assert.equal(skippedPdf.pdf.qrParts[0].amountMinor, 108100, 'the QR demands only what the ledger carries');

  // Re-issuing while STILL locked is the honest refusal, not illegal_transition and not a loss.
  const stillLocked = call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'lk-r1' });
  assert.equal(stillLocked.error, 'period_locked');

  // Unlock, re-issue: the skipped fee books, once, and joins the demand.
  must(call(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'lk-unlock' }), 'unlock_period');
  const recovered = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'lk-r2' }),
    'recover',
  );
  assert.equal(recovered.feeRecovered, true);
  assert.ok(recovered.feeEntryId, 'the skipped fee is now on the ledger');
  assert.equal(recovered.feeSkippedReason, null);
  assert.equal(recovered.items[0].feeBooked, true);
  const entries = deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning'`)
    .get(workspaceId).n;
  assert.equal(entries, 1);
  // And exactly once: with nothing left to recover, a further issue is the plain illegal
  // transition again, and no second entry exists.
  const again = call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'lk-r3' });
  assert.equal(again.error, 'illegal_transition');
  const entriesAfter = deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning'`)
    .get(workspaceId).n;
  assert.equal(entriesAfter, 1);
  // D73: the recovery booked the fee to the LEDGER and never to this letter. The reprint is the
  // letter as issued (the demand froze), and the fee's demand arrives one escalation later,
  // through A16's open item.
  const recoveredPdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf 2');
  assert.equal(recoveredPdf.pdf.base64, skippedPdf.pdf.base64, 'the reprint is byte-identical to the issued letter');
  assert.equal(recoveredPdf.pdf.qrParts[0].amountMinor, 108100, 'the frozen demand never gains the recovered fee');
  const openAfter = must(call(deps, 'list_open_items', { workspaceId }), 'open items after recovery');
  assert.equal(openAfter.items[0].dunningFeeMinor, 2000, 'the recovered fee rides the open item toward the next letter');
  assert.equal(openAfter.reconciled, true);
});

test('an invoice paid between propose and issue drops out at issue', () => {
  const { deps, workspaceId, accId, customerId, documentId } = world();
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'd-p' }), 'propose');
  assert.equal(run.items.length, 1);
  must(
    call(deps, 'record_payment', {
      workspaceId,
      direction: 'incoming',
      date: TODAY,
      amountMinor: 108100,
      bankAccountId: accId('1020'),
      counterpartyKind: 'customer',
      counterpartyId: customerId,
      allocations: [{ documentId, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'd-pay',
    }),
    'payment',
  );
  const refused = call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'd-i' });
  assert.equal(refused.error, 'nothing_to_issue');
  const view = must(call(deps, 'get_dunning_run', { workspaceId, runId: run.runId }), 'get_dunning_run');
  assert.equal(view.status, 'proposed', 'a run with nothing left to chase never issues');
});

// --- The letter -----------------------------------------------------------------------------------

test('the letter renders per debtor with one QR payment part per invoice, deterministically', () => {
  const { deps, workspaceId, customerId, documentId } = world();
  bookedFeePolicy(deps, workspaceId, feeAccount(deps, workspaceId));
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'pdf-p' }), 'propose');

  // M-1's shape: a proposed run has no letter, the figures have not frozen.
  const early = call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId });
  assert.equal(early.error, 'not_available');

  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'pdf-i' }), 'issue');
  const rendered = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  const bytes = Buffer.from(rendered.pdf.base64, 'base64').toString('latin1');
  assert.ok(bytes.startsWith('%PDF-1.4'), 'a real PDF header');
  assert.ok(bytes.includes('Zahlungserinnerung'), 'the level-1 title');
  assert.equal(rendered.pdf.pages, 2, 'the letter page plus one payment part per invoice');
  assert.equal(rendered.pdf.qrParts.length, 1);
  assert.equal(rendered.pdf.qrParts[0].documentId, documentId);
  assert.equal(rendered.pdf.qrParts[0].hasQr, true, JSON.stringify(rendered.pdf.qrParts[0]));
  // Open amount + booked fee, the figure the debtor is actually asked to pay.
  assert.equal(rendered.pdf.qrParts[0].amountMinor, 110100);
  assert.match(rendered.pdf.qrParts[0].reference, /^\d{27}$/, 'a QRR reference under a QR-IBAN');

  const again = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf again');
  assert.equal(again.pdf.base64, rendered.pdf.base64, 'same frozen rows, same bytes');
});

// --- Send -----------------------------------------------------------------------------------------

test('send degrades honestly without a transport, and transmits once per debtor with one', () => {
  const { deps, workspaceId } = world();
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 's-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 's-i' }), 'issue');

  const unconfirmed = call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, idempotencyKey: 's-0' });
  assert.equal(unconfirmed.error, 'needs_confirmation');

  const noTransport = call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 's-1' });
  assert.equal(noTransport.error, 'needs_email_config');

  const relay = recordingRelay();
  deps.emailRelay = relay;
  const sent = must(
    call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 's-2' }),
    'send',
  );
  assert.equal(sent.status, 'sent');
  assert.equal(sent.transmitted, 1);
  assert.equal(relay.sent.length, 1);
  assert.equal(relay.sent[0].to, 'debitor@kunde.example');
  assert.equal(relay.sent[0].subject, 'Zahlungserinnerung');

  // Idempotent: the settled outcome replays and nothing is transmitted again.
  const replay = must(
    call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 's-2' }),
    'send replay',
  );
  assert.equal(replay.transmitted, 1, 'the memoised result, byte-identical');
  assert.equal(relay.sent.length, 1, 'no second email left the building');

  // A fresh key on a fully sent run re-asserts without transmitting either.
  const reassert = must(
    call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 's-3' }),
    'send re-assert',
  );
  assert.equal(reassert.alreadySent, true);
  assert.equal(relay.sent.length, 1);
});

test('a debtor without an email keeps a downloadable letter and the run stays issued', () => {
  const { deps, workspaceId, customerId } = world({ email: null });
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'ne-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'ne-i' }), 'issue');
  deps.emailRelay = recordingRelay();
  const outcome = must(
    call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'ne-s' }),
    'send',
  );
  assert.equal(outcome.status, 'issued');
  assert.equal(outcome.transmitted, 0);
  assert.deepEqual(
    outcome.outcomes.map((o) => o.outcome),
    ['no_email'],
  );
  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  assert.ok(pdf.pdf.byteLength > 0);
});

test('send re-validates settlement: a debtor paid after issue is skipped by name, the rest still send', () => {
  const { deps, workspaceId, accId, customerId, documentId } = world();
  // A second debtor with an invoice of its own, so the skip and the send meet in ONE call.
  const customer2 = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: 'Offen AG',
      address: { street: 'Seestrasse', houseNo: '2', zip: '6300', city: 'Zug', country: 'CH' },
      email: 'zwei@kunde.example',
      idempotencyKey: 'sv-contact2',
    }),
    'create_contact 2',
  ).contact.id;
  const document2 = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customer2,
      currency: 'CHF',
      dueDate: '2026-06-01',
      lines: [{ description: 'Beratung', unitPriceMinor: 50000, taxCode: 'UST81' }],
      idempotencyKey: 'sv-doc2',
    }),
    'create_document 2',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: document2, idempotencyKey: 'sv-issue2' }), 'issue_invoice 2');

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'sv-p' }), 'propose');
  assert.equal(run.items.length, 2);
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'sv-i' }), 'issue');

  // The first debtor pays IN FULL after issue: US-A15.4's last moment is now the send.
  must(
    call(deps, 'record_payment', {
      workspaceId,
      direction: 'incoming',
      date: TODAY,
      amountMinor: 108100,
      bankAccountId: accId('1020'),
      counterpartyKind: 'customer',
      counterpartyId: customerId,
      allocations: [{ documentId, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'sv-pay',
    }),
    'settling payment',
  );

  const relay = recordingRelay();
  deps.emailRelay = relay;
  const sent = must(
    call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'sv-s' }),
    'send',
  );
  // The settled debtor's letter never reached the transport; the open debtor's did.
  assert.equal(relay.sent.length, 1, 'exactly one email left the building');
  assert.equal(relay.sent[0].to, 'zwei@kunde.example');
  assert.equal(sent.transmitted, 1);
  // The skip is COUNTED AND NAMED, never silent. A FULL payment is named 'paid' distinctly (K-31 f2),
  // never the old blanket 'settled_since_issue' that read the same for a partial payment or a
  // cancellation.
  const skipped = sent.outcomes.find((o) => o.debtorId === customerId);
  assert.equal(skipped.outcome, 'paid');
  assert.deepEqual(skipped.settledDocumentIds, [documentId]);
  assert.deepEqual(skipped.changedItems, [{ documentId, reason: 'paid' }]);
  assert.deepEqual(sent.skippedSettled, [documentId]);
  const transmittedOutcome = sent.outcomes.find((o) => o.debtorId === customer2);
  assert.equal(transmittedOutcome.outcome, 'sent');
  // The run stays 'issued': not every letter went out, and the status never claims it did.
  assert.equal(sent.status, 'issued');
  // D73 stands: the frozen rows and the frozen letter are untouched by the skip.
  const view = must(call(deps, 'get_dunning_run', { workspaceId, runId: run.runId }), 'get_dunning_run');
  const frozenItem = view.items.find((i) => i.documentId === documentId);
  assert.equal(frozenItem.overdueMinor, 108100, 'the frozen demand is evidence, not a live figure');
});

test('a letter naming ANY settled invoice is skipped whole: the frozen PDF cannot shed an item', () => {
  const { deps, workspaceId, accId, customerId, documentId } = world();
  // A second overdue invoice for the SAME debtor, so one letter carries two invoices.
  const document2 = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate: '2026-06-01',
      lines: [{ description: 'Support', unitPriceMinor: 50000, taxCode: 'UST81' }],
      idempotencyKey: 'pv-doc2',
    }),
    'create_document 2',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: document2, idempotencyKey: 'pv-issue2' }), 'issue_invoice 2');

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'pv-p' }), 'propose');
  assert.equal(run.items.length, 2);
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'pv-i' }), 'issue');

  // One of the two invoices settles after issue. The letter still names it, so the letter must not go.
  must(
    call(deps, 'record_payment', {
      workspaceId,
      direction: 'incoming',
      date: TODAY,
      amountMinor: 108100,
      bankAccountId: accId('1020'),
      counterpartyKind: 'customer',
      counterpartyId: customerId,
      allocations: [{ documentId, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'pv-pay',
    }),
    'settling payment',
  );

  const relay = recordingRelay();
  deps.emailRelay = relay;
  const sent = must(
    call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'pv-s' }),
    'send',
  );
  assert.equal(relay.sent.length, 0, 'no email left the building');
  assert.equal(sent.transmitted, 0);
  assert.deepEqual(
    sent.outcomes,
    [
      {
        debtorId: customerId,
        outcome: 'paid',
        settledDocumentIds: [documentId],
        changedItems: [{ documentId, reason: 'paid' }],
      },
    ],
  );
  assert.deepEqual(sent.skippedSettled, [documentId]);
  assert.equal(sent.status, 'issued');
  // The still-open invoice keeps its honest paths: the frozen PDF stays downloadable as issued,
  // and the escalation machine owes it the NEXT letter, never a shrunken reprint of this one.
  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  assert.ok(pdf.pdf.byteLength > 0);
});

// --- Tenancy and automation -----------------------------------------------------------------------

test('H-TENANT: a run is invisible from a foreign workspace', () => {
  const { deps, workspaceId } = world();
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 't-p' }), 'propose');
  // A DISTINCT idempotency key: the default 'ws' would replay the FIRST workspace's minting and
  // hand back the same tenant, which is exactly the kind of quiet fixture lie this suite hunts.
  const other = mintWorkspace(deps, 'Fremde AG', 'ws-other').workspaceId;
  const foreign = call(deps, 'get_dunning_run', { workspaceId: other, runId: run.runId });
  assert.equal(foreign.error, 'not_found');
  const list = must(call(deps, 'list_dunning_runs', { workspaceId: other }), 'list');
  assert.equal(list.runs.length, 0);
});

test('the three automation events are registered with payload-true entity paths', () => {
  const rows = AUTOMATION_EVENTS.filter((e) => e.event.startsWith('dunning.'));
  assert.deepEqual(
    rows.map((e) => [e.event, e.emittedBy, e.entityKind, e.entityIdPath]),
    [
      ['dunning.proposed', 'propose_dunning_run', 'dunning_run', 'result.runId'],
      ['dunning.issued', 'issue_dunning_run', 'dunning_run', 'input.runId'],
      ['dunning.sent', 'send_dunning_run', 'dunning_run', 'input.runId'],
    ],
  );
});
