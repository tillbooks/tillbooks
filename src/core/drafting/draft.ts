/**
 * E06, ledger-grounded draft generation: the reply that is true, not just fluent.
 *
 * WHAT THIS MODULE IS. The payoff of the local-correspondence cluster (E04–E07): it reads a thread
 * E04 indexed, retrieves the closest exemplars through E05's `voice_retrieve` door, optionally
 * enriches the prompt with the A16/A11/B00 READ models for the ONE contact who consented, calls
 * the OP6 adapter through E05's `registeredRuntime()` (the only inference door in the product,
 * never a runtime named here), and hands the text to E04's draft write-back. The human reviews and
 * sends in their own mail client: TILL has no send verb and no SMTP, so P8 holds by construction.
 *
 * THE CONSENT GATE IS THE LOAD-BEARING PRIVACY CONTROL (US-E06.2, revDSG Art. 6 proportionality as
 * we read it). Grounding is READ from `contact.ledger_grounding_enabled` at generation time, and
 * the `groundInLedger` parameter can only force it OFF, never on: an agent cannot override a
 * client's opt-out by passing a flag, and a caller may always choose to be MORE private, never
 * less. An unresolved sender (null `contact_id`) never grounds, whatever any flag says. Grounding
 * additionally asserts A16's own read domain (`read_sales`) in-engine, so someone who may not see
 * the books cannot launder them through a draft. All four legs are asserted by the grounding
 * property test, not left to good sense.
 *
 * WHAT THIS MODULE IS NOT. It writes NOTHING financial: no `postEntry`, no `recordPayment`, no
 * import from `ledger/` or `payments/` (P3 by absence, asserted by
 * `test/drafting/no-financial-write-and-guards.test.mjs`). Amounts are consumed as A16's
 * already-rounded minor-unit output and only FORMATTED here (P2 round-once stays upstream). The
 * PROMPT NEVER REACHES THE DISK: `draft_run` stores `prompt_sha256` and no prompt/body/facts
 * column, and the generate RESPONSE deliberately returns `factsUsed` but NOT the draft body, so
 * neither the idempotency replay row nor any other SQLite row ever carries a byte of the
 * composition (the §8 sentinel fixture proves it against the raw database file). It stamps NO
 * audit rows (the E04/E05/G00 posture) and emits NO automation event (reconciled spec §6b: the
 * cluster's automation surface is empty, and both writes sit in `NOT_AUTOMATABLE`).
 *
 * TENANCY (§H-TENANT): every query filters on `ctx.workspaceId`, so a foreign thread, profile or
 * run id answers the same `not_found` a nonexistent one does, and the ledger reads are the
 * workspace-scoped A16/A11/B00 verbs themselves, so a Treuhänder on client X's workspace can
 * never ground a draft in client Y's books.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { ADAPTERS, bodySha256, writeMailDraft, replaceMailDraft } from '../mail/index.js';
import type { MailStoreAdapter } from '../mail/index.js';
import { registeredRuntime, retrieveVoiceExemplars } from '../voice/index.js';
// A16's per-customer read model (it composes the same open items `list_open_items` reports, plus
// the parked credits): the ONE door E06 takes into the debtors position.
import { customerBalance } from '../debtors/index.js';
import { listDocuments } from '../sales/index.js';
import { listProjects } from '../projects/index.js';
import type { DraftRunStatus } from './enums.js';

interface DraftRunRow {
  id: string;
  workspace_id: string;
  thread_id: string;
  profile_id: string | null;
  grounded: number;
  runtime_id: string | null;
  model_ref: string | null;
  prompt_sha256: string | null;
  status: string;
  actor: string;
  started_at: string;
  ended_at: string;
}

interface ThreadRow {
  id: string;
  workspace_id: string;
  account_id: string;
  thread_key: string;
  subject: string | null;
  contact_id: string | null;
}

interface AccountRow {
  id: string;
  workspace_id: string;
  adapter: string;
  address: string;
  store_path: string;
}

interface MessageRow {
  id: string;
  direction: string;
  store_ref: string;
  body_sha256: string;
  sent_at: string | null;
}

interface ProfileRow {
  id: string;
  account_id: string;
  style_card: string;
}

function mapRun(row: DraftRunRow) {
  return {
    id: row.id,
    threadId: row.thread_id,
    profileId: row.profile_id,
    grounded: row.grounded === 1,
    runtimeId: row.runtime_id,
    modelRef: row.model_ref,
    promptSha256: row.prompt_sha256,
    status: row.status,
    actor: row.actor,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function readThread(ctx: WorkspaceContext, threadId: unknown): ThreadRow | undefined {
  if (typeof threadId !== 'string' || threadId.length === 0) return undefined;
  return ctx.store.db
    .prepare('SELECT * FROM mail_thread WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, threadId) as ThreadRow | undefined;
}

function readAccount(ctx: WorkspaceContext, accountId: string): AccountRow | undefined {
  return ctx.store.db
    .prepare('SELECT * FROM mail_account WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, accountId) as AccountRow | undefined;
}

function adapterOf(account: AccountRow): MailStoreAdapter {
  const adapter = ADAPTERS[account.adapter as keyof typeof ADAPTERS];
  if (adapter === undefined) throw new Error(`mail_account ${account.id} names unknown adapter '${account.adapter}'`);
  return adapter;
}

/** The RFC-5322 body without its headers: the reply is to the prose, not the routing. */
function stripHeaders(raw: string): string {
  const separator = /\r?\n\r?\n/.exec(raw);
  return separator === null ? raw : raw.slice(separator.index + separator[0].length);
}

