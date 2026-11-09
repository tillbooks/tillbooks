// D177 non-author critic probes, engine half, round 2 (critic/d177-engine-r2-2026-10-16, reviewed tip
// 5bd3469e): the settlement dry run, the screened supersede, "Zeile entschieden", the fraction bounds.
// [FINDING] tests assert the contract and fail on the reviewed tip by design; [PROBE] tests pass and record
// what was checked. Synthetic data only: every payer, amount and text is invented.
//
// Copied onto claude/d177-engine with the round-2 remediation (16.10.2026). Two [PROBE] tests recorded
// behaviour the remediation changed by design and now assert the remedied contract, saying so: R2-1 (a
// spent key on a reopened line is refused at the screen) and R2-2 (a dry run's rolled-back writes do not
// make a refusal partial).

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  listBankInbox,
  bookBankLine,
  setBankStandard,
  prevalidateBookBankLine,
  reopenBankLine,
  setCreditorBankProfile,
  createPaymentBatch,
  generatePain001,
} from '../../dist/core/banking/index.js';
import { getAction } from '../../dist/api/registry.js';
import { runGoverned } from '../../dist/api/agent-gate.js';
import { createAccount } from '../../dist/core/accounts/accounts.js';
import { makeContext } from '../../dist/core/context.js';
import { approvingActionIds } from '../../dist/core/agent/approving.js';
import { getAuditLog } from '../../dist/core/ledger/auditLog.js';
import { postEntry } from '../../dist/core/ledger/index.js';
import { world, importLines, must, refused, postedBill, issueInvoice } from './bank-inbox-support.mjs';
import { assertClaimInvariantHolds } from './bank-inbox-support.mjs';
import { chainedOpening } from './e2-adapt.mjs';

afterEach(assertClaimInvariantHolds);

const lineOf = (t, id) => must(listBankInbox(t.ctx, { status: 'all' }), 'inbox').lines.find((l) => l.bankTxnId === id);
const deps = (t, actor) => ({ store: t.store, clock: t.clock, ids: t.ids, actor });
const governed = (t, name, input, actor = 'agent') => runGoverned(deps(t, actor), getAction(name), { workspaceId: t.workspaceId, ...input });
const approve = (t, actionId) => getAction('approve_drafted_action').run(deps(t, 'studio'), { workspaceId: t.workspaceId, actionId });
const statusOf = (t, id) => t.store.db.prepare('SELECT status, reject_reason FROM agent_action WHERE id = ?').get(id);

/** A content fingerprint of EVERY table (not only row counts: an UPDATE that escaped would show here). */
function fingerprint(t, skip = []) {
  const tables = t.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) {
    if (skip.includes(name)) continue;
    const rows = t.store.db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)).sort();
    out[name] = createHash('sha256').update(rows.join('\n')).digest('hex');
  }
  return out;
}

