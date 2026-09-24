// A11: the entry an issued invoice points at IS the entry A11 built.
//
// The predecessor of this file asserted "an issued invoice ALWAYS carries a 1100 debit equal to its
// own total", which is a restatement of the OLD guard (one `SUM(base_debit_minor)` on account 1100)
// rather than of the invariant. An independent critic defeated it three ways in minutes, and every
// one of the three satisfies that sentence:
//
//   A. `1100 debit 108100 / 1020 credit 108100`. The 1100 debit matches, so the invoice issues; the
//      books hold NO revenue and NO output VAT, and the MWST-Abrechnung reads a §H-VAT-TRACE that
//      does not exist. The customer is still billed CHF 1081.00 and the return understates output
//      VAT by CHF 81.00 on a real, sendable invoice.
//   B. `1100 debit 108100` AND `1100 credit 108100`. `SUM(base_debit_minor)` ignores credits on the
//      same account, so the guard passes while the posted rows net to CHF 0.00 against a QR-bill
//      that bills CHF 1081.00.
//   C. A squat dated `2019-01-02`. The invoice issues with `issue_date 2026-07-16` while its posting
//      sits in FY2019, past any period lock, because the lock was evaluated when the SQUAT posted.
//
// So the assertions here are written to the INVARIANT instead:
//
//   An issued invoice's `posted_entry_id` names an entry with `source='invoice'`, `ref` = the
//   invoice's own gap-free number, `date` = its own issue date, and a line set whose NET movements
//   are exactly the gross receivable / net revenue / output VAT its own positions produce, with the
//   §H-VAT-TRACE present on the revenue legs. No other entry can occupy that slot, and no caller
//   holding only `post` can put one there.
//
// `assertPostingIsTheInvoicesOwn` below is that sentence in code, and it runs over EVERY issued
// invoice in the database at the end of every test in this file, attack and control alike.
//
// ## Correction to the commit message of c062894 (`fix(a11): compare all four money dimensions`)
//
// That commit's message claims: "Tests cover shape D (right integer, wrong currency), shape D-prime
// (right currency, wrong rate)". With respect to the code c062894 actually changed, that is FALSE,
// and history is immutable, so the correction is recorded here where a reader of these tests will
// find it.
//
// c062894 changed `verifyPostedEntryIsOurs` in `src/core/sales/invoice.ts`: it widened the row
// comparison to carry `currency`, `fx_rate` and the per-line BASE allocation. Shapes D and D-prime
// never reach that function's refusal branch. They squat on `invoice-post-<invoiceId>`, and A11 does
// not post under that key: the key is MINTED at `invoice.ts:249` as
// `invoice-post-<invoiceId>-<ipk>`. The squat therefore never collides, A11 posts its own entry,
// `verifyPostedEntryIsOurs` is called against A11's OWN row set, and it returns null. An independent
// critic instrumented `dist/` and read the verdict out directly: for both shapes,
// `verify trace = [{"verdict":"ok"}]`. They pass, but what they exercise is the MINT (the earlier
// posting-key fix) and the FX posting path, not the identity check.
//
// So for a period the three dimensions c062894 added had NO test that made any of them the deciding
// one. Shapes E, F and G below close that. Each squats on the PREDICTED mint so it genuinely
// collides, and each differs from the invoice's own posting in EXACTLY ONE dimension: currency (E),
// rate (F), base allocation (G). "Exactly one" is not a claim in a comment here: each test issues the
// same invoice in a clean workspace, reads A11's own posted rows back out of SQLite, and asserts that
// dropping the named dimension makes the squat row-for-row identical to it.
//
// The general defect this is remediating is worth naming, because this repo has now shipped it seven
// times on the money path: assertions written to the shape of the FIX rather than to the shape of the
// INVARIANT. A test that only reaches the code path the previous commit created will keep passing
// after the current commit is reverted.

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace, setCreditorProfile } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { createDocument, issueInvoice, buildQrBill, transitionDocument } from '../../dist/core/sales/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';

const AT = '2026-07-16T00:00:00.000Z';

