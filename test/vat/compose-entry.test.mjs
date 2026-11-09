// The D152 amendment's engine proofs for `compose_entry` (A02 §6, A06 §4). Every workspace and figure is
// synthetic, invented for the test.
//
// PROOF 2, preview and post agree. `previewPostingLines` is the pre-write half of `postEntry` and `postEntry`
//   calls it, so the claim is structural; this suite holds it by measurement anyway, over a brute-force set
//   of random line sets (balanced and not, traced and not, stale hints, unknown, archived and 'none' codes,
//   unknown accounts, bad supply dates, a locked period, a draft to promote, a posted entry, a missing id):
//   for each, the preview's verdict and lines equal what `postEntry` then stores, or the refusal it returns,
//   code AND payload. The same is then held one level up, through `compose_entry` `expand`.
// PROOF 3, decompose then expand round-trips. Every A1 satz, every Aufteilen (the grid property's random
//   Sammelbuchungen), every agent draft (the round-2 critic's promotion-parity generator, 1'500 drafts under
//   TILL_SLOW_TESTS=1, a biting sample by default) and every straddle decomposes to intent whose expansion
//   reproduces the stored lines EXACTLY, and posting that expansion stores per-line traces EQUAL to the
//   stored ones. The shapes that cannot be decomposed (a deductible Einfuhrsteuer has no own account; legs
//   merged across lines; a coded line with no trace) say `roundTrips: false` and never guess.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { postEntry, saveDraft, getEntry, ledgerPorts, lockPeriod } from '../../dist/core/ledger/index.js';
import { previewPostingLines } from '../../dist/core/ledger/postEntry.js';
import { composeEntry } from '../../dist/core/ledger/compose.js';
import { buildVatLines, deactivateTaxCode, upsertTaxCode } from '../../dist/core/vat/index.js';
import { makeContext } from '../../dist/core/context.js';
import { setup } from './support.mjs';

const COMPOSER = pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerPayload.ts', import.meta.url))).href;
const { composeSatz, composeLines } = await import(COMPOSER);

const SLOW = process.env.TILL_SLOW_TESTS === '1';
const AGREEMENT_CASES = SLOW ? 6000 : 1200;
const PARITY_DRAFTS = SLOW ? 1500 : Number(process.env.CRITIC_PARITY_DRAFTS ?? 300);

/** A workspace whose context carries the REAL period port, so a lock is honoured. */
function world(method = 'effektiv') {
  const w = setup({ method });
  const ctx = makeContext(w.store, { workspaceId: w.workspaceId, actor: 'user_1', clock: w.clock, ids: w.ids, ...ledgerPorts({ store: w.store, workspaceId: w.workspaceId, ids: w.ids }) });
  const accounts = w.store.db
    .prepare('SELECT id, number, type, vat_code_default, cost_center_allowed FROM account WHERE workspace_id = ?')
    .all(w.workspaceId)
    .map((r) => ({ id: r.id, number: r.number, type: r.type, vatCodeDefault: r.vat_code_default, costCenterAllowed: r.cost_center_allowed === 1 }));
  const byNumber = (n) => accounts.find((a) => a.number === n).id;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  return { ...w, ctx, accounts, byNumber, accountOf: (id) => byId.get(id) };
}

function rng(seed) {
  let s = seed;
  // The HIGH bits of the LCG: its low bits cycle with a short period, so `s % n` would revisit a handful
  // of combinations and leave whole refusal classes unreached (measured: it never reached a period lock).
  const rnd = (n) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return Math.floor(s / 65536) % n;
  };
  return { rnd, pick: (xs) => xs[rnd(xs.length)] };
}

/** The rows an entry stores, one comparable string per line, in insertion order. */
function rows(w, entryId) {
  return w.store.db
    .prepare('SELECT account_id, cost_center_id, debit_minor, credit_minor, tax_code, tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? ORDER BY rowid')
    .all(entryId)
    .map((r) => JSON.stringify([r.account_id, r.cost_center_id, r.debit_minor, r.credit_minor, r.tax_code, r.tax_base_minor, r.tax_amount_minor, r.supply_date]));
}

/** A `post_entry`-shaped line as a stored row string (absent fields as the row stores them). */
function asRow(l) {
  return JSON.stringify([
    l.account,
    l.costCenter ?? null,
    l.debit ?? 0,
    l.credit ?? 0,
    l.taxCode ?? null,
    l.taxBase ?? null,
    l.taxAmount ?? null,
    l.taxCode === undefined ? null : (l.supplyDate ?? null),
  ]);
}

/** A prepared line (what `previewPostingLines` answers) as a stored row string. */
function preparedRow(l) {
  return JSON.stringify([l.account, l.costCenter, l.debit, l.credit, l.taxCode, l.taxBase === null ? null : 0 + l.taxBase, l.taxAmount === null ? null : 0 + l.taxAmount, l.taxCode === null ? null : l.supplyDate]);
}

