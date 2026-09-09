/**
 * Phase E, the shared action registry: parity by construction.
 *
 * Every agent-facing verb is exposed exactly ONCE here, as an `ActionDef`. The MCP stdio server
 * (`mcp.ts`) and the REST twins (`rest.ts`) are two thin adapters over this SAME array: each looks up
 * an action by name and calls `action.run`, so the two faces cannot drift. Adding a verb is a single
 * append here; both surfaces pick it up for free.
 *
 * `run` is the one place a verb is invoked. It maps a camelCase input object straight through to the
 * engine verb, building the `WorkspaceContext` with the REAL A03 ledger ports (so a post stamps the
 * hash-chained audit log and honours period locks) for ctx-based verbs, or calling the deps-based
 * setup verbs (`create_workspace`, `bootstrap_workspace`) with `{ store, clock, ids, actor }` directly.
 */

import type { OkFields, Result } from '../core/result.js';
import { err } from '../core/result.js';
import type { SqliteStore } from '../core/store/sqlite-store.js';
import { isBusyError } from '../core/store/sqlite-store.js';
import type { Clock } from '../core/clock.js';
import type { IdGen } from '../core/ids.js';
import type {
  WorkspaceContext,
  EmailRelayPort,
  SignTransmitterPort,
  EbillTransmitterPort,
  EbicsTransportPort,
  EbicsKeystorePort,
  ManagedChannelPort,
} from '../core/context.js';
import type { DiagnosticsPort } from '../core/ports.js';
import { makeContext } from '../core/context.js';

import {
  ledgerPorts,
  postEntry,
  reverseEntry,
  saveDraft,
  deleteDraft,
  getEntry,
  listJournal,
  softCloseMonth,
  reopenMonth,
  hardCloseYear,
  lockPeriod,
  unlockPeriod,
  getAuditLog,
  listPeriodLocks,
} from '../core/ledger/index.js';
import {
  createWorkspace,
  bootstrapWorkspace,
  setFiscalConfig,
  setVatMethod,
  setCreditorProfile,
  getCompanyProfile,
  updateCompanyProfile,
} from '../core/setup/index.js';
import {
  createAccount,
  updateAccount,
  archiveAccount,
  unarchiveAccount,
  deleteAccount,
  listAccounts,
  createCostCenter,
  archiveCostCenter,
  unarchiveCostCenter,
  deleteCostCenter,
  listCostCenters,
} from '../core/accounts/index.js';
import {
  seedTaxCodes,
  configureVat,
  getVatConfig,
  listSaldoGenerations,
  setSaldoDeclarationBasis,
  listTaxCodes,
  upsertTaxCode,
  deactivateTaxCode,
  reactivateTaxCode,
  setAccountTaxDefault,
  computeLineTax,
  computeVatReturn,
  exportVatReturnEch0217,
  listVatPeriods,
  markVatPeriodFiled,
  saldoEligibility,
} from '../core/vat/index.js';
import { fxActions } from './fx-actions.js';
import { paymentActions } from './payment-actions.js';
import { debtorActions } from './debtor-actions.js';
import { bankActions } from './bank-actions.js';
import { reportActions } from './report-actions.js';
import { openingActions } from './opening-actions.js';
import { supportActions } from './support-actions.js';
import { migrationMapActions } from './migration-map-actions.js';
import { migrationActions } from './migration-actions.js';
// G11 Eröffnungsprüfung
import { migrationCheckActions } from './migration-check-actions.js';
import { migrationOpenItemsActions } from './migration-open-items-actions.js';
// G12 Testmandant
import { migrationTestmandantActions } from './migration-testmandant-actions.js';
// G03 onboarding & demo workspace
import { onboardingActions } from './onboarding-actions.js';
// G13 GL archive
import { glArchiveActions } from './gl-archive-actions.js';
// G19 extraction companion (guides + export-completeness manifest)
import { migrationExtractionActions } from './migration-extraction-actions.js';
import { migrationProjectActions } from './migration-project-actions.js';
// G22 checklists (D127): the MWST-Periode checklist and its siblings.
import { checklistActions } from './checklist-actions.js';
import { permissionActions } from './permission-actions.js';
import { customizationActions } from './customization-actions.js';
import { documentTemplateActions } from './document-template-actions.js';
import { dispatchActions } from './dispatch-actions.js';
import { automationActions } from './automation-actions.js';
import { contactActions } from './contact-actions.js';
import { taskActions } from './task-actions.js';
import { notificationActions } from './notification-actions.js';
import { pluginActions } from './plugin-actions.js';
import {
  registerMoneyPathTools,
  registerCoreToolNames,
} from '../core/plugins/index.js';
import { dealActions } from './deal-actions.js';
import { quoteActions } from './quote-actions.js';
import { forecastActions } from './forecast-actions.js';
import { searchActions } from './search-actions.js';
import { fileActions } from './file-actions.js';
import { signActions } from './sign-actions.js';
import { portalActions } from './portal-actions.js';
import { vendorPortalActions } from './vendor-portal-actions.js';
import { itemActions } from './item-actions.js';
import { assetActions } from './asset-actions.js';
import { maintenanceActions } from './maintenance-actions.js';
import { assetReportsActions } from './asset-reports-actions.js';
import { requisitionActions } from './requisition-actions.js';
import { inventoryActions } from './inventory-actions.js';
import { trackingActions } from './tracking-actions.js';
import { movementActions } from './movement-actions.js';
import { stocktakeActions } from './stocktake-actions.js';
import { inventoryAdjustActions } from './inventory-adjust-actions.js';
// I02 goods receipt
import { receiptActions } from './receipt-actions.js';
import { valuationActions } from './valuation-actions.js';
import { valuationRunActions } from './valuation-run-actions.js';
import { landedCostActions } from './landed-cost-actions.js';
import { threeWayMatchActions } from './three-way-match-actions.js';
import { supplierPerformanceActions } from './supplier-performance-actions.js';
import { procurementAnalyticsActions } from './procurement-analytics-actions.js';
import { inventoryAgentActions } from './inventory-agent-actions.js';
import { projectActions } from './project-actions.js';
import { timeActions } from './time-actions.js';
import { billingActions } from './billing-actions.js';
import { retainerActions } from './retainer-actions.js';
import { costingActions } from './costing-actions.js';
import { dashboardActions } from './dashboard-actions.js';
import { attentionActions } from './attention-actions.js';
import { guidanceActions } from './guidance-actions.js';
import { deliveryActions } from './delivery-actions.js';
import { syncActions } from './sync-actions.js';
import { moveActions } from './move-actions.js';
import { envActions } from './env-actions.js';
import { reportBuilderActions } from './report-builder-actions.js';
import { stockActions } from './stock-actions.js';
import { salesOrderActions } from './sales-order-actions.js';
import { purchaseOrderActions } from './purchase-order-actions.js';
import { poAmendmentActions } from './po-amendment-actions.js';
import { purchaseActions } from './purchase-actions.js';
import { captureActions } from './capture-actions.js';
import { payrollActions } from './payroll-actions.js';
import { ebillActions } from './ebill-actions.js';
import { ebicsActions } from './ebics-actions.js';
import { hrActions } from './hr-actions.js';
import { mailActions } from './mail-actions.js';
import { voiceActions } from './voice-actions.js';
import { draftActions } from './draft-actions.js';
import { egressActions } from './egress-actions.js';
import { dunningActions } from './dunning-actions.js';
import { recurringActions } from './recurring-actions.js';
import { qrMatchActions } from './qr-match-actions.js';
import { camtActions } from './camt-actions.js';
import { pain001Actions } from './pain001-actions.js';
import { workspaceActions } from './workspace-actions.js';
import { reviewActions } from './review-actions.js';
import { agentActions } from './agent-actions.js';
import { agentOversightActions } from './agent-oversight-actions.js';
import { CONSEQUENCE_FOR_ACTION } from '../core/agent/index.js';
import { dataActions } from './data-actions.js';
import type { CatalogAction } from '../core/data/index.js';
import { assertEveryActionIsGated, capabilityPort, requiredCapabilitiesFor } from '../core/access/index.js';
import {
  dispatchAutomationEvent,
  eventsEmittedBy,
  registerWriteActions,
} from '../core/automation/index.js';
import type { ActionInvoker } from '../core/automation/index.js';
import {
  createContact,
  updateContact,
  archiveContact,
  unarchiveContact,
  getContact,
  listContacts,
  createItem,
  updateItem,
  archiveItem,
  unarchiveItem,
  getItem,
  listItems,
  createDocument,
  updateDocument,
  transitionDocument,
  convertDocument,
  getDocument,
  listDocuments,
  issueInvoice,
  sendInvoice,
  buildQrBill,
  renderInvoicePdf,
  createCreditNote,
  issueCreditNote,
  renderCreditNotePdf,
} from '../core/sales/index.js';

/** What a single request is handed: the store and seams, plus the actor to stamp. Per-request. */
export interface ApiDeps {
  store: SqliteStore;
  clock: Clock;
  ids: IdGen;
  actor: string;
  /**
   * M01: the proxy-attested subject in served mode, absent locally. Set per request by the transport
   * (see `served-mode.ts`), threaded onto `WorkspaceContext` so `whoami` can name it. Never consulted
   * for authorization: the `actor` is what A24 gates on.
   */
  subject?: string | undefined;
  /** M01: how identity was established (`local_client` by default, `served_subject` in served mode). */
  identitySource?: import('../core/access/index.js').IdentitySource | undefined;
  /**
   * The outbound email transport, when the HOST wired one. Absent means there is no transport, and
   * `send_invoice` then degrades honestly rather than claiming a send: there is no transport in the
   * MIT core by design, and a configured `workspace.email_relay` mode alone can never mean "sent".
   *
   * This is the seam a host fills. `EmailRelayPort` lives on `WorkspaceContext` and `makeContext`
   * carries it through, but `ApiDeps` is what MCP, the REST twins and the Studio bridge all hand to
   * `action.run`, so without it here the port was unreachable from every shipped surface.
   */
  emailRelay?: EmailRelayPort | undefined;
  /** The E01 e-sign transmitter (OP4), when the host wired one. Absent in the MIT core. */
  signTransmitter?: SignTransmitterPort | undefined;
  /** A32's eBill connector (OP4), when the host wired one. Absent in the MIT core: transmit degrades to cloud_tier. */
  ebillTransmitter?: EbillTransmitterPort | undefined;
  /** A33's EBICS transport (OP4), when the host wired one. Absent means the channel's network steps degrade honestly. */
  ebicsTransport?: EbicsTransportPort | undefined;
  /** A33's key custody seam. Absent means the core's in-process `defaultEbicsKeystore`. */
  ebicsKeystore?: EbicsKeystorePort | undefined;
  /** A37's managed connectivity relay (OP4, owner-gated). Absent means the cloud tier is off: managed actions degrade to cloud_tier. */
  managedChannel?: ManagedChannelPort | undefined;
  /**
   * G08's seam. Absent means nothing is recorded, which is the correct default for an embedder that
   * wired no host: the core notices a defect, it does not decide whether to write one down.
   */
  diagnostics?: DiagnosticsPort | undefined;
  /** G08: the `~/.till/` directory, injected so tests never touch the developer's home. */
  supportDir?: string | undefined;
  /** G04: the backup-bundle directory, injected so tests never write into the developer's home. */
  backupDir?: string | undefined;
  /**
   * A35: the stable per-connection key of an MCP session, minted by the transport (one connection is
   * one session). Absent for connectionless callers (the REST twins): the recorder's idle-gap rule
   * applies. Never client-supplied: a client that could pick its session could hide a call.
   */
  agentTransportKey?: string | undefined;
  /** A35: the client name captured at `initialize`, rendered as the session's provenance line. */
  agentClientLabel?: string | undefined;
}

/** A tool input, decoded from JSON. camelCase keys map straight through to the engine verb. */
export type ActionInput = Record<string, unknown>;

/** A minimal JSON Schema for a tool's input (field names + types; the workspace id where required). */
export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
}

/**
 * One agent-facing verb, as both faces see it.
 *
 * WHY THIS IS GENERIC, AND WHY THE DEFAULTS MATTER MORE THAN THE PARAMETERS.
 *
 * `run` used to be typed `(deps, input) => Result`, the OPEN `Result`. `src/core/result.ts` made the
 * success payload declarable (`Result<PostEntryOk>`) and `postEntry` declared one, but this line then
 * threw it away: the dispatcher BOTH surfaces go through erased every declared payload on its way to
 * the wire, so nothing downstream of here could state what a tool answers with. That is the last
 * type-level link in this repo's longest-running defect family, "the Studio assumed a shape the
 * engine never sends".
 *
 * `N` and `T` both DEFAULT to what was written here before (`string`, `OkFields`), so a bare
 * `ActionDef` means exactly what it always meant: every one of the five action-group modules, both
 * adapters, `ACTIONS` itself and every suite compile unchanged. Declaring a payload stays a per-verb
 * decision, made one verb at a time, and an undeclared verb pays nothing.
 *
 * `N` carries the snake_case tool NAME as a literal, which is the half `app/src/lib/payloads.ts`
 * could not derive: the Studio had to hand-write `post_entry: PayloadOf<typeof postEntry>` because
 * nothing at the dispatcher tied that wire name to that payload. With the name on the type, the
 * binding is read off the definition instead of restated beside it.
 *
 * An INTERFACE is safe here, unlike `Ok` in `src/core/result.ts`, and the difference is worth
 * stating because it looks like the same trap. There, the payload type had to be a type ALIAS: an
 * interface is denied the implicit index signature, so `Ok<PostEntryOk>` would have stopped being
 * assignable to the open `Ok` the other verbs return. That constraint is on `T` (a type ALIAS is
 * still what a payload must be declared as), not on the container: nothing requires `ActionDef` to
 * satisfy `Record<string, unknown>`, and `ActionDef<'post_entry', PostEntryOk>` is assignable to
 * `ActionDef` through ordinary property and return-type covariance. `test/api/wire-payload-binding.test.mjs`
 * proves that assignability rather than assuming it.
 */
export interface ActionDef<N extends string = string, T extends OkFields = OkFields> {
  /** snake_case tool name, e.g. `post_entry`. Stable: this IS the §H-ENUM tool identity. */
  name: N;
  /** `read` tools carry `readOnlyHint` on MCP; `write` tools do not. */
  kind: 'read' | 'write';
  /** One-line human description surfaced as the MCP tool description. */
  summary: string;
  /**
   * A35/G16: the consequence sentence beside `summary` on money-path writes: what the write
   * IRREVERSIBLY does, for a human deciding whether to run or approve it. One field, three
   * consumers (the palette's review step, the Vorschlag card, an MCP client's confirmation prose).
   * Populated from `CONSEQUENCE_FOR_ACTION` after `ACTIONS` is built; absent on everything else.
   */
  consequence?: string;
  /** The tool's input schema. */
  inputSchema: JsonSchema;
  /** The SINGLE invocation of the underlying verb. Both MCP and REST call exactly this. */
  run(deps: ApiDeps, input: ActionInput): Result<T>;
}

