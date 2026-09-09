#!/usr/bin/env node
/**
 * seed-demo-rich.mjs: the rich presentation ledger (D118 E1-E5, plan
 * `docs/planning/modernisation/03-test-data-plan.md`).
 *
 * A deterministic, resettable seed that drives the PUBLIC API only (`handleRest` over a hand-composed
 * `ApiDeps`), so the ledger is real by construction and every invariant that guards `develop` also
 * guards the seed. NO engine code is touched: this script only CALLS existing verbs.
 *
 * Determinism: ONE shared `sequenceIdGen` gives byte-stable ids across the whole run, and a
 * CONTROLLABLE clock (`setClock`) stamps each dated verb with the business date it belongs to, rather
 * than the wall clock, so the ledger is byte-identical on every run and screenshots reproduce. Every
 * write carries a stable `seed:<phase>:<entity>:<n>` idempotency key, so re-running the SAME db is a
 * no-op replay, never a duplicate.
 *
 * Storage: a DEDICATED db, `~/.till/till-demo.db` by default (via `TILL_DB_PATH`), so the seed NEVER
 * touches real books and the Studio, resolving the same `src/api/db-path.ts` path, shares the ledger.
 *
 * Usage:
 *   TILL_DB_PATH=~/.till/till-demo.db node scripts/seed-demo-rich.mjs --reset
 *   TILL_DB_PATH=~/.till/till-demo.db node scripts/seed-demo-rich.mjs           # idempotent replay
 *   node scripts/seed-demo-rich.mjs --reset --phase=8                          # a single phase
 *   TILL_SEED_TODAY=2027-03-10 node scripts/seed-demo-rich.mjs --reset         # roll the calendar
 *
 * Rolling TODAY (WP1): `TILL_SEED_TODAY` (ISO YYYY-MM-DD) remaps the whole frozen calendar via
 * `scripts/lib/seed-dates.mjs`. Unset, TODAY stays 2026-08-23 and the output is byte-identical to
 * the frozen ledger. Events whose remapped date lands after TODAY are skipped, counted, and
 * printed in a summary at the end of the run.
 *
 * The build (`npm run build`) must run first so `dist/` exists.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { resolveSeedToday, makeSeedCalendar } from './lib/seed-dates.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const { SqliteStore } = await import(join(ROOT, 'dist/core/store/sqlite-store.js'));
const { sequenceIdGen } = await import(join(ROOT, 'dist/core/ids.js'));
const { handleRest } = await import(join(ROOT, 'dist/api/rest.js'));
const { resolveDbPath } = await import(join(ROOT, 'dist/api/db-path.js'));

// ---------------------------------------------------------------------------------------------------
// CLI + db path
// ---------------------------------------------------------------------------------------------------

const args = process.argv.slice(2);
const RESET = args.includes('--reset');
const onlyPhaseArg = args.find((a) => a.startsWith('--phase='));
const ONLY_PHASE = onlyPhaseArg ? Number(onlyPhaseArg.split('=')[1]) : null;

const dbPath = resolveDbPath();
if (dbPath === ':memory:') {
  console.error('Refusing to seed :memory: (nothing would survive). Set TILL_DB_PATH to a file, e.g. ~/.till/till-demo.db');
  process.exit(1);
}

if (RESET) {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbPath + suffix;
    if (existsSync(p)) {
      rmSync(p);
      console.log('reset: removed ' + p);
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// The rolling calendar (WP1): TODAY from TILL_SEED_TODAY, defaulting to the frozen 2026-08-23.
// `d`/`dm`/`dq`/`dt` remap the frozen date literals; the horizons come from CAL.months()/monthShift().
// ---------------------------------------------------------------------------------------------------

const TODAY = resolveSeedToday(process.env);
const CAL = makeSeedCalendar(TODAY);
const { d, dm, dq, dt } = CAL;

// Post-TODAY event skips: counted per label and printed at the end, never silent.
const SKIPS = { total: 0, byLabel: new Map() };
/** True (and counts + prints) when any given remapped EVENT date lands after TODAY. */
function skipFuture(label, ...dates) {
  const future = dates.filter((x) => x && CAL.isFuture(x));
  if (future.length === 0) return false;
  SKIPS.total += 1;
  SKIPS.byLabel.set(label, (SKIPS.byLabel.get(label) || 0) + 1);
  console.log('  [today-skip] ' + label + ' @ ' + future[0] + ' (after TODAY ' + TODAY + ')');
  return true;
}

// ---------------------------------------------------------------------------------------------------
// The controllable clock + deterministic deps (the `test/api/support.mjs` freshDeps pattern, but a
// file store, one shared id sequence, and a clock whose instant we move per business date).
// ---------------------------------------------------------------------------------------------------

let CLOCK_NOW = d('2025-01-01') + 'T09:00:00.000Z';
const clock = { now: () => CLOCK_NOW };
/** Move the audit clock to 09:00 UTC on `isoDate` (YYYY-MM-DD). */
function setClock(isoDate) {
  CLOCK_NOW = isoDate + 'T09:00:00.000Z';
}

const store = new SqliteStore({ location: dbPath, clock });
const ids = sequenceIdGen();
const deps = { store, clock, ids, actor: 'user_1' };

/** Drive one public verb. Throws loudly (verb + payload + error) on a domain rejection. */
function call(verb, input, opts = {}) {
  if (opts.date) setClock(opts.date);
  const res = handleRest(verb, { ...input }, deps);
  if (res.body && res.body.ok === false) {
    throw new Error('SEED FAIL ' + verb + ' status=' + res.status + ' -> ' + JSON.stringify(res.body) + '  input=' + JSON.stringify(input));
  }
  return res.body;
}

/** A tolerant call: logs a warning instead of throwing, for order-sensitive presentation niceties. */
function tryCall(verb, input, opts = {}) {
  try {
    return call(verb, input, opts);
  } catch (e) {
    console.warn('  [skip] ' + verb + ': ' + String(e.message).slice(0, 160));
    return null;
  }
}

/** Read an account id by its number within a workspace (read-only SELECT, no money-path write). */
function accId(workspaceId, number) {
  const row = store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number);
  if (!row) throw new Error('account ' + number + ' not found in ' + workspaceId);
  return row.id;
}

/** Count rows for a table in a workspace (verification). */
function countRows(workspaceId, table, where = '') {
  const sql = 'SELECT COUNT(*) AS n FROM ' + table + ' WHERE workspace_id = ?' + (where ? ' AND ' + where : '');
  return store.db.prepare(sql).get(workspaceId).n;
}

// Pure date helper (deterministic): add days to a YYYY-MM-DD string.
function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00.000Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------------
// The company story (E1/E2): Seeblick Kaffee & Technik GmbH, Winterthur.
// ---------------------------------------------------------------------------------------------------

const COMPANY = {
  name: 'Seeblick Kaffee & Technik GmbH',
  // Reserved demo UID: check-digit-VALID (passes the eCH-0217 mod-11 test) so the MWST export path
  // is exercisable end to end on the golden baseline, yet an obvious placeholder (near all-nines)
  // that is not a real registered company. Must stay distinct from the CHE-102.673.386 the
  // sales/test fixtures use. CHE-nnn.nnn.nnn.
  uid: 'CHE-199.999.992',
  mwstNo: 'CHE-199.999.992 MWST',
  address: { street: 'Technikumstrasse', buildingNo: '38', zip: '8400', town: 'Winterthur', country: 'CH' },
  qrIban: 'CH4431999123000889012', // SIX published specimen QR-IBAN (the honest demo choice).
};

// Twelve customers: cafes, restaurants, a hotel chain. Repeat business, a few custom terms.
const CUSTOMERS = [
  { name: 'Rialto Bar GmbH', street: 'Marktgasse', houseNo: '4', zip: '8400', city: 'Winterthur', email: 'buchhaltung@rialto.example', terms: 30, segment: 'gastro' },
  { name: 'Café Sternen', street: 'Steinberggasse', houseNo: '12', zip: '8400', city: 'Winterthur', email: 'info@sternen.example', terms: 30, segment: 'gastro' },
  { name: 'Restaurant Löwen AG', street: 'Bahnhofplatz', houseNo: '3', zip: '8500', city: 'Frauenfeld', email: 'finanz@loewen.example', terms: 20, segment: 'gastro' },
  { name: 'Hotel Blaustern AG', street: 'Seestrasse', houseNo: '77', zip: '8002', city: 'Zürich', email: 'kreditoren@blaustern.example', terms: 45, segment: 'hotel' },
  { name: 'Kafi Rösterei Turm', street: 'Obertor', houseNo: '9', zip: '8400', city: 'Winterthur', email: 'hallo@kafiturm.example', terms: 30, segment: 'gastro' },
  { name: 'Bistro Central', street: 'Hauptgasse', houseNo: '21', zip: '9000', city: 'St. Gallen', email: 'buchung@central.example', terms: 30, segment: 'gastro' },
  { name: 'Bäckerei Meier & Co', street: 'Dorfstrasse', houseNo: '5', zip: '8404', city: 'Winterthur', email: 'meier@baeckerei.example', terms: 15, segment: 'gastro' },
  { name: 'Seeblick Lounge GmbH', street: 'Quaistrasse', houseNo: '2', zip: '8640', city: 'Rapperswil', email: 'office@seeblicklounge.example', terms: 30, segment: 'gastro' },
  { name: 'Gasthof Adler', street: 'Landstrasse', houseNo: '44', zip: '8450', city: 'Andelfingen', email: 'adler@gasthof.example', terms: 30, segment: 'gastro' },
  { name: 'Coworking Kafi AG', street: 'Zürcherstrasse', houseNo: '110', zip: '8406', city: 'Winterthur', email: 'ap@coworkingkafi.example', terms: 30, segment: 'office' },
  { name: 'Berghotel Panorama AG', street: 'Alpweg', houseNo: '1', zip: '7050', city: 'Arosa', email: 'einkauf@panorama.example', terms: 45, segment: 'hotel' },
  // A dual-role partner cafe that also resells our beans (tagged both roles in phase 3).
  { name: 'Rösterei Partner AG', street: 'Industriestrasse', houseNo: '18', zip: '8404', city: 'Winterthur', email: 'partner@roesterei.example', terms: 30, segment: 'gastro', dual: true },
];

// Six suppliers: EUR machines, USD parts, CHF roastery, utilities, landlord, IT/SaaS.
const SUPPLIERS = [
  { name: 'Macchine Espresso SRL', city: 'Milano', country: 'IT', currency: 'EUR', iban: 'IT60X0542811101000000123456', kind: 'machines' },
  { name: 'Grind Parts Inc', city: 'Seattle', country: 'US', currency: 'USD', iban: 'US64SVBKUS6S3300958879', kind: 'parts' },
  { name: 'Rösterei Ostschweiz AG', city: 'Wil', country: 'CH', currency: 'CHF', iban: 'CH5604835012345678009', kind: 'beans' },
  { name: 'Stadtwerke Winterthur', city: 'Winterthur', country: 'CH', currency: 'CHF', iban: 'CH9300762011623852957', kind: 'utilities' },
  { name: 'Immo Technikum AG', city: 'Winterthur', country: 'CH', currency: 'CHF', iban: 'CH5800791123000889012', kind: 'landlord' },
  // Dual-role: the partner roastery is both a customer and a supplier (restocks).
  { name: 'Rösterei Partner AG', city: 'Winterthur', country: 'CH', currency: 'CHF', iban: 'CH5604835098765432001', kind: 'beans', dualOfCustomer: 'Rösterei Partner AG' },
];

// Fifteen items across four categories.
const ITEMS = [
  // 6 machines/grinders (stocked)
  { key: 'm1', name: 'Espressomaschine La Riva Due', price: 480000, unit: 'piece', cat: 'maschinen', stock: true, tax: 'UST81' },
  { key: 'm2', name: 'Espressomaschine La Riva Tre', price: 720000, unit: 'piece', cat: 'maschinen', stock: true, tax: 'UST81' },
  { key: 'm3', name: 'Siebträger Barista Pro', price: 260000, unit: 'piece', cat: 'maschinen', stock: true, tax: 'UST81' },
  { key: 'g1', name: 'Mühle Macinare 64', price: 145000, unit: 'piece', cat: 'maschinen', stock: true, tax: 'UST81' },
  { key: 'g2', name: 'Mühle Macinare 83', price: 198000, unit: 'piece', cat: 'maschinen', stock: true, tax: 'UST81' },
  { key: 'm4', name: 'Röster Seeblick R15', price: 950000, unit: 'piece', cat: 'maschinen', stock: true, tax: 'UST81' },
  // 3 bean SKUs (stocked, per kg)
  { key: 'b1', name: 'Kaffeebohnen Hausmischung (kg)', price: 2400, unit: 'kg', cat: 'kaffee', stock: true, tax: 'UST26' },
  { key: 'b2', name: 'Kaffeebohnen Espresso Forte (kg)', price: 2800, unit: 'kg', cat: 'kaffee', stock: true, tax: 'UST26' },
  { key: 'b3', name: 'Kaffeebohnen Bio Entkoffeiniert (kg)', price: 3200, unit: 'kg', cat: 'kaffee', stock: true, tax: 'UST26' },
  // 3 spare parts (stocked)
  { key: 'p1', name: 'Brühgruppe Dichtungsset', price: 4500, unit: 'piece', cat: 'ersatzteile', stock: true, tax: 'UST81' },
  { key: 'p2', name: 'Mahlscheiben 64mm', price: 8900, unit: 'piece', cat: 'ersatzteile', stock: true, tax: 'UST81' },
  { key: 'p3', name: 'Dampfventil Kit', price: 6200, unit: 'piece', cat: 'ersatzteile', stock: true, tax: 'UST81' },
  // services
  { key: 's1', name: 'Servicestunde Techniker', price: 15500, unit: 'hour', cat: 'dienstleistung', stock: false, tax: 'UST81' },
  { key: 's2', name: 'Installation Pauschale', price: 65000, unit: 'flat', cat: 'dienstleistung', stock: false, tax: 'UST81' },
  { key: 's3', name: 'Lieferung', price: 3500, unit: 'flat', cat: 'dienstleistung', stock: false, tax: 'UST81' },
];

const CATEGORIES = [
  { key: 'maschinen', name: 'Maschinen' },
  { key: 'kaffee', name: 'Kaffee' },
  { key: 'ersatzteile', name: 'Ersatzteile' },
  { key: 'dienstleistung', name: 'Dienstleistung' },
];

// ---------------------------------------------------------------------------------------------------
// Shared handles, filled as phases run (kept module-level so `--phase=n` can re-derive from the db).
// ---------------------------------------------------------------------------------------------------

const W = {}; // workspace ids: W.main, W.thin
const H = {
  customers: {}, // name -> contactId
  suppliers: {}, // name -> contactId
  items: {}, // key -> itemId
  categories: {}, // key -> categoryId
  banks: {}, // key -> bankAccountId
  assetCats: {}, // key -> categoryId
  invoices: [], // { id, contact, total, month, open, overdue }
  vendorBills: [], // { id, vendor, total, open }
  projects: {}, // key -> projectId
};

/** Broad id extractor: verbs return the new row under a variety of envelopes. */
function oneId(res) {
  if (!res) return undefined;
  return (
    res.id ??
    res.document?.id ?? res.invoice?.id ??
    res.salesOrder?.id ?? res.salesOrderId ??
    res.deliveryNote?.id ?? res.deliveryNoteId ??
    res.creditNote?.id ?? res.creditNoteId ??
    res.quote?.id ?? res.quoteId ??
    res.contact?.id ?? res.item?.id ??
    res.bankAccount?.id ?? res.bankAccountId ??
    res.category?.id ?? res.categoryId ??
    res.asset?.id ?? res.assetId ??
    res.project?.id ?? res.projectId ??
    res.phase?.id ?? res.phaseId ??
    res.run?.id ?? res.runId ??
    res.location?.id ?? res.locationId ??
    res.batch?.id ?? res.batchId ??
    res.poId ?? res.vendorBillId ??
    res.creditId ?? res.statementId ??
    res.task?.id ?? res.taskId ??
    res.viewId ?? res.ruleId ?? res.fieldId ??
    res.memberId ?? res.scheduleId ?? res.retainerId ??
    undefined
  );
}

const k = (phase, entity, n) => 'seed:' + phase + ':' + entity + ':' + n;

/** Record an exchange rate at the EXACT date of an FX posting (banks book the day's rate). */
function ensureRate(base, date, rate) {
  tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: base, quoteCurrency: 'CHF', rate, asOf: date, source: 'manual', idempotencyKey: 'seed:fx:' + base + ':' + date }, { date });
}

// ===================================================================================================
// PHASE 0: workspace + statutory identity
// ===================================================================================================
function phase0() {
  const ws = call('create_workspace', {
    name: COMPANY.name,
    legalForm: 'gmbh',
    baseCurrency: 'CHF',
    fiscalYearStart: '01-01',
    idempotencyKey: k('p0', 'workspace', 1),
  }, { date: d('2025-01-01') });
  W.main = ws.workspaceId;
  // These setters carry no idempotency key (create_workspace already fixed currency/fiscal year), so
  // on a no-reset replay they are harmless no-ops: tolerant, not strict.
  tryCall('update_company_profile', { workspaceId: W.main, name: COMPANY.name, legalForm: 'gmbh', uid: COMPANY.uid, mwstNo: COMPANY.mwstNo });
  tryCall('set_creditor_profile', { workspaceId: W.main, creditorName: COMPANY.name, address: COMPANY.address, qrIban: COMPANY.qrIban });
  console.log('  phase0: workspace ' + W.main + ' (' + COMPANY.name + ')');
}

// ===================================================================================================
// PHASE 1: VAT config + aging + FX method
// ===================================================================================================
function phase1() {
  call('vat_configure', { workspaceId: W.main, method: 'effektiv', timing: 'soll', registered: true, vatNumber: COMPANY.mwstNo, idempotencyKey: k('p1', 'vat', 1) }, { date: d('2025-01-01') });
  tryCall('set_aging_bucket_config', { workspaceId: W.main, boundariesDays: [30, 60, 90], idempotencyKey: k('p1', 'aging', 1) });
  tryCall('set_fx_method', { workspaceId: W.main, method: 'monthly_avg' });
  console.log('  phase1: effektiv/Soll, registered, aging 30/60/90');
}

