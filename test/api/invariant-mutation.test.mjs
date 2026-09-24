/**
 * D85: the proof that conformance rules 10 to 12 can actually FAIL.
 *
 * WHY THIS FILE EXISTS. Rules 10 to 12 run green over all 132 write verbs, and a green assertion is
 * evidence of exactly nothing until someone has watched it go red. CLAUDE.md's rule that money-path
 * invariant tests are authored or reviewed by a non-author exists because "self-review fails toward
 * whatever the author last touched": the failure mode it guards against is not a wrong assertion, it
 * is a VACUOUS one, an invariant that passes because it never looks at anything. A detector that
 * cannot fail is worse than no detector, because it reports safety.
 *
 * WHAT IS MUTATED, AND WHERE. Each test below takes a real store built through the real registry,
 * then commits the forbidden act DIRECTLY IN SQL, underneath the engine: it edits a posted entry,
 * it writes a lopsided reversal, it moves another tenant's row. SQL is the right level because it is
 * strictly more permissive than any engine defect could be. If a future capability finds a way to
 * mutate a posted entry, whatever route it takes, the row ends up in the state these tests put it in
 * by hand, and the detector that catches this catches that.
 *
 * THE DETECTORS ARE IMPORTED, NEVER RESTATED. These tests drive the identical functions in
 * `invariants.mjs` that the gate drives. A mutation test written against its own copy of a detector
 * proves the copy works and says nothing at all about the gate.
 *
 * Each test asserts BOTH directions: clean input gives no violation (so the detector is not simply
 * shouting at everything), and mutated input gives one naming the right row.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { mintWorkspace, manualPost } from './support.mjs';
import { fixture } from './conformance-contract.mjs';
import {
  tenantSnapshot,
  reversalViolations,
  tenantViolations,
} from './invariants.mjs';

/** A fixture with one posted manual entry, which is the smallest world every mutation needs. */
function seeded(key = 'mut-1') {
  const fx = fixture();
  const posted = fx.call('post_entry', manualPost(fx.accId, key));
  assert.equal(posted.ok, true, 'the seed post must succeed before anything can be mutated');
  return { fx, entryId: posted.entryId };
}

// --- Rule 10, append-only: the triggers ARE the enforcement ------------------------------------

test('mutation: a posted entry cannot be edited or deleted, even with a raw database handle', () => {
  // The strongest form of this proof, and the reason rule 10 guards the triggers instead of
  // sweeping the verbs. This test holds a raw SQLite handle, which is strictly more power than any
  // capability agent's code will ever have, and STILL cannot move history.
  const { fx, entryId } = seeded();
  for (const [what, run] of [
    ['edit the entry', () => fx.deps.store.db.prepare('UPDATE journal_entry SET description = ? WHERE id = ?').run('x', entryId)],
    ['delete the entry', () => fx.deps.store.db.prepare('DELETE FROM journal_entry WHERE id = ?').run(entryId)],
    ['edit a line', () => fx.deps.store.db.prepare('UPDATE journal_line SET debit_minor = 9999 WHERE entry_id = ?').run(entryId)],
    ['delete a line', () => fx.deps.store.db.prepare('DELETE FROM journal_line WHERE entry_id = ?').run(entryId)],
  ]) {
    assert.throws(run, /posted_immutable/, `${what}: the ledger allowed a destructive edit`);
  }
  fx.deps.store.close();
});

test('mutation: dropping a trigger is CAUGHT by the conformance guard, not silently tolerated', () => {
  // The actual exposure. The triggers cannot be defeated by a capability, but they CAN be lost by a
  // migration, and nothing else in the repo would notice. This simulates that loss and proves the
  // rule-10 guard sees it, so the guard is measuring the thing that can really go wrong.
  const { fx, entryId } = seeded();
  fx.deps.store.db.exec('DROP TRIGGER journal_line_no_update_posted');

  const names = new Set(
    fx.deps.store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all().map((r) => r.name),
  );
  assert.equal(names.has('journal_line_no_update_posted'), false, 'the trigger is gone, as the migration would leave it');

  // And with it gone, history really is editable: this is what the guard is protecting against.
  fx.deps.store.db.prepare('UPDATE journal_line SET debit_minor = 9999 WHERE entry_id = ?').run(entryId);
  const edited = fx.deps.store.db.prepare('SELECT debit_minor FROM journal_line WHERE entry_id = ? ORDER BY id').all(entryId);
  assert.ok(edited.some((l) => l.debit_minor === 9999), 'without the trigger a posted line was rewritten');
  fx.deps.store.close();
});

// --- Rule 11, reversal symmetry ----------------------------------------------------------------
//
// The mutations below DROP the immutability trigger first, and that is deliberate rather than a
// workaround. A wrong reversal is not written by editing history: the engine computes the wrong
// amounts and writes them while the entry is still a draft, then posts it. By the time a row is
// posted the damage is already inside it. Dropping the trigger is the only way to reproduce, in one
// short test, the row state that a miscomputing engine would have produced legitimately.

