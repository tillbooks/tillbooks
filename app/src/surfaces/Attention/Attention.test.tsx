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
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

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
    // K-33: the empty state offers a way on, never a dead end.
    expect(screen.getByRole('link', { name: 'Zur Übersicht' })).toHaveAttribute('href', '/overview');
  });

  it('K-40: the amount is Inter with tabular figures (.t-money), every figure intact, and no text-glyph refresh', async () => {
    renderHub({
      attention_summary: ok({
        computedAt: '2026-08-17T14:32:00.000Z',
        visibleQueues: 1,
        total: 2,
        incomplete: false,
        queues: [{ queueId: 'qr_match', area: 'bank', count: 2, topUrgency: 'overdue' }],
        top: [
          item('qr_match', 'c1', { amountMinor: 9900, currency: 'CHF', urgency: 'overdue' }),
          item('qr_match', 'c2', { amountMinor: 281060, currency: 'CHF' }),
        ],
        failed: [],
      }),
    });
    // The two figures render exactly as formatMoney writes them: the change is the face, not a digit.
    const small = await screen.findByText('CHF 99.00');
    const large = screen.getByText("CHF 2'810.60");
    for (const amount of [small, large]) {
      expect(amount).toHaveClass('att-amount');
      expect(amount).toHaveClass('t-money');
    }
    // The urgency is the shared Status word (glyph plus word), never a text dingbat.
    expect(screen.getByText('überfällig').closest('.status-word')).toHaveAttribute('data-kind', 'warn');
    // The refresh control is a named icon button, not the "⟳" text glyph.
    const refresh = screen.getByRole('button', { name: 'Aktualisieren' });
    expect(refresh.textContent).toBe('');
    expect(refresh.querySelector('svg')).not.toBeNull();
  });

  it('the urgency list renders the top rows, NO row is current on arrival (D152 rule 5), the amount is tabular', async () => {
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
    // D152 rule 5: no row is current on arrival. The roving tab stop still sits on the first row,
    // so Tab lands in the list; focusing a row is the person's act and makes it current.
    const rows = screen.getAllByRole('button').filter((b) => b.className.includes('att-row-open'));
    for (const row of rows) expect(row).not.toHaveAttribute('aria-current');
    expect(rows[0]).toHaveAttribute('tabindex', '0');
    expect(rows[1]).toHaveAttribute('tabindex', '-1');
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

describe('Pendenzen: every queue is named in words, never as a raw key (the bank_keys_review defect)', () => {
  const ebicsItem = (queueId: string): Record<string, unknown> => ({
    queueId,
    entityKind: 'ebics_connection',
    entityId: 'ebconn_synth_9',
    titleKey: 'attention.item.bankActivation.signLetter.title',
    titleParams: { bank: 'Synthbank' },
    subtitleKey: 'attention.item.bankActivation.signLetter.subtitle',
    subtitleParams: { bank: 'Synthbank', lastCheckAt: '2026-10-02T05:02:00.000Z' },
    since: '2026-09-28T08:00:00.000Z',
    urgency: 'open',
    deepLink: { route: '/bank-accounts', params: {} },
    decisionOptions: [
      { id: 'open', verb: null, labelKey: 'attention.act.openBankAccounts', role: 'link', input: {}, deepLink: { route: '/bank-accounts', params: {} } },
    ],
  });
  const single = (queueId: string, labelKey?: string) =>
    ok({
      computedAt: '2026-10-02T06:00:00.000Z',
      visibleQueues: 7,
      total: 1,
      incomplete: false,
      queues: [{ queueId, ...(labelKey !== undefined ? { labelKey } : {}), area: 'bank', count: 1, topUrgency: 'open' }],
      top: [ebicsItem(queueId)],
      failed: [],
    });

  it('bank_keys_review and bank_activation have their own queue labels', async () => {
    const { unmount } = renderHub({ attention_summary: single('bank_keys_review', 'attention.queue.bankKeysReview') });
    expect(await screen.findByRole('heading', { name: 'Bankschlüssel' })).toBeInTheDocument();
    unmount();
    renderHub({ attention_summary: single('bank_activation', 'attention.queue.bankActivation') });
    expect(await screen.findByRole('heading', { name: 'Bank-Freischaltung' })).toBeInTheDocument();
  });

  it("a queue with no queueLabel falls back to the provider's own labelKey, silently (no raw key, no console error)", async () => {
    renderHub({ attention_summary: single('future_queue', 'attention.queue.bankActivation') });
    expect(await screen.findByRole('heading', { name: 'Bank: Freischaltung' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('attention.queueLabel');
  });

  it('a failed queue with no label at all is named by its readable id, never the dot path', async () => {
    renderHub({
      attention_summary: ok({
        computedAt: '2026-10-02T06:00:00.000Z',
        visibleQueues: 2,
        total: 0,
        incomplete: true,
        queues: [],
        top: [],
        failed: ['future_queue'],
      }),
    });
    expect(await screen.findByText(/Future queue/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('attention.queueLabel');
  });

  it('the EBICS letter row says the owner words and the last bank answer in Swiss time', async () => {
    renderHub({ attention_summary: single('bank_activation', 'attention.queue.bankActivation') });
    expect(await screen.findByText('Unterschreibe den INI-Brief für die Synthbank')).toBeInTheDocument();
    expect(screen.getByText(/Zuletzt bei der Synthbank nachgefragt: 02\.10\.2026, 07:02\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bankkonten öffnen' })).toBeInTheDocument();
  });
});

describe('Pendenzen: a list never opens itself (D152 rule 5)', () => {
  const twoRows = () =>
    ok({
      computedAt: '2026-08-17T14:32:00.000Z',
      visibleQueues: 2,
      total: 2,
      incomplete: false,
      queues: [
        { queueId: 'qr_match', area: 'bank', count: 1, topUrgency: 'open' },
        { queueId: 'dunning_run', area: 'sales', count: 1, topUrgency: 'open' },
      ],
      top: [item('qr_match', 'c1'), item('dunning_run', 'run_7')],
      failed: [],
    });

  it('nothing is current on arrival; Tab lands on the first row and makes it current, the arrows move it', async () => {
    const user = userEvent.setup();
    const { container } = renderHub({ attention_summary: twoRows() });
    await screen.findByText('Mahnlauf wartet auf Freigabe');
    expect(container.querySelector('[aria-current="true"]')).toBeNull();
    const rows = screen.getAllByRole('button').filter((b) => b.className.includes('att-row-open'));
    act(() => rows[0].focus());
    await waitFor(() => expect(rows[0]).toHaveAttribute('aria-current', 'true'));
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(rows[1]).toHaveAttribute('aria-current', 'true'));
    expect(rows[1]).toHaveFocus();
    expect(rows[0]).not.toHaveAttribute('aria-current');
  });

  it('a click (or Enter) opens the row exactly where it did before: the item deep link', async () => {
    const user = userEvent.setup();
    render(
      <TillClientProvider client={new TillClient(fakeTransport({ attention_summary: twoRows() }))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/attention']}>
              <Routes>
                <Route path="/attention" element={<Attention />} />
                <Route path="/dunning" element={<LocationProbe />} />
              </Routes>
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText('Mahnlauf wartet auf Freigabe');
    const rows = screen.getAllByRole('button').filter((b) => b.className.includes('att-row-open'));
    act(() => rows[1].focus());
    await user.keyboard('{Enter}');
    expect(await screen.findByTestId('probe')).toHaveTextContent('/dunning?id=run_7');
  });
});

function LocationProbe() {
  const location = useLocation();
  return <p data-testid="probe">{`${location.pathname}${location.search}`}</p>;
}
