/**
 * F02's money-path ABSENCE, asserted rather than documented (spec §4 "Money correctness": F02
 * performs zero money arithmetic and opens no posting path; open amounts come from the A11/A14 read
 * models, settlement is A14's alone). Three legs:
 *
 *   1. The `portal_grant` table has ZERO money columns, read off the live PRAGMA rather than a list,
 *      so a migration that adds one reddens this file on the day it lands.
 *   2. The portal engine calls no `postEntry` / `recordPayment` and writes no `journal_entry` /
 *      `payment` row directly. Its ONE money-path TOUCH is the READ-ONLY `buildQrBill` (A11's own QR
 *      reference, read verbatim) and its ONE write delegation is C02's `acceptQuote` (which posts
 *      nothing: a quote has a no-op poster). Both are asserted PRESENT, so the probe is non-vacuous.
 *   3. Behaviourally: minting a grant, resolving a token, and accepting a quote through the portal
 *      leave the journal at ZERO entries. F02 never posts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const PORTAL_DIR = fileURLToPath(new URL('../../src/core/portal/', import.meta.url));

test('F02: the portal_grant table carries no money column', () => {
  const store = new SqliteStore();
  const columns = store.db.prepare('PRAGMA table_info(portal_grant)').all().map((c) => c.name);
  assert.ok(columns.length >= 10, 'PRAGMA answered nothing: the probe is broken');
  const money = columns.filter(
    (name) => name.includes('_rappen') || name.includes('_minor') || name.includes('amount'),
  );
  assert.deepEqual(money, [], `the portal_grant table grew money columns: ${money.join(', ')}`);
});

test('F02: the portal engine reaches no posting path (P3)', () => {
  const files = readdirSync(PORTAL_DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 3, `only ${files.length} engine files found: the probe is aimed wrong`);
  // CALLS and raw SQL, not import specifiers: F02 legitimately imports `ledgerPorts` (to wire the
  // audit/period ports onto a token-resolved ctx) and read helpers from `sales`/`debtors`, so a
  // blanket import ban would be wrong. What must never appear is a posting CALL or a direct write to
  // a money table.
  const forbidden = [
    /\bpostEntry\s*\(/,
    /\brecordPayment\s*\(/,
    /INSERT INTO journal_entry\b/,
    /INSERT INTO payment\b/,
    /from 'node:http'/,
    /from 'node:https'/,
    /\bfetch\s*\(/,
  ];
  for (const file of files) {
    const source = readFileSync(`${PORTAL_DIR}${file}`, 'utf8');
    for (const probe of forbidden) {
      assert.equal(probe.test(source), false, `${file} matches ${probe}: the money/posting boundary is crossed`);
    }
  }
  // Non-vacuous both ways: the posting probe MUST find its prey where it legitimately lives, and
  // F02's two allowed money-path touches must really be there.
  const payments = readFileSync(fileURLToPath(new URL('../../src/core/payments/payment.ts', import.meta.url)), 'utf8');
  assert.ok(/\bpostEntry\s*\(/.test(payments), 'the postEntry probe cannot find postEntry even in A14');
  const engine = readFileSync(`${PORTAL_DIR}grants.ts`, 'utf8');
  assert.ok(/\bacceptQuote\s*\(/.test(engine), 'the C02 accept delegation is gone: how does the portal accept a quote?');
  assert.ok(/\bbuildQrBill\s*\(/.test(engine), 'the A11 QR-reference read is gone: the portal must surface A11\'s own reference');
});

test('F02: grant lifecycle + resolve + quote accept post ZERO journal entries', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const journalCount = () =>
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;

  assert.equal(journalCount(), 0, 'a fresh workspace already has journal entries: the probe is broken');

  const contact = call('create_contact', { partyRole: 'customer', name: 'Kundin AG', idempotencyKey: 'k' });
  assert.equal(contact.ok, true);
  const quote = call('quotes_create', {
    contactId: contact.contact.id,
    validUntil: '2027-01-31',
    lines: [{ description: 'Leistung', unitPriceMinor: 20000 }],
    idempotencyKey: 'q',
  });
  assert.equal(quote.ok, true);
  call('quotes_send', { quoteId: quote.document.id, idempotencyKey: 'qs' });

  const grant = call('portal_grant_create', {
    contactId: contact.contact.id,
    scopes: [{ kind: 'quote', id: quote.document.id }, { kind: 'all_invoices' }],
    expiresAt: '2027-01-31',
    idempotencyKey: 'g',
  });
  assert.equal(grant.ok, true, JSON.stringify(grant));
  call('portal_grant_send', { grantId: grant.grantId, confirmed: true, idempotencyKey: 'gs' });

  const resolved = getAction('portal_resolve').run(deps, { token: grant.tokenOnce });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));

  const accepted = getAction('portal_quote_accept').run(deps, {
    token: grant.tokenOnce,
    quoteId: quote.document.id,
    idempotencyKey: 'pa',
  });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));

  // The whole flow: not one posting. Accepting a quote posts nothing (a quote has a no-op poster);
  // revenue is recognised only when A11 later ISSUES the invoice, which the portal never does.
  assert.equal(journalCount(), 0, 'the portal flow posted a journal entry: the P3 boundary is broken');
});
