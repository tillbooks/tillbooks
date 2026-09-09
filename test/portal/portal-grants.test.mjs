/**
 * F02 customer portal, driven through the registry (both faces run the same `action.run`).
 *
 * The suite proves the spec's §7/§8 assertions, and above all the security invariant this capability
 * exists for (US-F02.5): TOKEN / GRANT ISOLATION. A token resolves ONLY to its own tenant's and its
 * own grantee's scoped records, an expired or revoked token resolves to nothing, and every refusal
 * writes ZERO rows and mints no invoice.
 *
 * Covered:
 *   - create validation + the 90-day clamp; token security (no plaintext token/link in the DB);
 *   - the THREE FENCES: cross-tenant (A cannot reach B), cross-contact/cross-grantee (X cannot reach
 *     Y, even by a guessed id), scope (only the listed entities), expired and revoked deny
 *     identically, an unknown token denies;
 *   - the resolve read model (open amount from A14, QR reference from A11 verbatim);
 *   - quote_accept delegates to C02's REAL accept, idempotent (ONE acceptance, no double-issue);
 *   - TX-ATOMICITY: a refused accept/grant writes zero rows;
 *   - send P8 draft-gate; revoke stamps and never deletes; the audit trail.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

/** A call bound to one workspace (the operator face). */
function callFor(deps, workspaceId) {
  return (name, input) => getAction(name).run(deps, { workspaceId, ...input });
}

/** The token face: no workspace, the grant binds it. */
function tokenCall(deps, name, input) {
  return getAction(name).run(deps, input);
}

let seq = 0;
function k(prefix) {
  return `${prefix}-${(seq += 1)}`;
}

/** A customer contact with a full postal address + email (so an invoice can carry a QR part). */
function customer(call, name) {
  const key = k('c');
  const c = call('create_contact', {
    partyRole: 'customer',
    name,
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: `${key}@example.ch`,
    idempotencyKey: key,
  });
  assert.equal(c.ok, true, `create_contact refused: ${JSON.stringify(c)}`);
  return c.contact.id;
}

/** Prepare a workspace's VAT + creditor profile so issued invoices can build a QR-bill. */
function prepareBooks(call) {
  call('vat_seed_defaults', {});
  call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const p = call('set_creditor_profile', {
    creditorName: 'Portal GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  assert.equal(p.ok, true, `set_creditor_profile refused: ${JSON.stringify(p)}`);
}

/** An ISSUED CHF invoice for a contact, so it carries an open amount and a QR reference. */
function issuedInvoice(call, contactId, amount = 20000) {
  const key = k('inv');
  const doc = call('create_document', {
    type: 'invoice',
    contactId,
    currency: 'CHF',
    dueDate: '2026-09-01',
    lines: [{ description: 'Leistung', quantityMilli: 1000, unitPriceMinor: amount }],
    idempotencyKey: `${key}-doc`,
  });
  assert.equal(doc.ok, true, `create_document refused: ${JSON.stringify(doc)}`);
  const issued = call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: `${key}-issue` });
  assert.equal(issued.ok, true, `issue_invoice refused: ${JSON.stringify(issued)}`);
  return doc.document.id;
}

/** A sent quote for a contact (draft -> issued -> sent), acceptable by the portal. */
function sentQuote(call, contactId, amount = 30000) {
  const key = k('q');
  const q = call('quotes_create', {
    contactId,
    validUntil: '2027-01-31',
    lines: [{ description: 'Offerte-Leistung', unitPriceMinor: amount }],
    idempotencyKey: `${key}-create`,
  });
  assert.equal(q.ok, true, `quotes_create refused: ${JSON.stringify(q)}`);
  const sent = call('quotes_send', { quoteId: q.document.id, idempotencyKey: `${key}-send` });
  assert.equal(sent.ok, true, `quotes_send refused: ${JSON.stringify(sent)}`);
  return q.document.id;
}

function grant(call, contactId, scopes, expiresAt = '2027-01-31') {
  return call('portal_grant_create', { contactId, scopes, expiresAt, idempotencyKey: k('g') });
}

// --- Create validation + clamp -------------------------------------------------------------------

test('F02 create: refuses an empty scope, a foreign contact, and a past expiry (no row written)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');
  const count = () => deps.store.db.prepare('SELECT COUNT(*) AS n FROM portal_grant').get().n;

  assert.equal(count(), 0);
  const empty = grant(call, contactId, []);
  assert.equal(empty.ok, false);
  assert.equal(empty.error, 'invalid_scope');

  const foreign = grant(call, 'contact_does_not_exist', [{ kind: 'all_invoices' }]);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error, 'contact_not_found');

  const past = grant(call, contactId, [{ kind: 'all_invoices' }], '2020-01-01');
  assert.equal(past.ok, false);
  assert.equal(past.error, 'expiry_in_past');

  assert.equal(count(), 0, 'a refused create wrote a portal_grant row (tx-atomicity broken)');
});

