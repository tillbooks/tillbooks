// E00, file management: the engine invariants the wave gate depends on.
//
// What is proved here, and why each one is a ROW assertion rather than a return-value one:
//
//   §H-TENANT on every query, including the one that reads BYTES back. A cross-tenant content read is
//   the worst failure available to this capability, because the caller cannot tell it happened.
//   Idempotency ON ROWS: a replayed upload must leave one `stored_file` AND one `stored_file_blob`,
//   which a returned id can never demonstrate.
//   The version chain: linear, append-only, head-only reads, and no verb that rewrites a prior row.
//   The integrity contract: `getFileContent` re-hashes before it answers, and refuses rather than
//   serving bytes its checksum disowns.
//   P3 BY OMISSION: the whole flow writes zero journal rows, asserted rather than argued.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  uploadFile,
  updateFile,
  newFileVersion,
  linkFile,
  listLinkedFiles,
  searchFiles,
  getFileContent,
  deleteFile,
  repointFileLinks,
  upsertFolder,
  MAX_FILE_BYTES,
  FILE_LIST_CEILING,
} from '../../dist/core/files/index.js';
import { createContact, createDocument, mergeContacts } from '../../dist/core/sales/index.js';
import { setup, newWorkspace, asActor, b64, counts } from './support.mjs';

const upload = (ctx, overrides = {}) =>
  uploadFile(ctx, {
    title: 'Mietvertrag',
    filename: 'mietvertrag.pdf',
    mime: 'application/pdf',
    contentBase64: b64('%PDF-1.4 Mietvertrag'),
    ...overrides,
  });

// --- Upload (US-E00.1) -------------------------------------------------------------------------

test('an upload persists the row, hashes the bytes itself, and keys the blob by that hash', () => {
  const { ctx, store, workspaceId } = setup();
  const res = upload(ctx, { tags: ['Vertrag', 'vertrag', ' 2026 '] });
  assert.equal(res.ok, true);

  const file = res.file;
  assert.equal(file.version, 1);
  assert.equal(file.supersedesId, null);
  assert.equal(file.bytes, Buffer.from('%PDF-1.4 Mietvertrag').byteLength);
  // The VALUE, not the shape. A test that re-hashes with the same helper the engine uses proves only
  // that the code is self-consistent; this is the sha256 of `%PDF-1.4 Mietvertrag`, computed
  // independently, so a change of algorithm or of encoding goes red here rather than silently.
  assert.equal(file.sha256, '2451b757927d61525518231a06fde70b6c7c90bc8b8edc2125030d12195efa8c');
  assert.equal(file.storageRef, file.sha256, 'storage_ref IS the content hash');
  // Case-preserving de-duplication and trimming, the `contacts_tag` shape.
  assert.deepEqual(file.tags, ['Vertrag', '2026']);
  assert.equal(file.retentionUntil, null);
  assert.equal(file.retentionLocked, false);
  assert.equal(file.pendingDelete, false);

  const blob = store.db
    .prepare('SELECT bytes, content FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
    .get(workspaceId, file.sha256);
  assert.equal(blob.bytes, file.bytes);
  assert.equal(blob.content.toString('utf8'), '%PDF-1.4 Mietvertrag');
});

test('the same idempotency key writes ONE file row and ONE blob row, not two', () => {
  const { ctx, store, workspaceId } = setup();
  const first = upload(ctx, { idempotencyKey: 'u-1' });
  const second = upload(ctx, { idempotencyKey: 'u-1' });

  assert.equal(second.ok, true);
  assert.equal(second.file.id, first.file.id);
  // THE ROWS, not the id: a verb that returned the right id while inserting a second filing is exactly
  // the defect this assertion exists for, and the blob table's PRIMARY KEY would have absorbed the
  // duplicate content silently.
  const after = counts(store, workspaceId);
  assert.equal(after.files, 1);
  assert.equal(after.blobs, 1);
});

test('two uploads of identical bytes are two filings over ONE blob', () => {
  const { ctx, store, workspaceId } = setup();
  const a = upload(ctx, { title: 'Kopie A', idempotencyKey: 'a' });
  const b = upload(ctx, { title: 'Kopie B', idempotencyKey: 'b' });
  assert.notEqual(a.file.id, b.file.id);
  assert.equal(a.file.sha256, b.file.sha256);
  const after = counts(store, workspaceId);
  assert.equal(after.files, 2);
  assert.equal(after.blobs, 1, 'content-addressed storage keeps one copy of identical bytes');
});

test('a payload that is not base64 is refused, and NOTHING is stored', () => {
  const { ctx, store, workspaceId } = setup();
  // `Buffer.from(x, 'base64')` never throws and silently drops anything outside the alphabet, so an
  // unchecked decode would store a SHORTER file under a checksum that matches the corruption exactly.
  const res = upload(ctx, { contentBase64: 'nicht base64 !!! ###' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'file_unreadable');
  assert.equal(res.reason, 'not_base64');
  assert.deepEqual(
    [counts(store, workspaceId).files, counts(store, workspaceId).blobs],
    [0, 0],
    'a refused upload leaves no orphan blob',
  );
});

test('an empty payload is refused rather than stored as a zero-byte record', () => {
  const { ctx } = setup();
  // Both branches, because they are reachable by different inputs and a zero-byte file is not a
  // business record either way. An absent or blank string never reaches the decoder; a payload that IS
  // valid base64 and decodes to nothing (wrapped whitespace, which a line-folding transport produces)
  // gets as far as the decode and is refused there.
  const missing = upload(ctx, { contentBase64: '' });
  assert.equal(missing.error, 'file_unreadable');
  assert.equal(missing.reason, 'missing');

  const empty = upload(ctx, { contentBase64: '\n  \n' });
  assert.equal(empty.error, 'file_unreadable');
  assert.equal(empty.reason, 'empty');
});

test('a payload over the cap is refused, and the refusal names the cap', () => {
  const { ctx } = setup();
  const oversize = Buffer.alloc(MAX_FILE_BYTES + 1, 0x41).toString('base64');
  const res = upload(ctx, { contentBase64: oversize });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'file_too_large');
  assert.equal(res.max, MAX_FILE_BYTES);
  assert.equal(res.bytes, MAX_FILE_BYTES + 1);
});

test('F9: a payload far over the cap is refused BEFORE anything is decoded', () => {
  const { ctx } = setup();
  // Comfortably past the base64 bound and with no whitespace, so the cheap length test and the exact
  // significant-character scan both trip. The proof that nothing was decoded is STRUCTURAL rather than a
  // memory measurement: the pre-decode refusal reports `base64Chars` and cannot report `bytes`, because
  // on that path no Buffer exists to measure. Measured on the shipped path before this existed, a 200 MB
  // payload took RSS from 152 MB to 490 MB before the same error came back.
  const oversize = 'A'.repeat(MAX_FILE_BYTES * 2);
  const res = upload(ctx, { contentBase64: oversize });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'file_too_large');
  assert.equal(res.max, MAX_FILE_BYTES);
  assert.equal(res.base64Chars, oversize.length);
  assert.equal(res.bytes, undefined, 'a pre-decode refusal must not report a size it never measured');
});