function billWorld() {
  const t = world();
  must(createAccount(t.ctx, { number: '1095', name: 'Erlös Durchlaufkonto', type: 'asset', idempotencyKey: 'acc-1095' }), '1095');
  const bill = postedBill(t, { grossMinor: 21500, seed: 'r2' });
  const l = importLines(t, {
    statementId: 'BS-R2',
    entries: [
      { ref: 'PAY', amountMinor: 21500, cd: 'DBIT', name: 'Druckerei Tannenbach AG', ustrd: 'RECHNUNG R2' },
      { ref: 'FEE', amountMinor: 470, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL R2' },
    ],
  }).lines;
  return { t, bill, l };
}

// ---------------------------------------------------------------------------------------------------
// The dry run
// ---------------------------------------------------------------------------------------------------

test('[PROBE R2] a successful settlement dry run through the wired verb (real audit port) leaves every table byte-identical, other seats\' drafts pending and the audit chain verifiable', () => {
  const { t, bill, l } = billWorld();
  t.store.db.prepare("INSERT INTO user (actor_id, kind, display_name, created_at) VALUES ('agent-zwei', 'agent', 'Zweiter Agent', '2026-07-01T00:00:00.000Z')").run();
  // Another seat's pending Vorschlag for the line: a decision would resolve it (an UPDATE, invisible to row counts).
  const other = must(governed(t, 'ignore_bank_line', { bankTxnId: l.PAY, reason: 'duplicate', idempotencyKey: 'r2-other' }, 'agent-zwei'));
  const before = fingerprint(t);
  const action = getAction('book_bank_line');
  const answer = action.prevalidate(deps(t, 'agent'), { workspaceId: t.workspaceId, bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'r2-dry' });
  assert.equal(answer, undefined, 'the payable bill passes');
  assert.deepEqual(fingerprint(t), before, 'every table byte-identical: payment, entry, link, decision, audit chain, memo, Zeile entschieden');
  assert.equal(t.store.db.inTransaction, false, 'no transaction left open');
  assert.deepEqual(approvingActionIds(), []);
  assert.equal(statusOf(t, other.actionId).status, 'pending', 'the other seat\'s Vorschlag was not resolved by the rolled-back decision');
  // The agent's governed draft (dry run included) drafts, and approving it books once; the chain verifies.
  const drafted = must(governed(t, 'book_bank_line', { bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'r2-agent' }));
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  must(approve(t, drafted.actionId));
  assert.equal(lineOf(t, l.PAY).state, 'booked');
  assert.deepEqual([statusOf(t, other.actionId).status, statusOf(t, other.actionId).reject_reason], ['rejected', 'Zeile entschieden']);
  const log = must(getAuditLog(makeContext(t.store, { workspaceId: t.workspaceId })));
  assert.ok(log.rows.some((r) => r.entityKind === 'bank_txn'), 'the approval wrote its audit row through the real port');
  assert.equal(log.chainVerified, true, 'the chain verifies after the dry run and the real booking');
});

test('[PROBE R2] the dry run of a customer invoice (QR credit, overpayment kept as Guthaben) and of a payment run leaves every table byte-identical', () => {
  const t = world();
  const inv = issueInvoice(t.ctx, { contactId: t.customerId, key: 'r2-inv' });
  const bills = [60000, 40000].map((a, i) => postedBill(t, { grossMinor: a, seed: `r2-run-${i}`, vendorName: i === 0 ? 'Lieferant Tannenweg AG' : 'Lieferant Birkenhof GmbH' }));
  for (const [i, b] of bills.entries()) must(setCreditorBankProfile(t.ctx, { vendorId: b.vendorId, iban: 'CH7200235123456789012', idempotencyKey: `r2-cbp-${i}` }));
  const batch = must(createPaymentBatch(t.ctx, { bankAccountId: t.bankAccountId, itemIds: bills.map((b) => b.vendorBillId), executionDate: '2026-07-30', idempotencyKey: 'r2-run' }));
  must(generatePain001(t.ctx, { batchId: batch.batchId, idempotencyKey: 'r2-gen' }));
  const l = importLines(t, {
    statementId: 'BS-R2B',
    entries: [
      { ref: 'IN', amountMinor: inv.totalMinor + 500, cd: 'CRDT', name: 'Kundin Beispiel', ustrd: 'ZAHLUNG R2' },
      { ref: 'RUN', amountMinor: 100000, cd: 'DBIT', name: 'Sammelauftrag', ustrd: 'SAMMELAUFTRAG R2' },
    ],
  }).lines;
  const before = fingerprint(t);
  const a1 = prevalidateBookBankLine(t.ctx, { bankTxnId: l.IN, target: { kind: 'open_item', documentId: inv.id, remainder: 'on_account' }, idempotencyKey: 'r2-in' });
  const a2 = prevalidateBookBankLine(t.ctx, { bankTxnId: l.RUN, target: { kind: 'payment_batch', batchId: batch.batchId }, idempotencyKey: 'r2-runb' });
  assert.equal(a1, undefined, JSON.stringify(a1));
  assert.equal(a2, undefined, JSON.stringify(a2));
  assert.deepEqual(fingerprint(t), before, 'payment, allocations, Guthaben, run state, entries, links, audit: all rolled back');
  // Both book for real afterwards on the same keys.
  must(bookBankLine(t.ctx, { bankTxnId: l.IN, target: { kind: 'open_item', documentId: inv.id, remainder: 'on_account' }, idempotencyKey: 'r2-in' }));
  must(bookBankLine(t.ctx, { bankTxnId: l.RUN, target: { kind: 'payment_batch', batchId: batch.batchId }, idempotencyKey: 'r2-runb' }));
});

test('[PROBE R2] a partial settlement passes and a refused one (a wrong entry) is refused; both dry runs leave every table byte-identical', () => {
  const { t, bill, l } = billWorld();
  const before = fingerprint(t);
  // 4.70 against a 215.00 bill is a partial payment (remainder open): the direct call accepts it too.
  assert.equal(prevalidateBookBankLine(t.ctx, { bankTxnId: l.FEE, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'r2-x1' }), undefined);
  const x2 = prevalidateBookBankLine(t.ctx, { bankTxnId: l.FEE, target: { kind: 'existing_entry', entryId: 'entry_gibt_es_nicht' }, idempotencyKey: 'r2-x2' });
  assert.equal(x2?.ok, false, JSON.stringify(x2));
  assert.deepEqual(fingerprint(t), before);
  assert.equal(t.store.db.inTransaction, false);
});

test('[PROBE R2] a throw inside the dry run (not a refusal) rolls back, leaves no transaction open, and the store keeps working', () => {
  const { t, bill, l } = billWorld();
  const before = fingerprint(t);
  const boom = makeContext(t.store, { workspaceId: t.workspaceId, actor: 'agent', clock: t.clock, ids: t.ids, audit: { record() { throw new TypeError('audit port down (synthetic)'); } } });
  assert.throws(() => prevalidateBookBankLine(boom, { bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'r2-boom' }), TypeError);
  assert.equal(t.store.db.inTransaction, false, 'the connection is not left mid-transaction');
  assert.deepEqual(fingerprint(t), before, 'nothing survived the throw');
  must(bookBankLine(t.ctx, { bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'r2-boom' }));
  assert.equal(lineOf(t, l.PAY).state, 'booked', 'the same key books afterwards');
});

test('[PROBE R2, remedied R2-2] the wired prevalidate turns a throw inside the dry run into a structured refusal, not partial (nothing survived)', () => {
  const { t, bill, l } = billWorld();
  const before = fingerprint(t);
  // Through the registry's guarded(): a throw in a NESTED tx of the dry run (the memo, the audit append)
  // answers unexpected_error instead of escaping the gate.
  const original = t.store.tx.bind(t.store);
  let calls = 0;
  t.store.tx = (fn) => {
    calls += 1;
    return original(() => {
      const r = fn();
      throw new RangeError('synthetic failure after the body');
      // eslint-disable-next-line no-unreachable
      return r;
    });
  };
  try {
    const a = getAction('book_bank_line').prevalidate(deps(t, 'agent'), { workspaceId: t.workspaceId, bankTxnId: l.PAY, target: { kind: 'open_item', documentId: bill.vendorBillId }, idempotencyKey: 'r2-g' });
    assert.equal(a?.error, 'unexpected_error', JSON.stringify(a));
    assert.equal(a.partial, false, 'R2-2: the dry run\'s rolled-back writes do not count, so the refusal says the book did not change');
    assert.ok(calls >= 2, 'the dry run nests transactions');
  } finally {
    t.store.tx = original;
  }
  assert.equal(t.store.db.inTransaction, false);
  assert.deepEqual(fingerprint(t), before, 'nothing survived');
});

// ---------------------------------------------------------------------------------------------------
// The screened supersede
// ---------------------------------------------------------------------------------------------------

test('[PROBE R2] an agent cannot mark its own draft screened: a `screened` field in the verb input is payload, never the seam\'s flag', () => {
  const { t, l } = billWorld();
  const good = must(governed(t, 'book_bank_line', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 'sc-1' }));
  const bad = governed(t, 'ignore_bank_line', { bankTxnId: l.FEE, reason: 'gibt_es_nicht', screened: true, idempotencyKey: 'sc-2' });
  assert.equal(bad.ok, false, 'refused at the screen');
  assert.equal(statusOf(t, good.actionId).status, 'pending');
});

