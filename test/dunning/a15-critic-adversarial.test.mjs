/**
 * A15 CRITIC probes (docs/critique/a15-critic.md), ADOPTED as permanent regressions by the
 * remediation round (31.07.2026).
 *
 * The critic wrote each probe to FAIL iff the defect it names is real, which means most of them
 * already assert the CORRECT behaviour and simply turn green once the defect is repaired: C1, C2,
 * C4, C6, C8, C9 (encoding), C11, C12 and C13 are byte-for-byte the critic's probes. FOUR are
 * adapted, each because an owner decision or a repaired contract changed what "correct" is, and
 * each flip is documented at the probe so the re-critic's mutation test can judge it:
 *
 *  - **C3** measured a note-only fee demanded by the QR but never booked. The repair (C6's
 *    contract: THE LETTER DEMANDS EXACTLY WHAT BOOKS) removed note-only fees from the product:
 *    `set_dunning_config` now refuses a positive fee that does not book. The probe therefore
 *    asserts the REFUSAL, plus the original invariant (QR amount == the ledger's receivable) on a
 *    legal fee-less policy.
 *  - **C5** measured that a period-skipped fee was unrecoverable. The repair keeps the fee on the
 *    items (`fee_booked = 0`) and makes `issue_dunning_run` on the skipped run BOOK it once the
 *    period allows, so the probe now walks the recovery: skip, refuse-while-locked, unlock, book
 *    once.
 *  - **C7** seeded its policy with `taxCode: 'UST81'`, which D69 removed from the config surface
 *    entirely (the fee's VAT follows the chased invoice, split pro rata). The seeding drops the
 *    field; the assertion (a mixed-rate invoice's fee books at MORE than one code) is unchanged
 *    and is D69's own acceptance test.
 *  - **C10** asserted `send_dunning_run` joins the denylist, explicitly flagged by the critic as
 *    an owner question. The owner answered (D70, 31.07.2026): send STAYS automatable, parity with
 *    `send_invoice`, the safety being the repaired C1-C4 invariants. The probe's polarity is
 *    FLIPPED to pin that decision.
 *
 * Everything dispatches through the registry, exactly as the author's suite does.
 *
 * ROUND 2 ADOPTIONS (31.07.2026, docs/critique/a15-critic.md round-2 section): **R7** is adopted
 * byte-for-byte in spirit and turns green through D73 (the demand freezes at issue: the recovery
 * books the fee to the ledger and the reprint stays the mailed bytes; the probe's assert was
 * already the correct behaviour). **R15** is adopted verbatim: the round-2 mutation test showed the
 * D69 `taxCode` refusal was pinned by nothing, so this is the pin, and the refusal STAYS (a pre-D69
 * caller must learn why its field died, not be silently ignored). **N5** gains its own pin: a
 * letter whose claim carries earlier Mahngebühren itemises them beside the invoice's own open
 * amount, never folds them in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { interestNoteMinor } from '../../dist/core/dunning/index.js';
import { NOT_AUTOMATABLE } from '../../dist/core/automation/denylist.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { freshDeps, mintWorkspace, recordingRelay } from '../api/support.mjs';

const call = (deps, name, input) => getAction(name).run(deps, input);

function must(res, what) {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
}

function steppingDeps(startIso = '2026-05-01T00:00:00.000Z') {
  let now = startIso;
  const clock = { now: () => now };
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids: sequenceIdGen(), actor: 'agent' };
  return { deps, setNow: (iso) => (now = iso) };
}

/** The shared world: a QR-IBAN creditor, one addressed customer, one issued CHF invoice. */
function seed(deps, { dueDate = '2026-06-01', lines, prefix = 'w' } = {}) {
  const { workspaceId, accId } = mintWorkspace(deps, 'Acme GmbH', `${prefix}-ws`);
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
      idempotencyKey: `${prefix}-contact`,
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
      lines: lines ?? [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: `${prefix}-doc`,
    }),
    'create_document',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `${prefix}-issue` }), 'issue');
  return { workspaceId, accId, customerId, documentId };
}

