// @ts-check
/**
 * NO TRACKED TEXT FILE MAY CONTAIN A NUL BYTE, because a file that does is invisible to `grep`.
 *
 * THE DEFECT THIS EXISTS FOR. `src/core/ledger/auditLog.ts` carried one raw NUL at byte 3297, the
 * separator in `H(prev_hash NUL canonical(row))`, written as the byte instead of the escape. That is
 * enough to make every tool that sniffs content call the file binary. Measured on the tree before the
 * fix:
 *
 *     $ file src/core/ledger/auditLog.ts
 *     src/core/ledger/auditLog.ts: data
 *     $ grep -c "chainVerified" src/core/ledger/auditLog.ts ; echo "exit=$?"
 *     exit=1
 *     $ grep -ac "chainVerified" src/core/ledger/auditLog.ts ; echo "exit=$?"
 *     10
 *     exit=0
 *
 * No match, no warning, exit 1. `grep -rn` over `src/` skipped the file in silence, and it was the
 * only one of the tree's source files with that property.
 *
 * WHY THAT IS WORSE THAN IT LOOKS HERE. This repo's longest-running defect family, "the Studio
 * assumed a shape the engine never sends", has six known members and every one of them was found by
 * grepping `src/` for a field name. A file `grep` cannot see is a permanent blind spot in the method
 * that has caught the most defects in this codebase. It nearly cost a real one: `chainVerified` was
 * about to be filed as a phantom affordance on the grounds that `grep -rn chainVerified src/` found
 * nothing, while `auditLog.ts` line 238 sends it on every read.
 *
 * WHY A BYTE SCAN AND NOT `git diff --numstat` OR A `.gitattributes` RULE. Git's own binary
 * detection would be the elegant mechanism, but it is configurable per repo and per checkout
 * (`.gitattributes`, `core.autocrlf`, filters), so a guard built on it asserts the configuration and
 * not the bytes. The bytes are what `grep` reads. This reads the bytes.
 *
 * SCAN COST, measured on this tree rather than estimated: 1014 text files, ~214 MB, 333 ms wall on
 * a cold page cache and ~42 ms warm. The suite prints the figure on every run, so drift is visible.
 * The size is not the source: it is 23 committed `report.html` evidence files under
 * `.claude/ui-tests/runs`, ~2.7 MB each, screenshots inlined as base64. The whole scan is cheaper
 * than one `tsc` invocation, so there is no reason to sample rather than read everything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The extensions whose files are SUPPOSED to be binary, and so are exempt from the scan.
 *
 * Deliberately an allowlist of formats and not a "skip anything that looks binary" heuristic: the
 * whole point is that a NUL appearing where nobody expected one is the finding. A new asset format
 * lands here by a person deciding it belongs, which is the moment to notice that the repo now holds
 * bytes `grep` will not read.
 */
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.ico',
  '.icns',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.zip',
  '.gz',
  '.tgz',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.wasm',
  '.mp4',
  '.mov',
  '.webm',
]);

/**
 * Extensions that carry SOURCE, in the broad sense of "text a person or a grep reads".
 *
 * Held separately so the escape hatch cannot become the fix. The obvious wrong way to green this
 * guard is to add `.ts` to `BINARY_EXTENSIONS`; the assertion below makes that its own failure.
 */
const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.html',
  '.astro',
  '.css',
  '.scss',
  '.yml',
  '.yaml',
  '.xml',
  '.svg',
  '.txt',
  '.sh',
  '.toml',
]);

/**
 * The lowercased extension of a path, or `''` when it has none.
 *
 * Matched on the last segment so a dotted directory (`.claude/ui-tests/...`) cannot be read as an
 * extension on a file that has none.
 *
 * @param {string} path repo-relative
 * @returns {string}
 */
function extensionOf(path) {
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  return dot <= 0 ? '' : last.slice(dot).toLowerCase();
}

/**
 * Every file git tracks, repo-relative.
 *
 * `-z` because a path may legally contain a newline, and git quotes such a path in the default
 * output. A split on `\n` would then invent two files that do not exist and report a missing-file
 * error for both, so this guard would fail by accusing the repo of its own parsing bug.
 *
 * @returns {string[]}
 */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/** The tracked files this guard judges: everything but the declared binary formats. */
function textFiles() {
  return trackedFiles().filter((f) => !BINARY_EXTENSIONS.has(extensionOf(f)));
}

/**
 * The offset of the first NUL in each of `paths` that has one.
 *
 * A missing file is reported as a finding rather than skipped. `git ls-files` naming something that
 * is not on disk means the corpus is not what it claims to be, and silence there is exactly the
 * failure mode this whole file is about.
 *
 * @param {string[]} paths repo-relative
 * @param {string} [base] the directory they are relative to
 * @returns {{ file: string, offset: number, bytes: number }[]}
 */
