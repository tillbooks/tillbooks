// @ts-check
/**
 * O00 (D199), WHAT'S NEW: the bundled notes file is valid, the running version has an entry, versions order
 * by SemVer precedence, and the install's seen marker decides what shows (the baseline, skipped versions,
 * the unreleased entry's fingerprint, the two settings).
 *
 * Every support folder here is a fresh temp directory; nothing reads or writes a real home.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUNDLED_NOTES,
  RELEASE_ICONS,
  bundledNotesProblems,
  compareVersions,
  entryFor,
  fingerprintOf,
  validateNotes,
} from '../../dist/core/releases/notes.js';
import { baselineFor, markSeen, readSeen, seedSeen, whatsNew, writeSeen } from '../../dist/core/releases/whatsNew.js';
import { TILL_PACKAGE_VERSION } from '../../dist/core/version.js';
import { getAction } from '../../dist/api/registry.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const ROOT = new URL('../../', import.meta.url);

function tmp() {
  return mkdtempSync(join(tmpdir(), 'till-whatsnew-'));
}

/**
 * A synthetic notes list: the unreleased entry and three versions, newest first.
 * @returns {import('../../dist/core/releases/notes.js').ReleaseNote[]}
 */
function sample() {
  /** @param {string} t @returns {import('../../dist/core/releases/notes.js').NoteItem} */
  const item = (t) => ({ kind: 'new', icon: 'sparkle', title: { en: t, 'de-CH': t }, body: { en: `${t} works.`, 'de-CH': `${t} geht.` } });
  return [
    { version: 'unreleased', items: [item('Dev one'), item('Dev two')] },
    { version: '1.0.0-beta.10', date: '2026-11-20', items: [item('Ten a'), item('Ten b')] },
    { version: '1.0.0-beta.9', date: '2026-11-19', items: [item('Nine a'), item('Nine b')] },
    { version: '1.0.0-beta.2', date: '2026-10-01', items: [item('Two a'), item('Two b')] },
  ];
}

test('the bundled notes file is valid and names the running version', () => {
  assert.deepEqual(bundledNotesProblems(), []);
  assert.ok(entryFor(TILL_PACKAGE_VERSION) !== null, `whats-new.json has no entry for the running version ${TILL_PACKAGE_VERSION}`);
});

test('the package version in package.json has an entry (release.mjs bump refuses one without)', () => {
  const pkg = JSON.parse(readFileSync(new URL('package.json', ROOT), 'utf8'));
  assert.ok(BUNDLED_NOTES.some((r) => r.version === pkg.version), `no entry for ${pkg.version}`);
});

test('versions order by SemVer precedence, pre-releases included, unreleased newest', () => {
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.99'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-beta', '1.0.0-beta.1'), -1);
  assert.equal(compareVersions('unreleased', '9.9.9'), 1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.5', '1.0.0-beta.5'), 0);
});

test('validation names every problem: dashes, the sharp s, length, order, kinds and icons', () => {
  const bad = {
    releases: [
      { version: '1.0.0-beta.1', date: '2026-01-01', items: [
        { kind: 'new', icon: 'sparkle', title: { en: 'A \u2014 B', 'de-CH': 'Grösse' }, body: { en: 'Fine.', 'de-CH': 'Stra\u00dfe.' } },
        { kind: 'odd', icon: 'nope', title: { en: 'Ends.', 'de-CH': 'x' }, body: { en: 'Two. Sentences.', 'de-CH': 'Kein Punkt' } },
      ] },
      { version: '1.0.0-beta.2', date: '2026-01-02', items: [] },
    ],
  };
  const problems = validateNotes(bad).join('\n');
  assert.match(problems, /em or en dash/);
  assert.match(problems, /sharp s/);
  assert.match(problems, /"kind" must be one of/);
  assert.match(problems, /"icon" "nope" is not in RELEASE_ICONS/);
  assert.match(problems, /ends with a period/);
  assert.match(problems, /more than one sentence/);
  assert.match(problems, /does not end with a period/);
  assert.match(problems, /not newest first/);
  assert.match(problems, /needs 2 to 4 "items"/);
  assert.deepEqual(validateNotes({ releases: [{ version: 'unreleased', items: sample()[0]?.items }, ...sample().slice(1)] }), []);
});

test('the baseline: a fresh book sees nothing, an existing install sees the running version once', () => {
  const notes = sample();
  const fresh = baselineFor('1.0.0-beta.10', notes, false);
  assert.equal(fresh.seen, '1.0.0-beta.10');
  assert.equal(fresh.unreleased, fingerprintOf(/** @type {any} */ (notes[0])));
  const existing = baselineFor('1.0.0-beta.10', notes, true);
  assert.equal(existing.seen, '1.0.0-beta.9');
  assert.equal(existing.unreleased, null);
});

