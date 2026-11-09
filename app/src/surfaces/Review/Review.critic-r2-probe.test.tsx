/**
 * The stale-read guard in `load` itself, adopted from the critic's r2 probe (critic/cl-review-r2,
 * e4b9fbdd): a plain read of ws_a still in flight when the screen switches to ws_b must never paint.
 * Removing the `stale()` checks in Review.tsx's `load` turns this red.
 */
import { describe, it, expect } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import Review from './index';

const ok = (data: Record<string, unknown>): RestResponse => ({ status: 200, body: { ok: true, ...data } });
function entry(id: string) {
  return { entryId: id, date: '2026-03-15', ref: `R-${id}`, description: `Buchung ${id}`, source: 'manual', status: 'open', reviewer: null, lastEventAt: null, commentCount: 0, flagCount: 0 };
}
const payload = (id: string) => ok({ period: '2026-03', periodStart: '2026-03-01', periodEnd: '2026-03-31', total: 1, approved: 0, flagged: 0, open: 1, entries: [entry(id)] });

let switchTo: ((id: string) => void) | null = null;
function Switcher() {
  switchTo = useWorkspace().setWorkspaceId;
  return null;
}

describe('critic r2 probe: the read guard in load', () => {
  it('a slow ws_a read that lands after the switch to ws_b never paints', async () => {
    let releaseA: (() => void) | null = null;
    const transport: Transport = async (action, input) => {
      if (action === 'review_status') {
        if (input.workspaceId === 'ws_a') await new Promise<void>((r) => { releaseA = r; });
        return payload(input.workspaceId === 'ws_a' ? 'a1' : 'b1');
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
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    act(() => switchTo?.('ws_b'));
    await screen.findByText('Buchung b1');
    await act(async () => { releaseA?.(); await new Promise((r) => setTimeout(r, 700)); });
    expect(screen.queryByText('Buchung a1')).toBeNull();
    expect(screen.getByText('Buchung b1')).toBeInTheDocument();
  });
});
