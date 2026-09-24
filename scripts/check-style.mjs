#!/usr/bin/env node
/**
 * House-style guard.
 *
 * Rule 1: no em dashes (U+2014), anywhere, ever. Use a colon, a comma, or parentheses.
 * En dashes (U+2013) are allowed: they carry real meaning in ranges like "B-F" or "8.1-3.8".
 *
 * docs/naming/ is exempt. It is a historical audit trail and is preserved verbatim.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gitEnv } from './lib/git-env.mjs';

/** Written as an escape, never a literal, so this file does not trip its own guard. */
const EM_DASH = '\u2014';

/** Paths preserved verbatim as a historical record, so the rule does not apply. */
const EXEMPT = [/^docs\/naming\//];

/**
 * Only text we author. Binary, generated and vendored trees are skipped.
 *
 * Script families are listed in full deliberately. This regex carried `mjs` and `js` but not
 * `cjs`, which silently exempted the entire .claude/ui-tests harness (23 files) from the one
 * rule CI exists to enforce. `cts`/`mts` have no tracked files yet and are listed for the same
 * reason `js`/`jsx`/`yaml` already were: covering the family costs nothing and closes the gap
 * before someone adds the first such file.
 *
 * Deliberately absent: `xml` and `log` (upstream fixtures and process output, neither authored),
 * `png` (binary), and `svg` (an exported asset format, typically tool output rather than prose).
 */
const CHECKED = /\.(mjs|cjs|js|jsx|ts|cts|mts|tsx|md|mdx|json|css|html|astro|yml|yaml|txt)$/;

function tracked() {
  return execFileSync('git', ['ls-files'], { env: gitEnv(), encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter((p) => CHECKED.test(p))
    .filter((p) => !EXEMPT.some((re) => re.test(p)));
}

const violations = [];
const files = tracked();

for (const path of files) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    continue;
  }
  if (!text.includes(EM_DASH)) continue;

  text.split('\n').forEach((line, i) => {
    if (!line.includes(EM_DASH)) return;
    violations.push({ path, line: i + 1, text: line.trim().slice(0, 100) });
  });
}

if (violations.length === 0) {
  console.log(`check-style: ok, no em dashes found in ${files.length} tracked files.`);
  process.exit(0);
}

console.error(`check-style: FAILED with ${violations.length} em dash(es).\n`);
console.error('House rule: no em dashes, anywhere, ever. Use a colon, a comma, or parentheses.\n');
for (const v of violations) {
  console.error(`  ${v.path}:${v.line}`);
  console.error(`    ${v.text}`);
}
process.exit(1);
