/**
 * G11, `source_as_at` (US-G11.4): each source file's OWN as-of date against the plan's
 * Übernahmestichtag. This is the failure mode a green check most easily hides: an operator exports
 * on day one, maps for a week, and every other control compares TILL against that export while
 * nothing compares the export against the Stichtag. A week-old file can tie out perfectly and still
 * be the wrong position.
 *
 * A format carrying no as-of date reports `not_computable` with the file named, NEVER `passed`:
 * absence of evidence is reported as absence of evidence (US-G11.4 boundary). The recovery for a
 * stale file is G09's superseding upload; deliberately cutting over from an older position is what
 * `migration_waive_control` is for, with the reason carried into the Prüfbericht.
 */

import type { ControlModule } from './registry.js';

/** Whole days between two ISO dates, UTC, so no timezone can move a Stichtag. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

export const sourceAsAt: ControlModule = {
  kind: 'source_as_at',
  declarable: false,
  appliesTo: () => true,
  compute(_ctx, plan, _step, env) {
    const cutover = plan.cutover_date;
    const findings = [];
    for (const file of env.files) {
      if (file.asAt === null) {
        findings.push({
          scope: file.fileId,
          computedMinor: null,
          inputsPresent: false,
          missingInput: 'as_of_date',
          detail: `Beleg ${file.fileId}: das Format trägt kein eigenes Exportdatum`,
        });
        continue;
      }
      if (cutover === null) {
        findings.push({ scope: file.fileId, computedMinor: null, inputsPresent: false, missingInput: 'cutover_date' });
        continue;
      }
      const asAt = file.asAt.slice(0, 10);
      const gap = daysBetween(asAt, cutover);
      findings.push({
        scope: file.fileId,
        computedMinor: gap,
        inputsPresent: true,
        selfStatus: gap === 0 ? ('passed' as const) : ('failed' as const),
        detail:
          gap === 0
            ? `Export vom ${asAt} == Übernahmestichtag`
            : `Beleg ${file.fileId}: Export vom ${asAt}, Übernahmestichtag ${cutover} (${Math.abs(gap)} Tage Abstand)`,
      });
    }
    return findings;
  },
};
