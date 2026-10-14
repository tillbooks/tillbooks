import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import Periods from './index';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider, useWorkspace } from '../../app/workspace';
import { watchReads } from '../../test-transport';
import { AUDIT_ENTITY_KINDS, AUDIT_ACTIONS } from './audit-vocabulary';
import listAccountsFixture from '../Accounts/list-accounts.fixture.json';
import { consequenceSentence } from '../../lib/approval-tiers';

type Handler = RestResponse | ((input: Record<string, unknown>) => RestResponse | Promise<RestResponse>);
type Handlers = Record<string, Handler>;

/** An empty, chain-verified audit read so the AuditPanel never 404s in a locks-focused test. */
const AUDIT_EMPTY: RestResponse = { status: 200, body: { ok: true, rows: [], chainVerified: true } };

/** The month-end checklist's four reads (F-07), answered empty so a locks-focused test never 404s them. */
const CHECKLIST_EMPTY: Handlers = {
  month_end_checklist: (input) => ({ status: 200, body: { ok: true, period: input.period, items: [] } }),
  list_reconciliation: { status: 200, body: { ok: true, matched: [], unmatched: [], partial: [] } },
  review_status: (input) => ({ status: 200, body: { ok: true, period: input.period, total: 0, approved: 0, flagged: 0, open: 0, entries: [] } }),
  list_vendor_bills: { status: 200, body: { ok: true, bills: [], total: 0, truncated: false } },
  // A38: the accrual editor's three reads beside the checklist, answered empty for the same reason.
  accrual_list: { status: 200, body: { ok: true, accruals: [], totalMinor: 0, baseCurrency: 'CHF' } },
  provision_list: { status: 200, body: { ok: true, provisions: [], openTotalMinor: 0, baseCurrency: 'CHF' } },
  list_accounts: { status: 200, body: { ...listAccountsFixture, ok: true as const } },
  // The open year_close runs (D152, fail closed): answered, and none, so the direct seal is offered.
  checklist_list: { status: 200, body: { ok: true, runs: [] } },
};

/**
 * `canManage` / `canUnlock` are driven through the SURFACE'S OWN PROPS, not through the lock response.
 *
 * The permission cases below used to reach this state by handing `list_period_locks` a body with
 * `canManage: false, canUnlock: false` on it. That response does not exist. The verb answers
 * `ok({ locks })`, `grep -rn canManage src/` finds nothing, and `Periods.tsx` read the fields as
 * `body.canManage !== false`, so an absent field meant `undefined !== false` and both gates were open
 * in every build that ever shipped. These fixtures were the only things in the whole system that ever
 * made either flag false: a hand-written double agreeing with the surface by construction, going
 * green over a gate that has never once fired.
 *
 * Declaring the payload turned that read into TS2339 and it is gone. What the cases assert is
 * unchanged and still worth asserting: GIVEN the actor may not manage periods, the control is
 * pre-disabled and says why. That is a statement about the surface, so it is made against the
 * surface's own prop. Where production should get the answer is A24's decision and A24 is unbuilt
 * (`allowAllCapabilities`), so nothing here presumes one.
 */
function renderPeriods(
  handlers: Handlers,
  opts: {
    locale?: 'en' | 'de-CH';
    initialId?: string | null;
    canManage?: boolean;
    canUnlock?: boolean;
  } = {},
) {
  const { locale = 'en', initialId = 'ws_test', canManage = true, canUnlock = true } = opts;
  const calls: { action: string; input: Record<string, unknown> }[] = [];
  const merged: Handlers = { get_audit_log: AUDIT_EMPTY, ...CHECKLIST_EMPTY, ...handlers };
  const base: Transport = async (action, input) => {
    calls.push({ action, input });
    const h = merged[action];
    if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof h === 'function' ? h(input) : h;
  };
  // Wrapped so a loading test can await `transport.started(...)`: `calls` records what was asked,
  // but only a wait can tell a read in flight apart from one that never left.
  const transport = watchReads(base);
  const client = new TillClient(transport);
  const utils = render(
    <TillClientProvider client={client}>
      <I18nProvider initialLocale={locale}>
        <WorkspaceProvider initialId={initialId}>
          <MemoryRouter>
            <Periods canManage={canManage} canUnlock={canUnlock} />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...utils, calls, transport };
}

/**
 * The Audit-Log panel with its OWN read answered, rather than the first frame of it.
 *
 * This surface issues two independent reads. `list_period_locks` fills the grid, and `<AuditPanel/>`
 * is mounted unconditionally beside it and then issues `get_audit_log` of its own. The panel renders
 * its `<section>`, its heading and its filter immediately, under a skeleton, so every anchor that
 * waits on the GRID hands back a surface with the panel still moving.
 *
 * That is exactly what the axe tests were doing, and the proof is that they claimed nothing: with
 * `get_audit_log` hung forever, both of them still passed. They were auditing four skeleton bars
 * where a person reads a table, and holding a pending update over the hundreds of milliseconds an
 * axe pass takes, which is how the un-acted-update warning in the loading test above was born.
 *
 * The skeleton is the ONE state the panel cannot be in once the read has answered, whichever way it
 * answered, so waiting for it to go is a statement about the read rather than a sleep, and it does
 * not tie the helper to any particular fixture.
 */
async function settledAuditPanel(region = 'Audit log'): Promise<HTMLElement> {
  const panel = (await screen.findByRole('region', { name: region })) as HTMLElement;
  await waitFor(() => expect(within(panel).queryByRole('status')).toBeNull());
  return panel;
}

/**
 * K-25: the trail is behind the "History" disclosure, closed by default. Open it once the read has
 * settled and hand back the panel.
 */
async function openHistory(name = 'History'): Promise<HTMLElement> {
  const panel = await settledAuditPanel(name === 'Verlauf' ? 'Prüfprotokoll' : 'Audit log');
  await userEvent.click(within(panel).getByRole('button', { name: new RegExp(`^${name}`) }));
  return panel;
}

/**
 * K-21: a lock row's verb lives in its one overflow. Open the row's trigger and hand back the item.
 */
async function openRowAction(row: HTMLElement, trigger: string, item: string): Promise<HTMLElement> {
  await userEvent.click(within(row).getByRole('button', { name: trigger }));
  return screen.findByRole('menuitem', { name: item });
}

function softMonth(over: Record<string, unknown> = {}) {
  return { period: '2026-06', kind: 'soft', lockedAt: '2026-07-01', lockedBy: 'owner', reason: null, ...over };
}

function sealedYear(over: Record<string, unknown> = {}) {
  return { period: '2025', kind: 'hard', lockedAt: '2026-01-05', lockedBy: 'owner', reason: 'year_close', ...over };
}

