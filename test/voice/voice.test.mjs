/**
 * E05's engine behaviour: the corpus floor, build idempotency and supersession, the retrieval
 * ranking property (the planted near-duplicate wins), staleness, the pure-read discipline (a dead
 * source is skipped by `voice_retrieve` and PURGED by `mail_reindex`), document exemplars, the
 * honest refusals (`needs_local_runtime`, `needs_model_selection`), erasure, and §H-TENANT
 * isolation, ALL UNDER THE OP6 EGRESS PROBE (the W9 sequencing rule: E05 reuses E04's probe from
 * its first commit, so no voice or runtime code can open a socket). The suite's last test asserts
 * the probe recorded ZERO attempts, so no catch anywhere can have swallowed one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync } from 'node:fs';

import { installEgressProbe } from '../mail/egress-probe.mjs';

// Installed BEFORE the engine is imported, so even a module-load-time dial-home would be caught.
const probe = installEgressProbe();

const { getAction } = await import('../../dist/api/registry.js');
const { makeContext } = await import('../../dist/core/context.js');
const {
  buildVoiceProfile,
  getVoiceProfile,
  listVoiceProfiles,
  retrieveVoiceExemplars,
  purgeVoiceForContact,
  distilStyleCard,
  registerRuntime,
  resetRuntimeRegistration,
  CORPUS_FLOOR,
} = await import('../../dist/core/voice/index.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
const { tempStoreDir, makeMaildirStore, rfc822 } = await import('../mail/fixtures.mjs');
const { stubAdapter, stubManifest, outboundCorpus } = await import('./fixtures.mjs');

/** A fresh workspace with a context for direct engine calls, plus the registry for seeding. */
function world() {
  const deps = freshDeps();
  const { workspaceId } = mintWorkspace(deps);
  const ctx = makeContext(deps.store, { workspaceId, actor: 'agent', clock: deps.clock, ids: deps.ids });
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, ctx, call };
}

/** A connected + indexed corpus world with the stub runtime registered and a model selected. */
function corpusWorld(count = CORPUS_FLOOR + 1) {
  registerRuntime(stubAdapter(), stubManifest());
  const w = world();
  const root = tempStoreDir('till-voice-');
  const messages = outboundCorpus(count);
  const paths = makeMaildirStore(root, messages);
  const account = w.call('mail_connect', {
    adapter: 'thunderbird',
    storePath: root,
    address: 'praxis@example.ch',
    idempotencyKey: 'vw-conn',
  });
  assert.equal(account.ok, true, JSON.stringify(account));
  const reindexed = w.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'vw-re' });
  assert.equal(reindexed.ok, true, JSON.stringify(reindexed));
  const selected = w.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'vw-sel' });
  assert.equal(selected.ok, true, JSON.stringify(selected));
  return { ...w, root, messages, paths, accountId: account.accountId };
}

test('E05 build: honest refusals in order: no runtime, then no model, then no such account', () => {
  resetRuntimeRegistration();
  const w = world();
  const noRuntime = buildVoiceProfile(w.ctx, { accountId: 'x' });
  assert.equal(noRuntime.ok, false);
  assert.equal(noRuntime.error, 'needs_local_runtime', 'never a cloud fallback: no cloud path exists to fall back to');

  registerRuntime(stubAdapter(), stubManifest());
  const noModel = buildVoiceProfile(w.ctx, { accountId: 'x' });
  assert.equal(noModel.error, 'needs_model_selection', 'we never silently pick a model and surprise the user with the download');

  const selected = w.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'ref-sel' });
  assert.equal(selected.ok, true);
  const noAccount = buildVoiceProfile(w.ctx, { accountId: 'mailacc_missing' });
  assert.equal(noAccount.error, 'not_found');
});

test('E05 build: the corpus floor bites at 19 and clears at 20, with the honest have/need counts', () => {
  const w = corpusWorld(CORPUS_FLOOR - 1);
  const refused = buildVoiceProfile(w.ctx, { accountId: w.accountId });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'corpus_too_small');
  assert.equal(refused.have, CORPUS_FLOOR - 1);
  assert.equal(refused.need, CORPUS_FLOOR);

  const w2 = corpusWorld(CORPUS_FLOOR);
  const built = buildVoiceProfile(w2.ctx, { accountId: w2.accountId, idempotencyKey: 'floor-ok' });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.profile.exemplarCount, CORPUS_FLOOR);
});