test('F9: a LEGAL payload at the cap is still accepted when it arrives WRAPPED', () => {
  // The bound has to be exact in both directions. A bare `length > MAX * 4/3` test would refuse this
  // file, because wrapping a payload at the cap makes it about 2.6% longer than the bound while the
  // bytes are exactly at it, and "your 25 MiB file is too large" is the wrong answer to give anyone.
  const { ctx } = setup();
  const wrapped = Buffer.alloc(MAX_FILE_BYTES, 0x41)
    .toString('base64')
    .replace(/(.{76})/g, '$1\n');
  assert.ok(wrapped.length > Math.ceil(MAX_FILE_BYTES / 3) * 4, 'the fixture is not actually over the bound');
  const res = upload(ctx, { contentBase64: wrapped, idempotencyKey: 'wrapped' });
  assert.equal(res.ok, true, `a legal wrapped payload was refused: ${JSON.stringify(res).slice(0, 200)}`);
  assert.equal(res.file.bytes, MAX_FILE_BYTES);
});

test('title, filename and mime are all bounded, on upload and on the version verb', () => {
  const { ctx } = setup();
  const tooLong = 'a'.repeat(241);
  const atLimit = 'a'.repeat(240);

  for (const field of ['title', 'filename', 'mime']) {
    const res = upload(ctx, { [field]: tooLong, idempotencyKey: `long-${field}` });
    assert.equal(res.ok, false, `${field} was accepted at 241 characters`);
    assert.equal(res.error, 'invalid_input');
    assert.equal(res.field, field);
    assert.equal(res.reason, 'too_long');
    assert.equal(res.max, 240);
    // The boundary is INCLUSIVE, which is the half a "too long" test alone never states.
    assert.equal(upload(ctx, { [field]: atLimit, idempotencyKey: `ok-${field}` }).ok, true);
  }

  const beleg = upload(ctx, { idempotencyKey: 'v-base' }).file;
  for (const field of ['filename', 'mime']) {
    const res = newFileVersion(ctx, {
      fileId: beleg.id,
      contentBase64: b64('fassung'),
      [field]: tooLong,
      idempotencyKey: `nv-${field}`,
    });
    assert.equal(res.ok, false, `files_new_version accepted a 241-character ${field}`);
    assert.equal(res.error, 'invalid_input');
    assert.equal(res.reason, 'too_long');
  }
});

