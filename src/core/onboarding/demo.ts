/**
 * G03, the demo workspace (US-G03.2): try TILL with real interactions before committing real books.
 *
 * COMPOSES, NEVER RE-IMPLEMENTS, and that is the whole design. `createDemoWorkspace` is the
 * `onboardClient` shape one register over: `createWorkspace` mints the tenant (A01's chart
 * auto-seeds), A24's `seatFirstOwner` seats the caller, A05's `configureVat` enables effektiv/Soll,
 * and then the sample content is seeded through the SAME `createContact` / `createItem` /
 * `createDocument` / `issueInvoice` verbs a real user would call. The demo behaves identically to a
 * real workspace because it IS one, schema-indistinguishable except for `kind='demo'` (G12's
 * §H-ENUM, single-sourced in `core/migration/testmandant.ts`), and G03 adds ZERO posting logic:
 * every journal effect below rides A10/A11's own poster.
 *
 * WHY THIS MODULE LIVES IN `core/onboarding/` AND NOT `core/setup/`: the discard reuses G12's
 * `hardDeleteWorkspace` mechanic, and `core/migration/` already imports `core/setup/` (its
 * Testmandant composes `createWorkspace`), so the demo pair one directory up keeps the module
 * graph acyclic.
 *
 * WHAT THE DEMO NEVER FABRICATES: an MWST number or a UID (a wrong statutory identifier is worse
 * than a missing one, the `bootstrap_workspace` rule). The creditor profile carries the sample
 * QR-IBAN that SIX publishes in the QR-bill implementation guidelines for exactly this
 * demonstration purpose, so the demo's invoices show a real QR summary; the banner names the
 * workspace as a demo on every screen.
 *
 * A DEMO NEVER PROMOTES (spec §3, OR Art. 957a: sample and real postings never mix). Enforced from
 * the other side by G12: `go_productive` refuses any workspace whose kind is not `sandbox`. The
 * only exit is `discardDemoWorkspace`, a hard delete gated on `kind='demo'` + `confirmed:true`.
 */

import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { makeContext } from '../context.js';
import type { SetupDeps } from '../setup/index.js';
import { createWorkspace, setCreditorProfile } from '../setup/index.js';
import { configureVat } from '../vat/index.js';
import { seatFirstOwner, capabilityPort } from '../access/index.js';
import { ledgerPorts } from '../ledger/index.js';
import { createContact, createItem, createDocument, issueInvoice } from '../sales/index.js';
import { hardDeleteWorkspace } from '../migration/index.js';
import { advanceOnboardingStep } from './progress.js';

export interface CreateDemoWorkspaceInput {
  /** An explicit workspace name; defaults to the shipped demo company. */
  name?: unknown;
  idempotencyKey: unknown;
}

export type CreateDemoWorkspaceOk = {
  workspaceId: string;
  seeded: { contacts: number; items: number; invoicesIssued: number; invoicesDraft: number };
};

/**
 * The sample QR-IBAN from the SIX Swiss QR-bill implementation guidelines (the published example
 * account, IID 31999 = the QR-IID sample range), used by SIX itself for specimen bills. A demo
 * needs SOME creditor account for its QR summaries to render, and the one identifier published for
 * demonstrations is the only honest choice: never a real account, never an invented one.
 */
const SIX_SAMPLE_QR_IBAN = 'CH4431999123000889012';

const DEMO_NAME = 'Demo Schreinerei Muster GmbH';

/** One demo customer: enough address for a valid QR debtor block, nothing personal. */
const DEMO_CUSTOMERS: ReadonlyArray<{
  name: string;
  street: string;
  houseNo: string;
  zip: string;
  city: string;
  email: string;
}> = [
  { name: 'Alpina Bau AG', street: 'Bahnhofstrasse', houseNo: '12', zip: '8001', city: 'Zürich', email: 'info@alpina-demo.example' },
  { name: 'Café Rütli GmbH', street: 'Marktgasse', houseNo: '7', zip: '3011', city: 'Bern', email: 'hallo@ruetli-demo.example' },
  { name: 'Studio Berger', street: 'Hirschmattstrasse', houseNo: '3', zip: '6003', city: 'Luzern', email: 'mail@berger-demo.example' },
];

// Units are D00's `ITEM_UNITS` enum members (`hour`, `flat`), never free text: the demo's items
// must survive the same validation a hand-entered one does, which is the point of the demo.
const DEMO_ITEMS: ReadonlyArray<{ name: string; priceMinor: number; unit: string }> = [
  { name: 'Beratung', priceMinor: 18000, unit: 'hour' },
  { name: 'Montage', priceMinor: 15000, unit: 'hour' },
  { name: 'Wartungspauschale', priceMinor: 45000, unit: 'flat' },
];