describe('Periods, five states', () => {
  it('renders the loading skeleton while the period-lock read is in flight', async () => {
    const { transport } = renderPeriods({ list_period_locks: () => new Promise<RestResponse>(() => {}) });
    const locks = screen.getByRole('region', { name: 'Closed periods' });
    // The grid renders its skeleton on the first commit, before any effect has fired, so asserting
    // it straight after render would pass just as well over a grid that never asked for the locks.
    await transport.started('list_period_locks');
    expect(within(locks).getByRole('status')).toHaveAttribute('aria-busy', 'true');

    // The AuditPanel next to the grid runs its OWN read, and that one resolves. Ending the test on
    // the synchronous assertion above left that state update to land after teardown, which is what
    // React was reporting as an un-acted update. Waiting for the panel to settle puts the update
    // back inside act(), and the wait doubles as the real assertion: a still-pending lock read
    // keeps the grid skeleton up even once its neighbour has finished.
    expect(await screen.findByText('Chain verified')).toBeInTheDocument();
    await settledAuditPanel();
    expect(within(locks).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the empty state when there are no locks', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    expect(
      await screen.findByText('No period closed yet.'),
    ).toBeInTheDocument();
  });

  it('renders the error state from a real engine Err code, with retry', async () => {
    const list = vi.fn<() => RestResponse>(() => ({
      status: 422,
      body: { ok: false, error: 'workspace_not_found' },
    }));
    renderPeriods({ list_period_locks: () => list() });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The selected workspace could not be found.');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it('renders the success grid: soft-lock reopen affordance, sealed year with no active control, and passes axe', async () => {
    const { container } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [softMonth(), sealedYear()] } },
    });
    const table = await screen.findByRole('table', { name: undefined });
    const soft = within(table).getByRole('row', { name: /June 2026/ });
    expect(within(soft).getByText('Soft lock')).toBeInTheDocument();
    expect(within(soft).getByText('01.07.2026')).toBeInTheDocument();
    // K-21: the reopen verb is in the row's one overflow, live.
    expect(await openRowAction(soft, 'Actions for June 2026', 'Reopen month')).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');

    const sealed = within(table).getByRole('row', { name: /2025/ });
    expect(within(sealed).getByText('Hard lock')).toBeInTheDocument();
    // A sealed hard lock is never shown active then rejected: it offers no control at all, and the row
    // says why in words.
    expect(within(sealed).queryByRole('button', { name: /Actions for/ })).not.toBeInTheDocument();
    expect(within(sealed).getByText(/legally sealed/i)).toBeInTheDocument();

    // Settled, not merely mounted: see `settledAuditPanel`. Both of this surface's reads have
    // answered here, so the pass audits the finished screen and nothing can update into it.
    await settledAuditPanel();
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });

  it('renders the permission-denied state on a permission_denied read', async () => {
    renderPeriods({
      list_period_locks: { status: 422, body: { ok: false, error: 'permission_denied' } },
    });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
  });
});

describe('Periods, permission-denied controls', () => {
  it('disables the reopen control with a note when the actor cannot manage periods', async () => {
    // NOT VACUOUS, and this was worth measuring rather than assuming: the sibling case in
    // `Journal.test.tsx` still passed both of its button assertions with the capability flipped back
    // on, because a blank create drawer disables its writes anyway. Here it does not. Re-run this
    // with `canManage: true` and the first assertion fails outright with "Received element is not
    // disabled", so the gate really is the only thing holding the button shut.
    renderPeriods(
      { list_period_locks: { status: 200, body: { ok: true, locks: [softMonth()] } } },
      { canManage: false },
    );
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /June 2026/ });
    // The item is offered DISABLED with the reason in its own label (A24), never live then refused.
    const item = await openRowAction(row, 'Actions for June 2026', 'Reopen month (owner or Treuhänder only)');
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('disables the hard-lock unlock control with a note when the actor may not unlock', async () => {
    // The `canUnlock` half had NO test at all until now, on either side of the gate. It is the
    // higher-stakes of the two: unlocking a hard lock is sealing-adjacent, and it was the read that
    // had stood permanently open the longest.
    renderPeriods(
      {
        list_period_locks: {
          status: 200,
          body: { ok: true, locks: [{ period: '2026-04', kind: 'hard', lockedAt: '2026-05-01', reason: null }] },
        },
      },
      { canUnlock: false },
    );
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /April 2026/ });
    const item = await openRowAction(row, 'Actions for April 2026', 'Unlock period (owner or Treuhänder only)');
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('leaves both controls live when the actor may act, which is what production renders today', async () => {
    // The other side of both gates, and the reason the two cases above cannot pass over a surface
    // that simply disables everything. `<Periods />` takes no props at the `/periods` route, so this
    // is also the assertion that the defaults are the pre-fix behaviour: before the payload was
    // declared, `undefined !== false` made both flags true on every response the engine can send.
    renderPeriods({
      list_period_locks: {
        status: 200,
        body: {
          ok: true,
          locks: [softMonth(), { period: '2026-04', kind: 'hard', lockedAt: '2026-05-01', reason: null }],
        },
      },
    });
    const table = await screen.findByRole('table');
    const soft = within(table).getByRole('row', { name: /June 2026/ });
    expect(await openRowAction(soft, 'Actions for June 2026', 'Reopen month')).not.toHaveAttribute('aria-disabled', 'true');
    await userEvent.keyboard('{Escape}');
    const hard = within(table).getByRole('row', { name: /April 2026/ });
    expect(await openRowAction(hard, 'Actions for April 2026', 'Unlock period')).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByText(/owner or Treuhänder only/)).toBeNull();
  });
});

describe('Periods, month close and reopen', () => {
  it('soft-closes a month with an idempotency key and refetches', async () => {
    const closed: Record<string, unknown>[] = [];
    const { calls } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_month: (input) => {
        closed.push(input);
        return { status: 200, body: { ok: true, period: input.period, kind: 'soft' } };
      },
    });
    await screen.findByText(/No period closed yet/);
    // The month picker hands back an ISO `YYYY-MM` value, exactly as a native picker does.
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close month' }));

    // A month close is a period lock on the money path, so it is gated exactly as the year close
    // is: nothing fires on the first click.
    const dialog = await screen.findByRole('alertdialog');
    expect(closed).toHaveLength(0);
    expect(within(dialog).getByText(/June 2026/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close month' }));

    await waitFor(() => expect(closed).toHaveLength(1));
    expect(closed[0].period).toBe('2026-06');
    expect(closed[0].workspaceId).toBe('ws_test');
    expect(typeof closed[0].idempotencyKey).toBe('string');
    expect(await screen.findByText('Month June 2026 closed.')).toBeInTheDocument();
    await waitFor(() =>
      expect(calls.filter((c) => c.action === 'list_period_locks').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('keeps Close month disabled until the month matches YYYY-MM', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    // The checklist for the prefilled month is the LAST read to answer (three calls joined), so it is
    // awaited first: the locks read then lands inside the same wait window rather than between awaits.
    await screen.findByText(/Nothing is waiting/);
    await screen.findByText(/No period closed yet/);
    const btn = screen.getByRole('button', { name: 'Close month' });
    const month = screen.getByLabelText('Month');
    // F-07 (J4.1): the field opens on the previous calendar month, the one a person closing "the
    // month" means, so the control starts enabled; the guard below still holds once it is cleared.
    expect((month as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}$/);
    expect(btn).toBeEnabled();
    fireEvent.change(month, { target: { value: '' } });
    expect(btn).toBeDisabled();
    // `<input type="month">` degrades to a text box in Safari and Firefox, so a nonsense month can
    // still reach this component. The ISO guard has to hold there too, not only in the picker.
    fireEvent.change(month, { target: { value: '2026-13' } });
    expect(btn).toBeDisabled();
    fireEvent.change(month, { target: { value: '' } });
    expect(btn).toBeDisabled();
    fireEvent.change(month, { target: { value: '2026-07' } });
    expect(btn).toBeEnabled();
    // A valid month mounts its checklist; let that read land before the test ends.
    await screen.findByRole('region', { name: 'Month-end close July 2026' });
    await screen.findByText(/Nothing is waiting/);
  });

  it('reopens a soft-closed month', async () => {
    const reopened: Record<string, unknown>[] = [];
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [softMonth()] } },
      reopen_month: (input) => {
        reopened.push(input);
        return { status: 200, body: { ok: true, period: input.period } };
      },
    });
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /June 2026/ });
    await userEvent.click(await openRowAction(row, 'Actions for June 2026', 'Reopen month'));
    await waitFor(() => expect(reopened).toHaveLength(1));
    expect(reopened[0].period).toBe('2026-06');
    expect(typeof reopened[0].idempotencyKey).toBe('string');
    expect(await screen.findByText('Month June 2026 reopened.')).toBeInTheDocument();
  });

  it('surfaces a hard_lock_sealed rejection cleanly instead of throwing', async () => {
    // An unsealed manual hard lock offers Unlock, but the engine may still refuse it.
    renderPeriods({
      list_period_locks: {
        status: 200,
        body: { ok: true, locks: [{ period: '2026-04', kind: 'hard', lockedAt: '2026-05-01', reason: null }] },
      },
      unlock_period: { status: 422, body: { ok: false, error: 'hard_lock_sealed', period: '2026-04' } },
    });
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /April 2026/ });
    await userEvent.click(await openRowAction(row, 'Actions for April 2026', 'Unlock period'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/legally sealed/i);
  });
});

