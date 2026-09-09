// E00 US-E00.6, the folder tree: the materialised path, the cycle guard, and the no-cascade rule.
//
// The no-cascade rule is a COMPLIANCE property and not a caution, which is why it is asserted here
// rather than described: a cascade would erase a file nested three levels down whose retention still
// has years to run, and it would do so without ever consulting the retention lock. The whole OR 958f
// rail would be reachable around, from a control labelled "delete folder".

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  upsertFolder,
  deleteFolder,
  listFolders,
  uploadFile,
  newFileVersion,
  MAX_FOLDER_NAME,
} from '../../dist/core/files/index.js';
import { setup, newWorkspace, b64, counts } from './support.mjs';

const paths = (store, workspaceId) =>
  store.db
    .prepare('SELECT path FROM file_folder WHERE workspace_id = ? ORDER BY path')
    .all(workspaceId)
    .map((r) => r.path);

// --- Create and read ---------------------------------------------------------------------------

test('a folder tree materialises its paths, and the read comes back in tree order', () => {
  const { ctx, store, workspaceId } = setup();
  const belege = upsertFolder(ctx, { name: 'Belege', idempotencyKey: '1' }).folder;
  const y2026 = upsertFolder(ctx, { name: '2026', parentId: belege.id, idempotencyKey: '2' }).folder;
  upsertFolder(ctx, { name: 'Q1', parentId: y2026.id, idempotencyKey: '3' });
  upsertFolder(ctx, { name: 'Verträge', idempotencyKey: '4' });

  assert.deepEqual(paths(store, workspaceId), ['/Belege', '/Belege/2026', '/Belege/2026/Q1', '/Verträge']);

  const listed = listFolders(ctx);
  // Path order IS tree order for a rail that indents by depth, so no client-side assembly is needed.
  assert.deepEqual(
    listed.folders.map((f) => [f.path, f.depth]),
    [
      ['/Belege', 0],
      ['/Belege/2026', 1],
      ['/Belege/2026/Q1', 2],
      ['/Verträge', 0],
    ],
  );
});

test('the read carries the counts and the delete rule, so the Studio never re-derives it', () => {
  const { ctx } = setup();
  const parent = upsertFolder(ctx, { name: 'Belege', idempotencyKey: '1' }).folder;
  const child = upsertFolder(ctx, { name: '2026', parentId: parent.id, idempotencyKey: '2' }).folder;
  const v1 = uploadFile(ctx, { title: 'A', folderId: child.id, contentBase64: b64('a') }).file;
  newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('a2'), idempotencyKey: 'v' });
  upsertFolder(ctx, { name: 'Leer', idempotencyKey: '3' });

  const byPath = new Map(listFolders(ctx).folders.map((f) => [f.path, f]));
  assert.equal(byPath.get('/Belege').childCount, 1);
  assert.equal(byPath.get('/Belege').deletable, false);
  // The count shown is the HEAD count: two rows exist in the chain, one record is filed there.
  assert.equal(byPath.get('/Belege/2026').fileCount, 1);
  assert.equal(byPath.get('/Belege/2026').deletable, false);
  assert.equal(byPath.get('/Leer').deletable, true);
});

test('the tree never crosses a workspace boundary', () => {
  const { ctx, deps } = setup();
  upsertFolder(ctx, { name: 'Unsere', idempotencyKey: '1' });
  const other = newWorkspace(deps, 'Nachbar GmbH');
  upsertFolder(other, { name: 'Ihre', idempotencyKey: '1' });

  assert.deepEqual(
    listFolders(ctx).folders.map((f) => f.name),
    ['Unsere'],
  );
  assert.deepEqual(
    listFolders(other).folders.map((f) => f.name),
    ['Ihre'],
  );
});

// --- Names -------------------------------------------------------------------------------------

test('two siblings cannot share a name, and the same name under different parents can', () => {
  const { ctx } = setup();
  const a = upsertFolder(ctx, { name: 'Belege', idempotencyKey: '1' }).folder;
  const b = upsertFolder(ctx, { name: 'Verträge', idempotencyKey: '2' }).folder;
  const clash = upsertFolder(ctx, { name: 'Belege', idempotencyKey: '3' });
  assert.equal(clash.ok, false);
  assert.equal(clash.error, 'folder_name_taken');

  assert.equal(upsertFolder(ctx, { name: '2026', parentId: a.id, idempotencyKey: '4' }).ok, true);
  assert.equal(upsertFolder(ctx, { name: '2026', parentId: b.id, idempotencyKey: '5' }).ok, true);
});

test('a slash in a name is refused, because it IS the path separator', () => {
  const { ctx } = setup();
  // `a/b` as one folder would be indistinguishable from a child `b` of a folder `a`, and the
  // uniqueness index would then be enforcing something other than sibling uniqueness.
  const res = upsertFolder(ctx, { name: 'Belege/2026', idempotencyKey: '1' });
  assert.equal(res.error, 'invalid_input');
  assert.equal(res.reason, 'slash_is_the_path_separator');
});

