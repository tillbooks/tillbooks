/**
 * G04 money-path invariant suite. These assertions are the reason a portability layer is allowed
 * anywhere near a ledger: each proves a property that, if it broke, would be a filing-grade defect, and
 * each is written to FAIL if the engine stopped honouring it (a green test that cannot go red is not
 * evidence). Everything runs offline against a fresh in-memory store, with artifact bundles written to
 * a temp directory so no run touches the developer's real ~/.till.
 *
 *   1. Round-trip fidelity: export -> backup -> restore reproduces the trial balance, the entry count,
 *      the relationships and a VERIFIABLE audit chain, byte-for-byte on money; ids differ by design.
 *   2. Restore atomicity: a mid-restore invariant failure (a doctored, checksum-consistent but
 *      unbalanced backup) rolls back ALL of it, and the new workspace never existed.
 *   3. §H-TENANT isolation: a scoped backup holds exactly one workspace's rows; restoring it never
 *      sees or touches another tenant already in the store.
 *   4. Idempotency on ROWS: create_backup and restore_backup replayed on one key write once.
 *   5. Strict schema-version rejection: an older OR newer artifact is refused, never loaded.
 *   6. Format-source guard: a .tillexport is never accepted as a restore source.
 *   7. P8 staging: an unconfirmed restore writes nothing.
 *   8. Append-only survives restore: a restored posted entry is still immutable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { SCHEMA_GENERATION } from '../../dist/core/store/schema.js';
import { freshDeps, mintWorkspace, manualPost } from '../api/support.mjs';

/** Fresh deps with a temp backup directory bound, plus a workspace-scoped `call` helper. */
function world() {
  const deps = freshDeps();
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-g04-inv-'));
  const { workspaceId, accId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, accId, call };
}

/**
 * Post `n` balanced manual entries of distinct amounts, so the trial balance is non-trivial. With
 * `opts.withReversal` it also reverses the first entry (so the `reverses_entry_id` chain is exercised),
 * and with `opts.withBlob` it uploads a document blob and links it to the first entry (so blob linkage
 * and content-addressed sha256 fidelity are exercised). Returns the ids the caller asserts on.
 */
function seedLedger(w, n = 3, opts = {}) {
  const posted = [];
  for (let i = 0; i < n; i += 1) {
    const res = w.call('post_entry', manualPost(w.accId, `p-${i}`, 1000 * (i + 1)));
    assert.equal(res.ok, true, `post ${i} failed: ${JSON.stringify(res)}`);
    posted.push(res.entryId);
  }
  const out = { posted };
  if (opts.withReversal) {
    const rev = w.call('reverse_entry', { entryId: posted[0], idempotencyKey: 'rev-0' });
    assert.equal(rev.ok, true, `reverse failed: ${JSON.stringify(rev)}`);
    out.reversalId = rev.reversalId;
    out.reversalTarget = posted[0];
  }
  if (opts.withBlob) {
    // Real non-ASCII bytes (a real umlaut) so the round-trip proves BYTE fidelity, not just ASCII.
    const bytes = Buffer.from('Buchungsbeleg fur die Prufung: Betrag gebucht, Beleg abgelegt (ä ö ü).', 'utf8');
    const up = w.call('files_upload', {
      contentBase64: bytes.toString('base64'),
      filename: 'beleg.pdf',
      title: 'Buchungsbeleg',
      idempotencyKey: 'file-0',
    });
    assert.equal(up.ok, true, `upload failed: ${JSON.stringify(up)}`);
    const link = w.call('files_link', {
      fileId: up.file.id,
      entityKind: 'journal_entry',
      entityId: posted[0],
      idempotencyKey: 'link-0',
    });
    assert.equal(link.ok, true, `link failed: ${JSON.stringify(link)}`);
    out.fileSha = up.file.sha256;
    out.fileBytes = bytes;
    out.linkedEntry = posted[0];
  }
  return out;
}

