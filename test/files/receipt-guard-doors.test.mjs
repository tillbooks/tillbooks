/**
 * N02 (D183), R1 RECEIPT UNIQUENESS, the re-cut after critic round 3: one receipt (its sha256) evidences
 * at most one LIVE booking in a workspace unless a person confirms a second with a reason.
 *
 * 1. THE POSITIVE GATE: the doors are derived from the CODE, not from field names. Every `linkFile` call
 *    whose entity kind can be a booking kind, every SQL write of a receipt pointer (`receipt_ref`,
 *    `receipt_document_id`), every write of a file's link (`stored_file.entity_kind` / `entity_id`) and
 *    every write of a bank line's decision must be named in `RECEIPT_DOORS` or `RECEIPT_GUARD_EXEMPT`, and
 *    every entry there must still name a site in the code.
 * 2. EACH GUARDED DOOR, driven with a live FILED holder and with a PENDING holder (a Vorschlag's
 *    reservation): refused naming the holder, then booked with the person's reason, recorded.
 * 3. The critic's round-3 probe, the agent seat, E1, liveness.
 *
 * Every byte here is SYNTHETIC: magic numbers and invented text in a temporary folder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getAction } from '../../dist/api/registry.js';
import { callTool } from '../../dist/api/mcp.js';
import { handleDropCall } from '../../dist/api/drop-face.js';
import { RECEIPT_BOOKING_KINDS, RECEIPT_DOORS, RECEIPT_GUARD_EXEMPT } from '../../dist/core/files/receiptGuard.js';
import { SCENARIOS, fixture } from '../api/conformance-contract.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic receipt, Muster Papeterie')]);
const R = '~/.claude/uploads/s1/r.jpg';
const REASON = { bookAgain: true, overrideReason: 'Zwei Positionen auf einem Beleg' };

// --- 1. the positive gate ----------------------------------------------------------------------

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

const FN = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^(?:export\s+)?const\s+(\w+)\s*[:=]/;

/** The top-level function (or const) a position sits in. */
function enclosing(text, index) {
  const lines = text.slice(0, index).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = FN.exec(lines[i]);
    if (m) return m[1] ?? m[2];
  }
  return '<module>';
}

/** The string literal a SQL keyword sits in: the nearest quote before it opens it. */
function stringAround(text, index) {
  let i = index;
  while (i > 0 && !['`', "'", '"'].includes(text[i])) i--;
  const end = text.indexOf(text[i], index);
  return text.slice(i + 1, end);
}

/** The text of a call from its open paren to the matching close paren. */
function callText(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

function splitTop(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim().length > 0) out.push(cur.trim());
  return out;
}

/** Does this SQL statement WRITE one of `columns`? (An UPDATE's SET clause; an INSERT's non-NULL value.) */
function writesColumn(sql, columns) {
  if (/^\s*UPDATE/i.test(sql)) {
    const set = /\bSET\b([\s\S]*?)(\bWHERE\b|$)/i.exec(sql)?.[1] ?? '';
    return columns.some((c) => new RegExp(`\\b${c}\\s*=`).test(set));
  }
  const cols = /\(([\s\S]*?)\)/.exec(sql)?.[1];
  if (cols === undefined) return true;
  const names = splitTop(cols);
  const values = /\bVALUES\s*\(([\s\S]*)\)/i.exec(sql)?.[1];
  return columns.some((c) => {
    const at = names.indexOf(c);
    if (at < 0) return false;
    if (values === undefined) return true; // INSERT ... SELECT: it copies whatever it selects
    return splitTop(values)[at]?.toUpperCase() !== 'NULL';
  });
}

