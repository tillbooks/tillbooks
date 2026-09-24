#!/usr/bin/env node
/**
 * Regenerates the two Bank Transaction Code fixtures from their upstream sources.
 *
 *   node scripts/extract-btc.mjs           rewrite the fixtures in place
 *   node scripts/extract-btc.mjs --check    regenerate and fail if anything drifted
 *
 * Both fixtures declare themselves machine-generated, so this is the thing that makes that claim
 * true. It is a maintenance script, not a build or CI step: it needs the network, and the test
 * suite stays offline by design. Run it when SIX or ISO publish a revision.
 *
 * The source workbooks are deliberately NOT vendored into the repo. They are third-party
 * publications, and this repo is heading for an MIT release.
 *
 * [GOTCHA] iso20022.org times out on its HTML pages while serving /sites/default/files/ perfectly
 * well. Fetch the file paths directly and never try to scrape the landing page for links.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { readWorkbook, readDocxText } from './lib/xlsx.mjs';
import { readLegacyWorkbook } from './lib/xls.mjs';

const ROOT = new URL('../', import.meta.url);
const CHECK = process.argv.includes('--check');

const SOURCES = {
  six: {
    url: 'https://www.six-group.com/dam/download/banking-services/standardization/sps/btc-codes-sps-en.xlsx',
    out: 'test/fixtures/btc-codes-sps-ch.json',
  },
  isoCodification: {
    url: 'https://www.iso20022.org/sites/default/files/media/file/BTC_Codification_30October2023.xls',
    out: 'test/fixtures/btc-codes-iso-20022.json',
  },
  isoDescription: {
    url: 'https://www.iso20022.org/sites/default/files/media/file/BTC_ExternalCodeListDescription_May2025_v2.docx',
  },
};

/** Expected upstream versions. A mismatch means the sources moved and this script needs review. */
const EXPECTED = { sixVersion: '1.0', isoCodification: 'v7.0', isoDescription: '7.1' };

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Folds the typographic variants SIX uses into plain characters.
 *
 * The workbook mixes soft hyphens, non-breaking hyphens and en dashes inside otherwise identical
 * labels, so "Real-Time" and "Real&#8209;Time" both occur. Code values are never touched.
 */
function normalize(s) {
  return s
    .replace(/­/g, '') // soft hyphen
    .replace(/[‑–]/g, '-') // non-breaking hyphen, en dash
    .trim();
}

const isCode = (s) => /^[A-Z]{4}$/.test((s ?? '').trim());

/** Rows carrying a domain and family code, in sheet order. */
function codeRows(rows) {
  const out = [];
  for (const r of rows) {
    const [domainName, familyName, subFamilyName, domain, family, subFamily, individualization] = [
      0, 1, 2, 3, 4, 5, 6,
    ].map((i) => normalize(r[i] ?? ''));
    if (!isCode(domain) || !isCode(family)) continue;

    const row = {
      domain,
      family,
      subFamily: isCode(subFamily) ? subFamily : null,
      domainName,
      familyName,
      subFamilyName,
      swissMarketIndividualization: individualization,
    };
    // Two Real-Time rows carry prose where a sub-family code belongs. Preserve the prose rather
    // than inventing a code to fill the hole.
    if (!isCode(subFamily) && subFamily) row.subFamilyNote = subFamily;
    out.push(row);
  }
  return out;
}

