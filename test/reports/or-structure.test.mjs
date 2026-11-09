// A08 §8, the compliance fixture: the Bilanz and the Erfolgsrechnung against the OR text itself.
//
// The section keys and the section ORDER are the statutory minimum structure, so they are pinned
// here as literals transcribed from the consolidated Obligationenrecht (SR 220), fetched
// 2026-07-26 from
//   https://www.fedlex.admin.ch/filestore/fedlex.data.admin.ch/eli/cc/27/317_321_377/20260101/
//     {de,fr,it}/html/fedlex-data-admin-ch-eli-cc-27-317_321_377-20260101-{de,fr,it}-html.html
// (HTTP 200 on all three; the JS-gated `/eli/cc/.../de/html/...` page serves an app shell instead).
//
// WHY THIS FILE EXISTS SEPARATELY from statements.test.mjs: the reconciliation flags prove that
// every account reached exactly one section and that the date fences agree. They say NOTHING about
// whether the sections are the right sections, in the right order, under the right headings. A
// chart where Abschreibungen were filed under Personalaufwand would foot, tie out, and be wrong.
// This is the file that would go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BILANZ_SECTIONS,
  ERFOLG_SECTIONS,
  COMPUTED_EQUITY_LINES,
  STATUTORY_ERFOLG_POSITIONS,
  bilanzSectionFor,
  erfolgSectionFor,
  computeBalanceSheet,
  computeIncomeStatement,
} from '../../dist/core/reports/index.js';
import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';
import { setup, seedBooks } from './support.mjs';

// --- OR Art. 959a, Mindestgliederung der Bilanz ---------------------------------------------------

test('OR Art. 959a: the FIRST-LEVEL Bilanz groupings, in the statutory order', () => {
  // Abs. 1: Aktiven "ihrem Liquiditätsgrad entsprechend ... in der vorgegebenen Reihenfolge",
  // Ziff. 1 Umlaufvermögen then Ziff. 2 Anlagevermögen. Abs. 2: Passiven "ihrer Fälligkeit
  // entsprechend", Ziff. 1 kurzfristiges Fremdkapital, Ziff. 2 langfristiges Fremdkapital,
  // Ziff. 3 Eigenkapital. Abs. 3 adds the "weitere Positionen" residual, which is why each side
  // ends with one.
  assert.deepEqual(
    BILANZ_SECTIONS.map((s) => [s.key, s.side]),
    [
      ['umlaufvermoegen', 'aktiven'],
      ['anlagevermoegen', 'aktiven'],
      ['uebrige_aktiven', 'aktiven'],
      ['kurzfristiges_fremdkapital', 'passiven'],
      ['langfristiges_fremdkapital', 'passiven'],
      ['eigenkapital', 'passiven'],
      ['uebrige_passiven', 'passiven'],
    ],
  );
});

test('OR Art. 959a: the first-level headings are the statutory wording, verbatim', () => {
  const de = Object.fromEntries(BILANZ_SECTIONS.map((s) => [s.key, s.labels.de]));
  assert.equal(de.umlaufvermoegen, 'Umlaufvermögen');
  assert.equal(de.anlagevermoegen, 'Anlagevermögen');
  assert.equal(de.kurzfristiges_fremdkapital, 'Kurzfristiges Fremdkapital');
  assert.equal(de.langfristiges_fremdkapital, 'Langfristiges Fremdkapital');
  assert.equal(de.eigenkapital, 'Eigenkapital');
  // fr and it come from the official French and Italian consolidations, not from a translation.
  const fr = Object.fromEntries(BILANZ_SECTIONS.map((s) => [s.key, s.labels.fr]));
  assert.equal(fr.umlaufvermoegen, 'Actif circulant');
  assert.equal(fr.anlagevermoegen, 'Actif immobilisé');
  assert.equal(fr.kurzfristiges_fremdkapital, 'Capitaux étrangers à court terme');
  assert.equal(fr.eigenkapital, 'Capitaux propres');
  const it = Object.fromEntries(BILANZ_SECTIONS.map((s) => [s.key, s.labels.it]));
  assert.equal(it.umlaufvermoegen, 'Attivo circolante');
  assert.equal(it.anlagevermoegen, 'Attivo fisso');
  assert.equal(it.langfristiges_fremdkapital, 'Capitale di terzi a lungo termine');
  assert.equal(it.eigenkapital, 'Capitale proprio');
});