/** The trial balance keyed by account NUMBER (numbers are copied verbatim; ids are re-minted). */
function trialBalanceByNumber(store, workspaceId) {
  const rows = store.db
    .prepare(
      `SELECT a.number AS number,
              COALESCE(SUM(l.base_debit_minor),0) AS d,
              COALESCE(SUM(l.base_credit_minor),0) AS c
         FROM account a
         JOIN journal_line l ON l.account_id = a.id
         JOIN journal_entry e ON e.id = l.entry_id
        WHERE a.workspace_id = ? AND e.status = 'posted'
        GROUP BY a.number
        ORDER BY a.number`,
    )
    .all(workspaceId);
  return rows.map((r) => `${r.number}:${r.d - r.c}`).join('|');
}

function countPostedEntries(store, workspaceId) {
  return store.db
    .prepare("SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ? AND status = 'posted'")
    .get(workspaceId).n;
}

function countWorkspaces(store) {
  return store.db.prepare('SELECT COUNT(*) AS n FROM workspace').get().n;
}

// --- 1. Round-trip fidelity ---------------------------------------------------------------------

test('G04 invariant: export -> backup -> restore reproduces the trial balance, the reversal chain and a linked document blob', () => {
  const w = world();
  // Four posts, a reversal of the first (the reverses_entry_id chain), and a document blob linked to
  // the first (blob linkage + content-addressed sha256): 4 posts + 1 reversal = 5 posted entries.
  const seed = seedLedger(w, 4, { withReversal: true, withBlob: true });
  const srcBalance = trialBalanceByNumber(w.deps.store, w.workspaceId);
  const srcEntries = countPostedEntries(w.deps.store, w.workspaceId);
  assert.ok(srcEntries === 5 && srcBalance.length > 0, 'fixture did not seed a real ledger with a reversal');

  // Export succeeds and is verifiable (US-G04.1 read-back).
  const exp = w.call('export_workspace', { idempotencyKey: 'exp' });
  assert.equal(exp.ok, true, `export failed: ${JSON.stringify(exp)}`);
  const expVerify = getAction('verify_backup').run(w.deps, { source: exp.artifactRef });
  assert.equal(expVerify.ok, true, 'export must verify');
  assert.equal(expVerify.entryCount, 5, 'export manifest entry count');

  // Backup, then restore into a brand-new workspace.
  const bkp = w.call('create_backup', { idempotencyKey: 'bkp' });
  assert.equal(bkp.ok, true, `backup failed: ${JSON.stringify(bkp)}`);
  const verify = getAction('verify_backup').run(w.deps, { source: bkp.artifactRef });
  assert.equal(verify.ok, true, 'backup must verify');
  assert.equal(verify.balanceOk, true, 'backup must balance');
  assert.equal(verify.entryCount, 5, 'backup entry count');

  const restore = getAction('restore_backup').run(w.deps, {
    source: bkp.artifactRef,
    newWorkspaceName: 'Restored GmbH',
    confirmed: true,
    idempotencyKey: 'rb',
  });
  assert.equal(restore.ok, true, `restore failed: ${JSON.stringify(restore)}`);
  const newWs = restore.workspaceId;
  assert.notEqual(newWs, w.workspaceId, 'restore must MINT a new workspace id (not reuse the source)');
  const db = w.deps.store.db;

  // Money and structure are identical; the audit chain re-verifies under the new identity.
  assert.equal(countPostedEntries(w.deps.store, newWs), 5, 'restored entry count must match source');
  assert.equal(
    trialBalanceByNumber(w.deps.store, newWs),
    srcBalance,
    'restored trial balance must equal the source, franc for franc',
  );
  const audit = getAction('get_audit_log').run(w.deps, { workspaceId: newWs });
  assert.equal(audit.ok, true, 'audit read failed');
  assert.equal(audit.chainVerified, true, 'the re-chained audit log MUST verify under the new workspace id');

  // Ids were re-minted, not preserved: no journal_entry id is shared between source and restore.
  const shared = db
    .prepare(
      `SELECT COUNT(*) AS n FROM journal_entry s
         JOIN journal_entry r ON s.id = r.id
        WHERE s.workspace_id = ? AND r.workspace_id = ?`,
    )
    .get(w.workspaceId, newWs).n;
  assert.equal(shared, 0, 'restore must re-mint surrogate ids (none may collide with the source)');

  // The reverses_entry_id chain survives restore, remapped end to end. Exactly one restored entry is a
  // reversal, its target is a RESTORED entry (not the source id, not dangling), and the pair still
  // exactly negates per account (a reversal mirrors its target).
  const reversals = db
    .prepare("SELECT id, reverses_entry_id FROM journal_entry WHERE workspace_id = ? AND reverses_entry_id IS NOT NULL")
    .all(newWs);
  assert.equal(reversals.length, 1, 'the restored workspace must hold exactly one reversal');
  const target = db.prepare('SELECT workspace_id FROM journal_entry WHERE id = ?').get(reversals[0].reverses_entry_id);
  assert.ok(target !== undefined, 'the reversal target must EXIST after restore (not a dangling id)');
  assert.equal(target.workspace_id, newWs, 'reverses_entry_id must be remapped INTO the restored workspace');
  assert.ok(
    ![seed.reversalTarget, seed.reversalId].includes(reversals[0].reverses_entry_id),
    'reverses_entry_id must be re-minted, not the source id',
  );
  const netByAccount = db
    .prepare(
      `SELECT account_id, COALESCE(SUM(base_debit_minor - base_credit_minor),0) AS net
         FROM journal_line WHERE entry_id IN (?, ?) GROUP BY account_id`,
    )
    .all(reversals[0].id, reversals[0].reverses_entry_id);
  for (const r of netByAccount) {
    assert.equal(r.net, 0, `the reversal must exactly negate its target on account ${r.account_id}`);
  }

  // The document blob survives restore: its link is remapped to the restored entry, its sha256 is
  // unchanged (content-addressed), and its bytes are byte-identical.
  const files = db
    .prepare('SELECT id, entity_kind, entity_id, sha256 FROM stored_file WHERE workspace_id = ?')
    .all(newWs);
  assert.equal(files.length, 1, 'the restored workspace must hold the one linked document');
  assert.equal(files[0].entity_kind, 'journal_entry', 'the document link kind must survive');
  assert.equal(files[0].sha256, seed.fileSha, 'the document sha256 must be byte-for-byte the source (content-addressed)');
  assert.notEqual(files[0].entity_id, seed.linkedEntry, 'the linked entity_id must be RE-MINTED, not the source id');
  const linkedWs = db.prepare('SELECT workspace_id FROM journal_entry WHERE id = ?').get(files[0].entity_id);
  assert.ok(linkedWs !== undefined && linkedWs.workspace_id === newWs, 'the document link must resolve to a RESTORED entry');
  const blob = db
    .prepare('SELECT content FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
    .get(newWs, files[0].sha256);
  assert.ok(blob !== undefined, 'the restored workspace must hold the content-addressed blob');
  assert.equal(Buffer.compare(blob.content, seed.fileBytes), 0, 'the blob bytes must be byte-identical after restore');
});

// --- 2. Restore atomicity (rollback on a mid-restore invariant failure) --------------------------

test('G04 invariant: a doctored but checksum-consistent unbalanced backup fails the pre-commit gate and rolls back ENTIRELY', () => {
  const w = world();
  seedLedger(w, 2);
  const bkp = w.call('create_backup', { idempotencyKey: 'bkp' });
  assert.equal(bkp.ok, true);

  // Doctor data.sqlite so a posted entry no longer balances, then make the manifest AGREE with the
  // tampered bytes, so the checksum gate passes and only the post-load balance re-check can catch it.
  const dataPath = join(bkp.artifactRef, 'data.sqlite');
  const snap = new Database(dataPath);
  snap.exec('DROP TRIGGER IF EXISTS journal_line_no_update_posted');
  const line = snap.prepare('SELECT id FROM journal_line LIMIT 1').get();
  snap.prepare('UPDATE journal_line SET base_credit_minor = base_credit_minor + 100 WHERE id = ?').run(line.id);
  snap.close();
  const manifestPath = join(bkp.artifactRef, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.files['data.sqlite'].sha256 = createHash('sha256').update(readFileSync(dataPath)).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));

  const before = countWorkspaces(w.deps.store);
  const restore = getAction('restore_backup').run(w.deps, {
    source: bkp.artifactRef,
    newWorkspaceName: 'Should Not Exist',
    confirmed: true,
    idempotencyKey: 'rb-bad',
  });
  assert.equal(restore.ok, false, 'a restore of an unbalanced backup must fail');
  assert.equal(restore.error, 'restore_invariant_failed', `expected restore_invariant_failed, got ${restore.error}`);
  assert.equal(countWorkspaces(w.deps.store), before, 'the failed restore left a workspace behind (rollback broke)');
  assert.equal(
    w.deps.store.db.prepare("SELECT COUNT(*) AS n FROM workspace WHERE name = 'Should Not Exist'").get().n,
    0,
    'the doomed workspace must not exist after rollback',
  );
});