test('an edit bounds the title, and cannot reach filename or mime at all', () => {
  const { ctx } = setup();
  const beleg = upload(ctx, { idempotencyKey: '1' }).file;
  const res = updateFile(ctx, { fileId: beleg.id, patch: { title: 'a'.repeat(241) }, idempotencyKey: 'e-1' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.field, 'title');
  assert.equal(res.max, 240);

  // The columns this verb has NO branch for are the design (content is corrected by a new version), so
  // an unbounded value on either of them cannot be a hole: it is ignored rather than stored.
  const ignored = updateFile(ctx, {
    fileId: beleg.id,
    patch: { filename: 'b'.repeat(500), mime: 'c'.repeat(500) },
    idempotencyKey: 'e-2',
  });
  assert.equal(ignored.ok, true);
  assert.equal(ignored.file.filename, beleg.filename);
  assert.equal(ignored.file.mime, beleg.mime);
});

test('a file with neither title nor filename still gets a name', () => {
  const { ctx } = setup();
  const res = uploadFile(ctx, { contentBase64: b64('x') });
  assert.equal(res.ok, true);
  assert.ok(res.file.title.length > 0);
  assert.ok(res.file.filename.length > 0);
  assert.equal(res.file.mime, 'application/octet-stream');
});

test('a folder that does not exist in THIS workspace is refused', () => {
  const { ctx, deps } = setup();
  const other = newWorkspace(deps, 'Nachbar GmbH');
  const theirs = upsertFolder(other, { name: 'Fremd' });
  assert.equal(theirs.ok, true);
  // §H-TENANT: the id is real, and it is not this tenant's. A workspace-blind FK would have accepted it.
  const res = upload(ctx, { folderId: theirs.folder.id });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'folder_not_found');
});

// --- Metadata edit (US-E00.4) ------------------------------------------------------------------

test('an edit moves the filing and NEVER the bytes', () => {
  const { ctx } = setup();
  const file = upload(ctx).file;
  const folder = upsertFolder(ctx, { name: 'Verträge' }).folder;

  const patched = updateFile(ctx, {
    fileId: file.id,
    patch: { title: 'Mietvertrag, unterzeichnet', tags: ['unterzeichnet'], folderId: folder.id },
    idempotencyKey: 'up-1',
  });
  assert.equal(patched.ok, true);
  assert.equal(patched.file.title, 'Mietvertrag, unterzeichnet');
  assert.deepEqual(patched.file.tags, ['unterzeichnet']);
  assert.equal(patched.file.folderId, folder.id);
  // The four columns the verb has no branch for. This is the "content is corrected by a new version,
  // never by an edit" rule, asserted rather than documented.
  assert.equal(patched.file.sha256, file.sha256);
  assert.equal(patched.file.storageRef, file.storageRef);
  assert.equal(patched.file.bytes, file.bytes);
  assert.equal(patched.file.version, file.version);
});

test('a foreign tenant cannot patch this workspace file', () => {
  const { ctx, deps } = setup();
  const file = upload(ctx).file;
  const other = newWorkspace(deps, 'Nachbar GmbH');
  const res = updateFile(other, { fileId: file.id, patch: { title: 'Übernommen' } });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found', 'a foreign id and a nonexistent one get the SAME answer');
});

test('a tag list is bounded and typed, and a non-string tag is refused outright', () => {
  const { ctx } = setup();
  const file = upload(ctx).file;
  assert.equal(updateFile(ctx, { fileId: file.id, patch: { tags: [42] } }).error, 'invalid_input');
  const tooMany = updateFile(ctx, {
    fileId: file.id,
    patch: { tags: Array.from({ length: 51 }, (_, i) => `tag${i}`) },
  });
  assert.equal(tooMany.error, 'invalid_input');
  assert.equal(tooMany.reason, 'too_many');
});

// --- Versioning (US-E00.3) ---------------------------------------------------------------------

