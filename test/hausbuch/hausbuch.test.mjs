// @ts-nocheck
// N00, the workspace brief and the Hausbuch. SYNTHETIC DATA ONLY: every name, IBAN and note below is
// invented for this suite (the IBANs are the published PostFinance / SIX samples or numbers built here with
// a correct check pair); no real book, statement or counterparty.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getAction } from '../../dist/api/registry.js';
import { handleRest } from '../../dist/api/rest.js';
import { callTool, listBriefResources, readBriefResource, briefResourceUri, BRIEF_RESOURCE_TEMPLATE, MCP_SERVER_INSTRUCTIONS } from '../../dist/api/mcp.js';
import { makeContext } from '../../dist/core/context.js';
import { ok, err } from '../../dist/core/result.js';
import { workspaceBrief, NO_NOTES_HINT, legsLine, parseBriefSections, briefSectionsProblem, BRIEF_SECTIONS, setNote, archiveNote, listNotes } from '../../dist/core/hausbuch/index.js';
import { requiredCapabilitiesFor } from '../../dist/core/access/index.js';
import { DIAL_CAPABILITY_FOR_ACTION } from '../../dist/core/agent/index.js';
import { freshDeps, mintWorkspace } from '../api/support.mjs';

const call = (deps, workspaceId, name, input = {}) => getAction(name).run(deps, { workspaceId, ...input });
const human = (deps) => ({ ...deps, actor: 'studio' });
const rows = (deps, table, workspaceId) => deps.store.db.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? ORDER BY rowid`).all(workspaceId);

/** A Swiss IBAN with a correct mod-97 check pair, built from a 5-digit clearing number and a 12-digit account. */
function ibanOf(clearing, account) {
  const bban = `${clearing}${account}`;
  const digits = `${bban}121700`; // C=12 H=17, check '00'
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return `CH${String(98 - rem).padStart(2, '0')}${bban}`;
}

function world() {
  const deps = freshDeps();
  const { workspaceId, accId } = mintWorkspace(deps, 'Beispiel Atelier GmbH');
  return { deps, workspaceId, accId, h: human(deps) };
}

/** A manual Vorlage (D176): two legs, an asked amount and the rest. */
function vorlage(t, label, debit, credit, key) {
  const res = call(t.h, t.workspaceId, 'set_bank_standard', {
    scope: 'manual',
    label,
    legs: [
      { accountId: t.accId(debit), taxCode: null, side: 'debit', amount: { kind: 'ask', label: 'Betrag' } },
      { accountId: t.accId(credit), taxCode: null, side: 'credit', amount: { kind: 'rest' } },
    ],
    idempotencyKey: key,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.standard;
}

// --- the brief ------------------------------------------------------------------------------------------

test('the brief composes identity, header, chart, VAT codes, Bankkonten, rules, notes and Pendenzen counts', () => {
  const t = world();
  call(t.h, t.workspaceId, 'vat_seed_defaults', {});
  assert.equal(call(t.h, t.workspaceId, 'create_bank_account', { name: 'Geschäftskonto', iban: 'CH93 0076 2011 6238 5295 7', currency: 'CHF', ledgerAccountId: t.accId('1020'), idempotencyKey: 'ba-1' }).ok, true);
  vorlage(t, 'Miete Atelier', '6000', '2800', 'v-1');
  call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Spesen immer mit Beleg buchen.', scope: { kind: 'workspace' }, idempotencyKey: 'n-1' });
  call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Bürobedarf auf 6500.', scope: { kind: 'account', ref: '6500' }, idempotencyKey: 'n-2' });

  const brief = call(t.deps, t.workspaceId, 'workspace_brief');
  assert.equal(brief.ok, true, JSON.stringify(brief));
  assert.deepEqual(brief.sections, [...BRIEF_SECTIONS]);
  assert.deepEqual(brief.omitted, []);
  assert.equal(brief.identity.actor, 'agent');
  assert.equal(typeof brief.identity.agentDial?.customize, 'string', 'the agent seat reads its own dial levels (whoami)');
  assert.equal(brief.workspace.name, 'Beispiel Atelier GmbH');
  assert.deepEqual(brief.accounts.columns, ['number', 'name', 'type', 'vat']);
  const kasse = brief.accounts.rows.find((r) => r[0] === '1000');
  assert.ok(kasse !== undefined && typeof kasse[1] === 'string', 'the seeded Kasse is a row');
  assert.ok(brief.vatCodes.rows.some((r) => r[0] === 'UST81' && r[2] === 810), 'UST81 at 8.1 % is a row');
  assert.deepEqual(brief.bankAccounts.rows[0].slice(1), ['Geschäftskonto', 'CH9300762011623852957', 'CHF', '1020']);
  assert.equal(brief.rules.length, 1);
  assert.equal(brief.rules[0].name, 'Miete Atelier');
  assert.equal(brief.rules[0].scope, 'manual');
  assert.equal(brief.rules[0].legs, 'debit 6000 ?Betrag; credit 2800 rest');
  assert.deepEqual(brief.notes.items.map((n) => n.text), ['Spesen immer mit Beleg buchen.', 'Bürobedarf auf 6500.']);
  assert.equal(brief.notes.items[1].scope.label.startsWith('6500 '), true);
  assert.equal(brief.notes.hint, undefined);
  assert.equal(typeof brief.counts.incomplete, 'boolean');
  // The counts ARE attention_summary's: the same queues with the same numbers.
  const summary = call(t.deps, t.workspaceId, 'attention_summary', {});
  assert.deepEqual(brief.counts.queues, Object.fromEntries(summary.queues.map((q) => [q.queueId, q.count])));
  assert.equal(brief.counts.total, summary.total);
  t.deps.store.close();
});

test('an empty workspace answers empty sections and tells the agent how to write the first note', () => {
  const t = world();
  const brief = call(t.deps, t.workspaceId, 'workspace_brief');
  assert.equal(brief.ok, true);
  assert.deepEqual(brief.rules, []);
  assert.deepEqual(brief.bankAccounts.rows, []);
  assert.deepEqual(brief.notes.items, []);
  assert.equal(brief.notes.hint, NO_NOTES_HINT);
  assert.match(NO_NOTES_HINT, /hausbuch_note_set/);
  t.deps.store.close();
});

test('sections narrows one call; the setting hausbuch.brief_sections decides the default and refuses a bad list', () => {
  const t = world();
  const one = call(t.deps, t.workspaceId, 'workspace_brief', { sections: ['notes', 'accounts'] });
  assert.deepEqual(one.sections, ['accounts', 'notes'], 'the brief keeps its own order');
  assert.equal(one.vatCodes, undefined);
  assert.equal(one.rules, undefined);
  assert.ok(one.identity !== undefined && one.workspace !== undefined, 'identity and header always come along');

  const bad = call(t.deps, t.workspaceId, 'workspace_brief', { sections: ['chart'] });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_input');
  assert.equal(bad.field, 'sections');

  const set = call(t.h, t.workspaceId, 'settings_set', { key: 'hausbuch.brief_sections', value: 'notes, counts', reason: 'nur das Nötigste', idempotencyKey: 's-1' });
  assert.equal(set.ok, true, JSON.stringify(set));
  assert.deepEqual(call(t.deps, t.workspaceId, 'workspace_brief').sections, ['notes', 'counts']);

  assert.deepEqual(briefSectionsProblem(''), { reason: 'empty' });
  for (const value of ['notes,chart', 'notes,notes', ' , ']) {
    const refused = call(t.h, t.workspaceId, 'settings_set', { key: 'hausbuch.brief_sections', value, reason: 'Probe', idempotencyKey: `s-bad-${value}` });
    assert.equal(refused.ok, false, value);
    assert.equal(refused.error, 'invalid_setting_value', value);
  }
  assert.deepEqual(parseBriefSections('garbage'), [...BRIEF_SECTIONS], 'a stored value that does not parse reads as every section');
  assert.equal(briefSectionsProblem('accounts,vatCodes'), null);
  t.deps.store.close();
});

test('per-section RBAC: a section whose read gate is refused is omitted, never answered', () => {
  const t = world();
  call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Nur intern.', scope: { kind: 'topic', ref: 'Lohn' }, idempotencyKey: 'n-1' });
  const denied = new Set(['read_vat', 'read_master_data']);
  const ctx = makeContext(t.deps.store, {
    workspaceId: t.workspaceId,
    actor: 'agent',
    clock: t.deps.clock,
    ids: t.deps.ids,
    capabilities: { assert: (c) => (denied.has(c) ? err('permission_denied', { capability: c }) : ok()) },
  });
  const brief = workspaceBrief(ctx, {});
  assert.equal(brief.ok, true);
  assert.equal(brief.vatCodes, undefined);
  assert.equal(brief.notes, undefined);
  assert.equal(brief.bankAccounts, undefined);
  assert.equal(brief.workspace, undefined, 'the header is master data');
  assert.deepEqual(
    brief.omitted.map((o) => [o.section, o.capability]),
    [
      ['vatCodes', 'read_vat'],
      ['bankAccounts', 'read_master_data'],
      ['notes', 'read_master_data'],
    ],
  );
  assert.ok(Array.isArray(brief.accounts.rows), 'a section the caller may read is still answered');
  t.deps.store.close();
});

test('the brief stays compact: a Nomadik-sized synthetic book measures well under 15000 tokens', () => {
  const t = world();
  call(t.h, t.workspaceId, 'vat_seed_defaults', {});
  const seeded = rows(t.deps, 'account', t.workspaceId).length;
  // Fill the chart to 200 active accounts with plausible KMU names.
  const taken = new Set(rows(t.deps, 'account', t.workspaceId).map((r) => r.number));
  const added = [];
  for (let n = 4100; seeded + added.length < 200; n += 1) {
    const number = String(n);
    if (taken.has(number)) continue;
    const res = call(t.h, t.workspaceId, 'create_account', { number, name: `Aufwand Kostenstelle ${added.length + 1} Projektarbeit`, type: 'expense', idempotencyKey: `acc-${number}` });
    assert.equal(res.ok, true, JSON.stringify(res));
    added.push(number);
  }
  for (const [n, clearing] of [['1021', '00762'], ['1022', '09000'], ['1023', '04835']]) {
    const ledger = call(t.h, t.workspaceId, 'create_account', { number: n, name: `Bank ${n}`, type: 'asset', idempotencyKey: `l-${n}` }).accountId;
    const res = call(t.h, t.workspaceId, 'create_bank_account', { name: `Konto ${n}`, iban: ibanOf(clearing, `0000123${n}00`), currency: 'CHF', ledgerAccountId: ledger, idempotencyKey: `b-${n}` });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
  for (let i = 0; i < 25; i += 1) vorlage(t, `Vorlage Monatsbuchung ${i + 1}`, added[i], '2800', `v-${i}`);
  for (let i = 0; i < 50; i += 1) {
    const res = call(t.h, t.workspaceId, 'hausbuch_note_set', {
      text: `Lieferant ${i + 1}: Rechnungen brutto buchen, Vorsteuer separat, Beleg im Ordner Kreditoren ablegen.`,
      scope: { kind: 'counterparty', ref: `Beispiel Lieferant ${i + 1} AG` },
      idempotencyKey: `note-${i}`,
    });
    assert.equal(res.ok, true, JSON.stringify(res));
  }
  const brief = call(t.deps, t.workspaceId, 'workspace_brief');
  assert.equal(brief.ok, true);
  assert.equal(brief.accounts.rows.length, 203);
  assert.equal(brief.notes.items.length, 50, 'every note rides along');
  assert.equal(brief.rules.length, 25);
  const tokens = Math.ceil(JSON.stringify(brief).length / 4);
  console.log(`N00 brief size on the synthetic fixture (203 accounts, ${brief.vatCodes.rows.length} VAT codes, ${brief.bankAccounts.rows.length} Bankkonten, 25 Vorlagen, 50 notes): ${JSON.stringify(brief).length} chars, about ${tokens} tokens`);
  assert.ok(tokens < 15000, `${tokens} tokens`);
  t.deps.store.close();
});

test('a rule recipe reads in one line: sides, codes, asked, computed, against and via', () => {
  const legs = [
    { accountNumber: '6500', taxCode: 'VST81', amount: { kind: 'ask', label: 'Material' } },
    { accountNumber: '6940', taxCode: null, against: true, amount: { kind: 'factor', label: 'Gebühr', num: 3, den: 100 } },
    { accountNumber: '3400', taxCode: 'UST81', amount: { kind: 'rest' } },
  ];
  assert.equal(legsLine({ outcome: 'legs', legs, ignoreReason: null, viaAccountNumber: '1095' }), '6500 VST81 ?Material; against 6940 3/100 Gebühr; 3400 UST81 rest via 1095');
  assert.equal(legsLine({ outcome: 'ignore', legs: [], ignoreReason: 'private', viaAccountNumber: null }), 'ignore: private');
});

// --- the notes --------------------------------------------------------------------------------------------

test('a note is validated: text 1 to 500 characters, a known account, a well-formed scope', () => {
  const t = world();
  const set = (input, key) => call(t.h, t.workspaceId, 'hausbuch_note_set', { idempotencyKey: key, ...input });
  for (const text of ['', '   ', 'x'.repeat(501)]) {
    const r = set({ text, scope: { kind: 'workspace' } }, `t-${text.length}`);
    assert.equal(r.error, 'invalid_input');
    assert.equal(r.field, 'text');
  }
  assert.equal(set({ text: 'x'.repeat(500), scope: { kind: 'workspace' } }, 't-500').ok, true);
  const unknown = set({ text: 'Konto?', scope: { kind: 'account', ref: '9999' } }, 'acc-x');
  assert.equal(unknown.error, 'scope_not_found');
  assert.equal(set({ text: 'Konto?', scope: { kind: 'contact', ref: 'x' } }, 'k-x').field, 'scope.kind');
  assert.equal(set({ text: 'Thema?', scope: { kind: 'topic' } }, 'tp-x').field, 'scope.ref');
  assert.equal(set({ text: 'Thema?', scope: { kind: 'topic', ref: 'x'.repeat(41) } }, 'tp-y').field, 'scope.ref');
  assert.equal(set({ text: 'Nichts', scope: { kind: 'workspace' }, id: 'hbn_missing' }, 'id-x').error, 'not_found');
  t.deps.store.close();
});

test('a counterparty note is keyed as a Buchungsregel is: a raw IBAN or name folds into the bank key', () => {
  const t = world();
  const byIban = call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Monatliche Lastschrift.', scope: { kind: 'counterparty', ref: 'ch56 0483 5012 3456 7800 9' }, idempotencyKey: 'c-1' });
  assert.equal(byIban.ok, true, JSON.stringify(byIban));
  assert.equal(byIban.note.scope.ref, 'iban:CH5604835012345678009');
  const byName = call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Rechnung brutto.', scope: { kind: 'counterparty', ref: 'Papeterie Lindengrund AG' }, idempotencyKey: 'c-2' });
  assert.equal(byName.note.scope.ref, 'name:papeterie lindengrund');
  assert.equal(byName.note.scope.label, 'Papeterie Lindengrund AG');
  const byKey = call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Gleich.', scope: { kind: 'counterparty', ref: 'name:Papeterie Lindengrund' }, idempotencyKey: 'c-3' });
  assert.equal(byKey.note.scope.ref, 'name:papeterie lindengrund');

  // The bank line Details read: a line's IBAN, else its name, meets the note.
  const viaIban = call(t.deps, t.workspaceId, 'hausbuch_notes', { counterparty: { name: 'Irgendwer', iban: 'CH5604835012345678009' } });
  assert.deepEqual(viaIban.notes.map((n) => n.text), ['Monatliche Lastschrift.']);
  const viaName = call(t.deps, t.workspaceId, 'hausbuch_notes', { counterparty: { name: 'PAPETERIE LINDENGRUND GMBH', iban: null } });
  assert.deepEqual(viaName.notes.map((n) => n.text).sort(), ['Gleich.', 'Rechnung brutto.']);
  assert.deepEqual(call(t.deps, t.workspaceId, 'hausbuch_notes', { counterparty: { name: 'Fremde AG' } }).notes, []);
  t.deps.store.close();
});

test('security: a seat without read_sales never sees a counterparty, its IBAN or the bank\'s name for it', () => {
  const t = world();
  // A bank reader writes a note keyed by an IBAN; a Buchungsregel elsewhere names the payer, so the label
  // the bank reader gets is bank data.
  call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Lastschrift monatlich.', scope: { kind: 'counterparty', ref: 'CH56 0483 5012 3456 7800 9' }, idempotencyKey: 'sec-1' });
  call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Allgemein gültig.', scope: { kind: 'workspace' }, idempotencyKey: 'sec-2' });
  const noBank = makeContext(t.deps.store, {
    workspaceId: t.workspaceId,
    actor: 'member:no-bank',
    clock: t.deps.clock,
    ids: t.deps.ids,
    capabilities: { assert: (c) => (c === 'read_sales' ? err('permission_denied', { capability: c }) : ok()) },
  });
  const listed = listNotes(noBank, { status: 'all' });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.notes.map((n) => n.text), ['Allgemein gültig.'], 'the counterparty note is withheld');
  assert.equal(listed.withheld, 1);
  assert.ok(!JSON.stringify(listed).includes('CH56'), 'no IBAN reaches the seat');
  // Security review r2 (existence oracle): a counterparty scope filter is refused before its key is
  // resolved, with or without a ref, for a key that exists and one that does not alike.
  for (const scope of [
    { kind: 'counterparty' },
    { kind: 'counterparty', ref: 'CH56 0483 5012 3456 7800 9' },
    { kind: 'counterparty', ref: 'iban:CH5604835012345678009' },
    { kind: 'counterparty', ref: 'Niemand Bekanntes AG' },
  ]) {
    const byScope = listNotes(noBank, { scope });
    assert.equal(byScope.ok, false, JSON.stringify(scope));
    assert.equal(byScope.error, 'permission_denied');
    assert.equal(byScope.capability, 'read_sales');
    assert.equal(byScope.notes, undefined);
  }
  assert.equal(listNotes(noBank, { scope: { kind: 'topic' } }).ok, true, 'another kind stays readable');
  const bankLookup = listNotes(noBank, { counterparty: { iban: 'CH5604835012345678009' } });
  assert.equal(bankLookup.error, 'permission_denied');
  assert.equal(bankLookup.capability, 'read_sales');
  const brief = workspaceBrief(noBank, { sections: ['notes'] });
  assert.deepEqual(brief.notes.items.map((n) => n.text), ['Allgemein gültig.']);
  assert.equal(brief.notes.withheld, 1);
  assert.ok(!JSON.stringify(brief).includes('CH56'), 'no IBAN reaches the brief');
  // A write by such a seat resolves no label from bank data and answers the scope blanked.
  const written = setNote(noBank, { text: 'Von mir.', scope: { kind: 'counterparty', ref: 'iban:CH9300762011623852957' }, idempotencyKey: 'sec-3' });
  assert.equal(written.ok, true, JSON.stringify(written));
  assert.deepEqual(written.note.scope, { kind: 'counterparty', ref: null, label: null });
  // The bank reader sees both counterparty notes in full.
  const full = call(t.h, t.workspaceId, 'hausbuch_notes', { scope: { kind: 'counterparty' } });
  assert.equal(full.notes.length, 2);
  assert.equal(full.withheld, 0);
  t.deps.store.close();
});

test('every change writes one history row and one audit row; a replay and an unchanged set write nothing', () => {
  const t = world();
  const created = call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Erste Fassung.', scope: { kind: 'topic', ref: 'MWST' }, idempotencyKey: 'h-1' });
  assert.equal(created.changed, true);
  const id = created.note.id;
  assert.deepEqual(call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Erste Fassung.', scope: { kind: 'topic', ref: 'MWST' }, idempotencyKey: 'h-1' }), created, 'a replay answers the stored result');
  const same = call(t.h, t.workspaceId, 'hausbuch_note_set', { id, text: 'Erste Fassung.', scope: { kind: 'topic', ref: 'MWST' }, idempotencyKey: 'h-2' });
  assert.equal(same.changed, false);
  const updated = call(t.h, t.workspaceId, 'hausbuch_note_set', { id, text: 'Zweite Fassung.', scope: { kind: 'topic', ref: 'MWST' }, idempotencyKey: 'h-3' });
  assert.equal(updated.changed, true);
  const archived = call(t.h, t.workspaceId, 'hausbuch_note_archive', { id, idempotencyKey: 'h-4' });
  assert.equal(archived.note.status, 'archived');
  assert.equal(call(t.h, t.workspaceId, 'hausbuch_note_archive', { id, idempotencyKey: 'h-5' }).changed, false, 'archiving an archived note changes nothing');
  assert.deepEqual(call(t.deps, t.workspaceId, 'workspace_brief', { sections: ['notes'] }).notes.items, [], 'an archived note leaves the brief');
  const restored = call(t.h, t.workspaceId, 'hausbuch_note_set', { id, text: 'Zweite Fassung.', scope: { kind: 'topic', ref: 'MWST' }, idempotencyKey: 'h-6' });
  assert.equal(restored.note.status, 'active', 'set on an archived note brings it back');

  const history = rows(t.deps, 'hausbuch_note_change', t.workspaceId);
  assert.deepEqual(history.map((r) => r.kind), ['create', 'update', 'archive', 'restore']);
  assert.equal(history[1].old_text, 'Erste Fassung.');
  assert.equal(history[1].new_text, 'Zweite Fassung.');
  assert.equal(history[1].actor, 'studio');
  const audit = t.deps.store.db.prepare("SELECT action FROM audit_log WHERE entity_kind = 'hausbuch_note' ORDER BY rowid").all().map((r) => r.action);
  assert.deepEqual(audit, ['create', 'update', 'archive', 'unarchive']);
  assert.throws(() => t.deps.store.db.prepare('DELETE FROM hausbuch_note_change').run(), /append-only/);
  assert.throws(() => t.deps.store.db.prepare("UPDATE hausbuch_note_change SET new_text = 'x'").run(), /append-only/);
  t.deps.store.close();
});

test('§H-TENANT: a note of workspace A is invisible and unreachable from workspace B', () => {
  const t = world();
  const a = call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Nur A.', scope: { kind: 'workspace' }, idempotencyKey: 'a-1' });
  const b = mintWorkspace(t.deps, 'Andere Werkstatt GmbH', 'ws-b');
  assert.deepEqual(call(t.h, b.workspaceId, 'hausbuch_notes', { status: 'all' }).notes, []);
  assert.deepEqual(call(t.deps, b.workspaceId, 'workspace_brief', { sections: ['notes'] }).notes.items, []);
  assert.equal(call(t.h, b.workspaceId, 'hausbuch_note_set', { id: a.note.id, text: 'Übernommen.', scope: { kind: 'workspace' }, idempotencyKey: 'b-1' }).error, 'not_found');
  assert.equal(call(t.h, b.workspaceId, 'hausbuch_note_archive', { id: a.note.id, idempotencyKey: 'b-2' }).error, 'not_found');
  assert.equal(call(t.h, t.workspaceId, 'hausbuch_notes', {}).notes[0].text, 'Nur A.', 'A is untouched');
  t.deps.store.close();
});

// --- the agent and the dial ---------------------------------------------------------------------------

test('both note writes are governed by the dial under customize', () => {
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.hausbuch_note_set, 'customize');
  assert.equal(DIAL_CAPABILITY_FOR_ACTION.hausbuch_note_archive, 'customize');
});

test('an agent seat\'s hausbuch_note_set under the default dial drafts a Vorschlag and writes no note; approving stores it, rejecting stores nothing', () => {
  const t = world();
  // The agent seat over the MCP door (runGoverned).
  const drafted = JSON.parse(callTool(t.deps, 'hausbuch_note_set', { workspaceId: t.workspaceId, text: 'Bezugsteuer wird nicht deklariert.', scope: { kind: 'topic', ref: 'MWST' }, idempotencyKey: 'ag-1' }).content[0].text);
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  assert.equal(drafted.drafted, true);
  assert.equal(drafted.dialCapability, 'customize');
  assert.deepEqual(rows(t.deps, 'hausbuch_note', t.workspaceId), [], 'the draft wrote no note');
  assert.deepEqual(rows(t.deps, 'hausbuch_note_change', t.workspaceId), []);

  // The Vorschlag carries the note's text (Pendenzen titles it with it).
  const pending = call(t.h, t.workspaceId, 'list_drafted_actions', {}).actions;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].actionTool, 'hausbuch_note_set');
  assert.equal(pending[0].payload.text, 'Bezugsteuer wird nicht deklariert.');

  const approved = call(t.h, t.workspaceId, 'approve_drafted_action', { actionId: drafted.actionId });
  assert.equal(approved.ok, true, JSON.stringify(approved));
  const notes = rows(t.deps, 'hausbuch_note', t.workspaceId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].created_by, 'studio', 'the approval replays the write as the person who approved it');
  const brief = JSON.parse(callTool(t.deps, 'workspace_brief', { workspaceId: t.workspaceId, sections: ['notes'] }).content[0].text);
  assert.deepEqual(brief.notes.items.map((n) => n.text), ['Bezugsteuer wird nicht deklariert.']);

  // A second proposal, rejected over REST, stores nothing.
  const second = handleRest('hausbuch_note_set', { workspaceId: t.workspaceId, text: 'Spesen pauschal.', scope: { kind: 'workspace' }, idempotencyKey: 'ag-2' }, t.deps).body;
  assert.equal(second.drafted, true);
  assert.equal(call(t.h, t.workspaceId, 'reject_drafted_action', { actionId: second.actionId, reason: 'stimmt nicht' }).ok, true);
  assert.equal(rows(t.deps, 'hausbuch_note', t.workspaceId).length, 1, 'a rejected note is never stored');
  t.deps.store.close();
});

test('an agent\'s change to a note the owner edits meanwhile goes stale: the approval overwrites nothing', () => {
  const t = world();
  const note = call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Fassung der Inhaberin.', scope: { kind: 'workspace' }, idempotencyKey: 'p-1' }).note;
  const drafted = JSON.parse(callTool(t.deps, 'hausbuch_note_set', { workspaceId: t.workspaceId, id: note.id, text: 'Fassung des Agenten.', scope: { kind: 'workspace' }, idempotencyKey: 'p-2' }).content[0].text);
  assert.equal(drafted.drafted, true, JSON.stringify(drafted));
  call(t.h, t.workspaceId, 'hausbuch_note_set', { id: note.id, text: 'Neue Fassung der Inhaberin.', scope: { kind: 'workspace' }, idempotencyKey: 'p-3' });
  const approved = call(t.h, t.workspaceId, 'approve_drafted_action', { actionId: drafted.actionId });
  assert.equal(approved.ok, false);
  assert.equal(approved.error, 'vorschlag_stale');
  assert.equal(rows(t.deps, 'hausbuch_note', t.workspaceId)[0].text, 'Neue Fassung der Inhaberin.');
  t.deps.store.close();
});

test('a caller without manage_settings is refused permission_denied on both writes; the list needs read_master_data', () => {
  const t = world();
  const note = call(t.h, t.workspaceId, 'hausbuch_note_set', { text: 'Bleibt.', scope: { kind: 'workspace' }, idempotencyKey: 'pd-1' }).note;
  assert.deepEqual(requiredCapabilitiesFor('hausbuch_note_set', {}), ['manage_settings']);
  assert.deepEqual(requiredCapabilitiesFor('hausbuch_note_archive', {}), ['manage_settings']);
  assert.deepEqual(requiredCapabilitiesFor('hausbuch_notes', {}), ['read_master_data']);
  // The engine belt, bitten directly with a port that holds every read and no manage_* right.
  const ctx = makeContext(t.deps.store, {
    workspaceId: t.workspaceId,
    actor: 'member:reader',
    clock: t.deps.clock,
    ids: t.deps.ids,
    capabilities: { assert: (c) => (c.startsWith('read_') ? ok() : err('permission_denied', { capability: c })) },
  });
  const set = setNote(ctx, { text: 'Anders.', scope: { kind: 'workspace' }, idempotencyKey: 'pd-2' });
  assert.equal(set.error, 'permission_denied');
  assert.equal(set.capability, 'manage_settings');
  assert.equal(archiveNote(ctx, { id: note.id, idempotencyKey: 'pd-3' }).error, 'permission_denied');
  assert.equal(listNotes(ctx, {}).ok, true, 'reading the notes needs only read_master_data');
  assert.equal(rows(t.deps, 'hausbuch_note', t.workspaceId)[0].text, 'Bleibt.');
  t.deps.store.close();
});

// --- the MCP resource and the server instructions -------------------------------------------------------

test('the brief is an MCP resource per workspace, read through the governed dispatch', () => {
  const t = world();
  assert.equal(BRIEF_RESOURCE_TEMPLATE, 'till://workspace/{id}/brief');
  const listed = listBriefResources(t.deps);
  assert.ok(listed.some((r) => r.uri === briefResourceUri(t.workspaceId)), JSON.stringify(listed));
  const read = readBriefResource(t.deps, briefResourceUri(t.workspaceId));
  assert.equal(read.mimeType, 'application/json');
  const body = JSON.parse(read.text);
  assert.equal(body.ok, true);
  assert.deepEqual(body.sections, [...BRIEF_SECTIONS]);
  // Read under the agent seat, so the A35 trace records the call like the tool.
  const traced = t.deps.store.db.prepare("SELECT COUNT(*) AS n FROM agent_call WHERE workspace_id = ? AND verb = 'workspace_brief'").get(t.workspaceId).n;
  assert.equal(traced, 1);
  assert.throws(() => readBriefResource(t.deps, 'till://workspace/x/other'), /unknown_resource/);
  assert.equal(JSON.parse(readBriefResource(t.deps, briefResourceUri('ws_missing')).text).error, 'workspace_not_found');
  t.deps.store.close();
});

test('the server instructions name workspace_brief in the whoami sentence', () => {
  assert.match(MCP_SERVER_INSTRUCTIONS, /Call whoami first, then workspace_brief/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Hausregeln/);
});