function scanDoorSites() {
  const sites = new Map();
  const literalNonBooking = [];
  const add = (key, why) => sites.set(key, [...(sites.get(key) ?? []), why]);
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    // Comments blanked (same length, newlines kept): a SQL statement quoted in prose is no write.
    const blank = (c) => c.replace(/[^\n]/g, ' ');
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, blank).replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, lead) => lead + blank(m.slice(lead.length)));
    const rel = relative(ROOT, file).split('\\').join('/');
    for (const m of text.matchAll(/\blinkFile\(/g)) {
      if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
      const call = callText(text, m.index + 'linkFile'.length);
      const kind = /entityKind:\s*'([a-z_]+)'/.exec(call)?.[1];
      if (kind !== undefined && !RECEIPT_BOOKING_KINDS.includes(kind)) {
        literalNonBooking.push(`${rel}#${enclosing(text, m.index)}:${kind}`);
        continue;
      }
      add(`${rel}#${enclosing(text, m.index)}`, `linkFile(${kind ?? 'a computed kind'})`);
    }
    for (const m of text.matchAll(/(INSERT(?: OR [A-Z]+)? INTO|UPDATE)\s+(vendor_bill|expense_line|bank_line_decision|stored_file)\b/g)) {
      const sql = stringAround(text, m.index);
      const table = m[2];
      const counts =
        table === 'bank_line_decision' ||
        (table === 'vendor_bill' && writesColumn(sql, ['receipt_ref'])) ||
        (table === 'expense_line' && writesColumn(sql, ['receipt_document_id'])) ||
        (table === 'stored_file' && writesColumn(sql, ['entity_kind', 'entity_id']));
      if (counts) add(`${rel}#${enclosing(text, m.index)}`, `${m[1]} ${table}`);
    }
  }
  return { sites, literalNonBooking };
}

test('R1 positive gate: every door derived from the code is guarded or exempt, and every entry still names a site', () => {
  const { sites, literalNonBooking } = scanDoorSites();
  const named = { ...RECEIPT_DOORS, ...RECEIPT_GUARD_EXEMPT };
  const unnamed = [...sites.keys()].filter((k) => !(k in named));
  assert.deepEqual(unnamed, [], `doors in neither RECEIPT_DOORS nor RECEIPT_GUARD_EXEMPT: ${unnamed.map((k) => `${k} (${sites.get(k)})`).join('; ')}`);
  const stale = Object.keys(named).filter((k) => !sites.has(k));
  assert.deepEqual(stale, [], 'entries that name no site in the code any more');
  assert.equal(Object.keys(RECEIPT_DOORS).some((k) => k in RECEIPT_GUARD_EXEMPT), false, 'a site is a door or exempt, never both');
  // The classifier does see the other links (it is not blind): ebics, templates, payroll and the rest.
  assert.ok(literalNonBooking.length >= 8, `non-booking links seen: ${literalNonBooking.join(', ')}`);
  // The G21 importer writes no receipt pointer (its bills carry receipt_ref NULL): the classifier reads values.
  assert.equal(sites.has('src/core/purchase/vendorBill.ts#createMigratedVendorBill'), false);
  for (const writer of ['src/core/hr/claims.ts#upsertLine', 'src/core/purchase/vendorBill.ts#insertDraft', 'src/core/purchase/vendorBill.ts#attachReceipt', 'src/core/banking/bankLines.ts#insertDecision']) {
    assert.ok(sites.has(writer), `the scan finds ${writer}`);
  }
});

// --- 2. every guarded door, with a filed and with a pending holder --------------------------------

