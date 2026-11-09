// A08, the STATUTORY-CLAIM guard: what the agent-facing surface says it conforms to, against what
// the section tables actually model.
//
// ## The defect class this exists for
//
// `sections.ts` has always been candid in prose: "WHAT THE BILANZ HERE IS NOT: OR Art. 959a's FIRST
// LEVEL ONLY ... the paragraph above said 'the STATUTORY headings, copied verbatim' and left a reader
// to conclude the article was implemented. It is not." Meanwhile the shipped `balance_sheet` tool
// description opened: "Bilanz (balance sheet) as of a date, in the OR Art. 959a minimum structure".
// Both strings lived in the repo for a whole capability and nothing went red, because nothing
// connected a description to a section table.
//
// It matters more than an ordinary copy defect for two reasons. An MCP tool description is read by
// AGENTS, which act on it with no human filter and will repeat it verbatim to a user; and the claim
// is a claim about SWISS STATUTORY COMPLIANCE, which is the one kind of claim in this product that
// cannot be walked back with a patch release.
//
// `or-structure.test.mjs` pins the ENGINE against the article. This file pins the SURFACE against the
// engine. Neither can catch the other's failure: a Bilanz with the wrong sections still foots, and a
// Bilanz with the right sections can still be described as something it is not.
//
// ## How the claim is detected, and what that CANNOT do
//
// A claim is an OR article citation with a structure noun NEAR it, on either side: "OR Art. 959a
// minimum structure", "the Mindestgliederung of Art. 959a OR". A bare citation used as PROVENANCE
// ("an Eigenkapital position (OR Art. 959a Abs. 2 Ziff. 3 lit. f and lit. g)") is not a claim and
// must not be flagged, which is most of what `CLAIM_WINDOW` and the noun list are for.
//
// **The first version of this detector scanned FORWARD only, and an independent critic defeated it
// end to end.** It added a real tool described "in the statutory minimum structure of OR Art. 959a
// and OR Art. 959b Abs. 3 ... ready to file with the Handelsregister", rebuilt `dist/`, and the
// suite went 8/8 green with exit 0, against a ledger scoring those articles 0/10, 2/14 and 0/8.
// Putting the noun before the citation was the whole trick. Dropping the `OR ` prefix, writing the
// ordinary Swiss order `Art. 959a OR`, or pushing the noun one character past the 40-char window
// escaped it too. The window is now symmetric, the prefix optional in both orders, the range wide
// enough that a neighbouring article is an undeclared claim rather than a silent pass, and the
// window length is measured (see `CLAIM_WINDOW`) instead of round. `the word order that defeated
// the first detector is caught` keeps every one of those evasions red from inside the suite.
//
// The limitation, stated rather than discovered later: **this guard cannot read negation.** A
// description saying "this is NOT the OR Art. 959a minimum structure" is flagged exactly like one
// asserting it, and now that the window is symmetric that bites in both directions. That is the
// safe direction to fail, and the consequence is that a disclaimer has to keep its citation clear
// of the structure noun. It is the guard working, not an inconvenience to route around: `the
// disclaimers do not trip the detector` below is the case that holds the shipped wording to it, and
// the fix when it goes red is always to reword the description, never to widen the detector. A
// second limitation: an author who invents new conformance vocabulary evades the noun list. That is
// true of every text guard, and it is worth having anyway.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS } from '../../dist/api/registry.js';
import {
  OR_ARTICLE_COVERAGE,
  BILANZ_SECTIONS,
  ERFOLG_SECTIONS,
  COMPUTED_EQUITY_LINES,
  STATUTORY_ERFOLG_POSITIONS,
  BILANZ_COVERAGE_NOTE,
  exportStatement,
  computeIncomeStatement,
} from '../../dist/core/reports/index.js';
import { setup, seedBooks, PERIOD } from './support.mjs';

// --- the detector --------------------------------------------------------------------------------

/**
 * An OR article citation, in EITHER citation order and with or without the `OR`.
 *
 * `Art. 959a OR` is the ordinary Swiss legal citation order, more standard in practice than this
 * repo's house `OR Art. 959a`, and the first version of this detector required the house form: a
 * contributor writing the citation the normal Swiss way was invisible to the guard for free. All
 * three forms key the same coverage row.
 *
 * The article range is `95x` and `96x`, which spans the whole Rechnungslegungsrecht (OR Art. 957 to
 * 963b) rather than only the two articles the ledger declares today. A claim on an article in that
 * range that `OR_ARTICLE_COVERAGE` does NOT declare is an offence rather than a silent pass, so
 * inventing a neighbouring article ("the OR Art. 961a minimum structure") is not an escape.
 *
 * The `(?![\p{L}])` after the article letter is what stops `Art. 958f` keying the row for `958`.
 */
