/**
 * Deterministic E05 fixtures: the stub OP6 adapter, a contract-valid manifest, and corpus
 * builders over E04's own mail fixtures.
 *
 * THE STUB ADAPTER IS THE SPEC'S OWN TEST DESIGN (§8: "a stub adapter, deterministic embeddings,
 * so the suite runs offline and fast"). `embed` hashes character trigrams into a fixed 64-dim
 * vector, which is enough structure for cosine ranking to prefer a near-duplicate over unrelated
 * prose while staying bit-reproducible across runs; `complete` answers canned text (E06's seam,
 * unused by E05's build). Neither touches anything outside process memory, and every suite here
 * runs under the OP6 egress probe, so a stub that dialled out would fail the suite that used it.
 */

import { rfc822 } from '../mail/fixtures.mjs';

/** FNV-1a, the boring deterministic hash. */
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A deterministic 64-dim trigram embedding: same text, same vector, every run, every machine. */
export function deterministicEmbed(text) {
  const vector = new Float32Array(64);
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
  for (let i = 0; i < normalized.length - 2; i += 1) {
    const trigram = normalized.slice(i, i + 3);
    const bucket = fnv1a(trigram) % 64;
    vector[bucket] += 1;
  }
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return vector.map((v) => v / norm);
}

/** The stub OP6 adapter. `modelRef` matches the manifest's first row so a build stamps a real ref. */
export function stubAdapter(overrides = {}) {
  return {
    id: 'stub-local',
    modelRef: 'stub-4b-q4',
    device: 'test',
    complete: (prompt) => `STUB COMPLETION: ${prompt.slice(0, 40)}`,
    embed: deterministicEmbed,
    ...overrides,
  };
}

/**
 * A manifest that PASSES the registration contract: commercial-use licence, nameable SPDX id,
 * pinned sha256, immutable-revision URL, a RAM floor. `stub-4b-q4` fits every machine (1 GB);
 * `stub-70b-f16` fits none (a floor no laptop clears), which is what the insufficient_ram and
 * disabled-row assertions key on without ever reading the real machine's RAM into the fixture.
 */
export function stubManifest() {
  return [
    {
      modelRef: 'stub-4b-q4',
      displayName: 'Stub 4B (Q4)',
      minRamGb: 1,
      downloadBytes: 2_400_000_000,
      sha256: 'a'.repeat(64),
      upstreamUrl: 'https://example.invalid/models/stub-4b/commit/0123abcd/stub-4b-q4.gguf',
      licence: { spdx: 'Apache-2.0', commercialUse: true },
      qualityDe: 'Deutsch nicht gemessen: diese Zeile verspricht nichts.',
      qualityEn: 'English quality not measured.',
      qualityMeasured: false,
      contextTokens: 8192,
    },
    {
      modelRef: 'stub-9b-q4',
      displayName: 'Stub 9B (Q4)',
      minRamGb: 1,
      downloadBytes: 5_600_000_000,
      sha256: 'b'.repeat(64),
      upstreamUrl: 'https://example.invalid/models/stub-9b/commit/4567cdef/stub-9b-q4.gguf',
      licence: { spdx: 'Apache-2.0', commercialUse: true },
      qualityDe: 'Schreibt gutes Deutsch (im Test gelesen).',
      qualityEn: 'Writes good English (read in testing).',
      qualityMeasured: true,
      contextTokens: 8192,
    },
    {
      modelRef: 'stub-70b-f16',
      displayName: 'Stub 70B (F16)',
      minRamGb: 100000,
      downloadBytes: 140_000_000_000,
      sha256: 'c'.repeat(64),
      upstreamUrl: 'https://example.invalid/models/stub-70b/commit/89abcdef/stub-70b-f16.gguf',
      licence: { spdx: 'Apache-2.0', commercialUse: true },
      qualityDe: 'Benötigt mehr RAM als jeder Laptop hat.',
      qualityEn: 'Needs more RAM than any laptop has.',
      qualityMeasured: true,
      contextTokens: 32768,
    },
  ];
}

/**
 * A corpus over the E04 fixture shapes: `count` OUTBOUND replies from the practitioner (each its
 * own thread, distinct Message-IDs, prose varied enough that trigram cosine can tell them apart)
 * plus one inbound message. Returns `{ messages }` for `makeMaildirStore`.
 */
export function outboundCorpus(count, accountAddress = 'praxis@example.ch', clientAddress = 'klient@example.org') {
  const topics = [
    'Terminverschiebung', 'Rechnungsfrage', 'Erstgespräch', 'Absage', 'Verordnung',
    'Kostengutsprache', 'Zwischenbericht', 'Ferienabwesenheit', 'Sitzungsrhythmus', 'Anmeldung',
  ];
  const messages = [];
  for (let i = 0; i < count; i += 1) {
    const topic = topics[i % topics.length];
    const id = `voice-out-${i + 1}@example.ch`;
    messages.push({
      id,
      raw: rfc822({
        from: accountAddress,
        to: clientAddress,
        subject: `Re: ${topic} ${i + 1}`,
        messageId: id,
        date: `Mon, ${String((i % 27) + 1).padStart(2, '0')} Jul 2026 10:00:00 +0200`,
        body: `Guten Tag\r\nDanke für Ihre Nachricht zu ${topic}. Gerne bestätige ich Ihnen den Vorschlag Nummer ${i + 1}; das passt für mich gut.\r\nFreundliche Grüsse\r\nPraxis Muster`,
      }),
    });
  }
  messages.push({
    id: 'voice-in-1@example.org',
    raw: rfc822({
      from: `Klient Muster <${clientAddress}>`,
      to: accountAddress,
      subject: 'Terminanfrage',
      messageId: 'voice-in-1@example.org',
      date: 'Tue, 28 Jul 2026 08:00:00 +0200',
      body: 'Guten Tag, hätten Sie nächste Woche einen Termin frei?',
    }),
  });
  return messages;
}