/**
 * Mint and seed the demo workspace, as ONE idempotent unit (§H-IDEMPOTENT: the memo lives in the
 * `_system` namespace, the `create_workspace`/`bootstrap_workspace` precedent, so a retry returns
 * the existing demo and never a second one). Validation runs BEFORE the memoized unit so a refusal
 * is never memoized beside a minted row (the `onboardClient` rule).
 */
export function createDemoWorkspace(deps: SetupDeps, input: CreateDemoWorkspaceInput): Result<CreateDemoWorkspaceOk> {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.trim().length === 0)) {
    return err('invalid_name');
  }
  const name = typeof input.name === 'string' ? input.name : DEMO_NAME;
  const key = input.idempotencyKey;

  return deps.store.rememberIdempotent('_system', key, 'create_demo_workspace', () => {
    const created = createWorkspace(deps, { name, legalForm: 'gmbh', baseCurrency: 'CHF' });
    if (!created.ok) return created;
    const workspaceId = created.workspaceId as string;

    // The ONE demo stamp: G12's kind enum plus the legacy flag, both set so every consumer
    // (`go_productive`'s refusal, the provenance leg, the shell banner) reads the same fact.
    deps.store.db.prepare("UPDATE workspace SET kind = 'demo', is_demo = 1 WHERE id = ?").run(workspaceId);

    // The REAL A03 audit port (the `onboardClient` precedent): the demo's postings and the owner
    // seating land on the chain exactly as a real workspace's would.
    const ctx = makeContext(deps.store, {
      workspaceId,
      actor: deps.actor ?? 'system',
      clock: deps.clock,
      ids: deps.ids,
      ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }),
    });

    // Seat the caller as owner FIRST (A24): the demo is theirs from birth, exactly as onboardClient
    // provisions a client book.
    seatFirstOwner(ctx);

    // A05: effektiv/Soll, registered, NO MWST number (never fabricated). Seeds the default Swiss
    // tax-code set through configureVat's own path, so demo invoices carry real VAT.
    const vat = configureVat(ctx, {
      method: 'effektiv',
      timing: 'soll',
      registered: true,
      idempotencyKey: `${key}:vat`,
    });
    if (!vat.ok) return vat;

    // A00: the demo creditor, with the SIX specimen QR-IBAN so QR summaries render (§3).
    const creditor = setCreditorProfile(ctx, {
      creditorName: name,
      address: { street: 'Werkstrasse', buildingNo: '5', zip: '8400', town: 'Winterthur', country: 'CH' },
      qrIban: SIX_SAMPLE_QR_IBAN,
    });
    if (!creditor.ok) return creditor;

    // A09: sample customers and items, through the owning verbs.
    const contactIds: string[] = [];
    for (const c of DEMO_CUSTOMERS) {
      const contact = createContact(ctx, {
        partyRole: 'customer',
        name: c.name,
        address: { street: c.street, houseNo: c.houseNo, zip: c.zip, city: c.city, country: 'CH' },
        email: c.email,
      });
      if (!contact.ok) return contact;
      contactIds.push((contact.contact as { id: string }).id);
    }
    const itemIds: string[] = [];
    for (const i of DEMO_ITEMS) {
      const item = createItem(ctx, {
        name: i.name,
        defaultUnitPriceMinor: i.priceMinor,
        unit: i.unit,
        defaultTaxCode: 'UST81',
      });
      if (!item.ok) return item;
      itemIds.push((item.item as { id: string }).id);
    }

    // A10/A11: two issued invoices and one draft, through the owning verbs. Issuing posts the
    // balanced VAT entry via A11's registered poster: the demo's journal is real by construction.
    const invoicePlans: ReadonlyArray<{ contact: number; lines: ReadonlyArray<{ item: number; qtyMilli: number }>; issue: boolean }> = [
      { contact: 0, lines: [{ item: 0, qtyMilli: 8000 }, { item: 1, qtyMilli: 12000 }], issue: true },
      { contact: 1, lines: [{ item: 2, qtyMilli: 1000 }], issue: true },
      { contact: 2, lines: [{ item: 0, qtyMilli: 4000 }], issue: false },
    ];
    let issued = 0;
    let drafts = 0;
    for (const [index, plan] of invoicePlans.entries()) {
      const doc = createDocument(ctx, {
        type: 'invoice',
        contactId: contactIds[plan.contact] as string,
        lines: plan.lines.map((l) => {
          const item = DEMO_ITEMS[l.item] as { name: string; priceMinor: number };
          return {
            itemId: itemIds[l.item] as string,
            description: item.name,
            quantityMilli: l.qtyMilli,
            unitPriceMinor: item.priceMinor,
            taxCode: 'UST81',
          };
        }),
      });
      if (!doc.ok) return doc;
      const documentId = (doc.document as { id: string }).id;
      if (plan.issue) {
        const issue = issueInvoice(ctx, { invoiceId: documentId, idempotencyKey: `${key}:issue:${index}` });
        if (!issue.ok) return issue;
        issued += 1;
      } else {
        drafts += 1;
      }
    }

    // The wizard never reopens inside the demo: its path is chosen and done.
    const progressed = advanceOnboardingStep(ctx, { path: 'demo', step: 'done', completed: true });
    if (!progressed.ok) return progressed;

    return ok<CreateDemoWorkspaceOk>({
      workspaceId,
      seeded: {
        contacts: contactIds.length,
        items: itemIds.length,
        invoicesIssued: issued,
        invoicesDraft: drafts,
      },
    });
  });
}

