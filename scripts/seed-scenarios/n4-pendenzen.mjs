#!/usr/bin/env node
/**
 * n4-pendenzen.mjs: the D178 Pendenzen scenario (node N4), laid ON TOP of a seeded ledger.
 *
 * It adds exactly twelve units of waiting work, the owner's count on 21.10.2026 ("I have 12 open points"):
 *
 *   - three bank Vorschläge drafted by the AGENT SEAT (through the MCP transport, so the dial drafts them as
 *     it would for a real agent): one books onto an account, two book by a Buchungsregel and so pin it
 *     (D162); the rule of the last one is edited after the proposal, so approving it refuses
 *     `vorschlag_stale` (the other rule booking stays fresh, for a flow that makes it stale mid-batch);
 *   - five bank lines waiting for a person, on one new Bankkonto;
 *   - one statement gap on that Bankkonto (statements 1 and 3 in the books, 2 missing);
 *   - one MWST checklist step due (the MWST-Periode run of the last quarter; every other open step is
 *     skipped with a reason, so exactly one step waits);
 *   - one flagged posting;
 *   - one Mahnlauf ready to issue.
 *
 * SYNTHETIC BY CONSTRUCTION (CLAUDE.md: private data never ships). Invented names, an invented IBAN over the
 * clearing number 09999 that no Swiss bank uses, invented amounts and texts. It drives the public verbs only
 * (`handleRest` for the person, `callTool` for the agent seat), never the engine directly and never SQL.
 *
 * Usage (the Seeblick ledger first, then this on top; never your real books):
 *   TILL_DB_PATH=/tmp/x/till-demo.db node scripts/seed-demo-rich.mjs --reset
 *   TILL_DB_PATH=/tmp/x/till-demo.db node scripts/seed-scenarios/n4-pendenzen.mjs
 *   TILL_DB_PATH=/tmp/x/till-demo.db node scripts/seed-scenarios/n4-pendenzen.mjs --fresh   # a new empty mandate
 *
 * `--fresh` lays the twelve units into a NEW workspace ("Pendenzen Testmandant AG") instead of Seeblick, so
 * Pendenzen shows exactly twelve: the fixture the text budget is measured on. Re-running is a replay: every
 * write carries a stable `seed:n4:` key, and the run stops early when its marker posting already exists.
 *
 * The build (`npm run build`) must run first so `dist/` exists.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const { SqliteStore } = await import(join(ROOT, 'dist/core/store/sqlite-store.js'));
const { handleRest } = await import(join(ROOT, 'dist/api/rest.js'));
const { callTool } = await import(join(ROOT, 'dist/api/mcp.js'));
const { resolveDbPath } = await import(join(ROOT, 'dist/api/db-path.js'));
const { AGENT_ACTOR } = await import(join(ROOT, 'dist/core/access/actors.js'));

const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
// The Studio reads with the REAL clock, so the scenario's dates follow today in Swiss time unless the run
// rolls the calendar like the seed does (`TILL_SEED_TODAY`, pass the same value to both).
const swissToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const TODAY = process.env.TILL_SEED_TODAY ?? swissToday;

/** `YYYY-MM-DD` plus `n` days (negative goes back). */
function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

const dbPath = resolveDbPath();
if (dbPath === ':memory:') {
  console.error('Refusing to seed :memory:. Set TILL_DB_PATH to the seeded ledger file.');
  process.exit(1);
}

