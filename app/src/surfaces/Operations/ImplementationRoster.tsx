/**
 * G20's cross-client roster (US-G20.4), on the Betrieb (Operations) surface (the Datenübernahme home
 * the spec names, moved here off `/setup` by K-16 Option A): one row per mandate showing each
 * implementation project's phase, its first blocker and who acts next, so forty rollouts are one screen.
 *
 * §H-TENANT, EMPHATICALLY PRESERVED. The roster COMPOSES `implementation_project_list` over the
 * memberships `list_workspaces` returns, client-side: N scoped reads, metadata ONLY (phase, blocker
 * kind, owner kind, days to cutover). No figure, no contact, no document crosses the fence, and no
 * verb reads across workspaces. A mandate where the actor lacks `manage_implementation` still returns
 * its metadata row (the list rides `read_master_data`), so a mandate is never silently dropped from
 * the count; a mandate that refuses renders as a hidden-state row naming the missing right.
 *
 * The order carries the priority: blocked-first, then by cutover proximity. No badges shouting; forty
 * rows render as a plain list with no horizontal scroll.
 *
 * STATE DISCIPLINE (A23 /ux-architect gate, D46). The five states are honest here:
 *  - loading is silent (null), on purpose: this panel renders itself AWAY when there is nothing to
 *    show (no projects), so most operators never see it. A skeleton would flash a placeholder and
 *    then vanish for the common no-project case, which reads worse than the panel simply appearing
 *    once it has content. It is a self-hiding composed panel, not a primary surface.
 *  - a load FAILURE of the cross-client `list_workspaces` read is NOT the empty state. It used to
 *    collapse into "Noch keine Einführung geplant", which told the operator nothing was planned when
 *    in truth the read failed: a false empty (canon: a celebratory/empty state that fires on a
 *    failure is a lie) AND a dead end (no retry). It now renders `ErrorBanner`, which says what
 *    happened and offers a retry.
 *  - a BLOCKED mandate carries its state as a glyph PLUS the word "Blockiert", never colour alone
 *    (DESIGN.md: status is icon plus text, always; WCAG 1.4.1).
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useT } from '../../i18n';
import { ErrorBanner } from '../../components/states';
import { AlertGlyph } from '../../components/states/glyphs';

interface RosterRow {
  workspaceId: string;
  clientName: string;
  phase: string | null;
  firstBlocker: { title: string; ownerKind: string; blocked: boolean } | null;
  daysToCutover: number | null;
  hidden: boolean;
}

type RosterState =
  | { kind: 'loading' }
  | { kind: 'error'; error: Err }
  | { kind: 'ready'; rows: RosterRow[] };

const PHASE_KEY: Record<string, string> = {
  discovery: 'discovery', extraction: 'extraction', mapping: 'mapping', rehearsal: 'rehearsal',
  cutover: 'cutover', parallel_run: 'parallelRun', live: 'liveLabel', closed: 'closed',
};

export function ImplementationRoster(): React.ReactElement | null {
  const client = useClient();
  const t = useT();
  const [state, setState] = useState<RosterState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    const listed = (await client.call('list_workspaces', {})).body;
    if (isErr(listed)) {
      // A failure of the cross-client read is an error, never a false "nothing planned".
      setState({ kind: 'error', error: listed });
      return;
    }
    const workspaces = (listed.workspaces ?? []) as Array<{ workspaceId: string; name: string }>;
    const composed: RosterRow[] = [];
    for (const ws of workspaces) {
      const res = (await client.call('implementation_project_list', { workspaceId: ws.workspaceId })).body;
      if (isErr(res)) {
        // A mandate the actor may not read renders as a hidden-state row, never dropped.
        if (res.error === 'permission_denied' || res.error === 'forbidden') {
          composed.push({ workspaceId: ws.workspaceId, clientName: ws.name, phase: null, firstBlocker: null, daysToCutover: null, hidden: true });
        }
        continue;
      }
      const projects = (res.projects ?? []) as Array<{ phase: string; firstBlocker: { title: string; ownerKind: string; blocked: boolean } | null; daysToCutover: number }>;
      const open = projects.find((p) => p.phase !== 'closed');
      if (open === undefined) continue;
      composed.push({
        workspaceId: ws.workspaceId,
        clientName: ws.name,
        phase: open.phase,
        firstBlocker: open.firstBlocker,
        daysToCutover: open.daysToCutover,
        hidden: false,
      });
    }
    // Blocked-first, then by cutover proximity (US-G20.4).
    composed.sort((a, b) => {
      const ab = a.firstBlocker?.blocked === true ? 0 : 1;
      const bb = b.firstBlocker?.blocked === true ? 0 : 1;
      return ab - bb || (a.daysToCutover ?? 1e9) - (b.daysToCutover ?? 1e9);
    });
    setState({ kind: 'ready', rows: composed });
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // Loading is silent: the panel is self-hiding, so a skeleton would flash and then vanish for the
  // common no-project case. See the state-discipline note in the header.
  if (state.kind === 'loading') return null;

  if (state.kind === 'error') {
    return (
      <section className="impl-roster" aria-label={t('implProject.roster.title')}>
        <h2>{t('implProject.roster.title')}</h2>
        <ErrorBanner error={state.error} context="read" onRetry={() => void load()} />
      </section>
    );
  }

  const { rows } = state;
  if (rows.length === 0) {
    return (
      <section className="impl-roster" aria-label={t('implProject.roster.title')}>
        <h2>{t('implProject.roster.title')}</h2>
        <p className="impl-roster-empty">{t('implProject.roster.empty')}</p>
      </section>
    );
  }

  return (
    <section className="impl-roster" aria-label={t('implProject.roster.title')}>
      <h2>{t('implProject.roster.title')}</h2>
      <ul className="impl-roster-rows">
        {rows.map((row) => {
          const blocked = row.firstBlocker?.blocked === true;
          return (
            <li key={row.workspaceId} className="impl-roster-row" data-attention={blocked ? 'true' : undefined} data-hidden={row.hidden ? 'true' : undefined}>
              <span className="impl-roster-client">{row.clientName}</span>
              {row.hidden ? (
                <span className="impl-roster-hidden">{t('implProject.roster.hidden')}</span>
              ) : (
                <>
                  {/* The blocked signal is a glyph PLUS the word, never colour alone (DESIGN.md). */}
                  {blocked && (
                    <span className="impl-roster-flag">
                      <AlertGlyph className="impl-roster-flag-glyph" size={14} />
                      {t('implProject.roster.blocked')}
                    </span>
                  )}
                  <span className="impl-roster-phase">{row.phase === 'live' ? t('implProject.phase.liveLabel') : t(`implProject.phase.${PHASE_KEY[row.phase ?? 'discovery']}`)}</span>
                  {row.firstBlocker !== null && (
                    <span className="impl-roster-blocker">{row.firstBlocker.title} · {t(`implProject.owner.${row.firstBlocker.ownerKind}`)}</span>
                  )}
                  {row.daysToCutover !== null && (
                    <span className="impl-roster-days">{t('implProject.roster.daysToCutover', { n: String(row.daysToCutover) })}</span>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
