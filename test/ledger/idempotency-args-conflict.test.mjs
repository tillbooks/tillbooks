/**
 * N01 US-N01.5, §H-IDEMPOTENT "one key, one meaning": the matrix on the money path.
 *
 * Before N01 an idempotency record held only the RESULT of the act it memoised, so a second
 * `post_entry` with the same key and a DIFFERENT amount was answered with the first entry's id: the
 * caller was told "booked" while the books held another booking. The registry now records, per
 * (workspace, verb, caller key), the canonical arguments the key was spent with (`idempotency_args`,
 * written in the act's own transaction) and refuses another call under it BEFORE the verb runs.
 *
 * Every "writes nothing" below is asserted on ROWS, table by table across the whole database, and not
 * on the return value: a refusal that still wrote a row is exactly the failure this guards.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import {
  idempotencyArgsHash,
  idempotencyArgsIdentity,
  canonicalJson,
  differingArgs,
  freeTextFieldsOf,
} from '../../dist/core/store/idempotencyArgs.js';
import { verbArgsHash } from '../../dist/core/agent/argsIdentity.js';
import { APPROVAL_CONFIRMS_FIELD } from '../../dist/core/agent/dialMap.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

const postEntry = getAction('post_entry');
const reverseEntry = getAction('reverse_entry');

/** The row count of every table: the whole database, so a stray write anywhere shows. */
function rowCounts(store) {
  const tables = store.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
  const out = {};
  for (const t of tables) out[t] = store.db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
  return out;
}

function postedEntries(store, workspaceId) {
  return store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted' ORDER BY rowid")
    .all(workspaceId);
}

function debitTotal(store, entryId) {
  return store.db.prepare('SELECT SUM(debit_minor) AS d FROM journal_line WHERE entry_id = ?').get(entryId).d;
}

function setup() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  return { deps, workspaceId, accId };
}