/**
 * Build a wired `WorkspaceContext` for a ctx-based verb: real A03 period + audit ports, and, since
 * A24, the real capability port.
 *
 * THE CAPABILITY PORT USED TO BE MISSING HERE, and its absence was invisible by construction.
 * `makeContext` falls back to `allowAllCapabilities` (`core/ports.ts`), so the twelve
 * `ctx.capabilities.assert(...)` call sites that A02, A03 and A14 have carried since Wave 0 all
 * returned ok, on every call, in every build that ever shipped. Nothing was broken and nothing was
 * enforced: the call sites existed exactly so there would be no bypass to retrofit, and the
 * retrofit is this line.
 */
function ctxOf(deps: ApiDeps, input: ActionInput): WorkspaceContext {
  const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId : '';
  return makeContext(deps.store, {
    workspaceId,
    actor: deps.actor,
    clock: deps.clock,
    ids: deps.ids,
    capabilities: capabilityPort(deps.store, workspaceId, deps.actor, deps.identitySource),
    // M01: carried through only when served mode set them, so a local ctx stays absent (not an explicit
    // undefined) under exactOptionalPropertyTypes.
    ...(deps.subject !== undefined ? { subject: deps.subject } : {}),
    ...(deps.identitySource !== undefined ? { identitySource: deps.identitySource } : {}),
    ...ledgerPorts({ store: deps.store, workspaceId, ids: deps.ids }),
    // Spread only when the host wired one: under `exactOptionalPropertyTypes` an explicit
    // `undefined` is not the same as absent, and "absent" is what the honest degradation reads.
    ...(deps.emailRelay !== undefined ? { emailRelay: deps.emailRelay } : {}),
    ...(deps.signTransmitter !== undefined ? { signTransmitter: deps.signTransmitter } : {}),
    ...(deps.ebillTransmitter !== undefined ? { ebillTransmitter: deps.ebillTransmitter } : {}),
    ...(deps.ebicsTransport !== undefined ? { ebicsTransport: deps.ebicsTransport } : {}),
    ...(deps.ebicsKeystore !== undefined ? { ebicsKeystore: deps.ebicsKeystore } : {}),
    ...(deps.managedChannel !== undefined ? { managedChannel: deps.managedChannel } : {}),
  });
}

// A cast that documents intent: the JSON input object is handed to the verb as its typed input. The
// engine verbs read the fields they need and ignore the rest (workspaceId included), so passing the
// whole object through is safe and is what keeps the mapping a straight camelCase pass-through.
function as<T>(input: ActionInput): T {
  return input as unknown as T;
}

/**
 * Convert any thrown exception into a structured Result. A verb should always RETURN its rejection
 * (P9, result.ts), but a type-invalid input the schema did not catch (a null id, an object where a
 * string was expected, a missing tenant) can still throw inside the engine or the SQLite driver. If
 * that escaped, it would be a 500 on REST and a JSON-RPC protocol error on MCP: the ONE way the two
 * faces could diverge. Catching it HERE, in the shared dispatch both adapters call, keeps every input
 * mapping to a Result and keeps the faces identical.
 */
function guarded<T extends OkFields>(name: string, run: () => Result<T>, deps?: ApiDeps): Result<T> {
  try {
    return run();
  } catch (e) {
    // Lock contention is NOT an unexpected error, and flattening it into one loses the only fact the
    // caller can act on. D12 put a second writer on the file (the Studio and an agent subprocess hold
    // the same SQLite database), so a write can legitimately lose a race after waiting out its busy
    // timeout. `store_busy` says "nothing is broken, try again in a moment"; `unexpected_error` says
    // "something is broken, stop". A Studio must be able to tell those apart before it decides
    // whether to retry a post.
    deps?.diagnostics?.record({
      kind: 'verb_error',
      at: new Date().toISOString(),
      code: isBusyError(e) ? 'store_busy' : 'unexpected_error',
      action: name,
      error: e,
    });
    if (isBusyError(e)) {
      return err('store_busy', {
        action: name,
        retryable: true,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    return err('unexpected_error', { action: name, message: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Boundary type validation. The MCP specification puts "validate all tool inputs" on the SERVER, and
 * an `inputSchema` a client never has to honour is a suggestion, not a check: an MCP caller is free
 * to send `{ itemId: [] }` for a field the schema declares as a string.
 *
 * Without this, such a value travelled all the way into the SQLite driver, which threw
 * `Too few parameter values were provided`. The throw guard turned that into `unexpected_error` with
 * the driver's own message attached, which is wrong twice over: the input was invalid (the caller's
 * fault, a stable code they can act on), not an internal failure, and the response leaked an engine
 * internal to an untrusted client. The conformance gate found this on eight verbs.
 *
 * The check is deliberately narrow. `undefined` and `null` mean ABSENT and pass straight through, so
 * the verb's own required-field and domain rules keep owning that answer and no existing rejection
 * code changes. Only a value that is PRESENT and of the wrong declared primitive type is rejected,
 * with `invalid_input` naming the field. Living in the shared registry, it covers both faces and
 * every future verb for free.
 */
export function actionInputTypeMismatch(schema: JsonSchema, input: ActionInput): string | undefined {
  return typeMismatch(schema, input);
}

function typeMismatch(schema: JsonSchema, input: ActionInput): string | undefined {
  for (const [field, spec] of Object.entries(schema.properties)) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    const declared = (spec as { type?: unknown }).type;
    const bad =
      (declared === 'string' && typeof value !== 'string') ||
      (declared === 'boolean' && typeof value !== 'boolean') ||
      (declared === 'integer' && !Number.isInteger(value)) ||
      (declared === 'array' && !Array.isArray(value)) ||
      (declared === 'object' && (typeof value !== 'object' || Array.isArray(value)));
    if (bad) return field;
  }
  return undefined;
}

/**
 * A24's PRIMARY enforcement point, and the reason it is here rather than in sixty-two verbs.
 *
 * An agent has exactly two doors into this engine, MCP stdio (`mcp.ts`) and the REST twins
 * (`rest.ts`), and both resolve an `ActionDef` out of `ACTIONS` and call `action.run`. There is no
 * third. So a check placed in this shared dispatch cannot be routed around by choosing a different
 * face, and it covers every verb at once, including the fifty whose engine code has never contained
 * a capability check and every verb a later capability appends.
 *
 * It runs AFTER the tenant checks and BEFORE the verb, which is the only correct order: a denial on
 * a workspace that does not exist would leak whether it exists, and a denial after the verb would
 * be a denial after the write.
 *
 * The rule comes from `CAPABILITY_FOR_ACTION` (`core/access/actionCapabilities.ts`), where every
 * verb, read and write, declares a capability or an explicit `ungated(reason)`, and where a verb
 * that declares neither makes this module fail to load at all (see the check under `ACTIONS`).
 */
function assertActionCapability(
  name: string,
  deps: ApiDeps,
  input: ActionInput,
  workspaceId: string,
): Result | undefined {
  // READS PASS THROUGH HERE TOO, as of D50. This function used to open with
  // `if (kind !== 'write') return undefined`, which left forty-nine read verbs ungated: a non-member
  // of a provisioned workspace could list the journal, read the audit trail and export the whole
  // ledger to CSV. There is no `kind` parameter any more, because the branch that used it was the
  // defect and a parameter nobody reads is an invitation to reinstate it.
  //
  // ALL OF, in declaration order, so the rejection names the FIRST capability the actor lacks and
  // two roles missing two different halves of the same rule are told two different things.
  const port = capabilityPort(deps.store, workspaceId, deps.actor, deps.identitySource);
  for (const capability of requiredCapabilitiesFor(name, input)) {
    const allowed = port.assert(capability);
    if (!allowed.ok) return allowed;
  }
  return undefined;
}

/**
 * A ctx-based action: validates the tenant, checks the capability, then builds the context and calls
 * the verb, all inside the throw guard. A missing/blank `workspaceId` is `invalid_input`; a
 * well-formed but nonexistent one is `workspace_not_found` (never a silent `ok` on a typo'd tenant,
 * and never the `''`-tenant FK crash).
 */
function ctxAction<N extends string, T extends OkFields = OkFields>(
  name: N,
  kind: 'read' | 'write',
  summary: string,
  inputSchema: JsonSchema,
  // The THIRD parameter exists for G01 and is ignored by every other call site. A verb that FIRES
  // another verb needs an `ActionInvoker`, and an invoker can only be built from `deps`. Widening
  // this callback by one optional argument was the smallest way to give two verbs what they need
  // without putting an api concern on `WorkspaceContext`, where seventy-six unrelated verbs would
  // then carry it. TypeScript lets a narrower function satisfy a wider signature, so nothing else
  // in this file, or in any of the six action-group modules, changed.
  call: (ctx: WorkspaceContext, input: ActionInput, deps: ApiDeps) => Result<T>,
): ActionDef<N, T> {
  return {
    name,
    kind,
    summary,
    inputSchema,
    run: (deps, input) =>
      guarded(name, () => {
        const mismatch = typeMismatch(inputSchema, input);
        if (mismatch !== undefined) return err('invalid_input', { field: mismatch });
        const workspaceId = input.workspaceId;
        if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
          return err('invalid_input', { field: 'workspaceId' });
        }
        const exists = deps.store.db
          .prepare('SELECT archived FROM workspace WHERE id = ?')
          .get(workspaceId) as { archived: number } | undefined;
        if (exists === undefined) return err('workspace_not_found', { workspaceId });
        // The `as Result<T>` is the same widening every rejection path here performs: an `Err` is a
        // `Result<T>` for every T, and this branch only ever returns one.
        const denied = assertActionCapability(name, deps, input, workspaceId);
        if (denied !== undefined) return denied as Result<T>;
        // A23: an ARCHIVED workspace is read-only (a retired mandate's books stay intact and
        // exportable, OR 958f, but nothing may move in them). Enforced HERE, at the one boundary
        // every write funnels through (humans, agents, and G01 firings alike), so a verb registered
        // next year is read-only-in-archive with no edit anywhere. `archive_workspace` itself is the
        // one exception, because unarchiving IS a write into an archived workspace. AFTER the A24
        // gate, so a non-member is told `permission_denied` and never learns a book's archive state.
        if (kind === 'write' && name !== 'archive_workspace' && exists.archived === 1) {
          return err('workspace_archived', { workspaceId });
        }
        const outcome = call(ctxOf(deps, input), input, deps);
        if (kind === 'write' && outcome.ok) emitAutomationEvents(deps, name, input, outcome);
        return outcome;
      }, deps),
  };
}

/**
 * G01's BUILD-ONCE hook: one place, after any write verb has committed, covering every verb at once.
 *
 * WHY HERE AND NOT IN THE EMITTING VERBS. G01's spec had all 44 emitting verbs call the dispatcher
 * themselves. That is 44 edits across nine capability modules, 44 chances to forget one, and no
 * mechanism at all for noticing the 45th when it lands next week. It is the same argument
 * `actionCapabilities.ts` makes about A24's gate, and it buys the same three things.
 *
 * IT ALSO RUNS AFTER THE COMMIT RATHER THAN INSIDE IT, which the in-verb design could not do. A rule
 * firing inside `issueInvoice`'s transaction can roll back the invoice that triggered it, and an
 * automation must never be able to unwind the business event it is reacting to.
 *
 * A FAILURE HERE NEVER CHANGES THE VERB'S RESULT. The throw is recorded through G08's diagnostics
 * port and swallowed: an automation defect must not be able to turn a good post into a failed one.
 * Nothing is logged when no rule matches, which is the overwhelmingly common case.
 */
function emitAutomationEvents(
  deps: ApiDeps,
  name: string,
  input: ActionInput,
  outcome: OkFields,
): void {
  if (eventsEmittedBy(name).length === 0) return;
  try {
    dispatchAutomationEvent(ctxOf(deps, input), invokerFor(deps), name, input, outcome);
  } catch (e) {
    deps.diagnostics?.record({
      kind: 'verb_error',
      at: new Date().toISOString(),
      code: 'automation_dispatch_failed',
      action: name,
      error: e,
    });
  }
}

/**
 * How G01 reaches the shared dispatch, and the reason its P3 guarantee is structural.
 *
 * A fired action goes through the SAME `action.run` the MCP stdio server and the REST twins call, so
 * it gets the tenant check, the boundary type check, the A24 capability gate and the throw guard for
 * free, because they are literally the same code. There is no second write path to audit.
 *
 * `asActor` OVERRIDES `deps.actor`, and that one line is the whole permission model: the firing runs
 * as the rule's author, so `assertActionCapability` resolves the target verb's capability against
 * THEM, live, on every firing. An author who is later revoked or demoted starts failing
 * `permission_denied` with nothing to invalidate and no cache to go stale. There is deliberately no
 * automation identity: one would need capabilities of its own, and granting them would be a hole
 * through the permission system that 74 specs depend on.
 */
function invokerFor(deps: ApiDeps): ActionInvoker {
  return (tool, actionInput, asActor) => {
    const action = getAction(tool);
    if (action === undefined) return err('unknown_action_tool', { tool });
    // Belt and braces: `createAutomationRule` already refused a read verb at save time, but a rule
    // stored before a verb changed kind would otherwise reach a read through the write path.
    if (action.kind !== 'write') return err('action_not_writable', { tool });
    return action.run({ ...deps, actor: asActor }, actionInput);
  };
}

/** A deps-based action (pre-workspace setup): `run` calls the verb with the raw deps, throw-guarded. */
function depsAction<N extends string, T extends OkFields = OkFields>(
  name: N,
  kind: 'read' | 'write',
  summary: string,
  inputSchema: JsonSchema,
  call: (deps: ApiDeps, input: ActionInput) => Result<T>,
): ActionDef<N, T> {
  return {
    name,
    kind,
    summary,
    inputSchema,
    run: (deps, input) =>
      guarded(name, () => {
        const mismatch = typeMismatch(inputSchema, input);
        if (mismatch !== undefined) return err('invalid_input', { field: mismatch });
        return call(deps, input);
      }, deps),
  };
}

// --- Schema fragments (kept minimal: field names and types) -----------------------------------

const STR = { type: 'string' } as const;
const INT = { type: 'integer' } as const;
const BOOL = { type: 'boolean' } as const;

/** A ctx-tool schema: `workspaceId` is always required, plus the verb's own fields. */
function ctxSchema(props: Record<string, unknown> = {}, required: string[] = []): JsonSchema {
  return {
    type: 'object',
    properties: { workspaceId: STR, ...props },
    required: ['workspaceId', ...required],
    additionalProperties: true,
  };
}

/** A deps-tool schema (no workspaceId in input: the verb mints or is pre-workspace). */
function depsSchema(props: Record<string, unknown>, required: string[]): JsonSchema {
  return { type: 'object', properties: props, required, additionalProperties: true };
}

const LINES = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      account: STR,
      debit: INT,
      credit: INT,
      costCenter: STR,
      taxCode: STR,
      taxBase: INT,
      taxAmount: INT,
      // A06 threads the Leistungsdatum (supply date) per line; values already pass through, and the
      // schema lists it so an agent can discover the field (a straddle leg is priced at its supply
      // date's rate, A06 §3/F2).
      supplyDate: STR,
    },
    required: ['account'],
  },
} as const;

/**
 * A10 document positions: the shared line shape create_document / update_document accept. `quantityMilli`
 * is thousandths (10.5 units -> 10500), integer, never a float; `unitPriceMinor` is Rappen (P2).
 */
const DOC_LINES = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      itemId: STR,
      description: STR,
      quantityMilli: INT,
      unitPriceMinor: INT,
      taxCode: STR,
      supplyDate: STR,
    },
    required: ['unitPriceMinor'],
  },
} as const;

