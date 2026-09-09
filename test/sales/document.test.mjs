// A10, the document lifecycle: the single P7 state machine (quote/order/invoice/credit_note).
//
// These exercise the machine A10 owns: the guarded transition table, gap-free per-type/year
// numbering, the convert graph, the poster DELEGATE SEAM, and the cancel semantics (posted reverses,
// draft deletes). Invoice posting itself is A11's; here a TEST poster stands in for it via A02
// postEntry, which is exactly how A11 will wire the real one. credit_note is left UNREGISTERED so the
// honest `posting_delegate_unregistered` seam behaviour is covered too.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSavedView } from '../../dist/core/customization/views.js';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import {
  createDocument,
  updateDocument,
  transitionDocument,
  convertDocument,
  getDocument,
  listDocuments,
  assertTransition,
  registerDocumentPoster,
} from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

/**
 * The A11 invoice poster, standing in for the real one: issuing posts a balanced entry via the one
 * posting path (A02 postEntry), cancelling reverses it. Registered once here so every `invoice` test
 * in this file exercises the real seam. `credit_note` stays unregistered on purpose (see below).
 */
registerDocumentPoster('invoice', {
  posts: true,
  onIssue: (ctx, doc) => {
    const debtor = accByNumber(ctx, '1100') ?? accByNumber(ctx, '1000');
    const revenue = accByNumber(ctx, '3200') ?? accByNumber(ctx, '6500');
    const amount = doc.total_minor > 0 ? doc.total_minor : 1000;
    const posted = postEntry(ctx, {
      date: ctx.clock.now().slice(0, 10),
      source: 'invoice',
      idempotencyKey: `test-invoice-post-${doc.id}`,
      lines: [
        { account: debtor, debit: amount },
        { account: revenue, credit: amount },
      ],
    });
    if (!posted.ok) return posted;
    return { ok: true, postedEntryId: posted.entryId };
  },
  onCancel: (ctx, doc) => {
    if (doc.posted_entry_id === null) return { ok: true };
    const reversed = reverseEntry(ctx, { entryId: doc.posted_entry_id, idempotencyKey: `test-cancel-${doc.id}` });
    if (!reversed.ok) return reversed;
    return { ok: true, reversalEntryId: reversed.reversalId };
  },
});

function accByNumber(ctx, number) {
  const row = ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number);
  return row?.id;
}