// --- 3. §H-TENANT isolation ---------------------------------------------------------------------

test('G04 invariant: a scoped backup holds ONE workspace, and restoring it never touches another tenant', () => {
  const deps = freshDeps();
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-g04-tenant-'));
  const a = mintWorkspace(deps, 'Tenant A', 'wsA');
  const b = mintWorkspace(deps, 'Tenant B', 'wsB');
  const callA = (name, input) => getAction(name).run(deps, { workspaceId: a.workspaceId, ...input });
  const callB = (name, input) => getAction(name).run(deps, { workspaceId: b.workspaceId, ...input });
  callA('post_entry', manualPost(a.accId, 'a1', 7000));
  callB('post_entry', manualPost(b.accId, 'b1', 3000));
  callB('post_entry', manualPost(b.accId, 'b2', 9000));

  const bkp = callA('create_backup', { idempotencyKey: 'bkpA' });
  assert.equal(bkp.ok, true);

  // The scoped snapshot contains exactly ONE workspace row (A), never B (§H-TENANT).
  const snap = new Database(join(bkp.artifactRef, 'data.sqlite'), { readonly: true });
  const wsRows = snap.prepare('SELECT id FROM workspace').all();
  assert.equal(wsRows.length, 1, 'a scoped backup must hold exactly one workspace row');
  assert.equal(wsRows[0].id, a.workspaceId, 'the one workspace row must be the backed-up tenant');
  assert.equal(
    snap.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(b.workspaceId).n,
    0,
    "tenant B's entries must NOT appear in tenant A's backup",
  );
  snap.close();

  const bEntriesBefore = countPostedEntries(deps.store, b.workspaceId);
  const restore = getAction('restore_backup').run(deps, {
    source: bkp.artifactRef,
    newWorkspaceName: 'Restored A',
    confirmed: true,
    idempotencyKey: 'rbA',
  });
  assert.equal(restore.ok, true, `restore failed: ${JSON.stringify(restore)}`);
  assert.notEqual(restore.workspaceId, b.workspaceId, 'restore must not collide with tenant B');
  assert.equal(countPostedEntries(deps.store, b.workspaceId), bEntriesBefore, 'restore must not touch tenant B');
  assert.equal(countPostedEntries(deps.store, restore.workspaceId), 1, "restore must load tenant A's one entry");
});

