// One scroll, never two (owner, 09.11.2026). Inside the app frame the document never scrolls: only
// <main> and the panels that own their scroll do. A second scrollbar beside main's appeared whenever
// anything poked past the viewport, because html and body were left at overflow: visible.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const css = readFileSync(join(ROOT, 'app/src/styles/global.css'), 'utf8');

test('the document never scrolls inside the app frame; main does', () => {
  assert.match(css, /html:has\(\.frame\),\s*html:has\(\.frame\) body\s*\{\s*overflow:\s*hidden;\s*\}/, 'global.css must lock html and body scroll while the frame is mounted');
  assert.match(css, /\.frame > main \{[^}]*overflow: auto;/, 'main keeps its own scroll');
});
