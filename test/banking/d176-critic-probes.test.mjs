// D176 non-author critic probes, round 1 (critic/d176-2026-10-15, reviewed tip 091a6881). Synthetic data only:
// invented names, invented amounts, the published sample IBANs of bank-inbox-support.mjs. A test marked
// [FINDING ...] failed on the reviewed tip by design; a test marked [PROBE] passed and records a property the
// critic attacked and found to hold.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import {
  listBankInbox,
  bookBankLine,
  ignoreBankLine,
  setBankStandard,
  listBankStandards,
  createBankAccount,
} from "../../dist/core/banking/index.js";
import { getAction } from "../../dist/api/registry.js";
import {
  createAccount,
  archiveAccount,
} from "../../dist/core/accounts/accounts.js";
import { SqliteStore } from "../../dist/core/store/sqlite-store.js";
import { SCHEMA_GENERATION } from "../../dist/core/store/schema.js";
import { makeContext } from "../../dist/core/context.js";
import { enqueueDraftedAction } from "../../dist/core/agent/index.js";
import {
  world,
  secondWorkspace,
  importLines,
  must,
  refused,
  legs as entryLegs,
  rowCounts,
  excuseClaimInvariant,
  assertClaimInvariantHolds,
  TELCO_IBAN,
  SAVINGS_IBAN,
} from "./bank-inbox-support.mjs";

afterEach(assertClaimInvariantHolds);

const PAYOUT = "Zahlwerk Beispiel Ltd";
const DATE = "2026-07-31";
const lineOf = (t, id) =>
  must(listBankInbox(t.ctx, { status: "all" }), "inbox").lines.find(
    (l) => l.bankTxnId === id,
  );
const call = (t, name, input) =>
  getAction(name).run(t.deps, { workspaceId: t.workspaceId, ...input });
const standardRows = (t) =>
  t.store.db
    .prepare(
      "SELECT * FROM bank_standard WHERE workspace_id = ? ORDER BY rowid",
    )
    .all(t.workspaceId);

function vWorld(opts) {
  const t = world(opts);
  must(
    createAccount(t.ctx, {
      number: "1095",
      name: "Erlös Durchlaufkonto",
      type: "asset",
      idempotencyKey: "acc-1095",
    }),
    "1095",
  );
  return t;
}

function monthRecipe(t) {
  return [
    {
      accountId: t.acc("1095"),
      taxCode: null,
      side: "debit",
      amount: { kind: "ask", label: "Bruttoumsatz" },
    },
    {
      accountId: t.acc("3400"),
      taxCode: "UST81",
      side: "credit",
      amount: { kind: "same", legIndex: 0 },
    },
    {
      accountId: t.acc("4400"),
      taxCode: null,
      side: "debit",
      amount: { kind: "ask", label: "Coach-Anteil" },
    },
    {
      accountId: t.acc("1095"),
      taxCode: null,
      side: "credit",
      amount: { kind: "rest" },
    },
  ];
}
const monthVorlage = (t, key = "v-month", label = "Monatsumsatz") =>
  must(
    setBankStandard(t.ctx, {
      scope: "manual",
      label,
      legs: monthRecipe(t),
      idempotencyKey: key,
    }),
    "Vorlage",
  ).standard;
const postTemplate = (t, template, key, extra = {}) =>
  call(t, "post_entry", {
    date: DATE,
    source: "manual",
    template,
    idempotencyKey: key,
    ...extra,
  });

// ================================================================================================
// 1. A Vorlage never books a bank ledger, a control or a VAT account (D139), also AFTER it was saved
// ================================================================================================