// --- 4. Idempotency on ROWS ---------------------------------------------------------------------

test('G04 invariant: create_backup and restore_backup are idempotent on their key (one row, one workspace)', () => {
  const w = world();
  seedLedger(w, 1);

  const b1 = w.call('create_backup', { idempotencyKey: 'once' });
  const b2 = w.call('create_backup', { idempotencyKey: 'once' });
  assert.equal(b1.ok && b2.ok, true);
  assert.equal(b1.backupId, b2.backupId, 'a replayed backup key must return the FIRST backup');
  assert.equal(
    w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM backups WHERE workspace_id = ?').get(w.workspaceId).n,
    1,
    'a replayed key must not write a second backups row',
  );

  const r1 = getAction('restore_backup').run(w.deps, {
    source: b1.artifactRef,
    newWorkspaceName: 'R',
    confirmed: true,
    idempotencyKey: 'r-once',
  });
  const wsAfterFirst = countWorkspaces(w.deps.store);
  const r2 = getAction('restore_backup').run(w.deps, {
    source: b1.artifactRef,
    newWorkspaceName: 'R',
    confirmed: true,
    idempotencyKey: 'r-once',
  });
  assert.equal(r1.ok && r2.ok, true);
  assert.equal(r1.workspaceId, r2.workspaceId, 'a replayed restore key must return the SAME workspace');
  assert.equal(countWorkspaces(w.deps.store), wsAfterFirst, 'a replayed restore must not mint a second workspace');
});

