/**
 * The MCP prompt per template (spec G22 §5, §10.10): the agent's face of the run detail.
 *
 * ONE RENDERER, TWO CALLERS. `renderChecklistPromptText` is pure over the SAME `ChecklistRunView`
 * that `checklist_get` returns, so the prompt and the verb can never disagree on what is open and in
 * what order (asserted by `test/checklists/g22-prompts.test.mjs`). The MCP server feeds it the
 * payloads of the governed `vat_periods` / `checklist_list` / `checklist_get` actions under the session
 * actor (so the A24 gate and the A35 trace are inherited); the engine-side `renderChecklistPrompt`
 * feeds it the derivation directly.
 *
 * Text only. With no run it names `checklist_start` and the period; it invents no state. A verb
 * refusal (no MWST config, a period that is not a filing period) is rendered verbatim by code. One
 * line shape per kind (§10.10): a choice lists its option ids and the complete call; a preview names
 * the read verb and the complete call; a posting names the domain verb and says the row flips by
 * derivation; a validation states the formula, the figures and the result; a governed sign-off says
 * it is drafted.
 */

import type { WorkspaceContext } from '../context.js';
import { ok, err } from '../result.js';
import type { Result } from '../result.js';
import { checklistTemplate, checklistTemplates } from './canon/index.js';
import { fiscalYearBounds, monthBounds, resolveChecklistPeriod, MONTH_LABEL } from './periods.js';
import { dayBefore } from './deadlines.js';
import { fiscalYearOf } from '../ledger/index.js';
import { deriveRun, runRowFor, type ChecklistItemView, type ChecklistRunView } from './runs.js';
import type { ChecklistPeriodKind, ChecklistTemplate } from './types.js';

/** The prompt name for a template: `checklist_<templateId>`. */
export function promptNameFor(templateId: string): string {
  return `checklist_${templateId}`;
}

/** The two prompt arguments every template prompt takes, in MCP `PromptArgument` shape. */
export const CHECKLIST_PROMPT_ARGUMENTS = [
  { name: 'workspaceId', description: 'The workspace (tenant) the checklist belongs to.', required: true },
  { name: 'period', description: 'The period label (2026-Q2 or 2026-H1 for the MWST-Periode, 2026-06 for a month, 2026 for a fiscal year). Defaults to the last period that has ended.', required: false },
] as const;