test("[FINDING D176-C1] a Vorlage whose leg account later becomes a Bankkonto ledger still posts to that bank ledger", () => {
  const t = vWorld();
  must(
    createAccount(t.ctx, {
      number: "1025",
      name: "Sparkonto Beispiel",
      type: "asset",
      idempotencyKey: "acc-1025",
    }),
  );
  const v = must(
    setBankStandard(t.ctx, {
      scope: "manual",
      label: "Umbuchung Sparkonto",
      legs: [
        {
          accountId: t.acc("1025"),
          taxCode: null,
          side: "debit",
          amount: { kind: "ask", label: "Betrag" },
        },
        {
          accountId: t.acc("2800"),
          taxCode: null,
          side: "credit",
          amount: { kind: "rest" },
        },
      ],
      idempotencyKey: "c1-v",
    }),
  ).standard;
  // Saved while 1025 was an ordinary asset account. Then 1025 becomes a Bankkonto's ledger.
  must(
    createBankAccount(t.ctx, {
      name: "Sparkonto",
      iban: SAVINGS_IBAN,
      currency: "CHF",
      ledgerAccountId: t.acc("1025"),
      idempotencyKey: "c1-bank",
    }),
  );
  const listed = must(
    listBankStandards(t.ctx, { scope: "manual" }),
  ).standards.find((s) => s.id === v.id);
  assert.notEqual(
    listed.invalidReason,
    null,
    "the list already says the Vorlage went invalid",
  );
  const posted = postTemplate(
    t,
    { standardId: v.id, asks: { 0: 50000 } },
    "c1-post",
  );
  assert.equal(
    posted.ok,
    false,
    `a Vorlage booked a bank ledger (D139): ${JSON.stringify(posted).slice(0, 200)}`,
  );
});

test("[FINDING D176-C1b] a Vorlage whose leg account was archived after saving: the composer still answers it, the list calls it invalid", () => {
  const t = vWorld();
  const v = must(
    setBankStandard(t.ctx, {
      scope: "manual",
      label: "Abgrenzung Beispiel",
      legs: [
        {
          accountId: t.acc("6570"),
          taxCode: null,
          side: "debit",
          amount: { kind: "ask", label: "Betrag" },
        },
        {
          accountId: t.acc("2800"),
          taxCode: null,
          side: "credit",
          amount: { kind: "rest" },
        },
      ],
      idempotencyKey: "c1b-v",
    }),
  ).standard;
  must(archiveAccount(t.ctx, { accountId: t.acc("6570") }));
  // For comparison: typed lines to the archived account.
  const typed = call(t, "post_entry", {
    date: DATE,
    source: "manual",
    lines: [
      { account: t.acc("6570"), debit: 1000 },
      { account: t.acc("2800"), credit: 1000 },
    ],
    idempotencyKey: "c1b-typed",
  });
  console.log("typed lines to an archived account:", JSON.stringify(typed));
  const listed = must(
    listBankStandards(t.ctx, { scope: "manual" }),
  ).standards.find((s) => s.id === v.id);
  assert.notEqual(listed.invalidReason, null);
  const posted = postTemplate(
    t,
    { standardId: v.id, asks: { 0: 1000 } },
    "c1b-post",
  );
  assert.equal(
    posted.ok,
    false,
    `an invalid Vorlage posted: ${JSON.stringify(posted).slice(0, 200)}`,
  );
});

test("[PROBE] a Vorlage refuses a bank ledger, a control and a VAT account at save time, also through an edit", () => {
  const t = vWorld();
  const v = monthVorlage(t);
  for (const number of ["1020", "1100", "2000", "2200", "1170"]) {
    const legs = [
      {
        accountId: t.acc(number),
        taxCode: null,
        side: "debit",
        amount: { kind: "ask", label: "X" },
      },
      {
        accountId: t.acc("3200"),
        taxCode: null,
        side: "credit",
        amount: { kind: "rest" },
      },
    ];
    refused(
      setBankStandard(t.ctx, {
        scope: "manual",
        label: `Probe ${number}`,
        legs,
        idempotencyKey: `p-${number}`,
      }),
      "invalid_recipe",
      number,
    );
    refused(
      setBankStandard(t.ctx, {
        scope: "manual",
        standardId: v.id,
        label: "Monatsumsatz",
        legs,
        idempotencyKey: `pe-${number}`,
      }),
      "invalid_recipe",
      `edit ${number}`,
    );
  }
});

// ================================================================================================
// 2. Keying: a rename onto another Vorlage's name, an edit that moves slots
// ================================================================================================