// The clock stands at 09:00 Swiss time on TODAY; ids are deterministic and cannot collide with the seed's
// own `sequenceIdGen` ids (`<prefix>_<n>`), because every id here carries `n4`.
let CLOCK_NOW = `${TODAY}T07:00:00.000Z`;
const clock = { now: () => CLOCK_NOW };
const counters = new Map();
const ids = {
  next(prefix) {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}_n4_${FRESH ? 'f' : 's'}${n}`;
  },
};
const store = new SqliteStore({ location: dbPath, clock });
const person = { store, clock, ids, actor: 'user_1' };
const agent = { store, clock, ids, actor: AGENT_ACTOR };

function call(verb, input) {
  const res = handleRest(verb, { ...input }, person);
  if (res.body && res.body.ok === false) {
    throw new Error(`SCENARIO FAIL ${verb} -> ${JSON.stringify(res.body)}  input=${JSON.stringify(input).slice(0, 400)}`);
  }
  return res.body;
}

function tryCall(verb, input) {
  const res = handleRest(verb, { ...input }, person);
  return res.body;
}

/** The agent seat, through the MCP transport: the dial decides (a governed write drafts). */
function agentCall(verb, input) {
  return JSON.parse(callTool(agent, verb, input).content[0].text);
}

// --- the workspace ----------------------------------------------------------------------------------

let workspaceId;
if (FRESH) {
  const made = call('create_workspace', { name: 'Pendenzen Testmandant AG', idempotencyKey: 'seed:n4:ws' });
  workspaceId = made.workspaceId;
} else {
  const ws = store.db.prepare("SELECT id FROM workspace WHERE name LIKE 'Seeblick%' ORDER BY created_at LIMIT 1").get();
  if (ws === undefined) {
    console.error('No Seeblick workspace in this ledger: run scripts/seed-demo-rich.mjs first, or pass --fresh.');
    process.exit(1);
  }
  workspaceId = ws.id;
}
const W = { workspaceId };
const accId = (number) => store.db.prepare('SELECT id FROM account WHERE workspace_id = ? AND number = ?').get(workspaceId, number)?.id;

// The last write of the scenario is the stale Vorschlag's rule edit; its draft marks a finished run. A run
// that stopped half-way replays from the start (every write carries its `seed:n4:` key).
const already = store.db
  .prepare("SELECT 1 FROM bank_standard WHERE workspace_id = ? AND label = 'Kiosk Kleinspesen' AND superseded_at IS NOT NULL")
  .get(workspaceId);
if (already !== undefined) {
  console.log(`n4-pendenzen: already laid into ${workspaceId}; nothing to do.`);
  store.close();
  process.exit(0);
}

// --- the MWST setup a fresh mandate lacks (Seeblick has it; these are idempotent or refused harmlessly) ---

if (FRESH) {
  call('vat_seed_defaults', W);
  call('set_vat_method', { ...W, vatMethod: 'effektiv', vatAccounting: 'soll' });
  call('set_creditor_profile', {
    ...W,
    creditorName: 'Pendenzen Testmandant AG',
    address: { street: 'Seeweg', buildingNo: '4', zip: '8700', town: 'Küsnacht', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
}

// --- 1 flagged posting (A25) -------------------------------------------------------------------------

CLOCK_NOW = `${TODAY}T06:30:00.000Z`;
const posted = call('post_entry', {
  ...W,
  date: TODAY,
  description: 'N4 Pendenzen: Büromaterial bar',
  source: 'manual',
  idempotencyKey: 'seed:n4:post',
  lines: [
    { account: accId('6500'), debit: 8640 },
    { account: accId('1000'), credit: 8640 },
  ],
});
const entryId = posted.entryId ?? posted.entry?.id;
call('flag_entry', { ...W, entryId, reason: 'Beleg fehlt, bitte nachreichen', idempotencyKey: 'seed:n4:flag' });

// --- 1 Mahnlauf ready (A15) ----------------------------------------------------------------------------

const customer = call('create_contact', {
  ...W,
  partyRole: 'customer',
  name: 'Bergsicht Velos GmbH',
  address: { street: 'Talstrasse', houseNo: '12', zip: '8810', city: 'Horgen', country: 'CH' },
  email: 'buchhaltung@bergsicht.example',
  idempotencyKey: 'seed:n4:contact',
}).contact.id;
// Issued 17 days ago (a recent, open period in a seeded ledger whose older months are locked), due five
// days later, so it is 12 days overdue: the first Mahnung (10 days) is due.
const invoiceDate = addDays(TODAY, -17);
CLOCK_NOW = `${invoiceDate}T07:00:00.000Z`;
const invoiceId = call('create_document', {
  ...W,
  type: 'invoice',
  contactId: customer,
  currency: 'CHF',
  date: invoiceDate,
  dueDate: addDays(invoiceDate, 5),
  lines: [{ description: 'Servicepauschale Kaffeemaschine', unitPriceMinor: 48000, taxCode: 'UST81' }],
  idempotencyKey: 'seed:n4:invoice',
}).document.id;
call('issue_invoice', { ...W, invoiceId, idempotencyKey: 'seed:n4:issue' });
CLOCK_NOW = `${TODAY}T06:40:00.000Z`;
const dunningConfig = tryCall('get_dunning_config', W);
// A mandate that never configured dunning reads the shipped defaults (`configured: false`): set ours then.
if (!(dunningConfig && dunningConfig.ok === true && dunningConfig.configured === true)) {
  const level = { feeMinor: 0, bookFee: false, showInterest: false };
  // The first Mahnung charges a booked CHF 20 fee, so issuing the run is a money write and its confirm in
  // Pendenzen has a fee to name (the orchestrator's N4 ruling, DESIGN.md C4). The fee credits an income
  // account of the mandate's own chart.
  const incomeAccount = ['3600', '3200', '3400', '3000']
    .map((n) => store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = ? AND type = 'income'").get(workspaceId, n)?.id)
    .find((id) => id !== undefined);
  const firstFee = incomeAccount === undefined ? level : { feeMinor: 2000, bookFee: true, feeIncomeAccountId: incomeAccount, showInterest: false };
  call('set_dunning_config', {
    ...W,
    levels: [
      { level: 1, daysOverdue: 10, ...firstFee },
      { level: 2, daysOverdue: 30, ...level },
      { level: 3, daysOverdue: 60, ...level },
    ],
    idempotencyKey: 'seed:n4:dunning-config',
  });
}
// One run per day: a seeded ledger may already hold TODAY's run (issued), so the proposal then dates from
// the day before, which no run holds.
call('propose_dunning_run', { ...W, idempotencyKey: 'seed:n4:dunning' });
const proposedRun = () => store.db.prepare("SELECT 1 FROM dunning_run WHERE workspace_id = ? AND status = 'proposed'").get(workspaceId);
if (proposedRun() === undefined) {
  CLOCK_NOW = `${addDays(TODAY, -1)}T07:00:00.000Z`;
  call('propose_dunning_run', { ...W, idempotencyKey: 'seed:n4:dunning-yesterday' });
  CLOCK_NOW = `${TODAY}T06:40:00.000Z`;
}

// --- 1 MWST checklist step due (G22) -------------------------------------------------------------------

const lastQuarter = (() => {
  const [y, m] = TODAY.split('-').map(Number);
  const q = Math.floor((m - 1) / 3); // the current quarter's index; the last ended one is q - 1
  return q === 0 ? `${y - 1}-Q4` : `${y}-Q${q}`;
})();
const run = call('checklist_start', { ...W, templateId: 'vat_period', period: lastQuarter, idempotencyKey: 'seed:n4:checklist' });
const runId = run.run?.runId ?? run.runId;
// Exactly ONE step waits: the look-ahead (the D172 setting) reaches just the computed return, the first MWST
// step a person meets and one that can never be skipped, and the steps already overdue before it are
// skipped with a reason.
const runView = call('checklist_get', { ...W, runId });
const runItems = runView.run?.items ?? runView.items ?? [];
const computed = runItems.find((it) => it.itemId === 'vat_return_computed');
const window = computed?.dueAt != null && computed.dueAt > TODAY ? Math.max(1, Math.min(90, daysBetween(TODAY, computed.dueAt))) : 1;
call('settings_set', { ...W, key: 'checklists.attention_window_days', value: window, reason: 'Testszenario N4: ein MWST-Schritt', idempotencyKey: 'seed:n4:window' });
const byRunItem = new Map(runItems.map((it) => [it.runItemId, it.itemId]));
const due = handleRest('attention_list', { ...W, queueId: 'checklist_items_due', limit: 200 }, person).body.items ?? [];
for (const item of due.filter((i) => i.deepLink?.params?.run === runId)) {
  const key = byRunItem.get(item.entityId);
  if (key === undefined || key === 'vat_return_computed') continue;
  call('checklist_item_skip', { ...W, runId, itemId: key, reason: 'Testszenario N4: nur ein Schritt', idempotencyKey: `seed:n4:skip:${key}` });
}

// --- the bank: one new Bankkonto, statements 1 and 3, eight lines on 1 ----------------------------------

function mod97(numeric) {
  let r = 0;
  for (const ch of numeric) r = (r * 10 + Number(ch)) % 97;
  return r;
}
function syntheticIban(accountNumber) {
  const bban = `09999${String(accountNumber).padStart(12, '0')}`;
  return `CH${String(98 - mod97(`${bban}121700`)).padStart(2, '0')}${bban}`;
}
const money = (minor) => `${Math.floor(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, '0')}`;

function camt053({ iban, seq, date, opening, entries }) {
  const closing = opening + entries.reduce((n, e) => n + e.minor, 0);
  const bal = (code, minor) =>
    `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">${money(minor)}</Amt><CdtDbtInd>${minor < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
  const ntry = entries
    .map((e, k) => {
      const credit = e.minor >= 0;
      const ref = `N4-${date.replace(/-/g, '')}-${seq}-${k + 1}`;
      const party = credit ? 'Dbtr' : 'Cdtr';
      return (
        `<Ntry><Amt Ccy="CHF">${money(e.minor)}</Amt><CdtDbtInd>${credit ? 'CRDT' : 'DBIT'}</CdtDbtInd><RvslInd>false</RvslInd>` +
        `<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt><AcctSvcrRef>${ref}</AcctSvcrRef>` +
        `<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>${credit ? 'RCDT' : 'ICDT'}</Cd><SubFmlyCd>AUTT</SubFmlyCd></Fmly></Domn></BkTxCd>` +
        `<NtryDtls><TxDtls><Refs><AcctSvcrRef>${ref}-1</AcctSvcrRef><EndToEndId>NOTPROVIDED</EndToEndId></Refs>` +
        `<Amt Ccy="CHF">${money(e.minor)}</Amt><CdtDbtInd>${credit ? 'CRDT' : 'DBIT'}</CdtDbtInd>` +
        `<RltdPties><${party}><Pty><Nm>${e.name}</Nm></Pty></${party}></RltdPties>` +
        `<RmtInf><Ustrd>${e.text}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`
      );
    })
    .join('');
  const id = `N4${date.replace(/-/g, '')}${String(seq).padStart(4, '0')}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt>` +
    `<GrpHdr><MsgId>${id}</MsgId><CreDtTm>${date}T23:30:00+01:00</CreDtTm></GrpHdr>` +
    `<Stmt><Id>${id}-S</Id><ElctrncSeqNb>${seq}</ElctrncSeqNb><CreDtTm>${date}T23:30:00+01:00</CreDtTm>` +
    `<FrToDt><FrDtTm>${date}T00:00:00+01:00</FrDtTm><ToDtTm>${date}T23:59:59+01:00</ToDtTm></FrToDt>` +
    `<Acct><Id><IBAN>${iban}</IBAN></Id><Ccy>CHF</Ccy><Ownr><Nm>Synthetische Pendenzen AG</Nm></Ownr></Acct>` +
    bal('OPBD', opening) +
    bal('CLBD', closing) +
    ntry +
    `</Stmt></BkToCstmrStmt></Document>`
  );
}

