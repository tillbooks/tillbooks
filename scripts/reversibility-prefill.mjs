#!/usr/bin/env node
// @ts-check
/**
 * D159: THE REVERSIBILITY PREFILL. One JSON line per registered WRITE, with every fact the repository
 * already holds about how far that write can be undone, and a HINT derived from those facts, so the
 * agents who classify the verbs (`write:reversible` / `write:correctable` / `write:final`, see
 * `src/api/actionKind.ts`) start from the evidence instead of re-deriving it.
 *
 * A HINT IS NOT A CLASS. It is a starting point a classifier confirms or overturns against the engine
 * verb; nothing reads this file back into the build.
 *
 * Usage: `npm run build && node scripts/reversibility-prefill.mjs [--out <dir>]`. Reads the BUILT
 * registry (`dist/`) and the posting graph over `src/` (`scripts/lib/posting-graph.mjs`, the
 * analyser behind `test/agent/dial-covers-entry-minting.test.mjs`). Writes `<dir>/prefill.jsonl` and
 * `<dir>/chunks.json` (default dir: `<os tmpdir>/rmap`) and prints the counts.
 *
 * Per line: `{ verb, file, domain, governed, excluded, catalogueClass, mintsEntry, denylistLegs, hint,
 * hintReason }`, plus `catalogueSource`, `governedBy`, `wayBackHint` and `chunk`.
 *   - `file`: the `src/api/*.ts` that registers the verb;
 *   - `domain`: the `src/core/<dir>` its handler's symbols mostly live in, else the file's stem;
 *   - `governed`: the dial family (by name, else the most severe input-keyed one), or null;
 *   - `excluded`: its `NOT_DIAL_GOVERNED` reason, or null;
 *   - `catalogueClass`: the reversibility of its resolved consequence entry (`consequences.ts`), or null;
 *   - `mintsEntry`: whether its handler reaches `postEntry`;
 *   - `denylistLegs`: its G01 denylist legs (`NOT_AUTOMATABLE_LEGS`).
 *
 * The hint rules, first match wins (D159 step 0):
 *   1. an existing catalogue class;
 *   2. it mints a journal entry: `correctable`;
 *   3. a `set` / `update` / `upsert` verb: `reversible`, way back `self`;
 *   4. one half of an archive/unarchive, pause/resume, enable/disable (or deactivate/reactivate) pair
 *      whose other half is registered: `reversible`, way back the other half;
 *   5. a delete / purge / anonymise / merge / send / transmit verb, or denylist leg (a): `final`;
 *   6. otherwise null.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analysePostingGraph } from './lib/posting-graph.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const { ACTIONS } = await import(join(ROOT, 'dist/api/registry.js'));
const {
  DIAL_CAPABILITY_FOR_ACTION,
  NOT_DIAL_GOVERNED,
  CONSEQUENCE_ENTRY_FOR_ACTION,
  dialCapabilitiesForVerb,
} = await import(join(ROOT, 'dist/core/agent/dialMap.js'));
const { CONSEQUENCE_FOR_VERB } = await import(join(ROOT, 'dist/core/agent/consequences.js'));
const { NOT_AUTOMATABLE_LEGS } = await import(join(ROOT, 'dist/core/automation/denylist.js'));

/** @param {string[]} argv */
function outDir(argv) {
  const i = argv.indexOf('--out');
  const given = i === -1 ? undefined : argv[i + 1];
  return given ?? join(tmpdir(), 'rmap');
}

/**
 * THE EIGHT CHUNKS, by domain. A verb lands in the chunk of the file that registers it; the verbs
 * registered inline in `registry.ts` land by their engine module (`REGISTRY_MODULE_CHUNK`), the item
 * master verbs with the stock chunk that owns items.
 */
