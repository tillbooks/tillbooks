/**
 * marketing-shots.mjs: the pure half of `scripts/marketing-screenshots.mjs` (no browser, no server),
 * so the private-data guard and the file contract are unit-tested on their own
 * (`test/scripts/marketing-screenshots.test.mjs`).
 *
 * The guard is the point of this file. The screenshots go onto a public website, so the ledger they
 * show must be the synthetic Seeblick seed and nothing else: the owner's real books live under
 * `~/.till/` and must never be opened by this pipeline (CLAUDE.md, "Private data never ships").
 * `assertDbInsideTemp` refuses any database path that does not resolve INSIDE the run's own temp
 * directory, after symlinks are followed, so neither a stray `TILL_DB_PATH` in the caller's shell nor
 * a symlink planted in the temp dir can point the run at a real ledger.
 */

import { realpathSync, existsSync } from 'node:fs';
import { dirname, basename, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** The surfaces the website shows, in display order. `route` is the Studio path the script opens. */
export const SURFACES = [
  {
    id: 'overview',
    route: '/overview',
    alt: {
      en: 'TILL Studio overview for the Seeblick demo company: revenue, cash, open receivables and payables, stock value, and what is waiting for a decision.',
      'de-CH': 'TILL Studio, Übersicht der Demofirma Seeblick: Umsatz, flüssige Mittel, offene Debitoren und Kreditoren, Lagerwert und was auf einen Entscheid wartet.',
    },
  },
  {
    id: 'bank-inbox',
    route: '/bank',
    alt: {
      en: 'The TILL bank inbox: imported bank lines waiting to be booked, with likely duplicates flagged.',
      'de-CH': 'Die Bank-Inbox in TILL: importierte Bankzeilen, die auf ihre Buchung warten, mögliche Duplikate markiert.',
    },
  },
  {
    id: 'mwst-abrechnung',
    route: '/mwst',
    alt: {
      en: 'The TILL VAT return for Q3 2026: the amount payable and the turnover per ESTV form line, ready to export as an eCH-0217 file.',
      'de-CH': 'Die MWST-Abrechnung in TILL für Q3/2026: zu bezahlender Betrag und Umsatz pro Ziffer des ESTV-Formulars, bereit für den Export als eCH-0217-Datei.',
    },
  },
  {
    id: 'agent-proposals',
    route: '/agent?tab=vorschlaege',
    alt: {
      en: 'Bookings an AI agent proposed in TILL over MCP, each waiting for a person to approve or reject it.',
      'de-CH': 'Buchungen, die ein KI-Agent in TILL über MCP vorgeschlagen hat, jede wartet auf die Freigabe oder Ablehnung durch einen Menschen.',
    },
  },
  {
    id: 'qr-invoice',
    // The QR-bill view is a document detail, so its route is resolved at run time from the seeded
    // ledger (an issued invoice with a QR payment part). See `marketing-screenshots.mjs`.
    route: null,
    alt: {
      en: 'An issued invoice in TILL with its Swiss QR-bill payment part: the scannable code, QR-IBAN, reference and amount.',
      'de-CH': 'Eine ausgestellte Rechnung in TILL mit dem Zahlteil der Schweizer QR-Rechnung: scanbarer Code, QR-IBAN, Referenz und Betrag.',
    },
  },
  {
    id: 'journal',
    route: '/journal',
    alt: {
      en: 'The TILL journal: posted bookings with date, voucher number, reference, amount and the document they came from.',
      'de-CH': 'Das Journal in TILL: gebuchte Buchungen mit Datum, Belegnummer, Referenz, Betrag und dem Beleg, aus dem sie stammen.',
    },
  },
  {
    id: 'reports',
    route: '/reports',
    alt: {
      en: 'TILL financial reports: the trial balance of the Seeblick demo company, checked against the journal.',
      'de-CH': 'Finanzberichte in TILL: die Saldenbilanz der Demofirma Seeblick, abgestimmt mit dem Journal.',
    },
  },
  {
    id: 'migration',
    route: '/migration',
    alt: {
      en: 'The TILL migration workspace for moving books over from another accounting system, step by step.',
      'de-CH': 'Der Migrationsbereich in TILL, um die Buchhaltung Schritt für Schritt aus einem anderen System zu übernehmen.',
    },
  },
];

/**
 * What the demo agent drafts over MCP before the capture, so the proposals view shows real pending
 * proposals. The seed has none (it drives the API as the human seat), and an agent seat's write at the
 * default dial (`ask`) is exactly how a proposal comes to exist. Account numbers are Seeblick's KMU
 * chart; amounts are minor units (Rappen). Invented, like the rest of the seed.
 */
export const AGENT_DRAFTS = [
  { description: 'Miete November Geschäftsräume Winterthur', debit: '6000', credit: '1020', amount: 245000 },
  { description: 'Swisscom Business Internet Oktober', debit: '6570', credit: '1020', amount: 8900 },
  { description: 'Diesel Lieferwagen ZH 482 117', debit: '6200', credit: '1020', amount: 14235 },
  { description: 'Betriebshaftpflicht Prämie 2027', debit: '6300', credit: '2000', amount: 124000 },
];

export const LOCALES = ['en', 'de-CH'];
export const THEMES = ['light', 'dark'];

/** The capture geometry the website was designed around: a 1440x900 desktop at 2x. */
export const VIEWPORT = { width: 1440, height: 900 };
export const DEVICE_SCALE_FACTOR = 2;

/** The locale token in a file name: the website's page locales are `en` and `de`. */
export const FILE_LOCALE = { en: 'en', 'de-CH': 'de' };

/**
 * `overview-de-dark.webp`: the one naming contract the website's pages import by (the ids and the
 * `de` token were fixed by the website's product-preview component).
 */
export function shotFileName(surfaceId, locale, theme) {
  if (!SURFACES.some((s) => s.id === surfaceId)) throw new Error(`unknown surface: ${surfaceId}`);
  if (!LOCALES.includes(locale)) throw new Error(`unknown locale: ${locale}`);
  if (!THEMES.includes(theme)) throw new Error(`unknown theme: ${theme}`);
  return `${surfaceId}-${FILE_LOCALE[locale]}-${theme}.webp`;
}

/** Resolve symlinks on the deepest part of `p` that exists, then re-append the rest. */
function realpathLoose(p) {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realpathLoose(parent), basename(abs));
}

