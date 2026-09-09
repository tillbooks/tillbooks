import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { axe } from 'jest-axe';

import Periods from './index';
import { TillClient, type Transport, type RestResponse } from '../../lib/client';
import { TillClientProvider } from '../../lib/client-context';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { watchReads } from '../../test-transport';
import { AUDIT_ENTITY_KINDS, AUDIT_ACTIONS } from './audit-vocabulary';

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
async function settledAuditPanel(): Promise<HTMLElement> {
  const panel = (await screen.findByRole('region', { name: 'Audit log' })) as HTMLElement;
  await waitFor(() => expect(within(panel).queryByRole('status')).toBeNull());
  return panel;
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
    expect(await screen.findByText('No entries in the audit log yet')).toBeInTheDocument();
    expect(within(locks).getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('renders the empty state when there are no locks', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    expect(
      await screen.findByText('No period closed yet'),
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
    const soft = within(table).getByRole('row', { name: /2026-06/ });
    expect(within(soft).getByText('Soft lock')).toBeInTheDocument();
    expect(within(soft).getByText('01.07.2026')).toBeInTheDocument();
    expect(within(soft).getByRole('button', { name: 'Reopen month' })).toBeEnabled();

    const sealed = within(table).getByRole('row', { name: /2025/ });
    expect(within(sealed).getByText('Hard lock')).toBeInTheDocument();
    // A sealed hard lock is never shown active then rejected: its unlock control is disabled.
    expect(within(sealed).getByRole('button', { name: 'Unlock period' })).toBeDisabled();
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
    const row = within(table).getByRole('row', { name: /2026-06/ });
    expect(within(row).getByRole('button', { name: 'Reopen month' })).toBeDisabled();
    expect(within(row).getByText('Only the owner or a Treuhänder may manage periods.')).toBeInTheDocument();
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
    const row = within(table).getByRole('row', { name: /2026-04/ });
    expect(within(row).getByRole('button', { name: 'Unlock period' })).toBeDisabled();
    expect(within(row).getByText('Only the owner or a Treuhänder may manage periods.')).toBeInTheDocument();
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
    expect(within(table).getByRole('button', { name: 'Reopen month' })).toBeEnabled();
    expect(within(table).getByRole('button', { name: 'Unlock period' })).toBeEnabled();
    expect(within(table).queryByText('Only the owner or a Treuhänder may manage periods.')).toBeNull();
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
    expect(within(dialog).getByText(/2026-06/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Close month' }));

    await waitFor(() => expect(closed).toHaveLength(1));
    expect(closed[0].period).toBe('2026-06');
    expect(closed[0].workspaceId).toBe('ws_test');
    expect(typeof closed[0].idempotencyKey).toBe('string');
    expect(await screen.findByText('Month 2026-06 closed.')).toBeInTheDocument();
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
    await screen.findByRole('region', { name: 'Month-end close 2026-07' });
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
    await userEvent.click(within(table).getByRole('button', { name: 'Reopen month' }));
    await waitFor(() => expect(reopened).toHaveLength(1));
    expect(reopened[0].period).toBe('2026-06');
    expect(typeof reopened[0].idempotencyKey).toBe('string');
    expect(await screen.findByText('Month 2026-06 reopened.')).toBeInTheDocument();
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
    await userEvent.click(within(table).getByRole('button', { name: 'Unlock period' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/legally sealed/i);
  });
});

describe('Periods, year-end close (confirm-gated)', () => {
  it('gates the year-end close behind a confirm dialog, then posts it and shows the carry entry', async () => {
    const closedYears: Record<string, unknown>[] = [];
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_year: (input) => {
        closedYears.push(input);
        // `baseCurrency` rides the answer because the real `close_year` sends it unconditionally,
        // in a CHF book too (yearClose.ts). This fake used to omit it and the panel filled the gap
        // with a defaulted CHF, so the assertion below passed over a franc label nobody had stated.
        return {
          status: 200,
          body: {
            ok: true,
            closingEntryId: 'je_close',
            carryEntryId: 'je_carry',
            result: 250000,
            baseCurrency: 'CHF',
          },
        };
      },
    });
    await screen.findByText(/No period closed yet/);
    await userEvent.selectOptions(screen.getByLabelText('Year'), '2026');
    await userEvent.click(screen.getByRole('button', { name: 'Run year-end close' }));

    // The destructive close never fires on the first click: a confirm dialog stands in front of it.
    const dialog = await screen.findByRole('alertdialog');
    expect(closedYears).toHaveLength(0);
    // The irreversibility is the ENGINE'S sentence (D118 C4), the same one the Review lock shows.
    expect(within(dialog).getByText(/cannot be reopened/i)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run year-end close' }));

    await waitFor(() => expect(closedYears).toHaveLength(1));
    expect(closedYears[0].year).toBe('2026');
    expect(typeof closedYears[0].idempotencyKey).toBe('string');
    expect(await screen.findByText('Year 2026 closed.')).toBeInTheDocument();
    // The posted result renders via formatMoney and the closing entry is linked.
    expect(screen.getByText(/CHF 2'500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/je_close/)).toBeInTheDocument();
  });

  it('surfaces year_already_closed as a dismissable error', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_year: { status: 422, body: { ok: false, error: 'year_already_closed' } },
    });
    await screen.findByText(/No period closed yet/);
    await userEvent.selectOptions(screen.getByLabelText('Year'), '2026');
    await userEvent.click(screen.getByRole('button', { name: 'Run year-end close' }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run year-end close' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That year has already been closed.');
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
    const auditTitle = screen.getByRole('heading', { name: 'Audit log' });
    const panel = auditTitle.closest('section') as HTMLElement;
    expect(within(panel).getByText('Posted')).toBeInTheDocument();
    expect(within(panel).getByText('Closed')).toBeInTheDocument();
    expect(within(panel).getAllByText('15.06.2026')).toHaveLength(2);
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
      const table = await screen.findByRole('table');
      expect(table.textContent).not.toMatch(/audit\.(action|entityKind)\./);
      // The filter dropdown offers every kind too, so a rate history is isolable at all.
      const filter = screen.getByLabelText(locale === 'de-CH' ? 'Objektart' : 'Object kind');
      expect(within(filter).getAllByRole('option')).toHaveLength(AUDIT_ENTITY_KINDS.length + 1);
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
    expect(within(table).getByRole('button', { name: 'Monat wieder öffnen' })).toBeInTheDocument();
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

  it('enters the year through a closed list covering the ten-year retention window', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/No period closed yet/);

    const year = screen.getByLabelText('Year');
    expect(year.tagName).toBe('SELECT');

    const thisYear = new Date().getFullYear();
    const values = within(year)
      .getAllByRole('option')
      .map((o) => (o as HTMLOptionElement).value)
      .filter((v) => v !== '');
    // Ten years back plus the current one, and never a year that has not happened yet.
    expect(values).toHaveLength(11);
    expect(values[0]).toBe(String(thisYear));
    expect(values[values.length - 1]).toBe(String(thisYear - 10));
    expect(values).not.toContain(String(thisYear + 1));
  });

  it('sends ISO to the engine from both pickers, never a Swiss-formatted date', async () => {
    const sent: Record<string, unknown>[] = [];
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      close_month: (input) => {
        sent.push(input);
        return { status: 200, body: { ok: true, period: input.period, kind: 'soft' } };
      },
      close_year: (input) => {
        sent.push(input);
        return { status: 200, body: { ok: true, result: 0 } };
      },
    });
    await screen.findByText(/No period closed yet/);

    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await userEvent.click(screen.getByRole('button', { name: 'Close month' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Close month' }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));

    const thisYear = String(new Date().getFullYear());
    await userEvent.selectOptions(screen.getByLabelText('Year'), thisYear);
    // The spy above fires when the request goes IN FLIGHT, not when its answer has been processed:
    // both close buttons render `disabled={... || busy}` until the continuation commits, and a
    // click on a disabled button is swallowed silently. With the year picked, enabled means
    // exactly "the month close finished", which is the state the next click depends on.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Run year-end close' })).toBeEnabled(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Run year-end close' }));
    await userEvent.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Run year-end close',
      }),
    );
    await waitFor(() => expect(sent).toHaveLength(2));

    expect(sent[0].period).toBe('2026-06');
    expect(sent[1].year).toBe(thisYear);
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
    expect(within(dialog).getByText(/2026-06/)).toBeInTheDocument();
    // The consequence is the engine's close-period sentence (F-07, D118 C4), not surface prose.
    expect(within(dialog).getByText(/against further posting/i)).toBeInTheDocument();
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
    expect(within(dialog).getByText(/2026-06/)).toBeInTheDocument();
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
    const panel = await screen.findByRole('region', { name: /Month-end close \d{4}-\d{2}/ });
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
    const panel = await screen.findByRole('region', { name: /Month-end close \d{4}-\d{2}/ });
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

  it('when every posted bill of the month is paid, the creditor line reads 0 and is not an attention item', async () => {
    renderPeriods({
      list_period_locks: { status: 200, body: { ok: true, locks: [] } },
      ...CHECKLIST,
      list_vendor_bills: { status: 200, body: { ok: true, bills: [{ id: 'vb_paid', status: 'posted', openMinor: 0, billDate: '2026-01-05' }], total: 1, truncated: false } },
    });
    const panel = await screen.findByRole('region', { name: /Month-end close \d{4}-\d{2}/ });
    const creditors = (await within(panel).findByRole('link', { name: 'Open supplier bills' })).closest('[data-line="creditors"]') as HTMLElement;
    expect(within(creditors).getByText('0', { selector: '.period-checklist-count' })).toBeInTheDocument();
    expect(creditors.className).toContain('period-checklist-line--ok');
    // Four: drafts, bank, debtors, review. The engine's attention grade on `open_creditors` (38) is not counted.
    expect(within(panel).getByText(/4 items still need a look/)).toBeInTheDocument();
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
    expect(await screen.findByRole('region', { name: 'Month-end close 2026-05' })).toBeInTheDocument();
    expect(screen.getByLabelText('Month')).toHaveValue('2026-05');
    expect(await screen.findByText(/2026-05 is already closed/)).toBeInTheDocument();
    expect(calls.find((c) => c.action === 'month_end_checklist')?.input.period).toBe('2026-05');
    // The lock row for that month carries the focus hook, and the table lists the newest period first.
    const locks = screen.getByRole('region', { name: 'Closed periods' });
    await within(locks).findByText('2026-07');
    const rows = Array.from(locks.querySelectorAll('tbody tr'));
    expect(rows.map((r) => r.querySelector('.period-num')?.textContent)).toEqual(['2026-07', '2026-05', '2025']);
    const focused = rows.find((r) => r.className.includes('period-row--focus'));
    expect(focused).toHaveTextContent('2026-05');
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
    expect(await screen.findByText(/2026-05 is already closed/)).toBeInTheDocument();
    expect(screen.getByText(/Change the entry date to an open month instead/)).toBeInTheDocument();
  });

  it('J8.6: an open month landing does NOT show the way-out hint (nothing to escape)', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } }, ...CHECKLIST_EMPTY });
    await screen.findByRole('region', { name: /Month-end close \d{4}-\d{2}/ });
    expect(screen.queryByText(/Change the entry date to an open month instead/)).toBeNull();
  });
});

