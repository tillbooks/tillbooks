/**
 * G15 Pendenzen after D178, the page: rendered from a canned grouped `attention_list`, so every assertion
 * is about what the surface shows and what it asks.
 *
 *  - the padlock (`visibleQueues == 0`) and the empty state ("Nichts offen.") are different
 *    facts and never render together; a failed provider is named once and the empty state stays away;
 *  - D207: three sections (Bankbuchungen, Weitere Vorschläge, Zu erledigen) in the engine's order, their rows
 *    adding up to the header count; no hub triage in any ⋯ (no "Aufgabe erstellen", no "Referenz kopieren");
 *  - D201: more rows behind a cursor
 *    read on request; the filters (search, kind chips with counts, area and sender facets) narrow it
 *    client-side, offer only what changes the list, end in a filtered-empty state with "Filter
 *    zurücksetzen", and persist as the person's `attention.filters`;
 *  - one line per row with the kind's glyph; the reason opens in place from the chevron;
 *  - "Stand" is Swiss time, in the refresh control's tooltip; no row is current on arrival; no "neu" badge;
 *    no hub-side hide; an empty "Ereignisse" zone draws nothing;
 *  - the five states (skeleton, empty, error with retry, success, a paging section) and axe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { PrefsProvider, PrefsStore, resetPrefsModuleForTests } from '../../lib/prefs';
import { Attention } from './index';
import { standTime } from './model';
import { bankVorschlag, groupedOf, linesRow } from './testing';

type Handler = (input: Record<string, unknown>) => RestResponse | Promise<RestResponse>;
type Canned = Record<string, RestResponse | Handler>;
type Call = { action: string; input: Record<string, unknown> };

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, calls: Call[]): Transport {
  return async (action, input) => {
    calls.push({ action, input: (input ?? {}) as Record<string, unknown> });
    const entry = canned[action];
    if (entry === undefined) return { status: 200, body: { ok: true } };
    return typeof entry === 'function' ? await entry((input ?? {}) as Record<string, unknown>) : entry;
  };
}

function row(queueId: string, entityId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const dunning = queueId === 'dunning_run';
  const link = { route: dunning ? '/dunning' : '/journal', params: { id: entityId } };
  return {
    queueId,
    entityKind: queueId,
    entityId,
    titleKey: dunning ? 'attention.item.dunningRun.title' : 'attention.item.reviewFlag.title',
    titleParams: {},
    subtitleKey: dunning ? 'attention.item.dunningRun.subtitle' : 'attention.item.reviewFlag.subtitle',
    subtitleParams: dunning ? { count: 3, date: '2026-08-01' } : { date: '2026-07-03', description: 'Honorar Juli' },
    since: '2026-08-01',
    urgency: 'open',
    deepLink: link,
    decisionOptions: [{ id: 'open', verb: null, labelKey: dunning ? 'attention.act.openDunning' : 'attention.act.openEntry', role: 'link', input: {}, deepLink: link }],
    ...over,
  };
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname + loc.search}</div>;
}

function renderHub(canned: Canned, opts: { store?: PrefsStore } = {}) {
  const calls: Call[] = [];
  const client = new TillClient(fakeTransport(canned, calls));
  const tree = (
    <MemoryRouter initialEntries={['/attention']}>
      <Routes>
        <Route path="/attention" element={<Attention />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(
    <TillClientProvider client={client}>
      <I18nProvider>
        <WorkspaceProvider initialId="ws_test">{opts.store !== undefined ? <PrefsProvider store={opts.store}>{tree}</PrefsProvider> : tree}</WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>,
  );
  return { ...view, calls, client };
}

/** Each row's way in for the roving focus: its one button (no title is a button, the fresh-eyes judge N4 M4). */
const focusTargets = () =>
  [...document.querySelectorAll<HTMLElement>('.att-row')].map((r) => r.querySelector('.att-row-action button') as HTMLButtonElement);

beforeEach(() => {
  window.localStorage.clear();
  resetPrefsModuleForTests();
});

