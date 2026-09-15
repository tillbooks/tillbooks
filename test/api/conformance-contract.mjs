/**
 * The MCP conformance CONTRACT (D14.2): the data the standing gate runs on.
 *
 * `conformance.test.mjs` holds the RULES and drives them off the registry, so a verb appended to
 * `ACTIONS` next month is held to every rule without anyone editing the harness. This file holds the
 * two things a rule cannot derive on its own:
 *
 *   1. `SCENARIOS`, one valid call per WRITE verb, because "call this verb twice and prove the
 *      ledger moved once" needs a genuinely valid input and no machine can invent one. A write verb
 *      with no scenario here makes the gate FAIL: that is the whole point, because it is the one
 *      moment a human is forced to say how the new verb is exercised.
 *   2. `IDEMPOTENCY_KEY_EXEMPT`, the only escape hatch in the gate. It is an explicit per-verb list
 *      with a written reason, so an exemption is a conscious edit in a reviewed diff and never a
 *      silent skip.
 *
 * Everything here runs offline against a fresh in-memory store.
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getAction } from '../../dist/api/registry.js';
import { buildQrrReference } from '../../dist/core/payments/reference.js';
import { registerRuntime } from '../../dist/core/voice/index.js';
import { freshDeps, mintWorkspace, manualPost, recordingRelay } from './support.mjs';
import { makeMaildirStore, rfc822 } from '../mail/fixtures.mjs';
import { stubAdapter, stubManifest, outboundCorpus } from '../voice/fixtures.mjs';

/** A real BAZG "Devisenkurse (Verkauf)" payload, captured verbatim. See `test/fx/bazg-feed.test.mjs`. */
const BAZG_DAILY_PAYLOAD = readFileSync(
  new URL('../fx/fixtures/bazg-xmldaily-20260724.xml', import.meta.url),
  'utf8',
);

/**
 * A fresh, deterministic world for ONE scenario: its own in-memory store, its own workspace, and a
 * `call` helper that dispatches through the registry with `workspaceId` already bound. Every
 * scenario gets its own, so no scenario can be influenced by another's writes.
 */
export function fixture() {
  const deps = freshDeps();
  // G08 writes files, not rows. Point it at a temp directory so the gate never touches the
  // developer's real ~/.till, which is the whole reason the support dir is injectable.
  deps.supportDir = mkdtempSync(join(tmpdir(), 'till-conformance-'));
  // G04 writes artifact bundles to disk, not rows. Point it at a temp directory for the same reason.
  deps.backupDir = mkdtempSync(join(tmpdir(), 'till-conf-backup-'));
  const { workspaceId, accId } = mintWorkspace(deps);
  const call = (name, input) => getAction(name).run(deps, { workspaceId, ...input });
  return { deps, workspaceId, accId, call };
}

/**
 * A15's shared world: a customer with a full postal address and email, and an ISSUED CHF invoice
 * due 2026-06-01 (45 days overdue at the fixture clock), on a workspace whose creditor profile can
 * carry a QR payment part. Returns the invoice's document id.
 */
function seedOverdueInvoice(fx, prefix) {
  fx.call('vat_seed_defaults', {});
  fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  fx.call('set_creditor_profile', {
    creditorName: 'Conformance GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const c = fx.call('create_contact', {
    partyRole: 'customer',
    name: 'Mahnung AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: 'buchhaltung@mahnung.example',
    idempotencyKey: `${prefix}-contact`,
  });
  const doc = fx.call('create_document', {
    type: 'invoice',
    contactId: c.contact.id,
    currency: 'CHF',
    dueDate: '2026-06-01',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${prefix}-doc`,
  });
  fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: `${prefix}-issue` });
  return doc.document.id;
}

/** A38: one accrued-expense draft on the June period end, keyed per scenario so no two collide. */
function accrualDraft(fx, key) {
  return {
    kind: 'accrued_expense',
    periodEnd: '2026-06-30',
    amountMinor: 180000,
    contraAccount: '6500',
    description: 'Strom Juni, Rechnung im Juli',
    idempotencyKey: key,
  };
}

/** A38: one Garantie provision draft on the June period end, Dr 6800 / Cr 2330. */
function provisionDraft(fx, key) {
  return {
    reason: 'garantie',
    periodEnd: '2026-06-30',
    amountMinor: 500000,
    provisionAccount: '2330',
    expenseAccount: '6800',
    description: 'Garantiefälle Halbjahr 2026',
    idempotencyKey: key,
  };
}

/** A balanced two-line draft body, the shape `save_draft` and `post_entry` share. */
function draftLines(accId, amount = 4200) {
  return [
    { account: accId('6500'), debit: amount },
    { account: accId('1000'), credit: amount },
  ];
}

/**
 * One valid call per WRITE verb: `(fx) => input`. The returned object is the COMPLETE input the gate
 * passes to `action.run`, `workspaceId` included where the verb is a ctx verb, so a deps verb
 * (pre-workspace) simply returns an input without one.
 *
 * A scenario MAY perform setup through `fx.call` first (post an entry so it can be reversed, lock a
 * period so it can be unlocked). The gate then calls the verb under test TWICE with the identical
 * input it returned.
 */
/**
 * Seed a PENDING `agent_action` row directly. A26 has NO tool that enqueues one (the dial does, from
 * inside the write dispatch at integration), so a drafted action is seeded through the store the way a
 * complex fixture seeds any precondition. The drafting actor is `till-agent`, deliberately DIFFERENT
 * from the fixture actor (`agent`), so approving it is not a self-approve (§6b Fixed). The wrapped verb
 * is a harmless config write so the replay's own money-path proof lives in A26's unit suite, not here.
 */
/**
 * Seed a minimal `migration_plan` row directly (G10). The plan-creating verb is G09's and does not
 * exist yet: the row here is the SEAM G10's spec defines (id + workspace + status + the three facts
 * the map layer consults), seeded through the store the way `seedDraftedAction` below seeds A26's
 * inbox. When G09 lands its `migration_create_plan`, these scenarios should switch to calling it.
 */
function seedMigrationPlan(fx, id, sourceAdapter = 'csv') {
  fx.deps.store.db
    .prepare(
      `INSERT INTO migration_plan (id, workspace_id, status, source_adapter, locale_pack, data_class, created_at)
       VALUES (?, ?, 'draft', ?, 'ch', NULL, ?)`,
    )
    .run(id, fx.workspaceId, sourceAdapter, fx.deps.clock.now());
  return id;
}

function seedDraftedAction(fx, id, actionTool, payload) {
  fx.deps.store.db
    .prepare(
      `INSERT INTO agent_action
         (id, workspace_id, actor, dial_capability, action_tool, payload_json, status, idempotency_key, created_at)
       VALUES (?, ?, 'till-agent', NULL, ?, ?, 'pending', ?, ?)`,
    )
    .run(id, fx.workspaceId, actionTool, JSON.stringify(payload), payload.idempotencyKey ?? null, fx.deps.clock.now());
  return id;
}

/** E02: an employee, by default with a vendor contact so its claims can be approved and reimbursed. */
function seedEmployee(fx, prefix, withContact = true) {
  const contactId = withContact
    ? fx.call('create_contact', { partyRole: 'vendor', name: 'Mitarbeiter Muster', idempotencyKey: `${prefix}-ct` }).contact.id
    : undefined;
  return fx.call('hr_employee_upsert', {
    employee: { firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01', ...(contactId ? { contactId } : {}) },
    idempotencyKey: `${prefix}-emp`,
  }).employeeId;
}

/**
 * E02: a SUBMITTED claim with one under-threshold CHF line, whose `created_by` is forced to a
 * distinct actor so the fixture actor (`agent`) can approve it without tripping the four-eyes
 * `self_approval` refusal, the `seedDraftedAction` shape one capability over.
 */
/**
 * E04: a real Thunderbird Maildir on disk (one inbound message, so `needs_reply` is non-empty),
 * built fresh per scenario in a temp directory. The fixture helpers are the mail suites' own.
 */
function seedMailStore(prefix) {
  const root = mkdtempSync(join(tmpdir(), `till-conf-${prefix}-`));
  makeMaildirStore(root, [
    {
      id: `${prefix}-1@example.org`,
      raw: rfc822({
        from: 'Klient Muster <klient@example.org>',
        to: 'praxis@example.ch',
        subject: 'Terminanfrage',
        messageId: `${prefix}-1@example.org`,
        body: 'Guten Tag, hätten Sie nächste Woche einen Termin frei?',
      }),
    },
  ]);
  return root;
}

/**
 * E05: a Maildir carrying 21 OUTBOUND messages (one over the 20-exemplar corpus floor) plus one
 * inbound, built fresh per scenario in a temp directory. The corpus builder is the voice suites'
 * own, over E04's fixture shapes.
 */
function seedVoiceMailStore(prefix) {
  const root = mkdtempSync(join(tmpdir(), `till-conf-${prefix}-`));
  makeMaildirStore(root, outboundCorpus(21));
  return root;
}

function seedSubmittedClaim(fx, prefix) {
  const employeeId = seedEmployee(fx, prefix);
  const claimId = fx.call('expense_claim_create', { employeeId, title: 'Reise Zürich', idempotencyKey: `${prefix}-c` }).claimId;
  fx.call('expense_line_upsert', { claimId, line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 4000 }, idempotencyKey: `${prefix}-l` });
  fx.call('expense_claim_submit', { claimId, idempotencyKey: `${prefix}-s` });
  fx.deps.store.db.prepare("UPDATE expense_claim SET created_by = 'claimant' WHERE workspace_id = ? AND id = ?").run(fx.workspaceId, claimId);
  return { employeeId, claimId };
}

/** G02: install one clean plugin and return its row id, for the enable/disable/uninstall/refresh scenarios. */
function seedPlugin(fx, prefix) {
  const payload = `seed-plugin-${prefix}`;
  const sha256 = createHash('sha256').update(payload).digest('hex');
  return fx.call('install_plugin', {
    source: 'local',
    packageRef: {
      manifest: {
        name: `Seed Extension ${prefix}`,
        version: '1.0.0',
        compat_range: '^1.0.0',
        sha256,
        capabilities: [],
        permissions: { requested: [] },
      },
      payload,
    },
    idempotencyKey: `${prefix}-plg-seed`,
  }).plugin.id;
}

/**
 * A31: a Swiss QR-bill payload (SPC) with a Swico S1 billing block, as a document dropped into the
 * capture queue. The deterministic pass finds the `SPC` header in the text and lands the fields, so
 * every downstream scenario has a real capture with real proposals. `Zürich` carries a real umlaut to
 * exercise the UTF-8 decode.
 */
const SPC_FIXTURE = [
  'SPC', '0200', '1', 'CH4431999123000889012',
  'S', 'Lieferant GmbH', 'Musterstrasse', '1', '8000', 'Zürich', 'CH',
  '', '', '', '', '', '', '',
  '1081.00', 'CHF',
  '', '', '', '', '', '', '',
  'QRR', '210000000003139471430009017', 'Rechnung Nr 10201409', 'EPD',
  '//S1/10/10201409/11/190512/30/106017086/32/8.1/40/0:30',
].join('\n');

function seedCapture(fx, prefix) {
  return fx.call('capture_document', {
    contentBase64: Buffer.from(SPC_FIXTURE, 'utf8').toString('base64'),
    mime: 'application/pdf',
    filename: `${prefix}.pdf`,
    idempotencyKey: `${prefix}-cap`,
  }).captureId;
}

export const SCENARIOS = {
  // --- M02, the §I sync/publish contract (the two owner publish dials) --------------------------
  // Both are absolute-state toggles carrying an idempotencyKey (spec §5): they route through
  // rememberIdempotent, so the double-call test replays rather than flipping twice. `sync_publish_disable`
  // enables first so the flip 1 -> 0 is a real change and the scenario is non-vacuous.
  sync_publish_enable: (fx) => ({ workspaceId: fx.workspaceId, idempotencyKey: 'm02-enable-1' }),
  sync_publish_disable: (fx) => {
    fx.call('sync_publish_enable', { idempotencyKey: 'm02-disable-seed' });
    return { workspaceId: fx.workspaceId, idempotencyKey: 'm02-disable-1' };
  },

  // --- G04, data freedom (export / backup / restore / delete) ----------------------------------
  // Artifact bundles land in `deps.backupDir` (a temp dir set by `fixture()`), so the gate never
  // touches the developer's real ~/.till. `restore_backup` seeds its own .tillbackup and passes
  // `confirmed:true` (the P8 human gate) so the happy path actually reconstructs a workspace; the
  // double-call test then proves the same key never mints a second one.
  export_workspace: (fx) => ({ workspaceId: fx.workspaceId, idempotencyKey: 'g04-exp-1' }),
  create_backup: (fx) => ({ workspaceId: fx.workspaceId, idempotencyKey: 'g04-bkp-1' }),
  delete_backup: (fx) => {
    const b = fx.call('create_backup', { idempotencyKey: 'g04-del-seed' });
    return { workspaceId: fx.workspaceId, backupId: b.backupId, idempotencyKey: 'g04-del-1' };
  },
  restore_backup: (fx) => {
    const b = fx.call('create_backup', { idempotencyKey: 'g04-rb-seed' });
    return { source: b.artifactRef, newWorkspaceName: 'Restored GmbH', confirmed: true, idempotencyKey: 'g04-rb-1' };
  },

  // --- N00, the environment landscape (D126, Phase A) ------------------------------------------
  // Host-level P8 writes over the tamper-evident control file, which `fixture()` isolates under
  // `deps.supportDir` (a temp dir), so the gate never touches the real ~/.till. Each passes
  // `confirmed:true` (the P8 gate) so the happy path executes, and an idempotencyKey so the
  // double-call test replays the stored SUCCESS rather than re-running. `synthetic` uses the fast
  // in-process `minimal` seed (never the heavy Seeblick child process). `env_switch` targets `main`
  // (present from bootstrap). `env_reset`/`env_delete` act on a freshly-created NON-active named env,
  // because reset/delete refuse the active tier (develop is active after bootstrap).
  env_switch: (fx) => ({ workspaceId: fx.workspaceId, name: 'main', confirmed: true, idempotencyKey: 'n00-switch-1' }),
  env_create: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'conf-create',
    policy: 'synthetic',
    seed: 'minimal',
    confirmed: true,
    idempotencyKey: 'n00-create-1',
  }),
  env_reset: (fx) => {
    fx.call('env_create', { name: 'conf-reset', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 'n00-reset-seed' });
    return { workspaceId: fx.workspaceId, name: 'conf-reset', seed: 'minimal', confirmed: true, idempotencyKey: 'n00-reset-1' };
  },
  env_delete: (fx) => {
    fx.call('env_create', { name: 'conf-del', policy: 'synthetic', seed: 'minimal', confirmed: true, idempotencyKey: 'n00-del-seed' });
    return { workspaceId: fx.workspaceId, name: 'conf-del', confirmed: true, idempotencyKey: 'n00-del-1' };
  },
  // env_copy (Phase B): a one-way copy between two freshly-created synthetic envs. The source is ranked
  // strictly above the target (down-only), both use the fast in-process `minimal` seed (schema only, no
  // workspaces), and neither is `main` or the active tier, so the happy path executes without touching
  // the real ledger. sanitize=raw (the default), so the secret floor still runs over an empty payload.
  env_copy: (fx) => {
    fx.call('env_create', { name: 'conf-copy-src', policy: 'synthetic', seed: 'minimal', tierRank: 250, confirmed: true, idempotencyKey: 'n00-copy-src' });
    fx.call('env_create', { name: 'conf-copy-tgt', policy: 'synthetic', seed: 'minimal', tierRank: 40, confirmed: true, idempotencyKey: 'n00-copy-tgt' });
    return { workspaceId: fx.workspaceId, source: 'conf-copy-src', target: 'conf-copy-tgt', scope: 'instance', sanitize: 'raw', confirmed: true, idempotencyKey: 'n00-copy-1' };
  },

  // --- G08, feedback & diagnostics -------------------------------------------------------------
  prepare_feedback: (fx) => ({
    workspaceId: fx.workspaceId,
    kind: 'bug',
    subject: 'Conformance report',
    message: 'Written by the conformance gate.',
    idempotencyKey: 'fb-1',
  }),

  set_diagnostics: (fx) => ({ workspaceId: fx.workspaceId, capture: true }),

  clear_diagnostics: (fx) => ({ workspaceId: fx.workspaceId }),

  // --- A00, setup ------------------------------------------------------------------------------
  create_workspace: () => ({ name: 'Conformance GmbH', idempotencyKey: 'cw-1' }),

  bootstrap_workspace: () => ({
    description: 'Einzelfirma in Zürich, Beratung, nicht MWST-pflichtig',
    idempotencyKey: 'bw-1',
  }),

  // --- A23, multi-client workspaces ------------------------------------------------------------
  // The Treuhänder composite: exercises the whole real path (mint + KMU chart + tax-code seed +
  // VAT method + owner seating), not just the mint, so rules 8 and 10 to 12 hold all of it.
  onboard_client: () => ({
    name: 'Mandant Muster Treuhand AG',
    legalForm: 'ag',
    vatMethod: 'effektiv',
    vatAccounting: 'soll',
    idempotencyKey: 'oc-1',
  }),

  // Archiving the fixture's own workspace is the interesting direction: the double-call replays the
  // key, and the boundary's read-only guard must keep letting `archive_workspace` itself through.
  archive_workspace: (fx) => ({ workspaceId: fx.workspaceId, archived: true, idempotencyKey: 'aw-1' }),

  // --- G03, onboarding & the demo workspace ----------------------------------------------------
  // `advance_onboarding_step` is an absolute resume-pointer set (key-exempt below). The demo pair
  // drives the REAL composite: create mints and seeds a whole demo book (chart, VAT, contacts,
  // items, issued invoices) idempotently under `_system`; discard mints its OWN demo first and
  // hard-deletes it, so the double-call replays the stored result rather than refusing on a
  // vanished workspace.
  advance_onboarding_step: (fx) => ({ workspaceId: fx.workspaceId, path: 'fresh', step: 'company' }),

  // M03: the move-checklist pointer is the same absolute resume-pointer set (key-exempt below); the
  // double-call re-asserts step 1 done and keeps the original timestamp (COALESCE in the engine).
  advance_move_step: (fx) => ({ workspaceId: fx.workspaceId, direction: 'local_to_selfhost', step: 1 }),

  create_demo_workspace: () => ({ idempotencyKey: 'cdw-1' }),

  discard_demo_workspace: (fx) => {
    const demo = fx.call('create_demo_workspace', { idempotencyKey: 'ddw-demo' });
    return { workspaceId: demo.workspaceId, confirmed: true, idempotencyKey: 'ddw-1' };
  },

  set_fiscal_config: (fx) => ({ workspaceId: fx.workspaceId, legalForm: 'gmbh' }),

  set_vat_method: (fx) => ({ workspaceId: fx.workspaceId, vatMethod: 'effektiv', vatAccounting: 'soll' }),

  set_creditor_profile: (fx) => ({
    workspaceId: fx.workspaceId,
    creditorName: 'Conformance GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8001', town: 'Zürich', country: 'CH' },
  }),

  update_company_profile: (fx) => ({ workspaceId: fx.workspaceId, legalForm: 'ag' }),

  // --- A01, accounts and cost centres ----------------------------------------------------------
  create_account: (fx) => ({
    workspaceId: fx.workspaceId,
    number: '6510',
    name: 'Porto',
    type: 'expense',
    idempotencyKey: 'ca-1',
  }),

  update_account: (fx) => ({
    workspaceId: fx.workspaceId,
    accountId: fx.accId('6500'),
    name: 'Büromaterial und Drucksachen',
  }),

  archive_account: (fx) => ({ workspaceId: fx.workspaceId, accountId: fx.accId('6500') }),

  unarchive_account: (fx) => {
    fx.call('archive_account', { accountId: fx.accId('6500') });
    return { workspaceId: fx.workspaceId, accountId: fx.accId('6500') };
  },

  delete_account: (fx) => {
    const created = fx.call('create_account', {
      number: '6511',
      name: 'Zu löschen',
      type: 'expense',
      idempotencyKey: 'da-seed',
    });
    return { workspaceId: fx.workspaceId, accountId: created.accountId, idempotencyKey: 'da-1' };
  },

  create_cost_center: (fx) => ({
    workspaceId: fx.workspaceId,
    code: 'CC1',
    name: 'Projekt Alpin',
    idempotencyKey: 'cc-1',
  }),

  archive_cost_center: (fx) => {
    const cc = fx.call('create_cost_center', { code: 'CC2', name: 'Projekt Jura', idempotencyKey: 'acc-seed' });
    return { workspaceId: fx.workspaceId, costCenterId: cc.costCenterId };
  },

  unarchive_cost_center: (fx) => {
    const cc = fx.call('create_cost_center', { code: 'CC3', name: 'Projekt Tessin', idempotencyKey: 'ucc-seed' });
    fx.call('archive_cost_center', { costCenterId: cc.costCenterId });
    return { workspaceId: fx.workspaceId, costCenterId: cc.costCenterId };
  },

  delete_cost_center: (fx) => {
    const cc = fx.call('create_cost_center', { code: 'CC4', name: 'Projekt Wallis', idempotencyKey: 'dcc-seed' });
    return { workspaceId: fx.workspaceId, costCenterId: cc.costCenterId };
  },

  // --- A02, the money path ---------------------------------------------------------------------
  post_entry: (fx) => ({ workspaceId: fx.workspaceId, ...manualPost(fx.accId, 'pe-1') }),

  reverse_entry: (fx) => {
    const posted = fx.call('post_entry', manualPost(fx.accId, 're-seed'));
    return { workspaceId: fx.workspaceId, entryId: posted.entryId, idempotencyKey: 're-1' };
  },

  save_draft: (fx) => ({
    workspaceId: fx.workspaceId,
    date: '2026-03-01',
    description: 'Entwurf Büromaterial',
    lines: draftLines(fx.accId),
    idempotencyKey: 'sd-1',
  }),

  delete_draft: (fx) => {
    const draft = fx.call('save_draft', {
      date: '2026-03-01',
      lines: draftLines(fx.accId),
      idempotencyKey: 'dd-seed',
    });
    return { workspaceId: fx.workspaceId, entryId: draft.entryId, idempotencyKey: 'dd-1' };
  },

  // --- A03, periods ----------------------------------------------------------------------------
  close_month: (fx) => ({ workspaceId: fx.workspaceId, period: '2026-03', idempotencyKey: 'cm-1' }),

  reopen_month: (fx) => {
    fx.call('close_month', { period: '2026-03', idempotencyKey: 'rm-seed' });
    return { workspaceId: fx.workspaceId, period: '2026-03', idempotencyKey: 'rm-1' };
  },

  close_year: (fx) => ({ workspaceId: fx.workspaceId, year: '2026', idempotencyKey: 'cy-1' }),

  lock_period: (fx) => ({
    workspaceId: fx.workspaceId,
    period: '2026-04',
    kind: 'soft',
    idempotencyKey: 'lp-1',
  }),

  unlock_period: (fx) => {
    fx.call('lock_period', { period: '2026-04', kind: 'soft', idempotencyKey: 'up-seed' });
    return { workspaceId: fx.workspaceId, period: '2026-04', idempotencyKey: 'up-1' };
  },

  // --- A05, VAT --------------------------------------------------------------------------------
  vat_seed_defaults: (fx) => ({ workspaceId: fx.workspaceId }),

  vat_configure: (fx) => ({
    workspaceId: fx.workspaceId,
    method: 'effektiv',
    timing: 'soll',
    registered: true,
    vatNumber: 'CHE-116.281.710 MWST',
    idempotencyKey: 'vc-1',
  }),

  vat_code_upsert: (fx) => {
    // A tax code only exists on a VAT-registered workspace, so register first.
    fx.call('vat_configure', {
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      idempotencyKey: 'vcu-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      code: 'UST81X',
      kind: 'output',
      rateBp: 810,
      formLine: '303',
      label: 'Normalsatz Umsatz',
      idempotencyKey: 'vcu-1',
    };
  },

  vat_code_deactivate: (fx) => {
    fx.call('vat_configure', {
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      idempotencyKey: 'vcd-seed',
    });
    fx.call('vat_seed_defaults', {});
    return { workspaceId: fx.workspaceId, code: 'UST81' };
  },

  vat_code_reactivate: (fx) => {
    fx.call('vat_configure', {
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      idempotencyKey: 'vcr-seed',
    });
    fx.call('vat_seed_defaults', {});
    // Archive it first, so the scenario exercises the real archived -> active path.
    fx.call('vat_code_deactivate', { code: 'UST81' });
    return { workspaceId: fx.workspaceId, code: 'UST81' };
  },

  account_set_tax_default: (fx) => {
    fx.call('vat_configure', {
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      idempotencyKey: 'astd-seed',
    });
    fx.call('vat_seed_defaults', {});
    return { workspaceId: fx.workspaceId, accountId: fx.accId('6500'), taxCode: 'VST-M' };
  },

  // MWSTV Art. 88 Abs. 6 is a Saldosteuersatz simplification, so the workspace has to be ON the
  // Saldo method before the election means anything: under effektiv the verb refuses with
  // `invalid_vat_method`, which is correct behaviour and would make a useless scenario.
  vat_saldo_declaration_basis: (fx) => {
    fx.call('vat_configure', {
      method: 'saldo',
      timing: 'soll',
      registered: true,
      saldoRates: [{ rateBp: 620 }, { rateBp: 370 }],
      idempotencyKey: 'vsdb-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      taxPeriod: '2026',
      basis: 'highest_rate',
      idempotencyKey: 'vsdb-1',
    };
  },

  // --- A09, contacts and items -----------------------------------------------------------------
  create_contact: (fx) => ({
    workspaceId: fx.workspaceId,
    partyRole: 'customer',
    name: 'Kundin AG',
    idempotencyKey: 'cc-contact-1',
  }),

  update_contact: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Patch AG', idempotencyKey: 'uc-seed' });
    return { workspaceId: fx.workspaceId, contactId: c.contact.id, patch: { email: 'buchhaltung@example.ch' } };
  },

  archive_contact: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Archiv AG', idempotencyKey: 'ac-seed' });
    return { workspaceId: fx.workspaceId, contactId: c.contact.id };
  },

  unarchive_contact: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Zurück AG', idempotencyKey: 'uac-seed' });
    fx.call('archive_contact', { contactId: c.contact.id });
    return { workspaceId: fx.workspaceId, contactId: c.contact.id };
  },

  // --- C00, contacts / CRM (extends A09) -------------------------------------------------------
  // Each new write seeds its own contact through A09's create_contact and then exercises the C00 verb
  // twice under one key: the gate's whole-database comparison is what proves a replay writes nothing.

  contacts_tag: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Tag AG', idempotencyKey: 'ctag-seed' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      segments: ['newsletter', 'vip'],
      roles: ['entscheider'],
      idempotencyKey: 'ctag-1',
    };
  },

  contacts_log_activity: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Verlauf AG', idempotencyKey: 'clog-seed' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      kind: 'call',
      body: 'Erstgespräch geführt.',
      occurredAt: '2026-03-01',
      idempotencyKey: 'clog-1',
    };
  },

  contacts_merge: (fx) => {
    const source = fx.call('create_contact', { partyRole: 'customer', name: 'Doppelt AG', idempotencyKey: 'cmrg-src' });
    const target = fx.call('create_contact', { partyRole: 'customer', name: 'Original AG', idempotencyKey: 'cmrg-tgt' });
    return {
      workspaceId: fx.workspaceId,
      sourceId: source.contact.id,
      targetId: target.contact.id,
      idempotencyKey: 'cmrg-1',
    };
  },

  contacts_import: (fx) => ({
    workspaceId: fx.workspaceId,
    rows: [
      { partyRole: 'customer', name: 'Import GmbH', email: 'kontakt@import.example' },
      { partyRole: 'vendor', name: 'Lieferant AG', vatNumber: 'CHE-116.281.710 MWST' },
    ],
    idempotencyKey: 'cimp-1',
  }),

  contacts_anonymise: (fx) => {
    const c = fx.call('create_contact', {
      partyRole: 'customer',
      name: 'Zu Anonymisieren',
      email: 'privat@example.ch',
      idempotencyKey: 'canon-seed',
    });
    return { workspaceId: fx.workspaceId, contactId: c.contact.id, idempotencyKey: 'canon-1' };
  },

  // --- E03, tasks & reminders. The fixture clock is 2026-07-16, so every dueAt/reminderAt below is
  // in its future (a past reminder is refused with reminder_in_past, which a scenario must not be).

  tasks_create: (fx) => {
    // The real path: an OP3-linked, recurring task, so the scenario exercises the registry check
    // and the rule parser rather than the bare-minimum insert.
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Nachfassen AG', idempotencyKey: 'tskc-seed' });
    return {
      workspaceId: fx.workspaceId,
      title: 'Offerte nachfassen',
      assigneeUserId: 'agent',
      dueAt: '2026-09-30',
      reminderAt: '2026-09-25T08:00:00.000Z',
      entityKind: 'contact',
      entityId: c.contact.id,
      recurrenceRule: 'FREQ=MONTHLY;INTERVAL=1',
      idempotencyKey: 'tskc-1',
    };
  },

  tasks_update: (fx) => {
    const t = fx.call('tasks_create', {
      title: 'Beleg nachreichen',
      assigneeUserId: 'agent',
      dueAt: '2026-08-15',
      idempotencyKey: 'tsku-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      taskId: t.taskId,
      patch: { dueAt: '2026-08-22', title: 'Beleg nachreichen (Frist verschoben)' },
      idempotencyKey: 'tsku-1',
    };
  },

  tasks_complete: (fx) => {
    // The composite write in full: contact-linked (so logActivity exercises the OP5 seam) AND
    // recurring (so the same idempotency key provably covers complete + log + spawn).
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Serie GmbH', idempotencyKey: 'tskd-seed-c' });
    const t = fx.call('tasks_create', {
      title: 'Monatsabschluss prüfen',
      assigneeUserId: 'agent',
      dueAt: '2026-07-31',
      entityKind: 'contact',
      entityId: c.contact.id,
      recurrenceRule: 'FREQ=MONTHLY',
      idempotencyKey: 'tskd-seed-t',
    });
    return { workspaceId: fx.workspaceId, taskId: t.taskId, logActivity: true, idempotencyKey: 'tskd-1' };
  },

  tasks_snooze: (fx) => {
    const t = fx.call('tasks_create', {
      title: 'Mahnung kontrollieren',
      assigneeUserId: 'agent',
      dueAt: '2026-08-10',
      reminderAt: '2026-08-01T08:00:00.000Z',
      idempotencyKey: 'tsks-seed',
    });
    return { workspaceId: fx.workspaceId, taskId: t.taskId, until: '2026-08-05T08:00:00.000Z', idempotencyKey: 'tsks-1' };
  },

  tasks_cancel: (fx) => {
    const t = fx.call('tasks_create', {
      title: 'Nicht mehr nötig',
      assigneeUserId: 'agent',
      idempotencyKey: 'tskx-seed',
    });
    return { workspaceId: fx.workspaceId, taskId: t.taskId, idempotencyKey: 'tskx-1' };
  },

  // --- C01, leads & deals ----------------------------------------------------------------------
  // Each write seeds its own contact through A09's create_contact; the FIRST deals_create in a
  // fixture also seeds the default pipeline, which IS the real path (a write seeds, a read never).
  // The create exercises the §H-FX capture over a real recorded EUR rate rather than the trivial
  // base-currency branch, so the frozen trio is derived exactly as production derives it.

  deals_create: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Funnel AG', idempotencyKey: 'dlc-seed' });
    fx.call('record_exchange_rate', { baseCurrency: 'EUR', rate: '0.93', asOf: '2026-07-15', idempotencyKey: 'dlc-rate' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      title: 'Website-Relaunch',
      valueMinor: 250000,
      currency: 'EUR',
      idempotencyKey: 'dlc-1',
    };
  },

  deals_update: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Patch AG', idempotencyKey: 'dlu-seed' });
    const d = fx.call('deals_create', { contactId: c.contact.id, title: 'Wartungsvertrag', valueMinor: 80000, idempotencyKey: 'dlu-deal' });
    return {
      workspaceId: fx.workspaceId,
      dealId: d.dealId,
      patch: { valueMinor: 95000, expectedCloseOn: '2026-09-30' },
      idempotencyKey: 'dlu-1',
    };
  },

  deals_move: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Phase AG', idempotencyKey: 'dlm-seed' });
    const d = fx.call('deals_create', { contactId: c.contact.id, title: 'Schulung', valueMinor: 40000, idempotencyKey: 'dlm-deal' });
    // The second OPEN stage of the seeded default funnel (Qualifiziert): a real cross-column move.
    const board = fx.call('deals_list', {});
    const target = board.stages.filter((s) => s.outcome === null)[1];
    return { workspaceId: fx.workspaceId, dealId: d.dealId, stageId: target.id, idempotencyKey: 'dlm-1' };
  },

  deals_mark: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Abschluss AG', idempotencyKey: 'dlk-seed' });
    const d = fx.call('deals_create', { contactId: c.contact.id, title: 'Grossprojekt', valueMinor: 500000, idempotencyKey: 'dlk-deal' });
    // The lost leg, because it is the guarded one (lostReason required, probability pinned to 0).
    return { workspaceId: fx.workspaceId, dealId: d.dealId, status: 'lost', lostReason: 'Budget gestrichen', idempotencyKey: 'dlk-1' };
  },

  deals_log_activity: (fx) => {
    // The composite write in full: the OP5 note AND the reminder task minted through the dispatch,
    // so one idempotency key provably covers note + task together. Reminder in the fixture future.
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Nachfass AG', idempotencyKey: 'dla-seed' });
    const d = fx.call('deals_create', { contactId: c.contact.id, title: 'Pilotphase', valueMinor: 120000, idempotencyKey: 'dla-deal' });
    return {
      workspaceId: fx.workspaceId,
      dealId: d.dealId,
      kind: 'call',
      body: 'Entscheider erreicht, Rückmeldung nächste Woche.',
      reminderAt: '2026-09-01T08:00:00.000Z',
      idempotencyKey: 'dla-1',
    };
  },

  deals_to_quote: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Offerte AG', idempotencyKey: 'dlq-seed' });
    const d = fx.call('deals_create', { contactId: c.contact.id, title: 'Umbau Empfang', valueMinor: 350000, idempotencyKey: 'dlq-deal' });
    return { workspaceId: fx.workspaceId, dealId: d.dealId, idempotencyKey: 'dlq-1' };
  },

  // --- C02, quotes / proposals -----------------------------------------------------------------
  // Each write seeds its own contact and, where the verb needs a prior state, the quote (and its
  // send/accept) through the real verbs, so the double-call test proves H-IDEMPOTENT on the actual
  // path. A quote posts nothing, so none of these needs VAT or a creditor profile.
  quotes_create: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Offerte AG', idempotencyKey: 'qc-seed' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      validUntil: '2027-01-31',
      lines: [{ description: 'Beratung', quantityMilli: 2000, unitPriceMinor: 15000 }],
      idempotencyKey: 'qc-1',
    };
  },

  quotes_update: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Entwurf AG', idempotencyKey: 'qu-seed' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, lines: [{ description: 'Position', unitPriceMinor: 8000 }], idempotencyKey: 'qu-quote' });
    return {
      workspaceId: fx.workspaceId,
      quoteId: q.document.id,
      patch: { validUntil: '2027-03-31', lines: [{ description: 'Neue Position', unitPriceMinor: 9500 }] },
      idempotencyKey: 'qu-1',
    };
  },

  quotes_send: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Versand AG', idempotencyKey: 'qs-seed' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 'qs-quote' });
    return { workspaceId: fx.workspaceId, quoteId: q.document.id, idempotencyKey: 'qs-1' };
  },

  quotes_accept: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Annahme AG', idempotencyKey: 'qa-seed' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 'qa-quote' });
    fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 'qa-send' });
    return { workspaceId: fx.workspaceId, quoteId: q.document.id, actor: 'Kundin Muster', idempotencyKey: 'qa-1' };
  },

  quotes_decline: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Absage AG', idempotencyKey: 'qd-seed' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 'qd-quote' });
    fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 'qd-send' });
    return { workspaceId: fx.workspaceId, quoteId: q.document.id, declineReason: 'Budget verschoben', idempotencyKey: 'qd-1' };
  },

  quotes_expire_sweep: (fx) => ({ workspaceId: fx.workspaceId, idempotencyKey: 'qx-1' }),

  quotes_revise: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Revision AG', idempotencyKey: 'qr-seed' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 'qr-quote' });
    fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 'qr-send' });
    return { workspaceId: fx.workspaceId, quoteId: q.document.id, idempotencyKey: 'qr-1' };
  },

  quotes_convert: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Umwandlung AG', idempotencyKey: 'qcv-seed' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 'qcv-quote' });
    fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 'qcv-send' });
    fx.call('quotes_accept', { quoteId: q.document.id, actor: 'Kundin', idempotencyKey: 'qcv-accept' });
    return { workspaceId: fx.workspaceId, quoteId: q.document.id, to: 'invoice', idempotencyKey: 'qcv-1' };
  },

  // --- D03, sales orders & delivery notes ------------------------------------------------------
  // Each write seeds its own state through D03's (and A09/C02/D01's) own verbs, so rules 8 and 10 to
  // 12 exercise the real path. The stock verbs lean on `stockSeed` (item + location + one receipt).
  sales_order_create: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Auftrag AG', idempotencyKey: 'soc-contact' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      lines: [{ description: 'Montage vor Ort', quantityMilli: 1000, unitPriceMinor: 12000 }],
      idempotencyKey: 'soc-1',
    };
  },

  sales_order_from_quote: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Offerte-Auftrag AG', idempotencyKey: 'sofq-contact' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 'sofq-quote' });
    fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 'sofq-send' });
    fx.call('quotes_accept', { quoteId: q.document.id, actor: 'Kundin', idempotencyKey: 'sofq-accept' });
    return { workspaceId: fx.workspaceId, quoteId: q.document.id, idempotencyKey: 'sofq-1' };
  },

  sales_order_confirm: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Bestaetigen AG', idempotencyKey: 'socf-contact' });
    const o = fx.call('sales_order_create', { contactId: c.contact.id, lines: [{ description: 'Dienstleistung', quantityMilli: 1000, unitPriceMinor: 9000 }], idempotencyKey: 'socf-order' });
    return { workspaceId: fx.workspaceId, salesOrderId: o.salesOrder.id, idempotencyKey: 'socf-1' };
  },

  sales_order_cancel: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Storno AG', idempotencyKey: 'socx-contact' });
    const o = fx.call('sales_order_create', { contactId: c.contact.id, lines: [{ description: 'Position', quantityMilli: 1000, unitPriceMinor: 5000 }], idempotencyKey: 'socx-order' });
    return { workspaceId: fx.workspaceId, salesOrderId: o.salesOrder.id, idempotencyKey: 'socx-1' };
  },

  sales_order_invoice: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Faktura AG', idempotencyKey: 'soiv-contact' });
    const o = fx.call('sales_order_create', { contactId: c.contact.id, lines: [{ description: 'Beratung', quantityMilli: 2000, unitPriceMinor: 15000 }], idempotencyKey: 'soiv-order' });
    fx.call('sales_order_confirm', { salesOrderId: o.salesOrder.id, idempotencyKey: 'soiv-confirm' });
    return { workspaceId: fx.workspaceId, salesOrderId: o.salesOrder.id, actor: 'Sachbearbeiterin', idempotencyKey: 'soiv-1' };
  },

  delivery_note_create: (fx) => {
    const s = stockSeed(fx, 'dnc');
    const o = fx.call('sales_order_create', { lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'dnc-order' });
    fx.call('sales_order_confirm', { salesOrderId: o.salesOrder.id, idempotencyKey: 'dnc-confirm' });
    return { workspaceId: fx.workspaceId, salesOrderId: o.salesOrder.id, locationId: s.locationId, idempotencyKey: 'dnc-1' };
  },

  delivery_note_issue: (fx) => {
    const s = stockSeed(fx, 'dni');
    const o = fx.call('sales_order_create', { lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'dni-order' });
    fx.call('sales_order_confirm', { salesOrderId: o.salesOrder.id, idempotencyKey: 'dni-confirm' });
    const n = fx.call('delivery_note_create', { salesOrderId: o.salesOrder.id, locationId: s.locationId, idempotencyKey: 'dni-note' });
    return { workspaceId: fx.workspaceId, deliveryNoteId: n.deliveryNote.id, actor: 'Lageristin', idempotencyKey: 'dni-1' };
  },

  delivery_note_render: (fx) => {
    const s = stockSeed(fx, 'dnr');
    const o = fx.call('sales_order_create', { lines: [{ itemId: s.itemId, quantityMilli: 3000, unitPriceMinor: 5000 }], idempotencyKey: 'dnr-order' });
    fx.call('sales_order_confirm', { salesOrderId: o.salesOrder.id, idempotencyKey: 'dnr-confirm' });
    const n = fx.call('delivery_note_create', { salesOrderId: o.salesOrder.id, locationId: s.locationId, idempotencyKey: 'dnr-note' });
    fx.call('delivery_note_issue', { deliveryNoteId: n.deliveryNote.id, idempotencyKey: 'dnr-issue' });
    return { workspaceId: fx.workspaceId, deliveryNoteId: n.deliveryNote.id, idempotencyKey: 'dnr-1' };
  },

  // --- D02, purchasing (PO -> goods receipt -> 3-way match, supplier prices) -------------------
  // Each write seeds its own world through D02's (and C00/D00/D01/A17's) own verbs. The gate's double
  // call proves the money-path invariants: a receipt mints ONE stock movement (not two on retry), and
  // a match consumes billed_qty exactly once. `purchasingSeed` mints a supplier, a stock-tracked item
  // and a location.
  po_upsert: (fx) => {
    const s = purchasingSeed(fx, 'pou');
    return {
      workspaceId: fx.workspaceId,
      supplierContactId: s.vendorId,
      lines: [{ itemId: s.itemId, qty: 10, unitPriceRappen: 10000 }],
      idempotencyKey: 'pou-1',
    };
  },

  po_send: (fx) => {
    const s = purchasingSeed(fx, 'pos');
    const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 4, unitPriceRappen: 10000 }], idempotencyKey: 'pos-po' });
    return { workspaceId: fx.workspaceId, poId: po.poId, actor: 'Einkäuferin', idempotencyKey: 'pos-1' };
  },

  receipt_record: (fx) => {
    const s = purchasingSeed(fx, 'rr');
    const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 6, unitPriceRappen: 10000 }], idempotencyKey: 'rr-po' });
    fx.call('po_send', { poId: po.poId, idempotencyKey: 'rr-send' });
    const line = fx.call('po_get', { poId: po.poId }).lines[0].id;
    return { workspaceId: fx.workspaceId, poId: po.poId, locationId: s.locationId, lines: [{ poLineId: line, qty: 4 }], actor: 'Lagerist', idempotencyKey: 'rr-1' };
  },

  match_bill: (fx) => {
    const s = purchasingSeed(fx, 'mb');
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    // PO for 10 units at net 100.00 each (net total 1'000.00), fully received.
    const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 10, unitPriceRappen: 10000 }], idempotencyKey: 'mb-po' });
    fx.call('po_send', { poId: po.poId, idempotencyKey: 'mb-send' });
    const line = fx.call('po_get', { poId: po.poId }).lines[0].id;
    fx.call('receipt_record', { poId: po.poId, locationId: s.locationId, lines: [{ poLineId: line, qty: 10 }], idempotencyKey: 'mb-recv' });
    // A17 bill for the SAME supplier, gross 1'081.00 at 8.1% -> net 1'000.00, POSTED so base_net_minor exists.
    const bill = fx.call('create_vendor_bill', {
      vendorId: s.vendorId,
      billDate: '2026-03-05',
      amountMinor: 108100,
      amountIsGross: true,
      taxCode: 'VST-M',
      expenseAccountId: fx.accId('6500'),
      idempotencyKey: 'mb-bill',
    });
    fx.call('post_vendor_bill', { vendorBillId: bill.vendorBillId, idempotencyKey: 'mb-post' });
    return { workspaceId: fx.workspaceId, poId: po.poId, billId: bill.vendorBillId, actor: 'Treuhänderin', idempotencyKey: 'mb-1' };
  },

  // --- I04, three-way match. Each seeds a supplier + stock item + a fully received PO + a POSTED A17
  // bill through the D02/A17 verbs, then evaluates and matches. The gate's double call proves the
  // money-path invariants: a create increments po_line.billed_qty exactly once on replay, and a
  // reverse restores it without double-adjusting. -------------------------------------------------
  match_three_way_create: (fx) => {
    const b = seedThreeWayBill(fx, 'twc', 108100); // gross 1'081.00 -> net 1'000.00, exactly the PO value.
    const evaluation = fx.call('match_three_way_evaluate', { billId: b.billId }).evaluation;
    return { workspaceId: fx.workspaceId, billId: b.billId, evaluation, idempotencyKey: 'twc-1' };
  },

  match_three_way_override: (fx) => {
    // Gross 1'200.00 -> net ~1'110.00, well over the 1'000.00 PO value: an out-of-tolerance variance.
    const b = seedThreeWayBill(fx, 'two', 120000);
    const evaluation = fx.call('match_three_way_evaluate', { billId: b.billId }).evaluation;
    return { workspaceId: fx.workspaceId, billId: b.billId, evaluation, reason: 'Preisdifferenz mit Lieferant vereinbart', idempotencyKey: 'two-1' };
  },

  match_three_way_reverse: (fx) => {
    const b = seedThreeWayBill(fx, 'twr', 108100);
    const evaluation = fx.call('match_three_way_evaluate', { billId: b.billId }).evaluation;
    const match = fx.call('match_three_way_create', { billId: b.billId, evaluation, idempotencyKey: 'twr-create' });
    return { workspaceId: fx.workspaceId, matchId: match.match.id, reason: 'Falsche Bestellung zugeordnet', idempotencyKey: 'twr-1' };
  },

  po_close_short: (fx) => {
    const s = purchasingSeed(fx, 'pcs');
    const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 8, unitPriceRappen: 10000 }], idempotencyKey: 'pcs-po' });
    fx.call('po_send', { poId: po.poId, idempotencyKey: 'pcs-send' });
    return { workspaceId: fx.workspaceId, poId: po.poId, actor: 'Einkäuferin', idempotencyKey: 'pcs-1' };
  },

  po_cancel: (fx) => {
    const s = purchasingSeed(fx, 'pcx');
    const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 3, unitPriceRappen: 10000 }], idempotencyKey: 'pcx-po' });
    return { workspaceId: fx.workspaceId, poId: po.poId, actor: 'Einkäuferin', idempotencyKey: 'pcx-1' };
  },

  po_revise: (fx) => {
    const s = purchasingSeed(fx, 'prv');
    const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 5, unitPriceRappen: 10000 }], idempotencyKey: 'prv-po' });
    fx.call('po_send', { poId: po.poId, idempotencyKey: 'prv-send' });
    return { workspaceId: fx.workspaceId, poId: po.poId, reason: 'Preiskorrektur', actor: 'Einkäuferin', idempotencyKey: 'prv-1' };
  },

  supplier_price_upsert: (fx) => {
    const s = purchasingSeed(fx, 'spu');
    return { workspaceId: fx.workspaceId, supplierContactId: s.vendorId, itemId: s.itemId, priceRappen: 9500, currency: 'CHF', validFrom: '2026-01-01', leadTimeDays: 7, idempotencyKey: 'spu-1' };
  },

  // --- I01, Advanced Purchase Order (OP14 versioning + amendment) -------------------------------
  // Each seeds a sent PO through D02's own verbs. The gate's double call proves the OP14 invariants:
  // apply mints ONE version N+1 (not two on retry), and start creates ONE amendment per key.
  po_amendment_start: (fx) => {
    const w = amendablePo(fx, 'pas');
    return { workspaceId: fx.workspaceId, poId: w.poId, reason: 'Preisänderung', actor: 'Einkäuferin', idempotencyKey: 'pas-1' };
  },

  po_amendment_update_lines: (fx) => {
    const w = amendablePo(fx, 'paul');
    const a = fx.call('po_amendment_start', { poId: w.poId, reason: 'Mengenkorrektur', idempotencyKey: 'paul-start' });
    return { workspaceId: fx.workspaceId, amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: w.lineId, qty: 8, unitPriceRappen: 11000 }], actor: 'Einkäuferin', idempotencyKey: 'paul-1' };
  },

  po_amendment_submit: (fx) => {
    const w = startedAmendment(fx, 'pasu');
    return { workspaceId: fx.workspaceId, amendmentId: w.amendmentId, actor: 'Einkäuferin', idempotencyKey: 'pasu-1' };
  },

  po_amendment_apply: (fx) => {
    const w = startedAmendment(fx, 'paa');
    return { workspaceId: fx.workspaceId, amendmentId: w.amendmentId, actor: 'Einkäuferin', idempotencyKey: 'paa-1' };
  },

  po_amendment_cancel: (fx) => {
    const w = startedAmendment(fx, 'pac');
    return { workspaceId: fx.workspaceId, amendmentId: w.amendmentId, reason: 'Abgebrochen', actor: 'Einkäuferin', idempotencyKey: 'pac-1' };
  },

  po_amendment_reject: (fx) => {
    const w = startedAmendment(fx, 'par');
    fx.call('po_amendment_submit', { amendmentId: w.amendmentId, idempotencyKey: 'par-submit' });
    return { workspaceId: fx.workspaceId, amendmentId: w.amendmentId, reason: 'Budget überschritten', actor: 'Genehmiger', idempotencyKey: 'par-1' };
  },

  pipelines_upsert: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Grosskunden',
    idempotencyKey: 'dpu-1',
  }),

  pipeline_stages_upsert: (fx) => {
    const p = fx.call('pipelines_upsert', { name: 'Partnervertrieb', idempotencyKey: 'dps-seed' });
    return {
      workspaceId: fx.workspaceId,
      pipelineId: p.pipelineId,
      name: 'Verhandlung',
      probability: 75,
      idempotencyKey: 'dps-1',
    };
  },

  create_item: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Beratung',
    defaultUnitPriceMinor: 15000,
    idempotencyKey: 'ci-1',
  }),

  update_item: (fx) => {
    // D00 constrains `unit` to the ITEM_UNITS enum, so the patch uses an enum member ('hour'), not the
    // free-text 'Stunde' A09 once accepted.
    const i = fx.call('create_item', { name: 'Patch', defaultUnitPriceMinor: 100, idempotencyKey: 'ui-seed' });
    return { workspaceId: fx.workspaceId, itemId: i.item.id, patch: { unit: 'hour' } };
  },

  archive_item: (fx) => {
    const i = fx.call('create_item', { name: 'Archiv', defaultUnitPriceMinor: 100, idempotencyKey: 'ai-seed' });
    return { workspaceId: fx.workspaceId, itemId: i.item.id };
  },

  unarchive_item: (fx) => {
    const i = fx.call('create_item', { name: 'Zurück', defaultUnitPriceMinor: 100, idempotencyKey: 'uai-seed' });
    fx.call('archive_item', { itemId: i.item.id });
    return { workspaceId: fx.workspaceId, itemId: i.item.id };
  },

  // --- D00, the products/items master's new verbs ----------------------------------------------
  delete_item: (fx) => {
    // An unreferenced item: the census passes, so the hard-delete succeeds and then replays its
    // stored result on the double call (nothing left to delete, no second row).
    const i = fx.call('create_item', { name: 'Wegwerf', defaultUnitPriceMinor: 100, idempotencyKey: 'di-seed' });
    return { workspaceId: fx.workspaceId, itemId: i.item.id, idempotencyKey: 'di-1' };
  },

  item_categories_upsert: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Beratung',
    idempotencyKey: 'icu-1',
  }),

  item_categories_delete: (fx) => {
    const cat = fx.call('item_categories_upsert', { name: 'Weg', idempotencyKey: 'icd-seed' });
    return { workspaceId: fx.workspaceId, categoryId: cat.category.id, idempotencyKey: 'icd-1' };
  },

  price_lists_upsert: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Grosskunden',
    segment: 'key_account',
    idempotencyKey: 'plu-1',
  }),

  price_lists_set_price: (fx) => {
    const list = fx.call('price_lists_upsert', { name: 'Liste', segment: 'key_account', idempotencyKey: 'plsp-list' });
    const item = fx.call('create_item', { name: 'Artikel', defaultUnitPriceMinor: 5000, idempotencyKey: 'plsp-item' });
    return {
      workspaceId: fx.workspaceId,
      priceListId: list.priceList.id,
      itemId: item.item.id,
      priceMinor: 4200,
      validFrom: '2026-01-01',
      idempotencyKey: 'plsp-1',
    };
  },

  // The removals (F6). Both answer a COUNT of rows taken away rather than a bare ok, so the gate's
  // "two calls settle identically" claim is a claim about rows here and not only about the shape: a
  // replay under the same key returns the stored count, and a second row-level delete would have to
  // report a different one.
  price_lists_unset_price: (fx) => {
    const list = fx.call('price_lists_upsert', { name: 'Weg', segment: 'key_account', idempotencyKey: 'plup-list' });
    const item = fx.call('create_item', { name: 'Entfernt', defaultUnitPriceMinor: 5000, idempotencyKey: 'plup-item' });
    fx.call('price_lists_set_price', {
      priceListId: list.priceList.id,
      itemId: item.item.id,
      priceMinor: 4200,
      validFrom: '2026-01-01',
      idempotencyKey: 'plup-price',
    });
    return {
      workspaceId: fx.workspaceId,
      priceListId: list.priceList.id,
      itemId: item.item.id,
      idempotencyKey: 'plup-1',
    };
  },

  price_lists_delete: (fx) => {
    const list = fx.call('price_lists_upsert', { name: 'Aufgelöst', segment: 'retail', idempotencyKey: 'pld-list' });
    const item = fx.call('create_item', { name: 'Gelistet', defaultUnitPriceMinor: 5000, idempotencyKey: 'pld-item' });
    fx.call('price_lists_set_price', {
      priceListId: list.priceList.id,
      itemId: item.item.id,
      priceMinor: 4200,
      validFrom: '2026-01-01',
      idempotencyKey: 'pld-price',
    });
    return { workspaceId: fx.workspaceId, priceListId: list.priceList.id, idempotencyKey: 'pld-1' };
  },

  // --- B00, projects master --------------------------------------------------------------------
  // Each scenario seeds its own C00 contact (and project) through the real verbs, then the gate
  // double-calls the verb under test: the whole-database comparison is what proves a replay writes
  // nothing.

  project_create: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Projekt AG', idempotencyKey: 'prc-seed' });
    return {
      workspaceId: fx.workspaceId,
      name: 'Website Relaunch',
      contactId: c.contact.id,
      budgetMinor: 500000,
      budgetHours: 80,
      startsOn: '2026-08-01',
      endsOn: '2026-12-31',
      idempotencyKey: 'prc-1',
    };
  },

  project_update: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Umbau AG', idempotencyKey: 'pru-seed' });
    const p = fx.call('project_create', { name: 'Umbau', contactId: c.contact.id, idempotencyKey: 'pru-proj' });
    return {
      workspaceId: fx.workspaceId,
      projectId: p.project.id,
      patch: { budgetMinor: 250000, name: 'Umbau Erdgeschoss' },
      idempotencyKey: 'pru-1',
    };
  },

  project_set_status: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Status AG', idempotencyKey: 'prs-seed' });
    const p = fx.call('project_create', { name: 'Rollout', contactId: c.contact.id, idempotencyKey: 'prs-proj' });
    return { workspaceId: fx.workspaceId, projectId: p.project.id, status: 'active', idempotencyKey: 'prs-1' };
  },

  project_delete: (fx) => {
    // A DRAFT with nothing referencing it: the census passes, so the hard-delete succeeds and the
    // double call replays its stored result (nothing left to delete, no second erasure).
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Verworfen AG', idempotencyKey: 'prd-seed' });
    const p = fx.call('project_create', { name: 'Verworfen', contactId: c.contact.id, idempotencyKey: 'prd-proj' });
    return { workspaceId: fx.workspaceId, projectId: p.project.id, idempotencyKey: 'prd-1' };
  },

  project_phase_add: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Phase AG', idempotencyKey: 'ppa-seed' });
    const p = fx.call('project_create', { name: 'Etappen', contactId: c.contact.id, budgetMinor: 300000, idempotencyKey: 'ppa-proj' });
    return {
      workspaceId: fx.workspaceId,
      projectId: p.project.id,
      name: 'Konzept',
      sort: 1,
      budgetMinor: 100000,
      milestoneOn: '2026-09-30',
      idempotencyKey: 'ppa-1',
    };
  },

  project_phase_update: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Phasen Patch AG', idempotencyKey: 'ppu-seed' });
    const p = fx.call('project_create', { name: 'Patchbar', contactId: c.contact.id, idempotencyKey: 'ppu-proj' });
    const ph = fx.call('project_phase_add', { projectId: p.project.id, name: 'Bau', idempotencyKey: 'ppu-phase' });
    return {
      workspaceId: fx.workspaceId,
      phaseId: ph.phase.id,
      patch: { budgetMinor: 50000, sort: 2 },
      idempotencyKey: 'ppu-1',
    };
  },

  project_phase_done: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Meilenstein AG', idempotencyKey: 'ppd-seed' });
    const p = fx.call('project_create', { name: 'Fertig', contactId: c.contact.id, idempotencyKey: 'ppd-proj' });
    const ph = fx.call('project_phase_add', {
      projectId: p.project.id,
      name: 'Abnahme',
      milestoneOn: '2026-10-01',
      idempotencyKey: 'ppd-phase',
    });
    return { workspaceId: fx.workspaceId, phaseId: ph.phase.id, doneAt: '2026-10-02', idempotencyKey: 'ppd-1' };
  },

  // --- B01, time tracking ----------------------------------------------------------------------
  // Each scenario seeds its own world through the real verbs (a C00 contact, a B00 project, and a
  // default rate card, because time_start/time_log refuse with no_rate_defined until a card
  // exists), then the gate double-calls the verb under test.

  time_start: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Zeit AG', idempotencyKey: 'tst-seed' });
    const p = fx.call('project_create', { name: 'Zeiterfassung', contactId: c.contact.id, idempotencyKey: 'tst-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'tst-rate' });
    return { workspaceId: fx.workspaceId, userId: 'user-f', projectId: p.project.id, notes: 'Konzept', idempotencyKey: 'tst-1' };
  },

  time_stop: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Stopp AG', idempotencyKey: 'tsp-seed' });
    const p = fx.call('project_create', { name: 'Laufend', contactId: c.contact.id, idempotencyKey: 'tsp-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'tsp-rate' });
    const e = fx.call('time_start', { userId: 'user-f', projectId: p.project.id, idempotencyKey: 'tsp-start' });
    return { workspaceId: fx.workspaceId, entryId: e.entry.id, idempotencyKey: 'tsp-1' };
  },

  time_log: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Nachtrag AG', idempotencyKey: 'tlg-seed' });
    const p = fx.call('project_create', { name: 'Nachtrag', contactId: c.contact.id, idempotencyKey: 'tlg-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 18000, validFrom: '2026-01-01', idempotencyKey: 'tlg-rate' });
    return {
      workspaceId: fx.workspaceId,
      userId: 'user-g',
      projectId: p.project.id,
      startedAt: '2026-07-10T09:00:00.000Z',
      minutes: 90,
      billable: true,
      notes: 'Sitzung',
      idempotencyKey: 'tlg-1',
    };
  },

  time_update: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Korrektur AG', idempotencyKey: 'tup-seed' });
    const p = fx.call('project_create', { name: 'Korrigierbar', contactId: c.contact.id, idempotencyKey: 'tup-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'tup-rate' });
    const e = fx.call('time_log', {
      userId: 'user-g',
      projectId: p.project.id,
      startedAt: '2026-07-09T08:00:00.000Z',
      minutes: 60,
      idempotencyKey: 'tup-log',
    });
    return { workspaceId: fx.workspaceId, entryId: e.entry.id, patch: { minutes: 75, notes: 'korrigiert' }, idempotencyKey: 'tup-1' };
  },

  time_delete: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Streichung AG', idempotencyKey: 'tde-seed' });
    const p = fx.call('project_create', { name: 'Gestrichen', contactId: c.contact.id, idempotencyKey: 'tde-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'tde-rate' });
    const e = fx.call('time_log', {
      userId: 'user-g',
      projectId: p.project.id,
      startedAt: '2026-07-08T08:00:00.000Z',
      minutes: 30,
      idempotencyKey: 'tde-log',
    });
    return { workspaceId: fx.workspaceId, entryId: e.entry.id, idempotencyKey: 'tde-1' };
  },

  time_submit: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Einreichung AG', idempotencyKey: 'tsu-seed' });
    const p = fx.call('project_create', { name: 'Einreichbar', contactId: c.contact.id, idempotencyKey: 'tsu-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'tsu-rate' });
    fx.call('time_log', {
      userId: 'user-g',
      projectId: p.project.id,
      startedAt: '2026-07-07T08:00:00.000Z',
      minutes: 120,
      idempotencyKey: 'tsu-log',
    });
    return { workspaceId: fx.workspaceId, period: '2026-07', idempotencyKey: 'tsu-1' };
  },

  time_approve: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Freigabe AG', idempotencyKey: 'tap-seed' });
    const p = fx.call('project_create', { name: 'Freigebbar', contactId: c.contact.id, idempotencyKey: 'tap-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'tap-rate' });
    fx.call('time_log', {
      userId: 'user-g',
      projectId: p.project.id,
      startedAt: '2026-07-06T08:00:00.000Z',
      minutes: 45,
      idempotencyKey: 'tap-log',
    });
    const s = fx.call('time_submit', { period: '2026-07', idempotencyKey: 'tap-submit' });
    return { workspaceId: fx.workspaceId, entryIds: s.entryIds, idempotencyKey: 'tap-1' };
  },

  time_lock: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Sperrung AG', idempotencyKey: 'tlk-seed' });
    const p = fx.call('project_create', { name: 'Sperrbar', contactId: c.contact.id, idempotencyKey: 'tlk-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'tlk-rate' });
    fx.call('time_log', {
      userId: 'user-g',
      projectId: p.project.id,
      startedAt: '2026-07-05T08:00:00.000Z',
      minutes: 60,
      idempotencyKey: 'tlk-log',
    });
    const s = fx.call('time_submit', { period: '2026-07', idempotencyKey: 'tlk-submit' });
    fx.call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'tlk-approve' });
    return { workspaceId: fx.workspaceId, period: '2026-07', idempotencyKey: 'tlk-1' };
  },

  rate_card_upsert: (fx) => ({
    workspaceId: fx.workspaceId,
    scope: 'default',
    rateMinor: 15000,
    currency: 'CHF',
    validFrom: '2026-01-01',
    idempotencyKey: 'rcu-1',
  }),

  rate_card_end: (fx) => {
    const card = fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'rce-seed' });
    return { workspaceId: fx.workspaceId, rateCardId: card.rateCard.id, validTo: '2026-12-31', idempotencyKey: 'rce-1' };
  },

  // --- B02, time -> billing --------------------------------------------------------------------
  // Each scenario seeds its own world through the real verbs (a C00 contact, a B00 project, a
  // default rate card, then logs, submits and approves one hour), because generation reads only
  // approved+billable+unbilled entries. The gate then double-calls the verb under test: generation
  // replays to the same draft (no second invoice, no second flip), release replays to a no-op.
  billing_generate_invoice: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Faktura Zeit AG', idempotencyKey: 'bgi-contact' });
    const p = fx.call('project_create', { name: 'Verrechenbar', contactId: c.contact.id, idempotencyKey: 'bgi-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'bgi-rate' });
    fx.call('time_log', { userId: 'user-f', projectId: p.project.id, startedAt: '2026-07-06T08:00:00.000Z', minutes: 90, idempotencyKey: 'bgi-log' });
    const s = fx.call('time_submit', { period: '2026-07', idempotencyKey: 'bgi-submit' });
    const a = fx.call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'bgi-approve' });
    return { workspaceId: fx.workspaceId, contactId: c.contact.id, timeEntryIds: a.approvedEntryIds, idempotencyKey: 'bgi-1' };
  },

  billing_release_time: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Freigabe Zeit AG', idempotencyKey: 'brt-contact' });
    const p = fx.call('project_create', { name: 'Freigebbar Zeit', contactId: c.contact.id, idempotencyKey: 'brt-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'brt-rate' });
    fx.call('time_log', { userId: 'user-f', projectId: p.project.id, startedAt: '2026-07-05T08:00:00.000Z', minutes: 60, idempotencyKey: 'brt-log' });
    const s = fx.call('time_submit', { period: '2026-07', idempotencyKey: 'brt-submit' });
    const a = fx.call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'brt-approve' });
    const inv = fx.call('billing_generate_invoice', { contactId: c.contact.id, timeEntryIds: a.approvedEntryIds, idempotencyKey: 'brt-gen' });
    return { workspaceId: fx.workspaceId, invoiceId: inv.invoiceId, idempotencyKey: 'brt-1' };
  },

  // --- B04, retainers & mandates ---------------------------------------------------------------
  // Each scenario seeds its own world through the real verbs (a C00 contact, a B00 project, a default
  // rate card, then June time logged/submitted/approved), because generation reads only ended-period
  // approved+billable+unbilled entries. The fixture clock is 2026-07-16, so period 2026-06 has ended.
  // The gate double-calls: create/update/close/generate replay to the same row/draft via their key,
  // and run_due is idempotent per period via the fee-draw guard (a second tick generates nothing).
  retainer_create: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Mandat AG', idempotencyKey: 'rc-contact' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      period: 'monthly',
      feeRappen: 250000,
      includedHours: 10,
      capRappen: 400000,
      rollover: true,
      startsOn: '2026-01-01',
      idempotencyKey: 'rc-1',
    };
  },

  retainer_update: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Korrektur Mandat AG', idempotencyKey: 'rmu-contact' });
    const r = fx.call('retainer_create', {
      contactId: c.contact.id,
      period: 'monthly',
      feeRappen: 200000,
      includedHours: 8,
      rollover: false,
      startsOn: '2026-01-01',
      idempotencyKey: 'rmu-ret',
    });
    return { workspaceId: fx.workspaceId, retainerId: r.retainer.id, patch: { feeRappen: 300000, rollover: true }, idempotencyKey: 'rmu-1' };
  },

  retainer_close: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Ende Mandat AG', idempotencyKey: 'rcl-contact' });
    // starts_on in the CURRENT month (2026-07): no period has ended at the fixture clock, so there is
    // no pending period and close succeeds without skipFinal.
    const r = fx.call('retainer_create', {
      contactId: c.contact.id,
      period: 'monthly',
      feeRappen: 180000,
      includedHours: 5,
      rollover: false,
      startsOn: '2026-07-01',
      idempotencyKey: 'rcl-ret',
    });
    return { workspaceId: fx.workspaceId, retainerId: r.retainer.id, idempotencyKey: 'rcl-1' };
  },

  retainer_generate_invoice: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Faktura Mandat AG', idempotencyKey: 'rg-contact' });
    const p = fx.call('project_create', { name: 'Mandat Projekt', contactId: c.contact.id, idempotencyKey: 'rg-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'rg-rate' });
    fx.call('time_log', { userId: 'user-f', projectId: p.project.id, startedAt: '2026-06-10T08:00:00.000Z', minutes: 120, idempotencyKey: 'rg-log' });
    const s = fx.call('time_submit', { period: '2026-06', idempotencyKey: 'rg-submit' });
    fx.call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'rg-approve' });
    const r = fx.call('retainer_create', {
      contactId: c.contact.id,
      projectId: p.project.id,
      period: 'monthly',
      feeRappen: 250000,
      includedHours: 1,
      capRappen: 20000,
      rollover: false,
      startsOn: '2026-06-01',
      idempotencyKey: 'rg-ret',
    });
    return { workspaceId: fx.workspaceId, retainerId: r.retainer.id, periodKey: '2026-06', idempotencyKey: 'rg-1' };
  },

  retainer_run_due: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Faellig Mandat AG', idempotencyKey: 'rd-contact' });
    const p = fx.call('project_create', { name: 'Faellig Projekt', contactId: c.contact.id, idempotencyKey: 'rd-proj' });
    fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: 'rd-rate' });
    fx.call('time_log', { userId: 'user-f', projectId: p.project.id, startedAt: '2026-06-12T08:00:00.000Z', minutes: 60, idempotencyKey: 'rd-log' });
    const s = fx.call('time_submit', { period: '2026-06', idempotencyKey: 'rd-submit' });
    fx.call('time_approve', { entryIds: s.entryIds, idempotencyKey: 'rd-approve' });
    fx.call('retainer_create', {
      contactId: c.contact.id,
      projectId: p.project.id,
      period: 'monthly',
      feeRappen: 200000,
      includedHours: 2,
      rollover: false,
      startsOn: '2026-06-01',
      idempotencyKey: 'rd-ret',
    });
    return { workspaceId: fx.workspaceId, asOf: '2026-07-16' };
  },

  // --- F01, report builder ---------------------------------------------------------------------
  // Every scenario composes the always-present `contacts` source, so none needs a seeded ledger: a
  // saved report holds a QUERY, not a figure. The gate re-calls each verb with the identical input and
  // proves the write happened once (§H-IDEMPOTENT via the store's idempotency table).
  reports_save: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Kontaktliste',
    source: 'contacts',
    columns: ['name', 'email'],
    idempotencyKey: 'f01-save-1',
  }),
  reports_update: (fx) => {
    const r = fx.call('reports_save', { name: 'Kontakte', source: 'contacts', columns: ['name'], idempotencyKey: 'f01-upd-save' });
    return { workspaceId: fx.workspaceId, reportId: r.report.id, patch: { name: 'Kontakte v2', columns: ['name', 'email'] }, idempotencyKey: 'f01-upd-1' };
  },
  reports_duplicate: (fx) => {
    const r = fx.call('reports_save', { name: 'Kontakte', source: 'contacts', columns: ['name'], idempotencyKey: 'f01-dup-save' });
    return { workspaceId: fx.workspaceId, reportId: r.report.id, idempotencyKey: 'f01-dup-1' };
  },
  reports_delete: (fx) => {
    const r = fx.call('reports_save', { name: 'Wegwerf', source: 'contacts', columns: ['name'], idempotencyKey: 'f01-del-save' });
    return { workspaceId: fx.workspaceId, reportId: r.report.id, idempotencyKey: 'f01-del-1' };
  },
  reports_run: (fx) => {
    const r = fx.call('reports_save', { name: 'Lauf', source: 'contacts', columns: ['name', 'email'], idempotencyKey: 'f01-run-save' });
    return { workspaceId: fx.workspaceId, reportId: r.report.id, idempotencyKey: 'f01-run-1' };
  },
  reports_schedule: (fx) => {
    const r = fx.call('reports_save', { name: 'Plan', source: 'contacts', columns: ['name'], idempotencyKey: 'f01-sch-save' });
    return { workspaceId: fx.workspaceId, reportId: r.report.id, schedule: { freq: 'monthly', at: '08:00', dayOfMonth: 1 }, idempotencyKey: 'f01-sch-1' };
  },

  // --- D01, inventory / stock ------------------------------------------------------------------
  // The valuation and commit scenarios lean on the KMU seed's 1200/4200 accounts (present from
  // create_workspace) and on the shared `stockSeed` helper (item + location + one receipt).
  stock_location_upsert: (fx) => ({ workspaceId: fx.workspaceId, name: 'Hauptlager', type: 'warehouse', idempotencyKey: 'sloc-1' }),
  stock_move: (fx) => {
    const s = stockSeed(fx, 'smv');
    return {
      workspaceId: fx.workspaceId,
      itemId: s.itemId,
      locationId: s.locationId,
      qty: 7,
      reason: 'receipt',
      unitCostMinor: 2000,
      movedAt: '2026-03-02',
      idempotencyKey: 'smv-1',
    };
  },
  stock_run_valuation: (fx) => {
    stockSeed(fx, 'sval');
    return { workspaceId: fx.workspaceId, method: 'weighted_avg', asOf: '2026-03-31', idempotencyKey: 'sval-1' };
  },
  stock_stocktake_open: (fx) => {
    stockSeed(fx, 'sto');
    return { workspaceId: fx.workspaceId, frozenAt: '2026-03-31', idempotencyKey: 'sto-1' };
  },
  stock_stocktake_count: (fx) => {
    stockSeed(fx, 'stc');
    const st = fx.call('stock_stocktake_open', { frozenAt: '2026-03-31', idempotencyKey: 'stc-open' });
    const ln = st.lines[0];
    return { workspaceId: fx.workspaceId, sessionId: st.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: 8 };
  },
  stock_stocktake_commit: (fx) => {
    stockSeed(fx, 'stcom');
    const st = fx.call('stock_stocktake_open', { frozenAt: '2026-03-31', idempotencyKey: 'stcom-open' });
    const ln = st.lines[0];
    fx.call('stock_stocktake_count', { sessionId: st.session.id, itemId: ln.item_id, locationId: ln.location_id, countedQty: ln.book_qty - 1 });
    return { workspaceId: fx.workspaceId, sessionId: st.session.id, idempotencyKey: 'stcom-1' };
  },

  // --- A10, document lifecycle -----------------------------------------------------------------
  create_document: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Beleg AG', idempotencyKey: 'crd-contact' });
    return {
      workspaceId: fx.workspaceId,
      type: 'quote',
      contactId: c.contact.id,
      lines: [{ description: 'Beratung', unitPriceMinor: 15000 }],
      idempotencyKey: 'crd-1',
    };
  },

  update_document: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Patch Beleg AG', idempotencyKey: 'ud-contact' });
    const doc = fx.call('create_document', {
      type: 'quote',
      contactId: c.contact.id,
      lines: [{ unitPriceMinor: 15000 }],
      idempotencyKey: 'ud-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      documentId: doc.document.id,
      patch: { notes: 'Zweite Fassung' },
      idempotencyKey: 'ud-1',
    };
  },

  // A quote issue posts nothing (no delegate needed), so it is the safe write to exercise the
  // transition verb: it succeeds and replays cleanly without an A11 poster registered.
  transition_document: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Übergang AG', idempotencyKey: 'td-contact' });
    const doc = fx.call('create_document', {
      type: 'quote',
      contactId: c.contact.id,
      lines: [{ unitPriceMinor: 15000 }],
      idempotencyKey: 'td-seed',
    });
    return { workspaceId: fx.workspaceId, documentId: doc.document.id, to: 'issued', idempotencyKey: 'td-1' };
  },

  convert_document: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Wandel AG', idempotencyKey: 'cd-contact' });
    const doc = fx.call('create_document', {
      type: 'quote',
      contactId: c.contact.id,
      lines: [{ unitPriceMinor: 15000 }],
      idempotencyKey: 'cd-seed-create',
    });
    fx.call('transition_document', { documentId: doc.document.id, to: 'issued', idempotencyKey: 'cd-seed-issue' });
    fx.call('transition_document', { documentId: doc.document.id, to: 'sent', idempotencyKey: 'cd-seed-send' });
    fx.call('transition_document', { documentId: doc.document.id, to: 'accepted', idempotencyKey: 'cd-seed-accept' });
    return { workspaceId: fx.workspaceId, documentId: doc.document.id, toType: 'order', idempotencyKey: 'cd-1' };
  },

  // A11: issue_invoice POSTS, so its scenario seeds a fully configured workspace (VAT + creditor) and a
  // customer + an invoice draft, then issues. The twice-called gate then proves the invoice entry is
  // posted exactly once (§H-IDEMPOTENT on ROWS): the replay returns the same number and touches nothing.
  issue_invoice: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    fx.call('set_creditor_profile', {
      creditorName: 'Conformance GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    });
    const c = fx.call('create_contact', {
      partyRole: 'customer',
      name: 'Rechnung AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'billing@rechnung.example',
      idempotencyKey: 'ii-contact',
    });
    const doc = fx.call('create_document', {
      type: 'invoice',
      contactId: c.contact.id,
      currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'ii-doc',
    });
    return { workspaceId: fx.workspaceId, invoiceId: doc.document.id, idempotencyKey: 'ii-1' };
  },

  // A11: send_invoice is the outbound step. The scenario issues an invoice, configures a local relay,
  // and confirms (P8, M15), so the first call transitions to `sent`; the replay is a clean no-op.
  send_invoice: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    // The creditor profile, exactly as `issue_invoice` above already seeds it. Without it the
    // workspace has no QR-IBAN, so the invoice this scenario mails carries NO payment part: the
    // customer cannot pay it. That used to send anyway (with "kein IBAN konfiguriert" printed on
    // the PDF as the reason for every QR failure, true or not), so the gate was proving the
    // idempotency of a send that should never have happened. `send_invoice` now refuses an invoice
    // with no payment part, which makes the missing profile here a fixture defect, not a contract
    // change to absorb.
    fx.call('set_creditor_profile', {
      creditorName: 'Conformance GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    });
    const c = fx.call('create_contact', {
      partyRole: 'customer',
      name: 'Versand AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'billing@versand.example',
      idempotencyKey: 'si-contact',
    });
    const doc = fx.call('create_document', {
      type: 'invoice',
      contactId: c.contact.id,
      currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'si-doc',
    });
    fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'si-issue' });
    // A real transport, injected into the deps the gate calls with, so the fixture's transport is
    // VISIBLE here. This line used to be `UPDATE workspace SET email_relay = 'local'`, which reached
    // a stub that returned `{ok:true}` without sending anything: the gate was then proving the
    // idempotency of a transmission that never happened. `workspace.email_relay` names a mode, it is
    // not a transport, and nothing in the MIT core is.
    fx.deps.emailRelay = recordingRelay();
    return {
      workspaceId: fx.workspaceId,
      invoiceId: doc.document.id,
      email: 'billing@versand.example',
      confirmed: true,
      idempotencyKey: 'si-1',
    };
  },

  // --- A32, eBill issuing ----------------------------------------------------------------------
  // `set_ebill_config` asserts an absolute state (naturally idempotent, key-exempt below); the two
  // moving writes prove the delivery machine. `ebill_prepare` seeds an ISSUED invoice through A11's
  // own verbs and proves one active delivery per invoice: the second call returns the existing row and
  // writes nothing. `ebill_transmit` proves the honest OP4 degradation: with NO connector wired into
  // `fx.deps`, transmit returns `ok:true, {transmitted:false, reason:'cloud_tier'}` and touches no row,
  // so the double call is a clean no-op. The conformant-transmit path (mock connector + a PDF/A-3b
  // payload) is exercised in `test/sales/ebill.test.mjs`, not here: the gate's minimal fixture renders
  // through the real `renderInvoicePdf` (pdfaProfile null, A32-OI1 deferred), which is exactly why the
  // PDF/A-3b hard gate lives at transmit and prepare merely RECORDS the fact (spec reconciliation).
  set_ebill_config: (fx) => ({ workspaceId: fx.workspaceId, billerPid: '41000000000000000' }),

  ebill_prepare: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    fx.call('set_creditor_profile', {
      creditorName: 'eBill Conformance GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    });
    const c = fx.call('create_contact', {
      partyRole: 'customer',
      name: 'eBill AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'billing@ebill.example',
      idempotencyKey: 'eb-contact',
    });
    const doc = fx.call('create_document', {
      type: 'invoice',
      contactId: c.contact.id,
      currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'eb-doc',
    });
    fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'eb-issue' });
    return { workspaceId: fx.workspaceId, invoiceId: doc.document.id, idempotencyKey: 'eb-1' };
  },

  ebill_transmit: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    fx.call('set_creditor_profile', {
      creditorName: 'eBill Transmit GmbH',
      address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
      qrIban: 'CH4431999123000889012',
    });
    const c = fx.call('create_contact', {
      partyRole: 'customer',
      name: 'eBill Versand AG',
      address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
      email: 'billing@ebill-versand.example',
      idempotencyKey: 'et-contact',
    });
    const doc = fx.call('create_document', {
      type: 'invoice',
      contactId: c.contact.id,
      currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'et-doc',
    });
    fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'et-issue' });
    const prepared = fx.call('ebill_prepare', { invoiceId: doc.document.id, idempotencyKey: 'et-prep' });
    return { workspaceId: fx.workspaceId, deliveryId: prepared.delivery.id, idempotencyKey: 'et-1' };
  },


  // --- A12, recurring invoices -----------------------------------------------------------------
  // The schedule is CONFIG; the money moves when the tick invokes create_document / issue_invoice
  // through the shared dispatch. So `create` proves one schedule per key, the four state-setters
  // prove absolute-state replay, and `run_due_recurring` proves the property the capability exists
  // for: the second identical tick generates NOTHING, because the first one advanced the cursor and
  // every occurrence's derived key already settled.

  create_recurring_schedule: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Serie AG', idempotencyKey: 'crs-contact' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      lines: [{ description: 'Beratung monatlich', unitPriceMinor: 200000 }],
      interval: 'monthly',
      anchorDate: '2026-08-01',
      idempotencyKey: 'crs-1',
    };
  },

  update_recurring_schedule: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Patch Serie AG', idempotencyKey: 'urs-contact' });
    const created = fx.call('create_recurring_schedule', {
      contactId: c.contact.id,
      lines: [{ description: 'Retainer', unitPriceMinor: 150000 }],
      interval: 'monthly',
      anchorDate: '2026-08-01',
      idempotencyKey: 'urs-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      scheduleId: created.schedule.id,
      patch: { name: 'Retainer, angepasst', notes: 'Zweite Fassung' },
    };
  },

  pause_recurring_schedule: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Pause Serie AG', idempotencyKey: 'prs-contact' });
    const created = fx.call('create_recurring_schedule', {
      contactId: c.contact.id,
      lines: [{ unitPriceMinor: 100000 }],
      interval: 'monthly',
      anchorDate: '2026-08-01',
      idempotencyKey: 'prs-seed',
    });
    return { workspaceId: fx.workspaceId, scheduleId: created.schedule.id };
  },

  resume_recurring_schedule: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Weiter Serie AG', idempotencyKey: 'rrs-contact' });
    const created = fx.call('create_recurring_schedule', {
      contactId: c.contact.id,
      lines: [{ unitPriceMinor: 100000 }],
      interval: 'monthly',
      anchorDate: '2026-08-01',
      idempotencyKey: 'rrs-seed',
    });
    fx.call('pause_recurring_schedule', { scheduleId: created.schedule.id });
    return { workspaceId: fx.workspaceId, scheduleId: created.schedule.id };
  },

  end_recurring_schedule: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Ende Serie AG', idempotencyKey: 'ers-contact' });
    const created = fx.call('create_recurring_schedule', {
      contactId: c.contact.id,
      lines: [{ unitPriceMinor: 100000 }],
      interval: 'monthly',
      anchorDate: '2026-08-01',
      idempotencyKey: 'ers-seed',
    });
    return { workspaceId: fx.workspaceId, scheduleId: created.schedule.id };
  },

  // A TICK WITH A REAL DUE SCHEDULE, the run_due_automations shape: the anchor sits on the fixture
  // clock's own day (2026-07-16), so the first call drafts exactly one invoice and advances the
  // cursor past asOf; the second call selects nothing and writes nothing.
  run_due_recurring: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Tick Serie AG', idempotencyKey: 'rdr-contact' });
    fx.call('create_recurring_schedule', {
      contactId: c.contact.id,
      lines: [{ description: 'Beratung', unitPriceMinor: 200000 }],
      interval: 'monthly',
      anchorDate: '2026-07-16',
      idempotencyKey: 'rdr-seed',
    });
    return { workspaceId: fx.workspaceId, asOf: '2026-07-16T09:00:00.000Z' };
  },

  // --- A13, credit notes -----------------------------------------------------------------------
  // create_credit_note derives a DRAFT from an issued invoice; the twice-called gate proves the
  // replay returns the same draft and mints no second document.
  create_credit_note: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Gutschrift AG', idempotencyKey: 'ccn-contact' });
    const doc = fx.call('create_document', {
      type: 'invoice',
      contactId: c.contact.id,
      currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'ccn-doc',
    });
    fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'ccn-issue-inv' });
    return { workspaceId: fx.workspaceId, fromInvoiceId: doc.document.id, idempotencyKey: 'ccn-1' };
  },

  // issue_credit_note POSTS the mirror entry, so the twice-called gate proves §H-IDEMPOTENT on
  // ROWS: the replay returns the same G-number and the journal grows by nothing.
  issue_credit_note: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Storno AG', idempotencyKey: 'icn-contact' });
    const doc = fx.call('create_document', {
      type: 'invoice',
      contactId: c.contact.id,
      currency: 'CHF',
      lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
      idempotencyKey: 'icn-doc',
    });
    fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: 'icn-issue-inv' });
    const cn = fx.call('create_credit_note', { fromInvoiceId: doc.document.id, idempotencyKey: 'icn-cn' });
    return { workspaceId: fx.workspaceId, creditNoteId: cn.document.id, idempotencyKey: 'icn-1' };
  },

  // --- A19 / §H-FX, exchange rates -------------------------------------------------------------
  // The rate is a DECIMAL STRING and is the price of one unit of `baseCurrency` in the workspace
  // base currency: EUR/CHF 0.9412 means 1 EUR = 0.9412 CHF. `method` names the admissible MWSTV
  // Art. 45 basis. Recording the same rate twice must leave ONE row, which is exactly what the
  // gate's double-call comparison checks.
  record_exchange_rate: (fx) => ({
    workspaceId: fx.workspaceId,
    baseCurrency: 'EUR',
    rate: '0.9412',
    asOf: '2026-07-16',
    source: 'manual',
    method: 'daily',
    provenance: 'ESTV Tageskurs Verkauf (MWSTV Art. 45 Abs. 3)',
    idempotencyKey: 'fxr-1',
  }),

  // --- §H-FX, the MWSTV Art. 45 Abs. 5 method lock ---------------------------------------------
  // Electing the conversion basis for a Steuerperiode (a calendar year, MWSTG Art. 34 Abs. 2). The
  // gate's double call re-asserts the SAME election, which by construction writes nothing the second
  // time: that is what makes the key exemption below a tested claim rather than a comment.
  set_fx_method: (fx) => ({ workspaceId: fx.workspaceId, method: 'daily', taxPeriod: '2026' }),

  // --- §H-FX, the ESTV/BAZG rate feed ----------------------------------------------------------
  // The payload is a REAL captured BAZG "Devisenkurse (Verkauf)" document, the series the ESTV names
  // as the MWST Tageskurs. Two currencies keep the gate's whole-database comparison cheap; what it
  // proves is the thing that matters, that a re-delivered feed import writes each rate ONCE.
  import_exchange_rates: (fx) => ({
    workspaceId: fx.workspaceId,
    payload: BAZG_DAILY_PAYLOAD,
    series: 'daily',
    currencies: ['EUR', 'USD'],
    idempotencyKey: 'imp-1',
  }),

  // --- A22, FX revaluation -----------------------------------------------------------------------
  // post_fx_revaluation POSTS the period-end unrealised gain/loss AND its next-period reversal, so the
  // gate's double call is doing its most valuable work: a period end revalued twice under one key must
  // leave exactly ONE revaluation entry, ONE reversal and ONE fx_revaluation run row, and the
  // comparison is against every row of every table. The setup seeds a EUR asset position booked at
  // 0.9600 and the 30.06 closing rate 0.9520, so the revaluation is a real, non-zero unrealised loss
  // rather than a no-op the double call could not tell from a broken verb.
  post_fx_revaluation: (fx) => {
    fx.call('record_exchange_rate', {
      baseCurrency: 'EUR',
      rate: '0.9520',
      asOf: '2026-06-30',
      source: 'manual',
      method: 'daily',
      idempotencyKey: 'fxrv-rate',
    });
    fx.call('post_entry', {
      date: '2026-06-15',
      source: 'manual',
      currency: 'EUR',
      fxRate: '0.9600',
      description: 'EUR-Position',
      idempotencyKey: 'fxrv-pos',
      lines: [
        { account: fx.accId('1000'), debit: 1000000 },
        { account: fx.accId('3200'), credit: 1000000 },
      ],
    });
    return { workspaceId: fx.workspaceId, periodEnd: '2026-06-30', idempotencyKey: 'fxrv-1' };
  },
  // fx_revaluation_reverse (D129 Q2) books the MIRROR PAIR of a posted run (the Storno dated the
  // period end and its own next-day reversal), so the double call must leave exactly one Storno, one
  // Storno reversal and one run row carrying the link. The seed is the post scenario's world, posted.
  fx_revaluation_reverse: (fx) => {
    fx.call('record_exchange_rate', {
      baseCurrency: 'EUR',
      rate: '0.9520',
      asOf: '2026-06-30',
      source: 'manual',
      method: 'daily',
      idempotencyKey: 'fxrr-rate',
    });
    fx.call('post_entry', {
      date: '2026-06-15',
      source: 'manual',
      currency: 'EUR',
      fxRate: '0.9600',
      description: 'EUR-Position',
      idempotencyKey: 'fxrr-pos',
      lines: [
        { account: fx.accId('1000'), debit: 1000000 },
        { account: fx.accId('3200'), credit: 1000000 },
      ],
    });
    const posted = fx.call('post_fx_revaluation', { periodEnd: '2026-06-30', idempotencyKey: 'fxrr-post' });
    if (posted.ok !== true || posted.runId === null) throw new Error(`fx_revaluation_reverse seed: ${JSON.stringify(posted)}`);
    return { workspaceId: fx.workspaceId, runId: posted.runId, idempotencyKey: 'fxrr-1' };
  },

  // --- A38, Abgrenzungen und Rückstellungen --------------------------------------------------------
  // accrual_post POSTS a PAIR (the accrual dated period end AND its next-period reversal) in one
  // transaction, and accrual_reverse posts the mirror pair, so the double call is doing its most
  // valuable work: an accrual posted twice under one key must leave exactly TWO entries, and a Storno
  // replayed must leave exactly FOUR, compared against every row of every table. The provision verbs
  // post one entry each; a release replayed must leave ONE release row and ONE entry.
  accrual_create: (fx) => ({
    workspaceId: fx.workspaceId,
    kind: 'accrued_expense',
    periodEnd: '2026-06-30',
    amountMinor: 180000,
    contraAccount: '6500',
    description: 'Strom Juni, Rechnung im Juli',
    idempotencyKey: 'acc-create-1',
  }),
  accrual_post: (fx) => {
    const draft = fx.call('accrual_create', accrualDraft(fx, 'acc-post-seed'));
    return { workspaceId: fx.workspaceId, accrualId: draft.accrual.id, idempotencyKey: 'acc-post-1' };
  },
  accrual_reverse: (fx) => {
    const draft = fx.call('accrual_create', accrualDraft(fx, 'acc-rev-seed'));
    fx.call('accrual_post', { accrualId: draft.accrual.id, idempotencyKey: 'acc-rev-post' });
    return { workspaceId: fx.workspaceId, accrualId: draft.accrual.id, reason: 'Rechnung kam doch im Juni', idempotencyKey: 'acc-rev-1' };
  },
  accrual_discard: (fx) => {
    const draft = fx.call('accrual_create', accrualDraft(fx, 'acc-disc-seed'));
    return { workspaceId: fx.workspaceId, accrualId: draft.accrual.id, reason: 'doppelt erfasst', idempotencyKey: 'acc-disc-1' };
  },
  provision_create: (fx) => ({
    workspaceId: fx.workspaceId,
    reason: 'garantie',
    periodEnd: '2026-06-30',
    amountMinor: 500000,
    provisionAccount: '2330',
    expenseAccount: '6800',
    description: 'Garantiefälle Halbjahr 2026',
    idempotencyKey: 'prov-create-1',
  }),
  provision_post: (fx) => {
    const draft = fx.call('provision_create', provisionDraft(fx, 'prov-post-seed'));
    return { workspaceId: fx.workspaceId, provisionId: draft.provision.id, idempotencyKey: 'prov-post-1' };
  },
  provision_release: (fx) => {
    const draft = fx.call('provision_create', provisionDraft(fx, 'prov-rel-seed'));
    fx.call('provision_post', { provisionId: draft.provision.id, idempotencyKey: 'prov-rel-post' });
    return {
      workspaceId: fx.workspaceId,
      provisionId: draft.provision.id,
      date: '2026-07-10',
      amountMinor: 200000,
      targetAccount: '6800',
      idempotencyKey: 'prov-rel-1',
    };
  },
  provision_reverse: (fx) => {
    const draft = fx.call('provision_create', provisionDraft(fx, 'prov-rev-seed'));
    fx.call('provision_post', { provisionId: draft.provision.id, idempotencyKey: 'prov-rev-post' });
    return { workspaceId: fx.workspaceId, provisionId: draft.provision.id, reason: 'Fall erledigt', idempotencyKey: 'prov-rev-1' };
  },
  provision_release_reverse: (fx) => {
    const draft = fx.call('provision_create', provisionDraft(fx, 'prov-rr-seed'));
    fx.call('provision_post', { provisionId: draft.provision.id, idempotencyKey: 'prov-rr-post' });
    const release = fx.call('provision_release', {
      provisionId: draft.provision.id,
      date: '2026-07-10',
      amountMinor: 200000,
      targetAccount: '6800',
      idempotencyKey: 'prov-rr-rel',
    });
    return { workspaceId: fx.workspaceId, releaseId: release.releaseId, reason: 'zu früh aufgelöst', idempotencyKey: 'prov-rr-1' };
  },
  provision_discard: (fx) => {
    const draft = fx.call('provision_create', provisionDraft(fx, 'prov-disc-seed'));
    return { workspaceId: fx.workspaceId, provisionId: draft.provision.id, reason: 'doppelt erfasst', idempotencyKey: 'prov-disc-1' };
  },

  // --- A14, payments and matching ----------------------------------------------------------------
  // These three verbs are the settlement half of the money path, so the gate's double-call is doing
  // its most valuable work here: a payment recorded twice under one key must leave ONE payment, ONE
  // allocation and ONE journal entry, and the comparison is against every row of every table.
  //
  // Each write also carries an explicit `intent` (owner decision P9). That is not ceremony for the
  // gate's benefit: it is the contract, and a scenario that could omit it would mean the contract
  // was not really there.

  // THE WRITE SHAPE THIS INCREMENT ADDS (A14's `dunning_fee` allocation target, closing the gap
  // recorded in A15 §4 per D59): one `record_payment` call allocates against a `documentId` AND a
  // `dunningItemId` together, so a customer paying the invoice plus its own booked Mahngebühr closes
  // both in a SINGLE posting instead of the invoice alone. The seed books a real level-1 fee through
  // A15's own verbs (never faked into the tables directly), so the gate's double-call proves the
  // WHOLE shape: one payment, two allocation rows, one balanced entry, replayed exactly once.
  record_payment: (fx) => {
    const documentId = seedOverdueInvoice(fx, 'rp');
    fx.call('set_dunning_config', {
      levels: [
        {
          level: 1,
          daysOverdue: 10,
          feeMinor: 3000,
          bookFee: true,
          feeIncomeAccountId: fx.accId('3200'),
          showInterest: true,
          interestBp: 500,
        },
        { level: 2, daysOverdue: 20, feeMinor: 0 },
        { level: 3, daysOverdue: 30, feeMinor: 0 },
      ],
      idempotencyKey: 'rp-dunning-cfg',
    });
    const proposed = fx.call('propose_dunning_run', { idempotencyKey: 'rp-dunning-propose' });
    const issued = fx.call('issue_dunning_run', {
      runId: proposed.runId,
      confirmed: true,
      idempotencyKey: 'rp-dunning-issue',
    });
    const item = issued.items.find((i) => i.documentId === documentId);
    return {
      workspaceId: fx.workspaceId,
      direction: 'incoming',
      date: '2026-07-16',
      // The canonical invoice (net CHF 1'000.00 plus 8.1% MWST 81.00 = gross CHF 1'081.00) plus its
      // own booked Mahngebühr, CHF 30.00.
      amountMinor: 108100 + 3000,
      bankAccountId: fx.accId('1020'),
      allocations: [
        { documentId, amountMinor: 108100 },
        { dunningItemId: item.id, amountMinor: 3000 },
      ],
      intent: 'post_payment',
      idempotencyKey: 'rp-1',
    };
  },

  // A Guthaben parked by an over-payment, then allocated to a second open invoice. `allocate_payment`
  // posts NO entry (the money was booked when it arrived), so the replay comparison here is about
  // the allocation rows and the derived document statuses, not about the journal.
  allocate_payment: (fx) => {
    const first = issuedInvoice(fx, 'ap1');
    // The SAME customer's second open invoice (D80's X1 guard refuses a Guthaben parked for one
    // counterparty being allocated to a different one's document, and this scenario's own comment
    // is exactly that: "a Guthaben parked by an over-payment, then allocated to a second open
    // invoice", not a stranger's).
    const second = issuedInvoice(fx, 'ap2', first.contactId);
    const paid = fx.call('record_payment', {
      direction: 'incoming',
      date: '2026-03-01',
      amountMinor: 130000,
      bankAccountId: fx.accId('1020'),
      counterpartyId: first.contactId,
      allocations: [{ documentId: first.id, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'ap-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      paymentId: paid.paymentId,
      allocations: [{ documentId: second.id, amountMinor: 21900 }],
      intent: 'allocate_payment',
      idempotencyKey: 'ap-1',
    };
  },

  reverse_payment: (fx) => {
    const inv = issuedInvoice(fx, 'rv');
    const paid = fx.call('record_payment', {
      direction: 'incoming',
      date: '2026-03-01',
      amountMinor: 108100,
      bankAccountId: fx.accId('1020'),
      allocations: [{ documentId: inv.id, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'rv-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      paymentId: paid.paymentId,
      date: '2026-03-02',
      intent: 'reverse_payment',
      idempotencyKey: 'rv-1',
    };
  },

  set_write_off_threshold: (fx) => ({
    workspaceId: fx.workspaceId,
    thresholdMinor: 250,
    idempotencyKey: 'wot-1',
  }),

  // --- A16, where the aging buckets cut ----------------------------------------------------------
  // A view setting, not money: the boundaries re-partition the same receivables total and can never
  // change it. It still earns a real scenario, because the row it writes carries an `updated_at` and
  // a `boundaries_days_json`, and the gate's whole-database comparison is what proves a repeat call
  // under the same key rewrites NEITHER. Counting rows here would have proved nothing: `workspace_id`
  // is the PRIMARY KEY of `aging_bucket_config`, so "one row" is what the table's own constraint
  // guarantees, not what the idempotency logic does.
  set_aging_bucket_config: (fx) => ({
    workspaceId: fx.workspaceId,
    boundariesDays: [30, 60, 90],
    idempotencyKey: 'sabc-1',
  }),

  // --- A15, Mahnwesen ----------------------------------------------------------------------------
  // The three run verbs share one world: an issued invoice due 2026-06-01, which is 45 days overdue
  // at the fixture clock (2026-07-16), so it proposes at level 1 under the shipped 10/20/30
  // thresholds. The config scenario books no fee on purpose (and MAY not demand one unbooked: a
  // positive fee without bookFee is refused since the C6 remediation): the double-call is then a
  // pure row-shape assertion, and the fee's money path is proven by A15's own suites where the
  // posted entry can be inspected rather than merely diffed.
  set_dunning_config: (fx) => ({
    workspaceId: fx.workspaceId,
    levels: [
      { level: 1, daysOverdue: 10, feeMinor: 0, showInterest: true, interestBp: 500 },
      { level: 2, daysOverdue: 20, feeMinor: 0 },
      { level: 3, daysOverdue: 30, feeMinor: 0 },
    ],
    idempotencyKey: 'sdc-1',
  }),

  propose_dunning_run: (fx) => {
    seedOverdueInvoice(fx, 'pdr');
    return { workspaceId: fx.workspaceId, idempotencyKey: 'pdr-1' };
  },

  issue_dunning_run: (fx) => {
    seedOverdueInvoice(fx, 'idr');
    const proposed = fx.call('propose_dunning_run', { idempotencyKey: 'idr-propose' });
    return { workspaceId: fx.workspaceId, runId: proposed.runId, confirmed: true, idempotencyKey: 'idr-1' };
  },

  send_dunning_run: (fx) => {
    seedOverdueInvoice(fx, 'sdr');
    const proposed = fx.call('propose_dunning_run', { idempotencyKey: 'sdr-propose' });
    fx.call('issue_dunning_run', { runId: proposed.runId, confirmed: true, idempotencyKey: 'sdr-issue' });
    // The same visible-transport rule as `send_invoice`: a mode is not a transport.
    fx.deps.emailRelay = recordingRelay();
    return { workspaceId: fx.workspaceId, runId: proposed.runId, confirmed: true, idempotencyKey: 'sdr-1' };
  },

  // --- A19, bank accounts ------------------------------------------------------------------------
  // Master data, except for the one verb that is not: `set_bank_opening_balance` POSTS, which is why
  // it is the only one of the four whose double-call is a money assertion rather than a row-shape one.
  //
  // A19's `bankAccountId` is a `bank_account` row and NOT A14's field of the same name (which means
  // the ledger account money moved on). The ledger link here is `ledgerAccountId`, and every scenario
  // below passes fx.accId('1020'), the seeded Bankkonto, through that field and no other.

  // The IBAN is a real, structurally valid Swiss IBAN: it passes ISO 7064 mod-97-10 (verified against
  // `core/setup/iban.ts`, the repo's one validator) and its IID 00762 sits OUTSIDE the SIX QR-IID
  // range 30000 to 31999, so it registers as a plain IBAN and not a receive-only QR-IBAN.
  create_bank_account: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'PostFinance Geschäft',
    iban: 'CH93 0076 2011 6238 5295 7',
    currency: 'CHF',
    ledgerAccountId: fx.accId('1020'),
    idempotencyKey: 'cba-1',
  }),

  update_bank_account: (fx) => ({
    workspaceId: fx.workspaceId,
    bankAccountId: bankAccount(fx, 'uba'),
    name: 'PostFinance Haupt',
    idempotencyKey: 'uba-1',
  }),

  // The only A19 verb that touches the ledger, so this is where §H-IDEMPOTENT actually bites: a
  // replay must move the ledger ZERO times, and the gate asserts that on the ROWS rather than on the
  // returned entry id (a verb that hands back the right id while posting a second entry is exactly
  // the bug worth catching). 9100 Eröffnungsbilanz is NOT in A01's core seed and A19 refuses to
  // invent it, so the scenario creates it first: without it the verb correctly answers `needs_account`
  // and the first call never succeeds.
  //
  // Note this pins REPLAY under the SAME key. The separate `opening_balance_already_set` guard, which
  // refuses a SECOND opening balance under a DIFFERENT key, is a distinct property and is not what
  // the double-call exercises.
  set_bank_opening_balance: (fx) => {
    openingBalanceAccount(fx, 'sbob');
    return {
      workspaceId: fx.workspaceId,
      bankAccountId: bankAccount(fx, 'sbob'),
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
      idempotencyKey: 'sbob-1',
    };
  },

  archive_bank_account: (fx) => ({
    workspaceId: fx.workspaceId,
    bankAccountId: bankAccount(fx, 'aba'),
    idempotencyKey: 'aba-1',
  }),

  // --- A21, QR incoming matching ---------------------------------------------------------------
  // The queue write posts nothing, so its double call proves only the row dedupe; the money bites
  // in `apply_qr_match`, whose replay must move the ledger ZERO times, and in `override_qr_match`,
  // whose replay must reverse the payment exactly once. The credit's reference is DERIVED from the
  // issued invoice's number through the same `buildQrrReference` A11 issues with, because a
  // hand-typed 27-digit literal would be the exact typo the mod-10 check exists to catch.
  record_incoming_credit: (fx) => ({
    workspaceId: fx.workspaceId,
    bankAccountId: bankAccount(fx, 'ric'),
    amountMinor: 108100,
    valueDate: '2026-03-01',
    payerName: 'Zahler AG',
    idempotencyKey: 'ric-1',
  }),

  apply_qr_match: (fx) => {
    const credit = qrCredit(fx, 'aqm');
    return {
      workspaceId: fx.workspaceId,
      creditId: credit.creditId,
      invoiceId: credit.invoiceId,
      mode: 'full',
      confirmed: true,
      idempotencyKey: 'aqm-1',
    };
  },

  override_qr_match: (fx) => {
    const credit = qrCredit(fx, 'oqm');
    fx.call('apply_qr_match', {
      creditId: credit.creditId,
      invoiceId: credit.invoiceId,
      mode: 'full',
      confirmed: true,
      idempotencyKey: 'oqm-apply',
    });
    return {
      workspaceId: fx.workspaceId,
      creditId: credit.creditId,
      action: 'unmatch',
      confirmed: true,
      idempotencyKey: 'oqm-1',
    };
  },

  set_qr_auto_apply: (fx) => ({
    workspaceId: fx.workspaceId,
    autoApply: true,
    idempotencyKey: 'sqaa-1',
  }),

  // --- A20, camt reconciliation -------------------------------------------------------------------
  // `import_camt`'s double call proves the statement dedupe (Stmt/Id + ElctrncSeqNb), not a posting:
  // the fee entry it carries stays unmatched until `create_entry_for_txn` books it. `confirm_match`
  // settles a DBIT against a POSTED vendor bill for the exact payable, so the replay proves A14's own
  // idempotency through the delegation rather than a second copy of it. `create_entry_for_txn` posts
  // a balanced two-leg entry via A02 and its replay must move the ledger ZERO times.
  import_camt: (fx) => {
    const bankAccountId = bankAccount(fx, 'ic');
    const iban = fx.call('get_bank_account', { bankAccountId }).bankAccount.iban;
    return {
      workspaceId: fx.workspaceId,
      bankAccountId,
      xml: camtFixtureXml({ statementId: 'IC-STMT', iban, entryRef: 'IC-NTRY', amountMinor: 4000, creditDebit: 'DBIT' }),
      idempotencyKey: 'ic-1',
    };
  },

  confirm_match: (fx) => {
    const vendorBillId = postedVendorBill(fx, 'cm');
    const bankAccountId = bankAccount(fx, 'cm');
    const iban = fx.call('get_bank_account', { bankAccountId }).bankAccount.iban;
    const imported = fx.call('import_camt', {
      bankAccountId,
      xml: camtFixtureXml({ statementId: 'CM-STMT', iban, entryRef: 'CM-NTRY', amountMinor: 108100, creditDebit: 'DBIT' }),
      idempotencyKey: 'cm-import',
    });
    const listed = fx.call('list_reconciliation', { statementId: imported.statementId });
    const row = listed.unmatched.find((t) => t.entryRef === 'CM-NTRY');
    return {
      workspaceId: fx.workspaceId,
      bankTxnId: row.bankTxnId,
      vendorBillId,
      idempotencyKey: 'cm-1',
    };
  },

  create_entry_for_txn: (fx) => {
    const bankAccountId = bankAccount(fx, 'ce');
    const iban = fx.call('get_bank_account', { bankAccountId }).bankAccount.iban;
    const imported = fx.call('import_camt', {
      bankAccountId,
      xml: camtFixtureXml({ statementId: 'CE-STMT', iban, entryRef: 'CE-NTRY', amountMinor: 500, creditDebit: 'DBIT' }),
      idempotencyKey: 'ce-import',
    });
    const listed = fx.call('list_reconciliation', { statementId: imported.statementId });
    const row = listed.unmatched.find((t) => t.entryRef === 'CE-NTRY');
    return {
      workspaceId: fx.workspaceId,
      bankTxnId: row.bankTxnId,
      contraAccountId: fx.accId('6500'),
      idempotencyKey: 'ce-1',
    };
  },

  // --- A36, live bank feed --------------------------------------------------------------------
  // `review_bank_txn` is a pure signal: it writes only its idempotency memo (no ledger row), so its
  // replay must move the database ZERO times beyond the memo. `set_camt_matching` upserts one config
  // row; its replay writes nothing new. Both prove idempotency-on-rows through the memo, not a stored
  // effect.
  review_bank_txn: (fx) => {
    const bankAccountId = bankAccount(fx, 'rbt');
    const iban = fx.call('get_bank_account', { bankAccountId }).bankAccount.iban;
    const imported = fx.call('import_camt', {
      bankAccountId,
      xml: camtFixtureXml({ statementId: 'RBT-STMT', iban, entryRef: 'RBT-NTRY', amountMinor: 9999, creditDebit: 'DBIT' }),
      idempotencyKey: 'rbt-import',
    });
    const listed = fx.call('list_reconciliation', { statementId: imported.statementId });
    const row = listed.unmatched.find((t) => t.entryRef === 'RBT-NTRY');
    return { workspaceId: fx.workspaceId, bankTxnId: row.bankTxnId, idempotencyKey: 'rbt-1' };
  },

  set_camt_matching: (fx) => ({
    workspaceId: fx.workspaceId,
    valueDateWindowDays: 3,
    reviewThreshold: 'high',
    idempotencyKey: 'scm-1',
  }),

  set_bank_sync_schedule: (fx) => {
    const bankAccountId = bankAccount(fx, 'sbss');
    const c = fx.call('bank_channel_connect', {
      host: { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER04', userId: 'USER0004' },
      routeBankAccountIds: [bankAccountId],
      confirm: true,
      idempotencyKey: 'sbss-conn',
    });
    // The unlink path (no ruleId): a valid write that stores a null pointer, idempotent on replay.
    return { workspaceId: fx.workspaceId, connectionId: c.connectionId, idempotencyKey: 'sbss-1' };
  },

  // --- A07, the MWST-Abrechnung ----------------------------------------------------------------
  // The one WRITE this capability has, and it transmits nothing: there is no ESTV submission API,
  // so filing is a human uploading an eCH-0217 file to the ePortal and this verb recording that he
  // did. What it writes is A03's hard lock, once per month of the quarter, because `period_lock`
  // keys on YYYY-MM or YYYY and a quarter is neither.
  //
  // The gate's double call is what makes the idempotency claim testable HERE rather than only in
  // the A07 suite: A07 holds no key of its own, it derives one per month and hands it to A03, so
  // "a replay writes nothing" is a property of the delegation and not of a key this verb stores.
  vat_mark_filed: (fx) => ({
    workspaceId: fx.workspaceId,
    period: '2026-Q1',
    idempotencyKey: 'vmf-1',
  }),

  // --- A04, opening balances -------------------------------------------------------------------
  // Both A04 writes post through A02, so this is where §H-IDEMPOTENT actually bites, and the gate
  // asserts it on the whole-database SNAPSHOT rather than on a returned entry id: a verb that hands
  // back the right id while posting a second opening entry is exactly the defect worth catching.
  //
  // WHY THIS IS NOT THE VACUOUS SHAPE A PREVIOUS SCENARIO WAS REJECTED FOR: the assertion does not
  // count rows on a table whose PRIMARY KEY already forbids a second one. `journal_entry` has no
  // uniqueness constraint that would stop a duplicate opening entry, and no constraint at all keyed
  // on the opening position: the `journal_line` rows would simply be added and both entries would
  // sit there posted, doubling every balance. Nothing but the code prevents that, which is what
  // makes the double call load-bearing here.
  //
  // The self-balancing set below is deliberate too. It ties out on its own (15'900.00 a side), so no
  // clarification account is involved and the scenario cannot pass by way of a plugged difference.
  set_opening_balances: (fx) => ({
    workspaceId: fx.workspaceId,
    lines: [
      { account: fx.accId('1020'), debitMinor: 1250000 },
      { account: fx.accId('1100'), debitMinor: 340000 },
      { account: fx.accId('2000'), creditMinor: 190000 },
      { account: fx.accId('2800'), creditMinor: 1400000 },
    ],
    reference: 'Inventar per 01.01.2026',
    idempotencyKey: 'sob-1',
  }),

  // Accounts are named by NUMBER here rather than by id, which is the shape a migration file
  // actually carries: a CSV exported from another package knows chart numbers and knows nothing
  // about this workspace's internal ids. Resolving those numbers against the caller's own chart is
  // the §H-TENANT-sensitive step, so the scenario exercises it rather than routing around it.
  import_opening_balances: (fx) => ({
    workspaceId: fx.workspaceId,
    format: 'csv',
    mapping: { account: 'Konto', debit: 'Soll', credit: 'Haben' },
    rows: [
      { Konto: '1020', Soll: "12'500.00", Haben: '' },
      { Konto: '2800', Soll: '', Haben: "12'500.00" },
    ],
    idempotencyKey: 'iob-1',
  }),

  // --- A19, unarchive (finding F12) ------------------------------------------------------------
  // Appended at the END, because this list is append-only for the same merge reason the registry is.
  //
  // WHY THE DOUBLE CALL IS LOAD-BEARING HERE, and not the vacuous shape a previous scenario was
  // rejected for. The gate's assertion is a whole-database snapshot, not a COUNT on a table whose
  // PRIMARY KEY already forbids a second row. What the second call could write, and what nothing but
  // the code prevents, is a second `audit_log` row (plus its `audit_head` advance): the audit trail
  // is an append-only hash chain with no uniqueness constraint of any kind, so a verb that re-ran
  // instead of replaying its key would leave two `unarchive` events behind and the snapshot would
  // differ. `unarchive_bank_account` carries a key, so it is compared against the WHOLE database,
  // audit tables included.
  //
  // The account is archived FIRST, so the verb under test does real work on its first call. Skipping
  // that would leave both calls as no-ops on an already-active row and the scenario would pass for a
  // verb that did nothing at all.
  unarchive_bank_account: (fx) => {
    const bankAccountId = bankAccount(fx, 'uba');
    fx.call('archive_bank_account', { bankAccountId, idempotencyKey: 'uba-archive' });
    return { workspaceId: fx.workspaceId, bankAccountId, idempotencyKey: 'uba-1' };
  },

  // --- A24, access control ---------------------------------------------------------------------
  // Placed here with A24's own verbs and not at the bottom of the file, per the note under
  // READ_SCENARIOS: "appended at the end" is not a property an object literal keeps.
  //
  // EVERY ONE OF THESE RUNS AGAINST AN UNPROVISIONED WORKSPACE, which is the state every fixture
  // starts in and the state every workspace in existence is in today. `invite_member` is the verb
  // that ENDS it: it seats the calling actor as owner before it writes the invitee's pending row, so
  // that a workspace can never hold a pending invite and nobody in charge. That means the first
  // scenario below is also the one place in this gate where the ungated world becomes the gated one,
  // and it still has to be idempotent across the transition.
  invite_member: (fx) => ({
    workspaceId: fx.workspaceId,
    email: 'buchhalter@muster.ch',
    role: 'bookkeeper',
    displayName: 'B. Halter',
    idempotencyKey: 'im-1',
  }),

  // THE ACTOR CHANGES BETWEEN SETUP AND THE CALL UNDER TEST, deliberately, because that is the flow
  // rather than a trick to get the gate green. `invite_member` runs as the fixture's own actor and
  // performs the provisioning flip; `accept_invite` then binds a DIFFERENT session actor to the
  // invited identity.
  //
  // THE REDEEMING ACTOR IS NOT A D13 ONE, and D50 is why. The flip now seats BOTH `studio` and
  // `agent` as owners, so neither can redeem anything: they answer the new `actor_already_member`,
  // naming the row they already hold. The actor that CAN redeem is the named subject
  // `src/api/session.ts` describes for a tier with real identities, and the local-tier way to bound
  // `till mcp` to a narrow role is now `set_role` on the agent's own seat rather than an invite.
  accept_invite: (fx) => {
    const invited = fx.call('invite_member', {
      email: 'treuhand@muster.ch',
      role: 'treuhaender',
      idempotencyKey: 'ai-invite',
    });
    fx.deps.actor = 'treuhand:mueller';
    return { token: invited.token };
  },

  // The member under test is the PENDING invitee and never the owner: `last_owner` is a rail on the
  // only accepted owner, and a scenario that tripped it would be testing the refusal rather than the
  // verb. The second call sets the role it is already at, which returns early and writes nothing,
  // which is what makes this exempt from the key rule honestly rather than by assertion.
  set_role: (fx) => {
    const invited = fx.call('invite_member', {
      email: 'wechsler@muster.ch',
      role: 'bookkeeper',
      idempotencyKey: 'sr-invite',
    });
    return { workspaceId: fx.workspaceId, memberId: invited.memberId, role: 'viewer' };
  },

  revoke_member: (fx) => {
    const invited = fx.call('invite_member', {
      email: 'abgang@muster.ch',
      role: 'bookkeeper',
      idempotencyKey: 'rm-invite',
    });
    return { workspaceId: fx.workspaceId, memberId: invited.memberId };
  },

  // `post` and nothing else, which is a real bundle rather than a placeholder: it is the narrowest
  // useful custom role and it exercises the registry validation on a name that IS in the registry.
  define_role: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Nur Buchen',
    capabilities: ['post'],
    idempotencyKey: 'dr-1',
  }),

  // The role is created and left UNHELD, because `role_in_use` refuses an archive while any member
  // still holds it. Assigning it first would make this scenario test that refusal instead.
  archive_role: (fx) => {
    const created = fx.call('define_role', {
      name: 'Vorübergehend',
      capabilities: ['post'],
      idempotencyKey: 'ar-define',
    });
    return { workspaceId: fx.workspaceId, roleId: created.roleId, idempotencyKey: 'ar-1' };
  },

  // --- G00, the customization framework --------------------------------------------------------
  // Every scenario runs on `contact`, one of the eight kinds in G00's OP3 registry. The kind is a
  // registry row rather than anything G00 special-cases, so exercising one exercises the mechanism.

  define_field: (fx) => ({
    workspaceId: fx.workspaceId,
    entityKind: 'contact',
    key: 'segment',
    labelI18n: { 'de-CH': 'Segment', en: 'Segment' },
    type: 'text',
    idempotencyKey: 'df-1',
  }),

  // A GENUINE DRAFT RELEASE, because `freshDeps` runs as actor `agent` (test/api/support.mjs) and that
  // is exactly the actor P8 stages. So this scenario exercises the real path rather than a no-op, and
  // the double call proves releasing an already-released field settles instead of erroring.
  confirm_field: (fx) => {
    const defined = fx.call('define_field', {
      entityKind: 'contact',
      key: 'confirm_me',
      labelI18n: { 'de-CH': 'Bestätigen', en: 'Confirm me' },
      type: 'text',
      idempotencyKey: 'cf-define',
    });
    return { workspaceId: fx.workspaceId, fieldDefId: defined.fieldDef.fieldDefId, idempotencyKey: 'cf-1' };
  },

  archive_field: (fx) => {
    const defined = fx.call('define_field', {
      entityKind: 'contact',
      key: 'retired',
      labelI18n: { 'de-CH': 'Stillgelegt', en: 'Retired' },
      type: 'text',
      idempotencyKey: 'af-define',
    });
    return { workspaceId: fx.workspaceId, fieldDefId: defined.fieldDef.fieldDefId, idempotencyKey: 'af-1' };
  },

  // A REAL contact, not an invented id: `setFieldValue` proves the record exists in this tenant
  // before it hangs a value on it, so a fabricated id would exercise the refusal instead of the write.
  //
  // The field is CONFIRMED first and it has to be. The fixture actor is `agent`, so the def lands as a
  // P8 draft and a value on a draft is refused with `field_draft`: the first version of this scenario
  // skipped the confirm and the gate caught it, which is the draft mechanism working on its authors.
  set_field_value: (fx) => {
    const defined = fx.call('define_field', {
      entityKind: 'contact',
      key: 'lead_source',
      labelI18n: { 'de-CH': 'Herkunft', en: 'Lead source' },
      type: 'text',
      idempotencyKey: 'sfv-define',
    });
    fx.call('confirm_field', { fieldDefId: defined.fieldDef.fieldDefId, idempotencyKey: 'sfv-confirm' });
    const contact = fx.call('create_contact', {
      partyRole: 'customer',
      name: 'Muster AG',
      idempotencyKey: 'sfv-contact',
    });
    return {
      workspaceId: fx.workspaceId,
      entityKind: 'contact',
      entityId: contact.contact.id,
      fieldKey: 'lead_source',
      value: 'Empfehlung',
      idempotencyKey: 'sfv-1',
    };
  },

  // PERSONAL, not shared: the fixture actor holds every capability, so a shared view would pass the
  // gate without ever touching the `manage_saved_views` branch and prove nothing about it either way.
  create_saved_view: (fx) => ({
    workspaceId: fx.workspaceId,
    entityKind: 'contact',
    name: 'Meine Kunden',
    filters: { partyRole: 'customer' },
    columns: ['name'],
    layout: 'table',
    idempotencyKey: 'csv-1',
  }),

  update_saved_view: (fx) => {
    const created = fx.call('create_saved_view', {
      entityKind: 'contact',
      name: 'Zu ändern',
      idempotencyKey: 'usv-create',
    });
    return {
      workspaceId: fx.workspaceId,
      viewId: created.savedView.viewId,
      patch: { name: 'Geändert' },
      idempotencyKey: 'usv-1',
    };
  },

  // A true delete, so the second call would find nothing: the idempotency key is what makes the
  // replay return the original result instead of `not_found`, which is exactly what the gate checks.
  delete_saved_view: (fx) => {
    const created = fx.call('create_saved_view', {
      entityKind: 'contact',
      name: 'Zu löschen',
      idempotencyKey: 'dsv-create',
    });
    return { workspaceId: fx.workspaceId, viewId: created.savedView.viewId, idempotencyKey: 'dsv-1' };
  },

  // --- G05, document templates -------------------------------------------------------------------
  // Presentation only: none of the four writes can touch a money figure, and the byte-identity of
  // the QR payload under a template is proven in test/customization/document-templates.test.mjs;
  // what the gate proves here is the registry contract (idempotency-on-rows, tenant, parity).
  create_document_template: (fx) => ({
    workspaceId: fx.workspaceId,
    documentKind: 'invoice',
    name: 'Briefpapier Standard',
    footerI18n: { 'de-CH': 'Vielen Dank für Ihren Auftrag.\nZahlbar innert 30 Tagen.' },
    languageMode: 'fixed',
    fixedLocale: 'de-CH',
    idempotencyKey: 'cdt-1',
  }),

  update_document_template: (fx) => {
    const created = fx.call('create_document_template', {
      documentKind: 'quote',
      name: 'Offerte Vorlage',
      idempotencyKey: 'udt-create',
    });
    return {
      workspaceId: fx.workspaceId,
      templateId: created.template.templateId,
      patch: { name: 'Offerte Vorlage 2026', footerI18n: { 'de-CH': 'Gültig 30 Tage.' } },
      idempotencyKey: 'udt-1',
    };
  },

  set_default_document_template: (fx) => {
    const created = fx.call('create_document_template', {
      documentKind: 'invoice',
      name: 'Wird Standard',
      idempotencyKey: 'sddt-create',
    });
    return {
      workspaceId: fx.workspaceId,
      documentKind: 'invoice',
      templateId: created.template.templateId,
      idempotencyKey: 'sddt-1',
    };
  },

  archive_document_template: (fx) => {
    const created = fx.call('create_document_template', {
      documentKind: 'dunning_run',
      name: 'Alte Mahnvorlage',
      idempotencyKey: 'adt-create',
    });
    return { workspaceId: fx.workspaceId, templateId: created.template.templateId, idempotencyKey: 'adt-1' };
  },

  // --- G05 §10, dispatch texts -------------------------------------------------------------------
  // The one write of the send-log family. NATURALLY idempotent (no key, see IDEMPOTENCY_KEY_EXEMPT):
  // the double-call is the interesting half of this scenario, because a value-identical re-save must
  // leave the row BYTE-identical (updated_at included), which is how the naturally-idempotent claim
  // is tested rather than asserted. The subject and body deliberately use variables, so the save-time
  // validation path is exercised rather than skipped.
  dispatch_text_upsert: (fx) => ({
    workspaceId: fx.workspaceId,
    documentKind: 'invoice',
    locale: 'de-CH',
    subject: 'Rechnung {{invoice_number}} von {{company_name}}',
    body: 'Guten Tag {{contact_name}}\n\nIm Anhang die Rechnung {{invoice_number}} über {{amount_total}}, zahlbar bis {{due_date}}.\n\nFreundliche Grüsse\n{{company_name}}',
  }),

  // --- G06, notifications & inbox ----------------------------------------------------------------
  // The recipient is ALWAYS the fixture actor (`agent`): the queue verbs are self-scoped
  // structurally (an inbox is not a shared mailbox), so a scenario naming anyone else would be
  // refused with `forbidden` and prove nothing. `task.due` is a real registry event (E03's tick
  // moment), and the deliver scenario links a REAL contact through the OP3 pair so the
  // entity-existence check is exercised rather than skipped.

  notifications_deliver: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Melde AG', idempotencyKey: 'ntfd-seed' });
    return {
      workspaceId: fx.workspaceId,
      userId: 'agent',
      event: 'task.due',
      entityKind: 'contact',
      entityId: c.contact.id,
      summaryI18nKey: 'notifications.summary.task_due',
      summaryParams: { title: 'Offerte nachfassen' },
      idempotencyKey: 'ntfd-1',
    };
  },

  notifications_mark_read: (fx) => {
    const d = fx.call('notifications_deliver', {
      userId: 'agent',
      event: 'invoice.issued',
      summaryI18nKey: 'notifications.summary.invoice_issued',
      idempotencyKey: 'ntfr-seed',
    });
    return { workspaceId: fx.workspaceId, notificationId: d.notificationId, idempotencyKey: 'ntfr-1' };
  },

  notifications_mark_all_read: (fx) => {
    fx.call('notifications_deliver', {
      userId: 'agent',
      event: 'deal.stage_changed',
      summaryI18nKey: 'notifications.summary.deal_stage_changed',
      idempotencyKey: 'ntfa-seed',
    });
    return { workspaceId: fx.workspaceId, userId: 'agent', idempotencyKey: 'ntfa-1' };
  },

  notifications_archive: (fx) => {
    const d = fx.call('notifications_deliver', {
      userId: 'agent',
      event: 'payment.recorded',
      summaryI18nKey: 'notifications.summary.payment_recorded',
      idempotencyKey: 'ntfx-seed',
    });
    return { workspaceId: fx.workspaceId, notificationId: d.notificationId, idempotencyKey: 'ntfx-1' };
  },

  notifications_set_preference: (fx) => ({
    workspaceId: fx.workspaceId,
    userId: 'agent',
    event: 'deal.stage_changed',
    channel: 'email',
    enabled: true,
    digest: 'daily',
    idempotencyKey: 'ntfp-1',
  }),

  notifications_run_digest: (fx) => {
    // The real path: an email preference on a digest cadence, then a delivered item inside the
    // window, so the run gathers something and renders the local artifact (OP4, never transmitted).
    fx.call('notifications_set_preference', {
      userId: 'agent',
      channel: 'email',
      enabled: true,
      digest: 'daily',
      idempotencyKey: 'ntfg-pref',
    });
    fx.call('notifications_deliver', {
      userId: 'agent',
      event: 'task.due',
      summaryI18nKey: 'notifications.summary.task_due',
      idempotencyKey: 'ntfg-item',
    });
    return {
      workspaceId: fx.workspaceId,
      userId: 'agent',
      channel: 'email',
      periodStart: '2026-07-01',
      periodEnd: '2026-07-31',
      idempotencyKey: 'ntfg-1',
    };
  },

  // --- G02, plugin architecture & extension registry ---------------------------------------------
  // A zero-capability, zero-permission manifest whose pinned sha256 matches its payload and whose
  // compat_range admits the current core, so install lands clean (status installed) and the double
  // call replays through §H-IDEMPOTENT. The seed helper below is reused by the state verbs.
  install_plugin: (fx) => {
    const payload = 'conformance-plugin-payload';
    const sha256 = createHash('sha256').update(payload).digest('hex');
    return {
      workspaceId: fx.workspaceId,
      source: 'local',
      packageRef: {
        manifest: {
          name: 'Conformance Extension',
          version: '1.0.0',
          compat_range: '^1.0.0',
          sha256,
          capabilities: [],
          permissions: { requested: [] },
        },
        payload,
      },
      idempotencyKey: 'plg-install-1',
    };
  },
  enable_plugin: (fx) => ({ workspaceId: fx.workspaceId, pluginId: seedPlugin(fx, 'enable'), idempotencyKey: 'plg-enable-1' }),
  disable_plugin: (fx) => ({ workspaceId: fx.workspaceId, pluginId: seedPlugin(fx, 'disable'), idempotencyKey: 'plg-disable-1' }),
  uninstall_plugin: (fx) => ({ workspaceId: fx.workspaceId, pluginId: seedPlugin(fx, 'uninstall'), idempotencyKey: 'plg-uninstall-1' }),
  refresh_plugin_compat: (fx) => ({ workspaceId: fx.workspaceId, pluginId: seedPlugin(fx, 'refresh'), idempotencyKey: 'plg-refresh-1' }),

  // --- G01, automation rules ---------------------------------------------------------------------
  // EVERY SCENARIO USES A REAL TRIGGER AND A REAL ACTION, both read off the live registries rather
  // than invented. `contact.created` is emitted by `create_contact` and `create_contact` is a
  // registered write verb, so these rows exercise the real validation path instead of a shape that
  // happens to type-check. A rule naming an event or a tool that does not exist is REFUSED, and a
  // refused scenario fails the gate rather than passing it quietly.
  //
  // The trigger and the action are deliberately DIFFERENT verbs. Pointing `contact.created` at
  // `create_contact` is a self-triggering rule and the engine refuses it by name, which is the point
  // of that check but would make this scenario prove nothing.

  create_automation_rule: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Neuer Kunde: Notiz anlegen',
    trigger: { event: 'contact.created' },
    condition: { all: [{ field: 'result.contact.partyRole', op: 'eq', value: 'customer' }] },
    action: { tool: 'create_item', inputTemplate: { name: 'Onboarding {{result.contact.id}}', defaultUnitPriceMinor: 0 } },
    idempotencyKey: 'car-1',
  }),

  update_automation_rule: (fx) => {
    const created = fx.call('create_automation_rule', {
      name: 'Zu bearbeiten',
      trigger: { event: 'invoice.issued' },
      action: { tool: 'create_item', inputTemplate: { name: 'X', defaultUnitPriceMinor: 0 } },
      idempotencyKey: 'uar-create',
    });
    return {
      workspaceId: fx.workspaceId,
      ruleId: created.rule.ruleId,
      patch: { name: 'Bearbeitet', condition: null },
      idempotencyKey: 'uar-1',
    };
  },

  // ENABLE RUNS ON A GENUINELY DISABLED RULE, because `freshDeps` runs as actor `agent`
  // (test/api/support.mjs) and that is exactly the actor whose rules land disabled. So this exercises
  // the real P8 release path rather than a no-op, and the double call proves enabling an
  // already-enabled rule settles instead of erroring.
  enable_automation_rule: (fx) => {
    const created = fx.call('create_automation_rule', {
      name: 'Zu aktivieren',
      trigger: { event: 'invoice.issued' },
      action: { tool: 'create_item', inputTemplate: { name: 'X', defaultUnitPriceMinor: 0 } },
      idempotencyKey: 'ear-create',
    });
    return { workspaceId: fx.workspaceId, ruleId: created.rule.ruleId };
  },

  disable_automation_rule: (fx) => {
    const created = fx.call('create_automation_rule', {
      name: 'Zu deaktivieren',
      trigger: { event: 'invoice.issued' },
      action: { tool: 'create_item', inputTemplate: { name: 'X', defaultUnitPriceMinor: 0 } },
      idempotencyKey: 'dar-create',
    });
    return { workspaceId: fx.workspaceId, ruleId: created.rule.ruleId };
  },

  archive_automation_rule: (fx) => {
    const created = fx.call('create_automation_rule', {
      name: 'Zu archivieren',
      trigger: { event: 'invoice.issued' },
      action: { tool: 'create_item', inputTemplate: { name: 'X', defaultUnitPriceMinor: 0 } },
      idempotencyKey: 'aar-create',
    });
    return { workspaceId: fx.workspaceId, ruleId: created.rule.ruleId };
  },

  // A TICK WITH A REAL DUE RULE, not an empty one. An empty tick would settle trivially and prove
  // nothing about the property that matters: the second call is the same `asOf`, so it computes the
  // same occurrence key, and the UNIQUE index on `automation_run` is what makes the replay a no-op.
  // The rule is created by an explicit enable because the fixture actor is `agent`.
  run_due_automations: (fx) => {
    const created = fx.call('create_automation_rule', {
      name: 'Täglich ein Artikel',
      trigger: { event: 'schedule.daily' },
      action: { tool: 'create_item', inputTemplate: { name: 'Täglich', defaultUnitPriceMinor: 0 } },
      idempotencyKey: 'rda-create',
    });
    fx.call('enable_automation_rule', { ruleId: created.rule.ruleId });
    // THE `asOf` IS ON THE FIXTURE CLOCK'S OWN DAY, not thirteen days past it. It used to name
    // 2026-07-29 against a clock pinned to 2026-07-16, which is the future-`asOf` defect the wave
    // critic drove five ledger entries through, written into the contract as if it were the shape of
    // a legal call. `runDueAutomations` now refuses an `asOf` ahead of the injected clock. The
    // property this scenario exists to prove is untouched: both calls pass the SAME `asOf`, so both
    // compute the same occurrence key and the UNIQUE index makes the replay a no-op.
    return { workspaceId: fx.workspaceId, asOf: '2026-07-16T09:00:00.000Z' };
  },

  // A STUCK ROW HAS TO BE FORCED, and that is the point of the verb rather than a weakness of the
  // fixture. The engine is at-most-once: it claims `running` before invoking and settles exactly
  // once after, so the only thing that leaves a stuck row is a process dying in between, which no
  // sequence of verb calls can reproduce. The row is fired for real through the product first, then
  // its status is put back to `running` to stand in for that death. Nothing else is written by hand.
  retry_automation_run: (fx) => {
    const created = fx.call('create_automation_rule', {
      name: 'Nach dem Abschluss',
      trigger: { event: 'period.closed' },
      action: { tool: 'create_contact', inputTemplate: { partyRole: 'customer', name: 'Abschluss' } },
      idempotencyKey: 'rar-create',
    });
    fx.call('enable_automation_rule', { ruleId: created.rule.ruleId });
    fx.call('close_month', { period: '2026-03', idempotencyKey: 'rar-close' });
    const run = fx.deps.store.db
      .prepare('SELECT id FROM automation_run WHERE workspace_id = ? AND rule_id = ?')
      .get(fx.workspaceId, created.rule.ruleId);
    fx.deps.store.db
      .prepare("UPDATE automation_run SET status = 'running', finished_at = NULL WHERE id = ?")
      .run(run.id);
    return { workspaceId: fx.workspaceId, runId: run.id, idempotencyKey: 'rar-retry' };
  },

  // --- A17, vendor bills and expenses ------------------------------------------------------------
  // The creditor half of the money path, so the gate's double call is doing the same work it does for
  // A14: a bill recorded twice under one key must leave ONE bill, ONE journal entry and ONE set of
  // journal lines, and the comparison is against every row of every table (the audit trail included,
  // which is an append-only hash chain with no uniqueness constraint of any kind).
  //
  // Every scenario books a REAL Swiss purchase: gross CHF 1'081.00 at 8.1% Normalsatz, which
  // back-derives net 1'000.00 and Vorsteuer 81.00. That is the same canonical figure A14's scenarios
  // use from the sales side, on purpose: one arithmetic to check by eye across both halves of the
  // ledger.

  create_vendor_bill: (fx) => vendorBillInput(fx, 'cvb'),

  record_expense: (fx) => vendorBillInput(fx, 're'),

  post_vendor_bill: (fx) => {
    const bill = fx.call('create_vendor_bill', vendorBillInput(fx, 'pvb'));
    return { workspaceId: fx.workspaceId, vendorBillId: bill.vendorBillId, idempotencyKey: 'pvb-post' };
  },

  // Attaching the Beleg to a POSTED bill, which is the case that matters: it is the only column a
  // posted bill will let anything change, and the DB trigger refuses every other one. A draft would
  // have exercised the freely-editable path and proved nothing about the frozen row.
  attach_receipt: (fx) => {
    const posted = fx.call('record_expense', vendorBillInput(fx, 'ar'));
    return {
      workspaceId: fx.workspaceId,
      vendorBillId: posted.vendorBillId,
      receiptRef: 'beleg/2026/kreditor-0042.pdf',
      idempotencyKey: 'ar-attach',
    };
  },

  // Voiding a POSTED bill, so the replay is compared across a REVERSING ENTRY rather than across a
  // status flip. A second call that re-ran instead of replaying its key would post a second reversal,
  // and 2000 Kreditoren would end up with a credit balance for a bill nobody owes.
  void_vendor_bill: (fx) => {
    const posted = fx.call('record_expense', vendorBillInput(fx, 'vvb'));
    return {
      workspaceId: fx.workspaceId,
      vendorBillId: posted.vendorBillId,
      reason: 'Doppelt erfasst',
      date: '2026-03-05',
      idempotencyKey: 'vvb-void',
    };
  },

  // --- A31, document capture ---------------------------------------------------------------------
  // The queue that feeds A17/E02 drafts. The gate's double call proves each write is idempotent on
  // ROWS: intake dedupes on content hash and replays its key (one capture, one file, one field set);
  // commit replays and never mints a second draft. Every scenario starts from a real SPC payload.

  capture_document: (fx) => ({
    workspaceId: fx.workspaceId,
    contentBase64: Buffer.from(SPC_FIXTURE, 'utf8').toString('base64'),
    mime: 'application/pdf',
    filename: 'beleg.pdf',
    idempotencyKey: 'cap-doc-1',
  }),

  // An operator correction: supersedes the QR-provenance vendor name with an operator/high value.
  // The double call replays under its key, so the field history stays identical.
  capture_extract: (fx) => {
    const captureId = seedCapture(fx, 'cap-ext');
    return {
      workspaceId: fx.workspaceId,
      captureId,
      source: 'operator',
      fields: [{ key: 'vendor_name', value: 'Lieferant GmbH (korrigiert)' }],
      idempotencyKey: 'cap-ext-1',
    };
  },

  // Commit into a DRAFT vendor bill. A re-run under the same key returns the original bill id and
  // creates no second draft (the money assertion this gate exists for).
  capture_commit: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    const vendor = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: 'cap-cmt-vendor' });
    const captureId = seedCapture(fx, 'cap-cmt');
    return {
      workspaceId: fx.workspaceId,
      captureId,
      target: { kind: 'vendor_bill', vendorId: vendor.contact.id, billDate: '2026-03-01', expenseAccountId: fx.accId('6500') },
      idempotencyKey: 'cap-cmt-1',
    };
  },

  capture_discard: (fx) => {
    const captureId = seedCapture(fx, 'cap-dsc');
    return { workspaceId: fx.workspaceId, captureId, reason: 'Kein Beleg', idempotencyKey: 'cap-dsc-1' };
  },

  // --- A34, payroll hand-off ---------------------------------------------------------------------
  // Two writes. The export produces a LOCAL artifact + one payroll_handoff_exports row; the double
  // call replays under its key (one export, one file). The wage posting is the ONE posting in this
  // lane: confirm:true posts ONE balanced entry through A02 (source=import), and the double call
  // returns the original posted entry and never posts a second one (the money assertion this gate
  // exists for). `list_payroll_handoffs` is a read: covered by the "no read mutates" rule, no
  // SCENARIOS/READ_SCENARIOS entry.
  payroll_handoff_export: (fx) => {
    seedEmployee(fx, 'phe');
    return { workspaceId: fx.workspaceId, format: 'json', idempotencyKey: 'phe-exp-1' };
  },

  wage_journal_post: (fx) => ({
    workspaceId: fx.workspaceId,
    lines: [
      { accountNumber: '5000', debitMinor: 500000, description: 'Bruttolohn' },
      { accountNumber: '5700', debitMinor: 50000, description: 'AG-Sozialbeitraege' },
      { accountNumber: '2260', creditMinor: 550000, description: 'Nettolohn' },
    ],
    entryDate: '2026-07-05',
    confirm: true,
    idempotencyKey: 'wjp-conf-1',
  }),

  // --- A18, creditor payments (pain.001) ---------------------------------------------------------
  // A vendor's IBAN is written by its own verb (D65 leg f), a batch is drafted from one open A17
  // bill, generated, and paid; every double-call is a real money assertion on `mark_batch_paid`
  // (it posts through A14's recordPayment) and a row-shape one on the other three.

  set_creditor_bank_profile: (fx) => {
    const vendor = fx.call('create_contact', {
      workspaceId: fx.workspaceId,
      partyRole: 'vendor',
      name: 'Zahllauf Lieferant AG',
      idempotencyKey: 'scbp-vendor',
    });
    return {
      workspaceId: fx.workspaceId,
      vendorId: vendor.contact.id,
      iban: 'CH93 0076 2011 6238 5295 7',
      idempotencyKey: 'scbp-1',
    };
  },

  create_payment_batch: (fx) => {
    const { billId, vendorId } = payableBillReady(fx, 'cpb');
    const bankAccountId = bankAccount(fx, 'cpb');
    fx.call('set_creditor_bank_profile', {
      workspaceId: fx.workspaceId,
      vendorId,
      iban: 'CH93 0076 2011 6238 5295 7',
      idempotencyKey: 'cpb-cbp',
    });
    return {
      workspaceId: fx.workspaceId,
      bankAccountId,
      itemIds: [billId],
      executionDate: '2026-03-20',
      idempotencyKey: 'cpb-1',
    };
  },

  generate_pain001: (fx) => {
    const { batchId } = batchReady(fx, 'gp1');
    return { workspaceId: fx.workspaceId, batchId, idempotencyKey: 'gp1-1' };
  },

  // The money assertion: `markBatchPaid` posts through A14's `recordPayment`, so a re-run instead of
  // a replay would double-book the outgoing payment and leave 2000 Kreditoren credited twice.
  mark_batch_paid: (fx) => {
    const { batchId } = batchReady(fx, 'mbp');
    fx.call('generate_pain001', { workspaceId: fx.workspaceId, batchId, idempotencyKey: 'mbp-gen' });
    return {
      workspaceId: fx.workspaceId,
      batchId,
      confirmation: true,
      valueDate: '2026-03-20',
      idempotencyKey: 'mbp-1',
    };
  },

  // F4: abandon a draft batch. Discarding is idempotent (replayed under its key) and moves the batch
  // to the terminal `discarded` status without touching the ledger; a draft needs no confirmation.
  discard_payment_batch: (fx) => {
    const { batchId } = batchReady(fx, 'dpb');
    return { workspaceId: fx.workspaceId, batchId, idempotencyKey: 'dpb-1' };
  },

  // --- A33, EBICS bank channel -----------------------------------------------------------------
  // No EBICS transport is wired in the conformance context, so every A33 write returns its honest
  // OSS-core outcome (ok:true): connect generates keys + files the INI letter locally (keys_generated),
  // sync degrades to needs_bank_transport, transmit with no channel routed degrades to
  // needs_bank_channel, and disconnect(retire) is purely local. The full network ceremony + transmit +
  // rejection paths live in `test/banking/ebics-channel.test.mjs` against an in-process mock host.
  bank_channel_connect: (fx) => {
    const bankAccountId = bankAccount(fx, 'ebc');
    return {
      workspaceId: fx.workspaceId,
      host: { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER01', userId: 'USER0001' },
      routeBankAccountIds: [bankAccountId],
      confirm: true,
      idempotencyKey: 'ebc-1',
    };
  },

  bank_sync: (fx) => {
    const bankAccountId = bankAccount(fx, 'ebs');
    const c = fx.call('bank_channel_connect', {
      host: { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER02', userId: 'USER0002' },
      routeBankAccountIds: [bankAccountId],
      confirm: true,
      idempotencyKey: 'ebs-conn',
    });
    return { workspaceId: fx.workspaceId, connectionId: c.connectionId, idempotencyKey: 'ebs-1' };
  },

  payment_batch_transmit: (fx) => {
    const { batchId } = batchReady(fx, 'ebt');
    fx.call('generate_pain001', { workspaceId: fx.workspaceId, batchId, idempotencyKey: 'ebt-gen' });
    return { workspaceId: fx.workspaceId, batchId, confirm: true, idempotencyKey: 'ebt-1' };
  },

  bank_channel_disconnect: (fx) => {
    const bankAccountId = bankAccount(fx, 'ebd');
    const c = fx.call('bank_channel_connect', {
      host: { url: 'https://ebics.example/ebics', hostId: 'EBICSHST', partnerId: 'PARTNER03', userId: 'USER0003' },
      routeBankAccountIds: [bankAccountId],
      confirm: true,
      idempotencyKey: 'ebd-conn',
    });
    return { workspaceId: fx.workspaceId, connectionId: c.connectionId, mode: 'retire', confirm: true, idempotencyKey: 'ebd-1' };
  },

  // --- E00, file management --------------------------------------------------------------------
  // Eight writes, each seeding its own file or folder through E00's own verbs. Two of them are worth
  // reading closely rather than skimming, because the gate's whole-database comparison is what proves
  // them and both would pass a weaker check while being wrong:
  //
  //   `files_upload` writes TWO rows on a real call, a `stored_file` and a `stored_file_blob`, and the
  //   blob is content-addressed. A verb that re-ran instead of replaying its key would leave a second
  //   metadata row pointing at the same blob, which no uniqueness constraint anywhere forbids: the
  //   blob table's PRIMARY KEY would silently absorb the duplicate content and only the snapshot
  //   would notice the duplicated filing.
  //
  //   `files_delete` runs as the fixture's actor, which is `agent`, so BOTH calls take the P8 staging
  //   path and the row is flagged rather than erased. That is the correct thing for this gate to
  //   exercise, because staging is what an agent actually gets; the erasing path, the blob going with
  //   it and the audit row it stamps are asserted in `test/files/` where the actor can be chosen.

  files_upload: (fx) => ({
    workspaceId: fx.workspaceId,
    title: 'Mietvertrag 2026',
    filename: 'mietvertrag.pdf',
    mime: 'application/pdf',
    contentBase64: Buffer.from('%PDF-1.4 Mietvertrag').toString('base64'),
    tags: ['vertrag', '2026'],
    idempotencyKey: 'fu-1',
  }),

  // G18 US-G18.4, the chunk-upload lane. `files_upload_begin` opens a session (one row, idempotent on
  // its key). `files_upload_chunk` seeds a session then appends seq 0 (idempotent: a replay writes no
  // second chunk row). `files_upload_commit` seeds a session + one chunk, then verifies the accumulated
  // sha256 and mints the blob once (a replay returns the same file, minting nothing).
  files_upload_begin: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'gl-export.csv',
    mediaType: 'text/csv',
    sizeBytes: 64,
    intent: 'migration_source',
    idempotencyKey: 'fub-1',
  }),

  files_upload_chunk: (fx) => {
    const begin = fx.call('files_upload_begin', {
      name: 'chunk-src.csv',
      mediaType: 'text/csv',
      sizeBytes: 5,
      intent: 'migration_source',
      idempotencyKey: 'fuc-begin',
    });
    return {
      workspaceId: fx.workspaceId,
      uploadId: begin.uploadId,
      seq: 0,
      contentBase64: Buffer.from('abcde').toString('base64'),
      idempotencyKey: 'fuc-1',
    };
  },

  files_upload_commit: (fx) => {
    const body = Buffer.from('Konto;Soll\n1000;10\n');
    const begin = fx.call('files_upload_begin', {
      name: 'commit-src.csv',
      mediaType: 'text/csv',
      sizeBytes: body.length,
      intent: 'migration_source',
      idempotencyKey: 'fux-begin',
    });
    fx.call('files_upload_chunk', {
      uploadId: begin.uploadId,
      seq: 0,
      contentBase64: body.toString('base64'),
      idempotencyKey: 'fux-chunk',
    });
    return {
      workspaceId: fx.workspaceId,
      uploadId: begin.uploadId,
      sha256: createHash('sha256').update(body).digest('hex'),
      idempotencyKey: 'fux-1',
    };
  },

  files_update: (fx) => {
    const file = storedFile(fx, 'fup');
    return {
      workspaceId: fx.workspaceId,
      fileId: file.id,
      patch: { title: 'Mietvertrag, unterzeichnet', tags: ['vertrag', 'unterzeichnet'] },
      idempotencyKey: 'fup-1',
    };
  },

  files_new_version: (fx) => {
    const file = storedFile(fx, 'fnv');
    return {
      workspaceId: fx.workspaceId,
      fileId: file.id,
      contentBase64: Buffer.from('%PDF-1.4 Mietvertrag Fassung 2').toString('base64'),
      idempotencyKey: 'fnv-1',
    };
  },

  files_link: (fx) => {
    const file = storedFile(fx, 'flk');
    const contact = fx.call('create_contact', {
      partyRole: 'customer',
      name: 'Vermieter AG',
      idempotencyKey: 'flk-contact',
    });
    return {
      workspaceId: fx.workspaceId,
      fileId: file.id,
      entityKind: 'contact',
      entityId: contact.contact.id,
      idempotencyKey: 'flk-1',
    };
  },

  // A file linked to a CONTACT carries no statutory floor (a contact is not a Buchungsbeleg), so this
  // scenario can set any date. The floor itself is exercised in `test/files/retention.test.mjs`, on a
  // file linked to an invoice, where a refusal is the correct answer and a scenario must succeed.
  files_set_retention: (fx) => {
    const file = storedFile(fx, 'fsr');
    return {
      workspaceId: fx.workspaceId,
      fileId: file.id,
      retentionUntil: '2036-12-31',
      idempotencyKey: 'fsr-1',
    };
  },

  files_delete: (fx) => {
    const file = storedFile(fx, 'fdl');
    return { workspaceId: fx.workspaceId, fileId: file.id, idempotencyKey: 'fdl-1' };
  },

  folders_upsert: (fx) => ({
    workspaceId: fx.workspaceId,
    name: 'Verträge',
    idempotencyKey: 'fo-1',
  }),

  folders_delete: (fx) => {
    const folder = fx.call('folders_upsert', { name: 'Leerer Ordner', idempotencyKey: 'fod-seed' });
    return { workspaceId: fx.workspaceId, folderId: folder.folder.id, idempotencyKey: 'fod-1' };
  },

  // --- E01, e-signature --------------------------------------------------------------------------
  // Six writes over E00 files. Two are worth reading closely: `sign_requests_send` succeeds only
  // because the scenario wires a `signTransmitter` into the deps (the `send_invoice` visible-
  // transport rule: the MIT core ships none, and without one the verb honestly refuses with
  // `needs_provider`, which rule 8 would report as a scenario that cannot succeed); and
  // `sign_requests_complete` drives the E00 delegation for real, so the replay comparison also
  // proves `files_new_version` minted exactly ONE new version row for two calls.

  sign_requests_create: (fx) => {
    const seed = signRequestSeed(fx, 'src');
    return {
      workspaceId: fx.workspaceId,
      fileId: seed.fileId,
      signerContactId: seed.signerContactId,
      signatureLevel: 'ses',
      message: 'Bitte Vertrag signieren',
      idempotencyKey: 'src-1',
    };
  },

  sign_requests_send: (fx) => {
    const seed = signRequestSeed(fx, 'sse');
    const req = fx.call('sign_requests_create', {
      fileId: seed.fileId,
      signerContactId: seed.signerContactId,
      signatureLevel: 'ses',
      idempotencyKey: 'sse-req',
    });
    // The same visible-transport rule as `send_invoice`: the OSS core ships no transmitter, so the
    // scenario injects one into the deps the gate calls with. `confirmed: true` is the P8 half.
    fx.deps.signTransmitter = { transmit: () => ({ ok: true, providerRef: 'prov-sse-1' }) };
    return {
      workspaceId: fx.workspaceId,
      signRequestId: req.signRequestId,
      confirmed: true,
      idempotencyKey: 'sse-1',
    };
  },

  sign_requests_record_event: (fx) => {
    const seed = signRequestSeed(fx, 'sre');
    const req = fx.call('sign_requests_create', {
      fileId: seed.fileId,
      signerContactId: seed.signerContactId,
      signatureLevel: 'ses',
      idempotencyKey: 'sre-req',
    });
    fx.deps.signTransmitter = { transmit: () => ({ ok: true, providerRef: 'prov-sre-1' }) };
    fx.call('sign_requests_send', { signRequestId: req.signRequestId, confirmed: true, idempotencyKey: 'sre-send' });
    return {
      workspaceId: fx.workspaceId,
      signRequestId: req.signRequestId,
      status: 'viewed',
      idempotencyKey: 'sre-1',
    };
  },

  // The manual/no-provider path (US-E01.4): the request never left `draft`, and completion is the
  // `draft -> signed` edge with the wet-ink scan. `originalSha256` anchors the requested version.
  sign_requests_complete: (fx) => {
    const seed = signRequestSeed(fx, 'sco');
    const req = fx.call('sign_requests_create', {
      fileId: seed.fileId,
      signerContactId: seed.signerContactId,
      signatureLevel: 'qes',
      idempotencyKey: 'sco-req',
    });
    return {
      workspaceId: fx.workspaceId,
      signRequestId: req.signRequestId,
      signedContentBase64: Buffer.from('%PDF-1.4 sco signiert').toString('base64'),
      originalSha256: seed.sha256,
      idempotencyKey: 'sco-1',
    };
  },

  sign_requests_withdraw: (fx) => {
    const seed = signRequestSeed(fx, 'swi');
    const req = fx.call('sign_requests_create', {
      fileId: seed.fileId,
      signerContactId: seed.signerContactId,
      signatureLevel: 'ses',
      idempotencyKey: 'swi-req',
    });
    fx.deps.signTransmitter = { transmit: () => ({ ok: true, providerRef: 'prov-swi-1' }) };
    fx.call('sign_requests_send', { signRequestId: req.signRequestId, confirmed: true, idempotencyKey: 'swi-send' });
    return { workspaceId: fx.workspaceId, signRequestId: req.signRequestId, idempotencyKey: 'swi-1' };
  },

  sign_requests_delete_draft: (fx) => {
    const seed = signRequestSeed(fx, 'sdd');
    const req = fx.call('sign_requests_create', {
      fileId: seed.fileId,
      signerContactId: seed.signerContactId,
      signatureLevel: 'ses',
      idempotencyKey: 'sdd-req',
    });
    return { workspaceId: fx.workspaceId, signRequestId: req.signRequestId, idempotencyKey: 'sdd-1' };
  },

  // --- F02, customer portal ----------------------------------------------------------------------
  // Five writes. Three are operator verbs over a `portal_grant`. The last two are TOKEN-authenticated
  // and pre-workspace, so each mints its token through `portal_grant_create` (returned once as
  // `tokenOnce`): `portal_resolve` STAMPS `last_resolved_at` and appends the revDSG access-trail row on
  // every read-through (a write, not a read: it records that the token was seen), and
  // `portal_quote_accept` drives C02's real accept through the token. The extra `workspaceId` `fx.call`
  // binds is harmless: the depsAction reads the token, never the tenant.
  portal_grant_create: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Portal AG', idempotencyKey: 'pgc-contact' });
    return {
      workspaceId: fx.workspaceId,
      contactId: c.contact.id,
      scopes: [{ kind: 'all_invoices' }],
      expiresAt: '2027-01-31',
      idempotencyKey: 'pgc-1',
    };
  },

  portal_grant_send: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Portal-Send AG', idempotencyKey: 'pgs-contact' });
    const g = fx.call('portal_grant_create', {
      contactId: c.contact.id,
      scopes: [{ kind: 'all_invoices' }],
      expiresAt: '2027-01-31',
      idempotencyKey: 'pgs-grant',
    });
    // P8: the outbound half is confirm-gated. The OSS core wires no transport, so this degrades to
    // sent:false/reason:cloud_tier and activates the grant (draft -> active), idempotent on replay.
    return { workspaceId: fx.workspaceId, grantId: g.grantId, confirmed: true, idempotencyKey: 'pgs-1' };
  },

  portal_grant_revoke: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Portal-Revoke AG', idempotencyKey: 'pgr-contact' });
    const g = fx.call('portal_grant_create', {
      contactId: c.contact.id,
      scopes: [{ kind: 'all_invoices' }],
      expiresAt: '2027-01-31',
      idempotencyKey: 'pgr-grant',
    });
    return { workspaceId: fx.workspaceId, grantId: g.grantId, idempotencyKey: 'pgr-1' };
  },

  portal_resolve: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Portal-Resolve AG', idempotencyKey: 'pres-contact' });
    const g = fx.call('portal_grant_create', {
      contactId: c.contact.id,
      scopes: [{ kind: 'all_invoices' }],
      expiresAt: '2027-01-31',
      idempotencyKey: 'pres-grant',
    });
    // Token-authenticated, pre-workspace: the grant binds the tenant, so no workspaceId is passed. The
    // double-call gate re-runs this write (it carries no key) and skips the audit tables; the frozen
    // clock stamps the same last_resolved_at both times, so the business row does not move.
    return { token: g.tokenOnce };
  },

  portal_quote_accept: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Portal-Accept AG', idempotencyKey: 'pqa-contact' });
    const q = fx.call('quotes_create', { contactId: c.contact.id, validUntil: '2027-01-31', lines: [{ description: 'Leistung', unitPriceMinor: 20000 }], idempotencyKey: 'pqa-quote' });
    fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 'pqa-send' });
    const g = fx.call('portal_grant_create', {
      contactId: c.contact.id,
      scopes: [{ kind: 'quote', id: q.document.id }],
      expiresAt: '2027-01-31',
      idempotencyKey: 'pqa-grant',
    });
    return { token: g.tokenOnce, quoteId: q.document.id, idempotencyKey: 'pqa-1' };
  },

  // --- F03, vendor portal ------------------------------------------------------------------------
  // Three writes. Two are operator grant wrappers over F02's shared engine (kind=vendor); the third
  // SNAPSHOTS an A14 payment settling an A17 bill into a remittance advice and files an E00 artifact,
  // posting nothing. Each carries an idempotencyKey, so the gate's replay comparison proves the keyed
  // second call touches ZERO rows (the advice's E00 artifact included: the upload is keyed too).
  vendor_portal_grant: (fx) => {
    const v = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Portal AG', idempotencyKey: 'vpg-vendor' });
    return {
      workspaceId: fx.workspaceId,
      contactId: v.contact.id,
      expiresAt: '2027-01-31',
      idempotencyKey: 'vpg-1',
    };
  },

  vendor_portal_revoke: (fx) => {
    const v = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Revoke AG', idempotencyKey: 'vpr-vendor' });
    const g = fx.call('vendor_portal_grant', { contactId: v.contact.id, expiresAt: '2027-01-31', idempotencyKey: 'vpr-grant' });
    return { workspaceId: fx.workspaceId, grantId: g.grantId, idempotencyKey: 'vpr-1' };
  },

  // A real outgoing supplier payment settling a posted A17 bill, then the advice over it. The advice
  // snapshots the A14 allocation figures and files a local E00 artifact; it POSTS NOTHING (the payment
  // was already posted by record_payment). The keyed replay returns the same advice and writes nothing.
  vendor_portal_remittance_create: (fx) => {
    const bill = fx.call('create_vendor_bill', vendorBillInput(fx, 'vprc'));
    fx.call('post_vendor_bill', { vendorBillId: bill.vendorBillId, idempotencyKey: 'vprc-post' });
    const paid = fx.call('record_payment', {
      direction: 'outgoing',
      date: '2026-03-20',
      amountMinor: 108100,
      bankAccountId: fx.accId('1020'),
      allocations: [{ vendorBillId: bill.vendorBillId, amountMinor: 108100 }],
      intent: 'post_payment',
      idempotencyKey: 'vprc-pay',
    });
    return { workspaceId: fx.workspaceId, paymentId: paid.paymentId, idempotencyKey: 'vprc-1' };
  },

  // --- A25, review & export ----------------------------------------------------------------------
  // Four writes, each on a REAL posted entry (seeded through post_entry, never a faked row), so the
  // gate's replay comparison proves what matters here: a review verb appends exactly one
  // entry_review event on the first call and NOTHING on the keyed second call, and the journal
  // tables it annotates never move at all. The dedicated sidecar tripwire (journal bytes identical
  // across every review verb, cross-tenant isolation, prepare's no-duplicate re-run) lives in
  // test/review/.

  comment_entry: (fx) => {
    const posted = fx.call('post_entry', manualPost(fx.accId, 'ce-seed'));
    return {
      workspaceId: fx.workspaceId,
      entryId: posted.entryId,
      text: 'Wozu gehört dieser Beleg?',
      idempotencyKey: 'ce-1',
    };
  },

  flag_entry: (fx) => {
    const posted = fx.call('post_entry', manualPost(fx.accId, 'fe-seed'));
    return {
      workspaceId: fx.workspaceId,
      entryId: posted.entryId,
      reason: 'Beleg fehlt',
      idempotencyKey: 'fe-1',
    };
  },

  approve_entry: (fx) => {
    const posted = fx.call('post_entry', manualPost(fx.accId, 'ae-seed'));
    return { workspaceId: fx.workspaceId, entryId: posted.entryId, idempotencyKey: 'ae-1' };
  },

  // The period holds one posted entry and one flagged anomaly shape (a line with no tax code on an
  // account carrying a VAT default), so prepare does real work: it writes at least one machine flag
  // on the first call and replays the stored packet on the second, leaving the database untouched.
  prepare_period: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('vat_configure', { method: 'effektiv', timing: 'soll', registered: true, idempotencyKey: 'pp-vc' });
    fx.call('account_set_tax_default', { accountId: fx.accId('6500'), taxCode: 'VST-M' });
    fx.call('post_entry', manualPost(fx.accId, 'pp-seed'));
    return { workspaceId: fx.workspaceId, period: '2026-03', idempotencyKey: 'pp-1' };
  },

  // --- A26, agent bookkeeping ------------------------------------------------------------------
  // The dial write. `manage_agent_dial` is owner-only, and the fixture actor resolves as owner on an
  // unprovisioned workspace, so the call is permitted; the double-call proves the keyed replay writes
  // nothing the second time.
  set_agent_dial: (fx) => {
    // F1: a dial write is a HUMAN act and the governed agent seat is refused (cannot_self_grant /
    // the A24 step-0 denial), so this scenario runs its fixture as the studio seat.
    fx.deps.actor = 'studio';
    return { workspaceId: fx.workspaceId, capability: 'post', level: 'auto', idempotencyKey: 'sad-1' };
  },

  // Approve replays the drafted verb through the shared dispatch as the approver and marks the row
  // executed. The seeded row's drafting actor differs from the approver, so it is not a self-approve.
  // Key-exempt: the actionId IS the key, so the second call finds it executed and replays the stored
  // result, moving nothing (the underlying config write also carries its own key).
  approve_drafted_action: (fx) => {
    // F1: approve rides manage_agent_dial, which the agent seat never holds; the approver is human.
    fx.deps.actor = 'studio';
    const id = seedDraftedAction(fx, 'aa-approve', 'set_aging_bucket_config', {
      workspaceId: fx.workspaceId,
      boundariesDays: [30, 60, 90],
      idempotencyKey: 'aa-approve-inner',
    });
    return { workspaceId: fx.workspaceId, actionId: id };
  },

  reject_drafted_action: (fx) => {
    // F1: reject rides manage_agent_dial too; the decider is human. The reason (F-08, J5.6) rides
    // along so the scenario exercises the stored sentence, not only the status flip.
    fx.deps.actor = 'studio';
    const id = seedDraftedAction(fx, 'aa-reject', 'set_aging_bucket_config', {
      workspaceId: fx.workspaceId,
      boundariesDays: [30, 60, 90],
      idempotencyKey: 'aa-reject-inner',
    });
    return { workspaceId: fx.workspaceId, actionId: id, reason: 'Falsche Staffelung, bitte 30/60/90/120.' };
  },

  // A35's composer verb (D90 D-1): needs the registered stub runtime (the E05/E06 scenario door).
  // It persists the prose turn and executes ONE read (ledger_qa here); the keyed double-call proves
  // the replay writes no second turn and no second call row.
  agent_ask: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    return { workspaceId: fx.workspaceId, text: 'Wie hoch ist der Umsatz?', idempotencyKey: 'ask-1' };
  },

  // A35's prose erasure (D90 D-5): seeds a session WITH prose through agent_ask, then clears it.
  // The keyed double-call settles; the call trace stays (asserted in test/agent/trace.test.mjs).
  agent_prose_delete: (fx) => {
    // F1: the erasure rides manage_agent_dial; the asker can be anyone with read_books, so the
    // fixture asks first and then flips to the human decider for the delete under test.
    registerRuntime(stubAdapter(), stubManifest());
    const asked = fx.call('agent_ask', { workspaceId: fx.workspaceId, text: 'Wie hoch ist der Umsatz?', idempotencyKey: 'apd-seed' });
    fx.deps.actor = 'studio';
    return { workspaceId: fx.workspaceId, sessionId: asked.sessionId, idempotencyKey: 'apd-1' };
  },

  // --- G10, migration maps ---------------------------------------------------------------------
  // Every scenario seeds its `migration_plan` row directly: the verb that creates a plan is G09's
  // (next wave), so the precondition is seeded through the store the way `seedDraftedAction` seeds
  // A26's inbox. The map itself is exercised through G10's own verbs against the workspace's REAL
  // chart and REAL tax codes, so target validation is on the true path, not a fixture of it.
  //
  // The account map deliberately carries one MAPPED account with a balance, one UNMAPPED zero-
  // balance account (ignorable, so the save is legal and `complete` is still false), because a
  // scenario that only ever saved a trivially complete map would leave the blocking read model
  // undriven over the wire.
  migration_set_map: (fx) => {
    seedMigrationPlan(fx, 'plan-msm');
    return {
      workspaceId: fx.workspaceId,
      planId: 'plan-msm',
      kind: 'account',
      entries: [
        { source: '1010', sourceName: 'Kasse Hauptsitz', balanceMinor: 250000, target: '1000' },
        { source: '9999', sourceName: 'Stillgelegtes Konto', balanceMinor: 0, target: null },
      ],
      idempotencyKey: 'msm-1',
    };
  },

  // Saves a template FROM a real map (set through the verb, not a row), so the snapshot path and
  // the client-figure stripping both run; the double-call replays the key and mints no second row.
  migration_save_map_template: (fx) => {
    seedMigrationPlan(fx, 'plan-mst');
    fx.call('migration_set_map', {
      planId: 'plan-mst',
      kind: 'account',
      entries: [{ source: '1010', sourceName: 'Kasse', balanceMinor: 120000, target: '1000' }],
      idempotencyKey: 'mst-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      planId: 'plan-mst',
      name: 'Standard Kassen-Zuordnung',
      sourceSystem: 'csv',
      kinds: ['account'],
      idempotencyKey: 'mst-1',
    };
  },

  // Applies a template saved from one plan onto a SECOND plan whose map has the same source
  // unmapped plus one source the template does not cover, so applied[] and new[] are both real.
  migration_apply_map_template: (fx) => {
    seedMigrationPlan(fx, 'plan-mat-a');
    fx.call('migration_set_map', {
      planId: 'plan-mat-a',
      kind: 'account',
      entries: [{ source: '1010', sourceName: 'Kasse', target: '1000' }],
      idempotencyKey: 'mat-map-a',
    });
    const saved = fx.call('migration_save_map_template', {
      planId: 'plan-mat-a',
      name: 'Kassen-Vorlage',
      sourceSystem: 'csv',
      kinds: ['account'],
      idempotencyKey: 'mat-tpl',
    });
    seedMigrationPlan(fx, 'plan-mat-b');
    fx.call('migration_set_map', {
      planId: 'plan-mat-b',
      kind: 'account',
      entries: [
        { source: '1010', sourceName: 'Kasse', balanceMinor: 50000, target: null },
        { source: '1021', sourceName: 'Zweitbank', balanceMinor: 0, target: null },
      ],
      idempotencyKey: 'mat-map-b',
    });
    return {
      workspaceId: fx.workspaceId,
      planId: 'plan-mat-b',
      templateId: saved.templateId,
      idempotencyKey: 'mat-1',
    };
  },

  // --- G09, the migration harness --------------------------------------------------------------
  // Every scenario drives the REAL plan/step verbs (the plan-creating verb is G09's now). The two
  // that need a committed or checked step use `contacts` (non-money, a real idempotent commit of
  // zero rows: the step has no linked source file, so the commit routes through `contacts_import`
  // with an empty batch and the double-call replays its key) and `opening_balances` (money-path:
  // the commit draft-stages without an approval, which is what leaves the step `checked` with the
  // hash `migration_record_approval` then binds to). A past Übernahmestichtag avoids cutover_in_future.
  migration_create_plan: (fx) => ({
    workspaceId: fx.workspaceId,
    sourceSystem: 'bexio',
    cutoverDate: '2020-01-01',
    localePack: 'ch',
    idempotencyKey: 'mcp-1',
  }),

  migration_set_scope: (fx) => {
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'csv',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'mss-plan',
    }).planId;
    return { workspaceId: fx.workspaceId, planId, classes: [{ dataClass: 'contacts', include: true }], idempotencyKey: 'mss-1' };
  },

  migration_trial_load_step: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mtl', 'contacts');
    return { workspaceId: fx.workspaceId, planId, stepId, idempotencyKey: 'mtl-1' };
  },

  migration_commit_step: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mcs', 'contacts');
    fx.call('migration_trial_load_step', { planId, stepId, idempotencyKey: 'mcs-trial' });
    return { workspaceId: fx.workspaceId, planId, stepId, idempotencyKey: 'mcs-1' };
  },

  // G21: import one open AR item as an origin=migrated document that posts NOTHING. Seeds VAT (so the
  // tax code resolves), a customer and a plan; the row carries the source number and its resolved
  // tax as a stored value (P6). The double-call the gate performs proves §H-IDEMPOTENT on the key
  // (one document per source item, never two). preview_open_items is a READ, so it needs no scenario.
  import_open_items: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Übernahme AG', idempotencyKey: 'ioi-ct' });
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'csv',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'ioi-plan',
    }).planId;
    return {
      workspaceId: fx.workspaceId,
      planId,
      side: 'ar',
      rows: [
        {
          contactId: c.contact.id,
          number: 'SRC-OI-1',
          issueDate: '2019-12-01',
          dueDate: '2020-01-15',
          currency: 'CHF',
          lines: [{ description: 'Übernommene Rechnung', netMinor: 100000, taxMinor: 7700, taxCode: 'UST81', supplyDate: '2019-12-01' }],
        },
      ],
      idempotencyKey: 'ioi-1',
    };
  },

  migration_record_approval: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mra', 'opening_balances');
    fx.call('migration_trial_load_step', { planId, stepId, idempotencyKey: 'mra-trial' });
    const staged = fx.call('migration_commit_step', { planId, stepId, idempotencyKey: 'mra-commit' });
    return { workspaceId: fx.workspaceId, planId, stepId, checkHash: staged.checkHash, idempotencyKey: 'mra-1' };
  },

  migration_rollback_step: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mrb', 'contacts');
    fx.call('migration_trial_load_step', { planId, stepId, idempotencyKey: 'mrb-trial' });
    fx.call('migration_commit_step', { planId, stepId, idempotencyKey: 'mrb-commit' });
    return { workspaceId: fx.workspaceId, planId, stepId, confirmed: true, idempotencyKey: 'mrb-1' };
  },

  migration_abandon_plan: (fx) => {
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'csv',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'mab-plan',
    }).planId;
    return { workspaceId: fx.workspaceId, planId, confirmed: true, idempotencyKey: 'mab-1' };
  },

  // migration_close_plan (G18 R4) is legal only from `live` with every step terminal. The trial-run
  // verbs cannot drive a plan to `live` without a full go-live, so the scenario stands the plan and
  // its one step in the terminal shape directly (the way seedMigrationPlan seeds a plan row), then
  // closes it. The double-call proves §H-IDEMPOTENT on the close.
  migration_close_plan: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mcl', 'contacts');
    fx.deps.store.db.prepare("UPDATE migration_step SET status = 'skipped' WHERE id = ? AND workspace_id = ?").run(stepId, fx.workspaceId);
    fx.deps.store.db.prepare("UPDATE migration_plan SET status = 'live' WHERE id = ? AND workspace_id = ?").run(planId, fx.workspaceId);
    return { workspaceId: fx.workspaceId, planId, confirmed: true, idempotencyKey: 'mcl-1' };
  },

  // --- G19, the extraction companion -------------------------------------------------------------
  // Both writes run over a bexio plan (whose guide has known item ids). set_manifest instantiates
  // from the guide; set_manifest_item records one item, exercised over the instantiated manifest.
  // The double-call the gate performs proves §H-IDEMPOTENT on each write's key.
  migration_set_manifest: (fx) => {
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'bexio',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'msm-plan',
    }).planId;
    return { workspaceId: fx.workspaceId, planId, sourceAccessUntil: '2020-06-01', idempotencyKey: 'msm-1' };
  },

  migration_set_manifest_item: (fx) => {
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'bexio',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'msmi-plan',
    }).planId;
    fx.call('migration_set_manifest', { planId, idempotencyKey: 'msmi-manifest' });
    return { workspaceId: fx.workspaceId, planId, itemId: 'contacts', status: 'exported', rowCount: 12, idempotencyKey: 'msmi-1' };
  },

  // --- G20, implementation projects --------------------------------------------------------------
  // Every write runs over a project created on a FUTURE cutover (the fixture clock is 2026-07-16, so
  // 2027-06-30 avoids cutover_in_past) with the effektiv method (so a 2027-Q2 window aligns). The
  // sign-off scenario runs as the STUDIO seat, because a sign-off is a human act the agent seat is
  // refused (signoff_needs_human, US-G20.5). The parallel declare/check run over the empty book, so a
  // declared 0 passes to the Rappen. Each double-call proves §H-IDEMPOTENT on the key.
  implementation_project_create: (fx) => ({
    workspaceId: fx.workspaceId,
    sourceSystem: 'bexio',
    cutoverDate: '2027-06-30',
    mwstMethod: 'effektiv',
    idempotencyKey: 'ipc-1',
  }),

  implementation_runbook_instantiate: (fx) => {
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'iri-proj' }).projectId;
    return { workspaceId: fx.workspaceId, projectId, templateId: 'w3_cutover', idempotencyKey: 'iri-1' };
  },

  implementation_task_set: (fx) => {
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'its-proj' }).projectId;
    return { workspaceId: fx.workspaceId, projectId, fields: { phase: 'discovery', title: 'Exportliste anlegen', ownerKind: 'agent' }, idempotencyKey: 'its-1' };
  },

  implementation_decision_record: (fx) => {
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'idr-proj' }).projectId;
    return { workspaceId: fx.workspaceId, projectId, title: 'Stichtag verschoben', context: 'Quellsystem noch nicht bereit', decision: 'Neuer Stichtag 2027-07-31', idempotencyKey: 'idr-1' };
  },

  implementation_signoff_record: (fx) => {
    // A sign-off is a HUMAN act: the studio seat, not the agent (signoff_needs_human).
    fx.deps.actor = 'studio';
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'isr-proj' }).projectId;
    return { workspaceId: fx.workspaceId, projectId, kind: 'conversion_date', evidenceRef: 'beleg-freigabe-2027-06-30', idempotencyKey: 'isr-1' };
  },

  implementation_parallel_declare: (fx) => {
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'ipd-proj' }).projectId;
    return { workspaceId: fx.workspaceId, projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'ipd-1' };
  },

  implementation_parallel_check: (fx) => {
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'ipk-proj' }).projectId;
    fx.call('implementation_parallel_declare', { projectId, period: '2027-Q2', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: 0 }], idempotencyKey: 'ipk-decl' });
    return { workspaceId: fx.workspaceId, projectId, period: '2027-Q2', idempotencyKey: 'ipk-1' };
  },

  implementation_project_close: (fx) => {
    // Close is legal only from the live phase with the closing sign-offs and terminal Stabilisierung
    // tasks. This scenario stands the project directly in that shape (the migration_close_plan pattern),
    // then closes it; the double-call proves §H-IDEMPOTENT on the close.
    fx.deps.actor = 'studio';
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'ipx-proj' }).projectId;
    fx.deps.store.db.prepare("UPDATE implementation_project SET status = 'live' WHERE id = ? AND workspace_id = ?").run(projectId, fx.workspaceId);
    fx.call('implementation_signoff_record', { projectId, kind: 'parallel_run_close', evidenceRef: 'parallellauf-2027', idempotencyKey: 'ipx-src-close' });
    fx.call('implementation_signoff_record', { projectId, kind: 'source_cancellation', evidenceRef: 'aufbewahrungsbuendel-2027', idempotencyKey: 'ipx-src-cancel' });
    return { workspaceId: fx.workspaceId, projectId, confirmed: true, idempotencyKey: 'ipx-1' };
  },

  // --- G22, checklists ------------------------------------------------------------------------------
  // Every scenario walks the real `vat_period` template over a configured effektiv workspace at the
  // fixture clock (2026-07-16), so 2026-Q2 has ended and is startable. The three system checks pass on
  // an empty book (no drafts, nothing on the bank, no missing tax codes), so `vat_return_computed` is
  // the first agent item and completes with the engine-bound return hash.
  checklist_start: (fx) => {
    seedChecklistWorld(fx);
    return { workspaceId: fx.workspaceId, templateId: 'vat_period', period: '2026-Q2', idempotencyKey: 'chk-start-1' };
  },
  checklist_item_complete: (fx) => {
    const runId = seedChecklistRun(fx, 'chk-complete');
    return { workspaceId: fx.workspaceId, runId, itemId: 'vat_return_computed', idempotencyKey: 'chk-complete-1' };
  },
  checklist_item_skip: (fx) => {
    const runId = seedChecklistRun(fx, 'chk-skip');
    return { workspaceId: fx.workspaceId, runId, itemId: 'ech0217_exported', reason: 'Diese Periode wird im ePortal von Hand erfasst.', idempotencyKey: 'chk-skip-1' };
  },
  checklist_item_reopen: (fx) => {
    const runId = seedChecklistRun(fx, 'chk-reopen');
    fx.call('checklist_item_skip', { runId, itemId: 'abstimmung_reviewed', reason: 'Keine Abstimmung nötig.', idempotencyKey: 'chk-reopen-skip' });
    return { workspaceId: fx.workspaceId, runId, itemId: 'abstimmung_reviewed', idempotencyKey: 'chk-reopen-1' };
  },
  checklist_abandon: (fx) => {
    const runId = seedChecklistRun(fx, 'chk-abandon');
    return { workspaceId: fx.workspaceId, runId, reason: 'Falsche Periode gestartet.', idempotencyKey: 'chk-abandon-1' };
  },

  // --- A38, the MWST-Saldierung (D129 leg 2) -------------------------------------------------------
  // `vat_settlement_post` transfers a FILED quarter's 2200 balance to 2201 INSIDE the filing lock (the
  // A38 §4.6 carve-out), so the double call is doing its most valuable work: the same key must leave ONE
  // settlement entry and ONE row, and a period settled twice would double the ESTV liability. The seed
  // posts one tagged sale into 2026-Q2 (Cr 3200 100'000.00 UST81, Cr 2200 8'100.00) and files the
  // quarter through A07's own verb, never by writing a lock by hand.
  vat_settlement_post: (fx) => {
    seedSettledQuarter(fx, 'vsp', false);
    return { workspaceId: fx.workspaceId, period: '2026-Q2', idempotencyKey: 'vsp-1' };
  },
  vat_settlement_reverse: (fx) => {
    const settlementId = seedSettledQuarter(fx, 'vsr', true);
    return { workspaceId: fx.workspaceId, settlementId, idempotencyKey: 'vsr-1' };
  },

  // --- G11, the Eröffnungsprüfung ----------------------------------------------------------------
  // All three writes run over an `opening_balances` step minted through the real G09 verbs. The
  // declare scenario states an expectation; the check scenario runs the real trial-run check (its
  // inner idempotency on (stepId, against, inputHash) is what the double-call proves); the waive
  // scenario first declares a total for an account the empty step does not hold, which the check
  // widens into a FAILED control (a position missing from the import), the honest thing a waiver is
  // for.
  migration_declare_control_total: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mdc', 'opening_balances');
    return {
      workspaceId: fx.workspaceId,
      planId,
      stepId,
      kind: 'trial_balance_matches_source',
      scope: '1100',
      declaredMinor: 250000,
      idempotencyKey: 'mdc-1',
    };
  },

  migration_check_step: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mck', 'opening_balances');
    return { workspaceId: fx.workspaceId, planId, stepId, against: 'testmandant', idempotencyKey: 'mck-1' };
  },

  migration_waive_control: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mwc', 'opening_balances');
    fx.call('migration_declare_control_total', {
      planId,
      stepId,
      kind: 'trial_balance_matches_source',
      scope: '9999',
      declaredMinor: 5000,
      idempotencyKey: 'mwc-declare',
    });
    const checked = fx.call('migration_check_step', { planId, stepId, against: 'testmandant', idempotencyKey: 'mwc-check' });
    const failing = checked.controls.find((c) => c.status === 'failed');
    return {
      workspaceId: fx.workspaceId,
      controlId: failing.controlId,
      reason: 'Bewusst aus dem alten System übernommen; Beleg liegt beim Treuhänder.',
      idempotencyKey: 'mwc-1',
    };
  },

  // --- G13 GL archive ---------------------------------------------------------------------------
  // Both writes drive the REAL chain: the export uploaded as the E00 Beleg, discovered onto a plan,
  // the gl_history class scoped in, and the archive imported. The import is idempotent two ways
  // (the memoised key, and wholesale replacement landing the identical archive); the purge uses
  // 2012 dates so the OR 958f retention (end of fiscal year + 10) is expired against the pinned
  // 2026 clock, and carries the confirm and the recorded reason the verb requires.
  gl_archive_import: (fx) => {
    const { planId, stepId } = seedG13HistoryStep(fx, 'gai');
    return { workspaceId: fx.workspaceId, planId, stepId, idempotencyKey: 'gai-1' };
  },

  gl_archive_purge: (fx) => {
    const { planId, stepId } = seedG13HistoryStep(fx, 'gap');
    fx.call('gl_archive_import', { planId, stepId, idempotencyKey: 'gap-import' });
    return {
      workspaceId: fx.workspaceId,
      periodFrom: '2012-01',
      periodTo: '2012-12',
      reason: 'Aufbewahrungsfrist abgelaufen',
      confirmed: true,
      idempotencyKey: 'gap-1',
    };
  },

  // --- G12 Testmandant --------------------------------------------------------------------------
  // Every scenario drives the REAL verbs. Create provisions the trial workspace off a real plan and
  // is idempotent per plan; discard hard-deletes it and replays its key. `go_productive` sets up a
  // promotable Testmandant (a real company profile, a clean empty check, a unique UID) and passes the
  // engine-side type-to-confirm (the exact legal name), so the double-call promotes once and the
  // second call is the idempotent already-live no-op.
  migration_create_testmandant: (fx) => {
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'csv',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'mct-plan',
    }).planId;
    return { workspaceId: fx.workspaceId, planId, idempotencyKey: 'mct-1' };
  },

  go_productive: (fx) => {
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'csv',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'gop-plan',
    }).planId;
    const t = fx.call('migration_create_testmandant', { planId, idempotencyKey: 'gop-t' });
    // Configure the Testmandant's real company profile (legal form + a unique UID); vat_registered
    // stays 0, so no MWST number is required. Then read its legal name for the type-to-confirm.
    fx.call('update_company_profile', { workspaceId: t.workspaceId, legalForm: 'gmbh', uid: 'CHE-123.456.789' });
    const profile = fx.call('get_company_profile', { workspaceId: t.workspaceId });
    return { workspaceId: fx.workspaceId, planId, confirmedName: profile.profile.name, idempotencyKey: 'gop-1' };
  },

  discard_testmandant: (fx) => {
    const planId = fx.call('migration_create_plan', {
      sourceSystem: 'csv',
      cutoverDate: '2020-01-01',
      localePack: 'ch',
      idempotencyKey: 'dst-plan',
    }).planId;
    fx.call('migration_create_testmandant', { planId, idempotencyKey: 'dst-t' });
    return { workspaceId: fx.workspaceId, planId, confirmed: true, idempotencyKey: 'dst-1' };
  },

  // --- E02, HR-lite (employees, absences, expense claims) --------------------------------------
  // Each drives the REAL verbs. The money-path pair is exercised with confirm:true so the double
  // call posts (approve) / pays (reimburse) ONCE and replays its memo the second time. The approve
  // and reimburse claims have a distinct `created_by` (seedSubmittedClaim) so the fixture actor can
  // approve without a self-approval refusal.
  hr_employee_upsert: (fx) => ({ workspaceId: fx.workspaceId, employee: { firstName: 'Alex', lastName: 'Muster', employmentPct: 80, startsOn: '2026-01-01' }, idempotencyKey: 'emp-1' }),
  hr_absence_record: (fx) => ({ workspaceId: fx.workspaceId, employeeId: seedEmployee(fx, 'ar', false), kind: 'vacation', fromDate: '2026-07-01', toDate: '2026-07-03', idempotencyKey: 'ar-1' }),
  hr_absence_cancel: (fx) => {
    const employeeId = seedEmployee(fx, 'ac', false);
    const absenceId = fx.call('hr_absence_record', { employeeId, kind: 'sick', fromDate: '2026-07-01', toDate: '2026-07-02', idempotencyKey: 'ac-ab' }).absenceId;
    return { workspaceId: fx.workspaceId, absenceId, idempotencyKey: 'ac-1' };
  },
  expense_claim_create: (fx) => ({ workspaceId: fx.workspaceId, employeeId: seedEmployee(fx, 'ecc', false), title: 'Reise Zürich', idempotencyKey: 'ecc-1' }),
  expense_line_upsert: (fx) => {
    const employeeId = seedEmployee(fx, 'elu', false);
    const claimId = fx.call('expense_claim_create', { employeeId, title: 'Reise', idempotencyKey: 'elu-c' }).claimId;
    return { workspaceId: fx.workspaceId, claimId, line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 4000 }, idempotencyKey: 'elu-1' };
  },
  expense_claim_submit: (fx) => {
    const employeeId = seedEmployee(fx, 'ecs', false);
    const claimId = fx.call('expense_claim_create', { employeeId, title: 'Reise', idempotencyKey: 'ecs-c' }).claimId;
    fx.call('expense_line_upsert', { claimId, line: { expenseDate: '2026-06-15', category: 'travel', amountMinor: 4000 }, idempotencyKey: 'ecs-l' });
    return { workspaceId: fx.workspaceId, claimId, idempotencyKey: 'ecs-1' };
  },
  expense_claim_approve: (fx) => ({ workspaceId: fx.workspaceId, claimId: seedSubmittedClaim(fx, 'eca').claimId, confirm: true, idempotencyKey: 'eca-1' }),
  expense_claim_reject: (fx) => ({ workspaceId: fx.workspaceId, claimId: seedSubmittedClaim(fx, 'ecj').claimId, reason: 'Beleg fehlt', idempotencyKey: 'ecj-1' }),
  expense_claim_reimburse: (fx) => {
    const { claimId } = seedSubmittedClaim(fx, 'ecr');
    fx.call('expense_claim_approve', { claimId, confirm: true, idempotencyKey: 'ecr-ap' });
    return { workspaceId: fx.workspaceId, claimId, bankAccountId: fx.accId('1020'), confirm: true, idempotencyKey: 'ecr-1' };
  },

  // --- E04 local mail store ----------------------------------------------------------------------
  // Each scenario builds a REAL on-disk Thunderbird Maildir in a temp directory (the fixtures the
  // mail suites share), so the gate's double-call exercises the actual adapter walk and the actual
  // Drafts write, not a stub. The double-call is exactly the §H-IDEMPOTENT claim that matters most
  // here: `mail_draft_write` twice under one key must land ONE message in the Drafts folder.
  mail_connect: (fx) => {
    const root = seedMailStore('mcn');
    return { workspaceId: fx.workspaceId, adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'mcn-1' };
  },
  mail_reindex: (fx) => {
    const root = seedMailStore('mri');
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'mri-c' });
    return { workspaceId: fx.workspaceId, accountId: account.accountId, idempotencyKey: 'mri-1' };
  },
  mail_draft_write: (fx) => {
    const root = seedMailStore('mdw');
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'mdw-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'mdw-r' });
    const threads = fx.call('mail_threads_list', { bucket: 'needs_reply' });
    return { workspaceId: fx.workspaceId, threadId: threads.items[0].id, body: 'Gerne, das passt.', idempotencyKey: 'mdw-1' };
  },

  // --- E05 voice profile + OP6 local runtime ----------------------------------------------------
  // Both writes run over the REAL seams: a registered stub adapter (deterministic embeddings, the
  // spec's own §8 test design; the registry is process state, so registering it is not a database
  // write) and a real on-disk Maildir carrying the 20-message corpus floor plus one. The
  // double-call is the claim that matters here: `voice_build` twice under one key must land ONE
  // profile and ONE set of exemplar rows, embeddings bit-identical.
  runtime_select: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    return { workspaceId: fx.workspaceId, modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'rsel-1' };
  },
  voice_build: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const root = seedVoiceMailStore('vb');
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'vb-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'vb-r' });
    fx.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'vb-sel' });
    return { workspaceId: fx.workspaceId, accountId: account.accountId, idempotencyKey: 'vb-1' };
  },

  // --- E06 ledger-grounded drafts ----------------------------------------------------------------
  // The full local loop over REAL seams: a registered stub adapter, an on-disk Maildir with a
  // needs-reply inbound thread, a built voice profile. The double-call is exactly the harm the
  // spec names (US-E06.1 Boundary): one key must land ONE draft_run row and ONE message in the
  // Drafts folder, because a duplicated draft to a therapy client is a real harm. The scenario
  // sender resolves to NO contact, so the run is UNGROUNDED by construction (the consent gate's
  // own suites live in test/drafting/).
  draft_generate: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const root = seedVoiceMailStore('dg');
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'dg-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'dg-r' });
    fx.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'dg-sel' });
    fx.call('voice_build', { accountId: account.accountId, idempotencyKey: 'dg-b' });
    const threads = fx.call('mail_threads_list', { bucket: 'needs_reply' });
    return { workspaceId: fx.workspaceId, threadId: threads.items[0].id, idempotencyKey: 'dg-1' };
  },
  draft_regenerate: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const root = seedVoiceMailStore('dr');
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'dr-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'dr-r' });
    fx.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'dr-sel' });
    fx.call('voice_build', { accountId: account.accountId, idempotencyKey: 'dr-b' });
    const threads = fx.call('mail_threads_list', { bucket: 'needs_reply' });
    const generated = fx.call('draft_generate', { threadId: threads.items[0].id, idempotencyKey: 'dr-g' });
    return { workspaceId: fx.workspaceId, draftRunId: generated.draftRunId, hint: 'kürzer', idempotencyKey: 'dr-1' };
  },

  // --- H00, fixed-asset categories (plain master data, no money path) --------------------------
  // The KMU seed carries 1500 (asset), 1510 (asset, used here as the accumulated-depreciation contra
  // account, which the verb admits as an asset-or-liability contra) and 6800 (expense).
  asset_category_create: (fx) => ({
    workspaceId: fx.workspaceId,
    code: 'MACH',
    name: 'Maschinen & Anlagen',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 60,
    residualValuePct: 1000,
    glAssetAccountId: fx.accId('1500'),
    glAccumDeprAccountId: fx.accId('1510'),
    glDeprExpenseAccountId: fx.accId('6800'),
    idempotencyKey: 'acc-1',
  }),

  asset_category_update: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'IT',
      name: 'Informatik',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 36,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'acu-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      categoryId: cat.category.id,
      patch: { residualValuePct: 500 },
      idempotencyKey: 'acu-1',
    };
  },

  asset_category_archive: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'OLD',
      name: 'Auslaufend',
      depreciationMethod: 'none',
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'aca-seed',
    });
    return { workspaceId: fx.workspaceId, categoryId: cat.category.id, idempotencyKey: 'aca-1' };
  },

  // --- H01, the Asset Master (master data, posts nothing) --------------------------------------
  // Every asset is created FROM a category, so each write scenario seeds its own category first, the
  // asset_category_update/archive shape. A fresh category code per scenario keeps the twice-called
  // conformance run from tripping duplicate_code across the shared workspace.
  asset_create: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-A',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-c-cat',
    });
    return {
      workspaceId: fx.workspaceId,
      categoryId: cat.category.id,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-03-15',
      acquisitionCostRappen: 12500000,
      idempotencyKey: 'as-c-1',
    };
  },

  asset_update: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-U',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-u-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'Servergestell',
      acquisitionDate: '2026-01-10',
      acquisitionCostRappen: 800000,
      idempotencyKey: 'as-u-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      assetId: asset.asset.id,
      patch: { notes: 'Standort Serverraum' },
      idempotencyKey: 'as-u-1',
    };
  },

  asset_archive: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-X',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-x-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'Alter Drucker',
      acquisitionDate: '2020-06-01',
      acquisitionCostRappen: 120000,
      idempotencyKey: 'as-x-seed',
    });
    return { workspaceId: fx.workspaceId, assetId: asset.asset.id, idempotencyKey: 'as-x-1' };
  },

  // --- H02, Asset Acquisition (MONEY PATH: the capitalisation posts a balanced A02 journal) ------
  // Each write seeds its own category + draft asset, then acquires. The gate calls the verb TWICE
  // with the identical input and compares the whole database row by row, so this is where §H-IDEMPOTENT
  // is proven ON ROWS for the acquisition: a replay must post no second journal entry and write no
  // second asset_transaction. The credit account is the bank (1020, an asset), the ordinary "paid from
  // the bank" acquisition; the asset GL account is inherited from the category (1500).
  asset_acquire: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-ACQ',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-acq-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'CNC Fräsmaschine',
      acquisitionDate: '2026-03-15',
      acquisitionCostRappen: 12500000,
      idempotencyKey: 'as-acq-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      assetId: asset.asset.id,
      date: '2026-03-15',
      acquisitionCostRappen: 12500000,
      creditAccountId: fx.accId('1020'),
      idempotencyKey: 'as-acq-1',
    };
  },

  asset_add_capitalisation: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-CAP',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-cap-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'Servergestell',
      acquisitionDate: '2026-01-10',
      acquisitionCostRappen: 800000,
      idempotencyKey: 'as-cap-seed',
    });
    fx.call('asset_acquire', {
      assetId: asset.asset.id,
      date: '2026-01-10',
      acquisitionCostRappen: 800000,
      creditAccountId: fx.accId('1020'),
      idempotencyKey: 'as-cap-acq',
    });
    return {
      workspaceId: fx.workspaceId,
      assetId: asset.asset.id,
      date: '2026-02-01',
      amountRappen: 150000,
      creditAccountId: fx.accId('1020'),
      idempotencyKey: 'as-cap-1',
    };
  },

  // --- H07, Asset Ledger & Reconciliation (MONEY PATH: opening balance posts a balanced A02 entry) ---
  // asset_opening_balance seeds a DRAFT asset's historical cost + accumulated depreciation as one balanced
  // opening journal (Dr cost 1500, Cr accum 1510, Cr equity 2979 for the NBV) plus one append-only
  // type=opening sub-ledger row. The gate's double call proves §H-IDEMPOTENT on ROWS: a replay returns the
  // original objects, posts no second journal and appends no second transaction. The asset is left in
  // draft by asset_create so the opening (not a second acquisition) is the one financial event it carries.
  asset_opening_balance: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-OPEN',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-open-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'Bestandsmaschine (Migration)',
      acquisitionDate: '2026-01-01',
      acquisitionCostRappen: 4000000,
      idempotencyKey: 'as-open-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      assetId: asset.asset.id,
      date: '2026-01-01',
      costRappen: 4000000,
      accumulatedDeprRappen: 1500000,
      offsetAccountId: fx.accId('2979'),
      idempotencyKey: 'as-open-1',
    };
  },

  // --- H05, Asset Transfer & Location (NON-POSTING) --------------------------------------------
  // A transfer and a location write both post NOTHING, so the gate's double call proves §H-IDEMPOTENT
  // on ROWS here: a replay writes no second location, no second transfer history row, and re-updates
  // nothing. A fresh location code per scenario keeps the twice-called run from tripping duplicate_code
  // across the shared workspace.
  asset_location_create: (fx) => ({
    workspaceId: fx.workspaceId,
    code: 'ZH-HQ-3F',
    name: 'Zürich HQ, 3. Stock',
    idempotencyKey: 'as-loc-c-1',
  }),

  asset_location_update: (fx) => {
    const loc = fx.call('asset_location_create', {
      code: 'ZH-HQ-U',
      name: 'Zürich HQ',
      idempotencyKey: 'as-loc-u-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      locationId: loc.location.id,
      patch: { name: 'Zürich Hauptsitz' },
      idempotencyKey: 'as-loc-u-1',
    };
  },

  asset_location_archive: (fx) => {
    const loc = fx.call('asset_location_create', {
      code: 'ZH-HQ-X',
      name: 'Alter Standort',
      idempotencyKey: 'as-loc-x-seed',
    });
    return { workspaceId: fx.workspaceId, locationId: loc.location.id, idempotencyKey: 'as-loc-x-1' };
  },

  // Seed a category + a draft asset + a target location, then transfer. The asset stays draft (a
  // transfer never posts, so it never moves the asset out of draft), which is exactly what proves the
  // non-posting contract: the double call must leave the journal untouched and write no second row.
  asset_transfer: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-TRF',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-trf-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'Gabelstapler',
      acquisitionDate: '2026-04-01',
      acquisitionCostRappen: 3200000,
      idempotencyKey: 'as-trf-seed',
    });
    const loc = fx.call('asset_location_create', {
      code: 'ZH-PLANT-B',
      name: 'Werk B',
      idempotencyKey: 'as-trf-loc',
    });
    return {
      workspaceId: fx.workspaceId,
      assetIds: [asset.asset.id],
      toLocationId: loc.location.id,
      effectiveDate: '2026-07-15',
      reason: 'Produktionsverlagerung',
      idempotencyKey: 'as-trf-1',
    };
  },

  // --- H04, Depreciation Run & Posting (MONEY PATH: the post books a balanced A02 journal) --------
  // Each write seeds a category + an ACQUIRED (active) asset so the H03 engine returns amount > 0 for
  // the run period. The gate calls the verb TWICE with the identical input and compares the whole
  // database row by row, so this is where §H-IDEMPOTENT is proven ON ROWS for the run: a replay posts
  // no second journal, writes no second asset_transaction and re-figures no asset. Straight-line over
  // 12 months on CHF 12'000.00 gives CHF 1'000.00 a month, comfortably above residual (0%).
  //
  // A helper that returns an ACTIVE asset ready to depreciate for period 2026-02.
  asset_depreciation_run_create: (fx) => {
    depreciableAssetSeed(fx, 'run-c');
    return { workspaceId: fx.workspaceId, period: '2026-02', idempotencyKey: 'run-c-1' };
  },

  asset_depreciation_run_post: (fx) => {
    depreciableAssetSeed(fx, 'run-p');
    const draft = fx.call('asset_depreciation_run_create', { period: '2026-02', idempotencyKey: 'run-p-draft' });
    return { workspaceId: fx.workspaceId, runId: draft.run.id, idempotencyKey: 'run-p-1' };
  },

  asset_depreciation_run_reverse: (fx) => {
    depreciableAssetSeed(fx, 'run-r');
    const draft = fx.call('asset_depreciation_run_create', { period: '2026-02', idempotencyKey: 'run-r-draft' });
    fx.call('asset_depreciation_run_post', { runId: draft.run.id, idempotencyKey: 'run-r-post' });
    return { workspaceId: fx.workspaceId, runId: draft.run.id, reason: 'Falscher Satz', idempotencyKey: 'run-r-1' };
  },

  // --- H06, Asset Disposal (MONEY PATH: the terminal disposal journal) --------------------------
  // Seed an ACTIVE asset (cost 1'200'000, accumulated 0, NBV 1'200'000), then dispose it for 1'000'000
  // proceeds: a book loss of 200'000. The gate calls the verb TWICE with identical input and compares
  // the whole database row by row, so this is where §H-IDEMPOTENT is proven ON ROWS for the disposal:
  // a replay posts no second journal, appends no second asset_transaction and re-flips no status.
  asset_dispose: (fx) => {
    const assetId = depreciableAssetSeed(fx, 'disp');
    return {
      workspaceId: fx.workspaceId,
      assetId,
      disposalDate: '2026-07-15',
      proceedsRappen: 1_000_000,
      proceedsAccountId: fx.accId('1020'),
      gainLossAccountId: fx.accId('6900'),
      reason: 'Verkauf an Dritte',
      idempotencyKey: 'disp-1',
    };
  },

  // --- H08, Simple Maintenance Log (NON-POSTING) ------------------------------------------------
  // Each write seeds a category + a draft asset (a maintenance log needs no acquisition), then logs.
  // The log posts NOTHING, so the gate's double call proves §H-IDEMPOTENT on ROWS: a replay writes no
  // second log, no second cancel, and re-updates nothing.
  asset_maintenance_log_create: (fx) => {
    const assetId = maintenanceAssetSeed(fx, 'mlog-c');
    return {
      workspaceId: fx.workspaceId,
      assetId,
      logDate: '2026-08-10',
      maintenanceType: 'corrective',
      title: 'Hydraulikpumpen-Dichtung ersetzt',
      costRappen: 45_000,
      idempotencyKey: 'mlog-c-1',
    };
  },
  asset_maintenance_log_update: (fx) => {
    const assetId = maintenanceAssetSeed(fx, 'mlog-u');
    const log = fx.call('asset_maintenance_log_create', {
      assetId,
      logDate: '2026-08-10',
      maintenanceType: 'inspection',
      title: 'Jahresinspektion',
      idempotencyKey: 'mlog-u-seed',
    });
    return {
      workspaceId: fx.workspaceId,
      id: log.log.id,
      patch: { title: 'Jahresinspektion (korrigiert)', costRappen: 12_000 },
      idempotencyKey: 'mlog-u-1',
    };
  },
  asset_maintenance_log_cancel: (fx) => {
    const assetId = maintenanceAssetSeed(fx, 'mlog-x');
    const log = fx.call('asset_maintenance_log_create', {
      assetId,
      logDate: '2026-08-10',
      maintenanceType: 'other',
      title: 'Falscherfassung',
      idempotencyKey: 'mlog-x-seed',
    });
    return { workspaceId: fx.workspaceId, id: log.log.id, reason: 'Doppelt erfasst', idempotencyKey: 'mlog-x-1' };
  },

  // --- I00, requisitions (internal-demand document, no money path) ------------------------------
  // Each write seeds its own world through I00's (and A09/C00's) own verbs. A requisition posts
  // nothing, so the gate's double call proves §H-IDEMPOTENT on ROWS: a re-submit writes no second
  // event, a re-convert mints no second PO. `requisitionSeed` returns an APPROVED requisition whose
  // sole line carries a preferred supplier, so convert/close can resolve a PO with no override.
  requisition_upsert: (fx) => ({
    workspaceId: fx.workspaceId,
    neededBy: '2026-09-01',
    urgency: 'normal',
    description: 'Werkstattbedarf',
    lines: [{ description: 'Schmiermittel', qtyMilli: 2000, estimatedUnitCostRappen: 5000 }],
    idempotencyKey: 'rq-1',
  }),

  requisition_submit: (fx) => {
    const r = fx.call('requisition_upsert', {
      neededBy: '2026-09-01',
      urgency: 'normal',
      lines: [{ description: 'X', qtyMilli: 1000, estimatedUnitCostRappen: 100 }],
      idempotencyKey: 'rqs-up',
    });
    return { workspaceId: fx.workspaceId, requisitionId: r.requisition.id, idempotencyKey: 'rqs-1' };
  },

  requisition_approve: (fx) => {
    const id = requisitionSeed(fx, 'rqa').id;
    return { workspaceId: fx.workspaceId, requisitionId: id, comment: 'ok', idempotencyKey: 'rqa-app' };
  },

  requisition_reject: (fx) => {
    const r = fx.call('requisition_upsert', {
      neededBy: '2026-09-01',
      urgency: 'normal',
      lines: [{ description: 'X', qtyMilli: 1000, estimatedUnitCostRappen: 100 }],
      idempotencyKey: 'rqrj-up',
    });
    fx.call('requisition_submit', { requisitionId: r.requisition.id, idempotencyKey: 'rqrj-sub' });
    return { workspaceId: fx.workspaceId, requisitionId: r.requisition.id, reason: 'over budget', idempotencyKey: 'rqrj-1' };
  },

  requisition_return: (fx) => {
    const r = fx.call('requisition_upsert', {
      neededBy: '2026-09-01',
      urgency: 'normal',
      lines: [{ description: 'X', qtyMilli: 1000, estimatedUnitCostRappen: 100 }],
      idempotencyKey: 'rqrt-up',
    });
    fx.call('requisition_submit', { requisitionId: r.requisition.id, idempotencyKey: 'rqrt-sub' });
    return { workspaceId: fx.workspaceId, requisitionId: r.requisition.id, reason: 'add a supplier', idempotencyKey: 'rqrt-1' };
  },

  requisition_convert_to_po: (fx) => {
    const seeded = requisitionSeed(fx, 'rqc');
    fx.call('requisition_approve', { requisitionId: seeded.id, idempotencyKey: 'rqc-app' });
    const detail = fx.call('requisition_get', { requisitionId: seeded.id }).requisition;
    return {
      workspaceId: fx.workspaceId,
      requisitionId: seeded.id,
      lines: [{ lineId: detail.lines[0].id, qtyMilli: detail.lines[0].qtyMilli }],
      idempotencyKey: 'rqc-1',
    };
  },

  requisition_cancel: (fx) => {
    const r = fx.call('requisition_upsert', {
      neededBy: '2026-09-01',
      urgency: 'normal',
      lines: [{ description: 'X', qtyMilli: 1000, estimatedUnitCostRappen: 100 }],
      idempotencyKey: 'rqcn-up',
    });
    return { workspaceId: fx.workspaceId, requisitionId: r.requisition.id, idempotencyKey: 'rqcn-1' };
  },

  requisition_close: (fx) => {
    const seeded = requisitionSeed(fx, 'rqcl');
    fx.call('requisition_approve', { requisitionId: seeded.id, idempotencyKey: 'rqcl-app' });
    const detail = fx.call('requisition_get', { requisitionId: seeded.id }).requisition;
    fx.call('requisition_convert_to_po', {
      requisitionId: seeded.id,
      lines: [{ lineId: detail.lines[0].id, qtyMilli: detail.lines[0].qtyMilli }],
      idempotencyKey: 'rqcl-conv',
    });
    return { workspaceId: fx.workspaceId, requisitionId: seeded.id, idempotencyKey: 'rqcl-1' };
  },
  // --- J00, warehouses & locations (Wave 13, inventory root, plain master data, no money path) ---
  warehouse_create: (fx) => ({
    workspaceId: fx.workspaceId,
    code: 'ZH-MAIN',
    name: 'Zürich Main Warehouse',
    city: 'Zürich',
    idempotencyKey: 'wh-1',
  }),

  warehouse_update: (fx) => {
    const wh = fx.call('warehouse_create', { code: 'BE-01', name: 'Bern Lager', idempotencyKey: 'whu-seed' });
    return {
      workspaceId: fx.workspaceId,
      warehouseId: wh.warehouse.id,
      patch: { name: 'Bern Hauptlager', city: 'Bern' },
      idempotencyKey: 'whu-1',
    };
  },

  warehouse_set_default: (fx) => {
    // The first warehouse becomes the default automatically; the second is non-default, so setting it
    // default is a real transition (and demotes the first).
    fx.call('warehouse_create', { code: 'W-A', name: 'Lager A', idempotencyKey: 'whsd-a' });
    const b = fx.call('warehouse_create', { code: 'W-B', name: 'Lager B', idempotencyKey: 'whsd-b' });
    return { workspaceId: fx.workspaceId, warehouseId: b.warehouse.id, idempotencyKey: 'whsd-1' };
  },

  warehouse_archive: (fx) => {
    // Archive the SECOND (non-default, empty) warehouse: the default cannot be archived.
    fx.call('warehouse_create', { code: 'W-KEEP', name: 'Behalten', idempotencyKey: 'wha-keep' });
    const gone = fx.call('warehouse_create', { code: 'W-GONE', name: 'Auslaufend', idempotencyKey: 'wha-gone' });
    return { workspaceId: fx.workspaceId, warehouseId: gone.warehouse.id, idempotencyKey: 'wha-1' };
  },

  location_create: (fx) => {
    const wh = fx.call('warehouse_create', { code: 'LC-WH', name: 'Lager', idempotencyKey: 'lc-wh' });
    return {
      workspaceId: fx.workspaceId,
      warehouseId: wh.warehouse.id,
      code: 'RECV',
      name: 'Receiving Dock',
      locationType: 'staging',
      idempotencyKey: 'lc-1',
    };
  },

  location_update: (fx) => {
    const wh = fx.call('warehouse_create', { code: 'LU-WH', name: 'Lager', idempotencyKey: 'lu-wh' });
    const loc = fx.call('location_create', {
      warehouseId: wh.warehouse.id,
      code: 'A-01',
      name: 'Aisle A',
      idempotencyKey: 'lu-loc',
    });
    return {
      workspaceId: fx.workspaceId,
      locationId: loc.location.id,
      patch: { name: 'Aisle A (Nord)', locationType: 'aisle' },
      idempotencyKey: 'lu-1',
    };
  },

  location_set_default: (fx) => {
    const wh = fx.call('warehouse_create', { code: 'LSD-WH', name: 'Lager', idempotencyKey: 'lsd-wh' });
    // The first location becomes the warehouse default; the second is non-default.
    fx.call('location_create', { warehouseId: wh.warehouse.id, code: 'L-A', name: 'A', idempotencyKey: 'lsd-a' });
    const b = fx.call('location_create', { warehouseId: wh.warehouse.id, code: 'L-B', name: 'B', idempotencyKey: 'lsd-b' });
    return { workspaceId: fx.workspaceId, locationId: b.location.id, idempotencyKey: 'lsd-1' };
  },

  location_archive: (fx) => {
    const wh = fx.call('warehouse_create', { code: 'LA-WH', name: 'Lager', idempotencyKey: 'la-wh' });
    // Archive the SECOND (non-default, empty) location: the default cannot be archived.
    fx.call('location_create', { warehouseId: wh.warehouse.id, code: 'K-A', name: 'Behalten', idempotencyKey: 'la-a' });
    const gone = fx.call('location_create', { warehouseId: wh.warehouse.id, code: 'K-B', name: 'Weg', idempotencyKey: 'la-b' });
    return { workspaceId: fx.workspaceId, locationId: gone.location.id, idempotencyKey: 'la-1' };
  },

  inventory_ensure_default_location: (fx) => ({ workspaceId: fx.workspaceId }),
  // --- H03, depreciation method enablement (the only H03 write; the calculators are pure reads) ---
  // Disabling a method is workspace state, no asset needed. Idempotent on the (workspace, method) row.
  asset_depreciation_method_set_enabled: (fx) => ({
    workspaceId: fx.workspaceId,
    methodKey: 'declining_balance',
    enabled: false,
    idempotencyKey: 'adm-1',
  }),

  // --- J01, lot & serial tracking (Wave 13, inventory, plain master data, no money path) ---------
  // Each scenario seeds a stockable, zero-stock item (and, where needed, its tracking mode / a lot or
  // serial) through the real verbs, then returns the input for the verb under test. Fresh items carry
  // no movements, so the zero-stock mode guard and the balance-derived archive guards all pass.
  item_set_tracking_mode: (fx) => {
    const item = fx.call('create_item', {
      workspaceId: fx.workspaceId,
      name: 'Tracked Widget',
      defaultUnitPriceMinor: 1000,
      trackStock: true,
      idempotencyKey: 'istm-item',
    });
    return { workspaceId: fx.workspaceId, itemId: item.item.id, mode: 'lot', idempotencyKey: 'istm-1' };
  },

  lot_create: (fx) => {
    const item = fx.call('create_item', { name: 'Lot Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'lc-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'lot', idempotencyKey: 'lc-mode' });
    return { workspaceId: fx.workspaceId, itemId: item.item.id, number: 'L-2026-001', expiryDate: '2027-01-01', idempotencyKey: 'lc-1' };
  },

  lot_update: (fx) => {
    const item = fx.call('create_item', { name: 'Lot Widget U', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'lu-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'lot', idempotencyKey: 'lu-mode' });
    const lot = fx.call('lot_create', { itemId: item.item.id, number: 'L-U-001', idempotencyKey: 'lu-lot' });
    return { workspaceId: fx.workspaceId, lotId: lot.lot.id, patch: { supplierReference: 'PO-42', notes: 'geprüft' }, idempotencyKey: 'lu-1' };
  },

  lot_set_status: (fx) => {
    const item = fx.call('create_item', { name: 'Lot Widget S', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'lss-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'lot', idempotencyKey: 'lss-mode' });
    const lot = fx.call('lot_create', { itemId: item.item.id, number: 'L-S-001', idempotencyKey: 'lss-lot' });
    return { workspaceId: fx.workspaceId, lotId: lot.lot.id, status: 'held', idempotencyKey: 'lss-1' };
  },

  lot_archive: (fx) => {
    const item = fx.call('create_item', { name: 'Lot Widget A', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'la-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'lot', idempotencyKey: 'la-mode' });
    const lot = fx.call('lot_create', { itemId: item.item.id, number: 'L-A-001', idempotencyKey: 'la-lot' });
    return { workspaceId: fx.workspaceId, lotId: lot.lot.id, idempotencyKey: 'la-arch-1' };
  },

  serial_create: (fx) => {
    const item = fx.call('create_item', { name: 'Serial Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'sc-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'serial', idempotencyKey: 'sc-mode' });
    return { workspaceId: fx.workspaceId, itemId: item.item.id, number: 'SN-0001', idempotencyKey: 'sc-1' };
  },

  serial_create_bulk: (fx) => {
    const item = fx.call('create_item', { name: 'Serial Widget B', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'scb-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'serial', idempotencyKey: 'scb-mode' });
    return { workspaceId: fx.workspaceId, itemId: item.item.id, numbers: ['SNB-1', 'SNB-2', 'SNB-3'], idempotencyKey: 'scb-1' };
  },

  serial_update: (fx) => {
    const item = fx.call('create_item', { name: 'Serial Widget U', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'su-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'serial', idempotencyKey: 'su-mode' });
    const serial = fx.call('serial_create', { itemId: item.item.id, number: 'SN-U-1', idempotencyKey: 'su-serial' });
    return { workspaceId: fx.workspaceId, serialId: serial.serial.id, patch: { notes: 'Gehäuse zerkratzt' }, idempotencyKey: 'su-1' };
  },

  serial_set_status: (fx) => {
    const item = fx.call('create_item', { name: 'Serial Widget S', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'sss-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'serial', idempotencyKey: 'sss-mode' });
    const serial = fx.call('serial_create', { itemId: item.item.id, number: 'SN-S-1', idempotencyKey: 'sss-serial' });
    return { workspaceId: fx.workspaceId, serialId: serial.serial.id, status: 'reserved', idempotencyKey: 'sss-1' };
  },

  serial_archive: (fx) => {
    const item = fx.call('create_item', { name: 'Serial Widget A', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'sa-item' });
    fx.call('item_set_tracking_mode', { itemId: item.item.id, mode: 'serial', idempotencyKey: 'sa-mode' });
    const serial = fx.call('serial_create', { itemId: item.item.id, number: 'SN-A-1', idempotencyKey: 'sa-serial' });
    // A serial must leave the in-stock statuses (available/reserved) before it can be archived.
    fx.call('serial_set_status', { serialId: serial.serial.id, status: 'scrapped', idempotencyKey: 'sa-scrap' });
    return { workspaceId: fx.workspaceId, serialId: serial.serial.id, idempotencyKey: 'sa-arch-1' };
  },

  // --- J02, the inventory movement ledger (money-path append-only quantity truth) ----------------
  inventory_move: (fx) => {
    const item = fx.call('create_item', { name: 'Move Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'imv-item' });
    const loc = fx.call('stock_location_upsert', { name: 'Lager', idempotencyKey: 'imv-loc' });
    return {
      workspaceId: fx.workspaceId,
      itemId: item.item.id,
      locationId: loc.location.id,
      qty: 25,
      movementType: 'receipt',
      unitCostMinor: 1500,
      effectiveDate: '2026-03-02',
      idempotencyKey: 'imv-1',
    };
  },
  inventory_transfer: (fx) => {
    const item = fx.call('create_item', { name: 'Xfer Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'itr-item' });
    const a = fx.call('stock_location_upsert', { name: 'Lager A', idempotencyKey: 'itr-a' });
    const b = fx.call('stock_location_upsert', { name: 'Lager B', idempotencyKey: 'itr-b' });
    // Seed enough on-hand at the source that the transfer does not overdraw it (negative stock off).
    fx.call('inventory_move', {
      itemId: item.item.id,
      locationId: a.location.id,
      qty: 40,
      movementType: 'receipt',
      unitCostMinor: 1500,
      effectiveDate: '2026-03-01',
      idempotencyKey: 'itr-recv',
    });
    return {
      workspaceId: fx.workspaceId,
      itemId: item.item.id,
      fromLocationId: a.location.id,
      toLocationId: b.location.id,
      qty: 10,
      effectiveDate: '2026-03-03',
      idempotencyKey: 'itr-1',
    };
  },
  inventory_set_config: (fx) => ({ workspaceId: fx.workspaceId, allowNegativeStock: true, idempotencyKey: 'icfg-1' }),

  // --- J04, cycle count / stocktake (money path by way of J02: commit mints only inventory_move) ---
  // Each write seeds its own session through J04's own verbs. The gate's double call proves the
  // money-path invariant on ROWS: a replayed commit mints ONE set of movements, and a replayed count /
  // approve / recount / cancel touches nothing a second time. A movementReadSeed gives book_qty = 12
  // at the freeze; a count of 17 makes a +5 variance the commit posts as one adjustment movement.
  inventory_stocktake_create: (fx) => {
    movementReadSeed(fx, 'stc');
    return { workspaceId: fx.workspaceId, type: 'full', freezeAt: '2026-04-01', idempotencyKey: 'stc-1' };
  },
  inventory_stocktake_count: (fx) => {
    const m = movementReadSeed(fx, 'stcn');
    const s = fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'stcn-sess' });
    return {
      workspaceId: fx.workspaceId,
      sessionId: s.session.id,
      lines: [{ itemId: m.itemId, locationId: m.locationId, countedQty: 12 }],
      idempotencyKey: 'stcn-1',
    };
  },
  inventory_stocktake_approve_lines: (fx) => {
    const m = movementReadSeed(fx, 'stap');
    const s = fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'stap-sess' });
    fx.call('inventory_stocktake_count', {
      sessionId: s.session.id,
      lines: [{ itemId: m.itemId, locationId: m.locationId, countedQty: 20 }],
      idempotencyKey: 'stap-cnt',
    });
    return { workspaceId: fx.workspaceId, sessionId: s.session.id, lineIds: 'all_review_required', idempotencyKey: 'stap-1' };
  },
  inventory_stocktake_request_recount: (fx) => {
    const m = movementReadSeed(fx, 'strc');
    const s = fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'strc-sess' });
    const counted = fx.call('inventory_stocktake_count', {
      sessionId: s.session.id,
      lines: [{ itemId: m.itemId, locationId: m.locationId, countedQty: 5 }],
      idempotencyKey: 'strc-cnt',
    });
    return { workspaceId: fx.workspaceId, sessionId: s.session.id, lineIds: [counted.updatedLines[0].id], idempotencyKey: 'strc-1' };
  },
  inventory_stocktake_commit: (fx) => {
    const m = movementReadSeed(fx, 'stcm');
    const s = fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'stcm-sess' });
    fx.call('inventory_stocktake_count', {
      sessionId: s.session.id,
      lines: [{ itemId: m.itemId, locationId: m.locationId, countedQty: 17 }],
      idempotencyKey: 'stcm-cnt',
    });
    fx.call('inventory_stocktake_approve_lines', { sessionId: s.session.id, lineIds: 'all_review_required', idempotencyKey: 'stcm-ap' });
    return { workspaceId: fx.workspaceId, sessionId: s.session.id, idempotencyKey: 'stcm-1' };
  },
  inventory_stocktake_cancel: (fx) => {
    movementReadSeed(fx, 'stcx');
    const s = fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'stcx-sess' });
    return { workspaceId: fx.workspaceId, sessionId: s.session.id, idempotencyKey: 'stcx-1' };
  },

  // --- J05, inventory adjustments & reasons (money path by way of J02: an adjustment is minted ONLY
  // through inventory_move, movement_type adjustment). The reason catalog is pure master data; the
  // three adjustment writes seed a reason + a receipt, then mint. The gate's double call proves the
  // money-path invariant on ROWS: a replayed adjust / batch / reverse mints ONE movement, never two.
  inventory_reason_create: (fx) => ({
    workspaceId: fx.workspaceId,
    code: 'SCHWUND',
    name: 'Schwund',
    category: 'shrinkage',
    requiresNote: false,
    idempotencyKey: 'irc-1',
  }),
  inventory_reason_update: (fx) => {
    const r = fx.call('inventory_reason_create', { code: 'BESCHAED', name: 'Beschaedigung', category: 'damage', idempotencyKey: 'iru-seed' });
    return { workspaceId: fx.workspaceId, id: r.reason.id, name: 'Beschaedigung (Lager)', requiresNote: true, idempotencyKey: 'iru-1' };
  },
  inventory_reason_archive: (fx) => {
    const r = fx.call('inventory_reason_create', { code: 'FUND', name: 'Gefunden', category: 'found', idempotencyKey: 'ira-seed' });
    return { workspaceId: fx.workspaceId, id: r.reason.id, idempotencyKey: 'ira-1' };
  },
  inventory_adjust: (fx) => {
    const m = movementReadSeed(fx, 'iadj');
    const r = fx.call('inventory_reason_create', { code: 'SCHWUND', name: 'Schwund', category: 'shrinkage', idempotencyKey: 'iadj-rsn' });
    return {
      workspaceId: fx.workspaceId,
      itemId: m.itemId,
      locationId: m.locationId,
      qtyDelta: -2,
      reasonCodeId: r.reason.id,
      effectiveDate: '2026-03-05',
      idempotencyKey: 'iadj-1',
    };
  },
  inventory_adjust_batch: (fx) => {
    const m = movementReadSeed(fx, 'iadjb');
    const r = fx.call('inventory_reason_create', { code: 'SCHWUND', name: 'Schwund', category: 'shrinkage', idempotencyKey: 'iadjb-rsn' });
    return {
      workspaceId: fx.workspaceId,
      effectiveDate: '2026-03-05',
      lines: [{ itemId: m.itemId, locationId: m.locationId, qtyDelta: -1, reasonCodeId: r.reason.id }],
      idempotencyKey: 'iadjb-1',
    };
  },
  inventory_adjust_reverse: (fx) => {
    const m = movementReadSeed(fx, 'iadjr');
    const r = fx.call('inventory_reason_create', { code: 'SCHWUND', name: 'Schwund', category: 'shrinkage', idempotencyKey: 'iadjr-rsn' });
    const rev = fx.call('inventory_reason_create', { code: 'STORNO', name: 'Storno', category: 'reversal', idempotencyKey: 'iadjr-rev' });
    const adj = fx.call('inventory_adjust', {
      itemId: m.itemId,
      locationId: m.locationId,
      qtyDelta: -3,
      reasonCodeId: r.reason.id,
      effectiveDate: '2026-03-05',
      idempotencyKey: 'iadjr-adj',
    });
    return { workspaceId: fx.workspaceId, adjustmentId: adj.adjustment.id, reasonCodeId: rev.reason.id, idempotencyKey: 'iadjr-1' };
  },

  // --- I02, the goods receipt (money path by way of J02: stock, and only through inventory_move) --
  // Each write seeds its own world through D02's and I02's own verbs. The gate's double call is what
  // proves the money-path invariants on ROWS: a replayed post mints ONE set of movements and ONE set
  // of trail rows, and a replayed reverse writes no second compensation. `receiptDraft` returns a
  // DRAFT receipt against a freshly sent PO; `postedReceipt` posts it.
  goods_receipt_create: (fx) => {
    const po = amendablePo(fx, 'grc');
    return { workspaceId: fx.workspaceId, poId: po.poId, receivedAt: '2026-03-04', note: 'Teillieferung', idempotencyKey: 'grc-1' };
  },

  goods_receipt_upsert_lines: (fx) => {
    const d = receiptDraft(fx, 'gru');
    return {
      workspaceId: fx.workspaceId,
      grId: d.grId,
      ops: [{ op: 'add', poLineId: d.lineId, qty: 2 }],
      idempotencyKey: 'gru-1',
    };
  },

  goods_receipt_post: (fx) => {
    const d = receiptDraft(fx, 'grp');
    fx.call('goods_receipt_upsert_lines', { grId: d.grId, ops: [{ op: 'add', poLineId: d.lineId, qty: 4 }], idempotencyKey: 'grp-line' });
    return { workspaceId: fx.workspaceId, grId: d.grId, idempotencyKey: 'grp-1' };
  },

  goods_receipt_accept_lines: (fx) => {
    const d = receiptDraft(fx, 'gra');
    fx.call('goods_receipt_upsert_lines', {
      grId: d.grId,
      ops: [{ op: 'add', poLineId: d.lineId, qty: 3, inspectionStatus: 'pending' }],
      idempotencyKey: 'gra-line',
    });
    const posted = fx.call('goods_receipt_post', { grId: d.grId, idempotencyKey: 'gra-post' });
    return {
      workspaceId: fx.workspaceId,
      grId: d.grId,
      lineIds: [posted.goodsReceipt.lines[0].id],
      idempotencyKey: 'gra-1',
    };
  },

  goods_receipt_reject_lines: (fx) => {
    const d = receiptDraft(fx, 'grj');
    fx.call('goods_receipt_upsert_lines', {
      grId: d.grId,
      ops: [{ op: 'add', poLineId: d.lineId, qty: 3, inspectionStatus: 'pending' }],
      idempotencyKey: 'grj-line',
    });
    const posted = fx.call('goods_receipt_post', { grId: d.grId, idempotencyKey: 'grj-post' });
    return {
      workspaceId: fx.workspaceId,
      grId: d.grId,
      lineIds: [posted.goodsReceipt.lines[0].id],
      reason: 'Transportschaden',
      idempotencyKey: 'grj-1',
    };
  },

  goods_receipt_reverse: (fx) => {
    const gr = postedReceipt(fx, 'grr', 2);
    return { workspaceId: fx.workspaceId, grId: gr.grId, reason: 'Falsche Ware geliefert', idempotencyKey: 'grr-1' };
  },

  goods_receipt_cancel: (fx) => {
    const d = receiptDraft(fx, 'grx');
    return { workspaceId: fx.workspaceId, grId: d.grId, reason: 'Lieferung storniert', idempotencyKey: 'grx-1' };
  },

  goods_receipt_set_config: (fx) => ({
    workspaceId: fx.workspaceId,
    allowOverReceipt: true,
    overReceiptPct: 5,
    idempotencyKey: 'grcfg-1',
  }),
  // --- J03, advanced valuation methods (the valuation basis behind a balance-sheet figure) --------
  // The three policy writes. None posts a journal entry: J03 produces the number and J06 books it.
  // Each scenario drives the real path rather than a thin one, because rules 8 and 10 to 12 are
  // exactly as strong as what the scenario exercises.
  inventory_valuation_method_set_enabled: (fx) => ({
    workspaceId: fx.workspaceId,
    // standard_cost is registered and OFF by default, so enabling it is the real state change.
    method: 'standard_cost',
    enabled: true,
    idempotencyKey: 'ivme-1',
  }),
  inventory_valuation_set_default: (fx) => {
    // A real movement BEFORE the effective date, so the scenario drives the Stetigkeit guard's live
    // branch (a workspace that already has a ledger) rather than the empty-workspace shortcut. The
    // force plus reason is what the engine demands there, and the scenario has to satisfy it.
    movementReadSeed(fx, 'ivsd');
    return {
      workspaceId: fx.workspaceId,
      method: 'fifo',
      effectiveFrom: '2026-03-01',
      forceRevaluation: true,
      reason: 'Umstellung auf FIFO per Quartalsbeginn',
      idempotencyKey: 'ivsd-1',
    };
  },
  inventory_valuation_set_item_method: (fx) => {
    // A real item with a real movement, so the open-period guard is genuinely in play: the movement
    // sits BEFORE effectiveFrom, which is the case the guard must let through.
    const m = movementReadSeed(fx, 'ivsim');
    return {
      workspaceId: fx.workspaceId,
      itemId: m.itemId,
      method: 'fifo',
      effectiveFrom: '2026-06-01',
      reason: 'Chargenware neu nach FIFO',
      idempotencyKey: 'ivsim-1',
    };
  },
  // --- I03, landed cost allocation (money path: J02 cost movements + one A02 entry) ---------------
  // Each write seeds its own world through I02's own verbs (a posted goods receipt), so the gate's
  // double call proves the money-path invariants on ROWS: a replayed confirm mints ONE set of cost
  // movements and ONE journal, and a replayed reverse writes no second compensation.
  landed_cost_voucher_create: (fx) => {
    const gr = landedGrLine(fx, 'lcvc');
    return {
      workspaceId: fx.workspaceId,
      costLines: [{ componentType: 'freight', amountMinor: 45000, description: 'Seefracht' }],
      targetGrLineIds: [gr.grLineId],
      inventoryAccountId: fx.accId('1200'),
      clearingAccountId: fx.accId('2300'),
      allocationMethod: 'by_value',
      idempotencyKey: 'lcvc-1',
    };
  },
  landed_cost_allocate_confirm: (fx) => {
    const v = draftVoucher(fx, 'lcac');
    return { workspaceId: fx.workspaceId, voucherId: v.voucherId, idempotencyKey: 'lcac-1' };
  },
  landed_cost_reverse: (fx) => {
    const v = allocatedVoucher(fx, 'lcrv');
    return { workspaceId: fx.workspaceId, voucherId: v.voucherId, reason: 'Falsche Zuordnung', idempotencyKey: 'lcrv-1' };
  },

  // --- J06, valuation run & GL link (MONEY PATH, OP11: sub-ledger valuation posted to the GL) ------
  // Each write seeds its own world through J02's own verb (a real receipt), so the gate's double call
  // proves the money-path invariants on ROWS: a replayed create writes ONE draft, a replayed post
  // mints ONE journal, a replayed reverse writes no second compensation. The default 1200/4200 KMU
  // control accounts are seeded by mintWorkspace, so the delta posts against a real chart.
  inventory_valuation_create: (fx) => {
    movementReadSeed(fx, 'ivc');
    return { workspaceId: fx.workspaceId, asOf: '2026-03-31', idempotencyKey: 'ivc-1' };
  },
  inventory_valuation_post: (fx) => {
    movementReadSeed(fx, 'ivp');
    const draft = fx.call('inventory_valuation_create', { asOf: '2026-03-31', idempotencyKey: 'ivp-draft' });
    return { workspaceId: fx.workspaceId, runId: draft.run.id, idempotencyKey: 'ivp-1' };
  },
  inventory_valuation_reverse: (fx) => {
    movementReadSeed(fx, 'ivr');
    const draft = fx.call('inventory_valuation_create', { asOf: '2026-03-31', idempotencyKey: 'ivr-draft' });
    fx.call('inventory_valuation_post', { runId: draft.run.id, idempotencyKey: 'ivr-post' });
    return { workspaceId: fx.workspaceId, runId: draft.run.id, reason: 'Falsche Bewertung', idempotencyKey: 'ivr-1' };
  },
  inventory_valuation_opening: (fx) => {
    const item = fx.call('create_item', { name: 'Opening Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: 'ivo-item' });
    return {
      workspaceId: fx.workspaceId,
      asOf: '2026-01-01',
      lines: [{ itemId: item.item.id, qty: 10, valueRappen: 15000 }],
      idempotencyKey: 'ivo-1',
    };
  },
};

/** I02: a DRAFT goods receipt against a freshly sent PO. Returns { grId, poId, lineId, locationId }. */
function receiptDraft(fx, prefix) {
  const po = amendablePo(fx, prefix);
  const created = fx.call('goods_receipt_create', {
    poId: po.poId,
    receivedAt: '2026-03-04',
    defaultLocationId: po.locationId,
    idempotencyKey: `${prefix}-gr`,
  });
  return { ...po, grId: created.goodsReceipt.id };
}

/** I02: a POSTED goods receipt for `qty` units of the PO's single line. Returns { grId, ... }. */
function postedReceipt(fx, prefix, qty) {
  const d = receiptDraft(fx, prefix);
  fx.call('goods_receipt_upsert_lines', {
    grId: d.grId,
    ops: [{ op: 'add', poLineId: d.lineId, qty }],
    idempotencyKey: `${prefix}-line`,
  });
  fx.call('goods_receipt_post', { grId: d.grId, idempotencyKey: `${prefix}-post` });
  return d;
}

/** I03: a posted goods receipt line I03 can allocate against. Returns { grLineId, itemId }. */
function landedGrLine(fx, prefix) {
  const gr = postedReceipt(fx, prefix, 10);
  const got = fx.call('goods_receipt_get', { grId: gr.grId });
  const line = got.goodsReceipt.lines[0];
  return { grLineId: line.id, itemId: line.itemId };
}

/** I03: a DRAFT landed-cost voucher against a posted receipt line. Returns { voucherId, grLineId }. */
function draftVoucher(fx, prefix) {
  const gr = landedGrLine(fx, prefix);
  const created = fx.call('landed_cost_voucher_create', {
    costLines: [{ componentType: 'freight', amountMinor: 45000, description: 'Seefracht' }],
    targetGrLineIds: [gr.grLineId],
    inventoryAccountId: fx.accId('1200'),
    clearingAccountId: fx.accId('2300'),
    allocationMethod: 'by_value',
    idempotencyKey: `${prefix}-voucher`,
  });
  return { voucherId: created.voucher.id, grLineId: gr.grLineId };
}

/** I03: a CONFIRMED (allocated) landed-cost voucher. Returns { voucherId, grLineId }. */
function allocatedVoucher(fx, prefix) {
  const v = draftVoucher(fx, prefix);
  fx.call('landed_cost_allocate_confirm', { voucherId: v.voucherId, idempotencyKey: `${prefix}-confirm` });
  return v;
}

/**
 * A submitted (pending_approval) requisition whose sole line carries a preferred supplier, so a later
 * convert resolves a PO with no supplier override. Returns { id }.
 */
/**
 * An ACTIVE fixed asset ready to depreciate (H04 scenarios): a straight-line category over 12 months,
 * an asset created under it, and a posted primary acquisition (H02) that moves it to `active` with a
 * CHF 12'000.00 cost base and 0% residual, so the H03 engine returns CHF 1'000.00 for any month after
 * acquisition. Returns the asset id.
 */
function depreciableAssetSeed(fx, prefix) {
  const cat = fx.call('asset_category_create', {
    code: `DEPR-${prefix}`,
    name: 'Maschinen',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 12,
    glAssetAccountId: fx.accId('1500'),
    glAccumDeprAccountId: fx.accId('1510'),
    glDeprExpenseAccountId: fx.accId('6800'),
    idempotencyKey: `${prefix}-cat`,
  });
  const asset = fx.call('asset_create', {
    categoryId: cat.category.id,
    name: 'CNC Fräsmaschine',
    acquisitionDate: '2026-01-10',
    acquisitionCostRappen: 1200000,
    idempotencyKey: `${prefix}-seed`,
  });
  fx.call('asset_acquire', {
    assetId: asset.asset.id,
    date: '2026-01-10',
    acquisitionCostRappen: 1200000,
    creditAccountId: fx.accId('1020'),
    idempotencyKey: `${prefix}-acq`,
  });
  return asset.asset.id;
}

/** A DRAFT asset (no acquisition needed) for the H08 maintenance-log scenarios. */
function maintenanceAssetSeed(fx, prefix) {
  const cat = fx.call('asset_category_create', {
    code: `MNT-${prefix}`,
    name: 'Maschinen',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 60,
    glAssetAccountId: fx.accId('1500'),
    glAccumDeprAccountId: fx.accId('1510'),
    glDeprExpenseAccountId: fx.accId('6800'),
    idempotencyKey: `${prefix}-cat`,
  });
  const asset = fx.call('asset_create', {
    categoryId: cat.category.id,
    name: 'Gabelstapler',
    acquisitionDate: '2026-04-01',
    acquisitionCostRappen: 3_200_000,
    idempotencyKey: `${prefix}-seed`,
  });
  return asset.asset.id;
}

function requisitionSeed(fx, prefix) {
  const vendor = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${prefix}-v` }).contact.id;
  const r = fx.call('requisition_upsert', {
    neededBy: '2026-09-01',
    urgency: 'normal',
    lines: [{ description: 'Position A', qtyMilli: 2000, estimatedUnitCostRappen: 2500, preferredSupplierId: vendor }],
    idempotencyKey: `${prefix}-up`,
  });
  fx.call('requisition_submit', { requisitionId: r.requisition.id, idempotencyKey: `${prefix}-sub` });
  return { id: r.requisition.id, vendor };
}

/** A G09 plan holding one gl_history step over a real uploaded export (G13's scenarios seed this). */
function seedG13HistoryStep(fx, prefix) {
  const csv = [
    'Datum,BelegNr,Konto,Soll,Haben,Buchungstext',
    '2012-03-05,B-1,1000,10000,0,Bareinnahme',
    '2012-03-05,B-1,3400,0,10000,Ertrag',
    '',
  ].join('\n');
  const uploaded = fx.call('files_upload', {
    filename: `${prefix}-gl.csv`,
    mime: 'text/csv',
    contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
    idempotencyKey: `${prefix}-file`,
  });
  const planId = fx.call('migration_create_plan', {
    sourceSystem: 'csv',
    cutoverDate: '2020-01-01',
    localePack: 'ch',
    idempotencyKey: `${prefix}-plan`,
  }).planId;
  fx.call('migration_discover_source', { planId, fileIds: [uploaded.file.id] });
  const scope = fx.call('migration_set_scope', {
    planId,
    classes: [{ dataClass: 'gl_history', include: true }],
    idempotencyKey: `${prefix}-scope`,
  });
  return { planId, stepId: scope.steps.find((s) => s.dataClass === 'gl_history').stepId };
}

/** A G09 plan with one scoped step of `dataClass`, minted through the real verbs. */
function seedG09Step(fx, prefix, dataClass) {
  const planId = fx.call('migration_create_plan', {
    sourceSystem: 'csv',
    cutoverDate: '2020-01-01',
    localePack: 'ch',
    idempotencyKey: `${prefix}-plan`,
  }).planId;
  const scope = fx.call('migration_set_scope', {
    planId,
    classes: [{ dataClass, include: true }],
    idempotencyKey: `${prefix}-scope`,
  });
  return { planId, stepId: scope.steps[0].stepId };
}

/**
 * The E01 seed: one E00 file and one signer contact WITH an email (the engine refuses a signer
 * without one, `signer_email_missing`), both through their own verbs. Answers the file's sha256
 * too, because `sign_requests_complete` must reference the requested version's hash.
 */
function signRequestSeed(fx, seed) {
  const file = storedFile(fx, `${seed}-sig`);
  const contact = fx.call('create_contact', {
    partyRole: 'customer',
    name: 'Signatur AG',
    email: `unterschrift-${seed}@example.ch`,
    idempotencyKey: `${seed}-signer`,
  });
  return { fileId: file.id, sha256: file.sha256, signerContactId: contact.contact.id };
}

/** One stored file, seeded through E00's own upload verb, for the scenarios that need one to exist. */
function storedFile(fx, seed) {
  const created = fx.call('files_upload', {
    title: `Beleg ${seed}`,
    filename: `${seed}.pdf`,
    mime: 'application/pdf',
    contentBase64: Buffer.from(`%PDF-1.4 ${seed}`).toString('base64'),
    idempotencyKey: `${seed}-seed`,
  });
  return created.file;
}

/**
 * A configured workspace with a vendor, and the input for ONE gross CHF 1'081.00 supplier bill.
 *
 * It goes through A05's and C00's own verbs rather than writing rows, for the reason A14's
 * `issuedInvoice` gives: A17 derives every open amount from the ledger and resolves its tax code
 * through A05, so a bill or a contact faked into a table would give the scenarios a payable that
 * reconciles to nothing.
 *
 * `partyRole: 'vendor'`, and that is not incidental. A17 REFUSES a customer-only contact with
 * `needs_vendor`, because booking a purchase against a party that is only a customer is the mirror of
 * the 1100 reconciliation defect the wave critic found on the sales side.
 */
function vendorBillInput(fx, seed) {
  fx.call('vat_seed_defaults', {});
  fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const vendor = fx.call('create_contact', {
    partyRole: 'vendor',
    name: 'Lieferant GmbH',
    idempotencyKey: `${seed}-vendor`,
  });
  return {
    workspaceId: fx.workspaceId,
    vendorId: vendor.contact.id,
    billDate: '2026-03-01',
    dueDate: '2026-03-31',
    vendorReference: `LG-${seed}-0042`,
    // Gross 1'081.00 at the 8.1% Normalsatz: net 1'000.00 plus Vorsteuer 81.00.
    amountMinor: 108100,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: fx.accId('6500'),
    idempotencyKey: `${seed}-bill`,
  };
}

/**
 * 9100 Eröffnungsbilanz, the contra account `set_bank_opening_balance` books against.
 *
 * Created through `create_account` rather than written into the table, for the reason A19 states in
 * `core/banking/bankAccounts.ts`: the account is deliberately absent from A01's core seed, A04 owns
 * seeding it, and a row faked in here would give the opening entry a contra account that no chart
 * knows about.
 */
function openingBalanceAccount(fx, seed) {
  const created = fx.call('create_account', {
    number: '9100',
    name: 'Eröffnungsbilanz',
    type: 'equity',
    idempotencyKey: `${seed}-obacc`,
  });
  return created.accountId;
}

/**
 * D01: an item (stock-tracked, with a cost price) plus a location and one receipt, so a valuation or a
 * stocktake has something to value and freeze. `track_stock`/`cost_price_minor`/`reorder_point_qty`
 * are set straight on the row: the item CRUD does not expose them as top-level fields, and this seam
 * is exactly what D02/D03 will mint through later. Returns the ids.
 */
function stockSeed(fx, seed) {
  const item = fx.call('create_item', { name: 'Widget', defaultUnitPriceMinor: 5000, idempotencyKey: `${seed}-item` });
  fx.deps.store.db
    .prepare('UPDATE item SET track_stock = 1, cost_price_minor = ?, reorder_point_qty = ? WHERE workspace_id = ? AND id = ?')
    .run(2000, 5, fx.workspaceId, item.item.id);
  const loc = fx.call('stock_location_upsert', { name: 'Lager', idempotencyKey: `${seed}-loc` });
  fx.call('stock_move', {
    itemId: item.item.id,
    locationId: loc.location.id,
    qty: 10,
    reason: 'receipt',
    unitCostMinor: 2000,
    movedAt: '2026-03-01',
    idempotencyKey: `${seed}-recv`,
  });
  return { itemId: item.item.id, locationId: loc.location.id };
}

/**
 * J02: a stock-tracked item, a location and one receipt movement through the append-only ledger.
 * Returns { itemId, locationId, movementId }, the fixtures the movement-ledger read scenarios need.
 */
function movementReadSeed(fx, seed) {
  const item = fx.call('create_item', { name: 'Ledger Widget', defaultUnitPriceMinor: 1000, trackStock: true, idempotencyKey: `${seed}-item` });
  const loc = fx.call('stock_location_upsert', { name: 'Lager', idempotencyKey: `${seed}-loc` });
  const moved = fx.call('inventory_move', {
    itemId: item.item.id,
    locationId: loc.location.id,
    qty: 12,
    movementType: 'receipt',
    unitCostMinor: 1500,
    effectiveDate: '2026-03-02',
    idempotencyKey: `${seed}-recv`,
  });
  return { itemId: item.item.id, locationId: loc.location.id, movementId: moved.movement.id };
}

/**
 * D02: a vendor contact, a stock-tracked item (with a cost price for the receipt's unit cost) and a
 * stock location. The purchasing seam D02's write scenarios build on.
 */
function purchasingSeed(fx, seed) {
  const vendor = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant GmbH', idempotencyKey: `${seed}-vendor` });
  const item = fx.call('create_item', { name: 'Rohstoff', defaultUnitPriceMinor: 12000, idempotencyKey: `${seed}-item` });
  fx.deps.store.db
    .prepare('UPDATE item SET track_stock = 1, cost_price_minor = ? WHERE workspace_id = ? AND id = ?')
    .run(9000, fx.workspaceId, item.item.id);
  const loc = fx.call('stock_location_upsert', { name: 'Wareneingang', idempotencyKey: `${seed}-loc` });
  return { vendorId: vendor.contact.id, itemId: item.item.id, locationId: loc.location.id };
}

/**
 * I04: a fully received PO (10 units at net 100.00 = 1'000.00) plus a POSTED A17 bill of `grossMinor`
 * for the same supplier, so `match_three_way_evaluate` has a real triangle to score. Returns the ids.
 */
function seedThreeWayBill(fx, seed, grossMinor) {
  const s = purchasingSeed(fx, seed);
  fx.call('vat_seed_defaults', {});
  fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 10, unitPriceRappen: 10000 }], idempotencyKey: `${seed}-po` });
  fx.call('po_send', { poId: po.poId, idempotencyKey: `${seed}-send` });
  const line = fx.call('po_get', { poId: po.poId }).lines[0].id;
  fx.call('receipt_record', { poId: po.poId, locationId: s.locationId, lines: [{ poLineId: line, qty: 10 }], idempotencyKey: `${seed}-recv` });
  const bill = fx.call('create_vendor_bill', {
    vendorId: s.vendorId,
    billDate: '2026-03-05',
    amountMinor: grossMinor,
    amountIsGross: true,
    taxCode: 'VST-M',
    expenseAccountId: fx.accId('6500'),
    idempotencyKey: `${seed}-bill`,
  });
  fx.call('post_vendor_bill', { vendorBillId: bill.vendorBillId, idempotencyKey: `${seed}-post` });
  return { poId: po.poId, billId: bill.vendorBillId, lineId: line, vendorId: s.vendorId, itemId: s.itemId, locationId: s.locationId };
}

/**
 * I01: a SENT purchase order with one open (un-received) line, the amendable world every OP14
 * versioning/amendment scenario starts from. Returns the PO id and its first line id.
 */
function amendablePo(fx, seed) {
  const s = purchasingSeed(fx, seed);
  const po = fx.call('po_upsert', { supplierContactId: s.vendorId, lines: [{ itemId: s.itemId, qty: 6, unitPriceRappen: 10000 }], idempotencyKey: `${seed}-po` });
  fx.call('po_send', { poId: po.poId, idempotencyKey: `${seed}-send` });
  const lineId = fx.call('po_get', { poId: po.poId }).lines[0].id;
  return { ...s, poId: po.poId, lineId };
}

/** I01: an amendable PO with an OPEN draft amendment carrying one effective (valid) change op. */
function startedAmendment(fx, seed) {
  const w = amendablePo(fx, seed);
  const a = fx.call('po_amendment_start', { poId: w.poId, reason: 'Mengenerhöhung', idempotencyKey: `${seed}-start` });
  fx.call('po_amendment_update_lines', { amendmentId: a.amendment.id, changes: [{ op: 'change', poLineId: w.lineId, qty: 9 }], idempotencyKey: `${seed}-upd` });
  return { ...w, amendmentId: a.amendment.id };
}

/**
 * A minimal camt.053.001.08 statement carrying ONE booked entry, spelled out by hand rather than
 * templated from a library (the repo has no XML dependency, the `bazgFeed.ts` precedent). Every
 * element path matches the primary source the parser is pinned to (SPS 2.3, 20.02.2026): `Stmt/Id`,
 * `ElctrncSeqNb`, `Acct/Id/IBAN`, `Bal/Tp/CdOrPrtry/Cd` (mandatory OPBD+CLBD), and the entry's own
 * `Sts/Cd`, `BookgDt`/`ValDt`, `BkTxCd`.
 */
function camtFixtureXml({ statementId, seqNb = '1', iban, entryRef, amountMinor, creditDebit }) {
  const amount = (amountMinor / 100).toFixed(2);
  return `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08">
<BkToCstmrStmt><GrpHdr><MsgId>${statementId}-msg</MsgId><CreDtTm>2026-03-05T08:00:00</CreDtTm></GrpHdr>
<Stmt><Id>${statementId}</Id><ElctrncSeqNb>${seqNb}</ElctrncSeqNb>
<FrToDt><FrDtTm>2026-03-01T00:00:00</FrDtTm><ToDtTm>2026-03-01T23:59:59</ToDtTm></FrToDt>
<Acct><Id><IBAN>${iban}</IBAN></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">1000.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="CHF">960.00</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Ntry><NtryRef>${entryRef}</NtryRef><Amt Ccy="CHF">${amount}</Amt><CdtDbtInd>${creditDebit}</CdtDbtInd>
<Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>2026-03-01</Dt></BookgDt><ValDt><Dt>2026-03-01</Dt></ValDt>
<BkTxCd><Domn><Cd>PMNT</Cd><Fmly><Cd>ICDT</Cd><SubFmlyCd>OTHR</SubFmlyCd></Fmly></Domn></BkTxCd>
</Ntry></Stmt></BkToCstmrStmt></Document>`;
}

/** A vendor bill drafted AND posted (`vendorBillInput`'s gross 1'081.00), for A20's debit scenarios. */
function postedVendorBill(fx, seed) {
  const created = fx.call('create_vendor_bill', vendorBillInput(fx, seed));
  fx.call('post_vendor_bill', { vendorBillId: created.vendorBillId, idempotencyKey: `${seed}-post` });
  return created.vendorBillId;
}

/** One registered Bankkonto, linked to the seeded 1020, for the A19 scenarios that need one to exist. */
function bankAccount(fx, seed) {
  const created = fx.call('create_bank_account', {
    name: 'Kantonalbank Kontokorrent',
    iban: 'CH93 0076 2011 6238 5295 7',
    currency: 'CHF',
    ledgerAccountId: fx.accId('1020'),
    idempotencyKey: `${seed}-bank`,
  });
  return created.bankAccountId;
}

/** A18's shared world: one POSTED open vendor bill, ready to batch. */
function payableBillReady(fx, seed) {
  const posted = fx.call('record_expense', vendorBillInput(fx, seed));
  return { billId: posted.vendorBillId, vendorId: posted.vendorBill.vendorId };
}

/** A18: a `draft` payment batch over one posted bill, its vendor's IBAN already on file. */
function batchReady(fx, seed) {
  const { billId, vendorId } = payableBillReady(fx, seed);
  const bankAccountId = bankAccount(fx, seed);
  fx.call('set_creditor_bank_profile', {
    vendorId,
    iban: 'CH93 0076 2011 6238 5295 7',
    idempotencyKey: `${seed}-cbp`,
  });
  const created = fx.call('create_payment_batch', {
    bankAccountId,
    itemIds: [billId],
    executionDate: '2026-03-20',
    idempotencyKey: `${seed}-batch`,
  });
  return { batchId: created.batchId, bankAccountId, billId, vendorId };
}

/**
 * A21's shared world: an issued CHF 1'081.00 invoice, a registered Bankkonto, and a queued credit
 * carrying the invoice's OWN QRR (derived via `buildQrrReference`, the derivation A11 issues with
 * and A14 recognises) for the exact gross amount, so the credit scores `high` and an apply is
 * legal for the double-call. Returns both ids the decision verbs need.
 */
function qrCredit(fx, seed) {
  const inv = issuedInvoice(fx, seed);
  const doc = fx.call('get_document', { documentId: inv.id });
  const recorded = fx.call('record_incoming_credit', {
    bankAccountId: bankAccount(fx, seed),
    amountMinor: 108100,
    valueDate: '2026-03-01',
    reference: buildQrrReference(doc.document.number),
    payerName: 'Zahler AG',
    idempotencyKey: `${seed}-credit`,
  });
  return { creditId: recorded.credit.creditId, invoiceId: inv.id };
}

/**
 * A configured workspace with ONE issued invoice of gross CHF 1'081.00, for the A14 scenarios.
 *
 * It goes through A05, A09, A10 and A11's own verbs rather than writing rows, because A14 derives
 * every open amount from the ledger: an invoice faked into a table would give the payment scenarios
 * a receivable that reconciles to nothing.
 */
function issuedInvoice(fx, seed, contactId) {
  fx.call('vat_seed_defaults', {});
  fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  // `contactId` lets a caller put a SECOND invoice on the SAME customer as an earlier one (the
  // `allocate_payment` scenario needs exactly that: a Guthaben parked for one customer, allocated
  // to that SAME customer's second open invoice, never a different customer's, per D80's X1 guard).
  // Left absent, a fresh contact is created exactly as before.
  const resolvedContactId =
    contactId ??
    fx.call('create_contact', {
      partyRole: 'customer',
      name: 'Zahler AG',
      idempotencyKey: `${seed}-contact`,
    }).contact.id;
  const doc = fx.call('create_document', {
    type: 'invoice',
    contactId: resolvedContactId,
    currency: 'CHF',
    lines: [{ description: 'Beratung', unitPriceMinor: 100000, taxCode: 'UST81' }],
    idempotencyKey: `${seed}-doc`,
  });
  fx.call('issue_invoice', { invoiceId: doc.document.id, idempotencyKey: `${seed}-issue` });
  return { id: doc.document.id, contactId: resolvedContactId };
}

/**
 * One valid call per READ verb that is worth driving on real data: `(fx) => input`.
 *
 * WHY THIS EXISTS ALONGSIDE `SCENARIOS`, AND WHY IT IS OPT-IN WHERE THAT ONE IS MANDATORY. The
 * standing read rule in `conformance.test.mjs` calls every read verb twice, once with the tenant
 * alone and once with every required field filled with `'no_such_id'`, and asserts the database did
 * not move. That covers the REJECTING read and the empty-workspace read. It never once reaches a
 * read's happy path, because no machine can invent a valid input (a `bankAccountId`, a UID). So a
 * read verb that writes only when it succeeds, which is the shape a "read" defect actually takes,
 * passes that rule untouched.
 *
 * MEASURED, not argued. Injecting one `ctx.audit.record` into `previewBankOpeningBalance` AFTER its
 * guards, so it fires only when the call succeeds, leaves the existing rule GREEN and turns this one
 * RED naming the verb. That is the whole gap, in one line of injected code.
 *
 * A row here fixes that for one verb: the gate calls it on a fixture set up through the engine's own
 * write verbs, requires the call to SUCCEED, calls it a second time and requires the identical
 * answer, and compares the WHOLE database including `audit_log` and `audit_head` before and after.
 * The audit tables are the point: they are an append-only hash chain with no uniqueness constraint
 * of any kind, so a read that stamped a row would leave every business table identical and still not
 * be a read.
 *
 * It is OPT-IN because making it mandatory would demand a hand-written valid input for all forty-odd
 * read verbs at once, and a gate that lands red teaches people to skip it. `SCENARIOS` is mandatory
 * because a WRITE with no scenario is the case where "nobody said how this is called" is worth
 * stopping the build for.
 *
 * WHERE A NEW ROW GOES: next to the verb's own capability, not at the bottom. "Appended at the end"
 * is not a property an object literal keeps, and it is not even true of the registry it mirrors: the
 * A19 block there is followed by A08 and A04.
 *
 * THE TWO ROWS BELOW WERE WRITTEN INDEPENDENTLY AND MERGED AS THEIR UNION, which is what `develop`'s
 * copy of this note asked whoever merged it to do: A07's `vat_export_ech0217` landed on `develop`
 * reproducing this structure from the A19 branch, because that branch was not landed yet and a read
 * verb needed somewhere to be exercised from. Both rows survive and the floor below counts both.
 */
/**
 * B03's shared world: a budgeted B00 project with one approved hour (B01), billed onto an A11
 * invoice (B02) and POSTED (A11 issue), so the costing reads have both a cost and a revenue side
 * to answer with. Returns the project id.
 */
function costingSeed(fx, prefix) {
  fx.call('vat_seed_defaults', {});
  fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
  fx.call('set_creditor_profile', {
    creditorName: 'Projekterfolg GmbH',
    address: { street: 'Bahnhofstrasse', buildingNo: '1', zip: '8000', town: 'Zürich', country: 'CH' },
    qrIban: 'CH4431999123000889012',
  });
  const c = fx.call('create_contact', {
    partyRole: 'customer',
    name: 'Marge AG',
    address: { street: 'Musterstrasse', houseNo: '5', zip: '3000', city: 'Bern', country: 'CH' },
    email: 'buchhaltung@marge.example',
    idempotencyKey: `${prefix}-contact`,
  });
  const p = fx.call('project_create', {
    name: 'Projekterfolg',
    contactId: c.contact.id,
    budgetMinor: 500000,
    budgetHours: 40,
    idempotencyKey: `${prefix}-proj`,
  });
  fx.call('rate_card_upsert', { scope: 'default', rateMinor: 15000, validFrom: '2026-01-01', idempotencyKey: `${prefix}-rate` });
  fx.call('time_log', { userId: 'user-g', projectId: p.project.id, startedAt: '2026-07-06T08:00:00.000Z', minutes: 60, idempotencyKey: `${prefix}-log` });
  const s = fx.call('time_submit', { period: '2026-07', idempotencyKey: `${prefix}-submit` });
  const a = fx.call('time_approve', { entryIds: s.entryIds, idempotencyKey: `${prefix}-approve` });
  const inv = fx.call('billing_generate_invoice', { contactId: c.contact.id, timeEntryIds: a.approvedEntryIds, idempotencyKey: `${prefix}-gen` });
  fx.call('issue_invoice', { invoiceId: inv.invoiceId, idempotencyKey: `${prefix}-issue` });
  return { projectId: p.project.id, contactId: c.contact.id, invoiceId: inv.invoiceId };
}

export const READ_SCENARIOS = {
  // --- A20, camt reconciliation: the statement list is a pure read over bank_statement/bank_txn ----
  // One import first, so the read answers with a real statement and its open-line count rather than
  // the empty-workspace path; the snapshot proves the read itself writes nothing.
  list_bank_statements: (fx) => {
    const bankAccountId = bankAccount(fx, 'lbs');
    const iban = fx.call('get_bank_account', { bankAccountId }).bankAccount.iban;
    fx.call('import_camt', {
      bankAccountId,
      xml: camtFixtureXml({ statementId: 'LBS-STMT', iban, entryRef: 'LBS-NTRY', amountMinor: 4000, creditDebit: 'DBIT' }),
      idempotencyKey: 'lbs-import',
    });
    return { workspaceId: fx.workspaceId, bankAccountId };
  },
  // --- A36, live bank feed: the static bank directory is a pure read over in-package data ---------
  bank_channel_directory: (fx) => ({ workspaceId: fx.workspaceId, query: 'UBS' }),
  // --- A38, Abgrenzungen und Rückstellungen: the draft reads and the tax helper ------------------
  // Each seeds a draft (or a posted provision with a release) first, so the read answers with real
  // lines and a real open balance rather than the empty-workspace path; the snapshot proves the
  // read itself writes nothing. The tax helper reads a year with revenue and an instalment on 8900,
  // so its ZStB 27/1 figures are non-zero.
  accrual_get: (fx) => {
    const draft = fx.call('accrual_create', accrualDraft(fx, 'acc-get-seed'));
    return { workspaceId: fx.workspaceId, accrualId: draft.accrual.id };
  },
  accrual_list: (fx) => {
    fx.call('accrual_create', accrualDraft(fx, 'acc-list-seed'));
    return { workspaceId: fx.workspaceId, periodEnd: '2026-06-30' };
  },
  provision_get: (fx) => {
    const draft = fx.call('provision_create', provisionDraft(fx, 'prov-get-seed'));
    fx.call('provision_post', { provisionId: draft.provision.id, idempotencyKey: 'prov-get-post' });
    fx.call('provision_release', {
      provisionId: draft.provision.id,
      date: '2026-07-10',
      amountMinor: 100000,
      targetAccount: '6800',
      idempotencyKey: 'prov-get-rel',
    });
    return { workspaceId: fx.workspaceId, provisionId: draft.provision.id };
  },
  provision_list: (fx) => {
    fx.call('provision_create', provisionDraft(fx, 'prov-list-seed'));
    return { workspaceId: fx.workspaceId, status: 'draft' };
  },
  tax_provision_preview: (fx) => {
    fx.call('post_entry', {
      date: '2026-03-15',
      source: 'manual',
      description: 'Beratungshonorar',
      idempotencyKey: 'tax-prev-rev',
      lines: [
        { account: fx.accId('1020'), debit: 90000 },
        { account: fx.accId('3400'), credit: 90000 },
      ],
    });
    fx.call('post_entry', {
      date: '2026-05-02',
      source: 'manual',
      description: 'Provisorische Steuerrechnung',
      idempotencyKey: 'tax-prev-inst',
      lines: [
        { account: fx.accId('8900'), debit: 10000 },
        { account: fx.accId('1020'), credit: 10000 },
      ],
    });
    return { workspaceId: fx.workspaceId, periodEnd: '2026-12-31', rateBp: 2000 };
  },
  // --- M02, the §I sync/publish contract reads (pure over the append-only outbox) ----------------
  // `get_sync_contract` and `sync_stream_status` answer on a fresh workspace (publishing off).
  // `sync_stream_read` enables publishing and posts one entry first, so it reads a real journal.posted
  // event from the stream; the snapshot proves the read itself writes nothing (the enable + post are
  // the scenario's own setup, taken before the snapshot). `sync_artifact_read` is deliberately NOT here:
  // this build produces no artifact.* handles, so it can only answer artifact_not_found, and the read
  // scenarios require a succeeding call. It stays covered by the read-only-honesty rule above.
  get_sync_contract: (fx) => ({ workspaceId: fx.workspaceId }),
  sync_stream_status: (fx) => ({ workspaceId: fx.workspaceId }),
  sync_stream_read: (fx) => {
    fx.call('sync_publish_enable', { idempotencyKey: 'm02-read-enable' });
    fx.call('post_entry', manualPost(fx.accId, 'm02-read-post'));
    return { workspaceId: fx.workspaceId, cursor: { seq: 0 } };
  },

  // --- J02, the inventory movement ledger (pure reads over the append-only ledger) ---------------
  // Each seeds one receipt movement first, so the read runs against real ledger data rather than the
  // empty-workspace path, and the whole-database snapshot proves it mutates nothing.
  inventory_balance: (fx) => {
    const m = movementReadSeed(fx, 'ibal');
    return { workspaceId: fx.workspaceId, itemId: m.itemId, locationId: m.locationId };
  },
  inventory_movement_list: (fx) => {
    const m = movementReadSeed(fx, 'ilst');
    return { workspaceId: fx.workspaceId, itemId: m.itemId };
  },
  inventory_movement_get: (fx) => {
    const m = movementReadSeed(fx, 'iget');
    return { workspaceId: fx.workspaceId, movementId: m.movementId };
  },
  inventory_get_config: (fx) => {
    fx.call('inventory_set_config', { allowNegativeStock: false, idempotencyKey: 'igc-seed' });
    return { workspaceId: fx.workspaceId };
  },

  // --- J04, the three cycle-count / stocktake reads (pure over the session snapshot) --------------
  // Each seeds a real movement then opens a session (and counts a line for the report), so the read
  // runs against a real frozen snapshot rather than the empty path, and the whole-database snapshot
  // proves that reading a variance report / session writes nothing.
  inventory_stocktake_report: (fx) => {
    const m = movementReadSeed(fx, 'istr');
    const s = fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'istr-sess' });
    fx.call('inventory_stocktake_count', {
      sessionId: s.session.id,
      lines: [{ itemId: m.itemId, locationId: m.locationId, countedQty: 12 }],
      idempotencyKey: 'istr-cnt',
    });
    return { workspaceId: fx.workspaceId, sessionId: s.session.id };
  },
  inventory_stocktake_get: (fx) => {
    movementReadSeed(fx, 'istg');
    const s = fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'istg-sess' });
    return { workspaceId: fx.workspaceId, sessionId: s.session.id };
  },
  inventory_stocktake_list: (fx) => {
    movementReadSeed(fx, 'istl');
    fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'istl-sess' });
    return { workspaceId: fx.workspaceId };
  },

  // --- J05, the reason catalog + adjustment reads (pure over the reason master + adjustment linkage) -
  // Each seeds a real reason code (and, for the adjustment reads, a real movement + a posted adjustment
  // through inventory_adjust) so the read runs against real data, and the whole-database snapshot is
  // what proves listing / aggregating adjustments writes nothing.
  inventory_reason_list: (fx) => {
    fx.call('inventory_reason_create', { code: 'SCHWUND', name: 'Schwund', category: 'shrinkage', idempotencyKey: 'irl-seed' });
    return { workspaceId: fx.workspaceId, activeOnly: true };
  },
  inventory_reason_get: (fx) => {
    const r = fx.call('inventory_reason_create', { code: 'BESCHAED', name: 'Beschaedigung', category: 'damage', idempotencyKey: 'irg-seed' });
    return { workspaceId: fx.workspaceId, id: r.reason.id };
  },
  inventory_adjust_list: (fx) => {
    const m = movementReadSeed(fx, 'ial');
    const r = fx.call('inventory_reason_create', { code: 'SCHWUND', name: 'Schwund', category: 'shrinkage', idempotencyKey: 'ial-rsn' });
    fx.call('inventory_adjust', {
      itemId: m.itemId,
      locationId: m.locationId,
      qtyDelta: -1,
      reasonCodeId: r.reason.id,
      effectiveDate: '2026-03-05',
      idempotencyKey: 'ial-adj',
    });
    return { workspaceId: fx.workspaceId };
  },
  inventory_adjust_analysis: (fx) => {
    const m = movementReadSeed(fx, 'iaa');
    const r = fx.call('inventory_reason_create', { code: 'SCHWUND', name: 'Schwund', category: 'shrinkage', idempotencyKey: 'iaa-rsn' });
    fx.call('inventory_adjust', {
      itemId: m.itemId,
      locationId: m.locationId,
      qtyDelta: -2,
      reasonCodeId: r.reason.id,
      unitCostMinor: 1500,
      effectiveDate: '2026-03-06',
      idempotencyKey: 'iaa-adj',
    });
    return { workspaceId: fx.workspaceId, fromDate: '2026-01-01', toDate: '2026-12-31', groupBy: ['reason', 'category'] };
  },

  // --- J03, the four valuation reads (pure derivations over the same ledger) ----------------------
  // Each seeds a real receipt first, so the read values something rather than answering on an empty
  // workspace, and the whole-database snapshot is what proves that valuing inventory writes nothing.
  inventory_valuation_preview: (fx) => {
    const m = movementReadSeed(fx, 'ivp');
    return { workspaceId: fx.workspaceId, itemIds: [m.itemId], asOf: '2026-12-31' };
  },
  inventory_valuation_methods: (fx) => {
    fx.call('inventory_valuation_set_default', {
      method: 'fifo',
      effectiveFrom: '2026-01-01',
      idempotencyKey: 'ivm-seed',
    });
    return { workspaceId: fx.workspaceId };
  },
  inventory_valuation_layers: (fx) => {
    const m = movementReadSeed(fx, 'ivl');
    return { workspaceId: fx.workspaceId, itemId: m.itemId };
  },
  inventory_valuation_method_history: (fx) => {
    fx.call('inventory_valuation_set_default', {
      method: 'fifo',
      effectiveFrom: '2026-01-01',
      reason: 'Stetigkeitsnachweis',
      idempotencyKey: 'ivmh-seed',
    });
    return { workspaceId: fx.workspaceId };
  },

  // --- I05, supplier performance ----------------------------------------------------------------
  // Five PURE READS over the live I02 receipts and the D02 po_match trail. Each seeds a real vendor
  // contact so the tenant lookup resolves (a supplier is FOUND, not an empty-workspace short-circuit),
  // and runs the verb over that supplier's window. The window is empty of activity, which is a
  // spec-required state (empty period -> empty-state, ok:true), and the whole-database snapshot is what
  // proves a scorecard mutates nothing. Deep metric correctness over seeded PO/receipt/match fixtures
  // lives in `test/procurement/supplier-performance.test.mjs`, not in this floor.
  supplier_scorecard_get: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Muster', idempotencyKey: 'i05-sc-ct' });
    return { workspaceId: fx.workspaceId, supplierId: c.contact.id };
  },
  supplier_performance_rank: (fx) => {
    fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Rang', idempotencyKey: 'i05-rk-ct' });
    return { workspaceId: fx.workspaceId, metric: 'overall_score' };
  },
  supplier_performance_trend: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Trend', idempotencyKey: 'i05-tr-ct' });
    return { workspaceId: fx.workspaceId, supplierId: c.contact.id, metric: 'otif_pct', periods: 3 };
  },
  supplier_performance_explain: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Erklärung', idempotencyKey: 'i05-ex-ct' });
    return { workspaceId: fx.workspaceId, supplierId: c.contact.id, metric: 'otif_pct' };
  },
  supplier_performance_alerts: (fx) => {
    fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Warnung', idempotencyKey: 'i05-al-ct' });
    return { workspaceId: fx.workspaceId };
  },

  // --- I06, procurement analytics & agent tools -------------------------------------------------
  // Ten PURE READS over the live I00-I05 + D02 documents. Nine run on the empty-workspace happy path
  // (a spec-required state: empty period -> zero totals, ok:true), which is exactly the read whose
  // "writes nothing" claim the whole-database snapshot proves. `procurement_po_history` needs a real
  // PO to resolve, so it seeds one via `amendablePo` and reads its just-created timeline. Deep money
  // correctness over seeded PO/receipt/match fixtures lives in `test/procurement/i06-analytics.test.mjs`.
  procurement_open_commitments: (fx) => ({ workspaceId: fx.workspaceId }),
  procurement_match_status: (fx) => ({ workspaceId: fx.workspaceId }),
  procurement_spend_summary: (fx) => ({ workspaceId: fx.workspaceId, group_by: 'supplier', from_date: '2026-01-01', to_date: '2026-12-31' }),
  procurement_supplier_scorecard: (fx) => ({ workspaceId: fx.workspaceId }),
  procurement_requisition_pipeline: (fx) => ({ workspaceId: fx.workspaceId }),
  procurement_grir_clearing: (fx) => ({ workspaceId: fx.workspaceId }),
  procurement_landed_cost_variance: (fx) => ({ workspaceId: fx.workspaceId, from_date: '2026-01-01', to_date: '2026-12-31' }),
  procurement_po_cycle: (fx) => ({ workspaceId: fx.workspaceId, from_date: '2026-01-01', to_date: '2026-12-31' }),
  procurement_anomalies: (fx) => ({ workspaceId: fx.workspaceId, since: '2026-01-01' }),
  procurement_po_history: (fx) => {
    const po = amendablePo(fx, 'i06-hist');
    return { workspaceId: fx.workspaceId, po_id: po.poId };
  },

  // --- J07, inventory agent tools & alerts (ten PURE READS over the live J00-J06 cluster) ---------
  // Each seeds a real receipt movement first (movementReadSeed), so the read runs against real ledger
  // data rather than the empty-workspace path, and the whole-database snapshot proves that surfacing
  // stock position, alerts, drift, history, traces and reorder candidates mutates NOT ONE row (P5,
  // §H-STOCK-AUDIT). Deep aggregation / alert correctness lives in `test/inventory/agent.test.mjs`.
  inventory_stock_position: (fx) => {
    movementReadSeed(fx, 'j07sp');
    return { workspaceId: fx.workspaceId, include_valuation: true };
  },
  inventory_low_stock: (fx) => {
    movementReadSeed(fx, 'j07ls');
    return { workspaceId: fx.workspaceId };
  },
  inventory_valuation_status: (fx) => {
    movementReadSeed(fx, 'j07vs');
    return { workspaceId: fx.workspaceId };
  },
  inventory_movement_history: (fx) => {
    const m = movementReadSeed(fx, 'j07mh');
    return { workspaceId: fx.workspaceId, item_id: m.itemId };
  },
  inventory_anomalies: (fx) => {
    movementReadSeed(fx, 'j07an');
    return { workspaceId: fx.workspaceId };
  },
  inventory_cycle_count_status: (fx) => {
    movementReadSeed(fx, 'j07cc');
    fx.call('inventory_stocktake_create', { freezeAt: '2026-04-01', idempotencyKey: 'j07cc-sess' });
    return { workspaceId: fx.workspaceId };
  },
  inventory_lot_trace: (fx) => {
    movementReadSeed(fx, 'j07lt');
    return { workspaceId: fx.workspaceId, lot_code: 'NO-SUCH-LOT' };
  },
  inventory_slow_movers: (fx) => {
    movementReadSeed(fx, 'j07sm');
    return { workspaceId: fx.workspaceId };
  },
  inventory_alerts: (fx) => {
    movementReadSeed(fx, 'j07al');
    return { workspaceId: fx.workspaceId };
  },
  inventory_reorder_candidates: (fx) => {
    movementReadSeed(fx, 'j07rc');
    return { workspaceId: fx.workspaceId };
  },

  // --- G05, document templates ------------------------------------------------------------------
  // `preview_document_template` is the read that RENDERS: on a workspace with no document of the
  // template's kind it renders the synthetic MUSTER sample, and the whole-database snapshot is what
  // proves the render (and the resolution behind it) mutates nothing, which is the freeze design's
  // own constraint (freeze rides issue writes precisely so this read can stay a read).
  list_document_templates: (fx) => {
    fx.call('create_document_template', { documentKind: 'invoice', name: 'Listenprobe', idempotencyKey: 'ldt-c' });
    return { workspaceId: fx.workspaceId };
  },
  get_document_template: (fx) => {
    const created = fx.call('create_document_template', {
      documentKind: 'credit_note',
      name: 'Leseprobe',
      idempotencyKey: 'gdt-c',
    });
    return { workspaceId: fx.workspaceId, templateId: created.template.templateId };
  },
  preview_document_template: (fx) => {
    const created = fx.call('create_document_template', {
      documentKind: 'invoice',
      name: 'Vorschauprobe',
      footerI18n: { 'de-CH': 'Muster-Fusszeile' },
      idempotencyKey: 'pdt-c',
    });
    return { workspaceId: fx.workspaceId, templateId: created.template.templateId };
  },

  // --- G05 §10, dispatch texts and the send log --------------------------------------------------
  // `dispatch_preview` is the read that RESOLVES: against a saved text (written first, so the
  // resolution path over a real row is exercised) and the MUSTER sample values, and the snapshot is
  // what proves the resolution mutates nothing. `list_dispatches` is driven on a REAL log row: a
  // `quotes_send` completes its designed artifact-only path first, so the read lists an
  // `artifact_created` row rather than an empty table.
  dispatch_preview: (fx) => {
    fx.call('dispatch_text_upsert', {
      documentKind: 'invoice',
      locale: 'de-CH',
      subject: 'Rechnung {{invoice_number}}',
      body: 'Guten Tag {{contact_name}}, total {{amount_total}}.',
    });
    return { workspaceId: fx.workspaceId, documentKind: 'invoice' };
  },
  list_dispatches: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Protokoll AG', idempotencyKey: 'ld-seed' });
    const q = fx.call('quotes_create', {
      contactId: c.contact.id,
      validUntil: '2027-01-31',
      lines: [{ description: 'Leistung', unitPriceMinor: 20000 }],
      idempotencyKey: 'ld-quote',
    });
    fx.call('quotes_send', { quoteId: q.document.id, idempotencyKey: 'ld-send' });
    return { workspaceId: fx.workspaceId };
  },

  // --- G06, notifications & inbox ---------------------------------------------------------------
  // Both reads are driven on REAL delivered data: the queue read proves the self-scoped list plus
  // its live unreadCount over a row the OP8 action target really wrote, and the preferences read
  // proves the synthesised wildcard defaults arrive alongside a stored override rather than an
  // empty screen (US-G06.3 Empty).
  notifications_list: (fx) => {
    fx.call('notifications_deliver', {
      userId: 'agent',
      event: 'task.due',
      summaryI18nKey: 'notifications.summary.task_due',
      idempotencyKey: 'ntfl-seed',
    });
    return { workspaceId: fx.workspaceId, userId: 'agent' };
  },
  notifications_list_preferences: (fx) => {
    fx.call('notifications_set_preference', {
      userId: 'agent',
      event: 'task.due',
      channel: 'push',
      enabled: false,
      idempotencyKey: 'ntflp-seed',
    });
    return { workspaceId: fx.workspaceId, userId: 'agent' };
  },

  // --- E05, voice profile + OP6 local runtime ---------------------------------------------------
  // The five reads are the whole voice read surface, and the happy path is worth driving for the
  // OP6 reason: `voice_retrieve` reads exemplar BODIES on demand out of a real on-disk store, and
  // the whole-database snapshot is what PROVES it is a pure read (the spec's own purge-on-retrieve
  // idea was reconciled away for exactly this rule). The registry stub is process state, not a row.
  runtime_status: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    return { workspaceId: fx.workspaceId };
  },
  runtime_catalog: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    return { workspaceId: fx.workspaceId };
  },
  voice_profiles_list: (fx) => ({ workspaceId: fx.workspaceId }),
  voice_profile_get: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const root = mkdtempSync(join(tmpdir(), 'till-conf-vpg-'));
    makeMaildirStore(root, outboundCorpus(21));
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'vpg-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'vpg-r' });
    fx.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'vpg-sel' });
    const built = fx.call('voice_build', { accountId: account.accountId, idempotencyKey: 'vpg-b' });
    return { workspaceId: fx.workspaceId, profileId: built.profileId };
  },
  voice_retrieve: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const root = mkdtempSync(join(tmpdir(), 'till-conf-vrt-'));
    makeMaildirStore(root, outboundCorpus(21));
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'vrt-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'vrt-r' });
    fx.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'vrt-sel' });
    const built = fx.call('voice_build', { accountId: account.accountId, idempotencyKey: 'vrt-b' });
    return { workspaceId: fx.workspaceId, profileId: built.profileId, queryText: 'Können wir den Termin verschieben?', k: 3 };
  },

  // --- E06, draft runs (real data: a generated draft, its body read on demand from the store) ----
  draft_list: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const root = seedVoiceMailStore('dls');
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'dls-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'dls-r' });
    fx.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'dls-sel' });
    fx.call('voice_build', { accountId: account.accountId, idempotencyKey: 'dls-b' });
    const threads = fx.call('mail_threads_list', { bucket: 'needs_reply' });
    fx.call('draft_generate', { threadId: threads.items[0].id, idempotencyKey: 'dls-g' });
    return { workspaceId: fx.workspaceId, threadId: threads.items[0].id };
  },

  // --- E07, the offline proof (OP6). THE ONE BLESSED READ-VERB WRITER (D96) --------------------
  // `egress_self_test` STAYS a read verb: the offline proof is a trust feature every role including
  // a viewer must be able to run, so it gates on `egress.read` and nothing narrower (spec §5). To
  // prove the local-first claim it runs the REAL E04 -> E05 -> E06 loop under the hard egress probe,
  // which PERSISTS a local draft (draft_run + mail_draft). On an empty workspace it returns
  // `needs_setup` and stays inert, which is the ONLY reason the "no read writes on real data" rule
  // passed for it before D96: no scenario drove it against a set-up workspace. This scenario removes
  // that silence, and `READ_WRITE_CARVEOUTS` below bounds what the rule then tolerates to EXACTLY the
  // two local-draft tables. The setup mirrors E06's `draft_list`: a registered stub runtime, an
  // on-disk Maildir with a needs-reply inbound thread, and a built voice profile, so all four
  // prerequisites (mail_store, voice_profile, local_runtime, draftable_thread) exist and the loop
  // actually runs rather than short-circuiting on `needs_setup`.
  egress_self_test: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const root = seedVoiceMailStore('est');
    const account = fx.call('mail_connect', { adapter: 'thunderbird', storePath: root, address: 'praxis@example.ch', idempotencyKey: 'est-c' });
    fx.call('mail_reindex', { accountId: account.accountId, idempotencyKey: 'est-r' });
    fx.call('runtime_select', { modelRef: 'stub-4b-q4', source: 'catalog', idempotencyKey: 'est-sel' });
    fx.call('voice_build', { accountId: account.accountId, idempotencyKey: 'est-b' });
    return { workspaceId: fx.workspaceId };
  },

  // --- F01, report builder ---------------------------------------------------------------------
  // The reads answer over the always-present `contacts` source with no ledger seeded, so a NIL
  // workspace exercises each. `reports_runs` needs a saved report to name; the others do not.
  reports_sources: (fx) => ({ workspaceId: fx.workspaceId }),
  reports_list: (fx) => ({ workspaceId: fx.workspaceId }),
  reports_preview: (fx) => ({ workspaceId: fx.workspaceId, source: 'contacts', columns: ['name', 'email'] }),
  reports_runs: (fx) => {
    const r = fx.call('reports_save', { name: 'Verlauf', source: 'contacts', columns: ['name'], idempotencyKey: 'f01-runs-save' });
    return { workspaceId: fx.workspaceId, reportId: r.report.id };
  },

  // --- F03, vendor portal (the three scoped reads) ---------------------------------------------
  // Each is workspace-scoped and reads only. The grants list answers over an empty portal; the two
  // scoped reads take the OPERATOR preview path (an explicit vendor contactId, no token) and answer
  // an empty list, which is exactly what proves "a read verb CHANGED nothing" on real data. The
  // token path and the cross-contact isolation fuzz live in test/portal/vendor-portal.test.mjs.
  vendor_portal_grants_list: (fx) => ({ workspaceId: fx.workspaceId }),
  vendor_portal_pos: (fx) => {
    const v = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Read AG', idempotencyKey: 'vpp-vendor' });
    return { workspaceId: fx.workspaceId, contactId: v.contact.id };
  },
  vendor_portal_remittances: (fx) => {
    const v = fx.call('create_contact', { partyRole: 'vendor', name: 'Lieferant Rem AG', idempotencyKey: 'vprem-vendor' });
    return { workspaceId: fx.workspaceId, contactId: v.contact.id };
  },

  // --- A05, the Bewilligungsverlauf (F11) --------------------------------------------------------
  // Worth driving for the same reason the export below is: under the Saldo method no rate is ever
  // stamped on a journal line, so this history is the ONLY evidence of what a filed period was
  // computed with. A read that answered `{ generations: [] }` over the wire while the engine held two
  // approvals would take that evidence away silently, and the rule that never reaches a happy path
  // would not notice. The fixture records a real approval so the row has something to lose.
  vat_saldo_generations: (fx) => {
    fx.call('vat_configure', {
      method: 'saldo',
      timing: 'soll',
      registered: true,
      saldoRates: [{ rateBp: 620 }, { rateBp: 370 }],
      saldoActivities: [
        { activityId: 'restauration', name: 'Restauration', rateBp: 620, accounts: ['3200'] },
        { activityId: 'ablieferung', name: 'Ablieferung', rateBp: 370, accounts: ['3000'] },
      ],
      idempotencyKey: 'vsg-seed',
    });
    return { workspaceId: fx.workspaceId };
  },

  // --- A07, the eCH-0217 export ------------------------------------------------------------------
  // The verb PRODUCES A FILE, which is the one read in the registry where "it changed nothing" is
  // not a formality: a person signs for the figures in that file and uploads it to the ESTV. The
  // gate's second claim matters just as much here, that two calls answer identically, because
  // `generationTime` is a timestamp inside the document: taken from the wall clock instead of the
  // injected one it would make every export a different file, and this row would go red.
  //
  // A workspace with no postings exports a valid NIL return, so the fixture needs only the two
  // things eCH-0217 cannot be built without: an MWST method, and the UID.
  vat_export_ech0217: (fx) => {
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    // A UID that passes its mod-11 check digit. This was `CHE-116.281.277`, which is not a UID the
    // ESTV could ever have issued: the export now validates the check digit (weights 5,4,3,2,7,6,5,4)
    // rather than only the eCH-0108 shape pattern, because a transposed digit used to be schema-valid
    // and fail at the portal under MWST-0009.
    fx.call('update_company_profile', { uid: 'CHE-116.281.271' });
    return { workspaceId: fx.workspaceId, periodStart: '2026-04-01', periodEnd: '2026-06-30' };
  },

  // --- A19, the opening-balance preview (owner decision D43/B2) ---------------------------------
  // The verb exists so the base-currency figure an operator sees BEFORE Buchen is the figure the
  // posting then writes, and Buchen posts an immutable entry whose only correction is a reversing
  // entry. So "it changed nothing" is not a formality here: it is the verb's contract. The fixture
  // creates 9100 first for the same reason `set_bank_opening_balance`'s scenario does, since without
  // it the verb correctly answers `needs_account` and the call under test never succeeds.
  //
  // `test/banking/bank-opening-preview.test.mjs` holds the claim this cannot: that the previewed
  // base amount EQUALS the base amount the posting writes. This row holds the two claims that belong
  // to the wire, that it succeeds over the registry and that it moves nothing.
  preview_bank_opening_balance: (fx) => {
    openingBalanceAccount(fx, 'pbob');
    return {
      workspaceId: fx.workspaceId,
      bankAccountId: bankAccount(fx, 'pbob'),
      amountMinor: 1250000,
      currency: 'CHF',
      date: '2026-01-01',
    };
  },

  // --- D00, the effective-price resolver (the capability's agent-primary read) --------------------
  // This is the read a downstream document line calls to learn what to charge, and the answer is then
  // SNAPSHOTTED onto that line and issued as an invoice. So a wrong answer here is undetectable
  // downstream: there is no later step that re-derives the price and disagrees.
  //
  // The standing read rule cannot reach it. It calls every read with `'no_such_id'` in the required
  // fields, which `resolvePrice` correctly answers `not_found` to, and then with the tenant alone,
  // which fails the same way because `itemId` is required. Neither call ever gets as far as comparing
  // a `valid_from`, so every date defect the remediation just fixed lived entirely inside the part of
  // the verb no gate had ever executed over the wire.
  //
  // The fixture is therefore the case that matters and not the degenerate one: a contact-scoped list
  // holding a price that is genuinely in force at `at`, so the row asserts the CONTACT tier answers
  // rather than the base price silently standing in for it. `at` is explicit, because the point is
  // the comparison and not what today happens to be.
  price_resolve: (fx) => {
    const contact = fx.call('create_contact', { partyRole: 'customer', name: 'Preis AG', idempotencyKey: 'pr-contact' });
    const item = fx.call('create_item', { name: 'Widget', defaultUnitPriceMinor: 5000, idempotencyKey: 'pr-item' });
    const list = fx.call('price_lists_upsert', {
      name: 'Preis AG',
      contactId: contact.contact.id,
      idempotencyKey: 'pr-list',
    });
    fx.call('price_lists_set_price', {
      priceListId: list.priceList.id,
      itemId: item.item.id,
      priceMinor: 4200,
      validFrom: '2026-01-01',
      idempotencyKey: 'pr-price',
    });
    return { workspaceId: fx.workspaceId, itemId: item.item.id, contactId: contact.contact.id, at: '2026-06-30' };
  },

  // --- E00, the integrity-verified read path (OR 958f Abs. 3, GeBüV Art. 6) ----------------------
  // The read whose happy path IS the statutory duty. `files_get_content` re-hashes the stored bytes and
  // compares them against the stored `sha256` before it answers, so the case that matters is the one
  // where a file really exists and really matches: the standing read rule only ever reaches the
  // `not_found` branch, where nothing is hashed and nothing is returned.
  //
  // The second claim the gate makes here is the one worth having. This verb is the only read in the
  // registry that returns the BYTES of a business record, and it is therefore the read most likely to
  // be tempted into writing something: an access log, a "last opened" stamp, a cached hash. Any of
  // those would leave every business table identical and still make this not a read, and the
  // whole-database snapshot including `audit_log` is what would catch it.
  files_get_content: (fx) => {
    const created = fx.call('files_upload', {
      title: 'Kontoauszug Januar',
      filename: 'auszug-2026-01.pdf',
      mime: 'application/pdf',
      contentBase64: Buffer.from('%PDF-1.4 Kontoauszug Januar 2026').toString('base64'),
      idempotencyKey: 'fgc-seed',
    });
    return { workspaceId: fx.workspaceId, fileId: created.file.id };
  },

  // --- A25, the two filing exports whose file a person relies on ---------------------------------
  // Both are the `vat_export_ech0217` argument one capability over: the verb PRODUCES A FILE that
  // leaves the workspace (to the tax authority's working papers, to the annual accounts), so "it
  // succeeds on real data, answers identically twice, and moves nothing" is the verb's contract
  // rather than a formality. Neither embeds a timestamp, which is what makes the identical-answer
  // half hold by construction rather than by the fixture's pinned clock. `export_statements` has no
  // row because it only packages two calls into A08's own `exportStatement`, which the standing
  // rules and A08's suites already cover.
  export_journal: (fx) => {
    fx.call('post_entry', manualPost(fx.accId, 'xj-seed'));
    return { workspaceId: fx.workspaceId, period: '2026-03', format: 'csv' };
  },

  export_vat: (fx) => {
    fx.call('vat_seed_defaults', {});
    fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
    fx.call('post_entry', manualPost(fx.accId, 'xv-seed'));
    return { workspaceId: fx.workspaceId, period: '2026-03', format: 'csv' };
  },

  // --- B03, job costing / project P&L ------------------------------------------------------------
  // The whole capability is four reads (pure P5), so this opt-in IS its conformance story: each
  // scenario seeds a real project with approved time through the real verbs (the B02 shape), and
  // the gate proves the card, the portfolio, the budget comparison and the drilldown succeed on
  // real data, answer identically twice, and move not one row. `costingSeed` bills and posts the
  // time invoice so the revenue side is exercised, not just the cost side.
  costing_project_pl: (fx) => {
    const s = costingSeed(fx, 'cpl');
    return { workspaceId: fx.workspaceId, projectId: s.projectId };
  },

  costing_pl_list: (fx) => {
    costingSeed(fx, 'cll');
    return { workspaceId: fx.workspaceId };
  },

  costing_budget_vs_actual: (fx) => {
    const s = costingSeed(fx, 'cba');
    return { workspaceId: fx.workspaceId, projectId: s.projectId };
  },

  costing_drilldown: (fx) => {
    const s = costingSeed(fx, 'cdd');
    return { workspaceId: fx.workspaceId, projectId: s.projectId, component: 'time' };
  },

  // --- F00, dashboards & KPIs --------------------------------------------------------------------
  // The whole capability is two reads (pure P5), so this opt-in IS its conformance story, the B03
  // reasoning one capability over. `costingSeed` gives the wall real figures on four tiles at once
  // (revenue and AR from the posted time invoice, utilisation from the logged minutes, margin from
  // the project), so the gate proves the composition succeeds on real data, answers identically
  // twice (the injected clock pins A17's today and the MWST period), and moves not one row, which
  // for a verb that fans out into seven source engines is exactly the claim worth buying.
  dashboard_overview: (fx) => {
    costingSeed(fx, 'dov');
    return { workspaceId: fx.workspaceId, from: '2026-01-01', to: '2026-12-31' };
  },

  dashboard_tile: (fx) => {
    costingSeed(fx, 'dtl');
    return { workspaceId: fx.workspaceId, tile: 'ar_aging', from: '2026-01-01', to: '2026-12-31' };
  },

  // --- G11, the two check reads a Treuhänder relies on -------------------------------------------
  // `migration_get_check` is the record an approval was bound to, and `migration_export_check` is
  // the `export_journal` argument one family over: it PRODUCES the Prüfbericht file that leaves the
  // workspace (to the Treuhänder's working papers), so "succeeds on real data, answers identically
  // twice, moves nothing" is its contract. Neither embeds a timestamp beyond the check's own
  // persisted created_at, so the identical-answer half holds by construction.
  migration_get_check: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mgc', 'opening_balances');
    const checked = fx.call('migration_check_step', { planId, stepId, against: 'testmandant', idempotencyKey: 'mgc-check' });
    return { workspaceId: fx.workspaceId, checkId: checked.checkId };
  },

  migration_export_check: (fx) => {
    const { planId, stepId } = seedG09Step(fx, 'mxc', 'opening_balances');
    const checked = fx.call('migration_check_step', { planId, stepId, against: 'testmandant', idempotencyKey: 'mxc-check' });
    return { workspaceId: fx.workspaceId, checkId: checked.checkId, format: 'json' };
  },

  // --- C03, the whole verb surface (the B03 argument one axis over) ------------------------------
  // A capability that is ONLY reads has no write scenario to carry its happy path, and the standing
  // read rule never reaches one: it fills required fields with 'no_such_id', which these verbs
  // correctly refuse (`invalid_range`, `invalid_period`) or, worse for coverage, cannot even be
  // steered into the interesting branches with (an empty workspace answers a legitimate zero
  // forecast). The fixture seeds an open deal, a won deal and a sent deal-less quote, so every
  // component has something to lose; the whole-database snapshot then holds P5's core claim, that a
  // forecast pass writes NOT ONE row, at the same wire the Studio and MCP share. The pinned clock is
  // what makes the identical-answer half meaningful for `forecast_revenue`, whose period keys derive
  // from "today".
  forecast_weighted_pipeline: (fx) => {
    seedForecastWorld(fx, 'fwp');
    return { workspaceId: fx.workspaceId, groupBy: 'month' };
  },

  forecast_sales_kpis: (fx) => {
    seedForecastWorld(fx, 'fsk');
    return { workspaceId: fx.workspaceId, from: '2026-07-01', to: '2026-07-31' };
  },

  forecast_revenue: (fx) => {
    seedForecastWorld(fx, 'frv');
    return { workspaceId: fx.workspaceId, horizonMonths: 3 };
  },

  forecast_vs_actual: (fx) => {
    seedForecastWorld(fx, 'fva');
    return { workspaceId: fx.workspaceId, period: '2026-07' };
  },

  // --- G07, global search ------------------------------------------------------------------------
  // The one G07 verb is a READ, so this opt-in IS its conformance story (the C03/F00 argument): a
  // fan-out over nine entity tables plus the OP7 custom-field values is exactly the read most worth
  // proving inert on its happy path. The fixture seeds BOTH branches, a base-field hit (the contact
  // name) and a custom-field hit (an Aktenzeichen on that contact whose value also matches), so the
  // rule proves the composed search succeeds on real data, answers identically twice (ranking is
  // deterministic: exact > prefix > contains > custom-field-only, created_at DESC tie-break on a
  // pinned clock), and moves not one row.
  search_global: (fx) => {
    const c = fx.call('create_contact', { partyRole: 'customer', name: 'Muster AG', idempotencyKey: 'sg-c' });
    const defined = fx.call('define_field', {
      entityKind: 'contact',
      key: 'aktenzeichen',
      labelI18n: { 'de-CH': 'Aktenzeichen', en: 'File reference' },
      type: 'text',
      idempotencyKey: 'sg-def',
    });
    // The fixture's actor may be the agent, in which case the def lands as a P8 draft; confirming a
    // live field is a successful no-op, which keeps this scenario order-independent either way.
    fx.call('confirm_field', { fieldDefId: defined.fieldDef.fieldDefId, idempotencyKey: 'sg-conf' });
    fx.call('set_field_value', {
      entityKind: 'contact',
      entityId: c.contact.id,
      fieldKey: 'aktenzeichen',
      value: 'Muster-4471',
      idempotencyKey: 'sg-val',
    });
    return { workspaceId: fx.workspaceId, q: 'Muster' };
  },

  // --- H02, asset sub-ledger reads --------------------------------------------------------------
  // Both reads are driven on a REAL acquired asset (category -> draft asset -> primary acquisition),
  // so the whole-database snapshot proves they mutate nothing while returning a genuine transaction.
  asset_transaction_list: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-TXL',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-txl-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'Drehbank',
      acquisitionDate: '2026-04-01',
      acquisitionCostRappen: 400000,
      idempotencyKey: 'as-txl-seed',
    });
    fx.call('asset_acquire', {
      assetId: asset.asset.id,
      date: '2026-04-01',
      acquisitionCostRappen: 400000,
      creditAccountId: fx.accId('1020'),
      idempotencyKey: 'as-txl-acq',
    });
    return { workspaceId: fx.workspaceId, assetId: asset.asset.id };
  },
  asset_transaction_get: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-TXG',
      name: 'Maschinen',
      depreciationMethod: 'straight_line',
      usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'),
      glAccumDeprAccountId: fx.accId('1510'),
      glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-txg-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id,
      name: 'Hobelmaschine',
      acquisitionDate: '2026-04-02',
      acquisitionCostRappen: 300000,
      idempotencyKey: 'as-txg-seed',
    });
    const acq = fx.call('asset_acquire', {
      assetId: asset.asset.id,
      date: '2026-04-02',
      acquisitionCostRappen: 300000,
      creditAccountId: fx.accId('1020'),
      idempotencyKey: 'as-txg-acq',
    });
    return { workspaceId: fx.workspaceId, id: acq.transaction.id };
  },

  // H06, the disposal preview: an ACTIVE asset + valid accounts, driven so `read means read` bites on
  // the verb that constructs the (unposted) disposal journal. It writes nothing, so the before/after
  // database snapshot must be identical.
  asset_disposal_preview: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-DPV', name: 'Maschinen', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'), glAccumDeprAccountId: fx.accId('1510'), glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-dpv-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id, name: 'Presse', acquisitionDate: '2026-04-03', acquisitionCostRappen: 500000, idempotencyKey: 'as-dpv-seed',
    });
    fx.call('asset_acquire', {
      assetId: asset.asset.id, date: '2026-04-03', acquisitionCostRappen: 500000, creditAccountId: fx.accId('1020'), idempotencyKey: 'as-dpv-acq',
    });
    return {
      workspaceId: fx.workspaceId, assetId: asset.asset.id, disposalDate: '2026-07-15',
      proceedsRappen: 420000, proceedsAccountId: fx.accId('1020'), gainLossAccountId: fx.accId('6900'),
    };
  },
  // H06, the disposal get: a genuinely disposed asset, read back by its disposal transaction id.
  asset_disposal_get: (fx) => {
    const cat = fx.call('asset_category_create', {
      code: 'MACH-DPG', name: 'Maschinen', depreciationMethod: 'straight_line', usefulLifeMonths: 60,
      glAssetAccountId: fx.accId('1500'), glAccumDeprAccountId: fx.accId('1510'), glDeprExpenseAccountId: fx.accId('6800'),
      idempotencyKey: 'as-dpg-cat',
    });
    const asset = fx.call('asset_create', {
      categoryId: cat.category.id, name: 'Stanze', acquisitionDate: '2026-04-04', acquisitionCostRappen: 600000, idempotencyKey: 'as-dpg-seed',
    });
    fx.call('asset_acquire', {
      assetId: asset.asset.id, date: '2026-04-04', acquisitionCostRappen: 600000, creditAccountId: fx.accId('1020'), idempotencyKey: 'as-dpg-acq',
    });
    const disp = fx.call('asset_dispose', {
      assetId: asset.asset.id, disposalDate: '2026-07-16', proceedsRappen: 500000,
      proceedsAccountId: fx.accId('1020'), gainLossAccountId: fx.accId('6900'), idempotencyKey: 'as-dpg-disp',
    });
    return { workspaceId: fx.workspaceId, transactionId: disp.transaction.id };
  },
  // H08, the maintenance-log reads: a real logged event, read by id and listed for its asset.
  asset_maintenance_log_get: (fx) => {
    const assetId = maintenanceAssetSeed(fx, 'mlog-g');
    const log = fx.call('asset_maintenance_log_create', {
      assetId, logDate: '2026-08-10', maintenanceType: 'calibration', title: 'Kalibrierung', idempotencyKey: 'mlog-g-seed',
    });
    return { workspaceId: fx.workspaceId, id: log.log.id };
  },
  asset_maintenance_log_list: (fx) => {
    const assetId = maintenanceAssetSeed(fx, 'mlog-l');
    fx.call('asset_maintenance_log_create', {
      assetId, logDate: '2026-08-11', maintenanceType: 'preventive', title: 'Wartung', costRappen: 8_000, idempotencyKey: 'mlog-l-seed',
    });
    return { workspaceId: fx.workspaceId, assetId };
  },

  // --- H09, the six fixed-asset REPORTS (pure reads over the H00-H08 cluster) ---------------------
  // Each seeds a real acquired (and for the disposal report, disposed) asset first, so the read runs
  // against genuine data and the whole-database snapshot is what proves it mutates nothing.
  asset_register_report: (fx) => {
    reportsAssetSeed(fx, 'rr');
    return { workspaceId: fx.workspaceId, filter: { status: ['active'] }, limit: 100 };
  },
  asset_depreciation_forecast: (fx) => {
    reportsAssetSeed(fx, 'df');
    return { workspaceId: fx.workspaceId, fromPeriod: '2026-05', toPeriod: '2026-10', groupBy: 'category' };
  },
  asset_disposal_summary: (fx) => {
    reportsAssetSeed(fx, 'ds', { dispose: true });
    return { workspaceId: fx.workspaceId, fromDate: '2026-01-01', toDate: '2026-12-31' };
  },
  asset_acquisition_summary: (fx) => {
    reportsAssetSeed(fx, 'ac');
    return { workspaceId: fx.workspaceId, fromDate: '2026-01-01', toDate: '2026-12-31' };
  },
  asset_nbv_summary: (fx) => {
    reportsAssetSeed(fx, 'nb');
    return { workspaceId: fx.workspaceId, groupBy: 'category' };
  },
  asset_end_of_life_list: (fx) => {
    reportsAssetSeed(fx, 'eol');
    return { workspaceId: fx.workspaceId, withinMonths: 60 };
  },

  // --- G15, the attention hub (pure reads composing the module work queues; own no table) ----------
  // The empty-workspace path is enough to prove non-mutation: both verbs read the providers (which
  // read other modules' reads) and the whole-database snapshot proves neither writes a row. With the
  // fixture's allow-all capabilities every registered queue is visible (agent_action, qr_match,
  // review_flag, dunning_run), so the summary answers a real { visibleQueues:4, total:0 } and the list
  // answers an empty page, and both mutate nothing. The F-01 decision fields an item carries
  // (decisionOptions, suggestedInvoiceId, reasonCode, consequence) are DERIVED per read and prove
  // themselves over real rows in test/attention/attention-decisions.test.mjs, incl. that acting through
  // an option twice writes once; the reads themselves stay pure.
  attention_summary: (fx) => ({ workspaceId: fx.workspaceId, topLimit: 5 }),
  attention_list: (fx) => ({ workspaceId: fx.workspaceId }),

  // --- A26 + A35, the agent queue and the oversight reads ---------------------------------------
  // Real data: `list_drafted_actions` runs over a really-seeded pending row; the three A35 reads run
  // over a real trace written by `agent_ask` (the stub runtime, the E05/E06 scenario door). Each is a
  // pure SELECT over the agent tables and the whole-database snapshot proves it writes nothing.
  list_drafted_actions: (fx) => {
    seedDraftedAction(fx, 'lda-read', 'set_aging_bucket_config', {
      workspaceId: fx.workspaceId,
      boundariesDays: [30, 60, 90],
      idempotencyKey: 'lda-inner',
    });
    return { workspaceId: fx.workspaceId };
  },
  list_agent_sessions: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    fx.call('agent_ask', { workspaceId: fx.workspaceId, text: 'Wie hoch ist der Umsatz?', idempotencyKey: 'las-seed' });
    return { workspaceId: fx.workspaceId };
  },
  get_agent_session: (fx) => {
    registerRuntime(stubAdapter(), stubManifest());
    const asked = fx.call('agent_ask', { workspaceId: fx.workspaceId, text: 'Wie hoch ist der Umsatz?', idempotencyKey: 'gas-seed' });
    return { workspaceId: fx.workspaceId, sessionId: asked.sessionId };
  },
  agent_trust_summary: (fx) => {
    seedDraftedAction(fx, 'ats-read', 'post_entry', { workspaceId: fx.workspaceId, idempotencyKey: 'ats-inner' });
    return { workspaceId: fx.workspaceId };
  },
  // M00: `delivery_status` is pre-workspace and takes no input. It reads the process runtime-state
  // singleton and the store's `PRAGMA user_version`, and writes nothing, so the whole-database
  // snapshot over a really-minted workspace is what proves the read is inert.
  delivery_status: () => ({}),
  // G04 / F-06: `list_restorable_backups` is pre-workspace too, a read over the backup DIRECTORY
  // (deps.backupDir, a temp dir in the fixture). It answers on an empty directory as well; the seed
  // takes one backup first so the read lists a real bundle with its generation.
  list_restorable_backups: (fx) => {
    fx.call('create_backup', { idempotencyKey: 'g04-lrb-seed' });
    return {};
  },
  // G20, implementation projects. `implementation_project_get` and `implementation_parallel_status`
  // read one project (created fresh on a future cutover); `implementation_project_list` reads the
  // workspace roster metadata. All three are pure SELECTs over the six governance tables and mint
  // nothing, so the whole-database snapshot over a really-created project proves each read inert.
  implementation_project_get: (fx) => {
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'ipg-read-proj' }).projectId;
    return { workspaceId: fx.workspaceId, projectId };
  },
  implementation_project_list: (fx) => {
    fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'ipl-read-proj' });
    return { workspaceId: fx.workspaceId };
  },
  implementation_parallel_status: (fx) => {
    const projectId = fx.call('implementation_project_create', { sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', idempotencyKey: 'ips-read-proj' }).projectId;
    return { workspaceId: fx.workspaceId, projectId };
  },

  // G22, checklists. `checklist_templates` reads shipped data; `checklist_get` and `checklist_list`
  // derive a really-started 2026-Q2 run live (the checks, the computed-return hash) and write nothing:
  // the whole-database snapshot over the started run proves each read inert and answers identically twice.
  checklist_templates: (fx) => ({ workspaceId: fx.workspaceId }),
  checklist_get: (fx) => ({ workspaceId: fx.workspaceId, runId: seedChecklistRun(fx, 'chk-get-read') }),
  checklist_list: (fx) => {
    seedChecklistRun(fx, 'chk-list-read');
    return { workspaceId: fx.workspaceId };
  },

  // A38 (D129 leg 2), the MWST-Saldierung reads. `vat_settlement_preview` derives the settlement model
  // of a filed, tagged 2026-Q2 live (the movement read, A07's return, the lines) and writes nothing;
  // `vat_settlement_list` reads over a really-posted settlement; `vat_annual_reconciliation` derives the
  // two Art. 128 MWSTV reconciliations over the year with one quarter filed. The snapshot proves each
  // inert and identical twice.
  vat_settlement_preview: (fx) => {
    seedSettledQuarter(fx, 'vsp-read', false);
    return { workspaceId: fx.workspaceId, period: '2026-Q2' };
  },
  vat_settlement_list: (fx) => {
    seedSettledQuarter(fx, 'vsl-read', true);
    return { workspaceId: fx.workspaceId, year: '2026' };
  },
  vat_annual_reconciliation: (fx) => {
    seedSettledQuarter(fx, 'var-read', false);
    return { workspaceId: fx.workspaceId, year: '2026' };
  },
};

/**
 * A38's shared world: G22's effektiv/soll workspace with one tagged sale in 2026-Q2 and the quarter
 * filed through `vat_mark_filed`. With `settle` the quarter is also settled through the real verb, and
 * the settlement id is returned.
 */
function seedSettledQuarter(fx, prefix, settle) {
  seedChecklistWorld(fx);
  fx.call('post_entry', {
    date: '2026-05-15',
    source: 'manual',
    description: 'Beratung Mai',
    idempotencyKey: `${prefix}-sale`,
    lines: [
      { account: fx.accId('1100'), debit: 108100 },
      { account: fx.accId('3200'), credit: 100000, taxCode: 'UST81' },
      { account: fx.accId('2200'), credit: 8100 },
    ],
  });
  const filed = fx.call('vat_mark_filed', { period: '2026-Q2', idempotencyKey: `${prefix}-file` });
  if (filed.ok !== true) throw new Error(`seedSettledQuarter filing: ${JSON.stringify(filed)}`);
  if (!settle) return null;
  const settled = fx.call('vat_settlement_post', { period: '2026-Q2', idempotencyKey: `${prefix}-settle` });
  if (settled.ok !== true) throw new Error(`seedSettledQuarter settlement: ${JSON.stringify(settled)}`);
  return settled.settlementId;
}

/** G22's shared world: an effektiv/soll workspace with the default tax codes, so 2026-Q2 is filable. */
function seedChecklistWorld(fx) {
  fx.call('vat_seed_defaults', {});
  fx.call('set_vat_method', { vatMethod: 'effektiv', vatAccounting: 'soll' });
}

/** A started `vat_period` run for 2026-Q2 on the shared world. Returns the run id. */
function seedChecklistRun(fx, prefix) {
  seedChecklistWorld(fx);
  const started = fx.call('checklist_start', { templateId: 'vat_period', period: '2026-Q2', idempotencyKey: `${prefix}-start` });
  if (started.ok !== true) throw new Error(`seedChecklistRun: ${JSON.stringify(started)}`);
  return started.runId;
}

/**
 * H09's shared seed: a category, a draft asset, its primary acquisition (so the asset is active with a
 * real cost base and a sub-ledger acquisition row), and optionally a disposal. Returns the asset id.
 * Nothing here is H09's own surface: the reports read what H00-H06 wrote.
 */
function reportsAssetSeed(fx, prefix, opts = {}) {
  const cat = fx.call('asset_category_create', {
    code: `MACH-${prefix.toUpperCase()}`,
    name: 'Maschinen',
    depreciationMethod: 'straight_line',
    usefulLifeMonths: 12,
    glAssetAccountId: fx.accId('1500'),
    glAccumDeprAccountId: fx.accId('1510'),
    glDeprExpenseAccountId: fx.accId('6800'),
    idempotencyKey: `${prefix}-cat`,
  });
  const asset = fx.call('asset_create', {
    categoryId: cat.category.id,
    name: 'Fräse',
    acquisitionDate: '2026-04-01',
    acquisitionCostRappen: 1_200_000,
    idempotencyKey: `${prefix}-seed`,
  });
  fx.call('asset_acquire', {
    assetId: asset.asset.id,
    date: '2026-04-01',
    acquisitionCostRappen: 1_200_000,
    creditAccountId: fx.accId('1020'),
    idempotencyKey: `${prefix}-acq`,
  });
  if (opts.dispose === true) {
    fx.call('asset_dispose', {
      assetId: asset.asset.id,
      disposalDate: '2026-07-20',
      proceedsRappen: 1_000_000,
      proceedsAccountId: fx.accId('1020'),
      gainLossAccountId: fx.accId('6900'),
      idempotencyKey: `${prefix}-disp`,
    });
  }
  return asset.asset.id;
}

/**
 * C03's shared world: one customer, an open deal with a close date, a won deal, a lost deal and a
 * sent deal-less quote, so all three revenue components, the KPI sample and the vs-actual pipeline
 * side are non-empty. Nothing here posts: C03 is a pure read model and its fixture honours that by
 * seeding only pipeline and quote state.
 */
function seedForecastWorld(fx, prefix) {
  const c = fx.call('create_contact', { partyRole: 'customer', name: 'Prognose AG', idempotencyKey: `${prefix}-c` });
  const open = fx.call('deals_create', {
    contactId: c.contact.id,
    title: 'Offen',
    valueMinor: 80000,
    expectedCloseOn: '2026-08-20',
    idempotencyKey: `${prefix}-open`,
  });
  const won = fx.call('deals_create', {
    contactId: c.contact.id,
    title: 'Gewonnen',
    valueMinor: 50000,
    idempotencyKey: `${prefix}-won`,
  });
  fx.call('deals_mark', { dealId: won.dealId, status: 'won', idempotencyKey: `${prefix}-w` });
  const lost = fx.call('deals_create', {
    contactId: c.contact.id,
    title: 'Verloren',
    valueMinor: 30000,
    idempotencyKey: `${prefix}-lost`,
  });
  fx.call('deals_mark', { dealId: lost.dealId, status: 'lost', lostReason: 'Preis', idempotencyKey: `${prefix}-l` });
  const quote = fx.call('quotes_create', {
    contactId: c.contact.id,
    lines: [{ description: 'Beratung', unitPriceMinor: 30000 }],
    validUntil: '2026-08-31',
    idempotencyKey: `${prefix}-q`,
  });
  fx.call('quotes_send', { quoteId: quote.document.id, idempotencyKey: `${prefix}-qs` });
  return { contactId: c.contact.id, openDealId: open.dealId, wonDealId: won.dealId };
}

/**
 * The recorded number of read verbs driven on real data. It goes UP.
 *
 * The opt-in above is the right shape and the wrong thing to leave unratcheted: with no floor, a
 * scenario deleted or commented out is a silence, and the verb quietly drops back to being covered
 * only by the rule that never reaches its happy path. That is the gap the real-data rule exists to
 * close, so the omission would be invisible in exactly the case that matters.
 *
 * WHAT IT DOES NOT CATCH, corrected after a critic measured all three mutations rather than two. A
 * RENAMED scenario is invisible to this floor, because the COUNT is unchanged: the net effect is
 * caught, but by a different rule, the pre-existing cross-check that every name in `READ_SCENARIOS`
 * is a read verb in the registry (`preview_bank_opening_balance_RENAMED: has a read scenario but is
 * not a read verb in the registry`). The docstring used to claim the rename as well, which is the
 * same defect as a tool description claiming a refusal it does not make: a guard whose stated reach
 * exceeds its actual reach invites the next author to stop looking.
 *
 * `DECLARED_FLOOR` in `test/style/result-payload-is-declared.test.mjs` is the same instrument for
 * the same problem, and it is asserted BOTH as a floor and as an equality: the floor is what stops
 * coverage falling, and the equality is what makes adding a scenario and raising the number one
 * commit rather than two. `conformance.test.mjs` asserts both against this constant.
 *
 * Two was a starting position, not a boast: A19's preview and A07's eCH-0217 export, one from each
 * side of the merge. F11 makes it three by adding A05's `vat_saldo_generations`, and D00's
 * remediation makes it four by adding `price_resolve`. E00 makes it five with `files_get_content`,
 * whose happy path is a statutory duty rather than a convenience. A25 makes it seven with
 * `export_journal` and `export_vat`, the two file-producing reads a Treuhänder files with. G11
 * makes it nine with `migration_get_check` (the record an approval binds to) and
 * `migration_export_check` (the Prüfbericht file). B03 makes it thirteen with its whole verb
 * surface, because a capability that is ONLY reads has no write scenario to carry its happy path.
 * F00 makes it fifteen the same way: the dashboard's two reads ARE the capability, and a verb that
 * fans out into seven source engines is the read most worth proving inert on its happy path.
 * C03 makes it nineteen with its whole verb surface, the B03 argument again: a read-only
 * capability has no write scenario to carry its happy path, and P5's "a forecast pass writes NOT
 * ONE row" is exactly the claim the whole-database snapshot holds.
 * D96 makes it THIRTY-THREE with `egress_self_test`, and this one is the exception that proves the
 * shape: it is the ONE read verb that DOES write on its happy path, a local draft (draft_run +
 * mail_draft) it persists to prove the local-first claim. Its scenario is driven under the
 * `READ_WRITE_CARVEOUTS` carve-out below, which bounds the tolerated write to exactly those two
 * tables; the whole-database snapshot the rule takes then still bites on any OTHER table it might
 * touch. Before D96 it had no scenario, so the "no read writes on real data" rule passed it by never
 * reaching its happy path, which is the exact silence this floor exists to forbid.
 * G07 makes it THIRTY-SEVEN with `search_global`, the C03 argument again: a read-only capability
 * has no write scenario to carry its happy path, and a verb that fans out over nine entity tables
 * plus the custom-field values is the read most worth proving inert on real data.
 * Raise it with each read verb whose happy path becomes worth driving, and when every read verb
 * has a row, make the rule mandatory and delete this.
 * G06 makes it THIRTY-EIGHT: `notifications_list` (the self-scoped queue plus its live
 * unreadCount over a really-delivered row) and `notifications_list_preferences` (the synthesised
 * wildcard defaults alongside a stored override), both pure reads under the whole-database snapshot.
 * J02 makes it FORTY-SEVEN (+4): `inventory_balance` (on-hand as the pure SUM over a real receipt),
 * `inventory_movement_list` (the history with its server-computed running balance),
 * `inventory_movement_get` (one real movement) and `inventory_get_config` (the negative-stock
 * posture), each driven over a seeded movement so the read runs on real ledger data, not the empty
 * path.
 * J03 makes it FIFTY-ONE (+4): `inventory_valuation_preview`, `inventory_valuation_methods`,
 * `inventory_valuation_layers` and `inventory_valuation_method_history`. These four are the strongest
 * case in the list for a read scenario, because "valuing inventory writes nothing" is the CLAIM the
 * capability rests on: J03 produces the balance-sheet figure and J06 books it, and if a preview left
 * a row behind then the pure-read design would be a story rather than a fact. The whole-database
 * snapshot over a really-seeded receipt is what turns it into one.
 * I06 makes it SEVENTY (+10): the whole procurement-analytics verb surface
 * (`procurement_open_commitments` / `_match_status` / `_spend_summary` / `_supplier_scorecard` /
 * `_requisition_pipeline` / `_grir_clearing` / `_landed_cost_variance` / `_po_cycle` / `_anomalies`
 * / `_po_history`). The C03 / I05 argument again: a read-only capability has no write scenario to
 * carry its happy path, and "a procurement analytics pass writes NOT ONE row" is the exact claim the
 * whole-database snapshot holds. Nine run on the empty workspace; `_po_history` on a seeded PO.
 * J04 makes it SEVENTY-NINE (+3): `inventory_stocktake_report` (the variance report over a counted
 * line), `inventory_stocktake_get` (one session with its frozen lines) and `inventory_stocktake_list`
 * (the session list with live progress). A stocktake report reads the J02 snapshot and the session's
 * own lines and mints nothing (P5); the whole-database snapshot over a really-seeded session proves it.
 * J05 makes it EIGHTY-THREE (+4): `inventory_reason_list` and `inventory_reason_get` (the reason
 * catalog), `inventory_adjust_list` (the manual-adjustment history joined to reason + item + location)
 * and `inventory_adjust_analysis` (the shrinkage / write-down aggregation). Each reads the reason master
 * and the inventory_adjustment linkage over the J02 ledger and mints nothing; the whole-database
 * snapshot over a really-seeded reason + posted adjustment is what proves it.
 * J07 makes it NINETY-THREE (+10): the whole inventory agent-tools verb surface
 * (`inventory_stock_position` / `_low_stock` / `_valuation_status` / `_movement_history` /
 * `_anomalies` / `_cycle_count_status` / `_lot_trace` / `_slow_movers` / `_alerts` /
 * `_reorder_candidates`). The C03 / I05 / I06 argument once more: a read-only capability has no write
 * scenario to carry its happy path, and "J07 owns no table and posts NOT ONE row" is the exact claim
 * the whole-database snapshot holds. Each is driven over a seeded receipt movement so the read runs on
 * real ledger data, not the empty path.
 * A26 + A35 make it NINETY-NINE (+4): `list_drafted_actions` (the queue's read face, over a seeded
 * pending row), and the three oversight reads (`list_agent_sessions` / `get_agent_session` over a
 * real trace written by `agent_ask`, `agent_trust_summary` over the queue). Pure SELECTs over the
 * agent tables; the snapshot proves each writes nothing.
 * M00 makes it ONE HUNDRED (+1): `delivery_status`, the pre-workspace process read (mode, version,
 * schema generation, bound host/port, scheduler tick). It reads the runtime-state singleton and
 * `PRAGMA user_version` and writes no row; the whole-database snapshot proves it inert.
 * M02 makes it ONE HUNDRED AND THREE (+3): `get_sync_contract` and `sync_stream_status` over a fresh
 * workspace (publishing off), and `sync_stream_read` over an enabled workspace with one posted entry.
 * All three are pure SELECTs over the sync outbox/state; the snapshot proves each writes nothing.
 * `sync_artifact_read` is deliberately absent (this build produces no artifact.* handles, so it can
 * only answer artifact_not_found, and a read scenario must succeed), covered by the read-only rule.
 * G20 makes it ONE HUNDRED AND SEVEN (+3): `implementation_project_get` and
 * `implementation_parallel_status` over a really-created project, and `implementation_project_list`
 * over the workspace roster. All three are pure SELECTs over the six governance tables; the
 * whole-database snapshot over a created project proves each read inert.
 * F-06 (J7.2) makes it ONE HUNDRED AND EIGHT (+1): `list_restorable_backups`, the pre-workspace
 * read over the backup DIRECTORY (deps.backupDir), driven after one `create_backup` so it lists a
 * real bundle with its generation. It opens no database and the snapshot proves it writes nothing.
 * F-03 (the booking paths, A20) makes it ONE HUNDRED AND NINE (+1): `list_bank_statements` over a
 * workspace with one imported camt.053, a pure SELECT over `bank_statement` and `bank_txn`; the
 * snapshot proves it inert.
 * G22 makes it ONE HUNDRED AND TWELVE (+3): `checklist_templates` (shipped data), `checklist_get` and
 * `checklist_list` over a really-started 2026-Q2 run, each deriving the live checks and the
 * computed-return hash and writing nothing; the snapshot proves each inert and identical twice.
 * A38 (D129 leg 2) makes it ONE HUNDRED AND FIFTEEN (+3): `vat_settlement_preview`, `vat_settlement_list`
 * and `vat_annual_reconciliation` over a filed, tagged 2026-Q2 (one of them over a really-posted
 * settlement), each a derivation from the ledger and A07's return, writing nothing.
 */
export const READ_SCENARIO_FLOOR = 120;

/**
 * THE ONE BLESSED READ-VERB WRITER (D96), and nothing else.
 *
 * The conformance "no read verb writes on real data" rule holds every read verb to a whole-database
 * snapshot: run it on a set-up workspace, and not one row may differ. `egress_self_test` is the sole
 * deliberate exception. It STAYS a read verb (D96 kept it gated on `egress.read`, held by every role
 * including a viewer, because the offline proof is a trust feature everyone must be able to run), but
 * to PROVE the local-first claim it runs the real E04 -> E06 draft loop under the hard egress probe,
 * which persists a LOCAL draft. That draft is benign (no money, no send, no network, in the user's
 * own workspace), so D96 blesses the write rather than re-classifying the verb.
 *
 * The blessing is BOUNDED, not blanket. The value is the exact set of tables the verb may touch: a
 * local draft is `draft_run` (E06's run row) plus `mail_draft` (E04's Drafts write) and NOTHING
 * else. The rule enforces the bound with the same whole-database snapshot: every table that changed
 * must be in this set, so `egress_self_test` writing a money, ledger or audit row FAILS exactly as
 * any other write would, and because no other verb is a key here, the rule is not loosened for
 * anything else. A read verb that is NOT in this map still faces the unmodified "not one row may
 * differ" assertion.
 */
export const READ_WRITE_CARVEOUTS = Object.freeze({
  egress_self_test: Object.freeze(['draft_run', 'mail_draft']),
});

/**
 * THE ONLY ESCAPE HATCH IN THE GATE.
 *
 * §H-IDEMPOTENT says every write takes an idempotency key. A verb listed here does not, and the
 * reason has to survive being read cold by someone else. Adding a name here is a deliberate edit in
 * a reviewed diff, which is the point: a new verb that quietly forgot its key goes RED instead of
 * disappearing into a skip.
 *
 * Being on this list buys ONE rule and nothing else. Every verb here is still double-called by the
 * gate and still has to settle: that is what makes the "naturally idempotent" claim below a tested
 * claim rather than a comment.
 *
 * The shared reason across the list: these are ABSOLUTE state-setting writes (set this field, put
 * this row in this state), not relative ones. A duplicate delivery re-asserts the same state and
 * cannot double-count, so a key would buy replay protection nothing needs. §H-IDEMPOTENT bites on
 * writes that MINT or MOVE something, and those all carry a key.
 */
export const IDEMPOTENCY_KEY_EXEMPT = Object.freeze({
  inventory_ensure_default_location:
    'Idempotent by construction (J00): it takes no input beyond the workspace and asserts the absolute state "a MAIN/DEFAULT warehouse+location pair exists". A second call re-reads the same pair rather than minting a second one, guarded by the one-default-per-workspace and one-default-per-warehouse partial-unique indexes, so a key would add ceremony without adding a guarantee.',
  set_diagnostics:
    'Sets the error-recording preference to an absolute value on this computer. A second delivery re-asserts the same boolean and cannot accumulate, so a key would add ceremony without adding a guarantee (G08 section 5).',
  clear_diagnostics:
    'Asserts the absolute state "the journal is empty". Clearing an already-empty journal is the same empty journal, so there is nothing a replay could double (G08 section 5).',
  set_fiscal_config: 'Sets fields to absolute values. Re-applying the same config is the same config.',
  dispatch_text_upsert:
    'Asserts the absolute state of one (documentKind, locale) text slot: a second delivery re-asserts the same subject/body and cannot accumulate, and a value-identical upsert is a FULL no-op that touches nothing, updated_at included (G05 section 10.4).',
  advance_onboarding_step:
    'Sets the wizard resume pointer (path, step) to absolute values, one row per workspace. A replay re-asserts the same pointer; nothing accumulates and nothing downstream gates on it (G03 section 4).',
  advance_move_step:
    'Sets the move-checklist resume pointer (direction, per-step done state) to absolute values, one row per workspace, the advance_onboarding_step shape verbatim: a replayed done keeps the original timestamp, a replayed abandon of an absent row is the same absent row, and nothing downstream gates on it (M03 section 3.1).',
  set_vat_method: 'Sets the method/timing pair absolutely. A replay re-asserts the same pair.',
  set_fx_method:
    'Sets one Steuerperiode conversion basis to an absolute value, and re-asserting the same basis writes nothing at all (that no-op is what keeps a retry safe after the period has locked).',
  set_creditor_profile: 'Overwrites the one creditor row with the values given. No accumulation.',
  set_ebill_config: 'Upserts the one eBill config row per workspace to an absolute biller_pid. A replay re-asserts the same value; nothing accumulates (A32 section 4).',
  update_company_profile: 'A patch of absolute field values onto the single profile row.',
  update_account: 'A patch of absolute field values onto one account. Replay is a no-op.',
  archive_account: 'Puts one account in the archived state. Already archived stays archived.',
  unarchive_account: 'Puts one account in the active state. Already active stays active.',
  archive_cost_center: 'Puts one cost centre in the archived state. Idempotent by construction.',
  unarchive_cost_center: 'Puts one cost centre in the active state. Idempotent by construction.',
  delete_cost_center:
    'Removes one row addressed by id. A second delete finds nothing and rejects; it cannot delete twice.',
  vat_seed_defaults: 'Seeds the default codes as upserts keyed by code. Re-seeding converges.',
  vat_code_deactivate: 'Puts one tax code in the inactive state. Already inactive stays inactive.',
  vat_code_reactivate: 'Puts one tax code in the active state. Already active stays active.',
  account_set_tax_default: 'Sets one account default tax code absolutely.',
  update_contact: 'A patch of absolute field values onto one contact.',
  archive_contact: 'Puts one contact in the archived state.',
  unarchive_contact: 'Puts one contact in the active state.',
  update_item: 'A patch of absolute field values onto one item.',
  archive_item: 'Puts one item in the archived state.',
  unarchive_item: 'Puts one item in the active state.',
  set_role:
    "Sets one member's role to an absolute value. A replay re-asserts the same role and returns early without writing, so there is nothing an accumulation could accumulate (A24 section 4).",
  revoke_member:
    'Asserts the absolute state "this member has no access". A second revoke finds no row and settles to the same answer rather than rejecting, because a replay of a completed revoke must answer what the first call made true (A24 section 4).',
  enable_automation_rule:
    'Puts one rule in the enabled state. Already enabled stays enabled, and there is no second enabling a key could prevent (G01 section 5).',
  disable_automation_rule:
    'Puts one rule in the disabled state. Deliberately the cheapest call in the capability to make, because it is the stop button: a required key is one more thing between a person and halting a rule that is writing to the ledger (G01 section 4).',
  archive_automation_rule:
    'Asserts the absolute state "this rule is retired and disabled". A second archive finds it already retired and settles to the same answer (G01 section 5).',
  run_due_automations:
    'SELF-KEYED, and this is the one exemption here that is a property of the mechanism rather than of the verb. Every occurrence the tick produces derives its own event_ref from asOf, and the UNIQUE index on automation_run refuses a second run row for it, so a replayed tick cannot fire anything twice no matter what key the caller passed. An idempotencyKey would key the TICK, which is not the thing that must not repeat (G01 section 4).',
  accept_invite:
    'Binds one session actor to one invited identity, addressed by a token that is itself the key. A replay finds the invite already accepted and returns the same membership; there is no second membership a key could prevent, and the verb is pre-workspace so there is no tenant to scope a key to (A24 section 4).',
  portal_resolve:
    'Token-authenticated read-through that STAMPS last_resolved_at to an absolute now() and appends the revDSG access-trail audit row every time the token is seen (F02 section 3). It mints and moves nothing: a replay re-stamps the same instant so the grant row does not move, and the audit row it appends is the access trail, which is meant to grow per resolve. A key would guard a replay that cannot double-count, and the verb is pre-workspace so there is no tenant to scope one to.',
  update_recurring_schedule:
    'A patch of absolute field values onto one schedule row, which is config and not a ledger object. Replay re-asserts the same values (A12 section 5).',
  pause_recurring_schedule:
    'Puts one schedule in the paused state. Already paused settles to the same answer (A12 section 5).',
  resume_recurring_schedule:
    'Puts one schedule in the active state. Already active settles to the same answer (A12 section 5).',
  end_recurring_schedule:
    'Puts one schedule in the terminal ended state. Ending an ended schedule settles to the same answer rather than rejecting, because a replay of a completed end must answer what the first call made true (A12 section 5).',
  run_due_recurring:
    'SELF-KEYED, the run_due_automations exemption in mechanism: every occurrence derives its key from (schedule_id, period_key) for the create_document / issue_invoice it invokes, and the partial UNIQUE index on recurring_run_log refuses a second settle of the same period. An idempotencyKey would key the TICK, which is not the thing that must not repeat (A12 section 4).',
  approve_drafted_action:
    'Addressed by actionId, which IS the key: a second approve finds the action already executed and replays the STORED result, so there is no second execution a key on this verb could prevent. The replayed verb additionally carries its own stored idempotency key, so even a re-approve after a crash cannot double-post (A26 section 4).',
  reject_drafted_action:
    'Asserts the absolute state "this drafted action is rejected", addressed by actionId. A second reject of a rejected row settles to the same answer and an executed row refuses, so there is nothing an accumulation could accumulate (A26 section 4).',
  stock_stocktake_count:
    "Sets one stocktake line's counted_qty to an absolute value, addressed by (session, item, location). A replay re-asserts the same count and writes the same value, so there is nothing an accumulation could accumulate; the count is not a ledger object and mints nothing until commit (D01 section 2, US-D01.6).",
  retainer_run_due:
    'SELF-KEYED, the run_due_recurring exemption in mechanism (B04 section 4). Every period it bills derives its idempotency from the (retainer_id, period_key, fee) uniqueness guard, so a second tick over the same days finds each period already invoiced and generates nothing, whatever key the caller passed. An idempotencyKey would key the TICK, which is not the thing that must not repeat.',
});

/**
 * Tables the "a replay changes nothing" comparison ignores for a key-EXEMPT verb.
 *
 * A key-carrying verb replays its stored result and touches nothing at all, so it is compared
 * against the WHOLE database. A key-exempt verb genuinely re-runs, and re-running an audited write
 * stamps a second audit row. That is correct behaviour and not a defect: the audit trail is supposed
 * to record that a second request arrived. What must not change is the BUSINESS state, so those two
 * tables (and only those two) are excluded for exempt verbs.
 */
export const AUDIT_TABLES = Object.freeze(['audit_log', 'audit_head']);
