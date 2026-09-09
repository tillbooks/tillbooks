// E00, the one irreversible verb: P8 staging, the blob erasure, and the audit row.
//
// `files_delete` is the only thing in E00 that cannot be undone, and the actor that reaches it most
// often is an autonomous one. So the questions asserted here are the three that a delete has to answer
// separately, and confusing any two of them would be a real defect:
//
//   MAY this actor delete at all? (A24, at the registry boundary, not here.)
//   HAS a human said so on this occasion? (P8, and an agent gets `staged:true` if not.)
//   DOES anything forbid it? (retention, and the chain.)
//
// The blob accounting is the part with no return value to trust: "the bytes are gone" and "the bytes
// another filing still needs are NOT gone" are both statements about rows.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  uploadFile,
  updateFile,
  newFileVersion,
  deleteFile,
  searchFiles,
  getFileContent,
} from '../../dist/core/files/index.js';
import { setup, asActor, newWorkspace, b64, counts } from './support.mjs';

const file = (ctx, seed, content = `inhalt ${seed}`) =>
  uploadFile(ctx, { title: seed, filename: `${seed}.pdf`, contentBase64: b64(content), idempotencyKey: `u-${seed}` })
    .file;

// --- P8: an agent stages, a human deletes ------------------------------------------------------

test('an AGENT delete stages the row and erases nothing', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'notiz');
  const agent = asActor(fixture, 'agent');

  const res = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'd-1' });
  assert.equal(res.ok, true, 'staging is a success, not a refusal: the request was accepted');
  assert.equal(res.staged, true);
  assert.equal(res.deleted, undefined);
  assert.equal(res.reason, 'irreversible_delete_requires_confirmation');

  const after = counts(fixture.store, fixture.workspaceId);
  assert.equal(after.files, 1, 'nothing was erased');
  assert.equal(after.blobs, 1);
  // The badge the operator sees is this flag, and it reaches the Studio through the ordinary read.
  assert.equal(searchFiles(fixture.ctx, {}).files[0].pendingDelete, true);
  // And the file is still readable while it waits, which is what makes the badge reviewable.
  assert.equal(getFileContent(fixture.ctx, { fileId: beleg.id }).ok, true);
});

test('an agent that passes confirmed=true really deletes', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'notiz');
  const agent = asActor(fixture, 'agent');
  const res = deleteFile(agent, { fileId: beleg.id, confirmed: true, idempotencyKey: 'd-1' });
  assert.equal(res.ok, true);
  assert.equal(res.deleted, true);
  assert.equal(res.staged, undefined);
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 0);
});

test('a HUMAN at the Studio deletes directly, with no staging step', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'notiz');
  // A confirm dialog the operator already clicked is not made safer by a second flag, and a Studio that
  // had to pass one would be lying about who is deciding.
  const res = deleteFile(fixture.ctx, { fileId: beleg.id, idempotencyKey: 'd-1' });
  assert.equal(res.deleted, true);
  assert.equal(res.staged, undefined);
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 0);
});

test('the staged flag is cleared through the ordinary edit, which is the badge Cancel', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'notiz');
  deleteFile(asActor(fixture, 'agent'), { fileId: beleg.id, idempotencyKey: 'd-1' });
  const cancelled = updateFile(fixture.ctx, {
    fileId: beleg.id,
    patch: { pendingDelete: false },
    idempotencyKey: 'c-1',
  });
  assert.equal(cancelled.file.pendingDelete, false);
});

test('a replayed agent delete stages once and answers identically', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'notiz');
  const agent = asActor(fixture, 'agent');
  const first = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'd-1' });
  const replay = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'd-1' });
  assert.deepEqual(replay, first);
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 1);
});