// --- 5. Strict schema-version rejection ---------------------------------------------------------

test('G04 invariant: a backup whose schema_version differs (older OR newer) is refused, never loaded', () => {
  const w = world();
  seedLedger(w, 1);
  const bkp = w.call('create_backup', { idempotencyKey: 'bkp' });
  assert.equal(bkp.ok, true);
  const manifestPath = join(bkp.artifactRef, 'manifest.json');
  const original = readFileSync(manifestPath, 'utf8');

  for (const version of [SCHEMA_GENERATION - 1, SCHEMA_GENERATION + 1]) {
    const manifest = JSON.parse(original);
    manifest.schemaVersion = version;
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const verify = getAction('verify_backup').run(w.deps, { source: bkp.artifactRef });
    assert.equal(verify.ok, false, `verify must reject schema_version ${version}`);
    assert.equal(verify.error, 'incompatible_schema_version', `expected incompatible_schema_version for ${version}`);
    const before = countWorkspaces(w.deps.store);
    const restore = getAction('restore_backup').run(w.deps, {
      source: bkp.artifactRef,
      newWorkspaceName: 'X',
      confirmed: true,
      idempotencyKey: `rb-${version}`,
    });
    assert.equal(restore.error, 'incompatible_schema_version', `restore must reject schema_version ${version}`);
    assert.equal(countWorkspaces(w.deps.store), before, 'a schema-mismatch restore must write nothing');
  }
  writeFileSync(manifestPath, original);
});

// --- 6. Format-source guard ---------------------------------------------------------------------

test('G04 invariant: a .tillexport is never accepted as a restore source', () => {
  const w = world();
  seedLedger(w, 1);
  const exp = w.call('export_workspace', { idempotencyKey: 'exp' });
  assert.equal(exp.ok, true);
  assert.ok(exp.artifactRef.endsWith('.tillexport'), 'export must produce a .tillexport bundle');
  const restore = getAction('restore_backup').run(w.deps, {
    source: exp.artifactRef,
    newWorkspaceName: 'FromExport',
    confirmed: true,
    idempotencyKey: 'rb-exp',
  });
  assert.equal(restore.ok, false, 'a .tillexport must not restore');
  assert.equal(restore.error, 'restore_source_not_backup', `expected restore_source_not_backup, got ${restore.error}`);
});

// --- 7. P8 staging ------------------------------------------------------------------------------

test('G04 invariant: an unconfirmed restore stages a plan and writes nothing (P8)', () => {
  const w = world();
  seedLedger(w, 1);
  const bkp = w.call('create_backup', { idempotencyKey: 'bkp' });
  const before = countWorkspaces(w.deps.store);
  const staged = getAction('restore_backup').run(w.deps, {
    source: bkp.artifactRef,
    newWorkspaceName: 'Pending',
    // no confirmed
  });
  assert.equal(staged.ok, true, 'a staged restore is a success carrying a plan');
  assert.equal(staged.staged, true, 'an unconfirmed restore must be staged');
  assert.ok(staged.plan && staged.plan.entryCount === 1, 'the plan describes what it would create');
  assert.equal(countWorkspaces(w.deps.store), before, 'a staged restore must not mint a workspace');
});

// --- 8. Append-only survives restore ------------------------------------------------------------

test('G04 invariant: a restored posted entry is still immutable (the append-only trigger survives restore)', () => {
  const w = world();
  seedLedger(w, 1);
  const bkp = w.call('create_backup', { idempotencyKey: 'bkp' });
  const restore = getAction('restore_backup').run(w.deps, {
    source: bkp.artifactRef,
    newWorkspaceName: 'Immutable',
    confirmed: true,
    idempotencyKey: 'rb',
  });
  assert.equal(restore.ok, true);
  const row = w.deps.store.db
    .prepare("SELECT l.id AS id FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id WHERE e.workspace_id = ? AND e.status = 'posted' LIMIT 1")
    .get(restore.workspaceId);
  assert.ok(row, 'the restored workspace must hold a posted line');
  assert.throws(
    () => w.deps.store.db.prepare('UPDATE journal_line SET base_debit_minor = 0 WHERE id = ?').run(row.id),
    /posted_immutable/,
    'a restored posted line must still be immutable',
  );
  // The verify read-back on an empty workspace is honest too (US-G04.3 empty path).
  const empty = mintWorkspace(w.deps, 'Empty', 'wsE');
  const emptyBackup = getAction('create_backup').run(w.deps, { workspaceId: empty.workspaceId, idempotencyKey: 'eb' });
  const emptyVerify = getAction('verify_backup').run(w.deps, { source: emptyBackup.artifactRef });
  assert.equal(emptyVerify.ok && emptyVerify.entryCount === 0 && emptyVerify.balanceOk, true, 'an empty backup verifies with zero entries');
  assert.ok(existsSync(emptyBackup.artifactRef) && readdirSync(emptyBackup.artifactRef).includes('FORMAT.md'), 'every bundle ships a FORMAT.md');
});