test('skipped versions show newest first, only up to the running build, capped by max', () => {
  const dir = tmp();
  try {
    const notes = sample().slice(1); // a released build: no unreleased entry
    writeSeen(dir, { seen: '1.0.0-beta.2', unreleased: null });
    const answer = whatsNew({ running: '1.0.0-beta.10', supportDir: dir, existingInstall: () => true, max: 10, notes });
    assert.deepEqual(answer.unseen.map((e) => e.version), ['1.0.0-beta.10', '1.0.0-beta.9']);
    const capped = whatsNew({ running: '1.0.0-beta.9', supportDir: dir, existingInstall: () => true, max: 1, notes });
    assert.deepEqual(capped.unseen.map((e) => e.version), ['1.0.0-beta.9']);
    assert.deepEqual(capped.recent.map((e) => e.version), ['1.0.0-beta.9']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('marking seen hides the notes; a changed unreleased entry shows again', () => {
  const dir = tmp();
  try {
    const notes = sample();
    markSeen({ running: '1.0.0-beta.10', supportDir: dir, notes });
    assert.deepEqual(whatsNew({ running: '1.0.0-beta.10', supportDir: dir, existingInstall: () => true, max: 10, notes }).unseen, []);
    const grown = [{ ...notes[0], items: [...(notes[0]?.items ?? []), notes[0]?.items[0]] }, ...notes.slice(1)];
    const again = whatsNew({ running: '1.0.0-beta.10', supportDir: dir, existingInstall: () => true, max: 10, notes: /** @type {any} */ (grown) });
    assert.deepEqual(again.unseen.map((e) => e.version), ['unreleased']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the boot seed writes the baseline once and never overwrites a marker', () => {
  const dir = tmp();
  try {
    assert.equal(seedSeen(dir, '1.0.0-beta.10', true, sample())?.seen, '1.0.0-beta.9');
    assert.equal(seedSeen(dir, '1.0.0-beta.10', false, sample()), null);
    assert.equal(readSeen(dir)?.seen, '1.0.0-beta.9');
    assert.equal(seedSeen(undefined, '1.0.0-beta.10', true, sample()), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the verbs: whats_new answers the settings and the locale, mark_seen writes the marker', () => {
  const dir = tmp();
  try {
    const deps = /** @type {any} */ (freshDeps());
    deps.supportDir = dir;
    deps.actor = 'studio';
    const { workspaceId } = mintWorkspace(deps);
    const read = getAction('whats_new');
    const mark = getAction('whats_new_mark_seen');
    assert.ok(read !== undefined && mark !== undefined);
    // An empty book: a new user, nothing to show (the virtual baseline is the running version).
    const first = /** @type {any} */ (read.run(deps, { workspaceId, locale: 'de-CH' }));
    assert.equal(first.ok, true);
    assert.equal(first.version, TILL_PACKAGE_VERSION);
    assert.equal(first.toast, true);
    assert.ok(first.recent.length >= 1);
    assert.equal(typeof first.recent[0].items[0].title, 'string');
    assert.match(first.releasesUrl, /\/de\/changelog\/$/);
    // An existing install that skipped versions sees the running version's notes.
    writeSeen(dir, { seen: '0.0.0', unreleased: null });
    const unseen = /** @type {any} */ (read.run(deps, { workspaceId }));
    assert.ok(unseen.unseen.some((/** @type {any} */ e) => e.version === TILL_PACKAGE_VERSION));
    assert.equal(typeof unseen.unseen[0].items[0].title, 'object', 'no locale: both languages');
    // The two settings.
    getAction('settings_set')?.run(deps, { workspaceId, key: 'releases.whats_new_toast', value: false, reason: 'Test', idempotencyKey: 'wn-toast' });
    getAction('settings_set')?.run(deps, { workspaceId, key: 'releases.whats_new_versions', value: 1, reason: 'Test', idempotencyKey: 'wn-max' });
    const capped = /** @type {any} */ (read.run(deps, { workspaceId }));
    assert.equal(capped.toast, false);
    assert.equal(capped.unseen.length, 1);
    // Mark seen: nothing left; a wrong version is refused.
    assert.equal(/** @type {any} */ (mark.run(deps, { workspaceId, version: '0.0.1' })).error, 'invalid_input');
    assert.equal(/** @type {any} */ (mark.run(deps, { workspaceId })).ok, true);
    assert.deepEqual(/** @type {any} */ (read.run(deps, { workspaceId })).unseen, []);
    // No support folder: nothing persisted, never a write somewhere else.
    delete deps.supportDir;
    assert.equal(/** @type {any} */ (mark.run(deps, { workspaceId })).persisted, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the Studio draws every release icon', () => {
  const studio = readFileSync(new URL('app/src/components/icons/releases.tsx', ROOT), 'utf8');
  for (const icon of RELEASE_ICONS) assert.match(studio, new RegExp(`\\b${icon}:`), `releases.tsx has no glyph for ${icon}`);
});