const CHUNKS = {
  C1: 'ledger, setup, accounts, VAT, opening, FX (and the A25 review, A23 workspaces, A26 agent bookkeeping, F01 reports)',
  C2: 'bank, money flows, dunning, accruals, eBill',
  C3: 'sales, recurring, deals, portal, sign, retainers, contacts',
  C4: 'purchasing, receipts, 3-way match, landed cost, capture (and the F03 vendor portal)',
  C5: 'stock, stocktake, valuation, items',
  C6: 'assets, projects, time, HR, payroll, tasks (and B02 billing, H08 maintenance)',
  C7: 'migration, GL archive, env, onboarding, data (and M02 sync, M03 move, G08 support)',
  C8: 'platform, permissions, automation, checklists, files, mail',
};

/** @type {Record<string, keyof typeof CHUNKS>} */
const FILE_CHUNK = {
  // C1
  'opening-actions.ts': 'C1',
  'fx-actions.ts': 'C1',
  'review-actions.ts': 'C1',
  'workspace-actions.ts': 'C1',
  'agent-actions.ts': 'C1',
  'agent-oversight-actions.ts': 'C1',
  'report-builder-actions.ts': 'C1',
  'compose-actions.ts': 'C1',
  'report-actions.ts': 'C1',
  // C2
  'bank-actions.ts': 'C2',
  'bank-inbox-actions.ts': 'C2',
  'camt-actions.ts': 'C2',
  'qr-match-actions.ts': 'C2',
  'pain001-actions.ts': 'C2',
  'payment-actions.ts': 'C2',
  'ebics-actions.ts': 'C2',
  'ebill-actions.ts': 'C2',
  'dunning-actions.ts': 'C2',
  'debtor-actions.ts': 'C2',
  'accrual-actions.ts': 'C2',
  'liquidity-actions.ts': 'C2',
  // C3
  'recurring-actions.ts': 'C3',
  'deal-actions.ts': 'C3',
  'quote-actions.ts': 'C3',
  'sales-order-actions.ts': 'C3',
  'portal-actions.ts': 'C3',
  'sign-actions.ts': 'C3',
  'retainer-actions.ts': 'C3',
  'contact-actions.ts': 'C3',
  'forecast-actions.ts': 'C3',
  // C4
  'purchase-actions.ts': 'C4',
  'purchase-order-actions.ts': 'C4',
  'po-amendment-actions.ts': 'C4',
  'requisition-actions.ts': 'C4',
  'receipt-actions.ts': 'C4',
  'three-way-match-actions.ts': 'C4',
  'landed-cost-actions.ts': 'C4',
  'capture-actions.ts': 'C4',
  'vendor-portal-actions.ts': 'C4',
  'supplier-performance-actions.ts': 'C4',
  'procurement-analytics-actions.ts': 'C4',
  // C5
  'stock-actions.ts': 'C5',
  'stocktake-actions.ts': 'C5',
  'valuation-actions.ts': 'C5',
  'valuation-run-actions.ts': 'C5',
  'inventory-actions.ts': 'C5',
  'inventory-adjust-actions.ts': 'C5',
  'inventory-agent-actions.ts': 'C5',
  'movement-actions.ts': 'C5',
  'tracking-actions.ts': 'C5',
  'item-actions.ts': 'C5',
  // C6
  'asset-actions.ts': 'C6',
  'asset-reports-actions.ts': 'C6',
  'maintenance-actions.ts': 'C6',
  'project-actions.ts': 'C6',
  'time-actions.ts': 'C6',
  'billing-actions.ts': 'C6',
  'costing-actions.ts': 'C6',
  'hr-actions.ts': 'C6',
  'payroll-actions.ts': 'C6',
  'task-actions.ts': 'C6',
  // C7
  'migration-actions.ts': 'C7',
  'migration-check-actions.ts': 'C7',
  'migration-extraction-actions.ts': 'C7',
  'migration-map-actions.ts': 'C7',
  'migration-open-items-actions.ts': 'C7',
  'migration-project-actions.ts': 'C7',
  'migration-testmandant-actions.ts': 'C7',
  'gl-archive-actions.ts': 'C7',
  'env-actions.ts': 'C7',
  'onboarding-actions.ts': 'C7',
  'data-actions.ts': 'C7',
  'sync-actions.ts': 'C7',
  'move-actions.ts': 'C7',
  'support-actions.ts': 'C7',
  'delivery-actions.ts': 'C7',
  // C8
  'permission-actions.ts': 'C8',
  'automation-actions.ts': 'C8',
  'checklist-actions.ts': 'C8',
  'file-actions.ts': 'C8',
  'mail-actions.ts': 'C8',
  'voice-actions.ts': 'C8',
  'draft-actions.ts': 'C8',
  'egress-actions.ts': 'C8',
  'customization-actions.ts': 'C8',
  'document-template-actions.ts': 'C8',
  'dispatch-actions.ts': 'C8',
  'notification-actions.ts': 'C8',
  'plugin-actions.ts': 'C8',
  'attention-actions.ts': 'C8',
  'dashboard-actions.ts': 'C8',
  'search-actions.ts': 'C8',
  'guidance-actions.ts': 'C8',
};

