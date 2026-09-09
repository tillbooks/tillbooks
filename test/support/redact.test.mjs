/**
 * G08 §7/§8, the redaction property test.
 *
 * This is the test the whole spec rests on: "no free text is ever captured automatically". It is
 * written first, and it carries its own negative case, because a capture test that has never been
 * seen to fail is decoration rather than evidence (the E07 deliberate-offender discipline).
 *
 * The fixture leak is deliberate and specific. A real exception raised inside a posting path can
 * carry an amount, a counterparty name and the OS username all at once, so the fixture carries all
 * three and the assertions name each of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  redactEntry,
  DEFECT_SHAPED_CODES,
  DIAGNOSTIC_ENTRY_KINDS,
  REDACTABLE_DETAIL_KEYS,
} from '../../dist/core/support/redact.js';

const INSTALL_ROOT = '/opt/till';
const AT = '2026-07-25T10:00:00.000Z';

/** An error whose message and stack both carry data that must never reach a report. */
function leakyError() {
  const e = new Error('Beratung Müller AG 1234.55 CH93 0076 2011 6238 5295 7');
  e.stack = [
    'Error: Beratung Müller AG 1234.55 CH93 0076 2011 6238 5295 7',
    '    at postEntry (/opt/till/dist/core/ledger/postEntry.js:118:11)',
    '    at /Users/testuser/tillbooks/node_modules/better-sqlite3/lib/methods/wrappers.js:5:21',
    '    at Object.run (/opt/till/dist/api/registry.js:172:9)',
  ].join('\n');
  return e;
}

const SECRETS = ['Müller', 'Beratung', '1234.55', 'CH93', 'testuser'];

function assertNoSecrets(entry, label) {
  const serialised = JSON.stringify(entry);
  for (const secret of SECRETS) {
    assert.ok(
      !serialised.includes(secret),
      `${label}: redacted entry leaked ${JSON.stringify(secret)} in ${serialised}`,
    );
  }
}

test('redactEntry drops the exception message entirely, including from the stack head', () => {
  const entry = redactEntry(
    { kind: 'verb_error', at: AT, code: 'unexpected_error', action: 'post_entry', error: leakyError() },
    { installRoot: INSTALL_ROOT },
  );
  assertNoSecrets(entry, 'message');
  assert.equal(entry.code, 'unexpected_error');
  assert.equal(entry.action, 'post_entry');
  assert.equal(entry.name, 'Error');
});

test('frames keep our own file, line and function but never an absolute path', () => {
  const entry = redactEntry(
    { kind: 'verb_error', at: AT, code: 'unexpected_error', error: leakyError() },
    { installRoot: INSTALL_ROOT },
  );
  assert.ok(
    entry.frames.some((f) => f.includes('dist/core/ledger/postEntry.js:118:11') && f.includes('postEntry')),
    `expected an install-relative frame, got ${JSON.stringify(entry.frames)}`,
  );
  for (const frame of entry.frames) {
    assert.ok(!frame.startsWith('/'), `frame is absolute: ${frame}`);
    assert.ok(!frame.includes('/Users/'), `frame carries a home directory: ${frame}`);
  }
});

test('a frame outside the install root collapses to <external> rather than naming the user', () => {
  const entry = redactEntry(
    { kind: 'verb_error', at: AT, error: leakyError() },
    { installRoot: INSTALL_ROOT },
  );
  assert.ok(entry.frames.includes('<external>'), `expected <external>, got ${JSON.stringify(entry.frames)}`);
});

test('detail KEY names survive only when allow-listed; every value is dropped', () => {
  const entry = redactEntry(
    {
      kind: 'verb_error',
      at: AT,
      code: 'invalid_input',
      detail: {
        field: 'lines[0].description',
        reason: 'Beratung Müller AG',
        'Kunde Müller': 'CH93 0076 2011 6238 5295 7',
      },
    },
    { installRoot: INSTALL_ROOT },
  );
  assertNoSecrets(entry, 'detail values');
  assert.ok(entry.detailKeys.includes('field'), 'allow-listed key "field" should survive');
  assert.ok(entry.detailKeys.includes('reason'), 'allow-listed key "reason" should survive');
  assert.ok(
    entry.detailKeys.includes('<custom>'),
    'a user-authored key must collapse to <custom>, never appear verbatim',
  );
  assert.ok(!entry.detailKeys.includes('Kunde Müller'), 'a user-authored key name leaked');
});

test('an OP7 custom field named after a client never reaches the journal', () => {
  // The rule that matters once G00 ships: denying VALUES is not enough, because a custom field's
  // KEY is user-authored too, and a Swiss user will name one after a client.
  const entry = redactEntry(
    { kind: 'verb_error', at: AT, code: 'invalid_input', detail: { 'Müller Treuhand AG': 1 } },
    { installRoot: INSTALL_ROOT },
  );
  assertNoSecrets(entry, 'custom field key');
  assert.deepEqual(entry.detailKeys, ['<custom>']);
});

