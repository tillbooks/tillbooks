// D167 critic round 1 (non-author): two money-path invariant probes the author's suite did not carry.
// Each was confirmed to FAIL against a mutation of the code it guards (docs/critique/d167-money-path-r1.md):
//   - the tenant probe fails when `liveStandardFor` (bankStandards.ts) drops its `workspace_id = ?` binding;
//   - the column probe fails when the `bank_standard_supersede_only` trigger drops its `id` or
//     `workspace_id` guard (bankInboxSchema.ts).
//
// SYNTHETIC DATA ONLY: invented names and the support module's invented IBANs.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createBankAccount, setBankStandard, listBankStandards } from '../../dist/core/banking/index.js';
import { world, secondWorkspace, importLines, must, assertClaimInvariantHolds, MAIN_IBAN, TELCO_IBAN } from './bank-inbox-support.mjs';

afterEach(assertClaimInvariantHolds);

const rowsOf = (t, ws) => t.store.db.prepare('SELECT * FROM bank_standard WHERE workspace_id = ? ORDER BY rowid').all(ws);

test('[INVARIANT tenant] when B sets a standard for a counterparty A also has one for, B gets its own row, and A\'s is never named or superseded', () => {
  const t = world();
  const b = secondWorkspace(t);
  const bBank = must(createBankAccount(b.ctx, { name: 'Konto B', iban: MAIN_IBAN, currency: 'CHF', ledgerAccountId: b.acc('1020'), idempotencyKey: 'bb' })).bankAccountId;
  const la = importLines(t, { statementId: 'A-1', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  const lb = importLines(t, { statementId: 'B-1', entries: [{ ref: 'TEL', amountMinor: 8650, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }, { ctx: b.ctx, bankAccountId: bBank }).lines;

  const a = must(setBankStandard(t.ctx, { bankTxnId: la.TEL, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'a' }));
  const aRowsBefore = rowsOf(t, t.workspaceId);
  const inB = must(setBankStandard(b.ctx, { bankTxnId: lb.TEL, accountId: b.acc('6800'), taxCode: null, idempotencyKey: 'b' }));

  assert.equal(inB.supersededId, null, "B's first standard supersedes nothing, least of all A's");
  assert.equal(inB.unchanged, false);
  assert.notEqual(inB.standard.id, a.standard.id, 'B answers its own row');
  assert.equal(inB.standard.accountId, b.acc('6800'));
  assert.deepEqual(rowsOf(t, t.workspaceId), aRowsBefore, "A's standard is untouched");
  assert.equal(rowsOf(t, b.workspaceId).length, 1);
  assert.deepEqual(
    must(listBankStandards(t.ctx, {})).standards.map((s) => s.id),
    [a.standard.id],
  );
});

test('[INVARIANT append-only] the id and workspace_id of a standard are immutable, also beside a legitimate stamp', () => {
  const t = world();
  const b = secondWorkspace(t);
  const l = importLines(t, { statementId: 'C-1', entries: [{ ref: 'TEL', amountMinor: 100, cd: 'DBIT', iban: TELCO_IBAN, name: 'Fernmelde Ostschweiz AG' }] }).lines;
  const s = must(setBankStandard(t.ctx, { bankTxnId: l.TEL, accountId: t.acc('6500'), taxCode: null, idempotencyKey: 'c' })).standard;
  const db = t.store.db;
  for (const [col, value] of [
    ['id', 'bstd_moved'],
    ['workspace_id', b.workspaceId],
  ]) {
    assert.throws(() => db.prepare(`UPDATE bank_standard SET ${col} = ? WHERE id = ?`).run(value, s.id), /only the supersession stamp/, `${col} is immutable`);
    assert.throws(
      () => db.prepare(`UPDATE bank_standard SET superseded_at = '2026-07-21T00:00:00.000Z', superseded_by = 'u', ${col} = ? WHERE id = ?`).run(value, s.id),
      /only the supersession stamp/,
      `${col} is immutable beside a stamp`,
    );
  }
  assert.equal(rowsOf(t, t.workspaceId).length, 1);
  assert.equal(rowsOf(t, b.workspaceId).length, 0, 'no standard moved into another workspace');
});
