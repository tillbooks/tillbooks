/**
 * A13 CRITIC, ROUND 2 (non-author critic, 2026-07-31), ADOPTED VERBATIM as part of the D74
 * rebuild's acceptance suite.
 *
 * Scoped to the F1 cancel guard, the A02 `baseAmountMinor` seam and its containment, the D67/D71
 * VAT closure, the D68 bucket netting, and F5-F7. The rebuild passes all of it unmodified.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { makeContext } from '../../dist/core/context.js';
import { sequenceIdGen } from '../../dist/core/ids.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { seedTaxCodes } from '../../dist/core/vat/index.js';
import { computeVatReturn } from '../../dist/core/vat/abrechnung.js';
import {
  createDocument,
  issueInvoice,
  createCreditNote,
  issueCreditNote,
  transitionDocument,
  getDocument,
} from '../../dist/core/sales/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { postEntry } from '../../dist/core/ledger/postEntry.js';
import { reverseEntry } from '../../dist/core/ledger/reverseEntry.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';
import { recordPayment, PAYMENT_INTENTS } from '../../dist/core/payments/index.js';
import { getAction, POST_ENTRY_SOURCES } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';

function movableClock(start) {
  let at = start;
  return { now: () => at, set: (v) => { at = v; } };
}

function setup(start = '2026-07-16T00:00:00.000Z') {
  const clock = movableClock(start);
  const ids = sequenceIdGen();
  const store = new SqliteStore({ clock });
  const workspaceId = createWorkspace({ store, clock, ids }, { name: 'Nomadik GmbH' }).workspaceId;
  const ctx = makeContext(store, {
    workspaceId, actor: 'user_1', clock, ids, ...ledgerPorts({ store, workspaceId, ids }),
  });
  seedTaxCodes(ctx);
  store.db
    .prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?")
    .run(workspaceId);
  store.db
    .prepare(
      `INSERT INTO contact (id, workspace_id, party_role, name, created_at)
       VALUES ('ct_1', ?, 'customer', 'Muster AG', ?)`,
    )
    .run(workspaceId, start);
  return { ctx, store, workspaceId, clock };
}

const acc = (ctx, number) =>
  ctx.store.db
    .prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?')
    .get(ctx.workspaceId, number).id;

function baseBalance(ctx, number) {
  return ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(ctx.workspaceId, number).net;
}

function txnBalance(ctx, number) {
  return ctx.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS net
         FROM journal_line l JOIN account a ON a.id = l.account_id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`,
    )
    .get(ctx.workspaceId, number).net;
}

function issuedInvoice(ctx, lines, currency = 'CHF', extra = {}) {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency, lines, ...extra });
  assert.ok(doc.ok, JSON.stringify(doc));
  const issued = issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: `inv-${doc.document.id}` });
  assert.ok(issued.ok, JSON.stringify(issued));
  return getDocument(ctx, { documentId: doc.document.id }).document;
}

function credit(ctx, invoice, opts, key) {
  const created = createCreditNote(ctx, { fromInvoiceId: invoice.id, ...opts, idempotencyKey: key });
  if (!created.ok) return { created };
  const issued = issueCreditNote(ctx, { creditNoteId: created.document.id, idempotencyKey: `${key}-i` });
  return { created, issued, id: created.document.id, doc: getDocument(ctx, { documentId: created.document.id }).document };
}

const ziffer = (ret, code) => (ret.lines ?? []).find((l) => l.code === code);

// --- Q1. THE A02 SEAM: containment ----------------------------------------------------------------

test('Q1a: baseAmountMinor is unreachable through every agent-facing verb, twice over', () => {
  const { ctx, store, workspaceId, clock } = setup();
  const ids = ctx.ids;
  const deps = { store, clock, ids };
  const linesWithBase = [
    { account: acc(ctx, '1020'), debit: 1000, baseAmountMinor: 999 },
    { account: acc(ctx, '3200'), credit: 1000, baseAmountMinor: 999 },
  ];

  // Gate 1: for every source the registry ALLOWS, the engine refuses the field outright.
  for (const source of POST_ENTRY_SOURCES) {
    const r = getAction('post_entry').run(deps, {
      workspaceId, date: '2026-07-16', source, description: 'x',
      idempotencyKey: `a-${source}`, lines: linesWithBase,
    });
    assert.equal(r.ok, false, `${source} accepted a stated base`);
    assert.equal(r.error, 'invalid_line');
    assert.match(String(r.reason), /reserved for engine correction sources/);
  }

  // Gate 2: the two sources that DO accept it are refused by the registry before the engine runs.
  for (const source of ['credit_note', 'reversal', 'close', 'purchase']) {
    const r = getAction('post_entry').run(deps, {
      workspaceId, date: '2026-07-16', source, description: 'x',
      idempotencyKey: `b-${source}`, lines: linesWithBase,
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'invalid_source');
  }

  // The REST twin is the same dispatcher, so it inherits both gates.
  const rest = handleRest('post_entry', {
    workspaceId, date: '2026-07-16', source: 'credit_note', description: 'x',
    idempotencyKey: 'rest-1', lines: linesWithBase,
  }, deps);
  assert.equal(rest.status, 422);
  assert.equal(rest.body.error, 'invalid_source');

  // And no other registered verb carries journal lines a caller could smuggle the field through:
  // save_draft hardcodes source 'manual' and does not persist a base column at all.
  const draft = getAction('save_draft').run(deps, {
    workspaceId, date: '2026-07-16', description: 'x', idempotencyKey: 'd1', lines: linesWithBase,
  });
  if (draft.ok) {
    const row = store.db
      .prepare("SELECT source FROM journal_entry WHERE workspace_id = ? AND id = ?")
      .get(workspaceId, draft.entryId);
    assert.equal(row.source, 'manual');
  }
});

test('Q1b: the seam is all-or-none, must equal the transaction amount in base currency, and §H-LEDGER still binds', () => {
  const { ctx } = setup();
  const mixed = postEntry(ctx, {
    date: '2026-07-16', source: 'credit_note', description: 'x', idempotencyKey: 'm1',
    lines: [{ account: acc(ctx, '1020'), debit: 1000, baseAmountMinor: 1000 }, { account: acc(ctx, '3200'), credit: 1000 }],
  });
  assert.equal(mixed.ok, false);
  assert.match(String(mixed.reason), /all-or-none/);

  const wrongBase = postEntry(ctx, {
    date: '2026-07-16', source: 'credit_note', description: 'x', idempotencyKey: 'm2',
    lines: [
      { account: acc(ctx, '1020'), debit: 1000, baseAmountMinor: 900 },
      { account: acc(ctx, '3200'), credit: 1000, baseAmountMinor: 1000 },
    ],
  });
  assert.equal(wrongBase.ok, false);
  assert.match(String(wrongBase.reason), /must equal the transaction amount/);

  // A foreign entry whose stated bases do not balance is still refused by the §H-LEDGER check.
  assert.ok(
    recordExchangeRate(ctx, {
      baseCurrency: 'EUR', rate: '0.9200', asOf: '2026-07-15', source: 'manual',
      method: 'daily', provenance: 'T', idempotencyKey: 'fx',
    }).ok,
  );
  const unbalanced = postEntry(ctx, {
    date: '2026-07-16', source: 'credit_note', description: 'x', currency: 'EUR', fxRate: '0.9200',
    idempotencyKey: 'm3',
    lines: [
      { account: acc(ctx, '1020'), debit: 1000, baseAmountMinor: 920 },
      { account: acc(ctx, '3200'), credit: 1000, baseAmountMinor: 919 },
    ],
  });
  assert.equal(unbalanced.ok, false, JSON.stringify(unbalanced));

  const balanced = postEntry(ctx, {
    date: '2026-07-16', source: 'credit_note', description: 'x', currency: 'EUR', fxRate: '0.9200',
    idempotencyKey: 'm4',
    lines: [
      { account: acc(ctx, '1020'), debit: 1000, baseAmountMinor: 920 },
      { account: acc(ctx, '3200'), credit: 1000, baseAmountMinor: 920 },
    ],
  });
  assert.ok(balanced.ok, JSON.stringify(balanced));
});

test('Q1c: reverseEntry mirrors the STORED base amounts exactly, on ordinary and foreign entries alike', () => {
  // The property the byte-for-byte A/B against the pre-change engine confirmed: a reversal gives
  // back the base the books carry, which for a derived entry is what the allocation produced.
  const shapes = [
    { currency: null, rate: null, lines: (c) => [{ account: acc(c, '1020'), debit: 12345 }, { account: acc(c, '3200'), credit: 12345 }] },
    { currency: 'EUR', rate: '0.9137', lines: (c) => [
      { account: acc(c, '1100'), debit: 10813 },
      { account: acc(c, '3200'), credit: 10003, taxCode: 'UST81', taxBase: 10003, taxAmount: 810 },
      { account: acc(c, '2200'), credit: 810 },
    ] },
    { currency: 'JPY', rate: '0.0067', lines: (c) => [
      { account: acc(c, '1020'), debit: 1 }, { account: acc(c, '1100'), debit: 100000 }, { account: acc(c, '3200'), credit: 100001 },
    ] },
  ];
  for (const [i, shape] of shapes.entries()) {
    const { ctx } = setup();
    if (shape.currency !== null) {
      assert.ok(recordExchangeRate(ctx, {
        baseCurrency: shape.currency, rate: shape.rate, asOf: '2026-07-15', source: 'manual',
        method: 'daily', provenance: 'T', idempotencyKey: 'fx',
      }).ok);
    }
    const posted = postEntry(ctx, {
      date: '2026-07-16', source: 'manual', description: 'x', idempotencyKey: `p${i}`,
      ...(shape.currency !== null ? { currency: shape.currency, fxRate: shape.rate } : {}),
      lines: shape.lines(ctx),
    });
    assert.ok(posted.ok, JSON.stringify(posted));
    const rev = reverseEntry(ctx, { entryId: posted.entryId, idempotencyKey: `r${i}` });
    assert.ok(rev.ok, JSON.stringify(rev));

    const read = (id) => ctx.store.db
      .prepare(`SELECT account_id, debit_minor, credit_minor, base_debit_minor, base_credit_minor
                  FROM journal_line WHERE entry_id = ? ORDER BY account_id, debit_minor, credit_minor`)
      .all(id);
    const original = read(posted.entryId);
    const mirror = read(rev.reversalId);
    assert.equal(mirror.length, original.length);
    // Every mirrored line gives back exactly the base its original carried, on the other side.
    const key = (r) => `${r.account_id}:${r.debit_minor}:${r.credit_minor}`;
    const mirrorByKey = new Map(mirror.map((r) => [`${r.account_id}:${r.credit_minor}:${r.debit_minor}`, r]));
    for (const o of original) {
      const m = mirrorByKey.get(key(o));
      assert.ok(m, `no mirror for ${key(o)} in shape ${i}`);
      assert.equal(m.base_credit_minor, o.base_debit_minor);
      assert.equal(m.base_debit_minor, o.base_credit_minor);
    }
  }
});

// --- Q2. F2: the FX partial-credit close ----------------------------------------------------------

test('Q2a: the shapes that close, close exactly: 1100, 2200 and revenue all zero in BOTH denominations', () => {
  const shapes = [
    { cur: 'EUR', rate: '0.9200', units: 3, price: 3333 },
    { cur: 'GBP', rate: '1.1731', units: 9, price: 1111 },
    { cur: 'JPY', rate: '0.0067', units: 5, price: 29999 },
  ];
  for (const s of shapes) {
    const { ctx } = setup();
    assert.ok(recordExchangeRate(ctx, {
      baseCurrency: s.cur, rate: s.rate, asOf: '2026-07-15', source: 'manual',
      method: 'daily', provenance: 'T', idempotencyKey: 'r1',
    }).ok);
    const invoice = issuedInvoice(ctx, [
      { description: 'S', quantityMilli: s.units * 1000, unitPriceMinor: s.price, taxCode: 'UST81' },
    ], s.cur);
    // The store moves after the invoice posted; the correction must not notice.
    assert.ok(recordExchangeRate(ctx, {
      baseCurrency: s.cur, rate: '1.5000', asOf: '2026-07-16', source: 'manual',
      method: 'daily', provenance: 'T', idempotencyKey: 'r2',
    }).ok);
    for (let n = 1; n <= s.units; n += 1) {
      const r = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1, quantityMilli: 1000 }] }, `f-${n}`);
      assert.ok(r.issued?.ok, `${s.cur} unit ${n}: ${JSON.stringify(r.issued ?? r.created)}`);
    }
    for (const account of ['1100', '2200', '3200']) {
      assert.equal(baseBalance(ctx, account), 0, `${s.cur} base ${account}`);
      assert.equal(txnBalance(ctx, account), 0, `${s.cur} txn ${account}`);
    }
    const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
    assert.equal(ziffer(ret, '303').baseMinor, 0);
    assert.equal(ziffer(ret, '303').taxMinor, 0);
    assert.equal(ret.reconciled, true);
    assert.equal(listOpenItems(ctx, {}).reconciled, true);
  }
});

// --- Q3. THE ZERO-RATED / EXEMPT REGRESSION -------------------------------------------------------

test('Q3a: EXPORT0 and AUSGENOMMEN invoices credit cleanly, and the credited base nets its own Ziffer (G1, FIXED)', () => {
  // POLARITY FLIPPED at round-2 remediation: this test used to pin the measured REGRESSION (the
  // hand-built leg set refused `zero` and `exempt` kinds outright). All four output-side kinds are
  // creditable again; what the guard refuses is the input-side kinds only. The 0% kinds carry no
  // VAT, and their credited BASE flows through the trace on the mirrored revenue leg: A02 stamps
  // `tax_base_minor` negative, and A07 nets it off the class's own Ziffer (220 exports, 230
  // exempt) in the credit's period, exactly as the invoice put it on.
  for (const [taxCode, formLine] of [['EXPORT0', '220'], ['AUSGENOMMEN', '230']]) {
    const { ctx } = setup();
    const invoice = issuedInvoice(ctx, [{ description: 'X', unitPriceMinor: 100000, taxCode }]);
    assert.equal(invoice.totalMinor, 100000);
    const before = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
    assert.equal(ziffer(before, formLine).baseMinor, 100000);

    const r = credit(ctx, invoice, {}, `z-${taxCode}`);
    assert.ok(r.issued.ok, `${taxCode}: ${JSON.stringify(r.issued ?? r.created)}`);
    assert.equal(baseBalance(ctx, '1100'), 0);
    assert.equal(txnBalance(ctx, '3200'), 0);
    // The credited zero-rated base reached the return: the deduction Ziffer nets to zero (A07
    // omits a fully-netted deduction line rather than rendering 0, so absent IS the netted answer),
    // and the worldwide-turnover Ziffer 200, which both entries feed, reads zero.
    const after = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
    assert.equal(ziffer(after, formLine)?.baseMinor ?? 0, 0);
    assert.equal(ziffer(after, formLine)?.taxMinor ?? 0, 0);
    assert.equal(ziffer(after, '200').baseMinor, 0);
    assert.deepEqual(ziffer(after, '200').entryIds.length, 2, 'both entries feed the total line');
    assert.equal(after.reconciled, true, JSON.stringify(after));
    // And the credit entry's traced row really carries the negative base with the code.
    const entry = getDocument(ctx, { documentId: r.id }).document.postedEntryId;
    const row = ctx.store.db
      .prepare('SELECT tax_code, tax_base_minor, tax_amount_minor FROM journal_line WHERE entry_id = ? AND tax_code IS NOT NULL')
      .get(entry);
    assert.equal(row.tax_code, taxCode);
    assert.equal(row.tax_base_minor, -100000);
    assert.equal(row.tax_amount_minor, 0);
  }

  // A MIXED invoice (taxed beside export) credits whole and every class closes.
  const { ctx } = setup();
  const mixed = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', unitPriceMinor: 50000, taxCode: 'EXPORT0' },
  ]);
  assert.equal(mixed.totalMinor, 158100);
  const full = credit(ctx, mixed, {}, 'z-mixed');
  assert.ok(full.issued.ok, JSON.stringify(full.issued ?? full.created));
  assert.equal(baseBalance(ctx, '1100'), 0);
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(ret, '303').baseMinor, 0);
  assert.equal(ziffer(ret, '303').taxMinor, 0);
  assert.equal(ziffer(ret, '220')?.baseMinor ?? 0, 0);
  assert.equal(ret.reconciled, true, JSON.stringify(ret));

  // A line with NO tax code at all keeps working too.
  const { ctx: c2 } = setup();
  const untaxed = issuedInvoice(c2, [{ description: 'X', unitPriceMinor: 100000 }]);
  assert.ok(credit(c2, untaxed, {}, 'z-none').issued.ok);
  assert.equal(baseBalance(c2, '1100'), 0);
});

// --- Q4. THE MIXED-RATE RESIDUAL MISATTRIBUTION ---------------------------------------------------

test('Q4a: the D67 residual stays inside its own RATE CLASS, so every Ziffer cross-foots (G2, FIXED)', () => {
  const { ctx } = setup();
  // Line A: CHF 1'000.00 at 8.1% (tax 81.00). Line B: 3 x CHF 0.07 at 2.6% (net 0.21, tax 0.01).
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST26' },
  ]);
  assert.equal(invoice.taxMinor, 8100 + 1);

  // Credit line B unit by unit: 2.6% of 0.07 rounds to 0.00, so both credits book no VAT.
  for (const n of [1, 2]) {
    const r = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 2, quantityMilli: 1000 }] }, `mx-${n}`);
    assert.ok(r.issued.ok);
    assert.equal(r.doc.taxMinor, 0);
  }
  // POLARITY FLIPPED at round-2 remediation (G2, FIXED): the residual is computed PER RATE CLASS
  // now, so the 2.6%-born Rappen lands on the 2.6% line and never on the 8.1% one. The exhausting
  // credit's TOTAL VAT is the same 81.01; what moved is which class carries the +0.01.
  const last = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1 }, { position: 2, quantityMilli: 1000 }] }, 'mx-3');
  assert.ok(last.issued.ok, JSON.stringify(last.issued));
  assert.equal(last.doc.taxMinor, 8101);

  // An untouched 8.1% sale so the Ziffer carries real turnover: the fix must hold on a LIVE line.
  issuedInvoice(ctx, [{ description: 'C', unitPriceMinor: 500000, taxCode: 'UST81' }]);

  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  const z303 = ziffer(ret, '303');
  const z313 = ziffer(ret, '313');
  // Each Ziffer now cross-foots against its own rate: 303 carries exactly 8.1% of its base (the
  // measured defect declared 40499 there), and 313 nets to zero on BOTH signable figures (the
  // measured defect declared base 0 with tax +1 against it).
  assert.equal(z303.baseMinor, 500000);
  assert.equal(z303.taxMinor, 40500);
  assert.equal(z303.taxMinor, Math.round(z303.baseMinor * 0.081));
  assert.equal(z313.baseMinor, 0);
  assert.equal(z313.taxMinor, 0);
  assert.equal(ret.reconciled, true);
  assert.equal(ret.reconciliation.driftMinor, 0);
  assert.equal(baseBalance(ctx, '1100'), 540500);
});

// --- Q5. F3: the dead end survives at ordinary amounts --------------------------------------------

test('Q5a: an ordinary CHF invoice of 7 x 14.29 credits unit by unit through all seven partials (D71, FIXED)', () => {
  // POLARITY FLIPPED at round-2 remediation: this test used to pin the measured DEAD END (six
  // units credited, the seventh refused `vat_residue_unexpressible` and CHF 15.43 stranded). D71:
  // the exhausting credit books each rate class's remaining VAT exactly, with no per-line
  // envelope, so the seventh unit books 1.14 where its own line computes 1.16 and the pair closes.
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'S', quantityMilli: 7000, unitPriceMinor: 1429, taxCode: 'UST81' },
  ]);
  assert.equal(invoice.subtotalMinor, 10003);
  assert.equal(invoice.taxMinor, 810);

  const taxes = [];
  for (let n = 1; n <= 7; n += 1) {
    const r = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1, quantityMilli: 1000 }] }, `d-${n}`);
    assert.ok(r.issued.ok, `unit ${n}: ${JSON.stringify(r.issued ?? r.created)}`);
    taxes.push(r.doc.taxMinor);
  }
  // Six canonical units at 1.16, and the exhausting seventh books the residual 1.14 exactly.
  assert.deepEqual(taxes, [116, 116, 116, 116, 116, 116, 114]);
  assert.equal(taxes.reduce((a, b) => a + b, 0), invoice.taxMinor);
  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(txnBalance(ctx, '3200'), 0);
  assert.equal(txnBalance(ctx, '2200'), 0);
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(ret, '303').baseMinor, 0);
  assert.equal(ziffer(ret, '303').taxMinor, 0);
  assert.equal(ret.reconciled, true, JSON.stringify(ret));
});

test('Q5b: the 19-partial shape closes in one final Gutschrift, with NO cancellation (D71, FIXED)', () => {
  // POLARITY FLIPPED at round-2 remediation: this test used to pin the measured DEFECT (the final
  // credit refused, the named recovery failed, and only an exhaustive eight-of-nineteen
  // cancellation search found a postable shape). D71 removes the envelope on the exhausting
  // credit: the 2.6% class's remaining VAT (0.04, which nineteen zero-rounding unit credits never
  // touched) books on the final credit's own 2.6% line, and the pair closes outright.
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', quantityMilli: 20000, unitPriceMinor: 7, taxCode: 'UST26' },
  ]);
  assert.equal(invoice.taxMinor, 8100 + 4);
  const priors = [];
  for (let n = 1; n <= 19; n += 1) {
    const r = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 2, quantityMilli: 1000 }] }, `r-${n}`);
    assert.ok(r.issued.ok);
    assert.equal(r.doc.taxMinor, 0);
    priors.push(r.id);
  }
  const last = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1 }, { position: 2, quantityMilli: 1000 }] }, 'r-last');
  assert.ok(last.issued.ok, JSON.stringify(last.issued ?? last.created));
  // The final credit's VAT: 81.00 canonical on the 8.1% class plus the 2.6% class's whole
  // remaining 0.04 on a 7-Rappen line (its own arithmetic says 0.00: D71's accepted cost).
  assert.equal(last.doc.taxMinor, 8100 + 4);

  assert.equal(baseBalance(ctx, '1100'), 0);
  assert.equal(txnBalance(ctx, '3200'), 0);
  assert.equal(txnBalance(ctx, '2200'), 0);
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  for (const code of ['303', '313']) {
    assert.equal(ziffer(ret, code).baseMinor, 0, `Ziffer ${code}`);
    assert.equal(ziffer(ret, code).taxMinor, 0, `Ziffer ${code}`);
  }
  assert.equal(ret.reconciled, true, JSON.stringify(ret));
  assert.equal(listOpenItems(ctx, {}).reconciled, true);
});

// --- Q6. F1: the cancel guard under composition ---------------------------------------------------

test('Q6a: a DRAFT credit does not block the cancel, and the orphan cannot resurrect the double relief', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const draft = createCreditNote(ctx, { fromInvoiceId: invoice.id, idempotencyKey: 'o-1' });
  assert.ok(draft.ok);

  const cancelled = transitionDocument(ctx, { documentId: invoice.id, to: 'cancelled' });
  assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
  assert.equal(baseBalance(ctx, '1100'), 0);

  // The orphaned draft still names a cancelled invoice. Both routes to issuing it refuse.
  const viaVerb = issueCreditNote(ctx, { creditNoteId: draft.document.id, idempotencyKey: 'o-1-i' });
  assert.equal(viaVerb.ok, false);
  assert.equal(viaVerb.error, 'invoice_not_creditable');
  assert.equal(viaVerb.reason, 'invoice_cancelled');
  const viaTransition = transitionDocument(ctx, { documentId: draft.document.id, to: 'issued' });
  assert.equal(viaTransition.ok, false);
  assert.equal(viaTransition.error, 'invoice_not_creditable');
  assert.equal(baseBalance(ctx, '1100'), 0);
});

test('Q6b: sent and partially-paid credit notes block too, and the refusal is not memoised', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = credit(ctx, invoice, {}, 'g-1');
  assert.ok(cn.issued.ok);
  assert.ok(transitionDocument(ctx, { documentId: cn.id, to: 'sent' }).ok);
  assert.equal(getDocument(ctx, { documentId: cn.id }).document.status, 'sent');
  const blocked = transitionDocument(ctx, { documentId: invoice.id, to: 'cancelled', idempotencyKey: 'cancel-key' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, 'has_credit_notes');

  // Clear the cause and replay the SAME key: it must succeed, never replay the refusal.
  assert.ok(transitionDocument(ctx, { documentId: cn.id, to: 'cancelled' }).ok);
  const retry = transitionDocument(ctx, { documentId: invoice.id, to: 'cancelled', idempotencyKey: 'cancel-key' });
  assert.ok(retry.ok, JSON.stringify(retry));
  assert.equal(baseBalance(ctx, '1100'), 0);
});

test('Q6c: a partially PAID and partially credited invoice is guarded as well', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }]);
  const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 40000 }, 'pp-1');
  assert.ok(cn.issued.ok);
  assert.ok(recordPayment(ctx, {
    intent: PAYMENT_INTENTS.record, direction: 'incoming', date: '2026-07-16', amountMinor: 10000,
    currency: 'CHF', bankAccountId: acc(ctx, '1020'), counterpartyId: 'ct_1',
    allocations: [{ documentId: invoice.id, amountMinor: 10000 }], idempotencyKey: 'pay',
  }).ok);
  assert.equal(getDocument(ctx, { documentId: invoice.id }).document.status, 'partially_paid');
  const r = transitionDocument(ctx, { documentId: invoice.id, to: 'cancelled' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'has_credit_notes');
});

// --- Q7. F4/D68: the buckets under composition -----------------------------------------------------

test('Q7a: several credits across several buckets each net into the bucket of the claim they offset', () => {
  const { ctx, clock } = setup('2026-01-10T00:00:00.000Z');
  const old = issuedInvoice(ctx, [{ description: 'old', unitPriceMinor: 100000, taxCode: 'UST81' }], 'CHF', { dueDate: '2026-02-10' });
  clock.set('2026-06-20T00:00:00.000Z');
  const mid = issuedInvoice(ctx, [{ description: 'mid', unitPriceMinor: 100000, taxCode: 'UST81' }], 'CHF', { dueDate: '2026-06-25' });
  clock.set('2026-07-16T00:00:00.000Z');
  for (const [n, target, amount] of [[1, old, 30000], [2, old, 30000], [3, mid, 50000]]) {
    const r = credit(ctx, target, { mode: 'partial', amountMinor: amount }, `b-${n}`);
    assert.ok(r.issued.ok, JSON.stringify(r.issued));
  }
  const list = listOpenItems(ctx, {});
  assert.ok(list.ok);
  const creditTotal = list.items.filter((i) => i.direction === 'outgoing').reduce((n, i) => n - i.openMinor, 0);
  assert.equal(list.baseBucketTotals['90+'], old.totalMinor - 32430 * 2);
  assert.equal(list.baseBucketTotals['0-30'], mid.totalMinor - 54050);
  assert.equal(list.baseBucketTotals['31-60'], 0);
  assert.equal(list.baseBucketTotals['61-90'], 0);
  assert.equal(
    Object.values(list.baseBucketTotals).reduce((a, b) => a + b, 0),
    list.baseTotalOpenMinor,
  );
  assert.equal(list.reconciled, true, JSON.stringify(list));
  assert.equal(creditTotal, 32430 * 2 + 54050);
  // The ROW model is untouched: the credit rows keep their own dates and their own overdue flag.
  for (const row of list.items.filter((i) => i.direction === 'outgoing')) {
    assert.equal(row.overdue, false);
    assert.equal(row.daysOverdue, 0);
  }
});

test('Q7b: a credit on a not-yet-due invoice, and a credit whose invoice is settled, both behave', () => {
  const { ctx } = setup('2026-07-01T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [{ description: 'x', unitPriceMinor: 100000, taxCode: 'UST81' }], 'CHF', { dueDate: '2026-12-31' });
  const cn = credit(ctx, invoice, { mode: 'partial', amountMinor: 50000 }, 'n-1');
  assert.ok(cn.issued.ok);
  const before = listOpenItems(ctx, {});
  assert.equal(before.baseBucketTotals['0-30'], invoice.totalMinor - cn.doc.totalMinor);
  assert.equal(before.baseBucketTotals['90+'], 0);

  // Settle the invoice outright: its row leaves the list, so the credit keeps the first bucket.
  assert.ok(recordPayment(ctx, {
    intent: PAYMENT_INTENTS.record, direction: 'incoming', date: '2026-07-01',
    amountMinor: invoice.totalMinor, currency: 'CHF', bankAccountId: acc(ctx, '1020'),
    counterpartyId: 'ct_1', allocations: [{ documentId: invoice.id, amountMinor: invoice.totalMinor }],
    idempotencyKey: 'pay',
  }).ok);
  const after = listOpenItems(ctx, {});
  assert.equal(after.items.length, 1);
  assert.equal(after.items[0].bucket, '0-30');
  assert.equal(after.baseBucketTotals['0-30'], -cn.doc.totalMinor);
  assert.equal(after.reconciled, true, JSON.stringify(after));
});