function setup() {
  const clock = fixedClock(AT);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const deps = { store, clock, ids };
  const workspaceId = createWorkspace(deps, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, { workspaceId, actor: 'user_1', clock, ids });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  setCreditorProfile(ctx, {
    creditorName: 'Nomadik GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, address_street, address_house_no, address_zip, address_city, address_country, email, default_currency, payment_terms_days, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', 'Musterstrasse', '5', '3000', 'Bern', 'CH', 'billing@muster.example', 'CHF', 30, ?)`,
    )
    .run(workspaceId, AT);
  return { ctx, store, workspaceId };
}

const account = (store, workspaceId, number) =>
  store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;

const draftInvoice = (ctx, lines = [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }]) =>
  createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency: 'CHF', lines }).document.id;

/** The ESTV daily selling rate for the invoice date (MWSTV Art. 45 Abs. 3). EUR 1 = CHF 0.9412. */
function recordEurRate(ctx) {
  const res = recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-16',
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: 'fx-eur-1',
  });
  assert.equal(res.ok, true, JSON.stringify(res));
}

const draftEurInvoice = (ctx, lines = [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }]) =>
  createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency: 'EUR', lines }).document.id;

/**
 * Net movements per account NUMBER for one entry: debit-positive, credit-negative.
 *
 * `net` is the TRANSACTION-currency movement, which is what the document totals and the QR-bill are
 * denominated in; `baseNet` is the base-CHF movement, which is what the books balance on (§H-FX).
 * For a CHF invoice the two are equal by construction (the allocation is the identity at rate 1);
 * for a EUR invoice they differ, and conflating them is exactly the defect this file now covers.
 */
function netByAccount(store, entryId) {
  const rows = store.db
    .prepare(
      `SELECT a.number AS number,
              SUM(l.debit_minor) - SUM(l.credit_minor) AS net,
              SUM(l.base_debit_minor) - SUM(l.base_credit_minor) AS baseNet,
              COUNT(*) AS rows,
              COUNT(DISTINCT l.currency) AS currencies,
              MIN(l.currency) AS currency,
              COUNT(DISTINCT COALESCE(l.fx_rate, '')) AS rates,
              MIN(COALESCE(l.fx_rate, '')) AS fxRate,
              SUM(CASE WHEN l.tax_code IS NOT NULL THEN 1 ELSE 0 END) AS traced
       FROM journal_line l JOIN account a ON a.id = l.account_id
       WHERE l.entry_id = ? GROUP BY a.number`,
    )
    .all(entryId);
  return new Map(rows.map((r) => [r.number, r]));
}

/**
 * THE INVARIANT. For every issued invoice in the database, the entry it points at must be the entry
 * A11 built from that invoice's own positions: right provenance, right number, right period, right
 * accounts, right VAT trace. Any of the three attack shapes fails at least two of these clauses.
 */
function assertPostingIsTheInvoicesOwn(store, workspaceId) {
  const baseCurrency = store.db.prepare('SELECT base_currency AS c FROM workspace WHERE id = ?').get(workspaceId).c;
  const issued = store.db
    .prepare(
      "SELECT id, number, currency, posted_entry_id, issue_date, subtotal_minor, tax_minor, total_minor FROM document WHERE workspace_id = ? AND type = 'invoice' AND status IN ('issued','sent','paid','overdue')",
    )
    .all(workspaceId);
  for (const doc of issued) {
    const where = `invoice ${doc.number ?? doc.id}`;
    assert.notEqual(doc.posted_entry_id, null, `${where}: an issued invoice must carry a posting`);
    const entry = store.db
      .prepare('SELECT id, date, ref, source, status FROM journal_entry WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, doc.posted_entry_id);
    assert.notEqual(entry, undefined, `${where}: the posted entry must exist in this workspace`);

    // Provenance, number and period: shape C dies here (its entry sits in FY2019).
    assert.equal(entry.source, 'invoice', `${where}: the posting must be sourced 'invoice'`);
    assert.equal(entry.status, 'posted', `${where}: the posting must be posted`);
    assert.equal(entry.ref, doc.number, `${where}: the posting must carry the invoice's own number`);
    assert.equal(entry.date, doc.issue_date, `${where}: the posting must sit in the invoice's own period`);

    // The money. Shapes A and B die here: A books no revenue and no VAT, B nets the receivable to 0.
    const net = netByAccount(store, doc.posted_entry_id);
    const receivable = net.get('1100');
    assert.notEqual(receivable, undefined, `${where}: the posting must move the 1100 receivable`);
    assert.equal(
      receivable.net,
      doc.total_minor,
      `${where}: the NET 1100 debit must equal the gross the QR-bill bills`,
    );
    const revenue = [...net.entries()].filter(([number]) => number.startsWith('3'));
    const revenueNet = revenue.reduce((sum, [, r]) => sum + r.net, 0);
    assert.equal(revenueNet, -doc.subtotal_minor, `${where}: revenue must be credited with the invoice's own net`);
    const vat = net.get('2200');
    if (doc.tax_minor === 0) {
      assert.equal(vat?.net ?? 0, 0, `${where}: a tax-free invoice books no output VAT`);
    } else {
      assert.notEqual(vat, undefined, `${where}: a taxed invoice MUST book the 2200 output VAT liability`);
      assert.equal(vat.net, -doc.tax_minor, `${where}: the 2200 credit must equal the invoice's own tax`);
      // §H-VAT-TRACE: the MWST-Abrechnung reads the stored trace, so the revenue legs must carry it.
      assert.equal(
        revenue.reduce((sum, [, r]) => sum + r.traced, 0) > 0,
        true,
        `${where}: the revenue legs must carry the stored VAT trace the return reads`,
      );
    }
    // No stray accounts: exactly the receivable, the revenue legs, and (when taxed) the VAT leg.
    const allowed = new Set(['1100', '2200', ...revenue.map(([number]) => number)]);
    for (const number of net.keys()) {
      assert.equal(allowed.has(number), true, `${where}: the posting touches a foreign account ${number}`);
    }

    // §H-FX. The currency and the rate are part of the posting's identity, not decoration: an entry
    // carrying the right integers in the WRONG currency is not this invoice's posting. Every row of
    // the entry must agree on both, and a base-currency posting must carry a NULL rate (a rate of 1
    // is not FX, and stamping one would make every CHF row look converted).
    for (const [number, movement] of net) {
      assert.equal(movement.currencies, 1, `${where}: account ${number} mixes currencies within one entry`);
      assert.equal(movement.currency, doc.currency, `${where}: account ${number} is not in the invoice's currency`);
      assert.equal(movement.rates, 1, `${where}: account ${number} mixes fx rates within one entry`);
      if (doc.currency === baseCurrency) {
        assert.equal(movement.fxRate, '', `${where}: a base-currency posting stores no rate`);
        assert.equal(movement.baseNet, movement.net, `${where}: at rate 1 the base movement IS the transaction one`);
      } else {
        assert.notEqual(movement.fxRate, '', `${where}: a foreign-currency posting must stamp its rate`);
      }
    }
    // And base CHF remains the ledger truth: the entry balances in base, whatever it was billed in.
    const baseBalance = [...net.values()].reduce((sum, m) => sum + m.baseNet, 0);
    assert.equal(baseBalance, 0, `${where}: the posting must balance in base currency (§H-FX)`);
  }
  return issued.length;
}

/** The refusal must be TOTAL: no number consumed, no status change, no partial write. */
function assertNothingWasHalfWritten(store, workspaceId, invoiceId) {
  const row = store.db
    .prepare('SELECT status, number, posted_entry_id, issue_date FROM document WHERE id = ?')
    .get(invoiceId);
  assert.equal(row.status, 'draft', 'the document must stay a draft');
  assert.equal(row.number, null, 'no gap-free number may be consumed');
  assert.equal(row.posted_entry_id, null, 'no foreign entry may become the posting');
  assert.equal(row.issue_date, null, 'no issue date may be stamped');
  assert.equal(
    store.db.prepare('SELECT COUNT(*) AS n FROM document_number_seq WHERE workspace_id = ?').get(workspaceId).n,
    0,
    'the number counter must roll back too',
  );
  assert.equal(
    store.db
      .prepare("SELECT COUNT(*) AS n FROM document_status_history WHERE document_id = ? AND to_status = 'issued'")
      .get(invoiceId).n,
    0,
  );
}