// ===================================================================================================
// PHASE 2: chart extensions + cost centres
// ===================================================================================================
function phase2() {
  // Accumulated-depreciation contra accounts (asset type), per asset class.
  const contra = [
    ['1509', 'Wertberichtigungen Maschinen'],
    ['1529', 'Wertberichtigungen Informatik'],
    ['1539', 'Wertberichtigungen Fahrzeuge'],
  ];
  for (const [n, name] of contra) {
    tryCall('create_account', { workspaceId: W.main, number: n, name, type: 'asset', idempotencyKey: k('p2', 'acc', n) });
  }
  // A second bank ledger account for the EUR account.
  tryCall('create_account', { workspaceId: W.main, number: '1021', name: 'Bank EUR', type: 'asset', idempotencyKey: k('p2', 'acc', '1021') });
  const centres = [['VK', 'Verkauf'], ['SV', 'Service'], ['VW', 'Verwaltung']];
  for (const [code, name] of centres) {
    tryCall('create_cost_center', { workspaceId: W.main, code, name, idempotencyKey: k('p2', 'cc', code) });
  }
  console.log('  phase2: contra accounts + EUR bank ledger + 3 cost centres');
}

// ===================================================================================================
// PHASE 3: master data (contacts, items, categories, price list, banks)
// ===================================================================================================
function phase3() {
  let n = 0;
  for (const c of CUSTOMERS) {
    n += 1;
    const res = call('create_contact', {
      workspaceId: W.main, partyRole: 'customer', name: c.name,
      address: { street: c.street, houseNo: c.houseNo, zip: c.zip, city: c.city, country: 'CH' },
      email: c.email, paymentTermsDays: c.terms, idempotencyKey: k('p3', 'customer', n),
    });
    H.customers[c.name] = res.contact.id;
    tryCall('contacts_tag', { workspaceId: W.main, contactId: res.contact.id, segments: [c.segment], idempotencyKey: k('p3', 'ctag', n) });
    if (c.dual) tryCall('contacts_tag', { workspaceId: W.main, contactId: res.contact.id, roles: ['vendor'], idempotencyKey: k('p3', 'cdual', n) });
  }
  n = 0;
  for (const s of SUPPLIERS) {
    n += 1;
    // The dual-role party already exists as a customer: tag it a vendor rather than duplicating.
    if (s.dualOfCustomer && H.customers[s.dualOfCustomer]) {
      H.suppliers[s.name] = H.customers[s.dualOfCustomer];
      continue;
    }
    const res = call('create_contact', {
      workspaceId: W.main, partyRole: 'vendor', name: s.name,
      address: { street: 'Import', houseNo: '1', zip: '0000', city: s.city, country: s.country },
      defaultCurrency: s.currency, idempotencyKey: k('p3', 'supplier', n),
    });
    H.suppliers[s.name] = res.contact.id;
    tryCall('set_creditor_bank_profile', { workspaceId: W.main, vendorId: res.contact.id, iban: s.iban, idempotencyKey: k('p3', 'sbank', n) });
  }
  // Item categories
  for (const cat of CATEGORIES) {
    const res = tryCall('item_categories_upsert', { workspaceId: W.main, name: cat.name, idempotencyKey: k('p3', 'cat', cat.key) });
    if (res) H.categories[cat.key] = oneId(res) ?? res.category?.id;
  }
  // Items
  let i = 0;
  for (const it of ITEMS) {
    i += 1;
    const input = {
      workspaceId: W.main, name: it.name, defaultUnitPriceMinor: it.price, unit: it.unit,
      defaultTaxCode: it.tax, idempotencyKey: k('p3', 'item', i),
    };
    if (it.stock) { input.trackStock = true; input.costPriceMinor = Math.round(it.price * 0.6); }
    if (H.categories[it.cat]) input.categoryId = H.categories[it.cat];
    const res = call('create_item', input);
    H.items[it.key] = res.item.id;
  }
  // Wholesale price list with a few overrides for gastro customers.
  const pl = tryCall('price_lists_upsert', { workspaceId: W.main, name: 'Gastro Wholesale', segment: 'gastro', idempotencyKey: k('p3', 'pricelist', 1) });
  const plId = pl ? (pl.priceListId ?? pl.priceList?.id ?? oneId(pl)) : null;
  if (plId) {
    const overrides = [['m1', 456000], ['m2', 684000], ['g1', 137000], ['b1', 2200], ['b2', 2600]];
    let o = 0;
    for (const [key, price] of overrides) {
      o += 1;
      tryCall('price_lists_set_price', { workspaceId: W.main, priceListId: plId, itemId: H.items[key], priceMinor: price, validFrom: d('2025-01-01'), idempotencyKey: k('p3', 'price', o) });
    }
  }
  // Two bank accounts: CHF Hauptkonto (ledger 1020), EUR Fremdwährungskonto (ledger 1021).
  const chf = call('create_bank_account', { workspaceId: W.main, name: 'Hauptkonto CHF', iban: 'CH9300762011623852957', currency: 'CHF', ledgerAccountId: accId(W.main, '1020'), idempotencyKey: k('p3', 'bank', 1) });
  H.banks.chf = oneId(chf) ?? chf.bankAccount?.id; // A19 bank_account row id (camt, incoming credit, batch)
  H.banks.chfLedger = accId(W.main, '1020'); // A14 record_payment moves money on the LEDGER account
  const eur = tryCall('create_bank_account', { workspaceId: W.main, name: 'Fremdwährungskonto EUR', iban: 'CH5800791123000889012', currency: 'EUR', ledgerAccountId: accId(W.main, '1021'), idempotencyKey: k('p3', 'bank', 2) });
  if (eur) H.banks.eur = oneId(eur) ?? eur.bankAccount?.id;
  console.log('  phase3: ' + Object.keys(H.customers).length + ' customers, ' + Object.keys(H.suppliers).length + ' suppliers, ' + Object.keys(H.items).length + ' items, banks');
}

// ===================================================================================================
// PHASE 4: opening balances at 2025-01-01
// ===================================================================================================
function phase4() {
  const lines = [
    { account: accId(W.main, '1020'), debitMinor: 4500000 },   // Bank CHF
    { account: accId(W.main, '1100'), debitMinor: 1200000 },   // Debitoren carried
    { account: accId(W.main, '1200'), debitMinor: 2000000 },   // Warenvorrat
    { account: accId(W.main, '1500'), debitMinor: 3000000 },   // Maschinen (cost)
    { account: accId(W.main, '1509'), creditMinor: 800000 },   // kum. Abschreibungen Maschinen
    { account: accId(W.main, '2000'), creditMinor: 900000 },   // Kreditoren
  ];
  const obDate = d('2025-01-01');
  const obYear = obDate.slice(0, 4);
  call('set_opening_balances', {
    workspaceId: W.main, asOf: obDate, lines,
    differenceAccount: accId(W.main, '2800'), reference: 'Eröffnungsbilanz ' + obYear,
    description: 'Eröffnungsbilanz per 01.01.' + obYear, idempotencyKey: k('p4', 'opening', 1),
  }, { date: obDate });
  console.log('  phase4: opening balances posted as of ' + obDate);
}

// ===================================================================================================
// PHASE 5: FX rates (monthly EUR + USD across the span, plus period-end points)
// ===================================================================================================
function phase5() {
  const months = allMonths();
  const eurRates = { base: '0.95', jitter: 0.03 };
  const usdRates = { base: '0.88', jitter: 0.04 };
  let n = 0;
  for (const [mi, m] of months.entries()) {
    n += 1;
    const asOf = m + '-01';
    const eur = (0.95 + Math.sin(mi) * 0.03).toFixed(4);
    const usd = (0.88 + Math.cos(mi) * 0.04).toFixed(4);
    tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'EUR', quoteCurrency: 'CHF', rate: eur, asOf, source: 'manual', idempotencyKey: k('p5', 'eur', n) }, { date: asOf });
    tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'USD', quoteCurrency: 'CHF', rate: usd, asOf, source: 'manual', idempotencyKey: k('p5', 'usd', n) }, { date: asOf });
  }
  // Period-end revaluation rates (Dec 31 of year(TODAY)-1 is always in the past; the mid-year
  // point can land after a rolled TODAY and is then skipped, counted).
  const ye = d('2025-12-31');
  const h1 = d('2026-06-30');
  tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'EUR', quoteCurrency: 'CHF', rate: '0.9420', asOf: ye, source: 'manual', idempotencyKey: k('p5', 'eur', 'ye25') }, { date: ye });
  if (!skipFuture('fx-rate-h1', h1)) {
    tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'EUR', quoteCurrency: 'CHF', rate: '0.9510', asOf: h1, source: 'manual', idempotencyKey: k('p5', 'eur', 'h126') }, { date: h1 });
  }
  tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'USD', quoteCurrency: 'CHF', rate: '0.8850', asOf: ye, source: 'manual', idempotencyKey: k('p5', 'usd', 'ye25') }, { date: ye });
  if (!skipFuture('fx-rate-h1', h1)) {
    tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'USD', quoteCurrency: 'CHF', rate: '0.8790', asOf: h1, source: 'manual', idempotencyKey: k('p5', 'usd', 'h126') }, { date: h1 });
  }
  // A rolled TODAY needs rate points AT TODAY (the engine refuses rates older than 7 days for a
  // fresh posting). The frozen default stays byte-identical, so only when the calendar is rolled.
  // When TODAY falls on the 1st of a month the monthly loop above has ALREADY written a point at
  // TODAY; injecting a second one under a different key would collide and print a scary warning,
  // so the injection is skipped whenever a rate already exists at TODAY for the pair.
  if (!CAL.identity) {
    const rateAtToday = (base) =>
      store.db
        .prepare('SELECT 1 AS x FROM exchange_rate WHERE workspace_id = ? AND base_currency = ? AND quote_currency = ? AND as_of = ?')
        .get(W.main, base, 'CHF', TODAY) !== undefined;
    if (!rateAtToday('EUR')) {
      tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'EUR', quoteCurrency: 'CHF', rate: '0.9480', asOf: TODAY, source: 'manual', idempotencyKey: k('p5', 'eur', 'today') }, { date: TODAY });
    }
    if (!rateAtToday('USD')) {
      tryCall('record_exchange_rate', { workspaceId: W.main, baseCurrency: 'USD', quoteCurrency: 'CHF', rate: '0.8820', asOf: TODAY, source: 'manual', idempotencyKey: k('p5', 'usd', 'today') }, { date: TODAY });
    }
  }
  console.log('  phase5: ' + (n * 2 + 2) + ' exchange-rate points');
}

// ===================================================================================================
// PHASE 6: fixed assets (categories, 5 assets 2024-2025 acquisitions, depreciation runs)
// ===================================================================================================
function phase6() {
  const cats = [
    { key: 'maschinen', code: 'MA', name: 'Maschinen', asset: '1500', accum: '1509', life: 96 },
    { key: 'it', code: 'IT', name: 'Informatik', asset: '1520', accum: '1529', life: 48 },
    { key: 'fahrzeuge', code: 'FZ', name: 'Fahrzeuge', asset: '1530', accum: '1539', life: 60 },
  ];
  for (const c of cats) {
    const res = tryCall('asset_category_create', {
      workspaceId: W.main, code: c.code, name: c.name, depreciationMethod: 'straight_line',
      usefulLifeMonths: c.life, residualValuePct: 0,
      glAssetAccountId: accId(W.main, c.asset), glAccumDeprAccountId: accId(W.main, c.accum),
      glDeprExpenseAccountId: accId(W.main, '6800'), idempotencyKey: k('p6', 'cat', c.code),
    });
    if (res) H.assetCats[c.key] = oneId(res);
  }
  const assets = [
    { cat: 'maschinen', name: 'Kaffeeröster Seeblick R15', cost: 2800000, date: '2024-03-15', life: 96 },
    { cat: 'fahrzeuge', name: 'Lieferwagen VW Transporter', cost: 3600000, date: '2024-06-01', life: 60 },
    { cat: 'maschinen', name: 'Demo-Espressoeinheit La Riva', cost: 720000, date: '2025-02-10', life: 96 },
    { cat: 'it', name: 'Notebook Service 1', cost: 180000, date: '2024-09-01', life: 48 },
    { cat: 'it', name: 'Notebook Service 2', cost: 180000, date: '2025-01-20', life: 48 },
  ];
  let a = 0;
  for (const as of assets) {
    a += 1;
    if (!H.assetCats[as.cat]) continue;
    tryCall('asset_create', {
      workspaceId: W.main, categoryId: H.assetCats[as.cat], name: as.name,
      acquisitionDate: d(as.date), acquisitionCostRappen: as.cost, depreciationMethod: 'straight_line',
      usefulLifeMonths: as.life, idempotencyKey: k('p6', 'asset', a),
    }, { date: d(as.date) });
  }
  // Depreciation runs, monthly, through month(TODAY)-1 (frozen: through 2026-07).
  const runMonths = allMonths().filter((m) => m <= CAL.monthShift(-1));
  let r = 0;
  for (const m of runMonths) {
    r += 1;
    const created = tryCall('asset_depreciation_run_create', { workspaceId: W.main, period: m, idempotencyKey: k('p6', 'run', r) }, { date: m + '-28' });
    const runId = created ? oneId(created) : null;
    if (runId) tryCall('asset_depreciation_run_post', { workspaceId: W.main, runId, postingDate: m + '-28', idempotencyKey: k('p6', 'runpost', r) }, { date: m + '-28' });
  }
  console.log('  phase6: ' + Object.keys(H.assetCats).length + ' categories, ' + a + ' assets, ' + r + ' depreciation runs');
}

// ===================================================================================================
// PHASE 7: inventory setup (locations + opening stock)
// ===================================================================================================
function phase7() {
  const wh = tryCall('stock_location_upsert', { workspaceId: W.main, name: 'Lager Winterthur', type: 'warehouse', idempotencyKey: k('p7', 'loc', 1) }, { date: d('2025-01-01') });
  H.locations = {};
  if (wh) H.locations.warehouse = oneId(wh) ?? wh.location?.id;
  const van = tryCall('stock_location_upsert', { workspaceId: W.main, name: 'Servicewagen', type: 'warehouse', idempotencyKey: k('p7', 'loc', 2) }, { date: d('2025-01-01') });
  if (van) H.locations.van = oneId(van) ?? van.location?.id;
  // Opening stock receipts for the stocked items.
  const stocked = ITEMS.filter((it) => it.stock);
  let s = 0;
  for (const it of stocked) {
    s += 1;
    if (!H.locations.warehouse) break;
    tryCall('stock_move', {
      workspaceId: W.main, itemId: H.items[it.key], locationId: H.locations.warehouse,
      qty: it.unit === 'kg' ? 200 : 12, reason: 'receipt',
      unitCostMinor: Math.round(it.price * 0.6), movedAt: d('2025-01-01'), idempotencyKey: k('p7', 'openstock', s),
    }, { date: d('2025-01-01') });
  }
  console.log('  phase7: locations + ' + s + ' opening stock receipts');
}

// ===================================================================================================
// PHASE 8: the sales stream (chronological) + the sales lifecycle walkthrough
// ===================================================================================================
function issueSalesInvoice(spec) {
  // The issue (or draft-creation) date is the EVENT date; skip if it lands after TODAY.
  if (skipFuture('invoice', spec.issueDate)) return null;
  const doc = call('create_document', {
    workspaceId: W.main, type: 'invoice', contactId: spec.contactId,
    currency: spec.currency || 'CHF', dueDate: spec.dueDate, lines: spec.lines,
    idempotencyKey: k('p8', 'doc', spec.n),
  }, { date: spec.issueDate });
  const invId = doc.document.id;
  if (spec.draft) {
    H.invoices.push({ id: invId, month: spec.month, draft: true, total: doc.document.totalMinor });
    return { id: invId, draft: true };
  }
  const issued = call('issue_invoice', { workspaceId: W.main, invoiceId: invId, idempotencyKey: k('p8', 'issue', spec.n) }, { date: spec.issueDate });
  const total = issued.document.totalMinor;
  H.invoices.push({ id: invId, contactId: spec.contactId, month: spec.month, open: !!spec.open, overdue: !!spec.overdue, dueDate: spec.dueDate, issueDate: spec.issueDate, currency: spec.currency || 'CHF', total });
  return { id: invId, total, open: !!spec.open };
}

