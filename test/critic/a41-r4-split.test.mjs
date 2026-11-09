// A41 critic round 4 (non-author), the A41.3 split. One KEPT assertion was parked with the A41.3 probe R8: the
// capture side (A41.1, list_captures bankLineCandidates) must never name another workspace's bank line. With R8
// a todo, no running test bit the tenant clause of that read (mutation: `t.workspace_id = ?` dropped from
// bankLineCandidatesForPool stays green). This probe restates it without the autobook gate.
//
// SYNTHETIC BY CONSTRUCTION: invented vendor, IBANs, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { createBankAccount } from '../../dist/core/banking/index.js';
import { must, world, secondWorkspace, importLines, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { receipt, lines, VENDOR } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

test('K1 §H-TENANT: list_captures never names another workspace\'s fitting bank line', () => {
  const t = world();
  const r = receipt(t, { amount: 5200, date: '2026-07-21' });
  const [own] = lines(t, [{ amount: 5200, date: '2026-07-21' }]);
  const b = secondWorkspace(t);
  const bank = must(createBankAccount(b.ctx, { name: 'Nachbarkonto', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: b.bankId, idempotencyKey: 'ib-k1' }));
  importLines(t, { statementId: 'K1-B', seqNb: '1', from: '2026-07-21', to: '2026-07-21', entries: [{ ref: 'K1B1', cd: 'DBIT', name: VENDOR, amountMinor: 5200, date: '2026-07-21' }] }, { ctx: b.ctx, bankAccountId: bank.bankAccountId });
  const caps = must(getAction('list_captures').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId }));
  const mine = caps.captures.find((c) => c.id === r.captureId);
  assert.deepEqual(mine.bankLineCandidates.map((l) => l.bankTxnId), [own], 'only this workspace\'s line');
});