function buildSixFixture(book) {
  const sheet = (needle) => {
    const hit = Object.entries(book).find(([name]) => name.toLowerCase().includes(needle));
    if (!hit) throw new Error(`no sheet matching "${needle}" in the SIX workbook`);
    return hit[1];
  };

  const version = sheet('current version');
  const stated = version.find((r) => (r[0] ?? '').toLowerCase().startsWith('current version'));
  const statedVersion = normalize((stated ?? []).filter(Boolean).pop() ?? '');
  if (statedVersion !== EXPECTED.sixVersion) {
    throw new Error(`SIX workbook is version ${statedVersion}, expected ${EXPECTED.sixVersion}`);
  }

  const mandatory = codeRows(sheet('mandatory'));
  const general = codeRows(sheet('general'));
  if (mandatory.length !== 12 || general.length !== 36) {
    throw new Error(`expected 12 mandatory and 36 general rows, got ${mandatory.length} and ${general.length}`);
  }

  return {
    $comment:
      'Generated from the SIX xlsx, not hand-transcribed. Do not edit by hand; re-extract with scripts/extract-btc.mjs.',
    source: {
      title: 'List of BTC codes used in Switzerland',
      publisher: 'SIX Group (Swiss Payment Standards)',
      url: SOURCES.six.url,
      linkedFrom:
        'https://www.six-group.com/en/products-services/banking-services/payment-standardization/standards/iso-20022.html',
      statedVersion: '1.0',
      statedAsOf: '2024-02-20',
      retrieved: '2026-07-19',
      versionCaveat:
        "The workbook states version 1.0 as of 2024-02-20, yet contains rows marked 'valid from 20.8.2024'. The stated date is therefore stale relative to the content. Treat the file, not its metadata, as authoritative.",
      normalization:
        'Soft hyphens removed; non-breaking hyphens and en dashes folded to plain hyphens. Code values are untouched.',
      languageEditions:
        'SIX publishes en, de and fr (there is no it edition). All three carry the identical 48 code rows in the same order, verified 2026-07-19; only the labels differ.',
      authority:
        'SIX publishes the CH list separately from the ISO external code sets. ISO remains the registry of record for code existence, but NOT via the quarterly ExternalCodeSets release: that release registers the three BTC set names without enumerating their values. The BTC values are published separately, and are extracted in test/fixtures/btc-codes-iso-20022.json.',
      crossCheckedAgainstIso:
        '2026-07-19: all 48 rows verified against ISO BTC codification v7.0 (2023-10-30) and description v7.1 (May 2025). Every triple is an ISO-permitted combination; nothing is deprecated. See docs/planning/btc-swiss-bank-transaction-codes.md.',
    },
    notes: [
      'BkTxCd is a mandatory C-level element in camt.053. Domain/Family/SubFamily are each a separate ISO external code set.',
      "Sheet 'CH-specific (mandatory)' is binding on all Swiss financial institutions. Sheet 'CH general (usual)' is customary usage, not mandated.",
      'Two Real-Time Credit Transfer rows carry prose instead of a sub-family code. subFamily is null for those and the sheet text is preserved in subFamilyNote. No code was invented.',
    ],
    chSpecificMandatory: mandatory,
    chGeneral: general,
  };
}