const sameMultiset = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** A random line set: sometimes a real booking (buildVatLines), sometimes a deliberately broken one. */
function randomLines(w, r) {
  const { rnd, pick } = r;
  const codes = ['VST-M', 'VST-I', 'UST81', 'UST26', 'BEZUG', 'IMPORT', 'EXPORT0', 'AUSGENOMMEN', 'OLD', 'none', 'NOPE'];
  const out = [];
  const k = 1 + rnd(3);
  for (let i = 0; i < k; i += 1) {
    const code = pick(['VST-M', 'VST-I', 'UST81', 'UST26', 'BEZUG', 'IMPORT', 'EXPORT0', 'AUSGENOMMEN']);
    const kind = w.store.db.prepare('SELECT kind FROM tax_code WHERE workspace_id = ? AND code = ?').get(w.workspaceId, code).kind;
    const direction = ['output', 'zero', 'exempt'].includes(kind) ? 'output' : 'input';
    const lines = buildVatLines(w.ctx, {
      counterAccount: w.byNumber(pick(['1020', '1000', '1100', '2000'])),
      revenueOrExpenseAccount: w.byNumber(direction === 'output' ? pick(['3400', '3200']) : pick(['6500', '6570', '1500'])),
      amountMinor: 1 + rnd(rnd(2) === 0 ? 3000 : 5_000_000),
      amountIsGross: rnd(2) === 0,
      taxCode: code,
      direction,
      supplyDate: rnd(4) === 0 ? '2023-12-20' : null,
    }).filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
    out.push(...lines);
  }
  // Break it, one way or another, a third of the time.
  const breakage = rnd(12);
  const at = rnd(out.length);
  const line = out[at];
  if (breakage === 0) line.debit !== undefined ? (line.debit += 1) : (line.credit += 1); // unbalanced
  else if (breakage === 1 && line.taxAmount !== undefined) line.taxAmount += rnd(2) === 0 ? 1 : 50; // a stale hint
  else if (breakage === 2 && line.taxCode !== undefined) line.taxCode = pick(codes); // another code
  else if (breakage === 3) line.account = 'acc_nope'; // an unknown account
  else if (breakage === 4 && line.taxCode !== undefined) line.supplyDate = '15.06.2023'; // a malformed supply date
  else if (breakage === 5) out.splice(at, 1); // a leg dropped
  else if (breakage === 6 && line.taxCode !== undefined) delete line.taxAmount; // a trace without its tax
  return out;
}

test('PROOF 2: previewPostingLines and postEntry agree, line for line and refusal for refusal', () => {
  const w = world();
  // An archived code, a locked month, a draft to promote, a posted entry and a missing one.
  assert.equal(upsertTaxCode(w.ctx, { code: 'OLD', kind: 'input', rateBp: 0, formLine: '400', label: 'Alt' }).ok, true);
  assert.equal(deactivateTaxCode(w.ctx, { code: 'OLD' }).ok, true);
  assert.equal(lockPeriod(w.ctx, { period: '2026-02', kind: 'soft', idempotencyKey: 'lock-feb' }).ok, true);
  const posted = postEntry(w.ctx, { date: '2026-03-02', source: 'manual', idempotencyKey: 'posted', lines: [{ account: w.byNumber('6500'), debit: 100 }, { account: w.byNumber('1020'), credit: 100 }] });
  assert.equal(posted.ok, true);

  const r = rng(152);
  const tally = new Map();
  const failures = [];
  for (let i = 0; i < AGREEMENT_CASES && failures.length < 10; i += 1) {
    const lines = randomLines(w, r);
    const date = r.pick(['2026-03-02', '2026-03-02', '2026-02-15', '2024-01-10']);
    const target = r.rnd(10);
    let entryId;
    if (target === 0) entryId = saveDraft(w.ctx, { date, lines: [{ account: w.byNumber('6500') }], idempotencyKey: `draft-${i}` }).entryId;
    else if (target === 1) entryId = posted.entryId;
    else if (target === 2) entryId = 'entry_nope';
    const input = { date, source: 'manual', lines, ...(entryId !== undefined ? { entryId } : {}) };
    const preview = previewPostingLines(w.ctx, structuredClone(input));
    const before = w.store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n;
    const preview2 = previewPostingLines(w.ctx, structuredClone(input));
    assert.equal(w.store.db.prepare('SELECT COUNT(*) AS n FROM journal_line').get().n, before, 'a preview writes nothing');
    assert.deepEqual(preview2, preview, 'a preview is deterministic');
    const result = postEntry(w.ctx, { ...structuredClone(input), idempotencyKey: `agree-${i}` });
    const label = preview.ok ? 'ok' : preview.error.error;
    tally.set(label, (tally.get(label) ?? 0) + 1);
    if (preview.ok) {
      if (!result.ok) failures.push(`case ${i}: preview ok, post refused ${JSON.stringify(result)}`);
      else if (JSON.stringify(rows(w, result.entryId)) !== JSON.stringify(preview.lines.map(preparedRow))) {
        failures.push(`case ${i}: stored ${JSON.stringify(rows(w, result.entryId))} != previewed ${JSON.stringify(preview.lines.map(preparedRow))}`);
      }
    } else if (JSON.stringify(result) !== JSON.stringify(preview.error)) {
      failures.push(`case ${i}: preview refused ${JSON.stringify(preview.error)}, post answered ${JSON.stringify(result)}`);
    }
  }
  assert.deepEqual(failures, []);
  // The set is a brute force over refusals too, not only over successes: each class was actually reached.
  for (const code of ['ok', 'unbalanced', 'vat_trace_unreconciled', 'unknown_tax_code', 'archived_tax_code', 'invalid_account', 'invalid_line', 'period_locked', 'already_posted', 'not_found']) {
    assert.ok((tally.get(code) ?? 0) > 0, `the brute force never reached ${code}: ${JSON.stringify([...tally])}`);
  }
});