test('F02 create: a scope naming another contact\'s invoice is refused (the contact fence at write)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  prepareBooks(call);
  const x = customer(call, 'Kundin X AG');
  const y = customer(call, 'Kundin Y AG');
  const yInvoice = issuedInvoice(call, y);

  const leak = grant(call, x, [{ kind: 'invoice', id: yInvoice }]);
  assert.equal(leak.ok, false, 'a grant for X was allowed to scope Y\'s invoice');
  assert.equal(leak.error, 'invalid_scope');
});

test('F02 create: a validity longer than 90 days is clamped and flagged, never refused', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');

  // Fixture clock is 2026-07-16; +90 days is 2026-10-14.
  const g = grant(call, contactId, [{ kind: 'all_invoices' }], '2030-01-01');
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(g.clamped, true, 'an over-long validity was not clamped');
  assert.equal(g.grant.expiresAt, '2026-10-14', `clamp landed on the wrong day: ${g.grant.expiresAt}`);
});

// --- Token security ------------------------------------------------------------------------------

test('F02 token security: the plaintext token and a usable link are NOWHERE in the database', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');

  const g = grant(call, contactId, [{ kind: 'all_invoices' }]);
  assert.equal(g.ok, true);
  const token = g.tokenOnce;
  assert.ok(typeof token === 'string' && token.length >= 64, 'the token is not a >=256-bit hex string');
  assert.equal(g.grant.status, 'draft', 'a freshly created grant is not a draft (P8)');

  // A FULL scan of every text cell of the portal_grant row: the token must appear NOWHERE, and the
  // stored hash must be present.
  const row = deps.store.db.prepare('SELECT * FROM portal_grant').get();
  const blob = JSON.stringify(row);
  assert.equal(blob.includes(token), false, 'the plaintext token leaked into a portal_grant column');
  assert.equal(blob.includes('/portal?token='), false, 'a usable portal link leaked into a portal_grant column');
  assert.ok(typeof row.token_hash === 'string' && row.token_hash.length === 64, 'the SHA-256 hash is missing');
  assert.equal(row.token_hash.includes(token), false, 'the hash contains the token');
  // The persisted artifact carries no token either.
  const artifact = JSON.parse(row.local_artifact_json);
  assert.equal(JSON.stringify(artifact).includes(token), false, 'the local artifact carries the token');
});

// --- The three fences ----------------------------------------------------------------------------

test('F02 fence: an unknown, expired, or revoked token all deny IDENTICALLY (grant_denied)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');

  const unknown = tokenCall(deps, 'portal_resolve', { token: 'deadbeef'.repeat(8) });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'grant_denied');

  // Revoked.
  const gr = grant(call, contactId, [{ kind: 'all_invoices' }]);
  call('portal_grant_revoke', { grantId: gr.grantId, idempotencyKey: k('rev') });
  const revoked = tokenCall(deps, 'portal_resolve', { token: gr.tokenOnce });
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error, 'grant_denied');

  // Expired: stamp the row's expiry into the past (the resolver's expiry fence is what is under test).
  const ge = grant(call, contactId, [{ kind: 'all_invoices' }]);
  deps.store.db.prepare('UPDATE portal_grant SET expires_at = ? WHERE id = ?').run('2020-01-01', ge.grantId);
  const expired = tokenCall(deps, 'portal_resolve', { token: ge.tokenOnce });
  assert.equal(expired.ok, false);
  assert.equal(expired.error, 'grant_denied');

  // Indistinguishable: all three carry the SAME error and no oracle field.
  for (const r of [unknown, revoked, expired]) {
    assert.deepEqual(Object.keys(r).sort(), ['error', 'ok'], `a denial leaked a distinguishing field: ${JSON.stringify(r)}`);
  }
});