test('OR Art. 959a Abs. 2 Ziff. 3 lit. f and lit. g are on the Bilanz as equity positions', () => {
  assert.deepEqual(
    COMPUTED_EQUITY_LINES.map((l) => [l.key, l.labels.de, l.cite]),
    [
      ['ergebnisvortrag', 'Gewinnvortrag oder Verlustvortrag', 'OR Art. 959a Abs. 2 Ziff. 3 lit. f'],
      ['jahresergebnis', 'Jahresgewinn oder Jahresverlust', 'OR Art. 959a Abs. 2 Ziff. 3 lit. g'],
    ],
  );
});

test('lit. f and lit. g end "als Minusposten", and the shortened label is not called verbatim', () => {
  // The assertion above pins the DISPLAY NAME, and that string is not what the article says. Both
  // Buchstaben end with a presentation instruction that no Swiss Bilanz prints on its face, and the
  // French consolidation carries the same suffix, so it is enacted text and not a German artifact.
  // The full wording is therefore held here as itself, rather than the short form being asserted as
  // though it were the statute.
  assert.deepEqual(
    COMPUTED_EQUITY_LINES.map((l) => l.statutoryWording.de),
    [
      'Gewinnvortrag oder Verlustvortrag als Minusposten',
      'Jahresgewinn oder Jahresverlust als Minusposten',
    ],
  );
  assert.deepEqual(
    COMPUTED_EQUITY_LINES.map((l) => l.statutoryWording.fr),
    [
      'bénéfice reporté ou perte reportée en diminution des capitaux propres',
      "bénéfice de l'exercice ou perte de l'exercice en diminution des capitaux propres",
    ],
  );
  // And the display label is a strict prefix of the German wording, which is what makes it a
  // shortening rather than a different string that merely looks similar.
  for (const line of COMPUTED_EQUITY_LINES) {
    assert.ok(
      line.statutoryWording.de.startsWith(line.labels.de),
      `${line.key}: the label is not the statutory wording minus its suffix`,
    );
    assert.equal(line.statutoryWording.de.slice(line.labels.de.length), ' als Minusposten');
  }
});

test('OR Art. 959a Abs. 1 and Abs. 2: the 24 SUB-POSITIONS are NOT modelled, and A08 says so', () => {
  // The article requires these "einzeln und in der vorgegebenen Reihenfolge". A08 implements the
  // first level only and emits raw account lines under each grouping, ordered by account number.
  // On the shipped KMU chart that reproduces the statutory sequence BY COINCIDENCE, because the
  // Kontenrahmen numbers ascend in the order the statute lists. A renamed or renumbered chart (which
  // A01 permits) yields a Bilanz that names none of these.
  //
  // This case exists so the gap cannot be quietly claimed shut: transcribed from the 2026-01-01
  // consolidation, it fails the moment someone adds sub-positions without updating the count, and it
  // fails if anyone deletes it while the docs still promise the article.
  const SUB_POSITIONS = {
    'Abs. 1 Ziff. 1 Umlaufvermögen': [
      'flüssige Mittel und kurzfristig gehaltene Aktiven mit Börsenkurs',
      'Forderungen aus Lieferungen und Leistungen',
      'übrige kurzfristige Forderungen',
      'Vorräte und nicht fakturierte Dienstleistungen',
      'aktive Rechnungsabgrenzungen',
    ],
    'Abs. 1 Ziff. 2 Anlagevermögen': [
      'Finanzanlagen',
      'Beteiligungen',
      'Sachanlagen',
      'immaterielle Werte',
      'nicht einbezahltes Grund-, Gesellschafter- oder Stiftungskapital',
    ],
    'Abs. 2 Ziff. 1 kurzfristiges Fremdkapital': [
      'Verbindlichkeiten aus Lieferungen und Leistungen',
      'kurzfristige verzinsliche Verbindlichkeiten',
      'übrige kurzfristige Verbindlichkeiten',
      'passive Rechnungsabgrenzungen',
    ],
    'Abs. 2 Ziff. 2 langfristiges Fremdkapital': [
      'langfristige verzinsliche Verbindlichkeiten',
      'übrige langfristige Verbindlichkeiten',
      'Rückstellungen sowie vom Gesetz vorgesehene ähnliche Positionen',
    ],
    'Abs. 2 Ziff. 3 Eigenkapital': [
      'Grund-, Gesellschafter- oder Stiftungskapital, gegebenenfalls gesondert nach Beteiligungskategorien',
      'gesetzliche Kapitalreserve',
      'gesetzliche Gewinnreserve',
      'freiwillige Gewinnreserven',
      'eigene Kapitalanteile als Minusposten',
      'Gewinnvortrag oder Verlustvortrag als Minusposten',
      'Jahresgewinn oder Jahresverlust als Minusposten',
    ],
  };
  const total = Object.values(SUB_POSITIONS).reduce((n, list) => n + list.length, 0);
  assert.equal(total, 24, 'the statutory sub-position count moved: re-read the article');

  // A08 models the seven first-level groupings and NOT these. The two lit. f / lit. g equity lines
  // are the only sub-positions it carries, and it carries them because the Bilanz cannot foot
  // without them, not because the sub-level is implemented.
  const modelled = new Set([
    ...BILANZ_SECTIONS.map((s) => s.labels.de),
    ...COMPUTED_EQUITY_LINES.map((l) => l.statutoryWording.de),
  ]);
  const missing = Object.values(SUB_POSITIONS).flat().filter((name) => !modelled.has(name));
  assert.equal(missing.length, 22, 'exactly two sub-positions are modelled, both for the tie-out');
  assert.deepEqual(
    Object.values(SUB_POSITIONS).flat().filter((name) => modelled.has(name)),
    ['Gewinnvortrag oder Verlustvortrag als Minusposten', 'Jahresgewinn oder Jahresverlust als Minusposten'],
  );
});

