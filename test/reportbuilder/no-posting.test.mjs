/**
 * F01 posts NOTHING (P3). The spec's §7 invariant, proven statically: no file in the reportbuilder
 * engine may import the posting or settlement seam. A report has no financial effect; it composes read
 * models and renders an artifact. If a future edit reaches for `postEntry` or `recordPayment` here,
 * this test reddens before it can land, which is the whole point of asserting the means rather than
 * trusting the comment.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../src/core/reportbuilder/', import.meta.url));

const FORBIDDEN = [
  'postEntry',
  'reverseEntry',
  'recordPayment',
  'allocatePayment',
  "from '../ledger/",
  "from '../payments/",
];

test('F01: the reportbuilder engine imports no posting or settlement seam', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length >= 6, 'the reportbuilder module has its files, or this scan proves nothing');
  for (const file of files) {
    const src = readFileSync(DIR + file, 'utf8');
    for (const needle of FORBIDDEN) {
      assert.ok(
        !src.includes(needle),
        `${file} references \`${needle}\`, which is the posting/settlement seam F01 must never touch (P3)`,
      );
    }
  }
});
