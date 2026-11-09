/**
 * K-15 (round 3): the adapter/encoding/delimiter OVERRIDE on `migration_discover_source`.
 *
 * Round 2 landed the reason display and a retry-as-is. The residual this suite proves: when the
 * auto-detected adapter, text encoding or delimiter is WRONG, the operator can FORCE the right one and
 * the file then classifies under the forced format, instead of being re-run identically to no effect.
 *
 * The invariants this pins, and why each earns its place:
 *   - NO override == byte-for-byte the old auto-detection (the round-2 behaviour is untouched for every
 *     caller that passes no override, and an empty override is the same as none).
 *   - A forced ENCODING re-decodes a legacy single-byte export that UTF-8 turned to mojibake.
 *   - A forced DELIMITER parses with exactly that separator, correcting a wrong sniff.
 *   - A forced ADAPTER classifies the file under the chosen format, so a bexio/Banana export detected
 *     as generic csv can be pinned to its vendor adapter.
 *   - A garbage override value is a STRUCTURED refusal (`invalid_input`) naming the field, never a
 *     silent wrong parse (P9).
 *   - The REST twin carries the param identically (proved through `handleRest`, the second face).
 *   - §H-TENANT still bites: an override never turns a foreign fileId into a readable one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const run = (deps, name, input) => getAction(name).run(deps, input);
const must = (res, what) => {
  assert.equal(res.ok, true, `${what} failed: ${JSON.stringify(res)}`);
  return res;
};

/** Upload raw bytes as an E00 blob and return its fileId. */
function uploadBytes(deps, workspaceId, name, bytes, mime = 'text/csv') {
  const up = must(
    run(deps, 'files_upload', {
      workspaceId,
      filename: name,
      mime,
      contentBase64: Buffer.from(bytes).toString('base64'),
      idempotencyKey: `up-${name}-${Math.random()}`,
    }),
    `files_upload ${name}`,
  );
  return up.file.id;
}

/** A CSV whose header carries a latin1-encoded `ä` (0xE4): UTF-8 turns it to a replacement char. */
function latin1Csv() {
  // `Name,Währung\nMuster,100\n` with the `ä` byte as 0xE4 (windows-1252 / latin1), not UTF-8.
  return Buffer.concat([
    Buffer.from('Name,W', 'latin1'),
    Buffer.from([0xe4]), // ä in latin1
    Buffer.from('hrung\nMuster,100\n', 'latin1'),
  ]);
}

test('K-15: NO override leaves detection byte-for-byte unchanged (and an empty override is the same)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const id = uploadBytes(deps, workspaceId, 'contacts.csv', 'Name;Ort\nMuster AG;Bern\n');

  const base = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [id] }), 'discover no override');
  const empty = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: {} }), 'discover empty override');

  assert.equal(base.files.length, 1);
  assert.equal(base.files[0].adapter, 'csv', 'auto adapter is the generic csv');
  assert.deepEqual(base.files[0].headers, ['Name', 'Ort'], 'the semicolon delimiter was auto-detected');
  assert.equal(base.files[0].rowCount, 1);
  // An empty override changes nothing: it is the same result as no override at all.
  assert.deepEqual(empty.files[0].headers, base.files[0].headers);
  assert.equal(empty.files[0].adapter, base.files[0].adapter);
  assert.deepEqual(empty.failures, base.failures);
});

test('K-15: a forced ENCODING re-decodes a legacy single-byte export UTF-8 got wrong', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const id = uploadBytes(deps, workspaceId, 'legacy.csv', latin1Csv());

  const auto = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [id] }), 'discover auto (utf-8)');
  const forced = must(
    run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: { encoding: 'latin1' } }),
    'discover forced latin1',
  );

  // Auto-decoding as UTF-8 turns the lone 0xE4 into the replacement character U+FFFD (mojibake).
  assert.ok(auto.files[0].headers.some((h) => h.includes('�')), 'UTF-8 auto-decode produced mojibake');
  assert.ok(!auto.files[0].headers.includes('Währung'), 'the correct header is NOT recovered under UTF-8');
  // Forcing latin1 recovers the real header text; the row structure is unchanged.
  assert.deepEqual(forced.files[0].headers, ['Name', 'Währung'], 'the forced encoding recovers the umlaut');
  assert.equal(forced.files[0].rowCount, 1);
});

test('K-15: a forced DELIMITER parses with exactly that separator, correcting a wrong sniff', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  // Header `Name;Nachname,Ort`: the sniffer ties and picks comma (declared first), splitting it into
  // ['Name;Nachname', 'Ort']. The intended separator is the semicolon.
  const id = uploadBytes(deps, workspaceId, 'ambiguous.csv', 'Name;Nachname,Ort\nMuster;AG,Bern\n');

  const auto = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [id] }), 'discover auto');
  const forced = must(
    run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: { delimiter: 'semicolon' } }),
    'discover forced semicolon',
  );

  assert.deepEqual(auto.files[0].headers, ['Name;Nachname', 'Ort'], 'auto sniff picked comma');
  assert.deepEqual(forced.files[0].headers, ['Name', 'Nachname,Ort'], 'the forced delimiter split on the semicolon');
  assert.notDeepEqual(forced.files[0].headers, auto.files[0].headers);
});