function feeAccount(deps, workspaceId, number = '3999', key = 'fee-acc') {
  const res = must(
    call(deps, 'create_account', {
      workspaceId,
      number,
      name: 'Mahngebühren',
      type: 'income',
      idempotencyKey: key,
    }),
    'create_account',
  );
  return res.account?.id ?? res.accountId ?? res.id;
}

function policy(deps, workspaceId, overrides = {}, key = 'cfg') {
  const base = {
    feeMinor: 2000,
    bookFee: true,
    showInterest: true,
    interestBp: 500,
    ...overrides,
  };
  return must(
    call(deps, 'set_dunning_config', {
      workspaceId,
      levels: [
        { level: 1, daysOverdue: 10, ...base },
        { level: 2, daysOverdue: 20, ...base },
        { level: 3, daysOverdue: 30, ...base },
      ],
      idempotencyKey: key,
    }),
    'set_dunning_config',
  );
}

// --- C1: two stale proposals both issue at the SAME level and both book a Mahngebühr ------------

test('C1: a second proposal on a later day re-proposes level 1, and BOTH runs issue with a fee', () => {
  const { deps, setNow } = steppingDeps('2026-05-20T00:00:00.000Z');
  const { workspaceId, documentId } = seed(deps, { dueDate: '2026-05-01', prefix: 'c1' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });

  // Day 1: propose. Not issued yet, so the level does not advance.
  setNow('2026-05-20T00:00:00.000Z');
  const runA = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c1-a' }), 'propose A');
  assert.equal(runA.items[0].level, 1);

  // Day 2: propose again. A15 keys idempotency on runDate, so this is a SECOND live draft over the
  // same invoice, at the same level.
  setNow('2026-05-21T00:00:00.000Z');
  const runB = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c1-b' }), 'propose B');
  assert.notEqual(runB.runId, runA.runId, 'two live drafts exist for one invoice');
  assert.equal(runB.items[0].level, 1);

  // Both issue. Nothing at issue re-checks the escalation state, so the invoice gets two identical
  // "1. Mahnung" letters and two Mahngebühren.
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: runB.runId, confirmed: true, idempotencyKey: 'c1-bi' }), 'issue B');
  const secondIssue = call(deps, 'issue_dunning_run', { workspaceId, runId: runA.runId, confirmed: true, idempotencyKey: 'c1-ai' });

  const feeEntries = deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning'`)
    .get(workspaceId).n;
  const open = must(call(deps, 'list_open_items', { workspaceId }), 'list_open_items');
  const item = open.items.find((i) => i.documentId === documentId);

  assert.equal(
    secondIssue.ok,
    false,
    `the stale level-1 run issued a SECOND time: fee entries=${feeEntries}, dunningFeeMinor=${item?.dunningFeeMinor}`,
  );
});

// --- C2: Verzugszins is computed on an amount that already contains a booked Mahngebühr ---------

test('C2: the level-2 Verzugszins note is computed on invoice + level-1 Mahngebühr', () => {
  const { deps, setNow } = steppingDeps('2026-05-01T00:00:00.000Z');
  const { workspaceId, documentId } = seed(deps, { dueDate: '2026-05-11', prefix: 'c2' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });

  setNow('2026-05-25T00:00:00.000Z');
  const first = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c2-1' }), 'propose 1');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: first.runId, confirmed: true, idempotencyKey: 'c2-1i' }), 'issue 1');

  setNow('2026-06-15T00:00:00.000Z');
  const second = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c2-2' }), 'propose 2');
  const item = second.items[0];
  assert.equal(item.level, 2);

  const invoiceOnly = 108100;
  const withFee = invoiceOnly + 2000;
  assert.equal(item.overdueMinor, withFee, 'the level-2 base already carries the level-1 fee');
  assert.equal(
    item.interestMinor,
    interestNoteMinor(invoiceOnly, 500, item.daysOverdue),
    `Art. 104 OR interest must run on the principal, not on the Mahngebühr: got ${item.interestMinor}, ` +
      `principal-only would be ${interestNoteMinor(invoiceOnly, 500, item.daysOverdue)}, ` +
      `fee-inclusive is ${interestNoteMinor(withFee, 500, item.daysOverdue)}`,
  );
});