test('E05 build: one key builds ONE profile; a new key supersedes and RETAINS the old row', () => {
  const w = corpusWorld();
  const first = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'b1' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const replay = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'b1' });
  assert.equal(replay.profileId, first.profileId, 'the same key must answer the original profile');
  assert.equal(
    w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM voice_profile WHERE workspace_id = ?').get(w.workspaceId).n,
    1,
  );

  const rebuilt = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'b2' });
  assert.equal(rebuilt.ok, true);
  assert.notEqual(rebuilt.profileId, first.profileId, 'a new key rebuilds');
  const listed = listVoiceProfiles(w.ctx);
  assert.equal(listed.profiles.length, 2, 'supersession is by row: the previous profile is retained');
  assert.equal(listed.profiles[0].id, rebuilt.profileId, 'newest first');
});

test('E05 build: the style card is readable, derived facts about THIS corpus', () => {
  const w = corpusWorld();
  const built = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'card' });
  assert.equal(built.ok, true);
  const card = built.profile.styleCard;
  assert.equal(card.greeting, 'Guten Tag', 'the corpus greets with Guten Tag in every message');
  assert.equal(card.signOff, 'Freundliche Grüsse', 'the FORMULA above the signature, never the signature line itself');
  assert.equal(card.formality, 'Sie', 'the corpus is Sie-form throughout');
  assert.ok(card.languageMix.de > card.languageMix.en, 'the corpus is German');
  assert.ok(card.meanSentenceWords > 0);
  assert.equal(built.profile.modelRef, 'stub-4b-q4', 'the profile records the model that embedded it');
});

test('E05 build: no excerpt anywhere: voice_exemplar holds locator, vector and hash only', () => {
  const w = corpusWorld();
  const built = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'nocopy' });
  assert.equal(built.ok, true);
  const rows = w.deps.store.db
    .prepare('SELECT * FROM voice_exemplar WHERE workspace_id = ?')
    .all(w.workspaceId);
  assert.ok(rows.length >= CORPUS_FLOOR);
  for (const row of rows) {
    assert.deepEqual(
      Object.keys(row).sort(),
      ['created_at', 'embedding', 'id', 'profile_id', 'sha256', 'source_kind', 'source_ref', 'workspace_id'],
    );
    assert.equal(row.source_kind, 'sent_mail');
    assert.match(row.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Buffer.isBuffer(row.embedding) && row.embedding.byteLength === 64 * 4);
  }
});

test('E05 retrieve: the planted near-duplicate ranks first, bodies read on demand from the store', () => {
  const w = corpusWorld();
  const built = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'rank' });
  assert.equal(built.ok, true);

  // The query is a near-duplicate of exemplar 3's own prose (topic Erstgespräch, Vorschlag 3).
  const got = retrieveVoiceExemplars(w.ctx, {
    profileId: built.profileId,
    queryText: 'Danke für Ihre Nachricht zu Erstgespräch. Gerne bestätige ich Ihnen den Vorschlag Nummer 3',
    k: 3,
  });
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.items.length, 3);
  assert.equal(got.stale, false);
  assert.match(got.items[0].body, /Erstgespräch/, 'the near-duplicate must rank first');
  assert.match(got.items[0].body, /Nummer 3/);
  assert.ok(got.items[0].score >= got.items[1].score && got.items[1].score >= got.items[2].score);
  for (const item of got.items) {
    assert.equal(item.sourceKind, 'sent_mail');
    assert.ok(item.body.length > 0, 'bodies are read on demand from the mail store, never from SQLite');
  }
});