test('[PROBE R2, remedied R2-1] a same-key memo no longer screens: after a reopen, a draft reusing the booked key is refused and the valid Vorschlag stands', () => {
  const { t, l } = billWorld();
  const k = 'r2-reused';
  must(bookBankLine(t.ctx, { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: k }));
  must(reopenBankLine(t.ctx, { bankTxnId: l.FEE, reason: 'falsches Konto (synthetisch)', idempotencyKey: 'r2-reopen' }));
  const valid = must(governed(t, 'book_bank_line', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6800'), amountMinor: 470 }] }, idempotencyKey: 'r2-valid' }));
  const garbage = governed(t, 'book_bank_line', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 1 }] }, idempotencyKey: k });
  // R2-1: the key already decided the line once; its replay would decide nothing, so the screen refuses.
  assert.equal(garbage.ok, false, JSON.stringify(garbage).slice(0, 200));
  assert.equal(garbage.error, 'idempotency_key_conflict');
  assert.equal(statusOf(t, valid.actionId).status, 'pending', 'the valid Vorschlag stands');
  must(approve(t, valid.actionId));
  assert.equal(lineOf(t, l.FEE).state, 'booked', 'and books the line');
});

// ---------------------------------------------------------------------------------------------------
// The fraction bounds
// ---------------------------------------------------------------------------------------------------