function setup(clockAt = AT, overrides = {}) {
  const clock = fixedClock(clockAt);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Acme AG' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids, ...overrides });
  const contactId = ctx.store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'CHF', 30, ?) RETURNING id`,
    )
    .get(workspaceId, clockAt).id;
  return { ctx, store, workspaceId, deps, contactId };
}

const LINE = { description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000 }; // 10 x 150.00 = 1'500.00

// --- createDocument ----------------------------------------------------------------------------

test('createDocument is always a draft, stamps the tenant, and computes the net subtotal', () => {
  const { ctx, workspaceId, contactId } = setup();
  const made = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE, { unitPriceMinor: 4000 }] });
  assert.equal(made.ok, true);
  assert.equal(made.document.status, 'draft');
  assert.equal(made.document.number, null);
  assert.equal(made.document.workspaceId, workspaceId);
  assert.equal(made.document.subtotalMinor, 150000 + 4000);
  assert.equal(made.lines.length, 2);
  assert.equal(made.lines[0].lineTotalMinor, 150000);
  assert.equal(made.history[0].toStatus, 'draft');
  assert.equal(made.history[0].fromStatus, null);
});

test('createDocument rejects an unknown type', () => {
  const { ctx } = setup();
  assert.equal(createDocument(ctx, { type: 'deal' }).error, 'invalid_type');
});

test('createDocument rejects a non-integer unit price (no float on the money path)', () => {
  const { ctx, contactId } = setup();
  const bad = createDocument(ctx, { type: 'quote', contactId, lines: [{ unitPriceMinor: 12.5 }] });
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'unitPriceMinor');
});

test('createDocument is idempotent under a key', () => {
  const { ctx, contactId } = setup();
  const a = createDocument(ctx, { type: 'quote', contactId, lines: [LINE], idempotencyKey: 'k1' });
  const b = createDocument(ctx, { type: 'quote', contactId, lines: [LINE], idempotencyKey: 'k1' });
  assert.deepEqual(a, b);
  const all = listDocuments(ctx, { type: 'quote' });
  assert.equal(all.documents.length, 1);
});

// --- assertTransition: every legal path, every off-table pair -----------------------------------

test('assertTransition: a quote walks draft -> issued -> sent -> accepted, each legal', () => {
  assert.equal(assertTransition('draft', 'issued', 'quote').ok, true);
  assert.equal(assertTransition('issued', 'sent', 'quote').ok, true);
  assert.equal(assertTransition('sent', 'accepted', 'quote').ok, true);
  assert.equal(assertTransition('sent', 'declined', 'quote').ok, true);
  assert.equal(assertTransition('sent', 'expired', 'quote').ok, true);
});

test('assertTransition rejects every off-table pair with illegal_transition and the allowed set', () => {
  const bad = assertTransition('draft', 'sent', 'invoice'); // skipping issue
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'illegal_transition');
  assert.deepEqual(bad.allowed, ['issued', 'cancelled']);
  // An invoice has no "accepted" state (that is a quote thing).
  assert.equal(assertTransition('sent', 'accepted', 'invoice').error, 'illegal_transition');
  // Settle is A14's, not a bare A10 transition.
  assert.equal(assertTransition('issued', 'settled', 'invoice').error, 'illegal_transition');
});

test('every type reaches a terminal state through only legal transitions', () => {
  // A tiny reachability walk: from draft, following the table, a terminal is always reachable.
  const terminals = new Set(['cancelled', 'converted', 'settled', 'declined', 'expired', 'superseded', 'confirmed']);
  for (const type of ['quote', 'order', 'invoice', 'credit_note']) {
    // draft -> issued is legal for all four.
    assert.equal(assertTransition('draft', 'issued', type).ok, true, `${type} can issue`);
    // draft -> cancelled (terminal) is legal for all four.
    assert.equal(assertTransition('draft', 'cancelled', type).ok, true, `${type} can cancel from draft`);
    assert.ok(terminals.has('cancelled'));
  }
});

// --- Issue: quote posts nothing, number assigned, gap-free --------------------------------------

test('issuing a quote assigns an O-number, posts NO ledger entry, records the trail', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  const issued = transitionDocument(ctx, { documentId: q.document.id, to: 'issued', idempotencyKey: 'iss-1' });
  assert.equal(issued.ok, true);
  assert.equal(issued.document.status, 'issued');
  assert.equal(issued.document.number, 'O-2026-0001');
  assert.equal(issued.document.postedEntryId, null);
  const journal = ctx.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get();
  assert.equal(journal.n, 0, 'a quote issue posts nothing');
  assert.equal(issued.history.at(-1).toStatus, 'issued');
});

test('the number mask carries the per-type prefix R/O/A/G', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  const o = createDocument(ctx, { type: 'order', contactId, lines: [LINE] });
  const r = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  assert.equal(transitionDocument(ctx, { documentId: q.document.id, to: 'issued' }).document.number, 'O-2026-0001');
  assert.equal(transitionDocument(ctx, { documentId: o.document.id, to: 'issued' }).document.number, 'A-2026-0001');
  assert.equal(transitionDocument(ctx, { documentId: r.document.id, to: 'issued' }).document.number, 'R-2026-0001');
});

test('numbering is monotonic and gap-free per type per year', () => {
  const { ctx, contactId } = setup();
  const nums = [];
  for (let i = 0; i < 3; i += 1) {
    const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
    nums.push(transitionDocument(ctx, { documentId: q.document.id, to: 'issued' }).document.number);
  }
  assert.deepEqual(nums, ['O-2026-0001', 'O-2026-0002', 'O-2026-0003']);
});

test('the counter resets per type per year', () => {
  const a = setup('2026-07-16T00:00:00.000Z');
  const b = setup('2027-01-04T00:00:00.000Z');
  const qa = createDocument(a.ctx, { type: 'quote', contactId: a.contactId, lines: [LINE] });
  const qb = createDocument(b.ctx, { type: 'quote', contactId: b.contactId, lines: [LINE] });
  assert.equal(transitionDocument(a.ctx, { documentId: qa.document.id, to: 'issued' }).document.number, 'O-2026-0001');
  assert.equal(transitionDocument(b.ctx, { documentId: qb.document.id, to: 'issued' }).document.number, 'O-2027-0001');
});

test('re-issuing with the same idempotency key returns the same number, consuming only one', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  const first = transitionDocument(ctx, { documentId: q.document.id, to: 'issued', idempotencyKey: 'issue-k' });
  const replay = transitionDocument(ctx, { documentId: q.document.id, to: 'issued', idempotencyKey: 'issue-k' });
  assert.equal(first.document.number, 'O-2026-0001');
  assert.deepEqual(replay, first);
  // The next quote gets 0002, proving the replay consumed no extra number.
  const q2 = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  assert.equal(transitionDocument(ctx, { documentId: q2.document.id, to: 'issued' }).document.number, 'O-2026-0002');
});

test('issue is refused without a customer (needs_customer) or without lines (needs_lines); no number', () => {
  const { ctx, contactId } = setup();
  const noCustomer = createDocument(ctx, { type: 'quote', lines: [LINE] });
  assert.equal(transitionDocument(ctx, { documentId: noCustomer.document.id, to: 'issued' }).error, 'needs_customer');
  const noLines = createDocument(ctx, { type: 'quote', contactId });
  assert.equal(transitionDocument(ctx, { documentId: noLines.document.id, to: 'issued' }).error, 'needs_lines');
  // Neither consumed a number: the next real issue is still 0001.
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  assert.equal(transitionDocument(ctx, { documentId: q.document.id, to: 'issued' }).document.number, 'O-2026-0001');
});

test('an illegal transition is rejected and changes no state', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  const bad = transitionDocument(ctx, { documentId: q.document.id, to: 'sent' }); // draft -> sent skips issue
  assert.equal(bad.error, 'illegal_transition');
  assert.equal(getDocument(ctx, { documentId: q.document.id }).document.status, 'draft');
});

// --- The poster seam: invoice posts, credit_note is unregistered --------------------------------

test('issuing an invoice posts through the delegate and links posted_entry_id', () => {
  const { ctx, contactId, store } = setup();
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  const issued = transitionDocument(ctx, { documentId: inv.document.id, to: 'issued', idempotencyKey: 'inv-iss' });
  assert.equal(issued.ok, true);
  assert.equal(issued.document.number, 'R-2026-0001');
  assert.ok(issued.document.postedEntryId, 'the posted entry is linked');
  const entries = store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE status = 'posted'").get();
  assert.equal(entries.n, 1);
});

test('issuing a generic credit_note draft (no reference invoice) is an honest error and consumes no number', () => {
  // Until A13 landed this pinned `posting_delegate_unregistered`. The delegate exists now, and the
  // honest refusal moved one step later: a credit-note draft made through the generic verb carries
  // no `credited_document_id`, so the registered poster refuses `needs_reference_invoice`, the
  // draft stays a draft, and the gap-free counter is untouched. Same property, real delegate.
  const { ctx, contactId } = setup();
  const cn = createDocument(ctx, { type: 'credit_note', contactId, lines: [LINE] });
  const attempt = transitionDocument(ctx, { documentId: cn.document.id, to: 'issued' });
  assert.equal(attempt.error, 'needs_reference_invoice');
  assert.equal(getDocument(ctx, { documentId: cn.document.id }).document.status, 'draft');
  assert.equal(getDocument(ctx, { documentId: cn.document.id }).document.number, null);
});

// --- Cancel: posted reverses (ledger still balances), draft deletes ------------------------------

test('cancelling a POSTED invoice reverses the entry and the ledger still nets to zero', () => {
  const { ctx, contactId, store } = setup();
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  const issued = transitionDocument(ctx, { documentId: inv.document.id, to: 'issued' });
  const originalEntry = issued.document.postedEntryId;

  const cancelled = transitionDocument(ctx, { documentId: inv.document.id, to: 'cancelled', idempotencyKey: 'can-1' });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.document.status, 'cancelled');

  // The original entry is untouched; a reversing entry now exists that references it.
  const original = store.db.prepare('SELECT status FROM journal_entry WHERE id = ?').get(originalEntry);
  assert.equal(original.status, 'posted');
  const reversal = store.db
    .prepare('SELECT id FROM journal_entry WHERE reverses_entry_id = ?')
    .get(originalEntry);
  assert.ok(reversal, 'a reversing entry references the original');

  // §H-LEDGER: total debits == total credits across every posted line, before and after.
  const sums = store.db
    .prepare('SELECT SUM(debit_minor) AS d, SUM(credit_minor) AS c FROM journal_line')
    .get();
  assert.equal(sums.d, sums.c, 'the ledger balances net after the reversal');
});

test('cancelling a DRAFT deletes it outright, leaving no journal trace', () => {
  const { ctx, contactId, store } = setup();
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  const cancelled = transitionDocument(ctx, { documentId: inv.document.id, to: 'cancelled' });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.deleted, true);
  assert.equal(getDocument(ctx, { documentId: inv.document.id }).error, 'not_found');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_line').get().n, 0);
});

// --- period lock: issuing into a locked period is refused, no number ----------------------------

test('issuing an invoice into a locked period returns period_locked and consumes no number', () => {
  const lockedPeriods = {
    assertOpen: (date) =>
      date.startsWith('2026-07')
        ? { ok: false, error: 'period_locked', period: '2026-07', kind: 'soft' }
        : { ok: true },
  };
  const { ctx, contactId } = setup(AT, { periods: lockedPeriods });
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  const attempt = transitionDocument(ctx, { documentId: inv.document.id, to: 'issued' });
  assert.equal(attempt.error, 'period_locked');
  const after = getDocument(ctx, { documentId: inv.document.id });
  assert.equal(after.document.status, 'draft');
  assert.equal(after.document.number, null);
  // Gap-free: a later successful issue (a quote, no posting) is still 0001 for its own series.
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  assert.equal(transitionDocument(ctx, { documentId: q.document.id, to: 'issued' }).document.number, 'O-2026-0001');
});

// --- updateDocument: draft-only ----------------------------------------------------------------

test('updateDocument patches a draft and recomputes the subtotal', () => {
  const { ctx, contactId } = setup();
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  const patched = updateDocument(ctx, {
    documentId: inv.document.id,
    patch: { lines: [{ unitPriceMinor: 5000 }, { unitPriceMinor: 2000 }], notes: 'Rev 2' },
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.document.subtotalMinor, 7000);
  assert.equal(patched.document.notes, 'Rev 2');
  assert.equal(patched.lines.length, 2);
});

test('updateDocument refuses a non-draft document (immutable, §H-AUDIT)', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  transitionDocument(ctx, { documentId: q.document.id, to: 'issued' });
  const attempt = updateDocument(ctx, { documentId: q.document.id, patch: { notes: 'nope' } });
  assert.equal(attempt.error, 'illegal_transition');
  assert.equal(attempt.reason, 'document_immutable');
});

// --- convertDocument: carries + links + marks terminal + idempotent -----------------------------

test('convertDocument clones the quote into an order, links the source, marks it converted', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE, { unitPriceMinor: 3000 }] });
  transitionDocument(ctx, { documentId: q.document.id, to: 'issued' });
  transitionDocument(ctx, { documentId: q.document.id, to: 'sent' });
  transitionDocument(ctx, { documentId: q.document.id, to: 'accepted' });

  const converted = convertDocument(ctx, { documentId: q.document.id, toType: 'order', idempotencyKey: 'conv-1' });
  assert.equal(converted.ok, true);
  assert.equal(converted.document.type, 'order');
  assert.equal(converted.document.status, 'draft');
  assert.equal(converted.document.sourceDocumentId, q.document.id);
  assert.equal(converted.document.contactId, contactId);
  assert.equal(converted.document.subtotalMinor, 150000 + 3000);
  assert.equal(converted.lines.length, 2);
  // The source is now terminal.
  assert.equal(getDocument(ctx, { documentId: q.document.id }).document.status, 'converted');
});

test('convertDocument is idempotent: the same key returns the same target, no duplicate', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  transitionDocument(ctx, { documentId: q.document.id, to: 'issued' });
  transitionDocument(ctx, { documentId: q.document.id, to: 'sent' });
  transitionDocument(ctx, { documentId: q.document.id, to: 'accepted' });
  const a = convertDocument(ctx, { documentId: q.document.id, toType: 'order', idempotencyKey: 'conv-k' });
  const b = convertDocument(ctx, { documentId: q.document.id, toType: 'order', idempotencyKey: 'conv-k' });
  assert.deepEqual(a, b);
  assert.equal(listDocuments(ctx, { type: 'order' }).documents.length, 1);
});

test('converting an unconvertible source (a quote not yet accepted) is illegal_transition', () => {
  const { ctx, contactId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  transitionDocument(ctx, { documentId: q.document.id, to: 'issued' }); // still just issued, not accepted
  const attempt = convertDocument(ctx, { documentId: q.document.id, toType: 'order' });
  assert.equal(attempt.error, 'illegal_transition');
  assert.equal(attempt.expected, 'accepted');
});

test('an invoice cannot be converted (no conversion rule)', () => {
  const { ctx, contactId } = setup();
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  assert.equal(convertDocument(ctx, { documentId: inv.document.id, toType: 'order' }).error, 'illegal_transition');
});

// --- Idempotency scope: a key belongs to ONE document, never a shared namespace ------------------

test('the same transition key on two DIFFERENT documents does not cross-replay', () => {
  const { ctx, contactId } = setup();
  const a = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  const b = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  const issuedA = transitionDocument(ctx, { documentId: a.document.id, to: 'issued', idempotencyKey: 'shared-k' });
  const issuedB = transitionDocument(ctx, { documentId: b.document.id, to: 'issued', idempotencyKey: 'shared-k' });
  assert.equal(issuedA.document.id, a.document.id);
  assert.equal(issuedB.ok, true);
  assert.equal(issuedB.document.id, b.document.id, "B gets ITS OWN result, not a replay of A's");
  assert.equal(getDocument(ctx, { documentId: b.document.id }).document.status, 'issued', 'B really issued');
  assert.notEqual(issuedB.document.number, issuedA.document.number, 'each consumed its own number');
  // The per-document replay still works: retrying A with the same key returns A's original.
  assert.deepEqual(transitionDocument(ctx, { documentId: a.document.id, to: 'issued', idempotencyKey: 'shared-k' }), issuedA);
});

test('the same convert key on two DIFFERENT documents does not cross-replay', () => {
  const { ctx, contactId } = setup();
  const accepted = () => {
    const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
    transitionDocument(ctx, { documentId: q.document.id, to: 'issued' });
    transitionDocument(ctx, { documentId: q.document.id, to: 'sent' });
    transitionDocument(ctx, { documentId: q.document.id, to: 'accepted' });
    return q.document.id;
  };
  const qA = accepted();
  const qB = accepted();
  const convA = convertDocument(ctx, { documentId: qA, toType: 'order', idempotencyKey: 'conv-shared' });
  const convB = convertDocument(ctx, { documentId: qB, toType: 'order', idempotencyKey: 'conv-shared' });
  assert.equal(convA.document.sourceDocumentId, qA);
  assert.equal(convB.ok, true);
  assert.equal(convB.document.sourceDocumentId, qB, "B converts ITSELF, not a replay of A's target");
  assert.equal(getDocument(ctx, { documentId: qB }).document.status, 'converted', 'B really converted');
  assert.equal(listDocuments(ctx, { type: 'order' }).documents.length, 2);
});

// --- Atomicity: an unkeyed create/update/convert commits everything or nothing ------------------

/** Run a verb that may (today) throw a raw driver error; fold a throw into a Result-shaped reject. */
function callSafely(fn) {
  try {
    return fn();
  } catch (e) {
    return { ok: false, error: 'raw_throw', message: String(e) };
  }
}

/** A ctx whose id generator throws for one prefix: a genuine mid-transaction failure injector. */
function ctxFailingOn(store, deps, workspaceId, failPrefix) {
  const failingIds = {
    next: (prefix) => {
      if (prefix === failPrefix) throw new Error(`boom: injected failure on ${failPrefix}`);
      return deps.ids.next(prefix);
    },
  };
  return makeContext(store, { workspaceId, actor: 'user_1', clock: deps.clock, ids: failingIds });
}

test('a failed unkeyed update leaves the draft lines and total unchanged (atomic patch)', () => {
  const { ctx, contactId, store, deps, workspaceId } = setup();
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  const before = getDocument(ctx, { documentId: inv.document.id });
  assert.equal(before.lines.length, 1);
  assert.equal(before.document.subtotalMinor, 150000);

  // The patch DELETEs the old lines first, then the injected failure hits the new line's id
  // generation. Without a wrapping transaction the delete commits and the failure leaves a draft
  // with zero lines but the stale total: a lying document.
  const brokenCtx = ctxFailingOn(store, deps, workspaceId, 'docline');
  const failed = callSafely(() =>
    updateDocument(brokenCtx, {
      documentId: inv.document.id,
      patch: { lines: [{ unitPriceMinor: 5 }] },
    }),
  );
  assert.equal(failed.ok, false);

  const after = getDocument(ctx, { documentId: inv.document.id });
  assert.equal(after.lines.length, 1, 'the old lines survive a failed patch');
  assert.equal(after.lines[0].lineTotalMinor, 150000);
  assert.equal(after.document.subtotalMinor, 150000, 'the total still matches the lines');
  const rawLines = store.db
    .prepare('SELECT COUNT(*) AS n FROM document_line WHERE document_id = ?')
    .get(inv.document.id);
  assert.equal(rawLines.n, 1, 'the rows are really on disk, not just in the view');
});

test('a failed unkeyed create creates nothing: no orphan document, no lines, no history', () => {
  const { contactId, store, deps, workspaceId } = setup();
  // The document row is inserted first; the injected failure hits the first line's id generation.
  const brokenCtx = ctxFailingOn(store, deps, workspaceId, 'docline');
  const failed = callSafely(() =>
    createDocument(brokenCtx, { type: 'invoice', contactId, lines: [{ unitPriceMinor: 5 }] }),
  );
  assert.equal(failed.ok, false);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document').get().n, 0, 'no orphan document');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_line').get().n, 0, 'no orphan lines');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document_status_history').get().n, 0, 'no orphan trail');
});

test('a failed unkeyed convert leaves the source accepted and creates no target (atomic convert)', () => {
  const { ctx, contactId, store, deps, workspaceId } = setup();
  const q = createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  transitionDocument(ctx, { documentId: q.document.id, to: 'issued' });
  transitionDocument(ctx, { documentId: q.document.id, to: 'sent' });
  transitionDocument(ctx, { documentId: q.document.id, to: 'accepted' });

  // The injected failure hits the convert's history write: everything before it (the target
  // document and its cloned lines) has already been written. Without a wrapping transaction those
  // writes commit and the failure leaves a half-converted pair.
  const brokenCtx = ctxFailingOn(store, deps, workspaceId, 'dhist');
  const failed = callSafely(() => convertDocument(brokenCtx, { documentId: q.document.id, toType: 'order' }));
  assert.equal(failed.ok, false);

  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM document WHERE type = 'order'").get().n, 0, 'no target');
  assert.equal(
    getDocument(ctx, { documentId: q.document.id }).document.status,
    'accepted',
    'the source is untouched and still convertible',
  );
});

// --- Reference validation: §H-TENANT on contactId and itemId, structured errors -----------------

/** A contact and an item seeded into a SECOND workspace of the same store. */
function seedForeignRefs(deps) {
  const otherWs = createWorkspace(deps, { name: 'Fremd GmbH' }).workspaceId;
  deps.store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at)
       VALUES ('ct_foreign', ?, 'customer', 'Fremd AG', 'CHF', 0, ?)`,
    )
    .run(otherWs, AT);
  deps.store.db
    .prepare(
      `INSERT INTO item (id, workspace_id, name, default_unit_price_minor, currency, created_at)
       VALUES ('it_foreign', ?, 'Fremdposition', 1000, 'CHF', ?)`,
    )
    .run(otherWs, AT);
  return { otherWs };
}

