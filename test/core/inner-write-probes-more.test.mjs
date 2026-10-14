/**
 * PRE-CLAIMED INNER KEYS, the rest of the census (K1, 04.10.2026). The listed sites are in
 * `inner-write-probes.test.mjs`; these are the further composites the exhaustive search found whose
 * inner key a public caller could reproduce: derived from the composite's own key, or from a row the
 * caller can read before the composite runs (an accrual, a provision, a deal, a bank account). Each
 * makes the pre-claim through the PUBLIC verb, then runs the composite, and asserts it never answers
 * ok over the foreign write. Each FAILED on develop 60302c09.
 *
 * Fixtures are synthetic by construction (invented names, the SIX sample IBAN).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { makeContext } from '../../dist/core/context.js';
import { ledgerPorts, postEntry, reverseEntry } from '../../dist/core/ledger/index.js';
import { reverseEntryInternal } from '../../dist/core/ledger/reverseEntry.js';
import { OPENING_KEY_PREFIX } from '../../dist/core/ledger/openingBalances.js';
import { BANK_OPENING_KEY_PREFIX } from '../../dist/core/banking/bankAccounts.js';

const IBAN = 'CH93 0076 2011 6238 5295 7';

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Beispiel GmbH', 'ws');
  const call = (verb, input = {}) => getAction(verb).run(deps, { workspaceId, ...input });
  return { deps, ws: workspaceId, accId, call, db: deps.store.db };
}

const entry = (w, id) => w.db.prepare('SELECT id, source, date, idempotency_key FROM journal_entry WHERE workspace_id = ? AND id = ?').get(w.ws, id);
const squatPost = (w, key, date = '2026-12-31') =>
  w.call('post_entry', { date, source: 'manual', idempotencyKey: key, lines: [{ account: w.accId('6500'), debit: 100 }, { account: w.accId('1000'), credit: 100 }] });

test('K1 accrual_post: a post_entry under `accrual:<id>` is never recorded as the accrual, and the squatter\'s entry is not reversed', () => {
  const w = world();
  const draft = w.call('accrual_create', { kind: 'accrued_expense', periodEnd: '2026-12-31', amountMinor: 180000, contraAccount: '6500', description: 'Strom Dezember', idempotencyKey: 'c-1' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const squat = squatPost(w, `accrual:${draft.accrual.id}`);
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const posted = w.call('accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'p-1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.notEqual(posted.entryId, squat.entryId, 'the accrual was recorded as the squatter\'s CHF 1.00 entry');
  assert.equal(entry(w, posted.entryId).source, 'accrual');
  const reversedSquat = w.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id = ?').get(w.ws, squat.entryId).n;
  assert.equal(reversedSquat, 0, 'the accrual\'s automatic reversal reversed the squatter\'s entry');
});

test('K1 provision_post: a post_entry under `provision:<id>` is never recorded as the provision', () => {
  const w = world();
  const draft = w.call('provision_create', { reason: 'garantie', periodEnd: '2026-12-31', amountMinor: 500000, provisionAccount: '2330', expenseAccount: '6800', description: 'Garantiefälle Geschäftsjahr 2026', idempotencyKey: 'c-1' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const id = draft.provision.id;
  const squat = squatPost(w, `provision:${id}`);
  const posted = w.call('provision_post', { provisionId: id, idempotencyKey: 'p-1' });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.notEqual(posted.entryId, squat.entryId, 'the provision was recorded as the squatter\'s CHF 1.00 entry');
  assert.equal(entry(w, posted.entryId).source, 'provision');
});

test('K1 set_opening_balances: a post_entry under the derived opening key is never the opening entry', () => {
  const w = world();
  const K = 'open-agent-1';
  // The derived key is `${OPENING_KEY_PREFIX}:<year>:<key>` (ledger/openingBalances.ts).
  const squat = squatPost(w, `${OPENING_KEY_PREFIX}:2026:${K}`, '2026-01-01');
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const opened = w.call('set_opening_balances', { asOf: '2026-01-01', lines: [{ account: '1020', debitMinor: 500000 }, { account: '2800', creditMinor: 500000 }], idempotencyKey: K });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.notEqual(opened.entryId, squat.entryId, 'the opening balance was recorded as the squatter\'s CHF 1.00 entry');
  assert.equal(entry(w, opened.entryId).source, 'import');
});

test('K1 set_bank_opening_balance: a post_entry under the derived bank-opening key is never the opening entry', () => {
  const w = world();
  const bank = w.call('create_bank_account', { name: 'Kantonalbank', iban: IBAN, currency: 'CHF', ledgerAccountId: w.accId('1020'), idempotencyKey: 'bank' });
  assert.equal(bank.ok, true, JSON.stringify(bank));
  assert.equal(w.call('create_account', { number: '9100', name: 'Eröffnungsbilanz', type: 'equity', idempotencyKey: 'ob' }).ok, true);
  const K = 'bank-open-agent-1';
  const squat = squatPost(w, `${BANK_OPENING_KEY_PREFIX}:${bank.bankAccountId}:${K}`, '2026-01-01');
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const opened = w.call('set_bank_opening_balance', { bankAccountId: bank.bankAccountId, amountMinor: 1250000, date: '2026-01-01', idempotencyKey: K });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  assert.notEqual(opened.entryId, squat.entryId, 'the bank opening balance was recorded as the squatter\'s CHF 1.00 entry');
  assert.equal(entry(w, opened.entryId).source, 'import');
});

test('K1 deals_to_quote: a quote created under `deal-quote-<id>` for another contact is never linked as the deal\'s quote', () => {
  const w = world();
  const contact = w.call('create_contact', { partyRole: 'customer', name: 'Muster AG', idempotencyKey: 'c1' }).contact.id;
  const other = w.call('create_contact', { partyRole: 'customer', name: 'Andere AG', idempotencyKey: 'c2' }).contact.id;
  const d = w.call('deals_create', { contactId: contact, title: 'Umbau Empfang', valueMinor: 350000, idempotencyKey: 'd-1' });
  assert.equal(d.ok, true, JSON.stringify(d));
  const squat = w.call('quotes_create', { contactId: other, lines: [{ description: 'Fremd', unitPriceMinor: 100 }], idempotencyKey: `deal-quote-${d.dealId}` });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const converted = w.call('deals_to_quote', { dealId: d.dealId, idempotencyKey: 'q-1' });
  assert.equal(converted.ok, true, JSON.stringify(converted));
  assert.notEqual(converted.quoteId, squat.document.id, 'the deal was linked to the squatter\'s quote for another contact');
  assert.equal(w.call('get_document', { documentId: converted.quoteId }).document.contactId, contact);
});

test('K1 vendor_portal_grant: a customer portal_grant_create under `["vendor",K]` is never answered as the vendor grant', () => {
  const w = world();
  const vendor = w.call('create_contact', { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'v' }).contact.id;
  const customer = w.call('create_contact', { partyRole: 'customer', name: 'Kunde AG', idempotencyKey: 'c' }).contact.id;
  const K = 'grant-agent-1';
  const squat = w.call('portal_grant_create', { contactId: customer, scopes: [{ kind: 'all_invoices' }], expiresAt: '2027-01-31', idempotencyKey: JSON.stringify(['vendor', K]) });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const g = w.call('vendor_portal_grant', { contactId: vendor, expiresAt: '2027-01-31', idempotencyKey: K });
  // develop (D157/D161) answers this squat with a refusal rather than a fresh grant: the vendor door's
  // legacy replay finds the customer grant under the shared key and refuses to hand it out. The K1
  // defect was ADOPTING the squatter's grant; either a fresh vendor grant or that refusal closes it.
  if (g.ok !== true) {
    assert.equal(g.error, 'idempotency_key_conflict', JSON.stringify(g));
    return;
  }
  const grantId = g.grant?.id ?? g.grantId;
  const squatId = squat.grant?.id ?? squat.grantId;
  assert.notEqual(grantId, squatId, 'the vendor grant answered with the squatter\'s customer grant');
});

test('K1 reverseEntryInternal (migration rollback): a public reverse_entry under the same key on the same entry is never adopted', () => {
  const w = world();
  const ctx = makeContext(w.deps.store, { workspaceId: w.ws, actor: 'agent', clock: w.deps.clock, ids: w.deps.ids, ...ledgerPorts({ store: w.deps.store, workspaceId: w.ws, ids: w.deps.ids }) });
  const opening = postEntry(ctx, { date: '2026-01-01', source: 'import', idempotencyKey: 'op-1', lines: [{ account: w.accId('1020'), debit: 500000 }, { account: w.accId('2800'), credit: 500000 }] });
  assert.equal(opening.ok, true, JSON.stringify(opening));
  const key = 'migrollback:step_1:K';
  // The squat: the public reverse_entry, same target, same key, dated a year later.
  const squat = reverseEntry(ctx, { entryId: opening.entryId, idempotencyKey: key, date: '2027-01-01' });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const internal = reverseEntryInternal(ctx, { entryId: opening.entryId, idempotencyKey: key, description: 'Datenübernahme rückgängig' }, 'migration_rollback_step_internal');
  assert.equal(internal.ok, false, 'the rollback answered ok over the squatter\'s reversal, dated a year later');
  assert.equal(internal.error, 'already_reversed');
});

test('K1 transition_document {to:accepted} (D162 route): a quotes_accept on another quote under `["<doc>",K]` is never answered as this acceptance', () => {
  const w = world();
  const c = w.call('create_contact', { partyRole: 'customer', name: 'Annahme AG', idempotencyKey: 'c' }).contact.id;
  const quote = (k) => {
    const q = w.call('quotes_create', { contactId: c, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: `q-${k}` });
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.equal(w.call('quotes_send', { quoteId: q.document.id, idempotencyKey: `s-${k}` }).ok, true);
    return q.document.id;
  };
  const target = quote('target');
  const other = quote('other');
  const K = 'accept-1';
  // The squat: the PUBLIC quotes_accept on ANOTHER quote, under the key the route derives for the target.
  const squat = w.call('quotes_accept', { quoteId: other, idempotencyKey: JSON.stringify([target, K]) });
  assert.equal(squat.ok, true, JSON.stringify(squat));
  const accepted = w.call('transition_document', { documentId: target, to: 'accepted', idempotencyKey: K });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  const status = w.db.prepare('SELECT status FROM document WHERE workspace_id = ? AND id = ?').get(w.ws, target).status;
  assert.equal(status, 'accepted', 'the route answered ok with the other quote\'s acceptance while the named quote never moved');
});
