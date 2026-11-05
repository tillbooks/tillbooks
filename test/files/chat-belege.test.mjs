/**
 * N02 (D183), chat Belege: the confined `sourcePath` reader, `attach` on the four acts (direct and
 * drafted), pending files and their sweep, the drop link lifecycle through the drop face, the
 * Belegeingang scan, and the `humanOnly` settings flag.
 *
 * Every file here is SYNTHETIC: a few magic-number bytes and invented text in a temporary home folder
 * the suite creates and removes. No real receipt, bank line or company appears.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleDropCall } from '../../dist/api/drop-face.js';
import { createScheduler } from '../../dist/api/scheduler.js';
import { createLocalHttpRouter } from '../../dist/api/local-http.js';
import { resolveServedActor } from '../../dist/api/session.js';
import { readConfinedFile, sniffType } from '../../dist/core/files/index.js';
import { fixedClock } from '../../dist/core/clock.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

// --- synthetic bytes -------------------------------------------------------------------------------
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic receipt, Muster Papeterie')]);
const JPEG_B = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('a second synthetic receipt')]);
const PDF = Buffer.from('%PDF-1.4\nsynthetic Beleg Bürobedarf CHF 84.50\n');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic png')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 synthetic')]);
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.from('synthetic')]);

/** A temporary home with the default roots and a few hostile neighbours. */
function makeHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'till-n02-')));
  const uploads = join(home, '.claude', 'uploads', 's1');
  mkdirSync(uploads, { recursive: true });
  mkdirSync(join(home, 'secret'), { recursive: true });
  mkdirSync(join(home, '.claude', 'uploads-evil'), { recursive: true });
  writeFileSync(join(uploads, 'r.jpg'), JPEG);
  writeFileSync(join(uploads, 'b.jpg'), JPEG_B);
  writeFileSync(join(uploads, 'beleg.pdf'), PDF);
  writeFileSync(join(uploads, 'notes.txt'), 'plain text, not a receipt');
  writeFileSync(join(home, 'secret', 'id_key'), 'NOT A REAL KEY, synthetic secret');
  writeFileSync(join(home, 'secret', 'outside.jpg'), JPEG);
  writeFileSync(join(home, '.claude', 'uploads-evil', 'x.jpg'), JPEG);
  symlinkSync(join(home, 'secret', 'outside.jpg'), join(uploads, 'link.jpg'));
  symlinkSync(join(home, 'secret', 'id_key'), join(uploads, 'key.jpg'));
  writeFileSync(join(home, 'secret', 'hard-src.jpg'), JPEG_B);
  linkSync(join(home, 'secret', 'hard-src.jpg'), join(uploads, 'hard.jpg'));
  // A sparse file over the 25 MiB cap whose first bytes ARE a PDF header: size is checked before a read.
  writeFileSync(join(uploads, 'big.pdf'), Buffer.from('%PDF-1.4\n'));
  truncateSync(join(uploads, 'big.pdf'), 26 * 1024 * 1024);
  return { home, uploads, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Deps with the local-file grant, as `till mcp` / `till up` hand them over. */
function localDeps(home) {
  return { ...freshDeps(), localFiles: { home } };
}

function human(deps, name, input) {
  return getAction(name).run({ ...deps, actor: 'studio' }, input);
}

function agentMcp(deps, name, args) {
  return JSON.parse(callTool({ ...deps, actor: 'agent' }, name, args).content[0].text);
}

function postInput(workspaceId, accId, key, extra = {}) {
  return {
    workspaceId,
    date: '2026-06-12',
    description: 'Bürobedarf',
    source: 'manual',
    idempotencyKey: key,
    lines: [
      { account: accId('6500'), debit: 8450 },
      { account: accId('1020'), credit: 8450 },
    ],
    ...extra,
  };
}

function entryCount(deps, workspaceId) {
  return deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(workspaceId).n;
}

function filesOn(deps, workspaceId, kind, id) {
  return deps.store.db
    .prepare('SELECT * FROM stored_file WHERE workspace_id = ? AND entity_kind = ? AND entity_id = ? ORDER BY created_at, rowid')
    .all(workspaceId, kind, id);
}

// --- the confined reader -----------------------------------------------------------------------

test('the sniffer reads PDF, JPEG, PNG, HEIC and WebP by their bytes, and nothing else', () => {
  assert.equal(sniffType(PDF), 'application/pdf');
  assert.equal(sniffType(JPEG), 'image/jpeg');
  assert.equal(sniffType(PNG), 'image/png');
  assert.equal(sniffType(WEBP), 'image/webp');
  assert.equal(sniffType(HEIC), 'image/heic');
  assert.equal(sniffType(Buffer.from('#!/bin/sh\necho hi')), null);
  assert.equal(sniffType(Buffer.from('synthetic secret, a config file and not a receipt')), null);
});

test('sourcePath confinement: .., symlink escape, hard link, absolute outside, sibling prefix, relative, ~user, NUL', () => {
  const h = makeHome();
  try {
    const roots = [join(h.home, '.claude', 'uploads')];
    const grant = { home: h.home };
    const read = (sourcePath) => readConfinedFile({ sourcePath, roots, grant });
    const reason = (r) => [r.error, r.reason];

    assert.equal(read('~/.claude/uploads/s1/r.jpg').file.mime, 'image/jpeg', 'the happy path reads');
    assert.deepEqual(reason(read('~/.claude/uploads/../../secret/outside.jpg')), ['path_not_allowed', 'outside_roots'], '`..` leaving the root');
    assert.deepEqual(reason(read('~/.claude/uploads/s1/../../../secret/id_key')), ['path_not_allowed', 'outside_roots']);
    assert.deepEqual(reason(read('~/.claude/uploads/s1/link.jpg')), ['path_not_allowed', 'outside_roots'], 'a symlink resolving outside');
    assert.deepEqual(reason(read('~/.claude/uploads/s1/key.jpg')), ['path_not_allowed', 'outside_roots'], 'a symlink to a secret');
    assert.deepEqual(reason(read('~/.claude/uploads/s1/hard.jpg')), ['path_not_allowed', 'hard_link'], 'a hard link to a file outside');
    assert.deepEqual(reason(read(join(h.home, 'secret', 'outside.jpg'))), ['path_not_allowed', 'outside_roots'], 'absolute outside the root');
    assert.deepEqual(reason(read('~/.claude/uploads-evil/x.jpg')), ['path_not_allowed', 'outside_roots'], 'a sibling sharing the prefix is not inside');
    assert.deepEqual(reason(read('s1/r.jpg')), ['path_not_allowed', 'not_absolute']);
    assert.deepEqual(reason(read('~root/.claude/uploads/s1/r.jpg')), ['path_not_allowed', 'not_absolute']);
    assert.deepEqual(reason(read('~/.claude/uploads/s1/r.jpg\0.pdf')), ['path_not_allowed', 'invalid_path']);
    assert.deepEqual(reason(read('~/.claude/uploads/s1/notes.txt')), ['unsupported_type', 'not_pdf_or_image'], 'a text file is never read past its head');
    assert.equal(read('~/.claude/uploads/s1/big.pdf').error, 'file_too_large', 'oversize refused from the descriptor size');
    assert.equal(read('~/.claude/uploads/s1/gone.jpg').error, 'file_not_found');
    // Outside the roots, even a missing file answers path_not_allowed: no existence oracle.
    assert.deepEqual(reason(read(join(h.home, 'secret', 'nope.jpg'))), ['path_not_allowed', 'outside_roots']);
    assert.deepEqual(reason(read('~/.claude/uploads/s1')), ['path_not_allowed', 'not_a_file'], 'a directory');
    // Served mode: no grant, refused before the string is looked at.
    assert.equal(readConfinedFile({ sourcePath: '~/.claude/uploads/s1/r.jpg', roots, grant: undefined }).error, 'source_path_local_only');
  } finally {
    h.cleanup();
  }
});

test('a FIFO in a root is refused without parking the process', () => {
  const h = makeHome();
  try {
    const fifo = join(h.uploads, 'pipe.jpg');
    try {
      execFileSync('mkfifo', [fifo]);
    } catch {
      return; // no mkfifo on this host: nothing to prove here
    }
    const r = readConfinedFile({ sourcePath: fifo, roots: [join(h.home, '.claude', 'uploads')], grant: { home: h.home } });
    assert.deepEqual([r.error, r.reason], ['path_not_allowed', 'not_a_file']);
  } finally {
    h.cleanup();
  }
});

test('files_upload and capture_document take sourcePath on a local host, and refuse it served', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId } = mintWorkspace(deps);
    const up = human(deps, 'files_upload', { workspaceId, sourcePath: '~/.claude/uploads/s1/r.jpg', idempotencyKey: 'fu-path' });
    assert.equal(up.ok, true, JSON.stringify(up));
    assert.equal(up.file.mime, 'image/jpeg', 'the mime is the sniffed type');
    assert.equal(up.file.filename, 'r.jpg');
    const both = human(deps, 'files_upload', { workspaceId, sourcePath: '~/.claude/uploads/s1/r.jpg', contentBase64: 'AAAA', idempotencyKey: 'fu-both' });
    assert.equal(both.error, 'invalid_input');
    const cap = human(deps, 'capture_document', { workspaceId, sourcePath: '~/.claude/uploads/s1/beleg.pdf', idempotencyKey: 'cd-path' });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    assert.equal(typeof cap.captureId, 'string');

    const served = freshDeps(); // no localFiles: till serve, served mode, an embedder
    const ws2 = mintWorkspace(served).workspaceId;
    assert.equal(human(served, 'files_upload', { workspaceId: ws2, sourcePath: '~/.claude/uploads/s1/r.jpg' }).error, 'source_path_local_only');
    assert.equal(human(served, 'capture_document', { workspaceId: ws2, sourcePath: '~/.claude/uploads/s1/r.jpg', idempotencyKey: 'x' }).error, 'source_path_local_only');
  } finally {
    h.cleanup();
  }
});

