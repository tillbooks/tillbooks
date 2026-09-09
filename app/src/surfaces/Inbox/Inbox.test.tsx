/**
 * The Posteingang surface: G06's human face over the delivery queue.
 *
 * The suite follows the Aufgaben discipline: a loading assertion waits for the read to have
 * STARTED (the `watchReads` seam, so the skeleton claim is about a load in progress and never
 * about the default state), copy is asserted through the catalogue and never as a literal typed
 * here, and the one English-locale claim renders under `initialLocale="en"`. The self-scope facts
 * (a foreign userId is `forbidden`, an archived item refuses mark-read) are ENGINE tests in
 * `test/notifications/`; what this suite owns is the surface: the five states, the grouping, the
 * live unread figure, the row actions issuing the real verbs, and the preferences panel.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { neverSettles, watchReads } from '../../test-transport';
import Inbox from './index';
import de from './messages.de-CH.json';
import en from './messages.en.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });
const reject = (error: string, extra: Record<string, unknown> = {}, status = 422): RestResponse => ({
  status,
  body: { ok: false, error, ...extra },
});

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

const ITEM = (over: Record<string, unknown> = {}) => ({
  id: 'ntf_1',
  userId: 'studio',
  event: 'task.due',
  entityKind: null,
  entityId: null,
  summaryI18nKey: 'notifications.summary.task_due',
  summaryParams: { title: 'Offerte nachfassen' },
  status: 'unread',
  deliveredVia: 'inbox',
  digestRunId: null,
  createdAt: '2026-07-15T08:00:00.000Z',
  readAt: null,
  archivedAt: null,
  day: '2026-07-15',
  ...over,
});

const PREF = (over: Record<string, unknown> = {}) => ({
  userId: 'studio',
  event: '*',
  channel: 'inbox',
  enabled: true,
  digest: 'instant',
  stored: false,
  ...over,
});

const baseCanned = (): Canned => ({
  notifications_list: ok({ items: [ITEM()], unreadCount: 1 }),
  list_saved_views: ok({ savedViews: [] }),
  notifications_list_preferences: ok({
    preferences: [PREF(), PREF({ channel: 'email', enabled: false }), PREF({ channel: 'push', enabled: false })],
    knownEvents: ['task.due', 'invoice.issued', 'deal.stage_changed'],
  }),
});

function tree(canned: Canned, workspaceId: string | null = 'ws_test', locale?: 'en') {
  return (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider {...(locale === undefined ? {} : { initialLocale: locale })}>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter>
            <Inbox />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
}

describe('Inbox, the load states', () => {
  it('shows the loading skeleton once the queue read has actually started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Inbox />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('notifications_list');
    const statuses = screen.getAllByRole('status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const node of statuses) expect(node).toHaveAttribute('aria-busy', 'true');
  });

  it('states what the surface is for when the inbox is empty, never a bare "No data"', async () => {
    render(tree({ ...baseCanned(), notifications_list: ok({ items: [], unreadCount: 0 }) }));
    expect(await screen.findByText(de.notifications.empty)).toBeInTheDocument();
  });

  it('renders the error banner with a retry when the read fails', async () => {
    render(tree({ ...baseCanned(), notifications_list: reject('io_error', {}, 500) }));
    expect(await screen.findByText(de.notifications.error.transport)).toBeInTheDocument();
  });

  it('renders the denied state when the engine answers forbidden', async () => {
    render(tree({ ...baseCanned(), notifications_list: reject('forbidden', {}, 403) }));
    expect(await screen.findByText(de.notifications.error.permissionDenied.read)).toBeInTheDocument();
  });
});

describe('Inbox, the queue', () => {
  it('groups rows into the three sections, shows the live unread figure, and status as glyph AND label', async () => {
    const canned = {
      ...baseCanned(),
      notifications_list: ok({
        items: [
          ITEM(),
          ITEM({ id: 'ntf_2', status: 'read', summaryI18nKey: 'notifications.summary.invoice_issued', summaryParams: {}, event: 'invoice.issued' }),
          ITEM({ id: 'ntf_3', status: 'archived', summaryI18nKey: 'notifications.summary.payment_recorded', summaryParams: {}, event: 'payment.recorded' }),
        ],
        unreadCount: 1,
      }),
    };
    render(tree(canned));
    expect(await screen.findByText('Aufgabe fällig: Offerte nachfassen')).toBeInTheDocument();
    for (const key of ['unread', 'read', 'archive'] as const) {
      expect(screen.getByRole('heading', { name: new RegExp(de.notifications.section[key]) })).toBeInTheDocument();
    }
    // The unread figure is TEXT in the heading (the number G15's bell will reuse).
    expect(screen.getByText('1 ungelesen')).toBeInTheDocument();
    // Status is text, not colour: the read row carries its label.
    expect(screen.getAllByText(de.notifications.status.read).length).toBeGreaterThan(0);
    // An archived row offers NO mutation: it is outside the mutable set.
    expect(
      screen.queryByRole('button', { name: `${de.notifications.action.archive}: Zahlung erfasst` }),
    ).not.toBeInTheDocument();
  });

  it('renders an unknown summary key as its event id rather than a raw dot-path', async () => {
    const canned = {
      ...baseCanned(),
      notifications_list: ok({
        items: [ITEM({ summaryI18nKey: 'workspace.custom.rule_copy', summaryParams: {}, event: 'quote.accepted' })],
        unreadCount: 1,
      }),
    };
    render(tree(canned));
    expect(await screen.findByText('quote.accepted', { selector: '.inbox-row-summary' })).toBeInTheDocument();
  });

  it('mark read issues the real verb with a fresh idempotency key and re-reads the queue', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned() };
    canned.notifications_mark_read = ok({ notificationId: 'ntf_1', status: 'read' });
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Inbox />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    const button = await screen.findByRole('button', {
      name: `${de.notifications.action.markRead}: Aufgabe fällig: Offerte nachfassen`,
    });
    await user.click(button);
    await waitFor(() => {
      const write = asked.find((a) => a.action === 'notifications_mark_read');
      expect(write).toBeDefined();
      expect(write?.input.notificationId).toBe('ntf_1');
      expect(typeof write?.input.idempotencyKey).toBe('string');
    });
    // The queue re-read follows the write (the count is live, not client-decremented).
    expect(asked.filter((a) => a.action === 'notifications_list').length).toBeGreaterThan(1);
  });

  it('mark all read issues the one-call clear for the caller and surfaces a refusal through the catalogue', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = {
      ...baseCanned(),
      notifications_mark_all_read: reject('notification_not_found'),
    };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Inbox />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: de.notifications.action.markAllRead }));
    expect(await screen.findByText(de.notifications.error.notification_not_found)).toBeInTheDocument();
    const write = asked.find((a) => a.action === 'notifications_mark_all_read');
    expect(write?.input.userId).toBe('studio');
  });

  it('has no axe violations on the loaded queue', async () => {
    const { container } = render(tree(baseCanned()));
    await screen.findByText('Aufgabe fällig: Offerte nachfassen');
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('Inbox, the preferences panel (on the route, D89)', () => {
  it('opens, reads the switchboard, and renders the three channels at their inherited defaults', async () => {
    render(tree(baseCanned()));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: de.notifications.action.openPrefs }));
    expect(await screen.findByRole('heading', { name: de.notifications.prefs.title })).toBeInTheDocument();
    expect(screen.getByText(de.notifications.prefs.channel.inbox)).toBeInTheDocument();
    // The in-app channel is ALWAYS instant: a text, never a cadence picker.
    const cadencePickers = screen.getAllByRole('combobox');
    expect(cadencePickers.length).toBe(2); // email + push only
    expect(screen.getByText(de.notifications.prefs.override.none)).toBeInTheDocument();
  });

  it('toggling a channel issues notifications_set_preference for the caller', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    const canned: Canned = { ...baseCanned(), notifications_set_preference: ok({ preference: PREF({ enabled: false, stored: true }) }) };
    render(
      <TillClientProvider client={new TillClient(fakeTransport(canned, asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter>
              <Inbox />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: de.notifications.action.openPrefs }));
    const toggles = await screen.findAllByRole('checkbox');
    await user.click(toggles[0] as HTMLElement);
    await waitFor(() => {
      const write = asked.find((a) => a.action === 'notifications_set_preference');
      expect(write).toBeDefined();
      expect(write?.input.userId).toBe('studio');
      expect(write?.input.channel).toBe('inbox');
      expect(write?.input.enabled).toBe(false);
      expect(typeof write?.input.idempotencyKey).toBe('string');
    });
  });

  it('surfaces the engine refusal inbox_is_always_instant through the catalogue', async () => {
    const canned: Canned = { ...baseCanned(), notifications_set_preference: reject('inbox_is_always_instant') };
    render(tree(canned));
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: de.notifications.action.openPrefs }));
    const toggles = await screen.findAllByRole('checkbox');
    await user.click(toggles[0] as HTMLElement);
    expect(await screen.findByText(de.notifications.error.inbox_is_always_instant)).toBeInTheDocument();
  });
});

describe('Inbox, the English locale', () => {
  it('renders the route title, unread figure and empty copy from the en catalogue', async () => {
    render(tree({ ...baseCanned(), notifications_list: ok({ items: [], unreadCount: 0 }) }, 'ws_test', 'en'));
    expect(await screen.findByRole('heading', { name: new RegExp(en.notifications.route.title) })).toBeInTheDocument();
    expect(screen.getByText('0 unread')).toBeInTheDocument();
    expect(screen.getByText(en.notifications.empty)).toBeInTheDocument();
  });
});
