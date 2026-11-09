/**
 * G17's corpus gates (spec §9, design §12): the offline CI rules that keep authored statutory copy
 * true. Each rule below is one the design derived from a real failure mode, not a style preference:
 *
 *  - NO DIGITS in any body: 5'005'000 became 5'024'000 on 1.1.2024, and a typed figure cannot be
 *    corrected by changing a constant. Amounts arrive as interpolation tokens.
 *  - NO REFERRING CONSTRUCTION and no URL: a body that ends by pointing somewhere has not answered,
 *    and offline the pointer is a dead end (design §5).
 *  - Every `docsPath` resolves against `site-docs/docs.json`, OFFLINE: a moved page is caught here,
 *    never by a user as a 404.
 *  - Every entry is complete in every shipped locale, carries at most four valid `seeAlso` keys and
 *    at least one of `seeAlso`/`docsPath` (the no-dead-end floor), and stays inside the word budget.
 *  - An entry stating a rule that has MOVED carries an `era` field, because the digit lint cannot
 *    see "mindestens eine Steuerperiode" go stale (the lint's stated blind spot).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { CONCEPTS, CONCEPT_KEYS } from '../../dist/core/guidance/corpus.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LOCALES = ['de-CH', 'en'];

/* Written as an escape so this guard does not trip the em dash gate it enforces. */
const EM_DASH = '\u2014';

/** Word budget: ~90 words per body. The floor catches a stub, the ceiling catches an article. */
const BODY_WORDS_MIN = 40;
const BODY_WORDS_MAX = 115;

/** The referring constructions the offline seam bans from every body (design §5c). */
const REFERRING = [
  /siehe\s+(die\s+)?dokumentation/i,
  /mehr\s+dazu\s+in/i,
  /see\s+the\s+docs/i,
  /read\s+the\s+documentation/i,
  /https?:\/\//i,
  /tillbooks\.ch/i,
];

