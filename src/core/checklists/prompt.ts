/**
 * The MCP prompt per template (spec G22 §5): the agent's face of the run detail.
 *
 * ONE RENDERER, TWO CALLERS. `renderChecklistPromptText` is pure over the SAME `ChecklistRunView`
 * that `checklist_get` returns, so the prompt and the verb can never disagree on what is open and in
 * what order (asserted by `test/checklists/g22-prompts.test.mjs`). The MCP server feeds it the
 * payloads of the governed `vat_periods` / `checklist_list` / `checklist_get` actions under the session
 * actor (so the A24 gate and the A35 trace are inherited); the engine-side `renderChecklistPrompt`
 * feeds it the derivation directly.
 *
 * Text only. With no run it names `checklist_start` and the period; it invents no state. A verb
 * refusal (no MWST config, a period that is not a filing period) is rendered verbatim by code.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { listVatPeriods } from '../vat/index.js';
import { checklistTemplate, CHECKLIST_TEMPLATES } from './canon/index.js';
import { deriveRun, runRowFor, type ChecklistItemView, type ChecklistRunView } from './runs.js';
import type { ChecklistTemplate } from './types.js';

/** The prompt name for a template: `checklist_<templateId>`. */
export function promptNameFor(templateId: string): string {
  return `checklist_${templateId}`;
}

/** The two prompt arguments every template prompt takes, in MCP `PromptArgument` shape. */
export const CHECKLIST_PROMPT_ARGUMENTS = [
  { name: 'workspaceId', description: 'The workspace (tenant) the checklist belongs to.', required: true },
  { name: 'period', description: 'The A07 period label (2026-Q2, 2026-H1). Defaults to the last period that has ended.', required: false },
] as const;

/** Every shipped prompt, for `prompts/list`. */
export function listChecklistPrompts(): Array<{ name: string; templateId: string; description: string }> {
  return CHECKLIST_TEMPLATES.map((t) => ({
    name: promptNameFor(t.templateId),
    templateId: t.templateId,
    description: `Walk the "${t.label}" checklist for one period: the open items in order, the verb each agent item calls, and what a human still has to do. Reads checklist_get under this session.`,
  }));
}

/** The template a prompt name resolves to, or undefined. */
export function templateForPrompt(name: unknown): string | undefined {
  if (typeof name !== 'string' || !name.startsWith('checklist_')) return undefined;
  const templateId = name.slice('checklist_'.length);
  return checklistTemplate(templateId) === undefined ? undefined : templateId;
}

/** A type alias, not an interface: it rides inside `Result<PromptPeriod>`, whose `OkFields` bound is an index signature. */
export type PromptPeriod = {
  readonly label: string;
  readonly periodStart: string;
  readonly periodEnd: string;
};

/**
 * Pick the period a prompt renders: the requested label when given (refused `period_not_filable`
 * when it is not one of the year's periods), else the last period that has ENDED as of `today` (this
 * year's, or last year's last when none has). `periodsOf` is the A07 `vat_periods` read for a year,
 * however the caller reaches it (engine or governed action).
 */
export function pickChecklistPeriod(
  periodsOf: (year: string) => Result,
  today: string,
  requested: unknown,
): Result<PromptPeriod> {
  const asPeriods = (res: Result): PromptPeriod[] =>
    Array.isArray(res.periods) ? (res.periods as PromptPeriod[]).map((p) => ({ label: p.label, periodStart: p.periodStart, periodEnd: p.periodEnd })) : [];
  if (typeof requested === 'string' && requested.length > 0) {
    const res = periodsOf(requested.slice(0, 4));
    if (!res.ok) return res;
    const periods = asPeriods(res);
    const match = periods.find((p) => p.label === requested);
    if (match === undefined) return err('period_not_filable', { period: requested, periods: periods.map((p) => p.label) });
    return ok(match);
  }
  const year = Number(today.slice(0, 4));
  for (const y of [year, year - 1]) {
    const res = periodsOf(String(y));
    if (!res.ok) return res;
    const ended = asPeriods(res).filter((p) => p.periodEnd < today);
    const last = ended[ended.length - 1];
    if (last !== undefined) return ok(last);
  }
  return err('period_not_filable', { period: null, reason: 'no period has ended yet' });
}

