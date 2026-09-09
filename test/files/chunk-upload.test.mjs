// G18 US-G18.4, the E00 chunk-upload lane: begin -> chunk (ordered) -> commit, verifying the
// accumulated sha256, minting a blob under a migration-class ceiling of 500 MB while the single-call
// bound stays 25 MiB. Proven ON ROWS (a sha mismatch mints nothing; an abandoned session leaves no
// phantom blob; a neighbour tenant cannot touch the session), the E00 house rule for every claim here.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  fileUploadBegin,
  fileUploadChunk,
  fileUploadCommit,
  getFileContent,
  readBlobByteSource,
  fileIsStreamOnly,
  uploadFile,
  MAX_FILE_BYTES,
} from '../../dist/core/files/index.js';
import { setup, newWorkspace, atTime } from './support.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function collect(gen) {
  const parts = [];
  for await (const c of gen) parts.push(Buffer.from(c));
  return Buffer.concat(parts);
}

test('a small file round-trips through the chunk lane and reads back base64', async () => {
  const { ctx } = setup();
  const body = Buffer.from('Konto;Soll;Haben\n1000;100;0\n2000;0;100\n', 'utf8');
  const begin = fileUploadBegin(ctx, { name: 'gl.csv', mediaType: 'text/csv', sizeBytes: body.byteLength, intent: 'migration_source' });
  assert.equal(begin.ok, true);
  const half = Math.ceil(body.byteLength / 2);
  const c0 = fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 0, contentBase64: body.subarray(0, half).toString('base64') });
  assert.equal(c0.ok, true);
  const c1 = fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 1, contentBase64: body.subarray(half).toString('base64') });
  assert.equal(c1.ok, true);
  const commit = fileUploadCommit(ctx, { uploadId: begin.uploadId, sha256: sha(body) });
  assert.equal(commit.ok, true, JSON.stringify(commit));
  const fileId = commit.file.id;
  // Under the single-call bound: served base64 the ordinary way.
  const read = getFileContent(ctx, { fileId });
  assert.equal(read.ok, true);
  assert.equal(Buffer.from(read.contentBase64, 'base64').toString('utf8'), body.toString('utf8'));
  assert.equal(fileIsStreamOnly(ctx, fileId), false);
});

test('a sha256 mismatch at commit refuses and mints NOTHING', async () => {
  const { ctx, store, workspaceId } = setup();
  const body = Buffer.from('hello world of migration', 'utf8');
  const begin = fileUploadBegin(ctx, { name: 'x.csv', sizeBytes: body.byteLength });
  fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 0, contentBase64: body.toString('base64') });
  const wrong = fileUploadCommit(ctx, { uploadId: begin.uploadId, sha256: sha(Buffer.from('different')) });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'source_integrity_mismatch');
  const files = store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(workspaceId).n;
  const blobs = store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_blob WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(files, 0);
  assert.equal(blobs, 0);
  // The session stays open so a corrected re-send can succeed.
  const ok = fileUploadCommit(ctx, { uploadId: begin.uploadId, sha256: sha(body) });
  assert.equal(ok.ok, true);
});

test('chunks must arrive in order; a gap is refused', () => {
  const { ctx } = setup();
  const begin = fileUploadBegin(ctx, { name: 'x.csv', sizeBytes: 100 });
  const gap = fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 1, contentBase64: Buffer.from('ab').toString('base64') });
  assert.equal(gap.ok, false);
  assert.equal(gap.error, 'chunk_out_of_order');
});

test('a repeated chunk seq is an idempotent no-op', () => {
  const { ctx, store, workspaceId } = setup();
  const begin = fileUploadBegin(ctx, { name: 'x.csv', sizeBytes: 100 });
  const b = Buffer.from('abcde').toString('base64');
  fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 0, contentBase64: b });
  const again = fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 0, contentBase64: b });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
  const rows = store.db.prepare('SELECT COUNT(*) AS n FROM file_upload_chunk WHERE workspace_id = ? AND upload_id = ?').get(workspaceId, begin.uploadId).n;
  assert.equal(rows, 1);
});