// --- attach on the acts --------------------------------------------------------------------------

test('post_entry with attach books AND links in one act; a refused path posts nothing', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const posted = human(deps, 'post_entry', postInput(workspaceId, accId, 'pe-a', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.equal(posted.attached.length, 1);
    const linked = filesOn(deps, workspaceId, 'journal_entry', posted.entryId);
    assert.equal(linked.length, 1);
    assert.equal(linked[0].mime, 'image/jpeg');
    assert.notEqual(linked[0].retention_statutory_until, null, 'a link to a posted entry derives the OR 958f floor');

    // A replay of the same key posts nothing new and links nothing twice.
    const again = human(deps, 'post_entry', postInput(workspaceId, accId, 'pe-a', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(again.ok, true);
    assert.equal(again.attached[0].alreadyLinked, true);
    assert.equal(entryCount(deps, workspaceId), 1);
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', posted.entryId).length, 1);

    const before = entryCount(deps, workspaceId);
    for (const [path, code] of [
      ['~/.claude/uploads/../../secret/id_key', 'path_not_allowed'],
      ['~/.claude/uploads/s1/notes.txt', 'unsupported_type'],
      ['~/.claude/uploads/s1/missing.jpg', 'file_not_found'],
    ]) {
      const refused = human(deps, 'post_entry', postInput(workspaceId, accId, `pe-bad-${code}`, { attach: [{ sourcePath: path }] }));
      assert.equal(refused.error, code, JSON.stringify(refused));
    }
    assert.equal(entryCount(deps, workspaceId), before, 'a refused attachment books nothing');
    const malformed = human(deps, 'post_entry', postInput(workspaceId, accId, 'pe-mal', { attach: [{ fileId: 'f', sourcePath: 'x' }] }));
    assert.equal(malformed.error, 'invalid_input');
  } finally {
    h.cleanup();
  }
});

test('a known receipt (R1): an unlinked twin is linked; a second booking needs a person\'s reason, gets its own filing row; refuse and allow', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    // An unlinked twin (a Beleg ohne Buchung) is consumed, not copied.
    const loose = human(deps, 'files_upload', { workspaceId, sourcePath: '~/.claude/uploads/s1/b.jpg', idempotencyKey: 'loose' });
    const one = human(deps, 'post_entry', postInput(workspaceId, accId, 'k1', { attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }] }));
    assert.equal(one.attached[0].fileId, loose.file.id, 'the stored unlinked file is linked itself');
    assert.equal(one.attached[0].duplicate, true);
    // The same receipt on a second entry: refused by default, naming the entry that holds it, and nothing posts.
    const n = entryCount(deps, workspaceId);
    const refused = human(deps, 'post_entry', postInput(workspaceId, accId, 'k2', { attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }] }));
    assert.equal(refused.error, 'receipt_already_booked', JSON.stringify(refused));
    assert.deepEqual(refused.holders.map((x) => [x.entityKind, x.entityId]), [['journal_entry', one.entryId]]);
    assert.equal(entryCount(deps, workspaceId), n, 'the refused booking posted nothing');
    // A confirmation needs its reason.
    const noReason = human(deps, 'post_entry', postInput(workspaceId, accId, 'k2', { bookAgain: true, attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }] }));
    assert.equal(noReason.error, 'reason_required');
    // Confirmed with a reason: booked, never moved off the first entry, the bytes stored once, the reason recorded.
    const two = human(deps, 'post_entry', postInput(workspaceId, accId, 'k2', {
      bookAgain: true, overrideReason: 'Teilzahlung, derselbe Beleg', attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }],
    }));
    assert.equal(two.ok, true, JSON.stringify(two));
    assert.equal(two.attached[0].duplicateOf, loose.file.id);
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', one.entryId).length, 1, 'the first entry keeps its Beleg');
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', two.entryId).length, 1);
    const blobs = deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?').get(workspaceId, loose.file.sha256).n;
    assert.equal(blobs, 1, 'the bytes are stored once');
    const override = deps.store.db.prepare('SELECT * FROM receipt_override WHERE workspace_id = ?').all(workspaceId);
    assert.equal(override.length, 1);
    assert.equal(override[0].reason, 'Teilzahlung, derselbe Beleg');
    assert.equal(override[0].target_kind, 'journal_entry');
    assert.equal(JSON.parse(override[0].holders_json)[0].entityId, one.entryId);
    // An explicit fileId of a booked receipt is judged the same way.
    const byId = human(deps, 'post_entry', postInput(workspaceId, accId, 'k4', { attach: [{ fileId: loose.file.id }] }));
    assert.equal(byId.error, 'receipt_already_booked');

    // refuse: even a person's confirmation is refused.
    assert.equal(human(deps, 'settings_set', { workspaceId, key: 'files.duplicate_beleg', value: 'refuse', reason: 'Prüfung', idempotencyKey: 'dup-r' }).ok, true);
    const hard = human(deps, 'post_entry', postInput(workspaceId, accId, 'k3', {
      bookAgain: true, overrideReason: 'trotzdem', attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }],
    }));
    assert.equal(hard.error, 'receipt_already_booked');
    assert.equal(hard.setting, 'files.duplicate_beleg');
    // allow: the rule is off.
    assert.equal(human(deps, 'settings_set', { workspaceId, key: 'files.duplicate_beleg', value: 'allow', reason: 'Prüfung', idempotencyKey: 'dup-a' }).ok, true);
    const free = human(deps, 'post_entry', postInput(workspaceId, accId, 'k5', { attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }] }));
    assert.equal(free.ok, true, JSON.stringify(free));
  } finally {
    h.cleanup();
  }
});

test('create_vendor_bill and record_expense link to the bill; book_bank_line asks the bank line\'s own right', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const vendor = human(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Muster Papeterie AG', idempotencyKey: 'v' });
    const bill = human(deps, 'record_expense', {
      workspaceId,
      vendorId: vendor.contact.id,
      billDate: '2026-06-10',
      amountMinor: 8450,
      expenseAccountId: accId('6500'),
      idempotencyKey: 'rx',
      attach: [{ sourcePath: '~/.claude/uploads/s1/beleg.pdf' }],
    });
    assert.equal(bill.ok, true, JSON.stringify(bill));
    assert.equal(filesOn(deps, workspaceId, 'vendor_bill', bill.vendorBillId).length, 1);
    const draft = human(deps, 'create_vendor_bill', {
      workspaceId,
      vendorId: vendor.contact.id,
      billDate: '2026-06-11',
      amountMinor: 1200,
      expenseAccountId: accId('6500'),
      idempotencyKey: 'cvb',
      attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }],
    });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    assert.equal(filesOn(deps, workspaceId, 'vendor_bill', draft.vendorBillId).length, 1);
  } finally {
    h.cleanup();
  }
  // book_bank_line links to the bank line, in the booking's own transaction (the conformance world).
  const fx = fixture();
  const input = SCENARIOS.book_bank_line(fx);
  const asHuman = { ...fx.deps, actor: 'studio' };
  const up = getAction('files_upload').run(asHuman, { workspaceId: fx.workspaceId, contentBase64: PDF.toString('base64'), mime: 'application/pdf', idempotencyKey: 'bb-file' });
  const booked = getAction('book_bank_line').run(asHuman, { ...input, attach: [{ fileId: up.file.id }] });
  assert.equal(booked.ok, true, JSON.stringify(booked));
  assert.deepEqual(filesOn(fx.deps, fx.workspaceId, 'bank_txn', input.bankTxnId).map((f) => f.id), [up.file.id]);
  fx.deps.store.close();
});

// --- the drafted act -----------------------------------------------------------------------------