/**
 * A13 partial-credit selection: which invoice positions to credit, quantity at most the original.
 * NOT the DOC_LINES shape: a credit note's lines are DERIVED (§4b.1), so the input names positions,
 * never prices.
 */
const CREDIT_NOTE_LINES = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      position: INT,
      quantityMilli: INT,
    },
    required: ['position'],
  },
} as const;

/** The draft-only patch update_document accepts (a posted document is immutable, §H-AUDIT). */
const DOC_PATCH = {
  type: 'object',
  properties: { contactId: STR, lines: DOC_LINES, currency: STR, dueDate: STR, notes: STR },
} as const;

const CREDITOR_ADDRESS = {
  type: 'object',
  properties: { street: STR, buildingNo: STR, zip: STR, town: STR, country: STR },
  required: ['street', 'buildingNo', 'zip', 'town', 'country'],
} as const;

const CONTACT_ADDRESS = {
  type: 'object',
  properties: { street: STR, houseNo: STR, zip: STR, city: STR, country: STR },
} as const;

const CONTACT_FIELDS = {
  partyRole: STR,
  name: STR,
  address: CONTACT_ADDRESS,
  vatNumber: STR,
  email: STR,
  defaultCurrency: STR,
  paymentTermsDays: INT,
} as const;

const ITEM_FIELDS = {
  name: STR,
  defaultUnitPriceMinor: INT,
  currency: STR,
  defaultTaxCode: STR,
  revenueAccountId: STR,
  unit: STR,
} as const;

/**
 * The business sources a caller may post through `post_entry`. The internal `reversal` and `close`
 * sources (data model §D0) are DELIBERATELY absent: reversal is the `reverse_entry` tool and year-end
 * sealing is `close_year`. Keeping them off the agent-facing post boundary is a money-path guardrail
 * (see the guard in `post_entry.run` below and postEntry's own note).
 *
 * A22 narrows `fx` off this list for the same reason `purchase`/`dunning`/`credit_note`/`camt` are
 * absent: an FX revaluation entry is written ONLY by `post_fx_revaluation`, which pairs it with the
 * next-period reversal and the `fx_revaluation` run row (§7 tripwire 3). A caller who could post
 * `source='fx'` through `post_entry` could forge a revaluation entry with no run behind it and no
 * auto-reversal, so the source stays engine-only.
 */
export const POST_ENTRY_SOURCES: readonly string[] = ['manual', 'invoice', 'payment', 'import', 'agent'];
const POST_ENTRY_SOURCE_SET = new Set(POST_ENTRY_SOURCES);

/**
 * A14's settlement verbs, built ONCE here so G02 can single-source the reserved money-path tool NAMES
 * (P3) from the registry's OWN A14 write set rather than a hand-copied literal. This is a throwaway
 * sibling of the live objects `ACTIONS` spreads inline below: same verbs, same names, so filtering it
 * to the write names is identical to filtering the live ones, while the inline call in `ACTIONS` stays
 * the form the orientation/contract source parsers understand. Handed to the plugin engine at load
 * (see `registerMoneyPathTools` under the list).
 */
const a14PaymentActions = paymentActions({ ctxAction, ctxSchema, STR, INT });

// --- The declared actions ----------------------------------------------------------------------

/**
 * `post_entry`, the pilot, defined HERE as a named const and merely referenced from the list below.
 *
 * WHY IT IS NOT INLINE LIKE THE OTHER 107. Its type has to survive, and inside the array literal it
 * does not. TypeScript applies SUBTYPE REDUCTION when it infers an array literal's element type, and
 * the list spreads in five action groups (`fxActions`, `paymentActions`, `debtorActions`,
 * `bankActions`, `reportActions`) that are each declared `ActionDef[]`, the open one. Every declared
 * entry is a SUBTYPE of that, so the union collapses and the whole list infers as plain `ActionDef`.
 * Measured, not assumed: with the spreads present the derivation below produced a map with zero keys;
 * with them removed it produced `ActionDef<'post_entry', PostEntryOk>`. Naming the const is what keeps
 * the array's own annotation (`readonly ActionDef[]`, unchanged) from being the thing that erases it.
 *
 * The definition itself is byte-for-byte what stood in the list, guardrail and all. Nothing about the
 * behaviour of this action moved; only where the value is bound.
 */
const postEntryAction = ctxAction(
  'post_entry',
  'write',
  'Post a balanced double-entry journal entry (business sources only; reversal/close are separate tools).',
  ctxSchema(
    { entryId: STR, date: STR, ref: STR, description: STR, lines: LINES, source: STR, idempotencyKey: STR },
    ['date', 'lines', 'source', 'idempotencyKey'],
  ),
  // Money-path guardrail: the agent post boundary carries only the business sources, and never a
  // reversal slot. `source='reversal'`/`'close'` and any `reversesEntryId` are rejected HERE, before
  // the verb, so neither MCP nor REST can occupy a reversal slot or forge a sealing entry.
  (ctx, input) => {
    if (input.reversesEntryId !== undefined) {
      return err('forbidden_field', {
        field: 'reversesEntryId',
        reason: 'reversal is the reverse_entry tool, not post_entry',
      });
    }
    const source = input.source;
    if (typeof source !== 'string' || !POST_ENTRY_SOURCE_SET.has(source)) {
      return err('invalid_source', { source, allowed: [...POST_ENTRY_SOURCES] });
    }
    return postEntry(ctx, as(input));
  },
);

/**
 * The rest of the A02 front door, hoisted for the same reason `postEntryAction` is: a declared
 * payload does not survive the action list's element inference.
 *
 * These are byte-for-byte the definitions that stood inline in `ACTIONS`, moved and not edited.
 * `delete_draft` is deliberately NOT here: `deleteDraft` answers `ok()` with no fields, and an empty
 * payload cannot be pinned by `PinnedAction` below (`OkFields extends {}` is true, so the filter
 * reads it as the open default and drops it). Declaring it would raise the census while leaving the
 * wire map unchanged, which is the kind of half-landing this whole chain exists to stop.
 */
const reverseEntryAction = ctxAction(
  'reverse_entry',
  'write',
  'Reverse a posted entry by posting its faithful mirror (OR 957a).',
  ctxSchema({ entryId: STR, date: STR, description: STR, idempotencyKey: STR }, ['entryId', 'idempotencyKey']),
  (ctx, input) => reverseEntry(ctx, as(input)),
);

const saveDraftAction = ctxAction(
  'save_draft',
  'write',
  'Create or update a draft journal entry (no money effect until posted).',
  ctxSchema(
    { entryId: STR, date: STR, ref: STR, description: STR, lines: LINES, idempotencyKey: STR },
    ['date', 'lines', 'idempotencyKey'],
  ),
  (ctx, input) => saveDraft(ctx, as(input)),
);

const getEntryAction = ctxAction(
  'get_entry',
  'read',
  // Both money pairs are named, because both are sent. A caller handed `baseDebit` as a bare
  // integer has to guess its unit, and guessing is how a EUR-base entry got read as francs.
  'Read a journal entry and its lines. Each line reports the transaction amounts (debit, credit) under its currency, and the amounts the books hold (baseDebit, baseCredit) under baseCurrency, which is the workspace base currency.',
  ctxSchema({ entryId: STR }, ['entryId']),
  (ctx, input) => getEntry(ctx, as(input)),
);

const listJournalAction = ctxAction(
  'list_journal',
  'read',
  // The currency is named because `total` is the TRANSACTION amount: a caller handed a bare
  // integer for a EUR entry has no way to know it is not Rappen, and guessing is how money gets
  // reported wrong. `baseTotal` is stated as derived so no caller tries to recompute it.
  'List journal entries, filtered by date range, account, source, or status. Each entry reports the currency its total is in (null when the entry has no lines), plus the base-currency total, rate and base currency for a foreign-currency entry, all derived from its posted rows. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
  ctxSchema({ from: STR, to: STR, account: STR, source: STR, status: STR, savedViewId: STR }),
  (ctx, input) => listJournal(ctx, as(input)),
);

/**
 * A03's period-lock read, hoisted for the same reason the four above are.
 *
 * Its payload is declared so that the Studio's two phantom permission reads become compile errors.
 * `Periods.tsx` gated the soft-close control on `body.canManage !== false` and the hard-lock UNLOCK
 * control on `body.canUnlock !== false`; this verb answers `ok({ locks })` and has never sent either
 * field, so both gates read `undefined !== false` and stood open. The definition is byte-for-byte the
 * one that stood inline in the list; only where the value is bound has moved.
 */
const listPeriodLocksAction = ctxAction(
  'list_period_locks',
  'read',
  'List all period locks for the workspace.',
  ctxSchema(),
  (ctx) => listPeriodLocks(ctx),
);

/**
 * Every action whose success payload is DECLARED, as the definitions themselves rather than as a
 * list of names. `ActionResults` below is read off this, so there is no second place where a wire
 * name is written next to a payload and no second place for the two to drift apart.
 *
 * A tuple (`as const`), so the entries keep their individual types: an ordinary array literal would
 * reduce them exactly the way the action list does, and the reduction is silent.
 *
 * ADDING A VERB. Declare the payload on the verb (see `src/core/result.ts`), hoist its action out of
 * the list to a const beside `postEntryAction`, and add it here. `test/api/wire-payload-binding.test.mjs`
 * then checks the rest: that the const is the very object the list dispatches under that name, and
 * that the count never falls.
 */
export const DECLARED_ACTIONS = [
  postEntryAction,
  reverseEntryAction,
  saveDraftAction,
  getEntryAction,
  listJournalAction,
  listPeriodLocksAction,
] as const;

/** The success payload a definition's `run` promises, read off the definition instead of restated. */
type PayloadOfDef<A extends ActionDef> = Omit<Extract<ReturnType<A['run']>, { ok: true }>, 'ok'>;

/**
 * The entries of `DECLARED_ACTIONS` that actually pin something: a LITERAL tool name and a payload
 * narrower than the open default.
 *
 * The filter is not ceremony. An entry that lost its declaration (its verb widened back to the open
 * `Result`, or its action came to be typed `ActionDef` somewhere along the way) would otherwise map
 * its name to `{ [x: string]: unknown }`, which answers for every field name, and the map would look
 * full while promising nothing. Filtered out instead, it makes the key count fall, and the count is
 * what the ratchet in `test/api/wire-payload-binding.test.mjs` watches.
 */
type PinnedAction<A> = A extends ActionDef
  ? string extends A['name']
    ? never
    : OkFields extends PayloadOfDef<A>
      ? never
      : A
  : never;

type Pinned = PinnedAction<(typeof DECLARED_ACTIONS)[number]>;

/**
 * WIRE ACTION NAME to the success payload that action answers with, derived from the dispatcher.
 *
 * This is the link the chain was missing. `app/src/lib/payloads.ts` had to hand-write
 * `post_entry: PayloadOf<typeof postEntry>` and said so in its own comment: the value side was
 * derived from the verb, but the NAME was bound by hand, because nothing here connected the two. A
 * verb re-pointed to a different action name, or an action re-pointed to a different verb, was
 * therefore invisible to every consumer of the wire. The Studio would have kept type-checking
 * against a payload the wire no longer sends, which is the defect family's shape exactly.
 *
 * Both halves now come off the same object. `run`'s return type carries the payload, `name` carries
 * the wire identity, and neither can be edited without the other following.
 */
export type ActionResults = {
  [N in Pinned['name']]: PayloadOfDef<Extract<Pinned, { name: N }>>;
};

// --- The append-only action list --------------------------------------------------------------

/**
 * The single source of truth for the tool surface (§H-ENUM). Append only; never reorder or rename an
 * existing entry (a name is a stable external contract). The registry test asserts names are unique
 * and that the list stays sorted-stable.
 */