const CITATION = /(?:\bOR\s+)?\bArt\.\s*(9[56]\d)([a-z])?(?![\p{L}])(?:\s*Abs\.\s*(\d+))?(?:\s*OR\b)?/gu;
/**
 * How far from a citation, IN EITHER DIRECTION, a structure noun still reads as part of the same
 * claim. Measured rather than picked round, because a forward-only 40 was defeated by word order:
 *
 *  - The longest gap in any real claim measured against this repo is **41** characters, the critic's
 *    "under OR Art. 959a, which prescribes the statutory minimum structure". A window of 40 missed
 *    it by one character. Every other claim form measured sits at 4 to 23.
 *  - The nearest gap between a citation and a noun that is NOT its claim, across the shipped
 *    descriptions, is **139** characters (the `balance_sheet` Eigenkapital provenance cite and the
 *    "WHAT IT IS NOT" sentence two clauses later).
 *
 * 80 clears the longest real claim by roughly 2x and still leaves 59 characters of headroom under
 * the nearest measured false positive. Re-measure before changing it, do not round it.
 */
const CLAIM_WINDOW = 80;
/**
 * The vocabulary that turns a citation into an assertion of conformance. "structure" and "layout"
 * are the two the shipped descriptions used; the German nouns are here because this repo writes
 * de-CH into English sentences routinely and a claim in either language is the same claim. Matched
 * case-insensitively, so a noun at the start of a sentence is not an escape.
 */
const CLAIM_NOUNS = ['structure', 'layout', 'gliederung', 'mindestgliederung', 'conformant', 'compliant', 'conform'];

/** Every conformance claim in one description, as the citation keys it asserts. */
function claimsIn(text) {
  const found = [];
  for (const match of text.matchAll(CITATION)) {
    const end = match.index + match[0].length;
    const before = text.slice(Math.max(0, match.index - CLAIM_WINDOW), match.index);
    const after = text.slice(end, end + CLAIM_WINDOW);
    // A NUL joins the two halves so no noun can be formed ACROSS the citation.
    const near = `${before}\u0000${after}`.toLowerCase();
    if (!CLAIM_NOUNS.some((noun) => near.includes(noun))) continue;
    const article = `OR Art. ${match[1]}${match[2] ?? ''}`;
    found.push(match[3] === undefined ? article : `${article} Abs. ${match[3]}`);
  }
  return found;
}

/**
 * The offences one description commits, as the guard below reports them.
 *
 * Extracted from the loop so a synthetic description can be run through the REAL scan rather than
 * through a reimplementation of it. `the critic's defeat` and `an undeclared article` below are
 * both exercised this way: mutating the shipped registry to prove a guard bites is a manual ritual
 * that only happens when someone remembers to perform it.
 */
function offencesFor(name, summary) {
  const offences = [];
  for (const citation of claimsIn(summary)) {
    const rows = rowsFor(citation);
    if (rows.length === 0) {
      offences.push(`${name}: claims ${citation}, which OR_ARTICLE_COVERAGE does not declare`);
      continue;
    }
    for (const [key, cover] of rows) {
      if (cover.modelledPositions === cover.requiredPositions) continue;
      offences.push(
        `${name}: claims conformance to ${citation}, but ${key} models ` +
          `${cover.modelledPositions} of ${cover.requiredPositions} positions`,
      );
    }
  }
  return offences;
}

/**
 * The coverage rows a citation puts on the hook. A citation naming an Absatz is itself; a BARE
 * article citation claims every Absatz declared for that article, which is why "OR Art. 959a" with
 * no Absatz is the strongest claim in the vocabulary rather than the vaguest.
 */
function rowsFor(citation) {
  const direct = OR_ARTICLE_COVERAGE[citation];
  if (direct !== undefined) return [[citation, direct]];
  return Object.entries(OR_ARTICLE_COVERAGE).filter(([key]) => key.startsWith(`${citation} Abs. `));
}

// --- the probe is checked before the code is blamed ----------------------------------------------

