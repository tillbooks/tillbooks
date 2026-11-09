/**
 * A25 Review: a workspace switch while a row write is in flight (critic/cl-review, 91e0b750, flipped
 * to assert the fix).
 *
 * The defect, pre-existing on develop at 60429dd5: an approve's re-read ran the load it captured when
 * it started, so a switch from ws_a to ws_b during the approve painted ws_a's rows on the ws_b screen.
 * The fix reads the scope on screen NOW after every await (a stale read never paints) and re-reads
 * through the current load. A switch also clears the selection and an open composer: neither carries
 * over to rows of another workspace.
 */
import { describe, it, expect } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import Review from './index';

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function entry(id: string, status: 'open' | 'flagged' | 'approved') {
  return {
    entryId: id,
    date: '2026-03-15',
    ref: `R-${id}`,
    description: `Buchung ${id}`,
    source: 'manual',
    status,
    reviewer: null,
    lastEventAt: null,
    commentCount: 0,
    flagCount: 0,
  };
}

function payload(entries: ReturnType<typeof entry>[]) {
  return ok({
    period: '2026-03',
    periodStart: '2026-03-01',
    periodEnd: '2026-03-31',
    total: entries.length,
    approved: entries.filter((e) => e.status === 'approved').length,
    flagged: entries.filter((e) => e.status === 'flagged').length,
    open: entries.filter((e) => e.status === 'open').length,
    entries,
  });
}

let switchTo: ((id: string) => void) | null = null;
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  switchTo = setWorkspaceId;
  return null;
}

/** ws_a holds a1, ws_b holds b1; `approve_entry` waits until the test releases it. */
function setup() {
  let releaseApprove: (() => void) | null = null;
  const transport: Transport = async (action, input) => {
    const ws = input.workspaceId;
    if (action === 'review_status') return ws === 'ws_a' ? payload([entry('a1', 'open')]) : payload([entry('b1', 'open')]);
    if (action === 'approve_entry') {
      await new Promise<void>((r) => {
        releaseApprove = r;
      });
      return ok({});
    }
    if (action === 'list_journal') return ok({ entries: [] });
    if (action === 'get_company_profile') return ok({ baseCurrency: 'CHF' });
    if (action === 'list_period_locks') return ok({ locks: [] });
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  render(
    <MemoryRouter initialEntries={['/review']}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_a">
          <Switcher />
          <TillClientProvider client={new TillClient(transport)}>
            <Review />
          </TillClientProvider>
        </WorkspaceProvider>
      </I18nProvider>
    </MemoryRouter>,
  );
  return { release: () => releaseApprove?.(), started: () => releaseApprove !== null };
}

describe('Review: a workspace switch while a row write is in flight', () => {
  it('the approve re-read never paints the old workspace rows on the new workspace screen', async () => {
    const probe = setup();
    const user = userEvent.setup();
    await screen.findByText('Buchung a1');
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    await waitFor(() => expect(probe.started()).toBe(true));
    act(() => switchTo?.('ws_b'));
    await screen.findByText('Buchung b1');
    await act(async () => {
      probe.release();
      await new Promise((r) => setTimeout(r, 50));
    });
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByText('Buchung a1')).toBeNull();
    expect(screen.getByText('Buchung b1')).toBeInTheDocument();
  });

  it('a switch clears the selection and an open composer', async () => {
    setup();
    const user = userEvent.setup();
    await screen.findByText('Buchung a1');
    await user.click(screen.getByRole('button', { name: 'Kommentieren' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Buchung a1').closest('tr')).toHaveAttribute('data-selected');
    act(() => switchTo?.('ws_b'));
    await screen.findByText('Buchung b1');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.querySelector('tbody tr[data-selected]')).toBeNull();
  });
});
