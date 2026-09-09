// C02, quotes / proposals: the money-path discipline, asserted rather than documented.
//
// A quote rides A10's shared document machine, so these tests prove the four things a critic scoped
// to the money path checks bite:
//   1. QUOTE CREATION POSTS NOTHING (no journal entry, no payment).
//   2. CONVERT IS IDEMPOTENT AND SINGLE-ISSUE (a double-convert yields exactly ONE document).
//   3. TAX + TOTALS FREEZE (a later item-price or tax-code change never moves an accepted/converted
//      quote's figures).
//   4. §H-TENANT (a cross-tenant id or token can never read, mutate, accept or convert a quote).
// plus the lifecycle guards (validity window, no-lines send refusal, single-use token, revise chain).

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import {
  createItem,
  updateItem,
  createQuote,
  updateQuote,
  sendQuote,
  acceptQuote,
  declineQuote,
  sweepExpiredQuotes,
  reviseQuote,
  convertQuote,
  getQuote,
  listQuotes,
} from '../../dist/core/sales/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function makeCtx(store, deps, name, clockAt = AT) {
  const workspaceId = createWorkspace(deps, { name }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock: fixedClock(clockAt), ids: deps.ids });
  const contactId = ctx.store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, default_currency, payment_terms_days, created_at)
       VALUES (?, ?, 'customer', 'Muster AG', 'CHF', 30, ?) RETURNING id`,
    )
    .get(`ct_${workspaceId}`, workspaceId, clockAt).id;
  return { ctx, workspaceId, contactId };
}

function setup(clockAt = AT) {
  const clock = fixedClock(clockAt);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const a = makeCtx(store, deps, 'Acme AG', clockAt);
  return { store, deps, ...a };
}

function journalCount(ctx) {
  return ctx.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(ctx.workspaceId).n;
}
function paymentCount(ctx) {
  return ctx.store.db.prepare('SELECT COUNT(*) AS n FROM payment WHERE workspace_id = ?').get(ctx.workspaceId).n;
}
function documentCount(ctx, type) {
  return ctx.store.db
    .prepare('SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = ?')
    .get(ctx.workspaceId, type).n;
}
function draft(ctx, contactId, validUntil = '2027-01-31', lines = [{ description: 'Leistung', unitPriceMinor: 20000 }]) {
  const r = createQuote(ctx, { contactId, validUntil, lines, idempotencyKey: `q-${ctx.ids.next('k')}` });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.document.id;
}

// --- 1. Quote creation posts nothing -----------------------------------------------------------

test('createQuote posts NOTHING to the ledger: no journal entry, no payment, no posted_entry_id', () => {
  const { ctx, contactId } = setup();
  assert.equal(journalCount(ctx), 0);
  const made = createQuote(ctx, {
    contactId,
    validUntil: '2027-01-31',
    lines: [{ description: 'Beratung', quantityMilli: 10000, unitPriceMinor: 15000 }],
    idempotencyKey: 'q1',
  });
  assert.equal(made.ok, true);
  assert.equal(made.document.status, 'draft');
  assert.equal(made.document.type, 'quote');
  assert.equal(made.document.postedEntryId, null);
  assert.equal(made.document.subtotalMinor, 150000);
  // The whole point: nothing reached the books or the settlement half.
  assert.equal(journalCount(ctx), 0, 'a quote wrote a journal entry');
  assert.equal(paymentCount(ctx), 0, 'a quote wrote a payment');
});

test('the whole quote lifecycle (create -> send -> accept) posts nothing', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  assert.equal(sendQuote(ctx, { quoteId: id, idempotencyKey: 's1' }).ok, true);
  assert.equal(acceptQuote(ctx, { quoteId: id, actor: 'Kundin', idempotencyKey: 'a1' }).ok, true);
  assert.equal(journalCount(ctx), 0, 'the quote lifecycle posted a journal entry');
  assert.equal(paymentCount(ctx), 0);
});

test('createQuote is idempotent under a key: a replay writes no second quote', () => {
  const { ctx, contactId } = setup();
  const a = createQuote(ctx, { contactId, lines: [{ unitPriceMinor: 5000 }], idempotencyKey: 'k1' });
  const b = createQuote(ctx, { contactId, lines: [{ unitPriceMinor: 5000 }], idempotencyKey: 'k1' });
  assert.deepEqual(a, b);
  assert.equal(documentCount(ctx, 'quote'), 1);
});

// --- 2. Convert is idempotent and single-issue -------------------------------------------------

test('convert is idempotent and single-issue: a double-convert yields exactly ONE invoice', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  acceptQuote(ctx, { quoteId: id, actor: 'K', idempotencyKey: 'a' });

  const first = convertQuote(ctx, { quoteId: id, to: 'invoice', idempotencyKey: 'c1' });
  assert.equal(first.ok, true);
  const targetId = first.document.id;

  // Same key: pure replay.
  const replay = convertQuote(ctx, { quoteId: id, to: 'invoice', idempotencyKey: 'c1' });
  assert.equal(replay.document.id, targetId);
  // A DIFFERENT key on an already-converted source returns the existing target, never a new one.
  const again = convertQuote(ctx, { quoteId: id, to: 'invoice', idempotencyKey: 'c2' });
  assert.equal(again.document.id, targetId, 'a second convert minted a new document');

  assert.equal(documentCount(ctx, 'invoice'), 1, 'more than one invoice exists after a double-convert');
  // And it is a DRAFT: convert never posts. Revenue is A11's, at issue.
  assert.equal(first.document.status, 'draft');
  assert.equal(journalCount(ctx), 0, 'convert posted to the ledger');
});

test('convert refuses a non-accepted quote (A10 illegal_transition guard)', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  const r = convertQuote(ctx, { quoteId: id, to: 'invoice', idempotencyKey: 'c' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal_transition');
});

test('convert refuses an unknown target type', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  const r = convertQuote(ctx, { quoteId: id, to: 'delivery_note', idempotencyKey: 'c' });
  assert.equal(r.error, 'invalid_type');
});

// --- 3. Tax + totals freeze --------------------------------------------------------------------

test('price + tax FREEZE: a later item price/tax change never moves an accepted or converted quote', () => {
  const { ctx, contactId } = setup();
  seedTaxCodes(ctx);
  const item = createItem(ctx, { name: 'Beratung', defaultUnitPriceMinor: 10000, defaultTaxCode: 'UST81', idempotencyKey: 'it' });
  assert.equal(item.ok, true, JSON.stringify(item));
  const itemId = item.item.id;

  // The line is priced/taxed ONCE, from the item, and snapshotted.
  const made = createQuote(ctx, { contactId, validUntil: '2027-01-31', lines: [{ itemId }], idempotencyKey: 'q' });
  assert.equal(made.ok, true);
  assert.equal(made.lines[0].unitPriceMinor, 10000, 'the item price was not snapshotted onto the line');
  assert.equal(made.lines[0].taxCode, 'UST81', 'the item tax code was not snapshotted onto the line');
  const quoteId = made.document.id;

  sendQuote(ctx, { quoteId, idempotencyKey: 's' });
  acceptQuote(ctx, { quoteId, actor: 'K', idempotencyKey: 'a' });

  // Now the master data moves underneath.
  assert.equal(updateItem(ctx, { itemId, patch: { defaultUnitPriceMinor: 99999, defaultTaxCode: 'UST26' } }).ok, true);

  // The accepted quote is unchanged: the freeze holds.
  const frozen = getQuote(ctx, { quoteId });
  assert.equal(frozen.lines[0].unitPriceMinor, 10000, 'the accepted quote line moved with the item price');
  assert.equal(frozen.lines[0].taxCode, 'UST81', 'the accepted quote line moved with the item tax code');

  // And the converted invoice carries the byte-equal frozen values (A10 clone).
  const converted = convertQuote(ctx, { quoteId, to: 'invoice', idempotencyKey: 'c' });
  assert.equal(converted.lines[0].unitPriceMinor, 10000);
  assert.equal(converted.lines[0].taxCode, 'UST81', 'the VAT trace did not survive the convert clone');
});

test('an issued quote is immutable: updateQuote refuses a patch once it is sent (freeze at write time)', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  const r = updateQuote(ctx, { quoteId: id, patch: { lines: [{ unitPriceMinor: 1 }] }, idempotencyKey: 'u' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal_transition'); // A10's document_immutable shape
});

// --- 4. §H-TENANT ------------------------------------------------------------------------------

test('§H-TENANT: a foreign workspace cannot read, accept or convert another tenant\'s quote', () => {
  const { store, deps, ctx: ctxA, contactId } = setup();
  const other = makeCtx(store, deps, 'Beta AG');
  const ctxB = other.ctx;

  const id = draft(ctxA, contactId);
  sendQuote(ctxA, { quoteId: id, idempotencyKey: 's' });

  // Read: B sees nothing.
  assert.equal(getQuote(ctxB, { quoteId: id }).error, 'not_found');
  // Accept: B cannot move A's quote.
  assert.equal(acceptQuote(ctxB, { quoteId: id, actor: 'X', idempotencyKey: 'a' }).error, 'not_found');
  // Convert: B cannot convert A's quote.
  assert.equal(convertQuote(ctxB, { quoteId: id, to: 'invoice', idempotencyKey: 'c' }).error, 'not_found');
  // And A's quote is still exactly where A left it.
  assert.equal(getQuote(ctxA, { quoteId: id }).document.status, 'sent');
});

test('§H-TENANT: an accept token minted in one workspace never resolves in another', () => {
  const { store, deps, ctx: ctxA, contactId } = setup();
  const ctxB = makeCtx(store, deps, 'Gamma AG').ctx;
  const id = draft(ctxA, contactId);
  const sent = sendQuote(ctxA, { quoteId: id, idempotencyKey: 's' });
  const token = sent.acceptToken;
  assert.equal(typeof token, 'string');
  // The token is scoped by the workspace-scoped hash lookup: B cannot use it.
  assert.equal(acceptQuote(ctxB, { token, idempotencyKey: 'a' }).error, 'invalid_token');
});

// --- Token single-use + validity window --------------------------------------------------------

test('the accept token is single-use: reusing it after acceptance is refused', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  const sent = sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  const token = sent.acceptToken;
  assert.equal(acceptQuote(ctx, { token, idempotencyKey: 'a1' }).ok, true);
  // A fresh call (new key) with the same token: the hash is gone, so it cannot resolve.
  assert.equal(acceptQuote(ctx, { token, idempotencyKey: 'a2' }).error, 'invalid_token');
});

test('acceptance after valid_until is refused (OR Art. 3 binding window)', () => {
  const { store, deps, ctx, contactId } = setup();
  // A quote valid only through 2026-08-31, created and sent at the fixture clock (2026-07-16).
  const id = draft(ctx, contactId, '2026-08-31');
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  // The same store, read by a clock a month past validity.
  const later = makeContext(store, { workspaceId: ctx.workspaceId, actor: 'host', clock: fixedClock('2026-10-01T00:00:00.000Z'), ids: deps.ids });
  const r = acceptQuote(later, { quoteId: id, actor: 'Kundin', idempotencyKey: 'a' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'quote_expired');
});

test('createQuote refuses a validity in the past', () => {
  const { ctx, contactId } = setup();
  const r = createQuote(ctx, { contactId, validUntil: '2020-01-01', lines: [{ unitPriceMinor: 1000 }], idempotencyKey: 'q' });
  assert.equal(r.error, 'validity_in_past');
});

// --- Send + sweep + revise ---------------------------------------------------------------------

test('send issues without posting and degrades to transmitted:false / needs_dispatch_module', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  const sent = sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  assert.equal(sent.ok, true);
  assert.equal(sent.document.status, 'sent');
  assert.equal(sent.document.number !== null, true, 'send did not assign the gap-free O-number');
  assert.equal(sent.transmitted, false);
  assert.equal(sent.reason, 'cloud_tier');
  assert.equal(sent.dispatch, 'needs_dispatch_module');
  assert.equal(journalCount(ctx), 0);
});

test('send refuses a quote with no lines', () => {
  const { ctx, contactId } = setup();
  const made = createQuote(ctx, { contactId, validUntil: '2027-01-31', lines: [], idempotencyKey: 'q' });
  assert.equal(made.ok, true);
  const r = sendQuote(ctx, { quoteId: made.document.id, idempotencyKey: 's' });
  assert.equal(r.error, 'no_lines');
});

test('send refuses a non-draft quote', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's1' });
  const r = sendQuote(ctx, { quoteId: id, idempotencyKey: 's2' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal_transition');
});

test('sweepExpiredQuotes moves only sent quotes past validity, and is a no-op otherwise', () => {
  const { store, deps, ctx, contactId } = setup();
  const past = draft(ctx, contactId, '2026-08-31');
  const future = draft(ctx, contactId, '2027-06-30');
  sendQuote(ctx, { quoteId: past, idempotencyKey: 'sp' });
  sendQuote(ctx, { quoteId: future, idempotencyKey: 'sf' });
  const later = makeContext(store, { workspaceId: ctx.workspaceId, actor: 'sweeper', clock: fixedClock('2026-10-01T00:00:00.000Z'), ids: deps.ids });
  const r = sweepExpiredQuotes(later, { idempotencyKey: 'sw' });
  assert.equal(r.expired, 1, 'the sweep expired the wrong number of quotes');
  assert.equal(getQuote(later, { quoteId: past }).document.status, 'expired');
  assert.equal(getQuote(later, { quoteId: future }).document.status, 'sent');
});

test('revise clones the frozen lines into version n+1 and retires the old one; an accepted quote refuses revise', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId, '2027-01-31', [{ description: 'A', unitPriceMinor: 12345 }]);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  const revised = reviseQuote(ctx, { quoteId: id, idempotencyKey: 'rev' });
  assert.equal(revised.ok, true);
  assert.equal(revised.document.version, 2);
  assert.equal(revised.document.supersedesId, id);
  assert.equal(revised.document.status, 'draft');
  assert.equal(revised.lines[0].unitPriceMinor, 12345, 'the revision did not clone the frozen line');
  assert.equal(revised.supersededId, id);
  // The old version is retired.
  assert.equal(getQuote(ctx, { quoteId: id }).document.status, 'superseded');
  // The newest-version collapse: the list hides the superseded one by default.
  const list = listQuotes(ctx, {});
  assert.equal(list.documents.some((d) => d.id === id), false, 'a superseded quote still shows by default');
  assert.equal(list.documents.some((d) => d.id === revised.document.id), true);

  // A revision cannot be taken from an accepted quote (the binding record).
  const other = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: other, idempotencyKey: 's2' });
  acceptQuote(ctx, { quoteId: other, actor: 'K', idempotencyKey: 'a2' });
  assert.equal(reviseQuote(ctx, { quoteId: other, idempotencyKey: 'rev2' }).error, 'illegal_transition');
});

test('a rejected revise of an ACCEPTED quote writes NO orphan draft (tx rolls back on err)', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  acceptQuote(ctx, { quoteId: id, actor: 'K', idempotencyKey: 'a' });

  const before = documentCount(ctx, 'quote');
  const r = reviseQuote(ctx, { quoteId: id, idempotencyKey: 'rev' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal_transition');
  // The bug: a new draft (version 2, supersedes the accepted quote) was COMMITTED while the verb
  // returned ok:false, so the quote count went 1 -> 2. A rejection must write ZERO rows.
  assert.equal(documentCount(ctx, 'quote'), before, 'a rejected revise left an orphan quote behind');
  // And the accepted source is untouched: still accepted, never flipped to superseded.
  assert.equal(getQuote(ctx, { quoteId: id }).document.status, 'accepted');
});

test('a rejected revise of a CONVERTED quote spawns no duplicate convertible draft', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  acceptQuote(ctx, { quoteId: id, actor: 'K', idempotencyKey: 'a' });
  convertQuote(ctx, { quoteId: id, to: 'invoice', idempotencyKey: 'c' });

  const quotesBefore = documentCount(ctx, 'quote');
  const invoicesBefore = documentCount(ctx, 'invoice');
  const r = reviseQuote(ctx, { quoteId: id, idempotencyKey: 'rev' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'illegal_transition');
  // The bug: a converted quote (which already produced an invoice) spawned a second convertible
  // draft. Neither the quote nor the invoice count may move on a rejected revise.
  assert.equal(documentCount(ctx, 'quote'), quotesBefore, 'a rejected revise of a converted quote left an orphan');
  assert.equal(documentCount(ctx, 'invoice'), invoicesBefore);
  assert.equal(getQuote(ctx, { quoteId: id }).document.status, 'converted');
});

test('a rejected revise under an idempotencyKey writes no orphan and is not memoised as an error', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  acceptQuote(ctx, { quoteId: id, actor: 'K', idempotencyKey: 'a' });

  const before = documentCount(ctx, 'quote');
  const first = reviseQuote(ctx, { quoteId: id, idempotencyKey: 'rev-key' });
  assert.equal(first.error, 'illegal_transition');
  // The idempotencyKey path was the worst case: rememberIdempotent memoised the error AND kept the
  // committed orphan. After the fix, the rejection rolls back before the idempotency row is written,
  // so the count is unchanged and a replay recomputes the same honest error rather than a stale one.
  assert.equal(documentCount(ctx, 'quote'), before, 'the idempotency path committed an orphan quote');
  const replay = reviseQuote(ctx, { quoteId: id, idempotencyKey: 'rev-key' });
  assert.equal(replay.error, 'illegal_transition');
  assert.equal(documentCount(ctx, 'quote'), before, 'the idempotency replay committed an orphan quote');
});

test('revising a draft is refused (drafts are edited in place)', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  assert.equal(reviseQuote(ctx, { quoteId: id, idempotencyKey: 'rev' }).error, 'edit_draft_instead');
});

test('decline records a reason, invalidates the token, and lands the quote in declined', () => {
  const { ctx, contactId } = setup();
  const id = draft(ctx, contactId);
  const sent = sendQuote(ctx, { quoteId: id, idempotencyKey: 's' });
  const r = declineQuote(ctx, { quoteId: id, declineReason: 'Zu teuer', idempotencyKey: 'd' });
  assert.equal(r.ok, true);
  assert.equal(r.document.status, 'declined');
  assert.equal(r.document.declineReason, 'Zu teuer');
  // The token is now dead.
  assert.equal(acceptQuote(ctx, { token: sent.acceptToken, idempotencyKey: 'a' }).error, 'invalid_token');
});