describe('Pendenzen: padlock vs empty vs work waiting', () => {
  it('padlock: visibleQueues 0 shows the padlock and NEVER "Nichts offen."', async () => {
    renderHub({ attention_list: ok(groupedOf([], { visibleQueues: 0 })) });
    expect(await screen.findByText('Hier gibt es nichts zu zeigen')).toBeInTheDocument();
    expect(screen.queryByText('Nichts offen.')).toBeNull();
  });

  it('empty: everything readable and nothing waiting says so in one line, only when nothing failed', async () => {
    renderHub({ attention_list: ok(groupedOf([])) });
    expect(await screen.findByText('Nichts offen.')).toBeInTheDocument();
    expect(screen.getByText('Was eine Entscheidung von dir braucht, erscheint hier.')).toBeInTheDocument();
    expect(document.querySelectorAll('[data-section]').length).toBe(0);
  });

  it('a failed provider is named exactly once, carries no count, and the empty state stays away', async () => {
    renderHub({ attention_list: ok(groupedOf([], { failed: ['dunning_run'] })) });
    expect(await screen.findByText('Mahnwesen konnte nicht geladen werden.')).toBeInTheDocument();
    expect(screen.getAllByText(/konnte nicht geladen werden/)).toHaveLength(1);
    expect(screen.queryByText('Nichts offen.')).toBeNull();
    expect(screen.getByText('unvollständig', { exact: false })).toBeInTheDocument();
  });

  it('the whole read failing shows the error with a retry, and the retry reads again', async () => {
    let reads = 0;
    const { calls } = renderHub({
      attention_list: () => {
        reads += 1;
        return reads === 1 ? { status: 500, body: { ok: false, error: 'store_busy' } } : ok(groupedOf([row('dunning_run', 'run_1')]));
      },
    });
    expect(await screen.findByText('Die Pendenzen konnten nicht geladen werden.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /erneut versuchen/i }));
    expect(await screen.findByText('Mahnlauf bereit zum Ausstellen')).toBeInTheDocument();
    expect(calls.filter((c) => c.action === 'attention_list')).toHaveLength(2);
  });
});

describe('Pendenzen: three sections (D207 point 2)', () => {
  it('one read, three sections in the engine\'s order; the rows add up to the header count', async () => {
    const rows = [bankVorschlag('a1'), bankVorschlag('a2'), linesRow(5), row('review_flag', 'e1'), row('dunning_run', 'run_1')];
    const { calls } = renderHub({ attention_list: ok(groupedOf(rows)) });
    await screen.findByText('5 Bankzeilen zu buchen');
    expect(calls.filter((c) => c.action === 'attention_list')).toHaveLength(1);
    expect(calls.find((c) => c.action === 'attention_list')?.input).toMatchObject({ workspaceId: 'ws_test', grouping: 'by_kind' });
    // D207: the bank decisions, then the to-dos; no "Weitere Vorschläge" section without such a row.
    expect([...document.querySelectorAll('[data-section]')].map((s) => s.getAttribute('data-section'))).toEqual(['bank', 'todo']);
    expect(screen.getByRole('heading', { name: /Bankbuchungen/ })).toHaveTextContent('Bankbuchungen2');
    expect(screen.getByRole('heading', { name: /Zu erledigen/ })).toHaveTextContent('Zu erledigen7');
    const units = [...document.querySelectorAll('[data-row-count]')].reduce((n, r) => n + Number(r.getAttribute('data-row-count')), 0);
    expect(units).toBe(9);
  });

  it('more rows behind a cursor are read on request, from the cursor; the count stays the engine\'s', async () => {
    const first = groupedOf([row('dunning_run', 'run_1')], { more: { sales: { count: 2, nextCursor: '1' } } });
    const page2 = groupedOf([row('dunning_run', 'run_2'), row('dunning_run', 'run_3')]);
    const { calls } = renderHub({
      attention_list: (input) => ok(input.cursor === '1' ? { ...page2, sections: [{ ...(page2.sections as Record<string, unknown>[])[0], count: 3 }] } : first),
    });
    const more = await screen.findByRole('button', { name: 'Weitere 2 anzeigen' });
    await userEvent.click(more);
    await waitFor(() => expect(document.querySelectorAll('[data-row-count]')).toHaveLength(3));
    expect(calls.filter((c) => c.action === 'attention_list').at(-1)?.input).toMatchObject({ section: 'sales', cursor: '1' });
    expect(screen.queryByRole('button', { name: /Weitere/ })).toBeNull();
  });
});

describe('Pendenzen: the filters (D201 point 4)', () => {
  const rows = [bankVorschlag('a1'), bankVorschlag('a2'), linesRow(2), row('review_flag', 'e1'), row('dunning_run', 'run_1')];
  // The fixture's engine kinds: two Vorschläge and the Mahnlauf (approve), the lines (do), the flag (note).
  const shown = () => document.querySelectorAll('.att-list > li').length;

  it('D208: the chips Alle / Bank / Erledigen name their counts; a chip shows its section alone and the search narrows it further', async () => {
    renderHub({ attention_list: ok(groupedOf(rows)) });
    await screen.findByText('2 Bankzeilen zu buchen');
    const kinds = screen.getByRole('group', { name: 'Art' });
    // No "Vorschläge" chip: no row of that section here (a chip only where it changes the list).
    expect(within(kinds).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ''))).toEqual(['Alle6', 'Bank2', 'Erledigen4']);
    await userEvent.click(within(kinds).getByRole('button', { name: /Erledigen/ }));
    expect(shown()).toBe(3);
    expect(screen.getByText('2 Bankzeilen zu buchen')).toBeInTheDocument();
    await userEvent.click(within(kinds).getByRole('button', { name: /Alle/ }));
    expect(shown()).toBe(5);
    await userEvent.type(screen.getByRole('searchbox'), 'Mahnlauf');
    expect(shown()).toBe(1);
    expect(screen.getByText('Mahnlauf bereit zum Ausstellen')).toBeInTheDocument();
  });

  it('the area and the sender are facets under "+ Filter"; choosing one narrows the list', async () => {
    renderHub({ attention_list: ok(groupedOf(rows)) });
    await screen.findByText('2 Bankzeilen zu buchen');
    await userEvent.click(document.querySelector('.facet-chip-add') as HTMLElement);
    const options = screen.getAllByRole('menuitem').map((m) => m.textContent);
    expect(options).toEqual(expect.arrayContaining(['Bank', 'Buchhaltung', 'Verkauf', 'Agent', 'TILL']));
    await userEvent.click(screen.getAllByRole('menuitem').find((m) => m.textContent === 'Agent') as HTMLElement);
    expect(shown()).toBe(2);
  });

  it('a filter that hides everything says so and offers "Filter zurücksetzen", which brings every row back', async () => {
    renderHub({ attention_list: ok(groupedOf(rows)) });
    await screen.findByText('2 Bankzeilen zu buchen');
    await userEvent.type(screen.getByRole('searchbox'), 'gibt es nicht');
    expect(screen.getByText('Keine Treffer.')).toBeInTheDocument();
    const resets = screen.getAllByRole('button', { name: 'Filter zurücksetzen' });
    await userEvent.click(resets[resets.length - 1] as HTMLElement);
    expect(shown()).toBe(5);
    expect(screen.getByRole('searchbox')).toHaveValue('');
  });

  it('the section, area and sender persist as the person\'s attention.filters; a stored filter reopens the list filtered', async () => {
    const prefWrites: Call[] = [];
    const prefsTransport: Transport = async (action, input) => {
      if (action === 'prefs_list') {
        return ok({ prefs: [{ key: 'attention.filters', value: { sections: ['todo'], area: 'all', actor: 'all' }, isDefault: false }], areas: [] });
      }
      if (action === 'prefs_set') {
        prefWrites.push({ action, input: input as Record<string, unknown> });
        return ok({ key: 'attention.filters', value: (input as Record<string, unknown>).value, changed: true, isDefault: false });
      }
      return ok();
    };
    const store = new PrefsStore(new TillClient(prefsTransport), 'ws_test', { useCache: false });
    renderHub({ attention_list: ok(groupedOf(rows)) }, { store });
    await screen.findByText('Buchung beanstandet');
    await waitFor(() => expect(shown()).toBe(3));
    await userEvent.click(within(screen.getByRole('group', { name: 'Art' })).getByRole('button', { name: /Bank/ }));
    await waitFor(() => expect(prefWrites.at(-1)?.input).toMatchObject({ key: 'attention.filters', value: { sections: ['bank'], area: 'all', actor: 'all' } }));
    expect(shown()).toBe(2);
  });
});