// --- C3: a note-only fee is DEMANDED by the QR payment part but never booked --------------------
// ADAPTED at adoption (see the header): the repair removed note-only fees from the product, so the
// probe asserts the config refusal AND the invariant it was defending (QR amount == receivable).

test('C3: a demanded-but-unbooked Mahngebühr is refused at config, and the QR never exceeds the receivable', () => {
  const deps = freshDeps();
  const { workspaceId, customerId, documentId } = seed(deps, { prefix: 'c3' });
  // bookFee false, fee 20.00: the original spec called this "note-only". C6's contract (the letter
  // demands exactly what books) makes it unrepresentable rather than un-demanded.
  const refused = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 2000, bookFee: false },
      { level: 2, daysOverdue: 20 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'c3-cfg',
  });
  assert.equal(refused.ok, false, 'a demanded fee that does not book must be refused');
  assert.equal(refused.reason, 'a_demanded_fee_must_book');

  // The invariant the probe defended, on a legal fee-less policy: the payment part asks for
  // exactly the ledger's receivable, nothing more.
  policy(deps, workspaceId, { bookFee: false, feeIncomeAccountId: null, feeMinor: 0 });
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c3-p' }), 'propose');
  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c3-i' }),
    'issue',
  );
  assert.equal(issued.feeEntryId, null, 'no fee, nothing books');

  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  const part = pdf.pdf.qrParts[0];
  const open = must(call(deps, 'list_open_items', { workspaceId }), 'list_open_items');
  const receivable = open.items.find((i) => i.documentId === documentId).openMinor;

  assert.equal(
    part.amountMinor,
    receivable,
    `the payment part asks for ${part.amountMinor} while the ledger's receivable is ${receivable}`,
  );
});

// --- C4: a FULLY PAID invoice keeps being dunned because its booked fee rides the same row ------

test('C4: after the invoice is paid in full, the next Mahnung still chases "Rechnung ... offen"', () => {
  const { deps, setNow } = steppingDeps('2026-05-01T00:00:00.000Z');
  const { workspaceId, accId, customerId, documentId } = seed(deps, { dueDate: '2026-05-11', prefix: 'c4' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });

  setNow('2026-05-25T00:00:00.000Z');
  const first = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c4-1' }), 'propose 1');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: first.runId, confirmed: true, idempotencyKey: 'c4-1i' }), 'issue 1');

  // The customer pays the INVOICE in full (108100). The fee (2000) is not an allocation target.
  must(
    call(deps, 'record_payment', {
      workspaceId,
      direction: 'incoming',
      date: '2026-05-26',
      amountMinor: 108100,
      bankAccountId: accId('1020'),
      counterpartyKind: 'customer',
      counterpartyId: customerId,
      allocations: [{ documentId, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'c4-pay',
    }),
    'record_payment',
  );

  setNow('2026-06-15T00:00:00.000Z');
  const second = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c4-2' }), 'propose 2');
  assert.equal(
    second.runId,
    null,
    `a fully paid invoice was proposed again: ${JSON.stringify(second.items)}`,
  );
});

// --- C5: a period lock loses the Mahngebühr for good ---------------------------------------------
// ADAPTED at adoption (see the header): the repair made the skip RECOVERABLE through
// `issue_dunning_run` itself, so the probe walks the full recovery: skip, honest refusal while
// still locked, unlock, book exactly once.

test('C5: a period-locked fee is skipped by name and BOOKS once the period allows', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, { prefix: 'c5' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });
  must(
    call(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'c5-lock' }),
    'lock_period',
  );

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c5-p' }), 'propose');
  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c5-i' }),
    'issue',
  );
  assert.equal(issued.feeSkippedReason, 'period_locked');

  // Still locked: the retry is the period's own refusal, never illegal_transition and never a loss.
  const whileLocked = call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c5-i2' });
  assert.equal(whileLocked.error, 'period_locked');

  // Reopen and try again: the skipped fee books, exactly once.
  must(call(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'c5-unlock' }), 'unlock_period');
  const recovered = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c5-i3' }),
    'recover',
  );
  assert.equal(recovered.feeRecovered, true);
  const feeEntries = deps.store.db
    .prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning'`)
    .get(workspaceId).n;
  assert.equal(feeEntries, 1, `the skipped Mahngebühr must book exactly once, got ${feeEntries}`);
});

