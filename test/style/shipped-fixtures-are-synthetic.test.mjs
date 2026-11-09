// @ts-check
/**
 * A SHIPPED FILE NEVER CLAIMS REAL-DATA PROVENANCE: fixtures and examples in public paths are synthetic.
 *
 * THE RULE. Fixtures, examples and test data in paths that ship are invented from scratch. Removing
 * names from real data does not make it synthetic: what remains still describes a real business. So a
 * shipped file never describes its data as taken from a real account, a real bank export or real books,
 * whether it says so outright, in the negative, or as an instruction to put such data in later.
 *
 * WHAT IT ASSERTS. No tracked text file that ships carries a phrase from the list below. A synthetic
 * fixture states what it IS (invented values, built to a published standard); the negative form ("not
 * a copy of ...") counts as a claim too, because it tells the reader that such a copy existed.
 *
 * WHAT IT DOES NOT ASSERT. This is a guard over CLAIMS, not values. It cannot see a real amount with
 * no comment around it. The values are checked by a separate scan that compares every shipped file
 * against fingerprints of the private books, on the owner's machine, before anything is published.
 *
 * SCOPE. Every tracked file, minus the areas that never ship (`docs/`, `web/`, `.claude/`, `ops/`,
 * `.githooks/`, `test/ops/`, `CLAUDE.md`), minus `.gitignore` (an ignore rule names what must NOT be
 * committed, the opposite of a provenance claim). This file is judged like every other: its phrase list
 * and its probe sentences are written so that they never match themselves (the probes are assembled
 * from fragments when the test runs). In a checkout where those areas do not exist the exclusions are
 * simply inert.
 *
 * THE PHRASE LIST is the JSON array between the two marker comments below. The publish step reads that
 * block out of this file to run the same check over the exact snapshot it is about to publish, so the
 * block must stay a valid JSON array of `[source, flags]` pairs. Tune a phrase against the tree, never by
 * deleting the hit: a phrase that fires is either a real claim to reword or a pattern to narrow.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cleanGitEnv } from '../lib/git-env.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SELF = 'test/style/shipped-fixtures-are-synthetic.test.mjs';

// provenance-phrases:begin
const PHRASE_SPECS = [
  ["\\b(?:byte|identity)[- ]scrubbed\\b", "i"],
  ["\\bscrubbed (?:but|from|real|owner|bank|zkb|export|iban|account|statement|copy|version)\\b", "i"],
  ["\\breal (?:zkb|bexio|postfinance|ubs|raiffeisen|bank)\\b[^\\n]{0,30}?\\bexports? (?:arrives?|lands?|comes in|is available)\\b", "i"],
  ["\\bfrom (?:the |an? )?owner(?:'s|s)? (?:own )?(?:real )?(?:account|books|ledger|bank|statements?|exports?|data)\\b", "i"],
  ["\\bverbatim from (?:the|a|an|our|my) (?:bank|real|live|production|owner)", "i"],
  ["\\breal[- ]derived\\b", "i"],
  ["\\b(?:derived|copied|taken|lifted|extracted|exported|pulled) (?:verbatim )?from (?:a |an |the |our |my )?(?:real|actual|live|production|genuine) (?:zkb |bexio |bank )?(?:exports?|statements?|ledgers?|books|bank data|customer data|account data)\\b", "i"],
  ["\\b(?:anonymi[sz]ed|pseudonymi[sz]ed|saniti[sz]ed|redacted|scrubbed) (?:copy|version|extract|export|snapshot) of (?:a |an |the |our |my )?(?:real|actual|live|production|genuine)\\b", "i"],
  ["\\bfrom (?:our|my) (?:own )?(?:zkb|bexio|bank|postfinance|ubs|raiffeisen) (?:account|export|statement|data)s?\\b", "i"],
  ["\\bbexio[-_ ]raw\\b", "i"],
  ["\\b[a-z0-9]+-exports/", "i"],
  ["\\bprivate[- ]fixtures?\\b", "i"],
  ["\\b(?:our|my) (?:own )?real (?:books|ledger|bank|accounts?|statements?|exports?)\\b", "i"],
  ["\\bREAL (?:ZKB|BANK|EXPORT|DATA)\\b", ""]
];
// provenance-phrases:end

const PHRASES = PHRASE_SPECS.map((spec) => new RegExp(String(spec[0]), String(spec[1] ?? '')));

/** Areas of the tree that never ship, as path prefixes, plus files judged elsewhere. */
const NOT_SHIPPED = ['docs/', 'web/', '.claude/', 'ops/', '.githooks/', 'test/ops/'];
const EXCLUDED_FILES = new Set(['CLAUDE.md', '.gitignore']);