test('E05 retrieve: a deleted source is SKIPPED by the read and PURGED by the next reindex', () => {
  const w = corpusWorld();
  const built = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'heal' });
  assert.equal(built.ok, true);
  const exemplarsBefore = w.deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM voice_exemplar WHERE workspace_id = ?')
    .get(w.workspaceId).n;

  // The user deletes a sent message in their own mail client (the store is the authority, OP6).
  unlinkSync(w.paths['voice-out-3@example.ch']);

  // The read SKIPS the dead source and mutates NOTHING (conformance rule 4: read means read).
  const before = JSON.stringify(
    w.deps.store.db.prepare('SELECT id FROM voice_exemplar WHERE workspace_id = ? ORDER BY id').all(w.workspaceId),
  );
  const got = retrieveVoiceExemplars(w.ctx, {
    profileId: built.profileId,
    queryText: 'Danke für Ihre Nachricht zu Erstgespräch. Gerne bestätige ich Ihnen den Vorschlag Nummer 3',
    k: exemplarsBefore,
  });
  assert.equal(got.ok, true);
  assert.equal(got.skipped, 1, 'the dead source is skipped and counted, never fatal');
  assert.equal(got.items.length, exemplarsBefore - 1);
  const after = JSON.stringify(
    w.deps.store.db.prepare('SELECT id FROM voice_exemplar WHERE workspace_id = ? ORDER BY id').all(w.workspaceId),
  );
  assert.equal(after, before, 'voice_retrieve is a pure read: the purge belongs to the write path');

  // The WRITE path erases the derived row: reindex self-heals the index AND the exemplars over it.
  const reindexed = w.call('mail_reindex', { accountId: w.accountId, idempotencyKey: 'heal-re' });
  assert.equal(reindexed.ok, true);
  assert.equal(reindexed.removed, 1);
  const exemplarsAfter = w.deps.store.db
    .prepare('SELECT COUNT(*) AS n FROM voice_exemplar WHERE workspace_id = ?')
    .get(w.workspaceId).n;
  assert.equal(exemplarsAfter, exemplarsBefore - 1, 'the exemplar left with its source');
});

test('E05 staleness: a corpus that moved since the build answers stale:true, surfaced not drifted past', () => {
  const w = corpusWorld();
  const built = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'stale' });
  assert.equal(built.ok, true);
  assert.equal(getVoiceProfile(w.ctx, { profileId: built.profileId }).stale, false);

  // A new sent message lands and is reindexed: the fingerprint moves.
  makeMaildirStore(
    w.root,
    [
      {
        id: 'voice-new-1@example.ch',
        raw: rfc822({
          from: 'praxis@example.ch',
          to: 'neu@example.org',
          subject: 'Neue Anfrage',
          messageId: 'voice-new-1@example.ch',
          body: 'Guten Tag\r\nGerne, das richten wir ein.\r\nFreundliche Grüsse\r\nPraxis Muster',
        }),
      },
    ],
    'INBOX2',
  );
  const reindexed = w.call('mail_reindex', { accountId: w.accountId, idempotencyKey: 'stale-re' });
  assert.equal(reindexed.ok, true);
  const got = getVoiceProfile(w.ctx, { profileId: built.profileId });
  assert.equal(got.stale, true, 'the GUI offers a rebuild instead of silently drifting');
  const retrieved = retrieveVoiceExemplars(w.ctx, { profileId: built.profileId, queryText: 'Termin', k: 2 });
  assert.equal(retrieved.stale, true);
});

test('E05 documents: an E00 file joins the corpus as a locator + vector; wrong mimes skip, unknown ids refuse', () => {
  const w = corpusWorld();
  const text = Buffer.from('Sehr geehrte Damen und Herren\nBeiliegend der Zwischenbericht zur Kostengutsprache.\nFreundliche Grüsse\nPraxis Muster', 'utf8');
  const uploaded = w.call('files_upload', {
    filename: 'bericht.txt',
    mime: 'text/plain',
    contentBase64: text.toString('base64'),
    idempotencyKey: 'doc-up',
  });
  assert.equal(uploaded.ok, true, JSON.stringify(uploaded));
  const binary = w.call('files_upload', {
    filename: 'logo.png',
    mime: 'image/png',
    contentBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
    idempotencyKey: 'doc-png',
  });
  assert.equal(binary.ok, true);

  const unknown = buildVoiceProfile(w.ctx, { accountId: w.accountId, documentIds: ['file_missing'], idempotencyKey: 'doc-x' });
  assert.equal(unknown.error, 'unknown_document');

  const built = buildVoiceProfile(w.ctx, {
    accountId: w.accountId,
    documentIds: [uploaded.file.id, binary.file.id],
    idempotencyKey: 'doc-b',
  });
  assert.equal(built.ok, true, JSON.stringify(built));
  assert.equal(built.skippedReasons.unsupported_mime, 1, 'a mime the extractor cannot read is skipped and counted, never fatal');
  const docRows = w.deps.store.db
    .prepare(`SELECT * FROM voice_exemplar WHERE workspace_id = ? AND source_kind = 'document'`)
    .all(w.workspaceId);
  assert.equal(docRows.length, 1);
  assert.equal(docRows[0].source_ref, uploaded.file.id, 'E00 owns the file; E05 stores a locator');

  const got = retrieveVoiceExemplars(w.ctx, { profileId: built.profileId, queryText: 'Zwischenbericht zur Kostengutsprache', k: 1 });
  assert.equal(got.ok, true);
  assert.equal(got.items[0].sourceKind, 'document', 'the document near-duplicate ranks first');
  assert.match(got.items[0].body, /Zwischenbericht/);
});