describe('Pendenzen: one row pattern', () => {
  it('a row is one line: the kind\'s glyph, the title and its meta, ONE real button, the reason in place behind the chevron, the rest in the ⋯', async () => {
    const flag = {
      ...row('review_flag', 'e1'),
      subtitleParams: { date: '2026-07-03', description: 'Honorar Juli', reviewer: 'Reto Muster', reason: 'Falsches Konto' },
      proposedBy: 'member:user_3',
      proposedByKind: 'member',
      reasonKey: 'attention.item.reviewFlag.reason',
      decisionOptions: [
        { id: 'open', verb: null, labelKey: 'attention.act.openEntry', role: 'link', input: {}, deepLink: { route: '/journal', params: { entryId: 'e1' } } },
        { id: 'resolve', verb: 'approve_entry', labelKey: 'attention.act.resolveFlag', role: 'secondary', input: { entryId: 'e1', idempotencyKey: 'k' }, capability: 'review' },
      ],
    };
    renderHub({ attention_list: ok(groupedOf([flag])) });
    const title = await screen.findByText('Buchung beanstandet');
    // N4 M4: the title is words, never a button; the row's one button is the way in.
    expect(title.tagName).not.toBe('BUTTON');
    expect(screen.queryByRole('button', { name: 'Buchung beanstandet' })).toBeNull();
    const line = title.closest('.att-row') as HTMLElement;
    // D208: no lead glyph column; the lead keeps only the box's slot, so every title starts on one edge.
    expect(line.querySelector('.att-lead .att-kind')).toBeNull();
    // The meta line: values only, the date in Swiss form and LAST (one order on every row).
    expect(line.querySelector('.att-row-meta')).toHaveTextContent('Honorar Juli · 03.07.2026');
    // Nothing explanatory at rest: the reason opens in place from the chevron.
    expect(line).not.toHaveTextContent('Falsches Konto');
    const disclose = within(line).getByRole('button', { name: 'Details: Buchung beanstandet' });
    expect(disclose).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(disclose);
    expect(disclose).toHaveAttribute('aria-expanded', 'true');
    expect(document.getElementById(disclose.getAttribute('aria-controls') ?? '')).toHaveTextContent('Markiert von Reto Muster: Falsches Konto');
    // ONE real button (an edge, never ghost text): the link here; the resolve sits in the ⋯.
    const action = within(line).getByRole('button', { name: 'Buchung öffnen' });
    expect(action.className).toContain('btn--secondary');
    expect(within(line).queryByRole('button', { name: 'Als geprüft freigeben' })).toBeNull();
    await userEvent.click(within(line).getByRole('button', { name: /Aktionen für Buchung beanstandet/ }));
    expect(screen.getByRole('menuitem', { name: 'Als geprüft freigeben' })).toBeInTheDocument();
    // The aggregate count is the row's own.
    expect(line.getAttribute('data-row-count')).toBe('1');
  });

  it('due and overdue say so in words in the meta line, with the date; open says nothing', async () => {
    renderHub({
      attention_list: ok(
        groupedOf([
          { ...row('dunning_run', 'run_1'), urgency: 'overdue', dueAt: '2026-10-01' },
          { ...row('dunning_run', 'run_2'), urgency: 'due', dueAt: '2026-10-30' },
          row('dunning_run', 'run_3'),
        ]),
      ),
    });
    await screen.findAllByText('Mahnlauf bereit zum Ausstellen');
    const metas = [...document.querySelectorAll('.att-row-meta')].map((m) => m.textContent ?? '');
    expect(metas[0]).toContain('überfällig seit 01.10.2026');
    expect(metas[1]).toContain('fällig 30.10.2026');
    expect(metas[2]).not.toMatch(/fällig|offen/);
  });
});