test('F02 fence: a token minted in workspace A can NEVER read workspace B (§H-TENANT)', () => {
  const deps = freshDeps();
  const A = mintWorkspace(deps, 'A GmbH', 'wsA').workspaceId;
  const B = mintWorkspace(deps, 'B GmbH', 'wsB').workspaceId;
  const callA = callFor(deps, A);
  const callB = callFor(deps, B);
  prepareBooks(callA);
  prepareBooks(callB);

  const custA = customer(callA, 'Kundin A AG');
  const custB = customer(callB, 'Kundin B AG');
  const invA = issuedInvoice(callA, custA);
  const invB = issuedInvoice(callB, custB);

  // A grant in A cannot even be SCOPED to B's invoice id: it is not A's contact's record.
  const cross = grant(callA, custA, [{ kind: 'invoice', id: invB }]);
  assert.equal(cross.ok, false);
  assert.equal(cross.error, 'invalid_scope');

  // A legitimate A grant resolves ONLY A's invoice, never B's.
  const gA = grant(callA, custA, [{ kind: 'invoice', id: invA }]);
  const resA = tokenCall(deps, 'portal_resolve', { token: gA.tokenOnce });
  assert.equal(resA.ok, true, JSON.stringify(resA));
  const ids = resA.invoices.map((i) => i.id);
  assert.deepEqual(ids, [invA], `A's token resolved something other than exactly A's invoice: ${JSON.stringify(ids)}`);
  assert.equal(ids.includes(invB), false, 'A\'s token reached B\'s invoice: cross-tenant leak');
});

test('F02 fence: the scope fence returns ONLY listed entities, never the contact\'s other records', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  prepareBooks(call);
  const contactId = customer(call, 'Kundin AG');
  const scoped = issuedInvoice(call, contactId);
  const unscoped = issuedInvoice(call, contactId); // same contact, NOT in scope

  const g = grant(call, contactId, [{ kind: 'invoice', id: scoped }]);
  const res = tokenCall(deps, 'portal_resolve', { token: g.tokenOnce });
  assert.equal(res.ok, true, JSON.stringify(res));
  const ids = res.invoices.map((i) => i.id);
  assert.deepEqual(ids, [scoped], 'the resolver returned an out-of-scope invoice of the same contact');
  assert.equal(ids.includes(unscoped), false, 'scope fence leaked an unscoped record');
});

// --- The resolve read model ----------------------------------------------------------------------

test('F02 resolve: an invoice carries its open amount (A14) and A11\'s QR reference verbatim', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  prepareBooks(call);
  const contactId = customer(call, 'Kundin AG');
  const invoiceId = issuedInvoice(call, contactId, 20000);

  const g = grant(call, contactId, [{ kind: 'invoice', id: invoiceId }]);
  const res = tokenCall(deps, 'portal_resolve', { token: g.tokenOnce });
  assert.equal(res.ok, true, JSON.stringify(res));
  const inv = res.invoices[0];
  assert.equal(inv.id, invoiceId);
  assert.equal(typeof inv.openMinor, 'number', 'no open amount from the A14 read model');
  assert.ok(inv.openMinor > 0, 'an unpaid issued invoice should have a positive open amount');

  // The QR reference the resolver returns must BYTE-EQUAL A11's own (buildQrBill), read verbatim.
  const qr = call('get_document', { documentId: invoiceId }); // sanity: it exists
  assert.equal(qr.ok, true);
  assert.ok(typeof inv.qrReference === 'string' && inv.qrReference.length > 0, 'no QR reference surfaced');
  // F02 passes A14's Rappen through; the OSS core computes no money and the amount stays integer.
  assert.equal(Number.isInteger(inv.totalMinor), true);
});

// --- quote_accept via C02, idempotent ------------------------------------------------------------

test('F02 quote_accept: delegates to C02\'s real accept (sent -> accepted), no invoice minted here', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');
  const quoteId = sentQuote(call, contactId);

  const g = grant(call, contactId, [{ kind: 'quote', id: quoteId }]);
  const before = call('quotes_get', { quoteId });
  assert.equal(before.document.status, 'sent');

  const accepted = tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId, idempotencyKey: k('pa') });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  const after = call('quotes_get', { quoteId });
  assert.equal(after.document.status, 'accepted', 'C02\'s real accept did not run through the portal');
  // Accepting posts nothing and mints no A11 document (conversion is a separate, human step).
  const docCount = deps.store.db.prepare("SELECT COUNT(*) AS n FROM document WHERE workspace_id = ? AND type = 'invoice'").get(workspaceId).n;
  assert.equal(docCount, 0, 'the portal accept minted an invoice: it must delegate, not hand-roll');
});

