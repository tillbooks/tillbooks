// A01 §8, seed reference fixture.
//
// Verifies the accounts that the money path DEPENDS ON, the ones a wrong number would ripple through:
// the equity carry block A03's year-close targets and the VAT accounts A05 references.
//
// PROVENANCE (owner decision D1, 2026-07-19): the account NUMBERS are the standard Swiss SME
// numbering (unprotectable, and interoperability depends on them); the STRUCTURE follows OR
// Art. 959a/959b (public domain under URG Art. 5); the LABELS are TILL's own clean-room wording in
// de-CH / fr / it / en, using the statutory OR headings verbatim where the statute prescribes one.
// No text from the veb.ch chart, Odoo l10n_ch, the ERPNext chart JSON, or Gäld was reproduced.
// EXPECTED_LABELS below is the source of truth for the seed. The seed is a customizable DEFAULT, not
// a closed set: A01 createAccount lets a workspace add or change anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KMU_CORE_SEED } from '../../dist/core/accounts/index.js';
import { createWorkspace } from '../../dist/core/setup/index.js';
import { createAccount, listAccounts } from '../../dist/core/accounts/index.js';
import { makeContext } from '../../dist/core/context.js';
import { SqliteStore } from '../../dist/core/store/sqlite-store.js';
import { fixedClock } from '../../dist/core/clock.js';
import { sequenceIdGen } from '../../dist/core/ids.js';

const byNumber = Object.fromEntries(KMU_CORE_SEED.map((a) => [a.number, a]));

// The money-path-critical accounts, confirmed number + type against the standard Swiss SME numbering.
// A03's year-close carries the result 2979 -> 2970 (both equity); A05 posts VAT through 1170/2200/2201.
const CONFIRMED = [
  { number: '2800', type: 'equity' }, // Grund-, Gesellschafter- oder Stiftungskapital
  { number: '2850', type: 'equity' }, // Privatkonto
  { number: '2970', type: 'equity' }, // Gewinnvortrag oder Verlustvortrag (year-close carry target)
  { number: '2979', type: 'equity' }, // Jahresgewinn oder Jahresverlust (year-close result)
  { number: '1170', type: 'asset' }, // Vorsteuer Material- und Dienstleistungsaufwand
  { number: '1171', type: 'asset' }, // Vorsteuer Investitionen und übriger Betriebsaufwand
  { number: '2200', type: 'liability' }, // Geschuldete MWST
  { number: '2201', type: 'liability' }, // Abrechnungskonto MWST
];

test('the money-path-critical accounts are present with the correct KMU type', () => {
  for (const c of CONFIRMED) {
    const seeded = byNumber[c.number];
    assert.ok(seeded, `account ${c.number} is in the seed`);
    assert.equal(seeded.type, c.type, `account ${c.number} is typed ${c.type}`);
  }
});

test('the year-close carry accounts 2979 and 2970 are both equity (A03 depends on this)', () => {
  assert.equal(byNumber['2979'].type, 'equity');
  assert.equal(byNumber['2970'].type, 'equity');
});

test('every seed account follows the KMU number-range type rule', () => {
  // 1xxx asset; 2xxx liability EXCEPT the equity block (2800/2850/2970/2979); 3xxx income;
  // 4xxx-6xxx expense. This is the mapping A08 statements and the year-close read.
  const equityBlock = new Set(['2800', '2850', '2970', '2979']);
  for (const a of KMU_CORE_SEED) {
    const lead = a.number[0];
    let expected;
    if (lead === '1') expected = 'asset';
    else if (lead === '2') expected = equityBlock.has(a.number) ? 'equity' : 'liability';
    else if (lead === '3') expected = 'income';
    else if (lead === '4' || lead === '5' || lead === '6') expected = 'expense';
    assert.equal(a.type, expected, `account ${a.number} (${a.name}) type`);
  }
});

