/**
 * E05, the voice profile: learn a practitioner's writing voice from mail they already sent,
 * WITHOUT copying a word of it.
 *
 * WHAT THIS MODULE IS. The style half of the local-correspondence cluster (E04–E07): it reads the
 * `direction='outbound'` corpus E04 indexed, distils a READABLE style card (a voice model the user
 * cannot read is a voice model they cannot trust, spec §2), embeds each exemplar through the OP6
 * adapter, and persists LOCATORS, VECTORS and HASHES, never an excerpt (Art. 321 StGB: the corpus
 * IS the secrecy-bearing material, and "index, never copy" is the rule that makes the product
 * lawful to run, spec §3). Retrieval over embeddings, NEVER a fine-tune: an embedding row is
 * deleted with a `DELETE`, a fine-tune cannot be un-learned (revDSG Art. 32 selects the
 * architecture, spec §3).
 *
 * WHAT THIS MODULE IS NOT. It never touches the journal: no `_rappen`, no `postEntry`, no
 * `recordPayment` (P3 by absence, asserted by `test/voice/no-copy-and-guards.test.mjs`). It stamps
 * NO audit rows (spec §7: §H-AUDIT untouched, the E04/G00 posture). It opens NO socket, our code
 * and the adapter alike: the egress probe wraps every suite here, and with no adapter registered
 * every consuming verb answers `needs_local_runtime`, never a cloud fallback, because no cloud
 * path was written (US-E05.4).
 *
 * THE SOURCES ARE THE AUTHORITY, THE EXEMPLARS ARE DERIVED. `retrieve` reads bodies on demand from
 * `source_ref` (E04's store for mail, E00's blob for documents) and SKIPS a source that no longer
 * resolves; the row itself is purged by E04's `mail_reindex` self-healing block and by C00's
 * `contacts_anonymise` (`purgeVoiceForContact`), never by a read (`voice_retrieve` leaves the
 * database byte-identical, conformance rule 4). Staleness is SURFACED rather than drifted past:
 * `source_sha256` fingerprints the corpus, and a profile whose corpus moved says `stale:true`.
 *
 * TENANCY (§H-TENANT): every query filters on `ctx.workspaceId`, so a foreign profile, account or
 * document id answers the same `not_found` a nonexistent one does.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { ADAPTERS, bodySha256 } from '../mail/index.js';
import type { MailStoreAdapter } from '../mail/index.js';
import { registeredRuntime, readRuntimeSelection } from './runtime.js';
import type { Op6Adapter } from './runtime.js';

/** The floor below which a profile would be a guess presented as a voice (US-E05.1 Empty). */
export const CORPUS_FLOOR = 20;

interface VoiceProfileRow {
  id: string;
  workspace_id: string;
  account_id: string;
  name: string | null;
  style_card: string;
  source_sha256: string;
  exemplar_count: number;
  model_ref: string;
  built_at: string;
  created_at: string;
}

interface VoiceExemplarRow {
  id: string;
  workspace_id: string;
  profile_id: string;
  source_kind: string;
  source_ref: string;
  embedding: Buffer;
  sha256: string;
  created_at: string;
}

interface MailAccountRow {
  id: string;
  workspace_id: string;
  adapter: string;
  address: string;
  store_path: string;
}

interface OutboundMessageRow {
  id: string;
  store_ref: string;
  body_sha256: string;
}

interface StoredFileMetaRow {
  id: string;
  mime: string;
  sha256: string;
  storage_ref: string;
  pending_delete: number;
}

function mapProfile(row: VoiceProfileRow) {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    styleCard: JSON.parse(row.style_card) as Record<string, unknown>,
    sourceSha256: row.source_sha256,
    exemplarCount: row.exemplar_count,
    modelRef: row.model_ref,
    builtAt: row.built_at,
  };
}

function readProfile(ctx: WorkspaceContext, profileId: unknown): VoiceProfileRow | undefined {
  if (typeof profileId !== 'string' || profileId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM voice_profile WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, profileId) as VoiceProfileRow | undefined;
}

function readMailAccount(ctx: WorkspaceContext, accountId: unknown): MailAccountRow | undefined {
  if (typeof accountId !== 'string' || accountId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM mail_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, accountId) as MailAccountRow | undefined;
}