describe('Pendenzen: time, focus, marker, triage', () => {
  it('"Stand" is Swiss time, never UTC (D178 point 4), and lives in the refresh control\'s tooltip', async () => {
    expect(standTime('2026-10-21T08:21:00.000Z')).toBe('10:21');
    expect(standTime('2026-01-15T08:21:00.000Z')).toBe('09:21');
    renderHub({ attention_list: ok(groupedOf([row('dunning_run', 'run_1')], { computedAt: '2026-10-21T08:21:00.000Z' })) });
    const refresh = await screen.findByRole('button', { name: 'Aktualisieren' });
    expect(refresh).toHaveAttribute('data-stand', 'Stand 10:21');
    // The design judge: no line of its own, the time lives in the refresh control's tooltip.
    await userEvent.hover(refresh);
    expect((await screen.findByText('Stand 10:21')).closest('[role="tooltip"]')).not.toBeNull();
  });

  it('nothing is current on arrival; Tab lands on the first row, the arrows move down the list; Enter opens', async () => {
    renderHub({ attention_list: ok(groupedOf([linesRow(2), row('review_flag', 'e1'), row('dunning_run', 'run_1')])) });
    await screen.findByText('2 Bankzeilen zu buchen');
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
    // The lines row's title and its one button open the same place, so its button is the way in.
    const titles = focusTargets();
    expect(titles.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    act(() => titles[0]?.focus());
    expect(titles[0]).toHaveAttribute('aria-current', 'true');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(titles[2]);
    await userEvent.keyboard('{Enter}');
    expect(screen.getByTestId('where')).toHaveTextContent('/dunning?id=run_1');
  });

  it('no "neu" badge on any row (D186: no decoration words)', async () => {
    window.localStorage.setItem('till.attention.lastSeen.ws_test', '2026-08-01T12:00:00.000Z');
    renderHub({ attention_list: ok(groupedOf([{ ...row('dunning_run', 'run_1'), since: '2026-08-02' }, { ...row('dunning_run', 'run_2'), since: '2026-07-01' }])) });
    await screen.findAllByText('Mahnlauf bereit zum Ausstellen');
    expect(screen.queryByText('neu')).toBeNull();
  });

  it('there is no hub-side hide, mute or snooze, and no hub triage (D207): a row with one exit draws no ⋯', async () => {
    renderHub({ attention_list: ok(groupedOf([row('dunning_run', 'run_1'), bankVorschlag('a1')])) });
    await screen.findByText('Mahnlauf bereit zum Ausstellen');
    expect(screen.queryByRole('button', { name: /Aktionen für/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Mehr zu/ })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Referenz kopieren|Aufgabe erstellen|ausblenden|stumm|später/i);
  });

  it('a failed queue with no label at all is named by its readable id, never the dot path', async () => {
    renderHub({ attention_list: ok(groupedOf([], { failed: ['future_queue'] })) });
    expect(await screen.findByText(/Future queue/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('attention.queueLabel');
  });

  it('an empty events zone draws nothing: no "Ereignisse" heading over an empty list', async () => {
    renderHub({ attention_list: ok(groupedOf([row('dunning_run', 'run_1')])), notifications_list: ok({ items: [] }) });
    await screen.findByText('Mahnlauf bereit zum Ausstellen');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByRole('heading', { name: 'Ereignisse' })).toBeNull();
  });

  it('has no axe violations with the filters, the list and rows rendered', async () => {
    const { container } = renderHub({
      attention_list: ok(groupedOf([bankVorschlag('a1'), bankVorschlag('a2'), linesRow(5), row('review_flag', 'e1'), row('dunning_run', 'run_1')])),
      list_drafted_actions: ok({ actions: [] }),
    });
    await screen.findByText('5 Bankzeilen zu buchen');
    // Let the side reads (events, drafted payloads, the dial, the chart) land before the audit.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(await axe(container)).toHaveNoViolations();
  });
});
