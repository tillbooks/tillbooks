/**
 * G07, Suche (`/search`): the paginated results page over `search_global`.
 *
 * ONE READ VERB, NO WRITE OF ITS OWN. The page renders grouped, ranked hits and hands every one
 * straight to its owning surface via the engine-supplied `route` (spec §6: never a G07-owned
 * detail view, no dead ends). The only write it can issue is G00's `create_saved_view`, scoped to
 * `entityKind:'global_search'` (US-G07.4), and that verb belongs to G00.
 *
 * THE URL IS THE STATE: `?q=` and `?kinds=` survive a reload and are shareable (US-G07.3). Scope
 * chips are rights-FILTERED as a courtesy (`can()` over each kind's read capability); the engine
 * is the enforcement and silently omits what the caller could not open (US-G07.5), so there is no
 * whole-screen padlock here by design: search itself carries no gate.
 *
 * DATA HONESTY: no relevance score is shown (the engine computes none), a partial adapter failure
 * renders its own inline notice while the healthy groups still answer, and the empty state always
 * offers a way out (widen the scope, shorten the term), never a bare "no data".
 *
 * ONE OMNIBOX (K-04, D137). The page used to carry its own search field and a primary "Suchen"
 * button beside the command palette: two inputs for one job, each with its own ranking. Now the
 * palette is the only field. This page is where "Alle Treffer" lands: the list, the entity facets as
 * the shared FilterChips, the saved searches. "Suche ändern" opens the palette on the current query,
 * and a deep link (`/search?q=`, a bookmark) opens the palette prefilled, while a hop from the
 * palette itself (`state.fromPalette`) does not reopen it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT } from '../../i18n';
import { useCapabilities } from '../../lib/capabilities';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FilterChips } from '../../components/FilterChips';
import { NavIcon } from '../../app/nav-icons';
import { useKeyboardOptional } from '../../app/keyboard';
import {
  KIND_DISPLAY,
  SEARCHABLE_KIND_IDS,
  parseSavedSearches,
  parseSearch,
  type SavedSearch,
  type SearchHit,
  type SearchModel,
  type SearchableKind,
} from './model';
import './Search.css';

export const MIN_QUERY_LENGTH = 2;
const PAGE_LIMIT = 50;

/** The `?kinds=` param, parsed against the mirror so a stale URL never sends an unknown kind. */
function kindsFromParam(raw: string | null): SearchableKind[] {
  if (raw === null || raw.length === 0) return [];
  return raw
    .split(',')
    .filter((k): k is SearchableKind => (SEARCHABLE_KIND_IDS as readonly string[]).includes(k));
}