test("[FINDING D176-C2] renaming Vorlage A to the name of Vorlage B silently supersedes B (and repoints B's follow-ups to A's legs)", () => {
  const t = vWorld();
  const l = importLines(t, {
    statementId: "BS-R",
    entries: [
      {
        ref: "P1",
        amountMinor: 3000,
        cd: "CRDT",
        name: PAYOUT,
        ustrd: "KURS 1",
      },
    ],
  }).lines;
  const a = monthVorlage(t, "r-a", "Monatsumsatz");
  const b = must(
    setBankStandard(t.ctx, {
      scope: "manual",
      label: "Lohn",
      legs: [
        {
          accountId: t.acc("5000"),
          taxCode: null,
          side: "debit",
          amount: { kind: "ask", label: "Brutto" },
        },
        {
          accountId: t.acc("2800"),
          taxCode: null,
          side: "credit",
          amount: { kind: "rest" },
        },
      ],
      idempotencyKey: "r-b",
    }),
  ).standard;
  const rule = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.P1,
      accountId: t.acc("1095"),
      taxCode: null,
      followUpStandardId: b.id,
      idempotencyKey: "r-rule",
    }),
  ).standard;
  assert.equal(rule.followUpLabel, "Lohn");
  const renamed = setBankStandard(t.ctx, {
    scope: "manual",
    standardId: a.id,
    label: "Lohn",
    legs: monthRecipe(t),
    idempotencyKey: "r-rename",
  });
  // What happens: both A and B are superseded, the new row holds B's name with A's legs.
  const live = standardRows(t).filter(
    (r) => r.superseded_at === null && r.scope === "manual",
  );
  assert.equal(
    renamed.ok === false || live.some((r) => r.id === b.id),
    true,
    `B ("Lohn") was replaced by A's legs without being named: ${JSON.stringify(live.map((r) => [r.id, r.label]))}`,
  );
});

test("[PROBE] an edit by standardId cannot move a bank rule to another counterparty or direction, and a Vorlage key never meets a line key", () => {
  const t = vWorld();
  const l = importLines(t, {
    statementId: "BS-K",
    entries: [
      {
        ref: "TEL",
        amountMinor: 8650,
        cd: "DBIT",
        iban: TELCO_IBAN,
        name: "Fernmelde Ostschweiz AG",
      },
      { ref: "V", amountMinor: 100, cd: "DBIT", name: "vorlage: Monatsumsatz" },
    ],
  }).lines;
  const r = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.TEL,
      accountId: t.acc("6500"),
      taxCode: null,
      idempotencyKey: "k-1",
    }),
  ).standard;
  // An edit carrying a bankTxnId of another counterparty is refused (exactly one of the two).
  refused(
    setBankStandard(t.ctx, {
      standardId: r.id,
      bankTxnId: l.V,
      accountId: t.acc("6500"),
      taxCode: null,
      idempotencyKey: "k-2",
    }),
    "invalid_input",
  );
  const e = must(
    setBankStandard(t.ctx, {
      standardId: r.id,
      accountId: t.acc("6570"),
      taxCode: null,
      idempotencyKey: "k-3",
    }),
  ).standard;
  assert.deepEqual(
    [e.counterpartyKey, e.direction],
    [r.counterpartyKey, r.direction],
  );
  // A payer literally named "vorlage: Monatsumsatz" keys as name:..., never as the Vorlage slot.
  const v = monthVorlage(t);
  const s = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.V,
      accountId: t.acc("6500"),
      taxCode: null,
      idempotencyKey: "k-4",
    }),
  ).standard;
  assert.ok(s.counterpartyKey.startsWith("name:"), s.counterpartyKey);
  assert.equal(
    standardRows(t).find((x) => x.id === v.id).superseded_at,
    null,
    "the Vorlage is untouched",
  );
});