function phase8() {
  const custNames = Object.keys(H.customers);
  const line = (key, qtyMilli) => {
    const it = ITEMS.find((x) => x.key === key);
    return { itemId: H.items[key], description: it.name, quantityMilli: qtyMilli, unitPriceMinor: it.price, taxCode: it.tax };
  };
  let n = 0;
  // Historical paid invoices, two per month, through month(TODAY)-3 (frozen: 2025-01..2026-05).
  const paidMonths = allMonths().filter((m) => m <= CAL.monthShift(-3));
  const itemCycle = ['m3', 'g1', 'b1', 'p2', 's1', 'm1', 'b2', 'g2', 'p1', 's2'];
  for (const [mi, m] of paidMonths.entries()) {
    for (const half of [0, 1]) {
      n += 1;
      const cust = custNames[(mi * 2 + half) % custNames.length];
      const key = itemCycle[(mi + half) % itemCycle.length];
      const issueDate = m + (half === 0 ? '-08' : '-20');
      issueSalesInvoice({
        n, month: m, contactId: H.customers[cust], issueDate,
        dueDate: addDays(issueDate, 30),
        lines: [line(key, 1000), line('s3', 1000)],
      });
    }
  }
  // Two EUR export invoices (echt befreit, EXPORT0) among the historical set.
  for (const [i, m] of [['2025-05'], ['2026-02']].entries()) {
    n += 1;
    const mm = dm(m[0]);
    const issueDate = mm + '-14';
    if (skipFuture('export-invoice', issueDate)) continue;
    ensureRate('EUR', issueDate, '0.9500');
    const it = ITEMS.find((x) => x.key === 'm2');
    issueSalesInvoice({
      n, month: mm, contactId: H.customers['Berghotel Panorama AG'], issueDate,
      dueDate: addDays(issueDate, 45), currency: 'EUR',
      lines: [{ itemId: H.items['m2'], description: it.name + ' (Export)', quantityMilli: 1000, unitPriceMinor: 720000, taxCode: 'EXPORT0' }],
    });
  }
  // Open, not overdue: month(TODAY) (frozen: 2026-08).
  for (const half of [0, 1]) {
    n += 1;
    const issueDate = d('2026-08' + (half === 0 ? '-05' : '-14'));
    issueSalesInvoice({
      n, month: dm('2026-08'), contactId: H.customers[custNames[half]], issueDate,
      dueDate: addDays(issueDate, 30), open: true,
      lines: [line('g2', 1000), line('s1', 4000)],
    });
  }
  // Open + one more not overdue (frozen: 2026-07-28 due 2026-08-27).
  n += 1;
  issueSalesInvoice({
    n, month: dm('2026-07'), contactId: H.customers[custNames[2]], issueDate: d('2026-07-28'),
    dueDate: d('2026-08-27'), open: true, lines: [line('m3', 1000)],
  });
  // Overdue x3 (due before TODAY) -> the dunning targets.
  const overdueSpecs = [
    { cust: 'Rialto Bar GmbH', issue: '2026-06-05', due: '2026-07-05', key: 'm1' },
    { cust: 'Café Sternen', issue: '2026-06-18', due: '2026-07-18', key: 'g1' },
    { cust: 'Bistro Central', issue: '2026-07-02', due: '2026-08-01', key: 'p2' },
  ];
  for (const od of overdueSpecs) {
    n += 1;
    issueSalesInvoice({
      n, month: d(od.issue).slice(0, 7), contactId: H.customers[od.cust], issueDate: d(od.issue),
      dueDate: d(od.due), open: true, overdue: true, lines: [line(od.key, 1000), line('s2', 1000)],
    });
  }
  // One OLD overdue invoice (due ~3 months before TODAY): the phase-18 dunning-escalation target,
  // aged far enough that the level-3 threshold (60 days) is reached. Its own key namespace so the
  // frozen p8 doc/issue key sequence above stays untouched.
  {
    const oldIssue = d('2026-04-20');
    const oldDue = d('2026-05-20');
    if (!skipFuture('dunning-escalation-invoice', oldIssue)) {
      const doc = call('create_document', {
        workspaceId: W.main, type: 'invoice', contactId: H.customers['Gasthof Adler'],
        currency: 'CHF', dueDate: oldDue, lines: [line('m4', 1000), line('s2', 1000)],
        idempotencyKey: k('p8', 'dunold', 1),
      }, { date: oldIssue });
      const issued = call('issue_invoice', { workspaceId: W.main, invoiceId: doc.document.id, idempotencyKey: k('p8', 'dunoldissue', 1) }, { date: oldIssue });
      H.invoices.push({
        id: doc.document.id, contactId: H.customers['Gasthof Adler'], month: oldIssue.slice(0, 7),
        open: true, overdue: true, dueDate: oldDue, issueDate: oldIssue, currency: 'CHF',
        total: issued.document.totalMinor,
      });
    }
  }
  // Two drafts (not issued).
  for (const half of [0, 1]) {
    n += 1;
    issueSalesInvoice({
      n, month: dm('2026-08'), contactId: H.customers[custNames[3 + half]], issueDate: d('2026-08-18'),
      dueDate: d('2026-09-17'), draft: true, lines: [line('m2', 1000), line('s2', 1000)],
    });
  }

  // --- The sales lifecycle walkthrough: quote -> order -> delivery -> invoice (Rialto Bar) ---------
  salesWalkthrough(line);

  const issued = H.invoices.filter((x) => !x.draft).length;
  const open = H.invoices.filter((x) => x.open && !x.draft).length;
  const overdue = H.invoices.filter((x) => x.overdue).length;
  const drafts = H.invoices.filter((x) => x.draft).length;
  console.log('  phase8: ' + H.invoices.length + ' invoices (' + issued + ' issued, ' + open + ' open, ' + overdue + ' overdue, ' + drafts + ' drafts)');

  // Three credit notes against three of the earliest paid invoices.
  const targets = H.invoices.filter((x) => !x.draft && !x.open).slice(0, 3);
  let c = 0;
  const cnDate = d('2026-03-10');
  let cnMade = 0;
  for (const t of targets) {
    c += 1;
    if (skipFuture('credit-note', cnDate)) continue;
    const mode = c === 1 ? 'full' : 'partial';
    const input = { workspaceId: W.main, fromInvoiceId: t.id, mode, reason: 'Rückvergütung', idempotencyKey: k('p8', 'cn', c) };
    if (mode === 'partial') input.amountMinor = Math.round((t.total || 20000) / 4);
    const cn = tryCall('create_credit_note', input, { date: cnDate });
    const cnId = cn ? oneId(cn) : null;
    if (cnId) tryCall('issue_credit_note', { workspaceId: W.main, creditNoteId: cnId, idempotencyKey: k('p8', 'cnissue', c) }, { date: cnDate });
    cnMade += 1;
  }
  console.log('  phase8: ' + cnMade + ' credit notes');
}

function salesWalkthrough(line) {
  // Guard on the LAST event date of the walkthrough so a partially-future chain never posts.
  if (skipFuture('sales-walkthrough', d('2026-06-27'))) return;
  const contactId = H.customers['Rialto Bar GmbH'];
  const quote = tryCall('create_document', {
    workspaceId: W.main, type: 'quote', contactId, dueDate: d('2026-07-15'),
    lines: [line('m1', 1000), line('s2', 1000)], idempotencyKey: k('p8', 'wtquote', 1),
  }, { date: d('2026-06-20') });
  const quoteId = quote ? quote.document?.id : null;
  if (!quoteId) { console.warn('  [skip] sales walkthrough: no quote'); return; }
  tryCall('transition_document', { workspaceId: W.main, documentId: quoteId, to: 'issued', idempotencyKey: k('p8', 'wtissued', 1) }, { date: d('2026-06-21') });
  tryCall('transition_document', { workspaceId: W.main, documentId: quoteId, to: 'sent', idempotencyKey: k('p8', 'wtsent', 1) }, { date: d('2026-06-21') });
  tryCall('transition_document', { workspaceId: W.main, documentId: quoteId, to: 'accepted', idempotencyKey: k('p8', 'wtaccepted', 1) }, { date: d('2026-06-22') });
  const so = tryCall('sales_order_from_quote', { workspaceId: W.main, quoteId, idempotencyKey: k('p8', 'wtso', 1) }, { date: d('2026-06-22') });
  const soId = so ? oneId(so) : null;
  if (!soId) { console.warn('  [skip] sales walkthrough: order not created'); return; }
  tryCall('sales_order_confirm', { workspaceId: W.main, salesOrderId: soId, idempotencyKey: k('p8', 'wtsoc', 1) }, { date: d('2026-06-23') });
  if (H.locations && H.locations.warehouse) {
    const dn = tryCall('delivery_note_create', { workspaceId: W.main, salesOrderId: soId, locationId: H.locations.warehouse, idempotencyKey: k('p8', 'wtdn', 1) }, { date: d('2026-06-25') });
    const dnId = dn ? oneId(dn) : null;
    if (dnId) tryCall('delivery_note_issue', { workspaceId: W.main, deliveryNoteId: dnId, idempotencyKey: k('p8', 'wtdni', 1) }, { date: d('2026-06-26') });
  }
  const inv = tryCall('sales_order_invoice', { workspaceId: W.main, salesOrderId: soId, idempotencyKey: k('p8', 'wtinv', 1) }, { date: d('2026-06-27') });
  if (inv) {
    const invId = oneId(inv);
    H.walkthroughInvoiceId = invId;
    console.log('  phase8: sales walkthrough quote->order->delivery->invoice (' + soId + ')');
  }
}

// ===================================================================================================
// PHASE 9: recurring + retainer
// ===================================================================================================
function phase9() {
  const bean = tryCall('create_recurring_schedule', {
    workspaceId: W.main, name: 'Bohnen-Abo monatlich', contactId: H.customers['Coworking Kafi AG'],
    lines: [{ description: 'Kaffeebohnen Hausmischung (10kg)', unitPriceMinor: 24000, taxCode: 'UST26' }],
    interval: 'monthly', anchorDate: d('2026-01-01'), dueDays: 30, autoIssue: true, idempotencyKey: k('p9', 'rec', 1),
  }, { date: d('2026-01-01') });
  const service = tryCall('create_recurring_schedule', {
    workspaceId: W.main, name: 'Service-Vertrag quartalsweise', contactId: H.customers['Hotel Blaustern AG'],
    lines: [{ description: 'Wartung quartalsweise', unitPriceMinor: 90000, taxCode: 'UST81' }],
    interval: 'quarterly', anchorDate: d('2026-01-01'), dueDays: 30, autoIssue: false, idempotencyKey: k('p9', 'rec', 2),
  }, { date: d('2026-01-01') });
  tryCall('run_due_recurring', { workspaceId: W.main, asOf: TODAY }, { date: TODAY });
  const ret = tryCall('retainer_create', {
    workspaceId: W.main, contactId: H.customers['Berghotel Panorama AG'], period: 'monthly',
    feeRappen: 120000, includedHours: 8, rollover: true, startsOn: d('2026-01-01'), idempotencyKey: k('p9', 'ret', 1),
  }, { date: d('2026-01-01') });
  tryCall('retainer_run_due', { workspaceId: W.main, asOf: TODAY }, { date: TODAY });
  console.log('  phase9: ' + [bean, service].filter(Boolean).length + ' recurring schedules, ' + (ret ? 1 : 0) + ' retainer');
}

// ===================================================================================================
// PHASE 10: projects + time
// ===================================================================================================
function phase10() {
  tryCall('rate_card_upsert', { workspaceId: W.main, scope: 'default', rateMinor: 15500, costRateMinor: 8000, validFrom: d('2025-01-01'), idempotencyKey: k('p10', 'rate', 1) }, { date: d('2025-01-01') });
  const projects = [
    { key: 'p1', name: 'Installation Hotel Blaustern', contact: 'Hotel Blaustern AG', start: '2025-03-01', budget: 1200000, done: true },
    { key: 'p2', name: 'Röster-Setup Rösterei Partner', contact: 'Rösterei Partner AG', start: '2026-02-01', budget: 1800000, done: false },
    { key: 'p3', name: 'Service-Retrofit Berghotel', contact: 'Berghotel Panorama AG', start: '2026-05-01', budget: 900000, done: false },
  ];
  for (const p of projects) {
    const start = d(p.start);
    if (skipFuture('project', start)) continue;
    const res = tryCall('project_create', { workspaceId: W.main, name: p.name, contactId: H.customers[p.contact], budgetMinor: p.budget, startsOn: start, idempotencyKey: k('p10', 'proj', p.key) }, { date: start });
    if (res) {
      H.projects[p.key] = oneId(res);
      tryCall('project_phase_add', { workspaceId: W.main, projectId: H.projects[p.key], name: 'Ausführung', budgetHours: 40, idempotencyKey: k('p10', 'phase', p.key) }, { date: start });
    }
  }
  // ~60 time entries across the three projects.
  let t = 0;
  const projKeys = Object.keys(H.projects);
  if (projKeys.length > 0) {
    for (let i = 0; i < 60; i += 1) {
      const pk = projKeys[i % projKeys.length];
      const monthIdx = i % 8;
      const day = String((i % 27) + 1).padStart(2, '0');
      const workDay = d('2026-0' + ((monthIdx % 8) + 1) + '-' + day);
      // The frozen seed contains ONE time entry started after its TODAY (2026-08-24); identity
      // mode preserves it verbatim so the default output stays byte-identical. A rolled calendar
      // skips post-TODAY entries.
      if (!CAL.identity && skipFuture('time-entry', workDay)) continue;
      const startedAt = workDay + 'T08:00:00.000Z';
      t += 1;
      tryCall('time_log', {
        workspaceId: W.main, userId: 'user_1', projectId: H.projects[pk],
        startedAt, minutes: 60 + (i % 4) * 30, billable: i % 5 !== 0, notes: 'Serviceeinsatz',
        idempotencyKey: k('p10', 'time', t),
      });
    }
  }
  console.log('  phase10: ' + projKeys.length + ' projects, ' + t + ' time entries');
}

// ===================================================================================================
// PHASE 11: purchasing (PO->receipt->bill->3-way-match; ~25 bills incl. FX + import VAT; capture)
// ===================================================================================================
function phase11() {
  H.vendorBills = [];
  // The purchase lifecycle walkthrough: Italian supplier (EUR), PO -> receipt -> bill -> match.
  purchaseWalkthrough();

  // ~24 more ordinary bills across the span: rent, utilities, roastery restocks, plus FX imports.
  const rent = H.suppliers['Immo Technikum AG'];
  const util = H.suppliers['Stadtwerke Winterthur'];
  const roast = H.suppliers['Rösterei Ostschweiz AG'];
  const itSaaS = H.suppliers['Grind Parts Inc'];
  const months = allMonths().filter((m) => m <= CAL.monthShift(-1));
  let n = 0;
  for (const m of months) {
    // Monthly rent (CHF)
    n += 1;
    postBill({ n, vendor: rent, date: m + '-01', amount: 320000, gross: true, tax: 'VST-M', acct: '6000', label: 'Miete' });
    // Utilities every other month
    if (Number(m.slice(5)) % 2 === 0) {
      n += 1;
      postBill({ n, vendor: util, date: m + '-05', amount: 48000, gross: true, tax: 'VST-M', acct: '6500', label: 'Strom' });
    }
    // Roastery restock (CHF) roughly quarterly
    if (Number(m.slice(5)) % 3 === 1) {
      n += 1;
      postBill({ n, vendor: roast, date: m + '-10', amount: 260000, gross: true, tax: 'VST-M', acct: '4200', label: 'Bohnen Einkauf' });
    }
  }
  // Three FX bills (EUR/USD import) with import/reverse-charge VAT.
  n += 1;
  postBill({ n, vendor: H.suppliers['Macchine Espresso SRL'], date: d('2026-03-12'), amount: 480000, gross: false, tax: 'BEZUG', acct: '4200', label: 'Maschine Import', currency: 'EUR', fxRate: '0.9500' });
  n += 1;
  postBill({ n, vendor: itSaaS, date: d('2026-04-08'), amount: 150000, gross: false, tax: 'BEZUG', acct: '4200', label: 'Ersatzteile USA', currency: 'USD', fxRate: '0.8800' });
  n += 1;
  postBill({ n, vendor: H.suppliers['Macchine Espresso SRL'], date: d('2026-06-20'), amount: 620000, gross: false, tax: 'BEZUG', acct: '4200', label: 'Maschine Import', currency: 'EUR', fxRate: '0.9450' });

  // Capture inbox: 3 documents (2 pending, 1 committed to a bill).
  captureInbox();

  console.log('  phase11: ' + H.vendorBills.length + ' vendor bills (incl. FX imports)');
}

function postBill(o) {
  if (skipFuture('vendor-bill', o.date)) return null;
  const input = {
    workspaceId: W.main, vendorId: o.vendor, billDate: o.date, dueDate: addDays(o.date, 30),
    amountMinor: o.amount, amountIsGross: !!o.gross, taxCode: o.tax,
    expenseAccountId: accId(W.main, o.acct), vendorReference: o.label, idempotencyKey: k('p11', 'bill', o.n),
  };
  if (o.currency) { input.currency = o.currency; input.fxRate = o.fxRate; ensureRate(o.currency, o.date, o.fxRate); }
  const bill = call('create_vendor_bill', input, { date: o.date });
  const billId = bill.vendorBillId;
  // Leave the last month's bills (month(TODAY)-1, frozen: 2026-07) unposted/open.
  const open = o.date >= CAL.monthShift(-1) + '-01';
  if (!open) call('post_vendor_bill', { workspaceId: W.main, vendorBillId: billId, idempotencyKey: k('p11', 'billpost', o.n) }, { date: o.date });
  H.vendorBills.push({ id: billId, vendor: o.vendor, total: o.amount, open, date: o.date, posted: !open, fx: !!o.currency });
  return billId;
}

function purchaseWalkthrough() {
  // Guard on the LAST event date of the chain (frozen: 2026-02-13).
  if (skipFuture('purchase-walkthrough', d('2026-02-13'))) return;
  const vendor = H.suppliers['Macchine Espresso SRL'];
  const loc = H.locations && H.locations.warehouse;
  if (!vendor || !loc) { console.warn('  [skip] purchase walkthrough: missing vendor/location'); return; }
  const po = tryCall('po_upsert', { workspaceId: W.main, supplierContactId: vendor, currency: 'EUR', lines: [{ itemId: H.items['m1'], qty: 3, unitPriceRappen: 300000 }], idempotencyKey: k('p11', 'po', 1) }, { date: d('2026-02-01') });
  const poId = po ? po.poId : null;
  if (!poId) { console.warn('  [skip] purchase walkthrough: no PO'); return; }
  tryCall('po_send', { workspaceId: W.main, poId, idempotencyKey: k('p11', 'posend', 1) }, { date: d('2026-02-02') });
  const detail = tryCall('po_get', { workspaceId: W.main, poId });
  const poLineId = detail && detail.lines && detail.lines[0] ? detail.lines[0].id : null;
  if (poLineId) tryCall('receipt_record', { workspaceId: W.main, poId, locationId: loc, lines: [{ poLineId, qty: 3 }], idempotencyKey: k('p11', 'receipt', 1) }, { date: d('2026-02-10') });
  ensureRate('EUR', d('2026-02-12'), '0.9500');
  const bill = tryCall('create_vendor_bill', {
    workspaceId: W.main, vendorId: vendor, billDate: d('2026-02-12'), amountMinor: 900000, amountIsGross: false,
    taxCode: 'BEZUG', expenseAccountId: accId(W.main, '4200'), currency: 'EUR', fxRate: '0.9500', vendorReference: 'Maschinen Charge', idempotencyKey: k('p11', 'wtbill', 1),
  }, { date: d('2026-02-12') });
  const billId = bill ? bill.vendorBillId : null;
  if (billId) {
    call('post_vendor_bill', { workspaceId: W.main, vendorBillId: billId, idempotencyKey: k('p11', 'wtbillpost', 1) }, { date: d('2026-02-12') });
    tryCall('match_bill', { workspaceId: W.main, poId, billId, override: true, idempotencyKey: k('p11', 'match', 1) }, { date: d('2026-02-13') });
    H.walkthroughBillId = billId;
    console.log('  phase11: purchase walkthrough PO->receipt->bill->3-way-match');
  }
}