/**
 * Swiss presentation of a minor-unit amount: `CHF 1'234.55`. FORMATTING ONLY, deliberately no
 * arithmetic beyond the fixed split into francs and rappen: the amount arrives already rounded
 * from A16's read model, and P2's round-once discipline is never re-entered here (spec §4).
 */
export function formatAmount(minor: number, currency: string): string {
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100).toString();
  const rappen = (abs % 100).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, "'");
  return `${negative ? '-' : ''}${currency} ${grouped}.${rappen}`;
}

/** `TT.MM.JJJJ`, the DESIGN.md date form, from an ISO date. A malformed date passes through. */
function formatDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m === null ? iso : `${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * The ledger facts for ONE consented contact, as display strings (US-E06.2). ONLY the read models
 * the spec names may ground a draft: A16 `list_open_items` + `customer_balance`, the A11 status of
 * an invoice the thread names, B00 project state, and nothing else (spec §6b Fixed). If a fact is
 * not already exposed by one of those reads, it does not enter a draft: that is why a settled
 * invoice is stated as PAID with its amount but without a settlement date (the date lives in A14,
 * which is not on the list).
 */
function collectLedgerFacts(ctx: WorkspaceContext, contactId: string, threadText: string): string[] {
  const facts: string[] = [];

  const balance = customerBalance(ctx, { customerId: contactId }) as {
    ok: boolean;
    items?: { kind: string; number: string | null; openMinor: number; currency: string; dueDate: string | null; daysOverdue: number; overdue: boolean }[];
    baseTotalOpenMinor?: number;
    baseCurrency?: string;
    onAccountMinor?: number;
  };
  if (balance.ok === true && balance.items !== undefined) {
    const base = balance.baseCurrency ?? 'CHF';
    if (balance.items.length > 0) {
      facts.push(`Offener Saldo: ${formatAmount(balance.baseTotalOpenMinor ?? 0, base)}`);
    }
    for (const item of balance.items.slice(0, 8)) {
      if (item.kind !== 'document') continue;
      const label = item.number === null ? 'Rechnung' : `Rechnung ${item.number}`;
      const due = item.dueDate === null ? '' : `, fällig am ${formatDay(item.dueDate)}`;
      const overdue = item.overdue ? `, ${item.daysOverdue} Tage überfällig` : '';
      facts.push(`${label}: offen ${formatAmount(item.openMinor, item.currency)}${due}${overdue}`);
    }
    if ((balance.onAccountMinor ?? 0) > 0) {
      facts.push(`Guthaben (Vorauszahlung): ${formatAmount(balance.onAccountMinor ?? 0, base)}`);
    }
  }

  // A11: the status of any invoice the thread NAMES that is not already an open item above, so
  // "habe ich die Rechnung vom Januar schon bezahlt?" is answered from the books (the payoff).
  const documents = listDocuments(ctx, { type: 'invoice', contactId }) as {
    ok: boolean;
    documents?: { number: string | null; status: string; totalMinor: number; currency: string }[];
  };
  if (documents.ok === true && documents.documents !== undefined) {
    const openNumbers = new Set(
      (balance.items ?? []).map((item) => item.number).filter((n): n is string => n !== null),
    );
    for (const doc of documents.documents) {
      if (doc.number === null || openNumbers.has(doc.number)) continue;
      if (!threadText.includes(doc.number)) continue;
      const paid = doc.status === 'settled' ? 'bezahlt' : doc.status === 'partially_paid' ? 'teilweise bezahlt' : doc.status;
      facts.push(`Rechnung ${doc.number}: ${paid}, Betrag ${formatAmount(doc.totalMinor, doc.currency)}`);
    }
  }

  // B00: the client's project state, so "wie steht es um X?" drafts against the plan of record.
  const projects = listProjects(ctx, { contactId }) as {
    ok: boolean;
    projects?: { code: string | null; name: string; status: string }[];
  };
  if (projects.ok === true && projects.projects !== undefined) {
    for (const project of projects.projects.slice(0, 5)) {
      const code = project.code === null ? '' : `${project.code} `;
      facts.push(`Projekt ${code}${project.name}: Status ${project.status}`);
    }
  }

  return facts.slice(0, 12);
}

export interface DraftContextInput {
  subject: string | null;
  clientMessage: string;
  exemplars: readonly string[];
  styleCard: Record<string, unknown>;
  hint?: string | undefined;
  /** undefined = ungrounded (no ledger section AT ALL); [] = grounded with no history. */
  ledgerFacts?: readonly string[] | undefined;
}

/**
 * PURE (spec §4): assemble the prompt and return `{ prompt, factsUsed }` so the GUI can show what
 * the draft was told (US-E06.3). One consumer, so it stays in this module rather than becoming a
 * pattern, exactly as `parseRecurrence` sits inside E03. An UNGROUNDED context carries no ledger
 * section at all, so the model is never told a figure it should not repeat; a grounded context
 * with no history says so in words rather than inviting invention.
 */
export function buildDraftContext(input: DraftContextInput): { prompt: string; factsUsed: string[] } {
  const card = input.styleCard;
  const styleLines = [
    typeof card.greeting === 'string' ? `Anrede: ${card.greeting}` : undefined,
    typeof card.signOff === 'string' ? `Grussformel: ${card.signOff}` : undefined,
    typeof card.formality === 'string' ? `Anredeform: ${card.formality}` : undefined,
    typeof card.meanSentenceWords === 'number' ? `Mittlere Satzlänge: ${card.meanSentenceWords} Wörter` : undefined,
    typeof card.medianReplyLines === 'number' ? `Typische Antwortlänge: ${card.medianReplyLines} Zeilen` : undefined,
  ].filter((line): line is string => line !== undefined);

  const sections: string[] = [
    'Du schreibst einen Antwortentwurf im Namen der Praxis. Der Mensch prüft und sendet ihn selbst.',
  ];
  if (styleLines.length > 0) sections.push(`Schreibstil (aus dem eigenen Korpus destilliert):\n${styleLines.join('\n')}`);
  if (input.exemplars.length > 0) {
    const samples = input.exemplars
      .map((body) => body.trim().slice(0, 600))
      .filter((body) => body.length > 0)
      .map((body, i) => `Beispiel ${i + 1}:\n${body}`);
    if (samples.length > 0) sections.push(`Frühere Antworten als Stilreferenz:\n${samples.join('\n---\n')}`);
  }
  const factsUsed = [...(input.ledgerFacts ?? [])];
  if (input.ledgerFacts !== undefined) {
    sections.push(
      factsUsed.length === 0
        ? 'Fakten aus der Buchhaltung: Keine Buchhaltungsdaten für diesen Kontakt. Erfinde keine Zahlen.'
        : `Fakten aus der Buchhaltung (NUR diese verwenden, nichts erfinden):\n${factsUsed.map((f) => `- ${f}`).join('\n')}`,
    );
  }
  sections.push(
    `Neue Nachricht des Kunden${input.subject === null ? '' : ` (Betreff: ${input.subject})`}:\n${input.clientMessage.trim()}`,
  );
  if (input.hint !== undefined && input.hint.trim().length > 0) {
    sections.push(`Hinweis für diese Fassung: ${input.hint.trim()}`);
  }
  sections.push('Schreibe nur den Antworttext, ohne Betreffzeile.');
  return { prompt: sections.join('\n\n'), factsUsed };
}

interface AttemptOptions {
  thread: ThreadRow;
  account: AccountRow;
  adapter: MailStoreAdapter;
  profileId?: string | undefined;
  groundInLedger?: boolean | undefined;
  hint?: string | undefined;
  /** Set on regenerate: the existing mail_draft row to replace instead of writing a second one. */
  replaceDraftId?: string | undefined;
  idempotencyKey?: string | undefined;
}

function insertRun(
  ctx: WorkspaceContext,
  opts: AttemptOptions,
  fields: {
    status: DraftRunStatus;
    grounded: boolean;
    profileId: string | null;
    runtimeId: string | null;
    modelRef: string | null;
    promptSha256: string | null;
    startedAt: string;
  },
): DraftRunRow {
  const id = ctx.ids.next('draftrun');
  ctx.store.db
    .prepare(
      `INSERT INTO draft_run (id, workspace_id, thread_id, profile_id, grounded, runtime_id, model_ref, prompt_sha256, status, actor, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ctx.workspaceId,
      opts.thread.id,
      fields.profileId,
      fields.grounded ? 1 : 0,
      fields.runtimeId,
      fields.modelRef,
      fields.promptSha256,
      fields.status,
      ctx.actor,
      fields.startedAt,
      ctx.clock.now(),
    );
  return ctx.store.db
    .prepare('SELECT * FROM draft_run WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, id) as DraftRunRow;
}