// --- The three attack shapes ---------------------------------------------------------------------
//
// Note on what these assert. The obvious assertion is `issue.ok === false`, and it would be another
// assertion written to the shape of a fix rather than to the invariant: it only holds if the chosen
// remediation is "refuse". The invariant is narrower and does not care how the attack is defeated:
// the squatter's entry NEVER becomes the invoice's posting, and whatever the invoice ends up
// pointing at is the entry A11 built from its own positions. With the posting key minted rather than
// derived, the squat stops colliding at all, so the invoice issues normally against its own entry
// and the squatter is left holding an ordinary, unrelated journal entry: that satisfies the
// invariant and is a better outcome than a refusal, which would have let any caller deny service on
// any invoice. `assertSquatterIsNotThePosting` states exactly that, and accepts either outcome.

function assertSquatterIsNotThePosting(store, workspaceId, invoiceId, squatEntryId, issue) {
  const row = store.db
    .prepare('SELECT status, posted_entry_id, total_minor FROM document WHERE id = ?')
    .get(invoiceId);
  assert.notEqual(
    row.posted_entry_id,
    squatEntryId,
    'a foreign entry must never become the invoice posting, whatever else happens',
  );
  if (issue.ok) {
    assert.equal(row.status, 'issued');
    assert.notEqual(row.posted_entry_id, null, 'an issued invoice posts its own entry');
  } else {
    assert.equal(issue.error, 'posting_key_conflict', JSON.stringify(issue));
    assertNothingWasHalfWritten(store, workspaceId, invoiceId);
  }
  assertPostingIsTheInvoicesOwn(store, workspaceId);
}

test('shape A: a squat with the right receivable but no revenue and NO OUTPUT VAT never becomes the posting', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'manual',
    description: 'squatter',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '1020'), credit: 108100 },
    ],
  });
  assert.equal(squat.ok, true, 'the squat is an ordinary journal entry and posts');

  const issue = issueInvoice(ctx, { invoiceId });
  assertSquatterIsNotThePosting(store, workspaceId, invoiceId, squat.entryId, issue);

  // The specific harm shape A caused: the books held no revenue and no output VAT while the customer
  // was billed CHF 1081.00, so the MWST-Abrechnung understated output VAT by CHF 81.00.
  const postedEntryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const net = netByAccount(store, postedEntryId);
  assert.equal(net.get('3200').net, -100000, 'the revenue the invoice bills IS booked');
  assert.equal(net.get('2200').net, -8100, 'the output VAT liability IS raised');
  assert.equal(net.has('1020'), false, 'the squatter counter-account is nowhere in the posting');
});

test('shape B: a net-zero receivable (debit AND credit on 1100) never becomes the posting', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'manual',
    description: 'net-zero squatter',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '1100'), credit: 108100 },
    ],
  });
  assert.equal(squat.ok, true);

  const issue = issueInvoice(ctx, { invoiceId });
  assertSquatterIsNotThePosting(store, workspaceId, invoiceId, squat.entryId, issue);

  // The specific harm: the QR-bill billed CHF 1081.00 against posted rows netting to CHF 0.00.
  const postedEntryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  assert.equal(netByAccount(store, postedEntryId).get('1100').net, 108100, 'the NET receivable, not the gross debit');
  const qr = buildQrBill(ctx, invoiceId);
  assert.equal(qr.qr.swissQrPayload.split('\n')[18].trim(), '1081.00', 'and it is what the QR-bill bills');
});

test('shape C: a squat dated into a prior financial year never becomes the posting', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const squat = postEntry(ctx, {
    date: '2019-01-02',
    source: 'manual',
    description: 'FY2019 squatter',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '3200'), credit: 108100 },
    ],
  });
  assert.equal(squat.ok, true);

  const issue = issueInvoice(ctx, { invoiceId });
  assertSquatterIsNotThePosting(store, workspaceId, invoiceId, squat.entryId, issue);

  // The specific harm: an invoice issued 2026-07-16 whose posting sat in FY2019, past any lock.
  const postedEntryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  assert.equal(
    store.db.prepare('SELECT date FROM journal_entry WHERE id = ?').get(postedEntryId).date,
    '2026-07-16',
    'the posting sits in the invoice own period, so its period lock is the one that was evaluated',
  );
});

test('shape A-prime: a squat that copies the source, the ref and the date exactly never becomes the posting', () => {
  // The nastiest variant: everything an outside observer can see about A11's entry is reproduced,
  // including `source: 'invoice'`, the number A10 is about to mint, and the entry date. Only the
  // MONEY differs (revenue is booked to 1020 and no VAT liability is raised).
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '1020'), credit: 108100 },
    ],
  });
  assert.equal(squat.ok, true);

  const issue = issueInvoice(ctx, { invoiceId });
  assertSquatterIsNotThePosting(store, workspaceId, invoiceId, squat.entryId, issue);
});

// --- Shapes D and D-prime: FX squats on the DERIVABLE key (mint coverage, not identity coverage) ---
//
// READ THIS BEFORE TRUSTING THE NAMES. These two tests are labelled as attacks on the identity check
// and they are not. They squat on `invoice-post-<invoiceId>`, and A11 mints
// `invoice-post-<invoiceId>-<ipk>` (invoice.ts:249), so the two keys never meet. The squat posts as
// an ordinary unrelated journal entry, the invoice issues against its own entry, and
// `verifyPostedEntryIsOurs` runs against A11's own rows and returns null. Nothing here reaches the
// refusal branch, and no currency, rate or base comparison decides anything. Shapes E, F and G below
// are the tests that do that.
//
// What these two DO cover, and why they are worth keeping:
//
//   - the MINT holds under an FX-shaped squat: an entry sitting on the derivable key, dressed with
//     `source: 'invoice'`, the ref A10 is about to mint and the right date, still never becomes the
//     posting (this is the earlier posting-key fix, not the four-dimension one);
//   - the honest EUR posting path end to end, read back from SQLite: EUR 1081.00 held at CHF 1017.44
//     with `fx_rate` stamped, so the conversion stays re-derivable for an auditor (MWSTV Art. 45).
//
// The harm they describe is real and is what motivated widening the identity check. It is simply not
// what they measure. A EUR 1081.00 invoice posts `1100 debit 108100 EUR` at a base of CHF 1017.44; a
// squatter posting `1100 debit 108100 CHF` matches the integer and the account exactly and books
// CHF 1081.00 against a receivable really worth CHF 1017.44, with no rate stored and nothing in the
// books recording that the debt is in euros. Shape E is that attack aimed at a key that collides.