test('a drafted post_entry stores the receipt PENDING (invisible, unlinkable), approval links it, the payload holds only the fileId', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'agent-1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    assert.equal(drafted.dialCapability, 'close-period', 'attach is governed by the stricter of post and the files_link family');
    const row = deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(drafted.actionId);
    const payload = JSON.parse(row.payload_json);
    assert.equal(payload.attach.length, 1);
    assert.deepEqual(Object.keys(payload.attach[0]), ['fileId'], 'the stored payload names the file, never the path');
    const fileId = payload.attach[0].fileId;
    const pending = deps.store.db.prepare('SELECT action_id FROM stored_file_pending WHERE id = ?').get(fileId);
    assert.equal(pending.action_id, drafted.actionId);

    // Invisible and unlinkable.
    const search = human(deps, 'files_search', { workspaceId });
    assert.equal(search.files.some((f) => f.id === fileId), false, 'a pending file is not in the filing');
    const entry = human(deps, 'post_entry', postInput(workspaceId, accId, 'other'));
    assert.equal(human(deps, 'files_link', { workspaceId, fileId, entityKind: 'journal_entry', entityId: entry.entryId }).error, 'not_found');
    assert.equal(human(deps, 'post_entry', postInput(workspaceId, accId, 'thief', { attach: [{ fileId }] })).error, 'not_found');
    assert.equal(agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'thief2', { attach: [{ fileId }] })).error, 'not_found');

    // A same-key replay stores nothing new.
    const replay = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'agent-1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(replay.actionId, drafted.actionId);
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_pending').get().n, 1);

    const approved = human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId });
    assert.equal(approved.ok, true, JSON.stringify(approved));
    const posted = deps.store.db.prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND idempotency_key = 'agent-1'").get(workspaceId);
    assert.ok(posted, 'the approved entry posted');
    const linked = filesOn(deps, workspaceId, 'journal_entry', posted.id);
    assert.deepEqual(linked.map((f) => f.id), [fileId], 'the pending file is linked in the act');
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_pending').get().n, 0);
  } finally {
    h.cleanup();
  }
});

test('a rejected Vorschlag\'s pending file is swept with its blob; a refused draft stores nothing', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'agent-r', { attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }] }));
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    assert.equal(human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: 'falsch' }).ok, true);
    const scheduler = createScheduler(deps, { runDue: () => {}, bankAutoSync: false });
    scheduler.belegeingangTickOnce();
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ?').get(workspaceId).n, 0, 'the file is gone');
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_blob WHERE workspace_id = ?').get(workspaceId).n, 0, 'and its bytes');

    const refused = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'agent-x', { attach: [{ sourcePath: '~/.claude/uploads/../../secret/id_key' }] }));
    assert.equal(refused.error, 'path_not_allowed');
    assert.equal(deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_action WHERE idempotency_key = 'agent-x'").get().n, 0, 'no Vorschlag');
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file').get().n, 0, 'no file');
  } finally {
    h.cleanup();
  }
});

test('the dial: post at auto still drafts a post_entry WITH attach (close-period asks), and executes one without', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const set = human(deps, 'set_agent_dial', { workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'dial-post' });
    assert.equal(set.ok, true, JSON.stringify(set));
    const plain = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'auto-1'));
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.equal(plain.drafted, undefined, 'without attach the post executes at auto');
    const withBeleg = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'auto-2', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(withBeleg.drafted, true, 'attach never carries a link past the files_link dial');
    assert.equal(withBeleg.dialCapability, 'close-period');
  } finally {
    h.cleanup();
  }
});

// --- humanOnly ------------------------------------------------------------------------------------

test('humanOnly: an agent can neither change nor propose files.source_roots or files.belegeingang_folder', () => {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  for (const key of ['files.source_roots', 'files.belegeingang_folder']) {
    const asAgent = agentMcp(deps, 'settings_set', { workspaceId, key, value: '~/', reason: 'alles lesen', idempotencyKey: `ho-${key}` });
    assert.equal(asAgent.error, 'human_only', JSON.stringify(asAgent));
    assert.equal(agentMcp(deps, 'settings_reset', { workspaceId, key, reason: 'zurück', idempotencyKey: `hr-${key}` }).error, 'human_only');
  }
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM agent_action').get().n, 0, 'not even a Vorschlag');
  // A direct registry call as the agent seat (the auto dial path) is refused by the engine too.
  const direct = getAction('settings_set').run({ ...deps, actor: 'agent' }, { workspaceId, key: 'files.source_roots', value: '~/', reason: 'r', idempotencyKey: 'ho-direct' });
  assert.equal(direct.error, 'human_only');
  const person = human(deps, 'settings_set', { workspaceId, key: 'files.source_roots', value: '~/Belege', reason: 'eigener Ordner', idempotencyKey: 'ho-human' });
  assert.equal(person.ok, true, JSON.stringify(person));
  const listed = human(deps, 'settings_get', { workspaceId, key: 'files.source_roots' });
  assert.equal(listed.setting.humanOnly, true);
});

// --- the drop link ---------------------------------------------------------------------------------

test('drop link lifecycle: minted by the agent, resolved and redeemed only through the Studio face, single-use, expiring', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const entry = human(deps, 'post_entry', postInput(workspaceId, accId, 'dl-e'));
    const minted = agentMcp(deps, 'files_drop_link', { workspaceId, target: { kind: 'journal_entry', id: entry.entryId }, idempotencyKey: 'dl-1' });
    assert.equal(minted.ok, true, JSON.stringify(minted));
    assert.match(minted.path, /^\/drop\/[A-Za-z0-9_-]{20,}$/);
    const stored = deps.store.db.prepare('SELECT token_hash FROM file_drop_link WHERE id = ?').get(minted.linkId);
    assert.notEqual(stored.token_hash, minted.token, 'the token is stored hashed');

    const studio = { ...deps, actor: 'studio' };
    const resolved = handleDropCall(studio, 'resolve', { token: minted.token });
    assert.equal(resolved.status, 200, JSON.stringify(resolved));
    assert.equal(resolved.body.link.state, 'ready');
    assert.equal(resolved.body.link.target.text, 'Bürobedarf');

    // Wrong type: refused, the link stays usable.
    const wrong = handleDropCall(studio, 'redeem', { token: minted.token, contentBase64: Buffer.from('plain text').toString('base64'), filename: 'a.txt' });
    assert.equal(wrong.body.error, 'unsupported_type');
    // An agent seat cannot redeem even with the token in hand.
    const asAgent = handleDropCall({ ...deps, actor: 'agent' }, 'redeem', { token: minted.token, contentBase64: PDF.toString('base64'), filename: 'b.pdf' });
    assert.equal(asAgent.body.error, 'human_only');

    const done = handleDropCall(studio, 'redeem', { token: minted.token, contentBase64: PDF.toString('base64'), filename: 'beleg.pdf' });
    assert.equal(done.status, 200, JSON.stringify(done));
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', entry.entryId).length, 1);
    const used = handleDropCall(studio, 'redeem', { token: minted.token, contentBase64: PNG.toString('base64'), filename: 'c.png' });
    assert.equal(used.status, 410);
    assert.equal(used.body.error, 'drop_link_used');
    // The minting memo no longer holds the clear token.
    const memo = deps.store.db.prepare("SELECT result_json FROM idempotency WHERE verb = 'files_drop_link' AND key = 'dl-1'").get();
    assert.equal(memo.result_json.includes(minted.token), false);
    assert.equal(handleDropCall(studio, 'resolve', { token: 'x'.repeat(40) }).status, 404);

    // Expiry: a second link, read a day and a bit later.
    const second = agentMcp(deps, 'files_drop_link', { workspaceId, target: { kind: 'journal_entry', id: entry.entryId }, idempotencyKey: 'dl-2' });
    const later = { ...studio, clock: fixedClock('2026-07-17T01:00:00.000Z') };
    assert.equal(handleDropCall(later, 'resolve', { token: second.token }).body.link.state, 'expired');
    assert.equal(handleDropCall(later, 'redeem', { token: second.token, contentBase64: PDF.toString('base64') }).body.error, 'drop_link_expired');

    // A target that does not exist, or a Vorschlag of another verb, is refused at minting.
    assert.equal(agentMcp(deps, 'files_drop_link', { workspaceId, target: { kind: 'journal_entry', id: 'nope' }, idempotencyKey: 'dl-3' }).error, 'entity_not_found');
  } finally {
    h.cleanup();
  }
});