/**
 * One generation attempt, shared by generate and regenerate. Runs INSIDE the idempotency wrapper,
 * so a refusal that records a `draft_run` row records it exactly once per key (§H-IDEMPOTENT).
 */
function attemptGeneration(ctx: WorkspaceContext, opts: AttemptOptions): Result {
  const startedAt = ctx.clock.now();

  // US-E06.1 Empty: a thread whose newest message is already outbound is not drafted against. We
  // do not invent a reason to write to a client. No run row: nothing was attempted.
  const newest = ctx.store.db
    .prepare(
      `SELECT id, direction, store_ref, body_sha256, sent_at FROM mail_message
        WHERE workspace_id = ? AND thread_id = ?
        ORDER BY sent_at DESC, indexed_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, opts.thread.id) as MessageRow | undefined;
  if (newest === undefined || newest.direction !== 'inbound') {
    return err('nothing_to_reply_to', { threadId: opts.thread.id });
  }

  // The source read, ON DEMAND from the store (OP6): a moved message is `needs_mailstore`
  // (recorded, so the failed work is visible), a changed one refuses with `source_changed`
  // (US-E06.1 Boundary: a draft built on a message that moved under it is built on sand).
  const raw = opts.adapter.readBody(opts.account.store_path, newest.store_ref);
  if (raw === undefined) {
    const run = insertRun(ctx, opts, {
      status: 'needs_mailstore',
      grounded: false,
      profileId: null,
      runtimeId: null,
      modelRef: null,
      promptSha256: null,
      startedAt,
    });
    return err('needs_mailstore', { threadId: opts.thread.id, draftRunId: run.id });
  }
  if (bodySha256(raw) !== newest.body_sha256) {
    return err('source_changed', { threadId: opts.thread.id, messageId: newest.id });
  }
  const clientMessage = stripHeaders(raw);

  // The voice profile: named explicitly, or the newest for this account (US-E06.1 Error:
  // `needs_voice_profile` links to Schreibstil rather than drafting voiceless).
  let profile: ProfileRow | undefined;
  if (opts.profileId !== undefined) {
    profile = ctx.store.db
      .prepare('SELECT id, account_id, style_card FROM voice_profile WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, opts.profileId) as ProfileRow | undefined;
    if (profile === undefined) return err('not_found', { profileId: opts.profileId });
  } else {
    profile = ctx.store.db
      .prepare(
        `SELECT id, account_id, style_card FROM voice_profile
          WHERE workspace_id = ? AND account_id = ? ORDER BY built_at DESC, id DESC LIMIT 1`,
      )
      .get(ctx.workspaceId, opts.account.id) as ProfileRow | undefined;
    if (profile === undefined) return err('needs_voice_profile', { accountId: opts.account.id });
  }

  // E05's OP6 seam: the ONE inference door. No adapter registered is an honest structural refusal
  // (no cloud fallback exists to fall back to), recorded so the failed work is visible.
  const registration = registeredRuntime();
  if (registration === undefined) {
    const run = insertRun(ctx, opts, {
      status: 'needs_local_runtime',
      grounded: false,
      profileId: profile.id,
      runtimeId: null,
      modelRef: null,
      promptSha256: null,
      startedAt,
    });
    return err('needs_local_runtime', { draftRunId: run.id });
  }

  // THE CONSENT GATE (US-E06.2). Grounding is true iff the sender RESOLVED to a contact, that
  // contact's own flag is on, the parameter did not force it off, and the actor holds A16's read
  // domain. The parameter can only narrow; nothing can widen. Asserted by the property test.
  let grounded = false;
  if (opts.thread.contact_id !== null) {
    const contact = ctx.store.db
      .prepare('SELECT ledger_grounding_enabled FROM contact WHERE workspace_id = ? AND id = ?')
      .get(ctx.workspaceId, opts.thread.contact_id) as { ledger_grounding_enabled: number } | undefined;
    const consented = contact !== undefined && contact.ledger_grounding_enabled === 1;
    const forcedOff = opts.groundInLedger === false;
    const maySeeBooks = ctx.capabilities.assert('read_sales').ok;
    grounded = consented && !forcedOff && maySeeBooks;
  }
  const ledgerFacts = grounded
    ? collectLedgerFacts(ctx, opts.thread.contact_id as string, `${opts.thread.subject ?? ''}\n${clientMessage}`)
    : undefined;

  // E05's retrieval door: the closest exemplars to the client's message. A retrieval failure
  // degrades to a style-card-only prompt rather than refusing the draft.
  const retrieved = retrieveVoiceExemplars(ctx, {
    profileId: profile.id,
    queryText: clientMessage.slice(0, 800),
    k: 3,
  }) as { ok: boolean; items?: { body: string }[] };
  const exemplars = retrieved.ok === true && retrieved.items !== undefined ? retrieved.items.map((i) => i.body) : [];

  let styleCard: Record<string, unknown>;
  try {
    styleCard = JSON.parse(profile.style_card) as Record<string, unknown>;
  } catch {
    styleCard = {};
  }

  const context = buildDraftContext({
    subject: opts.thread.subject,
    clientMessage,
    exemplars,
    styleCard,
    hint: opts.hint,
    ledgerFacts,
  });

  // The completion, through the registered adapter. A thrown adapter is a FAILED run on the
  // record, never a silent loss and never a 500 (P9).
  let body: string;
  try {
    body = registration.adapter.complete(context.prompt);
  } catch {
    const run = insertRun(ctx, opts, {
      status: 'failed',
      grounded,
      profileId: profile.id,
      runtimeId: registration.adapter.id,
      modelRef: registration.adapter.modelRef,
      promptSha256: bodySha256(context.prompt),
      startedAt,
    });
    return err('generation_failed', { draftRunId: run.id });
  }
  if (typeof body !== 'string' || body.trim().length === 0) {
    const run = insertRun(ctx, opts, {
      status: 'failed',
      grounded,
      profileId: profile.id,
      runtimeId: registration.adapter.id,
      modelRef: registration.adapter.modelRef,
      promptSha256: bodySha256(context.prompt),
      startedAt,
    });
    return err('generation_failed', { draftRunId: run.id });
  }

  // The run row FIRST (its id rides the mail_draft row as provenance), then the E04 write. The
  // whole attempt runs inside one transaction, so a failed write leaves the row stamped 'failed'
  // and nothing half-done.
  const runId = ctx.ids.next('draftrun');
  ctx.store.db
    .prepare(
      `INSERT INTO draft_run (id, workspace_id, thread_id, profile_id, grounded, runtime_id, model_ref, prompt_sha256, status, actor, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      runId,
      ctx.workspaceId,
      opts.thread.id,
      profile.id,
      grounded ? 1 : 0,
      registration.adapter.id,
      registration.adapter.modelRef,
      bodySha256(context.prompt),
      'ok',
      ctx.actor,
      startedAt,
      ctx.clock.now(),
    );

  const written =
    opts.replaceDraftId === undefined
      ? writeMailDraft(ctx, {
          threadId: opts.thread.id,
          body,
          draftRunId: runId,
          ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: `${opts.idempotencyKey}:w` }),
        })
      : replaceMailDraft(ctx, {
          draftId: opts.replaceDraftId,
          body,
          draftRunId: runId,
          ...(opts.idempotencyKey === undefined ? {} : { idempotencyKey: `${opts.idempotencyKey}:w` }),
        });
  if (!written.ok) {
    ctx.store.db
      .prepare('UPDATE draft_run SET status = ?, ended_at = ? WHERE workspace_id = ? AND id = ?')
      .run('failed', ctx.clock.now(), ctx.workspaceId, runId);
    return written;
  }

  const row = ctx.store.db
    .prepare('SELECT * FROM draft_run WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, runId) as DraftRunRow;
  // DELIBERATELY NOT RETURNED: the draft body AND the facts strings. The idempotency replay row
  // serialises this Result into SQLite, so anything returned here reaches the disk through the
  // back door: the body is composed from Art. 321 material, and a facts string is a composition
  // artefact the sentinel fixture scans for. The pane reads the body ON DEMAND via `draft_list`
  // from the Drafts folder (OP6 index-never-copy), and renders its verification block from the
  // LIVE A16/A11/B00 reads under the caller's own `read_sales`, which is a stronger check than
  // replaying what the draft was told: it shows the current truth to verify the claim against.
  return ok({
    draftRunId: runId,
    run: mapRun(row),
    draftId: (written as { ok: true; draftId?: string }).draftId ?? null,
    grounded,
    factsCount: context.factsUsed.length,
  });
}