function words(text) {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

test('corpus keys are unique, kebab-case, and CONCEPT_KEYS mirrors them', () => {
  const keys = CONCEPTS.map((c) => c.key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate corpus key');
  for (const key of keys) {
    assert.match(key, /^[a-z][a-z0-9-]*$/, `${key}: corpus keys are lowercase kebab-case`);
  }
  assert.deepEqual([...CONCEPT_KEYS], keys);
});

test('every entry is complete in every shipped locale', () => {
  for (const c of CONCEPTS) {
    for (const locale of LOCALES) {
      assert.ok(typeof c.term[locale] === 'string' && c.term[locale].trim() !== '', `${c.key}: term ${locale}`);
      assert.ok(typeof c.body[locale] === 'string' && c.body[locale].trim() !== '', `${c.key}: body ${locale}`);
    }
    assert.ok(Array.isArray(c.articles) && c.articles.length > 0, `${c.key}: the structured citation field is empty. A concept without a citation is a claim without a source; where no article exists the field says so ("kein Gesetzesartikel").`);
  }
});

test('no guidance body contains a digit (row 10.1: figures interpolate from era-scoped constants)', () => {
  for (const c of CONCEPTS) {
    for (const locale of LOCALES) {
      assert.ok(
        !/\d/.test(c.body[locale]),
        `${c.key} (${locale}): a digit in an authored body cannot be corrected by changing a constant. Interpolate it, or spell the rule and carry an era field.`,
      );
    }
  }
});

test('no guidance body refers the reader elsewhere or carries a URL (offline-completability, design §5)', () => {
  for (const c of CONCEPTS) {
    for (const locale of LOCALES) {
      for (const banned of REFERRING) {
        assert.ok(
          !banned.test(c.body[locale]),
          `${c.key} (${locale}): matches ${banned}. A body that ends by pointing somewhere has not answered.`,
        );
      }
    }
  }
});

test('no guidance body contains an em dash or a first-person "wir"', () => {
  for (const c of CONCEPTS) {
    for (const locale of LOCALES) {
      assert.ok(!c.body[locale].includes(EM_DASH), `${c.key} (${locale}): em dash`);
      assert.ok(!/\bwir\b/i.test(c.body[locale]), `${c.key} (${locale}): the product has no first person (§7c rule 6)`);
    }
  }
});

test('bodies stay inside the ~90 word budget', () => {
  for (const c of CONCEPTS) {
    for (const locale of LOCALES) {
      const n = words(c.body[locale]).length;
      assert.ok(
        n >= BODY_WORDS_MIN && n <= BODY_WORDS_MAX,
        `${c.key} (${locale}): ${n} words, budget ${BODY_WORDS_MIN}..${BODY_WORDS_MAX}. Over budget belongs in site-docs; under it is a stub.`,
      );
    }
  }
});

test('seeAlso: at most four, every target a corpus key, never self, and the no-dead-end floor holds', () => {
  const keys = new Set(CONCEPT_KEYS);
  for (const c of CONCEPTS) {
    assert.ok(c.seeAlso.length <= 4, `${c.key}: ${c.seeAlso.length} seeAlso, cap is 4`);
    assert.equal(new Set(c.seeAlso).size, c.seeAlso.length, `${c.key}: duplicate seeAlso`);
    for (const target of c.seeAlso) {
      assert.ok(keys.has(target), `${c.key}: seeAlso "${target}" is not a corpus key`);
      assert.notEqual(target, c.key, `${c.key}: seeAlso points at itself`);
    }
    assert.ok(
      c.seeAlso.length > 0 || typeof c.docsPath === 'string',
      `${c.key}: no seeAlso and no docsPath. A concept with neither renders a body and nothing else, which is a dead end (design §3a).`,
    );
  }
});

test('every docsPath resolves against site-docs/docs.json, offline (row 6.3)', () => {
  const docs = JSON.parse(readFileSync(join(ROOT, 'site-docs/docs.json'), 'utf8'));
  const pages = new Set();
  for (const tab of docs.navigation?.tabs ?? []) {
    for (const group of tab.groups ?? []) {
      for (const page of group.pages ?? []) pages.add(page);
    }
  }
  assert.ok(pages.size > 0, 'site-docs/docs.json lists no pages: the resolver itself is broken');
  for (const c of CONCEPTS) {
    if (c.docsPath === undefined) continue;
    assert.ok(
      pages.has(c.docsPath),
      `${c.key}: docsPath "${c.docsPath}" is not a page in site-docs/docs.json. Until a page exists, the docsPath is absent and no link renders (design §8b).`,
    );
  }
});

test('a not-implemented subject says so in the body, in both locales, as an explicit NEGATION about TILL (row 10.2)', () => {
  const flagged = CONCEPTS.filter((c) => c.notImplemented === true);
  assert.ok(flagged.length >= 2, 'vereinnahmte-entgelte and verrechnungssteuer both carry the flag');
  // The SHAPE, not just the token (corpus-critic F12): a body reading "TILL rechnet das vollständig
  // ab" contains "TILL" and implies coverage. What the flag promises is a sentence in which TILL is
  // the subject of a NEGATION: "TILL kann ... noch nicht berechnen", "TILL führt ... und mehr
  // nicht", "TILL cannot compute", "not represented in TILL". So the gate demands a sentence that
  // names TILL AND carries a negation marker, per locale.
  const NEGATION = {
    'de-CH': /\b(nicht|noch nicht|kein\w*|mehr nicht)\b/,
    en: /\b(cannot|not|no|never|nothing)\b/,
  };
  for (const c of flagged) {
    for (const locale of LOCALES) {
      const sentences = c.body[locale].split(/(?<=[.!?])\s+/);
      const honest = sentences.some((s) => s.includes('TILL') && NEGATION[locale].test(s));
      assert.ok(
        honest,
        `${c.key} (${locale}): a notImplemented entry must carry a sentence in which TILL is the subject of a negation (the explicit not-implemented line); a body that merely mentions TILL can still imply coverage, which is an outward-facing claim.`,
      );
    }
  }
});

/**
 * THE ERA RULE, enumerable rather than pinned (corpus-critic F1, proven by mutation: a new entry
 * citing MWSTG Art. 35, replaced 1.1.2025, with no era passed every gate while the pin below stayed
 * green). `MOVED_ARTICLES` is the register a reviewer maintains when the law moves: the day each
 * article's CURRENT form took effect, verified against the year-versioned fedlex consolidation
 * named in the row. The gate below derives which entries owe an `era` from their own citations, so
 * a new entry citing a moved article without one FAILS, by name.
 *
 * Match precision: a map key with an Absatz binds citations of that Absatz and citations of the
 * bare article (which include it); a citation of a DIFFERENT Absatz alone is untouched, so
 * `MWSTG Art. 37 Abs. 4` (unchanged since 2010) does not demand an era while bare `MWSTG Art. 37`
 * (which includes the Abs. 1 limits raised 1.1.2024) does.
 */
const MOVED_ARTICLES = [
  // MWSTG Art. 35 was rewritten wholesale by BG vom 16. Juni 2023 (AS 2024 438), in force 1.1.2025:
  // quarterly / half-yearly-under-Saldo cadence plus the new Abs. 1bis annual option.
  { law: 'MWSTG', art: 35, abs: null, from: '2025-01-01', source: 'AS 2024 438, fedlex 20250101' },
  // MWSTG Art. 37 Abs. 1: both eligibility limits raised with the Steuersatzerhöhung, 1.1.2024
  // (AS 2022 863). Abs. 4 (the lock-ins) is unchanged and deliberately NOT in this register.
  { law: 'MWSTG', art: 37, abs: 1, from: '2024-01-01', source: 'AS 2022 863, fedlex 20240101' },
  // MWSTG Art. 28 Abs. 2: the Urproduzenten flat input-tax deduction moved with the same
  // Steuersatzerhöhung (AS 2022 863), in force 1.1.2024 (re-critic R2; verified 2026-08-18).
  { law: 'MWSTG', art: 28, abs: 2, from: '2024-01-01', source: 'AS 2022 863, fedlex 20240101' },
  // MWSTV Art. 84 and Art. 86 were both replaced by V vom 21. August 2024 (AS 2024 485), in force
  // 1.1.2025 (the N-rate model).
  { law: 'MWSTV', art: 84, abs: null, from: '2025-01-01', source: 'AS 2024 485, fedlex 20250101' },
  { law: 'MWSTV', art: 86, abs: null, from: '2025-01-01', source: 'AS 2024 485, fedlex 20250101' },
];

/** Parse a corpus citation into law, article number and the Absätze it names (empty = the whole article). */
function parseCitation(citation) {
  const m = /^(MWSTG|MWSTV)\s+Art\.\s*(\d+)([a-z]*)(?:\s+Abs\.\s*([\d\su.,und]+))?/.exec(citation);
  if (m === null) return null;
  const absList = m[4] === undefined ? [] : [...m[4].matchAll(/\d+/g)].map((x) => Number(x[0]));
  return { law: m[1], art: Number(m[2]), suffix: m[3] ?? '', abs: absList };
}

/** True when `citation` covers the moved rule `row`: same law+article, and the Absatz (if the row names one) is cited or the citation is article-wide. */
function citesMovedRule(citation, row) {
  const parsed = parseCitation(citation);
  if (parsed === null || parsed.law !== row.law || parsed.art !== row.art || parsed.suffix !== '') return false;
  if (row.abs === null) return true;
  return parsed.abs.length === 0 || parsed.abs.includes(row.abs);
}

test('EVERY entry citing a moved article carries an era at least as new as the move (the F1 rule)', () => {
  for (const c of CONCEPTS) {
    for (const citation of c.articles) {
      for (const row of MOVED_ARTICLES) {
        if (!citesMovedRule(citation, row)) continue;
        assert.ok(
          c.era !== undefined,
          `${c.key}: cites "${citation}", whose current form took effect ${row.from} (${row.source}), and carries NO era. ` +
            'The era field is the staleness handle the no-digit lint lacks: add one, re-verify the body against the current consolidation, or drop the citation.',
        );
        assert.ok(
          c.era.effectiveFrom >= row.from,
          `${c.key}: cites "${citation}" (current form in force ${row.from}, ${row.source}) but its era.effectiveFrom is ${c.era.effectiveFrom}: the entry was last verified against an OLDER text than the one in force.`,
        );
      }
    }
  }
});

test('the parser and matcher bite: a moved-article citation without an era is detectable, and Abs. precision holds', () => {
  // Non-vacuous, both directions: bare Art. 37 matches the Abs. 1 row, Abs. 4 alone does not, and a
  // fabricated era-less entry citing Art. 35 would be caught by the rule above.
  const abs1Row = MOVED_ARTICLES.find((r) => r.law === 'MWSTG' && r.art === 37);
  assert.ok(citesMovedRule('MWSTG Art. 37', abs1Row));
  assert.ok(citesMovedRule('MWSTG Art. 37 Abs. 1', abs1Row));
  assert.ok(citesMovedRule('MWSTG Art. 37 Abs. 1 und 4', abs1Row));
  assert.ok(!citesMovedRule('MWSTG Art. 37 Abs. 4', abs1Row));
  const art35Row = MOVED_ARTICLES.find((r) => r.law === 'MWSTG' && r.art === 35);
  assert.ok(citesMovedRule('MWSTG Art. 35', art35Row));
  assert.ok(!citesMovedRule('MWSTG Art. 34', art35Row));
  // And the probe entry the critic used (articles: ['MWSTG Art. 35'], no era) would fail the rule.
  const probe = { key: 'probe', articles: ['MWSTG Art. 35'], era: undefined };
  const demands = probe.articles.some((cit) => MOVED_ARTICLES.some((row) => citesMovedRule(cit, row)));
  assert.ok(demands, 'the F1 probe entry is inside the rule, not beside it');
});

test('the two verified boundaries stay pinned (the design-critic and corpus-critic findings must not regress)', () => {
  const saldo = CONCEPTS.find((c) => c.key === 'saldosteuersatz');
  assert.ok(saldo?.era !== undefined, 'saldosteuersatz: the Art. 37 Abs. 1 limits moved on 1.1.2024');
  assert.equal(saldo.era.effectiveFrom, '2024-01-01', 'the limit raise rode the Steuersatzerhöhung of 1.1.2024, NOT 1.1.2025 (the design-critic finding)');
  const ziffer = CONCEPTS.find((c) => c.key === 'ziffer');
  assert.ok(ziffer?.era !== undefined, 'ziffer: the Saldo declaration scheme moved with the N-rate model');
  assert.equal(ziffer.era.effectiveFrom, '2025-01-01', 'the N-rate model (MWSTV Art. 86) is in force 1.1.2025, a DIFFERENT change from the limit raise');
});
