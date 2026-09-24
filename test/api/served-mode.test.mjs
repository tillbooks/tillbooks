/**
 * M01, the served-mode trust boundary as a pure unit: config resolution FAILS CLOSED, and the header
 * is read ONLY in served mode.
 *
 * These two functions are the whole of the trust boundary on TILL's side (D105). `resolveServedMode`
 * decides whether the header is trusted at all, and it must never read an unrecognised mode value as
 * "off"; `extractSubject` is the one place a client-supplied header is (or, in local mode, is NOT)
 * consulted. A spoofed header on a laptop must reach nothing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveServedMode,
  extractSubject,
  DEFAULT_SUBJECT_HEADER,
  IDENTITY_SOURCES,
} from '../../dist/api/served-mode.js';

test('resolveServedMode: unset or blank TILL_SERVED_MODE is local mode (the header is inert)', () => {
  for (const env of [{}, { TILL_SERVED_MODE: '' }, { TILL_SERVED_MODE: '   ' }]) {
    const config = resolveServedMode(env);
    assert.equal(config.enabled, false);
    assert.equal(config.headerName, DEFAULT_SUBJECT_HEADER);
  }
});

test('resolveServedMode: TILL_SERVED_MODE=proxy turns served mode on with the default header', () => {
  const config = resolveServedMode({ TILL_SERVED_MODE: 'proxy' });
  assert.equal(config.enabled, true);
  assert.equal(config.headerName, DEFAULT_SUBJECT_HEADER);
});

test('resolveServedMode: a custom header name is trimmed and lowercased (HTTP is case-insensitive)', () => {
  const config = resolveServedMode({ TILL_SERVED_MODE: 'proxy', TILL_SUBJECT_HEADER: '  X-Forwarded-Subject  ' });
  assert.equal(config.enabled, true);
  assert.equal(config.headerName, 'x-forwarded-subject');
});

test('resolveServedMode: FAILS CLOSED on an unrecognised mode, never silently local', () => {
  // The whole point: a typo like `Proxy` or a stray `on` must not drop to local mode, which would
  // leave a deployment believing it authenticates when it does not.
  for (const mode of ['Proxy', 'on', 'true', '1', 'oidc']) {
    assert.throws(() => resolveServedMode({ TILL_SERVED_MODE: mode }), /served-mode configuration is invalid/);
  }
});

test('resolveServedMode: FAILS CLOSED on a blank or malformed header name', () => {
  // A server that reads its subject from "" reads it from nowhere; a header name with a space is not a
  // valid HTTP token. Both refuse to start rather than quietly reading nothing forever.
  assert.throws(() => resolveServedMode({ TILL_SERVED_MODE: 'proxy', TILL_SUBJECT_HEADER: '   ' }), /invalid/);
  assert.throws(() => resolveServedMode({ TILL_SERVED_MODE: 'proxy', TILL_SUBJECT_HEADER: 'bad header' }), /invalid/);
});

test('extractSubject: LOCAL MODE never reads the header (the trust boundary)', () => {
  // A spoofed header on a loopback dev server must grant nothing: extractSubject returns null even
  // when the header is present, because in local mode no proxy has vouched for anyone.
  const local = resolveServedMode({});
  const headers = { [DEFAULT_SUBJECT_HEADER]: 'attacker@evil.example' };
  assert.equal(extractSubject(headers, local), null);
});

test('extractSubject: served mode reads exactly the configured header, trimmed', () => {
  const served = resolveServedMode({ TILL_SERVED_MODE: 'proxy' });
  assert.equal(extractSubject({ [DEFAULT_SUBJECT_HEADER]: '  bob@treuhand.ch  ' }, served), 'bob@treuhand.ch');
  assert.equal(extractSubject({}, served), null);
  assert.equal(extractSubject({ [DEFAULT_SUBJECT_HEADER]: '   ' }, served), null);
});

test('extractSubject: a repeated or comma-joined header is not a single attested subject', () => {
  const served = resolveServedMode({ TILL_SERVED_MODE: 'proxy' });
  // Node hands a repeated header as an array; a folded one arrives comma-joined. Neither is one value
  // the proxy attested, so both read as absent rather than being parsed into a guess.
  assert.equal(extractSubject({ [DEFAULT_SUBJECT_HEADER]: ['a@x', 'b@x'] }, served), null);
  assert.equal(extractSubject({ [DEFAULT_SUBJECT_HEADER]: 'a@x, b@x' }, served), null);
});

test('IDENTITY_SOURCES is the closed H-ENUM vocabulary', () => {
  assert.deepEqual([...IDENTITY_SOURCES], ['local_client', 'served_subject']);
});