test('PROOF 2, one level up: compose_entry expand answers what post_entry then stores, or the refusal it returns', () => {
  const w = world();
  assert.equal(lockPeriod(w.ctx, { period: '2026-02', kind: 'soft', idempotencyKey: 'lock-feb' }).ok, true);
  const r = rng(2026);
  const pool = [
    ['VST-M', '6500', 'debit'], ['VST-M', '6500', 'credit'], ['VST-I', '1500', 'debit'], ['UST81', '3400', 'credit'],
    ['UST81', '3400', 'debit'], ['UST26', '3200', 'credit'], ['BEZUG', '6500', 'debit'], ['BEZUG', '6500', 'credit'],
    ['IMPORT', '6500', 'debit'], ['EXPORT0', '3400', 'credit'], ['AUSGENOMMEN', '3400', 'credit'], ['NOPE', '6500', 'debit'],
  ];
  const tally = new Map();
  const failures = [];
  for (let i = 0; i < AGREEMENT_CASES / 2 && failures.length < 10; i += 1) {
    const intents = [];
    let signed = 0;
    for (let k = 1 + r.rnd(3); k > 0; k -= 1) {
      const [code, acc, side] = r.pick(pool);
      const amount = 1 + r.rnd(r.rnd(2) === 0 ? 3000 : 5_000_000);
      intents.push({ account: w.byNumber(acc), side, amount, gross: r.rnd(5) !== 0, taxCode: code, ...(r.rnd(4) === 0 ? { supplyDate: '2023-12-20' } : {}) });
      signed += side === 'debit' ? amount : -amount;
    }
    // A counter that closes the GROSS on most cases; a net intent (gross:false) or a deliberate miss leaves
    // it open, and the engine must say unbalanced exactly as the post would.
    const miss = r.rnd(6) === 0 ? 1 : 0;
    if (signed + miss !== 0) intents.push({ account: w.byNumber('1020'), side: signed + miss > 0 ? 'credit' : 'debit', amount: Math.abs(signed + miss), gross: true });
    const date = r.pick(['2026-03-02', '2026-03-02', '2026-02-15', '2024-01-10']);
    const answer = composeEntry(w.ctx, { mode: 'expand', date, lines: intents });
    assert.equal(answer.ok, true, JSON.stringify(answer));
    const label = answer.verdict.ok ? 'ok' : answer.verdict.error;
    tally.set(label, (tally.get(label) ?? 0) + 1);
    if (!answer.composed) {
      if (answer.lines.length !== 0) failures.push(`case ${i}: not composed, yet ${answer.lines.length} lines`);
      continue;
    }
    const result = postEntry(w.ctx, { date, source: 'manual', idempotencyKey: `up-${i}`, lines: structuredClone(answer.lines) });
    if (answer.verdict.ok) {
      if (!result.ok) failures.push(`case ${i}: compose ok, post refused ${JSON.stringify(result)}`);
      else if (JSON.stringify(rows(w, result.entryId)) !== JSON.stringify(answer.lines.map(asRow))) failures.push(`case ${i}: stored ${JSON.stringify(rows(w, result.entryId))} != answered ${JSON.stringify(answer.lines)}`);
    } else {
      const { line: _line, ...verdict } = answer.verdict;
      if (JSON.stringify(result) !== JSON.stringify(verdict)) failures.push(`case ${i}: compose refused ${JSON.stringify(answer.verdict)}, post answered ${JSON.stringify(result)}`);
    }
  }
  assert.deepEqual(failures, []);
  for (const code of ['ok', 'unbalanced', 'period_locked', 'unknown_tax_code']) assert.ok((tally.get(code) ?? 0) > 0, `never reached ${code}: ${JSON.stringify([...tally])}`);
});

test('the period-locked answer still carries the stamped lines (a draft saved then keeps the gate\'s trace)', () => {
  const w = world();
  assert.equal(lockPeriod(w.ctx, { period: '2026-02', kind: 'soft', idempotencyKey: 'lock' }).ok, true);
  const answer = composeEntry(w.ctx, {
    mode: 'expand',
    date: '2026-02-15',
    lines: [
      { account: w.byNumber('3400'), side: 'debit', amount: 10810, gross: true, taxCode: 'UST81' },
      { account: w.byNumber('1100'), side: 'credit', amount: 10810, gross: true },
    ],
  });
  assert.equal(answer.verdict.error, 'period_locked');
  assert.equal(answer.stamped, true);
  // The mirrored revenue reduction, stamped NEGATED by the gate exactly as the post would store it.
  assert.deepEqual(answer.lines[0], { account: w.byNumber('3400'), debit: 10000, taxCode: 'UST81', taxBase: -10000, taxAmount: -810 });
});

/** A draft's stored lines in the `post_entry` shape, exactly as `decompose` reads them back. */
function storedAsLines(w, entryId) {
  return getEntry(w.ctx, { entryId }).lines.map((l) => {
    const out = { account: l.account };
    if (l.debit > 0) out.debit = l.debit;
    if (l.credit > 0) out.credit = l.credit;
    for (const k of ['costCenter', 'taxCode', 'taxBase', 'taxAmount', 'supplyDate']) if (l[k] !== null) out[k] = l[k];
    return out;
  });
}

/** Decompose a stored draft, expand its intent, promote that expansion: the round trip, measured. */
function roundTrip(w, entryId, date, key) {
  const d = composeEntry(w.ctx, { mode: 'decompose', entryId });
  assert.equal(d.ok, true, JSON.stringify(d));
  const stored = storedAsLines(w, entryId);
  assert.ok(sameMultiset(d.lines.map(asRow), stored.map(asRow)), 'decompose reads the stored lines verbatim');
  const again = composeEntry(w.ctx, { mode: 'expand', date, entryId, lines: d.intent });
  const problems = [];
  if (!d.roundTrips) problems.push(`roundTrips false for ${JSON.stringify(stored)}: intent ${JSON.stringify(d.intent)}`);
  else if (!sameMultiset(again.lines.map(asRow), stored.map(asRow))) problems.push(`expand(intent) ${JSON.stringify(again.lines)} != stored ${JSON.stringify(stored)}`);
  else if (again.verdict.ok) {
    const promoted = postEntry(w.ctx, { entryId, date, source: 'manual', idempotencyKey: key, lines: again.lines });
    if (!promoted.ok) problems.push(`promotion refused ${JSON.stringify(promoted)}`);
    else if (!sameMultiset(rows(w, entryId), stored.map(asRow))) problems.push(`posted traces ${JSON.stringify(rows(w, entryId))} != stored ${JSON.stringify(stored)}`);
  }
  return { d, problems };
}

