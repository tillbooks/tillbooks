/**
 * A38, the ownership of every entry the accruals and provisions mint (critic finding, HIGH, 2026-09-09).
 *
 * The critic reproduced three desyncs through the raw A02 `reverse_entry` tool: reversing B (an
 * accrual's automatic Rückbuchung) returned ok while the accrual row stayed `posted`, after which
 * `accrual_reverse` minted a fifth entry and 2300 sat at -180'000; reversing a provision's formation
 * returned ok while `provision_get` kept reporting the full balance and `provision_release` was still
 * admitted; and reversing the reversal of a release was admitted while the derivation still counted
 * the first reversal. The fix is N3's mechanism: `OWNED_REVERSAL_SOURCES` names the owning verb for
 * `accrual` and `provision`, the mirrors inherit their target's owner, and the releases get a named
 * path of their own, `provision_release_reverse`. Every assertion here failed on the pre-fix dist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { OWNED_REVERSAL_SOURCES } from '../../dist/core/ledger/reverseEntry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, ws, name, input) => getAction(name).run(deps, { workspaceId: ws, ...input });

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Nomadik GmbH', 'ws');
  const other = mintWorkspace(deps, 'Fremde AG', 'ws2');
  return { deps, ws: workspaceId, ws2: other.workspaceId, accId };
}

function postedCount(deps, ws) {
  return deps.store.db.prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'").get(ws).n;
}

/** Every account whose posted lines do NOT net to zero, by number: `[]` is the healthy answer. */
function unbalanced(deps, ws) {
  return deps.store.db
    .prepare(
      `SELECT a.number, SUM(l.base_debit_minor - l.base_credit_minor) AS net
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id
         JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted'
        GROUP BY a.number
       HAVING net <> 0
        ORDER BY a.number`,
    )
    .all(ws)
    .map((r) => [r.number, r.net]);
}