function captureInbox() {
  const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  let c = 0;
  for (const i of [1, 2, 3]) {
    if (skipFuture('capture-document', d('2026-07-15'))) continue;
    c += 1;
    const cap = tryCall('capture_document', { workspaceId: W.main, contentBase64: tinyPng, mime: 'image/png', filename: 'beleg-' + i + '.png', idempotencyKey: k('p11', 'capture', i) }, { date: d('2026-07-15') });
    const capId = cap ? oneId(cap) : null;
    if (capId && i === 3) {
      // Commit one into a bill; leave two pending.
      tryCall('capture_extract', { workspaceId: W.main, captureId: capId, source: 'manual', idempotencyKey: k('p11', 'capextract', i) }, { date: d('2026-07-15') });
    }
  }
  console.log('  phase11: ' + c + ' capture inbox documents');
}

// ===================================================================================================
// PHASE 12: settlement (AR + AP payments, batch/pain001, incoming QR credits, CAMT import)
// ===================================================================================================
function phase12() {
  // Settle the paid AR invoices (everything not marked open/draft), ~10 days after issue.
  let p = 0;
  for (const inv of H.invoices) {
    if (inv.draft || inv.open) continue;
    if (inv.currency && inv.currency !== 'CHF') continue; // FX AR settled via bank EUR, skip for simplicity
    const payDate = addDays(inv.dueDate || inv.issueDate, -5);
    if (skipFuture('ar-payment', payDate)) continue;
    p += 1;
    call('record_payment', {
      workspaceId: W.main, direction: 'incoming', date: payDate, amountMinor: inv.total,
      bankAccountId: H.banks.chfLedger, counterpartyKind: 'customer', counterpartyId: inv.contactId,
      allocations: [{ documentId: inv.id, amountMinor: inv.total }],
      intent: 'post_payment', idempotencyKey: k('p12', 'arpay', p),
    }, { date: payDate });
  }
  console.log('  phase12: ' + p + ' AR payments recorded');

  // Settle most posted AP bills; leave a few open.
  let a = 0;
  // FX bills settle cross-currency (a separate flow); leave them as open FX payables for the reval.
  const settle = H.vendorBills.filter((b) => b.posted && !b.fx && b.date < CAL.monthShift(-2) + '-01');
  for (const b of settle) {
    const payDate = addDays(b.date, 20);
    if (skipFuture('ap-payment', payDate)) continue;
    a += 1;
    tryCall('record_payment', {
      workspaceId: W.main, direction: 'outgoing', date: payDate, amountMinor: b.total,
      bankAccountId: H.banks.chfLedger, counterpartyKind: 'supplier', counterpartyId: b.vendor,
      allocations: [{ vendorBillId: b.id, amountMinor: b.total }],
      intent: 'post_payment', idempotencyKey: k('p12', 'appay', a),
    }, { date: payDate });
  }
  console.log('  phase12: ' + a + ' AP payments recorded');

  // Creditor payment batch (pain.001) for one supplier run: pick an open posted bill.
  const openPosted = H.vendorBills.filter((b) => b.posted && b.date >= CAL.monthShift(-2) + '-01');
  if (openPosted.length > 0 && !skipFuture('payment-batch', d('2026-08-01'))) {
    const batch = tryCall('create_payment_batch', { workspaceId: W.main, bankAccountId: H.banks.chf, itemIds: [openPosted[0].id], executionDate: d('2026-08-01'), idempotencyKey: k('p12', 'batch', 1) }, { date: d('2026-07-25') });
    const batchId = batch ? oneId(batch) : null;
    if (batchId) {
      tryCall('generate_pain001', { workspaceId: W.main, batchId, idempotencyKey: k('p12', 'pain', 1) }, { date: d('2026-07-25') });
      tryCall('mark_batch_paid', { workspaceId: W.main, batchId, confirmation: true, valueDate: d('2026-08-01'), idempotencyKey: k('p12', 'batchpaid', 1) }, { date: d('2026-08-01') });
      console.log('  phase12: creditor payment batch + pain.001 + marked paid');
    }
  }

  // Incoming QR credits: 4, two auto-applied to open invoices, two left unmatched.
  const openInvs = H.invoices.filter((x) => x.open && !x.draft && (!x.currency || x.currency === 'CHF'));
  // `credit` feeds the idempotency keys and increments BEFORE the skip (stable keys across
  // TODAYs); `crMade` feeds the printed total and counts only what was actually recorded.
  let credit = 0;
  let crMade = 0;
  const qrDate1 = d('2026-08-20');
  const qrDate2 = d('2026-08-21');
  for (let i = 0; i < Math.min(2, openInvs.length); i += 1) {
    credit += 1;
    if (skipFuture('qr-credit', qrDate1)) continue;
    const inv = openInvs[i];
    const cr = tryCall('record_incoming_credit', {
      workspaceId: W.main, bankAccountId: H.banks.chf, amountMinor: inv.total,
      valueDate: qrDate1, reference: 'RF' + (10 + i), payerName: 'Kunde', idempotencyKey: k('p12', 'qrc', credit),
    }, { date: qrDate1 });
    const creditId = cr ? oneId(cr) : null;
    if (creditId) tryCall('apply_qr_match', { workspaceId: W.main, creditId, invoiceId: inv.id, confirmed: true, idempotencyKey: k('p12', 'qrapply', credit) }, { date: qrDate1 });
    crMade += 1;
  }
  // Two unmatched credits sitting in the queue.
  for (let i = 0; i < 2; i += 1) {
    credit += 1;
    if (skipFuture('qr-credit', qrDate2)) continue;
    tryCall('record_incoming_credit', {
      workspaceId: W.main, bankAccountId: H.banks.chf, amountMinor: 45000 + i * 12000,
      valueDate: qrDate2, reference: 'RF' + (90 + i), payerName: 'Unbekannt', idempotencyKey: k('p12', 'qrc', credit),
    }, { date: qrDate2 });
    crMade += 1;
  }
  console.log('  phase12: ' + crMade + ' incoming QR credits');

  // CAMT import: two statements, one fully suggested/confirmed, one with unmatched lines.
  camtImport();
}

/**
 * Build a camt.053 statement. `period` carries ALREADY-REMAPPED dates (callers run them through
 * the CAL helpers): { from, to, created } as YYYY-MM-DD, plus optional { openingMinor,
 * closingMinor } balances in Rappen (both CRDT; defaults keep the frozen phase-12 statements
 * byte-stable at 1000.00 / 5000.00).
 */
function camtBuilder(statementId, entries, iban, period) {
  const ntrys = entries.map((e) => {
    const amount = (e.amountMinor / 100).toFixed(2);
    const rmt = e.reference ? '<NtryDtls><TxDtls><RmtInf><Strd><CdtrRefInf><Tp><CdOrPrtry><Cd>SCOR</Cd></CdOrPrtry></Tp><Ref>' + e.reference + '</Ref></CdtrRefInf></Strd></RmtInf></TxDtls></NtryDtls>' : '';
    return '<Ntry><NtryRef>' + e.ref + '</NtryRef><Amt Ccy="CHF">' + amount + '</Amt><CdtDbtInd>' + e.cd + '</CdtDbtInd>' +
      '<Sts><Cd>BOOK</Cd></Sts><RvslInd>false</RvslInd>' +
      '<BookgDt><Dt>' + e.date + '</Dt></BookgDt><ValDt><Dt>' + e.date + '</Dt></ValDt>' +
      '<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>' +
      rmt + '</Ntry>';
  }).join('\n');
  const bal = (code, minor) =>
    '<Bal><Tp><CdOrPrtry><Cd>' + code + '</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">' + (minor / 100).toFixed(2) + '</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>';
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">\n' +
    '<BkToCstmrStmt><GrpHdr><MsgId>' + statementId + '-msg</MsgId><CreDtTm>' + period.created + 'T08:00:00</CreDtTm></GrpHdr>\n' +
    '<Stmt><Id>' + statementId + '</Id><ElctrncSeqNb>1</ElctrncSeqNb>\n' +
    '<FrToDt><FrDtTm>' + period.from + 'T00:00:00</FrDtTm><ToDtTm>' + period.to + 'T23:59:59</ToDtTm></FrToDt>\n' +
    '<Acct><Id><IBAN>' + iban + '</IBAN></Id></Acct>\n' +
    bal('OPBD', period.openingMinor ?? 100000) + '\n' +
    bal('CLBD', period.closingMinor ?? 500000) + '\n' +
    ntrys + '\n</Stmt></BkToCstmrStmt></Document>';
}

function camtImport() {
  // The whole statement (period, entries, import) lives on the remapped calendar; if the import
  // date lands after TODAY the statement does not exist yet.
  const importDate = d('2026-08-01');
  if (skipFuture('camt-import', importDate)) return;
  const iban = 'CH9300762011623852957';
  const julyPeriod = { from: d('2026-07-01'), to: d('2026-07-31'), created: d('2026-08-01') };
  const s1 = camtBuilder('SEED-CAMT-1', [
    { ref: 'E1', amountMinor: 108100, cd: 'CRDT', date: d('2026-07-10'), reference: 'RF18' },
    { ref: 'E2', amountMinor: 32000, cd: 'DBIT', date: d('2026-07-12') },
  ], iban, julyPeriod);
  const imp1 = tryCall('import_camt', { workspaceId: W.main, bankAccountId: H.banks.chf, xml: s1, idempotencyKey: k('p12', 'camt', 1) }, { date: importDate });
  const stmt1 = imp1 ? (imp1.statementId ?? imp1.statement?.id ?? oneId(imp1)) : null;
  if (stmt1) tryCall('suggest_matches', { workspaceId: W.main, statementId: stmt1 }, { date: importDate });
  const s2 = camtBuilder('SEED-CAMT-2', [
    { ref: 'U1', amountMinor: 21000, cd: 'CRDT', date: d('2026-07-20') },
    { ref: 'U2', amountMinor: 9900, cd: 'CRDT', date: d('2026-07-22') },
    { ref: 'U3', amountMinor: 15500, cd: 'DBIT', date: d('2026-07-25') },
  ], iban, julyPeriod);
  const imp2 = tryCall('import_camt', { workspaceId: W.main, bankAccountId: H.banks.chf, xml: s2, idempotencyKey: k('p12', 'camt', 2) }, { date: importDate });
  const stmt2 = imp2 ? (imp2.statementId ?? imp2.statement?.id ?? oneId(imp2)) : null;
  if (stmt2) tryCall('suggest_matches', { workspaceId: W.main, statementId: stmt2 }, { date: importDate });
  console.log('  phase12: 2 CAMT statements imported' + (stmt1 ? ' (suggested)' : ''));
}

// ===================================================================================================
// PHASE 13: dunning
// ===================================================================================================
function phase13() {
  tryCall('set_dunning_config', {
    workspaceId: W.main,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 0 },
      { level: 2, daysOverdue: 30, feeMinor: 2000, bookFee: true, feeIncomeAccountId: accId(W.main, '3200') },
      { level: 3, daysOverdue: 60, feeMinor: 5000, bookFee: true, feeIncomeAccountId: accId(W.main, '3200') },
    ],
    idempotencyKey: k('p13', 'dunconf', 1),
  }, { date: TODAY });
  // The escalation invoice (due d('2026-05-20')) gets its LEVEL 1 letter at a REAL past date, so its
  // issued_at anchors the K-60 minimum-interval clock in the past rather than at TODAY. At this asOf
  // only that invoice is overdue (the phase-8 "overdue x3" invoices come due in July/August), so this
  // stays the level-1-only run; phase 18 walks the same invoice up to level 3 on later historical
  // dates spaced >= the min-interval, and dun the July/August receivables at TODAY.
  const l1AsOf = d('2026-06-05');
  if (skipFuture('dunning-level1', l1AsOf)) {
    console.log('  phase13: dunning config set (level-1 date is future, skipped)');
    return;
  }
  const run = tryCall('propose_dunning_run', { workspaceId: W.main, asOf: l1AsOf, idempotencyKey: k('p13', 'dunpropose', 1) }, { date: l1AsOf });
  const runId = run && run.proposed !== false ? oneId(run) : null;
  if (runId) {
    tryCall('issue_dunning_run', { workspaceId: W.main, runId, confirmed: true, idempotencyKey: k('p13', 'dunissue', 1) }, { date: l1AsOf });
    console.log('  phase13: dunning run proposed + issued at ' + l1AsOf + ' (level 1, not sent)');
  } else {
    console.log('  phase13: dunning config set (no proposable run)');
  }
}

// ===================================================================================================
// PHASE 14: period close + VAT filing + FX revaluation (order-sensitive, best-effort)
// ===================================================================================================
function phase14() {
  // FX revaluation at period ends (Dec 31 of year(TODAY)-1 is always past; the mid-year point is
  // skipped, counted, when the rolled TODAY has not reached it yet).
  const ye = d('2025-12-31');
  const h1 = d('2026-06-30');
  tryCall('post_fx_revaluation', { workspaceId: W.main, periodEnd: ye, idempotencyKey: k('p14', 'fxrev', 1) }, { date: ye });
  if (!skipFuture('fx-revaluation', h1)) {
    tryCall('post_fx_revaluation', { workspaceId: W.main, periodEnd: h1, idempotencyKey: k('p14', 'fxrev', 2) }, { date: h1 });
  }

  // Close months: Jan-Nov of year(TODAY)-1 (leave Dec open) and Jan..month(TODAY)-2 of year(TODAY)
  // (frozen: 2025-01..11 and 2026-01..06).
  const prevYear = String(Number(TODAY.slice(0, 4)) - 1).padStart(4, '0');
  const curYear = TODAY.slice(0, 4);
  const closeCut = CAL.monthShift(-2);
  const closeMonths = [];
  for (let m = 1; m <= 11; m += 1) closeMonths.push(prevYear + '-' + String(m).padStart(2, '0'));
  for (let m = 1; m <= 12; m += 1) {
    const mm = curYear + '-' + String(m).padStart(2, '0');
    if (mm <= closeCut) closeMonths.push(mm);
  }
  let closed = 0;
  for (const m of closeMonths) {
    const res = tryCall('close_month', { workspaceId: W.main, period: m, idempotencyKey: k('p14', 'close', m) }, { date: m + '-28' });
    if (res) closed += 1;
  }
  // VAT: file all four quarters of year(TODAY)-1 plus every quarter of year(TODAY) that ended by
  // month(TODAY)-4; prepare (read) the following quarter. Frozen: file 2025-Q1..2026-Q1, read Q2.
  const fileCut = CAL.monthShift(-4);
  const quarters = [];
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) quarters.push(prevYear + '-' + q);
  const qEndMonth = { Q1: '03', Q2: '06', Q3: '09', Q4: '12' };
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
    if (curYear + '-' + qEndMonth[q] <= fileCut) quarters.push(curYear + '-' + q);
  }
  const filed = [];
  for (const q of quarters) {
    const res = tryCall('vat_mark_filed', { workspaceId: W.main, period: q, idempotencyKey: k('p14', 'vatfile', q) }, { date: TODAY });
    if (res) filed.push(q);
  }
  // "Prepare the next quarter" (a read): the quarter after the last filed one, clamped to the
  // quarter TODAY sits in so the read stays meaningful at any rolled TODAY (never a quarter that
  // has not started yet).
  const filedCur = quarters.filter((q) => q.startsWith(curYear + '-')).length;
  const todayQ = Math.floor((Number(TODAY.slice(5, 7)) - 1) / 3) + 1;
  const nextQ = Math.min(filedCur + 1, todayQ);
  const qEnds = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
  tryCall('vat_return', {
    workspaceId: W.main,
    periodStart: curYear + '-' + String(nextQ * 3 - 2).padStart(2, '0') + '-01',
    periodEnd: curYear + '-' + qEnds[nextQ],
  });
  console.log('  phase14: ' + closed + ' months closed, VAT filed: ' + filed.join(', '));
}