test("[PROBE] labels that differ only in case, punctuation or an umlaut spelling are one Vorlage; different words are two", () => {
  const t = vWorld();
  const a = monthVorlage(t, "u-1", "Gebühren Müller");
  const b = must(
    setBankStandard(t.ctx, {
      scope: "manual",
      // The bank's two-letter spelling of both umlauts, assembled so the transliteration guard reads no prose.
      label: ["gebu", "ehren, MU", "ELLER!"].join(""),
      legs: monthRecipe(t),
      // Critic D176-C2's fix: a save onto a taken name replaces it only when the caller says so.
      replaceStandardId: a.id,
      idempotencyKey: "u-2",
    }),
  );
  assert.equal(b.supersededId, a.id);
  const c = monthVorlage(t, "u-3", "Gebühren Müller 2");
  assert.equal(
    standardRows(t).filter((r) => r.superseded_at === null).length,
    2,
  );
  assert.notEqual(c.id, b.standard.id);
});

// ================================================================================================
// 3. The ignore outcome: the placeholder account, tenant binding on standardId
// ================================================================================================

test('[FINDING D176-C3] an EDIT from legs to "Nicht buchen" stores the rest leg\'s expense account as the placeholder, not the Bankkonto ledger (§15.6)', () => {
  const t = vWorld();
  const l = importLines(t, {
    statementId: "BS-I",
    entries: [
      {
        ref: "TEL",
        amountMinor: 8650,
        cd: "DBIT",
        iban: TELCO_IBAN,
        name: "Fernmelde Ostschweiz AG",
      },
    ],
  }).lines;
  const r = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.TEL,
      accountId: t.acc("6500"),
      taxCode: null,
      idempotencyKey: "i-1",
    }),
  ).standard;
  const ig = must(
    setBankStandard(t.ctx, {
      standardId: r.id,
      outcome: "ignore",
      ignoreReason: "booked_elsewhere",
      idempotencyKey: "i-2",
    }),
  ).standard;
  assert.equal(ig.accountId, null, "the API answers null");
  const row = standardRows(t).find((x) => x.id === ig.id);
  assert.equal(
    row.account_id,
    t.bankId,
    `§15.6: the placeholder is the Bankkonto ledger; stored ${row.account_id === t.acc("6500") ? "6500 (the old rest account)" : row.account_id}`,
  );
});

test("[PROBE] ignore_bank_line standardId: another workspace's rule is rule_not_found, writes nothing", () => {
  const t = vWorld();
  const b = secondWorkspace(t);
  const l = importLines(t, {
    statementId: "BS-T",
    entries: [
      {
        ref: "TEL",
        amountMinor: 8650,
        cd: "DBIT",
        iban: TELCO_IBAN,
        name: "Fernmelde Ostschweiz AG",
      },
    ],
  }).lines;
  const own = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.TEL,
      outcome: "ignore",
      ignoreReason: "other",
      idempotencyKey: "t-1",
    }),
  ).standard;
  const before = rowCounts(t.store, b.workspaceId);
  refused(
    ignoreBankLine(b.ctx, {
      bankTxnId: l.TEL,
      reason: "other",
      standardId: own.id,
      idempotencyKey: "t-2",
    }),
    "not_found",
  );
  assert.deepEqual(rowCounts(t.store, b.workspaceId), before);
  // Typed wrong: a number, an empty string.
  refused(
    ignoreBankLine(t.ctx, {
      bankTxnId: l.TEL,
      reason: "other",
      standardId: 7,
      idempotencyKey: "t-3",
    }),
    "invalid_input",
  );
  refused(
    ignoreBankLine(t.ctx, {
      bankTxnId: l.TEL,
      reason: "other",
      standardId: "",
      idempotencyKey: "t-4",
    }),
    "invalid_input",
  );
});

// ================================================================================================
// 4. The Studio's rule target for a complete rule with a next step: byte-identical to the accounts form
// ================================================================================================