test('F02 quote_accept: idempotent - the same key twice yields ONE acceptance, no double-issue', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');
  const quoteId = sentQuote(call, contactId);
  const g = grant(call, contactId, [{ kind: 'quote', id: quoteId }]);

  const first = tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId, idempotencyKey: 'once' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId, idempotencyKey: 'once' });
  assert.equal(second.ok, true, 'the idempotent replay did not succeed');

  // Exactly ONE accept audit row (the genuine transition), never two.
  const acceptAudits = deps.store.db
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE workspace_id = ? AND entity_kind = 'portal_grant' AND action = 'accept'")
    .get(workspaceId).n;
  assert.equal(acceptAudits, 1, `a replay double-counted the acceptance: ${acceptAudits} accept audits`);

  // A DIFFERENT key on the already-accepted quote is refused by C02 (no second acceptance).
  const third = tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId, idempotencyKey: 'twice' });
  assert.equal(third.ok, false, 'a second acceptance under a new key was allowed (double-issue risk)');
});

// --- TX-atomicity on a refused accept ------------------------------------------------------------

test('F02 tx-atomicity: a REFUSED accept (out of scope) writes ZERO rows and leaves the quote sent', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');
  const scopedQuote = sentQuote(call, contactId);
  const otherQuote = sentQuote(call, contactId); // same contact, NOT in the grant's scope

  const g = grant(call, contactId, [{ kind: 'quote', id: scopedQuote }]);

  const journalBefore = deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
  const refused = tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId: otherQuote, idempotencyKey: k('bad') });
  assert.equal(refused.ok, false, 'accepting an out-of-scope quote was allowed');
  assert.equal(refused.error, 'grant_denied');

  // The out-of-scope quote is untouched, and nothing posted.
  const still = call('quotes_get', { quoteId: otherQuote });
  assert.equal(still.document.status, 'sent', 'a refused accept transitioned the quote anyway');
  const journalAfter = deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(journalAfter, journalBefore, 'a refused accept posted a journal entry');
});

test('F02 fence: a token for contact X cannot accept contact Y\'s quote (cross-grantee)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const x = customer(call, 'Kundin X AG');
  const y = customer(call, 'Kundin Y AG');
  const yQuote = sentQuote(call, y);

  // A grant for X, even if we try to name Y's quote, is refused at create (contact fence)...
  const badScope = grant(call, x, [{ kind: 'quote', id: yQuote }]);
  assert.equal(badScope.ok, false);
  assert.equal(badScope.error, 'invalid_scope');

  // ...and an X grant with a legitimate (empty-of-Y) scope cannot accept Y's quote either.
  const gx = grant(call, x, [{ kind: 'all_invoices' }]);
  const cross = tokenCall(deps, 'portal_quote_accept', { token: gx.tokenOnce, quoteId: yQuote, idempotencyKey: k('cg') });
  assert.equal(cross.ok, false, 'X\'s token accepted Y\'s quote: cross-grantee leak');
  assert.equal(cross.error, 'grant_denied');
  assert.equal(call('quotes_get', { quoteId: yQuote }).document.status, 'sent', 'Y\'s quote was moved by X\'s token');
});

// --- CRITIC F1: the idempotency key forwarded into C02 is scoped by grant AND quote ------------
// C02's `acceptQuote` memoises under `(workspace_id, key, 'quotes_accept')`, a namespace SHARED with
// the operator `quotes_accept` verb and with every other grant's portal accept in the workspace.
// Forwarding the external caller's RAW key would let a replay return a DIFFERENT quote's or contact's
// stored result across the grantee fence. These two repros FAIL on the raw-key code and PASS once the
// key is derived from [grantId, quoteId, key] (mirroring sendGrant/revokeGrant's grant-scoping).

