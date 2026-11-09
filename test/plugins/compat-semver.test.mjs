/**
 * G02 §8: the semver `compat_range` comparator, table-tested directly (it is pure, so no database).
 *
 * Exact, caret, tilde, comparator sets, x-ranges and OR sets are all exercised against a fixed
 * version, and `isValidRange` is checked so a manifest with an unreadable range degrades to
 * `invalid_manifest` (fail closed) rather than accidentally-compatible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { satisfies, isValidRange, CORE_CONTRACT_VERSION } from '../../dist/core/plugins/index.js';

test('G02: the core contract version is a clean semver the comparator can read', () => {
  assert.equal(isValidRange(CORE_CONTRACT_VERSION), true);
  assert.equal(satisfies(CORE_CONTRACT_VERSION, CORE_CONTRACT_VERSION), true);
});

test('G02: semver satisfies covers exact, caret, tilde, comparators, x-ranges and OR', () => {
  const cases = [
    // [version, range, expected]
    ['1.2.3', '1.2.3', true],
    ['1.2.3', '1.2.4', false],
    ['1.2.3', '^1.0.0', true],
    ['1.9.9', '^1.0.0', true],
    ['2.0.0', '^1.0.0', false],
    ['0.2.5', '^0.2.0', true],
    ['0.3.0', '^0.2.0', false], // caret on 0.x pins the minor
    ['0.0.4', '^0.0.3', false], // caret on 0.0.x pins the patch
    ['0.0.3', '^0.0.3', true],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.0', '~1.2', true],
    ['1.3.0', '~1.2', false],
    ['1.5.0', '~1', true],
    ['2.0.0', '~1', false],
    ['1.4.0', '>=1.2.0 <2.0.0', true],
    ['2.0.0', '>=1.2.0 <2.0.0', false],
    ['1.1.0', '>=1.2.0 <2.0.0', false],
    ['1.2.0', '1.2.x', true],
    ['1.3.0', '1.2.x', false],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['3.0.0', '*', true],
    ['1.0.0', '^1.0.0 || ^2.0.0', true],
    ['2.5.0', '^1.0.0 || ^2.0.0', true],
    ['3.0.0', '^1.0.0 || ^2.0.0', false],
    // fail closed: an unreadable version or range is not satisfied
    ['not.a.version', '^1.0.0', false],
    ['1.0.0', 'garbage!!', false],
  ];
  for (const [version, range, expected] of cases) {
    assert.equal(satisfies(version, range), expected, `satisfies("${version}", "${range}") should be ${expected}`);
  }
});

test('G02: isValidRange accepts real ranges and rejects garbage (fail-closed manifest gate)', () => {
  for (const good of ['1.2.3', '^1.0.0', '~1.2', '>=1.0.0 <2.0.0', '1.x', '*', '^1.0.0 || ^2.0.0']) {
    assert.equal(isValidRange(good), true, `${good} should be a valid range`);
  }
  for (const bad of ['garbage!!', '^^1', '>=x.y', 'not a version', '', 1, null, undefined]) {
    assert.equal(isValidRange(bad), false, `${JSON.stringify(bad)} should be an invalid range`);
  }
});