// --- OR Art. 959b Abs. 2, Mindestgliederung der Erfolgsrechnung ----------------------------------

test('OR Art. 959b Abs. 2: the ten positions, in the prescribed order, then the Abs. 5 residual', () => {
  // "müssen mindestens folgende Positionen je einzeln und in der vorgegebenen Reihenfolge
  // ausgewiesen werden": 1 Nettoerlöse, 2 Bestandesänderungen, 3 Materialaufwand, 4 Personalaufwand,
  // 5 übriger betrieblicher Aufwand, 6 Abschreibungen, 7 Finanzaufwand und Finanzertrag,
  // 8 betriebsfremder Aufwand und Ertrag, 9 ausserordentlicher/einmaliger/periodenfremder Aufwand
  // und Ertrag, 10 direkte Steuern, 11 Jahresgewinn oder Jahresverlust. Position 11 is the RESULT
  // and is reported as `reingewinnMinor`, never as a bucket an account could fall into.
  assert.deepEqual(ERFOLG_SECTIONS.map((s) => s.key), [
    'netto_erloese',
    'bestandes_aenderungen',
    'materialaufwand',
    'personalaufwand',
    'uebriger_betrieblicher_aufwand',
    'abschreibungen',
    'finanzergebnis',
    'betriebsfremder_erfolg',
    'ausserordentlicher_erfolg',
    'direkte_steuern',
    'uebrige_positionen',
  ]);
  assert.equal(STATUTORY_ERFOLG_POSITIONS, 10);
  assert.deepEqual(
    ERFOLG_SECTIONS.slice(0, STATUTORY_ERFOLG_POSITIONS).map((s) => s.cite),
    Array.from({ length: 10 }, (_, i) => `OR Art. 959b Abs. 2 Ziff. ${i + 1}`),
  );
  assert.equal(ERFOLG_SECTIONS[10].cite, 'OR Art. 959b Abs. 5');
});

test('OR Art. 959b Abs. 2: the position headings are the statutory wording in all three languages', () => {
  const byKey = Object.fromEntries(ERFOLG_SECTIONS.map((s) => [s.key, s.labels]));
  assert.equal(byKey.netto_erloese.de, 'Nettoerlöse aus Lieferungen und Leistungen');
  assert.equal(byKey.netto_erloese.fr, 'Produits nets des ventes de biens et de prestations de services');
  assert.equal(byKey.netto_erloese.it, 'Importo netto dei ricavi da forniture e prestazioni');
  assert.equal(byKey.materialaufwand.de, 'Materialaufwand');
  assert.equal(byKey.materialaufwand.fr, 'Charges de matériel');
  assert.equal(byKey.personalaufwand.de, 'Personalaufwand');
  assert.equal(byKey.personalaufwand.it, 'Costi per il personale');
  assert.equal(
    byKey.abschreibungen.de,
    'Abschreibungen und Wertberichtigungen auf Positionen des Anlagevermögens',
  );
  assert.equal(byKey.finanzergebnis.de, 'Finanzaufwand und Finanzertrag');
  assert.equal(byKey.finanzergebnis.fr, 'Charges et produits financiers');
  assert.equal(byKey.direkte_steuern.de, 'Direkte Steuern');
  assert.equal(byKey.direkte_steuern.it, 'Imposte dirette');
});