// --- 9. The backup registry is machine-local: it never rides a snapshot across workspaces ---------

test('G04 invariant: a restored workspace inherits NO backup history, so deleteBackup cannot erase a source artifact', () => {
  const w = world();
  seedLedger(w, 1);
  // Two backups: the FIRST creates a `backups` row, so the SECOND's snapshot is taken while that row
  // (with its machine-local storage_ref pointing at the FIRST artifact) already exists. If the backups
  // registry rode the snapshot, restoring the second would copy that row into the new workspace.
  const b1 = w.call('create_backup', { idempotencyKey: 'b1' });
  const b2 = w.call('create_backup', { idempotencyKey: 'b2' });
  assert.equal(b1.ok && b2.ok, true);

  const restore = getAction('restore_backup').run(w.deps, {
    source: b2.artifactRef,
    newWorkspaceName: 'Restored',
    confirmed: true,
    idempotencyKey: 'rb',
  });
  assert.equal(restore.ok, true, `restore failed: ${JSON.stringify(restore)}`);
  const newWs = restore.workspaceId;

  // The restored workspace's backup history is EMPTY and references NONE of the source's artifacts.
  const listed = getAction('list_backups').run(w.deps, { workspaceId: newWs });
  assert.equal(listed.ok, true);
  assert.equal(listed.backups.length, 0, 'a restored workspace must inherit an EMPTY backup history, not the source registry');
  for (const r of w.deps.store.db.prepare('SELECT storage_ref FROM backups WHERE workspace_id = ?').all(newWs)) {
    assert.notEqual(r.storage_ref, b1.artifactRef, 'a restored backup row must never point at a source artifact');
    assert.notEqual(r.storage_ref, b2.artifactRef, 'a restored backup row must never point at a source artifact');
  }

  // deleteBackup in the restored workspace touches only ITS OWN artifacts: a backup made in the
  // restored ws deletes cleanly, and BOTH source artifacts remain on disk, untouched.
  const b3 = getAction('create_backup').run(w.deps, { workspaceId: newWs, idempotencyKey: 'b3' });
  assert.equal(b3.ok, true);
  const del = getAction('delete_backup').run(w.deps, { workspaceId: newWs, backupId: b3.backupId, idempotencyKey: 'del3' });
  assert.equal(del.ok, true);
  assert.equal(existsSync(b3.artifactRef), false, 'a delete in the restored ws erases its OWN artifact');
  assert.equal(existsSync(b1.artifactRef), true, 'the SOURCE artifact must survive a restored-workspace delete');
  assert.equal(existsSync(b2.artifactRef), true, 'the SOURCE artifact must survive a restored-workspace delete');

  // The source workspace is untouched: it still lists its own two backups.
  const srcList = w.call('list_backups', {});
  assert.equal(srcList.ok, true);
  assert.equal(srcList.backups.length, 2, 'the source workspace keeps its own two backups');
});

// --- 10. A non-null ADDITIVE column value survives restore (the G04xG05 interaction) --------------