function nulBearing(paths, base = ROOT) {
  /** @type {{ file: string, offset: number, bytes: number }[]} */
  const found = [];
  for (const file of paths) {
    /** @type {Buffer} */
    let buffer;
    try {
      buffer = readFileSync(join(base, file));
    } catch {
      found.push({ file, offset: -1, bytes: -1 });
      continue;
    }
    const offset = buffer.indexOf(0);
    if (offset !== -1) found.push({ file, offset, bytes: buffer.length });
  }
  return found;
}

// -------------------------------------------------------------------------------------------
// The corpus is real
// -------------------------------------------------------------------------------------------

test('the corpus is non-empty and holds the file the defect was found in', () => {
  // A guard whose glob silently resolves to nothing passes forever. The number is a floor and not an
  // equality: files land here every day, and a guard that fails on growth gets deleted.
  const files = textFiles();
  assert.ok(
    files.length >= 500,
    `the scan corpus is ${files.length} files, which is far below this repo's size. \`git ls-files\` ` +
      'returned little or nothing (wrong cwd, not a work tree, a broken -z parse), so a green ' +
      'verdict below would mean the scan found nothing because it read nothing.',
  );
  assert.ok(
    files.includes('src/core/ledger/auditLog.ts'),
    'the audit-log module is not in the corpus, and it is the exact file that carried the NUL this ' +
      'guard exists for. Either the path moved (update this assertion deliberately) or the filter ' +
      'above is excluding source.',
  );
});

test('the binary exemption cannot be used to smuggle source past the scan', () => {
  // The path of least resistance when this guard goes red is to add the offending extension to
  // BINARY_EXTENSIONS. That would restore the blind spot the guard was written to close, so it is
  // itself a failure.
  const smuggled = [...BINARY_EXTENSIONS].filter((ext) => SOURCE_EXTENSIONS.has(ext));
  assert.deepEqual(
    smuggled,
    [],
    `${JSON.stringify(smuggled)} is listed as a binary format AND as a source format. Exempting a ` +
      'source extension is how this guard gets silenced rather than satisfied: the NUL stays, the ' +
      'file stays invisible to `grep -rn`, and the suite goes green about it.',
  );
});

// -------------------------------------------------------------------------------------------
// The mechanism reddens
// -------------------------------------------------------------------------------------------

test('mechanism: a planted NUL is found, and its NUL-free twin is not', () => {
  // Proving the detector on files this test writes itself, because the assertion below is a negative
  // one: without this, "no NUL anywhere" is indistinguishable from "the scan never looked".
  const dir = mkdtempSync(join(tmpdir(), 'till-nul-'));
  try {
    const separator = String.fromCharCode(0);
    writeFileSync(join(dir, 'planted.ts'), `export const sep = '${separator}';\n`);
    writeFileSync(join(dir, 'clean.ts'), "export const sep = '\\u0000';\n");

    const found = nulBearing(['planted.ts', 'clean.ts'], dir);
    assert.deepEqual(
      found.map((f) => f.file),
      ['planted.ts'],
      'the scan did not single out the file with the planted NUL, so it is not detecting what this ' +
        `guard claims it detects. Got: ${JSON.stringify(found)}`,
    );
    assert.equal(found[0]?.offset, 20, 'the reported offset is not where the planted NUL actually sits');

    // And the property that makes it matter: the escaped twin is byte-for-byte free of NUL while
    // still spelling the same string at runtime.
    assert.equal(
      JSON.parse('"\\u0000"'),
      separator,
      'the escape and the raw byte are not the same character, which would make the fix in ' +
        '`auditLog.ts` a change to the audit-log hash domain rather than a re-spelling of it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mechanism: a file git does not have on disk is reported, never skipped', () => {
  const found = nulBearing(['no-such-file-anywhere.ts']);
  assert.deepEqual(
    found.map((f) => f.file),
    ['no-such-file-anywhere.ts'],
    'an unreadable path was swallowed. A scan that skips what it cannot open reports "clean" for a ' +
      'corpus it never read, which is the shape of every guard in this repo that turned out to be inert.',
  );
});

// -------------------------------------------------------------------------------------------
// The guard proper
// -------------------------------------------------------------------------------------------

test('no tracked text file contains a NUL byte, so `grep -rn` can see all of them', () => {
  const files = textFiles();
  const started = process.hrtime.bigint();
  const found = nulBearing(files);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // Reported, not asserted: a wall-clock threshold on a shared CI box is a flake, but a scan that
  // silently grows to minutes is worth seeing in the log.
  console.log(`  scanned ${files.length} tracked text files in ${ms.toFixed(0)} ms`);

  assert.deepEqual(
    found,
    [],
    'a tracked text file contains a NUL byte. `file` will call it binary and `grep` will skip it ' +
      'without printing anything and exit 1, so it is invisible to every `grep -rn` sweep over this ' +
      'repo, which is how most of the Studio/engine contract defects here were found. If the byte is ' +
      'deliberate (a hash-domain separator, a delimiter), write it as the escape `\\u0000`: same ' +
      'character at runtime, visible file on disk. If the file is genuinely binary, add its ' +
      `extension to BINARY_EXTENSIONS above. Found: ${JSON.stringify(found)}`,
  );
});
