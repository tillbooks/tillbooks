/**
 * SYNTHETIC adapter fixtures (G18 US-G18.5). Every fixture here is authored from the format's PUBLISHED
 * shape (the `cleanRoomSource` on each registry row), NOT reduced from a real vendor export: the values
 * (names, figures, accounts) are invented, and only the STRUCTURE (headers, delimiter, XML envelope) is
 * the documented one. No `node:fs`: a fixture is a string constant, so the adapters stay pure and a
 * golden-fixture test imports the exact bytes it parses. de-CH strings use real umlauts.
 *
 * These prove the PARSE arms. Column PRESETS are a separate concern and ship empty (there are no
 * anonymised real-export presets in the repo, spec §2 "the fixture rule"): a preset entry with no
 * fixture backing does not ship, so the registry rows carry `columnPresets: []`.
 */

/** bexio and the generic CSV path: a semicolon-delimited contacts export (the ch-de ERP default). */
export const BEXIO_CONTACTS_CSV = `Name;Ort;Konto
Muster AG;Zürich;1100
Beispiel GmbH;Bern;1101
Übung AG;Genève;1102
`;

/** Banana Accounting: TAB-separated, case-sensitive English headers, ISO dates, decimal point. */
export const BANANA_TRANSACTIONS_TSV =
  ['Date\tDescription\tAccountDebit\tAccountCredit\tAmount\tVatCode',
   '2025-01-05\tBüromaterial\t6500\t1020\t120.00\tVSt81',
   '2025-01-31\tHonorar Beratung\t1100\t3400\t5400.00\tUSt81',
   '2025-02-14\tMiete Februar\t6000\t1020\t1500.00\t'].join('\n') + '\n';

/** Crésus Comptabilité: TAB-separated, CR+LF lines, French journal headers, Swiss number style. */
export const CRESUS_JOURNAL_TSV =
  ['Date\tN° pièce\tCompte débit\tCompte crédit\tLibellé\tMontant',
   "2025-01-05\t1\t6500\t1020\tFournitures de bureau\t120.00",
   "2025-01-31\t2\t1100\t3400\tHonoraires\t5'400.00"].join('\r\n') + '\r\n';

/** Abacus AbaConnect: the published XML envelope, an ADRE (address / contacts) export of two records. */
export const ABACUS_CONTACTS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<AbaConnectContainer>
  <TaskCount>1</TaskCount>
  <Task>
    <Parameter>
      <Application>ADRE</Application>
      <Id>HierarchyAddress</Id>
      <MapId>AbaDefault</MapId>
      <Version>2024.10</Version>
    </Parameter>
    <Transaction>
      <Address mode="SAVE">
        <AddressNumber>1001</AddressNumber>
        <LastName>Muster</LastName>
        <FirstName>Hans</FirstName>
        <Country>CH</Country>
        <ZIP>8000</ZIP>
        <City>Zürich</City>
      </Address>
      <Address mode="SAVE">
        <AddressNumber>1002</AddressNumber>
        <LastName>Beispiel</LastName>
        <FirstName>Anna</FirstName>
        <Country>CH</Country>
        <ZIP>3000</ZIP>
        <City>Bern</City>
      </Address>
    </Transaction>
  </Task>