for (const shape of ["plain", "taxed+described", "via"]) {
  test(`[PROBE] a complete rule booked as {kind: rule} posts exactly what its proposed accounts target posts (${shape})`, () => {
    const t = vWorld();
    const l = importLines(t, {
      statementId: "BS-B",
      entries: [
        {
          ref: "A",
          amountMinor: 8650,
          cd: "DBIT",
          iban: TELCO_IBAN,
          name: "Fernmelde Ostschweiz AG",
          ustrd: "RECHNUNG 1",
        },
        {
          ref: "B",
          amountMinor: 8650,
          cd: "DBIT",
          iban: TELCO_IBAN,
          name: "Fernmelde Ostschweiz AG",
          ustrd: "RECHNUNG 1",
        },
      ],
    }).lines;
    const v = monthVorlage(t);
    const leg = {
      accountId: t.acc("6500"),
      taxCode: shape === "plain" ? null : "VST-M",
      amount: { kind: "rest" },
      ...(shape === "taxed+described" ? { description: "Telefon Juli" } : {}),
    };
    const rule = must(
      setBankStandard(t.ctx, {
        bankTxnId: l.A,
        label: "Telefon",
        legs: [leg],
        ...(shape === "via" ? { viaAccountId: t.acc("1095") } : {}),
        followUpStandardId: v.id,
        idempotencyKey: "b-rule",
      }),
    ).standard;
    const proposal = lineOf(t, l.A).proposal;
    assert.equal(proposal.reasonCode, "standard");
    const a = must(
      bookBankLine(t.ctx, {
        bankTxnId: l.A,
        target: proposal.target,
        idempotencyKey: "b-a",
      }),
    );
    const b = must(
      bookBankLine(t.ctx, {
        bankTxnId: l.B,
        target: { kind: "rule", standardId: rule.id, asks: {} },
        idempotencyKey: "b-b",
      }),
    );
    const shapeOf = (entryId) => {
      const e = t.store.db
        .prepare(
          "SELECT date, description, source, status, ref FROM journal_entry WHERE id = ?",
        )
        .get(entryId);
      const lines = t.store.db
        .prepare(
          "SELECT account_id, debit_minor, credit_minor, tax_code, tax_base_minor, tax_amount_minor, cost_center_id, supply_date FROM journal_line WHERE entry_id = ? ORDER BY rowid",
        )
        .all(entryId);
      return { e, lines };
    };
    assert.deepEqual(shapeOf(b.entryId), shapeOf(a.entryId));
    assert.equal(
      lineOf(t, l.A).followUp,
      null,
      "the accounts form records no rule",
    );
    assert.deepEqual(lineOf(t, l.B).followUp, {
      standardId: v.id,
      label: "Monatsumsatz",
    });
  });
}

// ================================================================================================
// 5. Pins (D162): a governed seat's post_entry { template } and ignore_bank_line { standardId }
// ================================================================================================

const agentCtx = (t) =>
  makeContext(t.store, {
    workspaceId: t.workspaceId,
    actor: "agent",
    clock: t.deps.clock,
    ids: t.deps.ids,
  });
const approve = (t, actionId) =>
  getAction("approve_drafted_action").run(
    { ...t.deps, actor: "studio" },
    { workspaceId: t.workspaceId, actionId },
  );

for (const change of [
  "vorlage_edited",
  "same_leg_code_rate",
  "rest_leg_account_archived",
  "none",
]) {
  test(`[PROBE] pin: an agent drafts post_entry { template }, then ${change}: approval ${change === "none" ? "posts" : "refuses vorschlag_stale"}`, () => {
    excuseClaimInvariant();
    const t = vWorld();
    const v = monthVorlage(t);
    const payload = {
      workspaceId: t.workspaceId,
      date: DATE,
      source: "manual",
      template: { standardId: v.id, asks: { 0: 21620, 2: 18620 } },
      idempotencyKey: `pin-${change}`,
    };
    const drafted = enqueueDraftedAction(agentCtx(t), {
      actionTool: "post_entry",
      payload,
    });
    assert.equal(drafted.ok, true, JSON.stringify(drafted));
    if (change === "vorlage_edited") {
      must(
        setBankStandard(t.ctx, {
          scope: "manual",
          standardId: v.id,
          label: "Monatsumsatz",
          legs: monthRecipe(t).map((x, i) =>
            i === 2 ? { ...x, accountId: t.acc("6570") } : x,
          ),
          idempotencyKey: "pin-edit",
        }),
      );
    } else if (change === "same_leg_code_rate") {
      assert.ok(
        t.store.db
          .prepare(
            "UPDATE tax_code SET rate_bp = rate_bp + 100 WHERE workspace_id = ? AND code = 'UST81'",
          )
          .run(t.workspaceId).changes >= 1,
      );
    } else if (change === "rest_leg_account_archived") {
      // An asked leg's account is archived after the agent proposed the post.
      must(archiveAccount(t.ctx, { accountId: t.acc("4400") }));
    }
    const before = rowCounts(t.store, t.workspaceId);
    const decided = approve(t, drafted.actionId);
    if (change === "none") {
      assert.notEqual(decided.ok, false, JSON.stringify(decided).slice(0, 300));
      assert.equal(
        rowCounts(t.store, t.workspaceId).entries - before.entries,
        1,
      );
    } else {
      assert.equal(
        decided.error,
        "vorschlag_stale",
        `${change}: ${JSON.stringify(decided).slice(0, 300)}`,
      );
      assert.equal(rowCounts(t.store, t.workspaceId).entries, before.entries);
    }
  });
}

