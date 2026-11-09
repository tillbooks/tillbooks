// Critic r1 on D188 (A39 §21, card-line rules), probe group 2: the draft-time dry run of set_bank_standard,
// the vendor prefix against the engine's unique pairing, the fee key's tenant read, and the text FX.
//
// SYNTHETIC BY CONSTRUCTION: every text, merchant, amount, rate and date is invented here.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { listBankInbox } from '../../dist/core/banking/index.js';
import { setBankStandard, prevalidateSetBankStandard } from '../../dist/core/banking/bankStandards.js';
import { lineCounterpartyOf } from '../../dist/core/banking/bankProposals.js';
import { readBankTxn, readBankTxnDetail } from '../../dist/core/banking/bankLines.js';
import { corroboratedTextFx, readLineFactsMap } from '../../dist/core/banking/statementFacts.js';
import { reconcileEngineAssignments } from '../../dist/core/banking/belegAssignment.js';
import { STATEMENT_COVERS_SQL } from '../../dist/core/banking/bankInbox.js';
import { world, importLines, must, refused, secondWorkspace, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { confirmedReceipt } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const CARD = 'Online purchase Beispielbank Visa Debit card no. xxxx 4711';

let n = 0;
function stmt(t, specs, opts) {
  n += 1;
  const dates = specs.map((s) => s.date).sort();
  const res = importLines(
    t,
    {
      statementId: `CR1D-${n}`,
      seqNb: String(n),
      from: dates[0],
      to: dates[dates.length - 1],
      entries: specs.map((s, i) => ({ ref: `CR1D${n}L${i + 1}`, cd: s.cd ?? 'DBIT', amountMinor: s.amount, date: s.date, ustrd: s.text })),
    },
    opts,
  );
  return specs.map((_, i) => res.lines[`CR1D${n}L${i + 1}`]);
}

/** Every table's row count: a dry run must leave all of them as they were. */
function allCounts(t) {
  const tables = t.store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  return Object.fromEntries(tables.map((name) => [name, t.store.db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n]));
}

test('[HELD] dry run: a passing and a refused prevalidate leave every table and the change count untouched; the real save then writes', () => {
  const t = world();
  const [card, nobody] = stmt(t, [
    { text: `${CARD}, WOLKENRECHNER`, amount: 1900, date: '2026-07-02' },
    { text: 'Zahlung gemäss Auftrag', amount: 4000, date: '2026-07-03' },
  ]);
  const before = allCounts(t);
  const changes = t.store.changeCount();
  assert.equal(prevalidateSetBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'same-key' }), undefined);
  refused(prevalidateSetBankStandard(t.ctx, { bankTxnId: nobody, accountId: t.acc('6570'), idempotencyKey: 'k2' }) ?? { ok: true }, 'no_counterparty');
  assert.deepEqual(allCounts(t), before);
  assert.equal(t.store.changeCount(), changes);
  // The memo of the dry run did not survive: the real save under the SAME key writes a rule (no phantom replay).
  const saved = must(setBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'same-key' }));
  assert.equal(saved.unchanged, false);
  assert.ok(t.store.db.prepare('SELECT 1 FROM bank_standard WHERE workspace_id = ? AND id = ?').get(t.workspaceId, saved.standard.id));
});

test('[HELD] dry run inside an outer transaction: only the dry run rolls back; the outer write commits', () => {
  const t = world();
  const [card] = stmt(t, [{ text: `${CARD}, WOLKENRECHNER`, amount: 1900, date: '2026-07-02' }]);
  t.store.tx(() => {
    t.store.db.prepare("UPDATE bank_txn_detail SET remittance_text = remittance_text WHERE workspace_id = ? AND bank_txn_id = ?").run(t.workspaceId, card);
    assert.equal(prevalidateSetBankStandard(t.ctx, { bankTxnId: card, accountId: t.acc('6570'), taxCode: null, idempotencyKey: 'nest' }), undefined);
  });
  assert.equal(t.store.db.prepare('SELECT COUNT(*) AS n FROM bank_standard WHERE workspace_id = ?').get(t.workspaceId).n, 0);
});

test('[HELD] vendor prefix: a prefix candidate beside a whole-word one, same amount, blocks the engine (no unattended pick)', () => {
  const t = world();
  const [line] = stmt(t, [{ text: `${CARD}, WOLKENRECHNERPRO`, amount: 2500, date: '2026-07-10' }]);
  confirmedReceipt(t, { amount: 2500, currency: 'CHF', vendor: 'Wolkenrechner GmbH', date: '2026-07-10' });
  confirmedReceipt(t, { amount: 2500, currency: 'CHF', vendor: 'Wolkenrechnerpro', date: '2026-07-10' });
  const groups = must(listBankInbox(t.ctx, { bankTxnId: line, status: 'all' })).lines[0].belegCandidates;
  assert.deepEqual(groups.map((g) => g.match.counterparty).sort(), ['name', 'name_prefix']);
  reconcileEngineAssignments(t.ctx, STATEMENT_COVERS_SQL);
  assert.equal(t.store.db.prepare("SELECT COUNT(*) AS n FROM beleg_assignment WHERE workspace_id = ? AND state = 'active'").get(t.workspaceId).n, 0);
});

test('[HELD] §H-TENANT: a fee line read under another workspace context derives no bank (the own IBAN is the line\'s workspace only)', () => {
  const t = world();
  const b = secondWorkspace(t);
  const [fee] = stmt(t, [{ text: 'Account maintenance', amount: 500, date: '2026-07-02' }]);
  const row = readBankTxn(t.ctx, fee);
  assert.equal(lineCounterpartyOf(t.ctx, row, readBankTxnDetail(t.ctx, fee))?.key, 'bank:00762');
  assert.equal(readBankTxn(b.ctx, fee), undefined, 'the other workspace cannot read the line');
  assert.equal(lineCounterpartyOf(b.ctx, row, readBankTxnDetail(t.ctx, fee)), null, 'nor derive its bank from its own accounts');
  assert.equal(readLineFactsMap(b.ctx, [fee]).size, 0);
});

test('[HELD] text FX: a rate that only fits in the inverse unit, two foreign amounts, or a foreign amount equal to the line currency answer nothing wrong', () => {
  // Inverse unit: CHF per USD 0.80 on USD 20.00 is CHF 16.00; read as USD per CHF it would be CHF 25.00.
  assert.equal(corroboratedTextFx('M, USD 20.00, Kurs 0.80', { amountMinor: 1600, currency: 'CHF' })?.exchange.unitCurrency, 'USD');
  assert.equal(corroboratedTextFx('M, USD 20.00, Kurs 0.80', { amountMinor: 2000, currency: 'CHF' }), null);
  assert.equal(corroboratedTextFx('M, USD 20.00, CHF 16.00, Kurs 0.80', { amountMinor: 1600, currency: 'CHF' })?.instructed.currency, 'USD');
  assert.equal(corroboratedTextFx('M, USD 20.00, USD 2.00 tip, Kurs 0.80', { amountMinor: 1600, currency: 'CHF' }), null);
  assert.equal(corroboratedTextFx('M, USD 20.00, Kurs 0.80', { amountMinor: -1600, currency: 'CHF' }), null);
});