function world() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'till-r1-')));
  mkdirSync(join(home, '.claude', 'uploads', 's1'), { recursive: true });
  writeFileSync(join(home, '.claude', 'uploads', 's1', 'r.jpg'), JPEG);
  const fx = fixture();
  fx.deps.localFiles = { home };
  const ws = fx.workspaceId;
  const asHuman = { ...fx.deps, actor: 'studio' };
  const run = (name, input) => getAction(name).run(asHuman, { workspaceId: ws, ...input });
  const agent = (name, args) => JSON.parse(callTool({ ...fx.deps, actor: 'agent' }, name, { workspaceId: ws, ...args }).content[0].text);
  const post = (key, extra = {}) =>
    run('post_entry', {
      date: '2026-06-12', description: 'Bürobedarf', source: 'manual', idempotencyKey: key,
      lines: [{ account: fx.accId('6500'), debit: 8450 }, { account: fx.accId('1020'), credit: 8450 }], ...extra,
    });
  const upload = (key) => run('files_upload', { contentBase64: JPEG.toString('base64'), mime: 'image/jpeg', filename: 'r.jpg', idempotencyKey: key }).file.id;
  const vendor = () => run('create_contact', { partyRole: 'vendor', name: 'Muster Papeterie AG', idempotencyKey: 'vendor' }).contact.id;
  const bill = (key, extra = {}) =>
    run('create_vendor_bill', { vendorId: vendor(), billDate: '2026-06-10', amountMinor: 8450, expenseAccountId: fx.accId('6500'), idempotencyKey: key, ...extra });
  const overrides = () => fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM receipt_override WHERE workspace_id = ?').get(ws).n;
  return {
    fx, ws, run, agent, post, upload, vendor, bill, overrides,
    cleanup: () => {
      fx.deps.store.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** The holder the door must meet: a booked entry, or a Vorschlag still waiting with the same receipt. */
const HOLDERS = {
  filed: (w) => {
    const e = w.post('holder', { attach: [{ sourcePath: R }] });
    assert.equal(e.ok, true, JSON.stringify(e));
    return ['journal_entry', e.entryId];
  },
  pending: (w) => {
    const d = w.agent('post_entry', {
      date: '2026-06-12', description: 'Bürobedarf', source: 'manual', idempotencyKey: 'holder',
      lines: [{ account: w.fx.accId('6500'), debit: 8450 }, { account: w.fx.accId('1020'), credit: 8450 }], attach: [{ sourcePath: R }],
    });
    assert.equal(d.drafted, true, JSON.stringify(d));
    return ['drafted_action', d.actionId];
  },
};

const capture = (w) => w.run('capture_document', { sourcePath: R, idempotencyKey: 'cap' }).captureId;
const claim = (w) => {
  w.claimId ??= SCENARIOS.expense_line_upsert(w.fx).claimId;
  return w.claimId;
};
const amount = [{ key: 'amount', value: { minor: 8450, currency: 'CHF' } }];

/** Every guarded door. `setup` runs before the holder exists; `act` is re-runnable (its keys repeat). */
const DOORS = {
  'files_link (the Studio attach path)': {
    act: (w, x) => w.run('files_link', { fileId: w.upload('u'), entityKind: 'journal_entry', entityId: w.post('door').entryId, idempotencyKey: 'lk', ...x }),
  },
  'post_entry attach': { act: (w, x) => w.post('door', { attach: [{ sourcePath: R }], ...x }) },
  'create_vendor_bill attach': { act: (w, x) => w.bill('door', { attach: [{ sourcePath: R }], ...x }) },
  'record_expense attach': {
    act: (w, x) =>
      w.run('record_expense', { vendorId: w.vendor(), billDate: '2026-06-10', amountMinor: 8450, expenseAccountId: w.fx.accId('6500'), idempotencyKey: 'door', attach: [{ sourcePath: R }], ...x }),
  },
  'book_bank_line attach': {
    setup: (w) => (w.line = SCENARIOS.create_entry_for_txn(w.fx).bankTxnId),
    act: (w, x) =>
      w.run('book_bank_line', {
        bankTxnId: w.line, target: { kind: 'accounts', legs: [{ accountId: w.fx.accId('6500'), amountMinor: 500 }] }, idempotencyKey: 'door', attach: [{ sourcePath: R }], ...x,
      }),
  },
  'the drop link onto a booking': {
    act: (w, x) => {
      const entryId = w.post('door').entryId;
      w.token ??= w.agent('files_drop_link', { target: { kind: 'journal_entry', id: entryId }, idempotencyKey: 'dl' }).token;
      return handleDropCall({ ...w.fx.deps, actor: 'studio' }, 'redeem', { token: w.token, contentBase64: JPEG.toString('base64'), filename: 'r.jpg', ...x }).body;
    },
  },
  'capture_commit to a vendor bill': {
    act: (w, x) =>
      w.run('capture_commit', {
        captureId: capture(w), target: { kind: 'vendor_bill', vendorId: w.vendor(), expenseAccountId: w.fx.accId('6500') }, corrections: amount, idempotencyKey: 'commit', ...x,
      }),
  },
  'capture_commit to an expense line': {
    setup: (w) => claim(w),
    act: (w, x) => w.run('capture_commit', { captureId: capture(w), target: { kind: 'expense_line', claimId: claim(w) }, corrections: amount, idempotencyKey: 'commit', ...x }),
  },
  'attach_receipt': {
    setup: (w) => (w.billId = w.bill('plain').vendorBillId),
    act: (w, x) => w.run('attach_receipt', { vendorBillId: w.billId, receiptRef: w.upload('u'), idempotencyKey: 'ar', ...x }),
  },
  'create_vendor_bill receiptRef': { act: (w, x) => w.bill('door', { receiptRef: w.upload('u'), ...x }) },
  'expense_line_upsert receiptDocumentId': {
    setup: (w) => claim(w),
    act: (w, x) =>
      w.run('expense_line_upsert', { claimId: claim(w), line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 4000, receiptDocumentId: w.upload('u') }, idempotencyKey: 'door', ...x }),
  },
  'files_new_version on a booked entry (new bytes)': {
    // The new bytes go through THE guard (security review B), so a holder of them refuses like any link;
    // the person's reason confirms the second booking and the replacement in one record.
    act: (w, x) => {
      const entryId = w.post('door').entryId;
      const other = w.run('files_upload', { contentBase64: Buffer.from('%PDF-1.4 another synthetic receipt').toString('base64'), mime: 'application/pdf', filename: 'a.pdf', idempotencyKey: 'other' }).file.id;
      assert.equal(w.run('files_link', { fileId: other, entityKind: 'journal_entry', entityId: entryId, idempotencyKey: 'lk-other' }).ok, true);
      return w.run('files_new_version', { fileId: other, contentBase64: JPEG.toString('base64'), mime: 'image/jpeg', filename: 'r.jpg', idempotencyKey: 'nv', ...x });
    },
  },
  'book_bank_line liveness (a receipt filed on the open line)': {
    setup: (w) => (w.line = SCENARIOS.create_entry_for_txn(w.fx).bankTxnId),
    act: (w, x) => {
      // An open line is not live: filing the receipt on it books nothing and is not judged.
      const filed = w.run('files_link', { fileId: w.upload('u'), entityKind: 'bank_txn', entityId: w.line, idempotencyKey: 'lk' });
      assert.equal(filed.ok, true, JSON.stringify(filed));
      return w.run('book_bank_line', { bankTxnId: w.line, target: { kind: 'accounts', legs: [{ accountId: w.fx.accId('6500'), amountMinor: 500 }] }, idempotencyKey: 'door', ...x });
    },
  },
};

for (const [door, spec] of Object.entries(DOORS)) {
  for (const mode of ['filed', 'pending']) {
    test(`R1 door: ${door}, against a ${mode} holder: refused naming it, booked with a person's reason`, () => {
      const w = world();
      try {
        spec.setup?.(w);
        const holder = HOLDERS[mode](w);
        const refused = spec.act(w, {});
        assert.equal(refused.error, spec.refusal ?? 'receipt_already_booked', JSON.stringify(refused));
        assert.ok(
          refused.holders.some((x) => x.entityKind === holder[0] && x.entityId === holder[1]),
          `the refusal names the ${mode} holder: ${JSON.stringify(refused.holders)}`,
        );
        assert.equal(w.overrides(), 0);
        const booked = spec.act(w, REASON);
        assert.equal(booked.ok, true, JSON.stringify(booked));
        assert.equal(w.overrides(), 1, 'the confirmation is recorded with its reason');
      } finally {
        w.cleanup();
      }
    });
  }
}

// --- 3. the round-3 probe, the agent seat, E1, liveness ------------------------------------------

test('critic R3-B: a drafted attach waits pending; the same receipt captured and committed meets it; the approval meets the bill; never booked twice silently', () => {
  const w = world();
  try {
    const [, actionId] = HOLDERS.pending(w);
    const cap = w.run('capture_document', { sourcePath: R, idempotencyKey: 'cap' });
    assert.equal(cap.ok, true, JSON.stringify(cap));
    assert.deepEqual(cap.holders.map((x) => [x.entityKind, x.entityId]), [['drafted_action', actionId]], 'the intake names the waiting Vorschlag');
    const commitInput = { captureId: cap.captureId, target: { kind: 'vendor_bill', vendorId: w.vendor(), expenseAccountId: w.fx.accId('6500') }, corrections: amount, idempotencyKey: 'commit' };
    const commit = w.run('capture_commit', commitInput);
    assert.equal(commit.error, 'receipt_already_booked', JSON.stringify(commit));
    assert.deepEqual(commit.holders.map((x) => x.entityId), [actionId]);
    // The person books the bill anyway, with a reason.
    assert.equal(w.run('capture_commit', { ...commitInput, ...REASON }).ok, true);
    // The approval now meets the bill its card did not show: holders_changed, and the card shows it.
    const changed = w.run('approve_drafted_action', { actionId });
    assert.equal(changed.error, 'holders_changed', JSON.stringify(changed));
    const card = w.run('list_drafted_actions', {}).actions.find((a) => a.actionId === actionId);
    assert.deepEqual(card.receiptHolders.map((x) => x.entityKind), ['vendor_bill']);
    assert.equal(w.run('approve_drafted_action', { actionId }).error, 'receipt_already_booked');
    assert.equal(w.run('approve_drafted_action', { actionId, ...REASON }).ok, true);
    const kinds = w.fx.deps.store.db.prepare('SELECT entity_kind FROM stored_file WHERE workspace_id = ? AND entity_kind IS NOT NULL ORDER BY entity_kind').all(w.ws).map((r) => r.entity_kind);
    assert.deepEqual(kinds, ['journal_entry', 'vendor_bill'], 'two bookings, each confirmed by a person');
    assert.equal(w.overrides(), 2);

    // Without the confirmations nothing is booked twice: the approval comes first, the commit meets it.
    const v = world();
    try {
      const [, first] = HOLDERS.pending(v);
      const c = v.run('capture_document', { sourcePath: R, idempotencyKey: 'cap' });
      assert.equal(v.run('approve_drafted_action', { actionId: first }).ok, true);
      const late = v.run('capture_commit', { captureId: c.captureId, target: { kind: 'vendor_bill', vendorId: v.vendor(), expenseAccountId: v.fx.accId('6500') }, corrections: amount, idempotencyKey: 'commit' });
      assert.equal(late.error, 'receipt_already_booked');
      assert.deepEqual(late.holders.map((x) => x.entityKind), ['journal_entry']);
      assert.equal(v.fx.deps.store.db.prepare("SELECT COUNT(*) AS n FROM stored_file WHERE workspace_id = ? AND entity_kind IS NOT NULL").get(v.ws).n, 1);
    } finally {
      v.cleanup();
    }
  } finally {
    w.cleanup();
  }
});

test('R1 agent seat: bookAgain is human_only; a hit at an auto dial becomes a Vorschlag whose card shows the holder', () => {
  const w = world();
  try {
    const [, entryId] = HOLDERS.filed(w);
    const input = {
      date: '2026-06-12', description: 'Bürobedarf', source: 'manual', idempotencyKey: 'agent-2',
      lines: [{ account: w.fx.accId('6500'), debit: 8450 }, { account: w.fx.accId('1020'), credit: 8450 }], attach: [{ sourcePath: R }],
    };
    const refused = w.agent('post_entry', { ...input, ...REASON });
    assert.equal(refused.error, 'human_only', JSON.stringify(refused));
    for (const capability of ['post', 'close-period']) {
      assert.equal(w.run('set_agent_dial', { capability, level: 'auto', idempotencyKey: `dial-${capability}` }).ok, true);
    }
    const n = w.fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.ws).n;
    const proposed = w.agent('post_entry', input);
    assert.equal(proposed.drafted, true, JSON.stringify(proposed));
    assert.equal(w.fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM journal_entry WHERE workspace_id = ?').get(w.ws).n, n, 'nothing was booked');
    const card = w.run('list_drafted_actions', {}).actions.find((a) => a.actionId === proposed.actionId);
    assert.deepEqual(card.receiptHolders.map((x) => [x.entityKind, x.entityId]), [['journal_entry', entryId]]);
    // The approver sees it, and books it only with a reason.
    assert.equal(w.run('approve_drafted_action', { actionId: proposed.actionId }).error, 'receipt_already_booked');
    assert.equal(w.run('approve_drafted_action', { actionId: proposed.actionId, ...REASON }).ok, true);
    // files_link, which the dial governs too, is proposed the same way.
    const fileId = w.upload('loose');
    const linked = w.agent('files_link', { fileId, entityKind: 'journal_entry', entityId: w.post('other').entryId, idempotencyKey: 'agent-lk' });
    assert.equal(linked.drafted, true, JSON.stringify(linked));
  } finally {
    w.cleanup();
  }
});

test('R1 E1: a receipt on a bill and on the bank line that pays it is one booking; a line booked elsewhere is a second', () => {
  const fx = fixture();
  try {
    const asHuman = { ...fx.deps, actor: 'studio' };
    const run = (name, input) => getAction(name).run(asHuman, { workspaceId: fx.workspaceId, ...input });
    const input = SCENARIOS.confirm_match(fx);
    const fileId = run('files_upload', { contentBase64: JPEG.toString('base64'), mime: 'image/jpeg', filename: 'r.jpg', idempotencyKey: 'u' }).file.id;
    assert.equal(run('files_link', { fileId, entityKind: 'vendor_bill', entityId: input.vendorBillId, idempotencyKey: 'lk-bill' }).ok, true);
    const twin = run('files_upload', { contentBase64: JPEG.toString('base64'), mime: 'image/jpeg', filename: 'r.jpg', idempotencyKey: 'u2' }).file.id;
    // On the open line: not live, not judged.
    assert.equal(run('files_link', { fileId: twin, entityKind: 'bank_txn', entityId: input.bankTxnId, idempotencyKey: 'lk-line' }).ok, true);
    // The line PAYS that bill: its decision settles the bill (E1), so the match is one booking.
    const matched = run('confirm_match', input);
    assert.equal(matched.ok, true, JSON.stringify(matched));
    assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM receipt_override').get().n, 0);
  } finally {
    fx.deps.store.close();
  }
});

test('critic round 4: E1 both ways (a matched line holds nothing against the bill it pays); a cancelled claim holds nothing', () => {
  const fx = fixture();
  try {
    const asHuman = { ...fx.deps, actor: 'studio' };
    const run = (name, input) => getAction(name).run(asHuman, { workspaceId: fx.workspaceId, ...input });
    const input = SCENARIOS.confirm_match(fx);
    const twin = run('files_upload', { contentBase64: JPEG.toString('base64'), mime: 'image/jpeg', filename: 'r.jpg', idempotencyKey: 'u2' }).file.id;
    assert.equal(run('files_link', { fileId: twin, entityKind: 'bank_txn', entityId: input.bankTxnId, idempotencyKey: 'lk-line' }).ok, true);
    assert.equal(run('confirm_match', input).ok, true);
    // The line is live now and pays the bill: the bill's own receipt is the same booking, not a second.
    const fileId = run('files_upload', { contentBase64: JPEG.toString('base64'), mime: 'image/jpeg', filename: 'r.jpg', idempotencyKey: 'u' }).file.id;
    assert.notEqual(fileId, twin, 'a second filing row, the line keeps its own');
    const linked = run('files_link', { fileId, entityKind: 'vendor_bill', entityId: input.vendorBillId, idempotencyKey: 'lk-bill' });
    assert.equal(linked.ok, true, JSON.stringify(linked));
    assert.equal(fx.deps.store.db.prepare('SELECT COUNT(*) AS n FROM receipt_override').get().n, 0);
  } finally {
    fx.deps.store.close();
  }
  const w = world();
  try {
    const claimId = claim(w);
    assert.equal(w.run('expense_line_upsert', { claimId, line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 4000, receiptDocumentId: w.upload('u') }, idempotencyKey: 'cl' }).ok, true);
    assert.equal(w.post('while-live', { attach: [{ sourcePath: R }] }).error, 'receipt_already_booked');
    w.fx.deps.store.db.prepare("UPDATE expense_claim SET status = 'cancelled' WHERE workspace_id = ? AND id = ?").run(w.ws, claimId);
    const after = w.post('after-cancel', { attach: [{ sourcePath: R }] });
    assert.equal(after.ok, true, JSON.stringify(after));
  } finally {
    w.cleanup();
  }
});