test("[PROBE] pin: an agent drafts ignore_bank_line { standardId }, the rule is edited: approval refuses vorschlag_stale", () => {
  excuseClaimInvariant();
  const t = vWorld();
  const l = importLines(t, {
    statementId: "BS-P",
    entries: [
      {
        ref: "TEL",
        amountMinor: 8650,
        cd: "DBIT",
        iban: TELCO_IBAN,
        name: "Fernmelde Ostschweiz AG",
      },
    ],
  }).lines;
  const r = must(
    setBankStandard(t.ctx, {
      bankTxnId: l.TEL,
      outcome: "ignore",
      ignoreReason: "booked_elsewhere",
      idempotencyKey: "pi-1",
    }),
  ).standard;
  const drafted = enqueueDraftedAction(agentCtx(t), {
    actionTool: "ignore_bank_line",
    payload: {
      workspaceId: t.workspaceId,
      bankTxnId: l.TEL,
      reason: "booked_elsewhere",
      standardId: r.id,
      idempotencyKey: "pi-2",
    },
  });
  assert.equal(drafted.ok, true, JSON.stringify(drafted));
  must(
    setBankStandard(t.ctx, {
      standardId: r.id,
      outcome: "ignore",
      ignoreReason: "duplicate",
      idempotencyKey: "pi-3",
    }),
  );
  const decided = approve(t, drafted.actionId);
  assert.equal(
    decided.error,
    "vorschlag_stale",
    JSON.stringify(decided).slice(0, 300),
  );
  assert.equal(lineOf(t, l.TEL).state, "open");
});

// ================================================================================================
// 6. Templates: a taxed rest leg; post_entry gates (period lock) as for typed lines
// ================================================================================================

test("[PROBE] a taxed REST leg balances: 1095 D asked gross, 3400 C UST81 the rest (gross)", () => {
  const t = vWorld();
  const v = must(
    setBankStandard(t.ctx, {
      scope: "manual",
      label: "Umsatz brutto",
      legs: [
        {
          accountId: t.acc("1095"),
          taxCode: null,
          side: "debit",
          amount: { kind: "ask", label: "Brutto" },
        },
        {
          accountId: t.acc("3400"),
          taxCode: "UST81",
          side: "credit",
          amount: { kind: "rest" },
        },
      ],
      idempotencyKey: "tr-1",
    }),
  ).standard;
  const posted = must(
    postTemplate(t, { standardId: v.id, asks: { 0: 21620 } }, "tr-2"),
  );
  assert.deepEqual(
    entryLegs(t.store, posted.entryId).map((x) => [
      x.number,
      x.debit,
      x.credit,
    ]),
    [
      ["1095", 21620, 0],
      ["2200", 0, 1620],
      ["3400", 0, 20000],
    ],
  );
});

test("[PROBE] post_entry { template } is refused by a period lock exactly as typed lines are", () => {
  const t = vWorld();
  const v = monthVorlage(t);
  must(
    call(t, "lock_period", {
      period: "2026-07",
      kind: "soft",
      idempotencyKey: "pl-1",
    }),
    "lock",
  );
  const before = rowCounts(t.store, t.workspaceId);
  const typed = call(t, "post_entry", {
    date: DATE,
    source: "manual",
    lines: [
      { account: t.acc("1095"), debit: 100 },
      { account: t.acc("4400"), credit: 100 },
    ],
    idempotencyKey: "pl-typed",
  });
  const viaTemplate = postTemplate(
    t,
    { standardId: v.id, asks: { 0: 21620, 2: 18620 } },
    "pl-tpl",
  );
  assert.equal(typed.ok, false);
  assert.equal(viaTemplate.ok, false);
  assert.equal(viaTemplate.error, typed.error);
  assert.deepEqual(rowCounts(t.store, t.workspaceId), before);
});