// --- C6: the in-engine `post` assert on a fee-bearing policy -------------------------------------

test('C6: an actor with dun but not post cannot issue a fee-bearing run', () => {
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId } = seed(deps, { prefix: 'c6' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });

  must(
    call(deps, 'invite_member', { workspaceId, email: 'a@muster.ch', role: 'bookkeeper', idempotencyKey: 'c6-inv' }),
    'invite_member',
  );
  const role = must(
    call(deps, 'define_role', {
      workspaceId,
      name: 'Nur mahnen',
      capabilities: ['read_sales', 'read_books', 'read_master_data', 'dun'],
      idempotencyKey: 'c6-role',
    }),
    'define_role',
  );
  const seat = call(deps, 'list_members', { workspaceId }).members.find((m) => m.actorId === 'agent');
  must(call(deps, 'set_role', { workspaceId, memberId: seat.memberId, role: role.roleId }), 'set_role');

  deps.actor = 'agent';
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c6-p' }), 'propose');
  const issued = call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c6-i' });
  assert.equal(issued.ok, false, `a dun-without-post actor booked a Mahngebühr: ${JSON.stringify(issued)}`);
  const rows = deps.store.db
    .prepare(`SELECT status, fee_entry_id FROM dunning_run WHERE workspace_id = ? AND id = ?`)
    .get(workspaceId, run.runId);
  assert.equal(rows.status, 'proposed', 'the refused issue left the run half-issued');
});

// --- C7: a mixed-rate invoice, and the fee's VAT rate --------------------------------------------

test('C7: the Mahngebühr books at ONE configured code across mixed-rate supplies', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, {
    prefix: 'c7',
    lines: [
      { description: 'Beratung 8.1%', unitPriceMinor: 100000, taxCode: 'UST81' },
      { description: 'Beherbergung 3.8%', unitPriceMinor: 100000, taxCode: 'UST38' },
    ],
  });
  // ADAPTED at adoption: the critic's seeding passed `taxCode: 'UST81'`, which D69 removed from
  // the config surface (the engine refuses the field by name). The assertion below is unchanged.
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c7-p' }), 'propose');
  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c7-i' }),
    'issue',
  );
  const entry = must(call(deps, 'get_entry', { workspaceId, entryId: issued.feeEntryId }), 'get_entry');
  const codes = [...new Set(entry.lines.map((l) => l.taxCode).filter((c) => c != null))];
  // ESTV practice (the spec's own claim): the fee shares the UNDERLYING supply's rate. A mixed-rate
  // invoice therefore has no single right answer, and the engine never asks the invoice.
  assert.ok(
    codes.length > 1,
    `one flat code (${JSON.stringify(codes)}) was applied to a fee whose supply is mixed-rate ` +
      '(8.1% + 3.8%); the spec claims the fee follows the underlying supply',
  );
});

// --- C8: the QRR reference's mod-10 recursive check digit, recomputed independently ---------------