/**
 * D152 rule 3 (cognitive-load pass B3, owner's pick "Guided + overflow", 04.10.2026): the year close
 * has ONE visible door, the guided one. The bare "Run year-end close" (disabled until a year was
 * picked, right beside the picker that unlocked it) moved behind the header overflow as "Close
 * directly …": the same picker, the same confirm and the same `close_year` call as at 60429dd5.
 */
const LAST_YEAR = String(new Date().getFullYear() - 1);
const THIS_YEAR = String(new Date().getFullYear());

/** Open the header overflow's direct seal and pick `year`; hands back the alert dialog. */
async function directClose(year: string): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
  await userEvent.click(await screen.findByRole('menuitem', { name: 'Close directly …' }));
  const dialog = await screen.findByRole('alertdialog');
  await userEvent.click(within(dialog).getByRole('combobox', { name: 'Year' }));
  await userEvent.click(screen.getByRole('option', { name: year }));
  return dialog;
}

describe('Periods, one visible year-close door (D152)', () => {
  it('offers one enabled "Year-end close" link that starts the guided close, and no disabled twin at rest', async () => {
    const { calls } = renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/No period closed yet/);
    const actions = document.querySelector('.periods-actions') as HTMLElement;
    const door = within(actions).getByRole('link', { name: 'Year-end close' });
    // No run open: the checklist list with the year-close Start dialog preselected on the last ended year.
    expect(door).toHaveAttribute('href', `/checklisten?start=year_close&year=${LAST_YEAR}`);
    expect(within(actions).getAllByRole('link')).toHaveLength(1);
    // The only button left in the actions panel is the month close, and it is live.
    expect(within(actions).getAllByRole('button').map((b) => b.textContent)).toEqual(['Close month']);
    for (const control of within(actions).getAllByRole('button')) expect(control).toBeEnabled();
    expect(screen.queryByRole('button', { name: /year-end close/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Year' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Guided year close' })).toBeNull();
    // Nothing on the surface is disabled at rest.
    for (const control of screen.getAllByRole('button')) expect(control).toBeEnabled();
    expect(calls.some((c) => c.action === 'close_year')).toBe(false);
  });

  it('skips a sealed year when handing the guided start its year', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [sealedYear({ period: LAST_YEAR })] } } });
    await screen.findByRole('table');
    expect(screen.getByRole('link', { name: 'Year-end close' })).toHaveAttribute(
      'href',
      `/checklisten?start=year_close&year=${String(Number(LAST_YEAR) - 1)}`,
    );
  });

  it('the header overflow holds the direct seal; its confirm appears only once a year is chosen', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/No period closed yet/);
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Close directly …']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Close directly …' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Close directly …' });
    // At rest: the picker and Cancel, no grey confirm.
    expect(within(dialog).queryByRole('button', { name: 'Run year-end close' })).toBeNull();
    for (const control of within(dialog).getAllByRole('button')) expect(control).toBeEnabled();
    // The picker is a closed list over the ten-year retention window plus this year, never a future year.
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Year' }));
    const values = within(screen.getByRole('listbox', { name: 'Year' }))
      .getAllByRole('option')
      .map((o) => o.getAttribute('data-value'))
      .filter((v) => v !== '');
    expect(values).toHaveLength(11);
    expect(values[0]).toBe(THIS_YEAR);
    expect(values[values.length - 1]).toBe(String(Number(THIS_YEAR) - 10));
    expect(values).not.toContain(String(Number(THIS_YEAR) + 1));
    await userEvent.click(screen.getByRole('option', { name: LAST_YEAR }));
    expect(within(dialog).getByRole('button', { name: 'Run year-end close' })).toBeEnabled();
    expect(screen.getByRole('alertdialog', { name: `Run the year-end close for ${LAST_YEAR}?` })).toBe(dialog);
  });

  it('hides the overflow from an actor who may not manage periods', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } }, { canManage: false });
    await screen.findByText(/No period closed yet/);
    expect(screen.queryByRole('button', { name: 'More actions' })).toBeNull();
  });

  it('has no axe violations with the one door in place', async () => {
    const { container } = renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [softMonth()] } } });
    await screen.findByRole('table');
    await settledAuditPanel();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('passes axe with the direct seal open on a chosen year', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/No period closed yet/);
    await settledAuditPanel();
    const dialog = await directClose(LAST_YEAR);
    expect(await axe(dialog)).toHaveNoViolations();
  });
});

describe('Periods, the direct year-end close (confirm-gated, behind the overflow)', () => {
  it('gates the year-end close behind the confirm, then posts it and shows the result in one line', async () => {
    const closedYears: Record<string, unknown>[] = [];
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_year: (input) => {
        closedYears.push(input);
        // `baseCurrency` rides the answer because the real `close_year` sends it unconditionally,
        // in a CHF book too (yearClose.ts).
        return {
          status: 200,
          body: { ok: true, closingEntryId: 'je_close', carryEntryId: 'je_carry', result: 250000, baseCurrency: 'CHF' },
        };
      },
    });
    await screen.findByText(/No period closed yet/);
    const dialog = await directClose(THIS_YEAR);
    // The destructive close never fires before the confirm is pressed.
    expect(closedYears).toHaveLength(0);
    // The consequence is the ENGINE'S sentence (D118 C4, D156), the same one an approver reads.
    const line = dialog.querySelector('.consequence-line') as HTMLElement;
    expect(line.getAttribute('data-verb')).toBe('close_year');
    expect(line).toHaveTextContent(consequenceSentence('close_year', 'en') as string);
    expect(within(dialog).getByText('The year-end close posts the result to accounts 2979 and 2970.')).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run year-end close' }));

    await waitFor(() => expect(closedYears).toHaveLength(1));
    expect(await screen.findByText(`Year ${THIS_YEAR} closed.`)).toBeInTheDocument();
    // The posted result and the closing entry, in ONE line.
    const result = screen.getByTestId('period-year-result');
    expect(result.tagName).toBe('P');
    expect(result.textContent).toBe("Year result: CHF 2'500.00 · Carried to 2979 (View closing entry: je_close)");
  });

  /**
   * The payload is pinned against 60429dd5, where the bare door sent `runWrite('close_year', { year,
   * idempotencyKey: newIdempotencyKey() })` through `client.call(action, { workspaceId, ...input })`:
   * exactly three fields, the year as the ISO string, a fresh UUID per attempt.
   */
  it('sends close_year with exactly the 60429dd5 payload: workspaceId, the ISO year, a fresh idempotency key per attempt', async () => {
    const sent: Record<string, unknown>[] = [];
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_year: (input) => {
        sent.push(input);
        return sent.length === 1
          ? { status: 422, body: { ok: false, error: 'period_locked', period: input.year } }
          : { status: 200, body: { ok: true, result: 0, baseCurrency: 'CHF' } };
      },
    });
    await screen.findByText(/No period closed yet/);
    await userEvent.click(within(await directClose(LAST_YEAR)).getByRole('button', { name: 'Run year-end close' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    await screen.findByRole('alert');
    await userEvent.click(within(await directClose(LAST_YEAR)).getByRole('button', { name: 'Run year-end close' }));
    await waitFor(() => expect(sent).toHaveLength(2));
    for (const input of sent) {
      expect(Object.keys(input).sort()).toEqual(['idempotencyKey', 'workspaceId', 'year']);
      expect(input.workspaceId).toBe('ws_test');
      expect(input.year).toBe(LAST_YEAR);
      expect(input.idempotencyKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(JSON.stringify(input)).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
    }
    // A retry is a new attempt, so it carries a new key (§H-IDEMPOTENT), exactly as before.
    expect(sent[0]?.idempotencyKey).not.toBe(sent[1]?.idempotencyKey);
  });

  it('surfaces year_already_closed as a dismissable error', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_year: { status: 422, body: { ok: false, error: 'year_already_closed' } },
    });
    await screen.findByText(/No period closed yet/);
    await userEvent.click(within(await directClose(THIS_YEAR)).getByRole('button', { name: 'Run year-end close' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That year has already been closed.');
  });

  it('surfaces year_close_unverified (critic R6-1) as a sentence: nothing posted, nothing sealed', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_year: { status: 422, body: { ok: false, error: 'year_close_unverified', year: THIS_YEAR, entry: 'pl', reason: 'not_close_source' } },
    });
    await screen.findByText(/No period closed yet/);
    await userEvent.click(within(await directClose(THIS_YEAR)).getByRole('button', { name: 'Run year-end close' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The close could not be verified, so nothing was posted and the year was not sealed.');
    expect(alert).not.toHaveTextContent('year_close_unverified');
  });

  it('cancelling the direct seal sends nothing', async () => {
    const { calls } = renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/No period closed yet/);
    const dialog = await directClose(THIS_YEAR);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(calls.some((c) => c.action === 'close_year')).toBe(false);
  });
});