export function Search() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const keyboard = useKeyboardOptional();

  const q = params.get('q') ?? '';
  const kinds = useMemo(() => kindsFromParam(params.get('kinds')), [params]);

  /** Open the one omnibox, on the current query when there is one (K-04). */
  const openPalette = useCallback(() => keyboard?.openPalette(q), [keyboard, q]);

  // K-04: a deep link or a bookmark opens the palette prefilled, once; arriving FROM the palette's
  // "Alle Treffer" (state.fromPalette) does not reopen what the person just left.
  const openedForKey = useRef<string | null>(null);
  useEffect(() => {
    const fromPalette = (location.state as { fromPalette?: boolean } | null)?.fromPalette === true;
    if (fromPalette || keyboard === null || openedForKey.current === location.key) return;
    openedForKey.current = location.key;
    keyboard.openPalette(q);
    // Once per arrival: the query changing under the open palette must not re-trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  const [model, setModel] = useState<SearchModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [saved, setSaved] = useState<SavedSearch[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [appending, setAppending] = useState(false);
  const requestSeq = useRef(0);

  /** The chips on offer: every kind whose read capability the actor holds (courtesy filter). */
  const offeredKinds = useMemo(
    () => SEARCHABLE_KIND_IDS.filter((kind) => can(KIND_DISPLAY[kind].readCapability)),
    [can],
  );

  const runSearch = useCallback(async () => {
    if (workspaceId === null || q.trim().length < MIN_QUERY_LENGTH) {
      setModel(null);
      return;
    }
    const seq = (requestSeq.current += 1);
    setLoading(true);
    setFailed(false);
    const input: Record<string, unknown> = { workspaceId, q, limit: PAGE_LIMIT };
    if (kinds.length > 0) input.entityKinds = kinds;
    const response = await client.call('search_global', input);
    if (seq !== requestSeq.current) return;
    if (isErr(response.body)) {
      // `query_too_short` cannot reach here (the guard above), so any rejection is a real failure.
      setFailed(true);
      setModel(null);
      setLoading(false);
      return;
    }
    const parsed = parseSearch(response.body);
    if (parsed === null) {
      setFailed(true);
      setModel(null);
    } else {
      setModel(parsed);
    }
    setLoading(false);
  }, [client, workspaceId, q, kinds]);

  useEffect(() => {
    void runSearch();
  }, [runSearch]);

  const loadSaved = useCallback(async () => {
    if (workspaceId === null) return;
    const response = await client.call('list_saved_views', { workspaceId, entityKind: 'global_search' });
    if (!isErr(response.body)) setSaved(parseSavedSearches(response.body));
  }, [client, workspaceId]);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const commit = (nextQ: string, nextKinds: SearchableKind[]) => {
    const next = new URLSearchParams();
    if (nextQ.length > 0) next.set('q', nextQ);
    if (nextKinds.length > 0) next.set('kinds', nextKinds.join(','));
    setParams(next);
  };


  const loadMore = async () => {
    if (workspaceId === null || model === null || model.nextCursor === null) return;
    setAppending(true);
    const input: Record<string, unknown> = { workspaceId, q, limit: PAGE_LIMIT, cursor: model.nextCursor };
    if (kinds.length > 0) input.entityKinds = kinds;
    const response = await client.call('search_global', input);
    setAppending(false);
    if (isErr(response.body)) return;
    const page = parseSearch(response.body);
    if (page === null) return;
    setModel({ ...page, hits: [...model.hits, ...page.hits] });
  };

  const saveSearch = async () => {
    if (workspaceId === null || q.trim().length < MIN_QUERY_LENGTH) return;
    const name = saveName.trim().length > 0 ? saveName.trim() : q;
    const response = await client.call('create_saved_view', {
      workspaceId,
      entityKind: 'global_search',
      name,
      filters: { q, ...(kinds.length > 0 ? { entityKinds: kinds } : {}) },
      idempotencyKey: `search-save-${workspaceId}-${name}`,
    });
    if (!isErr(response.body)) {
      setSaving(false);
      setSaveName('');
      await loadSaved();
    }
  };

  if (workspaceId === null) return <NoWorkspaceState />;

  const groups = new Map<SearchableKind, SearchHit[]>();
  if (model !== null) {
    for (const hit of model.hits) {
      const list = groups.get(hit.entityKind);
      if (list === undefined) groups.set(hit.entityKind, [hit]);
      else list.push(hit);
    }
  }

  const tooShort = q.trim().length < MIN_QUERY_LENGTH;
  const isEmpty = !loading && !failed && model !== null && model.hits.length === 0;

  return (
    <section className="search-page" aria-labelledby="search-title">
      <SurfaceHeader
        title={t('search.route.title')}
        titleId="search-title"
        help={<SurfaceHelp surface="Search" />}
        actions={
          keyboard !== null ? (
            <button type="button" className="btn btn--secondary" onClick={openPalette}>
              {q.trim().length > 0 ? t('search.action.change') : t('search.action.open')}
            </button>
          ) : undefined
        }
      />
      {!tooShort && (
        <div className="search-controls">
          <p className="search-query">
            {t('search.queryLead')} <span className="search-query-term">{q}</span>
          </p>
          {/* US-G07.3: the scope, as the shared facet chips (K-11). Rights-filtered; the engine
              enforces regardless. None selected searches every kind. */}
          <FilterChips
            label={t('search.scope.label')}
            chips={offeredKinds.map((kind) => ({ value: kind, label: t(KIND_DISPLAY[kind].labelKey) }))}
            selected={kinds}
            onChange={(next) => commit(q, next)}
          />
        </div>
      )}

      {saved.length > 0 && (
        <nav className="search-saved panel" aria-label={t('search.savedSearch.list')}>
          <h2 className="search-saved-title">{t('search.savedSearch.list')}</h2>
          <ul className="search-saved-list">
            {saved.map((entry) => (
              <li key={entry.viewId}>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => commit(entry.q, entry.entityKinds)}>
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}

      {/* K-33: no query yet names what is missing and offers the one field there is. */}
      {tooShort && (
        <EmptyState
          title={q.trim().length === 0 ? t('search.noQuery.title') : t('search.hint.minLength')}
          hint={t('search.noQuery.hint')}
          action={keyboard !== null ? { label: t('search.action.open'), onClick: openPalette } : undefined}
        />
      )}

      {!tooShort && loading && <Skeleton rows={6} height={40} labelKey="search.loading" />}
      {!tooShort && !loading && failed && <ErrorBanner context="read" onRetry={() => void runSearch()} />}

      {!tooShort && !loading && !failed && model !== null && model.failedKinds.length > 0 && (
        <p className="search-partial" role="status">
          {t('search.error.partial')}
        </p>
      )}

      {/* K-33: a facet that hides every hit is a FILTERED empty state (clear the facets); an empty
          search over every kind offers to change the search. */}
      {isEmpty &&
        (kinds.length > 0 ? (
          <EmptyState
            title={t('search.emptyScoped', { q })}
            hint={t('search.emptyHint')}
            filtered={{ onClear: () => commit(q, []), clearLabel: t('search.action.widenScope') }}
          />
        ) : (
          <EmptyState
            title={t('search.empty', { q })}
            hint={t('search.emptyHint')}
            action={keyboard !== null ? { label: t('search.action.change'), onClick: openPalette } : undefined}
          />
        ))}

      {!tooShort && !loading && !failed && model !== null && model.hits.length > 0 && (
        <div className="search-results">
          {[...groups.entries()].map(([kind, hits]) => (
            <section key={kind} className="search-group panel" aria-label={t(KIND_DISPLAY[kind].labelKey)}>
              <h2 className="search-group-title">
                <NavIcon name={KIND_DISPLAY[kind].icon} className="search-group-icon" size={16} />
                {t(KIND_DISPLAY[kind].labelKey)}
              </h2>
              <ul className="search-hit-list">
                {hits.map((hit) => (
                  <li key={`${hit.entityKind}-${hit.entityId}`}>
                    <button
                      type="button"
                      className="search-hit"
                      onClick={() => navigate(`${hit.route}?focus=${encodeURIComponent(hit.entityId)}`)}
                    >
                      <span className="search-hit-title">{hit.title}</span>
                      {hit.snippet !== undefined && (
                        <span className="search-hit-snippet">
                          {hit.matchedVia === 'custom_field'
                            ? t('search.result.matchedVia.customField', { snippet: hit.snippet })
                            : hit.snippet}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}

          <div className="search-foot">
            {model.hasMore && (
              <button type="button" className="btn btn--secondary" disabled={appending} onClick={() => void loadMore()}>
                {t('search.action.more')}
              </button>
            )}
            {saving ? (
              <form
                className="search-save-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveSearch();
                }}
              >
                <input
                  type="text"
                  className="field search-save-name"
                  value={saveName}
                  onChange={(event) => setSaveName(event.target.value)}
                  placeholder={q}
                  aria-label={t('search.savedSearch.name')}
                />
                <button type="submit" className="btn btn--secondary">
                  {t('search.savedSearch.confirm')}
                </button>
                <button type="button" className="btn btn--ghost" onClick={() => setSaving(false)}>
                  {t('search.savedSearch.cancel')}
                </button>
              </form>
            ) : (
              <button type="button" className="btn btn--ghost" onClick={() => setSaving(true)}>
                {t('search.savedSearch.save')}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

export default Search;
