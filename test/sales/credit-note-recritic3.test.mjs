/**
 * A13 CRITIC, ROUND 3 (non-author critic, 2026-07-31), ADOPTED as the last third of the D74
 * rebuild's acceptance suite.
 *
 * Scoped to the four output-side kinds, the per-rate-class closure, the S5 Klassenausgleich pair,
 * and the attribution surface. FOUR probes are ADAPTED (each says so inline) because the rebuild's
 * DESIGN closes the paths they measured rather than patching their symptoms: R1a/R1b (H1: the edit
 * path is gone, `credit_note_lines_derived`, and the poster refuses unattributed lines), R1c (H3:
 * the line refusal carries BOTH remainders), and R2a (H2: the signed released-base telescoping
 * closes the 20 x EUR 0.07 shape exactly). Everything else runs unmodified.
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
  updateDocument,
  getDocument,
} from '../../dist/core/sales/index.js';
import { ledgerPorts } from '../../dist/core/ledger/index.js';
import { recordExchangeRate } from '../../dist/core/fx/index.js';
import { listOpenItems } from '../../dist/core/debtors/index.js';

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
  store.db.prepare("UPDATE workspace SET vat_method = 'effektiv', vat_accounting = 'soll' WHERE id = ?").run(workspaceId);
  store.db
    .prepare(`INSERT INTO contact (id, workspace_id, party_role, name, created_at) VALUES ('ct_1', ?, 'customer', 'Muster AG', ?)`)
    .run(workspaceId, start);
  return { ctx, store, workspaceId, clock };
}

const bal = (ctx, number) => ctx.store.db
  .prepare(`SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS b,
                   COALESCE(SUM(l.debit_minor - l.credit_minor), 0) AS t
              FROM journal_line l JOIN account a ON a.id = l.account_id
              JOIN journal_entry e ON e.id = l.entry_id
             WHERE a.workspace_id = ? AND a.number = ? AND e.status = 'posted'`)
  .get(ctx.workspaceId, number);

function issuedInvoice(ctx, lines, currency = 'CHF') {
  const doc = createDocument(ctx, { type: 'invoice', contactId: 'ct_1', currency, lines });
  assert.ok(doc.ok, JSON.stringify(doc));
  assert.ok(issueInvoice(ctx, { invoiceId: doc.document.id, idempotencyKey: `inv-${doc.document.id}` }).ok);
  return getDocument(ctx, { documentId: doc.document.id }).document;
}

function credit(ctx, invoice, opts, key) {
  const created = createCreditNote(ctx, { fromInvoiceId: invoice.id, ...opts, idempotencyKey: key });
  if (!created.ok) return { created };
  const issued = issueCreditNote(ctx, { creditNoteId: created.document.id, idempotencyKey: `${key}-i` });
  return { created, issued, id: created.document.id, doc: getDocument(ctx, { documentId: created.document.id }).document };
}

const ziffer = (ret, code) => (ret.lines ?? []).find((l) => l.code === code);
const crossFoots = (line, rateBp) => Math.round((line.baseMinor * rateBp) / 10000) === line.taxMinor;

// --- R1. THE UNREVIEWED SURFACE: attribution is not enforced on every path ------------------------

test('R1a: ADAPTED (H1, FIXED BY DESIGN): the edit path that nulled the attribution is GONE, and closure refuses without attribution', () => {
  // The round-3 probe measured the defect: `update_document` rewrote a Gutschrift's lines from the
  // patch, nulled `credited_line_position`, and the exhausting closure then filed CHF 500.00 of
  // turnover on the wrong Ziffer with no tax to match, `reconciled: true` throughout. The rebuild's
  // §4b.1 answer is structural, and this probe pins BOTH halves of the H1 acceptance criterion:
  // the attribution survives every edit path (there is none: the patch refuses), AND closure
  // refuses honestly without it (the poster's unattributed_lines guard, forced here via SQL, a
  // path no shipped code has).
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', unitPriceMinor: 50000, taxCode: 'UST26' },
  ]);
  assert.equal(invoice.subtotalMinor, 150000);
  assert.equal(invoice.taxMinor, 8100 + 1300);

  const draft = createCreditNote(ctx, { fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 50000, idempotencyKey: 'e-1' });
  assert.ok(draft.ok);
  const before = ctx.store.db
    .prepare('SELECT credited_line_position AS p FROM document_line WHERE document_id = ? ORDER BY position')
    .all(draft.document.id);
  assert.deepEqual(before.map((r) => r.p), [1, 2], 'the derived draft IS attributed');

  // The round-3 killer operation, verbatim: it now REFUSES, and nothing moves.
  const patched = updateDocument(ctx, {
    documentId: draft.document.id,
    patch: { lines: [{ description: 'rewritten', unitPriceMinor: 150000, taxCode: 'UST81' }] },
  });
  assert.equal(patched.ok, false, JSON.stringify(patched));
  assert.equal(patched.error, 'credit_note_lines_derived');
  const after = ctx.store.db
    .prepare('SELECT credited_line_position AS p FROM document_line WHERE document_id = ? ORDER BY position')
    .all(draft.document.id);
  assert.deepEqual(after.map((r) => r.p), [1, 2], 'the attribution SURVIVES');

  // The untouched draft still issues, and BOTH Ziffern cross-foot: no base ever moves without its
  // rate's tax beside it.
  const issued = issueCreditNote(ctx, { creditNoteId: draft.document.id, idempotencyKey: 'e-1-i' });
  assert.equal(issued.ok, true, JSON.stringify(issued));
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  const z303 = ziffer(ret, '303');
  const z313 = ziffer(ret, '313');
  assert.equal(crossFoots(z303, 810), true, JSON.stringify(z303));
  assert.equal(crossFoots(z313, 260), true, JSON.stringify(z313));
  assert.equal(ret.reconciled, true);
  assert.equal(listOpenItems(ctx, {}).reconciled, true);

  // Belt and braces: an unattributed line reached by NO shipped path (SQL here) refuses closure.
  const second = createCreditNote(ctx, { fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 20000, idempotencyKey: 'e-2' });
  assert.ok(second.ok);
  ctx.store.db
    .prepare('UPDATE document_line SET credited_line_position = NULL WHERE document_id = ?')
    .run(second.document.id);
  const refused = issueCreditNote(ctx, { creditNoteId: second.document.id, idempotencyKey: 'e-2-i' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'unattributed_lines');
});

test('R1b: ADAPTED (H1): BOTH edit magnitudes refuse identically: the decoupling cannot be created at any size', () => {
  // The round-3 probe showed the decoupling only appeared at the EXHAUSTING size (the below-remainder
  // edit still cross-footed), which is what made it invisible to a casual test. The rebuild refuses
  // the edit at EVERY size, so there is no magnitude at which the theorem's premise can be broken.
  for (const net of [50000, 150000]) {
    const { ctx } = setup();
    const invoice = issuedInvoice(ctx, [
      { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
      { description: 'B', unitPriceMinor: 50000, taxCode: 'UST26' },
    ]);
    const draft = createCreditNote(ctx, { fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 50000, idempotencyKey: 'x' });
    const patched = updateDocument(ctx, {
      documentId: draft.document.id,
      patch: { lines: [{ description: 'r', unitPriceMinor: net, taxCode: 'UST81' }] },
    });
    assert.equal(patched.ok, false, `net ${net}`);
    assert.equal(patched.error, 'credit_note_lines_derived', `net ${net}`);
  }
});

test('R1c: ADAPTED (H3): line_over_credit carries BOTH remainders, so no surface can print a wrong amount', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', unitPriceMinor: 100000, taxCode: 'UST26' },
  ]);
  const half = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1, quantityMilli: 500 }] }, 'h-1');
  assert.ok(half.issued.ok);

  const over = createCreditNote(ctx, { fromInvoiceId: invoice.id, mode: 'partial', lines: [{ position: 1 }], idempotencyKey: 'h-2' });
  assert.ok(over.ok, 'create still accepts it: the cap is an ISSUE-time refusal');
  const refused = issueCreditNote(ctx, { creditNoteId: over.document.id, idempotencyKey: 'h-2-i' });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'over_credit');
  assert.equal(refused.reason, 'line_over_credit');
  assert.equal(refused.remainingLineNetMinor, 50000);

  // ADAPTED (H3, FIXED): the refusal carries BOTH remainders, so no surface rendering either field
  // can print CHF 0.00 against a line-level refusal. (The measured defect: the payload carried only
  // `remainingLineNetMinor` and the Studio's banner read `remainingCreditableMinor ?? 0`.)
  const trueRemainingGross = invoice.totalMinor - half.doc.totalMinor;
  assert.equal(trueRemainingGross, 156650);
  assert.equal(refused.remainingCreditableMinor, trueRemainingGross);
});

// --- R2. F2 UNDER COMPOSITION WITH THE D71 SHUTTLE ------------------------------------------------

test('R2a: ADAPTED (H2, FIXED): the 20 x EUR 0.07 shape closes exactly in BOTH denominations', () => {
  // The round-3 probe measured F2's recurrence at head: base -1 stranded on 1100 and Ziffer 303 at
  // base -2 / tax +1, because the base statement accumulated leg magnitudes sign-blind and the
  // clawback's flipped 2200 leg inflated the cumulative share past 1. The rebuild's stated bases
  // are a SIGNED released-base telescoping (spec 4b.3): the exhausting credit states
  // booked-minus-released per account, so this exact shape (the guard-refused 19th unit included)
  // now closes to zero everywhere.
  const { ctx } = setup();
  assert.ok(recordExchangeRate(ctx, {
    baseCurrency: 'EUR', rate: '0.9137', asOf: '2026-07-15', source: 'manual',
    method: 'daily', provenance: 'T', idempotencyKey: 'fx',
  }).ok);
  const invoice = issuedInvoice(ctx, [{ description: 'S', quantityMilli: 20000, unitPriceMinor: 7, taxCode: 'UST81' }], 'EUR');
  assert.equal(invoice.subtotalMinor, 140);
  assert.equal(invoice.taxMinor, 11);

  let done = 0;
  for (let n = 1; n <= 20; n += 1) {
    const r = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1, quantityMilli: 1000 }] }, `u-${n}`);
    if (!r.issued.ok) break;
    done = n;
  }
  assert.equal(done, 18, 'the 19th unit refuses over_credit on the gross guard');
  const rest = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1, quantityMilli: (20 - done) * 1000 }] }, 'u-rest');
  assert.ok(rest.issued.ok, JSON.stringify(rest.issued));

  // Both denominations close exactly, and the Ziffer nets to zero on BOTH signable figures.
  assert.equal(bal(ctx, '1100').t, 0);
  assert.equal(bal(ctx, '1100').b, 0);
  assert.equal(bal(ctx, '2200').b, 0);
  assert.equal(bal(ctx, '3200').b, 0);
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  const z303 = ziffer(ret, '303');
  assert.equal(z303.baseMinor, 0);
  assert.equal(z303.taxMinor, 0);
  assert.equal(ret.reconciled, true, JSON.stringify(ret));
  assert.equal(listOpenItems(ctx, {}).reconciled, true);
});

// --- R3. THE SHUTTLE: what it actually is ---------------------------------------------------------

test('R3a: the adjustment shuttle is a ONE-RAPPEN BASE shuttle carrying an UNBOUNDED tax', () => {
  // The docblock calls it "a one-Rappen revenue shuttle". The two revenue legs are indeed 1 Rappen
  // each, but the tax they carry is the whole class residual, which grows with the number of
  // partial credits. Measured, not argued.
  const measured = [];
  for (const units of [3, 10, 20, 50, 100]) {
    const { ctx } = setup();
    const invoice = issuedInvoice(ctx, [
      { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
      { description: 'B', quantityMilli: units * 1000, unitPriceMinor: 7, taxCode: 'UST26' },
    ]);
    for (let n = 1; n <= units; n += 1) {
      assert.ok(credit(ctx, invoice, { mode: 'partial', lines: [{ position: 2, quantityMilli: 1000 }] }, `s-${n}`).issued.ok);
    }
    const last = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1 }] }, 's-last');
    assert.ok(last.issued.ok, JSON.stringify(last.issued));
    const shuttle = ctx.store.db
      .prepare(`SELECT l.debit_minor d, l.credit_minor c, l.tax_base_minor tb, l.tax_amount_minor ta
                  FROM journal_line l
                 WHERE l.entry_id = ? AND (l.debit_minor = 1 OR l.credit_minor = 1) AND l.tax_code IS NOT NULL`)
      .all(last.doc.postedEntryId);
    assert.ok(shuttle.length >= 2, `units ${units}`);
    // Every shuttle leg moves exactly one Rappen of base, and its stamped base is +1 / -1.
    for (const leg of shuttle) assert.equal(Math.abs(leg.tb), 1);
    measured.push(Math.max(...shuttle.map((l) => Math.abs(l.ta ?? 0))));
    // The pair still closes on every account, which is the point of the mechanism.
    assert.equal(bal(ctx, '1100').b, 0);
    assert.equal(bal(ctx, '2200').b, 0);
    assert.equal(bal(ctx, '3200').b, 0);
  }
  // DOCUMENTS THE NAMING: 1, 2, 4, 9, 18 Rappen of tax on one Rappen of base.
  assert.deepEqual(measured, [1, 2, 4, 9, 18]);
});

test('R3b: the shuttle is idempotent on ROWS and tenant-scoped', () => {
  const { ctx, store } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST26' },
  ]);
  for (let n = 1; n <= 3; n += 1) {
    assert.ok(credit(ctx, invoice, { mode: 'partial', lines: [{ position: 2, quantityMilli: 1000 }] }, `t-${n}`).issued.ok);
  }
  const cn = createCreditNote(ctx, { fromInvoiceId: invoice.id, mode: 'partial', lines: [{ position: 1 }], idempotencyKey: 'last' });
  const first = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'last-i' });
  assert.ok(first.ok);
  const lines = store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n;
  const replay = issueCreditNote(ctx, { creditNoteId: cn.document.id, idempotencyKey: 'last-i' });
  assert.ok(replay.ok);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n, lines);
  assert.equal(replay.document.number, first.document.number);
  assert.equal(bal(ctx, '1100').b, 0);

  const otherId = createWorkspace({ store, clock: ctx.clock, ids: ctx.ids }, { name: 'Fremd AG' }).workspaceId;
  const other = makeContext(store, { workspaceId: otherId, actor: 'u2', clock: ctx.clock, ids: ctx.ids });
  assert.equal(createCreditNote(other, { fromInvoiceId: invoice.id, idempotencyKey: 'f' }).error, 'not_found');
  assert.equal(listOpenItems(other, {}).items.length, 0);
});

test('R3c: a pure-tax class correction files alone across periods, on a Ziffer with zero turnover', () => {
  // Not created by round 3 (the +4 in the earlier period is per-line canonical rounding that has
  // been there since round 1), but round 3 is what finally books the closing -4. Recorded because
  // both filed figures are Ziffern carrying tax against zero turnover, which ESTV cross-foots.
  const { ctx, clock } = setup('2026-02-10T00:00:00.000Z');
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', quantityMilli: 20000, unitPriceMinor: 7, taxCode: 'UST26' },
  ]);
  for (let n = 1; n <= 20; n += 1) {
    assert.ok(credit(ctx, invoice, { mode: 'partial', lines: [{ position: 2, quantityMilli: 1000 }] }, `p-${n}`).issued.ok);
  }
  clock.set('2026-08-10T00:00:00.000Z');
  assert.ok(credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1 }] }, 'p-last').issued.ok);

  const q1 = computeVatReturn(ctx, { periodStart: '2026-01-01', periodEnd: '2026-03-31' });
  const q3 = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(q1, '313').baseMinor, 0);
  assert.equal(ziffer(q1, '313').taxMinor, 4);
  assert.equal(ziffer(q3, '313').baseMinor, 0);
  assert.equal(ziffer(q3, '313').taxMinor, -4);
  // Across the two periods it is exact, and the ledger closes.
  assert.equal(bal(ctx, '1100').b, 0);
  assert.equal(q1.reconciled, true);
  assert.equal(q3.reconciled, true);
});

// --- R4. G1 AND G2 VERIFIED ------------------------------------------------------------------------

test('R4a: EXPORT0 and AUSGENOMMEN credit through ALL THREE modes, and 220/230/200 net independently', () => {
  for (const taxCode of ['EXPORT0', 'AUSGENOMMEN']) {
    for (const opts of [{}, { mode: 'partial', lines: [{ position: 1, quantityMilli: 500 }] }, { mode: 'partial', amountMinor: 40000 }]) {
      const { ctx } = setup();
      const invoice = issuedInvoice(ctx, [{ description: 'X', quantityMilli: 1000, unitPriceMinor: 100000, taxCode }]);
      const r = credit(ctx, invoice, opts, 'k');
      assert.ok(r.issued.ok, `${taxCode} ${JSON.stringify(opts)}: ${JSON.stringify(r.issued)}`);
    }
  }
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'E', unitPriceMinor: 100000, taxCode: 'EXPORT0' },
    { description: 'A', unitPriceMinor: 70000, taxCode: 'AUSGENOMMEN' },
    { description: 'T', unitPriceMinor: 50000, taxCode: 'UST81' },
  ]);
  const before = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(before, '220').baseMinor, 100000);
  assert.equal(ziffer(before, '230').baseMinor, 70000);
  assert.equal(ziffer(before, '200').baseMinor, 220000);
  assert.equal(ziffer(before, '299').baseMinor, 50000);

  assert.ok(credit(ctx, invoice, {}, 'full').issued.ok);
  const after = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(after, '200').baseMinor, 0);
  assert.equal(ziffer(after, '299').baseMinor, 0);
  assert.equal(ziffer(after, '220'), undefined, 'a zero Ziffer is not rendered');
  assert.equal(ziffer(after, '230'), undefined);
  assert.equal(after.reconciled, true);

  // Recomputed independently from the raw stamped traces, not from the report.
  const traces = ctx.store.db
    .prepare(`SELECT l.tax_code AS code, COALESCE(SUM(l.tax_base_minor), 0) AS base, COALESCE(SUM(l.tax_amount_minor), 0) AS tax
                FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
               WHERE e.workspace_id = ? AND e.status = 'posted' AND l.tax_code IS NOT NULL GROUP BY l.tax_code`)
    .all(ctx.workspaceId);
  for (const row of traces) {
    assert.equal(row.base, 0, `${row.code} base`);
    assert.equal(row.tax, 0, `${row.code} tax`);
  }
});

test('R4b: three rate classes credited together close each on its own Ziffer', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'A', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST81' },
    { description: 'B', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST26' },
    { description: 'C', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST38' },
    { description: 'D', unitPriceMinor: 100000, taxCode: 'UST81' },
  ]);
  for (let n = 1; n <= 2; n += 1) {
    assert.ok(credit(ctx, invoice, {
      mode: 'partial',
      lines: [{ position: 1, quantityMilli: 1000 }, { position: 2, quantityMilli: 1000 }, { position: 3, quantityMilli: 1000 }],
    }, `c-${n}`).issued.ok);
  }
  const last = credit(ctx, invoice, {
    mode: 'partial',
    lines: [{ position: 1, quantityMilli: 1000 }, { position: 2, quantityMilli: 1000 }, { position: 3, quantityMilli: 1000 }, { position: 4 }],
  }, 'c-3');
  assert.ok(last.issued.ok, JSON.stringify(last.issued));
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  for (const code of ['303', '313', '343']) {
    const z = ziffer(ret, code);
    assert.equal(z.baseMinor, 0, code);
    assert.equal(z.taxMinor, 0, code);
  }
  assert.equal(ret.reconciled, true);
  assert.equal(bal(ctx, '1100').b, 0);
  assert.equal(bal(ctx, '2200').b, 0);
  assert.equal(bal(ctx, '3200').b, 0);
});

test('R4c: a class present ONLY in prior credits closes through the shuttle', () => {
  const { ctx } = setup();
  const invoice = issuedInvoice(ctx, [
    { description: 'A', unitPriceMinor: 100000, taxCode: 'UST81' },
    { description: 'B', quantityMilli: 3000, unitPriceMinor: 7, taxCode: 'UST26' },
  ]);
  for (let n = 1; n <= 3; n += 1) {
    assert.ok(credit(ctx, invoice, { mode: 'partial', lines: [{ position: 2, quantityMilli: 1000 }] }, `o-${n}`).issued.ok);
  }
  // The exhausting credit carries NO 2.6% line at all: that class exists only in the priors.
  const last = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1 }] }, 'o-last');
  assert.ok(last.issued.ok, JSON.stringify(last.issued));
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(ret, '303').taxMinor, 0);
  assert.equal(ziffer(ret, '313').taxMinor, 0);
  assert.equal(ziffer(ret, '313').baseMinor, 0);
  assert.equal(bal(ctx, '1100').b, 0);
  assert.equal(listOpenItems(ctx, {}).reconciled, true);
});

// --- R5. THE OLD REFUSAL IS EFFECTIVELY GONE ------------------------------------------------------

test('R5a: vat_residue_unexpressible is unreachable across a sweep of ordinary FX shapes', () => {
  let attempts = 0;
  for (const [cur, rate, units, price] of [
    ['EUR', '0.9200', 3, 3333], ['JPY', '0.0067', 5, 1], ['JPY', '0.0001', 9, 1],
    ['EUR', '0.0100', 12, 1], ['GBP', '1.1731', 9, 1111],
  ]) {
    const { ctx } = setup();
    assert.ok(recordExchangeRate(ctx, {
      baseCurrency: cur, rate, asOf: '2026-07-15', source: 'manual',
      method: 'daily', provenance: 'T', idempotencyKey: 'fx',
    }).ok);
    const invoice = issuedInvoice(ctx, [{ description: 'S', quantityMilli: units * 1000, unitPriceMinor: price, taxCode: 'UST81' }], cur);
    for (let n = 1; n <= units; n += 1) {
      attempts += 1;
      const r = credit(ctx, invoice, { mode: 'partial', lines: [{ position: 1, quantityMilli: 1000 }] }, `v-${n}`);
      if (!r.issued.ok) {
        assert.notEqual(r.issued.error, 'vat_residue_unexpressible', `${cur} ${rate} unit ${n}`);
        break;
      }
    }
    assert.equal(bal(ctx, '1100').t, 0, `${cur} ${rate} txn`);
  }
  assert.ok(attempts >= 35);
});

test('R5b: the 40-tiny-line invoice closes to zero once the exact remainder is credited', () => {
  const { ctx } = setup();
  const lines = [];
  for (let k = 0; k < 40; k += 1) lines.push({ description: `L${k}`, unitPriceMinor: 3 + (k % 5), taxCode: k % 2 ? 'UST26' : 'UST81' });
  const invoice = issuedInvoice(ctx, lines);
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 60) break;
    const r = credit(ctx, invoice, { mode: 'partial', amountMinor: 7 }, `w-${guard}`);
    if (!r.created?.ok || !r.issued?.ok) break;
  }
  // The refusal names the remaining net, and crediting exactly that closes the invoice.
  const probe = createCreditNote(ctx, { fromInvoiceId: invoice.id, mode: 'partial', amountMinor: 999999, idempotencyKey: 'probe' });
  assert.equal(probe.ok, false);
  const remainingNet = probe.remainingNetMinor;
  assert.ok(remainingNet > 0);
  const final = credit(ctx, invoice, { mode: 'partial', amountMinor: remainingNet }, 'w-final');
  assert.ok(final.issued.ok, JSON.stringify(final.issued));
  assert.equal(bal(ctx, '1100').b, 0);
  assert.equal(bal(ctx, '2200').b, 0);
  assert.equal(bal(ctx, '3200').b, 0);
  const ret = computeVatReturn(ctx, { periodStart: '2026-07-01', periodEnd: '2026-09-30' });
  assert.equal(ziffer(ret, '303').taxMinor, 0);
  assert.equal(ziffer(ret, '313').taxMinor, 0);
  assert.equal(ret.reconciled, true);
});