test('a blank, absent, oversized or non-string name is refused', () => {
  const { ctx } = setup();
  assert.equal(upsertFolder(ctx, { idempotencyKey: '1' }).error, 'invalid_input');
  assert.equal(upsertFolder(ctx, { name: '   ', idempotencyKey: '2' }).reason, 'empty');
  assert.equal(upsertFolder(ctx, { name: 42, idempotencyKey: '3' }).error, 'invalid_input');
  assert.equal(upsertFolder(ctx, { name: 'x'.repeat(MAX_FOLDER_NAME + 1), idempotencyKey: '4' }).reason, 'too_long');
});

// --- Rename and re-parent ----------------------------------------------------------------------

test('a rename re-materialises every descendant path in the same transaction', () => {
  const { ctx, store, workspaceId } = setup();
  const belege = upsertFolder(ctx, { name: 'Belege', idempotencyKey: '1' }).folder;
  const y = upsertFolder(ctx, { name: '2026', parentId: belege.id, idempotencyKey: '2' }).folder;
  upsertFolder(ctx, { name: 'Q1', parentId: y.id, idempotencyKey: '3' });

  const renamed = upsertFolder(ctx, { folderId: belege.id, name: 'Buchungsbelege', idempotencyKey: '4' });
  assert.equal(renamed.ok, true);
  assert.deepEqual(paths(store, workspaceId), [
    '/Buchungsbelege',
    '/Buchungsbelege/2026',
    '/Buchungsbelege/2026/Q1',
  ]);
});

test('a rename of a folder whose name holds a LIKE wildcard leaves its SIBLINGS alone', () => {
  const { ctx, store, workspaceId } = setup();
  // The defect this is here for: `%` matches anything and `_` matches any character, so an unescaped
  // prefix sweep would rewrite the path of every folder in the workspace. Named `100%` deliberately.
  const wild = upsertFolder(ctx, { name: '100%', idempotencyKey: '1' }).folder;
  upsertFolder(ctx, { name: 'Unter', parentId: wild.id, idempotencyKey: '2' });
  upsertFolder(ctx, { name: 'Unberührt', idempotencyKey: '3' });

  upsertFolder(ctx, { folderId: wild.id, name: 'Rabatte', idempotencyKey: '4' });
  assert.deepEqual(paths(store, workspaceId), ['/Rabatte', '/Rabatte/Unter', '/Unberührt']);
});

test('a re-parent moves the subtree, and a move to the root is an explicit null', () => {
  const { ctx, store, workspaceId } = setup();
  const a = upsertFolder(ctx, { name: 'A', idempotencyKey: '1' }).folder;
  const b = upsertFolder(ctx, { name: 'B', idempotencyKey: '2' }).folder;
  const moved = upsertFolder(ctx, { name: 'Wandert', parentId: a.id, idempotencyKey: '3' }).folder;
  upsertFolder(ctx, { name: 'Kind', parentId: moved.id, idempotencyKey: '4' });

  upsertFolder(ctx, { folderId: moved.id, parentId: b.id, idempotencyKey: '5' });
  assert.deepEqual(paths(store, workspaceId), ['/A', '/B', '/B/Wandert', '/B/Wandert/Kind']);

  // `parentId: null` is "move to the root" and is a DIFFERENT request from an absent parentId, which
  // means "leave the parent where it is".
  upsertFolder(ctx, { folderId: moved.id, parentId: null, idempotencyKey: '6' });
  assert.deepEqual(paths(store, workspaceId), ['/A', '/B', '/Wandert', '/Wandert/Kind']);

  // Absent parentId on a pure rename keeps the ancestry.
  upsertFolder(ctx, { folderId: moved.id, name: 'Steht', idempotencyKey: '7' });
  assert.deepEqual(paths(store, workspaceId), ['/A', '/B', '/Steht', '/Steht/Kind']);
});

test('a folder can never become a descendant of itself', () => {
  const { ctx } = setup();
  const parent = upsertFolder(ctx, { name: 'Eltern', idempotencyKey: '1' }).folder;
  const child = upsertFolder(ctx, { name: 'Kind', parentId: parent.id, idempotencyKey: '2' }).folder;
  const grand = upsertFolder(ctx, { name: 'Enkel', parentId: child.id, idempotencyKey: '3' }).folder;

  assert.equal(upsertFolder(ctx, { folderId: parent.id, parentId: parent.id, idempotencyKey: '4' }).error, 'folder_cycle');
  assert.equal(upsertFolder(ctx, { folderId: parent.id, parentId: child.id, idempotencyKey: '5' }).error, 'folder_cycle');
  assert.equal(upsertFolder(ctx, { folderId: parent.id, parentId: grand.id, idempotencyKey: '6' }).error, 'folder_cycle');
  // The other direction is fine: a child may move under a sibling of its parent.
  const other = upsertFolder(ctx, { name: 'Anderer', idempotencyKey: '7' }).folder;
  assert.equal(upsertFolder(ctx, { folderId: child.id, parentId: other.id, idempotencyKey: '8' }).ok, true);
});

