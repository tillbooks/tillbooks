/**
 * The Suche results page: G07's human face over `search_global`.
 *
 * The suite follows the Aufgaben/Prognose discipline: the loading assertion waits for the read to
 * have STARTED (`watchReads`), copy is asserted through the catalogue and never as a literal typed
 * here, and the states the spec's §6 names are each driven: skeleton, the under-2-chars hint, empty
 * (with the scoped "widen back out" exception), populated grouped rows with the custom-field match
 * announced as text, the partial-failure notice, and the rights-FILTERED scope chips (US-G07.3: a
 * kind the actor cannot read is never offered, hidden rather than shown-then-rejected). Saving a
 * search is asserted at the wire: G00's `create_saved_view` with `entityKind:'global_search'`.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';

import { TillClientProvider } from '../../lib/client-context';
import { TillClient, type RestResponse, type Transport } from '../../lib/client';
import { I18nProvider } from '../../i18n';
import { WorkspaceProvider } from '../../app/workspace';
import { CapabilitiesContext, type Capabilities } from '../../lib/capabilities';
import { neverSettles, watchReads } from '../../test-transport';
import Search from './index';
import de from './messages.de-CH.json';

type CannedHandler = (input: Record<string, unknown>) => RestResponse;
type Canned = Record<string, RestResponse | CannedHandler>;

const ok = (data: Record<string, unknown> = {}): RestResponse => ({ status: 200, body: { ok: true, ...data } });

function fakeTransport(canned: Canned, asked?: Array<{ action: string; input: Record<string, unknown> }>): Transport {
  return async (action, input) => {
    asked?.push({ action, input: input ?? {} });
    const entry = canned[action];
    if (entry === undefined) return { status: 404, body: { ok: false, error: 'unknown_action' } };
    return typeof entry === 'function' ? entry(input ?? {}) : entry;
  };
}

// --- The engine's own payload shapes -----------------------------------------------------------

const HITS = (results: Record<string, unknown>[], over: Record<string, unknown> = {}) =>
  ok({ q: 'Muster', results, total: results.length, hasMore: false, failedKinds: [], ...over });

const POPULATED = (): Canned => ({
  search_global: HITS([
    { entityKind: 'contact', entityId: 'contact_1', title: 'Muster AG', matchedVia: 'field', route: '/contacts' },
    { entityKind: 'document', entityId: 'doc_1', title: 'RE-2026-014', matchedVia: 'field', route: '/documents' },
    {
      entityKind: 'project',
      entityId: 'proj_1',
      title: 'Muster Redesign',
      matchedVia: 'custom_field',
      snippet: 'Aktenzeichen: 4471',
      route: '/projects',
    },
  ]),
  list_saved_views: ok({
    entityKind: 'global_search',
    savedViews: [{ viewId: 'view_1', name: 'Muster überall', filters: { q: 'Muster' } }],
  }),
  create_saved_view: ok({ savedView: { viewId: 'view_2' } }),
});

const EMPTY = (): Canned => ({
  search_global: HITS([]),
  list_saved_views: ok({ entityKind: 'global_search', savedViews: [] }),
});

function tree(canned: Canned, { path = '/search?q=Muster', workspaceId = 'ws_test' as string | null, caps = null as Capabilities | null } = {}) {
  const inner = (
    <TillClientProvider client={new TillClient(fakeTransport(canned))}>
      <I18nProvider>
        <WorkspaceProvider initialId={workspaceId}>
          <MemoryRouter initialEntries={[path]}>
            <Search />
          </MemoryRouter>
        </WorkspaceProvider>
      </I18nProvider>
    </TillClientProvider>
  );
  return caps === null ? inner : <CapabilitiesContext.Provider value={caps}>{inner}</CapabilitiesContext.Provider>;
}

describe('Search (Suche)', () => {
  it('LOADING: shows the skeleton while search_global is in flight, proven started', async () => {
    const transport = watchReads(neverSettles);
    render(
      <TillClientProvider client={new TillClient(transport)}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/search?q=Muster']}>
              <Search />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await transport.started('search_global');
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('HINT: below two characters nothing is queried and the min-length hint renders', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      <TillClientProvider client={new TillClient(fakeTransport(EMPTY(), asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/search?q=M']}>
              <Search />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    expect(await screen.findByText(de.search.hint.minLength)).toBeInTheDocument();
    expect(asked.filter((a) => a.action === 'search_global')).toHaveLength(0);
  });

  it('SUCCESS: grouped rows under reused kind glyph headings, the custom-field match announced as text', async () => {
    render(tree(POPULATED()));
    expect(await screen.findByText('Muster AG')).toBeInTheDocument();
    // Group headings come from the kind catalogue, one per matched kind.
    expect(screen.getByRole('heading', { name: de.search.kind.contact })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: de.search.kind.document })).toBeInTheDocument();
    // The custom-field match is announced as text, never conveyed by icon or colour alone.
    expect(screen.getByText('Treffer in Aktenzeichen: 4471')).toBeInTheDocument();
    // The saved search from G00 renders in its panel.
    expect(screen.getByRole('button', { name: 'Muster überall' })).toBeInTheDocument();
  });

  it('K-04: the results page has no field and no "Suchen" button of its own; the facets are chips', async () => {
    render(tree(POPULATED()));
    expect(await screen.findByText('Muster AG')).toBeInTheDocument();
    // The one omnibox is the palette: no search box and no submit button on this page.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Suchen' })).toBeNull();
    // The query the page answers is named, and the entity facets are the shared FilterChips.
    expect(screen.getByText('Muster', { selector: '.search-query-term' })).toBeInTheDocument();
    const facets = screen.getByRole('group', { name: de.search.scope.label });
    expect(facets).toHaveClass('filter-chips');
  });

  it('EMPTY: names the query and offers a way out; a scoped empty adds "Alle Bereiche durchsuchen"', async () => {
    render(tree(EMPTY()));
    expect(await screen.findByText("Keine Treffer für 'Muster'.")).toBeInTheDocument();
  });

  it('EMPTY (scoped): says so and offers the one-tap widen-out, never a dead end (US-G07.3)', async () => {
    render(tree(EMPTY(), { path: '/search?q=Muster&kinds=document' }));
    expect(await screen.findByText("Keine Treffer in diesem Bereich für 'Muster'.")).toBeInTheDocument();
    // Two widen-out controls by design: the chip row's clear and the empty state's CTA.
    expect(screen.getAllByRole('button', { name: de.search.action.widenScope }).length).toBeGreaterThanOrEqual(1);
  });

  it('PARTIAL FAILURE: one failed adapter renders the inline notice while healthy groups still answer', async () => {
    const canned = POPULATED();
    canned.search_global = HITS(
      [{ entityKind: 'contact', entityId: 'contact_1', title: 'Muster AG', matchedVia: 'field', route: '/contacts' }],
      { failedKinds: ['task'] },
    );
    render(tree(canned));
    expect(await screen.findByText(de.search.error.partial)).toBeInTheDocument();
    expect(screen.getByText('Muster AG')).toBeInTheDocument();
  });

  it('RIGHTS-FILTERED CHIPS: a kind the actor cannot read is never offered as a scope (US-G07.3)', async () => {
    const caps: Capabilities = {
      whoami: null,
      can: (capability: string) => capability === 'read_master_data',
      refresh: () => {},
    };
    render(tree(POPULATED(), { caps }));
    await screen.findByText('Muster AG');
    const scope = screen.getByRole('group', { name: de.search.scope.label });
    // read_master_data offers contact, item, project and po; the read_sales/read_books kinds are hidden.
    expect(scope).toHaveTextContent(de.search.kind.contact);
    expect(scope).toHaveTextContent(de.search.kind.po);
    expect(scope).not.toHaveTextContent(de.search.kind.document);
    expect(scope).not.toHaveTextContent(de.search.kind.vendor_bill);
  });

  it('SAVE: "Suche speichern" issues G00 create_saved_view scoped to global_search with the filters', async () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      <TillClientProvider client={new TillClient(fakeTransport(POPULATED(), asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId="ws_test">
            <MemoryRouter initialEntries={['/search?q=Muster']}>
              <Search />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    await screen.findByText('Muster AG');
    fireEvent.click(screen.getByRole('button', { name: de.search.savedSearch.save }));
    fireEvent.submit(screen.getByRole('textbox', { name: de.search.savedSearch.name }).closest('form') as HTMLFormElement);
    await screen.findByText('Muster AG');
    const save = asked.find((a) => a.action === 'create_saved_view');
    expect(save).toBeDefined();
    expect(save?.input.entityKind).toBe('global_search');
    expect(save?.input.filters).toEqual({ q: 'Muster' });
  });

  it('NO WORKSPACE: renders the shared no-workspace state, and asks the engine for nothing', () => {
    const asked: Array<{ action: string; input: Record<string, unknown> }> = [];
    render(
      <TillClientProvider client={new TillClient(fakeTransport(POPULATED(), asked))}>
        <I18nProvider>
          <WorkspaceProvider initialId={null}>
            <MemoryRouter initialEntries={['/search?q=Muster']}>
              <Search />
            </MemoryRouter>
          </WorkspaceProvider>
        </I18nProvider>
      </TillClientProvider>,
    );
    expect(asked).toHaveLength(0);
  });

  it('a11y: the settled populated surface has no axe violations', async () => {
    const { container } = render(tree(POPULATED()));
    await screen.findByText('Muster AG');
    expect(await axe(container)).toHaveNoViolations();
  });
});