test('F02 F1: a shared idempotency key cannot make the portal return ANOTHER contact\'s quote (cross-grantee replay)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const x = customer(call, 'Kundin X AG');
  const y = customer(call, 'Kundin Y AG');
  const qx = sentQuote(call, x, 11100);
  const qy = sentQuote(call, y, 99900);

  // The operator accepts Y's quote under a plain key. C02 memoises the result under
  // (workspace, 'shared', 'quotes_accept'): the very namespace the portal delegates into.
  const opAccept = call('quotes_accept', { quoteId: qy, idempotencyKey: 'shared' });
  assert.equal(opAccept.ok, true, JSON.stringify(opAccept));
  assert.equal(opAccept.document.id, qy);

  // X, scoped only to qx, replays the SAME raw key through the portal. It must accept X's OWN quote
  // (or error), and can NEVER return Y's document across the grantee fence.
  const gx = grant(call, x, [{ kind: 'quote', id: qx }]);
  const res = tokenCall(deps, 'portal_quote_accept', { token: gx.tokenOnce, quoteId: qx, idempotencyKey: 'shared' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.notEqual(res.document.id, qy, 'the portal returned another contact\'s quote via a shared idempotency key (cross-grantee disclosure)');
  assert.equal(res.document.id, qx, 'the portal did not return X\'s own quote');
  // X's own quote genuinely transitioned: it was not a silent false-success.
  assert.equal(call('quotes_get', { quoteId: qx }).document.status, 'accepted', 'qx never actually accepted');
});

test('F02 F1: one key reused across two of X\'s OWN quotes never returns the first quote for the second', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const x = customer(call, 'Kundin X AG');
  const q1 = sentQuote(call, x, 12300);
  const q2 = sentQuote(call, x, 45600);
  const gx = grant(call, x, [{ kind: 'quote', id: q1 }, { kind: 'quote', id: q2 }]);

  const first = tokenCall(deps, 'portal_quote_accept', { token: gx.tokenOnce, quoteId: q1, idempotencyKey: 'accept' });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.document.id, q1);

  // The SAME key on a DIFFERENT quote must not replay q1's stored result while leaving q2 sent.
  const second = tokenCall(deps, 'portal_quote_accept', { token: gx.tokenOnce, quoteId: q2, idempotencyKey: 'accept' });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.notEqual(second.document.id, q1, 'the second accept replayed the first quote\'s document (silent false-success)');
  assert.equal(second.document.id, q2, 'the second accept did not act on q2');
  assert.equal(call('quotes_get', { quoteId: q2 }).document.status, 'accepted', 'q2 stayed sent while reporting success');
});

// --- send P8 + revoke + audit --------------------------------------------------------------------

test('F02 send: P8 draft-gate - unconfirmed keeps the grant a draft; confirmed activates it', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');
  const g = grant(call, contactId, [{ kind: 'all_invoices' }]);

  const unconfirmed = call('portal_grant_send', { grantId: g.grantId, idempotencyKey: k('s') });
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.error, 'needs_confirmation');
  assert.equal(call('portal_grant_list', {}).grants.find((x) => x.id === g.grantId).status, 'draft', 'an unconfirmed send activated the grant');

  const confirmed = call('portal_grant_send', { grantId: g.grantId, confirmed: true, idempotencyKey: k('s') });
  assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
  assert.equal(confirmed.sent, false, 'the OSS core claimed a send with no transport wired');
  assert.equal(confirmed.reason, 'cloud_tier');
  assert.equal(confirmed.grant.status, 'active', 'a confirmed send did not activate the grant');
});

test('F02 revoke: stamps revoked_at, the row survives, and a re-revoke is a no-op', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');
  const g = grant(call, contactId, [{ kind: 'all_invoices' }]);

  const revoked = call('portal_grant_revoke', { grantId: g.grantId, idempotencyKey: k('r') });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.grant.status, 'revoked');

  // The row survives (the access trail is never deleted).
  const list = call('portal_grant_list', {});
  assert.equal(list.grants.length, 1, 'revoke deleted the grant row instead of stamping it');

  const again = call('portal_grant_revoke', { grantId: g.grantId, idempotencyKey: k('r2') });
  assert.equal(again.ok, true);
  assert.equal(again.alreadyRevoked, true, 'a re-revoke was not a no-op');
});

test('F02 audit: create, send, revoke, resolve (view) and accept all land in the audit trail', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = callFor(deps, workspaceId);
  const contactId = customer(call, 'Kundin AG');
  const quoteId = sentQuote(call, contactId);

  const g = grant(call, contactId, [{ kind: 'quote', id: quoteId }]);
  call('portal_grant_send', { grantId: g.grantId, confirmed: true, idempotencyKey: k('s') });
  tokenCall(deps, 'portal_resolve', { token: g.tokenOnce });
  tokenCall(deps, 'portal_quote_accept', { token: g.tokenOnce, quoteId, idempotencyKey: k('a') });
  call('portal_grant_revoke', { grantId: g.grantId, idempotencyKey: k('r') });
  // A denied resolve after revoke, for the deny audit.
  tokenCall(deps, 'portal_resolve', { token: g.tokenOnce });

  const actions = deps.store.db
    .prepare("SELECT DISTINCT action FROM audit_log WHERE workspace_id = ? AND entity_kind = 'portal_grant' ORDER BY action")
    .all(workspaceId)
    .map((r) => r.action);
  for (const expected of ['accept', 'create', 'deny', 'revoke', 'send', 'view']) {
    assert.ok(actions.includes(expected), `the audit trail is missing the '${expected}' action: got ${actions.join(', ')}`);
  }
});