test('PROOF 3: every A1 satz, both methods, both eras, both sides, decomposes and round-trips; posted traces EQUAL stored', () => {
  const CASES = [
    ['VST-M', '6500', '1020'], ['VST-M', '1020', '6500'], ['VST-I', '1500', '1020'], ['VST-I', '1020', '1500'],
    ['UST81', '1100', '3400'], ['UST81', '3400', '1100'], ['UST26', '1100', '3200'], ['UST38', '1100', '3400'],
    ['EXPORT0', '1100', '3400'], ['AUSGENOMMEN', '3400', '1100'], ['BEZUG', '6500', '1020'], ['BEZUG', '1020', '6500'], ['', '6500', '1020'],
  ];
  const failures = [];
  let n = 0;
  for (const method of ['effektiv', 'saldo']) {
    const w = world(method);
    for (const date of ['2026-03-02', '2023-06-30']) {
      for (const [code, soll, haben] of CASES) {
        for (const gross of [1, 5, 99, 100, 107, 1081, 10770, 123457, 9999995]) {
          n += 1;
          const composed = composeSatz({ soll: w.byNumber(soll), haben: w.byNumber(haben), amountMinor: gross, taxCode: code, costCenter: '' }, w.accountOf);
          const built = composeEntry(w.ctx, { mode: 'expand', date, lines: composeLines(composed, true, date) });
          assert.deepEqual(built.verdict, { ok: true }, `${method} ${date} ${code} ${soll} an ${haben} @${gross}`);
          const draft = saveDraft(w.ctx, { date, lines: built.lines, idempotencyKey: `a1-${n}` });
          const { d, problems } = roundTrip(w, draft.entryId, date, `a1p-${n}`);
          if (problems.length > 0) failures.push(`${method} ${date} ${code} ${soll} an ${haben} @${gross}: ${problems.join('; ')}`);
          // The intent IS the satz: one taxed intent line at the typed amount, the counter at the same amount.
          else if (!(d.intent.length === 2 && d.intent.every((l) => l.amount === gross))) failures.push(`${code} @${gross}: intent ${JSON.stringify(d.intent)}`);
          if (failures.length > 10) break;
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('PROOF 3: Aufteilen (random derived Sammelbuchungen) decompose and round-trip, and a same-era date move (R3a) still posts', () => {
  const w = world();
  const r = rng(4242);
  const pool = [
    ['VST-M', '6500', 'debit'], ['VST-M', '6500', 'credit'], ['VST-I', '1500', 'debit'], ['UST81', '3400', 'credit'],
    ['UST81', '3400', 'debit'], ['UST26', '3200', 'credit'], ['BEZUG', '6500', 'debit'], ['EXPORT0', '3400', 'credit'],
  ];
  const failures = [];
  for (let iter = 0; iter < (SLOW ? 3000 : 400) && failures.length < 10; iter += 1) {
    const composed = [];
    let signed = 0;
    for (let k = 1 + r.rnd(4); k > 0; k -= 1) {
      const [code, acc, side] = r.pick(pool);
      const amount = 1 + r.rnd(r.rnd(2) === 0 ? 5000 : 50_000_000);
      composed.push({ accountId: w.byNumber(acc), side, amountMinor: amount, taxCode: code, costCenter: '' });
      signed += side === 'debit' ? amount : -amount;
    }
    if (signed === 0) continue;
    composed.push({ accountId: w.byNumber(r.pick(['1020', '1000', '2000'])), side: signed > 0 ? 'credit' : 'debit', amountMinor: Math.abs(signed), taxCode: '', costCenter: '' });
    const built = composeEntry(w.ctx, { mode: 'expand', date: '2026-09-30', lines: composeLines(composed, true, '2026-09-30') });
    if (!built.verdict.ok) {
      failures.push(`iter ${iter}: ${JSON.stringify(built.verdict)}`);
      continue;
    }
    const draft = saveDraft(w.ctx, { date: '2026-09-30', lines: built.lines, idempotencyKey: `auf-${iter}` });
    const { d, problems } = roundTrip(w, draft.entryId, '2026-09-30', `aufp-${iter}`);
    if (problems.length > 0) failures.push(`iter ${iter}: ${problems.join('; ')}`);
    // R3a on every other one: a copy of the draft, its date moved one day within the era, posts from its intent.
    if (iter % 2 === 0 && d.roundTrips) {
      const copy = saveDraft(w.ctx, { date: '2026-09-30', lines: built.lines, idempotencyKey: `aufc-${iter}` });
      const moved = d.intent.map((l) => (l.supplyDate === '2026-09-30' ? { ...l, supplyDate: '2026-10-01' } : l));
      const answer = composeEntry(w.ctx, { mode: 'expand', date: '2026-10-01', entryId: copy.entryId, lines: moved });
      const posted = answer.verdict.ok ? postEntry(w.ctx, { entryId: copy.entryId, date: '2026-10-01', source: 'manual', idempotencyKey: `aufm-${iter}`, lines: answer.lines }) : answer.verdict;
      if (!posted.ok) failures.push(`iter ${iter}: the date move refused ${JSON.stringify(posted)}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('PROOF 3: the round-2 critic generator (agent drafts, straddles included) decomposes and round-trips', () => {
  const w = world();
  const pool = [
    ['VST-M', '6500', 'input'], ['VST-I', '1520', 'input'], ['UST81', '3400', 'output'], ['UST26', '3200', 'output'],
    ['BEZUG', '6500', 'input'], ['IMPORT', '6500', 'input'], ['EXPORT0', '3400', 'output'], ['AUSGENOMMEN', '3400', 'output'],
  ];
  const counters = ['1020', '1000', '1100', '2000'];
  let s = 977;
  const rnd = (n) => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s % n;
  };
  const failures = [];
  const tally = { roundTrips: 0, verbatim: 0 };
  for (let iter = 0; iter < PARITY_DRAFTS && failures.length < 10; iter += 1) {
    const straddle = rnd(2) === 0;
    const date = straddle ? '2024-01-10' : '2026-03-02';
    const supplyDate = straddle ? '2023-12-20' : null;
    const lines = [];
    let hasImport = false;
    const k = 1 + rnd(3);
    for (let i = 0; i < k; i += 1) {
      const [code, acc, direction] = pool[rnd(pool.length)];
      if (code === 'IMPORT') hasImport = true;
      lines.push(
        ...buildVatLines(w.ctx, {
          counterAccount: w.byNumber(counters[rnd(counters.length)]),
          revenueOrExpenseAccount: w.byNumber(acc),
          amountMinor: 1 + rnd(rnd(2) === 0 ? 5000 : 10_000_000),
          amountIsGross: rnd(2) === 0,
          taxCode: code,
          direction,
          supplyDate,
        }).filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0),
      );
    }
    const d = saveDraft(w.ctx, { date, lines, idempotencyKey: `d-${iter}` });
    assert.equal(d.ok, true);
    const { d: dec, problems } = roundTrip(w, d.entryId, date, `p-${iter}`);
    if (hasImport) {
      // A deductible Einfuhrsteuer books its 1170 line and nothing on an own account, so there is no intent
      // to recover it as: the engine says so (verbatim), it never invents an expense account.
      if (dec.roundTrips) failures.push(`iter ${iter}: a deductible import claimed to round-trip`);
      tally.verbatim += 1;
      continue;
    }
    tally.roundTrips += 1;
    if (problems.length > 0) failures.push(`iter ${iter}: ${problems.join('; ')}`);
  }
  assert.deepEqual(failures, []);
  assert.ok(tally.roundTrips > PARITY_DRAFTS / 2, JSON.stringify(tally));
});

test('decompose never guesses: merged legs, a code without a trace, a stranded tag and an import base stay verbatim', () => {
  const w = world();
  const id = (n) => w.byNumber(n);
  const shapes = {
    'legs merged across two lines': [
      { account: id('6500'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: 7 },
      { account: id('6570'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: 7 },
      { account: id('1170'), debit: 14 },
      { account: id('1020'), credit: 200 },
    ],
    'a coded line with no trace': [
      { account: id('6500'), debit: 9963, taxCode: 'VST-M' },
      { account: id('1170'), debit: 807 },
      { account: id('1020'), credit: 10770 },
    ],
    'a coded line with no leg (an agent two-liner)': [
      { account: id('1100'), debit: 10000 },
      { account: id('3400'), credit: 10000, taxCode: 'UST81' },
    ],
    'a stranded input tag on the 1170 line itself': [
      { account: id('6500'), debit: 9963 },
      { account: id('1170'), debit: 807, taxCode: 'VST-M', taxBase: 807, taxAmount: 65 },
      { account: id('1020'), credit: 10770 },
    ],
    'a deductible import on 1170': [
      { account: id('1170'), debit: 4321, taxCode: 'IMPORT', taxBase: 0, taxAmount: 4321 },
      { account: id('1020'), credit: 4321 },
    ],
  };
  for (const [name, lines] of Object.entries(shapes)) {
    const d = composeEntry(w.ctx, { mode: 'decompose', date: '2026-03-02', lines });
    assert.equal(d.ok, true);
    assert.equal(d.roundTrips, false, name);
    assert.ok(sameMultiset(d.lines.map(asRow), lines.map(asRow)), `${name}: the stored lines come back verbatim`);
  }
  // A coded line with no trace pairs by its NET reading, and is stated as the gross it books (107.70) because
  // that gross expands to the very same lines; it still does not round-trip, because no trace was stored.
  const untraced = composeEntry(w.ctx, { mode: 'decompose', date: '2026-03-02', lines: shapes['a coded line with no trace'] });
  assert.equal(untraced.paired, true);
  assert.equal(untraced.roundTrips, false);
  assert.deepEqual(untraced.intent[0], { account: id('6500'), side: 'debit', amount: 10770, gross: true, taxCode: 'VST-M' });
  // Pairing is exact on the leg: the gross 100 (0.07) and 101 (0.08) both net 0.93, and only the leg the
  // draft actually books decides which one it was.
  for (const [gross, tax] of [[100, 7], [101, 8]]) {
    const d = composeEntry(w.ctx, {
      mode: 'decompose',
      date: '2026-03-02',
      lines: [
        { account: id('6500'), debit: 93, taxCode: 'VST-M', taxBase: 93, taxAmount: tax, supplyDate: '2026-03-02' },
        { account: id('1170'), debit: tax },
        { account: id('1020'), credit: gross },
      ],
    });
    assert.equal(d.roundTrips, true, `gross ${gross}`);
    assert.equal(d.intent[0].amount, gross);
  }
});

test('decompose is §H-TENANT scoped: another workspace\'s entry id is not_found, and a read writes nothing', () => {
  const a = world();
  const b = setup({ store: a.store, ids: a.ids });
  const bLines = [
    { account: a.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '6500'").get(b.workspaceId).id, debit: 100 },
    { account: a.store.db.prepare("SELECT id FROM account WHERE workspace_id = ? AND number = '1020'").get(b.workspaceId).id, credit: 100 },
  ];
  const theirs = saveDraft(b.ctx, { date: '2026-03-02', lines: bLines, idempotencyKey: 'b-draft' });
  assert.equal(theirs.ok, true);
  const changes = a.store.db.prepare('SELECT total_changes() AS n').get().n;
  const d = composeEntry(a.ctx, { mode: 'decompose', entryId: theirs.entryId });
  assert.equal(d.ok, false);
  assert.equal(d.error, 'not_found');
  // Their lines named by id in an expand are invalid accounts HERE, exactly as post_entry would say.
  const e = composeEntry(a.ctx, { mode: 'expand', date: '2026-03-02', lines: bLines });
  assert.equal(e.verdict.error, 'invalid_account');
  assert.equal(a.store.db.prepare('SELECT total_changes() AS n').get().n, changes, 'compose_entry wrote nothing');
});

test('compose_entry refuses a malformed request as the read\'s own invalid_input', () => {
  const w = world();
  const bad = [
    { mode: 'sideways' },
    { mode: 'expand', date: '2026-02-30', lines: [] },
    { mode: 'expand', date: '2026-03-02', lines: 'x' },
    { mode: 'expand', date: '2026-03-02', lines: [{ account: w.byNumber('6500'), side: 'up', amount: 1, gross: true }] },
    { mode: 'expand', date: '2026-03-02', lines: [{ account: w.byNumber('6500'), side: 'debit', amount: 1.5, gross: true }] },
    { mode: 'expand', date: '2026-03-02', lines: [{ account: w.byNumber('6500'), side: 'debit', amount: 100, gross: true, debit: 100 }] },
    { mode: 'decompose' },
  ];
  for (const input of bad) {
    const r = composeEntry(w.ctx, input);
    assert.equal(r.ok, false, JSON.stringify(input));
    assert.equal(r.error, 'invalid_input', JSON.stringify(input));
  }
});

// Critic R4 L2: `roundTrips` compares as a multiset, so an untouched reopen expanded in the expansion's own
// order (a Bezugsteuer's legs after its base, the counter last) would repost the draft's lines reordered.
// When the answer IS the draft being promoted, it comes back in the draft's stored order.
test('an untouched reopen answers, and posts, the draft\'s lines in their STORED order; an edited one in the expansion\'s', async () => {
  const { reopenState, composerRequest, BLANK_SATZ } = await import(
    pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href
  );
  const w = world();
  const id = (n) => w.byNumber(n);
  // An agent's Bezugsteuer draft in buildVatLines' order: base, counter, 2200, 1170.
  const lines = buildVatLines(w.ctx, { counterAccount: id('1020'), revenueOrExpenseAccount: id('6500'), amountMinor: 100000, amountIsGross: false, taxCode: 'BEZUG', direction: 'input' });
  const draft = saveDraft(w.ctx, { date: '2026-03-02', lines, idempotencyKey: 'l2-draft' });
  const stored = getEntry(w.ctx, { entryId: draft.entryId }).lines;
  const d = composeEntry(w.ctx, { mode: 'decompose', date: '2026-03-02', lines: stored });
  assert.equal(d.roundTrips, true);
  const state = reopenState(d, w.accountOf);
  const request = composerRequest({ face: state.face, satz: state.face === 'satz' ? state.satz : BLANK_SATZ, lines: state.lines, manualLock: state.manualLock }, w.accountOf, '2026-03-02');
  const order = (ls) => ls.map((l) => `${l.account}:${l.debit ?? 0}:${l.credit ?? 0}`);
  // Without the draft named, the expansion's own order: the counter last.
  const loose = composeEntry(w.ctx, { mode: 'expand', date: '2026-03-02', lines: request.lines });
  assert.notDeepEqual(order(loose.lines), order(stored), 'fixture: the expansion order differs from the stored one');
  // Naming the draft being promoted, the stored order.
  const answer = composeEntry(w.ctx, { mode: 'expand', date: '2026-03-02', entryId: draft.entryId, lines: request.lines });
  assert.deepEqual(order(answer.lines), order(stored));
  const posted = postEntry(w.ctx, { entryId: draft.entryId, date: '2026-03-02', source: 'manual', idempotencyKey: 'l2-post', lines: answer.lines });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.deepEqual(order(getEntry(w.ctx, { entryId: draft.entryId }).lines), order(stored), 'the promoted rows keep the stored order');
  // Edited (another amount), it is not the draft any more: the expansion's order stands.
  const other = saveDraft(w.ctx, { date: '2026-03-02', lines, idempotencyKey: 'l2-draft-2' });
  const edited = request.lines.map((l) => ('amount' in l ? { ...l, amount: 120000 } : l));
  const editedAnswer = composeEntry(w.ctx, { mode: 'expand', date: '2026-03-02', entryId: other.entryId, lines: edited });
  assert.deepEqual(order(editedAnswer.lines).map((s) => s.split(':')[0]), order(loose.lines).map((s) => s.split(':')[0]));
});

// Critic R4 L1: the captions name the rate, the deductibility (the method) and the ESTV form line, which
// `vat_preview` gates on `read_vat`. `compose_entry` requires ALL OF `read_books` and `read_vat`, so a
// custom role holding the books but not the VAT is refused at the boundary, naming the one it lacks.
test('compose_entry needs read_books AND read_vat: a role with the books but not the VAT is refused', async () => {
  const { freshDeps, mintWorkspace } = await import('../api/support.mjs');
  const { getAction } = await import('../../dist/api/registry.js');
  const deps = freshDeps();
  deps.actor = 'studio';
  const { workspaceId, accId } = mintWorkspace(deps, 'Zugriff GmbH', 'l1-ws');
  const run = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  const roleOf = (capabilities, key) => {
    const r = run('define_role', { name: `L1 ${key}`, capabilities, idempotencyKey: `l1-role-${key}` });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r.roleId;
  };
  const booksOnly = roleOf(['read_books'], 'books');
  const booksAndVat = roleOf(['read_books', 'read_vat'], 'both');
  const invited = run('invite_member', { email: 'l1@muster.ch', role: booksOnly, idempotencyKey: 'l1-invite' });
  assert.equal(invited.ok, true, JSON.stringify(invited));
  const seat = run('list_members', {}).members.find((m) => m.actorId === 'agent');
  assert.ok(seat, 'the agent is seated');
  const asAgent = (role) => {
    deps.actor = 'studio';
    assert.equal(run('set_role', { memberId: seat.memberId, role }).ok, true);
    deps.actor = 'agent';
    return run('compose_entry', {
      mode: 'expand',
      date: '2026-03-02',
      lines: [
        { account: accId('6500'), side: 'debit', amount: 100, gross: true },
        { account: accId('1020'), side: 'credit', amount: 100, gross: true },
      ],
    });
  };
  const refused = asAgent(booksOnly);
  assert.equal(refused.ok, false, JSON.stringify(refused));
  assert.equal(refused.error, 'permission_denied');
  assert.match(JSON.stringify(refused), /read_vat/);
  const allowed = asAgent(booksAndVat);
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
  assert.deepEqual(allowed.verdict, { ok: true });
});

// Owner, 02.10.2026: KEEP THE STORED LEISTUNGSDATUM. Swiss MWST takes the rate from the supply date, not the
// booking date. A fresh, unsaved satz prices at the date typed; once saved, a taxed line keeps its stored
// Leistungsdatum, and so its rate and its Ziffer, when the booking date moves, the period-lock way out
// included. VST-M is Ziffer 400 in both eras (only the rate moves), so the Ziffer half is proven on UST81 too,
// whose 7.7% family is 302 and whose 8.1% family is 303.
for (const c of [
  { code: 'VST-M', soll: '6500', haben: '1020', net: 10000, tax: 770, ziffer: '400' },
  { code: 'UST81', soll: '1100', haben: '3400', net: 10000, tax: 770, ziffer: '302' },
]) {
  test(`a saved December 2023 ${c.code} draft moved to 10.01.2024 past a locked December posts with its Leistungsdatum, its 7.7% and its Ziffer ${c.ziffer}`, async () => {
    const { reopenState, composerRequest, BLANK_SATZ } = await import(
      pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href
    );
    const w = world();
    const satz = { ...BLANK_SATZ, soll: w.byNumber(c.soll), haben: w.byNumber(c.haben), amount: '107.70', taxCode: c.code };
    const ask = (state, date, entryId) => {
      const request = composerRequest({ face: state.face, satz: state.face === 'satz' ? state.satz : BLANK_SATZ, lines: state.lines, manualLock: state.manualLock }, w.accountOf, date);
      return composeEntry(w.ctx, { mode: 'expand', date, ...(entryId !== undefined ? { entryId } : {}), lines: request.lines });
    };
    // Typed on 15.12.2023 and saved as a draft, exactly as the composer saves it.
    const typed = ask({ face: 'satz', satz, lines: [], manualLock: false }, '2023-12-15');
    assert.deepEqual(typed.verdict, { ok: true });
    const draft = saveDraft(w.ctx, { date: '2023-12-15', lines: typed.lines, idempotencyKey: `ld-${c.code}` });
    assert.equal(draft.ok, true, JSON.stringify(draft));
    assert.equal(lockPeriod(w.ctx, { period: '2023-12', kind: 'soft', idempotencyKey: `ld-lock-${c.code}` }).ok, true);
    // Reopened: the satz keeps the stored Leistungsdatum, also though it equals the entry date.
    const stored = getEntry(w.ctx, { entryId: draft.entryId }).lines;
    const d = composeEntry(w.ctx, { mode: 'decompose', date: '2023-12-15', lines: stored });
    const state = reopenState(d, w.accountOf);
    assert.equal(state.face, 'satz');
    assert.equal(state.satz.supplyDate, '2023-12-15');
    // On its own date the lock refuses, and names the way out's period.
    const refused = ask(state, '2023-12-15', draft.entryId);
    assert.equal(refused.verdict.error, 'period_locked');
    assert.equal(refused.verdict.period, '2023-12');
    // Moved to 10.01.2024 and posted: the supply date, the rate and the Ziffer are the stored line's.
    const moved = ask(state, '2024-01-10', draft.entryId);
    assert.deepEqual(moved.verdict, { ok: true });
    const caption = moved.captions.find((x) => x !== null && x.ok);
    assert.equal(caption.rateBp, 770);
    assert.equal(caption.formLine, c.ziffer);
    const posted = postEntry(w.ctx, { entryId: draft.entryId, date: '2024-01-10', source: 'manual', idempotencyKey: `ld-post-${c.code}`, lines: moved.lines });
    assert.equal(posted.ok, true, JSON.stringify(posted));
    const row = w.store.db
      .prepare('SELECT tax_base_minor, tax_amount_minor, supply_date FROM journal_line WHERE entry_id = ? AND tax_code = ?')
      .get(draft.entryId, c.code);
    assert.deepEqual(row, { tax_base_minor: c.net, tax_amount_minor: c.tax, supply_date: '2023-12-15' });
    assert.equal(getEntry(w.ctx, { entryId: draft.entryId }).entry.date, '2024-01-10');
  });
}

test('an UNSAVED satz whose date moves from 15.12.2023 to 10.01.2024 before saving is priced at 8.1% on the date typed', async () => {
  const { composerRequest, BLANK_SATZ } = await import(
    pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href
  );
  const w = world();
  const satz = { ...BLANK_SATZ, soll: w.byNumber('6500'), haben: w.byNumber('1020'), amount: '107.70', taxCode: 'VST-M' };
  const ask = (date) => {
    const request = composerRequest({ face: 'satz', satz, lines: [], manualLock: false }, w.accountOf, date);
    return composeEntry(w.ctx, { mode: 'expand', date, lines: request.lines });
  };
  assert.equal(ask('2023-12-15').captions.find((x) => x !== null && x.ok).rateBp, 770, 'fixture: the 7.7% era first');
  const moved = ask('2024-01-10');
  assert.deepEqual(moved.verdict, { ok: true });
  assert.equal(moved.captions.find((x) => x !== null && x.ok).rateBp, 810);
  assert.deepEqual(moved.lines[0], { account: w.byNumber('6500'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: '2024-01-10' });
});

// Critic R5 L-a (coordinator's decision within the owner's rule): correcting a saved taxed line's ACCOUNT does
// not move the supply, so its kept Leistungsdatum stays while the line carries a code. Critic R6-S1 (one rule):
// whenever the line is left with NO code, by "Ohne MWST" or by an account that carries none, it lets go of it.
test('a saved December 2023 line moved into 2024 and corrected from 6500 to 6570 still posts at 7.7% on 15.12.2023; no code at all lets the date go', async () => {
  const { reopenState, composerRequest, withSatzAccount, withTaxCode, BLANK_SATZ } = await import(
    pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href
  );
  const w = world();
  const offered = [{ code: 'VST-M' }];
  // 6570 carries VST-M as its default here, so the corrected line keeps a code; 1000 Kasse carries none.
  const accountOf = (id) => (id === w.byNumber('6570') ? { ...w.accountOf(id), vatCodeDefault: 'VST-M' } : w.accountOf(id));
  const ask = (satz, date, entryId) => {
    const request = composerRequest({ face: 'satz', satz, lines: [], manualLock: false }, accountOf, date);
    return composeEntry(w.ctx, { mode: 'expand', date, ...(entryId !== undefined ? { entryId } : {}), lines: request.lines });
  };
  const typed = ask({ ...BLANK_SATZ, soll: w.byNumber('6500'), haben: w.byNumber('1020'), amount: '107.70', taxCode: 'VST-M' }, '2023-12-15');
  const draft = saveDraft(w.ctx, { date: '2023-12-15', lines: typed.lines, idempotencyKey: 'la-draft' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const stored = getEntry(w.ctx, { entryId: draft.entryId }).lines;
  const state = reopenState(composeEntry(w.ctx, { mode: 'decompose', date: '2023-12-15', lines: stored }), accountOf);
  assert.equal(state.face, 'satz');
  // The account is corrected; the new account brings VST-M, so the line is still taxed and keeps its date.
  const corrected = withSatzAccount(state.satz, 'soll', w.byNumber('6570'), accountOf, offered);
  assert.equal(corrected.taxCode, 'VST-M');
  assert.equal(corrected.supplyDate, '2023-12-15');
  const moved = ask(corrected, '2024-01-10', draft.entryId);
  assert.deepEqual(moved.verdict, { ok: true });
  assert.deepEqual(moved.lines.find((l) => l.taxCode === 'VST-M'), { account: w.byNumber('6570'), debit: 10000, taxCode: 'VST-M', taxBase: 10000, taxAmount: 770, supplyDate: '2023-12-15' });
  const posted = postEntry(w.ctx, { entryId: draft.entryId, date: '2024-01-10', source: 'manual', idempotencyKey: 'la-post', lines: moved.lines });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  // No code, then a code again: the line is untaxed in between, so the code chosen after is a new fact and
  // follows the booking date. "Ohne MWST" and an account that carries no code are the same act (R6-S1).
  const viaOhne = { ...corrected, ...withTaxCode('') };
  const viaAccount = withSatzAccount(withSatzAccount(corrected, 'soll', w.byNumber('1000'), accountOf, offered), 'soll', w.byNumber('6570'), accountOf, offered);
  assert.equal(viaOhne.supplyDate, '');
  assert.equal(viaAccount.supplyDate, '');
  const retaxed = (satz) => ask({ ...satz, ...withTaxCode('VST-M') }, '2024-01-10').lines.find((l) => l.taxCode === 'VST-M');
  const at2024 = { account: w.byNumber('6570'), debit: 9963, taxCode: 'VST-M', taxBase: 9963, taxAmount: 807, supplyDate: '2024-01-10' };
  assert.deepEqual(retaxed(viaOhne), at2024);
  assert.deepEqual(retaxed(viaAccount), at2024);
});

// Critic R6-V: the verbatim path carries the implied Leistungsdatum. A coded line with no trace reopens
// VERBATIM; when it stated no supply date its stored entry date priced it. Moved across the 2024 era where
// the tax coincides (1.63 at 7.7% and at 8.1% both round to 0.13), the gate takes it either way, so without
// the date it posted with a NULL supply date and A07 filed it on 303.
test('a verbatim Vorschlag that stated no supply date, moved into 2024, states its stored date and A07 files it on 302', async () => {
  const { reopenState, composerRequest, BLANK_SATZ } = await import(
    pathToFileURL(fileURLToPath(new URL('../../app/src/surfaces/Journal/composerModel.ts', import.meta.url))).href
  );
  const { computeVatReturn } = await import('../../dist/core/vat/index.js');
  const w = world();
  const lines = [
    { account: w.byNumber('1100'), debit: 176 },
    { account: w.byNumber('3400'), credit: 163, taxCode: 'UST81' },
    { account: w.byNumber('2200'), credit: 13 },
  ];
  const draft = saveDraft(w.ctx, { date: '2023-12-15', lines, idempotencyKey: 'r6v-draft' });
  assert.equal(draft.ok, true, JSON.stringify(draft));
  const stored = getEntry(w.ctx, { entryId: draft.entryId }).lines;
  const d = composeEntry(w.ctx, { mode: 'decompose', date: '2023-12-15', lines: stored });
  const state = reopenState(d, w.accountOf);
  assert.equal(state.manualLock, true, 'fixture: a verbatim reopen');
  const req = (at) => composerRequest({ face: state.face, satz: BLANK_SATZ, lines: state.lines, manualLock: true }, w.accountOf, at).lines;
  // Unmoved: byte-verbatim, no supply date written.
  assert.deepEqual(req('2023-12-15'), d.lines);
  // Moved into 2024: the stored line plus its implied Leistungsdatum, nothing else.
  const movedReq = req('2024-01-01');
  assert.deepEqual(movedReq, d.lines.map((l) => (l.taxCode === 'UST81' ? { ...l, supplyDate: '2023-12-15' } : l)));
  const answer = composeEntry(w.ctx, { mode: 'expand', date: '2024-01-01', entryId: draft.entryId, lines: movedReq });
  assert.deepEqual(answer.verdict, { ok: true });
  const posted = postEntry(w.ctx, { entryId: draft.entryId, date: '2024-01-01', source: 'manual', idempotencyKey: 'r6v-post', lines: answer.lines });
  assert.equal(posted.ok, true, JSON.stringify(posted));
  assert.equal(w.store.db.prepare("SELECT supply_date FROM journal_line WHERE entry_id = ? AND tax_code = 'UST81'").get(draft.entryId).supply_date, '2023-12-15');
  const r = computeVatReturn(w.ctx, { periodStart: '2024-01-01', periodEnd: '2024-03-31' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(
    { z302: r.lines.find((l) => l.code === '302')?.taxMinor ?? null, z303: r.lines.find((l) => l.code === '303')?.taxMinor ?? null },
    { z302: 13, z303: null },
  );
});