// The full seed labels, in [de-CH, fr, it, en] order. Clean-room wording (D1); the entries marked
// OR are the statutory Mindestgliederung headings from OR Art. 959a/959b, used verbatim because a
// statute is public domain (URG Art. 5) and it is the wording an auditor reads.
const EXPECTED_LABELS = {
  '1000': ['Kassenbestand', 'Espèces en caisse', 'Contanti in cassa', 'Cash on hand'],
  '1020': ['Bankkonto', 'Compte bancaire', 'Conto bancario', 'Bank account'],
  '1060': ['Kurzfristig gehaltene Wertpapiere', 'Titres détenus à court terme', 'Titoli detenuti a breve termine', 'Short-term securities'],
  // OR 959a I.1.b
  '1100': ['Forderungen aus Lieferungen und Leistungen', 'Créances résultant de la vente de biens et de prestations de services', 'Crediti da forniture e prestazioni', 'Trade receivables'],
  '1109': ['Wertberichtigung auf Forderungen', 'Correctif de valeur sur créances', 'Rettifica di valore su crediti', 'Allowance for doubtful receivables'],
  // ESTV MWST-Abrechnung, Ziffer 400 / Ziffer 405
  '1170': ['Vorsteuer auf Material- und Dienstleistungsaufwand', 'Impôt préalable sur charges de matériel et de services', 'Imposta precedente su costi per materiale e prestazioni', 'Input VAT on material and service costs'],
  '1171': ['Vorsteuer auf Investitionen und übrigem Betriebsaufwand', "Impôt préalable sur investissements et autres charges d'exploitation", "Imposta precedente su investimenti e altri costi d'esercizio", 'Input VAT on investments and other operating costs'],
  '1176': ['Guthaben Verrechnungssteuer', "Créance d'impôt anticipé", "Credito d'imposta preventiva", 'Withholding tax receivable'],
  '1200': ['Vorräte Handelswaren', 'Stocks de marchandises', 'Scorte di merci', 'Merchandise inventory'],
  // OR 959a I.1.e
  '1300': ['Aktive Rechnungsabgrenzung', 'Actifs de régularisation', 'Ratei e risconti attivi', 'Accrued income and prepaid expenses'],
  '1500': ['Maschinen und Produktionsanlagen', 'Machines et installations de production', 'Macchine e impianti di produzione', 'Machinery and production equipment'],
  '1510': ['Betriebseinrichtungen und Mobiliar', "Installations d'exploitation et mobilier", 'Installazioni aziendali e mobilio', 'Fixtures and furniture'],
  '1520': ['Informatik- und Kommunikationsanlagen', 'Équipements informatiques et de communication', 'Apparecchiature informatiche e di comunicazione', 'IT and communication equipment'],
  '1530': ['Fahrzeuge', 'Véhicules', 'Veicoli', 'Vehicles'],
  // OR 959a II.1.a
  '2000': ['Verbindlichkeiten aus Lieferungen und Leistungen', "Dettes résultant de l'achat de biens et de prestations de services", 'Debiti per forniture e prestazioni', 'Trade creditors'],
  '2100': ['Kurzfristige Bankschulden', 'Dettes bancaires à court terme', 'Debiti bancari a breve termine', 'Short-term bank liabilities'],
  '2200': ['Geschuldete MWST auf Erlösen', "TVA due sur le chiffre d'affaires", "IVA dovuta sulla cifra d'affari", 'VAT payable on revenue'],
  '2201': ['MWST-Abrechnung mit der ESTV', "Décompte TVA avec l'AFC", "Rendiconto IVA con l'AFC", 'VAT settlement account with the FTA'],
  // Übrige kurzfristige Verbindlichkeiten (OR 959a II.1.c); TILL's own wording. E02 employee-payable
  // (D95): 2270 is the canonical social-insurance current account, so this takes the free 2260 slot.
  '2260': ['Verbindlichkeiten gegenüber Personal', 'Dettes envers le personnel', 'Debiti verso il personale', 'Payables to employees'],
  // OR 959a II.1.d
  '2300': ['Passive Rechnungsabgrenzung', 'Passifs de régularisation', 'Ratei e risconti passivi', 'Deferred income and accrued expenses'],
  '2400': ['Langfristige Bankschulden', 'Dettes bancaires à long terme', 'Debiti bancari a lungo termine', 'Long-term bank liabilities'],
  '2450': ['Langfristige Darlehen', 'Prêts à long terme', 'Prestiti a lungo termine', 'Long-term loans'],
  // OR 959a II.2.c
  '2600': ['Rückstellungen', 'Provisions', 'Accantonamenti', 'Provisions'],
  // OR 959a II.3.a
  '2800': ['Grund-, Gesellschafter- oder Stiftungskapital', 'Capital social ou capital de la fondation', 'Capitale sociale o capitale della fondazione', 'Basic, shareholder or foundation capital'],
  '2850': ['Privatkonto', 'Compte privé', 'Conto privato', "Owner's drawings account"],
  // OR 959a II.3.f
  '2970': ['Gewinnvortrag oder Verlustvortrag', 'Bénéfice ou perte reporté', 'Utile o perdita riportati', 'Profit carried forward or loss carried forward'],
  // OR 959a II.3.g / 959b 2.11
  '2979': ['Jahresgewinn oder Jahresverlust', "Bénéfice ou perte de l'exercice", "Utile o perdita dell'esercizio", 'Annual profit or annual loss'],
  '3000': ['Erlöse aus eigener Produktion', 'Produits de la production propre', 'Ricavi da produzione propria', 'Revenue from own production'],
  '3200': ['Erlöse aus Handelswaren', 'Produits de la vente de marchandises', 'Ricavi dalla vendita di merci', 'Revenue from merchandise sales'],
  '3400': ['Erlöse aus Dienstleistungen', 'Produits des prestations de services', 'Ricavi da prestazioni di servizi', 'Revenue from services'],
  '3600': ['Übrige betriebliche Erlöse', "Autres produits d'exploitation", "Altri ricavi d'esercizio", 'Other operating revenue'],
  '3800': ['Rabatte, Skonti und Gutschriften', 'Rabais, escomptes et notes de crédit', 'Ribassi, sconti e note di credito', 'Discounts, rebates and credit notes'],
  // The P&L counterpart of 1109, and A14's write-off target.
  '3805': ['Verluste aus Forderungen und Veränderung der Wertberichtigung', 'Pertes sur créances et variation du correctif de valeur', 'Perdite su crediti e variazione della rettifica di valore', 'Losses on receivables and change in the allowance'],
  // A14's realised currency difference on clearing a RECEIVABLE. An Erlösminderung, because
  // settling a trade receivable is operating activity, and bidirectional so a gain and a loss net.
  '3806': ['Kursdifferenzen auf Forderungen', 'Différences de change sur créances', 'Differenze di cambio su crediti', 'Exchange rate differences on receivables'],
  '4000': ['Materialaufwand Fertigung', 'Charges de matériel de fabrication', 'Costi per il materiale di produzione', 'Production material costs'],
  '4200': ['Einkauf Handelswaren', 'Achats de marchandises', 'Acquisto di merci', 'Merchandise purchases'],
  '4400': ['Bezogene Fremdleistungen', 'Prestations de tiers', 'Prestazioni di terzi', 'Third-party services purchased'],
  // The purchase-side mirror of 3800 (the collective Aufwandminderung).
  '4900': ['Erhaltene Rabatte und Skonti', 'Rabais et escomptes obtenus', 'Ribassi e sconti ottenuti', 'Discounts and rebates received'],
  // 3806's purchase-side twin, for a difference realised on clearing a PAYABLE.
  '4906': ['Kursdifferenzen auf Verbindlichkeiten', 'Différences de change sur dettes', 'Differenze di cambio su debiti', 'Exchange rate differences on payables'],
  '5000': ['Löhne und Gehälter', 'Salaires et traitements', 'Salari e stipendi', 'Wages and salaries'],
  '5700': ['Sozialversicherungsbeiträge Arbeitgeber', "Cotisations sociales de l'employeur", 'Contributi sociali del datore di lavoro', 'Employer social security contributions'],
  '5800': ['Übrige Personalkosten', 'Autres frais de personnel', 'Altri costi del personale', 'Other personnel costs'],
  '6000': ['Miete und Nebenkosten Geschäftsräume', 'Loyer et charges des locaux commerciaux', 'Affitto e spese accessorie dei locali commerciali', 'Rent and utilities for business premises'],
  '6100': ['Unterhalt und Reparaturen an Anlagen', 'Entretien et réparations des installations', 'Manutenzione e riparazioni degli impianti', 'Maintenance and repairs of equipment'],
  '6200': ['Fahrzeug- und Transportkosten', 'Frais de véhicules et de transport', 'Costi di veicoli e trasporto', 'Vehicle and transport costs'],
  '6300': ['Versicherungen, Gebühren und Bewilligungen', 'Assurances, taxes et autorisations', 'Assicurazioni, tasse e autorizzazioni', 'Insurance, fees and permits'],
  '6400': ['Energie und Entsorgung', 'Énergie et élimination des déchets', 'Energia e smaltimento', 'Energy and waste disposal'],
  '6500': ['Verwaltungs- und Bürokosten', "Frais d'administration et de bureau", 'Costi amministrativi e di ufficio', 'Administrative and office costs'],
  '6570': ['Informatik, Software und Lizenzen', 'Informatique, logiciels et licences', 'Informatica, software e licenze', 'IT, software and licences'],
  '6600': ['Werbung und Marketing', 'Publicité et marketing', 'Pubblicità e marketing', 'Advertising and marketing'],
  // OR 959b 2.5
  '6700': ['Übriger betrieblicher Aufwand', "Autres charges d'exploitation", "Altri costi d'esercizio", 'Other operating expenses'],
  // OR 959b 2.6
  '6800': ['Abschreibungen und Wertberichtigungen auf Positionen des Anlagevermögens', "Amortissements et corrections de valeur sur les postes de l'actif immobilisé", "Ammortamenti e rettifiche di valore sulle poste dell'attivo fisso", 'Depreciation and value adjustments on fixed assets'],
  // OR 959b 2.7 (the expense half)
  '6900': ['Finanzaufwand', 'Charges financières', 'Costi finanziari', 'Financial expenses'],
  // The currency loss on a FINANCIAL position, for A22's period-end revaluation. A14's realised
  // difference on a TRADE settlement goes to 3806 / 4906 instead: a different event, a different
  // account. In the standard numbering 6949 is the loss account; its gain twin 6999 is an Ertrag
  // and is left out of the 4xxx-6xxx block.
  '6949': ['Währungsverluste', 'Pertes de change', 'Perdite di cambio', 'Currency losses'],
};