/** `registry.ts` inline verbs, by the engine module their handler lives in. */
/** @type {Record<string, keyof typeof CHUNKS>} */
const REGISTRY_MODULE_CHUNK = {
  setup: 'C1',
  accounts: 'C1',
  ledger: 'C1',
  vat: 'C1',
  checklists: 'C1', // close_year runs through the G22 guard, but it seals a fiscal year: a ledger act
  reports: 'C1',
  sales: 'C3',
};

/** @param {string} verb @param {string} file @param {string | undefined} module */
function chunkOf(verb, file, module) {
  const base = file.split('/').pop() ?? file;
  if (base === 'registry.ts') {
    if (/(^|_)item$/.test(verb)) return 'C5';
    const chunk = module === undefined ? undefined : REGISTRY_MODULE_CHUNK[module];
    if (chunk !== undefined) return chunk;
    throw new Error(`${verb}: registered in registry.ts with engine module ${module ?? '(none)'}, which no chunk claims`);
  }
  const chunk = FILE_CHUNK[base];
  if (chunk === undefined) throw new Error(`${verb}: ${file} is not assigned to a chunk; add it to FILE_CHUNK`);
  return chunk;
}

// --- The hint ----------------------------------------------------------------------------------

const SETTER_TOKENS = new Set(['set', 'update', 'upsert']);
/** @type {Record<string, string>} */
const PAIR_TOKENS = {
  archive: 'unarchive',
  unarchive: 'archive',
  pause: 'resume',
  resume: 'pause',
  enable: 'disable',
  disable: 'enable',
  deactivate: 'reactivate',
  reactivate: 'deactivate',
};
const FINAL_NAME = /delete|purge|anonymi[sz]e|merge|send|transmit/;

/**
 * @param {{ verb: string, governed: string | null, catalogueClass: string | null, catalogueSource: string | null, mintsEntry: boolean, denylistLegs: string[] }} f
 * @param {Set<string>} writes
 * @returns {{ hint: string | null, hintReason: string, wayBackHint: string[] | null }}
 */