export const ACTIONS: readonly ActionDef[] = [
  // A00, company & fiscal setup.
  depsAction(
    'create_workspace',
    'write',
    'Mint a new workspace (tenant) with its KMU chart of accounts.',
    depsSchema(
      { name: STR, baseCurrency: STR, fiscalYearStart: STR, legalForm: STR, idempotencyKey: STR },
      ['name'],
    ),
    (deps, input) => createWorkspace(deps, as(input)),
  ),
  depsAction(
    'bootstrap_workspace',
    'write',
    'One-call agent setup: parse a short description into a workspace and VAT config.',
    depsSchema({ description: STR, name: STR, idempotencyKey: STR }, ['description', 'idempotencyKey']),
    (deps, input) => bootstrapWorkspace(deps, as(input)),
  ),
  ctxAction(
    'set_fiscal_config',
    'write',
    'Set legal form, base currency, or fiscal year start (currency/year lock once the ledger is non-empty).',
    ctxSchema({ legalForm: STR, baseCurrency: STR, fiscalYearStart: STR }),
    (ctx, input) => setFiscalConfig(ctx, as(input)),
  ),
  ctxAction(
    'set_vat_method',
    'write',
    'Set the VAT method (effektiv/saldo) and accounting timing (soll/ist).',
    ctxSchema({ vatMethod: STR, vatAccounting: STR }, ['vatMethod', 'vatAccounting']),
    (ctx, input) => setVatMethod(ctx, as(input)),
  ),
  ctxAction(
    'set_creditor_profile',
    'write',
    'Set the QR-bill creditor: IBAN (a QR-IBAN gives a QRR reference, a plain IBAN gives SCOR), optional name (defaults to the company name) and optional structured address. The IBAN saves without the address; the address is needed before the first QR-bill renders (buildQrBill answers needs_creditor_address until then). A partial address is refused (needs_structured_address).',
    ctxSchema({ creditorName: STR, address: CREDITOR_ADDRESS, qrIban: STR, iban: STR }, []),
    (ctx, input) => setCreditorProfile(ctx, as(input)),
  ),
  ctxAction(
    'get_company_profile',
    'read',
    'Read the workspace company & fiscal profile.',
    ctxSchema(),
    (ctx) => getCompanyProfile(ctx),
  ),
  ctxAction(
    'update_company_profile',
    'write',
    'Update company identity fields (name, legal form, UID, MWST number).',
    ctxSchema({ name: STR, legalForm: STR, uid: STR, mwstNo: STR }),
    (ctx, input) => updateCompanyProfile(ctx, as(input)),
  ),

  // A01, chart of accounts & cost centres.
  ctxAction(
    'create_account',
    'write',
    'Create a ledger account.',
    ctxSchema(
      { number: STR, name: STR, type: STR, vatCodeDefault: STR, costCenterAllowed: BOOL, idempotencyKey: STR },
      ['number', 'name', 'type'],
    ),
    (ctx, input) => createAccount(ctx, as(input)),
  ),
  ctxAction(
    'update_account',
    'write',
    'Rename an account or change its VAT default / cost-centre flag (number and type are frozen).',
    ctxSchema({ accountId: STR, name: STR, vatCodeDefault: STR, costCenterAllowed: BOOL }, ['accountId']),
    (ctx, input) => updateAccount(ctx, as(input)),
  ),
  ctxAction(
    'archive_account',
    'write',
    'Archive an account (soft; the account keeps its postings).',
    ctxSchema({ accountId: STR }, ['accountId']),
    (ctx, input) => archiveAccount(ctx, as(input)),
  ),
  ctxAction(
    'unarchive_account',
    'write',
    'Reactivate a soft-archived account (idempotent).',
    ctxSchema({ accountId: STR }, ['accountId']),
    (ctx, input) => unarchiveAccount(ctx, as(input)),
  ),
  ctxAction(
    'delete_account',
    'write',
    'Hard-delete an account that never carried a posting.',
    ctxSchema({ accountId: STR, idempotencyKey: STR }, ['accountId']),
    (ctx, input) => deleteAccount(ctx, as(input)),
  ),
  ctxAction(
    'list_accounts',
    'read',
    'List accounts, optionally filtered by search text. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
    ctxSchema({ search: STR, includeArchived: BOOL, savedViewId: STR }),
    (ctx, input) => listAccounts(ctx, as(input)),
  ),
  ctxAction(
    'create_cost_center',
    'write',
    'Create a cost centre (Kostenstelle).',
    ctxSchema({ code: STR, name: STR, idempotencyKey: STR }, ['code', 'name']),
    (ctx, input) => createCostCenter(ctx, as(input)),
  ),
  ctxAction(
    'archive_cost_center',
    'write',
    'Archive a cost centre (soft).',
    ctxSchema({ costCenterId: STR }, ['costCenterId']),
    (ctx, input) => archiveCostCenter(ctx, as(input)),
  ),
  ctxAction(
    'unarchive_cost_center',
    'write',
    'Reactivate a soft-archived cost centre (idempotent).',
    ctxSchema({ costCenterId: STR }, ['costCenterId']),
    (ctx, input) => unarchiveCostCenter(ctx, as(input)),
  ),
  ctxAction(
    'delete_cost_center',
    'write',
    'Hard-delete a cost centre that no posted line references.',
    ctxSchema({ costCenterId: STR }, ['costCenterId']),
    (ctx, input) => deleteCostCenter(ctx, as(input)),
  ),
  ctxAction(
    'list_cost_centers',
    'read',
    'List cost centres. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
    ctxSchema({ includeArchived: BOOL, savedViewId: STR }),
    (ctx, input) => listCostCenters(ctx, as(input)),
  ),

  // A02, the double-entry journal. Every action here whose verb DECLARES a success payload is
  // defined above rather than inline, so that the declaration survives the array's element
  // inference; see `postEntryAction` for the measurement. `delete_draft` is the one that stays
  // inline, because its verb answers `ok()` with no fields at all: see `deleteDraftAction`'s
  // absence and the note on `DECLARED_ACTIONS`.
  postEntryAction,
  reverseEntryAction,
  saveDraftAction,
  ctxAction(
    'delete_draft',
    'write',
    'Delete a draft journal entry (never a posted one).',
    ctxSchema({ entryId: STR, idempotencyKey: STR }, ['entryId', 'idempotencyKey']),
    (ctx, input) => deleteDraft(ctx, as(input)),
  ),
  getEntryAction,
  listJournalAction,

  // A03, period locks, close, and the audit trail.
  ctxAction(
    'close_month',
    'write',
    'Soft-close a month (reversible guardrail).',
    ctxSchema({ period: STR, idempotencyKey: STR }, ['period', 'idempotencyKey']),
    (ctx, input) => softCloseMonth(ctx, as(input)),
  ),
  ctxAction(
    'reopen_month',
    'write',
    'Reopen a soft-closed month (a hard-sealed month refuses).',
    ctxSchema({ period: STR, idempotencyKey: STR }, ['period', 'idempotencyKey']),
    (ctx, input) => reopenMonth(ctx, as(input)),
  ),
  ctxAction(
    'close_year',
    'write',
    'Hard-close a fiscal year: sweep the P&L into equity and seal the year.',
    ctxSchema({ year: STR, idempotencyKey: STR }, ['year', 'idempotencyKey']),
    (ctx, input) => hardCloseYear(ctx, as(input)),
  ),
  ctxAction(
    'lock_period',
    'write',
    'Lock a month or year, soft or hard.',
    ctxSchema({ period: STR, kind: STR, reason: STR, idempotencyKey: STR }, ['period', 'kind', 'idempotencyKey']),
    (ctx, input) => lockPeriod(ctx, as(input)),
  ),
  ctxAction(
    'unlock_period',
    'write',
    'Unlock a period (a filing/year seal refuses).',
    ctxSchema({ period: STR, idempotencyKey: STR }, ['period', 'idempotencyKey']),
    (ctx, input) => unlockPeriod(ctx, as(input)),
  ),
  ctxAction(
    'get_audit_log',
    'read',
    'Read the tamper-evident audit trail and its chain-verification status.',
    ctxSchema({ entityKind: STR, from: STR, to: STR }),
    (ctx, input) => getAuditLog(ctx, as(input)),
  ),
  listPeriodLocksAction,

  // A05, MWST configuration and tax codes.
  ctxAction(
    'vat_seed_defaults',
    'write',
    'Seed the default Swiss tax-code set (idempotent).',
    ctxSchema(),
    (ctx) => seedTaxCodes(ctx),
  ),
  ctxAction(
    'vat_configure',
    'write',
    'Configure VAT: method, timing, registration, VAT number, and the ESTV Bewilligung (asOf picks the statutory rate era). A filer holding several Saldosteuersätze maps each Tätigkeit to its Ertragskonten with saldoActivities, which is how MWSTV Art. 84 Abs. 3 books the Erträge separately per rate. Changing an approval that already governs posted turnover must say which it is: saldoGrant for a new ESTV Bewilligung from a given day, saldoCorrection to rewrite the open one.',
    ctxSchema(
      {
        method: STR,
        timing: STR,
        registered: BOOL,
        vatNumber: STR,
        saldoRates: { type: 'array', items: { type: 'object', properties: { rateBp: INT }, required: ['rateBp'] } },
        // A Tätigkeit points at a rate it must ALSO appear in `saldoRates`, and owns its Ertragskonten
        // by account NUMBER (the chart is what a person and an agent both name). Several Tätigkeiten
        // may share one Saldosteuersatz: MWSTV Art. 86 Abs. 3 says so, so `rateBp` is not unique here.
        saldoActivities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              activityId: STR,
              name: STR,
              rateBp: INT,
              activityCode: STR,
              accounts: { type: 'array', items: STR },
            },
            required: ['activityId', 'name', 'rateBp'],
          },
        },
        saldoGrant: { type: 'object', properties: { validFrom: STR }, required: ['validFrom'] },
        saldoCorrection: BOOL,
        methodChange: { type: 'object', properties: { validFrom: STR }, required: ['validFrom'] },
        asOf: STR,
        idempotencyKey: STR,
      },
      ['method', 'timing', 'registered', 'idempotencyKey'],
    ),
    (ctx, input) => configureVat(ctx, as(input)),
  ),
  ctxAction(
    'vat_config',
    'read',
    'Read the current VAT configuration, including the Saldosteuersätze in force today, each Tätigkeit with the Ertragskonten mapped to it, and the elected MWSTV Art. 88 Abs. 6 declaration basis.',
    ctxSchema(),
    (ctx) => getVatConfig(ctx),
  ),
  ctxAction(
    'vat_saldo_generations',
    'read',
    'The Bewilligungsverlauf: every ESTV Saldosteuersatz approval this workspace has recorded, oldest first, with the days each governed and the Tätigkeiten and Ertragskonten it carried. Under Saldo no rate is stamped on a journal line, so this history is the only evidence of what a filed period was computed with.',
    ctxSchema(),
    (ctx) => listSaldoGenerations(ctx),
  ),
  ctxAction(
    'vat_saldo_eligibility',
    'read',
    'The MWSTG Art. 37 Abs. 1 Saldo eligibility limits in force today (both halves of the cumulative test, era-scoped, boundary 1.1.2024) beside the measured steuerbarer Umsatz of one calendar year (Ziffer 299, computed by the same path as the Abrechnung). Never a verdict: eligibility turns on EXPECTED turnover (ESTV practice, MWST-Info 12) and on a tax-due half that needs a rate the ESTV has not granted yet, so this read compares and stops.',
    ctxSchema({ year: STR }),
    (ctx, input) => saldoEligibility(ctx, as(input)),
  ),
  ctxAction(
    'vat_saldo_declaration_basis',
    'write',
    'Elect, or withdraw, the MWSTV Art. 88 Abs. 6 simplification for one Steuerperiode: `highest_rate` declares the whole taxable turnover at the highest approved Saldosteuersatz on one Ziffer, `per_activity` restores the Abs. 1 split per Tätigkeit. It is voluntary and usually raises the tax due, so the engine never applies it on its own.',
    ctxSchema({ taxPeriod: STR, basis: STR, idempotencyKey: STR }, ['taxPeriod', 'basis', 'idempotencyKey']),
    (ctx, input) => setSaldoDeclarationBasis(ctx, as(input)),
  ),
  ctxAction(
    'vat_codes',
    'read',
    'List tax codes (active only by default).',
    ctxSchema({ includeArchived: BOOL }),
    (ctx, input) => listTaxCodes(ctx, as(input)),
  ),
  ctxAction(
    'vat_code_upsert',
    'write',
    'Add or edit a tax code at the single tax enumeration point.',
    ctxSchema(
      { code: STR, kind: STR, rateBp: INT, formLine: STR, label: STR, validFrom: STR, idempotencyKey: STR },
      ['code', 'kind', 'rateBp', 'formLine'],
    ),
    (ctx, input) => upsertTaxCode(ctx, as(input)),
  ),
  ctxAction(
    'vat_code_deactivate',
    'write',
    'Archive a tax code (never deletes; a posted line always resolves its code).',
    ctxSchema({ code: STR }, ['code']),
    (ctx, input) => deactivateTaxCode(ctx, as(input)),
  ),
  ctxAction(
    'vat_code_reactivate',
    'write',
    'Reactivate an archived tax code, so it appears again on new documents. The exact mirror of vat_code_deactivate; posted lines never depended on the flag.',
    ctxSchema({ code: STR }, ['code']),
    (ctx, input) => reactivateTaxCode(ctx, as(input)),
  ),
  ctxAction(
    'account_set_tax_default',
    'write',
    "Set (or clear) an account's default tax code.",
    ctxSchema({ accountId: STR, taxCode: STR }, ['accountId']),
    (ctx, input) => setAccountTaxDefault(ctx, as(input)),
  ),

  // A06, VAT on transactions. The ONLY new tool is this read-only preview; the write surface is the
  // per-line `tax` field on post_entry/issue_invoice/record_expense, which all call buildVatLines.
  // vat_preview runs the SAME computeLineTax the GUI readout uses: agent preview and human figure are
  // one code path, never two. Read-only, so it needs a parity case (test/api/parity.test.mjs), not a
  // conformance write scenario. The spec's `GET /api/vat/preview` is conceptual: the REST twin is the
  // generic action-name dispatcher (rest.ts handleRest), not a path router, covered by parity.
  ctxAction(
    'vat_preview',
    'read',
    'Preview a line VAT (net/tax/gross, ESTV form line, kind, deductibility) without posting.',
    ctxSchema(
      {
        amountMinor: INT,
        amountIsGross: BOOL,
        taxCode: STR,
        // The Leistungsdatum, an ISO day (a full ISO timestamp names its day). The format is ALSO
        // enforced by the engine: a malformed date is a structured `invalid_date`, never silently
        // treated as absent (which would book the CURRENT rate for a mistyped historical date).
        supplyDate: {
          type: 'string',
          format: 'date',
          pattern: '^\\d{4}-\\d{2}-\\d{2}(T.*)?$',
          description: 'Supply date (Leistungsdatum), ISO YYYY-MM-DD; picks the statutory rate era.',
        },
      },
      ['amountMinor'],
    ),
    (ctx, input) => computeLineTax(ctx, as(input)),
  ),

  // A07, the MWST-Abrechnung. Two reads and one write, and the write TRANSMITS NOTHING: there is no
  // ESTV submission API anywhere in public ESTV, eCH or vendor documentation. eCH-0217 is a file
  // FORMAT, not a transport, so the ceiling on this whole capability is a valid file handed to a
  // human who uploads it to the ePortal himself. `vat_mark_filed` records that he did, by applying
  // A03's hard lock; it is deliberately not nameable as an automation action, because the act it
  // records is irreversible with the tax authority.
  ctxAction(
    'vat_return',
    'read',
    'Compute the MWST-Abrechnung for a period: ESTV form lines with base/tax, the payable or credit, and the drill-down entry ids.',
    ctxSchema(
      {
        periodStart: {
          type: 'string',
          format: 'date',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'First day of the reported period, ISO YYYY-MM-DD (inclusive).',
        },
        periodEnd: {
          type: 'string',
          format: 'date',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Last day of the reported period, ISO YYYY-MM-DD (inclusive).',
        },
      },
      ['periodStart', 'periodEnd'],
    ),
    (ctx, input) => computeVatReturn(ctx, as(input)),
  ),
  // The export, and the reason A07 has a primary action at all. It PRODUCES A FILE and transmits
  // nothing: `computeVatReturn`'s figures serialised as eCH-0217 v2.0.0 for a person to upload to
  // the ESTV ePortal himself. A read, because it writes nothing and must answer the same twice,
  // which is why `generationTime` comes off the injected clock rather than the wall clock.
  ctxAction(
    'vat_export_ech0217',
    'read',
    'Export the MWST-Abrechnung for a period as an eCH-0217 v2.0.0 XML file for upload to the ESTV ePortal. Produces a file and transmits nothing: there is no ESTV submission API.',
    ctxSchema(
      {
        periodStart: {
          type: 'string',
          format: 'date',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'First day of the reported period, ISO YYYY-MM-DD (inclusive).',
        },
        periodEnd: {
          type: 'string',
          format: 'date',
          pattern: '^\\d{4}-\\d{2}-\\d{2}$',
          description: 'Last day of the reported period, ISO YYYY-MM-DD (inclusive).',
        },
        typeOfSubmission: {
          type: 'integer',
          enum: [1, 2, 3],
          description: 'eCH-0217 typeOfSubmission: 1 Ersteinreichung (default), 2 Korrekturabrechnung, 3 Jahresabstimmung.',
        },
      },
      ['periodStart', 'periodEnd'],
    ),
    (ctx, input) => exportVatReturnEch0217(ctx, as(input)),
  ),
  ctxAction(
    'vat_periods',
    'read',
    'List the statutory reporting periods of a year (quarterly under effektiv, semi-annual under Saldo) and whether each is filed.',
    ctxSchema({ year: { type: 'string', pattern: '^\\d{4}$', description: 'Calendar year, YYYY.' } }),
    (ctx, input) => listVatPeriods(ctx, as(input)),
  ),
  ctxAction(
    'vat_mark_filed',
    'write',
    'Record that a VAT period was filed with the ESTV, applying the A03 hard lock to its months. Transmits nothing.',
    ctxSchema(
      {
        period: {
          type: 'string',
          pattern: '^\\d{4}-(Q[1-4]|H[12])$',
          description: 'Period label: YYYY-Qn (effektiv) or YYYY-Hn (Saldo).',
        },
        idempotencyKey: STR,
      },
      ['period', 'idempotencyKey'],
    ),
    (ctx, input) => markVatPeriodFiled(ctx, as(input)),
  ),

  // A09, contacts & items (invoicing-lite master data).
  ctxAction(
    'create_contact',
    'write',
    'Create a customer/vendor contact.',
    ctxSchema({ ...CONTACT_FIELDS, description: STR, idempotencyKey: STR }, ['partyRole']),
    (ctx, input) => createContact(ctx, as(input)),
  ),
  ctxAction(
    'update_contact',
    'write',
    'Update a contact from a patch.',
    ctxSchema({ contactId: STR, patch: { type: 'object', properties: CONTACT_FIELDS } }, ['contactId', 'patch']),
    (ctx, input) => updateContact(ctx, as(input)),
  ),
  ctxAction(
    'archive_contact',
    'write',
    'Archive a contact (soft).',
    ctxSchema({ contactId: STR }, ['contactId']),
    (ctx, input) => archiveContact(ctx, as(input)),
  ),
  ctxAction(
    'unarchive_contact',
    'write',
    'Reactivate a soft-archived contact (idempotent).',
    ctxSchema({ contactId: STR }, ['contactId']),
    (ctx, input) => unarchiveContact(ctx, as(input)),
  ),
  ctxAction(
    'get_contact',
    'read',
    'Read a contact.',
    ctxSchema({ contactId: STR }, ['contactId']),
    (ctx, input) => getContact(ctx, as(input)),
  ),
  ctxAction(
    'list_contacts',
    'read',
    'List contacts, filtered by query or party role. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
    ctxSchema({ query: STR, partyRole: STR, includeArchived: BOOL, savedViewId: STR }),
    (ctx, input) => listContacts(ctx, as(input)),
  ),
  ctxAction(
    'create_item',
    'write',
    'Create an invoicing item (a reusable line default).',
    ctxSchema({ ...ITEM_FIELDS, idempotencyKey: STR }, ['name', 'defaultUnitPriceMinor']),
    (ctx, input) => createItem(ctx, as(input)),
  ),
  ctxAction(
    'update_item',
    'write',
    'Update an item from a patch.',
    ctxSchema({ itemId: STR, patch: { type: 'object', properties: ITEM_FIELDS } }, ['itemId', 'patch']),
    (ctx, input) => updateItem(ctx, as(input)),
  ),
  ctxAction(
    'archive_item',
    'write',
    'Archive an item (soft).',
    ctxSchema({ itemId: STR }, ['itemId']),
    (ctx, input) => archiveItem(ctx, as(input)),
  ),
  ctxAction(
    'unarchive_item',
    'write',
    'Reactivate a soft-archived item (idempotent).',
    ctxSchema({ itemId: STR }, ['itemId']),
    (ctx, input) => unarchiveItem(ctx, as(input)),
  ),
  ctxAction(
    'get_item',
    'read',
    'Read an item.',
    ctxSchema({ itemId: STR }, ['itemId']),
    (ctx, input) => getItem(ctx, as(input)),
  ),
  ctxAction(
    'list_items',
    'read',
    'List items, filtered by query. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here.',
    ctxSchema({ query: STR, includeArchived: BOOL, savedViewId: STR }),
    (ctx, input) => listItems(ctx, as(input)),
  ),

  // D12's `list_workspaces` sat inline here (appended after A09) until A23 took ownership of the
  // workspace roster and migrated it into `./workspace-actions.ts`, spread in with its three
  // siblings near the end of this list. A tool's position is part of its history, not its meaning.

  // A10, document lifecycle (the shared quote/order/invoice/credit_note state machine). Appended at
  // the end because the list is append-only. issue/send/cancel are all `transition_document`; posting
  // on issue is delegated to A11/A13 through the engine's poster seam.
  ctxAction(
    'create_document',
    'write',
    'Create a document draft (quote, order, invoice, or credit note) with positions.',
    ctxSchema(
      { type: STR, contactId: STR, lines: DOC_LINES, currency: STR, dueDate: STR, notes: STR, idempotencyKey: STR },
      ['type'],
    ),
    (ctx, input) => createDocument(ctx, as(input)),
  ),
  ctxAction(
    'update_document',
    'write',
    'Patch a draft document (draft-only; an issued document is immutable and corrected by reversal).',
    ctxSchema({ documentId: STR, patch: DOC_PATCH, idempotencyKey: STR }, ['documentId', 'patch']),
    (ctx, input) => updateDocument(ctx, as(input)),
  ),
  ctxAction(
    'transition_document',
    'write',
    'Advance a document (issue, send, accept, decline, confirm, cancel); issuing an invoice posts via the delegate.',
    ctxSchema({ documentId: STR, to: STR, idempotencyKey: STR }, ['documentId', 'to']),
    (ctx, input) => transitionDocument(ctx, as(input)),
  ),
  ctxAction(
    'convert_document',
    'write',
    'Convert an accepted quote to an order or invoice (or a confirmed order to an invoice), linking the source.',
    ctxSchema({ documentId: STR, toType: STR, idempotencyKey: STR }, ['documentId', 'toType']),
    (ctx, input) => convertDocument(ctx, as(input)),
  ),
  ctxAction(
    'get_document',
    'read',
    "Read a document with its positions and status trail. For an invoice, include 'qr' and/or 'pdf' to attach the Swiss QR-bill payload and the rendered PDF (A11, D14).",
    ctxSchema(
      { documentId: STR, include: { type: 'array', items: STR } },
      ['documentId'],
    ),
    (ctx, input) => getDocumentWithIncludes(ctx, input),
  ),
  ctxAction(
    'list_documents',
    'read',
    'List documents, filtered by type, status, contact, credited invoice (A13: the credit notes of invoice X), or date range. savedViewId applies a saved view (G00): its stored filters are merged underneath any filter named explicitly here, so an explicit one always wins.',
    ctxSchema({ type: STR, status: STR, contactId: STR, creditedDocumentId: STR, from: STR, to: STR, savedViewId: STR }),
    (ctx, input) => listDocuments(ctx, as(input)),
  ),

  // A11, invoice: the ONLY two invoice-named tools (D14). Create/edit/read/list ride A10's generic
  // document tools; there is no create_invoice. issue_invoice posts through A11's onIssue delegate;
  // send_invoice is the outbound channel, P8-gated (draft_by_default). Appended at the end because the
  // list is append-only.
  ctxAction(
    'issue_invoice',
    'write',
    'Issue a draft invoice: assign the gap-free number, post the balanced VAT entry (A10 onIssue delegate), and attach the QR-bill summary.',
    ctxSchema({ invoiceId: STR, idempotencyKey: STR }, ['invoiceId']),
    (ctx, input) => issueInvoice(ctx, as(input)),
  ),
  ctxAction(
    'send_invoice',
    'write',
    'Send an issued invoice by email (renders + attaches the PDF, transitions to sent). Outbound step is P8-gated: pass confirmed=true or enable the workspace dial.',
    ctxSchema({ invoiceId: STR, email: STR, confirmed: BOOL, idempotencyKey: STR }, ['invoiceId']),
    (ctx, input) => sendInvoice(ctx, as(input)),
  ),

  // A13, credit notes: the ONLY two credit-note-named tools (D14 parity with A11). Create derives a
  // DRAFT from an issued invoice (full, by positions, or by an apportioned net amount); issue posts
  // the mirror entry through A13's onIssue delegate. Read/list/PDF ride get_document
  // (include:['pdf']) and list_documents(type:'credit_note', creditedDocumentId?). Cancellation is
  // A10's shared transition_document. Placed beside its capability rather than at the bottom.
  ctxAction(
    'create_credit_note',
    'write',
    'Draft a Gutschrift against an issued invoice: full, selected positions (reduced quantities), or a net amount apportioned over the remaining line nets. Always a draft; issuing is a separate, confirmed step (P8).',
    ctxSchema(
      { fromInvoiceId: STR, mode: STR, lines: CREDIT_NOTE_LINES, amountMinor: INT, reason: STR, idempotencyKey: STR },
      ['fromInvoiceId', 'idempotencyKey'],
    ),
    (ctx, input) => createCreditNote(ctx, as(input)),
  ),
  ctxAction(
    'issue_credit_note',
    'write',
    'Issue a drafted Gutschrift: assign the gap-free G-number and post the mirror entry (debit revenue and output VAT, credit 1100 Debitoren) dated today, closing against the invoice per rate class (D67/D71).',
    ctxSchema({ creditNoteId: STR, idempotencyKey: STR }, ['creditNoteId', 'idempotencyKey']),
    (ctx, input) => issueCreditNote(ctx, as(input)),
  ),

  // A32, eBill issuing. The five verbs (config pair + prepare/transmit/status), defined in
  // `./ebill-actions.ts` and spread in as one line, the shape §H-FX established, so concurrent appends
  // to this append-only list collide over a line rather than a block. Packages an issued A11 invoice
  // as an outward-facing eBill payload (OP4, cloud-tier transmit); posts nothing (P3 by absence).
  ...ebillActions({ ctxAction, ctxSchema, STR, BOOL }),

  // A33, EBICS bank channel. The five verbs (connect/sync/transmit/disconnect + the status read),
  // defined in `./ebics-actions.ts` and spread in as one line, the same shape §H-FX established, so
  // concurrent appends to this append-only list collide over a line rather than a block. The local
  // EBICS client is OSS-core (D29): it uploads A18 pain.001 batches (P8-gated, WITHOUT the signature
  // flag, so the bank authorizes) and pulls camt.053/054 + pain.002 into A20. Posts nothing (P3 by
  // delegation): statements enter only through A20's import, and nothing here marks anything paid.
  ...ebicsActions({ ctxAction, ctxSchema, STR, BOOL, INT }),

  // A22 / §H-FX, the exchange-rate verbs. Defined in `./fx-actions.ts` and spread in as one line, so
  // several agents appending to this append-only list at once collide over a line rather than a
  // block. The helpers are passed in rather than imported there, which keeps the module graph acyclic.
  ...fxActions({ ctxAction, ctxSchema, STR }),

  // A14, payments and matching: the settlement half of the money path. Defined in
  // `./payment-actions.ts` and spread in as one line, the same shape §H-FX established, so
  // concurrent appends to this append-only list collide over a line rather than a block. (The
  // identical `a14PaymentActions` const above exists ONLY to derive the reserved money-path NAMES
  // for G02; it is a throwaway sibling, never the live objects, so this stays the inline call form
  // the orientation/contract generators parse.)
  ...paymentActions({ ctxAction, ctxSchema, STR, INT }),

  // A16, Debitoren: the OP-Liste, its aging buckets, and the reconciliation to 1100. Defined in
  // `./debtor-actions.ts` and spread in as one line, the same shape §H-FX and A14 established.
  ...debtorActions({ ctxAction, ctxSchema, STR }),
  // A19, the bank-account register: the anchor A18/A20/A21/A22 hang their own tables off. Defined
  // in `./bank-actions.ts` and spread in as one line, the same shape §H-FX and A14 established.
  ...bankActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // A08, the financial statements: Saldenbilanz, Bilanz, Erfolgsrechnung, Kontoblatt and the local
  // export. Five READS and no write, so nothing here owes a conformance scenario. Defined in
  // `./report-actions.ts` and spread in as one line, the same shape §H-FX, A14, A16 and A19 use.
  ...reportActions({ ctxAction, ctxSchema, STR }),
  // A04, opening balances: the position every statement above it is measured from. Defined in
  // `./opening-actions.ts` and spread in as one line, the same shape §H-FX and A14 established.
  ...openingActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // G08, feedback and diagnostics. Same one-line spread the FX and payment verbs use, for the same
  // reason: this list is append-only and several agents append to it at once.
  ...supportActions({ ctxAction, ctxSchema, STR, BOOL }),

  // A24, access control. Same one-line spread, and `depsSchema`/`depsAction` ride along because
  // `accept_invite` is pre-workspace: the accepter is not a member yet.
  ...permissionActions({ ctxAction, depsAction, ctxSchema, depsSchema, STR }),

  // G00, the customization framework. The four tools A09, A10, A11 and A14 have been naming in their
  // own §5 tables while `PENDING_TOOLS` held the place become real on this line.
  ...customizationActions({ ctxAction, ctxSchema, STR, BOOL, INT }),

  // G05, document templates: presentation only, around content the consuming capability computed.
  ...documentTemplateActions({ ctxAction, ctxSchema, STR, BOOL }),

  // G05, dispatch texts and the cross-document send log (the §10 / D29 amendment). The three tools
  // `PENDING_TOOLS` held the place for become real on this line; the send verbs themselves are
  // untouched and merely append log rows through the shared `recordDispatch` delegate.
  ...dispatchActions({ ctxAction, ctxSchema, STR }),

  // G01, automation rules. The one capability whose verbs can cause another verb to run, which is why
  // `invokerFor` rides along: it is the only route from an engine module back into this dispatch, and
  // it is the reason G01 needs no write path of its own.
  ...automationActions({ ctxAction, ctxSchema, invokerFor, STR, BOOL, INT }),

  // D00, the products/items master's NEW verbs (delete_item, the category tree, the price lists and
  // the resolver). Defined in `./item-actions.ts` and spread in as one line; the item CRUD itself
  // stays on A09's create_item/update_item, extended through the additionalProperties boundary.
  ...itemActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // C00, the contacts / CRM verbs (tag, activity log + timeline, merge, import, anonymise). A09's
  // contact CRUD is extended in place, so only C00's genuinely new surface is spread in here, the
  // same one-line shape §H-FX and G00 use.
  ...contactActions({ ctxAction, ctxSchema, STR }),

  // E03, tasks & reminders. The cross-entity to-do spine: five lifecycle writes, the queue read,
  // and tasks_reminders_due, the ONE reminder-trigger surface C01/A16/G06 poll. Defined in
  // `./task-actions.ts` and spread in as one line, the same shape C00 and E00 use.
  ...taskActions({ ctxAction, ctxSchema, STR, BOOL }),

  // G06, notifications & inbox. The ONE delivery surface: notifications_deliver is the OP8 action
  // a G01 rule targets (an OP8 CONSUMER, not a second engine), the queue around it is self-scoped
  // (an inbox is not a shared mailbox), and the digest is the OP4 outbound half that always stops
  // at a local artifact in the OSS core. Defined in `./notification-actions.ts`, spread as one line.
  ...notificationActions({ ctxAction, ctxSchema, STR, BOOL }),

  // G02, plugin architecture & extension registry. Ten verbs (five writes, five reads): the manifest
  // lifecycle (preview/install/enable/disable/uninstall/compat-refresh), the installed-list reads,
  // and the registry-discovery seam. Every write asserts `manage_plugins` (owner-only by default);
  // the reserved money-path names a plugin can never register (P3) are single-sourced from the
  // A02/A14 write set and handed to the engine below. Defined in `./plugin-actions.ts`, spread as one
  // line, the same shape every sibling uses.
  ...pluginActions({ ctxAction, ctxSchema, STR, INT }),

  // C01, leads & deals. The pre-financial pipeline between C00's contacts and A10's documents:
  // eight writes (lifecycle + the §6b pipeline configuration pair) and the one board read. Two
  // verbs hold an invoker (`deals_to_quote` reaches the quote verb, `deals_log_activity`'s
  // reminder half reaches `tasks_create`), which is why `invokerFor` rides along, exactly as it
  // does for G01, A12 and A26. Defined in `./deal-actions.ts` and spread in as one line.
  ...dealActions({ ctxAction, ctxSchema, invokerFor, STR, INT, BOOL }),

  // C02, quotes / proposals: the Offerte lifecycle riding A10's shared document machine. Eight
  // writes (create, update, send, accept, decline, expire-sweep, revise, convert) and two reads,
  // spread in as one line, the same shape every sibling uses. No verb holds an invoker: the quote
  // engine reaches A10 directly, never back through the dispatch, and it opens NO posting path
  // (convert delegates entirely to A10's convertDocument).
  ...quoteActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // C03, sales forecasting: four reads and not one write (P5), spread in as one line. The pure read
  // model over C01 deals + C02 quotes + A08 actuals; it owns no table and opens no posting path.
  ...forecastActions({ ctxAction, ctxSchema, STR, INT }),

  // A17, vendor bills and expenses: the CREDITOR half of the money path, and the first purchase verbs
  // this registry has ever carried. Five writes and two reads, spread in as one line. There is no pay
  // verb among them on purpose: a bill is settled by A14's `record_payment` with `vendorBillId` on the
  // allocation, exactly as an invoice is settled with `documentId`.
  ...purchaseActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  ...captureActions({ ctxAction, ctxSchema, STR }),
  // A34 payroll hand-off: the employee-master export (local artifact, OP4) and the ONE wage-journal
  // posting through A02 (P8 preview-then-confirm), spread in as one line. `wage_journal_post` is the
  // only path a wage journal reaches the ledger (P3); the migration harness routes `payroll` here.
  ...payrollActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // E00, file management: the filing tree, the content-addressed store, the version chain, the OP3
  // entity link and the OR 958f retention lock. The prefix is `files_` and not `documents_` because
  // A10 owns that noun four verbs up this same array (see `./file-actions.ts`).
  ...fileActions({ ctxAction, ctxSchema, STR, BOOL }),

  // E01, e-signature: the sign-request lifecycle over E00 files (request, send via the OP4 seam,
  // track, complete back into E00 as a new version). Six writes and two reads, spread in as one
  // line, the same shape E00 and E03 use. It opens NO posting path: a sign request is a tracking
  // record, and completion delegates every byte to E00's files_new_version.
  ...signActions({ ctxAction, ctxSchema, STR, BOOL }),

  // F02, customer portal: scoped, expiring, tokened grants that let one customer self-serve their own
  // invoices, quotes and documents. Four operator verbs (create/send/revoke/list) gated by A24, and
  // TWO token-authenticated pre-workspace verbs (`portal_resolve`, `portal_quote_accept`), so
  // `depsAction`/`depsSchema` ride along the `accept_invite`/A23 shape. `portal_quote_accept` reaches
  // C02's accept engine directly (no invoker), opens NO posting path, and shares the `portal_grant`
  // table with F03. Spread in as one line, the same shape every sibling uses.
  ...portalActions({ ctxAction, depsAction, ctxSchema, depsSchema, STR, BOOL }),

  // F03, vendor portal: the CREDITOR-side mirror of F02. Six workspace-scoped verbs (the token is a
  // second fence WITHIN the workspace, not a pre-workspace depsAction): three portal.manage writes
  // (grant/revoke/remittance-create), three read_master_data reads (grants list + two scoped reads).
  // Reuses F02's shared grant engine (kind=vendor) and adds the remittance_advice snapshot; opens NO
  // posting path. Spread in as one line, the same shape every sibling uses.
  ...vendorPortalActions({ ctxAction, ctxSchema, STR }),

  // A15, Mahnwesen: the escalating reminder loop over A16's open items. Four writes and four reads,
  // spread in as one line. `dunning` as a journal source is deliberately NOT in POST_ENTRY_SOURCES:
  // only issue_dunning_run may book a Mahngebühr, so a caller cannot forge one (the A17 precedent).
  ...dunningActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // A12, recurring invoices (Serienrechnungen): schedules whose tick INVOKES create_document /
  // issue_invoice through this same dispatch as the schedule's author, which is why `invokerFor`
  // rides along exactly as it does for G01. Spread in as one line, the same shape every sibling uses.
  ...recurringActions({ ctxAction, ctxSchema, invokerFor, STR, INT, BOOL }),

  // A21, QR incoming matching: the Abgleich queue over A19's register, settling only through A14.
  // Four writes and two reads, spread in as one line. `set_qr_auto_apply` is on the G01 denylist
  // (D65 leg (e)).
  ...qrMatchActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // A20, camt reconciliation: import a camt.053/054 statement, propose matches, settle a debit or
  // link a manual entry, and the reconciled-to-balance read. Three writes and two reads, spread in
  // as one line. A CREDIT never settles here (`confirm_match` refuses `use_qr_queue`): it is decided
  // in A21's own queue, which `import_camt` routes it into.
  ...camtActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // A18, creditor payments: select A17's open items, generate a pain.001.001.09 credit-transfer
  // initiation, mark paid through A14's recordPayment. Eight verbs (five writes, three reads), spread
  // in as one line. `set_creditor_bank_profile`, `get_payment_batch`, `list_payment_batches` and
  // `discard_payment_batch` are additions beyond the spec's four named tools (see the reconciliation
  // note atop `core/banking/pain001.ts`).
  ...pain001Actions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // A23, multi-client workspaces (Treuhänder onboarding and archive). `list_workspaces` (D12) moved
  // here from its inline registration; `depsAction`/`depsSchema` ride along because listing and
  // onboarding are pre-workspace, the `accept_invite`/`create_workspace` shape. Spread in as one
  // line, the same shape every sibling uses.
  ...workspaceActions({ ctxAction, depsAction, ctxSchema, depsSchema, STR, BOOL }),

  // A25, Treuhänder review & export: the entry_review sidecar over the immutable journal (comment,
  // flag, approve, the coverage read, the agent's prepare) and the three filing exports, which only
  // ever repackage what A02/A08/A07 already computed. Locking stays A03's lock_period. Defined in
  // `./review-actions.ts` and spread in as one line, the same shape §H-FX and A14 established.
  ...reviewActions({ ctxAction, ctxSchema, STR }),

  // A26, agent bookkeeping. Three convenience reads, the dial pair, and the two inbox verbs. A26 adds
  // NO agent-only financial or customization write tool beyond the dial itself (§6b): the money and
  // customization stories reach the existing A00-A25 / G00-G02 verbs, routed through the dial.
  // `approve_drafted_action` holds an invoker (it replays a drafted verb as the approver), which is
  // why `invokerFor` rides along, exactly as it does for G01 and A12. A35 added the queue read
  // (`list_drafted_actions`), the composer verb (`agent_ask`, D90 D-1) and the prose delete
  // (`agent_prose_delete`, D90 D-5) to this block: the write mechanics over agent artifacts stay
  // A26's even when A35 is the face that renders them.
  ...agentActions({ ctxAction, ctxSchema, invokerFor, STR, BOOL }),

  // A35, agent conversation & oversight. The three READS over the trace the transport seam records
  // (`src/api/agent-gate.ts`): the Gespräche archive pair and the Vertrauen trust evidence. A35
  // registers ZERO write verbs. Defined in `./agent-oversight-actions.ts` and spread in as one line,
  // the same shape every sibling uses.
  ...agentOversightActions({ ctxAction, ctxSchema, STR, BOOL }),

  // G10, migration maps and the locale seam. The persisted column/account/tax/currency maps a
  // Datenübernahme resolves through, the operator-scoped Zuordnungsvorlagen, and the two ungated
  // catalog reads (adapters with their cleanRoomSource, locale packs). Six ctx verbs on
  // `manage_import` plus two depsAction catalog reads; defined in `./migration-map-actions.ts` and
  // spread in as one line, the same shape every sibling uses.
  ...migrationMapActions({ ctxAction, depsAction, ctxSchema, depsSchema, STR }),

  // G09, the migration harness. The plan and step machine G10's maps feed: discovery over pure byte
  // adapters, scope, the six-condition commit gate and the money path (a migrated document posts
  // nothing, a money-path class establishes opening balances through A04's single entry). Twelve
  // ctx verbs, seven writes and five reads; the writes gate on `manage_import`, a money-path commit
  // additionally on `commit_migration` inside the engine. Defined in `./migration-actions.ts` and
  // spread in as one line, the same shape every sibling uses.
  ...migrationActions({ ctxAction, ctxSchema, STR }),

  // G11, the Eröffnungsprüfung. The migration family's check: control totals declared from the old
  // system, the persisted append-only check whose hash a G09 approval binds to, the waiver with a
  // recorded reason, and the Prüfbericht export. Six ctx verbs, three writes and three reads, all
  // on `manage_import`; defined in `./migration-check-actions.ts` and spread in as one line, the
  // same shape every sibling uses.
  ...migrationCheckActions({ ctxAction, ctxSchema, STR }),

  // G21, open-items AR/AP migration. The two verbs that carry open Debitoren/Kreditoren across from an
  // old system as origin=migrated documents / vendor bills that post NOTHING (their only ledger effect
  // is A04's opening 1100/2000 line): preview_open_items (read, the control tie-out without a write)
  // and import_open_items (write, atomic + idempotent, rides commit_migration, denylisted from
  // automation). Defined in `./migration-openitems-actions.ts` and spread in as one line, the sibling
  // shape.
  ...migrationOpenItemsActions({ ctxAction, ctxSchema, STR }),

  // G12 Testmandant. The disposable trial workspace, its go-productive promotion and its discard.
  // Five ctx verbs: two reads (get, and the family's one two-workspace diff) plus three writes.
  // `migration_create_testmandant` gates on `manage_import`; `go_productive` on `promote_workspace`
  // AND `commit_migration` (minting real books is the G04 restore analogy, committing money-path data
  // the G09 one), with the type-to-confirm checked engine-side; `discard_testmandant` on
  // `manage_import`. Both `go_productive` and `discard_testmandant` are denylisted from automation.
  // Defined in `./migration-testmandant-actions.ts` and spread in as one line, the sibling shape.
  ...migrationTestmandantActions({ ctxAction, ctxSchema, STR }),

  // G03, onboarding & migration. The first-run on-ramp OVER the family above, never a second door:
  // the wizard resume pointer (two ctx verbs, bookkeeping and never a gate), the pre-workspace
  // `create_demo_workspace` (the `create_workspace`/`onboard_client` depsAction shape, seeds sample
  // books through the owning verbs, kind='demo' never promotes) and `discard_demo_workspace` (the
  // demo's one exit, hard delete fenced to kind='demo', denylisted from automation alongside
  // `discard_testmandant`). No import verb lives here: imports are G09-G13's. Defined in
  // `./onboarding-actions.ts` and spread in as one line, the sibling shape.
  ...onboardingActions({ ctxAction, depsAction, ctxSchema, depsSchema, STR, BOOL }),

  // G13 GL archive. The read-only prior-system ledger beside the live one, hard-partitioned from it
  // (an archive row never reaches list_journal or a live statement; the labelled comparative is the
  // one meeting point, composed at the API layer). Six ctx verbs: four reads on `read_books` (the
  // archive IS the books, historical or not), `gl_archive_import` on `commit_migration`, and the
  // destructive, denylisted `gl_archive_purge` on the owner-only `purge_archive`. Defined in
  // `./gl-archive-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...glArchiveActions({ ctxAction, ctxSchema, STR }),

  // G19, the extraction companion core. The first mile of a migration as product data: the guide
  // registry (getting data OUT of the old system) and the export-completeness manifest. Two guide
  // reads are depsActions with NO workspaceId (they describe the software, ungated, the
  // `migration_list_source_adapters` shape); the three manifest verbs are ctx verbs (two writes, one
  // read) on `manage_import` like the rest of the import domain. The core stores no vendor
  // credential or session state; the browser companion is a separate optional package. Defined in
  // `./migration-extraction-actions.ts` and spread in as one line, the sibling shape.
  ...migrationExtractionActions({ ctxAction, depsAction, ctxSchema, depsSchema, STR }),

  // G20, implementation projects. The cutover as a first-class object above the migration plan(s):
  // the project, its runbook tasks, decisions, sign-offs and the parallel-run reconciliation, plus the
  // cross-client roster (composed over A23 client-side). Eleven ctx verbs, prefixed `implementation_`
  // because B00 owns the bare `project_*` names for its billing projects (spec §5 reconciled). Eight
  // writes gate on `manage_implementation`; `implementation_signoff_record` rides `commit_migration`;
  // the roster list gates on `read_master_data`. Defined in `./migration-project-actions.ts` and
  // spread in as one line, the sibling shape.
  ...migrationProjectActions({ ctxAction, ctxSchema, STR }),

  // G22, checklists. Recurring checklists as shipped product data (D127), the MWST-Periode first:
  // a template instantiates into a run whose items are derived live (system checks, hash-bound verb
  // evidence, append-only sign-offs). Three reads on `read_books`, five writes on the new
  // `manage_checklists`; no money moves and no table carries a Rappen. Defined in
  // `./checklist-actions.ts` and spread in as one line, the sibling shape.
  ...checklistActions({ ctxAction, ctxSchema, STR }),

  // B00, the projects master (phases, milestones, budget vs actual, status): the cluster-B spine
  // every later B-capability keys against. Seven writes and three reads, all on the master-data
  // capability pair; B00 posts nothing (its one money read is the P5 budget-vs-actual query over
  // the read-only cost-source seam). Defined in `./project-actions.ts` and spread in as one line,
  // the same shape every sibling uses.
  ...projectActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // B01, time tracking (timers, timesheets, rate cards): the first leaf on B00's spine. Ten writes
  // (the entry lifecycle, the submit/approve/lock chain, the versioned rate-card pair) and three
  // reads; B01 posts nothing (time is pre-financial, the one money figure is derived round-once at
  // read from the OP1 snapshot). Defined in `./time-actions.ts` and spread in as one line, the
  // same shape every sibling uses.
  ...timeActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // B02, time -> billing: approved unbilled time (B01) becomes A11 invoice DRAFT lines, plus the WIP
  // read model. Two writes (`billing_generate_invoice`, `billing_release_time`) gated on
  // `billing.generate`, two reads (`billing_unbilled_preview`, `billing_wip_report`) on
  // `billing.read`. B02 posts nothing: generation delegates to A10 `createDocument` (P3), and A11 ->
  // A02 own the only journal entry, at issue. Defined in `./billing-actions.ts`, spread in as one line.
  ...billingActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // B04, retainers & mandates: a recurring fee that bills itself as an A11 draft, drawing approved
  // B01 time down against included hours and pricing the over-cap excess with B02's round-once
  // semantics on the SAME invoice. Five writes (create/update/close/generate_invoice/run_due) gate on
  // `retainer.manage`, two reads (burndown/list) on `billing.read`. B04 posts nothing (P3); generation
  // delegates to A10 createDocument. Defined in `./retainer-actions.ts`, spread in as one line.
  ...retainerActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // B03, job costing / project P&L: the pure P5 read model over B00/B01/B02/A11. Four reads and
  // not one write (the A08 shape): the card, the portfolio list, budget-vs-actual and the
  // drilldown, all gated on `costing.read` (the revDSG pay-data gate, see actionCapabilities.ts).
  // B03 owns no table, posts nothing and emits no events; the A17/D02 components degrade honestly
  // until their project references land. Defined in `./costing-actions.ts`, spread in as one line.
  ...costingActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // F00, dashboards & KPIs: the pure P5 tile wall over the read models above. Two reads and not
  // one write (the B03 shape): the overview and the single tile, each composing
  // A08/A16/A17/A07/B01/B03/D01 (+ A19's account list and G00's saved views) in-process, RBAC
  // asserted PER TILE inside the engine (the boundary is ungated 'asserted_in_engine'). F00 owns
  // no table, posts nothing and emits no events. Defined in `./dashboard-actions.ts`, spread in
  // as one line.
  ...dashboardActions({ ctxAction, ctxSchema, STR }),

  // G15, the attention hub: two READS that compose the module work queues into one answer. Owns no
  // table, posts nothing and emits no events (pure P5, the F00 posture). RBAC is the union of the
  // providers' read gates, asserted per queue in the engine, so both verbs are ungated at the
  // boundary. Defined in `./attention-actions.ts`, spread in as one line.
  ...attentionActions({ ctxAction, ctxSchema, STR, INT }),

  // F01, report builder: ten verbs (six writes, four reads) composing REPORT_SOURCES read models
  // into saved reports rendered to local CSV/PDF artifacts. Owns saved_reports + report_runs, posts
  // nothing (P3). Defined in `./report-builder-actions.ts`, spread in as one line.
  ...reportBuilderActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // D01, inventory / stock: the OP2 stock seam D03 later consumes. Ten verbs (six writes, four
  // reads). The operational writes gate on `manage_master_data`, the reads on `read_master_data`.
  // Since K68 `stock_run_valuation` is REPORT-ONLY (it computes and returns the valuation but mints
  // no journal entry), so it too gates on `read_master_data`; J06 `inventory_valuation_post` is the
  // sole ledger-reaching poster (see actionCapabilities.ts). Defined in `./stock-actions.ts` and
  // spread in as one line, the same shape every sibling uses.
  ...stockActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // D03, sales orders & delivery notes: the order -> delivery -> invoice fulfilment bridge. Eleven
  // verbs (eight writes, three reads). The writes gate on `issue` (the sales-document write capability
  // C02/A11 use), the reads on `read_sales`. Invoicing delegates to A10 createDocument (no posting
  // path, P3); issue movements are minted only through D01 stock.move (OP2). Defined in
  // `./sales-order-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...salesOrderActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // D02, purchasing: PO -> goods receipt -> 3-way match against the A17 vendor bill, plus supplier
  // prices. Twelve verbs (eight writes, four reads). The writes gate on `manage_master_data` (D02 posts
  // NOTHING, P3; a match override additionally asserts `post` inside the engine), the reads on
  // `read_master_data`. Receipts mint stock only through D01 stock.move (OP2); matching links the A17
  // bill and posts nothing. Defined in `./purchase-order-actions.ts` and spread in as one line, DISJOINT
  // from A17's own `purchase-actions.ts`.
  ...purchaseOrderActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // I01, Advanced Purchase Order (OP14): ten versioning + amendment verbs (six writes, four reads) that
  // LAYER controlled versioning over the live D02 PO without touching D02's public surface. Writes gate
  // on `manage_master_data`, reads on `read_master_data`, exactly as the D02 purchasing verbs do.
  // `po_amendment_apply` re-renders the P8 outbound artifact (transmitted:false) and never posts (P3).
  // Defined in `./po-amendment-actions.ts` and spread in as one line, DISJOINT from D02's own file.
  ...poAmendmentActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // E02, HR-lite: employees, absences and expense claims (Spesen). Fourteen verbs (nine writes, five
  // reads). The money path is `expense_claim_approve` (posts the reimbursement liability via A02) and
  // `expense_claim_reimburse` (pays via A14), both P8 draft-gated; the reads self-scope to the
  // caller's own personnel/Spesen rows unless they hold `hr.manage`/`spesen.approve`. Defined in
  // `./hr-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...hrActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // E04, local mail store. Seven verbs (three writes, four reads) over the mail store a client on
  // this machine already writes: connect (no credential exists to ask for), reindex (locators and
  // hashes, never a body: OP6), the thread queue and read, and the draft write-back into the
  // client's LOCAL Drafts folder. NO send verb exists and none may be added (P8 by construction);
  // erasure rides C00 contacts_anonymise, never a second entry point. Defined in
  // `./mail-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...mailActions({ ctxAction, ctxSchema, STR }),

  // E05, voice profile and the OP6 local runtime. Seven verbs (two writes, five reads): learn a
  // style card from the E04 outbound corpus (locators, vectors and hashes, never an excerpt:
  // Art. 321 index-never-copy), retrieve the nearest exemplars for E06's drafting, and the model
  // picker over the companion package's static manifest (a file, never a fetch; the RAM floor
  // enforced in the verb). `runtime.register` is deliberately NOT a tool (an agent must never swap
  // the model out from under a user); erasure rides C00 contacts_anonymise, never a second entry
  // point. Defined in `./voice-actions.ts` and spread in as one line, the same shape every sibling
  // uses.
  ...voiceActions({ ctxAction, ctxSchema, STR, INT }),

  // E06, ledger-grounded drafts. Three verbs (two writes, one read): generate a reply for an E04
  // thread through E05's OP6 adapter (the one inference door), grounded in the A16/A11/B00 READ
  // models ONLY for a contact whose own consent flag is on (the parameter can only force grounding
  // OFF, never on), and hand it to E04's Drafts write-back. NO send verb exists and none may be
  // added (P8 by construction); no prompt byte reaches the disk (draft_run stores prompt_sha256);
  // erasure rides C00 contacts_anonymise, never a second entry point. Defined in
  // `./draft-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...draftActions({ ctxAction, ctxSchema, STR, BOOL }),

  // E07, the offline proof & the honest threat model (the CAPSTONE of the local-first claim). Two
  // READS (no writes): `egress_self_test` installs a socket-level probe over every network vector and
  // runs the REAL E04/E05/E06 loop under it, reporting `passed:true, socketsOpened:0` only when it is
  // measured (never a simulation); `egress_status` is the standing indicator's observed-never-stored
  // read model. Both gate on `egress.read` and are deliberately readable by an agent auditing the
  // claim. No new screen, no new table, no money path. Defined in `./egress-actions.ts` and spread in
  // as one line, the same shape every sibling uses.
  ...egressActions({ ctxAction, ctxSchema }),

  // G04, data freedom (export / backup / restore / verify / delete + the API catalog). Four ctx
  // verbs gate on `manage_data_export`; `verify_backup` and `get_api_catalog` are pre-workspace
  // reads and `restore_backup` is the `create_workspace` shape (it MINTS the tenant), so all three
  // are deps verbs. `get_api_catalog` reads the whole surface lazily through `catalogActions`, which
  // resolves against `ACTIONS` at REQUEST time (fully built by then), so there is no init cycle.
  // Defined in `./data-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...dataActions({
    ctxAction,
    depsAction,
    ctxSchema,
    depsSchema,
    STR,
    BOOL,
    catalogActions: buildCatalogActions,
  }),

  // G07, global search. One READ over the declarative searchable-kind roster plus the G00
  // custom-field values, fenced per kind by that kind's own read capability in the engine (the F00
  // dashboards posture), so it owes no conformance write scenario and no idempotency key. Defined
  // in `./search-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...searchActions({ ctxAction, ctxSchema, STR, INT }),

  // H00, fixed-asset categories & defaults (Wave 12, plain master data, no money path): the six
  // asset_category_* verbs (create/update/archive/list/get/resolve_defaults) carrying the
  // depreciation and GL-account defaults H01 assets inherit. Defined in `./asset-actions.ts` and
  // spread in as one line, the same shape every sibling uses.
  ...assetActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // H08, Simple Maintenance Log (Wave 12, NON-POSTING): the five asset_maintenance_log_* verbs
  // (create/update/cancel/get/list), an append-oriented per-asset log with descriptive cost capture and
  // no GL side-effect. Defined in `./maintenance-actions.ts` and spread in as one line, the same shape
  // every sibling uses; appended right after the asset cluster it extends.
  ...maintenanceActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // H09, Asset Reports & Agent Tools (Wave 12, READ-ONLY): the six pure report verbs
  // (asset_register_report, asset_depreciation_forecast, asset_disposal_summary,
  // asset_acquisition_summary, asset_nbv_summary, asset_end_of_life_list) over the H00-H08 cluster.
  // Reconciliation and per-asset transaction history already ship inside H07 and are re-used, not
  // re-minted. Defined in `./asset-reports-actions.ts` and spread in as one line; appended after the
  // maintenance log it reports over.
  ...assetReportsActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // I00, requisitions (Wave 14, cluster I root, plain operational document, no money path): the eleven
  // requisition_* verbs (upsert/submit/approve/reject/return/convert_to_po/cancel/close + get/list/
  // my_pending_approvals) that open the procure-to-pay chain and convert approved demand into a D02 PO.
  // Defined in `./requisition-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...requisitionActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // J00, warehouses & locations (Wave 13, inventory root, plain master data, no money path): the
  // fifteen warehouse_* / location_* / inventory_* verbs. Warehouses on the `warehouse` table,
  // locations on D01's extended `stock_location` table (spec §4 Reconciliation), on-hand always the
  // SUM over the OP2 movement ledger. Defined in `./inventory-actions.ts` and spread in as one line.
  ...inventoryActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // J01, lot & serial tracking (Wave 13, inventory, plain master data, no money path): the eighteen
  // item_set_tracking_mode / lot_* / serial_* / inventory_on_hand_by_lot / inventory_available_serials
  // verbs. Lot and serial masters carry no quantity column; on-hand is the SUM over the OP2 movement
  // ledger (J02 fills the stock_movement.lot_id/serial_id extension points). Defined in
  // `./tracking-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...trackingActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // J02, the inventory movement ledger (Wave 13, inventory, MONEY-PATH: append-only quantity truth,
  // the OR 958c Bestandesnachweis): inventory_move, inventory_transfer, inventory_balance,
  // inventory_movement_list, inventory_movement_get, inventory_get_config, inventory_set_config. The
  // one write path for on-hand; on-hand is always SUM(stock_movement.qty), never a stored column, and
  // a movement row is immutable (BEFORE UPDATE/DELETE triggers). Defined in `./movement-actions.ts`
  // and spread in as one line, the same shape every sibling uses.
  ...movementActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // I02, the goods receipt (Wave 14, cluster I, MONEY-PATH by way of J02): the thirteen
  // goods_receipt_* verbs (create/upsert_lines/post/accept_lines/reject_lines/reverse/cancel/
  // set_config + preview/get/list/lines_for_match/get_config). The reversible, inspection-aware
  // document over a D02/I01 purchase order. It writes stock ONLY through J02's inventory_move, posts
  // no journal entry (P3), and maintains po_line.received_qty together with D02's shared
  // goods_receipt_line trail so the two can never disagree. Writes gate on manage_master_data and
  // reads on read_master_data (the D02 purchasing surface's own vocabulary). Defined in
  // `./receipt-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...receiptActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // J03, advanced valuation methods (Wave 13, inventory, MONEY-PATH: this is the figure that reaches
  // the balance sheet): inventory_valuation_preview, inventory_valuation_methods,
  // inventory_valuation_layers, inventory_valuation_method_history, and the three policy writes
  // inventory_valuation_method_set_enabled, inventory_valuation_set_default,
  // inventory_valuation_set_item_method. Pure calculators over the J02 ledger (weighted average,
  // FIFO layers, standard cost, and the compulsory OR 960c clamp), plus an append-only DATED method
  // assignment: resolution at an as-of date returns the method in force THEN, and the period lock
  // answers to effectiveFrom rather than the call date, so a closed year cannot be restated. J03
  // posts nothing; J06 takes these numbers to A02. Defined in `./valuation-actions.ts` and spread in
  // as one line, the same shape every sibling uses.
  ...valuationActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // J06, inventory valuation run & GL link (Wave 13, MONEY-PATH, OP11): the nine
  // inventory_valuation_* / inventory_reconciliation_* verbs (create / post / reverse / opening
  // writes, get / list / report / reconciliation_report / reconciliation_check reads). J06 is the ONLY
  // path an inventory valuation figure reaches the General Ledger: a run takes J03's computed valuation
  // (which already folds in I03 landed cost) and posts the delta against the live GL through ONE
  // balanced A02 entry (source `inventory_valuation`), and the reconciliation proves sub-ledger == GL.
  // Writes gate on `inventory.setup` (create) and `post` (post/reverse/opening), reads on
  // `read_master_data`. Defined in `./valuation-run-actions.ts` and spread in as one line.
  ...valuationRunActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // J04, cycle count / stocktake (Wave 13, inventory, MONEY-PATH): the nine inventory_stocktake_*
  // verbs (create / count / approve_lines / request_recount / commit / cancel writes, report / get /
  // list reads). A session freezes a J02 balance-as-of snapshot, accepts counts (blind or open),
  // surfaces variance against thresholds, and commits every non-zero variance EXCLUSIVELY as an OP13 /
  // J02 inventory_move (movement_type adjustment): J04 never writes a quantity, so on-hand stays the
  // SUM over the ledger. Writes gate on `manage_master_data` (the inventory_move register), reads on
  // `read_master_data`. Defined in `./stocktake-actions.ts` and spread in as one line.
  ...stocktakeActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  ...inventoryAdjustActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // I03, landed cost allocation (Wave 14, cluster I, MONEY-PATH): the six landed_cost_* verbs
  // (voucher_create / allocate_confirm / reverse writes, allocate_preview / list / get reads). A
  // voucher capitalises freight/duty/handling onto inventory by writing value-only J02 landed_cost
  // movements (qty 0, a signed cost_amount bound to the receipt movement) and ONE balanced A02 entry;
  // J03 folds the cost into the valuation and reverse nets it back out. Writes gate on
  // `procurement.landed_cost`, reads on `read_master_data`. Defined in `./landed-cost-actions.ts` and
  // spread in as one line, the same shape every sibling uses.
  ...landedCostActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // I04, the three-way match (Wave 14, cluster I): match_three_way_create / _override / _reverse
  // (the three writes) then _evaluate / _get / _list / _exceptions / match_status_for_bill (the five
  // reads). A first-class, pure, auditable elevation of D02's minimal match: it compares the A17 bill
  // aggregate against the I01 PO lines and I02 receipts, persists an immutable match (or an override
  // with a mandatory reason), gates payment, and reverses by restoring billed_qty. It POSTS NOTHING
  // (P3): it increments po_line.billed_qty and marks I02 receipt lines only; A17 -> A02 stays the sole
  // posting path. Writes gate on purchasing.match (override additionally on purchasing.match_override,
  // reverse on purchasing.match_override); reads on read_master_data. Defined in
  // `./three-way-match-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...threeWayMatchActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // I05, supplier performance (Wave 14, cluster I): five PURE READS deriving a supplier scorecard,
  // ranking, metric trend, metric explanation and threshold alerts from the live I02 goods receipts
  // and the D02 po_match trail (supplier_scorecard_get, supplier_performance_rank / _trend / _explain
  // / _alerts). Owns no table and writes nothing: every figure recomputes from source on each call, so
  // a scorecard is referentially transparent and never posts to the GL. Reads gate on read_master_data
  // (the D02/I01/I02 purchasing read domain). Defined in `./supplier-performance-actions.ts` and spread
  // in as one line, the same shape every sibling uses.
  ...supplierPerformanceActions({ ctxAction, ctxSchema, STR, INT }),
  // I06, procurement analytics & agent tools (Wave 14, cluster I): ten PURE READS over the live
  // I00-I05 + D02 documents (procurement_open_commitments, _match_status, _spend_summary,
  // _supplier_scorecard, _requisition_pipeline, _grir_clearing, _landed_cost_variance, _po_cycle,
  // _anomalies, _po_history). Owns no table and writes nothing: every figure is a pure projection of
  // the live po_line counters, the I04 three_way_match trail, the I00 requisitions, the I03 vouchers
  // and (for the scorecard) I05's own read, recomputed on each call. Reads gate on read_master_data
  // (the D02/I01/I02 purchasing read domain), the I05 posture. Defined in
  // `./procurement-analytics-actions.ts` and spread in as one line, the same shape every sibling uses.
  ...procurementAnalyticsActions({ ctxAction, ctxSchema, STR, INT, BOOL }),
  // J07, inventory agent tools & alerts (Wave 13, inventory, the TERMINAL leaf): ten PURE READS over
  // the whole J00-J06 cluster (inventory_stock_position, _low_stock, _valuation_status,
  // _movement_history, _anomalies, _cycle_count_status, _lot_trace, _slow_movers, _alerts,
  // _reorder_candidates). Owns no table and writes nothing (P5, §H-STOCK-AUDIT): on-hand is always
  // SUM(stock_movement.qty) and every figure is derived on the spot from the append-only J02 ledger
  // and the J03/J06 valuation reads, reusing inventoryValuationPreview / _Report / inventoryMovement
  // List / inventoryStocktakeList. Reads gate on read_master_data (the J00-J06 inventory read domain),
  // the I05/I06 posture. Defined in `./inventory-agent-actions.ts` and spread in as one line.
  ...inventoryAgentActions({ ctxAction, ctxSchema, STR, INT, BOOL }),

  // G17, in-product guidance. Two workspace-free READS over the authored Begriffe corpus (the
  // wording of record for GUI and agent alike), spread in as one line, the same shape every sibling
  // uses. `depsAction` rides along because the corpus is not tenant data: giving these verbs a
  // workspaceId would imply the explanation of a statutory election can differ per workspace, the
  // one property that must never exist (see ./guidance-actions.ts). G17 mints no write verb, no
  // table and no route, which is what keeps the product-tour genre unbuildable.
  ...guidanceActions({ depsAction, depsSchema, STR }),

  // M00, packaged local delivery. ONE workspace-free READ, `delivery_status`, describing the running
  // process (mode, version, schema generation, bound host/port, whether the Studio is served, the
  // scheduler tick), spread in as one line, the same shape every sibling uses. `depsAction` because
  // it precedes any workspace: it reports the process, not tenant data (see ./delivery-actions.ts).
  // M00 mints no write verb of its own: `till up` is a process launch, not a ledger action, and the
  // scheduler reuses G01's `run_due_automations` unchanged.
  ...deliveryActions({ depsAction, depsSchema }),
  // M02, the §I sync/publish contract (D106): two owner dials + four consumer reads. All six are ctx
  // verbs (workspace-scoped, §H-TENANT). The inbound lane is existing verbs, so nothing new here posts.
  ...syncActions({ ctxAction, ctxSchema, STR, INT }),
  // M03, deployment journeys: the Move record's resume-pointer pair (get_move_state /
  // advance_move_step), the G03 onboarding-pointer shape verbatim: workspace-scoped bookkeeping,
  // never a gate on any verb. Every other action on the M03 surfaces reuses an existing verb
  // (create_backup, archive_workspace, trial_balance), so nothing else registers here.
  ...moveActions({ ctxAction, ctxSchema, STR, BOOL, INT }),

  // N00, the environment landscape (D126, host-level).
  // The `env_*` family (Phase A): list/status/current reads and switch/create/reset/delete writes over
  // the tamper-evident, audited control file. Host-level, but ctx verbs so `landscape.manage` /
  // `landscape.read` resolve against the caller's workspace (managing the landscape is an owner act);
  // the ops work on the control file, not the ledger. Every write is P8-staged and host-idempotent.
  // policy=copy and copy-policy reset are Phase B. Defined in `./env-actions.ts` and spread in as one
  // line, the same shape every sibling uses.
  ...envActions({ ctxAction, ctxSchema, STR, BOOL, INT }),
];