test('every seed account carries its clean-room label in all four languages', () => {
  for (const [number, [de, fr, it, en]] of Object.entries(EXPECTED_LABELS)) {
    const seeded = byNumber[number];
    assert.ok(seeded, `account ${number} is in the seed`);
    assert.equal(seeded.labels.de, de, `account ${number} de-CH label`);
    assert.equal(seeded.labels.fr, fr, `account ${number} fr label`);
    assert.equal(seeded.labels.it, it, `account ${number} it label`);
    assert.equal(seeded.labels.en, en, `account ${number} en label`);
  }
});

test('the default account name is the de-CH label (single-sourced, no drift)', () => {
  for (const a of KMU_CORE_SEED) {
    assert.equal(a.name, a.labels.de, `account ${a.number} name equals its de-CH label`);
  }
});

test('no label in any of the four languages is empty', () => {
  for (const a of KMU_CORE_SEED) {
    for (const lang of ['de', 'fr', 'it', 'en']) {
      const label = a.labels[lang];
      assert.equal(typeof label, 'string', `account ${a.number} has a ${lang} label`);
      assert.ok(label.trim().length > 0, `account ${a.number} ${lang} label is not empty`);
    }
  }
});

test('the seed and the fixture agree on their full account set (no drift)', () => {
  assert.deepEqual(
    KMU_CORE_SEED.map((a) => a.number).sort(),
    Object.keys(EXPECTED_LABELS).sort(),
    'every seeded number is pinned in the fixture and vice versa',
  );
});