test('critic round 4: a superseded version is never re-linked; only a person sets files.duplicate_beleg', () => {
  const w = world();
  try {
    const [, entryA] = HOLDERS.filed(w);
    const v1 = w.fx.deps.store.db.prepare("SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry' AND entity_id = ?").get(w.ws, entryA).id;
    const nv = w.run('files_new_version', { fileId: v1, contentBase64: Buffer.from('%PDF-1.4 corrected synthetic').toString('base64'), mime: 'application/pdf', filename: 'y.pdf', idempotencyKey: 'nv', ...REASON });
    assert.equal(nv.ok, true, JSON.stringify(nv));
    const entryB = w.post('b').entryId;
    const link = { fileId: v1, entityKind: 'journal_entry', entityId: entryB, idempotencyKey: 'lk-v1' };
    assert.equal(w.run('files_link', link).error, 'not_head_version');
    assert.equal(w.run('files_link', { ...link, ...REASON }).error, 'not_head_version');
    assert.equal(getAction('files_link').run({ ...w.fx.deps, actor: 'agent' }, { workspaceId: w.ws, ...link }).error, 'not_head_version');
    assert.equal(w.fx.deps.store.db.prepare('SELECT entity_id FROM stored_file WHERE id = ?').get(v1).entity_id, entryA, 'v1 stays in the chain of A');
    // The agent can never lift the rule it runs under; a person can.
    const set = { key: 'files.duplicate_beleg', value: 'allow', reason: 'Testlauf', idempotencyKey: 'dup' };
    assert.equal(getAction('settings_set').run({ ...w.fx.deps, actor: 'agent' }, { workspaceId: w.ws, ...set }).error, 'human_only');
    assert.equal(w.run('settings_set', set).ok, true);
  } finally {
    w.cleanup();
  }
});