/**
 * A35/G16: stamp the consequence sentence onto the money-path verbs, once, at load. The map lives in
 * `src/core/agent/dialMap.ts` beside the dial map it annotates; a name that resolves to no action
 * THROWS here, so the map cannot rot into decoration when a verb is renamed.
 */
for (const [name, consequence] of Object.entries(CONSEQUENCE_FOR_ACTION)) {
  const action = ACTIONS.find((a) => a.name === name);
  if (action === undefined) {
    throw new Error(`CONSEQUENCE_FOR_ACTION names '${name}', which is not a registered verb.`);
  }
  action.consequence = consequence;
}

/**
 * The whole tool surface as catalog rows for `get_api_catalog` (G04.4). Resolved lazily (called per
 * request, never at module load) so `ACTIONS` is fully constructed before it is read, and it reads
 * the SAME registry the P4 parity check reads, so the catalog can never drift from the live surface.
 */
function buildCatalogActions(): CatalogAction[] {
  return ACTIONS.map((a) => ({
    name: a.name,
    kind: a.kind,
    summary: a.summary,
    // A35 (critic F11): the catalog is the second machine consumer of the consequence sentence.
    ...(a.consequence === undefined ? {} : { consequence: a.consequence }),
    inputSchema: a.inputSchema,
    capabilities: requiredCapabilitiesFor(a.name, {}),
  }));
}