test('a drop onto a pending Vorschlag is held pending and linked to the entry when the Vorschlag is approved', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'vd-1'));
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    const minted = agentMcp(deps, 'files_drop_link', { workspaceId, target: { kind: 'drafted_action', id: drafted.actionId }, idempotencyKey: 'vd-link' });
    assert.equal(minted.ok, true, JSON.stringify(minted));
    const studio = { ...deps, actor: 'studio' };
    const dropped = handleDropCall(studio, 'redeem', { token: minted.token, contentBase64: JPEG.toString('base64'), filename: 'quittung.jpg' });
    assert.equal(dropped.status, 200, JSON.stringify(dropped));
    assert.equal(dropped.body.pending, true);
    assert.equal(human(deps, 'files_search', { workspaceId }).files.length, 0, 'held, not filed');
    assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId }).ok, true);
    const posted = deps.store.db.prepare("SELECT id FROM journal_entry WHERE idempotency_key = 'vd-1'").get();
    assert.deepEqual(filesOn(deps, workspaceId, 'journal_entry', posted.id).map((f) => f.id), [dropped.body.fileId]);
  } finally {
    h.cleanup();
  }
});

test('the drop face is mounted beside the REST twins in local mode only, and needs the Studio key', async () => {
  const deps = freshDeps();
  const local = createLocalHttpRouter(deps, { rest: true, studioKey: { current: () => 'k'.repeat(43), accepts: () => false } });
  assert.ok(local.faces.some((f) => f.name === 'studio-drop'));
  const served = createLocalHttpRouter(deps, { rest: true, servedMode: { enabled: true, headerName: 'x-forwarded-user' } });
  assert.equal(served.faces.some((f) => f.name === 'studio-drop'), false, 'served mode mounts no drop face');
  const noRest = createLocalHttpRouter(deps, {});
  assert.equal(noRest.faces.some((f) => f.name === 'studio-drop'), false, 'till serve (no REST twins) mounts none');
  await local.closeAll?.();
});

// --- the Belegeingang ------------------------------------------------------------------------------

test('Belegeingang: captured once as the owner seat, moved to Erledigt after commit, a copy deduped, a WebP named, keep never re-captures', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId } = mintWorkspace(deps);
    const scheduler = createScheduler(deps, { runDue: () => {}, bankAutoSync: false });
    // No folder yet: nothing is created, the status says so.
    let [report] = scheduler.belegeingangTickOnce();
    assert.equal(report.state, 'folder_missing');
    assert.equal(existsSync(join(h.home, 'TILL', 'Belegeingang')), false, 'TILL never creates the folder');

    const folder = join(h.home, 'TILL', 'Belegeingang');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'a.pdf'), PDF);
    writeFileSync(join(folder, 'a-kopie.pdf'), PDF);
    writeFileSync(join(folder, 'bild.webp'), WEBP);
    writeFileSync(join(folder, '.DS_Store'), 'x');
    [report] = scheduler.belegeingangTickOnce();
    assert.equal(report.state, 'ok', JSON.stringify(report));
    assert.equal(report.captured, 1);
    assert.equal(report.duplicates, 1, 'the same bytes twice are captured once');
    assert.deepEqual(report.errors.map((e) => [e.file, e.error]), [['bild.webp', 'unsupported_mime']]);
    assert.deepEqual(readdirSync(join(folder, 'Erledigt')).sort(), ['a-kopie.pdf', 'a.pdf']);
    assert.ok(existsSync(join(folder, 'bild.webp')), 'an unreadable file stays in place');
    const captures = deps.store.db.prepare('SELECT created_by FROM captures WHERE workspace_id = ?').all(workspaceId);
    assert.deepEqual(captures.map((c) => c.created_by), ['studio'], 'one capture, as the seated owner');
    const status = human(deps, 'belegeingang_status', { workspaceId });
    assert.equal(status.state, 'ok');
    assert.equal(status.waitingCaptures, 1);
    assert.equal(status.errors[0].file, 'bild.webp');

    // keep: the file stays and is never captured again.
    human(deps, 'settings_set', { workspaceId, key: 'files.belegeingang_after', value: 'keep', reason: 'Test', idempotencyKey: 'keep' });
    writeFileSync(join(folder, 'b.jpg'), JPEG_B);
    [report] = scheduler.belegeingangTickOnce();
    assert.equal(report.captured, 1);
    [report] = scheduler.belegeingangTickOnce();
    assert.equal(report.captured, 0, 'a kept file is remembered');
    assert.equal(report.duplicates, 0);
    assert.ok(existsSync(join(folder, 'b.jpg')));

    // off: never read.
    human(deps, 'settings_set', { workspaceId, key: 'files.belegeingang_scan', value: 'off', reason: 'Test', idempotencyKey: 'off' });
    [report] = scheduler.belegeingangTickOnce();
    assert.equal(report.state, 'off');
  } finally {
    h.cleanup();
  }
});

test('Belegeingang: a folder two workspaces name is skipped for both; no local grant means no scan at all', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    mintWorkspace(deps, 'Muster AG', 'ws-a');
    mintWorkspace(deps, 'Beispiel GmbH', 'ws-b');
    mkdirSync(join(h.home, 'TILL', 'Belegeingang'), { recursive: true });
    writeFileSync(join(h.home, 'TILL', 'Belegeingang', 'a.pdf'), PDF);
    const reports = createScheduler(deps, { runDue: () => {}, bankAutoSync: false }).belegeingangTickOnce();
    assert.deepEqual(reports.map((r) => r.state), ['folder_shared', 'folder_shared']);
    assert.ok(existsSync(join(h.home, 'TILL', 'Belegeingang', 'a.pdf')), 'nothing moved');

    const served = freshDeps();
    mintWorkspace(served);
    assert.deepEqual(createScheduler(served, { runDue: () => {}, bankAutoSync: false }).belegeingangTickOnce(), []);
  } finally {
    h.cleanup();
  }
});

test('the dial mirror of the attach acts equals the attach seam\'s own list, and every act declares attach', async () => {
  const { ATTACH_TARGET_KIND } = await import('../../dist/core/files/index.js');
  const { ATTACH_DIAL_ACTS } = await import('../../dist/core/agent/dialMap.js');
  assert.deepEqual([...ATTACH_DIAL_ACTS].sort(), Object.keys(ATTACH_TARGET_KIND).sort());
  for (const act of ATTACH_DIAL_ACTS) {
    assert.ok('attach' in getAction(act).inputSchema.properties, `${act} declares attach`);
    assert.equal(typeof getAction(act).prepareDraft, 'function', `${act} stores its draft receipts pending`);
  }
});

test('a plugin call never reads by path, and a served TILL mints no drop link', async () => {
  const { withinPluginCall } = await import('../../dist/core/plugins/callScope.js');
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const viaPlugin = withinPluginCall('plugin:demo', () =>
      getAction('files_upload').run({ ...deps, actor: 'plugin:demo' }, { workspaceId, sourcePath: '~/.claude/uploads/s1/r.jpg', idempotencyKey: 'pl' }),
    );
    assert.equal(viaPlugin.error, 'source_path_local_only', 'the jail is not widened by the engine');
    const entry = human(deps, 'post_entry', postInput(workspaceId, accId, 'srv-e'));
    // A served HUMAN member (the proxy-attested subject), who holds every right: refused all the same.
    const invite = human(deps, 'invite_member', { workspaceId, email: 'person@muster.example', role: 'owner', kind: 'human', idempotencyKey: 'inv' });
    assert.equal(invite.ok, true, JSON.stringify(invite));
    const servedDeps = () => {
      const id = resolveServedActor(deps.store, 'person@muster.example');
      return { ...deps, actor: id.actor, subject: id.subject, identitySource: id.identitySource };
    };
    assert.equal(getAction('accept_invite').run(servedDeps(), { token: invite.token }).ok, true);
    const served = getAction('files_drop_link').run(servedDeps(), { workspaceId, target: { kind: 'journal_entry', id: entry.entryId }, idempotencyKey: 'srv' });
    assert.equal(served.error, 'drop_link_local_only');
  } finally {
    h.cleanup();
  }
});

// --- critic round 1 (non-author probes, turned into tests) ------------------------------------------

test('critic F6: till up grants local file reads only when local AND bound to loopback', async () => {
  const { localFileGrantFor } = await import('../../dist/api/up.js');
  assert.deepEqual(localFileGrantFor({ served: false, host: '127.0.0.1', home: '/h' }), { home: '/h' });
  assert.deepEqual(localFileGrantFor({ served: false, host: '::1', home: '/h' }), { home: '/h' });
  assert.deepEqual(localFileGrantFor({ served: false, host: 'localhost', home: '/h' }), { home: '/h' });
  assert.equal(localFileGrantFor({ served: false, host: '0.0.0.0', home: '/h' }), undefined, 'a LAN bind reads nothing by path');
  assert.equal(localFileGrantFor({ served: false, host: '192.168.1.20', home: '/h' }), undefined);
  assert.equal(localFileGrantFor({ served: true, host: '127.0.0.1', home: '/h' }), undefined, 'served mode reads nothing by path');
});