export interface GenerateDraftInput {
  threadId: string;
  profileId?: string;
  groundInLedger?: boolean;
  idempotencyKey?: string;
}

/** US-E06.1: generate the draft reply for a thread. See the module header for the whole contract. */
export function generateDraft(ctx: WorkspaceContext, input: GenerateDraftInput): Result {
  const thread = readThread(ctx, input.threadId);
  if (thread === undefined) return err('not_found', { threadId: input.threadId });
  const account = readAccount(ctx, thread.account_id);
  if (account === undefined) return err('not_found', { accountId: thread.account_id });
  const adapter = adapterOf(account);
  if (input.groundInLedger !== undefined && typeof input.groundInLedger !== 'boolean') {
    return err('invalid_input', { field: 'groundInLedger' });
  }

  const opts: AttemptOptions = {
    thread,
    account,
    adapter,
    profileId: input.profileId,
    groundInLedger: input.groundInLedger,
    idempotencyKey: input.idempotencyKey,
  };
  const run = (): Result => attemptGeneration(ctx, opts);
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'draft_generate', run);
  }
  return ctx.store.tx(run);
}

export interface RegenerateDraftInput {
  draftRunId: string;
  hint?: string;
  idempotencyKey?: string;
}

/**
 * US-E06.4: re-run a draft with an optional plain-language hint, writing a NEW `draft_run` row
 * (append-only in spirit: the sequence of attempts stays interpretable) and REPLACING the Drafts
 * message via E04 rather than adding a second one. A draft the user already sent or deleted is
 * `draft_gone` and is NOT re-created: once it is sent, it is theirs.
 */