test('a new version is a NEW ROW pointing backwards, and the prior row is untouched', () => {
  const { ctx, store, workspaceId } = setup();
  const v1 = upload(ctx, { tags: ['vertrag'] }).file;
  const folder = upsertFolder(ctx, { name: 'Verträge' }).folder;
  updateFile(ctx, { fileId: v1.id, patch: { folderId: folder.id } });

  const res = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('%PDF-1.4 Fassung 2'), idempotencyKey: 'v-1' });
  assert.equal(res.ok, true);
  const v2 = res.file;
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedesId, v1.id);
  assert.notEqual(v2.sha256, v1.sha256);
  // The filing is inherited; the content is not.
  assert.equal(v2.folderId, folder.id);
  assert.equal(v2.title, v1.title);
  assert.deepEqual(v2.tags, ['vertrag']);

  // APPEND-ONLY: v1's own row is byte-identical to what it was, which is the OR 958f trail.
  const stillV1 = store.db.prepare('SELECT * FROM stored_file WHERE id = ?').get(v1.id);
  assert.equal(stillV1.sha256, v1.sha256);
  assert.equal(stillV1.version, 1);
  assert.equal(stillV1.supersedes_id, null);
  assert.equal(counts(store, workspaceId).files, 2);
});

test('superseding a version that is already superseded is refused: chains are linear, never trees', () => {
  const { ctx } = setup();
  const v1 = upload(ctx).file;
  newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('two'), idempotencyKey: 'v-2' });
  const fork = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('three'), idempotencyKey: 'v-3' });
  assert.equal(fork.ok, false);
  assert.equal(fork.error, 'not_head_version');
});

test('replaying a new-version key returns the SAME version and adds no row', () => {
  const { ctx, store, workspaceId } = setup();
  const v1 = upload(ctx).file;
  const first = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('two'), idempotencyKey: 'v-1' });
  const replay = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('two'), idempotencyKey: 'v-1' });
  // The replay must return the STORED RESULT and not the head guard's refusal. Before the guard order
  // was fixed this answered `not_head_version` against the version it had itself just added.
  assert.equal(replay.ok, true);
  assert.equal(replay.file.id, first.file.id);
  assert.equal(counts(store, workspaceId).files, 2);
});

test('the same key on a DIFFERENT file does not replay the first file version', () => {
  const { ctx, store, workspaceId } = setup();
  const a = upload(ctx, { title: 'A', idempotencyKey: 'ua' }).file;
  const b = upload(ctx, { title: 'B', idempotencyKey: 'ub' }).file;
  const va = newFileVersion(ctx, { fileId: a.id, contentBase64: b64('a2'), idempotencyKey: 'shared' });
  const vb = newFileVersion(ctx, { fileId: b.id, contentBase64: b64('b2'), idempotencyKey: 'shared' });
  assert.equal(vb.ok, true);
  assert.notEqual(vb.file.id, va.file.id);
  assert.equal(vb.file.supersedesId, b.id);
  assert.equal(counts(store, workspaceId).files, 4);
});

// --- Search (US-E00.4) -------------------------------------------------------------------------

test('search returns the HEAD of a chain and never the superseded copy as a peer', () => {
  const { ctx } = setup();
  const v1 = upload(ctx).file;
  const v2 = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('two'), idempotencyKey: 'v' }).file;

  const heads = searchFiles(ctx, {});
  assert.equal(heads.files.length, 1);
  assert.equal(heads.files[0].id, v2.id);
  assert.equal(heads.files[0].versions, undefined);

  const nested = searchFiles(ctx, { includeVersions: true });
  assert.equal(nested.files.length, 1, 'includeVersions nests, it does not flatten');
  assert.deepEqual(
    nested.files[0].versions.map((v) => v.version),
    [1, 2],
  );
  assert.deepEqual(
    nested.files[0].versions.map((v) => v.id),
    [v1.id, v2.id],
  );
});

test('every token in q must match, so a second word narrows', () => {
  const { ctx } = setup();
  upload(ctx, { title: 'Mietvertrag Büro', idempotencyKey: '1' });
  upload(ctx, { title: 'Mietvertrag Lager', filename: 'lager.pdf', idempotencyKey: '2' });

  assert.equal(searchFiles(ctx, { q: 'mietvertrag' }).files.length, 2);
  assert.equal(searchFiles(ctx, { q: 'mietvertrag büro' }).files.length, 1);
  assert.equal(searchFiles(ctx, { q: 'mietvertrag garage' }).files.length, 0);
});

test('search matches the filename and the tags, not only the title', () => {
  const { ctx } = setup();
  upload(ctx, { title: 'Ohne Hinweis', filename: 'versicherungspolice.pdf', tags: ['2026'], idempotencyKey: '1' });
  assert.equal(searchFiles(ctx, { q: 'versicherung' }).files.length, 1);
  assert.equal(searchFiles(ctx, { q: '2026' }).files.length, 1);
});

test('a tag filter matches a whole tag and not a substring of one', () => {
  const { ctx } = setup();
  upload(ctx, { title: 'A', tags: ['versicherung'], idempotencyKey: '1' });
  upload(ctx, { title: 'B', tags: ['krankenversicherung'], idempotencyKey: '2' });
  const hits = searchFiles(ctx, { tag: 'versicherung' });
  assert.equal(hits.files.length, 1);
  assert.deepEqual(hits.files[0].tags, ['versicherung']);
});