test('critic F4: a symlinked folder inside a root is no existence oracle: a file, a missing file and a folder behind it answer alike', () => {
  const h = makeHome();
  try {
    mkdirSync(join(h.home, 'secret', 'sub'), { recursive: true });
    symlinkSync(join(h.home, 'secret'), join(h.uploads, 'dirlink'));
    symlinkSync(join(h.home, 'secret', 'gone.jpg'), join(h.uploads, 'dangling.jpg'));
    const read = (p) => readConfinedFile({ sourcePath: p, roots: [join(h.home, '.claude', 'uploads')], grant: { home: h.home } });
    const answers = [
      '~/.claude/uploads/s1/dirlink/outside.jpg',
      '~/.claude/uploads/s1/dirlink/missing.jpg',
      '~/.claude/uploads/s1/dirlink/sub',
      '~/.claude/uploads/s1/dirlink/nope/deeper.jpg',
      '~/.claude/uploads/s1/dangling.jpg',
    ].map((p) => {
      const r = read(p);
      return [r.error, r.reason];
    });
    for (const a of answers) assert.deepEqual(a, ['path_not_allowed', 'outside_roots']);
    // Security review of F4: a DANGLING folder link inside a root (s1/gone -> ~/secret/nope) is outside
    // too; walking past it to s1 would have answered file_not_found about a folder outside the roots.
    symlinkSync(join(h.home, 'secret', 'nope'), join(h.uploads, 'gone'));
    for (const p of ['~/.claude/uploads/s1/gone/x.jpg', '~/.claude/uploads/s1/gone/a/b.jpg']) {
      const r = read(p);
      assert.deepEqual([r.error, r.reason], ['path_not_allowed', 'outside_roots'], p);
    }
    // Inside a root, a missing file or folder is still named honestly.
    assert.equal(read('~/.claude/uploads/s1/missing.jpg').error, 'file_not_found');
    assert.equal(read('~/.claude/uploads/s1/r.jpg/inner.jpg').error, 'file_not_found');
    assert.equal(read('~/.claude/uploads/s9/missing.jpg').error, 'file_not_found');
  } finally {
    h.cleanup();
  }
});

test('critic F5: the hard-link rule holds on the descriptor and on the resolved path', () => {
  const h = makeHome();
  try {
    const read = (p) => readConfinedFile({ sourcePath: p, roots: [join(h.home, '.claude', 'uploads')], grant: { home: h.home } });
    // A hard link reached through an in-root symlink is refused too.
    symlinkSync(join(h.uploads, 'hard.jpg'), join(h.uploads, 'via-link.jpg'));
    assert.deepEqual([read('~/.claude/uploads/s1/via-link.jpg').error, read('~/.claude/uploads/s1/via-link.jpg').reason], ['path_not_allowed', 'hard_link']);
    // An in-root symlink to an in-root receipt is read (resolved before the open, never followed by it).
    symlinkSync(join(h.uploads, 'r.jpg'), join(h.uploads, 'alias.jpg'));
    assert.equal(read('~/.claude/uploads/s1/alias.jpg').file.mime, 'image/jpeg');
  } finally {
    h.cleanup();
  }
});

test('critic F3: a backup of books that minted a drop link restores beside the original, every restored link void', async () => {
  const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
  const { sequenceIdGen } = await import('../../dist/core/ids.js');
  const dir = mkdtempSync(join(tmpdir(), 'n02-restore-'));
  try {
    const clock = fixedClock('2026-06-15T10:00:00.000Z');
    const store = new SqliteStore({ location: join(dir, 'book.sqlite'), clock });
    const deps = { store, clock, ids: sequenceIdGen(), actor: 'studio', backupDir: join(dir, 'backups') };
    const { workspaceId, accId } = mintWorkspace(deps);
    const entry = getAction('post_entry').run(deps, postInput(workspaceId, accId, 'e1'));
    const link = getAction('files_drop_link').run(deps, { workspaceId, target: { kind: 'journal_entry', id: entry.entryId }, idempotencyKey: 'dl' });
    assert.equal(link.ok, true, JSON.stringify(link));
    const bkp = getAction('create_backup').run(deps, { workspaceId, idempotencyKey: 'bk' });
    assert.equal(bkp.ok, true, JSON.stringify(bkp));
    const restored = getAction('restore_backup').run(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored).slice(0, 400));
    const rows = store.db.prepare('SELECT workspace_id, token_hash, used_at FROM file_drop_link ORDER BY workspace_id').all();
    assert.equal(rows.length, 2);
    assert.equal(new Set(rows.map((r) => r.token_hash)).size, 2);
    const copy = rows.find((r) => r.workspace_id !== workspaceId);
    assert.match(copy.token_hash, /^restored-copy:/);
    assert.notEqual(copy.used_at, null, 'the restored link is void');
    // The original link still works, in the original books only.
    const resolved = handleDropCall(deps, 'resolve', { token: link.token });
    assert.equal(resolved.body.link.workspaceId, workspaceId);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('critic F7: an expired link loses its clear token from the mint memo, and old link rows are pruned', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const entry = human(deps, 'post_entry', postInput(workspaceId, accId, 'x-e'));
  const minted = human(deps, 'files_drop_link', { workspaceId, target: { kind: 'journal_entry', id: entry.entryId }, idempotencyKey: 'x-dl' });
  const memo = () => deps.store.db.prepare("SELECT result_json FROM idempotency WHERE verb = 'files_drop_link' AND key = 'x-dl'").get().result_json;
  assert.equal(memo().includes(minted.token), true, 'premise: the open link replays its token');
  // Two days later: expired, so the memo is scrubbed; the replay answers no token.
  const later = { ...deps, clock: fixedClock('2026-07-18T00:00:00.000Z') };
  createScheduler(later, { runDue: () => {}, bankAutoSync: false }).belegeingangTickOnce();
  assert.equal(memo().includes(minted.token), false);
  const replay = getAction('files_drop_link').run({ ...later, actor: 'studio' }, { workspaceId, target: { kind: 'journal_entry', id: entry.entryId }, idempotencyKey: 'x-dl' });
  assert.equal(replay.token, null);
  assert.equal(replay.url, null);
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM file_drop_link').get().n, 1, 'kept for files.drop_link_keep_days');
  const muchLater = { ...deps, clock: fixedClock('2026-09-30T00:00:00.000Z') };
  createScheduler(muchLater, { runDue: () => {}, bankAutoSync: false }).belegeingangTickOnce();
  assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM file_drop_link').get().n, 0, 'pruned after 30 days');
});

test('critic F2: a pending file is inert to every other door (sign request, get_content, update, delete), and the sweep never trips', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'a-1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    const fileId = JSON.parse(deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(drafted.actionId).payload_json).attach[0].fileId;
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file WHERE id = ?').get(fileId).n, 0, 'a pending file is not a stored_file row at all');
    const c = human(deps, 'create_contact', { workspaceId, partyRole: 'customer', name: 'Signer Muster', email: 'signer@example.invalid', idempotencyKey: 'c' });
    const sr = human(deps, 'sign_requests_create', { workspaceId, fileId, signerContactId: c.contact.id, signatureLevel: 'ses', idempotencyKey: 'sr' });
    assert.equal(sr.ok, false, 'a sign request cannot name a pending file');
    assert.equal(human(deps, 'files_get_content', { workspaceId, fileId }).ok, false);
    assert.equal(human(deps, 'files_update', { workspaceId, fileId, patch: { title: 'x' } }).error, 'not_found');
    assert.equal(human(deps, 'files_delete', { workspaceId, fileId, confirmed: true }).error, 'not_found');

    assert.equal(human(deps, 'reject_drafted_action', { workspaceId, actionId: drafted.actionId, reason: 'nein' }).ok, true);
    const diag = [];
    createScheduler({ ...deps, diagnostics: { record: (e) => diag.push(e) } }, { runDue: () => {}, bankAutoSync: false }).belegeingangTickOnce();
    assert.deepEqual(diag, [], 'the sweep reports nothing wrong');
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_pending').get().n, 0, "the rejected Vorschlag's file is gone");
    // Every later drafted attach still drafts.
    const later = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'a-2', { attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }] }));
    assert.equal(later.drafted, true, JSON.stringify(later));
  } finally {
    h.cleanup();
  }
});

test("critic F2: a twin's deletion never takes the bytes a pending file needs", () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'tw-1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    const fileId = JSON.parse(deps.store.db.prepare('SELECT payload_json FROM agent_action WHERE id = ?').get(drafted.actionId).payload_json).attach[0].fileId;
    // The same bytes uploaded afterwards and then deleted: the blob must stay for the pending file.
    const twin = human(deps, 'files_upload', { workspaceId, sourcePath: '~/.claude/uploads/s1/r.jpg', idempotencyKey: 'tw-up' });
    assert.equal(human(deps, 'files_delete', { workspaceId, fileId: twin.file.id, confirmed: true, idempotencyKey: 'tw-del' }).ok, true);
    assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId }).ok, true);
    const content = human(deps, 'files_get_content', { workspaceId, fileId });
    assert.equal(content.ok, true, JSON.stringify(content));
  } finally {
    h.cleanup();
  }
});