export function regenerateDraft(ctx: WorkspaceContext, input: RegenerateDraftInput): Result {
  if (typeof input.draftRunId !== 'string' || input.draftRunId.length === 0) {
    return err('invalid_input', { field: 'draftRunId' });
  }
  if (input.hint !== undefined && typeof input.hint !== 'string') {
    return err('invalid_input', { field: 'hint' });
  }
  const prior = ctx.store.db
    .prepare('SELECT * FROM draft_run WHERE workspace_id = ? AND id = ?')
    .get(ctx.workspaceId, input.draftRunId) as DraftRunRow | undefined;
  if (prior === undefined) return err('not_found', { draftRunId: input.draftRunId });
  const thread = readThread(ctx, prior.thread_id);
  if (thread === undefined) return err('draft_gone', { draftRunId: prior.id });
  const account = readAccount(ctx, thread.account_id);
  if (account === undefined) return err('not_found', { accountId: thread.account_id });
  const adapter = adapterOf(account);

  // The Drafts message this run produced (or, for a retried run, the thread's latest TILL draft).
  const draft = ctx.store.db
    .prepare(
      `SELECT id, store_ref FROM mail_draft
        WHERE workspace_id = ? AND thread_id = ?
        ORDER BY (draft_run_id = ?) DESC, created_at DESC LIMIT 1`,
    )
    .get(ctx.workspaceId, thread.id, prior.id) as { id: string; store_ref: string } | undefined;
  if (draft === undefined) return err('draft_gone', { draftRunId: prior.id });
  if (adapter.readBody(account.store_path, draft.store_ref) === undefined) {
    return err('draft_gone', { draftRunId: prior.id });
  }

  const opts: AttemptOptions = {
    thread,
    account,
    adapter,
    profileId: prior.profile_id ?? undefined,
    hint: input.hint,
    replaceDraftId: draft.id,
    idempotencyKey: input.idempotencyKey,
  };
  const run = (): Result => attemptGeneration(ctx, opts);
  if (typeof input.idempotencyKey === 'string' && input.idempotencyKey.length > 0) {
    return ctx.store.rememberIdempotent(ctx.workspaceId, input.idempotencyKey, 'draft_regenerate', run);
  }
  return ctx.store.tx(run);
}

