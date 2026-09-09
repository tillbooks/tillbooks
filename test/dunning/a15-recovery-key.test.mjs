/**
 * A15's two-questions-one-key guard, at the ENGINE, for every caller.
 *
 * `issue_dunning_run` answers two questions: the issue while a run is `proposed`, and C8's fee
 * recovery afterwards. A caller reusing the ISSUE's key for the recovery used to be answered from
 * the issue's memo: `{ok:true}`, and not one Rappen of the deferred Mahngebühr on the ledger. The
 * wave's UX pass found it and repaired the STUDIO, which minted a second key of its own; U1 is the
 * critic's refutation of that repair, driven through the registry, which is the MCP agent's path, a
 * G01 rule's path and REST's.
 *
 * THE PROPERTY THESE EIGHT PROBES PIN TOGETHER, and it is not "the recovery always works". A caller
 * retrying its issue and a caller asking for a recovery send BYTE-IDENTICAL input: same workspace,
 * same verb, same runId, same key. No routing rule can tell them apart, so the engine refuses the
 * ambiguity instead of guessing it. What must hold is:
 *
 *   - a reused key never SILENTLY no-ops: it recovers, or it refuses by name (U1);
 *   - a fresh key recovers, once, and both memos stay distinct (U2, V3);
 *   - an unchanged key never acquires a new effect, and never moves money it did not ask for
 *     (V1 before the unlock, V2 after it);
 *   - the second namespace opens no hole of its own: per-run scoping (U3), §H-TENANT (U3b), and a
 *     failed recovery memoising nothing (U3c).
 *
 * Authored by the independent critic (docs/critique/a15-critic.md, rounds 8f0f6e6 and 70ca3ff) as
 * the acceptance criteria for the engine repair, and adopted here unchanged as the permanent guard,
 * with one exception recorded in place: U1's assertion is relaxed to the property above, which is
 * the critic's own prescription once V1 and V2 proved "must recover" unreachable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const call = (deps, name, input) => getAction(name).run(deps, input);
const must = (r, what) => {
  assert.equal(r.ok, true, `${what} failed: ${JSON.stringify(r)}`);
  return r;
};

function steppingDeps(startIso) {
  let now = startIso;
  const clock = { now: () => now };
  const store = new SqliteStore({ clock });
  return { deps: { store, clock, ids: sequenceIdGen(), actor: 'agent' }, setNow: (iso) => (now = iso) };
}

function seed(deps, prefix) {
  const { workspaceId, accId } = mintWorkspace(deps, 'Acme GmbH', `${prefix}-ws`);
  must(call(deps, 'vat_seed_defaults', { workspaceId }), 'vat');
  must(call(deps, 'set_vat_method', { workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }), 'method');
  must(
    call(deps, 'set_creditor_profile', {
      workspaceId,
      creditorName: 'Treuhand Muster GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    }),
    'creditor',
  );
  const customerId = must(
    call(deps, 'create_contact', {
      workspaceId,
      partyRole: 'customer',
      name: 'Säumig AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'debitor@kunde.example',
      idempotencyKey: `${prefix}-c`,
    }),
    'contact',
  ).contact.id;
  const documentId = must(
    call(deps, 'create_document', {
      workspaceId,
      type: 'invoice',
      contactId: customerId,
      currency: 'CHF',
      dueDate: '2026-06-01',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: `${prefix}-d`,
    }),
    'doc',
  ).document.id;
  must(call(deps, 'issue_invoice', { workspaceId, invoiceId: documentId, idempotencyKey: `${prefix}-i` }), 'issue');
  const acc = must(
    call(deps, 'create_account', { workspaceId, number: '3999', name: 'Mahngebühren', type: 'income', idempotencyKey: `${prefix}-a` }),
    'acct',
  );
  const accountId = acc.account?.id ?? acc.accountId ?? acc.id;
  const lvl = { feeMinor: 2000, bookFee: true, feeIncomeAccountId: accountId, showInterest: true, interestBp: 500 };
  must(
    call(deps, 'set_dunning_config', {
      workspaceId,
      levels: [
        { level: 1, daysOverdue: 10, ...lvl },
        { level: 2, daysOverdue: 20, ...lvl },
        { level: 3, daysOverdue: 30, ...lvl },
      ],
      idempotencyKey: `${prefix}-cfg`,
    }),
    'policy',
  );
  return { workspaceId, accId, customerId, documentId };
}

/** Lock, propose, issue: a run whose Mahngebühr is deferred, issued under `<prefix>-ISSUEKEY`. */
function deferredFeeRun(deps, workspaceId, prefix, period = '2026-07') {
  must(call(deps, 'lock_period', { workspaceId, period, kind: 'hard', idempotencyKey: `${prefix}-lock` }), 'lock');
  const run = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: `${prefix}-p` }), 'propose');
  const issued = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: run.runId, confirmed: true, idempotencyKey: `${prefix}-ISSUEKEY` }),
    'issue',
  );
  assert.equal(issued.feeSkippedReason, 'period_locked');
  must(call(deps, 'unlock_period', { workspaceId, period, reason: 'Korrektur', idempotencyKey: `${prefix}-u` }), 'unlock');
  return run.runId;
}