test('critic F1: a booking that takes a Beleg ohne Buchung closes the capture, and the Beleg never leaves the posted entry', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const cap = human(deps, 'capture_document', { workspaceId, sourcePath: '~/.claude/uploads/s1/r.jpg', idempotencyKey: 'cap' });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    const docId = deps.store.db.prepare('SELECT document_id FROM captures WHERE id = ?').get(cap.captureId).document_id;
    const posted = human(deps, 'post_entry', postInput(workspaceId, accId, 'p-1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(posted.ok, true, JSON.stringify(posted));
    assert.equal(posted.attached[0].duplicateOf, docId, "a second filing row, never the capture's own document");
    assert.equal(posted.attached[0].settledCaptureId, cap.captureId);
    assert.equal(deps.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(cap.captureId).status, 'committed');
    assert.equal(human(deps, 'belegeingang_status', { workspaceId }).waitingCaptures, 0, 'it left Belege ohne Buchung');
    const vendor = human(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Muster Papeterie AG', idempotencyKey: 'v' });
    const commit = human(deps, 'capture_commit', {
      workspaceId,
      captureId: cap.captureId,
      target: { kind: 'vendor_bill', vendorId: vendor.contact.id, expenseAccountId: accId('6500') },
      corrections: [{ key: 'amount', value: { minor: 8450, currency: 'CHF' } }],
      idempotencyKey: 'commit',
    });
    assert.equal(commit.error, 'invalid_state', 'a capture booked elsewhere is never committed into a second booking');
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', posted.entryId).length, 1, 'the posted entry keeps its Beleg');
    const settled = deps.store.db.prepare('SELECT entity_kind, entity_id FROM capture_settlement WHERE capture_id = ?').get(cap.captureId);
    assert.deepEqual({ ...settled }, { entity_kind: 'journal_entry', entity_id: posted.entryId });
  } finally {
    h.cleanup();
  }
});

test('critic F1: keep leaves the capture waiting; capture_commit refuses a document another record holds; the drop link follows the same rule', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    human(deps, 'settings_set', { workspaceId, key: 'files.capture_on_attach', value: 'keep', reason: 'Test', idempotencyKey: 'keep' });
    const cap = human(deps, 'capture_document', { workspaceId, sourcePath: '~/.claude/uploads/s1/r.jpg', idempotencyKey: 'cap' });
    const posted = human(deps, 'post_entry', postInput(workspaceId, accId, 'p-1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(posted.attached[0].settledCaptureId, null);
    assert.equal(deps.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(cap.captureId).status, 'needs_review');
    const vendor = human(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Muster Papeterie AG', idempotencyKey: 'v' });
    const commitInput = {
      workspaceId,
      captureId: cap.captureId,
      target: { kind: 'vendor_bill', vendorId: vendor.contact.id, expenseAccountId: accId('6500') },
      corrections: [{ key: 'amount', value: { minor: 8450, currency: 'CHF' } }],
      idempotencyKey: 'commit',
    };
    // Kept waiting, but its receipt is booked: committing meets the receipt guard (R1), naming the holder.
    const twice = human(deps, 'capture_commit', commitInput);
    assert.equal(twice.error, 'receipt_already_booked', JSON.stringify(twice));
    assert.deepEqual(twice.holders.map((x) => x.entityId), [posted.entryId]);
    assert.equal(deps.store.db.prepare("SELECT status FROM captures WHERE id = ?").get(cap.captureId).status, 'needs_review', 'the refused commit rolled back');
    // The audited per-call override books it anyway, with a reason, and never takes the entry's row.
    assert.equal(human(deps, 'capture_commit', { ...commitInput, bookAgain: true }).error, 'reason_required');
    const committed = human(deps, 'capture_commit', { ...commitInput, bookAgain: true, overrideReason: 'Zweite Lieferung, gleicher Beleg' });
    assert.equal(committed.ok, true, JSON.stringify(committed));
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', posted.entryId).length, 1, 'the entry keeps its Beleg');
    const override = deps.store.db.prepare('SELECT reason, target_kind, target_id, holders_json FROM receipt_override WHERE workspace_id = ?').get(workspaceId);
    assert.equal(override.reason, 'Zweite Lieferung, gleicher Beleg');
    assert.deepEqual([override.target_kind, override.target_id], ['vendor_bill', committed.targetId]);
    assert.equal(JSON.parse(override.holders_json)[0].entityId, posted.entryId);

    // A capture whose document a person linked to an entry by hand: commit refuses, naming the holder.
    const cap2 = human(deps, 'capture_document', { workspaceId, sourcePath: '~/.claude/uploads/s1/b.jpg', idempotencyKey: 'cap2' });
    const doc2 = deps.store.db.prepare('SELECT document_id FROM captures WHERE id = ?').get(cap2.captureId).document_id;
    const e2 = human(deps, 'post_entry', postInput(workspaceId, accId, 'p-2'));
    assert.equal(human(deps, 'files_link', { workspaceId, fileId: doc2, entityKind: 'journal_entry', entityId: e2.entryId, idempotencyKey: 'lk' }).ok, true);
    const refused = human(deps, 'capture_commit', { ...commitInput, captureId: cap2.captureId, idempotencyKey: 'commit2' });
    assert.equal(refused.error, 'document_already_linked');
    assert.equal(refused.entityId, e2.entryId);
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', e2.entryId).length, 1);

    // The drop page onto a booking resolves a Beleg ohne Buchung the same way (setting back to close).
    human(deps, 'settings_set', { workspaceId, key: 'files.capture_on_attach', value: 'close', reason: 'Test', idempotencyKey: 'close' });
    const capPdf = human(deps, 'capture_document', { workspaceId, sourcePath: '~/.claude/uploads/s1/beleg.pdf', idempotencyKey: 'cap3' });
    const e3 = human(deps, 'post_entry', postInput(workspaceId, accId, 'p-3'));
    const minted = agentMcp(deps, 'files_drop_link', { workspaceId, target: { kind: 'journal_entry', id: e3.entryId }, idempotencyKey: 'dl' });
    const done = handleDropCall({ ...deps, actor: 'studio' }, 'redeem', { token: minted.token, contentBase64: PDF.toString('base64'), filename: 'beleg.pdf' });
    assert.equal(done.status, 200, JSON.stringify(done));
    assert.equal(deps.store.db.prepare('SELECT status FROM captures WHERE id = ?').get(capPdf.captureId).status, 'committed');
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', e3.entryId).length, 1);
  } finally {
    h.cleanup();
  }
});

/** A receipt dropped through a link onto a pending Vorschlag, as the person does it on the drop page. */
function dropOnto(deps, workspaceId, actionId, key) {
  const minted = agentMcp(deps, 'files_drop_link', { workspaceId, target: { kind: 'drafted_action', id: actionId }, idempotencyKey: key });
  assert.equal(minted.ok, true, JSON.stringify(minted));
  const done = handleDropCall({ ...deps, actor: 'studio' }, 'redeem', { token: minted.token, contentBase64: PDF.toString('base64'), filename: 'quittung.pdf' });
  assert.equal(done.status, 200, JSON.stringify(done));
  return done.body.fileId;
}

test('critic F8: a dropped receipt follows its Vorschlag when a newer one for the same bank line replaces it (D177)', () => {
  const fx = fixture();
  const input = SCENARIOS.book_bank_line(fx);
  const first = JSON.parse(callTool(fx.deps, 'book_bank_line', { ...input, idempotencyKey: 'bbl-a' }).content[0].text);
  assert.equal(first.drafted, true, JSON.stringify(first));
  const fileId = dropOnto(fx.deps, fx.workspaceId, first.actionId, 'f8-link');
  const second = JSON.parse(callTool(fx.deps, 'book_bank_line', { ...input, idempotencyKey: 'bbl-b' }).content[0].text);
  assert.equal(second.drafted, true, JSON.stringify(second));
  assert.deepEqual(second.supersededActionIds, [first.actionId], 'premise: the newer Vorschlag replaced the older (ersetzt)');
  assert.equal(fx.deps.store.db.prepare('SELECT action_id FROM stored_file_pending WHERE id = ?').get(fileId).action_id, second.actionId);
  createScheduler(fx.deps, { runDue: () => {}, bankAutoSync: false }).belegeingangTickOnce();
  assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM stored_file_pending WHERE id = ?').get(fileId).n, 1, 'the sweep keeps it');
  const approved = getAction('approve_drafted_action').run({ ...fx.deps, actor: 'studio' }, { workspaceId: fx.workspaceId, actionId: second.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  assert.deepEqual(filesOn(fx.deps, fx.workspaceId, 'bank_txn', input.bankTxnId).map((f) => f.id), [fileId]);
  fx.deps.store.close();
});

test('critic F8: a dropped receipt follows its Vorschlag when the same key re-mints it after a stale void', () => {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps);
  const first = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'st-1'));
  assert.equal(first.drafted, true, JSON.stringify(first));
  const fileId = dropOnto(deps, workspaceId, first.actionId, 'st-link');
  // The pinned record moved, so the engine voided the Vorschlag (`markStale`); the agent proposes again.
  deps.store.db.prepare("UPDATE agent_action SET status = 'stale' WHERE id = ?").run(first.actionId);
  const again = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'st-1'));
  assert.equal(again.drafted, true, JSON.stringify(again));
  assert.notEqual(again.actionId, first.actionId);
  assert.equal(deps.store.db.prepare('SELECT action_id FROM stored_file_pending WHERE id = ?').get(fileId).action_id, again.actionId);
  assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: again.actionId }).ok, true);
  const posted = deps.store.db.prepare("SELECT id FROM journal_entry WHERE idempotency_key = 'st-1'").get();
  assert.deepEqual(filesOn(deps, workspaceId, 'journal_entry', posted.id).map((f) => f.id), [fileId]);
});