const iban = syntheticIban(FRESH ? 404401 : 404402);
const bankAccountId = call('create_bank_account', {
  ...W,
  name: 'Testbank Betriebskonto',
  iban,
  currency: 'CHF',
  ledgerAccountId: accId('1020'),
  idempotencyKey: 'seed:n4:bank',
}).bankAccountId;
const day1 = addDays(TODAY, -5);
const day3 = addDays(TODAY, -3);
const lines = [
  { minor: -6450, name: 'Papeterie Lindenhof', text: 'Rechnung 2207 Büromaterial' },
  { minor: -12990, name: 'Rösterei Seefeld AG', text: 'Kaffeebohnen August' },
  { minor: -3520, name: 'Kiosk am Bahnhof', text: 'Kartenzahlung' },
  { minor: -24800, name: 'Elektro Brunner GmbH', text: 'Service Kaffeemaschine' },
  { minor: -1890, name: 'Post CH AG', text: 'Porto Pakete' },
  { minor: -8900, name: 'Swisscom Schweiz AG', text: 'Abo Internet' },
  { minor: -4310, name: 'Reinigung Glanz GmbH', text: 'Fensterreinigung' },
  { minor: -15600, name: 'Druckerei Zürichsee', text: 'Flyer Herbst' },
];
const opening1 = 250000;
call('import_camt', { ...W, bankAccountId, xml: camt053({ iban, seq: 1, date: day1, opening: opening1, entries: lines }), idempotencyKey: 'seed:n4:camt-1' });
const closing1 = opening1 + lines.reduce((n, e) => n + e.minor, 0);
// Statement 2 is missing: a gap the person must close.
call('import_camt', { ...W, bankAccountId, xml: camt053({ iban, seq: 3, date: day3, opening: closing1, entries: [] }), idempotencyKey: 'seed:n4:camt-3' });