test('the three MIXED positions are the three the statute writes as Aufwand AND Ertrag', () => {
  // Ziff. 7, 8 and 9 each name both sides in one position, which is why they are shown net and why
  // `nature` exists at all: a GUI that flipped the display sign of an expense position would print
  // a financial GAIN as a loss.
  assert.deepEqual(
    ERFOLG_SECTIONS.filter((s) => s.nature === 'mixed').map((s) => s.key),
    ['bestandes_aenderungen', 'finanzergebnis', 'betriebsfremder_erfolg', 'ausserordentlicher_erfolg', 'uebrige_positionen'],
  );
  assert.deepEqual(
    ERFOLG_SECTIONS.filter((s) => s.nature === 'expense').map((s) => s.key),
    ['materialaufwand', 'personalaufwand', 'uebriger_betrieblicher_aufwand', 'abschreibungen', 'direkte_steuern'],
  );
  assert.deepEqual(ERFOLG_SECTIONS.filter((s) => s.nature === 'revenue').map((s) => s.key), ['netto_erloese']);
});

// --- The shipped chart, account by account -------------------------------------------------------

test('every account in the shipped KMU seed lands in the section its number and the OR imply', () => {
  // Named account by account rather than by rule, so a range edit that silently moves 2300 out of
  // the kurzfristiges Fremdkapital has to change this table too. The expectations are read off the
  // OR: 2300 passive Rechnungsabgrenzungen is Abs. 2 Ziff. 1 lit. d (SHORT term), 2600
  // Rückstellungen is Ziff. 2 lit. c (LONG term), and both are easy to get backwards.
  const expected = {
    '1000': 'umlaufvermoegen',
    '1020': 'umlaufvermoegen',
    '1060': 'umlaufvermoegen',
    '1100': 'umlaufvermoegen',
    '1109': 'umlaufvermoegen',
    '1170': 'umlaufvermoegen',
    '1171': 'umlaufvermoegen',
    '1176': 'umlaufvermoegen',
    '1200': 'umlaufvermoegen',
    '1300': 'umlaufvermoegen',
    '1500': 'anlagevermoegen',
    '1510': 'anlagevermoegen',
    '1520': 'anlagevermoegen',
    '1530': 'anlagevermoegen',
    '2000': 'kurzfristiges_fremdkapital',
    '2100': 'kurzfristiges_fremdkapital',
    '2200': 'kurzfristiges_fremdkapital',
    '2201': 'kurzfristiges_fremdkapital',
    '2260': 'kurzfristiges_fremdkapital',
    '2300': 'kurzfristiges_fremdkapital',
    // 2330 kurzfristige Rückstellungen: Abs. 2 Ziff. 1 lit. e, SHORT term unlike 2600 (A38).
    '2330': 'kurzfristiges_fremdkapital',
    '2400': 'langfristiges_fremdkapital',
    '2450': 'langfristiges_fremdkapital',
    '2600': 'langfristiges_fremdkapital',
    '2800': 'eigenkapital',
    '2850': 'eigenkapital',
    '2970': 'eigenkapital',
    '2979': 'eigenkapital',
  };
  for (const account of KMU_CORE_SEED) {
    if (account.type === 'income' || account.type === 'expense') continue;
    assert.equal(bilanzSectionFor(account), expected[account.number], `account ${account.number} ${account.name}`);
  }
  assert.equal(Object.keys(expected).length, KMU_CORE_SEED.filter((a) => a.type !== 'income' && a.type !== 'expense').length);
});