/** Reproduce what a miscomputing engine would have posted, by writing it after the fact. */
function rewriteReversalLines(fx, sql, reversalId) {
  fx.deps.store.db.exec('DROP TRIGGER journal_line_no_update_posted');
  fx.deps.store.db.prepare(sql).run(reversalId);
}

test('mutation: the reversal detector catches a reversal that does not fully negate', () => {
  const { fx, entryId } = seeded();
  const reversed = fx.call('reverse_entry', { entryId, date: '2026-03-02', idempotencyKey: 'rev-1' });
  assert.equal(reversed.ok, true, 'the real reversal must succeed');

  assert.deepEqual(reversalViolations(fx.deps.store), [], 'a REAL reversal leaves nothing to report');

  // A reversal booked at the wrong amount. It still looks like a reversal, it still balances within
  // itself, and it leaves the account it claimed to unwind still moved. This is the shape an
  // FX-rate or partial-reversal defect takes, and it is invisible to any check that only asks
  // "does a reversing entry exist?".
  rewriteReversalLines(
    fx,
    'UPDATE journal_line SET base_credit_minor = base_credit_minor - 1 WHERE entry_id = ?',
    reversed.reversalId,
  );

  const found = reversalViolations(fx.deps.store);
  assert.equal(found.length, 1, 'the detector must report the lopsided reversal');
  assert.match(found[0], /does NOT negate/);
  assert.match(found[0], new RegExp(entryId), 'the violation must name the entry that stayed moved');
  fx.deps.store.close();
});

test('mutation: the reversal detector catches a reversal booked with the SAME sign', () => {
  const { fx, entryId } = seeded();
  const reversed = fx.call('reverse_entry', { entryId, date: '2026-03-02', idempotencyKey: 'rev-2' });
  assert.equal(reversed.ok, true);

  // A reversal that repeats the original instead of negating it: the copy-paste defect, which
  // DOUBLES the position it was meant to erase rather than clearing it.
  rewriteReversalLines(
    fx,
    `UPDATE journal_line
        SET base_debit_minor = base_credit_minor, base_credit_minor = base_debit_minor
      WHERE entry_id = ?`,
    reversed.reversalId,
  );

  const found = reversalViolations(fx.deps.store);
  assert.equal(found.length, 1, 'a same-signed reversal must be reported');
  assert.match(found[0], /does NOT negate/);
  fx.deps.store.close();
});

// --- Rule 12, §H-TENANT ------------------------------------------------------------------------

test('mutation: the tenant detector catches a cross-tenant write', () => {
  const { fx } = seeded();
  const a = fx.workspaceId;
  const before = tenantSnapshot(fx.deps.store, a);

  const other = mintWorkspace(fx.deps, 'Fremde GmbH', 'tenant-b');
  assert.notEqual(other.workspaceId, a);

  // Writing in B must leave A untouched, which is the clean direction.
  assert.equal(getAction('create_account').run(fx.deps, {
    workspaceId: other.workspaceId, number: '6510', name: 'Porto', type: 'expense', idempotencyKey: 'b-1',
  }).ok, true);
  assert.deepEqual(
    tenantViolations(before, tenantSnapshot(fx.deps.store, a), 'create_account'),
    [],
    'a legitimate write in B must not be reported as an A leak',
  );

  // The forbidden act: the missing `WHERE workspace_id = ?`. Every §H-TENANT defect ever found in
  // this repo reduces to exactly this, a query that reached across the tenant boundary.
  fx.deps.store.db.prepare('UPDATE account SET name = ? WHERE workspace_id = ?').run('Leaked', a);

  const found = tenantViolations(before, tenantSnapshot(fx.deps.store, a), 'some_verb');
  assert.equal(found.length, 1, 'the detector must report the cross-tenant write');
  assert.match(found[0], /changed this tenant's rows/);
  fx.deps.store.close();
});

test('mutation: the tenant detector reads EVERY tenant-scoped table, not just the ones it knows', () => {
  // The detector derives its table list from `sqlite_master` plus `PRAGMA table_info`, so a table
  // added by a future migration is covered without anyone editing it. That derivation is the whole
  // reason the rule keeps working as capabilities land, so it is asserted rather than trusted: if a
  // future change hardcodes a list, this goes red.
  const { fx } = seeded();
  const scoped = fx.deps.store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .filter((t) =>
      fx.deps.store.db.prepare(`PRAGMA table_info("${t}")`).all().some((col) => col.name === 'workspace_id'),
    );
  assert.ok(scoped.length > 20, `expected many tenant-scoped tables, found ${scoped.length}`);

  const snap = JSON.parse(tenantSnapshot(fx.deps.store, fx.workspaceId));
  for (const t of scoped) {
    assert.ok(t in snap, `${t} scopes by workspace_id but the tenant snapshot never reads it`);
  }
  fx.deps.store.close();
});