/**
 * F-07 (J4.1, D118 C4): the month close and the year close confirm with the ENGINE'S consequence
 * sentence (`agent.consequence.close-period`), the identical string the Review surface's lock dialog
 * and the Vorschlag card render. The Periods-only wording is gone; nothing here restates the
 * consequence in its own words.
 */
describe('Periods, one lock sentence (F-07)', () => {
  const SENTENCE = 'Seals an accounting period against further posting. A hard seal cannot be reopened.';

  it('the month-close confirm renders the shared close-period sentence', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/Nothing is waiting/);
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-06' } });
    await screen.findByRole('region', { name: 'Month-end close 2026-06' });
    await screen.findByText(/Nothing is waiting/);
    fireEvent.click(screen.getByRole('button', { name: 'Close month' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Close month 2026-06?' });
    const line = dialog.querySelector('.consequence-line') as HTMLElement;
    expect(line).not.toBeNull();
    // F-08 governs `close_month` under the close-period dial: the sentence is the verb's own, no
    // sibling fallback (the pre-F-08 `lock_period` detour is gone).
    expect(line.getAttribute('data-verb')).toBe('close_month');
    expect(line).toHaveTextContent(SENTENCE);
    // No surface-authored consequence beside it: the body carries only what a soft close adds.
    expect(dialog).not.toHaveTextContent(/no longer post/);
  });

  it('the year-close confirm renders the same sentence for close_year', async () => {
    renderPeriods({ list_period_locks: { status: 200, body: { ok: true, locks: [] } } });
    await screen.findByText(/Nothing is waiting/);
    fireEvent.change(screen.getByLabelText('Year'), { target: { value: String(new Date().getFullYear()) } });
    fireEvent.click(screen.getByRole('button', { name: 'Run year-end close' }));
    const dialog = await screen.findByRole('alertdialog');
    const line = dialog.querySelector('.consequence-line') as HTMLElement;
    expect(line.getAttribute('data-verb')).toBe('close_year');
    expect(line).toHaveTextContent(SENTENCE);
  });
});
