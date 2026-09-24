/**
 * The G12 Testmandant panel (component test). The claims worth the most:
 *
 *   THE COMPARISON RENDERS ITS RESULT: "Mit dem Live-Mandanten vergleichen" used to fire the read and
 *   DISCARD the response (nothing appeared). It now lands in state: a per-class count list, a distinct
 *   no-live and no-differences state, and an error line, so the control is never a dead end (f6).
 *
 *   DISCARD SITS BEHIND A REAL CONFIRM: discard destroys the trial workspace, so the first click opens
 *   a confirm sub-state and does NOT call the destructive verb; the disclosure hiding the button was
 *   never a confirmation (f10).
 *
 * Copy is asserted through the catalogue (`messages.de-CH.json`), never as a literal typed here.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { TestmandantPanel } from './TestmandantPanel';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, calls: string[] = []): Transport {
  return async (action, input) => {
    calls.push(action);
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input as Record<string, unknown>) : entry;
  };
}

/** The panel in its PRESENT phase: a Testmandant exists, so the overflow (diff + discard) is on screen. */
function tree(canned: Canned, calls: string[] = []) {
  const base: Canned = {
    migration_get_testmandant: ok({ workspaceId: 'ws_trial', kind: 'sandbox' }),
    get_company_profile: ok({ profile: { name: 'ACME AG' } }),
    ...canned,
  };
  return (
    <TillClientProvider client={new TillClient(fakeTransport(base, calls))}>
      <I18nProvider>
        <MemoryRouter>
          <TestmandantPanel workspaceId="ws_1" planId="migplan_1" planState="planned" checkClean={false} onChanged={() => {}} />
        </MemoryRouter>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('TestmandantPanel prepared ahead of the Stichtag (F-09)', () => {
  it('disables Produktiv setzen with the reason on the control, and offers no type-to-confirm', async () => {
    const calls: string[] = [];
    render(
      <TillClientProvider client={new TillClient(fakeTransport({
        migration_get_testmandant: ok({ workspaceId: 'ws_trial', kind: 'sandbox' }),
        get_company_profile: ok({ profile: { name: 'ACME AG' } }),
      }, calls))}>
        <I18nProvider>
          <MemoryRouter>
            <TestmandantPanel
              workspaceId="ws_1"
              planId="migplan_1"
              planState="trial"
              checkClean
              cutoverPending
              cutoverDate="2026-10-01"
              onChanged={() => {}}
            />
          </MemoryRouter>
        </I18nProvider>
      </TillClientProvider>,
    );
    const button = await screen.findByRole('button', { name: de.migration.testmandant.goProductive });
    expect(button).toBeDisabled();
    const note = screen.getByText(de.migration.testmandant.waitForStichtag.replace('{date}', '01.10.2026'));
    expect(button).toHaveAttribute('aria-describedby', note.id);
    // No type-to-confirm before the date: the control that would be refused is not offered.
    expect(screen.queryByLabelText(de.migration.testmandant.confirmLabel)).toBeNull();
    expect(calls).not.toContain('go_productive');
  });
});

describe('TestmandantPanel diff (f6)', () => {
  it('renders the per-class comparison instead of discarding the read', async () => {
    render(
      tree({
        migration_diff_testmandant_to_live: ok({
          live: { workspaceId: 'ws_live' },
          perClass: [
            { dataClass: 'contacts', testmandantCount: 12, liveCount: 10 },
            { dataClass: 'items', testmandantCount: 5, liveCount: 5 },
          ],
        }),
      }),
    );
    const compare = await screen.findByRole('button', { name: de.migration.testmandant.diff.title });
    fireEvent.click(compare);
    // The changed class renders its two counts, keyed on the data class label.
    expect(await screen.findByText(/Kontakte/)).toBeTruthy();
    expect(screen.queryByText(de.migration.testmandant.diff.same)).toBeNull();
  });

  it('names the no-live state distinctly from a no-differences state', async () => {
    render(tree({ migration_diff_testmandant_to_live: ok({ live: null }) }));
    fireEvent.click(await screen.findByRole('button', { name: de.migration.testmandant.diff.title }));
    expect(await screen.findByText(de.migration.testmandant.diff.noLive)).toBeTruthy();
  });

  it('renders the no-differences state when every class ties out', async () => {
    render(
      tree({
        migration_diff_testmandant_to_live: ok({
          live: { workspaceId: 'ws_live' },
          perClass: [{ dataClass: 'contacts', testmandantCount: 3, liveCount: 3 }],
        }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: de.migration.testmandant.diff.title }));
    expect(await screen.findByText(de.migration.testmandant.diff.same)).toBeTruthy();
  });

  it('names a refused comparison as an alert, never a silent no-op', async () => {
    render(tree({ migration_diff_testmandant_to_live: { status: 200, body: { ok: false, error: 'forbidden' } } }));
    fireEvent.click(await screen.findByRole('button', { name: de.migration.testmandant.diff.title }));
    expect(await screen.findByText(de.migration.testmandant.diff.error)).toBeTruthy();
  });
});

describe('TestmandantPanel discard (f10)', () => {
  it('requires a confirm before the destructive call: the first click does NOT discard', async () => {
    const calls: string[] = [];
    render(tree({ discard_testmandant: ok({}) }, calls));
    const discard = await screen.findByRole('button', { name: de.migration.testmandant.discard });
    fireEvent.click(discard);
    // The confirm sub-state appears and the destructive verb has NOT been called.
    expect(await screen.findByText(de.migration.testmandant.discardConfirm)).toBeTruthy();
    await waitFor(() => {
      expect(calls.filter((c) => c === 'discard_testmandant')).toHaveLength(0);
    });
  });

  it('calls the destructive verb only after the confirm is accepted', async () => {
    const calls: string[] = [];
    render(tree({ discard_testmandant: ok({}) }, calls));
    fireEvent.click(await screen.findByRole('button', { name: de.migration.testmandant.discard }));
    await screen.findByText(de.migration.testmandant.discardConfirm);
    // Two buttons now carry the discard label (the confirm and its danger action); the danger one commits.
    const confirmButtons = screen.getAllByRole('button', { name: de.migration.testmandant.discard });
    const danger = confirmButtons.find((b) => b.className.includes('btn--danger'));
    fireEvent.click(danger as HTMLElement);
    await waitFor(() => {
      expect(calls.filter((c) => c === 'discard_testmandant')).toHaveLength(1);
    });
  });
});