test('createDocument rejects a cross-tenant contactId with a structured error (H-TENANT)', () => {
  const { ctx, store, deps } = setup();
  seedForeignRefs(deps);
  const attempt = callSafely(() => createDocument(ctx, { type: 'invoice', contactId: 'ct_foreign', lines: [LINE] }));
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'invalid_reference', 'a structured code, never a raw driver throw');
  assert.equal(attempt.field, 'contactId');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document').get().n, 0, 'nothing was created');
});

test('createDocument rejects a nonexistent itemId with a structured error, never a raw throw', () => {
  const { ctx, contactId, store } = setup();
  const attempt = callSafely(() =>
    createDocument(ctx, { type: 'invoice', contactId, lines: [{ itemId: 'it_nope', unitPriceMinor: 5 }] }),
  );
  assert.equal(attempt.ok, false);
  assert.equal(attempt.error, 'invalid_reference');
  assert.equal(attempt.field, 'itemId');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM document').get().n, 0, 'nothing was created');
});

test('updateDocument rejects a cross-tenant contactId and a cross-tenant itemId (H-TENANT)', () => {
  const { ctx, contactId, deps } = setup();
  seedForeignRefs(deps);
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });

  const foreignContact = callSafely(() =>
    updateDocument(ctx, { documentId: inv.document.id, patch: { contactId: 'ct_foreign' } }),
  );
  assert.equal(foreignContact.error, 'invalid_reference');
  assert.equal(foreignContact.field, 'contactId');

  const foreignItem = callSafely(() =>
    updateDocument(ctx, { documentId: inv.document.id, patch: { lines: [{ itemId: 'it_foreign', unitPriceMinor: 5 }] } }),
  );
  assert.equal(foreignItem.error, 'invalid_reference');
  assert.equal(foreignItem.field, 'itemId');

  // The draft is untouched by both rejections.
  const after = getDocument(ctx, { documentId: inv.document.id });
  assert.equal(after.document.contactId, contactId);
  assert.equal(after.lines.length, 1);
  assert.equal(after.document.subtotalMinor, 150000);
});