test('the detector fires on an assertion and stays silent on a provenance citation', () => {
  // The exact string that shipped, which is the regression this guard exists to catch.
  assert.deepEqual(
    claimsIn('Bilanz (balance sheet) as of a date, in the OR Art. 959a minimum structure: Umlaufvermögen and'),
    ['OR Art. 959a'],
  );
  // The Absatz-qualified form, and a true claim is still a claim: detection and verdict are separate.
  assert.deepEqual(
    claimsIn('in the OR Art. 959b Abs. 2 Gesamtkostenverfahren layout: the ten statutory positions'),
    ['OR Art. 959b Abs. 2'],
  );
  // Provenance, not conformance. This is the one that decides whether the guard is usable at all: if
  // it flagged every citation, the only way to pass would be to stop citing the article, which is the
  // opposite of what a statutory report should do.
  assert.deepEqual(
    claimsIn('an Eigenkapital position (OR Art. 959a Abs. 2 Ziff. 3 lit. f and lit. g), which is what makes it foot'),
    [],
  );
  assert.deepEqual(claimsIn('the sections are ordered as the article prescribes (OR Art. 959b Abs. 2)'), []);
  assert.deepEqual(claimsIn('the Stetigkeit principle of OR Art. 958c'), []);
  // This one USED to be a negative control, on the reasoning that a parenthesised citation is
  // provenance. It is not: "their structure is statutory" asserts conformance in as many words, and
  // parenthesising the citation is exactly how the forward-only window was defeated. The symmetric
  // window reads it as the claim it is, which is the correct answer and not a regression.
  assert.deepEqual(claimsIn('their structure is statutory (OR Art. 959a/959b), so they do not expose'), [
    'OR Art. 959a',
  ]);
  // And a bare article citation puts every declared Absatz of it on the hook.
  assert.deepEqual(rowsFor('OR Art. 959a').map(([key]) => key), ['OR Art. 959a Abs. 1', 'OR Art. 959a Abs. 2']);
  assert.deepEqual(rowsFor('OR Art. 959b Abs. 2').map(([key]) => key), ['OR Art. 959b Abs. 2']);
});

// --- the coverage ledger is not a free-standing opinion -------------------------------------------