const feeEntries = (deps, ws) =>
  deps.store.db.prepare(`SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND source = 'dunning'`).get(ws).n;
const snapshotRow = (deps, ws, runId) =>
  deps.store.db.prepare('SELECT fee_booked, demanded_fee_minor FROM dunning_item WHERE workspace_id = ? AND run_id = ?').get(ws, runId);

// --- U1: the defect, at the layer the Studio fix did NOT touch ------------------------------------
//
// RELAXED, on the critic's own prescription, once V1 and V2 proved the original form unreachable:
// "must recover" and "an unchanged key must not acquire a new effect" cannot both hold, because the
// two callers are indistinguishable. What was actually wrong was the SILENCE, and that is what this
// probe now pins. The title states what green means, because a name that asserts the defect would
// read as a pass for the bug to everyone who meets it later.

test('U1: a reused key never silently no-ops: it recovers, or it refuses by name', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, 'u1');
  const runId = deferredFeeRun(deps, workspaceId, 'u1');
  assert.equal(feeEntries(deps, workspaceId), 0, 'nothing booked yet, by construction');

  // An MCP agent, a G01 rule or a REST caller reusing the run's issue key, exactly as the Studio
  // did until claude/wave-leaf-ux-pass. `recallIdempotent` answers before `recoverSkippedFee` runs.
  const recovery = call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'u1-ISSUEKEY' });

  const recovered = recovery.ok === true && recovery.feeRecovered === true && feeEntries(deps, workspaceId) === 1;
  const refusedByName = recovery.ok === false && recovery.error === 'recovery_needs_its_own_key';
  assert.equal(
    recovered || refusedByName,
    true,
    `the call reported ${JSON.stringify({ ok: recovery.ok, error: recovery.error, feeRecovered: recovery.feeRecovered })} ` +
      `and booked ${feeEntries(deps, workspaceId)} entries: a reused key must either do the recovery or ` +
      'say why it will not, never answer ok from the issue memo with nothing on the ledger',
  );
  // Whichever arm it took, it must not have moved money it was not asked for.
  if (refusedByName) {
    assert.equal(feeEntries(deps, workspaceId), 0, 'a refusal must not book');
    assert.equal(recovery.runId, runId, 'the refusal names the run it is about');
    assert.equal(typeof recovery.remedy, 'string', 'the refusal names the remedy');
  }
});

// --- U2: the fix, on rows --------------------------------------------------------------------------