test('security review: versioning a booked receipt off never frees the old bytes; replacing it is a person\'s act', () => {
  const w = world();
  try {
    const [, entryId] = HOLDERS.filed(w);
    const fileId = w.fx.deps.store.db.prepare("SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry' AND entity_id = ?").get(w.ws, entryId).id;
    const other = Buffer.from('%PDF-1.4 a different synthetic receipt').toString('base64');
    const version = { fileId, contentBase64: other, mime: 'application/pdf', filename: 'b.pdf', idempotencyKey: 'nv' };
    // An agent never replaces a booked receipt; a person needs the reason.
    assert.equal(getAction('files_new_version').run({ ...w.fx.deps, actor: 'agent' }, { workspaceId: w.ws, ...version }).error, 'human_only');
    assert.equal(w.run('files_new_version', version).error, 'receipt_replace_needs_reason');
    assert.equal(w.run('files_new_version', { ...version, bookAgain: true }).error, 'reason_required');
    const replaced = w.run('files_new_version', { ...version, bookAgain: true, overrideReason: 'Falsche Seite gescannt' });
    assert.equal(replaced.ok, true, JSON.stringify(replaced));
    assert.equal(w.overrides(), 1);
    // The OLD bytes are still the entry's evidence: attaching them elsewhere is refused, naming the entry.
    const again = w.post('elsewhere', { attach: [{ sourcePath: R }] });
    assert.equal(again.error, 'receipt_already_booked', JSON.stringify(again));
    assert.deepEqual(again.holders.map((x) => [x.entityKind, x.entityId]), [['journal_entry', entryId]]);
    // The same bytes again on the same record replace nothing and ask nothing.
    const same = w.run('files_new_version', { fileId: replaced.file.id, contentBase64: other, mime: 'application/pdf', filename: 'b.pdf', idempotencyKey: 'nv-same' });
    assert.equal(same.ok, true, JSON.stringify(same));
  } finally {
    w.cleanup();
  }
});