test('a LIKE wildcard in a search token is a literal, never a pattern', () => {
  const { ctx } = setup();
  upload(ctx, { title: 'Rabatt 100% Aktion', idempotencyKey: '1' });
  upload(ctx, { title: 'Nichts dergleichen', idempotencyKey: '2' });
  // The distinguishing case is the bare wildcard. Escaped, `%` is a search for a literal percent sign
  // and finds the ONE row that contains one; unescaped it would match every row in the workspace,
  // which is how an operator's search silently turns into "select all". `_` is the single-character
  // wildcard and no title here holds one, so it must find nothing at all.
  assert.equal(searchFiles(ctx, { q: '100%' }).files.length, 1);
  assert.equal(searchFiles(ctx, { q: '%' }).files.length, 1);
  assert.equal(searchFiles(ctx, { q: '_' }).files.length, 0);
});

test('a LIKE wildcard in a TAG filter is a literal too, not only in a q token', () => {
  // The `q` path had this test and the tag path did not, although both call the same `escapeLike`. They
  // are separate clauses with separately built patterns, so one being escaped says nothing about the
  // other: unescaped, `_00prozent` would match `100prozent` and a tag search would quietly return rows
  // the operator never asked for.
  const { ctx } = setup();
  upload(ctx, { title: 'A', tags: ['100prozent'], idempotencyKey: '1' });
  upload(ctx, { title: 'B', tags: ['100%rabatt'], idempotencyKey: '2' });

  assert.equal(searchFiles(ctx, { tag: '_00prozent' }).files.length, 0, 'the underscore must be a literal');
  const literal = searchFiles(ctx, { tag: '100%rabatt' });
  assert.equal(literal.files.length, 1);
  assert.deepEqual(literal.files[0].tags, ['100%rabatt']);
  // And the bare wildcard finds the one tag that really contains a percent sign, never every row.
  assert.equal(searchFiles(ctx, { tag: '%' }).files.length, 0, 'a bare % is a literal and matches no whole tag');
});

test('the D34 ceiling truncates, flags it, and reports the real total', () => {
  // `FILE_LIST_CEILING` and the `total` COUNT branch behind it were a documented contract with nothing
  // asserting either, and the Studio's own test mocked only `truncated: false`. The COUNT is a SECOND
  // query built from the same WHERE clause, so it is exactly the kind of code that keeps working until
  // somebody adds a filter to one of the two.
  const { ctx } = setup();
  const over = FILE_LIST_CEILING + 5;
  for (let i = 0; i < over; i++) {
    uploadFile(ctx, { title: `beleg ${i}`, filename: `b${i}.pdf`, contentBase64: b64(`inhalt ${i}`) });
  }
  const listed = searchFiles(ctx, {});
  assert.equal(listed.files.length, FILE_LIST_CEILING);
  assert.equal(listed.truncated, true);
  assert.equal(listed.total, over, 'the total is the real count and not the truncated page length');
  assert.equal(listed.ceiling, FILE_LIST_CEILING);

  // Under the ceiling, `total` is the page length and no COUNT is run at all.
  const narrowed = searchFiles(ctx, { q: 'beleg 7' });
  assert.equal(narrowed.truncated, false);
  assert.equal(narrowed.total, narrowed.files.length);
  assert.ok(narrowed.total > 0 && narrowed.total < FILE_LIST_CEILING);

  // The COUNT honours the FILTER, which is the drift this branch is exposed to.
  const filtered = searchFiles(ctx, { mime: 'application/octet-stream' });
  assert.equal(filtered.total, over);
});

test('search never crosses a workspace boundary', () => {
  const { ctx, deps } = setup();
  upload(ctx, { title: 'Unsere Datei', idempotencyKey: '1' });
  const other = newWorkspace(deps, 'Nachbar GmbH');
  uploadFile(other, { title: 'Ihre Datei', contentBase64: b64('fremd') });

  assert.deepEqual(
    searchFiles(ctx, {}).files.map((f) => f.title),
    ['Unsere Datei'],
  );
  assert.deepEqual(
    searchFiles(other, {}).files.map((f) => f.title),
    ['Ihre Datei'],
  );
});

// --- The read path (US-E00.1/3, OR 958f Abs. 3) ------------------------------------------------