/** @returns {string[]} */
function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { env: cleanGitEnv(), cwd: ROOT, maxBuffer: 1 << 28 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

/** @param {string} path */
function shipped(path) {
  return !EXCLUDED_FILES.has(path) && !NOT_SHIPPED.some((p) => path.startsWith(p));
}

/**
 * Every provenance claim in `text`, one entry per line (the first phrase that fires names it). A claim
 * is reported by file, line and phrase, never by the line's text, which may carry values.
 * @param {string} file
 * @param {string} text
 * @returns {{ file: string, line: number, phrase: string }[]}
 */
function claimsIn(file, text) {
  /** @type {{ file: string, line: number, phrase: string }[]} */
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const re = PHRASES.find((r) => r.test(line));
    if (re) found.push({ file, line: i + 1, phrase: re.source });
  }
  return found;
}

test('the corpus is the shipped tree and it is not empty', () => {
  const files = trackedFiles().filter(shipped);
  assert.ok(files.length >= 500, `only ${files.length} shipped files were found: git ls-files read nothing useful`);
  assert.ok(files.includes('README.md'), 'README.md is not in the corpus, so the filter is excluding what ships');
  assert.ok(files.some((f) => f.startsWith('test/banking/')), 'no bank fixture is in the corpus, and fixtures are what this rule is about');
  assert.ok(files.includes(SELF), 'this file must be judged by its own phrases, not exempt from them');
});

test('no shipped file claims its data came from a real account or export', () => {
  /** @type {{ file: string, line: number, phrase: string }[]} */
  const claims = [];
  for (const file of trackedFiles().filter(shipped)) {
    /** @type {Buffer} */
    let buf;
    try {
      buf = readFileSync(join(ROOT, file));
    } catch {
      continue;
    }
    if (buf.subarray(0, 8192).includes(0)) continue;
    claims.push(...claimsIn(file, buf.toString('utf8')));
  }
  assert.deepEqual(
    claims.map((c) => `${c.file}:${c.line}  matches /${c.phrase}/`),
    [],
    `${claims.length} shipped line(s) claim real-data provenance. Fixtures in public paths are synthetic by ` +
      'construction: describe what the data IS (invented values, the published standard it follows), not ' +
      'where a real copy came from or that it is not one. If the data really is derived from a real ' +
      'account, it does not belong in a shipped path at all.',
  );
});

test('mechanism: every phrase bites, and the sentences the tree legitimately uses do not', () => {
  // assembled from fragments, so this file's own lines never carry a claim the scan would flag
  /** @param {string[]} parts */
  const w = (...parts) => parts.join(' ');
  /** @param {string[]} parts */
  const d = (...parts) => parts.join('-');
  const claimsFor = [
    w('this fixture is a', 'REAL', 'BANK', 'export,', d('identity', 'scrubbed')),
    w('names', 'scrubbed', 'but', 'amounts kept'),
    w('this is NOT a', d('byte', 'scrubbed'), 'copy'),
    w('When a real', 'bank', 'export arrives it should REPLACE this file'),
    w('values taken from the', "owner's", 'account'),
    w('copied verbatim from the', 'bank statement'),
    w('a', d('real', 'derived'), 'fixture'),
    w('balances derived from a', 'real bank statement'),
    w('an anonymised copy of a', 'real export'),
    w('pulled from our', 'bank account'),
    w('see', `${d('bexio', 'raw')}/journal.xlsx`),
    w('from', `acme${'-'}exports/statement.xml`),
    w('kept in the private', 'fixtures folder'),
    w('these are our', 'real books'),
    w('the entry-level ref (scrubbed', 'from the order ref)'),
  ];
  for (const s of claimsFor) {
    assert.ok(claimsIn('probe', s).length > 0, `the phrase list does not catch: ${s}`);
  }
  for (const re of PHRASES) {
    assert.ok(claimsFor.some((s) => re.test(s)), `no probe exercises the phrase /${re.source}/, so nothing proves it bites`);
  }
  const legitimate = [
    'Every VALUE is invented: names, addresses, IBANs, references, statement ids and amounts.',
    'the real ISO 20022 notification element is Ntfctn',
    'headers observed from a real bexio account and help.bexio.com',
    'a real export carries more than TILL stores',
    'the parent handed a scrubbed env (no inherited secrets)',
    'the reserved-key list is derived from the real columns',
    'functional observation of the owner\'s own account',
    'learned from a real bexio Bilanz export',
    'If you run TILL against your real accounts today, expect to lose the data',
    'a rule that fired a copy at 03:00 would move real client data',
  ];
  for (const s of legitimate) {
    assert.deepEqual(claimsIn('probe', s), [], `a legitimate sentence is flagged: ${s}`);
  }
});

test('the phrase block stays machine-readable for the publish step', () => {
  const src = readFileSync(join(ROOT, SELF), 'utf8');
  const block = /\/\/ provenance-phrases:begin\n([\s\S]*?)\/\/ provenance-phrases:end/.exec(src)?.[1] ?? '';
  const json = block.slice(block.indexOf('['), block.lastIndexOf(']') + 1);
  /** @type {unknown} */
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed, PHRASE_SPECS, 'the marked block does not parse to the list this file uses');
});