// --- critic round 2 (non-author probes, turned into tests) ------------------------------------------

test('critic R2 F2: the decider sees every Beleg a Vorschlag will link (proposed and dropped); the agent and other Vorschläge do not', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'pv-1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    const minted = agentMcp(deps, 'files_drop_link', { workspaceId, target: { kind: 'drafted_action', id: drafted.actionId }, idempotencyKey: 'pv-link' });
    const dropped = handleDropCall({ ...deps, actor: 'studio' }, 'redeem', { token: minted.token, contentBase64: PDF.toString('base64'), filename: 'lieferschein.pdf' });
    assert.equal(dropped.status, 200, JSON.stringify(dropped));
    const listed = human(deps, 'list_drafted_actions', { workspaceId });
    const row = listed.actions.find((a) => a.actionId === drafted.actionId);
    assert.deepEqual(
      row.belege.map((b) => [b.source, b.mime, b.pending]),
      [
        ['draft', 'image/jpeg', true],
        ['drop', 'application/pdf', true],
      ],
    );
    const proposedId = row.belege[0].fileId;
    const preview = human(deps, 'files_pending_preview', { workspaceId, actionId: drafted.actionId, fileId: proposedId });
    assert.equal(preview.ok, true, JSON.stringify(preview).slice(0, 200));
    assert.equal(Buffer.from(preview.contentBase64, 'base64').equals(JPEG), true, 'the very bytes the approval will link');
    // The proposing agent cannot read it (it never holds the deciding right), nor through MCP.
    assert.equal(agentMcp(deps, 'files_pending_preview', { workspaceId, actionId: drafted.actionId, fileId: proposedId }).error, 'permission_denied');
    // Another Vorschlag's file is not this one's Beleg.
    const other = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'pv-2'));
    assert.equal(human(deps, 'files_pending_preview', { workspaceId, actionId: other.actionId, fileId: proposedId }).error, 'not_found');
    // Decided: nothing pending to preview.
    assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId }).ok, true);
    assert.equal(human(deps, 'files_pending_preview', { workspaceId, actionId: drafted.actionId, fileId: proposedId }).error, 'invalid_state');
  } finally {
    h.cleanup();
  }
});

test('R1: capture_document of a booked receipt queues it and names the holders; committing it meets the guard; the Belegeingang dedupes the copy', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const posted = human(deps, 'post_entry', postInput(workspaceId, accId, 'p', { attach: [{ sourcePath: '~/.claude/uploads/s1/b.jpg' }] }));
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const cap = human(deps, 'capture_document', { workspaceId, sourcePath: '~/.claude/uploads/s1/b.jpg', idempotencyKey: 'cap' });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    assert.equal(typeof cap.captureId, 'string', 'queued: the intake is informational');
    assert.equal(cap.alreadyBooked, true);
    assert.deepEqual(cap.holders.map((x) => [x.entityKind, x.entityId]), [['journal_entry', posted.entryId]]);
    const vendor = human(deps, 'create_contact', { workspaceId, partyRole: 'vendor', name: 'Muster Papeterie AG', idempotencyKey: 'v' });
    const commit = human(deps, 'capture_commit', {
      workspaceId, captureId: cap.captureId,
      target: { kind: 'vendor_bill', vendorId: vendor.contact.id, expenseAccountId: accId('6500') },
      corrections: [{ key: 'amount', value: { minor: 8450, currency: 'CHF' } }], idempotencyKey: 'commit',
    });
    assert.equal(commit.error, 'receipt_already_booked', JSON.stringify(commit));
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM vendor_bill WHERE workspace_id = ?').get(workspaceId).n, 0, 'the refused commit left no bill');
    // The same receipt saved into the Belegeingang folder: the live capture is its twin, so it is a duplicate.
    const folder = join(h.home, 'TILL', 'Belegeingang');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'b.jpg'), JPEG_B);
    const [report] = createScheduler(deps, { runDue: () => {}, bankAutoSync: false }).belegeingangTickOnce();
    assert.equal(report.duplicates, 1, JSON.stringify(report));
    assert.equal(deps.store.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE workspace_id = ?').get(workspaceId).n, 1);
    assert.equal(filesOn(deps, workspaceId, 'journal_entry', posted.entryId).length, 1);
  } finally {
    h.cleanup();
  }
});

test('R1: two drafts of one receipt queue in order; the first approval books, the second meets it (holders_changed, then a reason); refuse holds at release', () => {
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const d1 = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'd1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(d1.drafted, true, JSON.stringify(d1));
    const d2 = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'd2', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(d2.drafted, true, JSON.stringify(d2));
    // The second card shows the first Vorschlag's reservation; the first card shows nothing.
    const cards = human(deps, 'list_drafted_actions', { workspaceId }).actions;
    const card = (id) => cards.find((a) => a.id === id || a.actionId === id);
    assert.deepEqual((card(d2.actionId).receiptHolders ?? []).map((x) => [x.entityKind, x.entityId]), [['drafted_action', d1.actionId]]);
    assert.deepEqual(card(d1.actionId).receiptHolders ?? [], []);
    // A person's direct booking of the same receipt meets both waiting Vorschläge.
    const direct = human(deps, 'post_entry', postInput(workspaceId, accId, 'h1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(direct.error, 'receipt_already_booked');
    assert.deepEqual(direct.holders.map((x) => x.entityId).sort(), [d1.actionId, d2.actionId].sort());

    // First come, first booked: d1 approves without a word (d2's reservation is later).
    const first = human(deps, 'approve_drafted_action', { workspaceId, actionId: d1.actionId });
    assert.equal(first.ok, true, JSON.stringify(first));
    const entry1 = deps.store.db.prepare("SELECT entity_id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry'").get(workspaceId).entity_id;
    // d2 now meets a booking its card did not show: holders_changed, and the card shows it.
    const changed = human(deps, 'approve_drafted_action', { workspaceId, actionId: d2.actionId });
    assert.equal(changed.error, 'holders_changed', JSON.stringify(changed));
    const again = human(deps, 'list_drafted_actions', { workspaceId }).actions.find((a) => a.id === d2.actionId || a.actionId === d2.actionId);
    assert.deepEqual(again.receiptHolders.map((x) => [x.entityKind, x.entityId]), [['journal_entry', entry1]]);
    // Shown now, it needs the person's confirmation with a reason.
    assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: d2.actionId }).error, 'receipt_already_booked');
    assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: d2.actionId, bookAgain: true }).error, 'reason_required');
    const second = human(deps, 'approve_drafted_action', { workspaceId, actionId: d2.actionId, bookAgain: true, overrideReason: 'Zwei Positionen auf einem Beleg' });
    assert.equal(second.ok, true, JSON.stringify(second));
    const override = deps.store.db.prepare('SELECT action_id, reason FROM receipt_override WHERE workspace_id = ?').get(workspaceId);
    assert.deepEqual({ ...override }, { action_id: d2.actionId, reason: 'Zwei Positionen auf einem Beleg' });

    // refuse: the release of a later Vorschlag is refused even with a confirmation.
    const deps2 = localDeps(h.home);
    const ws2 = mintWorkspace(deps2).workspaceId;
    const acc2 = (n) => deps2.store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(ws2, n).id;
    const e1 = agentMcp(deps2, 'post_entry', postInput(ws2, acc2, 'e1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    const e2 = agentMcp(deps2, 'post_entry', postInput(ws2, acc2, 'e2', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    assert.equal(e2.drafted, true, JSON.stringify(e2));
    human(deps2, 'settings_set', { workspaceId: ws2, key: 'files.duplicate_beleg', value: 'refuse', reason: 'Test', idempotencyKey: 's' });
    // Approving the LATER one first meets the earlier reservation its card showed: refused under refuse.
    const early = human(deps2, 'approve_drafted_action', { workspaceId: ws2, actionId: e2.actionId, bookAgain: true, overrideReason: 'trotzdem' });
    assert.equal(early.error, 'receipt_already_booked', JSON.stringify(early));
    assert.equal(human(deps2, 'approve_drafted_action', { workspaceId: ws2, actionId: e1.actionId }).ok, true);
    assert.equal(deps2.store.db.prepare("SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry'").get(ws2).n, 1);
  } finally {
    h.cleanup();
  }
});