test('shape D: a CHF squat on the DERIVABLE key never becomes a EUR invoice posting', () => {
  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx);

  // The squat: the same account, the same integer, the same date, labelled `source: 'invoice'` with
  // the number A10 is about to mint. Only the CURRENCY is wrong, and it is wrong silently: a CHF
  // entry stores no rate at all, so nothing on the row says a conversion was skipped.
  //
  // The key is the DERIVABLE one, so this squat does not collide with A11's minted key and the
  // currency comparison inside `verifyPostedEntryIsOurs` never runs on it. Shape E is the same
  // deception aimed at the key A11 actually posts under.
  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '3200'), credit: 100000, taxCode: 'UST81' },
      { account: account(store, workspaceId, '2200'), credit: 8100 },
    ],
  });
  assert.equal(squat.ok, true, `the squat posts as an ordinary CHF entry: ${JSON.stringify(squat)}`);
  const squatRow = store.db
    .prepare('SELECT currency, fx_rate, debit_minor AS d, base_debit_minor AS b FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(squat.entryId, account(store, workspaceId, '1100'));
  assert.deepEqual(squatRow, { currency: 'CHF', fx_rate: null, d: 108100, b: 108100 }, 'the squat books CHF 1081.00');

  const issue = issueInvoice(ctx, { invoiceId });
  assertSquatterIsNotThePosting(store, workspaceId, invoiceId, squat.entryId, issue);

  // The specific harm shape D would cause: the books must hold the CONVERTED receivable, not the
  // EUR integer read as francs. EUR 1081.00 at 0.9412 is CHF 1017.44, not CHF 1081.00.
  const postedEntryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const posting = store.db
    .prepare('SELECT currency, fx_rate, debit_minor AS d, base_debit_minor AS b FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(postedEntryId, account(store, workspaceId, '1100'));
  assert.deepEqual(
    posting,
    { currency: 'EUR', fx_rate: '0.9412', d: 108100, b: 101744 },
    'the receivable is EUR 1081.00 held at CHF 1017.44, with the rate stored so it stays re-derivable',
  );
});

test('shape D-prime: a EUR squat at the WRONG RATE on the DERIVABLE key never becomes the posting', () => {
  // The currency is right and the RATE is wrong (parity instead of 0.9412), which overstates the CHF
  // receivable by 63.56 while every integer in the transaction currency matches the invoice exactly.
  //
  // Same caveat as shape D: the key is the derivable one, so this never collides and the rate
  // comparison in `verifyPostedEntryIsOurs` is not what defeats it. What this covers is the mint
  // holding under a same-currency squat, and the invoice being priced at ITS OWN recorded rate rather
  // than at whatever rate happened to be lying around under a neighbouring key. Shape F is the
  // wrong-rate attack aimed at a key that collides.
  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx);

  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: `invoice-post-${invoiceId}`,
    currency: 'EUR',
    fxRate: '1',
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '3200'), credit: 100000, taxCode: 'UST81' },
      { account: account(store, workspaceId, '2200'), credit: 8100 },
    ],
  });
  // Whether A02 accepts a rate of 1 on a foreign posting is A02's call; the invariant below holds
  // either way, and is what this test is really about.
  const issue = issueInvoice(ctx, { invoiceId });
  assertSquatterIsNotThePosting(store, workspaceId, invoiceId, squat.ok ? squat.entryId : null, issue);

  const postedEntryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const posting = store.db
    .prepare('SELECT fx_rate, base_debit_minor AS b FROM journal_line WHERE entry_id = ? AND account_id = ?')
    .get(postedEntryId, account(store, workspaceId, '1100'));
  assert.deepEqual(posting, { fx_rate: '0.9412', b: 101744 }, 'the invoice is priced at ITS rate, not the squatter’s');
});

// --- Shapes E, F and G: squats that actually REACH the identity check ------------------------------
//
// The three dimensions c062894 added to the row multiset are `currency`, `fx_rate` and the per-line
// BASE allocation. To make any of them the deciding fact, a squat has to satisfy two conditions at
// once, and no shipped test satisfied either until now:
//
//   1. It has to COLLIDE, which means squatting the MINTED key `invoice-post-<id>-<ipk>`, not the
//      derivable `invoice-post-<id>`. Under the deterministic test id generator the mint is
//      predictable, which is the adversary's best case in production (a leaked or replayed key).
//   2. It has to be right on EVERY other dimension, so that the named one is the only thing left that
//      can refuse it. A squat that also gets the account or the integer wrong is discriminated before
//      currency, rate or base is ever compared, and proves nothing about them.
//
// Condition 2 is checked, not asserted: every test below issues the same invoice a second time in a
// clean workspace, reads A11's own posted rows back out of SQLite, and shows that DROPPING the named
// dimension makes the squat row-for-row identical to that reference. That is the same property a
// mutation check demonstrates (delete the dimension from the key and the test goes green on a squat
// it should refuse), expressed in the test itself so it cannot silently rot.
//
// All three go green on arrival. That is the point: they are the regression protection a shipped fix
// did not have, not new behaviour.

/**
 * The dimensions of one posted row, as the identity check compares them.
 *
 * `rate` normalises a NULL `fx_rate` to `''`, which is exactly what `verifyPostedEntryIsOurs` does
 * when it builds its multiset key, so the two views of a row cannot drift apart.
 */
const ROW_DIMENSIONS = ['account', 'd', 'c', 'bd', 'bc', 'currency', 'rate'];

function entryRows(store, entryId) {
  return store.db
    .prepare(
      `SELECT a.number AS account, l.debit_minor AS d, l.credit_minor AS c,
              l.base_debit_minor AS bd, l.base_credit_minor AS bc,
              l.currency AS currency, COALESCE(l.fx_rate, '') AS rate
         FROM journal_line l JOIN account a ON a.id = l.account_id
        WHERE l.entry_id = ? ORDER BY l.rowid`,
    )
    .all(entryId);
}

/** The rows as an order-independent multiset, optionally with some dimensions dropped. */
function rowMultiset(rows, drop = []) {
  const keys = ROW_DIMENSIONS.filter((k) => !drop.includes(k));
  const tally = new Map();
  for (const row of rows) {
    const key = keys.map((k) => row[k]).join('|');
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  return tally;
}

const sameRows = (a, b) => {
  if (a.size !== b.size) return false;
  for (const [key, count] of a) if (b.get(key) !== count) return false;
  return true;
};

/**
 * Issue the same invoice in a CLEAN workspace with no squatter, and return the rows A11 posts for it,
 * read out of SQLite. This is the reference every shape below is measured against: the outward claim
 * is compared to the posted ledger rows, never to a fixture.
 */
function referencePosting(lines) {
  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx, lines);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, `the reference invoice must issue cleanly: ${JSON.stringify(issue)}`);
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 1);
  const entryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  return entryRows(store, entryId);
}

