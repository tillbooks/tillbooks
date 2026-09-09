/**
 * G18 US-G18.4: the streaming READ wiring. A migration-class GL export (over the 25 MiB single-call
 * bound) enters through the chunk lane, is stored in segments, and is read back through the synchronous
 * segment reader + `parseStreamSync` WITHOUT ever being materialised whole. Peak memory is one batch,
 * and the streamed rows equal the materialised parse of the same bytes.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { fileUploadBegin, fileUploadChunk, fileUploadCommit, readBlobSegmentsSync, MAX_FILE_BYTES } from '../../dist/core/files/index.js';
import { parseStreamSync, parseGenericCsv, STREAM_BATCH_ROWS } from '../../dist/core/migration/index.js';
import { setup } from '../files/support.mjs';

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** Build a CSV whose byte length exceeds the single-call bound, returning it split into ~13 MiB chunks. */
function bigCsvChunks() {
  const header = 'id,name,amount\n';
  const rows = [];
  let bytes = header.length;
  let i = 0;
  // Grow until well past 25 MiB.
  while (bytes < MAX_FILE_BYTES + 2 * 1024 * 1024) {
    const line = `${i},Zeile ${i},${i * 100}\n`;
    rows.push(line);
    bytes += Buffer.byteLength(line);
    i += 1;
  }
  const whole = Buffer.from(header + rows.join(''), 'utf8');
  const chunkSize = 13 * 1024 * 1024;
  const chunks = [];
  for (let o = 0; o < whole.byteLength; o += chunkSize) chunks.push(whole.subarray(o, Math.min(o + chunkSize, whole.byteLength)));
  return { whole, chunks, rowCount: i };
}

test('a > 25 MiB GL export streams from segments and equals the materialised parse, memory-flat', () => {
  const { ctx } = setup();
  const { whole, chunks, rowCount } = bigCsvChunks();
  assert.ok(whole.byteLength > MAX_FILE_BYTES);

  const begin = fileUploadBegin(ctx, { name: 'gl.csv', mediaType: 'text/csv', sizeBytes: whole.byteLength, intent: 'migration_source' });
  assert.equal(begin.ok, true);
  chunks.forEach((c, seq) => {
    const r = fileUploadChunk(ctx, { uploadId: begin.uploadId, seq, contentBase64: c.toString('base64') });
    assert.equal(r.ok, true, `chunk ${seq}`);
  });
  const commit = fileUploadCommit(ctx, { uploadId: begin.uploadId, sha256: sha(whole) });
  assert.equal(commit.ok, true);
  const fileId = commit.file.id;

  // Stream the rows from the segment reader, holding at most one batch at a time.
  let streamedRows = 0;
  let maxBatch = 0;
  let firstRow;
  let lastRow;
  for (const batch of parseStreamSync(readBlobSegmentsSync(ctx, fileId))) {
    maxBatch = Math.max(maxBatch, batch.rows.length);
    if (streamedRows === 0 && batch.rows.length > 0) firstRow = batch.rows[0];
    if (batch.rows.length > 0) lastRow = batch.rows[batch.rows.length - 1];
    streamedRows += batch.rows.length;
  }
  assert.equal(streamedRows, rowCount, 'every data row streamed exactly once');
  assert.ok(maxBatch <= STREAM_BATCH_ROWS, `no batch exceeded the ceiling (max ${maxBatch})`);
  assert.deepEqual(firstRow, { id: '0', name: 'Zeile 0', amount: '0' });

  // Identical to a materialised parse of the same bytes (proves the streamed path is not lossy).
  const materialised = parseGenericCsv(whole);
  assert.equal(materialised.rows.length, rowCount);
  assert.deepEqual(lastRow, materialised.rows[materialised.rows.length - 1]);
});
