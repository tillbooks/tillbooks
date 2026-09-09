/**
 * G15 Pendenzen, the Studio hub: the states the design makes load-bearing, rendered from a canned
 * `attention_summary` so every assertion is about what the surface shows, not about the engine.
 *
 *  - the padlock (`visibleQueues == 0`) and the empty state ("Alles erledigt") are DIFFERENT facts
 *    and never render together (design story 1.5, 1.2);
 *  - a failed provider is named once and the empty state stays unreachable (story 1.3);
 *  - the row count does not grow with the backlog (story 1.4);
 *  - the per-workspace "neu" marker tags a row only when it is newer than the last visit (story 9.x);
 *  - there is NO hub-side hide/mute/snooze/clear (story 3.3), and the row overflow triages only;
 *  - the axe pass is clean.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { Attention } from './index';

type Handler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | Handler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned): Transport {
  return async (action, input) => {
    const entry = canned[action];
    if (entry === undefined) return { status: 200, body: { ok: true } };
    return typeof entry === 'function' ? entry(input) : entry;
  };
}

function item(queueId: string, entityId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    queueId,
    entityKind: queueId,
    entityId,
    titleKey: queueId === 'qr_match' ? 'attention.item.qrMatch.title' : 'attention.item.dunningRun.title',
    titleParams: {},
    subtitleKey: queueId === 'qr_match' ? 'attention.item.qrMatch.subtitle' : 'attention.item.dunningRun.subtitle',
    subtitleParams: queueId === 'qr_match' ? { bank: 'PostFinance' } : { count: 3, date: '2026-08-01' },
    since: '2026-08-01',
    urgency: 'open',
    deepLink: { route: queueId === 'qr_match' ? '/reconciliation' : '/dunning', params: { id: entityId } },
    ...over,
  };
}

function renderHub(canned: Canned) {
  const client = new TillClient(fakeTransport(canned));
  return render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">
          <MemoryRouter initialEntries={['/attention']}>
            <Attention />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('Pendenzen: padlock vs empty vs work waiting', () => {
  it('padlock: visibleQueues 0 shows the padlock and NEVER "Alles erledigt", and total is not rendered as 0', async () => {
    renderHub({
      attention_summary: ok({ computedAt: '2026-08-17T14:32:00.000Z', visibleQueues: 0, total: null, incomplete: false, queues: [], top: [], failed: [] }),
    });
    expect(await screen.findByText(/Hier gibt es nichts zu zeigen/)).toBeInTheDocument();
    expect(screen.queryByText('Alles erledigt.')).not.toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('empty: everything readable and nothing waiting shows "Alles erledigt.", only when nothing failed', async () => {
    renderHub({
      attention_summary: ok({ computedAt: '2026-08-17T14:32:00.000Z', visibleQueues: 2, total: 0, incomplete: false, queues: [], top: [], failed: [] }),
    });
    expect(await screen.findByText('Alles erledigt.')).toBeInTheDocument();
  });

  it('the urgency list renders the top rows, the leading row is selected, the amount is tabular', async () => {
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 2,
        total: 5,
        incomplete: false,
        queues: [
          { queueId: 'qr_match', area: 'bank', count: 2, topUrgency: 'open' },
          { queueId: 'dunning_run', area: 'sales', count: 3, topUrgency: 'open' },
        ],
        top: [item('qr_match', 'c1', { amountMinor: 124000, currency: 'CHF' }), item('dunning_run', 'r1')],
        failed: [],
      }),
    });
    expect(await screen.findByText('Zahlung ohne Zuordnung')).toBeInTheDocument();
    expect(screen.getByText('Mahnlauf wartet auf Freigabe')).toBeInTheDocument();
    expect(screen.getByText("CHF 1'240.00")).toBeInTheDocument();
    // The leading row is the selected primary affordance.
    const rows = screen.getAllByRole('button').filter((b) => b.className.includes('att-row-open'));
    expect(rows[0]).toHaveAttribute('aria-current', 'true');
    // The area index renders at two or more visible areas.
    expect(screen.getByText('Nach Bereich')).toBeInTheDocument();
  });
});

describe('Pendenzen: honesty and scale', () => {
  it('a failed provider is named exactly once and the empty state stays unreachable', async () => {
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 2,
        total: 0,
        incomplete: true,
        queues: [],
        top: [],
        failed: ['dunning_run'],
      }),
    });
    expect(await screen.findByText(/Mahnwesen konnte nicht geladen werden/)).toBeInTheDocument();
    expect(screen.queryByText('Alles erledigt.')).not.toBeInTheDocument();
    expect(screen.getByText(/unvollständig/)).toBeInTheDocument();
  });

  it('at scale the row count does not grow with the backlog: 5 rows though the total is 300', async () => {
    const top = Array.from({ length: 5 }, (_, i) => item('qr_match', `c${i}`));
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 1,
        total: 300,
        incomplete: false,
        queues: [{ queueId: 'qr_match', area: 'bank', count: 300, topUrgency: 'open' }],
        top,
        failed: [],
      }),
    });
    await screen.findAllByText('Zahlung ohne Zuordnung');
    const rows = screen.getAllByRole('button').filter((b) => b.className.includes('att-row-open'));
    expect(rows).toHaveLength(5);
    // The count carries the rest: 99+ in the total badge, not 300 rows.
    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('a single visible queue does NOT render the area index (a heading with nothing to index)', async () => {
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 1,
        total: 1,
        incomplete: false,
        queues: [{ queueId: 'qr_match', area: 'bank', count: 1, topUrgency: 'open' }],
        top: [item('qr_match', 'c1')],
        failed: [],
      }),
    });
    await screen.findByText('Zahlung ohne Zuordnung');
    expect(screen.queryByText('Nach Bereich')).not.toBeInTheDocument();
  });
});

describe('Pendenzen: the "neu" marker and the absence of hub-side clearing', () => {
  it('tags a row "neu" only when it is newer than the per-workspace last-seen marker', async () => {
    window.localStorage.setItem('till.attention.lastSeen.ws_test', '2026-08-05T00:00:00.000Z');
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 1,
        total: 2,
        incomplete: false,
        queues: [{ queueId: 'qr_match', area: 'bank', count: 2, topUrgency: 'open' }],
        top: [
          item('qr_match', 'new', { since: '2026-08-10', entityId: 'new' }),
          item('qr_match', 'old', { since: '2026-08-01', entityId: 'old' }),
        ],
        failed: [],
      }),
    });
    await screen.findAllByText('Zahlung ohne Zuordnung');
    // Exactly one "neu" tag: the row whose `since` is newer than the marker.
    expect(screen.getAllByText('neu')).toHaveLength(1);
  });

  it('a missing marker renders zero "neu" tags (never everything tagged new)', async () => {
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 1,
        total: 1,
        incomplete: false,
        queues: [{ queueId: 'qr_match', area: 'bank', count: 1, topUrgency: 'open' }],
        top: [item('qr_match', 'c1', { since: '2026-08-10' })],
        failed: [],
      }),
    });
    await screen.findByText('Zahlung ohne Zuordnung');
    expect(screen.queryByText('neu')).not.toBeInTheDocument();
  });

  it('there is no hub-side hide, mute or snooze anywhere; the row overflow triages only', async () => {
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 1,
        total: 1,
        incomplete: false,
        queues: [{ queueId: 'qr_match', area: 'bank', count: 1, topUrgency: 'open' }],
        top: [item('qr_match', 'c1')],
        failed: [],
      }),
    });
    await screen.findByText('Zahlung ohne Zuordnung');
    for (const banned of [/verbergen/i, /stummschalten/i, /erledigt für heute/i, /snooze/i, /ausblenden/i]) {
      expect(screen.queryByText(banned)).not.toBeInTheDocument();
    }
    // The work list has no archive control (that belongs to the events zone).
    expect(screen.queryByRole('button', { name: /Archivieren:/ })).not.toBeInTheDocument();
  });
});

describe('Pendenzen: the defer (createTask) reports its outcome', () => {
  const oneItem = (extra: Record<string, unknown> = {}): Canned => ({
    attention_summary: ok({
      computedAt: '2026-08-17T14:32:00.000Z',
      visibleQueues: 1,
      total: 1,
      incomplete: false,
      queues: [{ queueId: 'qr_match', area: 'bank', count: 1, topUrgency: 'open' }],
      top: [item('qr_match', 'c1')],
      failed: [],
    }),
    ...extra,
  });

  it('a successful defer confirms it (a defer changes no visible row, so it NEEDS the banner)', async () => {
    const user = userEvent.setup();
    renderHub(oneItem({ tasks_create: ok({ id: 'task_1' }) }));
    await screen.findByText('Zahlung ohne Zuordnung');
    await user.click(screen.getByRole('button', { name: /Aktionen für/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Aufgabe erstellen' }));
    expect(await screen.findByText('Aufgabe erstellt.')).toBeInTheDocument();
  });

  it('a failed tasks_create shows the refusal, NOT a silent success', async () => {
    const user = userEvent.setup();
    renderHub(oneItem({ tasks_create: { status: 422, body: { ok: false, error: 'permission_denied' } } }));
    await screen.findByText('Zahlung ohne Zuordnung');
    await user.click(screen.getByRole('button', { name: /Aktionen für/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Aufgabe erstellen' }));
    expect(await screen.findByText('Dafür fehlt dir die Berechtigung.')).toBeInTheDocument();
    expect(screen.queryByText('Aufgabe erstellt.')).not.toBeInTheDocument();
  });
});

describe('Pendenzen: accessibility', () => {
  it('has no axe violations with work listed', async () => {
    const { container } = renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 2,
        total: 5,
        incomplete: false,
        queues: [
          { queueId: 'qr_match', area: 'bank', count: 2, topUrgency: 'open' },
          { queueId: 'dunning_run', area: 'sales', count: 3, topUrgency: 'open' },
        ],
        top: [item('qr_match', 'c1', { amountMinor: 124000, currency: 'CHF' }), item('dunning_run', 'r1')],
        failed: [],
      }),
      notifications_list: ok({ items: [], unreadCount: 0 }),
    });
    await screen.findByText('Zahlung ohne Zuordnung');
    await waitFor(async () => {
      expect(await axe(container)).toHaveNoViolations();
    });
  });
});