export interface ListDraftRunsInput {
  threadId?: string;
  /** false skips the on-demand Drafts-folder body reads (the F01 report source's metadata-only path). */
  includeBodies?: boolean;
}

/**
 * US-E06.3: the draft runs, newest first, joined to E04's `mail_draft` and each surviving draft's
 * BODY READ ON DEMAND from the Drafts-folder locator, never from SQLite (OP6). `draftGone` says
 * the human sent or deleted it in their own client; `modelChanged` says the registered runtime's
 * model no longer matches the one that wrote it ("Mit einem anderen Modell erstellt."). A read:
 * leaves the database byte-identical.
 */
export function listDraftRuns(ctx: WorkspaceContext, input: ListDraftRunsInput = {}): Result {
  if (input.threadId !== undefined && readThread(ctx, input.threadId) === undefined) {
    return err('not_found', { threadId: input.threadId });
  }
  const clauses = ['workspace_id = ?'];
  const params: string[] = [ctx.workspaceId];
  if (input.threadId !== undefined) {
    clauses.push('thread_id = ?');
    params.push(input.threadId);
  }
  const rows = ctx.store.db
    .prepare(`SELECT * FROM draft_run WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC, id DESC`)
    .all(...params) as DraftRunRow[];

  const registration = registeredRuntime();
  const runs = rows.map((row) => {
    const draft = ctx.store.db
      .prepare('SELECT id, store_ref, account_id FROM mail_draft WHERE workspace_id = ? AND draft_run_id = ?')
      .get(ctx.workspaceId, row.id) as { id: string; store_ref: string; account_id: string } | undefined;
    let body: string | null = null;
    let draftGone = row.status === 'ok';
    if (input.includeBodies === false) {
      draftGone = false;
    } else if (draft !== undefined) {
      const account = readAccount(ctx, draft.account_id);
      if (account !== undefined) {
        const raw = adapterOf(account).readBody(account.store_path, draft.store_ref);
        if (raw !== undefined) {
          body = stripHeaders(raw);
          draftGone = false;
        }
      }
    }
    return {
      ...mapRun(row),
      draftId: draft?.id ?? null,
      body,
      draftGone,
      modelChanged:
        registration !== undefined && row.model_ref !== null && registration.adapter.modelRef !== row.model_ref,
    };
  });
  return ok({ runs, total: runs.length });
}

