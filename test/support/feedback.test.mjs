/**
 * G08 §8, the verb suite.
 *
 * Every test injects a temporary directory: none of them touches the real `~/.till/`, which the
 * injected-path design (§4) makes free rather than something to remember.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearDiagnostics,
  getDiagnostics,
  listFeedback,
  prepareFeedback,
  previewFeedback,
  recordDiagnostic,
  setDiagnostics,
  supportPaths,
  readConfig,
  JOURNAL_CAP,
  MAILTO_MAX,
} from '../../dist/core/support/index.js';

const AT = '2026-07-25T10:00:00.000Z';
const ENV = {
  version: '0.0.0',
  runtime: 'node v22.0.0',
  platform: 'darwin 25.5.0',
  locale: 'de-CH',
  client: 'studio',
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'till-g08-'));
  return {
    dir,
    deps: { paths: supportPaths(dir), now: () => AT, env: ENV, installRoot: '/opt/till' },
  };
}

const REPORT = { kind: 'bug', subject: 'Posting fails', message: 'It said store_busy twice.' };

function throwing() {
  const e = new Error('Beratung Müller AG 1234.55');
  e.stack = ['Error: Beratung Müller AG 1234.55', '    at postEntry (/opt/till/dist/core/x.js:1:1)'].join('\n');
  return e;
}

// --- consent, the boundary an agent cannot cross ------------------------------------------------

test('capture off plus includeDiagnostics returns diagnostics_not_enabled and writes nothing', () => {
  const { deps, dir } = setup();
  const result = prepareFeedback(deps, { ...REPORT, includeDiagnostics: true, idempotencyKey: 'k1' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'diagnostics_not_enabled');
  assert.ok(!existsSync(join(dir, 'feedback')), 'no artifact may be written on a refused call');
});

test('clientError is refused on the SAME condition, so it is not a second door through the opt-in', () => {
  const { deps } = setup();
  const withClientError = {
    ...REPORT,
    includeDiagnostics: true,
    clientError: { kind: 'unhandled_exception', error: throwing(), surface: '/journal' },
    idempotencyKey: 'k1',
  };
  const refused = prepareFeedback(deps, withClientError);
  assert.equal(refused.error, 'diagnostics_not_enabled');
});

test('includeDiagnostics false with a clientError succeeds and the report carries no frames', () => {
  const { deps } = setup();
  const result = prepareFeedback(deps, {
    ...REPORT,
    includeDiagnostics: false,
    clientError: { kind: 'unhandled_exception', error: throwing() },
    idempotencyKey: 'k1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnosticsIncluded, false);
  assert.ok(result.report.includes('No error details shared.'));
  assert.ok(!result.report.includes('dist/core/x.js'), 'frames travelled without consent');
  assert.ok(!result.report.includes('Müller'), 'the exception message reached the report');
});

test('with capture on, the crash detail travels and is still redacted', () => {
  const { deps } = setup();
  setDiagnostics(deps, { capture: true });
  const result = prepareFeedback(deps, {
    ...REPORT,
    includeDiagnostics: true,
    clientError: { kind: 'unhandled_exception', error: throwing(), surface: '/documents/doc_01H8XK4M2N' },
    idempotencyKey: 'k1',
  });
  assert.equal(result.ok, true);
  assert.equal(result.diagnosticsIncluded, true);
  assert.ok(result.report.includes('dist/core/x.js:1:1'), 'the frame should travel');
  assert.ok(!result.report.includes('Müller'), 'the message leaked into a shared report');
  assert.ok(result.report.includes('/documents/:id'), 'the route should be masked to a pattern');
});

// --- idempotency without a key store -------------------------------------------------------------

test('the same idempotency key yields one feedbackId and exactly one file', () => {
  const { deps, dir } = setup();
  const first = prepareFeedback(deps, { ...REPORT, idempotencyKey: 'same-key' });
  const second = prepareFeedback(deps, { ...REPORT, idempotencyKey: 'same-key' });
  assert.equal(first.feedbackId, second.feedbackId);
  assert.equal(readdirSync(join(dir, 'feedback')).length, 1);
  assert.equal(first.report, second.report, 'a repeat must return the ORIGINAL, not a re-render');
});

test('a different key yields a different file', () => {
  const { deps, dir } = setup();
  prepareFeedback(deps, { ...REPORT, idempotencyKey: 'a' });
  prepareFeedback(deps, { ...REPORT, idempotencyKey: 'b' });
  assert.equal(readdirSync(join(dir, 'feedback')).length, 2);
});

test('a repeat returns the original even when the inputs changed underneath it', () => {
  const { deps } = setup();
  const first = prepareFeedback(deps, { ...REPORT, idempotencyKey: 'k' });
  const second = prepareFeedback(deps, { ...REPORT, message: 'Completely different text', idempotencyKey: 'k' });
  assert.equal(second.report, first.report);
  assert.ok(!second.report.includes('Completely different text'));
});

// --- validation ----------------------------------------------------------------------------------

test('an empty message, an over-long message and a missing key each name their field', () => {
  const { deps } = setup();
  assert.equal(prepareFeedback(deps, { ...REPORT, message: '', idempotencyKey: 'k' }).field, 'message');
  assert.equal(prepareFeedback(deps, { ...REPORT, message: 'x'.repeat(4001), idempotencyKey: 'k' }).field, 'message');
  assert.equal(prepareFeedback(deps, { ...REPORT, subject: '', idempotencyKey: 'k' }).field, 'subject');
  assert.equal(prepareFeedback(deps, { ...REPORT }).field, 'idempotencyKey');
  assert.equal(prepareFeedback(deps, { ...REPORT, kind: 'rant', idempotencyKey: 'k' }).field, 'kind');
});

// --- the config file ------------------------------------------------------------------------------

test('a read-only support dir returns config_not_writable and capture STAYS OFF', () => {
  const { deps, dir } = setup();
  chmodSync(dir, 0o500);
  try {
    const result = setDiagnostics(deps, { capture: true });
    assert.equal(result.error, 'config_not_writable');
    assert.equal(getDiagnostics(deps).capture, false, 'the failure mode of a privacy switch must be OFF');
  } finally {
    chmodSync(dir, 0o700);
  }
});

test('a corrupt config reads as defaults and the file is left byte-identical', () => {
  const { deps, dir } = setup();
  const path = join(dir, 'config.json');
  writeFileSync(path, '{{{not json', 'utf8');
  const before = readFileSync(path, 'utf8');
  const read = getDiagnostics(deps);
  assert.equal(read.capture, false);
  assert.equal(read.configReadable, false);
  assert.equal(readFileSync(path, 'utf8'), before, 'an unreadable config must not be rewritten');
});

test('keys written by a newer TILL survive our write', () => {
  const { deps, dir } = setup();
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ futureThing: 1, theme: 'x' }), 'utf8');
  setDiagnostics(deps, { capture: true });
  const after = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
  assert.equal(after.futureThing, 1);
  assert.equal(after.theme, 'x');
  assert.equal(after.diagnostics.capture, true);
});

test('set_diagnostics is naturally idempotent, which H-IDEMPOTENT requires be TESTED not asserted', () => {
  const { deps, dir } = setup();
  setDiagnostics(deps, { capture: true });
  const once = readFileSync(join(dir, 'config.json'), 'utf8');
  setDiagnostics(deps, { capture: true });
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), once);
});

// --- the journal -----------------------------------------------------------------------------------

test('nothing is recorded while capture is off, and the file is never created', () => {
  const { deps, dir } = setup();
  recordDiagnostic(deps, { kind: 'verb_error', at: AT, code: 'unexpected_error', error: throwing() });
  assert.ok(!existsSync(join(dir, 'diagnostics.jsonl')));
  assert.deepEqual(getDiagnostics(deps).entries, []);
});

test('turning capture off DELETES the journal: off means gone, not dormant', () => {
  const { deps, dir } = setup();
  setDiagnostics(deps, { capture: true });
  recordDiagnostic(deps, { kind: 'verb_error', at: AT, code: 'store_busy' });
  assert.ok(existsSync(join(dir, 'diagnostics.jsonl')));
  setDiagnostics(deps, { capture: false });
  assert.ok(!existsSync(join(dir, 'diagnostics.jsonl')), 'switching off must erase, not merely ignore');
});

test('the journal caps at 20 and evicts oldest-first', () => {
  const { deps } = setup();
  setDiagnostics(deps, { capture: true });
  for (let i = 0; i < 100; i += 1) {
    recordDiagnostic(deps, { kind: 'verb_error', at: `2026-07-25T10:00:${String(i).padStart(2, '0')}.000Z`, code: 'store_busy', action: `act_${i}` });
  }
  const { entries } = getDiagnostics(deps);
  assert.equal(entries.length, JOURNAL_CAP);
  assert.equal(entries[entries.length - 1].action, 'act_99', 'the newest entry must survive');
  assert.equal(entries[0].action, 'act_80', 'the oldest must be evicted');
});

test('a torn line is skipped rather than making the whole journal unreadable', () => {
  const { deps, dir } = setup();
  setDiagnostics(deps, { capture: true });
  recordDiagnostic(deps, { kind: 'verb_error', at: AT, code: 'store_busy' });
  writeFileSync(join(dir, 'diagnostics.jsonl'), `{"partial":\n${JSON.stringify({ at: AT, kind: 'verb_error', code: 'unexpected_error', detailKeys: [], frames: [] })}\n`, 'utf8');
  const read = getDiagnostics(deps);
  assert.equal(read.ok, true);
  assert.equal(read.entries.length, 1);
});

test('clear empties the journal and LEAVES written reports alone', () => {
  const { deps, dir } = setup();
  setDiagnostics(deps, { capture: true });
  recordDiagnostic(deps, { kind: 'verb_error', at: AT, code: 'store_busy' });
  prepareFeedback(deps, { ...REPORT, idempotencyKey: 'k' });
  assert.equal(clearDiagnostics(deps).ok, true);
  assert.deepEqual(getDiagnostics(deps).entries, []);
  assert.equal(readdirSync(join(dir, 'feedback')).length, 1, 'erasure must not take reports the user chose to keep');
  assert.equal(clearDiagnostics(deps).ok, true, 'clear is naturally idempotent');
});

test('two distinct empty states: capture off versus capture on with nothing recorded', () => {
  const { deps } = setup();
  const off = getDiagnostics(deps);
  assert.equal(off.capture, false);
  setDiagnostics(deps, { capture: true });
  const on = getDiagnostics(deps);
  assert.equal(on.capture, true);
  assert.deepEqual(on.entries, []);
  // The panel branches on `capture`, so the two facts stay distinguishable to the GUI.
  assert.notEqual(off.capture, on.capture);
});

// --- the mailto budget --------------------------------------------------------------------------

test('a 5000-character de-CH message yields a URI under the budget and truncated:true', () => {
  const { deps } = setup();
  const message = 'Grüezi, die Rückmeldung über die Buchhaltung. '.repeat(120).slice(0, 5000);
  const result = previewFeedback(deps, { ...REPORT, message: message.slice(0, 4000) });
  assert.equal(result.ok, true);
  assert.ok(result.mailto.length <= MAILTO_MAX, `mailto was ${result.mailto.length}, budget ${MAILTO_MAX}`);
  assert.equal(result.truncated, true);
  assert.ok(result.report.includes(message.slice(0, 200)), 'the artifact must carry the full text');
});

test('a short message is not truncated and the URI names the fixed recipient', () => {
  const { deps } = setup();
  const result = previewFeedback(deps, REPORT);
  assert.equal(result.truncated, false);
  assert.ok(result.mailto.startsWith('mailto:hello@tillbooks.ch?'));
});

test('preview writes nothing at all', () => {
  const { deps, dir } = setup();
  previewFeedback(deps, REPORT);
  assert.deepEqual(readdirSync(dir), []);
});

// --- the log IS the directory ---------------------------------------------------------------------

test('list reports what is on disk, newest first, always in state prepared and never sent', () => {
  const { deps } = setup();
  assert.deepEqual(listFeedback(deps).reports, [], 'an absent directory is an empty log, not an error');
  prepareFeedback(deps, { ...REPORT, subject: 'First', idempotencyKey: 'a' });
  prepareFeedback(deps, { ...REPORT, subject: 'Second', idempotencyKey: 'b' });
  const { reports } = listFeedback(deps);
  assert.equal(reports.length, 2);
  for (const row of reports) {
    assert.equal(row.state, 'prepared');
    assert.notEqual(row.state, 'sent');
  }
  assert.deepEqual(reports.map((r) => r.subject).sort(), ['First', 'Second']);
});

test('a log row carries the enum member, not the English display title', () => {
  // Found by running the Studio, not by mocking it: the log is the directory, so the row is parsed
  // back out of the artifact markdown. Returning the rendered title put an English sentence in the
  // middle of a German table. The row carries the member; display belongs to whoever displays.
  const { deps } = setup();
  prepareFeedback(deps, { ...REPORT, kind: 'bug', idempotencyKey: 'a' });
  prepareFeedback(deps, { ...REPORT, kind: 'question', idempotencyKey: 'b' });
  const kinds = listFeedback(deps).reports.map((r) => r.kind).sort();
  assert.deepEqual(kinds, ['bug', 'question']);
});

test('deleting a file deletes the row, because there is no second record to go stale', () => {
  const { deps, dir } = setup();
  const created = prepareFeedback(deps, { ...REPORT, idempotencyKey: 'a' });
  assert.equal(listFeedback(deps).reports.length, 1);
  rmSync(created.path);
  assert.equal(listFeedback(deps).reports.length, 0);
});

// --- the structural guards ------------------------------------------------------------------------

test('the report renderer imports nothing from node, so the browser crash path can use it', () => {
  // If this fails, the ErrorBoundary's client-side path silently breaks: it is the ONE path that
  // must work when the engine is unreachable, which is exactly when it cannot be tested by hand.
  const source = readFileSync(new URL('../../src/core/support/report.ts', import.meta.url), 'utf8');
  assert.ok(!/from 'node:/.test(source), 'report.ts must stay free of node: imports');
});

test('no HTTP client is imported anywhere under src/core/support', () => {
  // The likeliest place in the repo for a future contributor to add one "just to post the report".
  const dir = new URL('../../src/core/support/', import.meta.url);
  for (const name of readdirSync(dir)) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    assert.ok(!/\bfetch\s*\(|node:https?|undici|axios|XMLHttpRequest|WebSocket/.test(source), `${name} reaches the network`);
  }
});

test('the support module has no money column and never imports a posting path', () => {
  const dir = new URL('../../src/core/support/', import.meta.url);
  for (const name of readdirSync(dir)) {
    const source = readFileSync(new URL(name, dir), 'utf8');
    assert.ok(!/_rappen|postEntry|recordPayment/.test(source), `${name} touches the money path`);
  }
});

test('the config default is OFF, which is the privacy-by-default posture in one assertion', () => {
  const { deps } = setup();
  assert.equal(readConfig(deps.paths).capture, false);
});
