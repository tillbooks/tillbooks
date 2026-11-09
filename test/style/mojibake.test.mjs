/**
 * The MOJIBAKE guard: double-encoded UTF-8 does not survive in this repo's markdown.
 *
 * WHY THIS GUARD EXISTS, NAMED PRECISELY: double-encoded UTF-8 PASSES the transliteration guard.
 * `test/style/umlaut-transliteration.test.mjs` hunts ASCII spellings (`Treuhaender`, `Uebersicht`),
 * so a `Treuhänder` whose ä was encoded twice (the UTF-8 bytes 0xC3 0xA4 re-read as Latin-1 and
 * re-encoded, yielding 0xC3 0x83 0xC2 0xA4) contains a real non-ASCII sequence, matches no register
 * entry, and sails through while rendering as mojibake ("TreuhÃ¤nder"). This happened TWICE:
 * kaizen round 1 repaired two occurrences in `docs/planning/DECISIONS.md` (K-3), and its critic
 * then found eight more across three modernisation planning docs. Second occurrence of the class,
 * so the class gets a permanent guard, per the flywheel rule.
 *
 * WHY THIS EXACT BYTE SIGNATURE, AND NOTHING LOOSER. The check is raw bytes: 0xC3 0x83 followed by
 * 0xC2 or 0xC3. In valid single-encoded UTF-8, 0xC3 0x83 decodes to Ã, and the ONLY way Ã appears
 * in this repo's prose is as the first half of a double-encoded character: every two-byte UTF-8
 * sequence for Latin-1 Supplement text (all French/German/Italian accents: ä = 0xC3 0xA4,
 * à = 0xC3 0xA0, é = 0xC3 0xA9, ü = 0xC3 0xBC) double-encodes to 0xC3 0x83 followed by a 0xC2/0xC3
 * lead-in. Single-encoded accents NEVER contain the pair 0xC3 0x83 at all, because their second
 * byte is a continuation byte in 0x80-0xBF range only reached via 0xA0-0xBC here. So the signature
 * cannot fire on correct French (`Equipements`, `Crésus`), correct German umlauts, or English.
 * It can, in principle, MISS a double-encoding of a character outside Latin-1 Supplement; that is
 * the deliberate trade, the same one the transliteration guard makes with its word register:
 * a guard that can false-positive gets deleted, a guard that can only miss gets kept. No heuristics
 * beyond the signature, no decoding, no word list.
 *
 * WHAT IS JUDGED: every tracked `*.md` file, raw bytes, no exemptions. Unlike the transliteration
 * guard, `docs/naming/` is NOT exempt here: mojibake is a transport defect, never an intentional
 * historical spelling, so there is nothing in any archive worth preserving that matches.
 *
 * The guard proves its own teeth below: a fixture with one injected signature must fail the scan.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function trackedMarkdownFiles() {
  return execFileSync('git', ['ls-files', '*.md'], { env: cleanGitEnv(), cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** Scan one buffer; return { offset, context } hits. Pure so the teeth test can reuse it. */
function scanForMojibake(buf) {
  const hits = [];
  for (let i = 0; i + 2 < buf.length; i += 1) {
    if (buf[i] === 0xc3 && buf[i + 1] === 0x83 && (buf[i + 2] === 0xc2 || buf[i + 2] === 0xc3)) {
      const context = buf
        .subarray(Math.max(0, i - 20), Math.min(buf.length, i + 24))
        .toString('latin1')
        .replace(/\s+/g, ' ');
      hits.push({ offset: i, context });
    }
  }
  return hits;
}

test('no tracked markdown file carries the double-encoding byte signature', () => {
  const files = trackedMarkdownFiles();
  assert.ok(files.length > 50, `expected a real corpus, got ${files.length} markdown files`);

  const findings = [];
  for (const rel of files) {
    const buf = readFileSync(join(ROOT, rel));
    for (const { offset, context } of scanForMojibake(buf)) {
      findings.push(`${rel}:${offset}: ...${context}...`);
    }
  }

  assert.deepEqual(
    findings,
    [],
    'Double-encoded UTF-8 (mojibake) found. Repair at the byte level: replace the sequence ' +
      '0xC3 0x83 0xC2 0xXX / 0xC3 0x83 0xC3 0xXX with its single-encoded original ' +
      '(e.g. b"\\xc3\\x83\\xc2\\xa4" -> b"\\xc3\\xa4" for a real ä). Findings:\n' +
      findings.join('\n'),
  );
});

test('the guard has teeth: an injected double-encoded sequence is caught', () => {
  // "Treuhänder" with the ä double-encoded, exactly the defect this guard exists for.
  const bad = Buffer.concat([
    Buffer.from('ein Treuh', 'utf8'),
    Buffer.from([0xc3, 0x83, 0xc2, 0xa4]),
    Buffer.from('nder im Text', 'utf8'),
  ]);
  const hits = scanForMojibake(bad);
  assert.equal(hits.length, 1, 'the signature scan must catch a re-introduced double-encoding');
  assert.equal(hits[0].offset, 9);
});

test('the guard is silent on correct single-encoded accents', () => {
  // Every accent class the repo actually uses: German umlauts, French accents, the sharp quote.
  const good = Buffer.from('Treuhänder, Übersicht, Fremdwährung, Crésus, à propos, Gäld', 'utf8');
  assert.deepEqual(scanForMojibake(good), []);
});