test('same key, same arguments: the replay answers the first result and writes nothing', () => {
  const { deps, workspaceId, accId } = setup();
  const input = { workspaceId, ...manualPost(accId, 'k-same') };
  const first = postEntry.run(deps, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = rowCounts(deps.store);

  const second = postEntry.run(deps, { ...input });
  assert.deepEqual(second, first, 'an identical retry replays the identical result');
  assert.deepEqual(rowCounts(deps.store), before, 'an identical retry wrote a row');
  assert.equal(postedEntries(deps.store, workspaceId).length, 1);
});

test('same key, DIFFERENT arguments: refused idempotency_key_conflict, and not one row written', () => {
  const { deps, workspaceId, accId } = setup();
  const first = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-diff', 5000) });
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = rowCounts(deps.store);

  const second = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-diff', 7000) });
  assert.equal(second.ok, false, 'a different amount under a spent key must not be answered ok');
  assert.equal(second.error, 'idempotency_key_conflict');
  assert.equal(second.idempotencyKey, 'k-diff');
  assert.equal(second.action, 'post_entry');
  assert.deepEqual(second.fields, ['lines'], 'the refusal names the argument that differs');
  assert.match(second.reason, /^Same key, different lines\. If this is the same act, resend the original arguments; only a genuinely different act takes a new key\.$/);
  assert.equal(second.entryId, undefined, 'the refusal must not hand back the first entry as if it were this one');
  assert.deepEqual(rowCounts(deps.store), before, 'the refused call wrote a row');

  const entries = postedEntries(deps.store, workspaceId);
  assert.equal(entries.length, 1, 'the ledger holds the first booking only');
  assert.equal(debitTotal(deps.store, entries[0].id), 5000, 'and at its first amount');

  // The first arguments still replay after the refusal: the key keeps its one meaning.
  const third = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-diff', 5000) });
  assert.deepEqual(third, first);
});

test('every kind of argument difference refuses: account, date, description, line order, an extra field', () => {
  const { deps, workspaceId, accId } = setup();
  const base = { workspaceId, ...manualPost(accId, 'k-each') };
  assert.equal(postEntry.run(deps, base).ok, true);
  const before = rowCounts(deps.store);
  const variants = {
    account: { ...base, lines: [{ account: accId('1020'), debit: 5000 }, { account: accId('1000'), credit: 5000 }] },
    date: { ...base, date: '2026-03-02' },
    description: { ...base, description: 'Etwas anderes' },
    lineOrder: { ...base, lines: [base.lines[1], base.lines[0]] },
    extraField: { ...base, ref: 'B-77' },
    descriptionDropped: (({ description: _d, ...rest }) => rest)(base),
  };
  for (const [label, input] of Object.entries(variants)) {
    const res = postEntry.run(deps, input);
    assert.equal(res.ok, false, `${label}: must refuse`);
    assert.equal(res.error, 'idempotency_key_conflict', `${label}: ${JSON.stringify(res)}`);
  }
  assert.deepEqual(rowCounts(deps.store), before, 'a refused variant wrote a row');
});

test('key order is not meaning: the same arguments in another key order replay', () => {
  const { deps, workspaceId, accId } = setup();
  const input = { workspaceId, ...manualPost(accId, 'k-order') };
  const first = postEntry.run(deps, input);
  assert.equal(first.ok, true);
  const reordered = {
    lines: input.lines.map((l) => Object.fromEntries(Object.entries(l).reverse())),
    idempotencyKey: input.idempotencyKey,
    source: input.source,
    description: input.description,
    date: input.date,
    workspaceId,
  };
  const before = rowCounts(deps.store);
  assert.deepEqual(postEntry.run(deps, reordered), first);
  assert.deepEqual(rowCounts(deps.store), before);
});

test('transport-only fields are not arguments (dryRun, agentReason)', () => {
  const { deps, workspaceId, accId } = setup();
  const input = { workspaceId, ...manualPost(accId, 'k-transport') };
  const first = postEntry.run(deps, input);
  assert.equal(first.ok, true);
  const before = rowCounts(deps.store);
  assert.deepEqual(postEntry.run(deps, { ...input, agentReason: 'Wiederholung nach Zeitüberschreitung' }), first);
  assert.deepEqual(postEntry.run(deps, { ...input, dryRun: false }), first);
  assert.deepEqual(rowCounts(deps.store), before);
});

test('free text (idempotency.hash_free_text): exclude by default replays a reworded reason; include refuses it', () => {
  const { deps, workspaceId } = setup();
  const lock = getAction('lock_period');
  const studio = { ...deps, actor: 'studio' };
  const input = { workspaceId, period: '2026-01', kind: 'soft', reason: 'Monatsabschluss', idempotencyKey: 'k-lock' };
  const first = lock.run(studio, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = rowCounts(deps.store);
  assert.deepEqual(lock.run(studio, { ...input, reason: 'Monatsabschluss Januar' }), first, 'the default compares no free text');
  // Every other argument is compared whatever the setting says.
  assert.equal(lock.run(studio, { ...input, kind: 'hard' }).error, 'idempotency_key_conflict');

  assert.equal(getAction('settings_set').run(studio, { workspaceId, key: 'idempotency.hash_free_text', value: 'include', reason: 'Begründungen zählen', idempotencyKey: 'k-set' }).ok, true);
  const after = rowCounts(deps.store);
  const reworded = lock.run(studio, { ...input, reason: 'Monatsabschluss Januar' });
  assert.equal(reworded.error, 'idempotency_key_conflict', JSON.stringify(reworded));
  assert.deepEqual(reworded.fields, ['reason']);
  assert.deepEqual(lock.run(studio, input), first, 'the identical call still replays');
  assert.deepEqual(rowCounts(deps.store), after);
  assert.ok(after.workspace_setting >= before.workspace_setting);
});

test('a key spent before N01 (no argument record) replays exactly as before, even for different arguments', () => {
  const { deps, workspaceId, accId } = setup();
  const first = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-legacy', 5000) });
  assert.equal(first.ok, true);
  // A key spent before N01 has no argument record.
  const cleared = deps.store.db
    .prepare("DELETE FROM idempotency_args WHERE workspace_id = ? AND verb = 'post_entry' AND caller_key = 'k-legacy'")
    .run(workspaceId);
  assert.equal(cleared.changes, 1, 'the fixture must have found the record it simulates as legacy');
  const before = rowCounts(deps.store);

  const second = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-legacy', 7000) });
  assert.deepEqual(second, first, 'no migration of history: a hashless record replays');
  assert.deepEqual(rowCounts(deps.store), before);
});

test('a record of another canonical-form version compares as absent and replays', () => {
  const { deps, workspaceId, accId } = setup();
  const first = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-version', 5000) });
  assert.equal(first.ok, true);
  deps.store.db
    .prepare("UPDATE idempotency_args SET args_hash = 'c0:abc' WHERE workspace_id = ? AND verb = 'post_entry' AND caller_key = 'k-version'")
    .run(workspaceId);
  assert.deepEqual(postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-version', 7000) }), first);
});

test('the record stores the canonical argument hash of the call that spent the key', () => {
  const { deps, workspaceId, accId } = setup();
  const input = { workspaceId, ...manualPost(accId, 'k-stored') };
  assert.equal(postEntry.run(deps, input).ok, true);
  const rows = deps.store.db
    .prepare("SELECT verb, caller_key, args_hash, field_hashes_json FROM idempotency_args WHERE workspace_id = ?")
    .all(workspaceId);
  assert.equal(rows.length, 1, 'one record per (workspace, verb, caller key)');
  const row = rows[0];
  assert.deepEqual([row.verb, row.caller_key], ['post_entry', 'k-stored']);
  assert.equal(row.args_hash, verbArgsHash('post_entry', input));
  assert.equal(row.args_hash, idempotencyArgsHash(input), 'post_entry has no approval-confirms field');
  assert.match(row.args_hash, /^c1:[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(JSON.parse(row.field_hashes_json)).sort(), ['date', 'description', 'lines', 'source']);
});

test('no false positives: a new key with new arguments posts, and a refused first call does not spend its key', () => {
  const { deps, workspaceId, accId } = setup();
  assert.equal(postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-a', 5000) }).ok, true);
  assert.equal(postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-b', 7000) }).ok, true);

  // Unbalanced: refused before anything is memoised, so the corrected call may use the same key.
  const unbalanced = { workspaceId, ...manualPost(accId, 'k-fix', 5000) };
  unbalanced.lines = [unbalanced.lines[0], { account: accId('1000'), credit: 4000 }];
  const refused = postEntry.run(deps, unbalanced);
  assert.equal(refused.ok, false);
  assert.notEqual(refused.error, 'idempotency_key_conflict');
  const fixed = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-fix', 5000) });
  assert.equal(fixed.ok, true, JSON.stringify(fixed));
  assert.equal(postedEntries(deps.store, workspaceId).length, 3);
});

test('the same key on ANOTHER verb is that verb\'s own record, not a conflict', () => {
  const { deps, workspaceId, accId } = setup();
  const posted = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-shared') });
  assert.equal(posted.ok, true);
  const reversed = reverseEntry.run(deps, { workspaceId, entryId: posted.entryId, idempotencyKey: 'k-shared' });
  assert.equal(reversed.ok, true, JSON.stringify(reversed));
});

test('a verb that RESCOPES its own memo key is compared all the same (the record is the registry\'s)', () => {
  // reverse_entry files its memo under `JSON.stringify([entryId, K])` and replays from the reversal row;
  // the registry's record is keyed by the caller's K, so neither shape matters.
  const { deps, workspaceId, accId } = setup();
  const posted = postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-post') });
  assert.equal(posted.ok, true);
  const input = { workspaceId, entryId: posted.entryId, idempotencyKey: 'k-rev', description: 'Storno Büromaterial' };
  const first = reverseEntry.run(deps, input);
  assert.equal(first.ok, true, JSON.stringify(first));
  const before = rowCounts(deps.store);
  assert.deepEqual(reverseEntry.run(deps, { ...input }), first, 'an identical retry replays');
  const conflict = reverseEntry.run(deps, { ...input, description: 'Storno, anderer Text' });
  assert.equal(conflict.error, 'idempotency_key_conflict', JSON.stringify(conflict));
  assert.deepEqual(conflict.fields, ['description']);
  assert.deepEqual(reverseEntry.run(deps, { ...input, date: '2026-04-01' }).fields, ['date']);
  assert.deepEqual(rowCounts(deps.store), before);
});

test('the argument record commits with the act and only with it', () => {
  const { deps, workspaceId, accId } = setup();
  const record = (key) =>
    deps.store.db.prepare('SELECT COUNT(*) AS n FROM idempotency_args WHERE workspace_id = ? AND caller_key = ?').get(workspaceId, key).n;
  // Refused before anything is written: no record, the key stays free.
  const unbalanced = { workspaceId, ...manualPost(accId, 'k-commit') };
  unbalanced.lines = [unbalanced.lines[0], { account: accId('1000'), credit: 1 }];
  assert.equal(postEntry.run(deps, unbalanced).ok, false);
  assert.equal(record('k-commit'), 0);
  // The act commits: so does its record.
  assert.equal(postEntry.run(deps, { workspaceId, ...manualPost(accId, 'k-commit') }).ok, true);
  assert.equal(record('k-commit'), 1);
});

// --- The canonical form, decided once (src/core/store/idempotencyArgs.ts) ---------------------------

test('canonical form: key order is ignored at every depth, array order is kept', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  assert.equal(canonicalJson({ lines: [{ y: 1, x: 2 }] }), '{"lines":[{"x":2,"y":1}]}');
  assert.notEqual(idempotencyArgsHash({ l: [1, 2] }), idempotencyArgsHash({ l: [2, 1] }));
});

test('canonical form: absent and undefined are the same, null and an explicit default are not', () => {
  assert.equal(idempotencyArgsHash({ a: 1 }), idempotencyArgsHash({ a: 1, b: undefined }));
  assert.notEqual(idempotencyArgsHash({ a: 1 }), idempotencyArgsHash({ a: 1, b: null }));
  // `source: 'manual'` sent versus left out: the literal input is the identity, not the engine default.
  assert.notEqual(idempotencyArgsHash({ a: 1 }), idempotencyArgsHash({ a: 1, currency: 'CHF' }));
});

test('canonical form: identity and transport fields are excluded; free text is hashed and compared by policy', () => {
  const h = idempotencyArgsHash({ a: 1 });
  assert.equal(idempotencyArgsHash({ a: 1, workspaceId: 'w1', idempotencyKey: 'k' }), h);
  assert.equal(idempotencyArgsHash({ a: 1, dryRun: true }), h);
  assert.equal(idempotencyArgsHash({ a: 1, agentReason: 'weil' }), h);
  const x = idempotencyArgsIdentity({ a: 1, reason: 'x' });
  const y = idempotencyArgsIdentity({ a: 1, reason: 'y' });
  assert.ok(x.fieldHashes.reason, 'the reason is stored, so the setting can change without a rewrite');
  assert.deepEqual(differingArgs(x, y, ['reason']), [], 'excluded as free text');
  assert.deepEqual(differingArgs(x, y, []), ['reason'], 'compared otherwise');
  assert.deepEqual(differingArgs(x, idempotencyArgsIdentity({ a: 2, reason: 'y' }), ['reason']), ['a']);
});

test('per verb: the approval-confirms field is transport for exactly the verbs whose approval injects it', () => {
  const confirmVerbs = Object.entries(APPROVAL_CONFIRMS_FIELD);
  assert.ok(confirmVerbs.length > 10, 'the map must be the real one');
  for (const [verb, field] of confirmVerbs) {
    assert.equal(
      verbArgsHash(verb, { a: 1, [field]: true }),
      verbArgsHash(verb, { a: 1 }),
      `${verb}: an approved replay (with ${field}) must hash like the drafted call (without it)`,
    );
  }
  // On a verb without such a field the flag is an ordinary argument.
  assert.notEqual(verbArgsHash('post_entry', { a: 1, confirmed: true }), verbArgsHash('post_entry', { a: 1 }));
});

test('the comparator says exactly what the module note says', () => {
  const a = idempotencyArgsIdentity({ a: 1, b: 2 });
  assert.deepEqual(differingArgs(a, a, []), []);
  assert.deepEqual(differingArgs(a, idempotencyArgsIdentity({ a: 1 }), []), ['b'], 'a dropped field differs');
  assert.deepEqual(differingArgs(a, idempotencyArgsIdentity({ a: 1, b: 2, c: 3 }), []), ['c'], 'an added field differs');
  assert.deepEqual(differingArgs({ argsHash: 'c0:old', fieldHashes: {} }, a, []), [], 'another version compares as absent');
});

test('free text is declared PER VERB by its schema: a plain-string reason is free text, a coded (enum) reason never is', () => {
  // `getAction` above loaded the registry, which declared every verb.
  assert.deepEqual(freeTextFieldsOf('lock_period'), ['reason'], 'a lock reason is the operator\'s own words');
  assert.deepEqual(freeTextFieldsOf('create_credit_note'), ['reason']);
  for (const coded of ['ignore_bank_line', 'provision_create', 'stock_move']) {
    assert.deepEqual(freeTextFieldsOf(coded), [], `${coded}: its reason is a closed code`);
    assert.ok(Array.isArray(getAction(coded).inputSchema.properties.reason.enum), `${coded}: the schema carries the enum`);
  }
  assert.deepEqual(freeTextFieldsOf('post_entry'), [], 'a verb without a reason has no free text');
  assert.deepEqual(freeTextFieldsOf('no_such_verb'), [], 'an undeclared verb compares everything');
});