test('G04 invariant: a non-null additive column (G05 document.rendered_template_id) survives backup -> restore, remapped to the restored template', () => {
  const w = world();
  seedLedger(w, 1); // a real ledger, so the snapshot is a real workspace and not an empty edge case.
  const db = w.deps.store.db;

  // Give the workspace a document_template (a workspace-scoped row, so restore RE-MINTS its id) and a
  // document, then stamp the document with a NON-NULL rendered_template_id. That column ships ONLY
  // through ADDITIVE_COLUMNS (it is absent from SCHEMA_SQL's base CREATE), so it is exactly the column
  // the G04 backup snapshot must widen via applyAdditiveSchema or silently lose. We set it directly on
  // the seeded document row: the natural freeze path (set_default_document_template + issue_invoice)
  // needs the full VAT/creditor/QR scaffolding, and the value under test is identical either way.
  const tpl = w.call('create_document_template', {
    documentKind: 'invoice',
    name: 'Briefpapier',
    idempotencyKey: 'covgap-tpl',
  });
  assert.equal(tpl.ok, true, `create_document_template failed: ${JSON.stringify(tpl)}`);
  const doc = w.call('create_document', { type: 'invoice', idempotencyKey: 'covgap-doc' });
  assert.equal(doc.ok, true, `create_document failed: ${JSON.stringify(doc)}`);
  // Read the template's real primary key back (do not assume the return field IS the PK), then stamp it.
  const srcTplId = db.prepare('SELECT id FROM document_template WHERE workspace_id = ?').get(w.workspaceId).id;
  db.prepare('UPDATE document SET rendered_template_id = ? WHERE id = ?').run(srcTplId, doc.document.id);

  // Non-vacuity, BEFORE backup: the value under test is genuinely non-null in the source.
  const srcVal = db.prepare('SELECT rendered_template_id FROM document WHERE id = ?').get(doc.document.id).rendered_template_id;
  assert.equal(srcVal, srcTplId, 'fixture did not stamp the expected rendered_template_id');
  assert.notEqual(srcVal, null, 'the additive column must be non-null before backup, else the test is vacuous');

  // Backup, then restore into a brand-new workspace.
  const bkp = w.call('create_backup', { idempotencyKey: 'covgap-bkp' });
  assert.equal(bkp.ok, true, `backup failed: ${JSON.stringify(bkp)}`);
  const restore = getAction('restore_backup').run(w.deps, {
    source: bkp.artifactRef,
    newWorkspaceName: 'Restored Additive',
    confirmed: true,
    idempotencyKey: 'covgap-rb',
  });
  assert.equal(restore.ok, true, `restore failed: ${JSON.stringify(restore)}`);
  const newWs = restore.workspaceId;

  // The restored document carries a NON-NULL rendered_template_id. This is the assertion the fix
  // exists for: before it, the snapshot omitted the additive column entirely, so a value it never
  // copied could not survive the round trip.
  const restoredDocs = db.prepare('SELECT id, rendered_template_id FROM document WHERE workspace_id = ?').all(newWs);
  assert.equal(restoredDocs.length, 1, 'the restored workspace must hold the one document');
  const restoredVal = restoredDocs[0].rendered_template_id;
  assert.ok(
    restoredVal !== null && restoredVal !== undefined,
    'rendered_template_id was DROPPED by backup -> restore (the additive column did not survive)',
  );

  // CORRECT ASSERTION: the value is REMAPPED, not preserved verbatim. rendered_template_id is declared
  // `TEXT REFERENCES document_template(id)` (schema.ts ADDITIVE_COLUMNS), and document_template is
  // itself a workspace-scoped table INSIDE the snapshot scope, so restore RE-MINTS the template id and
  // remaps the FK to it (portability.ts loadTable/remapValue treats it as a foreign key). Therefore the
  // restored value must NOT equal the source id, and must resolve to a document_template row that lives
  // in the RESTORED workspace. (Were the value copied verbatim instead, it would be a dangling id and
  // the pre-commit foreign_key_check would have failed the restore outright.)
  assert.notEqual(
    restoredVal,
    srcTplId,
    'rendered_template_id must be RE-MINTED (its template is a scoped, re-minted row), not the source id',
  );
  const restoredTpl = db.prepare('SELECT workspace_id FROM document_template WHERE id = ?').get(restoredVal);
  assert.ok(restoredTpl !== undefined, 'the restored rendered_template_id must resolve to a real template, not a dangling id');
  assert.equal(restoredTpl.workspace_id, newWs, 'rendered_template_id must be remapped INTO the restored workspace');
});
