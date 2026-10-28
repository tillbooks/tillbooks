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
      en: 'TILL Studio overview for a sample company: revenue, cash, open receivables and payables, stock value, and what is waiting for a decision.',
      'de-CH': 'TILL Studio, Übersicht einer Beispielfirma: Umsatz, flüssige Mittel, offene Debitoren und Kreditoren, Lagerwert und was auf einen Entscheid wartet.',
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
      en: 'The Swiss QR-bill payment part of an issued invoice in TILL: the scannable code, reference, amount and due date.',
      'de-CH': 'Der Zahlteil der Schweizer QR-Rechnung zu einer ausgestellten Rechnung in TILL: scanbarer Code, Referenz, Betrag und Fälligkeit.',
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
      en: 'TILL financial reports: the trial balance of a sample company, checked against the journal.',
      'de-CH': 'Finanzberichte in TILL: die Saldenbilanz einer Beispielfirma, abgestimmt mit dem Journal.',
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

/**
 * What the demo migration plan scopes before the migration frame (scripts/marketing-screenshots.mjs):
 * the classes a small company brings over from bexio. Every one is first-scope in
 * src/core/migration/dataClasses.ts, so `migration_set_scope` lands a step for each.
 */
export const MIGRATION_SCOPE = ['chart_of_accounts', 'tax_codes', 'contacts', 'opening_balances', 'open_items_ar', 'open_items_ap'];

export const LOCALES = ['en', 'de-CH'];
export const THEMES = ['light', 'dark'];

/**
 * The capture geometry: a 1120x800 Studio at 2x. The website draws its crops at about the size they
 * were taken (UX critic M3): at 1440 a table spreads over 1176px and a feature row's 736px column drew
 * it at 0.54, with 6 to 7px text; at 1120 the same screen, every column included, fits about 840px.
 */
export const VIEWPORT = { width: 1120, height: 800 };
/**
 * The phone frame: the same screen in the Studio's own narrow layout (below 767px its rail becomes a
 * drawer and the tables reflow), which is what a phone-width crop on the website is cut from. A crop
 * of a desktop frame cannot keep a label and its amount together on a phone: the VAT return's
 * "Amount payable" sits 800px left of its figure there (UX critic M3).
 */
export const PHONE_VIEWPORT = { width: 480, height: 900 };
export const DEVICE_SCALE_FACTOR = 2;

/** The two frames every surface is captured in. */
export const FRAMES = ['desk', 'phone'];

/** The locale token in a file name: the website's page locales are `en` and `de`. */
export const FILE_LOCALE = { en: 'en', 'de-CH': 'de' };

/**
 * `overview-de-dark.webp`, `overview-de-dark-phone.webp`: the one naming contract the website's pages
 * import by (the ids and the `de` token were fixed by the website's product-preview component).
 */
export function shotFileName(surfaceId, locale, theme, frame = 'desk') {
  if (!SURFACES.some((s) => s.id === surfaceId)) throw new Error(`unknown surface: ${surfaceId}`);
  if (!LOCALES.includes(locale)) throw new Error(`unknown locale: ${locale}`);
  if (!THEMES.includes(theme)) throw new Error(`unknown theme: ${theme}`);
  if (!FRAMES.includes(frame)) throw new Error(`unknown frame: ${frame}`);
  return `${surfaceId}-${FILE_LOCALE[locale]}-${theme}${frame === 'phone' ? '-phone' : ''}.webp`;
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
      frame: e.frame ?? 'desk',
      width: e.width,
      height: e.height,
      alt: surface.alt[e.locale],
    };
  }
  return {
    about:
      'Product screenshots of the TILL Studio, generated by scripts/marketing-screenshots.mjs from the synthetic Seeblick demo ledger. Do not edit by hand: re-run npm run shots:marketing.',
    // The workshop version the Studio was built at when captured (D181 critic r4): the home page's
    // CAPTURED_WITH must equal it, so a recapture forces each shot's shownIn/checkedAgainst again.
    capturedWith: meta.capturedWith,
    seedToday: meta.seedToday,
    viewport: meta.viewport ?? VIEWPORT,
    phoneViewport: meta.phoneViewport ?? PHONE_VIEWPORT,
    deviceScaleFactor: DEVICE_SCALE_FACTOR,
    surfaces: SURFACES.map((s) => ({ id: s.id, alt: s.alt })),
    images,
  };
}