test('K-15: a forced ADAPTER classifies the file under the chosen vendor format', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const id = uploadBytes(deps, workspaceId, 'bex.csv', 'Name;Ort\nMuster AG;Bern\n');

  const auto = must(run(deps, 'migration_discover_source', { workspaceId, fileIds: [id] }), 'discover auto');
  const forced = must(
    run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: { adapter: 'bexio_csv' } }),
    'discover forced bexio_csv',
  );

  assert.equal(auto.files[0].adapter, 'csv', 'auto reports the generic csv adapter');
  assert.equal(forced.files[0].adapter, 'bexio_csv', 'the forced adapter is reported');
  // A forced adapter that the file cannot parse is a structured per-file failure, not a throw.
  const xlsxForced = must(
    run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: { adapter: 'xlsx' } }),
    'discover forced xlsx on a csv (call itself ok)',
  );
  assert.equal(xlsxForced.files.length, 0, 'forcing xlsx on a csv classifies nothing');
  assert.equal(xlsxForced.failures[0].error, 'source_unparseable', 'it is a per-file source_unparseable');
});

test('K-15: a forced adapter links the plan Beleg under the forced adapter (US-G09.8)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const id = uploadBytes(deps, workspaceId, 'bex.csv', 'Name;Ort\nMuster AG;Bern\n');
  const planId = must(
    run(deps, 'migration_create_plan', { workspaceId, sourceSystem: 'csv', cutoverDate: '2020-01-01', idempotencyKey: 'k15-plan' }),
    'create plan',
  ).planId;

  must(run(deps, 'migration_discover_source', { workspaceId, planId, fileIds: [id], override: { adapter: 'bexio_csv' } }), 'discover forced with plan');
  const linked = deps.store.db
    .prepare('SELECT adapter FROM migration_source_file WHERE workspace_id = ? AND plan_id = ? AND file_id = ?')
    .get(workspaceId, planId, id);
  assert.equal(linked.adapter, 'bexio_csv', 'the Beleg link records the forced adapter, not the plan default');
});

test('K-15: a garbage override value is a structured invalid_input naming the field', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const id = uploadBytes(deps, workspaceId, 'c.csv', 'A,B\n1,2\n');

  const badAdapter = run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: { adapter: 'not_a_real_adapter' } });
  assert.equal(badAdapter.ok, false);
  assert.equal(badAdapter.error, 'invalid_input');
  assert.equal(badAdapter.field, 'override.adapter');

  const badEnc = run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: { encoding: 'ebcdic' } });
  assert.equal(badEnc.ok, false);
  assert.equal(badEnc.error, 'invalid_input');
  assert.equal(badEnc.field, 'override.encoding');

  const badDelim = run(deps, 'migration_discover_source', { workspaceId, fileIds: [id], override: { delimiter: 'pipe' } });
  assert.equal(badDelim.ok, false);
  assert.equal(badDelim.error, 'invalid_input');
  assert.equal(badDelim.field, 'override.delimiter');
});

test('K-15: the REST twin carries the override identically (handleRest, the second face)', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const id = uploadBytes(deps, workspaceId, 'legacy.csv', latin1Csv());

  const rest = handleRest('migration_discover_source', { workspaceId, fileIds: [id], override: { encoding: 'latin1' } }, deps);
  assert.equal(rest.status, 200);
  assert.equal(rest.body.ok, true);
  assert.deepEqual(rest.body.files[0].headers, ['Name', 'Währung'], 'REST forces the encoding exactly as MCP does');

  // A garbage override is a domain rejection (422), never an MCP/HTTP-shaped throw.
  const badRest = handleRest('migration_discover_source', { workspaceId, fileIds: [id], override: { delimiter: 'pipe' } }, deps);
  assert.equal(badRest.status, 422);
  assert.equal(badRest.body.ok, false);
  assert.equal(badRest.body.error, 'invalid_input');
});

test('K-15 §H-TENANT: an override never turns a foreign fileId into a readable one', () => {
  const deps = freshDeps();
  const { workspaceId: wsA } = mintWorkspace(deps, 'Alpha GmbH', 'ws-a');
  const { workspaceId: wsB } = mintWorkspace(deps, 'Beta GmbH', 'ws-b');
  const idB = uploadBytes(deps, wsB, 'legacy.csv', latin1Csv());

  const disc = must(
    run(deps, 'migration_discover_source', { workspaceId: wsA, fileIds: [idB], override: { encoding: 'latin1', adapter: 'bexio_csv' } }),
    'cross-tenant discover call itself returns ok',
  );
  assert.equal(disc.files.length, 0, 'no cross-tenant file classified, override or not');
  assert.equal(disc.failures[0].error, 'source_integrity_mismatch', 'the foreign fileId is refused before any parse');
});
