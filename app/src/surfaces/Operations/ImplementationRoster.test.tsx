/**
 * The G20 cross-client roster. The claims worth the most:
 *
 *   IT COMPOSES OVER A23, METADATA ONLY: one row per mandate with a project, driven by list_workspaces
 *   and a scoped implementation_project_list per workspace. No figure crosses the fence.
 *
 *   A NO-PERMISSION MANDATE RENDERS HIDDEN-STATE, never dropped from the count.
 *
 *   BLOCKED-FIRST ORDER: a blocked mandate sorts ahead of an unblocked one.
 *
 * Copy is asserted through the catalogue (the shared implProject namespace), never a literal.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { ImplementationRoster } from './ImplementationRoster';
import de from '../Migration/messages.de-CH.json';
import setupDe from './messages.de-CH.json';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const errRes = (error: string): RestResponse => ({ status: 200, body: { ok: false, error } });

/** A transport that answers per (action, workspaceId), so two mandates can differ. */
function fakeTransport(byWorkspace: Record<string, Record<string, RestResponse>>, top: Record<string, RestResponse>): Transport {
  return async (action, input) => {
    const wid = (input as { workspaceId?: string } | undefined)?.workspaceId;
    if (wid !== undefined && byWorkspace[wid]?.[action] !== undefined) return byWorkspace[wid][action];
    return top[action] ?? { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
}

function tree(byWorkspace: Record<string, Record<string, RestResponse>>, top: Record<string, RestResponse>) {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(byWorkspace, top))}>
      <I18nProvider>
        <ImplementationRoster />
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('ImplementationRoster', () => {
  it('shows the empty state when no mandate has a project', async () => {
    render(tree({}, {
      list_workspaces: ok({ workspaces: [{ workspaceId: 'ws_1', name: 'Alpha GmbH' }] }),
      implementation_project_list: ok({ projects: [] }),
    }));
    expect(await screen.findByText(de.implProject.roster.empty)).toBeTruthy();
  });

  it('composes one metadata row per mandate, blocked-first, with a hidden-state row for no access', async () => {
    render(tree(
      {
        ws_blocked: { implementation_project_list: ok({ projects: [{ projectId: 'p1', phase: 'cutover', firstBlocker: { title: 'Go/No-Go', ownerKind: 'human', blocked: true }, daysToCutover: 20 }] }) },
        ws_calm: { implementation_project_list: ok({ projects: [{ projectId: 'p2', phase: 'discovery', firstBlocker: { title: 'Exportliste', ownerKind: 'agent', blocked: false }, daysToCutover: 5 }] }) },
        ws_forbidden: { implementation_project_list: errRes('forbidden') },
      },
      {
        list_workspaces: ok({ workspaces: [
          { workspaceId: 'ws_calm', name: 'Calm GmbH' },
          { workspaceId: 'ws_blocked', name: 'Blocked GmbH' },
          { workspaceId: 'ws_forbidden', name: 'Locked GmbH' },
        ] }),
      },
    ));
    // The blocked mandate and the calm one both render; the forbidden one is a hidden-state row.
    expect(await screen.findByText('Blocked GmbH')).toBeTruthy();
    expect(screen.getByText('Calm GmbH')).toBeTruthy();
    expect(screen.getByText('Locked GmbH')).toBeTruthy();
    expect(screen.getByText(de.implProject.roster.hidden)).toBeTruthy();

    // Blocked-first: the blocked mandate's row precedes the calm mandate's row in document order.
    const clients = screen.getAllByText(/GmbH/).map((n) => n.textContent);
    expect(clients.indexOf('Blocked GmbH')).toBeLessThan(clients.indexOf('Calm GmbH'));
  });

  it('carries the blocked state as a glyph PLUS the word, never colour alone (WCAG 1.4.1)', async () => {
    render(tree(
      {
        ws_blocked: { implementation_project_list: ok({ projects: [{ projectId: 'p1', phase: 'cutover', firstBlocker: { title: 'Go/No-Go', ownerKind: 'human', blocked: true }, daysToCutover: 20 }] }) },
      },
      { list_workspaces: ok({ workspaces: [{ workspaceId: 'ws_blocked', name: 'Blocked GmbH' }] }) },
    ));
    // The visible WORD carries the meaning: the row is not signalled by colour only.
    const flag = await screen.findByText(setupDe.implProject.roster.blocked);
    expect(flag).toBeTruthy();
    // The glyph beside it is decorative (aria-hidden), so a screen reader hears the word, not "image".
    const glyph = flag.closest('.impl-roster-flag')?.querySelector('svg');
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders an error state with a retry, NEVER a false empty, when the cross-client read fails', async () => {
    let calls = 0;
    const transport: Transport = async (action) => {
      if (action === 'list_workspaces') {
        calls += 1;
        return calls === 1
          ? { status: 422, body: { ok: false, error: 'transport_error' } }
          : { status: 200, body: { ok: true, workspaces: [] } };
      }
      return { status: 404, body: { ok: false, error: 'unknown_action' } };
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <ImplementationRoster />
        </I18nProvider>
      </TillClientProvider>,
    );

    // A failed read is an error, not "nothing planned": the empty sentence must NOT appear.
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(de.implProject.roster.empty)).toBeNull();

    // The retry refetches; the (now empty) list resolves to the honest empty state.
    await userEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));
    expect(await screen.findByText(de.implProject.roster.empty)).toBeTruthy();
  });
});