test('OR_ARTICLE_COVERAGE agrees with the section tables it describes', () => {
  // The ledger is the guard's oracle, so a wrong number there would silently license a wrong claim.
  // Every `modelledPositions` is therefore derived from the shipped tables rather than asserted.
  //
  // 959a Abs. 1: `BILANZ_SECTIONS` cites Ziffern and Absätze, never a `lit.`, which is exactly the
  // statement "the sub-level is not modelled" in a form the table itself can be checked against.
  assert.deepEqual(BILANZ_SECTIONS.filter((s) => s.cite.includes('lit.')).map((s) => s.key), []);
  assert.equal(OR_ARTICLE_COVERAGE['OR Art. 959a Abs. 1'].modelledPositions, 0);

  // 959a Abs. 2: the only sub-positions modelled anywhere are lit. f and lit. g, and they exist for
  // the tie-out. Both cite Abs. 2, so the count is theirs.
  assert.deepEqual(
    COMPUTED_EQUITY_LINES.map((l) => l.cite),
    ['OR Art. 959a Abs. 2 Ziff. 3 lit. f', 'OR Art. 959a Abs. 2 Ziff. 3 lit. g'],
  );
  assert.equal(OR_ARTICLE_COVERAGE['OR Art. 959a Abs. 2'].modelledPositions, COMPUTED_EQUITY_LINES.length);

  // The two Absätze together are the 24 the file docblock and or-structure.test.mjs both count.
  assert.equal(
    OR_ARTICLE_COVERAGE['OR Art. 959a Abs. 1'].requiredPositions +
      OR_ARTICLE_COVERAGE['OR Art. 959a Abs. 2'].requiredPositions,
    24,
  );

  // 959b Abs. 2: ten account-backed sections plus the result. The residual is Abs. 5 and is not one
  // of the eleven, so it must not be counted into the coverage.
  //
  // BOTH halves are derived here. This row used to close with `modelledPositions === requiredPositions`
  // against a table literally reading `{ requiredPositions: 11, modelledPositions: 11 }`, which cannot
  // fail: the one row that licenses a POSITIVE statutory claim was the one row asserted against
  // itself, and a description generalising it to "every one of its positions is modelled under its
  // statutory wording" passed. Ten of the eleven is what that is true of.
  const ziffern = ERFOLG_SECTIONS.filter((s) => /^OR Art\. 959b Abs\. 2 Ziff\. \d+$/.test(s.cite));
  assert.deepEqual(
    ziffern.map((s) => s.cite),
    Array.from({ length: STATUTORY_ERFOLG_POSITIONS }, (_, i) => `OR Art. 959b Abs. 2 Ziff. ${i + 1}`),
  );
  // Ziff. 11 is NOT among them, and saying so here is what keeps the 11 below from being read as
  // eleven statutory headings. It is the sum of the other ten, and a section accounts could fall
  // into is how a report double-counts itself.
  assert.deepEqual(ERFOLG_SECTIONS.filter((s) => s.cite.endsWith('Ziff. 11')), []);
  assert.equal(OR_ARTICLE_COVERAGE['OR Art. 959b Abs. 2'].requiredPositions, STATUTORY_ERFOLG_POSITIONS + 1);

  // The eleventh counts as modelled only because the shipped read model really emits it, and emits
  // it as the sum of the ten rather than as a field that happens to exist. Computed here rather than
  // asserted, over the awkward fixture, so deleting `reingewinnMinor` or letting it drift off the
  // sections moves the derived number and the ledger goes red.
  const t = setup();
  seedBooks(t);
  const erfolg = computeIncomeStatement(t.ctx, PERIOD);
  assert.equal(erfolg.ok, true);
  assert.equal(typeof erfolg.reingewinnMinor, 'number');
  assert.equal(
    erfolg.reingewinnMinor,
    erfolg.sections.reduce((sum, s) => sum + s.subtotalMinor, 0),
    'position 11 must be the sum of the positions above it',
  );
  const emittedResult = typeof erfolg.reingewinnMinor === 'number' ? 1 : 0;
  assert.equal(OR_ARTICLE_COVERAGE['OR Art. 959b Abs. 2'].modelledPositions, ziffern.length + emittedResult);

  // What the 11 rests on, asserted where the number is derived rather than left for a description
  // to generalise. This used to be a comment recording a gap: position 11 counted as modelled while
  // the Erfolgsrechnung headed it "Reingewinn oder Reinverlust", the conventional Treuhand wording,
  // and the Bilanz printed the same figure under the enacted "Jahresgewinn oder Jahresverlust" at
  // Abs. 2 Ziff. 3 lit. g. `export.ts` closed it on 2026-07-26, so the two statements now agree and
  // the gap is asserted shut instead of written down.
  //
  // The two names are checked against ONE constant, so a future edit to either statement has to
  // move both or come here and argue. The Erfolgsrechnung resolves the "oder" by sign, which is the
  // enacted wording with the branch the book did not take dropped: the stem is what has to match.
  // The proof that the heading is ON the page rather than merely in the bytes is
  // `export.test.mjs`, which parses the placements against the MediaBox; this case only asserts
  // that the coverage row is not licensing a heading the article does not know.
  const ENACTED_ZIFF_11 = 'Jahresgewinn oder Jahresverlust';
  assert.equal(COMPUTED_EQUITY_LINES[1].labels.de, ENACTED_ZIFF_11);
  const erfolgPdf = exportStatement(t.ctx, { kind: 'income', format: 'pdf', ...PERIOD });
  assert.equal(erfolgPdf.ok, true);
  const erfolgBytes = Buffer.from(erfolgPdf.artifact.base64, 'base64').toString('latin1');
  assert.ok(
    erfolgBytes.includes(ENACTED_ZIFF_11.split(' oder ')[erfolg.reingewinnMinor < 0 ? 1 : 0]),
    'the Erfolgsrechnung must head position 11 with the enacted wording',
  );
  assert.ok(!erfolgBytes.includes('Reingewinn'), 'the conventional wording must not be back');

  // 959b Abs. 3 is the Absatzerfolgsrechnung and nothing cites it, which is what "not built" means.
  assert.deepEqual(ERFOLG_SECTIONS.filter((s) => s.cite.includes('Abs. 3')).map((s) => s.key), []);
  assert.equal(OR_ARTICLE_COVERAGE['OR Art. 959b Abs. 3'].modelledPositions, 0);
});

// --- the guard ------------------------------------------------------------------------------------

test('no tool description claims an OR article the section tables do not fully model', () => {
  const offences = ACTIONS.flatMap((action) => offencesFor(action.name, action.summary));
  assert.deepEqual(offences, []);
});