// ===================================================================================================
// PHASE 15: human/agent surface layer + the thin second workspace (E5)
// ===================================================================================================
function phase15() {
  // Tasks (mix of due/overdue).
  const taskSpecs = [
    { title: 'Q2 MWST-Abrechnung einreichen', due: '2026-08-31' },
    { title: 'Überfällige Rechnung Rialto nachfassen', due: '2026-08-10' },
    // The year rolls with the calendar: Dezember of year(TODAY)-1 is the open year-end month.
    { title: 'Jahresabschluss Dezember ' + (Number(TODAY.slice(0, 4)) - 1) + ' vorbereiten', due: '2026-09-15' },
    { title: 'Inventur Lager Winterthur', due: '2026-08-20' },
    { title: 'Lieferwagen Service buchen', due: '2026-09-01' },
    { title: 'Neuen Bohnen-Lieferanten evaluieren', due: '2026-10-01' },
    { title: 'Preisliste Gastro aktualisieren', due: '2026-08-25' },
    { title: 'Offene Kreditorenzahlungen freigeben', due: '2026-08-24' },
  ];
  let t = 0;
  for (const ts of taskSpecs) {
    t += 1;
    tryCall('tasks_create', { workspaceId: W.main, title: ts.title, assigneeUserId: 'user_1', dueAt: d(ts.due) + 'T09:00:00.000Z', idempotencyKey: k('p15', 'task', t) }, { date: TODAY });
  }
  // Saved views + custom fields.
  tryCall('create_saved_view', { workspaceId: W.main, entityKind: 'contact', name: 'Gastro-Kunden', filters: { segment: 'gastro' }, idempotencyKey: k('p15', 'view', 1) });
  tryCall('create_saved_view', { workspaceId: W.main, entityKind: 'document', name: 'Überfällige Rechnungen', filters: { type: 'invoice', status: 'overdue' }, idempotencyKey: k('p15', 'view', 2) });
  tryCall('define_field', { workspaceId: W.main, entityKind: 'item', key: 'herkunft', labelI18n: { 'de-CH': 'Herkunft', en: 'Origin' }, type: 'text', idempotencyKey: k('p15', 'field', 1) });
  tryCall('define_field', { workspaceId: W.main, entityKind: 'contact', key: 'kundentyp', labelI18n: { 'de-CH': 'Kundentyp', en: 'Customer type' }, type: 'text', idempotencyKey: k('p15', 'field', 2) });
  // Automation rules.
  tryCall('create_automation_rule', { workspaceId: W.main, name: 'Neukunde taggen', trigger: { event: 'contact.created' }, action: { tool: 'contacts_tag', inputTemplate: { contactId: 'x', segments: ['neu'] } }, enabled: true, idempotencyKey: k('p15', 'rule', 1) });
  tryCall('create_automation_rule', { workspaceId: W.main, name: 'Überfällige mahnen', trigger: { event: 'period.closed' }, action: { tool: 'propose_dunning_run', inputTemplate: {} }, enabled: false, idempotencyKey: k('p15', 'rule', 2) });
  // A Treuhänder member.
  tryCall('invite_member', { workspaceId: W.main, email: 'treuhand@seeblick.example', role: 'treuhaender', displayName: 'Treuhand Partner', idempotencyKey: k('p15', 'member', 1) });
  // A file linked to a bill/contact.
  const tinyPdf = Buffer.from('%PDF-1.4 seed').toString('base64');
  tryCall('files_upload', { workspaceId: W.main, title: 'Signierter Servicevertrag', filename: 'vertrag.pdf', contentBase64: tinyPdf, mime: 'application/pdf', idempotencyKey: k('p15', 'file', 1) });

  // The thin second workspace (E5): a Treuhänder/multi-client switch + Members/Review target.
  const thin = tryCall('create_workspace', { name: 'Kleinatelier Muster GmbH', legalForm: 'gmbh', baseCurrency: 'CHF', fiscalYearStart: '01-01', idempotencyKey: k('p15', 'thinws', 1) }, { date: d('2026-01-01') });
  if (thin) {
    W.thin = thin.workspaceId;
    tryCall('vat_configure', { workspaceId: W.thin, method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: k('p15', 'thinvat', 1) }, { date: d('2026-01-01') });
    const c = tryCall('create_contact', { workspaceId: W.thin, partyRole: 'customer', name: 'Atelier Kunde AG', idempotencyKey: k('p15', 'thincontact', 1) });
    if (c && c.contact) {
      const it = tryCall('create_item', { workspaceId: W.thin, name: 'Beratung', defaultUnitPriceMinor: 18000, unit: 'hour', defaultTaxCode: 'UST81', idempotencyKey: k('p15', 'thinitem', 1) });
      if (it && it.item && !skipFuture('thin-invoice', d('2026-07-15'))) {
        const doc = tryCall('create_document', { workspaceId: W.thin, type: 'invoice', contactId: c.contact.id, dueDate: d('2026-08-30'), lines: [{ itemId: it.item.id, description: 'Beratung', quantityMilli: 5000, unitPriceMinor: 18000, taxCode: 'UST81' }], idempotencyKey: k('p15', 'thindoc', 1) }, { date: d('2026-07-15') });
        if (doc && doc.document) tryCall('issue_invoice', { workspaceId: W.thin, invoiceId: doc.document.id, idempotencyKey: k('p15', 'thinissue', 1) }, { date: d('2026-07-15') });
      }
    }
    tryCall('invite_member', { workspaceId: W.thin, email: 'treuhand@seeblick.example', role: 'treuhaender', displayName: 'Treuhand Partner', idempotencyKey: k('p15', 'thinmember', 1) });
  }
  console.log('  phase15: ' + t + ' tasks, saved views, fields, automations, member, file; thin workspace ' + (W.thin || 'skipped'));
}

// ===================================================================================================
// PHASE 16: payments realism (WP2 item a)
// Partial + split payments, an overpayment (on-account remainder, later allocated), an
// underpayment with write-off, settlement of the EUR export invoices (realised FX difference on
// 3806), and a three-instalment chain. Every event is anchored on month(TODAY)-1 or TODAY, both
// always in the past and always OPEN periods (phase 14 closes through month(TODAY)-2), so this
// phase seeds in full at ANY rolled TODAY: zero skips by construction.
// ===================================================================================================
/** The posted-ledger balance of an account (by number) in base Rappen. `exclusive` = strictly before `date`. */
function ledgerBalanceAt(accountNumber, date, exclusive = false) {
  const id = accId(W.main, accountNumber);
  const cmp = exclusive ? '<' : '<=';
  const row = store.db
    .prepare(
      `SELECT COALESCE(SUM(l.base_debit_minor - l.base_credit_minor), 0) AS net
         FROM journal_line l JOIN journal_entry e ON e.id = l.entry_id
        WHERE e.workspace_id = ? AND l.account_id = ? AND e.status = 'posted' AND e.date ${cmp} ?`,
    )
    .get(W.main, id, date);
  return row.net;
}

function phase16() {
  const M1 = CAL.monthShift(-1);
  const dd = (day) => M1 + '-' + day;
  const line16 = (key, qtyMilli) => {
    const it = ITEMS.find((x) => x.key === key);
    return { itemId: H.items[key], description: it.name, quantityMilli: qtyMilli, unitPriceMinor: it.price, taxCode: it.tax };
  };
  const mkInvoice = (n, custName, issueDate, lines) => {
    // create_document + issue_invoice as two steps (the phase-8 idiom).
    const doc = call('create_document', {
      workspaceId: W.main, type: 'invoice', contactId: H.customers[custName], currency: 'CHF',
      dueDate: addDays(issueDate, 30), lines, idempotencyKey: k('p16', 'doc', n),
    }, { date: issueDate });
    const issued = call('issue_invoice', { workspaceId: W.main, invoiceId: doc.document.id, idempotencyKey: k('p16', 'issue', n) }, { date: issueDate });
    return { id: doc.document.id, total: issued.document.totalMinor, contactId: H.customers[custName] };
  };
  const pay = (n, input, date) =>
    call('record_payment', { workspaceId: W.main, direction: 'incoming', date, bankAccountId: H.banks.chfLedger, counterpartyKind: 'customer', intent: 'post_payment', idempotencyKey: k('p16', 'pay', n), ...input }, { date });

  // 1) Partial payment + completing second payment.
  const invA = mkInvoice(1, 'Gasthof Adler', dd('03'), [line16('m3', 1000), line16('s3', 1000)]);
  pay(1, { amountMinor: 100000, counterpartyId: invA.contactId, allocations: [{ documentId: invA.id, amountMinor: 100000 }] }, dd('10'));
  pay(2, { amountMinor: invA.total - 100000, counterpartyId: invA.contactId, allocations: [{ documentId: invA.id, amountMinor: invA.total - 100000 }] }, dd('18'));

  // 2) One SPLIT payment settling two invoices at once.
  const invB = mkInvoice(2, 'Bäckerei Meier & Co', dd('04'), [line16('b1', 20000)]);
  const invC = mkInvoice(3, 'Bäckerei Meier & Co', dd('05'), [line16('b2', 15000)]);
  pay(3, {
    amountMinor: invB.total + invC.total, counterpartyId: invB.contactId,
    allocations: [{ documentId: invB.id, amountMinor: invB.total }, { documentId: invC.id, amountMinor: invC.total }],
  }, dd('12'));

  // 3) Overpayment: the surplus stays on account, then allocate_payment moves it onto the NEXT
  //    open invoice of the same customer.
  const invD = mkInvoice(4, 'Coworking Kafi AG', dd('06'), [line16('g1', 1000)]);
  const invE = mkInvoice(5, 'Coworking Kafi AG', dd('07'), [line16('p2', 2000)]);
  const over = pay(4, {
    amountMinor: invD.total + 15000, counterpartyId: invD.contactId,
    allocations: [{ documentId: invD.id, amountMinor: invD.total }], onAccountMinor: 15000,
  }, dd('15'));
  const overId = over.payment?.id ?? over.paymentId ?? oneId(over);
  call('allocate_payment', {
    workspaceId: W.main, paymentId: overId,
    allocations: [{ documentId: invE.id, amountMinor: 15000 }],
    intent: 'allocate_payment', idempotencyKey: k('p16', 'alloc', 1),
  }, { date: dd('16') });

  // 4) A pure on-account payment left UNALLOCATED: the standing suggest_payment_matches target.
  pay(5, { amountMinor: 32000, counterpartyId: H.customers['Hotel Blaustern AG'], onAccountMinor: 32000 }, dd('16'));
  tryCall('suggest_payment_matches', { workspaceId: W.main, amountMinor: 32000, counterpartyId: H.customers['Hotel Blaustern AG'], direction: 'incoming' });

  // 5) Underpayment with an explicit write-off (Rappen tolerance, US-A14 write-off path).
  const invF = mkInvoice(6, 'Kafi Rösterei Turm', dd('08'), [line16('b3', 8000)]);
  pay(6, {
    amountMinor: invF.total - 900, counterpartyId: invF.contactId,
    allocations: [{ documentId: invF.id, amountMinor: invF.total - 900, writeOffMinor: 900 }],
  }, dd('20'));

  // 6) Instalment chain: one invoice settled in three instalments.
  const invG = mkInvoice(7, 'Seeblick Lounge GmbH', dd('02'), [line16('m2', 1000)]);
  const inst = [Math.round(invG.total / 3), Math.round(invG.total / 3)];
  inst.push(invG.total - inst[0] - inst[1]);
  pay(7, { amountMinor: inst[0], counterpartyId: invG.contactId, allocations: [{ documentId: invG.id, amountMinor: inst[0] }] }, dd('09'));
  pay(8, { amountMinor: inst[1], counterpartyId: invG.contactId, allocations: [{ documentId: invG.id, amountMinor: inst[1] }] }, dd('17'));
  pay(9, { amountMinor: inst[2], counterpartyId: invG.contactId, allocations: [{ documentId: invG.id, amountMinor: inst[2] }] }, TODAY);

  // 7) Settle the open EUR export invoices at a rate that differs from booking: the realised FX
  //    difference lands on 3806 (operating Kursdifferenzen). Keyed by invoice id (stable).
  const eurInvoices = H.invoices.filter((x) => !x.draft && x.currency === 'EUR');
  let eurSettled = 0;
  for (const [i, inv] of eurInvoices.entries()) {
    const payDate = dd(i === 0 ? '11' : '13');
    const rate = i === 0 ? '0.9300' : '0.9650';
    ensureRate('EUR', payDate, rate);
    call('record_payment', {
      workspaceId: W.main, direction: 'incoming', date: payDate, amountMinor: inv.total,
      currency: 'EUR', fxRate: rate, bankAccountId: accId(W.main, '1021'),
      counterpartyKind: 'customer', counterpartyId: inv.contactId,
      allocations: [{ documentId: inv.id, amountMinor: inv.total }],
      intent: 'post_payment', idempotencyKey: k('p16', 'eurpay', inv.id),
    }, { date: payDate });
    eurSettled += 1;
  }

  // 8) One invoice issued TODAY and left open: at ANY rolled TODAY the ledger carries at least
  //    one open receivable (the aging/dunning/QR surfaces always have a live target).
  mkInvoice(8, 'Bistro Central', TODAY, [line16('b2', 12000), line16('s3', 1000)]);

  console.log('  phase16: partial+split+over+under payments, 1 on-account, 3 instalments, ' + eurSettled + ' EUR settlements (FX realised), 1 open invoice at TODAY');
}

// ===================================================================================================
// PHASE 17: bank-reconciliation depth (WP2 item b)
// CAMT statements for every complete month of the current year plus a partial one to TODAY; one
// statement (month(TODAY)-1) fully matched AND reconciled to zero (balances derived from the
// posted ledger); the rest carry deliberate unmatched leftovers.
// ===================================================================================================
function phase17() {
  const iban = 'CH9300762011623852957';
  const M1 = CAL.monthShift(-1);
  const M1end = addDays(CAL.monthShift(0) + '-01', -1); // last day of month(TODAY)-1
  const curYear = TODAY.slice(0, 4);

  // 17a: a posted vendor bill the reconciled statement's DBIT settles via confirm_match.
  const util = H.suppliers['Stadtwerke Winterthur'];
  const bill = call('create_vendor_bill', {
    workspaceId: W.main, vendorId: util, billDate: M1 + '-06', dueDate: addDays(M1 + '-06', 30),
    amountMinor: 54000, amountIsGross: true, taxCode: 'VST-M',
    expenseAccountId: accId(W.main, '6500'), vendorReference: 'Strom Abschlag', idempotencyKey: k('p17', 'bill', 1),
  }, { date: M1 + '-06' });
  call('post_vendor_bill', { workspaceId: W.main, vendorBillId: bill.vendorBillId, idempotencyKey: k('p17', 'billpost', 1) }, { date: M1 + '-06' });

  // 17b: the RECONCILED-TO-ZERO statement for month(TODAY)-1. Opening/closing balances are the
  // POSTED ledger balances of 1020 (opening strictly before the period, closing at period end
  // after the two bookings below), so `list_reconciliation` reports reconciled: true.
  const bookings = 54000 + 2500; // the bill settlement + the bank fee, both DBIT
  const opening = ledgerBalanceAt('1020', M1 + '-01', true);
  const closing = ledgerBalanceAt('1020', M1end) - bookings;
  const sRec = camtBuilder('SEED-CAMT-REC-' + M1, [
    { ref: 'R1', amountMinor: 54000, cd: 'DBIT', date: M1 + '-07' },
    { ref: 'R2', amountMinor: 2500, cd: 'DBIT', date: M1 + '-15' },
  ], iban, { from: M1 + '-01', to: M1end, created: TODAY, openingMinor: opening, closingMinor: closing });
  const impRec = call('import_camt', { workspaceId: W.main, bankAccountId: H.banks.chf, xml: sRec, idempotencyKey: k('p17', 'camt', 'rec') }, { date: TODAY });
  const recStmtId = impRec.statementId;
  tryCall('suggest_matches', { workspaceId: W.main, statementId: recStmtId }, { date: TODAY });
  const recTxns = call('list_reconciliation', { workspaceId: W.main, statementId: recStmtId });
  const txnByRef = (res, ref) => [...(res.matched || []), ...(res.unmatched || []), ...(res.partial || [])].find((t) => t.entryRef === ref);
  const r1 = txnByRef(recTxns, 'R1');
  const r2 = txnByRef(recTxns, 'R2');
  if (r1) call('confirm_match', { workspaceId: W.main, bankTxnId: r1.bankTxnId, vendorBillId: bill.vendorBillId, idempotencyKey: k('p17', 'confirm', 1) }, { date: M1 + '-07' });
  if (r2) call('create_entry_for_txn', { workspaceId: W.main, bankTxnId: r2.bankTxnId, contraAccountId: accId(W.main, '6900'), description: 'Bankspesen', idempotencyKey: k('p17', 'fee', 1) }, { date: M1 + '-15' });
  const recCheck = call('list_reconciliation', { workspaceId: W.main, statementId: recStmtId });
  console.log('  phase17: statement ' + M1 + ' matched to zero (reconciled: ' + recCheck.reconciled + ')');

  // 17c: one leftover statement per COMPLETE month of the current year (deliberately unmatched;
  // default balances, so they also read as NOT reconciled). The month(TODAY)-1 month already has
  // the reconciled statement above; it gets its leftover twin too, like a real second page.
  let s = 0;
  let sMade = 0;
  const lastDayOf = (m) => {
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    const nextFirst = (mo === 12 ? (y + 1) + '-01' : m.slice(0, 4) + '-' + String(mo + 1).padStart(2, '0')) + '-01';
    return addDays(nextFirst, -1);
  };
  for (const m of allMonths().filter((x) => x.startsWith(curYear) && x < TODAY.slice(0, 7))) {
    s += 1;
    const monthEnd = lastDayOf(m);
    // Month-qualified NtryRefs: the importer keys a txn on its bank-assigned identity (falling
    // back to NtryRef), so a reused 'L1' across statements would dedupe to a single txn.
    const xml = camtBuilder('SEED-CAMT-M-' + m, [
      { ref: 'L1-' + m, amountMinor: 1200 + s * 100, cd: 'DBIT', date: m + '-05' },
      { ref: 'L2-' + m, amountMinor: 8800, cd: 'DBIT', date: m + '-18' },
    ], iban, { from: m + '-01', to: monthEnd, created: TODAY });
    tryCall('import_camt', { workspaceId: W.main, bankAccountId: H.banks.chf, xml, idempotencyKey: k('p17', 'camtm', m) }, { date: TODAY });
    sMade += 1;
  }

  // A partial statement for the running month, up to TODAY (no balances: reconciliation honestly
  // reports null for an incomplete period).
  const m0 = TODAY.slice(0, 7);
  const partial = camtBuilder('SEED-CAMT-M-' + m0 + '-partial', [
    { ref: 'P1', amountMinor: 4400, cd: 'DBIT', date: m0 + '-01' },
  ], iban, { from: m0 + '-01', to: TODAY, created: TODAY, openingMinor: null, closingMinor: null });
  const impPart = tryCall('import_camt', { workspaceId: W.main, bankAccountId: H.banks.chf, xml: partial, idempotencyKey: k('p17', 'camtm', 'partial') }, { date: TODAY });

  // review_bank_txn on one deliberate leftover: the human "seen, leave it" state.
  if (impPart && impPart.statementId) {
    const partTxns = tryCall('list_reconciliation', { workspaceId: W.main, statementId: impPart.statementId });
    const p1 = partTxns ? txnByRef(partTxns, 'P1') : null;
    if (p1) tryCall('review_bank_txn', { workspaceId: W.main, bankTxnId: p1.bankTxnId, idempotencyKey: k('p17', 'review', 1) }, { date: TODAY });
  }
  console.log('  phase17: ' + sMade + ' leftover statements + 1 partial (' + m0 + ')');
}