test('surface stores a route pattern, and an entity id in a concrete path is masked', () => {
  const entry = redactEntry(
    { kind: 'verb_error', at: AT, surface: '/documents/doc_01H8XK4M2N9PQR/edit' },
    { installRoot: INSTALL_ROOT },
  );
  assert.equal(entry.surface, '/documents/:id/edit');
  assert.ok(!entry.surface.includes('doc_01H8XK4M2N9PQR'), 'an entity id reached the journal');
});

test('a non-Error throw records <non-error> rather than undefined', () => {
  const entry = redactEntry(
    { kind: 'unhandled_exception', at: AT, error: 'Beratung Müller AG 1234.55' },
    { installRoot: INSTALL_ROOT },
  );
  assertNoSecrets(entry, 'non-error throw');
  assert.equal(entry.name, '<non-error>');
  assert.deepEqual(entry.frames, []);
});

test('fuzz: no detail value and no message substring ever survives, across shapes', () => {
  const values = [
    'Müller',
    1234.55,
    ['Beratung', 'Müller'],
    { nested: 'CH93 0076 2011 6238 5295 7' },
    null,
    undefined,
  ];
  for (const key of [...REDACTABLE_DETAIL_KEYS, 'Kunde Müller', 'x']) {
    for (const value of values) {
      const entry = redactEntry(
        { kind: 'verb_error', at: AT, code: 'unexpected_error', detail: { [key]: value }, error: leakyError() },
        { installRoot: INSTALL_ROOT },
      );
      assertNoSecrets(entry, `fuzz key=${key} value=${JSON.stringify(value)}`);
    }
  }
});

test('the entry shape is exactly the declared field set, so nothing rides along unnoticed', () => {
  // Pairs with the disclosure-completeness test: a new field here must also be named in
  // `diagnostics.captured.list`, or the in-product Art. 19 disclosure silently understates.
  const entry = redactEntry(
    { kind: 'verb_error', at: AT, code: 'store_busy', action: 'post_entry', surface: '/journal', detail: { field: 1 }, error: leakyError() },
    { installRoot: INSTALL_ROOT },
  );
  assert.deepEqual(
    Object.keys(entry).sort(),
    ['action', 'at', 'code', 'detailKeys', 'frames', 'kind', 'name', 'surface'].sort(),
  );
});

test('THE NEGATIVE CASE: a redactor that passes the message through must fail these assertions', () => {
  // A trust test that cannot fail is decoration. This proves the assertions above have teeth, by
  // running them against a deliberately broken redactor and requiring that they reject it.
  const brokenRedactor = (raw) => ({
    at: raw.at,
    kind: raw.kind,
    name: raw.error?.name,
    code: raw.code,
    action: raw.action,
    surface: raw.surface,
    detailKeys: Object.keys(raw.detail ?? {}),
    frames: (raw.error?.stack ?? '').split('\n'),
  });
  assert.throws(
    () => assertNoSecrets(brokenRedactor({ kind: 'verb_error', at: AT, error: leakyError() }), 'broken'),
    /leaked/,
    'the leak assertions did not reject a redactor that passes the raw stack through',
  );
});

test('an error that crossed a JSON boundary keeps its frames instead of degrading to <non-error>', () => {
  // The Studio's crash path posts the caught throw as JSON, and JSON is never an instanceof Error.
  // Without this, a crash reported THROUGH the engine was a weaker report than the same crash
  // reported in-browser, which is exactly backwards.
  const serialised = { name: 'TypeError', message: 'Beratung Müller AG 1234.55', stack: leakyError().stack };
  const entry = redactEntry({ kind: 'unhandled_exception', at: AT, error: serialised }, { installRoot: INSTALL_ROOT });
  assertNoSecrets(entry, 'json error');
  assert.equal(entry.name, 'TypeError');
  assert.ok(entry.frames.some((f) => f.includes('dist/core/ledger/postEntry.js')), 'frames should survive JSON');
});

test('a caller cannot smuggle prose through the stack field', () => {
  // Accepting `stack` from a client is only safe because redactFrames reads nothing but `at` lines.
  const entry = redactEntry(
    { kind: 'transport_error', at: AT, error: { name: 'X', stack: 'Beratung Müller AG 1234.55\nnot a frame' } },
    { installRoot: INSTALL_ROOT },
  );
  assertNoSecrets(entry, 'smuggled stack');
  assert.deepEqual(entry.frames, []);
});

test('the enums are single-sourced and frozen', () => {
  assert.deepEqual([...DIAGNOSTIC_ENTRY_KINDS], ['verb_error', 'unhandled_exception', 'transport_error']);
  assert.deepEqual([...DEFECT_SHAPED_CODES], ['unexpected_error', 'store_busy', 'transport_error']);
  assert.ok(Object.isFrozen(DEFECT_SHAPED_CODES));
});