const MOD10_TABLE = [
  [0, 9, 4, 6, 8, 2, 7, 1, 3, 5],
  [9, 4, 6, 8, 2, 7, 1, 3, 5, 0],
  [4, 6, 8, 2, 7, 1, 3, 5, 0, 9],
  [6, 8, 2, 7, 1, 3, 5, 0, 9, 4],
  [8, 2, 7, 1, 3, 5, 0, 9, 4, 6],
  [2, 7, 1, 3, 5, 0, 9, 4, 6, 8],
  [7, 1, 3, 5, 0, 9, 4, 6, 8, 2],
  [1, 3, 5, 0, 9, 4, 6, 8, 2, 7],
  [3, 5, 0, 9, 4, 6, 8, 2, 7, 1],
  [5, 0, 9, 4, 6, 8, 2, 7, 1, 3],
];

/** Independent implementation of the SIX mod-10 recursive check digit (Recommendation 6.2.2). */
function mod10Recursive(digits) {
  let carry = 0;
  for (const ch of digits) carry = MOD10_TABLE[carry][Number(ch)];
  return (10 - carry) % 10;
}

test('C8: the letter QRR reference carries a correct mod-10 recursive check digit', () => {
  const deps = freshDeps();
  const { workspaceId, customerId } = seed(deps, { prefix: 'c8' });
  policy(deps, workspaceId, { bookFee: false, feeIncomeAccountId: null, feeMinor: 0 });
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c8-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c8-i' }), 'issue');
  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  const part = pdf.pdf.qrParts[0];
  assert.equal(part.hasQr, true, `no payment part: ${part.reason}`);
  assert.equal(part.reference.length, 27, 'a QRR reference is 27 digits');
  assert.equal(
    Number(part.reference.slice(26)),
    mod10Recursive(part.reference.slice(0, 26)),
    `bad check digit on ${part.reference}`,
  );

  // The same reference the ORIGINAL invoice's payment part carries, or the payment will not match.
  const invoiceDoc = must(
    call(deps, 'get_document', { workspaceId, documentId: run.items[0].documentId, include: ['pdf'] }),
    'get_document',
  );
  const payload = Buffer.from(invoiceDoc.pdf.base64, 'base64').toString('latin1');
  assert.ok(payload.includes(part.reference), 'the reminder QRR differs from the invoice QRR');
});

// --- C9: the letter's German umlauts and the PDF font encoding ------------------------------------

test('C9: the reminder PDF declares no /Encoding, so its latin1 umlauts mis-render', () => {
  const deps = freshDeps();
  const { workspaceId, customerId } = seed(deps, { prefix: 'c9' });
  policy(deps, workspaceId, { bookFee: false, feeIncomeAccountId: null, feeMinor: 0 });
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c9-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c9-i' }), 'issue');
  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  const bytes = Buffer.from(pdf.pdf.base64, 'base64');
  const text = bytes.toString('latin1');

  assert.ok(text.includes('/BaseFont /Helvetica'), 'the letter uses the base-14 Helvetica');
  assert.ok(text.includes('Für die folgenden Rechnungen'), 'the umlaut rides as a latin1 byte');
  assert.ok(
    /\/BaseFont \/Helvetica[^>]*\/Encoding \/WinAnsiEncoding/.test(text),
    'the font dictionary names no /Encoding, so 0xFC renders as the StandardEncoding glyph (ae), ' +
      'not as u-umlaut: "Für", "fällig", "überfällig", "Grüsse" and "Mahngebühr" all corrupt ' +
      'on an outward-facing Swiss letter',
  );
});

// --- C10: send is automatable, so a rule can mass-mail Mahnungen unattended -----------------------
// POLARITY FLIPPED at adoption (see the header): the critic asserted membership and named it an
// owner question; the owner answered with D70 (31.07.2026): `send_dunning_run` STAYS automatable,
// parity with `send_invoice`, the safety being the repaired C1-C4 invariants this suite pins. This
// probe now pins the DECISION, so a future denylist edit re-opens D70 consciously.