// ===================================================================================================
// PHASE 18: dunning escalation (WP2 item c)
// Two further runs escalate the aged receivables to level 2 (booked fees) and the old phase-8
// invoice to level 3; the level-3 run is then SENT through a local no-op relay.
// ===================================================================================================
function phase18() {
  // ONE run per asOf day (proposeDunningRun returns the existing run for a repeated day). The
  // escalation is HISTORICALLY DATED so it clears the K-60 minimum-interval gate: to step into
  // level N (N>=2) the engine requires >= minIntervalDays (default 10) between the previous level's
  // issued_at DATE and the run's asOf, AND the absolute daysOverdue threshold (10/30/60). Phase 13
  // issued level 1 for the escalation invoice (due d('2026-05-20')) at d('2026-06-05'); these two
  // rounds issue level 2 and level 3 on dates spaced >= 10 days apart and >= 30/60 days overdue,
  // all inside OPEN periods (months through month(TODAY)-2 are closed by phase 14, so the fee
  // bookings must land in July/August):
  //   level 2: asOf d('2026-07-05'), 46 days overdue, 30 days after the level-1 letter (fee books in July)
  //   level 3: asOf d('2026-07-20'), 61 days overdue, 15 days after the level-2 letter (fee books in July), then SENT
  // A final round at TODAY dun the July/August "overdue x3" receivables (the escalation invoice is
  // terminal at level 3 by then, so it is left untouched).
  const rounds = [
    { asOf: d('2026-07-05'), send: false },
    { asOf: d('2026-07-20'), send: true },
    { asOf: TODAY, send: false },
  ];
  let issuedRuns = 0;
  let idx = 0;
  for (const round of rounds) {
    idx += 1;
    const { asOf, send } = round;
    if (skipFuture('dunning-escalation-round', asOf)) continue;
    const run = tryCall('propose_dunning_run', { workspaceId: W.main, asOf, idempotencyKey: k('p18', 'propose', idx) }, { date: asOf });
    const runId = run && run.proposed !== false ? oneId(run) : null;
    if (!runId) continue;
    const issued = tryCall('issue_dunning_run', { workspaceId: W.main, runId, confirmed: true, idempotencyKey: k('p18', 'issue', idx) }, { date: asOf });
    if (!issued) continue;
    issuedRuns += 1;
    if (send) {
      // SENT through a seed-local relay: a pure in-process stub (nothing leaves the machine),
      // the `test/dunning` recordingRelay idiom. Attached only for this one send.
      deps.emailRelay = { send: () => ({ ok: true }) };
      const sent = tryCall('send_dunning_run', { workspaceId: W.main, runId, confirmed: true, idempotencyKey: k('p18', 'send', 1) }, { date: asOf });
      delete deps.emailRelay;
      if (sent) console.log('  phase18: run ' + runId + ' SENT (' + (sent.transmitted ?? 0) + ' letters)');
    }
  }
  const maxLevel = store.db
    .prepare('SELECT COALESCE(MAX(level), 0) AS ml FROM dunning_item WHERE workspace_id = ?')
    .get(W.main).ml;
  console.log('  phase18: ' + issuedRuns + ' escalation runs issued (max level ' + maxLevel + ')');
}

// ===================================================================================================
// PHASE 19: stocktake + inventory operations (WP2 item d, widened per the audit)
// Reorder points (one real low-stock state), a committed D01 stocktake with count differences, a
// J04 cycle count through approve/commit, J05 reason codes + adjustments (incl. a batch and a
// reversal), the J00 warehouse/location registry, J01 lot/serial tracking on two dedicated SKUs,
// and a posted J06 valuation run. Everything is dated TODAY: zero skips at any rolled TODAY.
// ===================================================================================================
function phase19() {
  const loc = H.locations && H.locations.warehouse;
  if (!loc) { console.warn('  [skip] phase19: no warehouse location'); return; }

  // Reorder points (D00 patch): p1 sits at 12 on hand, so 15 trips the low-stock state.
  call('update_item', { workspaceId: W.main, itemId: H.items['p1'], patch: { reorderPointQty: 15 } });
  call('update_item', { workspaceId: W.main, itemId: H.items['b1'], patch: { reorderPointQty: 50 } });
  call('update_item', { workspaceId: W.main, itemId: H.items['g1'], patch: { reorderPointQty: 2 } });

  // D01 stocktake: open freezes one line per item at the location and commit refuses uncounted
  // lines, so EVERY line gets counted: two with real differences, the rest confirmed at book.
  const st = call('stock_stocktake_open', { workspaceId: W.main, frozenAt: TODAY, locationId: loc, idempotencyKey: k('p19', 'stock', 1) }, { date: TODAY });
  const stId = st.sessionId ?? st.session?.id ?? oneId(st);
  // stock_stocktake_count is a raw per-line setter with no idempotency key, so a no-reset REPLAY
  // (the keyed open returns the already-committed session) must skip the count+commit leg.
  const stStatus = store.db.prepare('SELECT status FROM stocktake_session WHERE workspace_id = ? AND id = ?').get(W.main, stId);
  if (stStatus && stStatus.status === 'open') {
    const stLines = store.db
      .prepare('SELECT item_id, location_id, book_qty FROM stocktake_line WHERE workspace_id = ? AND session_id = ? ORDER BY item_id')
      .all(W.main, stId);
    for (const l of stLines) {
      let counted = l.book_qty;
      if (l.item_id === H.items['p2']) counted = Math.max(0, l.book_qty - 2); // shrinkage
      if (l.item_id === H.items['b2']) counted = Math.max(0, l.book_qty - 5); // shrinkage
      call('stock_stocktake_count', { workspaceId: W.main, sessionId: stId, itemId: l.item_id, locationId: l.location_id, countedQty: counted }, { date: TODAY });
    }
    call('stock_stocktake_commit', { workspaceId: W.main, sessionId: stId, idempotencyKey: k('p19', 'stockcommit', 1) }, { date: TODAY });
  }

  // J00 registry (a SEPARATE table from D01 stock_location: both exist on purpose).
  tryCall('warehouse_create', { workspaceId: W.main, code: 'WH1', name: 'Hauptlager Winterthur', city: 'Winterthur', isDefault: true, idempotencyKey: k('p19', 'wh', 1) }, { date: TODAY });
  const whRow = store.db.prepare("SELECT id FROM warehouse WHERE workspace_id = ? AND code = 'WH1'").get(W.main);
  if (whRow) {
    tryCall('location_create', { workspaceId: W.main, warehouseId: whRow.id, code: 'A1', name: 'Regal A1', isDefaultForWarehouse: true, idempotencyKey: k('p19', 'loc', 1) }, { date: TODAY });
    tryCall('location_create', { workspaceId: W.main, warehouseId: whRow.id, code: 'B1', name: 'Regal B1', idempotencyKey: k('p19', 'loc', 2) }, { date: TODAY });
  }

  // J01 lot/serial tracking on two DEDICATED SKUs (fresh items so enabling tracking cannot
  // collide with existing untracked stock).
  const lotItem = call('create_item', { workspaceId: W.main, name: 'Kaffeebohnen Microlot Gesha (kg)', defaultUnitPriceMinor: 5800, unit: 'kg', defaultTaxCode: 'UST26', trackStock: true, costPriceMinor: 3480, idempotencyKey: k('p19', 'item', 'lot') });
  const serItem = call('create_item', { workspaceId: W.main, name: 'Espressomaschine La Riva Uno (Serie)', defaultUnitPriceMinor: 320000, unit: 'piece', defaultTaxCode: 'UST81', trackStock: true, costPriceMinor: 192000, idempotencyKey: k('p19', 'item', 'serial') });
  call('item_set_tracking_mode', { workspaceId: W.main, itemId: lotItem.item.id, mode: 'lot', idempotencyKey: k('p19', 'track', 'lot') });
  call('item_set_tracking_mode', { workspaceId: W.main, itemId: serItem.item.id, mode: 'serial', idempotencyKey: k('p19', 'track', 'serial') });
  const lot1 = call('lot_create', { workspaceId: W.main, itemId: lotItem.item.id, number: 'LOT-GESHA-01', supplierReference: 'Charge 24-118', idempotencyKey: k('p19', 'lot', 1) });
  tryCall('lot_create', { workspaceId: W.main, itemId: lotItem.item.id, number: 'LOT-GESHA-02', idempotencyKey: k('p19', 'lot', 2) });
  const serials = call('serial_create_bulk', { workspaceId: W.main, itemId: serItem.item.id, numbers: ['SN-RIVA-1001', 'SN-RIVA-1002', 'SN-RIVA-1003'], idempotencyKey: k('p19', 'serial', 1) });
  const lot1Id = lot1.lot?.id ?? oneId(lot1);
  // Receive tracked stock through the J02 movement ledger.
  call('inventory_move', { workspaceId: W.main, itemId: lotItem.item.id, locationId: loc, qty: 25, movementType: 'receipt', unitCostMinor: 3480, effectiveDate: TODAY, lotId: lot1Id, idempotencyKey: k('p19', 'move', 'lot') }, { date: TODAY });
  const serIds = (serials.serials ?? []).map((x) => x.id ?? x);
  if (serIds[0]) {
    call('inventory_move', { workspaceId: W.main, itemId: serItem.item.id, locationId: loc, qty: 1, movementType: 'receipt', unitCostMinor: 192000, effectiveDate: TODAY, serialId: serIds[0], idempotencyKey: k('p19', 'move', 'serial') }, { date: TODAY });
  }

  // J05 reason codes + adjustments: one single, one batch of two, one reversal.
  const rShrink = call('inventory_reason_create', { workspaceId: W.main, code: 'SHRINK', name: 'Schwund', category: 'shrinkage', idempotencyKey: k('p19', 'reason', 1) });
  const rDamage = call('inventory_reason_create', { workspaceId: W.main, code: 'DMG', name: 'Beschädigung', category: 'damage', idempotencyKey: k('p19', 'reason', 2) });
  const rCorr = call('inventory_reason_create', { workspaceId: W.main, code: 'CORR', name: 'Korrektur', category: 'correction', idempotencyKey: k('p19', 'reason', 3) });
  const ridOf = (r) => r.reasonCode?.id ?? r.reason?.id ?? oneId(r);
  const adj = call('inventory_adjust', { workspaceId: W.main, itemId: H.items['p3'], locationId: loc, qtyDelta: -1, reasonCodeId: ridOf(rDamage), note: 'Transportschaden', effectiveDate: TODAY, idempotencyKey: k('p19', 'adj', 1) }, { date: TODAY });
  call('inventory_adjust_batch', {
    workspaceId: W.main, description: 'Inventurdifferenzen', effectiveDate: TODAY,
    lines: [
      { itemId: H.items['b3'], locationId: loc, qtyDelta: -3, reasonCodeId: ridOf(rShrink) },
      { itemId: H.items['g2'], locationId: loc, qtyDelta: -1, reasonCodeId: ridOf(rShrink) },
    ],
    idempotencyKey: k('p19', 'adjbatch', 1),
  }, { date: TODAY });
  const adjId = adj.adjustment?.id ?? adj.adjustmentId ?? oneId(adj);
  tryCall('inventory_adjust_reverse', { workspaceId: W.main, adjustmentId: adjId, reasonCodeId: ridOf(rCorr), note: 'Doch kein Schaden', effectiveDate: TODAY, idempotencyKey: k('p19', 'adjrev', 1) }, { date: TODAY });

  // J04 cycle count: create -> count -> approve -> commit.
  const cc = call('inventory_stocktake_create', { workspaceId: W.main, type: 'cycle', freezeAt: TODAY, locationIds: [loc], itemIds: [H.items['p2'], H.items['b1']], idempotencyKey: k('p19', 'cycle', 1) }, { date: TODAY });
  const ccId = cc.session?.id ?? cc.sessionId ?? oneId(cc);
  // Same replay guard as the D01 stocktake: on a no-reset replay the keyed create returns the
  // committed session and the count/approve/commit leg must not run again.
  const ccStatus = store.db.prepare('SELECT status FROM cycle_count_session WHERE workspace_id = ? AND id = ?').get(W.main, ccId);
  if (ccStatus && ccStatus.status !== 'committed') {
  call('inventory_stocktake_count', {
    workspaceId: W.main, sessionId: ccId,
    lines: [
      { itemId: H.items['p2'], locationId: loc, countedQty: 9 },
      { itemId: H.items['b1'], locationId: loc, countedQty: 198 },
    ],
    idempotencyKey: k('p19', 'cyclecount', 1),
  }, { date: TODAY });
  call('inventory_stocktake_approve_lines', { workspaceId: W.main, sessionId: ccId, lineIds: 'all_review_required', idempotencyKey: k('p19', 'cycleappr', 1) }, { date: TODAY });
  call('inventory_stocktake_commit', { workspaceId: W.main, sessionId: ccId, idempotencyKey: k('p19', 'cyclecommit', 1) }, { date: TODAY });
  }

  // J06 valuation run, posted (defaults resolve to the KMU 1200/4200 pair).
  const val = call('inventory_valuation_create', { workspaceId: W.main, asOf: TODAY, method: 'fifo', idempotencyKey: k('p19', 'val', 1) }, { date: TODAY });
  const valId = val.run?.id ?? val.runId ?? oneId(val);
  call('inventory_valuation_post', { workspaceId: W.main, runId: valId, idempotencyKey: k('p19', 'valpost', 1) }, { date: TODAY });

  const low = tryCall('stock_low_stock', { workspaceId: W.main });
  console.log('  phase19: stocktake + cycle count committed, 3 reason codes, adjustments, lots/serials, valuation run posted, low-stock items: ' + (low && low.items ? low.items.length : '?'));
}

