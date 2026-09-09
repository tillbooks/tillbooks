/**
 * G08 §4, the single pure renderer.
 *
 * **This file must stay free of every `node:` import.** It is compiled into the engine AND imported
 * by the Studio bundle, which is the whole point: the preview the user reads, the artifact written
 * to disk, and the report the `ErrorBoundary` composes in the browser when the engine is unreachable
 * all come from ONE function. A privacy preview rendered by a second code path is a preview that can
 * drift into a lie, and a crash reporter that needs a working backend to report a broken backend is
 * not a crash reporter.
 *
 * A test asserts the no-node-import property, because the day someone adds `readFileSync` here is
 * the day the crash path stops working, and it will fail silently in a browser.
 */

import type { DiagnosticEntry } from './redact.js';

/** §H-ENUM. Three kinds, and the set is fixed: §10 triage reads it and the dialog's decision-point
 * ceiling (7) has no room for a fourth. Only the LABELS are customizable (§6b). */
export const FEEDBACK_KINDS = Object.freeze(['bug', 'idea', 'question'] as const);
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/** §H-ENUM. One member, and its single membership is the point: TILL cannot observe a send, so
 * there is no `sent` for a workspace or a plugin to add later. */
export const FEEDBACK_STATES = Object.freeze(['prepared'] as const);

/** Fixed (§6b): a customizable recipient turns a report button into an exfiltration control. */
export const FEEDBACK_RECIPIENT = 'hello@tillbooks.ch';

/**
 * The whole `mailto:` URI budget.
 *
 * Mail handlers on Windows are reported to fail SILENTLY above roughly this length, the click simply
 * doing nothing, so Windows sets the budget for every platform. `INTERNET_MAX_URL_LENGTH` (2083) is
 * the commonly cited neighbouring figure but governs Internet Explorer's address bar rather than
 * `mailto:` dispatch, so this number rests on the observed failure and not on that constant.
 */
export const MAILTO_MAX = 2000;

export const SUBJECT_MAX = 200;
export const MESSAGE_MAX = 4000;

export interface ReportEnvironment {
  readonly version: string;
  readonly runtime: string;
  readonly platform: string;
  readonly locale: string;
  readonly client: string;
}

export interface ReportInput {
  readonly kind: FeedbackKind;
  readonly subject: string;
  readonly message: string;
  readonly at: string;
  readonly env: ReportEnvironment;
  /** `undefined` means the user did not share diagnostics. An empty array means they shared, and
   * there was nothing recorded. The two render differently, because they are different facts. */
  readonly diagnostics?: readonly DiagnosticEntry[] | undefined;
}

/**
 * The human title for each kind. Exported because `listFeedback` has to read it BACK out of an
 * artifact: the log is the directory, so the markdown is the record, and the parser needs the same
 * table the renderer used rather than a second copy that can drift.
 */
export const KIND_TITLE: Record<FeedbackKind, string> = {
  bug: 'Something is broken',
  idea: 'An idea',
  question: 'A question',
};

function renderEntry(entry: DiagnosticEntry, index: number): string {
  const lines = [`### ${index + 1}. ${entry.at}, ${entry.kind}`];
  if (entry.code !== undefined) lines.push(`- Code: ${entry.code}`);
  if (entry.name !== undefined) lines.push(`- Exception: ${entry.name}`);
  if (entry.action !== undefined) lines.push(`- Action: ${entry.action}`);
  if (entry.surface !== undefined) lines.push(`- Screen: ${entry.surface}`);
  if (entry.detailKeys.length > 0) lines.push(`- Fields: ${entry.detailKeys.join(', ')}`);
  if (entry.frames.length > 0) {
    lines.push('- Where:');
    for (const frame of entry.frames) lines.push(`  - ${frame}`);
  }
  return lines.join('\n');
}

function renderDiagnostics(entries: readonly DiagnosticEntry[] | undefined): string {
  if (entries === undefined) {
    return 'No error details shared. The person reporting this chose not to include them.';
  }
  if (entries.length === 0) {
    return 'Error details were shared, and none had been recorded.';
  }
  return entries.map(renderEntry).join('\n\n');
}

/**
 * Render the report. Pure, deterministic, and the only place a report is ever composed.
 *
 * Everything here is either the user's own typed prose or a value the redactor already bounded.
 * Nothing is read from the environment at render time, which is what makes byte-identity between
 * the engine and the browser assertable by a fixture rather than hoped for.
 */
export function renderReport(input: ReportInput): string {
  const { env } = input;
  return [
    `# TILL feedback: ${input.subject}`,
    '',
    `- Kind: ${KIND_TITLE[input.kind]}`,
    `- Written: ${input.at}`,
    `- TILL ${env.version} · ${env.runtime} · ${env.platform} · ${env.locale} · ${env.client}`,
    '',
    '## What happened',
    '',
    input.message,
    '',
    '## Error details',
    '',
    renderDiagnostics(input.diagnostics),
    '',
  ].join('\n');
}

export interface MailtoResult {
  readonly mailto: string;
  readonly mailtoBody: string;
  /** True when the user's text did not fit. NEVER silent: the success state says so and points at
   * Copy report, which always carries the whole thing. */
  readonly truncated: boolean;
}

const TRUNCATION_MARKER = '\n\n[...] The rest is in the full report. Use Copy report in TILL.';

/**
 * Build the `mailto:` URI, fitting the user's own words into the budget and saying so when they do
 * not fit. Diagnostics deliberately never travel here: at roughly 800 characters of plain de-CH text
 * there is no room, and smuggling them into a URL would put them somewhere the user cannot review.
 */
export function buildMailto(subject: string, body: string, max = MAILTO_MAX): MailtoResult {
  const base = `mailto:${FEEDBACK_RECIPIENT}?subject=${encodeURIComponent(subject)}&body=`;
  const fits = (text: string): boolean => base.length + encodeURIComponent(text).length <= max;
  if (fits(body)) return { mailto: base + encodeURIComponent(body), mailtoBody: body, truncated: false };
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(body.slice(0, mid) + TRUNCATION_MARKER)) lo = mid;
    else hi = mid - 1;
  }
  const text = body.slice(0, lo) + TRUNCATION_MARKER;
  return { mailto: base + encodeURIComponent(text), mailtoBody: text, truncated: true };
}

/**
 * Recover the enum member from a rendered title.
 *
 * Found by running the Studio rather than by testing it: `listFeedback` parses `- Kind:` back out of
 * the artifact, so without this it returned "Something is broken" as the `kind` and the panel put an
 * English sentence in the middle of a German table. A row must carry the MEMBER and leave the display
 * title to whichever face is doing the displaying.
 */
export function kindFromTitle(title: string): FeedbackKind | undefined {
  for (const kind of FEEDBACK_KINDS) {
    if (KIND_TITLE[kind] === title) return kind;
  }
  return undefined;
}