test('C10: no dunning verb is on the automation denylist (D70)', () => {
  for (const verb of ['propose_dunning_run', 'issue_dunning_run', 'send_dunning_run']) {
    assert.equal(
      NOT_AUTOMATABLE.has(verb),
      false,
      `${verb} joined the denylist: that reverses D70 (owner-decided 31.07.2026) and must be a new decision, not a drive-by`,
    );
  }
});

// --- C11: send replay under a fresh key must not retransmit ---------------------------------------

test('C11: a fully sent run does not retransmit under a fresh idempotency key', () => {
  const deps = freshDeps();
  const { workspaceId, customerId } = seed(deps, { prefix: 'c11' });
  policy(deps, workspaceId, { bookFee: false, feeIncomeAccountId: null, feeMinor: 0 });
  const relay = recordingRelay();
  deps.emailRelay = relay;
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c11-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c11-i' }), 'issue');
  must(call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c11-s1' }), 'send 1');
  must(call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'c11-s2' }), 'send 2');
  assert.equal(relay.sent.length, 1, 'the letter went out twice');
  assert.equal(customerId.length > 0, true);
});

// --- C12: a backdated asOf regresses the escalation and issues an out-of-order letter -------------

test('C12: proposing with a past asOf after level 3 re-issues a level-2 letter and a second fee', () => {
  const { deps, setNow } = steppingDeps('2026-05-01T00:00:00.000Z');
  const { workspaceId } = seed(deps, { dueDate: '2026-05-11', prefix: 'c12' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });

  for (const [at, key] of [
    ['2026-05-25T00:00:00.000Z', '1'],
    ['2026-06-15T00:00:00.000Z', '2'],
    ['2026-07-15T00:00:00.000Z', '3'],
  ]) {
    setNow(at);
    const r = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: `c12-p${key}` }), `propose ${key}`);
    must(call(deps, 'issue_dunning_run', { workspaceId, runId: r.runId, confirmed: true, idempotencyKey: `c12-i${key}` }), `issue ${key}`);
  }

  // Level 3 is issued and terminal. A backdated proposal reads `issuedLevels` as of the OLD date,
  // so it sees only the level-1 run and proposes level 2 all over again.
  setNow('2026-07-20T00:00:00.000Z');
  const back = must(call(deps, 'propose_dunning_run', { workspaceId, asOf: '2026-06-20', idempotencyKey: 'c12-back' }), 'backdated propose');
  assert.equal(
    back.runId,
    null,
    `a backdated proposal regressed a terminal invoice to level ${back.items?.[0]?.level}: ${JSON.stringify(back.items)}`,
  );
});

// --- C13: a cancelled invoice's fee keeps being dunned under the cancelled invoice's number --------

test('C13: after the invoice is cancelled by reversal, its Mahngebühr is dunned on its own', () => {
  const { deps, setNow } = steppingDeps('2026-05-01T00:00:00.000Z');
  const { workspaceId, documentId } = seed(deps, { dueDate: '2026-05-11', prefix: 'c13' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });

  setNow('2026-05-25T00:00:00.000Z');
  const first = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c13-1' }), 'propose 1');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: first.runId, confirmed: true, idempotencyKey: 'c13-1i' }), 'issue 1');

  // Cancel the invoice the way A10 cancels: reverse its posted entry (never a delete).
  const postedEntryId = deps.store.db
    .prepare('SELECT posted_entry_id AS e FROM document WHERE workspace_id = ? AND id = ?')
    .get(workspaceId, documentId).e;
  must(call(deps, 'reverse_entry', { workspaceId, entryId: postedEntryId, idempotencyKey: 'c13-rev' }), 'reverse_entry');

  setNow('2026-06-15T00:00:00.000Z');
  const second = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'c13-2' }), 'propose 2');
  assert.equal(
    second.runId,
    null,
    `a cancelled invoice is still dunned, by its own number: ${JSON.stringify(second.items)}`,
  );
});