/**
 * A24's fail-closed check, run once at module load, over EVERY verb rather than only the writes.
 *
 * This is the line that makes "you cannot un-gate posting" structural rather than a convention. A
 * capability that appends a verb to `ACTIONS` and does not declare its gate in
 * `CAPABILITY_FOR_ACTION` cannot import this module at all: the MCP server, the REST twins, the
 * Studio bridge and every root suite fail here, at start-up, with the verb named.
 *
 * IT COVERS READS AS OF D50, and that is the whole point of touching it. The old call filtered to
 * `kind === 'write'`, so the guard could not see the forty-nine ungated reads and was silent about
 * the exact defect the wave critic reproduced. A24 is referenced by 74 of 90 specs: a read appended
 * by a capability that never opens this file has to fail loudly here rather than quietly serve the
 * ledger to a non-member.
 *
 * `reachesTheGate` is a ctx verb, identified the way every caller identifies one: a `depsAction` is
 * pre-workspace and carries no `workspaceId`, so a capability declared on it could never be
 * enforced, and the guard refuses that as its third check.
 */
assertEveryActionIsGated(
  ACTIONS.map((a) => ({
    name: a.name,
    kind: a.kind,
    reachesTheGate: a.inputSchema.required.includes('workspaceId'),
  })),
);

