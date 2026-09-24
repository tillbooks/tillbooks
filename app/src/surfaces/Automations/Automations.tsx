/**
 * G01, the Automatisierungen surface: every rule this workspace runs unattended, and every time one ran.
 *
 * WHY A SCREEN AT ALL, against the canon's high bar for adding one. This is the only subsystem in TILL
 * that writes to the ledger with nobody watching, and there is exactly one question an operator must
 * be able to answer about it: "what is running, and what did it do?" No existing surface can answer
 * either half. A per-entity panel scattered across fifteen screens would answer it fifteen times and
 * therefore never, and the Verlauf half has no natural home anywhere else at all.
 *
 * TWO TABS, REGELN AND VERLAUF, and the split is not decoration. Regeln is configuration and needs
 * `manage_automations`; Verlauf is a read anyone who can open the workspace may have, and it is the
 * half a person reaches for when something has already gone wrong. Gating the history behind the
 * capability that CAUSED the problem would be exactly backwards.
 *
 * DEAKTIVIEREN IS THE ONE CONTROL THAT IS NEVER DISABLED, and that is the visible half of the engine's
 * decision. Every other write control is pre-disabled for an actor without `manage_automations`,
 * because the canon forbids showing a control that will always reject on click. The stop button is
 * ungated in the engine (`core/access/actionCapabilities.ts` carries the reasoning), so hiding it here
 * would be the screen lying about what the person is allowed to do, on the one control that matters
 * most when a rule is misbehaving.
 *
 * THE PICKERS ARE FED BY THE ENGINE, NOT MIRRORED. `list_automation_rules` returns a `catalogue` of
 * every registered trigger event, every legal action verb and every condition operator, read off the
 * live registries. A hand-copied list here would drift the first time a capability registers an event,
 * and the drift would show up as a rejection the operator cannot explain.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { CATALOG, useI18n, useT, type Locale } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Select } from '../../components/Select';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Tabs, type TabItem } from '../../components/Tabs';
import { Status, type StatusKind } from '../../components/Status';
import type { OverflowMenuItem } from '../../components/OverflowMenu';
import { useSeatNames } from '../../app/useSeatNames';
import './Automations.css';

/** §H-IDEMPOTENT: a retry with the same key never double-acts. */
function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

export interface CatalogueEvent {
  event: string;
  entityKind: string | null;
  emittedBy: string | null;
  schedule: boolean;
}

export interface Catalogue {
  events: readonly CatalogueEvent[];
  actions: readonly string[];
  ops: readonly string[];
}

/**
 * THE PAYLOAD IS NULLABLE ON THE WIRE, and the null is not "empty".
 *
 * `core/automation/disclosure.ts` gates the payload PER ROW, because `read_automations` buys the
 * automation facts while the payload belongs to the domain of the verb that fired. A reader who
 * could not have made that call themselves gets `inputTemplate: null` plus a `withheld` capability
 * naming what would unlock it, rather than a row that silently omits the field: a built-in `viewer`
 * could read an invitee's email out of a rule template before this existed.
 *
 * Declaring these non-nullable compiled fine and was simply untrue, which is the worst kind of type:
 * it type-checks every `null` the engine sends straight into the render.
 */
export interface RuleDto {
  ruleId: string;
  name: string;
  trigger: { event: string; entityKind: string | null; schedule: boolean };
  condition: unknown;
  action: { tool: string; inputTemplate: Record<string, unknown> | null };
  /** The capability that would unlock the template, or null when nothing was held back. */
  withheld: string | null;
  enabled: boolean;
  archived: boolean;
  createdBy: string;
  lastFiredAt: string | null;
}

export interface RunDto {
  runId: string;
  ruleId: string;
  ruleName: string | null;
  event: string;
  status: string;
  actionTool: string;
  /** What the rule actually SENT, resolved. Null when withheld: see `withheld`. */
  actionInput: Record<string, unknown> | null;
  /** The capability that would unlock `actionInput`, or null when nothing was held back. */
  withheld: string | null;
  errorCode: string | null;
  actor: string;
  /** How many times this occurrence was delivered again after it was already accounted for. */
  redeliveries: number;
  startedAt: string;
}

type Tab = 'rules' | 'runs';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ok'; rules: readonly RuleDto[]; runs: readonly RunDto[]; catalogue: Catalogue };