describe('Audit-Log panel + chain verification', () => {
  function auditRow(over: Record<string, unknown> = {}) {
    return {
      id: 'al_1',
      entityKind: 'entry',
      entityId: 'je_1',
      action: 'post',
      actor: 'owner',
      at: '2026-06-15T09:00:00.000Z',
      ...over,
    };
  }

  it('shows an empty audit panel before any activity', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      get_audit_log: { status: 200, body: { ok: true, rows: [], chainVerified: true } },
    });
    await openHistory();
    expect(await screen.findByText('No entries in the audit log yet')).toBeInTheDocument();
  });

  it('renders the trail with a chain-verified badge, glyph plus text', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      get_audit_log: {
        status: 200,
        body: { ok: true, rows: [auditRow(), auditRow({ id: 'al_2', action: 'close', entityKind: 'period_lock' })], chainVerified: true },
      },
    });
    expect(await screen.findByText('Chain verified')).toBeInTheDocument();
    const panel = await openHistory();
    expect(within(panel).getByText('Posted')).toBeInTheDocument();
    expect(within(panel).getByText('Closed')).toBeInTheDocument();
    expect(within(panel).getAllByText('15.06.2026')).toHaveLength(2);
  });

  it('K-25: the trail sits behind "History", shows the newest 20, and loads 50 more at a time', async () => {
    // 75 rows, oldest first as the engine stores the chain.
    const rows = Array.from({ length: 75 }, (_, i) =>
      auditRow({ id: `al_${i}`, at: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z`, actor: 'user_1' }),
    );
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      get_audit_log: { status: 200, body: { ok: true, rows, chainVerified: true } },
    });
    const panel = await settledAuditPanel();
    // Closed by default: the chain status is in view, the 75 rows are not.
    expect(within(panel).getByText('Chain verified')).toBeInTheDocument();
    const toggle = within(panel).getByRole('button', { name: /^History/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(panel).queryByRole('table')).toBeNull();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const bodyRows = () => within(panel).getByRole('table').querySelectorAll('tbody tr');
    expect(bodyRows()).toHaveLength(20);
    expect(within(panel).getByText('20 of 75')).toBeInTheDocument();
    // K-38: a minted seat id reads as a person, never "user_1".
    expect(within(panel).queryByText('user_1')).toBeNull();
    expect(within(panel).getAllByText('Person 1').length).toBeGreaterThan(0);

    await userEvent.click(within(panel).getByRole('button', { name: 'Load more' }));
    expect(bodyRows()).toHaveLength(70);
    await userEvent.click(within(panel).getByRole('button', { name: 'Load more' }));
    expect(bodyRows()).toHaveLength(75);
    expect(within(panel).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  // The regression this guards: the genesis `workspace`/`create` row rendered its raw dot-path keys
  // (`audit.entityKind.workspace`, `audit.action.create`) straight at the user.
  it('renders every emitted kind and action as real de-CH copy, never a raw key', async () => {
    renderPeriods(
      {
        list_period_locks: { status: 200, body: { ok: true, locks: [] } },
        get_audit_log: {
          status: 200,
          body: {
            ok: true,
            chainVerified: true,
            rows: [
              auditRow({ id: 'al_1', entityKind: 'workspace', action: 'create' }),
              auditRow({ id: 'al_2', entityKind: 'entry', action: 'post' }),
              auditRow({ id: 'al_3', entityKind: 'entry', action: 'reverse' }),
              auditRow({ id: 'al_4', entityKind: 'entry', action: 'close' }),
              auditRow({ id: 'al_5', entityKind: 'period_lock', action: 'lock' }),
              auditRow({ id: 'al_6', entityKind: 'period_lock', action: 'unlock' }),
              auditRow({ id: 'al_7', entityKind: 'exchange_rate', action: 'record' }),
            ],
          },
        },
      },
      { locale: 'de-CH' },
    );
    await openHistory('Verlauf');
    const table = await screen.findByRole('table');
    for (const label of [
      'Arbeitsbereich',
      'Erstellt',
      'Gebucht',
      'Storniert',
      'Abgeschlossen',
      // §H-FX: the fifth emitter. Its row used to reach the Objekt column as a raw dot-path.
      'Wechselkurs',
      'Erfasst',
    ]) {
      expect(within(table).getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(table.textContent).not.toMatch(/audit\.(action|entityKind)\./);
  });

  // The vocabulary is a mirror of the engine, and the mirror is only useful if EVERY member of it
  // can actually reach a screen. Driving the rows off the constants themselves means a kind added to
  // `AUDIT_ENTITY_KINDS` without copy fails here as well as in the drift guard, in both locales.
  it.each(['de-CH', 'en'] as const)(
    'renders a row for every kind and action in the vocabulary as real %s copy',
    async (locale) => {
      const rows = [
        ...AUDIT_ENTITY_KINDS.map((kind, i) => auditRow({ id: `k_${i}`, entityKind: kind })),
        ...AUDIT_ACTIONS.map((action, i) => auditRow({ id: `a_${i}`, action })),
      ];
      renderPeriods(
        {
          list_period_locks: { status: 200, body: { ok: true, locks: [] } },
          get_audit_log: { status: 200, body: { ok: true, chainVerified: true, rows } },
        },
        { locale },
      );
      const panel = await openHistory(locale === 'de-CH' ? 'Verlauf' : 'History');
      // Every row on screen: the trail opens on the newest 20 and loads 50 more at a time (K-25).
      const more = locale === 'de-CH' ? 'Mehr laden' : 'Load more';
      while (within(panel).queryByRole('button', { name: more }) !== null) {
        await userEvent.click(within(panel).getByRole('button', { name: more }));
      }
      const table = await screen.findByRole('table');
      expect(table.querySelectorAll('tbody tr')).toHaveLength(rows.length);
      expect(table.textContent).not.toMatch(/audit\.(action|entityKind)\./);
      // The filter dropdown offers every kind too, so a rate history is isolable at all.
      const filterLabel = locale === 'de-CH' ? 'Objektart' : 'Object kind';
      await userEvent.click(screen.getByRole('combobox', { name: filterLabel }));
      expect(
        within(screen.getByRole('listbox', { name: filterLabel })).getAllByRole('option'),
      ).toHaveLength(AUDIT_ENTITY_KINDS.length + 1);
    },
  );

  it('renders a broken-chain banner naming the first bad row', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      get_audit_log: {
        status: 200,
        body: { ok: true, rows: [auditRow()], chainVerified: false, brokenAtId: 'al_9' },
      },
    });
    expect(await screen.findByText('Chain broken')).toBeInTheDocument();
    const banner = await screen.findByRole('alert');
    expect(banner).toHaveTextContent(/broken at row al_9/i);
  });
});

describe('Periods, de-CH copy', () => {
  it('renders the Swiss German title and lock state with real umlauts', async () => {
    renderPeriods(
      { list_period_locks: { status: 200, body: { ok: true, locks: [softMonth()] } } },
      { locale: 'de-CH' },
    );
    expect(await screen.findByRole('heading', { name: 'Perioden', level: 1 })).toBeInTheDocument();
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Weich gesperrt')).toBeInTheDocument();
    const row = within(table).getByRole('row', { name: /Juni 2026/ });
    expect(await openRowAction(row, 'Aktionen für Juni 2026', 'Monat wieder öffnen')).toBeInTheDocument();
  });
});

describe('Periods, no workspace', () => {
  it('offers the way to /setup instead of a page of dead controls', async () => {
    const { calls } = renderPeriods(
      { list_period_locks: { status: 200, body: { ok: true, locks: [] } } },
      { locale: 'de-CH', initialId: null },
    );
    expect(await screen.findByText('Kein Arbeitsbereich vorhanden')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Arbeitsbereich einrichten' })).toHaveAttribute(
      'href',
      '/setup',
    );
    // And it never calls a ctx verb with a blank tenant.
    expect(calls.filter((c) => c.action === 'list_period_locks')).toEqual([]);
  });
});

/**
 * D15/C1: Swiss display where a date is read, native pickers where one is entered.
 *
 * The load-bearing assertion is the WIRE FORMAT. The human layer is localised by the browser, but
 * the engine contract is ISO and must stay ISO: a picker that started sending `19.07.2026` to
 * `close_month` would be a money-path bug, not a cosmetic one.
 */
describe('Periods, date entry (D15/C1)', () => {
  it('enters the month through a native month picker, not a text box', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/No period closed yet/);

    const month = screen.getByLabelText('Month');
    expect(month).toHaveAttribute('type', 'month');
    // The format hint is inert in a browser that renders the picker and only surfaces where the
    // control degrades to plain text, so the label itself stays free of ISO noise.
    expect(month).toHaveAttribute('placeholder', 'YYYY-MM');
  });

  it('sends ISO to the engine from the month picker, never a Swiss-formatted date', async () => {
    const sent: Record<string, unknown>[] = [];
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_month: (input) => {
        sent.push(input);
        return { status: 200, body: { ok: true, period: input.period, kind: 'soft' } };
      },
    });
    await screen.findByText(/No period closed yet/);

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close month' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Close month' }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));

    expect(sent[0].period).toBe('2026-06');
    // Belt and braces: nothing leaving this surface may carry the Swiss display format.
    for (const call of sent) {
      expect(JSON.stringify(call)).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
    }
  });

  it('renders a lock date in Swiss format, never raw ISO', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [softMonth()] } },
    });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('01.07.2026')).toBeInTheDocument();
    expect(within(table).queryByText('2026-07-01')).not.toBeInTheDocument();
  });
});

/**
 * Item 3: month close carries the same weight as year close.
 *
 * Both are period locks on the money path and both change what can be posted, so the same class of
 * action carries the same gate. The cancel path is the one that matters: a confirm that closes the
 * period anyway is worse than no confirm at all.
 */
describe('Periods, month close confirmation', () => {
  it('states what happens, names the exact period, and says the month can be reopened', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/No period closed yet/);

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close month' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText(/June 2026/)).toBeInTheDocument();
    // The consequence is the engine's close_month sentence (F-07, D118 C4, D156), not surface prose.
    expect(within(dialog).getByText(consequenceSentence('close_month', 'en') as string)).toBeInTheDocument();
    // A month close is reopenable, unlike the year close, and the copy must not overstate it.
    expect(within(dialog).getByText(/you can reopen the month/i)).toBeInTheDocument();
  });

  it('does NOT close the period when the confirm is cancelled', async () => {
    const closed: Record<string, unknown>[] = [];
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_month: (input) => {
        closed.push(input);
        return { status: 200, body: { ok: true, period: input.period, kind: 'soft' } };
      },
    });
    await screen.findByText(/No period closed yet/);

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close month' }));

    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(closed).toHaveLength(0);
    // The typed month survives the cancel, so a mis-click does not cost the user their input.
    expect(screen.getByLabelText('Month')).toHaveValue('2026-06');
  });

  it('uses the "du" register in de-CH and names the period', async () => {
    renderPeriods(
      { list_period_locks: { status: 200, body: { ok: true, locks: [] } } },
      { locale: 'de-CH' },
    );
    await screen.findByText(/Noch keine Periode abgeschlossen/);

    fireEvent.change(screen.getByLabelText('Monat'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Monat abschliessen' }));

    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/kannst du den Monat wieder öffnen/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Juni 2026/)).toBeInTheDocument();
    // "du", never the polite "Sie" (D56, which reverses D49: the register is now du everywhere).
    expect(within(dialog).queryByText(/können Sie/)).toBeNull();
  });

  it('passes axe with the month confirm open', async () => {
    const { container } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
    });
    await screen.findByText(/No period closed yet/);
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close month' }));
    await screen.findByRole('alertdialog');
    await settledAuditPanel();

    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});

/**
 * F-07 (J4.1 ideal step 1, J8.6): the month-end checklist is INLINE on this surface, one line per
 * open item with its count and a link to the surface that resolves it; a `?month=` deep link puts
 * that month in view; and the lock table lists the newest period first.
 */
describe('Periods, the month-end checklist (F-07)', () => {
  const CHECKLIST: Handlers = {
    month_end_checklist: (input) => ({
      status: 200,
      body: {
        ok: true,
        period: input.period,
        items: [
          { kind: 'dangling_drafts', count: 2, drillIds: ['d1', 'd2'], status: 'attention' },
          { kind: 'open_debtors', count: 3, drillIds: [], status: 'attention' },
          { kind: 'open_creditors', count: 38, drillIds: [], status: 'attention' },
          { kind: 'vat_preview', count: 0, drillIds: [], status: 'ok', note: 'payableMinor=100960, creditMinor=0' },
          { kind: 'fx_revaluation', count: 0, drillIds: [], status: 'not_available', note: 'A22 period-end revaluation is not built yet.' },
        ],
      },
    }),
    list_reconciliation: { status: 200, body: { ok: true, matched: [{ id: 'm1' }], unmatched: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }, { id: 'u4' }], partial: [] } },
    review_status: (input) => ({
      status: 200,
      body: { ok: true, period: input.period, total: 16, approved: 4, flagged: 0, open: 12, entries: [] },
    }),
    // The golden shape (critic F2): the engine's `open_creditors` says 38 because a PAID bill stays
    // `posted`; the bills read for the month carries one paid bill, one still open, and one open bill
    // dated AFTER month end (which `/bills` counts today but the month-end picture must not).
    list_vendor_bills: (input) => ({
      status: 200,
      body: {
        ok: true,
        bills: [
          { id: 'vb_paid', status: 'posted', openMinor: 0, billDate: `${String(input.to).slice(0, 7)}-03` },
          { id: 'vb_open', status: 'posted', openMinor: 12_500, billDate: `${String(input.to).slice(0, 7)}-15` },
          { id: 'vb_next', status: 'posted', openMinor: 9_900, billDate: '2999-01-01' },
        ],
        total: 3,
        truncated: false,
      },
    }),
  };

  it('renders every line with its count and a link to the surface that resolves it', async () => {
    const { calls } = renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } }, ...CHECKLIST });
    const panel = await screen.findByRole('region', { name: /Month-end close \w+ \d{4}/ });
    // Five: drafts, bank, debtors, the DERIVED creditor line (one open bill), review. Not the engine's 38.
    expect(await within(panel).findByText(/5 items still need a look/)).toBeInTheDocument();
    const line = (key: string) => panel.querySelector(`[data-line="${key}"]`) as HTMLElement;
    expect(within(line('drafts')).getByRole('link', { name: 'Unposted drafts' })).toHaveAttribute('href', '/journal');
    expect(line('drafts')).toHaveTextContent(/^2/);
    expect(within(line('bank')).getByRole('link', { name: 'Unmatched bank transactions' })).toHaveAttribute('href', '/reconciliation');
    expect(line('bank')).toHaveTextContent(/^4/);
    expect(within(line('debtors')).getByRole('link', { name: 'Open customer invoices' })).toHaveAttribute('href', '/open-items');
    expect(within(line('creditors')).getByRole('link', { name: 'Open supplier bills' })).toHaveAttribute('href', '/bills');
    expect(within(line('vat')).getByRole('link', { name: 'VAT return' })).toHaveAttribute('href', '/mwst');
    // The bills read was made for posted bills dated to the month's last day.
    const bills = calls.find((c) => c.action === 'list_vendor_bills');
    expect(bills?.input.status).toBe('posted');
    expect(bills?.input.to).toMatch(/^\d{4}-\d{2}-(28|29|30|31)$/);
    expect(within(line('review')).getByRole('link', { name: 'Entries not yet approved' })).toHaveAttribute('href', '/review');
    expect(line('review')).toHaveTextContent('4 of 16 approved');
    // The engine's not_available line is reported as such, dim, with no link: never dropped.
    expect(line('fx')).toHaveTextContent('not checked in this version');
    expect(within(line('fx')).queryByRole('link')).toBeNull();
    // The three reads were made for the month in the field, with the month's own bounds.
    const recon = calls.find((c) => c.action === 'list_reconciliation');
    expect(recon?.input.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(recon?.input.to).toMatch(/^\d{4}-\d{2}-(28|29|30|31)$/);
    expect(calls.find((c) => c.action === 'review_status')?.input.period).toBe((recon?.input.from as string).slice(0, 7));
  });

  /**
   * Critic F2 (2026-09-05): the engine's `open_creditors` counts `vendor_bill.status = 'posted'`, the
   * A17 LIFECYCLE, so a paid bill keeps counting (38 on the golden July where 5 were open). The line
   * is derived from `list_vendor_bills` with `/bills`'s own rule instead, and the debtor line names
   * its Stichtag, because the engine's count is as of month end while `/open-items` is as of today.
   */
  it('a paid supplier bill does not count as open: the creditor line is derived from the bills read, not the engine item', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } }, ...CHECKLIST });
    const panel = await screen.findByRole('region', { name: /Month-end close \w+ \d{4}/ });
    const creditors = (await within(panel).findByRole('link', { name: 'Open supplier bills' })).closest('[data-line="creditors"]') as HTMLElement;
    // One bill: the paid one (openMinor 0) and the one dated after month end are out; the engine's 38 never renders.
    expect(within(creditors).getByText('1', { selector: '.period-checklist-count' })).toBeInTheDocument();
    expect(creditors).not.toHaveTextContent('38');
    expect(creditors.className).toContain('period-checklist-line--attention');
    // The debtor line says as of which day it counts.
    const debtors = panel.querySelector('[data-line="debtors"]') as HTMLElement;
    expect(debtors).toHaveTextContent(/as of \d{2}\.\d{2}\.\d{4}/);
    // The summary counts the derived creditor line once, not the engine's grading of it.
    expect(within(panel).getByText(/5 items still need a look/)).toBeInTheDocument();
  });

  it('when every posted bill of the month is paid, the creditor line is not shown and is not an attention item', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      ...CHECKLIST,
      list_vendor_bills: { status: 200, body: { ok: true, bills: [{ id: 'vb_paid', status: 'posted', openMinor: 0, billDate: '2026-01-05' }], total: 1, truncated: false } },
    });
    const panel = await screen.findByRole('region', { name: /Month-end close \w+ \d{4}/ });
    // Four: drafts, bank, debtors, review. The engine's attention grade on `open_creditors` (38) is not counted.
    expect(await within(panel).findByText(/4 items still need a look/)).toBeInTheDocument();
    // A counted zero is a line about nothing (D152 rule 2): it is left out, not printed as "0".
    expect(panel.querySelector('[data-line="creditors"]')).toBeNull();
    expect(within(panel).queryByRole('link', { name: 'Open supplier bills' })).toBeNull();
  });

  /**
   * D152 rule 2 (cognitive-load pass B3): "0 Unverbuchte Entwürfe" was a line about nothing. A line
   * whose count is exactly 0 is hidden; a line with NO count (the MWST preview, a read that did not
   * answer, the FX line the engine cannot check) stays, because hiding it would read as "nothing to
   * do" where nothing was counted.
   */
  it('hides every line whose count is 0 and keeps the lines that carry no count', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      ...CHECKLIST,
      month_end_checklist: (input) => ({
        status: 200,
        body: {
          ok: true,
          period: input.period,
          items: [
            { kind: 'dangling_drafts', count: 0, drillIds: [], status: 'ok' },
            { kind: 'open_debtors', count: 3, drillIds: [], status: 'attention' },
            { kind: 'vat_preview', count: 0, drillIds: [], status: 'ok', note: 'payableMinor=100960, creditMinor=0' },
            { kind: 'fx_revaluation', count: 0, drillIds: [], status: 'not_available' },
          ],
        },
      }),
      list_reconciliation: { status: 200, body: { ok: true, matched: [], unmatched: [], partial: [] } },
      review_status: { status: 500, body: { ok: false, error: 'unexpected_error' } },
    });
    const panel = await screen.findByRole('region', { name: /Month-end close \w+ \d{4}/ });
    await within(panel).findByText(/items? still need/);
    const shown = Array.from(panel.querySelectorAll('[data-line]')).map((l) => l.getAttribute('data-line'));
    // Hidden: drafts (0) and bank (0 unmatched). Shown: the counted debtors and creditors, the MWST
    // preview (no count), the review line whose read failed (no count) and the unchecked FX line.
    expect(shown).toEqual(['debtors', 'creditors', 'vat', 'review', 'fx']);
    expect(panel).not.toHaveTextContent('Unposted drafts');
    expect(panel.querySelector('[data-line="review"]')).toHaveTextContent('could not be read');
    expect(within(panel).getByText(/2 items still need a look/)).toBeInTheDocument();
    // No count cell anywhere reads 0.
    for (const count of panel.querySelectorAll('.period-checklist-count')) expect(count.textContent).not.toBe('0');
  });

  it('with every count at 0 only the uncounted MWST line stays, and the summary says nothing waits', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      ...CHECKLIST_EMPTY,
      month_end_checklist: (input) => ({
        status: 200,
        body: {
          ok: true,
          period: input.period,
          items: [
            { kind: 'dangling_drafts', count: 0, drillIds: [], status: 'ok' },
            { kind: 'open_debtors', count: 0, drillIds: [], status: 'ok' },
            { kind: 'vat_preview', count: 0, drillIds: [], status: 'ok', note: 'payableMinor=0, creditMinor=0' },
          ],
        },
      }),
    });
    const panel = await screen.findByRole('region', { name: /Month-end close \w+ \d{4}/ });
    expect(await within(panel).findByText(/Nothing is waiting/)).toBeInTheDocument();
    expect(Array.from(panel.querySelectorAll('[data-line]')).map((l) => l.getAttribute('data-line'))).toEqual(['vat']);
  });

  it('a ?month= deep link puts that month in the field, in the checklist and on its lock row', async () => {
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const merged: Handlers = {
      get_audit_log: AUDIT_EMPTY,
      ...CHECKLIST_EMPTY,
      list_period_locks: { status: 200, body: { ok: true, locks: [sealedYear(), softMonth({ period: '2026-05' }), softMonth({ period: '2026-07' })] } },
    };
    const transport: Transport = async (action, input) => {
      calls.push({ action, input });
      const h = merged[action];
      if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof h === 'function' ? h(input) : h;
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/periods?month=2026-05']}>
              <Periods canManage canUnlock />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    expect(await screen.findByRole('region', { name: 'Month-end close May 2026' })).toBeInTheDocument();
    expect(screen.getByLabelText('Month')).toHaveValue('2026-05');
    expect(await screen.findByText(/May 2026 is already closed/)).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'month_end_checklist')?.input.period).toBe('2026-05');
    // The lock row for that month carries the focus hook, and the table lists the newest period first.
    const locks = screen.getByRole('region', { name: 'Closed periods' });
    await within(locks).findByText('July 2026');
    const rows = Array.from(locks.querySelectorAll('tbody tr'));
    expect(rows.map((r) => r.querySelector('.period-num')?.textContent)).toEqual(['July 2026', 'May 2026', '2025']);
    // K-24: the deep-linked month is the CURRENT row (aria-current, the selection pill), not a side bar.
    const focused = rows.find((r) => r.getAttribute('aria-current') === 'true');
    expect(focused).toHaveTextContent('May 2026');
    expect(rows.filter((r) => r.getAttribute('aria-current') === 'true')).toHaveLength(1);
  });

  /**
   * F-10 (friction ledger J8.6): the month landing named the door (this month is locked) but not the
   * one-line way out. Reopening the month is the heavy move; changing the entry date to an open month
   * is usually what the operator wants, so the locked state now states it, and an open month does not.
   */
  it('J8.6: a locked month landing states the way out (change the entry date)', async () => {
    const merged: Handlers = {
      get_audit_log: AUDIT_EMPTY,
      ...CHECKLIST_EMPTY,
      list_period_locks: { status: 200, body: { ok: true, locks: [softMonth({ period: '2026-05' })] } },
    };
    const transport: Transport = async (action, input) => {
      const h = merged[action];
      if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof h === 'function' ? h(input) : h;
    };
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider initialLocale="en">
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/periods?month=2026-05']}>
              <Periods canManage canUnlock />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    // The door is named, AND the one-line way out is stated beside it.
    expect(await screen.findByText(/May 2026 is already closed/)).toBeInTheDocument();
    expect(screen.getByText(/Change the entry date to an open month instead/)).toBeInTheDocument();
  });

  it('J8.6: an open month landing does NOT show the way-out hint (nothing to escape)', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } }, ...CHECKLIST_EMPTY });
    await screen.findByRole('region', { name: /Month-end close \w+ \d{4}/ });
    expect(screen.queryByText(/Change the entry date to an open month instead/)).toBeNull();
  });
});

/**
 * F-07 (J4.1, D118 C4): the month close confirms with the ENGINE'S consequence sentence
 * (the engine's one catalogue, D156), the identical string the Review surface's lock dialog, the
 * guided year close and the Vorschlag card render. The Periods-only wording is gone; nothing here
 * restates the consequence in its own words.
 */
describe('Periods, one lock sentence (F-07)', () => {
  const SENTENCE = consequenceSentence('close_month', 'en') as string;

  it('the month-close confirm renders the shared close-period sentence', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/Nothing is waiting/);
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await screen.findByRole('region', { name: 'Month-end close June 2026' });
    await screen.findByText(/Nothing is waiting/);
    fireEvent.click(screen.getByRole('button', { name: 'Close month' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Close month June 2026?' });
    const line = dialog.querySelector('.consequence-line') as HTMLElement;
    expect(line).not.toBeNull();
    // F-08 governs `close_month` under the close-period dial: the sentence is the verb's own, no
    // sibling fallback (the pre-F-08 `lock_period` detour is gone).
    expect(line.getAttribute('data-verb')).toBe('close_month');
    expect(line).toHaveTextContent(SENTENCE);
    // No surface-authored consequence beside it: the body carries only what a soft close adds.
    expect(dialog).not.toHaveTextContent(/no longer post/);
  });

});

describe('Periods, the year_close hand-off (D129 leg 2)', () => {
  const run = (year: string) => ({ runId: `yc_${year}`, templateId: 'year_close', templateLabel: 'Jahresabschluss', periodLabel: year, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, status: 'open', nextItemId: 'year_sealed', openCount: 1, doneCount: 30, skippedCount: 2, itemCount: 33, createdBy: 'studio' });

  it('the one door lands in the open guided run, the oldest year first, and names that year', async () => {
    const { calls } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: (input) => ({
        status: 200,
        body: { ok: true, runs: input.templateId === 'year_close' ? [run('2026'), run('2025')] : [] },
      }),
    });
    await screen.findByText(/No period closed yet/);
    await waitFor(() => expect(calls.some((c) => c.action === 'checklist_list')).toBe(true));
    expect(calls.find((c) => c.action === 'checklist_list')?.input).toMatchObject({ templateId: 'year_close', status: 'open' });
    const door = await screen.findByRole('link', { name: 'Year-end close 2025' });
    expect(door).toHaveAttribute('href', '/checklisten?run=yc_2025');
    expect(screen.getByTestId('period-year-close')).toBe(door);
    expect(screen.queryByRole('link', { name: 'Year-end close 2026' })).toBeNull();
    expect(screen.queryByRole('button', { name: /year-end close/i })).toBeNull();
  });

  it('with no open run, or when the checklists cannot be read, the door opens the checklist list', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: { status: 403, body: { ok: false, error: 'permission_denied' } },
    });
    await screen.findByText(/No period closed yet/);
    expect(screen.getByRole('link', { name: 'Year-end close' })).toHaveAttribute('href', `/checklisten?start=year_close&year=${LAST_YEAR}`);
  });
});

/**
 * Critic F1 on cl-periods (G22 §10.12): the direct seal never seals a year whose guided year_close
 * run is open. As at 60429dd5, picking that year swaps the seal for the hand-off to the run.
 */
describe('Periods, the direct seal defers to an open guided run (G22 §10.12)', () => {
  it('a year with an open run gets the hand-off link and the note, never the confirm; another year gets the confirm', async () => {
    const { calls } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: (input) => ({
        status: 200,
        body: { ok: true, runs: input.templateId === 'year_close' ? [{ runId: `yc_${LAST_YEAR}`, templateId: 'year_close', templateLabel: 'Jahresabschluss', periodLabel: LAST_YEAR, periodStart: `${LAST_YEAR}-01-01`, periodEnd: `${LAST_YEAR}-12-31`, status: 'open', nextItemId: 'accruals', openCount: 20, doneCount: 10, skippedCount: 0, itemCount: 30, createdBy: 'studio' }] : [] },
      }),
    });
    await screen.findByRole('link', { name: `Year-end close ${LAST_YEAR}` });
    const dialog = await directClose(LAST_YEAR);
    expect(within(dialog).queryByRole('button', { name: 'Run year-end close' })).toBeNull();
    expect(within(dialog).queryByText('The year-end close posts the result to accounts 2979 and 2970.')).toBeNull();
    expect(within(dialog).getByTestId('period-open-year-close')).toHaveAttribute('href', `/checklisten?run=yc_${LAST_YEAR}`);
    expect(within(dialog).getByRole('link', { name: 'Open the year close' })).toBeInTheDocument();
    expect(within(dialog).getByText(`A guided year close is running for ${LAST_YEAR}; the seal is its last step.`)).toBeInTheDocument();
    // Another year has no run: the seal and its confirm are back.
    await userEvent.click(within(dialog).getByRole('combobox', { name: 'Year' }));
    await userEvent.click(screen.getByRole('option', { name: THIS_YEAR }));
    expect(within(dialog).getByRole('button', { name: 'Run year-end close' })).toBeEnabled();
    expect(within(dialog).queryByTestId('period-open-year-close')).toBeNull();
    expect(calls.some((c) => c.action === 'close_year')).toBe(false);
  });
});

/**
 * Critic F2/F3 on cl-periods: nothing of workspace A survives a switch to B, and a write still in
 * flight for A when the switch happens paints nothing onto B (no banner, no A locks on B's grid).
 */
describe('Periods, a workspace switch', () => {
  let switchTo: (id: string) => void = () => {};
  function Switcher() {
    const { setWorkspaceId } = useWorkspace();
    switchTo = setWorkspaceId;
    return null;
  }

  it('a month close in flight for A when the user switches to B paints neither its banner nor A\'s locks on B', async () => {
    let releaseClose: (() => void) | null = null;
    const calls: { action: string; input: Record<string, unknown> }[] = [];
    const handlers: Handlers = {
      get_audit_log: AUDIT_EMPTY,
      ...CHECKLIST_EMPTY,
      checklist_list: { status: 200, body: { ok: true, runs: [] } },
      list_period_locks: (input) => ({
        status: 200,
        body: { ok: true, locks: input.workspaceId === 'ws_a' ? [softMonth({ period: '2026-05' })] : [softMonth({ period: '2025-11' })] },
      }),
      close_month: (input) =>
        new Promise<RestResponse>((resolve) => {
          releaseClose = () => resolve({ status: 200, body: { ok: true, period: input.period, kind: 'soft' } });
        }),
    };
    const transport = watchReads(async (action, input) => {
      calls.push({ action, input });
      const h = handlers[action];
      if (h === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
      return typeof h === 'function' ? h(input) : h;
    });
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
    await screen.findByText('May 2026');
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close month' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Close month' }));
    await transport.started('close_month');
    await waitFor(() => expect(releaseClose).not.toBeNull());
    act(() => switchTo('ws_b'));
    await screen.findByText('November 2025');
    const before = calls.length;
    await act(async () => {
      releaseClose?.();
      await new Promise((r) => setTimeout(r, 20));
    });
    // A's answer reached nothing: no banner, no refetch of A's locks, and B's grid still shows B.
    expect(screen.queryByText(/closed\./)).toBeNull();
    expect(calls.slice(before).filter((c) => c.action === 'list_period_locks' && c.input.workspaceId === 'ws_a')).toHaveLength(0);
    expect(screen.queryByText('May 2026')).toBeNull();
    expect(screen.getByText('November 2025')).toBeInTheDocument();
  });
});

/**
 * D152, critic R2-F1 (owner: "Engine guard + fail-closed UI", 04.10.2026): the direct seal's confirm
 * appears only once the open year runs are KNOWN and none is open for the picked year. While the read
 * is in flight it says so; refused or unreadable it says so and links to the checklists; at confirm
 * time it reads the runs again; and an engine `year_close_in_progress` lands on the hand-off.
 */
describe('Periods, the direct seal fails closed (D152, R2-F1)', () => {
  const RUN = (year: string) => ({ runId: `yc_${year}`, templateId: 'year_close', templateLabel: 'Jahresabschluss', periodLabel: year, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, status: 'open', nextItemId: 'accruals', openCount: 20, doneCount: 10, skippedCount: 0, itemCount: 30, createdBy: 'studio' });

  it('while the runs are being read: a quiet checking line, no confirm, nothing sent', async () => {
    const { calls, transport } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: () => new Promise<RestResponse>(() => {}),
    });
    await screen.findByText(/No period closed yet/);
    await transport.started('checklist_list');
    const dialog = await directClose(LAST_YEAR);
    expect(within(dialog).getByTestId('period-runs-checking')).toHaveTextContent('Checking for open guided year closes …');
    expect(within(dialog).queryByRole('button', { name: 'Run year-end close' })).toBeNull();
    expect(calls.some((c) => c.action === 'close_year')).toBe(false);
  });

  it('runs that cannot be read: the note and a link to the checklists, no confirm', async () => {
    const { calls } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: { status: 403, body: { ok: false, error: 'permission_denied' } },
    });
    await screen.findByText(/No period closed yet/);
    const dialog = await directClose(LAST_YEAR);
    await within(dialog).findByTestId('period-runs-unknown');
    expect(within(dialog).getByTestId('period-runs-unknown')).toHaveTextContent('Open guided year closes could not be read, so no direct close is offered here.');
    expect(within(dialog).getByRole('link', { name: 'Go to the checklists' })).toHaveAttribute('href', '/checklisten');
    expect(within(dialog).queryByRole('button', { name: 'Run year-end close' })).toBeNull();
    expect(calls.some((c) => c.action === 'close_year')).toBe(false);
  });

  it('re-reads the runs at confirm time: a run started in between turns the dialog to the hand-off, nothing sent', async () => {
    let reads = 0;
    const { calls } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: () => {
        reads += 1;
        return { status: 200, body: { ok: true, runs: reads === 1 ? [] : [RUN(LAST_YEAR)] } };
      },
    });
    await screen.findByText(/No period closed yet/);
    const dialog = await directClose(LAST_YEAR);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run year-end close' }));
    expect(await within(dialog).findByTestId('period-open-year-close')).toHaveAttribute('href', `/checklisten?run=yc_${LAST_YEAR}`);
    expect(reads).toBe(2);
    expect(calls.some((c) => c.action === 'close_year')).toBe(false);
  });

  it('a re-read that fails at confirm time sends nothing and turns the dialog to unknown', async () => {
    let reads = 0;
    const { calls } = renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      checklist_list: () => {
        reads += 1;
        return reads === 1 ? { status: 200, body: { ok: true, runs: [] } } : { status: 500, body: { ok: false, error: 'internal' } };
      },
    });
    await screen.findByText(/No period closed yet/);
    const dialog = await directClose(LAST_YEAR);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run year-end close' }));
    await within(dialog).findByTestId('period-runs-unknown');
    expect(calls.some((c) => c.action === 'close_year')).toBe(false);
  });

  it('the engine refusal year_close_in_progress keeps the dialog open on the hand-off to the run it names', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_year: { status: 422, body: { ok: false, error: 'year_close_in_progress', year: LAST_YEAR, fiscalYear: LAST_YEAR, yearRunId: 'yc_race' } },
    });
    await screen.findByText(/No period closed yet/);
    const dialog = await directClose(LAST_YEAR);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run year-end close' }));
    expect(await within(dialog).findByTestId('period-open-year-close')).toHaveAttribute('href', '/checklisten?run=yc_race');
    expect(within(dialog).getByText(`A guided year close is running for ${LAST_YEAR}; the seal is its last step.`)).toBeInTheDocument();
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(screen.queryByTestId('period-year-result')).toBeNull();
  });
});