/** The posted balance of one account, over every date or up to `upTo` inclusive. */
function balance(deps, ws, number, upTo = '9999-12-31') {
  return deps.store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id JOIN account a ON a.id = l.account_id
        WHERE e.workspace_id = ? AND e.status = 'posted' AND a.number = ? AND e.date <= ?`,
    )
    .get(ws, number, upTo).net;
}

function postAccrual(deps, ws, key = 'acc-1') {
  const draft = call(deps, ws, 'accrual_create', {
    kind: 'accrued_expense',
    periodEnd: '2026-06-30',
    amountMinor: 180000,
    contraAccount: '6500',
    description: 'Strom Juni, Rechnung im Juli',
    idempotencyKey: key,
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const posted = call(deps, ws, 'accrual_post', { accrualId: draft.accrual.id, idempotencyKey: `${key}-post` });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return posted;
}

function postProvision(deps, ws, key = 'prov-1') {
  const draft = call(deps, ws, 'provision_create', {
    reason: 'garantie',
    periodEnd: '2026-06-30',
    amountMinor: 500000,
    provisionAccount: '2330',
    expenseAccount: '6800',
    description: 'Garantiefälle Halbjahr 2026',
    idempotencyKey: key,
  });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const posted = call(deps, ws, 'provision_post', { provisionId: draft.provision.id, idempotencyKey: `${key}-post` });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  return { id: draft.provision.id, entryId: posted.entryId };
}

function rawReverse(deps, ws, entryId, key) {
  return call(deps, ws, 'reverse_entry', { entryId, idempotencyKey: key });
}

test('the ownership map names accrual_reverse for accrual and an owner for provision beside vat_settlement_reverse', () => {
  assert.equal(OWNED_REVERSAL_SOURCES.vat_settlement, 'vat_settlement_reverse');
  assert.equal(OWNED_REVERSAL_SOURCES.accrual, 'accrual_reverse');
  assert.notEqual(OWNED_REVERSAL_SOURCES.provision, undefined, 'provision entries are owned');
});

test('the raw reverse_entry is refused owned_by on A and on B; the accrual row and the ledger are untouched', () => {
  const { deps, ws } = world();
  const posted = postAccrual(deps, ws);
  const before = postedCount(deps, ws);
  assert.equal(before, 2, 'the accrual pair');

  const onA = rawReverse(deps, ws, posted.entryId, 'raw-a');
  assert.equal(onA.ok, false, JSON.stringify(onA));
  assert.equal(onA.error, 'owned_by');
  assert.equal(onA.verb, 'accrual_reverse');
  assert.equal(onA.entryId, posted.entryId);

  // B is `source='reversal'`: it inherits the owner of the entry it reverses.
  const onB = rawReverse(deps, ws, posted.reversalEntryId, 'raw-b');
  assert.equal(onB.ok, false, JSON.stringify(onB));
  assert.equal(onB.error, 'owned_by');
  assert.equal(onB.verb, 'accrual_reverse');

  const got = call(deps, ws, 'accrual_get', { accrualId: posted.accrualId });
  assert.equal(got.ok, true);
  assert.equal(got.accrual.status, 'posted');
  assert.equal(postedCount(deps, ws), before, 'nothing was minted');
  assert.equal(balance(deps, ws, '2300', '2026-06-30'), -180000, 'the accrual still stands on 2300 in June');
  assert.equal(balance(deps, ws, '2300'), 0, 'and B still clears it the day after');
});

test('accrual_reverse still nets every account to zero across the four entries, and no fifth entry can be minted', () => {
  const { deps, ws } = world();
  const posted = postAccrual(deps, ws);
  const storno = call(deps, ws, 'accrual_reverse', { accrualId: posted.accrualId, idempotencyKey: 'st-1' });
  assert.equal(storno.ok, true, JSON.stringify(storno));
  assert.equal(postedCount(deps, ws), 4, 'A, B, C, D');
  assert.deepEqual(unbalanced(deps, ws), [], 'every account nets to zero across the four entries');

  // C and D are owned too (C by source, D by what it reverses).
  for (const [id, key] of [
    [storno.stornoEntryId, 'raw-c'],
    [storno.stornoReversalEntryId, 'raw-d'],
    [posted.entryId, 'raw-a2'],
    [posted.reversalEntryId, 'raw-b2'],
  ]) {
    const r = rawReverse(deps, ws, id, key);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.equal(r.error, 'owned_by');
  }

  // The owning verb replays under its key and refuses a second Storno under another.
  const replay = call(deps, ws, 'accrual_reverse', { accrualId: posted.accrualId, idempotencyKey: 'st-1' });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  const again = call(deps, ws, 'accrual_reverse', { accrualId: posted.accrualId, idempotencyKey: 'st-2' });
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal(postedCount(deps, ws), 4, 'no fifth entry');
  assert.deepEqual(unbalanced(deps, ws), []);
});

test('the raw reverse_entry is refused owned_by on the formation, a release and a release-undo; provision_get and the ledger agree after every admitted path', () => {
  const { deps, ws } = world();
  const prov = postProvision(deps, ws);
  const get = () => {
    const got = call(deps, ws, 'provision_get', { provisionId: prov.id });
    assert.equal(got.ok, true, JSON.stringify(got));
    return got;
  };
  const view = () => get().provision;
  assert.equal(view().openBalanceMinor, 500000);
  assert.equal(balance(deps, ws, '2330'), -500000);

  // The formation.
  const onFormation = rawReverse(deps, ws, prov.entryId, 'raw-f');
  assert.equal(onFormation.ok, false, JSON.stringify(onFormation));
  assert.equal(onFormation.error, 'owned_by');
  assert.equal(onFormation.verb, 'provision_reverse');
  assert.equal(view().status, 'posted');
  assert.equal(view().openBalanceMinor, 500000);
  assert.equal(balance(deps, ws, '2330'), -500000, 'the formation still stands');

  // A release, then the raw tool on its entry.
  const release = call(deps, ws, 'provision_release', {
    provisionId: prov.id,
    date: '2026-07-10',
    amountMinor: 200000,
    targetAccount: '6800',
    idempotencyKey: 'rel-1',
  });
  assert.equal(release.ok, true, JSON.stringify(release));
  assert.equal(view().openBalanceMinor, 300000);
  assert.equal(balance(deps, ws, '2330'), -300000, 'the ledger and the derivation agree after the release');
  const onRelease = rawReverse(deps, ws, release.entryId, 'raw-r');
  assert.equal(onRelease.ok, false, JSON.stringify(onRelease));
  assert.equal(onRelease.error, 'owned_by');
  assert.equal(onRelease.verb, 'provision_release_reverse');
  assert.equal(view().openBalanceMinor, 300000, 'the release still counts');

  // The named path.
  const undo = call(deps, ws, 'provision_release_reverse', { releaseId: release.releaseId, idempotencyKey: 'rr-1' });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.equal(typeof undo.reversalEntryId, 'string');
  assert.equal(undo.provisionId, prov.id);
  assert.equal(undo.openBalanceMinor, 500000);
  assert.equal(view().openBalanceMinor, 500000);
  assert.equal(balance(deps, ws, '2330'), -500000, 'the ledger and the derivation agree after the undo');
  const released = get().releases.find((r) => r.id === release.releaseId);
  assert.equal(released.reversedByEntryId, undo.reversalEntryId, 'the derivation names the undo');

  // The undo's own mirror is owned too: reversing the reversal of a release is refused.
  const onUndo = rawReverse(deps, ws, undo.reversalEntryId, 'raw-ru');
  assert.equal(onUndo.ok, false, JSON.stringify(onUndo));
  assert.equal(onUndo.error, 'owned_by');
  assert.equal(onUndo.verb, 'provision_release_reverse');
  assert.equal(view().openBalanceMinor, 500000);

  // §H-IDEMPOTENT on the named path: the key replays, another key is refused, nothing new is minted.
  const n = postedCount(deps, ws);
  const replay = call(deps, ws, 'provision_release_reverse', { releaseId: release.releaseId, idempotencyKey: 'rr-1' });
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.reversalEntryId, undo.reversalEntryId);
  const again = call(deps, ws, 'provision_release_reverse', { releaseId: release.releaseId, idempotencyKey: 'rr-2' });
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal(again.error, 'already_reversed');
  assert.equal(postedCount(deps, ws), n);

  // With no live release the formation reverses through its own verb, and the books read zero.
  const reversed = call(deps, ws, 'provision_reverse', { provisionId: prov.id, reason: 'Fall erledigt', idempotencyKey: 'pr-1' });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
  assert.equal(view().status, 'reversed');
  assert.equal(view().openBalanceMinor, 0);
  assert.equal(balance(deps, ws, '2330'), 0);
  assert.deepEqual(unbalanced(deps, ws), []);
});

test('a second workspace gets not_found before owned_by, on the raw tool and on the named path', () => {
  const { deps, ws, ws2 } = world();
  const posted = postAccrual(deps, ws);
  const prov = postProvision(deps, ws);
  const release = call(deps, ws, 'provision_release', {
    provisionId: prov.id,
    date: '2026-07-10',
    amountMinor: 100000,
    targetAccount: '6800',
    idempotencyKey: 'rel-x',
  });
  assert.equal(release.ok, true, JSON.stringify(release));

  for (const id of [posted.entryId, posted.reversalEntryId, prov.entryId, release.entryId]) {
    const r = rawReverse(deps, ws2, id, `raw-${id}`);
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not_found', JSON.stringify(r));
  }
  const undo = call(deps, ws2, 'provision_release_reverse', { releaseId: release.releaseId, idempotencyKey: 'rr-x' });
  assert.equal(undo.ok, false);
  assert.equal(undo.error, 'not_found', JSON.stringify(undo));
  const storno = call(deps, ws2, 'accrual_reverse', { accrualId: posted.accrualId, idempotencyKey: 'st-x' });
  assert.equal(storno.ok, false);
  assert.equal(storno.error, 'not_found', JSON.stringify(storno));
  assert.equal(postedCount(deps, ws2), 0, 'the other workspace minted nothing');
});