test('a parent in ANOTHER workspace is not a parent', () => {
  const { ctx, deps } = setup();
  const other = newWorkspace(deps, 'Nachbar GmbH');
  const theirs = upsertFolder(other, { name: 'Fremd', idempotencyKey: '1' }).folder;
  const res = upsertFolder(ctx, { name: 'Unser', parentId: theirs.id, idempotencyKey: '1' });
  assert.equal(res.error, 'folder_not_found');
  assert.equal(res.field, 'parentId');
});

test('a foreign tenant cannot rename this workspace folder', () => {
  const { ctx, deps } = setup();
  const ours = upsertFolder(ctx, { name: 'Unser', idempotencyKey: '1' }).folder;
  const other = newWorkspace(deps, 'Nachbar GmbH');
  assert.equal(upsertFolder(other, { folderId: ours.id, name: 'Gekapert', idempotencyKey: '1' }).error, 'folder_not_found');
});

// --- Delete ------------------------------------------------------------------------------------

test('deleting a folder NEVER cascades: files and child folders both refuse it', () => {
  const { ctx, store, workspaceId } = setup();
  const parent = upsertFolder(ctx, { name: 'Belege', idempotencyKey: '1' }).folder;
  const child = upsertFolder(ctx, { name: '2026', parentId: parent.id, idempotencyKey: '2' }).folder;
  uploadFile(ctx, { title: 'Beleg', folderId: child.id, contentBase64: b64('x'), idempotencyKey: 'u' });

  const withChild = deleteFolder(ctx, { folderId: parent.id, idempotencyKey: 'd1' });
  assert.equal(withChild.error, 'folder_not_empty');
  assert.equal(withChild.childFolders, 1);
  assert.equal(withChild.files, 0);

  const withFiles = deleteFolder(ctx, { folderId: child.id, idempotencyKey: 'd2' });
  assert.equal(withFiles.error, 'folder_not_empty');
  assert.equal(withFiles.files, 1);
  // Nothing was removed by either refusal, which is the property that keeps a nested retained record
  // out of reach of a folder control.
  const after = counts(store, workspaceId);
  assert.equal(after.folders, 2);
  assert.equal(after.files, 1);
});

test('a SUPERSEDED version still counts as content, so the folder holding only history refuses', () => {
  const { ctx } = setup();
  const folder = upsertFolder(ctx, { name: 'Belege', idempotencyKey: '1' }).folder;
  const v1 = uploadFile(ctx, { title: 'A', folderId: folder.id, contentBase64: b64('a'), idempotencyKey: 'u' }).file;
  newFileVersion(ctx, { fileId: v1.id, contentBase64: b64('a2'), idempotencyKey: 'v' });
  const res = deleteFolder(ctx, { folderId: folder.id, idempotencyKey: 'd' });
  // TWO rows, one visible record. The guard counts rows on purpose: the OR 958f trail lives in the
  // superseded ones, and a guard that only saw heads would let a folder delete take history with it.
  assert.equal(res.error, 'folder_not_empty');
  assert.equal(res.files, 2);
});

test('an empty folder deletes, and a replayed delete answers the same thing', () => {
  const { ctx, store, workspaceId } = setup();
  const folder = upsertFolder(ctx, { name: 'Leer', idempotencyKey: '1' }).folder;
  const first = deleteFolder(ctx, { folderId: folder.id, idempotencyKey: 'd' });
  assert.equal(first.ok, true);
  assert.equal(first.deleted, true);
  // Before the guard order was fixed this answered `folder_not_found` for the row it had itself
  // removed, which tells a caller its correct request was wrong.
  const replay = deleteFolder(ctx, { folderId: folder.id, idempotencyKey: 'd' });
  assert.deepEqual(replay, first);
  assert.equal(counts(store, workspaceId).folders, 0);
});

test('a replayed create adds ONE folder, not two, and answers with the same folder', () => {
  const { ctx, store, workspaceId } = setup();
  const first = upsertFolder(ctx, { name: 'Verträge', idempotencyKey: 'f-1' });
  const replay = upsertFolder(ctx, { name: 'Verträge', idempotencyKey: 'f-1' });
  assert.equal(replay.ok, true);
  assert.equal(replay.folder.id, first.folder.id);
  assert.equal(counts(store, workspaceId).folders, 1);
});

test('deleting a folder does not exist for a foreign tenant', () => {
  const { ctx, deps, store, workspaceId } = setup();
  const ours = upsertFolder(ctx, { name: 'Unser', idempotencyKey: '1' }).folder;
  const other = newWorkspace(deps, 'Nachbar GmbH');
  assert.equal(deleteFolder(other, { folderId: ours.id, idempotencyKey: 'd' }).error, 'folder_not_found');
  assert.equal(counts(store, workspaceId).folders, 1);
});