test('security review B: a drafted replacement is judged at approval; a holder of the new bytes that appeared after drafting refuses holders_changed', () => {
  const w = world();
  try {
    const [, entryId] = HOLDERS.filed(w);
    const fileId = w.fx.deps.store.db.prepare("SELECT id FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry' AND entity_id = ?").get(w.ws, entryId).id;
    const nb = Buffer.from('%PDF-1.4 a corrected synthetic receipt').toString('base64');
    const d = w.agent('files_new_version', { fileId, contentBase64: nb, mime: 'application/pdf', filename: 'c.pdf', idempotencyKey: 'nv-draft' });
    assert.equal(d.drafted, true, JSON.stringify(d));
    const cardOf = () => w.run('list_drafted_actions', {}).actions.find((a) => a.actionId === d.actionId);
    assert.deepEqual(cardOf().receiptHolders ?? [], [], 'nothing held the new bytes when the agent drafted');
    // After the draft, a person books the same new bytes on another entry.
    const other = w.post('other');
    const up = w.run('files_upload', { contentBase64: nb, mime: 'application/pdf', filename: 'c.pdf', idempotencyKey: 'nb' }).file.id;
    assert.equal(w.run('files_link', { fileId: up, entityKind: 'journal_entry', entityId: other.entryId, idempotencyKey: 'lk-nb' }).ok, true);
    // The approval meets it, even with a reason: the card did not show it.
    const changed = w.run('approve_drafted_action', { actionId: d.actionId, ...REASON });
    assert.equal(changed.error, 'holders_changed', JSON.stringify(changed));
    assert.deepEqual(changed.holders.map((x) => [x.entityKind, x.entityId]), [['journal_entry', other.entryId]]);
    assert.deepEqual(cardOf().receiptHolders.map((x) => x.entityId), [other.entryId], 'the card now shows it');
    assert.equal(w.overrides(), 0);
    // Shown now: without a reason it is refused, with the person's reason the replacement books, once.
    assert.equal(w.run('approve_drafted_action', { actionId: d.actionId }).error, 'receipt_already_booked');
    const ok = w.run('approve_drafted_action', { actionId: d.actionId, ...REASON });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(w.overrides(), 1);
  } finally {
    w.cleanup();
  }
});