/**
 * The squat differs from the invoice's own posting SOMEWHERE, and drop `dimension` and it stops
 * differing at all. Together those two say: this dimension, and nothing else, is what can refuse it.
 */
function assertDiffersInExactlyOneDimension(squatRows, refRows, dimension, label) {
  assert.equal(
    sameRows(rowMultiset(squatRows), rowMultiset(refRows)),
    false,
    `${label}: the squat must differ from the invoice's own posting somewhere`,
  );
  assert.equal(
    sameRows(rowMultiset(squatRows, dimension), rowMultiset(refRows, dimension)),
    true,
    `${label}: drop ${dimension.join('+')} and the squat is row-for-row the invoice's own posting, so nothing else can be what refuses it`,
  );
}

/**
 * The key A11 is ABOUT to mint. `ctx.ids.next('ipk')` burns one value from the same generator to
 * learn the counter, so the next one A11 draws is one step on. No secrecy assumption: this is the
 * adversary holding a leaked or replayed key.
 */
function predictMintedPostingKey(ctx, invoiceId) {
  const probe = ctx.ids.next('ipk');
  return `invoice-post-${invoiceId}-${probe.replace(/(\d+)$/, (n) => String(Number(n) + 1))}`;
}

/**
 * The full refusal invariant, read back out of SQLite rather than off the return value: the rejection
 * is `posting_key_conflict` and names the failing dimension, the document is still a draft with no
 * number, no `posted_entry_id` and no issue date, the number counter never advanced, no issued
 * invoice exists at all, and the squatter's own rows are byte-for-byte what they were.
 */
function assertTotalRefusal(store, workspaceId, invoiceId, issue, squatEntryId, rowsBefore) {
  assert.equal(issue.ok, false, `the squat must be refused, not honoured: ${JSON.stringify(issue)}`);
  assert.equal(issue.error, 'posting_key_conflict', JSON.stringify(issue));
  assertNothingWasHalfWritten(store, workspaceId, invoiceId);
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 0, 'no invoice may be issued at all');
  assert.deepEqual(entryRows(store, squatEntryId), rowsBefore, "the squatter's rows are untouched");
  return issue.mismatch;
}

test('shape E: CURRENCY alone refuses a squat on the minted key', () => {
  // Right accounts, right transaction integers, right base integers, right rate: only the CURRENCY
  // of the rows differs. A squatter who knows the francs and the rate but books the debt in the wrong
  // currency leaves the books stating that the customer owes USD 1081.00 when they owe EUR 1081.00.
  // The CHF is correct today and wrong from the next revaluation onward, because every later
  // settlement and revaluation prices the wrong pair.
  const refRows = referencePosting();

  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx);
  const mintedKey = predictMintedPostingKey(ctx, invoiceId);

  // USD at the SAME rate as the invoice, so `allocateBase` produces the identical base split: the
  // rate is what drives the allocation, and the currency code is the only thing left that differs.
  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: mintedKey,
    currency: 'USD',
    fxRate: '0.9412',
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '3200'), credit: 100000, taxCode: 'UST81' },
      { account: account(store, workspaceId, '2200'), credit: 8100 },
    ],
  });
  assert.equal(squat.ok, true, `the squat posts as an ordinary USD entry: ${JSON.stringify(squat)}`);

  const rowsBefore = entryRows(store, squat.entryId);
  assertDiffersInExactlyOneDimension(rowsBefore, refRows, ['currency'], 'shape E');

  const issue = issueInvoice(ctx, { invoiceId });
  const mismatch = assertTotalRefusal(store, workspaceId, invoiceId, issue, squat.entryId, rowsBefore);
  assert.equal(mismatch.endsWith('|EUR|0.9412:missing'), true, `the currency is what is missing: ${mismatch}`);
  assert.equal(issue.expectedCurrency, 'EUR', JSON.stringify(issue));
});

test('shape F: the RATE alone refuses a squat on the minted key', () => {
  // Right accounts, right transaction integers, right currency, and (this is the sharp part) the same
  // base integers to the Rappen: 0.941205 and 0.9412 both convert this invoice to CHF 1017.44. Only
  // the STAMPED rate differs.
  //
  // That is not cosmetic. `fx_rate` is what makes the conversion re-derivable, and MWSTV Art. 45
  // Abs. 3 is satisfied by a stated rate an auditor can reproduce, not by a franc figure that happens
  // to be right. A row carrying a rate the books were not made with is a false audit trail even when
  // every amount on it agrees.
  const refRows = referencePosting();

  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx);
  const mintedKey = predictMintedPostingKey(ctx, invoiceId);

  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: mintedKey,
    currency: 'EUR',
    fxRate: '0.941205',
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '3200'), credit: 100000, taxCode: 'UST81' },
      { account: account(store, workspaceId, '2200'), credit: 8100 },
    ],
  });
  assert.equal(squat.ok, true, `the squat posts as an ordinary EUR entry: ${JSON.stringify(squat)}`);

  const rowsBefore = entryRows(store, squat.entryId);
  assertDiffersInExactlyOneDimension(rowsBefore, refRows, ['rate'], 'shape F');
  // Said out loud, because it is the whole reason this test isolates the rate: the francs AGREE.
  assert.equal(
    rowsBefore.every((row) => row.currency === 'EUR' && row.rate === '0.941205'),
    true,
    JSON.stringify(rowsBefore),
  );
  assert.deepEqual(
    rowsBefore.map((row) => [row.account, row.d, row.c, row.bd, row.bc]),
    refRows.map((row) => [row.account, row.d, row.c, row.bd, row.bc]),
    'every amount on the squat, transaction and base alike, equals the invoice own posting',
  );

  const issue = issueInvoice(ctx, { invoiceId });
  const mismatch = assertTotalRefusal(store, workspaceId, invoiceId, issue, squat.entryId, rowsBefore);
  assert.equal(mismatch.endsWith('|EUR|0.9412:missing'), true, `the stamped rate is what is missing: ${mismatch}`);
  assert.equal(issue.expectedFxRate, '0.9412', JSON.stringify(issue));
});