export interface DiscardDemoWorkspaceInput {
  workspaceId: unknown;
  confirmed: unknown;
  idempotencyKey: unknown;
}

export type DiscardDemoWorkspaceOk = {
  discardedWorkspaceId: string;
};

/**
 * Hard-delete a demo workspace and every row under it (US-G03.2). STRUCTURALLY incapable of
 * reaching real books: it refuses unless `kind='demo'` (a sandbox discards through G12's
 * `discard_testmandant`, and a live workspace's only lifecycle verb is A23's reversible
 * `archive_workspace`), and the delete itself is G12's `hardDeleteWorkspace`, which targets only
 * rows whose tenant column names the demo. `confirmed:true` gates it (Tier-3 forgiveness): the
 * operator may have typed their own experiments into it.
 *
 * A DEPS VERB THAT RESOLVES ITS OWN TENANT, and the reason is the replay contract. The shared
 * `ctxAction` boundary refuses `workspace_not_found` before the verb runs, and after a completed
 * discard the workspace IS not found: a retried delivery of the same idempotencyKey would then
 * refuse instead of replaying, which breaks §H-IDEMPOTENT on the one verb whose success removes
 * its own tenant. So this verb takes `workspaceId` in its input, replays from the `_system`
 * namespace FIRST (the memo must outlive the delete it records; the stored payload is only the id
 * of an already-deleted demo, so an early replay leaks nothing that still exists), and then
 * re-states the boundary's own order itself: tenant existence (`invalid_input` /
 * `workspace_not_found`, the exact ctx vocabulary), the A24 gate (`manage_settings` through the
 * same `capabilityPort` the boundary wires; `actionCapabilities.ts` records this verb as
 * `asserted_in_engine` for exactly this reason), then the kind fence and the confirm.
 */
export function discardDemoWorkspace(deps: SetupDeps, input: DiscardDemoWorkspaceInput): Result<DiscardDemoWorkspaceOk> {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    return err('invalid_input', { field: 'idempotencyKey' });
  }
  if (typeof input.workspaceId !== 'string' || input.workspaceId.length === 0) {
    return err('invalid_input', { field: 'workspaceId' });
  }
  const replayed = deps.store.recallIdempotent<Result<DiscardDemoWorkspaceOk>>('_system', input.idempotencyKey, 'discard_demo_workspace');
  if (replayed !== undefined) return replayed;

  const ws = deps.store.db
    .prepare('SELECT id, kind FROM workspace WHERE id = ?')
    .get(input.workspaceId) as { id: string; kind: string } | undefined;
  if (ws === undefined) return err('workspace_not_found', { workspaceId: input.workspaceId });

  // The A24 gate, engine-side (the boundary cannot run it: a deps verb resolves no tenant there).
  // M01 re-critic residual: thread `deps.identitySource` so this fifth enforcement site matches the
  // other four. Without it a served caller was resolved as LOCAL here, so `capabilityFor`'s M01 step 1
  // would have handed a served non-member the unprovisioned-workspace grant on an unclaimed demo.
  // Latent today (a demo is always seated at creation), but this site must not be the one place a
  // served subject is treated as the SQLite-file holder.
  const gate = capabilityPort(deps.store, ws.id, deps.actor ?? 'system', deps.identitySource).assert('manage_settings');
  if (!gate.ok) return gate;

  if (ws.kind !== 'demo') return err('not_a_demo_workspace', { workspaceId: ws.id, kind: ws.kind });
  if (input.confirmed !== true) return err('needs_confirmation', { workspaceId: ws.id });

  const targetId = ws.id;
  const ctx = makeContext(deps.store, {
    workspaceId: targetId,
    actor: deps.actor ?? 'system',
    clock: deps.clock,
    ids: deps.ids,
  });
  return deps.store.rememberIdempotent('_system', input.idempotencyKey, 'discard_demo_workspace', () => {
    hardDeleteWorkspace(ctx, targetId);
    return ok<DiscardDemoWorkspaceOk>({ discardedWorkspaceId: targetId });
  });
}