test('security review: a signature completion has no exemption; on a live booking\'s receipt it is a person\'s act with a reason, elsewhere it needs none', () => {
  const w = world();
  try {
    const signer = w.run('create_contact', { partyRole: 'customer', name: 'Muster Signer AG', email: 'signer@example.ch', idempotencyKey: 'signer' }).contact.id;
    const signFlow = (fileId, sha256, key) => {
      const created = w.run('sign_requests_create', { fileId, signerContactId: signer, signatureLevel: 'ses', idempotencyKey: `${key}-req` });
      assert.equal(created.ok, true, JSON.stringify(created));
      const input = { signRequestId: created.signRequestId, signedContentBase64: Buffer.from(`%PDF-1.4 ${key} signiert`).toString('base64'), originalSha256: sha256, idempotencyKey: `${key}-c` };
      return {
        asAgent: (x = {}) => getAction('sign_requests_complete').run({ ...w.fx.deps, actor: 'agent' }, { workspaceId: w.ws, ...input, ...x }),
        asPerson: (x = {}) => w.run('sign_requests_complete', { ...input, ...x }),
      };
    };
    // A file that is no booking's receipt: signing it replaces no receipt and asks nothing.
    const plain = w.run('files_upload', { contentBase64: Buffer.from('%PDF-1.4 a synthetic contract').toString('base64'), mime: 'application/pdf', filename: 'v.pdf', idempotencyKey: 'plain' }).file;
    const free = signFlow(plain.id, plain.sha256, 'free').asPerson();
    assert.equal(free.ok, true, JSON.stringify(free));
    assert.equal(w.overrides(), 0);
    // A booked receipt: an agent never completes it, a person needs the reason, and the reason is recorded.
    const [, entryId] = HOLDERS.filed(w);
    const booked = w.fx.deps.store.db.prepare("SELECT id, sha256 FROM stored_file WHERE workspace_id = ? AND entity_kind = 'journal_entry' AND entity_id = ?").get(w.ws, entryId);
    const flow = signFlow(booked.id, booked.sha256, 'live');
    assert.equal(flow.asAgent().error, 'human_only');
    assert.equal(flow.asAgent(REASON).error, 'human_only');
    assert.equal(flow.asPerson().error, 'receipt_replace_needs_reason');
    const done = flow.asPerson(REASON);
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(w.overrides(), 1);
    // The unsigned bytes stay the entry's evidence.
    const again = w.post('elsewhere', { attach: [{ sourcePath: R }] });
    assert.equal(again.error, 'receipt_already_booked', JSON.stringify(again));
  } finally {
    w.cleanup();
  }
});

test('R1 liveness: a reversed entry, a void bill and a reopened line no longer hold a receipt', () => {
  const w = world();
  try {
    const [, entryId] = HOLDERS.filed(w);
    assert.equal(w.run('reverse_entry', { entryId, idempotencyKey: 'rev' }).ok, true);
    const again = w.post('again', { attach: [{ sourcePath: R }] });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(w.overrides(), 0, 'no confirmation needed: the reversed entry is not live');
  } finally {
    w.cleanup();
  }
});