test('E05 §H-TENANT: a foreign profile and account answer the same not_found a nonexistent one does', () => {
  const w = corpusWorld();
  const built = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'ten' });
  assert.equal(built.ok, true);

  const other = world();
  const otherSel = other.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'ten-sel' });
  assert.equal(otherSel.ok, true);
  assert.equal(getVoiceProfile(other.ctx, { profileId: built.profileId }).error, 'not_found');
  assert.equal(retrieveVoiceExemplars(other.ctx, { profileId: built.profileId, queryText: 'x', k: 1 }).error, 'not_found');
  assert.equal(buildVoiceProfile(other.ctx, { accountId: w.accountId, idempotencyKey: 'ten-b' }).error, 'not_found');
  assert.equal(listVoiceProfiles(other.ctx).profiles.length, 0);
});

test('E05 erasure: contacts_anonymise purges the erased person\'s exemplars inside the same transaction', () => {
  const w = corpusWorld();
  const contact = w.call('create_contact', {
    partyRole: 'customer',
    name: 'Klient Muster',
    email: 'klient@example.org',
    idempotencyKey: 'er-ct',
  });
  // Re-run the index so the outbound messages resolve to the contact (To: klient@example.org).
  const reindexed = w.call('mail_reindex', { accountId: w.accountId, idempotencyKey: 'er-re' });
  assert.equal(reindexed.ok, true);
  const built = buildVoiceProfile(w.ctx, { accountId: w.accountId, idempotencyKey: 'er-b' });
  assert.equal(built.ok, true);
  const before = w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM voice_exemplar WHERE workspace_id = ?').get(w.workspaceId).n;
  assert.ok(before >= CORPUS_FLOOR);

  const erased = w.call('contacts_anonymise', { contactId: contact.contact.id, idempotencyKey: 'er-anon' });
  assert.equal(erased.ok, true, JSON.stringify(erased));
  assert.equal(erased.voicePurged.exemplars, before, 'every exemplar embedded from that mail went with the person');
  assert.equal(
    w.deps.store.db.prepare('SELECT COUNT(*) AS n FROM voice_exemplar WHERE workspace_id = ?').get(w.workspaceId).n,
    0,
    'an embedding is deleted with a DELETE: the revDSG Art. 32 argument for retrieval over fine-tuning, measured',
  );
  // The purge helper alone is a no-op on an empty id list.
  assert.deepEqual(purgeVoiceForContact(w.ctx, []), { exemplars: 0 });
});

test('E05 distilStyleCard is pure and total: an empty corpus yields an empty, well-shaped card', () => {
  const empty = distilStyleCard([]);
  assert.deepEqual(empty, {
    greeting: null,
    signOff: null,
    formality: 'Sie',
    meanSentenceWords: 0,
    medianReplyLines: 0,
    languageMix: { de: 0, en: 0 },
  });
  const once = distilStyleCard(['Hallo\nWie geht es dir?\nGruss']);
  assert.deepEqual(once, distilStyleCard(['Hallo\nWie geht es dir?\nGruss']), 'deterministic on its input');
});

test('E05 OP6: none of the above opened a socket', () => {
  assert.deepEqual(probe.violations, []);
});