test('the word order that defeated the first detector is caught', () => {
  // Verbatim the tool the independent critic added to `report-actions.ts` to defeat the guard: it
  // claims full conformance to two articles the ledger scores 0/10, 2/14 and 0/8, plus "ready to
  // file", and the whole suite went green with exit 0 because every structure noun sat BEFORE its
  // citation. Kept as a case rather than as a mutation ritual: a defeat that has to be re-performed
  // by hand to be noticed is a defeat that will not be noticed.
  const defeat =
    'Jahresrechnung as of a date, in the statutory minimum structure of OR Art. 959a and ' +
    'OR Art. 959b Abs. 3, every prescribed position present, in the prescribed order, ' +
    'ready to file with the Handelsregister.';
  assert.deepEqual(claimsIn(defeat), ['OR Art. 959a', 'OR Art. 959b Abs. 3']);
  assert.deepEqual(offencesFor('annual_accounts', defeat), [
    'annual_accounts: claims conformance to OR Art. 959a, but OR Art. 959a Abs. 1 models 0 of 10 positions',
    'annual_accounts: claims conformance to OR Art. 959a, but OR Art. 959a Abs. 2 models 2 of 14 positions',
    'annual_accounts: claims conformance to OR Art. 959b Abs. 3, but OR Art. 959b Abs. 3 models 0 of 8 positions',
  ]);

  // The rest of the critic's evasion sweep, each one green against the forward-only 40-char window.
  const evasions = {
    'noun before the citation': 'in the statutory minimum structure of OR Art. 959a',
    'the German noun, before': 'in the Mindestgliederung of OR Art. 959a',
    'a clause between, 41 chars': 'under OR Art. 959a, which prescribes the statutory minimum structure',
    'no OR prefix': 'in the Art. 959a minimum structure',
    'the Swiss citation order': 'in the minimum structure of Art. 959a OR',
    'a sentence-leading noun': 'Structure per OR Art. 959a, in full',
  };
  for (const [label, text] of Object.entries(evasions)) {
    assert.deepEqual(claimsIn(text), ['OR Art. 959a'], label);
  }
  // And an article outside the ledger is an offence rather than a silent pass, so reaching for a
  // neighbouring article is not an escape either.
  assert.deepEqual(offencesFor('x', 'in the OR Art. 961a minimum structure'), [
    'x: claims OR Art. 961a, which OR_ARTICLE_COVERAGE does not declare',
  ]);
});

test('an Absatz the ledger deliberately omits is an offence, not a silent pass', () => {
  // The undeclared-claim branch of the scan had no case at all, and the two Absätze it exists for
  // were unreachable from the shipped text: `balance_sheet` wrote its residual as a bare "(Abs. 3)"
  // with no article, which no citation regex can key. Both descriptions now write the article out,
  // and this is the case that says why the omission is deliberate.
  //
  // 959a Abs. 3 and 959b Abs. 5 prescribe no enumerated positions, only "weitere Positionen ...
  // sofern wesentlich", which is a materiality judgement A08 does not make. They are absent from
  // OR_ARTICLE_COVERAGE for that reason, so a claim on one is an unanswerable claim rather than a
  // true or false one, and it has to go red and be argued rather than default to a pass.
  for (const absatz of ['OR Art. 959a Abs. 3', 'OR Art. 959b Abs. 5']) {
    assert.equal(OR_ARTICLE_COVERAGE[absatz], undefined, `${absatz} must stay out of the ledger`);
    assert.deepEqual(rowsFor(absatz), []);
    assert.deepEqual(offencesFor('x', `grouped in the ${absatz} structure`), [
      `x: claims ${absatz}, which OR_ARTICLE_COVERAGE does not declare`,
    ]);
  }
  // The shipped descriptions cite both as provenance, which is not a claim and must stay silent.
  for (const name of ['balance_sheet', 'income_statement']) {
    const action = ACTIONS.find((a) => a.name === name);
    assert.match(action.summary, /OR Art\. 959[ab] Abs\. [35]/, `${name} must cite the residual Absatz in full`);
  }
});

test('the guard is not vacuous: income_statement makes a real claim and it holds', () => {
  // A guard nobody can fail is worse than none, and a guard nobody can PASS is a ban. `income_statement`
  // is the positive control: it asserts OR Art. 959b Abs. 2, that claim is detected, and it survives
  // because all eleven positions of the Absatz are present and in order. So the case above
  // distinguishes a true claim from a false one rather than merely forbidding the word.
  const income = ACTIONS.find((a) => a.name === 'income_statement');
  assert.deepEqual(claimsIn(income.summary), ['OR Art. 959b Abs. 2']);
  const [[, cover]] = rowsFor('OR Art. 959b Abs. 2');
  assert.equal(cover.modelledPositions, cover.requiredPositions);
});