test('shape G: the BASE ALLOCATION alone refuses a squat on the minted key', () => {
  // The one that proves `expectedBaseAmounts` is load-bearing rather than decorative.
  //
  // §H-FX converts ONCE per side on the side total and allocates the result back over the lines by
  // largest remainder, ties to the lower line index. So the per-line base is NOT the line's own amount
  // times the rate, and when two lines tie on the remainder, WHICH ONE gets the leftover Rappen is
  // decided by their ORDER in the entry.
  //
  // EUR 29.00 + EUR 63.00 at 8.1% is exactly such an invoice. The credit side is
  // [2900, 235, 6300, 510] against a converted total of CHF 93.60; the 2900 and the 6300 lines tie at
  // remainder 4095 and there is one Rappen to hand out, so A11's order gives it to the 2900 line
  // (base 2730 / 5929). A squat listing the two positions the other way round produces the identical
  // rows on every other dimension (same accounts, same EUR integers, same currency, same 0.9412) and
  // hands that Rappen to the 6300 line instead (base 2729 / 5930).
  //
  // Nothing outside the base columns can tell those two entries apart. An identity check comparing
  // only account, transaction amount, currency and rate accepts the squat, and the books then hold a
  // revenue split that the invoice's own positions never produced: the reversal A02 would post on
  // cancel mirrors line for line and would no longer mirror, and per-line base reporting is off by a
  // Rappen on two lines in opposite directions, which nets to zero and so is invisible in every total.
  const lines = [
    { description: 'Beratung', unitPriceMinor: 2900, taxCode: 'UST81' },
    { description: 'Material', unitPriceMinor: 6300, taxCode: 'UST81' },
  ];
  const refRows = referencePosting(lines);

  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx, lines);
  const mintedKey = predictMintedPostingKey(ctx, invoiceId);

  // The same six lines A11 builds, with the two POSITIONS swapped. Nothing else moves.
  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: mintedKey,
    currency: 'EUR',
    fxRate: '0.9412',
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 6810 },
      { account: account(store, workspaceId, '3200'), credit: 6300, taxCode: 'UST81' },
      { account: account(store, workspaceId, '2200'), credit: 510 },
      { account: account(store, workspaceId, '1100'), debit: 3135 },
      { account: account(store, workspaceId, '3200'), credit: 2900, taxCode: 'UST81' },
      { account: account(store, workspaceId, '2200'), credit: 235 },
    ],
  });
  assert.equal(squat.ok, true, `the squat posts as an ordinary EUR entry: ${JSON.stringify(squat)}`);

  const rowsBefore = entryRows(store, squat.entryId);
  assertDiffersInExactlyOneDimension(rowsBefore, refRows, ['bd', 'bc'], 'shape G');
  // The Rappen, named: read out of SQLite on both sides rather than asserted from a fixture.
  const revenueBase = (rows, credit) =>
    rows.find((row) => row.account === '3200' && row.c === credit).bc;
  assert.deepEqual(
    [revenueBase(refRows, 2900), revenueBase(refRows, 6300)],
    [2730, 5929],
    "the invoice's own allocation gives the leftover Rappen to the first tied line",
  );
  assert.deepEqual(
    [revenueBase(rowsBefore, 2900), revenueBase(rowsBefore, 6300)],
    [2729, 5930],
    'the squat, listed the other way round, gives it to the other one',
  );
  // And the difference is invisible in every total, which is exactly why a per-row check is needed.
  assert.equal(
    rowsBefore.reduce((sum, row) => sum + row.bc, 0),
    refRows.reduce((sum, row) => sum + row.bc, 0),
    'the two entries carry the SAME converted credit total: only its allocation differs',
  );

  const issue = issueInvoice(ctx, { invoiceId });
  const mismatch = assertTotalRefusal(store, workspaceId, invoiceId, issue, squat.entryId, rowsBefore);
  assert.equal(
    mismatch.endsWith('|0|2900|0|2730|EUR|0.9412:missing'),
    true,
    `the invoice's own base allocation is what is missing: ${mismatch}`,
  );
});

// --- Parity disclosure: a rate of 1 on a foreign currency is still a conversion --------------------
//
// The contradiction this replaces: a PEGGED foreign currency (a EUR rate recorded as exactly 1) used
// to post `currency='EUR'` with `fx_rate=NULL`, because `postEntry` stored NULL whenever the rate was
// 1 REGARDLESS of currency, and A11 predicted the same NULL. The engine was self-consistent, so the
// invoice issued, while `assertPostingIsTheInvoicesOwn` above asserts the opposite ("a
// foreign-currency posting must stamp its rate"). The suite was green only because no test recorded
// a rate of 1.
//
// It is settled, and the reasoning lives in docs/specs/03-fx-foundation.md section 13 with the fetched
// sources. In short: MWSTV Art. 45 (SR 641.201) is SILENT on the rate-of-1 case, but Abs. 5 binds the
// taxable person to ONE chosen conversion procedure for a whole Steuerperiode, and MWSTG Art. 70
// Abs. 1 routes VAT bookkeeping to the handelsrechtliche Grundsätze of OR Art. 957a, whose Abs. 2
// Ziff. 5 demands `Nachprüfbarkeit`. A row reading `EUR` with a NULL rate is indistinguishable from a
// franc row, so neither the Abs. 5 consistency nor the ESTV Prüfspur (MWST-Info 16 Ziff. 1.5) can be
// walked back through it. The deciding predicate is therefore "is this line's currency the workspace
// base currency?", never "is the rate 1?": a base-currency line carries no rate because no conversion
// happened, a foreign-currency line carries its rate because one did, and a rate that happened to be
// 1 is a fact about that day's market, not a licence to erase the record of it.
//
// This is written to the INVARIANT ("a foreign-currency row states the basis it was converted on"),
// not to the shape of the fix. It reads the POSTED ROWS back out of SQLite and would survive any
// remediation that makes the disclosure true, including one that never touches `RATE_ONE`.
test('a pegged EUR rate of exactly 1 still stamps its rate on every posted row', () => {
  const { ctx, store, workspaceId } = setup();
  const pegged = recordExchangeRate(ctx, {
    baseCurrency: 'EUR',
    rate: '1',
    asOf: '2026-07-16',
    source: 'manual',
    method: 'daily',
    provenance: 'a peg, recorded as the rate it is',
    idempotencyKey: 'fx-eur-peg',
  });
  assert.equal(pegged.ok, true, JSON.stringify(pegged));

  const invoiceId = draftEurInvoice(ctx);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));

  const entryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const rows = entryRows(store, entryId);
  assert.equal(rows.length > 0, true, 'the invoice posted rows at all');
  assert.equal(
    rows.every((row) => row.currency === 'EUR'),
    true,
    'the rows are stamped EUR, so the books know the debt is in euros',
  );
  // The disclosure itself. Not "the string is 1.000000000000": that would describe the fix. The
  // property is that the row STATES a basis, and that the basis it states is the one that was applied.
  assert.equal(
    rows.every((row) => row.rate !== ''),
    true,
    `a foreign-currency posting must stamp its rate, even a rate of 1: ${JSON.stringify(rows)}`,
  );
  for (const row of rows) {
    assert.equal(
      Math.round(row.d * Number(row.rate)),
      row.bd,
      `the stated rate must re-derive the stored base debit on ${row.account}: ${JSON.stringify(row)}`,
    );
    assert.equal(
      Math.round(row.c * Number(row.rate)),
      row.bc,
      `the stated rate must re-derive the stored base credit on ${row.account}: ${JSON.stringify(row)}`,
    );
  }
  // And the arithmetic is untouched: at parity the books hold exactly what was billed.
  const net = netByAccount(store, entryId);
  assert.equal(net.get('1100').net, 108100, 'the transaction receivable is the EUR gross');
  assert.equal(net.get('1100').baseNet, 108100, 'at parity the base receivable is the same integer');
  assertPostingIsTheInvoicesOwn(store, workspaceId);
});