test('U2: the recovery under its OWN key books exactly once, and both memos stay distinct', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, 'u2');
  const runId = deferredFeeRun(deps, workspaceId, 'u2');

  const recovered = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'u2-RECOVERKEY' }),
    'recover',
  );
  assert.equal(recovered.feeRecovered, true);
  assert.equal(feeEntries(deps, workspaceId), 1, 'the deferred Mahngebühr reached the ledger');
  assert.deepEqual(snapshotRow(deps, workspaceId, runId), { fee_booked: 1, demanded_fee_minor: 0 });

  const replayRecover = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'u2-RECOVERKEY' }),
    'replay recovery',
  );
  assert.deepEqual(replayRecover, recovered, 'the recovery key must replay the recovery');

  const replayIssue = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'u2-ISSUEKEY' }),
    'replay issue',
  );
  assert.equal(replayIssue.feeSkippedReason, 'period_locked', 'the issue memo must still describe the issue');
  assert.equal(replayIssue.feeRecovered, undefined);

  assert.equal(feeEntries(deps, workspaceId), 1);
  assert.deepEqual(snapshotRow(deps, workspaceId, runId), { fee_booked: 1, demanded_fee_minor: 0 });
});

// --- U3: holes the NEW key could introduce ---------------------------------------------------------

test('U3: a recovery key is scoped per run, so the same literal key on two runs does its own work', () => {
  const { deps, setNow } = steppingDeps('2026-07-16T00:00:00.000Z');
  const { workspaceId } = seed(deps, 'u3');
  const runA = deferredFeeRun(deps, workspaceId, 'u3');
  must(call(deps, 'issue_dunning_run', { workspaceId, runId: runA, confirmed: true, idempotencyKey: 'SHARED' }), 'recover A');
  assert.equal(feeEntries(deps, workspaceId), 1);

  setNow('2026-08-20T00:00:00.000Z');
  const proposedB = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'u3-p2' }), 'propose B');
  assert.notEqual(proposedB.runId, null, `no second run to test with: ${JSON.stringify(proposedB)}`);
  assert.equal(proposedB.items[0].level, 2);
  const issuedB = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId: proposedB.runId, confirmed: true, idempotencyKey: 'SHARED' }),
    'issue B under the same literal key',
  );
  assert.equal(issuedB.runId, proposedB.runId, 'run B was answered from run A memo');
  assert.equal(feeEntries(deps, workspaceId), 2, 'run B booked its own fee');
});

test('U3b: H-TENANT, the same literal key in two workspaces does each workspace its own work', () => {
  const deps = freshDeps();
  const wsA = seed(deps, 'u3a').workspaceId;
  const runA = deferredFeeRun(deps, wsA, 'u3a');
  const wsB = seed(deps, 'u3b').workspaceId;
  const runB = deferredFeeRun(deps, wsB, 'u3b');

  must(call(deps, 'issue_dunning_run', { workspaceId: wsA, runId: runA, confirmed: true, idempotencyKey: 'TENANT' }), 'recover A');
  assert.equal(feeEntries(deps, wsA), 1);
  assert.equal(feeEntries(deps, wsB), 0, 'workspace B must be untouched');

  must(call(deps, 'issue_dunning_run', { workspaceId: wsB, runId: runB, confirmed: true, idempotencyKey: 'TENANT' }), 'recover B');
  assert.equal(feeEntries(deps, wsB), 1);
  assert.equal(feeEntries(deps, wsA), 1);

  const crossed = call(deps, 'issue_dunning_run', { workspaceId: wsB, runId: runA, confirmed: true, idempotencyKey: 'CROSS' });
  assert.equal(crossed.ok, false);
  assert.equal(crossed.error, 'not_found');
});