const txns = store.db
  .prepare('SELECT id FROM bank_txn WHERE workspace_id = ? AND bank_account_id = ? ORDER BY rowid')
  .all(workspaceId, bankAccountId)
  .map((r) => r.id);

// --- 3 bank Vorschläge by the agent seat, one of them stale --------------------------------------------

const DIAL_KEY = 'seed:n4:dial';
// The agent drafts what it may not do alone: `post` asks (the default; set it explicitly so a re-seeded
// ledger with another level still drafts).
tryCall('set_agent_dial', { ...W, capability: 'post', level: 'ask', idempotencyKey: DIAL_KEY });

const drafted = [];
// One accounts booking, drafted exactly as an agent sends it (it names no record, so nothing can go stale).
{
  const k = 1;
  const res = agentCall('book_bank_line', {
    ...W,
    bankTxnId: txns[k],
    target: { kind: 'accounts', legs: [{ accountId: accId('6500'), amountMinor: Math.abs(lines[k].minor) }] },
    text: lines[k].text,
    idempotencyKey: `seed:n4:vorschlag:${k}`,
  });
  if (res.drafted !== true) throw new Error(`the agent's book_bank_line was not drafted: ${JSON.stringify(res).slice(0, 300)}`);
  drafted.push(res.actionId);
}