function itemLine(item: ChecklistItemView, run: ChecklistRunView, workspaceId: string): string {
  const due = item.dueAt === null ? '' : `, due ${item.dueAt}`;
  const head = `${item.position}. [${item.ownerKind}] ${item.title} (itemId ${item.itemId}${due})`;
  if (item.blockedBy !== null) return `${head}: waits on ${item.blockedBy}.`;
  if (item.evidenceKind === 'check') {
    const count = item.checkResult?.count;
    const pending = count === undefined ? '' : `, ${count} pending`;
    const where = item.deepLink === null ? '' : ` A human resolves it on ${item.deepLink}.`;
    return `${head}: live check ${item.check ?? ''} not passed${pending}. It flips by itself; nobody completes it by hand.${where}`;
  }
  if (item.evidenceKind === 'verb_result') {
    const args = `{workspaceId: "${workspaceId}", periodStart: "${run.periodStart}", periodEnd: "${run.periodEnd}"}`;
    const stale = item.stale ? ' The earlier result is stale: the figures changed since it was bound.' : '';
    return `${head}: call ${item.verb ?? ''} ${args}, then checklist_item_complete {workspaceId: "${workspaceId}", runId: "${run.runId}", itemId: "${item.itemId}", idempotencyKey}. The engine re-runs the verb and binds its hash.${stale}`;
  }
  if (item.evidenceKind === 'filed_attestation') {
    return `${head}: a human files the exported file in the ESTV ePortal (outside TILL), then checklist_item_complete {workspaceId: "${workspaceId}", runId: "${run.runId}", itemId: "${item.itemId}", evidence: {kind: "filed_attestation", ref: "YYYY-MM-DD"}, idempotencyKey} records the date they stand behind. Under the agent seat this call is governed by the vat-file dial (the same dial as vat_mark_filed): it is DRAFTED as a Vorschlag for the owner's approval, never recorded by the agent alone.`;
  }
  const precondition = item.precondition === null ? '' : ` Requires the live check ${item.precondition} to pass first (currently ${item.preconditionResult?.passed === true ? 'passed' : 'not passed'}).`;
  const ref = item.requiresEvidenceRef ? ' evidence.ref must name the bank transaction or journal entry.' : '';
  const stale = item.stale ? ' The earlier sign-off is stale (Freigabe hinfällig): the return changed since it was signed.' : '';
  return `${head}: a sign-off through checklist_item_complete {workspaceId: "${workspaceId}", runId: "${run.runId}", itemId: "${item.itemId}", evidence: {kind: "signoff", ref}, idempotencyKey}.${precondition}${ref}${stale}`;
}

export interface RenderPromptInput {
  readonly template: ChecklistTemplate;
  readonly workspaceId: string;
  readonly period: PromptPeriod;
  /** The `checklist_get` view, or null when no run exists for the period. */
  readonly run: ChecklistRunView | null;
}

/** The pure renderer: the text plus the open item ids in order, for the parity test. */
export function renderChecklistPromptText(input: RenderPromptInput): { text: string; openItemIds: string[] } {
  const { template, workspaceId, period, run } = input;
  if (run === null) {
    const text =
      `No "${template.label}" checklist run exists for ${period.label} (${period.periodStart} to ${period.periodEnd}) in workspace ${workspaceId}. ` +
      `Start one with checklist_start {workspaceId: "${workspaceId}", templateId: "${template.templateId}", period: "${period.label}", idempotencyKey}, then ask for this prompt again.`;
    return { text, openItemIds: [] };
  }
  const open = run.items.filter((i) => i.status === 'open');
  const lines: string[] = [];
  lines.push(`"${template.label}" checklist for ${run.periodLabel} (${run.periodStart} to ${run.periodEnd}), run ${run.runId}, status ${run.status}.`);
  if (run.status === 'abandoned') {
    lines.push(`This run was abandoned (${run.abandonReason ?? 'no reason recorded'}). Start a new run with checklist_start if the period still needs one.`);
  } else if (open.length === 0) {
    lines.push('Every item is done or skipped. Nothing is open.');
  } else {
    lines.push(`Open items, in order (${open.length} of ${run.itemCount}); the next actionable one is ${run.nextItemId ?? 'none'}:`);
    for (const item of open) lines.push(itemLine(item, run, workspaceId));
  }
  lines.push(`Done: ${run.doneCount}. Skipped: ${run.skippedCount}. Read the full state with checklist_get {workspaceId: "${workspaceId}", runId: "${run.runId}"}.`);
  return { text: lines.join('\n'), openItemIds: open.map((i) => i.itemId) };
}

/** A verb refusal, rendered verbatim as prompt text (never invented, never softened). */
export function renderChecklistPromptRefusal(step: string, refusal: Result): string {
  return `The checklist prompt cannot render: ${step} refused ${JSON.stringify(refusal)}. Resolve the refusal, then ask again.`;
}

/** The engine-side prompt over the derivation directly (the MCP server goes through the actions). */
export function renderChecklistPrompt(
  ctx: WorkspaceContext,
  input: { templateId: string; period?: unknown },
): Result<{ text: string; runId: string | null; openItemIds: string[] }> {
  const template = checklistTemplate(input.templateId);
  if (template === undefined) return err('unknown_template', { templateId: input.templateId });
  const picked = pickChecklistPeriod((year) => listVatPeriods(ctx, { year }), ctx.clock.now().slice(0, 10), input.period);
  if (!picked.ok) return picked;
  const row = runRowFor(ctx, template.templateId, picked.periodStart);
  const run = row === undefined ? null : deriveRun(ctx, row);
  const rendered = renderChecklistPromptText({ template, workspaceId: ctx.workspaceId, period: picked, run });
  return ok({ text: rendered.text, runId: run?.runId ?? null, openItemIds: rendered.openItemIds });
}