test('the standard numbering holds: 2450 is the long-term loan account and 2451 is not seeded', () => {
  assert.ok(byNumber['2450'], '2450 exists');
  assert.equal(byNumber['2450'].name, 'Langfristige Darlehen');
  assert.equal(byNumber['2451'], undefined, '2451 is not part of this core seed');
});

test('no de-CH label uses ASCII umlaut transliteration (ae/oe/ue) or a sharp-s', () => {
  for (const a of KMU_CORE_SEED) {
    assert.ok(!/ß/.test(a.labels.de), `account ${a.number} (${a.name}) must not contain a sharp-s`);
  }
  // The specific transliterations the seed used to carry are all gone.
  const banned = ['Bueromaschinen', 'Bueromaterial', 'Erloes', 'Uebrig', 'uebrig', 'Rueckstell', 'Gebuehren', 'erloese', 'fuer Drittleistungen'];
  for (const a of KMU_CORE_SEED) {
    for (const b of banned) {
      assert.ok(!a.labels.de.includes(b), `account ${a.number} (${a.name}) still transliterates "${b}"`);
    }
  }
});

test('the seed is a customizable DEFAULT: a workspace can freely add accounts beyond it', () => {
  const store = new SqliteStore({ clock: fixedClock('2026-07-16T00:00:00.000Z') });
  const ids = sequenceIdGen();
  const minted = createWorkspace({ store, clock: fixedClock('2026-07-16T00:00:00.000Z'), ids }, { name: 'Acme GmbH' });
  const ctx = makeContext(store, { workspaceId: minted.workspaceId, clock: fixedClock('2026-07-16T00:00:00.000Z'), ids });

  const before = listAccounts(ctx).accounts.length;
  const added = createAccount(ctx, { number: '3901', name: 'Eigener Ertrag', type: 'income' });
  assert.equal(added.ok, true, 'a workspace adds its own account on top of the seed');
  const after = listAccounts(ctx).accounts.length;
  assert.equal(after, before + 1);
  assert.ok(listAccounts(ctx).accounts.find((a) => a.number === '3901'));
});