test('[PROBE R2] the bounds keep real fractions (Bondigoo 1081/180, a VAT share 81/1081, a 4-decimal fee) and overflow needs a line above 90 billion', () => {
  const { t } = billWorld();
  const l = importLines(t, {
    statementId: 'BS-BD',
    entries: [
      { ref: 'P', amountMinor: 1512, cd: 'CRDT', name: 'Zahlwerk Beispiel Ltd', ustrd: 'AUSZAHLUNG BD' },
      { ref: 'H', amountMinor: 9_100_000_000_000, cd: 'CRDT', name: 'Zahlwerk Gross Ltd', ustrd: 'AUSZAHLUNG H' },
    ],
  }).lines;
  for (const [num, den, key] of [[1081, 180, 'a'], [81, 1081, 'b'], [100000, 97123, 'c'], [1_000_000, 1000, 'd']]) {
    must(setBankStandard(t.ctx, { bankTxnId: l.P, legs: [
      { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'factor', label: 'Brutto', num, den } },
      { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
    ], idempotencyKey: `bd-${key}` }), `${num}/${den}`);
  }
  assert.ok(l.H !== undefined, 'a 91-billion line imports');
  {
    must(setBankStandard(t.ctx, { bankTxnId: l.H, legs: [
      { accountId: t.acc('3400'), taxCode: null, amount: { kind: 'factor', label: 'Brutto', num: 1000, den: 1 } },
      { accountId: t.acc('4400'), taxCode: null, amount: { kind: 'rest' } },
    ], idempotencyKey: 'bd-h' }));
    const p = lineOf(t, l.H).proposal;
    assert.equal(p.reasonParams.computed[0].overflow, true, 'reachable only for a line above 90 billion');
    assert.equal(p.certainty, 'check');
    refused(bookBankLine(t.ctx, { bankTxnId: l.H, target: p.target, idempotencyKey: 'bd-hb' }), 'rule_not_applicable');
  }
});

// ---------------------------------------------------------------------------------------------------
// "Zeile entschieden": scope (kills N13, which survives the author's suite)
// ---------------------------------------------------------------------------------------------------

test('[PROBE R2] Zeile entschieden is scoped to the decided line: a match decides its line only, other lines keep their Vorschläge, a reopen resolves nothing', () => {
  const { t, l } = billWorld();
  // D178 point 19 (re-cut): the next statement opens where the last one closed, as a bank's do.
  const m = importLines(t, { statementId: 'BS-ZS', seqNb: '2', openingMinor: chainedOpening(t), entries: [{ ref: 'M', amountMinor: 2000, cd: 'DBIT', name: 'Kartenterminal Beispiel AG', ustrd: 'TERMINAL ZS' }] }).lines.M;
  const entry = must(postEntry(t.ctx, { date: '2026-07-20', source: 'manual', description: 'von Hand zs', idempotencyKey: 'zs-e', lines: [{ account: t.acc('6500'), debit: 2000 }, { account: t.acc('1020'), credit: 2000 }] }));
  const onFee = must(governed(t, 'book_bank_line', { bankTxnId: l.FEE, target: { kind: 'accounts', legs: [{ accountId: t.acc('6500'), amountMinor: 470 }] }, idempotencyKey: 'zs-fee' }));
  const onM = must(governed(t, 'ignore_bank_line', { bankTxnId: m, reason: 'duplicate', idempotencyKey: 'zs-m' }));
  // A person MATCHES line M to the existing entry.
  must(bookBankLine(t.ctx, { bankTxnId: m, target: { kind: 'existing_entry', entryId: entry.entryId }, idempotencyKey: 'zs-match' }));
  assert.equal(lineOf(t, m).state, 'matched');
  assert.deepEqual([statusOf(t, onM.actionId).status, statusOf(t, onM.actionId).reject_reason], ['rejected', 'Zeile entschieden'], 'a match decides the line');
  assert.equal(statusOf(t, onFee.actionId).status, 'pending', 'a decision of ANOTHER line leaves this Vorschlag pending');
  // A reopen of M, then a new Vorschlag on it, then reopen nothing else: no reopen resolves a Vorschlag.
  must(reopenBankLine(t.ctx, { bankTxnId: m, reason: 'falsch zugeordnet (synthetisch)', idempotencyKey: 'zs-reopen' }));
  const after = must(governed(t, 'ignore_bank_line', { bankTxnId: m, reason: 'duplicate', idempotencyKey: 'zs-m2' }));
  assert.equal(after.drafted, true, JSON.stringify(after));
  assert.equal(statusOf(t, after.actionId).status, 'pending');
  assert.equal(statusOf(t, onFee.actionId).status, 'pending');
});