</AbaConnectContainer>
`;

/**
 * The XML PARTS of a synthetic `.xlsx` workbook, so a test (or a caller) can pack them into a valid
 * Open Packaging Convention zip with the shared zip writer. Two worksheets, so the worksheet catalog is
 * non-trivial; the first carries a header row (Name, Ort, Konto) and two data rows, one via a shared
 * string and one inline, plus a numeric and a cached-formula cell, to exercise the typed-cell reader.
 */
export const XLSX_PARTS: Readonly<Record<string, string>> = {
  '[Content_Types].xml':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>` +
    `</Types>`,
  '_rels/.rels':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`,
  'xl/workbook.xml':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>` +
    `<sheet name="Kontakte" sheetId="1" r:id="rId1"/>` +
    `<sheet name="Notizen" sheetId="2" r:id="rId2"/>` +
    `</sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>` +
    `<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>` +
    `</Relationships>`,
  'xl/sharedStrings.xml':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">` +
    `<si><t>Name</t></si><si><t>Ort</t></si><si><t>Konto</t></si><si><t>Muster AG</t></si>` +
    `</sst>`,
  // Row 1: header (three shared strings). Row 2: an inline-string name, a shared-string Ort, a number.
  // Row 3: a shared-string name, an inline Ort, and a CACHED FORMULA value (the <f> is never evaluated).
  'xl/worksheets/sheet1.xml':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
    `<row r="2"><c r="A2" t="inlineStr"><is><t>Beispiel GmbH</t></is></c><c r="B2" t="inlineStr"><is><t>Bern</t></is></c><c r="C2"><v>1101</v></c></row>` +
    `<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" t="inlineStr"><is><t>Zürich</t></is></c><c r="C3"><f>1100+2</f><v>1102</v></c></row>` +
    `</sheetData></worksheet>`,
  'xl/worksheets/sheet2.xml':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData></sheetData></worksheet>`,
};

/** A worksheet whose only row is the header, so the empty-workbook contract (`rowCount:0`) is testable. */
export const XLSX_HEADER_ONLY_PARTS: Readonly<Record<string, string>> = {
  '[Content_Types].xml': XLSX_PARTS['[Content_Types].xml'] as string,
  '_rels/.rels': XLSX_PARTS['_rels/.rels'] as string,
  'xl/workbook.xml':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="Leer" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `</Relationships>`,
  'xl/worksheets/sheet1.xml':
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>` +
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c><c r="B1" t="inlineStr"><is><t>Ort</t></is></c></row>` +
    `</sheetData></worksheet>`,
};

/*
 * ---------------------------------------------------------------------------------------------------
 * BEXIO EXPORT FIXTURES (US-G18.1, "the fixture rule").
 *
 * These carry the REAL bexio export HEADERS (the clean-room-safe part: the documented export layout,
 * observed from a real bexio account and help.bexio.com) with ANONYMISED, INVENTED values. No real
 * company data lands in the repo: only the header row of each class is a fact, the rows below are made
 * up. Every `bexio_csv` column preset in `../registry.ts` traces to a header here (the g18-adapters
 * "unbacked preset never ships" test walks it). bexio de-CH exports are semicolon-delimited with a
 * `.` decimal point, which `parseGenericCsv` detects from the header line.
 */

/**
 * OPENING BALANCES: the bexio Saldenliste (account balances). Three columns; `Kontonummer` is the KMU
 * account and `Saldo` its balance (bexio sign convention: assets/expenses positive, equity/liabilities/
 * income negative, so the leaf accounts sum to zero). `Name` carries no neutral field and stays mapped
 * to nothing, which is correct. The rows below balance to 0.00.
 */
export const BEXIO_SALDENLISTE_CSV = [
  'Kontonummer;Name;Saldo',
  '1020;Bank Kontokorrent;10000.00',
  '1100;Forderungen aus Lieferungen und Leistungen;5000.00',
  '2200;Geschuldete MWST (Umsatzsteuer);-1200.00',
  '2800;Eigenkapital;-13800.00',
].join('\n') + '\n';

/**
 * GL HISTORY: the bexio Buchungen/Journal export, the source for the G13 read-only archive. Soll/Haben
 * are the debit/credit ACCOUNTS (with their names, as bexio writes them), `Betrag` the value, and the
 * export carries the multi-currency trio (`Buchungswährung`, `Umrechnungsfaktor`, base-currency amount).
 * Row 1 is a foreign-currency (USD) line like a real bexio bank booking; `Id` is bexio's booking id
 * (the `source_entry_id` match key, no neutral column field) and stays unmapped, as do the FX-detail
 * columns and the base-currency pair.
 */
export const BEXIO_JOURNAL_CSV = [
  'Id;Datum;Referenz;Soll;Haben;Beschreibung;Betrag;Buchungswährung;Umrechnungsfaktor;Betrag in Basiswährung;Währung in Basiswährung;MWST',
  '1;05.01.2026;Bank Buchung 1;6570 - EDV- und Lizenzaufwand;1020 - Bank Kontokorrent;Cloud-Hosting;8.43;USD;0.7829180000;6.60;CHF;',
  '2;31.01.2026;RG-2026-001;1100 - Forderungen;3400 - Dienstleistungsertrag;Beratung Januar;5400.00;CHF;1.0000000000;5400.00;CHF;UN81',
  '3;14.02.2026;Bank Buchung 2;6000 - Raumaufwand;1020 - Bank Kontokorrent;Büromiete Februar;1500.00;CHF;1.0000000000;1500.00;CHF;VM81',
].join('\n') + '\n';

/**
 * CHART OF ACCOUNTS: the bexio Kontenplan export. `Nummer*`/`Name*`/`Gruppe*`/`Kontoart*` describe the
 * KMU chart; `Systemkonto` tags the bexio system role and `Steuertyp` the default tax handling. The
 * numbers are the standard Kontenrahmen KMU (identity-mappable onto TILL's seeded chart), so a group
 * row (`Kontoart* = Gruppe`) and leaf accounts are both shown.
 */
export const BEXIO_CHART_CSV = [
  'Nummer*;Name*;Gruppe*;Kontoart*;Systemkonto;Steuertyp',
  '1;Aktiven;;Gruppe;ASSETS;',
  '1020;Bank Kontokorrent;10;Aktivkonto;;',
  '2200;Geschuldete MWST (Umsatzsteuer);22;Passivkonto;;UN81',
  '3400;Dienstleistungsertrag;34;Ertragskonto;;UN81',
  '6570;EDV- und Lizenzaufwand;65;Aufwandskonto;;VM81',
].join('\n') + '\n';

/**
 * CONTACTS: the FULL bexio contacts export header (38 columns), so the contacts adapter path is proven
 * on the real column shape (the shorter `BEXIO_CONTACTS_CSV` above stays as the minimal generic sample).
 * Two anonymised rows: a company and a private person, with real umlauts.
 */
export const BEXIO_CONTACTS_FULL_CSV = [
  'Kontakt Nr.;Kontaktart;Kontaktart Beschreibung;Firma;Firmennamen-Zusatz;Nachname;Vorname;Kontakt Nr. der verknüpften Firma;Name der verknüpften Firma;Verknüpfungsinformation;Anrede;Titel;Geburtstag;Adresse;Strasse;Haus-Nr.;Adresszusatz;PLZ;Ort;Land;E-Mail;E-Mail 2;Telefon;Telefon 2;Mobile;Fax;Website;Skype;Sprache;Korrespondenzweg;Ansprechpartner;MWST-Nummer;Anzahl Mitarbeitende;Handelsregister-Nr.;Umsatzsteuer-Identifikationsnummer;Kategorie;Branche;Bemerkungen',
  '1;1;Firma;Muster AG;;;;;;;;;;Musterstrasse 1;;;;8000;Zürich;Schweiz;kontakt@muster.example;;+41 44 000 00 00;;;;https://muster.example;;de;E-Mail;;CHE-123.456.789 MWST;5;CH-020.4.000.000-0;;Kunde;;',
  '2;2;Privat;;;Beispiel;Anna;;;;Frau;;1980-01-01;Beispielweg 2;;;;3000;Bern;Schweiz;anna@beispiel.example;;;;+41 79 000 00 00;;;;de;Post;;;0;;;Lieferant;;',
].join('\n') + '\n';