// ================================================================================================
// 7. Generation 16 on a generation-11 book (the shape of the owner's live book)
// ================================================================================================

test("[PROBE] generation 16 opens a generation-11 book: every row of every table unchanged, the D176 columns and triggers arrive, a Vorlage then works", () => {
  excuseClaimInvariant();
  const dir = mkdtempSync(join(tmpdir(), "d176-critic-gen11-"));
  const file = join(dir, "book.db");
  try {
    const t = vWorld({ location: file });
    const l = importLines(t, {
      statementId: "G11",
      entries: [
        {
          ref: "TEL",
          amountMinor: 8650,
          cd: "DBIT",
          iban: TELCO_IBAN,
          name: "Fernmelde Ostschweiz AG",
        },
      ],
    }).lines;
    must(
      setBankStandard(t.ctx, {
        bankTxnId: l.TEL,
        accountId: t.acc("6500"),
        taxCode: "VST-M",
        idempotencyKey: "g1",
      }),
    );
    must(
      bookBankLine(t.ctx, {
        bankTxnId: l.TEL,
        target: {
          kind: "accounts",
          legs: [
            { accountId: t.acc("6500"), amountMinor: 8650, taxCode: "VST-M" },
          ],
        },
        idempotencyKey: "g2",
      }),
    );
    const workspaceId = t.workspaceId;
    const acc = {
      a1095: t.acc("1095"),
      a3400: t.acc("3400"),
      a4400: t.acc("4400"),
    };
    t.store.close();

    // Back to a generation-11 shape: no D176, no D175, no wage run kind, no settings tables.
    const raw = new Database(file);
    raw.exec("DROP TRIGGER IF EXISTS bank_standard_outcome_frozen");
    for (const col of [
      "scope",
      "outcome",
      "ignore_reason",
      "ignore_note",
      "follow_up_standard_id",
    ])
      raw.exec(`ALTER TABLE bank_standard DROP COLUMN ${col}`);
    raw.exec("DROP INDEX IF EXISTS bank_standard_one_live_rule");
    raw.exec("DROP TRIGGER IF EXISTS bank_standard_recipe_frozen");
    raw.exec("DROP TRIGGER IF EXISTS bank_line_decision_rule_frozen");
    raw.exec("ALTER TABLE bank_line_decision DROP COLUMN rule_id");
    for (const col of ["label", "match_text", "legs_json", "via_account_id"])
      raw.exec(`ALTER TABLE bank_standard DROP COLUMN ${col}`);
    raw.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS bank_standard_one_live ON bank_standard (workspace_id, counterparty_key, direction) WHERE superseded_at IS NULL",
    );
    raw.exec("ALTER TABLE wage_journal_posts DROP COLUMN run_kind");
    raw.exec("DROP TABLE IF EXISTS workspace_setting_change");
    raw.exec("DROP TABLE IF EXISTS workspace_setting");
    raw.pragma("user_version = 11");
    const tables = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    const snapshot = Object.fromEntries(
      tables.map((n) => [
        n,
        raw.prepare(`SELECT * FROM "${n}" ORDER BY rowid`).all(),
      ]),
    );
    raw.close();

    const store = new SqliteStore({ location: file });
    const db = store.db;
    // The book reaches exactly this build's generation (16 when D176 landed; D178 added 17 and 18).
    assert.equal(db.pragma("user_version", { simple: true }), SCHEMA_GENERATION);
    for (const n of tables) {
      const addedBy = {
        bank_standard: [
          "scope",
          "outcome",
          "ignore_reason",
          "ignore_note",
          "follow_up_standard_id",
          "label",
          "match_text",
          "legs_json",
          "via_account_id",
        ],
        bank_line_decision: ["rule_id"],
        wage_journal_posts: ["run_kind"],
      };
      const added = new Set(addedBy[n] ?? []);
      const now = db
        .prepare(`SELECT * FROM "${n}" ORDER BY rowid`)
        .all()
        .map((r) =>
          Object.fromEntries(Object.entries(r).filter(([k]) => !added.has(k))),
        );
      assert.deepEqual(now, snapshot[n], `table ${n} unchanged`);
    }
    for (const trig of [
      "bank_standard_outcome_frozen",
      "bank_standard_recipe_frozen",
      "bank_standard_supersede_only",
      "bank_standard_no_delete",
    ]) {
      assert.ok(
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?",
          )
          .get(trig),
        trig,
      );
    }
    const rows = db.prepare("SELECT scope, outcome FROM bank_standard").all();
    assert.ok(rows.every((r) => r.scope === "bank" && r.outcome === "legs"));
    const ctx = makeContext(store, {
      workspaceId,
      actor: "user_1",
      clock: t.ctx.clock,
      ids: t.ctx.ids,
    });
    const v = must(
      setBankStandard(ctx, {
        scope: "manual",
        label: "Monatsumsatz",
        legs: [
          {
            accountId: acc.a1095,
            taxCode: null,
            side: "debit",
            amount: { kind: "ask", label: "Brutto" },
          },
          {
            accountId: acc.a3400,
            taxCode: "UST81",
            side: "credit",
            amount: { kind: "same", legIndex: 0 },
          },
          {
            accountId: acc.a4400,
            taxCode: null,
            side: "debit",
            amount: { kind: "ask", label: "Coach" },
          },
          {
            accountId: acc.a1095,
            taxCode: null,
            side: "credit",
            amount: { kind: "rest" },
          },
        ],
        idempotencyKey: "g3",
      }),
    ).standard;
    // With the supersession stamp in the same UPDATE, so only the D176 trigger can refuse it.
    for (const set of ["outcome = 'ignore'", "scope = 'bank'"]) {
      assert.throws(
        () =>
          db
            .prepare(
              `UPDATE bank_standard SET superseded_at = '2026-07-31T00:00:00.000Z', superseded_by = 'u', ${set} WHERE id = ?`,
            )
            .run(v.id),
        /only the supersession stamp/,
        set,
      );
    }
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ================================================================================================
// 8. The author's [INVARIANT append-only] test does not bite on the trigger it names
// ================================================================================================

test("[PROBE D176-C4] the D176 columns stay frozen when an UPDATE also writes the supersession stamp (the only update the older triggers let through)", () => {
  // The author's test updates a D176 column alone, which `bank_standard_supersede_only` already refuses
  // (NEW.superseded_at IS NULL), so it passes with `bank_standard_outcome_frozen` disabled. This one only
  // passes while that trigger exists: the stamp plus a changed column is what the third trigger is for.
  const t = vWorld();
  const v = monthVorlage(t);
  for (const [column, value] of [
    ["scope", "bank"],
    ["outcome", "ignore"],
    ["ignore_reason", "duplicate"],
    ["ignore_note", "x"],
    ["follow_up_standard_id", v.id],
  ]) {
    assert.throws(
      () =>
        t.store.db
          .prepare(
            `UPDATE bank_standard SET superseded_at = '2026-07-31T00:00:00.000Z', superseded_by = 'u', ${column} = ? WHERE id = ?`,
          )
          .run(value, v.id),
      /only the supersession stamp/,
      column,
    );
  }
});

test("[PROBE] an edit by standardId replays: the same key answers the stored result and adds no row", () => {
  const t = vWorld();
  const v = monthVorlage(t);
  const input = {
    scope: "manual",
    standardId: v.id,
    label: "Monatsumsatz",
    legs: monthRecipe(t).map((x, i) =>
      i === 2 ? { ...x, accountId: t.acc("6570") } : x,
    ),
    idempotencyKey: "er-1",
  };
  const first = must(setBankStandard(t.ctx, input));
  const rows = standardRows(t);
  assert.deepEqual(setBankStandard(t.ctx, input), first);
  assert.deepEqual(standardRows(t), rows);
});