/**
 * A booking by a Buchungsregel the person saved for the line: the Vorschlag pins the rule (D162), so an
 * edit of the rule after the proposal makes the approval refuse `vorschlag_stale` and book nothing.
 */
function ruleVorschlag(k, label, account) {
  const rule = call('set_bank_standard', {
    ...W,
    bankTxnId: txns[k],
    label,
    legs: [{ accountId: accId(account) ?? accId('6500'), taxCode: null, amount: { kind: 'rest' } }],
    idempotencyKey: `seed:n4:rule:${k}`,
  }).standard;
  const res = agentCall('book_bank_line', {
    ...W,
    bankTxnId: txns[k],
    target: { kind: 'rule', standardId: rule.id, asks: {} },
    text: lines[k].text,
    idempotencyKey: `seed:n4:vorschlag:${k}`,
  });
  if (res.drafted !== true) throw new Error(`the agent's rule booking was not drafted: ${JSON.stringify(res).slice(0, 300)}`);
  drafted.push(res.actionId);
  return rule;
}

// The second is fresh: a browser flow can make it stale WHILE it is ticked (the "stale inside a batch" story).
ruleVorschlag(3, 'Elektro Service', '6100');
// The third goes stale now: the person edits its rule after the proposal.
const staleRule = ruleVorschlag(2, 'Kiosk Kleinspesen', '6500');
CLOCK_NOW = `${TODAY}T07:30:00.000Z`;
const ruleRow = store.db.prepare('SELECT * FROM bank_standard WHERE id = ?').get(staleRule.id);
call('set_bank_standard', {
  ...W,
  bankTxnId: txns[2],
  label: ruleRow.label,
  legs: JSON.parse(ruleRow.legs_json).map((l) => ({ ...l, accountId: accId('6570') ?? accId('6800') })),
  idempotencyKey: 'seed:n4:rule-edit',
});

// --- the result -------------------------------------------------------------------------------------

const summary = handleRest('attention_summary', W, person).body;
const grouped = handleRest('attention_list', { ...W, grouping: 'by_area' }, person).body;
console.log(`n4-pendenzen: laid into ${workspaceId} (${FRESH ? 'fresh mandate' : 'Seeblick'})`);
console.log(`  badge ${summary.total}: ${summary.queues.map((q) => `${q.queueId} ${q.count}`).join(', ')}`);
// An engine before D178 answers no sections (the scenario also seeds the "before" measurement).
console.log(`  sections: ${Array.isArray(grouped.sections) ? grouped.sections.map((s) => `${s.key} ${s.count}`).join(', ') : 'none (an engine before D178)'}`);
console.log(`  Vorschläge: ${drafted.join(', ')} (the last one is stale)`);
store.close();