test('critic R2-A: a pending Vorschlag survives backup and restore beside the original; its released id reads as a file id', async () => {
  const { SqliteStore } = await import('../../dist/core/store/sqlite-store.js');
  const { sequenceIdGen } = await import('../../dist/core/ids.js');
  const h = makeHome();
  const dir = mkdtempSync(join(tmpdir(), 'n02-r2-restore-'));
  try {
    const clock = fixedClock('2026-06-15T10:00:00.000Z');
    const store = new SqliteStore({ location: join(dir, 'book.sqlite'), clock });
    const deps = { store, clock, ids: sequenceIdGen(), actor: 'studio', backupDir: join(dir, 'backups'), localFiles: { home: h.home } };
    const { workspaceId, accId } = mintWorkspace(deps);
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'd1', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    const bkp = human(deps, 'create_backup', { workspaceId, idempotencyKey: 'bk' });
    const restored = getAction('restore_backup').run(deps, { source: bkp.artifactRef, newWorkspaceName: 'Kopie AG', confirmed: true });
    assert.equal(restored.ok, true, JSON.stringify(restored).slice(0, 300));
    const ws2 = restored.workspaceId;
    const pending = store.db.prepare('SELECT id FROM stored_file_pending WHERE workspace_id = ?').get(ws2);
    assert.match(pending.id, /^stored_file_/, 'minted as the stored-file id it becomes');
    const vorschlag = store.db.prepare("SELECT id, payload_json FROM agent_action WHERE workspace_id = ? AND action_tool = 'post_entry'").get(ws2);
    assert.equal(JSON.parse(vorschlag.payload_json).attach[0].fileId, pending.id, 'the payload follows the restored id');
    assert.equal(human(deps, 'approve_drafted_action', { workspaceId: ws2, actionId: vorschlag.id }).ok, true);
    const linked = store.db.prepare("SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry'").get(ws2);
    assert.equal(linked.id, pending.id);
    assert.equal(human(deps, 'files_get_content', { workspaceId: ws2, fileId: linked.id }).ok, true);
    assert.equal(human(deps, 'approve_drafted_action', { workspaceId, actionId: drafted.actionId }).ok, true, 'the original still approves');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    h.cleanup();
  }
});

// --- security review of the preview (round 2) -----------------------------------------------------

/** A context in this book whose capability port refuses exactly `denied`. */
async function restrictedCtx(deps, workspaceId, actor, denied) {
  const { makeContext } = await import('../../dist/core/context.js');
  return makeContext(deps.store, {
    workspaceId,
    actor,
    clock: deps.clock,
    ids: deps.ids,
    capabilities: { assert: (c) => (denied.includes(c) ? { ok: false, error: 'permission_denied', capability: c } : { ok: true }) },
  });
}

test('security: the preview answers the SNIFFED type, and a filed Beleg passes every files_get_content gate', async () => {
  const { previewVorschlagBeleg } = await import('../../dist/core/files/index.js');
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    // A filed file stored with a lying mime: its bytes are HTML.
    const html = human(deps, 'files_upload', { workspaceId, contentBase64: Buffer.from('<html><script>x</script></html>').toString('base64'), mime: 'image/jpeg', filename: 'r.jpg', idempotencyKey: 'html' });
    const drafted = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'sx-1', { attach: [{ fileId: html.file.id }] }));
    assert.equal(drafted.drafted, true, JSON.stringify(drafted));
    const preview = human(deps, 'files_pending_preview', { workspaceId, actionId: drafted.actionId, fileId: html.file.id });
    assert.equal(preview.ok, true, JSON.stringify(preview).slice(0, 200));
    assert.equal(preview.beleg.mime, 'image/jpeg', 'premise: the stored mime lies');
    assert.equal(preview.sniffedMime, 'application/octet-stream', 'the card acts on the bytes, never on the stored mime');
    // A receipt sniffs as what it is.
    const jpeg = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'sx-2', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }] }));
    const jpegId = human(deps, 'list_drafted_actions', { workspaceId }).actions.find((a) => a.actionId === jpeg.actionId).belege[0].fileId;
    assert.equal(human(deps, 'files_pending_preview', { workspaceId, actionId: jpeg.actionId, fileId: jpegId }).sniffedMime, 'image/jpeg');

    // A filed Beleg under the payroll sensitivity seam: a decider without hr.manage reads nothing.
    deps.store.db.prepare("UPDATE stored_file SET entity_kind = 'payroll_handoff', entity_id = 'ph_1' WHERE id = ?").run(html.file.id);
    const noHr = await restrictedCtx(deps, workspaceId, 'studio', ['hr.manage']);
    assert.equal(previewVorschlagBeleg(noHr, { actionId: drafted.actionId, fileId: html.file.id }).error, 'forbidden');
  } finally {
    h.cleanup();
  }
});

test('security: attach never names a file the caller could not read; the Vorschlag list shows Belege only to a reader', async () => {
  const { withAttach, prepareDraftAttach } = await import('../../dist/core/files/index.js');
  const { withBelege } = await import('../../dist/api/chat-belege-actions.js');
  const h = makeHome();
  try {
    const deps = localDeps(h.home);
    const { workspaceId, accId } = mintWorkspace(deps);
    const payroll = human(deps, 'files_upload', { workspaceId, sourcePath: '~/.claude/uploads/s1/b.jpg', idempotencyKey: 'pr' });
    deps.store.db.prepare("UPDATE stored_file SET entity_kind = 'payroll_handoff', entity_id = 'ph_1' WHERE id = ?").run(payroll.file.id);
    const input = postInput(workspaceId, accId, 'sec-1', { attach: [{ fileId: payroll.file.id }] });
    let ran = false;
    const run = () => {
      ran = true;
      return { ok: true, entryId: 'x' };
    };
    // Direct: a caller without hr.manage cannot copy the payroll artifact into an entry's filing.
    const direct = withAttach(await restrictedCtx(deps, workspaceId, 'studio', ['hr.manage']), undefined, 'post_entry', input, run, () => 'x');
    assert.equal(direct.error, 'forbidden');
    assert.equal(ran, false, 'refused before the act');
    // Nor without the right to read file content at all.
    assert.equal(withAttach(await restrictedCtx(deps, workspaceId, 'studio', ['read_file_content']), undefined, 'post_entry', input, run, () => 'x').error, 'permission_denied');
    // At draft time: the proposer could not read it, so nothing is proposed.
    const draft = prepareDraftAttach(await restrictedCtx(deps, workspaceId, 'agent', ['hr.manage']), undefined, 'post_entry', input);
    assert.equal(draft.error, 'forbidden');

    // The list: a pending Vorschlag naming a receipt, listed for a reader, a non-reader, and a reader
    // without hr.manage while one Beleg is a payroll artifact.
    const proposed = agentMcp(deps, 'post_entry', postInput(workspaceId, accId, 'sec-2', { attach: [{ sourcePath: '~/.claude/uploads/s1/r.jpg' }, { fileId: payroll.file.id }] }));
    assert.equal(proposed.drafted, true, JSON.stringify(proposed));
    const listed = getAction('list_drafted_actions').run({ ...deps, actor: 'studio' }, { workspaceId });
    const rowOf = (res) => res.actions.find((a) => a.actionId === proposed.actionId);
    assert.equal(rowOf(listed).belege.length, 2, 'the owner sees both');
    const raw = { ...listed, actions: listed.actions.map(({ belege, ...rest }) => rest) };
    assert.equal(rowOf(withBelege(await restrictedCtx(deps, workspaceId, 'studio', ['read_file_content']), raw)).belege, undefined, 'a non-reader learns no Belege');
    const noHr = rowOf(withBelege(await restrictedCtx(deps, workspaceId, 'studio', ['hr.manage']), raw)).belege;
    assert.deepEqual(noHr.map((b) => b.source), ['draft'], 'a reader without hr.manage never sees the payroll artifact');
  } finally {
    h.cleanup();
  }
});