/**
 * G01's load-time handshake, the same shape as the line above it.
 *
 * The set of verbs a rule may name as its action IS the write half of this array, so G01 keeps no
 * allow-list of its own and a verb registered next year is a legal action the day it lands. The
 * dependency has to run api -> core to stay acyclic (`core/automation/` must never import this file),
 * which is why the set is handed over rather than imported. Until this line runs, G01 answers
 * `automation_unavailable` rather than pretending no verb is a write.
 */
registerWriteActions(ACTIONS.filter((a) => a.kind === 'write').map((a) => a.name));

/**
 * G02's load-time handshake, the same shape as the two lines above it, and the backbone of P3's
 * no-second-posting-path guarantee.
 *
 * The reserved money-path names a plugin manifest may never register or shadow ARE the A02 journal
 * front door plus the A14 settlement half's write verbs, single-sourced from the registry's OWN
 * action definitions (the A02 named consts and the captured `a14PaymentActions` group) rather than a
 * hand-copied literal that could drift. The full core tool-name set (for `capability_name_conflict`)
 * is every `ACTIONS` name. Both are handed to `core/plugins` here, api -> core, so the engine never
 * imports this file (acyclic), exactly like G01's `registerWriteActions` above.
 */
const MONEY_PATH_WRITE_TOOLS: readonly string[] = [
  postEntryAction.name,
  reverseEntryAction.name,
  saveDraftAction.name,
  // `delete_draft` is the one A02 write still defined inline in the list (its verb declares no
  // payload, so it is not hoisted to a const); named as a literal and drift-guarded just below.
  'delete_draft',
  ...a14PaymentActions.filter((a) => a.kind === 'write').map((a) => a.name),
];
// Drift guard: every reserved name MUST be a registered WRITE. If A02 or A14 renames a verb, this
// throws at load with the name, so the single source cannot silently lose a money-path tool.
for (const name of MONEY_PATH_WRITE_TOOLS) {
  const action = ACTIONS.find((a) => a.name === name);
  if (action === undefined || action.kind !== 'write') {
    throw new Error(
      `G02 reserved money-path tool '${name}' is not a registered write action: the P3 single source has drifted.`,
    );
  }
}
registerMoneyPathTools(MONEY_PATH_WRITE_TOOLS);
registerCoreToolNames(ACTIONS.map((a) => a.name));