test('U3c: a recovery that fails while STILL locked memoises nothing under its own key', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, 'u3c');
  must(call(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'u3c-lock' }), 'lock');
  const runId = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'u3c-p' }), 'propose').runId;
  must(call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'u3c-ISSUE' }), 'issue');

  const stillLocked = call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'u3c-REC' });
  assert.equal(stillLocked.ok, false);
  assert.equal(stillLocked.error, 'period_locked');
  assert.equal(feeEntries(deps, workspaceId), 0);

  must(call(deps, 'unlock_period', { workspaceId, period: '2026-07', reason: 'Korrektur', idempotencyKey: 'u3c-u' }), 'unlock');
  const ok2 = must(
    call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'u3c-REC' }),
    'recover on the key that failed while locked',
  );
  assert.equal(ok2.feeRecovered, true);
  assert.equal(feeEntries(deps, workspaceId), 1);
});

// --- V: the surface the recovery-memo RE-ORDERING opened (bb77372) --------------------------------

/**
 * The repair reads the recovery memo unconditionally and the ISSUE memo only when the call is NOT a
 * recovery. That second half is what these probes attack: on a run whose fee a period lock deferred,
 * `recovering` is true, so an ordinary REPLAY of the issue's own key stops consulting the issue's
 * memo and is routed into the recovery instead. Both probes hold at 6aaeaa8 and break at bb77372.
 */

test('V1: replaying the ISSUE key on a deferred run must answer the issue, not a period_locked error', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, 'v1');
  must(call(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'v1-lock' }), 'lock');
  const runId = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'v1-p' }), 'propose').runId;

  const first = must(call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'v1-K' }), 'issue');
  assert.equal(first.feeSkippedReason, 'period_locked');

  // The window the idempotency key exists for: the write LANDED, the response was lost, the caller
  // retries the identical request. Same workspace, same verb, same runId, same key.
  const retry = call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'v1-K' });
  assert.deepEqual(
    retry,
    first,
    `§H-IDEMPOTENT: one key, one answer. The first call answered ok and the retry answered ` +
      `${JSON.stringify({ ok: retry.ok, error: retry.error })}, because the deferred fee routes the ` +
      'replay into the recovery instead of the issue memo',
  );
});

test('V2: replaying the ISSUE key after the period reopened must not BOOK the deferred fee', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, 'v2');
  must(call(deps, 'lock_period', { workspaceId, period: '2026-07', kind: 'hard', idempotencyKey: 'v2-lock' }), 'lock');
  const runId = must(call(deps, 'propose_dunning_run', { workspaceId, idempotencyKey: 'v2-p' }), 'propose').runId;
  const first = must(call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'v2-K' }), 'issue');
  assert.equal(first.feeEntryId, null);
  must(call(deps, 'unlock_period', { workspaceId, period: '2026-07', reason: 'Korrektur', idempotencyKey: 'v2-u' }), 'unlock');
  assert.equal(feeEntries(deps, workspaceId), 0);

  // The caller is retrying an ISSUE. It never asked for a recovery.
  const retry = call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'v2-K' });
  assert.equal(
    feeEntries(deps, workspaceId),
    0,
    `an unchanged key moved money on the retry: ${JSON.stringify({ ok: retry.ok, feeRecovered: retry.feeRecovered })}`,
  );
});

test('V3: a repeated RECOVERY key replays the recovery, and a fresh key on a settled run refuses', () => {
  const deps = freshDeps();
  const { workspaceId } = seed(deps, 'v3');
  const runId = deferredFeeRun(deps, workspaceId, 'v3');
  const rec = must(call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'v3-REC' }), 'recover');
  assert.equal(rec.feeRecovered, true);
  // The orchestrator's named risk: the recovery memo answering a question it should not.
  const again = must(call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'v3-REC' }), 'repeat');
  assert.deepEqual(again, rec, 'the recovery key must replay the recovery');
  const fresh = call(deps, 'issue_dunning_run', { workspaceId, runId, confirmed: true, idempotencyKey: 'v3-FRESH' });
  assert.equal(fresh.ok, false);
  assert.equal(fresh.error, 'illegal_transition', 'a settled run must refuse a genuinely new call');
  assert.equal(feeEntries(deps, workspaceId), 1);
});