/**
 * revDSG erasure (spec §8): purge every `draft_run` referencing the erased person's threads. Runs
 * INSIDE C00 `contacts_anonymise`'s transaction, BEFORE `purgeMailForContact` (it needs the
 * `mail_thread` rows to find its own), exactly as E05's exemplar purge does. The Drafts folder on
 * disk stays untouched: TILL erases what TILL derived, and the mail client is not ours to delete
 * from. DELIBERATELY NOT AN MCP TOOL: erasure is C00's single entry point.
 */
export function purgeDraftRunsForContact(ctx: WorkspaceContext, contactIds: readonly string[]): {
  draftRuns: number;
} {
  if (contactIds.length === 0) return { draftRuns: 0 };
  const placeholders = contactIds.map(() => '?').join(', ');
  const draftRuns = ctx.store.db
    .prepare(
      `DELETE FROM draft_run
        WHERE workspace_id = ? AND thread_id IN (
          SELECT t.id FROM mail_thread t
           WHERE t.workspace_id = ? AND (
             t.contact_id IN (${placeholders})
             OR EXISTS (SELECT 1 FROM mail_message m WHERE m.thread_id = t.id AND m.contact_id IN (${placeholders}))
           )
        )`,
    )
    .run(ctx.workspaceId, ctx.workspaceId, ...contactIds, ...contactIds).changes;
  return { draftRuns };
}
