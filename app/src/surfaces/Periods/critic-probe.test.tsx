/**
 * CRITIC PROBES (critic/cl-periods, not for develop). Each case reproduces one finding of the
 * non-author critic against claude/cl-periods. Each case was `it.fails` while its defect reproduced;
 * each is a plain `it` now that the defect is fixed, so a regression turns it red.
 */
import { describe, it, expect } from 'vitest';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import Periods from './index';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { watchReads } from '../../test-transport';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

const BASE: Handlers = {
  get_audit_log: { status: 200, body: { ok: true, rows: [], chainVerified: true } },
  month_end_checklist: (input) => ({ status: 200, body: { ok: true, period: input.period, items: [] } }),
  list_reconciliation: { status: 200, body: { ok: true, matched: [], unmatched: [], partial: [] } },
  review_status: (input) => ({ status: 200, body: { ok: true, period: input.period, total: 0, approved: 0, flagged: 0, open: 0, entries: [] } }),
  list_vendor_bills: { status: 200, body: { ok: true, bills: [], total: 0, truncated: false } },
  accrual_list: { status: 200, body: { ok: true, accruals: [], totalMinor: 0, baseCurrency: 'CHF' } },
  provision_list: { status: 200, body: { ok: true, provisions: [], openTotalMinor: 0, baseCurrency: 'CHF' } },
  list_accounts: { status: 200, body: { ...listAccountsFixture, ok: true as const } },
};

const LAST_YEAR = String(new Date().getFullYear() - 1);
const run = (year: string) => ({ runId: `yc_${year}`, templateId: 'year_close', templateLabel: 'Jahresabschluss', periodLabel: year, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, status: 'open', nextItemId: 'accruals', openCount: 20, doneCount: 10, skippedCount: 0, itemCount: 30, createdBy: 'studio' });

let switchTo: (id: string) => void = () => {};
function Switcher() {
  const { setWorkspaceId } = useWorkspace();
  switchTo = setWorkspaceId;
  return null;
}

function renderPeriods(handlers: Handlers) {
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const merged: Handlers = { ...BASE, ...handlers };
  let inFlight = 0;
  const base: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = merged[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    inFlight += 1;
    try {
      return await (typeof h === 'function' ? h(input) : h);
    } finally {
      inFlight -= 1;
    }
  };
  const transport = watchReads(base);
  render(
    <TillClientProvider client={new TillClient(transport)}>
      <I18nProvider initialLocale="en">
        <WorkspaceProvider initialId="ws_a">
          <Switcher />
          <MemoryRouter>
            <Periods canManage canUnlock />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  // Every request the page started has answered and its render has committed. A test that ends on a
  // negative assertion waits on this instead of a fixed sleep: under full-suite load a read (the audit
  // panel's DataTable) could otherwise answer after the test returned and update outside act().
  const settled = async () => {
    await waitFor(() => expect(inFlight).toBe(0));
    await act(async () => {});
  };
  return { calls, transport, settled };
}

describe('critic probe: the direct seal vs an open guided run (G22 §10.12)', () => {
  it('does NOT offer the bare seal for a year whose guided year_close run is open', async () => {
    const { calls, settled } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: (input) => ({ status: 200, body: { ok: true, runs: input.templateId === 'year_close' ? [run(LAST_YEAR)] : [] } }),
      close_year: { status: 200, body: { ok: true, result: 0, baseCurrency: 'CHF', closingEntryId: 'je_c' } },
    });
    await screen.findByRole('link', { name: `Year-end close ${LAST_YEAR}` });
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Close directly …' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Year' }));
    await userEvent.click(screen.getByRole('option', { name: LAST_YEAR }));
    // 60429dd5: picking a year with an open run swapped the bare seal for the hand-off link.
    const confirm = within(dialog).queryByRole('button', { name: 'Run year-end close' });
    if (confirm !== null) await userEvent.click(confirm);
    await settled();
    expect(calls.filter((c) => c.action === 'close_year')).toHaveLength(0);
  });
});

