/**
 * F-13, J2.5: the mandates strip. One screen names every mandate's waiting count; a click switches;
 * a single workspace renders no strip at all; the counts are the engine's totals, never a fake zero;
 * and beyond the eager cap the tail reads only on demand.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspaceId } from '../../app/workspace';
import { EAGER_CAP, MandatesStrip } from './MandatesStrip';

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string): RestResponse => ({ status: 400, body: { ok: false, error } });

function CurrentWorkspace() {
  const id = useWorkspaceId();
  return <output data-testid="current">{id}</output>;
}

function renderStrip(transport: Transport, initialId = 'ws_1') {
  const client = new TillClient(transport);
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId={initialId}>
          <MemoryRouter>
            <MandatesStrip />
            <CurrentWorkspace />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

const WS = (n: number) => ({ workspaceId: `ws_${n}`, name: `Mandat ${n}`, baseCurrency: 'CHF', fiscalYearStart: '2026-01-01' });

/** A transport answering the list and per-workspace summaries, recording which summaries were read. */
function transportFor(workspaces: unknown[], totals: Record<string, number | null | 'fail'>) {
  const read: string[] = [];
  const transport: Transport = async (action, input) => {
    if (action === 'list_workspaces') return ok({ workspaces });
    if (action === 'attention_summary') {
      const id = String((input as { workspaceId: string }).workspaceId);
      read.push(id);
      const total = totals[id];
      if (total === 'fail') return reject('store_busy');
      return ok({ visibleQueues: total === null ? 0 : 3, total: total === undefined ? 0 : total, top: [] });
    }
    return { status: 404, body: { ok: false, error: 'unknown_action' } };
  };
  return { transport, read };
}

describe('F-13 J2.5: the mandates strip', () => {
  it('renders NOTHING for a single workspace: a solo owner never sees a list of themselves', async () => {
    const { transport } = transportFor([WS(1)], { ws_1: 4 });
    const { container } = renderStrip(transport);
    await waitFor(() => expect(container.querySelector('output')).toBeInTheDocument());
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.mandates')).toBeNull();
  });

  it('renders nothing when the list cannot be read (a served stranger, an engine down)', async () => {
    const transport: Transport = async () => reject('permission_denied');
    const { container } = renderStrip(transport);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('.mandates')).toBeNull();
  });

  it('lists every mandate with its waiting count on one screen, the current one marked', async () => {
    const { transport, read } = transportFor([WS(1), WS(2), WS(3)], { ws_1: 2, ws_2: 0, ws_3: null });
    renderStrip(transport);
    const nav = await screen.findByRole('navigation', { name: 'Mandate' });
    await waitFor(() => expect(within(nav).getByText('2 warten')).toBeInTheDocument());
    expect(within(nav).getByText('nichts wartet')).toBeInTheDocument();
    // A denied read (total null) shows the name alone: no zero, no placeholder glyph.
    const third = within(nav).getByRole('button', { name: 'Zu Mandat 3 wechseln' });
    expect(third.textContent).toBe('Mandat 3');
    // The current mandate carries aria-current and is not offered as a switch target.
    const current = within(nav).getByRole('button', { name: 'Mandat 12 warten' });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(read.sort()).toEqual(['ws_1', 'ws_2', 'ws_3']);
  });

  it('one click switches the workspace to the mandate that needs work', async () => {
    const { transport } = transportFor([WS(1), WS(2)], { ws_1: 0, ws_2: 5 });
    renderStrip(transport);
    const nav = await screen.findByRole('navigation', { name: 'Mandate' });
    await waitFor(() => expect(within(nav).getByText('5 warten')).toBeInTheDocument());
    await userEvent.click(within(nav).getByRole('button', { name: 'Zu Mandat 2 wechseln' }));
    expect(screen.getByTestId('current')).toHaveTextContent('ws_2');
  });

  it('a failed count is a muted retry on that row, never a zero', async () => {
    const totals: Record<string, number | null | 'fail'> = { ws_1: 1, ws_2: 'fail' };
    const { transport } = transportFor([WS(1), WS(2)], totals);
    renderStrip(transport);
    const nav = await screen.findByRole('navigation', { name: 'Mandate' });
    await waitFor(() => expect(within(nav).getByText('nicht gelesen')).toBeInTheDocument());
    totals.ws_2 = 3;
    await userEvent.click(within(nav).getByRole('button', { name: 'Erneut versuchen' }));
    await waitFor(() => expect(within(nav).getByText('3 warten')).toBeInTheDocument());
  });

  it('reads the counts of at most EAGER_CAP mandates eagerly; the tail waits behind one disclosure', async () => {
    const many = Array.from({ length: EAGER_CAP + 3 }, (_, i) => WS(i + 1));
    const totals: Record<string, number | null | 'fail'> = {};
    for (const w of many) totals[w.workspaceId] = 1;
    const { transport, read } = transportFor(many, totals);
    renderStrip(transport);
    const nav = await screen.findByRole('navigation', { name: 'Mandate' });
    await waitFor(() => expect(read.length).toBe(EAGER_CAP));
    expect(within(nav).queryByRole('button', { name: 'Zu Mandat 11 wechseln' })).toBeNull();
    await userEvent.click(within(nav).getByRole('button', { name: `Alle ${many.length} Mandate anzeigen` }));
    await waitFor(() => expect(read.length).toBe(many.length));
    expect(within(nav).getByRole('button', { name: 'Zu Mandat 11 wechseln' })).toBeInTheDocument();
  });

  it('has no axe violations', async () => {
    const { transport } = transportFor([WS(1), WS(2)], { ws_1: 2, ws_2: 0 });
    const { container } = renderStrip(transport);
    await waitFor(() => expect(screen.getByText('2 warten')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });
});