test('a document can still reference its OWN workspace item (the check is tenancy, not existence-phobia)', () => {
  const { ctx, contactId, deps, workspaceId } = setup();
  deps.store.db
    .prepare(
      `INSERT INTO item (id, workspace_id, name, default_unit_price_minor, currency, created_at)
       VALUES ('it_own', ?, 'Beratung', 15000, 'CHF', ?)`,
    )
    .run(workspaceId, AT);
  const made = createDocument(ctx, { type: 'quote', contactId, lines: [{ itemId: 'it_own', unitPriceMinor: 15000 }] });
  assert.equal(made.ok, true);
  assert.equal(made.lines[0].itemId, 'it_own');
});

// --- listDocuments: filters and tenancy ---------------------------------------------------------

test('listDocuments filters by type, status, and contact, and never crosses workspaces', () => {
  const { ctx, contactId, deps } = setup();
  createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  const inv = createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });
  transitionDocument(ctx, { documentId: inv.document.id, to: 'issued' });

  assert.equal(listDocuments(ctx, { type: 'quote' }).documents.length, 1);
  assert.equal(listDocuments(ctx, { type: 'invoice', status: 'issued' }).documents.length, 1);
  assert.equal(listDocuments(ctx, { contactId }).documents.length, 2);

  // §H-TENANT: a second workspace sees none of the first's documents.
  const otherWs = createWorkspace(deps, { name: 'Other GmbH' }).workspaceId;
  const otherCtx = makeContext(deps.store, { workspaceId: otherWs, actor: 'u', clock: deps.clock, ids: deps.ids });
  assert.equal(listDocuments(otherCtx, {}).documents.length, 0);
});