// The other half of the same predicate, and the reason it is stated as "is this the base currency?"
// rather than "did anything convert?": an ordinary CHF entry must NOT start looking converted.
test('a CHF posting stores no rate and reports none, at parity or otherwise', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));

  const entryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const rows = entryRows(store, entryId);
  assert.equal(rows.length > 0, true, 'the invoice posted rows at all');
  assert.equal(
    rows.every((row) => row.currency === 'CHF' && row.rate === ''),
    true,
    `a base-currency posting states no conversion basis because none was applied: ${JSON.stringify(rows)}`,
  );
  // Nothing is asserted about `issue`'s own payload here on purpose: `transitionDocument` does not
  // surface the poster's FX summary, so `'currency' in issue` is false for a EUR invoice too and
  // would be an assertion that cannot fail. The payload that CAN fail is `postEntry`'s own, and the
  // discriminating half of it lives in test/ledger/post-entry-fx.test.mjs, which reads it for EUR.
  const direct = postEntry(ctx, {
    date: '2026-07-16',
    source: 'manual',
    description: 'an ordinary franc entry',
    idempotencyKey: 'chf-plain-1',
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 5000 },
      { account: account(store, workspaceId, '1020'), credit: 5000 },
    ],
  });
  assert.equal(direct.ok, true, JSON.stringify(direct));
  assert.equal('fxRate' in direct, false, `postEntry reports no rate for a CHF entry: ${JSON.stringify(direct)}`);
  assert.equal(
    entryRows(store, direct.entryId).every((row) => row.currency === 'CHF' && row.rate === ''),
    true,
    'an ordinary CHF entry stores a NULL rate',
  );
});

test('control: a EUR invoice issues normally and satisfies the invariant end to end', () => {
  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 1);

  const entryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const net = netByAccount(store, entryId);
  // Billed in EUR, held in CHF, and the base side balances exactly (the allocation is per SIDE).
  assert.equal(net.get('1100').net, 108100, 'the transaction receivable is the EUR gross');
  assert.equal(net.get('1100').baseNet, 101744, 'the books hold the converted CHF');
  assert.equal(net.get('3200').net, -100000);
  assert.equal(net.get('2200').net, -8100);
  assert.equal(net.get('3200').baseNet + net.get('2200').baseNet, -101744, 'the credit side converts to the same total');
});

test('control: a mixed-rate EUR invoice satisfies the invariant, allocation and all', () => {
  // Three positions at three VAT rates: the credit side has four lines to allocate the converted
  // total across, which is where largest-remainder actually does work.
  const { ctx, store, workspaceId } = setup();
  recordEurRate(ctx);
  const invoiceId = draftEurInvoice(ctx, [
    { description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'Übernachtung', unitPriceMinor: 50000, taxCode: 'UST38' },
    { description: 'Buch', unitPriceMinor: 2000, taxCode: 'UST26' },
  ]);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 1);
});

// --- The durable half: the key is no longer derivable --------------------------------------------

test('the posting key is MINTED, not derived: `invoice-post-<id>` names no invoice posting', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));

  const entry = store.db
    .prepare('SELECT idempotency_key FROM journal_entry WHERE id = ?')
    .get(issue.document.postedEntryId ?? store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p);
  assert.notEqual(
    entry.idempotency_key,
    `invoice-post-${invoiceId}`,
    'the key an outside caller can compute must NOT be the key the posting occupies',
  );
  assert.equal(
    entry.idempotency_key.startsWith(`invoice-post-${invoiceId}-`),
    true,
    `the key stays greppable but carries an unguessable mint: ${entry.idempotency_key}`,
  );
  assertPostingIsTheInvoicesOwn(store, workspaceId);
});

test('the derivable key is now inert: occupying it after the fact touches nothing', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  assert.equal(issueInvoice(ctx, { invoiceId }).ok, true);
  const postedEntryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;

  const late = postEntry(ctx, {
    date: '2026-07-16',
    source: 'manual',
    description: 'late squatter',
    idempotencyKey: `invoice-post-${invoiceId}`,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 500000 },
      { account: account(store, workspaceId, '1020'), credit: 500000 },
    ],
  });
  assert.equal(late.ok, true, 'it is still an ordinary journal entry');
  assert.notEqual(late.entryId, postedEntryId, 'and it is a DIFFERENT entry from the invoice posting');
  assert.equal(
    store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p,
    postedEntryId,
    'the invoice still points at its own posting',
  );
  assertPostingIsTheInvoicesOwn(store, workspaceId);
});