test('content comes back byte-identical, for the head and for every earlier version', () => {
  const { ctx } = setup();
  const v1 = uploadFile(ctx, { title: 'Beleg', contentBase64: b64('erste Fassung') }).file;
  const v2 = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('zweite Fassung'), idempotencyKey: 'v' }).file;

  const first = getFileContent(ctx, { fileId: v1.id });
  const second = getFileContent(ctx, { fileId: v2.id });
  assert.equal(Buffer.from(first.contentBase64, 'base64').toString('utf8'), 'erste Fassung');
  assert.equal(Buffer.from(second.contentBase64, 'base64').toString('utf8'), 'zweite Fassung');
  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(second.sha256, v2.sha256);
});

test('a blob whose bytes no longer match its checksum is REFUSED, with both hashes', () => {
  const { ctx, store, workspaceId } = setup();
  const file = uploadFile(ctx, { title: 'Beleg', contentBase64: b64('echte Bytes') }).file;
  // A changeable information carrier is exactly what GeBüV Art. 9 admits only under technical
  // safeguards, so the tamper is simulated at the carrier rather than through a verb.
  store.db
    .prepare('UPDATE stored_file_blob SET content = ? WHERE workspace_id = ? AND sha256 = ?')
    .run(Buffer.from('manipuliert'), workspaceId, file.sha256);

  const res = getFileContent(ctx, { fileId: file.id });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'integrity_mismatch');
  assert.equal(res.expected, file.sha256);
  assert.notEqual(res.actual, file.sha256);
  assert.equal(res.contentBase64, undefined, 'a refused read hands back NO bytes');
});

test('a missing blob is content_not_found, never an empty success', () => {
  const { ctx, store, workspaceId } = setup();
  const file = uploadFile(ctx, { title: 'Beleg', contentBase64: b64('weg') }).file;
  store.db.prepare('DELETE FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?').run(workspaceId, file.sha256);
  const res = getFileContent(ctx, { fileId: file.id });
  assert.equal(res.error, 'content_not_found');
  assert.equal(res.contentBase64, undefined);
});

test('a foreign tenant cannot read this workspace bytes', () => {
  const { ctx, deps } = setup();
  const file = uploadFile(ctx, { title: 'Vertraulich', contentBase64: b64('geheim') }).file;
  const other = newWorkspace(deps, 'Nachbar GmbH');
  const res = getFileContent(other, { fileId: file.id });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'not_found');
  assert.equal(res.contentBase64, undefined);
});

test('a missing or blank fileId is a structured refusal, never a throw', () => {
  const { ctx } = setup();
  for (const input of [{}, { fileId: '' }, { fileId: 'no_such_id' }]) {
    const res = getFileContent(ctx, input);
    assert.equal(res.ok, false);
    assert.equal(res.error, 'not_found');
  }
});

// --- OP3, the entity link (US-E00.2) -----------------------------------------------------------

test('a file links to a registered kind, and the link is readable from the record', () => {
  const { ctx } = setup();
  const file = upload(ctx).file;
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Vermieter AG' }).contact;

  const res = linkFile(ctx, { fileId: file.id, entityKind: 'contact', entityId: contact.id, idempotencyKey: 'l-1' });
  assert.equal(res.ok, true);
  assert.equal(res.file.entityKind, 'contact');
  assert.equal(res.file.entityId, contact.id);
  // A contact is not a Buchungsbeleg, so no statutory lock is derived: locking a CV attached to a
  // person for ten years would defeat the revDSG erasure duty no statute asked for here.
  assert.equal(res.retentionDerived, false);
  assert.equal(res.file.retentionUntil, null);

  const linked = listLinkedFiles(ctx, { entityKind: 'contact', entityId: contact.id });
  assert.equal(linked.files.length, 1);
  assert.equal(linked.files[0].id, file.id);
});

test('an unregistered kind is refused and the refusal names the kinds that exist', () => {
  const { ctx } = setup();
  const file = upload(ctx).file;
  const res = linkFile(ctx, { fileId: file.id, entityKind: 'unicorn', entityId: 'x' });
  assert.equal(res.error, 'unknown_entity_kind');
  assert.ok(Array.isArray(res.known) && res.known.includes('contact'));
});

test('a dangling target and a FOREIGN target get the same entity_not_found', () => {
  const { ctx, deps } = setup();
  const file = upload(ctx).file;
  const other = newWorkspace(deps, 'Nachbar GmbH');
  const theirContact = createContact(other, { partyRole: 'customer', name: 'Fremd AG' }).contact;

  const dangling = linkFile(ctx, { fileId: file.id, entityKind: 'contact', entityId: 'kontakt_gibt_es_nicht' });
  const foreign = linkFile(ctx, { fileId: file.id, entityKind: 'contact', entityId: theirContact.id });
  assert.equal(dangling.error, 'entity_not_found');
  assert.equal(foreign.error, 'entity_not_found', 'an id must not be probeable across tenants');
});