function mailAdapterOf(account: MailAccountRow): MailStoreAdapter {
  const adapter = ADAPTERS[account.adapter as keyof typeof ADAPTERS];
  if (adapter === undefined) throw new Error(`mail_account ${account.id} names unknown adapter '${account.adapter}'`);
  return adapter;
}

/** The RFC-5322 body without its headers: the voice lives in the prose, not the routing. */
function stripHeaders(raw: string): string {
  const separator = /\r?\n\r?\n/.exec(raw);
  return separator === null ? raw : raw.slice(separator.index + separator[0].length);
}

/** Text mimes an exemplar can be distilled from; anything else is skipped and counted, never fatal. */
const TEXT_MIME_RE = /^text\/|^application\/(json|xml|rtf)$/;

/**
 * The corpus fingerprint (US-E05.1/3): sha256 over the SORTED index hashes of the account's
 * outbound mail plus the current hashes of the profile's documents. Computed the same way at build
 * and at read, so "your sent mail changed since this was learned" is a measured fact.
 */
export function corpusFingerprint(
  ctx: WorkspaceContext,
  accountId: string,
  documentIds: readonly string[],
): string {
  const mailHashes = (
    ctx.store.db
      .prepare(
        `SELECT body_sha256 FROM mail_message
          WHERE workspace_id = ? AND account_id = ? AND direction = 'outbound'`,
      )
      .all(ctx.workspaceId, accountId) as { body_sha256: string }[]
  ).map((row) => row.body_sha256);
  const docHashes: string[] = [];
  for (const documentId of documentIds) {
    const file = ctx.store.db
      .prepare('SELECT sha256 FROM stored_file WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, documentId) as { sha256: string } | undefined;
    if (file !== undefined) docHashes.push(file.sha256);
  }
  return bodySha256([...mailHashes.sort(), ...docHashes.sort()].join('\n'));
}

/** The document ids a profile was built over, derived from its own exemplar rows. */
function profileDocumentIds(ctx: WorkspaceContext, profileId: string): string[] {
  return (
    ctx.store.db
      .prepare(
        `SELECT DISTINCT source_ref FROM voice_exemplar
          WHERE workspace_id = ? AND profile_id = ? AND source_kind = 'document'`,
      )
      .all(ctx.workspaceId, profileId) as { source_ref: string }[]
  ).map((row) => row.source_ref);
}

/* ------------------------------------------------------------------------------------------------
 * the style card (US-E05.1): distilled, deterministic, readable
 * ---------------------------------------------------------------------------------------------- */

const DE_STOPWORDS = new Set(['und', 'der', 'die', 'das', 'ich', 'sie', 'nicht', 'mit', 'für', 'ist', 'wir', 'sich', 'auf', 'eine', 'als', 'auch', 'werden', 'bei', 'oder', 'aber', 'dass', 'noch', 'nach', 'gerne', 'danke', 'grüsse', 'freundliche']);
const EN_STOPWORDS = new Set(['the', 'and', 'you', 'for', 'that', 'with', 'this', 'have', 'not', 'are', 'was', 'but', 'they', 'will', 'would', 'from', 'thanks', 'regards', 'best', 'dear']);

/** The most frequent value, ties broken by first appearance (deterministic). */
function mostCommon(values: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const value of values) {
    const count = counts.get(value) ?? 0;
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * THE CARD RECORDS FORMULAS, NEVER LITERAL LINES. A first line is routinely "Liebe Frau Muster":
 * copying it into `style_card` would put a CLIENT NAME into the database, which is exactly the
 * excerpt the Art. 321 sentinel fixture scans for. So a greeting or sign-off is matched against a
 * known-formula vocabulary and only the FORMULA is recorded (the longest matching prefix, in
 * canonical casing); a line matching no formula contributes nothing, because claiming nothing
 * beats copying something (OP6 index-never-copy, applied to the card itself).
 */
const GREETING_FORMULAS = [
  'sehr geehrte damen und herren',
  'sehr geehrte frau',
  'sehr geehrter herr',
  'guten tag',
  'guten morgen',
  'grüezi mitenand',
  'grüezi',
  'liebe frau',
  'lieber herr',
  'liebe alle',
  'liebes team',
  'liebe',
  'lieber',
  'hallo zusammen',
  'hallo',
  'salü',
  'hoi',
  'dear',
  'hello',
  'hi',
] as const;

const SIGN_OFF_FORMULAS = [
  'mit freundlichen grüssen',
  'freundliche grüsse',
  'beste grüsse',
  'herzliche grüsse',
  'liebe grüsse',
  'besten dank und freundliche grüsse',
  'danke und gruss',
  'gruss',
  'grüsse',
  'kind regards',
  'best regards',
  'warm regards',
  'regards',
  'best',
  'thanks',
] as const;

/** Title-case a formula for display ("freundliche grüsse" -> "Freundliche Grüsse"). */
function canonicalFormula(formula: string): string {
  return formula
    .split(' ')
    .map((word) => (word.length === 0 ? word : word[0]?.toUpperCase() + word.slice(1)))
    .join(' ');
}

/** The longest known formula the line OPENS with, or null: never the line itself. */
function matchFormula(line: string, formulas: readonly string[]): string | null {
  const lowered = line.toLowerCase();
  for (const formula of formulas) {
    if (lowered === formula || lowered.startsWith(`${formula} `) || lowered.startsWith(`${formula},`)) {
      return canonicalFormula(formula);
    }
  }
  return null;
}

/**
 * PURE (spec §4): distil the measurable conventions of a corpus into the style card the GUI shows
 * in plain language. One consumer, so it stays here rather than becoming a pattern, exactly as
 * `parseRecurrence` sits inside E03. Deterministic on its input, so the suite runs offline and the
 * card is reproducible; the adapter's `complete` is E06's drafting seam, not a distillation
 * dependency (a stub would write junk into a card the user is asked to trust).
 */
export function distilStyleCard(bodies: readonly string[]): Record<string, unknown> {
  const greetings: string[] = [];
  const signOffs: string[] = [];
  let sentenceWords = 0;
  let sentenceCount = 0;
  let sieCount = 0;
  let duCount = 0;
  let deCount = 0;
  let enCount = 0;
  const lineCounts: number[] = [];

  for (const body of bodies) {
    const lines = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('>'));
    if (lines.length === 0) continue;
    lineCounts.push(lines.length);
    const greeting = matchFormula(lines[0] as string, GREETING_FORMULAS);
    if (greeting !== null) greetings.push(greeting);
    // The sign-off usually sits above a signature line, so scan the last three lines upward and
    // record the FORMULA of the first that matches, never any line itself.
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 3); i -= 1) {
      const signOff = matchFormula(lines[i] as string, SIGN_OFF_FORMULAS);
      if (signOff !== null) {
        signOffs.push(signOff);
        break;
      }
    }

    const text = lines.join(' ');
    const sentences = text.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
    for (const sentence of sentences) {
      const words = sentence.split(/\s+/).filter((w) => w.length > 0);
      sentenceWords += words.length;
      sentenceCount += 1;
    }
    for (const word of text.toLowerCase().split(/[^a-zA-Zäöüéèà]+/)) {
      if (word === 'sie' || word === 'ihnen' || word === 'ihr') sieCount += 1;
      if (word === 'du' || word === 'dir' || word === 'dich') duCount += 1;
      if (DE_STOPWORDS.has(word)) deCount += 1;
      if (EN_STOPWORDS.has(word)) enCount += 1;
    }
  }

  const sortedLines = [...lineCounts].sort((a, b) => a - b);
  const medianLines = sortedLines.length === 0 ? 0 : (sortedLines[Math.floor(sortedLines.length / 2)] as number);
  const languageTotal = deCount + enCount;
  return {
    greeting: mostCommon(greetings),
    signOff: mostCommon(signOffs),
    formality: sieCount >= duCount ? 'Sie' : 'du',
    meanSentenceWords: sentenceCount === 0 ? 0 : Math.round((sentenceWords / sentenceCount) * 10) / 10,
    medianReplyLines: medianLines,
    languageMix: {
      de: languageTotal === 0 ? 0 : Math.round((deCount / languageTotal) * 100),
      en: languageTotal === 0 ? 0 : Math.round((enCount / languageTotal) * 100),
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * embeddings: stored as little-endian Float32 blobs, compared by cosine
 * ---------------------------------------------------------------------------------------------- */

function embeddingToBlob(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
}

function blobToEmbedding(blob: Buffer): Float32Array {
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/* ------------------------------------------------------------------------------------------------
 * build (US-E05.1 / US-E05.2)
 * ---------------------------------------------------------------------------------------------- */

/** The registered adapter, or the honest refusals (US-E05.4/5: never a 500, never a cloud). */
function requireRuntime(ctx: WorkspaceContext): { adapter: Op6Adapter } | { refused: Result } {
  const registration = registeredRuntime();
  if (registration === undefined) return { refused: err('needs_local_runtime', {}) };
  if (readRuntimeSelection(ctx) === undefined) return { refused: err('needs_model_selection', {}) };
  return { adapter: registration.adapter };
}

export interface BuildVoiceProfileInput {
  accountId: string;
  documentIds?: string[];
  name?: string;
  idempotencyKey?: string;
}

/**
 * Learn the voice: gather the outbound corpus via E04 (plus optional E00 documents), refuse below
 * the floor (`corpus_too_small`: we do not build a bad profile from 3 emails and let the user
 * discover the problem in a draft to a client), distil the card, embed every exemplar, persist
 * locators + vectors + hashes, stamp the corpus fingerprint. Re-running under the same key returns
 * the original profile; a NEW key rebuilds and supersedes by row, the previous profile retained so
 * history stays interpretable (US-E05.1 Boundary).
 */
export function buildVoiceProfile(ctx: WorkspaceContext, input: BuildVoiceProfileInput): Result {
  const runtime = requireRuntime(ctx);
  if ('refused' in runtime) return runtime.refused;
  const account = readMailAccount(ctx, input.accountId);
  if (account === undefined) return err('not_found', { accountId: input.accountId });

  const documentIds = input.documentIds ?? [];
  const documents: { id: string; sha256: string; text: string }[] = [];
  const skippedReasons: Record<string, number> = {};
  const skip = (reason: string) => {
    skippedReasons[reason] = (skippedReasons[reason] ?? 0) + 1;
  };
  for (const documentId of documentIds) {
    if (typeof documentId !== 'string' || documentId.length === 0) {
      return err('unknown_document', { documentId });
    }
    const file = ctx.store.db
      .prepare('SELECT id, mime, sha256, storage_ref, pending_delete FROM stored_file WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, documentId) as StoredFileMetaRow | undefined;
    if (file === undefined || file.pending_delete === 1) return err('unknown_document', { documentId });
    if (!TEXT_MIME_RE.test(file.mime)) {
      // A mime the extractor cannot read is skipped and counted, never fatal (US-E05.2 Error).
      skip('unsupported_mime');
      continue;
    }
    const blob = ctx.store.db
      .prepare('SELECT content FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
      .get(ctx.workspaceId, file.storage_ref) as { content: Buffer } | undefined;
    if (blob === undefined) {
      skip('document_content_missing');
      continue;
    }
    const bytes = Buffer.isBuffer(blob.content) ? blob.content : Buffer.from(blob.content as unknown as Uint8Array);
    documents.push({ id: file.id, sha256: file.sha256, text: bytes.toString('utf8') });
  }

  const mailAdapter = mailAdapterOf(account);
  const outbound = ctx.store.db
    .prepare(
      `SELECT id, store_ref, body_sha256 FROM mail_message
        WHERE workspace_id = ? AND account_id = ? AND direction = 'outbound'
        ORDER BY sent_at, indexed_at`,
    )
    .all(ctx.workspaceId, account.id) as OutboundMessageRow[];
  const mailExemplars: { messageId: string; sha256: string; text: string }[] = [];
  for (const message of outbound) {
    const raw = mailAdapter.readBody(account.store_path, message.store_ref);
    if (raw === undefined) {
      skip('message_unreadable');
      continue;
    }
    mailExemplars.push({ messageId: message.id, sha256: message.body_sha256, text: stripHeaders(raw) });
  }
  if (mailExemplars.length < CORPUS_FLOOR) {
    return err('corpus_too_small', { have: mailExemplars.length, need: CORPUS_FLOOR });
  }

  const run = (): Result => {
    const adapter = runtime.adapter;
    const styleCard = distilStyleCard([...mailExemplars.map((m) => m.text), ...documents.map((d) => d.text)]);
    const fingerprint = corpusFingerprint(ctx, account.id, documents.map((d) => d.id));
    const now = ctx.clock.now();
    const profileId = ctx.ids.next('voiceprf');
    const exemplarCount = mailExemplars.length + documents.length;
    ctx.store.db
      .prepare(
        `INSERT INTO voice_profile (id, workspace_id, account_id, name, style_card, source_sha256, exemplar_count, model_ref, built_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        profileId,
        ctx.workspaceId,
        account.id,
        input.name ?? null,
        JSON.stringify(styleCard),
        fingerprint,
        exemplarCount,
        adapter.modelRef,
        now,
        now,
      );
    const insert = ctx.store.db.prepare(
      `INSERT INTO voice_exemplar (id, workspace_id, profile_id, source_kind, source_ref, embedding, sha256, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const exemplar of mailExemplars) {
      insert.run(
        ctx.ids.next('voiceex'),
        ctx.workspaceId,
        profileId,
        'sent_mail',
        exemplar.messageId,
        embeddingToBlob(adapter.embed(exemplar.text)),
        exemplar.sha256,
        now,
      );
    }
    for (const document of documents) {
      insert.run(
        ctx.ids.next('voiceex'),
        ctx.workspaceId,
        profileId,
        'document',
        document.id,
        embeddingToBlob(adapter.embed(document.text)),
        document.sha256,
        now,
      );
    }
    const row = readProfile(ctx, profileId) as VoiceProfileRow;
    return ok({ profileId, profile: mapProfile(row), skippedReasons });
  };

  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'voice_build', run);
  }
  return ctx.store.tx(run);
}

/* ------------------------------------------------------------------------------------------------
 * reads (US-E05.1 / US-E05.3)
 * ---------------------------------------------------------------------------------------------- */

/** One profile, its card rendered readably, staleness measured against the CURRENT corpus. */
export function getVoiceProfile(ctx: WorkspaceContext, input: { profileId: string }): Result {
  const row = readProfile(ctx, input.profileId);
  if (row === undefined) return err('not_found', { profileId: input.profileId });
  const fingerprint = corpusFingerprint(ctx, row.account_id, profileDocumentIds(ctx, row.id));
  return ok({ profile: mapProfile(row), stale: fingerprint !== row.source_sha256 });
}

/** Every profile, newest first: supersession is by row, the history stays interpretable (P5). */
export function listVoiceProfiles(ctx: WorkspaceContext): Result {
  const rows = ctx.store.db
    .prepare('SELECT * FROM voice_profile WHERE workspace_id = ? ORDER BY built_at DESC, id DESC')
    .all(ctx.workspaceId) as VoiceProfileRow[];
  return ok({ profiles: rows.map(mapProfile), total: rows.length });
}

export interface RetrieveInput {
  profileId: string;
  queryText: string;
  k?: number;
}

/**
 * US-E05.3, E06's only door to the corpus: embed the query, cosine-rank the exemplars, read the
 * top-k BODIES ON DEMAND from `source_ref` (E04's store for mail, E00's blob for documents). A
 * source that no longer resolves is SKIPPED AND COUNTED, never returned and never fatal; the dead
 * row itself is purged by `mail_reindex` / `contacts_anonymise`, because this is a READ and a read
 * leaves the database byte-identical (conformance rule 4). A corpus that moved since the build
 * comes back `stale:true`, surfaced rather than silently drifted past.
 */
export function retrieveVoiceExemplars(ctx: WorkspaceContext, input: RetrieveInput): Result {
  const registration = registeredRuntime();
  if (registration === undefined) return err('needs_local_runtime', {});
  const profile = readProfile(ctx, input.profileId);
  if (profile === undefined) return err('not_found', { profileId: input.profileId });
  if (typeof input.queryText !== 'string' || input.queryText.trim().length === 0) {
    return err('invalid_input', { field: 'queryText' });
  }
  const k = input.k === undefined ? 5 : input.k;
  if (!Number.isInteger(k) || k < 1 || k > 50) return err('invalid_input', { field: 'k' });

  const exemplars = ctx.store.db
    .prepare('SELECT * FROM voice_exemplar WHERE workspace_id = ? AND profile_id = ?')
    .all(ctx.workspaceId, profile.id) as VoiceExemplarRow[];
  const query = registration.adapter.embed(input.queryText);
  const ranked = exemplars
    .map((row) => ({ row, score: cosineSimilarity(query, blobToEmbedding(row.embedding)) }))
    .sort((a, b) => b.score - a.score || a.row.id.localeCompare(b.row.id));

  const items: { exemplarId: string; sourceKind: string; sourceRef: string; score: number; body: string }[] = [];
  let skipped = 0;
  for (const candidate of ranked) {
    if (items.length >= k) break;
    const body = readExemplarBody(ctx, candidate.row);
    if (body === undefined) {
      // The source application deleted it, and the source is authoritative (OP6). Skip; the row
      // leaves on the next reindex, not on a read.
      skipped += 1;
      continue;
    }
    items.push({
      exemplarId: candidate.row.id,
      sourceKind: candidate.row.source_kind,
      sourceRef: candidate.row.source_ref,
      score: Math.round(candidate.score * 10000) / 10000,
      body,
    });
  }

  const fingerprint = corpusFingerprint(ctx, profile.account_id, profileDocumentIds(ctx, profile.id));
  return ok({ items, skipped, stale: fingerprint !== profile.source_sha256 });
}

/** A body read on demand from its locator, or undefined when the source no longer resolves. */
function readExemplarBody(ctx: WorkspaceContext, exemplar: VoiceExemplarRow): string | undefined {
  if (exemplar.source_kind === 'sent_mail') {
    const message = ctx.store.db
      .prepare('SELECT account_id, store_ref FROM mail_message WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, exemplar.source_ref) as { account_id: string; store_ref: string } | undefined;
    if (message === undefined) return undefined;
    const account = readMailAccount(ctx, message.account_id);
    if (account === undefined) return undefined;
    const raw = mailAdapterOf(account).readBody(account.store_path, message.store_ref);
    return raw === undefined ? undefined : stripHeaders(raw);
  }
  const file = ctx.store.db
    .prepare('SELECT storage_ref, pending_delete FROM stored_file WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, exemplar.source_ref) as { storage_ref: string; pending_delete: number } | undefined;
  if (file === undefined || file.pending_delete === 1) return undefined;
  const blob = ctx.store.db
    .prepare('SELECT content FROM stored_file_blob WHERE workspace_id = ? AND sha256 = ?')
    .get(ctx.workspaceId, file.storage_ref) as { content: Buffer } | undefined;
  if (blob === undefined) return undefined;
  const bytes = Buffer.isBuffer(blob.content) ? blob.content : Buffer.from(blob.content as unknown as Uint8Array);
  return bytes.toString('utf8');
}

/* ------------------------------------------------------------------------------------------------
 * erasure (revDSG Art. 32): internal, called INSIDE C00's anonymise transaction, never an MCP tool
 * ---------------------------------------------------------------------------------------------- */

/**
 * Purge every exemplar embedded from the erased person's mail: the vectors are derived from
 * Art. 321 correspondence keyed to that person, and an embedding is deleted with a `DELETE`, which
 * is the whole reason retrieval beat fine-tuning (spec §3). Runs INSIDE `contacts_anonymise`'s
 * transaction, BEFORE `purgeMailForContact` (it needs the `mail_message` rows to find its own).
 * The profile row and its style card survive: the card is distilled statistics over the whole
 * corpus, not material about the person, and its staleness flag flips so a rebuild is offered.
 *
 * DELIBERATELY NOT AN MCP TOOL: erasure is C00 `contacts_anonymise`'s single entry point, exactly
 * as E04's `purgeMailForContact` is.
 */
export function purgeVoiceForContact(ctx: WorkspaceContext, contactIds: readonly string[]): {
  exemplars: number;
} {
  if (contactIds.length === 0) return { exemplars: 0 };
  const placeholders = contactIds.map(() => '?').join(', ');
  const exemplars = ctx.store.db
    .prepare(
      `DELETE FROM voice_exemplar
        WHERE workspace_id = ? AND source_kind = 'sent_mail'
          AND source_ref IN (
            SELECT m.id FROM mail_message m
             WHERE m.workspace_id = ? AND (
               m.contact_id IN (${placeholders})
               OR m.thread_id IN (
                 SELECT t.id FROM mail_thread t
                  WHERE t.workspace_id = ? AND t.contact_id IN (${placeholders})
               )
             )
          )`,
    )
    .run(ctx.workspaceId, ctx.workspaceId, ...contactIds, ctx.workspaceId, ...contactIds).changes;
  return { exemplars };
}