// --- R7 (round 2): the C8 recovery must never rewrite an already-sent letter (D73) ----------------

test('R7: recovering a period-skipped fee on a SENT run leaves the mailed letter byte-identical', () => {
  const deps = freshDeps();
  const { workspaceId, customerId } = seed(deps, { prefix: 'r7' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId) });
  must(call(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'r7-lock' }), 'lock');

  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'r7-p' }), 'propose');
  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'r7-i' }),
    'issue',
  );
  assert.equal(issued.feeSkippedReason, 'period_locked');

  // The letter goes OUT to the debtor, demanding the invoice only.
  const relay = recordingRelay();
  deps.emailRelay = relay;
  const sent = must(
    call(deps, 'send_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'r7-s' }),
    'send',
  );
  assert.equal(sent.status, 'sent');
  const mailed = relay.sent[0].pdfBase64;

  // The period reopens and the deferred fee books: to the LEDGER, never to the letter.
  must(call(deps, 'unlock_period', { workspaceId, period: '2026-07', idempotencyKey: 'r7-unlock' }), 'unlock');
  const recovered = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 'r7-r' }),
    'recover',
  );
  assert.equal(recovered.feeRecovered, true);

  // The SAME read verb, on the SAME sent run, renders the mailed bytes (D73: the demand froze at
  // issue; a reprint is evidence, not a live view).
  const after = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf after');
  assert.equal(after.pdf.base64, mailed, 'the recovery rewrote an ALREADY SENT letter');
  assert.equal(after.pdf.qrParts[0].amountMinor, 108100, 'the mailed slip never gains the recovered fee');

  // The fee is on the books and rides the open item toward the NEXT escalation letter.
  const open = must(call(deps, 'list_open_items', { workspaceId }), 'open items');
  assert.equal(open.items[0].dunningFeeMinor, 2000);
  assert.equal(open.reconciled, true);
});

// --- R15 (round 2): the D69 taxCode refusal is pinned, because nothing else asserts it ------------

test('R15: the removed per-level tax code is refused by name (D69), and no row is written', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, { prefix: 'r15' });
  const acc = feeAccount(deps, workspaceId, '3998', 'r15-acc');
  const refused = call(deps, 'set_dunning_config', {
    workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 2000, bookFee: true, feeIncomeAccountId: acc, taxCode: 'UST81' },
      { level: 2, daysOverdue: 20 },
      { level: 3, daysOverdue: 30 },
    ],
    idempotencyKey: 'r15-cfg',
  });
  assert.equal(refused.ok, false, 'a pre-D69 caller sending taxCode must learn why, not be ignored');
  assert.equal(refused.field, 'taxCode');
  assert.equal(refused.reason, 'd69_fee_vat_follows_the_invoice');
  // And the row it would have written does not exist.
  assert.equal(
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM dunning_config WHERE workspace_id = ?').get(workspaceId).n,
    0,
  );
});

// --- N5 (round 2): earlier Mahngebühren are itemised on the letter, never folded in ---------------