test('re-linking replaces the link rather than refusing a mis-filed voucher', () => {
  const { ctx } = setup();
  const file = upload(ctx).file;
  const a = createContact(ctx, { partyRole: 'customer', name: 'Falsch AG' }).contact;
  const b = createContact(ctx, { partyRole: 'customer', name: 'Richtig AG' }).contact;
  linkFile(ctx, { fileId: file.id, entityKind: 'contact', entityId: a.id, idempotencyKey: '1' });
  const moved = linkFile(ctx, { fileId: file.id, entityKind: 'contact', entityId: b.id, idempotencyKey: '2' });
  assert.equal(moved.file.entityId, b.id);
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: a.id }).files.length, 0);
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: b.id }).files.length, 1);
});

test('a new version inherits the link, so listLinked follows the chain to the head', () => {
  const { ctx } = setup();
  const v1 = upload(ctx).file;
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Vermieter AG' }).contact;
  linkFile(ctx, { fileId: v1.id, entityKind: 'contact', entityId: contact.id, idempotencyKey: 'l' });
  const v2 = newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('zwei'), idempotencyKey: 'v' }).file;

  const linked = listLinkedFiles(ctx, { entityKind: 'contact', entityId: contact.id });
  assert.equal(linked.files.length, 1, 'one record, not two');
  assert.equal(linked.files[0].id, v2.id);
  assert.equal(linked.files[0].version, 2);

  const nested = listLinkedFiles(ctx, { entityKind: 'contact', entityId: contact.id, includeVersions: true });
  assert.deepEqual(
    nested.files[0].versions.map((v) => v.version),
    [1, 2],
  );
});

test('the D34 ceiling holds on listLinked exactly as on search', () => {
  // `files_list_linked` projected the same rows as `files_search` with no LIMIT at all, so the one
  // screen that always passes `includeVersions` was the one read that could not be truncated.
  const { ctx } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Sammel AG' }).contact;
  const over = FILE_LIST_CEILING + 3;
  for (let i = 0; i < over; i++) {
    const filed = uploadFile(ctx, { title: `beleg ${i}`, filename: `b${i}.pdf`, contentBase64: b64(`inhalt ${i}`) }).file;
    linkFile(ctx, { fileId: filed.id, entityKind: 'contact', entityId: contact.id });
  }
  const linked = listLinkedFiles(ctx, { entityKind: 'contact', entityId: contact.id });
  assert.equal(linked.files.length, FILE_LIST_CEILING);
  assert.equal(linked.truncated, true);
  assert.equal(linked.total, over, 'the total is the real count and not the truncated page length');
  assert.equal(linked.ceiling, FILE_LIST_CEILING);

  // Under the ceiling the flag is false and `total` is the page length, matching `files_search`.
  const other = createContact(ctx, { partyRole: 'customer', name: 'Einzel AG' }).contact;
  const single = uploadFile(ctx, { title: 'einzeln', contentBase64: b64('einzeln') }).file;
  linkFile(ctx, { fileId: single.id, entityKind: 'contact', entityId: other.id });
  const few = listLinkedFiles(ctx, { entityKind: 'contact', entityId: other.id });
  assert.equal(few.truncated, false);
  assert.equal(few.total, 1);
});

test('listLinked refuses an unregistered kind and a blank id without throwing', () => {
  const { ctx } = setup();
  assert.equal(listLinkedFiles(ctx, { entityKind: 'unicorn', entityId: 'x' }).error, 'unknown_entity_kind');
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact' }).error, 'invalid_input');
  assert.equal(listLinkedFiles(ctx, {}).error, 'unknown_entity_kind');
});

// --- F6: the E00 half a C00 merge needs -------------------------------------------------------
//
// `stored_file.entity_id` is a POLYMORPHIC link, so C00's `MERGE_REPOINT_FKS` (a list of
// `{table, column}` pairs re-pointed unconditionally) cannot express it: an unconditional
// `UPDATE stored_file SET entity_id` would move a file attached to an ITEM whose id happened to equal
// the merged-away contact's. The predicate on `entity_kind` is what makes the write safe, so it lives
// with the module that owns the discriminator. The C00-side call is a named handoff in E00's spec §0;
// what is asserted here is the half E00 owns.