// ===================================================================================================
// PHASE 20: procurement pipeline depth (audit amendment)
// Live POs in several states (sent/open, partially received, cancelled, closed short, revised), a
// requisition driven submit -> approve -> convert, an I02 goods-receipt document posted, an I04
// three-way match (one clean, one with a price exception), an I03 landed-cost voucher allocated,
// and supplier prices for two vendors. Dated TODAY: zero skips.
// ===================================================================================================
function phase20() {
  const loc = H.locations && H.locations.warehouse;
  const roast = H.suppliers['Rösterei Ostschweiz AG'];
  const milano = H.suppliers['Macchine Espresso SRL'];
  if (!loc || !roast) { console.warn('  [skip] phase20: missing location/supplier'); return; }

  // Supplier prices for two vendors.
  call('supplier_price_upsert', { workspaceId: W.main, supplierContactId: roast, itemId: H.items['b1'], priceRappen: 1400, currency: 'CHF', validFrom: d('2025-01-01'), leadTimeDays: 5, idempotencyKey: k('p20', 'sprice', 1) });
  call('supplier_price_upsert', { workspaceId: W.main, supplierContactId: roast, itemId: H.items['b2'], priceRappen: 1650, currency: 'CHF', validFrom: d('2025-01-01'), leadTimeDays: 5, idempotencyKey: k('p20', 'sprice', 2) });
  call('supplier_price_upsert', { workspaceId: W.main, supplierContactId: milano, itemId: H.items['m1'], priceRappen: 295000, currency: 'EUR', validFrom: d('2025-01-01'), leadTimeDays: 21, idempotencyKey: k('p20', 'sprice', 3) });

  const mkPo = (n, supplier, lines) => {
    const po = call('po_upsert', { workspaceId: W.main, supplierContactId: supplier, currency: 'CHF', lines, idempotencyKey: k('p20', 'po', n) }, { date: TODAY });
    return po.poId;
  };
  const poLines = (poId) => (call('po_get', { workspaceId: W.main, poId }).lines || []);

  // PO A: sent and OPEN (the standing open-commitment target).
  const poA = mkPo(1, roast, [{ itemId: H.items['b1'], qty: 100, unitPriceRappen: 1400 }, { itemId: H.items['b2'], qty: 50, unitPriceRappen: 1650 }]);
  call('po_send', { workspaceId: W.main, poId: poA, idempotencyKey: k('p20', 'send', 1) }, { date: TODAY });

  // PO B: sent, PARTIALLY received via the D02 receipt path (open lines remain).
  const poB = mkPo(2, roast, [{ itemId: H.items['p1'], qty: 10, unitPriceRappen: 2700 }, { itemId: H.items['p2'], qty: 6, unitPriceRappen: 5300 }]);
  call('po_send', { workspaceId: W.main, poId: poB, idempotencyKey: k('p20', 'send', 2) }, { date: TODAY });
  const bLines = poLines(poB);
  if (bLines[0]) call('receipt_record', { workspaceId: W.main, poId: poB, locationId: loc, lines: [{ poLineId: bLines[0].id, qty: 6 }], idempotencyKey: k('p20', 'receipt', 1) }, { date: TODAY });

  // PO C: draft, CANCELLED.
  const poC = mkPo(3, roast, [{ itemId: H.items['b3'], qty: 20, unitPriceRappen: 1900 }]);
  call('po_cancel', { workspaceId: W.main, poId: poC, idempotencyKey: k('p20', 'cancel', 1) }, { date: TODAY });

  // PO D: sent, partially received, then CLOSED SHORT.
  const poD = mkPo(4, roast, [{ itemId: H.items['p3'], qty: 8, unitPriceRappen: 3700 }]);
  call('po_send', { workspaceId: W.main, poId: poD, idempotencyKey: k('p20', 'send', 3) }, { date: TODAY });
  const dLines = poLines(poD);
  if (dLines[0]) call('receipt_record', { workspaceId: W.main, poId: poD, locationId: loc, lines: [{ poLineId: dLines[0].id, qty: 5 }], idempotencyKey: k('p20', 'receipt', 2) }, { date: TODAY });
  call('po_close_short', { workspaceId: W.main, poId: poD, idempotencyKey: k('p20', 'closeshort', 1) }, { date: TODAY });

  // PO E: sent, then an I01 AMENDMENT cycle (start -> update lines -> submit -> apply).
  const poE = mkPo(5, roast, [{ itemId: H.items['g1'], qty: 4, unitPriceRappen: 87000 }]);
  call('po_send', { workspaceId: W.main, poId: poE, idempotencyKey: k('p20', 'send', 4) }, { date: TODAY });
  const amStart = tryCall('po_amendment_start', { workspaceId: W.main, poId: poE, reason: 'Menge erhöht', idempotencyKey: k('p20', 'amstart', 1) }, { date: TODAY });
  const amId = amStart ? (amStart.amendmentId ?? amStart.amendment?.id ?? oneId(amStart)) : null;
  if (amId) {
    const eLines = poLines(poE);
    if (eLines[0]) tryCall('po_amendment_update_lines', { workspaceId: W.main, amendmentId: amId, changes: [{ op: 'change', poLineId: eLines[0].id, qty: 6 }], idempotencyKey: k('p20', 'amlines', 1) }, { date: TODAY });
    tryCall('po_amendment_submit', { workspaceId: W.main, amendmentId: amId, idempotencyKey: k('p20', 'amsubmit', 1) }, { date: TODAY });
    tryCall('po_amendment_apply', { workspaceId: W.main, amendmentId: amId, idempotencyKey: k('p20', 'amapply', 1) }, { date: TODAY });
  }
  // po_revise on its own PO (F: revise reopens a sent order as a new revision).
  const poF = mkPo(6, roast, [{ itemId: H.items['g2'], qty: 2, unitPriceRappen: 119000 }]);
  call('po_send', { workspaceId: W.main, poId: poF, idempotencyKey: k('p20', 'send', 5) }, { date: TODAY });
  tryCall('po_revise', { workspaceId: W.main, poId: poF, reason: 'Preisrunde', idempotencyKey: k('p20', 'revise', 1) }, { date: TODAY });

  // Requisition: upsert -> submit -> approve -> convert to a SENT PO.
  const req = call('requisition_upsert', {
    workspaceId: W.main, requesterId: 'user_1', neededBy: addDays(TODAY, 14), description: 'Ersatzteile Servicewagen',
    lines: [{ itemId: H.items['p3'], description: 'Dampfventil Kit', qtyMilli: 4000, estimatedUnitCostRappen: 3600, preferredSupplierId: roast }],
    idempotencyKey: k('p20', 'req', 1),
  }, { date: TODAY });
  const reqId = req.requisition?.id ?? oneId(req);
  call('requisition_submit', { workspaceId: W.main, requisitionId: reqId, idempotencyKey: k('p20', 'reqsubmit', 1) }, { date: TODAY });
  call('requisition_approve', { workspaceId: W.main, requisitionId: reqId, comment: 'ok', idempotencyKey: k('p20', 'reqappr', 1) }, { date: TODAY });
  const reqDetail = call('requisition_get', { workspaceId: W.main, requisitionId: reqId });
  const reqLine = (reqDetail.requisition?.lines || [])[0];
  let poG = null;
  if (reqLine) {
    const conv = call('requisition_convert_to_po', { workspaceId: W.main, requisitionId: reqId, lines: [{ lineId: reqLine.id, qtyMilli: 4000 }], createAs: 'sent', idempotencyKey: k('p20', 'reqconv', 1) }, { date: TODAY });
    poG = conv.purchaseOrderId ?? conv.poId ?? oneId(conv);
  }

  // A second requisition left SUBMITTED: the standing target for my_pending_approvals,
  // approve, reject and return.
  const req2 = call('requisition_upsert', {
    workspaceId: W.main, requesterId: 'user_1', neededBy: addDays(TODAY, 30), description: 'Bohnen Nachschub Q-Lager',
    lines: [{ itemId: H.items['b1'], description: 'Kaffeebohnen Hausmischung (kg)', qtyMilli: 60000, estimatedUnitCostRappen: 1400, preferredSupplierId: roast }],
    idempotencyKey: k('p20', 'req', 2),
  }, { date: TODAY });
  const req2Id = req2.requisition?.id ?? oneId(req2);
  call('requisition_submit', { workspaceId: W.main, requisitionId: req2Id, idempotencyKey: k('p20', 'reqsubmit', 2) }, { date: TODAY });

  // I02 goods receipt on the converted PO: create -> add lines -> post.
  let grLineIds = [];
  if (poG) {
    tryCall('goods_receipt_set_config', { workspaceId: W.main, allowOverReceipt: false, idempotencyKey: k('p20', 'grconf', 1) });
    const gr = call('goods_receipt_create', { workspaceId: W.main, poId: poG, receivedAt: TODAY, defaultLocationId: loc, idempotencyKey: k('p20', 'gr', 1) }, { date: TODAY });
    const grId = gr.goodsReceipt?.id ?? oneId(gr);
    const gLines = poLines(poG);
    if (gLines[0]) {
      call('goods_receipt_upsert_lines', { workspaceId: W.main, grId, ops: [{ op: 'add', poLineId: gLines[0].id, qty: 4, locationId: loc }], idempotencyKey: k('p20', 'grlines', 1) }, { date: TODAY });
      call('goods_receipt_post', { workspaceId: W.main, grId, idempotencyKey: k('p20', 'grpost', 1) }, { date: TODAY });
      const grDetail = call('goods_receipt_get', { workspaceId: W.main, grId });
      grLineIds = (grDetail.goodsReceipt?.lines || []).map((l) => l.id);
    }

    // I04 three-way match: a CLEAN full match (bill = 4 received units at the PO price)...
    const billG = call('create_vendor_bill', {
      workspaceId: W.main, vendorId: roast, billDate: TODAY, dueDate: addDays(TODAY, 30),
      amountMinor: 14400, amountIsGross: false, taxCode: 'VST-M', expenseAccountId: accId(W.main, '4200'),
      vendorReference: 'Ersatzteile ' + TODAY, idempotencyKey: k('p20', 'billg', 1),
    }, { date: TODAY });
    call('post_vendor_bill', { workspaceId: W.main, vendorBillId: billG.vendorBillId, idempotencyKey: k('p20', 'billgpost', 1) }, { date: TODAY });
    tryCall('match_three_way_evaluate', { workspaceId: W.main, billId: billG.vendorBillId, poId: poG });
    tryCall('match_three_way_create', { workspaceId: W.main, billId: billG.vendorBillId, poId: poG, idempotencyKey: k('p20', 'match', 1) }, { date: TODAY });

  }

  // ...and one PRICE EXCEPTION on its OWN PO + goods receipt: the bill lands above the received
  // value, evaluates to `variance` (create would refuse out_of_tolerance), and the OVERRIDE
  // records the human judgment: the exception row match_three_way_exceptions lists.
  const poH = mkPo(7, roast, [{ itemId: H.items['p1'], qty: 2, unitPriceRappen: 3600 }]);
  call('po_send', { workspaceId: W.main, poId: poH, idempotencyKey: k('p20', 'send', 6) }, { date: TODAY });
  const grH = call('goods_receipt_create', { workspaceId: W.main, poId: poH, receivedAt: TODAY, defaultLocationId: loc, idempotencyKey: k('p20', 'gr', 2) }, { date: TODAY });
  const grHId = grH.goodsReceipt?.id ?? oneId(grH);
  const hLines = poLines(poH);
  if (hLines[0]) {
    call('goods_receipt_upsert_lines', { workspaceId: W.main, grId: grHId, ops: [{ op: 'add', poLineId: hLines[0].id, qty: 2, locationId: loc }], idempotencyKey: k('p20', 'grlines', 2) }, { date: TODAY });
    call('goods_receipt_post', { workspaceId: W.main, grId: grHId, idempotencyKey: k('p20', 'grpost', 2) }, { date: TODAY });
    const billX = call('create_vendor_bill', {
      workspaceId: W.main, vendorId: roast, billDate: TODAY, dueDate: addDays(TODAY, 30),
      amountMinor: 9900, amountIsGross: false, taxCode: 'VST-M', expenseAccountId: accId(W.main, '4200'),
      vendorReference: 'Ersatzteile Nachtrag ' + TODAY, idempotencyKey: k('p20', 'billx', 1),
    }, { date: TODAY });
    call('post_vendor_bill', { workspaceId: W.main, vendorBillId: billX.vendorBillId, idempotencyKey: k('p20', 'billxpost', 1) }, { date: TODAY });
    tryCall('match_three_way_evaluate', { workspaceId: W.main, billId: billX.vendorBillId, poId: poH });
    tryCall('match_three_way_override', { workspaceId: W.main, billId: billX.vendorBillId, poId: poH, reason: 'Expresszuschlag akzeptiert', idempotencyKey: k('p20', 'match', 2) }, { date: TODAY });
  }

  // A DRAFT goods receipt on the open PO A: the standing target for accept_lines,
  // reject_lines and cancel (a posted document is immutable, so only a draft serves them).
  const aLines = poLines(poA);
  if (aLines[0]) {
    const grDraft = call('goods_receipt_create', { workspaceId: W.main, poId: poA, receivedAt: TODAY, defaultLocationId: loc, idempotencyKey: k('p20', 'gr', 3) }, { date: TODAY });
    const grDraftId = grDraft.goodsReceipt?.id ?? oneId(grDraft);
    const grDraftStatus = store.db.prepare('SELECT status FROM goods_receipt_doc WHERE workspace_id = ? AND id = ?').get(W.main, grDraftId);
    if (grDraftStatus && grDraftStatus.status === 'draft') {
      call('goods_receipt_upsert_lines', { workspaceId: W.main, grId: grDraftId, ops: [{ op: 'add', poLineId: aLines[0].id, qty: 40, locationId: loc }], idempotencyKey: k('p20', 'grlines', 3) }, { date: TODAY });
    }
  }

  // I03 landed cost on the posted goods-receipt lines: create the voucher, confirm the allocation.
  if (grLineIds.length > 0) {
    const voucher = tryCall('landed_cost_voucher_create', {
      workspaceId: W.main,
      costLines: [{ componentType: 'freight', description: 'Spedition', amountMinor: 4200 }, { componentType: 'handling', description: 'Verzollung/Handling', amountMinor: 1800 }],
      targetGrLineIds: grLineIds,
      inventoryAccountId: accId(W.main, '1200'), clearingAccountId: accId(W.main, '2000'),
      effectiveDate: TODAY, idempotencyKey: k('p20', 'lc', 1),
    }, { date: TODAY });
    const voucherId = voucher ? (voucher.voucher?.id ?? voucher.voucherId ?? oneId(voucher)) : null;
    if (voucherId) tryCall('landed_cost_allocate_confirm', { workspaceId: W.main, voucherId, effectiveDate: TODAY, idempotencyKey: k('p20', 'lcconf', 1) }, { date: TODAY });
  }

  const poCount = store.db.prepare('SELECT COUNT(*) AS n FROM purchase_order WHERE workspace_id = ?').get(W.main).n;
  console.log('  phase20: ' + poCount + ' POs total (open/partial/cancelled/closed-short/amended/revised), requisition converted, GR posted, 3-way matches, landed cost');
}

// ===================================================================================================
// PHASE 21: cheap wins where the verb is BUILT (WP2 item e, made concrete by the audit)
// Deals + pipeline, notifications, a saved + run report, a document template, quote lifecycle
// states, a review case, contact activities, a folder, a sign-request draft, asset extras
// (location, transfer, maintenance log, one disposal), custom field values, and one fired
// automation rule. Dated TODAY: zero skips.
// ===================================================================================================
function phase21() {
  // (a) Deals pipeline: one pipeline, three stages, three deals in different states.
  const pipe = tryCall('pipelines_upsert', { workspaceId: W.main, name: 'Vertrieb Maschinen', idempotencyKey: k('p21', 'pipe', 1) });
  const pipeId = pipe ? (pipe.pipelineId ?? pipe.pipeline?.id ?? oneId(pipe)) : null;
  const stageIds = {};
  if (pipeId) {
    for (const [i, [key, name, prob]] of [['lead', 'Lead', 10], ['angebot', 'Angebot', 50], ['abschluss', 'Abschluss', 90]].entries()) {
      const st = tryCall('pipeline_stages_upsert', { workspaceId: W.main, pipelineId: pipeId, name, sort: i + 1, probability: prob, idempotencyKey: k('p21', 'stage', key) });
      if (st) stageIds[key] = st.stageId ?? st.stage?.id ?? oneId(st);
    }
    const dealSpecs = [
      { n: 1, cust: 'Hotel Blaustern AG', title: 'Röster-Upgrade Blaustern', value: 1450000, stage: 'angebot' },
      { n: 2, cust: 'Bistro Central', title: 'Zweite Espressomaschine', value: 520000, stage: 'lead' },
      { n: 3, cust: 'Berghotel Panorama AG', title: 'Wintersaison Bohnenvertrag', value: 380000, stage: 'abschluss' },
    ];
    const dealIds = [];
    for (const ds of dealSpecs) {
      const deal = tryCall('deals_create', { workspaceId: W.main, contactId: H.customers[ds.cust], title: ds.title, valueMinor: ds.value, pipelineId: pipeId, stageId: stageIds[ds.stage], expectedCloseOn: addDays(TODAY, 30), idempotencyKey: k('p21', 'deal', ds.n) });
      dealIds.push(deal ? (deal.dealId ?? deal.deal?.id ?? oneId(deal)) : null);
    }
    if (dealIds[1] && stageIds.angebot) tryCall('deals_move', { workspaceId: W.main, dealId: dealIds[1], stageId: stageIds.angebot, idempotencyKey: k('p21', 'dealmove', 1) });
    if (dealIds[2]) tryCall('deals_mark', { workspaceId: W.main, dealId: dealIds[2], status: 'won', idempotencyKey: k('p21', 'dealmark', 1) });
    if (dealIds[0]) tryCall('deals_log_activity', { workspaceId: W.main, dealId: dealIds[0], kind: 'call', body: 'Budgetrahmen bestätigt, Offerte folgt', occurredAt: TODAY + 'T08:00:00.000Z', idempotencyKey: k('p21', 'dealact', 1) });
  }

  // (b) Notifications: deliver four inbox rows, read one, archive one, run the digest.
  const notifSpecs = [
    { n: 1, event: 'invoice.issued', key: 'notifications.invoice_issued' },
    { n: 2, event: 'journal.posted', key: 'notifications.journal_posted' },
    { n: 3, event: 'period.closed', key: 'notifications.period_closed' },
    { n: 4, event: 'contact.created', key: 'notifications.contact_created' },
  ];
  const notifIds = [];
  for (const ns of notifSpecs) {
    const nres = tryCall('notifications_deliver', { workspaceId: W.main, userId: 'user_1', event: ns.event, summaryI18nKey: ns.key, idempotencyKey: k('p21', 'notif', ns.n) }, { date: TODAY });
    notifIds.push(nres ? nres.notificationId : null);
  }
  if (notifIds[0]) tryCall('notifications_mark_read', { workspaceId: W.main, notificationId: notifIds[0], idempotencyKey: k('p21', 'notifread', 1) });
  if (notifIds[1]) tryCall('notifications_archive', { workspaceId: W.main, notificationId: notifIds[1], idempotencyKey: k('p21', 'notifarch', 1) });
  tryCall('notifications_run_digest', { workspaceId: W.main, userId: 'user_1', channel: 'email', periodStart: addDays(TODAY, -7), periodEnd: TODAY, idempotencyKey: k('p21', 'digest', 1) }, { date: TODAY });

  // (c) A saved report definition, run once with a retained artifact.
  const rep = tryCall('reports_save', {
    workspaceId: W.main, name: 'Offene Debitoren nach Kunde', source: 'ar_open_items',
    columns: ['customerName', 'dueDate', 'openMinor', 'currency'], format: 'csv', idempotencyKey: k('p21', 'report', 1),
  });
  const repId = rep ? (rep.reportId ?? rep.report?.id ?? oneId(rep)) : null;
  if (repId) tryCall('reports_run', { workspaceId: W.main, reportId: repId, retain: true, idempotencyKey: k('p21', 'reportrun', 1) }, { date: TODAY });

  // (d) A custom document template, set as the invoice default.
  const tpl = tryCall('create_document_template', { workspaceId: W.main, documentKind: 'invoice', name: 'Seeblick Standard', idempotencyKey: k('p21', 'tpl', 1) });
  const tplId = tpl ? (tpl.templateId ?? tpl.template?.id ?? oneId(tpl)) : null;
  if (tplId) tryCall('set_default_document_template', { workspaceId: W.main, documentKind: 'invoice', templateId: tplId, idempotencyKey: k('p21', 'tpldefault', 1) });

  // (e) Quote lifecycle states: draft / sent / declined / revised / accepted, plus the sweep.
  const mkQuote = (n, cust, key, qtyMilli) => {
    const it = ITEMS.find((x) => x.key === key);
    const q = tryCall('quotes_create', {
      workspaceId: W.main, contactId: H.customers[cust], validUntil: addDays(TODAY, 20),
      lines: [{ itemId: H.items[key], description: it.name, quantityMilli: qtyMilli, unitPriceMinor: it.price, taxCode: it.tax }],
      idempotencyKey: k('p21', 'quote', n),
    }, { date: TODAY });
    return q ? (q.quoteId ?? q.quote?.id ?? oneId(q)) : null;
  };
  // NOT sent through quotes_send on purpose: it mints a RANDOM accept token (crypto), which
  // would break the seed's byte-identical determinism. The shared A10 transition walks the same
  // status machine deterministically (the phase-8 walkthrough idiom); the C02 decline / revise /
  // accept verbs are deterministic and run for real.
  const toSent = (quoteId, key) => {
    tryCall('transition_document', { workspaceId: W.main, documentId: quoteId, to: 'issued', idempotencyKey: k('p21', key, 'issued') }, { date: TODAY });
    tryCall('transition_document', { workspaceId: W.main, documentId: quoteId, to: 'sent', idempotencyKey: k('p21', key, 'sent') }, { date: TODAY });
  };
  const q1 = mkQuote(1, 'Rialto Bar GmbH', 'g2', 1000); // stays draft: the quotes_send target
  const q2 = mkQuote(2, 'Café Sternen', 'm3', 1000);
  if (q2) toSent(q2, 'q2t'); // stays sent: the open offer
  const q3 = mkQuote(3, 'Bistro Central', 'm1', 1000);
  if (q3) {
    toSent(q3, 'q3t');
    tryCall('quotes_decline', { workspaceId: W.main, quoteId: q3, declineReason: 'Budget verschoben', idempotencyKey: k('p21', 'qdecline', 1) }, { date: TODAY });
  }
  const q4 = mkQuote(4, 'Hotel Blaustern AG', 'm2', 1000);
  if (q4) {
    toSent(q4, 'q4t');
    tryCall('quotes_revise', { workspaceId: W.main, quoteId: q4, idempotencyKey: k('p21', 'qrevise', 1) }, { date: TODAY });
  }
  const q5 = mkQuote(5, 'Gasthof Adler', 'g1', 1000);
  if (q5) {
    toSent(q5, 'q5t');
    tryCall('quotes_accept', { workspaceId: W.main, quoteId: q5, idempotencyKey: k('p21', 'qaccept', 1) }, { date: TODAY });
  }
  tryCall('quotes_expire_sweep', { workspaceId: W.main, asOf: TODAY, idempotencyKey: k('p21', 'qsweep', 1) }, { date: TODAY });

  // (f) A review case: one flagged + commented journal entry (A25 review state).
  const entryRow = store.db
    .prepare("SELECT id FROM journal_entry WHERE workspace_id = ? AND status = 'posted' ORDER BY date DESC, id DESC LIMIT 1")
    .get(W.main);
  if (entryRow) {
    tryCall('flag_entry', { workspaceId: W.main, entryId: entryRow.id, reason: 'Beleg fehlt, bitte nachreichen', idempotencyKey: k('p21', 'flag', 1) }, { date: TODAY });
    tryCall('comment_entry', { workspaceId: W.main, entryId: entryRow.id, text: 'Lieferant um Belegkopie gebeten', idempotencyKey: k('p21', 'comment', 1) }, { date: TODAY });
  }

  // (g) Contact activities on the CRM timeline.
  tryCall('contacts_log_activity', { workspaceId: W.main, contactId: H.customers['Rialto Bar GmbH'], kind: 'call', body: 'Servicetermin vereinbart', occurredAt: TODAY + 'T07:30:00.000Z', idempotencyKey: k('p21', 'cact', 1) });
  tryCall('contacts_log_activity', { workspaceId: W.main, contactId: H.customers['Hotel Blaustern AG'], kind: 'email', body: 'Offerte Nachfassmail geschickt', occurredAt: TODAY + 'T08:15:00.000Z', idempotencyKey: k('p21', 'cact', 2) });

  // (h) A folder with a file in it, and a sign-request DRAFT on that file (nothing transmits).
  const folder = tryCall('folders_upsert', { workspaceId: W.main, name: 'Verträge', idempotencyKey: k('p21', 'folder', 1) });
  const folderId = folder ? (folder.folderId ?? folder.folder?.id ?? oneId(folder)) : null;
  const tinyPdf = Buffer.from('%PDF-1.4 seed vertrag').toString('base64');
  const file = tryCall('files_upload', { workspaceId: W.main, folderId: folderId ?? undefined, title: 'Wartungsvertrag Blaustern', filename: 'wartungsvertrag.pdf', contentBase64: tinyPdf, mime: 'application/pdf', idempotencyKey: k('p21', 'file', 1) });
  const fileId = file ? (file.fileId ?? file.file?.id ?? oneId(file)) : null;
  if (fileId) tryCall('sign_requests_create', { workspaceId: W.main, fileId, signerContactId: H.customers['Hotel Blaustern AG'], signatureLevel: 'ses', message: 'Bitte Wartungsvertrag signieren', idempotencyKey: k('p21', 'sign', 1) }, { date: TODAY });

  // (i) Asset extras: locations, a transfer, a maintenance log entry, one disposal.
  tryCall('asset_location_create', { workspaceId: W.main, code: 'WERK', name: 'Werkstatt', idempotencyKey: k('p21', 'aloc', 1) });
  tryCall('asset_location_create', { workspaceId: W.main, code: 'OFFICE', name: 'Büro Technikumstrasse', idempotencyKey: k('p21', 'aloc', 2) });
  const alocRow = store.db.prepare("SELECT id FROM asset_location WHERE workspace_id = ? AND code = 'WERK'").get(W.main);
  const assetRows = store.db.prepare("SELECT id, name FROM asset WHERE workspace_id = ? ORDER BY id").all(W.main);
  const roaster = assetRows.find((a) => a.name.includes('Kaffeeröster'));
  if (alocRow && roaster) tryCall('asset_transfer', { workspaceId: W.main, assetIds: [roaster.id], toLocationId: alocRow.id, effectiveDate: TODAY, reason: 'Umzug Werkstatt', idempotencyKey: k('p21', 'atransfer', 1) }, { date: TODAY });
  if (roaster) tryCall('asset_maintenance_log_create', { workspaceId: W.main, assetId: roaster.id, logDate: TODAY, maintenanceType: 'preventive', title: 'Jahresservice Trommellager', costRappen: 42000, externalParty: 'Röstertechnik Service AG', idempotencyKey: k('p21', 'amaint', 1) }, { date: TODAY });
  // One REAL disposal: the phase-6 assets are register drafts (never acquired through H01), so a
  // demo unit is created, acquired and sold today, leaving a genuine disposal + gain/loss row.
  if (H.assetCats && H.assetCats.maschinen) {
    const demo = tryCall('asset_create', { workspaceId: W.main, categoryId: H.assetCats.maschinen, name: 'Vorführmühle Macinare 64', acquisitionDate: TODAY, acquisitionCostRappen: 90000, depreciationMethod: 'straight_line', usefulLifeMonths: 60, idempotencyKey: k('p21', 'asset', 1) }, { date: TODAY });
    const demoId = demo ? (demo.asset?.id ?? oneId(demo)) : null;
    if (demoId) {
      tryCall('asset_acquire', { workspaceId: W.main, assetId: demoId, date: TODAY, acquisitionCostRappen: 90000, creditAccountId: accId(W.main, '1020'), idempotencyKey: k('p21', 'aacq', 1) }, { date: TODAY });
      tryCall('asset_dispose', { workspaceId: W.main, assetId: demoId, disposalDate: TODAY, proceedsRappen: 40000, proceedsAccountId: accId(W.main, '1020'), gainLossAccountId: accId(W.main, '6800'), reason: 'Vorführgerät verkauft', idempotencyKey: k('p21', 'adispose', 1) }, { date: TODAY });
    }
  }

  // (j) Custom field VALUES for the phase-15 field definitions.
  tryCall('set_field_value', { workspaceId: W.main, entityKind: 'item', entityId: H.items['b1'], fieldKey: 'herkunft', value: 'Brasilien / Honduras', idempotencyKey: k('p21', 'cf', 1) });
  tryCall('set_field_value', { workspaceId: W.main, entityKind: 'contact', entityId: H.customers['Rialto Bar GmbH'], fieldKey: 'kundentyp', value: 'Stammkunde', idempotencyKey: k('p21', 'cf', 2) });

  // (k) Fire one automation rule for real: a fresh contact trips the enabled `contact.created`
  // rule from phase 15, leaving a genuine automation run (its template targets a placeholder, so
  // the run records an honest failure: a retry target, not a fake success).
  tryCall('create_contact', { workspaceId: W.main, partyRole: 'customer', name: 'Kafi Neugass GmbH', email: 'info@neugass.example', idempotencyKey: k('p21', 'contact', 1) });
  // NOT retried on purpose: retry_automation_run accepts only a STUCK run (run_not_stuck for a
  // finally-failed one), so the failed run above stays as the honest list/get target.

  console.log('  phase21: deals+pipeline, notifications, saved report, template, quote states, review case, sign draft, asset extras, field values, automation run');
}