test('every result account in the shipped KMU seed lands in its OR Art. 959b position', () => {
  const expected = {
    '3000': 'netto_erloese',
    '3200': 'netto_erloese',
    '3400': 'netto_erloese',
    '3600': 'netto_erloese',
    // Erlösminderungen belong INSIDE Nettoerlöse: Ziff. 1 says "Nettoerlöse", so a discount reduces
    // revenue and must not be shown as an expense.
    '3800': 'netto_erloese',
    '3805': 'netto_erloese',
    '3806': 'netto_erloese',
    '3809': 'netto_erloese',
    '4000': 'materialaufwand',
    '4200': 'materialaufwand',
    '4400': 'materialaufwand',
    '4900': 'materialaufwand',
    '4906': 'materialaufwand',
    '5000': 'personalaufwand',
    '5700': 'personalaufwand',
    '5800': 'personalaufwand',
    '6000': 'uebriger_betrieblicher_aufwand',
    '6100': 'uebriger_betrieblicher_aufwand',
    '6200': 'uebriger_betrieblicher_aufwand',
    '6300': 'uebriger_betrieblicher_aufwand',
    '6400': 'uebriger_betrieblicher_aufwand',
    '6500': 'uebriger_betrieblicher_aufwand',
    '6570': 'uebriger_betrieblicher_aufwand',
    '6600': 'uebriger_betrieblicher_aufwand',
    '6700': 'uebriger_betrieblicher_aufwand',
    '6800': 'abschreibungen',
    '6900': 'finanzergebnis',
    '6949': 'finanzergebnis',
    // Ziff. 10 direkte Steuern: the 89xx band, never ausserordentlicher Erfolg (A38).
    '8900': 'direkte_steuern',
  };
  for (const account of KMU_CORE_SEED) {
    if (account.type !== 'income' && account.type !== 'expense') continue;
    assert.equal(erfolgSectionFor(account), expected[account.number], `account ${account.number} ${account.name}`);
  }
  assert.equal(Object.keys(expected).length, KMU_CORE_SEED.filter((a) => a.type === 'income' || a.type === 'expense').length);
});

test('the 1400 liquidity boundary: OR Art. 959a Abs. 1s split, at the exact number', () => {
  // THE most consequential classification boundary on the Bilanz, and it was untested: the shipped
  // KMU seed has no 14xx account at all, so moving the boundary from 1400 to 1500 left every case
  // green. It is the Umlaufvermögen / Anlagevermögen split, which is Abs. 1's whole ordering
  // principle ("ihrem Liquiditätsgrad entsprechend"), and getting it wrong moves an asset between
  // two statutory positions while the Bilanz keeps footing to the Rappen.
  //
  // Asserted at the boundary rather than in the middle of each range, so a fence moved by one is
  // caught. 1400 is the first Anlagevermögen number in the Kontenrahmen KMU.
  assert.equal(bilanzSectionFor({ number: '1399', type: 'asset' }), 'umlaufvermoegen');
  assert.equal(bilanzSectionFor({ number: '1400', type: 'asset' }), 'anlagevermoegen');
  assert.equal(bilanzSectionFor({ number: '1499', type: 'asset' }), 'anlagevermoegen');
  // And the two outer edges of the asset band, which decide Umlaufvermögen against the residual.
  assert.equal(bilanzSectionFor({ number: '1000', type: 'asset' }), 'umlaufvermoegen');
  assert.equal(bilanzSectionFor({ number: '1999', type: 'asset' }), 'anlagevermoegen');
  assert.equal(bilanzSectionFor({ number: '2000', type: 'asset' }), 'uebrige_aktiven');
  // The maturity split on the Passiven, at its own two boundaries (Abs. 2).
  assert.equal(bilanzSectionFor({ number: '2399', type: 'liability' }), 'kurzfristiges_fremdkapital');
  assert.equal(bilanzSectionFor({ number: '2400', type: 'liability' }), 'langfristiges_fremdkapital');
  assert.equal(bilanzSectionFor({ number: '2799', type: 'liability' }), 'langfristiges_fremdkapital');
  assert.equal(bilanzSectionFor({ number: '2800', type: 'liability' }), 'uebrige_passiven');
  // Equity is decided by TYPE, not by number, because the equity block sits inside the 2xxx range.
  assert.equal(bilanzSectionFor({ number: '2800', type: 'equity' }), 'eigenkapital');
  // A number SHORTER than four digits scales UP, keeping its leading digits, so '999' is class 9 and
  // lands in the residual rather than being read as a 0999 current asset. Written down because the
  // first draft of this case assumed the opposite.
  assert.equal(bilanzSectionFor({ number: '999', type: 'asset' }), 'uebrige_aktiven');
  assert.equal(bilanzSectionFor({ number: '14', type: 'asset' }), 'anlagevermoegen');
  assert.equal(bilanzSectionFor({ number: '13', type: 'asset' }), 'umlaufvermoegen');
});