test('F6: repointFileLinks moves the links for ONE kind and leaves every other kind alone', () => {
  const { ctx } = setup();
  const a = createContact(ctx, { partyRole: 'customer', name: 'Doppelt AG' }).contact;
  const b = createContact(ctx, { partyRole: 'customer', name: 'Richtig AG' }).contact;
  const cv = upload(ctx, { title: 'Lebenslauf', idempotencyKey: '1' }).file;
  const beleg = upload(ctx, { title: 'Beleg', idempotencyKey: '2' }).file;
  const doc = createDocument(ctx, { type: 'invoice', contactId: b.id, lines: [{ unitPriceMinor: 1000 }] }).document;
  linkFile(ctx, { fileId: cv.id, entityKind: 'contact', entityId: a.id, idempotencyKey: 'l1' });
  linkFile(ctx, { fileId: beleg.id, entityKind: 'document', entityId: doc.id, idempotencyKey: 'l2' });

  const moved = repointFileLinks(ctx, { entityKind: 'contact', fromId: a.id, toId: b.id });
  assert.equal(moved, 1);
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: a.id }).files.length, 0);
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: b.id }).files.length, 1);
  // The document link is untouched, which is the whole reason the predicate exists.
  assert.equal(listLinkedFiles(ctx, { entityKind: 'document', entityId: doc.id }).files.length, 1);

  // Idempotent by construction: a second run finds no row still naming the source.
  assert.equal(repointFileLinks(ctx, { entityKind: 'contact', fromId: a.id, toId: b.id }), 0);
});

test('F6: repointFileLinks is what closes the merge gap, and it does not cross a tenant', () => {
  const { ctx, deps } = setup();
  const a = createContact(ctx, { partyRole: 'customer', name: 'Doppelt AG' }).contact;
  const b = createContact(ctx, { partyRole: 'customer', name: 'Richtig AG' }).contact;
  const cv = upload(ctx, { title: 'Lebenslauf', idempotencyKey: '1' }).file;
  linkFile(ctx, { fileId: cv.id, entityKind: 'contact', entityId: a.id, idempotencyKey: 'l' });

  // C00's merge re-points every FK it knows about. It does not yet know about this one, which is the
  // finding; the assertion below is that E00's support is SUFFICIENT to close it, so the handoff is a
  // one-line call and not a design question. If C00 later adds the call, this still holds.
  assert.equal(mergeContacts(ctx, { sourceId: a.id, targetId: b.id, idempotencyKey: 'm' }).ok, true);
  repointFileLinks(ctx, { entityKind: 'contact', fromId: a.id, toId: b.id });
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: b.id }).files.length, 1);
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: a.id }).files.length, 0);

  // §H-TENANT: a neighbour naming the same ids moves nothing here.
  const other = newWorkspace(deps, 'Nachbar GmbH');
  assert.equal(repointFileLinks(other, { entityKind: 'contact', fromId: b.id, toId: a.id }), 0);
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: b.id }).files.length, 1);
});

test('F6: repointFileLinks refuses to do anything on an unregistered kind or a blank id', () => {
  const { ctx } = setup();
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Doppelt AG' }).contact;
  const cv = upload(ctx, { idempotencyKey: '1' }).file;
  linkFile(ctx, { fileId: cv.id, entityKind: 'contact', entityId: contact.id, idempotencyKey: 'l' });
  assert.equal(repointFileLinks(ctx, { entityKind: 'unicorn', fromId: contact.id, toId: 'x' }), 0);
  assert.equal(repointFileLinks(ctx, { entityKind: 'contact', fromId: contact.id, toId: '' }), 0);
  assert.equal(repointFileLinks(ctx, { entityKind: 'contact', fromId: contact.id, toId: contact.id }), 0);
  assert.equal(listLinkedFiles(ctx, { entityKind: 'contact', entityId: contact.id }).files.length, 1);
});

// --- P3 by omission ----------------------------------------------------------------------------

test('the whole E00 flow posts NOTHING: no journal entry, no journal line', () => {
  const fixture = setup();
  const { ctx, store, workspaceId } = fixture;
  const folder = upsertFolder(ctx, { name: 'Belege', idempotencyKey: 'f' }).folder;
  const file = upload(ctx, { folderId: folder.id, idempotencyKey: 'u' }).file;
  const contact = createContact(ctx, { partyRole: 'customer', name: 'Kunde AG' }).contact;
  const doc = createDocument(ctx, { type: 'invoice', contactId: contact.id, lines: [{ unitPriceMinor: 1000 }] });
  linkFile(ctx, { fileId: file.id, entityKind: 'document', entityId: doc.document.id, idempotencyKey: 'l' });
  newFileVersion(ctx, { fileId: file.id, contentBase64: b64('zwei'), idempotencyKey: 'v' });
  updateFile(ctx, { fileId: file.id, patch: { title: 'Neu' }, idempotencyKey: 'p' });
  searchFiles(ctx, { q: 'neu' });
  getFileContent(ctx, { fileId: file.id });
  deleteFile(asActor(fixture, 'agent'), { fileId: file.id });

  const after = counts(store, workspaceId);
  assert.equal(after.entries, 0, 'E00 has no posting path at all (P3 by omission)');
  assert.equal(after.lines, 0);
});