test('balance_sheet discloses the gap instead of claiming the article', () => {
  const balance = ACTIONS.find((a) => a.name === 'balance_sheet');
  // The phrase that shipped, gone. Asserted as a substring rather than via the detector, because this
  // is the specific regression and it should fail by name.
  assert.ok(
    !balance.summary.includes('in the OR Art. 959a minimum structure'),
    'the shipped overclaim is back in balance_sheet',
  );
  // And the description now says what the statement is NOT, in terms an agent can act on: it has to
  // name the sub-positions as unmodelled and tell the agent not to present the output as conformant.
  assert.match(balance.summary, /sub-positions/);
  assert.match(balance.summary, /not modelled/);
  assert.match(balance.summary, /OR-conformant/);
  // The seven groupings and the two computed equity lines are what it IS, and stay described.
  assert.match(balance.summary, /Umlaufvermögen/);
  assert.match(balance.summary, /Eigenkapital/);
});

test('the disclaimers do not trip the detector, which cannot read negation', () => {
  // The header states this limitation; this is the case that keeps the shipped wording inside it.
  // If a future edit phrases the caveat as "not the OR Art. 959a minimum structure", the guard above
  // reads an assertion and goes red, and the fix is to reword, never to weaken the detector.
  for (const action of ACTIONS) {
    for (const citation of claimsIn(action.summary)) {
      const rows = rowsFor(citation);
      assert.ok(rows.length > 0, `${action.name}: undeclared claim ${citation}`);
    }
  }
  assert.deepEqual(claimsIn(ACTIONS.find((a) => a.name === 'balance_sheet').summary), []);
});

// --- the artifact carries the same limit as the surface (finding F1) ------------------------------

test('the exported Bilanz PDF prints the coverage note on every page', () => {
  const t = setup();
  seedBooks(t);
  const res = exportStatement(t.ctx, { kind: 'balance', format: 'pdf', asOf: '2026-03-31' });
  assert.equal(res.ok, true);
  const pdf = Buffer.from(res.artifact.base64, 'base64').toString('latin1');
  // The note sits in the MASTHEAD, which `buildMinimalPdf` repeats per page, so a page separated from
  // page 1 still carries it. Counted against the page count rather than merely found once: a file
  // whose caveat is on page 1 only is a file whose caveat can be detached from the figures.
  const pages = (pdf.match(/\/Type \/Page[^s]/g) ?? []).length;
  assert.ok(pages >= 1);
  const occurrences = pdf.split(BILANZ_COVERAGE_NOTE).length - 1;
  assert.equal(occurrences, pages, 'the coverage note is not on every page of the Bilanz PDF');
});

test('the coverage note is on the Bilanz only, and names the article it limits', () => {
  const t = setup();
  seedBooks(t);
  // The Erfolgsrechnung has no equivalent gap (OR Art. 959b Abs. 2 is modelled in full), the
  // Saldenbilanz and the Kontoblatt are working papers claiming no statutory structure at all. A
  // caveat on those would be noise on three documents to disclose a limit that only one of them has.
  for (const kind of ['income', 'trial']) {
    const res = exportStatement(t.ctx, {
      kind,
      format: 'pdf',
      periodStart: '2026-01-01',
      periodEnd: '2026-03-31',
    });
    assert.equal(res.ok, true);
    const pdf = Buffer.from(res.artifact.base64, 'base64').toString('latin1');
    assert.ok(!pdf.includes(BILANZ_COVERAGE_NOTE), `${kind} carries the Bilanz coverage note`);
  }
  // de-CH on a de-CH document, with real umlauts, and it names the Absätze so a Treuhänder can look
  // them up rather than being told only that something is missing.
  assert.match(BILANZ_COVERAGE_NOTE, /OR Art\. 959a/);
  assert.match(BILANZ_COVERAGE_NOTE, /Gliederung/);
  // House style, on a string that goes on paper. Written as an escape because `check:style` scans
  // this file too and a literal one here would fail the gate it is asserting.
  assert.ok(!/\u2014/.test(BILANZ_COVERAGE_NOTE));
});