// ===================================================================================================
// Helpers + runner
// ===================================================================================================
function allMonths() {
  // Jan of year(TODAY)-1 through month(TODAY): the frozen span (2025-01..2026-08), rolled.
  return CAL.months();
}

const PHASES = [phase0, phase1, phase2, phase3, phase4, phase5, phase6, phase7, phase8, phase9, phase10, phase11, phase12, phase13, phase14, phase15, phase16, phase17, phase18, phase19, phase20, phase21];

/** Failures collected by verify() and smokeCheck(); a non-empty list exits the run nonzero. */
const FAILURES = [];

function smokeCheck() {
  console.log('\nSmoke check (read verbs):');
  // The report windows are horizon-relative (Jan 1 of year(TODAY) through TODAY; the VAT read is
  // the last COMPLETE quarter relative to TODAY), so they stay meaningful at any rolled TODAY.
  const curYear = TODAY.slice(0, 4);
  const prevYear = String(Number(curYear) - 1).padStart(4, '0');
  const todayQ = Math.floor((Number(TODAY.slice(5, 7)) - 1) / 3) + 1;
  const qStarts = { 1: '01-01', 2: '04-01', 3: '07-01', 4: '10-01' };
  const qEnds = { 1: '03-31', 2: '06-30', 3: '09-30', 4: '12-31' };
  const lastQ = todayQ === 1 ? { y: prevYear, q: 4 } : { y: curYear, q: todayQ - 1 };
  const reads = [
    ['dashboard_overview', { workspaceId: W.main, from: curYear + '-01-01', to: TODAY }],
    ['aging_report', { workspaceId: W.main, asOf: TODAY }],
    ['trial_balance', { workspaceId: W.main, periodStart: curYear + '-01-01', periodEnd: TODAY }],
    ['balance_sheet', { workspaceId: W.main, asOf: TODAY }],
    ['income_statement', { workspaceId: W.main, periodStart: curYear + '-01-01', periodEnd: TODAY }],
    ['attention_summary', { workspaceId: W.main }],
    ['stock_valuation_report', { workspaceId: W.main, method: 'fifo', asOf: TODAY }],
    ['asset_depreciation_forecast', { workspaceId: W.main, fromPeriod: curYear + '-01', toPeriod: curYear + '-12' }],
    ['vat_return', { workspaceId: W.main, periodStart: lastQ.y + '-' + qStarts[lastQ.q], periodEnd: lastQ.y + '-' + qEnds[lastQ.q] }],
    // The new-phase surfaces.
    ['list_reconciliation', { workspaceId: W.main, bankAccountId: H.banks.chf }],
    ['list_dunning_runs', { workspaceId: W.main }],
    ['suggest_payment_matches', { workspaceId: W.main, direction: 'incoming' }],
    ['stock_low_stock', { workspaceId: W.main }],
    ['inventory_adjust_list', { workspaceId: W.main }],
    ['inventory_stocktake_list', { workspaceId: W.main }],
    ['inventory_valuation_list', { workspaceId: W.main }],
    ['warehouse_list', { workspaceId: W.main }],
    ['lot_list', { workspaceId: W.main }],
    ['serial_list', { workspaceId: W.main }],
    ['po_open_lines', { workspaceId: W.main }],
    ['requisition_list', { workspaceId: W.main }],
    ['goods_receipt_list', { workspaceId: W.main }],
    ['match_three_way_list', { workspaceId: W.main }],
    ['landed_cost_list', { workspaceId: W.main }],
    ['procurement_spend_summary', { workspaceId: W.main }],
    ['deals_list', { workspaceId: W.main }],
    ['forecast_weighted_pipeline', { workspaceId: W.main }],
    ['notifications_list', { workspaceId: W.main, userId: 'user_1' }],
    ['reports_list', { workspaceId: W.main }],
    ['list_document_templates', { workspaceId: W.main }],
    ['quotes_list', { workspaceId: W.main }],
    ['sign_requests_list', { workspaceId: W.main }],
    ['review_status', { workspaceId: W.main, period: CAL.monthShift(-1) }],
  ];
  for (const [r, input] of reads) {
    const res = handleRest(r, input, deps);
    const okRead = res.body && res.body.ok !== false;
    console.log('  ' + r + ': ' + (okRead ? 'ok' : 'MISS(' + (res.body && res.body.error) + ')'));
    if (!okRead) FAILURES.push('smokeCheck ' + r + ': ' + (res.body && res.body.error));
  }
}

function verify() {
  console.log('\nVerified row counts (main workspace):');
  // Every row: [label, table, where, TODAY-independent minimum, optional condition]. The minimums
  // are conservative floors that hold at ANY rolled TODAY (the calendar always spans at least Jan
  // of year(TODAY)-1 through TODAY); rows whose seed events carry current-year literal dates are
  // guarded by the SAME CAL condition the phase used, so a legitimately skipped event never
  // reports a false failure. A count below its floor is a named FAILURE and the run exits nonzero.
  const always = () => true;
  const rows = [
    ['contacts', 'contact', '', 17, always],
    ['items', 'item', '', 17, always],
    ['invoices', 'document', "type = 'invoice'", 20, always],
    ['issued invoices (open)', 'document', "type = 'invoice' AND status = 'issued'", 1, always],
    ['issued invoices (frozen span)', 'document', "type = 'invoice' AND status = 'issued'", 5, () => !CAL.isFuture(d('2026-08-14'))],
    ['draft invoices', 'document', "type = 'invoice' AND status = 'draft'", 2, () => !CAL.isFuture(d('2026-08-18'))],
    ['credit notes', 'document', "type = 'credit_note'", 3, () => !CAL.isFuture(d('2026-03-10'))],
    ['quotes (documents)', 'document', "type = 'quote'", 5, always],
    ['vendor bills', 'vendor_bill', '', 14, always],
    ['payments', 'payment', '', 30, always],
    ['journal entries', 'journal_entry', '', 60, always],
    // Phase 16: the payment scenarios are TODAY-anchored, so they exist at any TODAY; the EUR
    // settlement floor is 1 (the prior-year export invoice always exists; the current-year one
    // may legitimately skip).
    ['EUR payments (FX settled)', 'payment', "currency = 'EUR'", 1, always],
    // Phase 17: the reconciled statement plus the partial statement always exist.
    ['bank statements', 'bank_statement', '', 2, always],
    ['bank txns', 'bank_txn', '', 3, always],
    // Phase 18: the escalation invoice (due d('2026-05-20')) is dunned on real past dates that clear
    // the K-60 minimum-interval gate (>= 10 days between issued levels) as well as the absolute
    // daysOverdue thresholds: level 1 at d('2026-06-05'), level 2 at d('2026-07-05') (46 days overdue,
    // 30 days after level 1), level 3 + the send at d('2026-07-20') (61 days overdue, 15 days after
    // level 2). Each check turns on once its own issue date is no longer in the future.
    ['dunning runs', 'dunning_run', '', 3, () => !CAL.isFuture(d('2026-07-20'))],
    ['dunning items level>=2', 'dunning_item', 'level >= 2', 1, () => !CAL.isFuture(d('2026-07-05'))],
    ['dunning run sent', 'dunning_run', "status = 'sent'", 1, () => !CAL.isFuture(d('2026-07-20'))],
    // Phase 19 (all TODAY-anchored).
    ['stocktake sessions (D01)', 'stocktake_session', '', 1, always],
    ['cycle counts (J04)', 'cycle_count_session', '', 1, always],
    ['reason codes', 'inventory_reason_code', '', 3, always],
    ['inventory adjustments', 'inventory_adjustment', '', 3, always],
    ['warehouses (J00)', 'warehouse', '', 1, always],
    ['locations (J00)', 'stock_location', 'warehouse_id IS NOT NULL', 2, always],
    ['lots', 'lot', '', 2, always],
    ['serials', 'serial', '', 3, always],
    ['valuation runs (J06)', 'inventory_valuation_run', '', 1, always],
    // Phase 20 (all TODAY-anchored).
    ['purchase orders', 'purchase_order', '', 7, always],
    ['requisitions', 'requisition', '', 1, always],
    ['goods receipts (I02)', 'goods_receipt_doc', '', 1, always],
    ['three-way matches (I04)', 'three_way_match', '', 1, always],
    ['landed cost vouchers', 'landed_cost_voucher', '', 1, always],
    ['supplier prices', 'supplier_item_price', '', 3, always],
    // Phase 21 (all TODAY-anchored).
    ['pipelines', 'pipeline', '', 1, always],
    ['deals', 'deal', '', 3, always],
    ['notifications', 'inbox_item', '', 3, always],
    ['saved reports', 'saved_reports', '', 1, always],
    ['document templates', 'document_template', '', 1, always],
    ['sign requests', 'sign_request', '', 1, always],
    ['contact activities', 'contact_activity', '', 2, always],
    ['asset maintenance logs', 'asset_maintenance_log', '', 1, always],
    ['automation runs', 'automation_run', '', 1, always],
  ];
  for (const [label, tbl, where, min, when] of rows) {
    let n;
    try {
      n = countRows(W.main, tbl, where);
    } catch (e) {
      n = null;
    }
    const applies = when();
    const shown = tbl + (where ? ' [' + where + ']' : '');
    if (n === null) {
      console.log('  ' + shown + ': (no such table)');
      if (applies) FAILURES.push('verify ' + label + ': table ' + tbl + ' missing');
      continue;
    }
    const bad = applies && n < min;
    console.log('  ' + shown + ': ' + n + (applies ? ' (min ' + min + (bad ? ' FAIL' : '') + ')' : ' (window not reached, floor waived)'));
    if (bad) FAILURES.push('verify ' + label + ': ' + n + ' < ' + min + ' (' + shown + ')');
  }
}

// ---------------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------------
console.log('Seeding rich demo ledger at ' + dbPath + (RESET ? ' (fresh)' : ' (replay)'));
console.log('TODAY = ' + TODAY + (CAL.identity ? ' (frozen default)' : ' (rolled via TILL_SEED_TODAY)'));
const startedAt = Date.now();

if (ONLY_PHASE !== null) {
  console.error('--phase=<n> requires the earlier phases to have run against this db. Running phase ' + ONLY_PHASE + ' only.');
  PHASES[ONLY_PHASE]();
} else {
  for (const phase of PHASES) phase();
}

verify();
smokeCheck();

// The post-TODAY skip summary: always printed, never silent.
if (SKIPS.total === 0) {
  console.log('\nPost-TODAY skips: none (every remapped event date is on or before ' + TODAY + ')');
} else {
  console.log('\nPost-TODAY skips: ' + SKIPS.total + ' events not seeded (remapped date after ' + TODAY + '):');
  for (const [label, count] of SKIPS.byLabel) console.log('  ' + label + ': ' + count);
}

store.close();

// verify()/smokeCheck() failures exit nonzero with every failure NAMED: a collapsed count or a
// missing read is a seed defect, never a soft warning. This nonzero exit is the fixture guard that
// turns the advisory prints into a real gate (K-67: a silent K-60 regression zeroed the dunning
// demo data, printed a warning, and still exited 0, so only a human reading the log caught it).
// Per-check date gates (CAL.isFuture) are honored INSIDE verify()/the row table, so a legitimately
// rolled TODAY that skips a future-dated event waives that check and never false-fails. The exit is
// enforced on a FULL run only: a `--phase=n` partial run verifies a subset of the seed against the
// whole-fixture floors, so its shortfalls stay printed-but-advisory (in practice such a run crashes
// earlier because the phase depends on prior-phase module state, but the guard is scoped to full
// runs regardless, so a partial run can never false-fail here).
if (FAILURES.length > 0) {
  const enforced = ONLY_PHASE === null;
  console.error(
    '\nSEED VERIFY ' +
      (enforced ? 'FAILED' : 'WARNINGS (--phase=' + ONLY_PHASE + ' partial run, not enforced)') +
      ' (' + FAILURES.length + '):',
  );
  for (const f of FAILURES) console.error('  - ' + f);
  if (enforced) process.exitCode = 1;
}

console.log('\nDone in ' + ((Date.now() - startedAt) / 1000).toFixed(1) + 's. Point the Studio at this ledger with TILL_DB_PATH=' + dbPath);

