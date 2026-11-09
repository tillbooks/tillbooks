/**
 * Every word the G22 attention provider asks the Studio to say EXISTS in both catalogues (beta
 * launch P0.4b).
 *
 * THE DEFECT. A company's first Pendenzen showed the raw key `attention.queueLabel.checklist_items_due`
 * (the Attention surface builds that key from the queue id, and no catalogue carried it), and each
 * row read "zuständig: human", the owner enum interpolated verbatim. Neither was visible to any
 * suite: the engine names keys, the Studio owns the words, and nothing held the two together.
 *
 * This suite reads the Studio's catalogues the way `app/src/i18n/index.tsx` builds them (the base
 * file deep-merged with every `surfaces/<Surface>/messages.<locale>.json`) and resolves every key the
 * provider can emit, for every owner kind, in de-CH AND en. It also proves the engine no longer sends
 * the raw owner kind as a parameter a sentence could interpolate.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.NODE_ENV = 'test';

const { getAction } = await import('../../dist/api/registry.js');
const { checklistItemsDueProvider, CHECKLIST_SUBTITLE_KEY_BY_OWNER } = await import('../../dist/core/checklists/attentionProvider.js');
const { freshDeps, mintWorkspace } = await import('../api/support.mjs');

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALES = ['de-CH', 'en'];

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(cur, v) : v;
  }
  return out;
}

/** The merged catalogue for a locale, exactly as the Studio assembles it at build time. */
function catalogue(locale) {
  let merged = JSON.parse(readFileSync(join(repoRoot, 'app', 'src', 'i18n', `${locale}.json`), 'utf8'));
  const surfaces = join(repoRoot, 'app', 'src', 'surfaces');
  for (const dir of readdirSync(surfaces).sort()) {
    const file = join(surfaces, dir, `messages.${locale}.json`);
    if (existsSync(file)) merged = deepMerge(merged, JSON.parse(readFileSync(file, 'utf8')));
  }
  return merged;
}

function lookup(messages, key) {
  let node = messages;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)]));

/** A workspace with an open month-close run whose items are due, so the provider emits real rows. */
function worldWithDueItems() {
  const deps = freshDeps();
  deps.actor = 'studio';
  let today = '2026-07-16T08:00:00.000Z';
  deps.clock = { now: () => today };
  const { workspaceId } = mintWorkspace(deps, 'Labels GmbH', 'labels-ws');
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  // A HAND start of July (the auto-start bound does not apply to a named period).
  today = '2026-08-03T08:00:00.000Z';
  const started = call('checklist_start', { templateId: 'month_close', period: '2026-07', idempotencyKey: 'labels-start' });
  assert.equal(started.ok, true, JSON.stringify(started));
  return { deps, workspaceId, call };
}

test('the queue label the Attention surface builds from the queue id exists, in words, in both locales', () => {
  const key = `attention.queueLabel.${checklistItemsDueProvider.queueId}`;
  assert.equal(key, 'attention.queueLabel.checklist_items_due');
  for (const locale of LOCALES) {
    const text = lookup(CATALOGUES[locale], key);
    assert.equal(typeof text, 'string', `${locale}: ${key} is missing`);
    assert.notEqual(text, key);
    assert.doesNotMatch(text, /_/, `${locale}: ${text} reads like an id, not a word`);
    assert.equal(typeof lookup(CATALOGUES[locale], checklistItemsDueProvider.labelKey), 'string', `${locale}: ${checklistItemsDueProvider.labelKey}`);
  }
});

test('every row key the provider emits resolves in both locales, and the owner is a word, never the enum', () => {
  const { call } = worldWithDueItems();
  const listed = call('attention_list', { queueId: 'checklist_items_due', limit: 50 });
  assert.equal(listed.ok, true, JSON.stringify(listed));
  const rows = listed.items;
  assert.ok(rows.length > 0, 'the fixture has due checklist items');
  const owners = new Set();
  for (const row of rows) {
    assert.equal('owner' in (row.subtitleParams ?? {}), false, 'the raw owner kind is no longer a parameter');
    for (const key of [row.titleKey, row.subtitleKey, ...row.decisionOptions.map((o) => o.labelKey)]) {
      for (const locale of LOCALES) {
        assert.equal(typeof lookup(CATALOGUES[locale], key), 'string', `${locale}: ${key} is missing`);
      }
    }
    owners.add(row.subtitleKey);
  }
  // Every owner kind's key (not only the ones this fixture happens to reach) says a word, not the enum.
  for (const [kind, key] of Object.entries(CHECKLIST_SUBTITLE_KEY_BY_OWNER)) {
    for (const locale of LOCALES) {
      const text = lookup(CATALOGUES[locale], key);
      assert.equal(typeof text, 'string', `${locale}: ${key}`);
      assert.match(text, /\{template\}/);
      assert.doesNotMatch(text, new RegExp(`: ${kind}$`), `${locale}: "${text}" ends on the enum ${kind}`);
    }
  }
  assert.equal(lookup(CATALOGUES['de-CH'], CHECKLIST_SUBTITLE_KEY_BY_OWNER.human), '{template}, zuständig: du');
  assert.ok(owners.size >= 1);
});