test('F5: the CONFIRM under the same idempotency key completes the erasure', () => {
  // THE DEFECT: the staged answer was remembered under `[fileId, key]`, so a confirm arriving under the
  // same key replayed "staged" and the file survived, while the identical call under a FRESH key erased
  // it. The staged payload's own `reason` invites exactly that retry, and nothing in the verb summary or
  // the schema said the confirm needed a new key, so the shape encouraged the failure it produced.
  const fixture = setup();
  const beleg = file(fixture.ctx, 'zweistufig');
  const agent = asActor(fixture, 'agent');

  const staged = deleteFile(agent, { fileId: beleg.id, idempotencyKey: 'd-1' });
  assert.equal(staged.staged, true);
  assert.deepEqual(staged.confirmWith, { fileId: beleg.id, confirmed: true }, 'the answer says what to send');
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 1);

  const confirmed = deleteFile(agent, { fileId: beleg.id, confirmed: true, idempotencyKey: 'd-1' });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.deleted, true, 'this replayed {staged:true} and the file survived');
  assert.equal(confirmed.staged, undefined);
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 0);
  assert.equal(counts(fixture.store, fixture.workspaceId).blobs, 0);
});

test('F5: each of the two calls is still replay-safe on its own, on ROWS', () => {
  // Folding `confirmed` into the key must not cost the idempotency guarantee either half had: a
  // repeated stage still stages once, and a repeated confirm still erases once and answers the same.
  const fixture = setup();
  const one = file(fixture.ctx, 'wiederholt');
  const agent = asActor(fixture, 'agent');

  const firstStage = deleteFile(agent, { fileId: one.id, idempotencyKey: 'k' });
  assert.deepEqual(deleteFile(agent, { fileId: one.id, idempotencyKey: 'k' }), firstStage);

  const firstConfirm = deleteFile(agent, { fileId: one.id, confirmed: true, idempotencyKey: 'k' });
  assert.equal(firstConfirm.deleted, true);
  // The replay answers the original result rather than `not_found` on the row it removed itself.
  assert.deepEqual(deleteFile(agent, { fileId: one.id, confirmed: true, idempotencyKey: 'k' }), firstConfirm);
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 0);
});

test('a stale staged answer does not outlive the file it staged', () => {
  // `{staged: true}` is a promise that a deletion is PENDING on a row that is still there. Stage under
  // one key, erase through a different path (here a human at the Studio, whose delete is direct), then
  // replay the stage: the honest answer is `not_found`, not a pending deletion of nothing. The
  // completed-erasure replay in the test above is unchanged; only the staged shape re-checks.
  const fixture = setup();
  const one = file(fixture.ctx, 'überholt');
  const agent = asActor(fixture, 'agent');

  const staged = deleteFile(agent, { fileId: one.id, idempotencyKey: 'stage-k' });
  assert.equal(staged.staged, true);
  assert.equal(deleteFile(fixture.ctx, { fileId: one.id, idempotencyKey: 'studio-k' }).deleted, true);

  const replayed = deleteFile(agent, { fileId: one.id, idempotencyKey: 'stage-k' });
  assert.equal(replayed.ok, false);
  assert.equal(replayed.error, 'not_found', 'the replay must not report a pending deletion of nothing');
  assert.equal(replayed.staged, undefined);
});

// --- The erasure -------------------------------------------------------------------------------

test('a delete erases the metadata AND the bytes, in one transaction', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'weg');
  assert.equal(counts(fixture.store, fixture.workspaceId).blobs, 1);

  const res = deleteFile(fixture.ctx, { fileId: beleg.id, idempotencyKey: 'd-1' });
  assert.equal(res.sha256, beleg.sha256, 'the answer names what was erased');
  const after = counts(fixture.store, fixture.workspaceId);
  assert.equal(after.files, 0);
  assert.equal(after.blobs, 0, 'the revDSG erasure duty is honoured on the bytes, not only on the row');
});

test('a blob another filing still references is NOT erased', () => {
  const fixture = setup();
  // Two separate filings of identical bytes share one content-addressed blob. Deleting one must not
  // take the other's only copy with it, which is the case a naive "delete the blob too" would break
  // and which no return value would reveal: the survivor's row would look perfectly healthy.
  const a = uploadFile(fixture.ctx, { title: 'Kopie A', contentBase64: b64('gleich'), idempotencyKey: 'a' }).file;
  const b = uploadFile(fixture.ctx, { title: 'Kopie B', contentBase64: b64('gleich'), idempotencyKey: 'b' }).file;
  assert.equal(a.sha256, b.sha256);
  assert.equal(counts(fixture.store, fixture.workspaceId).blobs, 1);

  deleteFile(fixture.ctx, { fileId: a.id, idempotencyKey: 'd-1' });
  const after = counts(fixture.store, fixture.workspaceId);
  assert.equal(after.files, 1);
  assert.equal(after.blobs, 1);
  // And the survivor still READS, checksum verified, which is the claim that matters.
  const read = getFileContent(fixture.ctx, { fileId: b.id });
  assert.equal(read.ok, true);
  assert.equal(Buffer.from(read.contentBase64, 'base64').toString('utf8'), 'gleich');
});