function hintFor(f, writes) {
  if (f.catalogueClass !== null) {
    return { hint: f.catalogueClass, hintReason: `catalogue (${f.catalogueSource})`, wayBackHint: null };
  }
  if (f.mintsEntry) {
    // The graph over-approximates (a shared engine function mints on some edges only); an ungoverned
    // minter has its reason in the minting guard's NOT_GOVERNED, which the classifier reads first.
    const caveat = f.governed === null ? ', ungoverned: read its NOT_GOVERNED reason in test/agent/dial-covers-entry-minting.test.mjs, it may be an over-approximation' : '';
    return { hint: 'correctable', hintReason: `mints a journal entry (reaches postEntry${caveat})`, wayBackHint: null };
  }
  const tokens = f.verb.split('_');
  const setter = tokens.find((t) => SETTER_TOKENS.has(t));
  if (setter !== undefined) return { hint: 'reversible', hintReason: `absolute setter ('${setter}')`, wayBackHint: ['self'] };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const other = token === undefined ? undefined : PAIR_TOKENS[token];
    if (other === undefined) continue;
    const twin = [...tokens.slice(0, i), other, ...tokens.slice(i + 1)].join('_');
    if (writes.has(twin)) return { hint: 'reversible', hintReason: `pair: ${f.verb} <-> ${twin}`, wayBackHint: [twin] };
  }
  const named = FINAL_NAME.exec(f.verb);
  if (named !== null) return { hint: 'final', hintReason: `name says '${named[0]}'`, wayBackHint: null };
  if (f.denylistLegs.includes('a')) return { hint: 'final', hintReason: 'denylist leg (a): cannot be undone by another verb', wayBackHint: null };
  return { hint: null, hintReason: 'no rule matched', wayBackHint: null };
}

// --- Run -----------------------------------------------------------------------------------------

const graph = analysePostingGraph(ROOT);
/** @type {{ name: string, kind: string }[]} */
const writeDefs = ACTIONS.filter((/** @type {{ kind: string }} */ a) => a.kind === 'write');
const writes = new Set(writeDefs.map((a) => a.name));

const rows = writeDefs.map((a) => {
  const verb = a.name;
  const facts = graph.get(verb);
  if (facts === undefined) throw new Error(`${verb}: the posting-graph analyser did not find its registration`);
  const byName = DIAL_CAPABILITY_FOR_ACTION[verb];
  const caps = /** @type {string[]} */ (dialCapabilitiesForVerb(verb));
  const entry = CONSEQUENCE_ENTRY_FOR_ACTION[verb];
  const module = facts.coreModules[0];
  const stem = (facts.file.split('/').pop() ?? '').replace(/(-actions)?\.ts$/, '');
  const base = {
    verb,
    file: facts.file,
    domain: module ?? stem,
    governed: caps[0] ?? null,
    governedBy: byName !== undefined ? 'name' : caps.length > 0 ? 'input' : null,
    excluded: NOT_DIAL_GOVERNED[verb] ?? null,
    catalogueClass: entry?.reversibility ?? null,
    catalogueSource: entry === undefined ? null : CONSEQUENCE_FOR_VERB[verb] !== undefined ? 'verb' : `family ${byName}`,
    mintsEntry: facts.mints,
    denylistLegs: [...(NOT_AUTOMATABLE_LEGS[verb] ?? [])],
  };
  return { ...base, ...hintFor(base, writes), chunk: chunkOf(verb, facts.file, module) };
});

const dir = outDir(process.argv.slice(2));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'prefill.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

/** @type {Record<string, { domains: string, count: number, files: string[], verbs: string[] }>} */
const chunks = {};
for (const [id, domains] of Object.entries(CHUNKS)) {
  const mine = rows.filter((r) => r.chunk === id);
  chunks[id] = { domains, count: mine.length, files: [...new Set(mine.map((r) => r.file))].sort(), verbs: mine.map((r) => r.verb) };
}
writeFileSync(join(dir, 'chunks.json'), JSON.stringify(chunks, null, 2) + '\n');

/** @param {(r: typeof rows[number]) => string} key */
const tally = (key) => {
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of rows) out[key(r)] = (out[key(r)] ?? 0) + 1;
  return out;
};
console.log(`reversibility-prefill: ${rows.length} writes -> ${join(dir, 'prefill.jsonl')}`);
console.log(`  hints: ${JSON.stringify(tally((r) => r.hint ?? 'null'))}`);
console.log(`  hint sources: ${JSON.stringify(tally((r) => r.hintReason.split(/[ (:]/)[0] ?? ''))}`);
console.log(`  chunks -> ${join(dir, 'chunks.json')}: ${Object.entries(chunks).map(([id, c]) => `${id} ${c.count}`).join(', ')}`);
