/**
 * The G20 project layer. The claims worth the most:
 *
 *   PLAN-ONLY USE PAYS NO PROJECT TAX: with no open project and no offer, the component renders
 *   nothing at all, so a small migration's plan surface is untouched.
 *
 *   THE EMPTY SURFACE OFFERS TO CREATE, never a blank: with `offerCreateWhenAbsent`, it reaches the
 *   create card and the "ohne Projekt fortfahren" escape.
 *
 *   THREE-STATUS HONESTY CARRIES TO THE SURFACE: a `not_asserted` period renders "Noch nicht geprüft"
 *   (orange), never a passing glyph.
 *
 *   SIGN-OFF WITHOUT commit_migration IS DISABLED, NOT HIDDEN: the reason renders as text.
 *
 * Copy is asserted through the catalogue, never as a literal typed here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { ImplementationProject, IMPL_PROJECT_SKIPPED_KEY_PREFIX } from './ImplementationProject';
import de from './messages.de-CH.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const errRes = (error: string): RestResponse => ({ status: 200, body: { ok: false, error } });

function fakeTransport(canned: Record<string, RestResponse>): Transport {
  return async (action) => canned[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
}

function caps(held: string[]): Capabilities {
  return { whoami: null, can: (c) => held.includes(c), refresh: () => undefined };
}

function tree(canned: Record<string, RestResponse>, opts: { offer?: boolean; held?: string[]; onContinueWithout?: () => void } = {}) {
  const inner = (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <ImplementationProject workspaceId="ws_1" offerCreateWhenAbsent={opts.offer} onContinueWithout={opts.onContinueWithout} />
      </I18nProvider>
    </TillClientProvider>
  );
  if (opts.held === undefined) return inner;
  return <CapabilitiesContext.Provider value={caps(opts.held)}>{inner}</CapabilitiesContext.Provider>;
}

const LOADED = {
  project: { projectId: 'p1', sourceSystem: 'bexio', cutoverDate: '2027-06-30', mwstMethod: 'effektiv', methodChange: false, status: 'cutover' },
  phase: 'cutover',
  phases: ['discovery', 'extraction', 'mapping', 'rehearsal', 'cutover', 'parallel_run', 'live'],
  nextAction: 'Go/No-Go',
  tasks: [
    { taskId: 't1', phase: 'cutover', title: 'Go/No-Go', ownerKind: 'human', dueDate: '2027-06-30', prerequisiteTaskId: 't0', evidenceKind: 'go_nogo', evidenceRef: null, status: 'blocked', reason: null, undeletable: true },
    { taskId: 't2', phase: 'discovery', title: 'Exportliste anlegen', ownerKind: 'agent', dueDate: null, prerequisiteTaskId: null, evidenceKind: null, evidenceRef: null, status: 'open', reason: null, undeletable: false },
  ],
  decisions: [{ decisionId: 'd1', title: 'Stichtag', context: null, decision: 'Neuer Stichtag', actor: 'studio', createdAt: '2027-01-01' }],
  signoffs: [],
  parallelRun: { periods: [{ period: '2027-Q2', status: 'not_asserted', figures: [{ kind: 'trial_balance', ref: '1020', declaredRappen: null, computedRappen: null, differenceRappen: null, status: 'not_asserted' }] }], overall: 'not_asserted' },
  availableRunbookTemplates: [],
};

describe('ImplementationProject', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders nothing when there is no project and no offer (plan-only pays no project tax)', async () => {
    const { container } = render(tree({ implementation_project_list: ok({ projects: [] }) }));
    // waitFor lets the load effect settle inside act(), then the tree stays empty (no project chrome).
    await waitFor(() => expect(container.querySelector('.impl-skeleton')).toBeNull());
    expect(container.querySelector('.impl-project')).toBeNull();
  });

  it('offers to create an implementation project on an empty surface', async () => {
    render(tree({ implementation_project_list: ok({ projects: [] }) }, { offer: true }));
    expect(await screen.findByText(de.implProject.empty)).toBeTruthy();
    expect(screen.getByRole('button', { name: de.implProject.create })).toBeTruthy();
    expect(screen.getByRole('button', { name: de.implProject.continueWithout })).toBeTruthy();
  });

  // P0.4c: the escape used to be a <p>; clicking it changed nothing on the one screen that decides
  // whether a bexio switcher migrates at all.
  it('"Ohne Projekt fortfahren" is a real button that collapses the offer, focuses the next step and remembers the choice', async () => {
    const onContinueWithout = vi.fn();
    const user = userEvent.setup();
    const { unmount } = render(tree({ implementation_project_list: ok({ projects: [] }) }, { offer: true, onContinueWithout }));
    const button = await screen.findByRole('button', { name: de.implProject.continueWithout });
    expect(button.tagName).toBe('BUTTON');
    await user.click(button);

    // The offer is gone (no create form, no explainer), one line says where to go on, and it has focus.
    expect(screen.queryByRole('button', { name: de.implProject.create })).toBeNull();
    expect(screen.queryByText(de.implProject.empty)).toBeNull();
    const line = screen.getByText(de.implProject.skipped);
    expect(document.activeElement).toBe(line);
    expect(onContinueWithout).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(`${IMPL_PROJECT_SKIPPED_KEY_PREFIX}ws_1`)).toBe('1');
    unmount();

    // The next visit remembers it, and the way back restores the offer.
    render(tree({ implementation_project_list: ok({ projects: [] }) }, { offer: true }));
    expect(await screen.findByText(de.implProject.skipped)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: de.implProject.createAnyway }));
    expect(screen.getByRole('button', { name: de.implProject.create })).toBeTruthy();
    expect(window.localStorage.getItem(`${IMPL_PROJECT_SKIPPED_KEY_PREFIX}ws_1`)).toBeNull();
  });

  it('a Studio that cannot store the choice still continues (storage throws)', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      const user = userEvent.setup();
      render(tree({ implementation_project_list: ok({ projects: [] }) }, { offer: true }));
      await user.click(await screen.findByRole('button', { name: de.implProject.continueWithout }));
      expect(screen.getByText(de.implProject.skipped)).toBeTruthy();
    } finally {
      setItem.mockRestore();
    }
  });

  it('leads with the project: phase strip (Stabilisierung), tasks and a not_asserted parallel period', async () => {
    render(tree({
      implementation_project_list: ok({ projects: [{ projectId: 'p1', phase: 'cutover' }] }),
      implementation_project_get: ok(LOADED),
    }));
    // The live phase is labelled Stabilisierung in the strip.
    expect(await screen.findByText(de.implProject.phase.liveLabel)).toBeTruthy();
    // A blocked task shows what it waits on.
    expect(screen.getByText(de.implProject.task.blockedBy.replace('{item}', 't0'))).toBeTruthy();
    // The not_asserted period renders "Noch nicht geprüft", never a passing state.
    expect(screen.getAllByText(de.implProject.parallel.notAsserted).length).toBeGreaterThan(0);
  });

  it('a sign-off control without commit_migration is disabled with the reason as text', async () => {
    render(tree(
      { implementation_project_list: ok({ projects: [{ projectId: 'p1', phase: 'cutover' }] }), implementation_project_get: ok(LOADED) },
      { held: ['manage_implementation'] }, // holds manage, NOT commit_migration
    ));
    expect(await screen.findByText(de.implProject.signoff.title)).toBeTruthy();
    // No "Unterschreiben" button, and the reason renders instead.
    expect(screen.queryByRole('button', { name: de.implProject.signoff.record })).toBeNull();
    expect(screen.getAllByText(de.implProject.signoff.needsCommit).length).toBeGreaterThan(0);
  });

  it('permission-denied renders the padlock note, not a blank screen', async () => {
    render(tree({ implementation_project_list: errRes('permission_denied') }));
    expect(await screen.findByText(de.implProject.denied)).toBeTruthy();
  });
});