test('a migration-class blob (over the single-call bound) refuses base64 and reads through the stream', async () => {
  const { ctx } = setup();
  // Build a > 25 MiB body from two ~13 MiB chunks. Content-addressed segments, streamed back.
  const chunkSize = 13 * 1024 * 1024;
  const a = Buffer.alloc(chunkSize, 0x41);
  const b = Buffer.alloc(chunkSize, 0x42);
  const whole = Buffer.concat([a, b]);
  assert.ok(whole.byteLength > MAX_FILE_BYTES);
  const begin = fileUploadBegin(ctx, { name: 'big.csv', sizeBytes: whole.byteLength, intent: 'migration_source' });
  assert.equal(fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 0, contentBase64: a.toString('base64') }).ok, true);
  assert.equal(fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 1, contentBase64: b.toString('base64') }).ok, true);
  const commit = fileUploadCommit(ctx, { uploadId: begin.uploadId, sha256: sha(whole) });
  assert.equal(commit.ok, true, JSON.stringify(commit).slice(0, 200));
  const fileId = commit.file.id;
  assert.equal(fileIsStreamOnly(ctx, fileId), true);
  const refused = getFileContent(ctx, { fileId });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'file_too_large_use_stream');
  const streamed = await collect(readBlobByteSource(ctx, fileId));
  assert.equal(streamed.byteLength, whole.byteLength);
  assert.equal(sha(streamed), sha(whole));
});

test('an incomplete session expires after 24 h and leaves no phantom blob', () => {
  const fx = setup();
  const begin = fileUploadBegin(fx.ctx, { name: 'x.csv', sizeBytes: 100 });
  fileUploadChunk(fx.ctx, { uploadId: begin.uploadId, seq: 0, contentBase64: Buffer.from('abc').toString('base64') });
  // 25 h later a new lane action sweeps the stale session.
  const later = atTime(fx, '2026-07-17T01:00:00.000Z');
  fileUploadBegin(later, { name: 'y.csv', sizeBytes: 10 });
  const chunkRows = fx.store.db.prepare('SELECT COUNT(*) AS n FROM file_upload_chunk WHERE workspace_id = ? AND upload_id = ?').get(fx.workspaceId, begin.uploadId).n;
  assert.equal(chunkRows, 0);
  const expired = fileUploadCommit(later, { uploadId: begin.uploadId, sha256: sha(Buffer.from('abc')) });
  assert.equal(expired.ok, false);
  const blobs = fx.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_blob WHERE workspace_id = ?').get(fx.workspaceId).n;
  assert.equal(blobs, 0);
});

test('§H-TENANT: a neighbour tenant cannot append to or commit another workspace session', () => {
  const fx = setup();
  const begin = fileUploadBegin(fx.ctx, { name: 'x.csv', sizeBytes: 100 });
  const neighbour = newWorkspace(fx.deps, 'Neighbour GmbH');
  const stolenChunk = fileUploadChunk(neighbour, { uploadId: begin.uploadId, seq: 0, contentBase64: Buffer.from('x').toString('base64') });
  assert.equal(stolenChunk.ok, false);
  assert.equal(stolenChunk.error, 'not_found');
  const stolenCommit = fileUploadCommit(neighbour, { uploadId: begin.uploadId, sha256: sha(Buffer.from('x')) });
  assert.equal(stolenCommit.ok, false);
  assert.equal(stolenCommit.error, 'not_found');
});

test('a 25 MiB + 1 single call is refused and told to use the chunk lane', () => {
  const { ctx } = setup();
  const over = Buffer.alloc(MAX_FILE_BYTES + 1, 0x43);
  const res = uploadFile(ctx, { filename: 'big.csv', contentBase64: over.toString('base64') });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'file_too_large');
  assert.equal(res.useLane, 'files_upload_begin');
});

test('commit is idempotent: a replay returns the same file', () => {
  const { ctx, store, workspaceId } = setup();
  const body = Buffer.from('one entry only', 'utf8');
  const begin = fileUploadBegin(ctx, { name: 'x.csv', sizeBytes: body.byteLength });
  fileUploadChunk(ctx, { uploadId: begin.uploadId, seq: 0, contentBase64: body.toString('base64') });
  const first = fileUploadCommit(ctx, { uploadId: begin.uploadId, sha256: sha(body), idempotencyKey: 'k1' });
  const second = fileUploadCommit(ctx, { uploadId: begin.uploadId, sha256: sha(body), idempotencyKey: 'k1' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.file.id, second.file.id);
  const files = store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(workspaceId).n;
  assert.equal(files, 1);
});