/**
 * `get_document` with the A11 `include` extension. Reads the base document (A10), then attaches the
 * QR-bill payload (`qr`) and/or the rendered PDF (`pdf`) for an invoice when requested. Unknown include
 * keys are ignored; a QR/PDF resolution error rides as `{ qr|pdf: { error } }` so a partial read never
 * fails the whole document read.
 */
function getDocumentWithIncludes(ctx: WorkspaceContext, input: ActionInput): Result {
  const base = getDocument(ctx, as(input));
  if (!base.ok) return base;
  const include = Array.isArray(input.include) ? (input.include as string[]) : [];
  if (include.length === 0) return base;
  const extra: Record<string, unknown> = {};
  const documentId = typeof input.documentId === 'string' ? input.documentId : '';
  if (include.includes('qr')) {
    const qr = buildQrBill(ctx, documentId);
    extra.qr = qr.ok ? qr.qr : qr;
  }
  if (include.includes('pdf')) {
    // A13: a Gutschrift renders its own artifact (no QR-bill payment part); everything else keeps
    // the invoice renderer, whose own type guard answers for quotes and orders.
    const type = (base.document as { type?: string }).type;
    const pdf = type === 'credit_note' ? renderCreditNotePdf(ctx, documentId) : renderInvoicePdf(ctx, documentId);
    extra.pdf = pdf.ok ? pdf.pdf : pdf;
  }
  return { ...base, ...extra };
}

/** Look up an action by its tool name, or `undefined`. */
export function getAction(name: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.name === name);
}