describe('critic probe: workspace switch', () => {
  it('the year-close door never points at the previous workspace run', async () => {
    let lockGate: (() => void) | null = null;
    renderPeriods({
      list_period_locks: (input) =>
        input.workspaceId === 'ws_a'
          ? { status: 200, body: { ok: true, locks: [] } }
          : new Promise<RestResponse>((resolve) => {
              lockGate = () => resolve({ status: 403, body: { ok: false, error: 'permission_denied' } });
            }),
      checklist_list: (input) => ({
        status: 200,
        body: { ok: true, runs: input.workspaceId === 'ws_a' && input.templateId === 'year_close' ? [run(LAST_YEAR)] : [] },
      }),
    });
    await screen.findByRole('link', { name: `Year-end close ${LAST_YEAR}` });
    act(() => switchTo('ws_b'));
    await waitFor(() => expect(lockGate).not.toBeNull());
    await act(async () => {
      lockGate?.();
    });
    // ws_b cannot read its locks; the door must not still carry ws_a's run.
    const door = screen.getByTestId('period-year-close');
    expect(door.getAttribute('href')).not.toContain('yc_');
  });

  it('the year result line of ws_a does not survive a switch to ws_b', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: { status: 200, body: { ok: true, runs: [] } },
      close_year: { status: 200, body: { ok: true, result: 123456, baseCurrency: 'CHF', closingEntryId: 'je_a_close' } },
    });
    await screen.findByText(/No period closed yet/);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Close directly …' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Year' }));
    await userEvent.click(screen.getByRole('option', { name: LAST_YEAR }));
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run year-end close' }));
    await screen.findByTestId('period-year-result');
    act(() => switchTo('ws_b'));
    await waitFor(() => expect(screen.queryByText(/No period closed yet/)).not.toBeNull());
    expect(screen.queryByTestId('period-year-result')).toBeNull();
  });
});

/**
 * ROUND 2 (critic on 6dd21ef6). The F1 guard only knows an open run once `checklist_list` has
 * answered. Each case was `it.fails` while the direct seal still reached `close_year` for a year whose
 * guided run is open; each is a plain `it` now that the confirm waits for a known, successful run read.
 */
describe('critic probe r2: the F1 guard has a window', () => {
  async function confirmDirect(year: string) {
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Close directly …' }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Year' }));
    await userEvent.click(screen.getByRole('option', { name: year }));
    const confirm = within(dialog).queryByRole('button', { name: 'Run year-end close' });
    if (confirm !== null) await userEvent.click(confirm);
    await new Promise((r) => setTimeout(r, 30));
  }
  const SEAL = { status: 200, body: { ok: true, result: 0, baseCurrency: 'CHF', closingEntryId: 'je_c' } } as const;

  it('a custom role with manage_periods but no read_books (define_role allows it) seals a year whose run is open', async () => {
    // Both reads ride read_books; the engine's close_year asserts only manage_periods.
    const { calls } = renderPeriods({
      list_period_locks: { status: 403, body: { ok: false, error: 'permission_denied' } },
      checklist_list: { status: 403, body: { ok: false, error: 'permission_denied' } },
      close_year: SEAL,
    });
    await screen.findByText(/manage periods|Only/i).catch(() => undefined);
    await confirmDirect(LAST_YEAR);
    expect(calls.filter((c) => c.action === 'close_year')).toHaveLength(0);
  });

  it('while checklist_list is still in flight, the confirm is offered for a year whose run is open', async () => {
    let releaseRuns: (() => void) | null = null;
    const { calls, transport } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: () =>
        new Promise<RestResponse>((resolve) => {
          releaseRuns = () => resolve({ status: 200, body: { ok: true, runs: [run(LAST_YEAR)] } });
        }),
      close_year: SEAL,
    });
    await screen.findByText(/No period closed yet/);
    await transport.started('checklist_list');
    await waitFor(() => expect(releaseRuns).not.toBeNull());
    await confirmDirect(LAST_YEAR);
    expect(calls.filter((c) => c.action === 'close_year')).toHaveLength(0);
  });

  it('a refused checklist_list (locks readable) leaves the confirm live for a year whose run exists', async () => {
    const { calls } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: { status: 500, body: { ok: false, error: 'internal' } },
      close_year: SEAL,
    });
    await screen.findByText(/No period closed yet/);
    await confirmDirect(LAST_YEAR);
    expect(calls.filter((c) => c.action === 'close_year')).toHaveLength(0);
  });
});
