// @ts-check
// Every registered attention queue is named in words in BOTH Studio locales, never as a raw key.
//
// The hub builds `attention.queueLabel.<queueId>` from runtime data (a single-queue heading, a failed
// provider line, the "auch in ..." collapse note), and the payload carries each provider's own
// `labelKey` as the fallback. A queue registered in the engine with neither translated renders as a dot
// path on screen: `attention.queueLabel.bank_keys_review` did, until this guard. So the guard reads the
// REGISTRY, not a hand list, and walks the SAME merge the Studio does (the shell catalogue, then every
// surface fragment in sorted path order).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATTENTION_PROVIDERS } from '../../dist/core/attention/index.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'src');
const LOCALES = /** @type {const} */ (['de-CH', 'en']);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** @param {Record<string, unknown>} base @param {Record<string, unknown>} extra @returns {Record<string, unknown>} */
function deepMerge(base, extra) {
  /** @type {Record<string, unknown>} */
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const existing = out[key];
    out[key] = isObject(existing) && isObject(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

/** @param {string} dir @param {string} name @returns {string[]} */
function findFiles(dir, name) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...findFiles(full, name));
    else if (entry === name) out.push(full);
  }
  return out;
}

/** @param {string} locale @returns {Record<string, unknown>} */
function catalogue(locale) {
  let acc = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(join(APP, 'i18n', `${locale}.json`), 'utf8')));
  for (const file of findFiles(join(APP, 'surfaces'), `messages.${locale}.json`).sort()) {
    acc = deepMerge(acc, JSON.parse(readFileSync(file, 'utf8')));
  }
  return acc;
}

/** @param {Record<string, unknown> | undefined} tree @param {string} key @returns {string | undefined} */
function resolve(tree, key) {
  /** @type {unknown} */
  let node = tree;
  for (const part of key.split('.')) {
    if (!isObject(node)) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)]));

test('the probe reads the registry and the real catalogues (it would see a known label)', () => {
  assert.ok(ATTENTION_PROVIDERS.length >= 7, 'the registry is populated');
  assert.equal(resolve(CATALOGUES['de-CH'], 'attention.queueLabel.qr_match'), 'Abgleich');
  assert.equal(resolve(CATALOGUES['de-CH'], 'attention.queueLabel.no_such_queue'), undefined);
});

test('every registered queueId has an attention.queueLabel entry in both locales', () => {
  for (const locale of LOCALES) {
    for (const p of ATTENTION_PROVIDERS) {
      const label = resolve(CATALOGUES[locale], `attention.queueLabel.${p.queueId}`);
      assert.ok(typeof label === 'string' && label.trim() !== '', `${locale}: attention.queueLabel.${p.queueId} is missing`);
    }
  }
});

test("every provider's own labelKey (the Studio fallback) resolves in both locales", () => {
  for (const locale of LOCALES) {
    for (const p of ATTENTION_PROVIDERS) {
      const label = resolve(CATALOGUES[locale], p.labelKey);
      assert.ok(typeof label === 'string' && label.trim() !== '', `${locale}: ${p.labelKey} (${p.queueId}) is missing`);
    }
  }
});

test('the bank_activation rows are worded in both locales, with the params the engine sends', () => {
  const keys = [
    ['attention.item.bankActivation.sendLegs.title', ['bank']],
    ['attention.item.bankActivation.sendLegs.subtitle', []],
    ['attention.item.bankActivation.resendLegs.title', ['bank']],
    ['attention.item.bankActivation.resendLegs.subtitle', ['bank']],
    ['attention.item.bankActivation.signLetter.title', ['bank']],
    ['attention.item.bankActivation.signLetter.subtitle', ['bank', 'lastCheckAt']],
    ['attention.item.bankActivation.signLetter.subtitleNoCheck', ['bank']],
    ['attention.act.openBankAccounts', []],
  ];
  for (const locale of LOCALES) {
    for (const [key, params] of keys) {
      const text = resolve(CATALOGUES[locale], /** @type {string} */ (key));
      assert.ok(typeof text === 'string' && text !== '', `${locale}: ${key} is missing`);
      for (const param of /** @type {string[]} */ (params)) {
        assert.ok(text.includes(`{${param}}`), `${locale}: ${key} carries {${param}}`);
      }
    }
  }
  // de-CH speaks to the person with "du" (D56), and the owner's own words lead the letter step.
  assert.match(resolve(CATALOGUES['de-CH'], 'attention.item.bankActivation.signLetter.title') ?? '', /^Unterschreibe den INI-Brief/);
});