/** Every registered prompt, for `prompts/list` (the fixture template only under test). */
export function listChecklistPrompts(): Array<{ name: string; templateId: string; description: string }> {
  return checklistTemplates().map((t) => ({
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
 * however the caller reaches it (engine or governed action), consulted only for the `vat_period`
 * kind; a `month` or `year` kind resolves from `today` and `fiscalYearStart` alone (spec §10.3).
 */
export function pickChecklistPeriod(
  periodsOf: (year: string) => Result,
  today: string,
  requested: unknown,
  periodKind: ChecklistPeriodKind = 'vat_period',
  fiscalYearStart = '01-01',
): Result<PromptPeriod> {
  const wanted = typeof requested === 'string' && requested.length > 0 ? requested : null;
  if (periodKind === 'month') {
    if (wanted !== null && !MONTH_LABEL.test(wanted)) return err('invalid_period', { period: wanted, expected: 'YYYY-MM' });
    const period = monthBounds(wanted ?? dayBefore(`${today.slice(0, 7)}-01`).slice(0, 7));
    if (period.periodEnd >= today) return err('period_not_ended', { period: period.label, periodEnd: period.periodEnd, today });
    return ok(period);
  }
  if (periodKind === 'year') {
    if (wanted !== null && !/^\d{4}$/.test(wanted)) return err('invalid_period', { period: wanted, expected: 'YYYY' });
    const label = wanted ?? String(Number(fiscalYearOf(today, fiscalYearStart)) - 1).padStart(4, '0');
    const period = fiscalYearBounds(label, fiscalYearStart);
    if (period.periodEnd >= today) return err('period_not_ended', { period: period.label, periodEnd: period.periodEnd, today });
    return ok(period);
  }
  const asPeriods = (res: Result): PromptPeriod[] =>
    Array.isArray(res.periods) ? (res.periods as PromptPeriod[]).map((p) => ({ label: p.label, periodStart: p.periodStart, periodEnd: p.periodEnd })) : [];
  if (wanted !== null) {
    const res = periodsOf(wanted.slice(0, 4));
    if (!res.ok) return res;
    const periods = asPeriods(res);
    const match = periods.find((p) => p.label === wanted);
    if (match === undefined) return err('period_not_filable', { period: wanted, periods: periods.map((p) => p.label) });
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

function completeCall(workspaceId: string, run: ChecklistRunView, item: ChecklistItemView, evidence: string | null): string {
  const ev = evidence === null ? '' : `, evidence: ${evidence}`;
  return `checklist_item_complete {workspaceId: "${workspaceId}", runId: "${run.runId}", itemId: "${item.itemId}"${ev}, idempotencyKey}`;
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
    return `${head}: call ${item.verb ?? ''} ${args}, then ${completeCall(workspaceId, run, item, null)}. The engine re-runs the verb and binds its hash.${stale}`;
  }
  if (item.evidenceKind === 'choice') {
    const options = (item.options ?? []).map((o) => o.id).join(' | ');
    const current =
      item.choice === null
        ? item.defaultOptionId === null
          ? ' No answer yet.'
          : ` Pre-selected: ${item.defaultOptionId} (not an answer until saved).`
        : ` Current answer: ${item.choice.optionId} (${item.choice.source}).`;
    return `${head}: a bounded choice, options ${options}.${current} Answer with ${completeCall(workspaceId, run, item, '{kind: "choice", ref: <optionId>}')}. Rows the answer governs are excluded or included by derivation.`;
  }
  if (item.evidenceKind === 'preview') {
    const input = `{workspaceId: "${workspaceId}", ${item.verbInput ?? 'period'}: "${item.verbInputValue ?? run.periodLabel}"}`;
    const state = item.previewResult === null ? '' : item.previewResult.ok ? (item.previewResult.empty ? ' The read answers nothing to do.' : '') : ` The read refuses: ${item.previewResult.error ?? 'refused'}.`;
    const stale = item.stale ? ' The earlier preview is stale: the figures changed since it was bound.' : '';
    return `${head}: read ${item.verb ?? ''} ${input}, review it, then ${completeCall(workspaceId, run, item, null)}. The engine re-runs the read and binds its hash.${state}${stale}`;
  }
  if (item.evidenceKind === 'posting') {
    const reverse = item.reverseVerb === null ? ' There is no reverse verb: this posting is final.' : ` Reverse with ${item.reverseVerb} (a reversing entry, never an edit).`;
    const probe = item.probeResult === null ? '' : item.probeResult.found === null ? ` The probe ${item.probe ?? ''} is unavailable: ${item.probeResult.reason ?? ''}.` : '';
    // The year run's settlement row carries a per-period table on its probe (spec §10.5 item 11, §10.10):
    // one call per unsettled FILED period; a period not yet filed waits on its MWST-Periode run; a
    // filed period with nothing on its tax accounts holds vacuously and needs no call.
    const periods = item.probeResult?.detail.periods;
    if (Array.isArray(periods) && periods.length > 0) {
      const rows = periods as { label: string; filed: boolean; settled: boolean; nothingToSettle?: boolean }[];
      const calls = rows.filter((r) => r.filed && !r.settled).map((r) => `${item.verb ?? ''} {workspaceId: "${workspaceId}", period: "${r.label}", idempotencyKey}`);
      const waiting = rows.filter((r) => !r.filed).map((r) => r.label);
      const vacuous = rows.filter((r) => r.nothingToSettle === true).map((r) => r.label);
      const settled = rows.filter((r) => r.settled && r.nothingToSettle !== true).map((r) => r.label);
      const parts = [
        calls.length === 0 ? '' : ` Call, one per unsettled filed period: ${calls.join('; ')}.`,
        waiting.length === 0 ? '' : ` Not filed yet, waits on the MWST-Periode run: ${waiting.join(', ')}.`,
        vacuous.length === 0 ? '' : ` Nothing to settle (the tax accounts read zero): ${vacuous.join(', ')}.`,
        settled.length === 0 ? '' : ` Settled: ${settled.join(', ')}.`,
      ].join('');
      return `${head}: post through ${item.verb ?? ''} per period under that verb's own gate; the row flips by derivation when the probe ${item.probe ?? ''} finds every filed period settled. Nobody completes it by hand.${parts}${reverse}${probe}`;
    }
    const input = `{workspaceId: "${workspaceId}", ${item.verbInput ?? 'period'}: "${item.verbInputValue ?? run.periodLabel}", idempotencyKey}`;
    return `${head}: post through ${item.verb ?? ''} ${input} under that verb's own gate; the row flips by derivation when the probe ${item.probe ?? ''} finds the artefact. Nobody completes it by hand.${reverse}${probe}`;
  }
  if (item.evidenceKind === 'validation') {
    const v = item.validationResult;
    const figures = v === null ? '' : ` Figures: ${JSON.stringify(v.figures)}.`;
    const result = v === null ? 'not evaluated' : v.result === 'unavailable' ? `unavailable (${v.reason ?? ''})` : v.result;
    const fix = item.fixLink === null ? '' : ` A human fixes it on ${item.fixLink}.`;
    if (item.severity === 'warn') {
      const stale = item.stale ? ' The earlier acknowledgement is stale: the figures moved.' : '';
      return `${head}: validation ${item.validation ?? ''} (formula ${v?.formula ?? ''}), result ${result}, a warning that does not block the close.${figures}${fix} Acknowledge with ${completeCall(workspaceId, run, item, '{kind: "signoff", ref: <reason>}')}.${stale}`;
    }
    return `${head}: validation ${item.validation ?? ''} (formula ${v?.formula ?? ''}), result ${result}, blocks the close until it passes.${figures}${fix} It flips by itself; nobody completes it by hand.`;
  }
  if (item.evidenceKind === 'filed_attestation') {
    return `${head}: a human files the exported file in the ESTV ePortal (outside TILL), then ${completeCall(workspaceId, run, item, '{kind: "filed_attestation", ref: "YYYY-MM-DD"}')} records the date they stand behind. Under the agent seat this call is governed by the vat-file dial (the same dial as vat_mark_filed): it is DRAFTED as a Vorschlag for the owner's approval, never recorded by the agent alone.`;
  }
  if (item.signoffKind === 'gv_attestation') {
    return `${head}: the Generalversammlung approves the statements (outside TILL), then ${completeCall(workspaceId, run, item, '{kind: "gv_attestation", ref: "YYYY-MM-DD"}')} records the date (a date before the statements sign-off needs evidence.reason). Under the agent seat this call is governed at the post tier: it is DRAFTED as a Vorschlag for the owner's approval, never recorded by the agent alone.`;
  }
  if (item.signoffKind === 'statements_signoff') {
    const stale = item.stale ? ' The earlier sign-off is stale (Freigabe hinfällig): the statements changed since it was signed.' : '';
    return `${head}: the owner releases the Bilanz and Erfolgsrechnung through ${completeCall(workspaceId, run, item, '{kind: "statements_signoff"}')}, bound to the statements hash ${run.anchorHash ?? 'unavailable'}. Under the agent seat this call is governed at the post tier: it is DRAFTED as a Vorschlag for the owner's approval, never recorded by the agent alone.${stale}`;
  }
  const precondition = item.precondition === null ? '' : ` Requires the live check ${item.precondition} to pass first (currently ${item.preconditionResult?.passed === true ? 'passed' : 'not passed'}).`;
  const ref = !item.requiresEvidenceRef
    ? ''
    : item.itemId === 'bank_balance_typed'
      ? ' evidence.ref is the closing balance per the bank statement at the period end, in the base currency (12345.60); the bank_balance_matches validation reads it when no A20 statement covers the period end (D129 Q7).'
      : ' evidence.ref must name the bank transaction or journal entry.';
  const stale = item.stale ? ' The earlier sign-off is stale (Freigabe hinfällig): the return changed since it was signed.' : '';
  return `${head}: a sign-off through ${completeCall(workspaceId, run, item, '{kind: "signoff", ref}')}.${precondition}${ref}${stale}`;
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
    lines.push('Every item is done, skipped or excluded. Nothing is open.');
  } else {
    lines.push(`Open items, in order (${open.length} of ${run.itemCount}); the next actionable one is ${run.nextItemId ?? 'none'}:`);
    for (const item of open) lines.push(itemLine(item, run, workspaceId));
  }
  const excluded = run.excludedCount > 0 ? ` Excluded by a choice: ${run.excludedCount}.` : '';
  lines.push(`Done: ${run.doneCount}. Skipped: ${run.skippedCount}.${excluded} Read the full state with checklist_get {workspaceId: "${workspaceId}", runId: "${run.runId}"}.`);
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
  const picked = resolveChecklistPeriod(ctx, template.periodKind, input.period);
  if (!picked.ok) return picked;
  const row = runRowFor(ctx, template.templateId, picked.periodStart);
  const run = row === undefined ? null : deriveRun(ctx, row);
  const rendered = renderChecklistPromptText({ template, workspaceId: ctx.workspaceId, period: picked, run });
  return ok({ text: rendered.text, runId: run?.runId ?? null, openItemIds: rendered.openItemIds });
}