test('a version that something supersedes may not be deleted out from under its successor', () => {
  const fixture = setup();
  const v1 = file(fixture.ctx, 'kette');
  const v2 = newFileVersion(fixture.ctx, { fileId: v1.id, contentBase64: b64('zwei'), idempotencyKey: 'v' }).file;

  const res = deleteFile(fixture.ctx, { fileId: v1.id, idempotencyKey: 'd-1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_head_version');
  assert.equal(res.supersededBy, v2.id);

  // Unguarded, this would leave v2 pointing at a row that is not there and put a hole in the middle of
  // the history an auditor reads, with nothing recording that it happened.
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 2);
});

test('a chain is dismantled newest-first, and each erasure takes its own blob', () => {
  const fixture = setup();
  const v1 = file(fixture.ctx, 'kette');
  const v2 = newFileVersion(fixture.ctx, { fileId: v1.id, contentBase64: b64('zwei'), idempotencyKey: 'v' }).file;
  assert.equal(counts(fixture.store, fixture.workspaceId).blobs, 2);

  assert.equal(deleteFile(fixture.ctx, { fileId: v2.id, idempotencyKey: 'd2' }).deleted, true);
  assert.equal(counts(fixture.store, fixture.workspaceId).blobs, 1);
  // v1 is the head again now that nothing supersedes it, so it may go too.
  assert.equal(deleteFile(fixture.ctx, { fileId: v1.id, idempotencyKey: 'd1' }).deleted, true);
  const after = counts(fixture.store, fixture.workspaceId);
  assert.equal(after.files, 0);
  assert.equal(after.blobs, 0);
});

// --- The audit row -----------------------------------------------------------------------------

test('an erasure stamps the A03 chain, and a STAGING does not', () => {
  const fixture = setup();
  const staged = file(fixture.ctx, 'vorgemerkt');
  const erased = file(fixture.ctx, 'gelöscht');

  deleteFile(asActor(fixture, 'agent'), { fileId: staged.id, idempotencyKey: 's' });
  assert.deepEqual(fixture.audit.events, [], 'staging changes no record, so it stamps nothing');

  deleteFile(fixture.ctx, { fileId: erased.id, idempotencyKey: 'd' });
  assert.deepEqual(
    fixture.audit.events.map((e) => [e.entityKind, e.action, e.actor]),
    [['stored_file', 'file_delete', 'studio']],
  );
  assert.equal(fixture.audit.events[0].entityId, erased.id);
});

test('a replayed erasure stamps ONE audit row', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'einmal');
  deleteFile(fixture.ctx, { fileId: beleg.id, idempotencyKey: 'd-1' });
  deleteFile(fixture.ctx, { fileId: beleg.id, idempotencyKey: 'd-1' });
  // The chain has no uniqueness constraint of any kind, so a verb that re-ran instead of replaying
  // would leave two erasure events for one erasure and nothing would complain.
  assert.equal(fixture.audit.events.length, 1);
});

// --- Tenancy -----------------------------------------------------------------------------------

test('a foreign tenant cannot delete, and cannot learn that the file exists', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'unser');
  const other = newWorkspace(fixture.deps, 'Nachbar GmbH');

  const res = deleteFile(other, { fileId: beleg.id, idempotencyKey: 'd-1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found', 'the same answer a nonexistent id gets');
  assert.equal(counts(fixture.store, fixture.workspaceId).files, 1);
});

test('a delete without an idempotency key still works, and is still transactional', () => {
  const fixture = setup();
  const beleg = file(fixture.ctx, 'ohne Schlüssel');
  const res = deleteFile(fixture.ctx, { fileId: beleg.id });
  assert.equal(res.deleted, true);
  const after = counts(fixture.store, fixture.workspaceId);
  assert.equal(after.files, 0);
  assert.equal(after.blobs, 0);
});