test('listDocuments reports the true total and flags truncation at the D34 ceiling', () => {
  const { ctx, store, workspaceId, contactId } = setup();
  const small = listDocuments(ctx, {});
  assert.equal(small.truncated, false);
  assert.equal(small.total, 0, 'an empty list has total 0');

  // 1001 raw draft rows: one past the ceiling. Raw SQL keeps this fast; listDocuments only reads.
  const insert = store.db.prepare(
    `INSERT INTO document (id, workspace_id, type, number, status, contact_id, currency, subtotal_minor, tax_minor, total_minor, created_at)
     VALUES (?, ?, 'invoice', NULL, 'draft', ?, 'CHF', 0, 0, 0, ?)`,
  );
  for (let i = 0; i < 1001; i += 1) insert.run(`doc_bulk_${i}`, workspaceId, contactId, AT);

  const capped = listDocuments(ctx, {});
  assert.equal(capped.ok, true);
  assert.equal(capped.documents.length, 1000, 'the page stops at the ceiling');
  assert.equal(capped.truncated, true, 'truncation is flagged, never silent');
  assert.equal(capped.total, 1001, 'the true count is reported so a client can say "1000 of 1001"');
  assert.equal(capped.ceiling, 1000);
});

// G00 HAS LANDED. This test used to assert the `unsupported` / `saved_views_not_built` refusal that
// stood in for saved views while there were none. The refusal was correct then and would be a lie now,
// so it is replaced by the behaviour it was holding a place for. An UNKNOWN id must still never fall
// back to the unfiltered list, which is the half of the old assertion that still matters.
test('listDocuments applies a saved view, and an unknown one still never yields a silent full list', () => {
  const { ctx, contactId } = setup();
  createDocument(ctx, { type: 'quote', contactId, lines: [LINE] });
  createDocument(ctx, { type: 'invoice', contactId, lines: [LINE] });

  const view = createSavedView(ctx, { entityKind: 'document', name: 'Nur Offerten', filters: { type: 'quote' } });
  assert.equal(view.ok, true);

  const viewed = listDocuments(ctx, { savedViewId: view.savedView.viewId });
  assert.equal(viewed.ok, true);
  assert.equal(viewed.documents.length, 1, "the view's stored filter really narrowed the list");
  assert.equal(viewed.documents[0].type, 'quote');

  // An explicit filter WINS over the same filter in the view: the caller picked the view and then
  // narrowed it, so stored state must not override a value typed in the request.
  const overridden = listDocuments(ctx, { savedViewId: view.savedView.viewId, type: 'invoice' });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.documents.length, 1);
  assert.equal(overridden.documents[0].type, 'invoice');

  const unknown = listDocuments(ctx, { savedViewId: 'sv_anything' });
  assert.equal(unknown.ok, false, 'an unknown savedViewId must not silently return the unfiltered list');
  assert.equal(unknown.error, 'not_found');

  assert.equal(listDocuments(ctx, {}).ok, true);
});

test('getDocument returns not_found for an unknown id', () => {
  const { ctx } = setup();
  assert.equal(getDocument(ctx, { documentId: 'nope' }).error, 'not_found');
});