test('N5: the level-2 letter states the invoice residual and the earlier Mahngebühr separately', () => {
  const { deps, setNow } = steppingDeps('2026-05-01T00:00:00.000Z');
  const { workspaceId, customerId } = seed(deps, { dueDate: '2026-05-11', prefix: 'n5' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId, '3997', 'n5-acc') });

  setNow('2026-05-25T00:00:00.000Z');
  const first = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'n5-1' }), 'propose 1');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: first.runId, confirmed: true, idempotencyKey: 'n5-1i' }), 'issue 1');

  setNow('2026-06-15T00:00:00.000Z');
  const second = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'n5-2' }), 'propose 2');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: second.runId, confirmed: true, idempotencyKey: 'n5-2i' }), 'issue 2');

  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: second.runId, debtorId: customerId }), 'pdf');
  const text = Buffer.from(pdf.pdf.base64, 'base64').toString('latin1');
  // The invoice's own residual and the level-1 fee, stated apart, so the debtor can reconcile the
  // line against the invoice they hold.
  assert.ok(text.includes("offen CHF 1'081.00"), 'the invoice residual is not stated on its own');
  assert.ok(
    text.includes('zzgl. bereits verrechnete Mahngebühren CHF 20.00'),
    'the earlier Mahngebühr is folded into the "offen" figure instead of itemised',
  );
});

// --- S2 (round 3): a pre-D73 issued row never claims a paid invoice -------------------------------
// The snapshot columns arrived by ALTER TABLE with DEFAULT 0, so a run ISSUED under a pre-D73 build
// of this branch reads 0 in both. `demanded_fee_minor = 0` honestly under-demands; a subtracted
// `principal_minor = 0` printed "offen CHF 0.00, zzgl. bereits verrechnete Mahngebühren" for the
// whole invoice: prose claiming a paid invoice. The renderer treats 0-on-issued as NOT SNAPSHOTTED
// and falls back to `overdue_minor`, reproducing the pre-D73 letter exactly.

test('S2: an issued item carrying the migration defaults renders the pre-D73 letter, never a paid claim', () => {
  const deps = freshDeps();
  const { workspaceId, customerId } = seed(deps, { prefix: 's2' });
  policy(deps, workspaceId, { bookFee: false, feeIncomeAccountId: null, feeMinor: 0 });
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 's2-p' }), 'propose');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 's2-i' }), 'issue');

  // Exactly what a pre-D73 issued row looks like after the additive migration widened it.
  deps.store.db
    .prepare('UPDATE dunning_item SET principal_minor = 0, demanded_fee_minor = 0 WHERE workspace_id = ? AND run_id = ?')
    .run(workspaceId, run.runId);

  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  const text = Buffer.from(pdf.pdf.base64, 'base64').toString('latin1');
  assert.ok(text.includes("offen CHF 1'081.00"), 'the pre-D73 letter states the full open amount');
  assert.ok(!text.includes('offen CHF 0.00'), 'the letter must never claim the invoice is paid');
  assert.ok(!text.includes('zzgl.'), 'the migration default must never be restated as fees');
  assert.equal(pdf.pdf.qrParts[0].amountMinor, 108100, 'the slip stays the honest open amount');
});

test('S7: a run merely PROPOSED before the migration self-heals at issue', () => {
  const deps = freshDeps();
  const { workspaceId, customerId } = seed(deps, { prefix: 's7' });
  policy(deps, workspaceId, { feeIncomeAccountId: feeAccount(deps, workspaceId, '3996', 's7-acc') });
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 's7-p' }), 'propose');

  // The migration default on a run that has NOT issued yet.
  deps.store.db
    .prepare('UPDATE dunning_item SET principal_minor = 0, demanded_fee_minor = 0 WHERE workspace_id = ? AND run_id = ?')
    .run(workspaceId, run.runId);

  // Issue rewrites both columns with real values: the snapshot heals before any letter exists.
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: 's7-i' }), 'issue');
  const row = deps.store.db
    .prepare('SELECT principal_minor, demanded_fee_minor FROM dunning_item WHERE workspace_id = ? AND run_id = ?')
    .get(workspaceId, run.runId);
  assert.equal(row.principal_minor, 108100);
  assert.equal(row.demanded_fee_minor, 2000);
  const pdf = must(call(deps, 'get_dunning_pdf', { workspaceId, runId: run.runId, debtorId: customerId }), 'pdf');
  assert.equal(pdf.pdf.qrParts[0].amountMinor, 110100, 'the healed snapshot demands invoice + fee');
});