test('even a PREDICTED mint is refused: the identity check does not rest on unguessability', () => {
  // Under the deterministic test id generator the mint is predictable, which is exactly the
  // adversary's best case (a leaked or replayed key in production). The occupied-key refusal and the
  // line-set identity check must both hold without any secrecy assumption.
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);

  // Mint one key from the SAME generator to learn the counter, then aim one step ahead of it.
  const probe = ctx.ids.next('ipk');
  const guessed = `invoice-post-${invoiceId}-${probe.replace(/(\d+)$/, (n) => String(Number(n) + 1))}`;
  const squat = postEntry(ctx, {
    date: '2026-07-16',
    source: 'invoice',
    ref: 'R-2026-0001',
    description: 'Rechnung R-2026-0001',
    idempotencyKey: guessed,
    lines: [
      { account: account(store, workspaceId, '1100'), debit: 108100 },
      { account: account(store, workspaceId, '1020'), credit: 108100 },
    ],
  });
  assert.equal(squat.ok, true);

  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, false, `a predicted mint must be refused, not honoured: ${JSON.stringify(issue)}`);
  assert.equal(issue.error, 'posting_key_conflict');
  assertNothingWasHalfWritten(store, workspaceId, invoiceId);
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 0);
});

// --- The control: the honest path is untouched ---------------------------------------------------

test('control: the honest issue path posts gross/net/VAT and satisfies the invariant', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));
  assert.equal(issue.document.number, 'R-2026-0001');
  assert.equal(issue.document.totalMinor, 108100);

  const entryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const net = netByAccount(store, entryId);
  assert.equal(net.get('1100').net, 108100);
  assert.equal(net.get('3200').net, -100000);
  assert.equal(net.get('2200').net, -8100);
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 1);

  // And the QR-bill bills exactly the receivable the books carry.
  const qr = buildQrBill(ctx, invoiceId);
  assert.equal(qr.ok, true, JSON.stringify(qr));
  assert.equal(qr.qr.swissQrPayload.split('\n')[18].trim(), '1081.00');
});

test('control: a mixed-rate invoice still satisfies the invariant', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx, [
    { description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'Übernachtung', unitPriceMinor: 50000, taxCode: 'UST38' },
    { description: 'Buch', unitPriceMinor: 2000, taxCode: 'UST26' },
  ]);
  const issue = issueInvoice(ctx, { invoiceId });
  assert.equal(issue.ok, true, JSON.stringify(issue));
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 1);
});

test('control: issuing twice is still idempotent through A10, not through the posting key', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  const first = issueInvoice(ctx, { invoiceId, idempotencyKey: 'k1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = issueInvoice(ctx, { invoiceId, idempotencyKey: 'k1' });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.document.number, first.document.number, 'the replay returns the original document');
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE source = 'invoice'").get().n,
    1,
    'a replayed issue must not double-post',
  );
  assert.equal(assertPostingIsTheInvoicesOwn(store, workspaceId), 1);
});

// --- The audit: the OTHER derivable key in the codebase -------------------------------------------
//
// After the mint, `doc-cancel-<documentId>` (the `onCancel` delegates in document.ts and invoice.ts)
// is the only internally-derived idempotency key left in `src/`. Everything else is caller-supplied
// or folds a caller key into a scoped pair (`send_invoice`, `transition_document`,
// `convert_document`, `reverse_entry`, and yearClose's `<key>:pl` / `:carry` / `:vat`).
//
// `doc-cancel-<id>` is safe, and not because it is unguessable: it is safe because of where it lands.
// `reverseEntry` folds the TARGET entry into it (`JSON.stringify([entryId, key])`) and posts under
// `source='reversal'`, which A02 routes to the `reverse_entry` namespace, and the tool boundary
// refuses `reversesEntryId` on `post_entry`. So the only way to occupy that slot is to actually
// reverse that same entry, and A02 forces every reversal to MIRROR its target line for line. A
// squatter cannot install arbitrary money there: the worst they can do is perform the correct
// reversal early. This test runs that attack from the ENGINE (past the tool boundary, the strongest
// position an attacker could hold) and reads the books back, rather than taking the reasoning on
// trust.

test('audit: squatting `doc-cancel-<id>` can only produce the correct reversal, never arbitrary money', () => {
  const { ctx, store, workspaceId } = setup();
  const invoiceId = draftInvoice(ctx);
  assert.equal(issueInvoice(ctx, { invoiceId }).ok, true);
  const postedEntryId = store.db.prepare('SELECT posted_entry_id AS p FROM document WHERE id = ?').get(invoiceId).p;
  const scopedCancelKey = JSON.stringify([postedEntryId, `doc-cancel-${invoiceId}`]);

  // The attack: post straight into the reversal namespace under the exact scoped key A11's cancel
  // will use, with lines that do NOT mirror the invoice posting (the money the squatter wants).
  const notAMirror = postEntry(ctx, {
    date: '2026-07-16',
    source: 'reversal',
    reversesEntryId: postedEntryId,
    description: 'reversal squatter',
    idempotencyKey: scopedCancelKey,
    lines: [
      { account: account(store, workspaceId, '1100'), credit: 1 },
      { account: account(store, workspaceId, '1020'), debit: 1 },
    ],
  });
  assert.equal(notAMirror.ok, false, `A02 must refuse a reversal that is not a mirror: ${JSON.stringify(notAMirror)}`);
  assert.equal(notAMirror.error, 'not_a_mirror');

  // The strongest thing a squatter CAN do is post the genuine mirror early, under that same key.
  const mirror = postEntry(ctx, {
    date: '2026-07-16',
    source: 'reversal',
    reversesEntryId: postedEntryId,
    description: 'early but honest',
    idempotencyKey: scopedCancelKey,
    lines: [
      { account: account(store, workspaceId, '1100'), credit: 108100 },
      {
        account: account(store, workspaceId, '3200'),
        debit: 100000,
        taxCode: 'UST81',
        taxBase: -100000,
        taxAmount: -8100,
      },
      { account: account(store, workspaceId, '2200'), debit: 8100 },
    ],
  });
  assert.equal(mirror.ok, true, JSON.stringify(mirror));

  // The cancel replays it, and the books come out exactly right: every account nets to zero.
  const cancelled = transitionDocument(ctx, { documentId: invoiceId, to: 'cancelled' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  for (const number of ['1100', '3200', '2200', '1020']) {
    const net = store.db
      .prepare(
        `SELECT COALESCE(SUM(l.base_debit_minor),0) - COALESCE(SUM(l.base_credit_minor),0) AS n
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
         WHERE e.workspace_id = ? AND l.account_id = ?`,
      )
      .get(workspaceId, account(store, workspaceId, number)).n;
    assert.equal(net, 0, `${number} must net to zero after the cancel`);
  }
  assert.equal(
    store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE source = 'reversal'").get().n,
    1,
    'and exactly one reversal exists: the squat did not become a second one',
  );
});