test('the Erfolgsrechnung position boundaries, at the exact number', () => {
  // The same treatment for OR Art. 959b Abs. 2's ranges, whose neighbours are easy to slide.
  assert.equal(erfolgSectionFor({ number: '3899' }), 'netto_erloese');
  assert.equal(erfolgSectionFor({ number: '3900' }), 'bestandes_aenderungen');
  assert.equal(erfolgSectionFor({ number: '3999' }), 'bestandes_aenderungen');
  assert.equal(erfolgSectionFor({ number: '4000' }), 'materialaufwand');
  assert.equal(erfolgSectionFor({ number: '4999' }), 'materialaufwand');
  assert.equal(erfolgSectionFor({ number: '5000' }), 'personalaufwand');
  assert.equal(erfolgSectionFor({ number: '6799' }), 'uebriger_betrieblicher_aufwand');
  assert.equal(erfolgSectionFor({ number: '6800' }), 'abschreibungen');
  assert.equal(erfolgSectionFor({ number: '6899' }), 'abschreibungen');
  assert.equal(erfolgSectionFor({ number: '6900' }), 'finanzergebnis');
  assert.equal(erfolgSectionFor({ number: '7000' }), 'betriebsfremder_erfolg');
  assert.equal(erfolgSectionFor({ number: '8899' }), 'ausserordentlicher_erfolg');
  assert.equal(erfolgSectionFor({ number: '8900' }), 'direkte_steuern');
  // Class 9 is the Abschluss class and belongs to no statement position, so it must NOT be folded
  // into direkte Steuern next door.
  assert.equal(erfolgSectionFor({ number: '9000' }), 'uebrige_positionen');
});

test('no account can fall off the edge: an unnumbered or out-of-range account still lands', () => {
  // `account.number` is free text (A01 validates only that it is non-empty), so these are reachable
  // states and not hypotheticals. A dropped account shrinks its line AND its subtotal by the same
  // amount, so the statement would still foot and only the coverage check would notice.
  assert.equal(bilanzSectionFor({ number: 'Sonderkonto', type: 'asset' }), 'uebrige_aktiven');
  assert.equal(bilanzSectionFor({ number: '9100', type: 'liability' }), 'uebrige_passiven');
  assert.equal(bilanzSectionFor({ number: 'x', type: 'equity' }), 'eigenkapital');
  assert.equal(erfolgSectionFor({ number: '9200' }), 'uebrige_positionen');
  assert.equal(erfolgSectionFor({ number: 'Sonstiges' }), 'uebrige_positionen');
  // A six-digit chart classifies on its leading digits rather than falling past every range.
  assert.equal(bilanzSectionFor({ number: '100000', type: 'asset' }), 'umlaufvermoegen');
  assert.equal(erfolgSectionFor({ number: '680000' }), 'abschreibungen');
  assert.equal(erfolgSectionFor({ number: '68' }), 'abschreibungen');
});

// --- The rendered statements carry the structure, not just the map ------------------------------

test('the rendered Bilanz prints all seven sections even when a period has nothing in them', () => {
  const t = setup();
  seedBooks(t);
  const res = computeBalanceSheet(t.ctx, { asOf: '2026-03-31' });
  assert.deepEqual(res.sections.map((s) => s.key), BILANZ_SECTIONS.map((s) => s.key));
  assert.deepEqual(res.sections.map((s) => s.cite), BILANZ_SECTIONS.map((s) => s.cite));
  // The two residuals are genuinely empty here, and they still render, at zero.
  assert.deepEqual(res.sections.filter((s) => s.lines.length === 0).map((s) => s.key), [
    'uebrige_aktiven',
    'uebrige_passiven',
  ]);
});

test('the rendered Erfolgsrechnung prints the eleven positions in the statutory order', () => {
  const t = setup();
  seedBooks(t);
  const res = computeIncomeStatement(t.ctx, { periodStart: '2026-01-01', periodEnd: '2026-03-31' });
  assert.deepEqual(res.sections.map((s) => s.key), ERFOLG_SECTIONS.map((s) => s.key));
  assert.deepEqual(res.sections.map((s) => s.nature), ERFOLG_SECTIONS.map((s) => s.nature));
});
