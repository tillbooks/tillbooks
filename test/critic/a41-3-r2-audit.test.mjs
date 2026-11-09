// Critic A41.3 r2 (non-author), probe group A: the D4 filter on get_audit_log. The filter drops the beleg_*
// rows for a seat without the receipt read right, but answers every surviving row with its prevHash and hash.
// A hidden row's hash is the next row's prevHash, and its content is a short list of guessable values (the
// sequential id, the workspace, entity kind bank_txn, a bank line id the seat reads anyway, four actions, a
// known actor, a timestamp next to its neighbours'). So the seat recomputes the hidden row exactly.
//
// SYNTHETIC BY CONSTRUCTION: invented vendors, amounts and dates.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { getAction } from '../../dist/api/registry.js';
import { makeContext } from '../../dist/core/context.js';
import { getAuditLog } from '../../dist/core/ledger/auditLog.js';
import { ok, err } from '../../dist/core/result.js';
import { settingsSet } from '../../dist/core/settings/settings.js';
import { must, assertClaimInvariantHolds } from '../banking/bank-inbox-support.mjs';
import { ruleWorld, debits, bookAsProposed, at, TELCO } from '../banking/n04-autobook-support.mjs';
import { receipt, assignBeleg } from '../banking/a41-beleg-support.mjs';

afterEach(assertClaimInvariantHolds);

const hashRow = (prev, row) => createHash('sha256').update(prev).update('\u0000').update(JSON.stringify(row)).digest('hex');

test('A1: a seat without read_master_data recomputes a hidden beleg_assign row, and so learns WHICH line got a receipt', () => {
  const t = ruleWorld();
  debits(t, [1100, 1200, 1300]).forEach((id) => bookAsProposed(t, id));
  must(settingsSet(t.ctx, { key: 'rules.autobook_requires_beleg', value: 'on', reason: 'critic', idempotencyKey: 'a1-rb' }));
  at(t, '2026-07-20T08:00:00.000Z');
  const candidates = debits(t, [1970, 1980, 1990, 2000], { from: '2026-04-01' });
  const secret = candidates[2];
  must(assignBeleg(t, secret, [receipt(t, { amount: 1990, vendor: TELCO, date: '2026-03-01' }).fileId]));
  // A later, ordinary audited act (a capture's intake), so the hidden row has a visible successor.
  must(getAction('capture_document').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, contentBase64: Buffer.from('a1 later receipt').toString('base64'), mime: 'application/pdf', filename: 'later.pdf', idempotencyKey: 'a1-later' }));

  const denying = makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: 'user_1',
    clock: t.clock,
    ids: t.ids,
    capabilities: { assert: (c) => (c === 'read_master_data' ? err('permission_denied', { capability: c }) : ok()) },
  });
  const res = getAuditLog(denying, {});
  assert.equal(res.ok, true);
  assert.equal(res.rows.some((r) => String(r.action).startsWith('beleg_')), false, 'precondition: the filter hides the rows');
  // The attack, with only what the seat is answered: find a break in the visible chain and solve for it.
  const visibleLines = must(getAction('list_bank_inbox').run({ ...t.deps, actor: 'user_1' }, { workspaceId: t.workspaceId, status: 'all' })).lines.map((l) => l.bankTxnId ?? l.id);
  const recovered = [];
  for (let i = 1; i < res.rows.length; i++) {
    const prev = res.rows[i - 1];
    const next = res.rows[i];
    if (next.prevHash === prev.hash) continue;
    const n = Number(prev.id.replace(/^\D+_/, ''));
    const idOf = (k) => prev.id.replace(/\d+$/, String(k));
    for (const id of [idOf(n + 1), idOf(n + 2)]) {
      for (const line of visibleLines) {
        for (const action of ['beleg_assign', 'beleg_release', 'beleg_consume']) {
          for (const actor of ['user_1', 'studio', 'system']) {
            for (const when of new Set([prev.at, next.at])) {
              if (hashRow(prev.hash, [id, t.workspaceId, 'bank_txn', line, action, actor, when]) === next.prevHash) recovered.push({ line, action });
            }
          }
        }
      }
    }
  }
  assert.deepEqual(recovered, [], `the filtered audit log still discloses the hidden row: ${JSON.stringify(recovered)} (the secret line is ${secret})`);
});