/**
 * Throw unless `dbPath` resolves strictly inside `tempDir`. Also refuses anything under `~/.till`
 * outright, as a second line in case a temp dir was ever created there.
 */
export function assertDbInsideTemp(tempDir, dbPath) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '' || dbPath.trim() === ':memory:') {
    throw new Error(`marketing-screenshots: refusing database path ${JSON.stringify(dbPath)}: it must be a file inside ${tempDir}`);
  }
  const root = realpathLoose(tempDir);
  const target = realpathLoose(dbPath);
  const till = realpathLoose(join(homedir(), '.till'));
  if (target === till || target.startsWith(till + sep)) {
    throw new Error(`marketing-screenshots: refusing ${dbPath}: it is under ~/.till, where real books live`);
  }
  if (!target.startsWith(root + sep)) {
    throw new Error(`marketing-screenshots: refusing ${dbPath}: it is outside the run's temp dir ${root}`);
  }
  return target;
}

/** The manifest the website reads: one entry per file, with its pixel size and alt text. */
export function buildManifest(entries, meta) {
  const images = {};
  for (const e of [...entries].sort((a, b) => a.file.localeCompare(b.file))) {
    const surface = SURFACES.find((s) => s.id === e.surface);
    images[e.file] = {
      surface: e.surface,
      locale: e.locale,
      theme: e.theme,
      width: e.width,
      height: e.height,
      alt: surface.alt[e.locale],
    };
  }
  return {
    about:
      'Product screenshots of the TILL Studio, generated by scripts/marketing-screenshots.mjs from the synthetic Seeblick demo ledger. Do not edit by hand: re-run npm run shots:marketing.',
    seedToday: meta.seedToday,
    viewport: VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    surfaces: SURFACES.map((s) => ({ id: s.id, alt: s.alt })),
    images,
  };
}