interface Feedback {
  tone: 'success' | 'error';
  text: string;
}

interface DraftRule {
  name: string;
  event: string;
  tool: string;
  inputTemplate: string;
}

/**
 * A run outcome as glyph AND text, never colour alone (WCAG 2.2 AA).
 *
 * The two suppression statuses get their own marks rather than collapsing into "failed", because
 * they are a different fact: the rule was fine and the engine stopped a loop. An operator who reads
 * "failed" there goes looking for a bug in their rule that is not present.
 */
const RUN_STATUS_KIND: Record<string, StatusKind> = {
  ok: 'success',
  failed: 'danger',
  skipped_condition: 'inactive',
  suppressed_loop: 'warn',
  suppressed_depth: 'warn',
  running: 'pending',
};

/**
 * K-38 (D137): a machine id on screen reads as words. A verb takes the product's own label where one
 * exists (the agent trace's and the palette's), and any other id at least loses its snake_case and
 * dots ("contact.created" reads "Contact created"), so no raw engine key reaches a table cell.
 */
function humanizeId(id: string): string {
  const words = id.replace(/[._]+/g, ' ').trim();
  return words.length === 0 ? id : words.charAt(0).toUpperCase() + words.slice(1);
}

/** A catalogue entry, or undefined: a quiet probe (the `t` of a miss logs, by design). */
function catalogueEntry(locale: Locale, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>(
      (node, part) => (node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      CATALOG[locale],
    );
  return typeof value === 'string' ? value : undefined;
}

function verbLabel(locale: Locale, tool: string): string {
  for (const key of [`agent.verb.${tool}`, `command.${tool}.label`]) {
    const label = catalogueEntry(locale, key);
    if (label !== undefined) return label;
  }
  return humanizeId(tool);
}

/**
 * de-CH renders `29.07.2026 14:32`; the wire is always an ISO UTC instant (P11, `core/clock.ts`).
 *
 * THE DATE ALONE IS NOT AN ANSWER HERE, which is why this is not the shared `formatDate`. Everywhere
 * else in the Studio a date identifies a business fact (a posting date, a due date) and the time of
 * day is noise. A run log is the opposite: a rule can fire forty times between breakfast and lunch,
 * and forty rows all reading `29.07.2026` cannot be ordered, cannot be matched against anything a
 * person remembers, and cannot answer "did this fire before or after I changed it?". That is the
 * whole question the Verlauf exists for.
 *
 * `new Date()` IS CORRECT HERE, and the warning it used to carry does not apply. That warning is
 * about deriving a DATE from an instant: the local calendar day can differ from the UTC one, so a
 * run just after midnight UTC prints as yesterday. Rendering the instant as a local date AND a local
 * time together is internally coherent: both halves describe the same local moment, which is the
 * moment the operator was living in when the rule ran.
 */
function formatWhen(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * A run's failure reason, in words, without ever leaking a dot-path onto the screen.
 *
 * `errorCode` is the TARGET VERB's own rejection code, not one of G01's, so the automation catalogue
 * is the wrong place to look it up alone: `t` falls back to the RAW KEY, and an unmapped code renders
 * `automation.error.opening_balance_already_set` at a Treuhänder. The chain is automation's own
 * vocabulary first, then the SHARED `errors.*` catalogue that carries the cross-cutting codes
 * (`permission_denied`, `store_busy`, `transport_error`), and only then the bare code, which is
 * machine-ish but is at least the string the operator can search for and quote in a report.
 */
/**
 * A capability id in the operator's language, for the withheld notice.
 *
 * The `capability.*` catalogue is A24's and already covers every id the disclosure gate can name, so
 * this reuses it rather than inventing a second vocabulary for the same closed set. A future id with
 * no entry degrades to the bare slug, which is searchable, rather than to a raw i18n dot-path.
 */
function capabilityLabel(t: (key: string) => string, capability: string): string {
  const label = t(`capability.${capability}`);
  return label === `capability.${capability}` ? capability : label;
}

function runReason(t: (key: string) => string, code: string): string {
  const own = t(`automation.error.${code}`);
  if (own !== `automation.error.${code}`) return own;
  const shared = t(`errors.${code}`);
  if (shared !== `errors.${code}`) return shared;
  return code;
}

export function Automations() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const caps = useCapabilities();
  const nameInputId = useId();
  const eventSelectId = useId();
  const toolSelectId = useId();
  const templateInputId = useId();

  const [tab, setTab] = useState<Tab>('rules');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DraftRule | null>(null);

  const canManage = caps.can(CAP.manageAutomations);
  const seatName = useSeatNames();
  const { locale } = useI18n();

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setState({ kind: 'loading' });
    const [rulesResponse, runsResponse] = await Promise.all([
      // Archived rules are asked for EXPLICITLY: a retired rule still owns its history, and this is
      // the one screen where "why is there a run row for a rule I cannot see" has to be answerable.
      client.call('list_automation_rules', { workspaceId, includeArchived: true }),
      client.call('list_automation_runs', { workspaceId }),
    ]);
    if (isErr(rulesResponse.body)) return setState({ kind: 'error', error: rulesResponse.body });
    if (isErr(runsResponse.body)) return setState({ kind: 'error', error: runsResponse.body });
    const rulesBody = rulesResponse.body as unknown as { rules: readonly RuleDto[]; catalogue: Catalogue };
    const runsBody = runsResponse.body as unknown as { runs: readonly RunDto[] };
    setState({ kind: 'ok', rules: rulesBody.rules, runs: runsBody.runs, catalogue: rulesBody.catalogue });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const liveRules = useMemo(
    () => (state.kind === 'ok' ? state.rules.filter((r) => !r.archived) : []),
    [state],
  );
  const archivedRules = useMemo(
    () => (state.kind === 'ok' ? state.rules.filter((r) => r.archived) : []),
    [state],
  );

  async function submitDraft() {
    if (draft === null) return;
    setBusy(true);
    setFeedback(null);
    let template: Record<string, unknown> = {};
    try {
      template = draft.inputTemplate.trim().length === 0 ? {} : (JSON.parse(draft.inputTemplate) as Record<string, unknown>);
    } catch {
      // Caught HERE rather than sent, because a template that is not JSON is a mistake in this form
      // and the engine's `invalid_action_input` would say so less precisely than the field can.
      setBusy(false);
      setFeedback({ tone: 'error', text: t('automation.error.invalid_action_input') });
      return;
    }
    const response = await client.call('create_automation_rule', {
      workspaceId,
      name: draft.name,
      trigger: { event: draft.event },
      action: { tool: draft.tool, inputTemplate: template },
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    if (isErr(response.body)) {
      // The engine's own code, rendered inline on the form that owns the input, never a toast and
      // never a stack trace. An unmapped code falls back to its own text rather than to silence.
      setFeedback({ tone: 'error', text: t(`automation.error.${response.body.error}`) });
      return;
    }
    setDraft(null);
    setFeedback({ tone: 'success', text: t('automation.rules.saved') });
    await load();
  }

  async function runRuleAction(
    action: 'enable_automation_rule' | 'disable_automation_rule' | 'archive_automation_rule',
    ruleId: string,
  ) {
    setBusy(true);
    setFeedback(null);
    const response = await client.call(action, { workspaceId, ruleId });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: t(`automation.error.${response.body.error}`) });
      return;
    }
    setFeedback({ tone: 'success', text: t(`automation.rules.${action === 'archive_automation_rule' ? 'archived' : 'toggled'}`) });
    await load();
  }

  /**
   * Finish a stuck claim. See the retry button for why this path has to exist at all.
   *
   * The retry re-sends the SAME stored input, including the derived `idempotencyKey`, so if the lost
   * invocation had in fact committed, the target verb answers from its own memo and nothing happens
   * twice. That is what makes offering this on the money path safe.
   */
  async function retryRun(runId: string) {
    setBusy(true);
    setFeedback(null);
    const response = await client.call('retry_automation_run', {
      workspaceId,
      runId,
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: t(`automation.error.${response.body.error}`) });
      return;
    }
    setFeedback({ tone: 'success', text: t('automation.run.retried') });
    await load();
  }

  async function tickNow() {
    setBusy(true);
    setFeedback(null);
    const response = await client.call('run_due_automations', { workspaceId });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: t(`automation.error.${response.body.error}`) });
      return;
    }
    const fired = (response.body as unknown as { occurrences?: number }).occurrences ?? 0;
    setFeedback({ tone: 'success', text: t('automation.tick.done', { n: String(fired) }) });
    await load();
  }

  if (workspaceId === null) {
    return <NoWorkspaceState body={t('automation.noWorkspaceHint')} />;
  }

  const catalogue: Catalogue = state.kind === 'ok' ? state.catalogue : { events: [], actions: [], ops: [] };

  const openDraft = () =>
    setDraft({
      name: '',
      event: catalogue.events[0]?.event ?? '',
      tool: catalogue.actions[0] ?? '',
      inputTemplate: '{}',
    });
  const rules = state.kind === 'ok' ? [...liveRules, ...archivedRules] : [];
  const runs: RunDto[] = state.kind === 'ok' ? [...state.runs] : [];

  // The rule list, as the shared DataTable (frame overflow, sticky header, density, five states).
  // The controls column stays surface-owned: DEAKTIVIEREN is never disabled (see the module note),
  // every other write control is pre-disabled for an actor without `manage_automations`, and an
  // archived rule offers none, because it cannot be enabled, stopped or archived again.
  const ruleColumns: DataTableColumn<RuleDto>[] = [
    { key: 'name', header: t('automation.col.name'), render: (rule) => rule.name },
    { key: 'trigger', header: t('automation.col.trigger'), render: (rule) => humanizeId(rule.trigger.event) },
    { key: 'action', header: t('automation.col.action'), render: (rule) => verbLabel(locale, rule.action.tool) },
    {
      key: 'status',
      header: t('automation.col.status'),
      // K-22: the shared Status, a glyph from the icon set plus the word, never ●/○.
      render: (rule) =>
        rule.archived ? (
          <Status kind="inactive" label={t('automation.status.archived')} />
        ) : rule.enabled ? (
          <Status kind="success" label={t('automation.status.enabled')} />
        ) : (
          <Status kind="neutral" label={t('automation.status.disabled')} />
        ),
    },
    {
      key: 'lastFired',
      header: t('automation.col.lastFired'),
      render: (rule) =>
        rule.lastFiredAt === null ? t('automation.neverFired') : formatWhen(rule.lastFiredAt),
    },
  ];

  /**
   * K-21 (D137): a rule row's verbs sit behind ONE overflow, destructive last. DEAKTIVIEREN IS NEVER
   * DISABLED: every other item is gated on `manage_automations`, because the canon forbids offering a
   * control that will always reject, but the engine deliberately leaves the stop ungated, so greying
   * it out would be this screen lying about what the person may do, on the one control that matters
   * most when a rule is writing things it should not. An archived rule offers none.
   */
  const ruleActions = (rule: RuleDto): OverflowMenuItem[] => {
    if (rule.archived) return [];
    const items: OverflowMenuItem[] = [];
    if (rule.enabled) {
      items.push({
        key: 'disable',
        label: t('automation.action.disable'),
        disabled: busy,
        onSelect: () => void runRuleAction('disable_automation_rule', rule.ruleId),
      });
    } else {
      items.push({
        key: 'enable',
        label: t('automation.action.enable'),
        disabled: !canManage || busy,
        onSelect: () => void runRuleAction('enable_automation_rule', rule.ruleId),
      });
    }
    items.push({
      key: 'archive',
      label: t('automation.action.archive'),
      danger: true,
      disabled: !canManage || busy,
      onSelect: () => void runRuleAction('archive_automation_rule', rule.ruleId),
    });
    return items;
  };

  const runColumns: DataTableColumn<RunDto>[] = [
    { key: 'rule', header: t('automation.col.rule'), render: (run) => run.ruleName ?? humanizeId(run.ruleId) },
    { key: 'trigger', header: t('automation.col.trigger'), render: (run) => humanizeId(run.event) },
    {
      // WHAT IT DID, which the log used to drop. `actionTool` was already on the DTO and was never
      // rendered, so the Verlauf answered "what fired, when, and how it went" and stayed silent on
      // the only question a bookkeeper opens it to settle: what the rule actually DOES to the books.
      key: 'action',
      header: t('automation.col.action'),
      render: (run) => (
        <>
          <code className="automations__tool">{run.actionTool}</code>
          {/*
            WHAT IT ACTUALLY SENT, behind a closed `<details>`. `actionInput` is the RESOLVED payload
            after template substitution, so this is what left the building and not what the rule
            intended. `!= null` catches undefined as well as null deliberately: `Object.entries`
            throws on both, and a log that cannot render is worse than one missing a column, so an
            absent payload degrades to no disclosure.
          */}
          {run.actionInput != null ? (
            <details className="automations__payload">
              <summary>{t('automation.run.payload')}</summary>
              <dl className="automations__payload-list">
                {Object.entries(run.actionInput).map(([key, value]) => (
                  <div key={key}>
                    <dt>{key}</dt>
                    <dd>{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            </details>
          ) : run.withheld != null ? (
            /*
              WITHHELD, NOT OMITTED, and it names its own key. `read_automations` buys the automation
              facts; the payload belongs to the domain of the verb that fired, so a reader who could
              not have made that call themselves does not get it. Saying "there is something here and
              this is what would unlock it" is the difference between a permission boundary and a
              screen that looks broken.
            */
            <p className="automations__withheld">
              {t('automation.run.withheld', { capability: capabilityLabel(t, run.withheld) })}
            </p>
          ) : null}
        </>
      ),
    },
    {
      key: 'outcome',
      header: t('automation.col.outcome'),
      render: (run) => (
        <>
          <Status kind={RUN_STATUS_KIND[run.status] ?? 'neutral'} label={t(`automation.runStatus.${run.status}`)} />
          {run.errorCode !== null ? (
            // The target verb's OWN rejection code, resolved through `runReason` so an unmapped one
            // degrades to the bare code instead of a raw i18n dot-path.
            <span className="automations__reason"> {runReason(t, run.errorCode)}</span>
          ) : null}
          {/*
            A REDELIVERED OCCURRENCE USED TO LEAVE NO TRACE AT ALL. The counter is durable, so the row
            can say the delivery was seen again and correctly fired nothing, which is a different fact
            from "it never arrived" and the only one that distinguishes working de-duplication from a
            silent drop.
          */}
          {(run.redeliveries ?? 0) > 0 ? (
            <span className="automations__redeliveries">
              {' '}
              {t('automation.run.redelivered', { n: String(run.redeliveries) })}
            </span>
          ) : null}
          {/*
            THE REPAIR PATH FOR A STUCK CLAIM. A process that died between the claim and the settle
            leaves a `running` row that can never re-fire, and the UNIQUE index permanently forbids
            re-claiming the occurrence. Offered ONLY on a stuck row, because the engine refuses a
            settled one with `run_not_stuck`, and pre-disabled without `manage_automations` rather
            than rejected on click.
          */}
          {run.status === 'running' ? (
            <button
              type="button"
              className="btn btn--secondary btn--sm automations__retry"
              disabled={busy || !canManage}
              onClick={() => void retryRun(run.runId)}
            >
              {t('automation.run.retry')}
            </button>
          ) : null}
          {run.status === 'running' && !canManage ? (
            <span className="lock-note">{t('automation.needsPermission')}</span>
          ) : null}
        </>
      ),
    },
    // K-38: a seat is named ("MCP-Agent", "Person 1"), never the raw user_1.
    { key: 'actor', header: t('automation.col.actor'), render: (run) => seatName(run.actor).label },
    { key: 'when', header: t('automation.col.when'), render: (run) => formatWhen(run.startedAt) },
  ];

  // The Regeln panel: the create control, the inline draft form, then the rule list. The actions and
  // the form stay above the table so the first rule can be created from an empty list.
  const rulesPanel = (
    <div className="automations__panel">
      <div className="automations__actions">
        <button
          type="button"
          className="btn btn--secondary"
          disabled={!canManage || busy}
          onClick={() => void tickNow()}
        >
          {t('automation.tick.now')}
        </button>
        {/*
          THE PRECONDITION IS STATED BESIDE THE CONTROL, not hung on `title`. `.lock-note` is the
          house answer and already exists in `global.css` for exactly this ("why can I not edit this").
        */}
        {!canManage ? <p className="lock-note">{t('automation.needsPermission')}</p> : null}
      </div>

      {draft !== null ? (
        <form
          className="automations__form"
          onSubmit={(e) => {
            e.preventDefault();
            void submitDraft();
          }}
        >
          <label htmlFor={nameInputId}>
            <span>{t('automation.form.name')}</span>
            <input
              className="field"
              id={nameInputId}
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.currentTarget.value })}
              required
            />
          </label>
          <label htmlFor={eventSelectId}>
            <span>{t('automation.form.trigger')}</span>
            <Select
              id={eventSelectId}
              value={draft.event}
              onChange={(val) => setDraft({ ...draft, event: val })}
              options={catalogue.events.map((ev) => ({ value: ev.event, label: humanizeId(ev.event) }))}
              ariaLabel={t('automation.form.trigger')}
            />
          </label>
          <label htmlFor={toolSelectId}>
            <span>{t('automation.form.action')}</span>
            <Select
              id={toolSelectId}
              value={draft.tool}
              onChange={(val) => setDraft({ ...draft, tool: val })}
              options={catalogue.actions.map((tool) => ({ value: tool, label: verbLabel(locale, tool) }))}
              ariaLabel={t('automation.form.action')}
            />
          </label>
          <label htmlFor={templateInputId}>
            <span>{t('automation.form.template')}</span>
            <textarea
              className="field automations__template"
              id={templateInputId}
              rows={4}
              value={draft.inputTemplate}
              onChange={(e) => setDraft({ ...draft, inputTemplate: e.currentTarget.value })}
            />
          </label>
          <p className="automations__hint">{t('automation.form.templateHint')}</p>
          <div className="automations__formActions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {t('automation.form.save')}
            </button>
            <button type="button" className="btn btn--secondary" onClick={() => setDraft(null)} disabled={busy}>
              {t('automation.form.cancel')}
            </button>
          </div>
        </form>
      ) : null}

      <DataTable
        columns={ruleColumns}
        rows={rules}
        rowKey={(rule) => rule.ruleId}
        caption={t('automation.rules.title')}
        // Dimmed, never coloured: an archived rule is a resolved state, not a fault. DataTable joins
        // this with its base row class, so the dim rule keeps the row's other styling.
        rowClassName={(rule) => (rule.archived ? 'automations-row--archived' : undefined)}
        rowActions={ruleActions}
        rowActionsLabel={(rule) => t('automation.rowActions', { name: rule.name })}
        emptyState={
          <EmptyState
            title={t('automation.empty.title')}
            hint={t('automation.empty.hint')}
            action={canManage ? { label: t('automation.rules.create'), onClick: openDraft } : undefined}
          />
        }
      />
    </div>
  );

  const runsPanel = (
    <div className="automations__panel">
      <DataTable
        columns={runColumns}
        rows={runs}
        rowKey={(run) => run.runId}
        caption={t('automation.runs.title')}
        emptyState={
          <EmptyState
            title={t('automation.emptyRuns.title')}
            hint={t('automation.emptyRuns.hint')}
            action={canManage ? { label: t('automation.tick.now'), onClick: () => void tickNow() } : undefined}
          />
        }
      />
    </div>
  );

  const tabs: TabItem[] = [
    { id: 'rules', label: t('automation.rules.title'), panel: rulesPanel },
    { id: 'runs', label: t('automation.runs.title'), panel: runsPanel },
  ];

  return (
    <section className="automations" aria-labelledby="automations-title">
      <SurfaceHeader
        title={t('automation.title')}
        titleId="automations-title"
        subtitle={t('automation.lede')}
        help={<SurfaceHelp surface="Automations" />}
        // K-08: the one primary, in the header slot; hidden while the draft form is open.
        actions={
          draft === null && state.kind === 'ok' ? (
            <button type="button" className="btn btn--primary" disabled={!canManage} onClick={openDraft}>
              {t('automation.rules.create')}
            </button>
          ) : undefined
        }
      />

      {/*
        A FAILURE IS ANNOUNCED ASSERTIVELY, a success politely. A polite live region is queued behind
        whatever the screen reader is already saying, so a refusal must not ride the same channel as
        a confirmation, or the person hears the archive before the rejection.
      */}
      {feedback !== null ? (
        <p
          className={`automations__feedback automations__feedback--${feedback.tone}`}
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.text}
        </p>
      ) : null}

      {state.kind === 'loading' ? (
        // Row skeletons in the final list shape, never a bare spinner: the page does not jump when
        // the answer arrives.
        <Skeleton rows={4} height={36} />
      ) : state.kind === 'error' ? (
        <ErrorBanner error={state.error} context="read" onRetry={() => void load()} />
      ) : (
        <Tabs tabs={tabs} activeId={tab} onChange={(id) => setTab(id as Tab)} label={t('automation.title')} />
      )}
    </section>
  );
}

export default Automations;