function buildIsoFixture(book, descriptionText) {
  const sheet = book.BTC_Codification;
  if (!sheet) throw new Error('no BTC_Codification sheet in the ISO workbook');

  const history = book['History Log'] ?? [];
  const version = history
    .map((r) => (r[3] ?? '').trim())
    .filter((v) => /^v\d/i.test(v))
    .pop();
  if ((version ?? '').toLowerCase() !== EXPECTED.isoCodification) {
    throw new Error(`ISO codification is ${version}, expected ${EXPECTED.isoCodification}`);
  }
  if (!descriptionText.includes(EXPECTED.isoDescription)) {
    throw new Error(`ISO description document no longer states version ${EXPECTED.isoDescription}`);
  }

  const domains = {};
  const families = {};
  const subFamilies = {};
  const combinations = new Set();
  const statusCounts = {};

  for (const r of sheet.slice(3)) {
    const [domainName, familyName, subFamilyName, domain, family, subFamily, status] = [
      0, 1, 2, 3, 4, 5, 6,
    ].map((i) => (r[i] ?? '').trim());
    if (!domain) continue;

    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
    if (!(domain in domains)) domains[domain] = domainName;
    if (!(`${domain}/${family}` in families)) families[`${domain}/${family}`] = familyName;
    if (!(subFamily in subFamilies)) subFamilies[subFamily] = subFamilyName;
    combinations.add(`${domain}/${family}/${subFamily}`);
  }

  return {
    $comment:
      'Generated from the ISO 20022 BTC codification workbook, not hand-transcribed. Do not edit by hand; re-extract with scripts/extract-btc.mjs.',
    source: {
      title: 'ISO20022 Bank Transaction Codes: all permitted combinations of the BTC code sets',
      publisher: 'ISO 20022 Registration Authority',
      url: SOURCES.isoCodification.url,
      version: 'v7.0',
      versionDate: '2023-10-30',
      retrieved: '2026-07-19',
      confirmedAgainst: {
        title: 'Bank Transaction Codes: External Code Sets (description document)',
        url: SOURCES.isoDescription.url,
        version: '7.1',
        versionDate: '2025-05',
        note: 'v7.1 only adds IRCA sub-family codes for IRCT/RRCT. It removes and deprecates nothing, so the v7.0 combination list stays complete for every code TILL uses.',
      },
      codeSetsRelease: {
        note: 'The quarterly ExternalCodeSets release does NOT enumerate the BTC code values. It registers the three set names only, and points at the separately published BTC documentation above.',
        url: 'https://www.iso20022.org/sites/default/files/media/file/ExternalCodeSets_XLSX.zip',
        file: '1Q2026_externalcodesets_v1.xlsx',
        publicationDate: '2026-05-29',
        release: '1Q2026',
        setsRegistered: [
          'ExternalBankTransactionDomain1Code',
          'ExternalBankTransactionFamily1Code',
          'ExternalBankTransactionSubFamily1Code',
        ],
        setStatus: 'Registered',
      },
    },
    notes: [
      'Status values in the BTC codification are New, Corrected and Updated. The list carries no Obsolete or Replaced By column, so no BTC code is deprecated as of v7.1.',
      'validCombinations is the authoritative allow-list: a Domain/Family/SubFamily triple is valid only if it appears here, even when all three codes exist individually.',
    ],
    statusCounts,
    domains,
    families,
    subFamilies,
    validCombinations: [...combinations].sort(),
  };
}

function emit(relPath, value) {
  const target = new URL(relPath, ROOT);
  const next = JSON.stringify(value, null, 2) + '\n';
  const current = (() => {
    try {
      return readFileSync(target, 'utf8');
    } catch {
      return null;
    }
  })();

  if (current === next) {
    console.log(`  unchanged  ${relPath}`);
    return true;
  }
  if (CHECK) {
    console.error(`  DRIFTED    ${relPath}`);
    return false;
  }
  writeFileSync(target, next);
  console.log(`  written    ${relPath}`);
  return true;
}

const [sixBuf, isoBuf, descBuf] = await Promise.all([
  download(SOURCES.six.url),
  download(SOURCES.isoCodification.url),
  download(SOURCES.isoDescription.url),
]);

console.log(`downloaded ${sixBuf.length} + ${isoBuf.length} + ${descBuf.length} bytes`);

const six = buildSixFixture(readWorkbook(sixBuf));
const iso = buildIsoFixture(readLegacyWorkbook(isoBuf), readDocxText(descBuf));

console.log(
  `SIX: ${six.chSpecificMandatory.length} mandatory + ${six.chGeneral.length} general | ` +
    `ISO: ${Object.keys(iso.domains).length} domains, ${Object.keys(iso.families).length} families, ` +
    `${Object.keys(iso.subFamilies).length} sub-families, ${iso.validCombinations.length} combinations`,
);

const ok = [emit(SOURCES.six.out, six), emit(SOURCES.isoCodification.out, iso)].every(Boolean);

if (!ok) {
  console.error('\nfixtures drifted from upstream. Re-run without --check to accept the new values,');
  console.error('then review the diff and update docs/planning/btc-swiss-bank-transaction-codes.md.');
  process.exit(1);
}
console.log(CHECK ? '\nextract-btc: ok, fixtures match upstream.' : '\nextract-btc: done.');
