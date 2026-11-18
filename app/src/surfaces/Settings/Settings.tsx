/**
 * D202, redesigned by the owner's pick A (18.11.2026): THE EINSTELLUNGEN ARE ONE PAGE. The header carries the
 * title and the search (top right). On the left a slim sticky rail lists the ten areas, each an icon and a
 * name, its sub-headings on hover and focus. On the right the chosen area's rows under small dim group
 * headings, or, while the search has text, every matching setting of every area under its area's name.
 * `/settings` shows the first area, `/settings/<area>` that area; a deep link `?focus=<key>` scrolls to the
 * row and focuses its control. G00 §11.7 is the contract; the design law is DESIGN.md "The calm Studio" and
 * "The seven screen types" (Settings).
 *
 * Every word comes from `settings_list` (the engine's presentation file), read through the catalog shared
 * with Cmd K (`lib/settings-index.ts`), which reads it again after every write and when the window regains
 * focus.
 *
 * A row (`SettingRow`): the plain label, its description and, on a human-only setting, "Nur eine Person
 * ändert das, nie der Agent." as the label's tooltip; a dim dot while changed; Auf Standard zurück and the
 * Änderungen clock on hover or focus; the control in one 240px column; a padlock only when the person lacks
 * the right (D204). A change saves at once with a toast that offers Rückgängig; a refusal puts the value
 * back and says why under the row. What the agent may change is one row of the Agent area
 * (`agent.settings_sections`, a multi-select), never a second switch in the head.
 *
 * Nothing else: no home of tiles, no counts, no "Zuletzt geändert" (the row's Änderungen keeps the
 * history), no line of open questions (an area with one carries a dot in the rail, the row its one-line
 * question). DESIGN.md rule 7.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { useWorkspaceId } from '../../app/workspace';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useCapabilities } from '../../lib/capabilities';
import {
  buildSettingsIndex,
  plainDescription,
  reloadSettingsCatalog,
  searchSettings,
  textOf,
  useSettingsCatalog,
  valueWords,
  type Locale,
  type SettingEntryView,
  type SettingValue,
  type SettingsAreaEntry,
  type SettingsCatalog,
  type SettingsIndexEntry,
} from '../../lib/settings-index';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SettingGroup, SettingRow } from '../../components/SettingRow';
import { IconButton } from '../../components/IconButton';
import { Tooltip, TooltipPortalContext } from '../../components/Tooltip';
import { VOCABULARY } from '../../components/icons';
import { ErrorBanner, NoWorkspaceState, Skeleton, refusalText } from '../../components/states';
import { LockGlyph } from '../../components/states/glyphs';
import { NavIcon } from '../../app/nav-icons';
import type { NavIconName } from '../../app/nav';
import { NotFound } from '../../app/NotFound';
import { useSeatNames } from '../../app/useSeatNames';
import { SettingControl } from './SettingControl';
import './Settings.css';

const TOAST_MS = 8000;
const SearchGlyph = VOCABULARY.search.glyph;
/** The controls a hit or a deep link focuses: the row's control, never its label. */
const CONTROL = '.setting-row-control button:not(:disabled), .setting-row-control input:not(:disabled)';

let keySeq = 0;
const newKey = () => `settings-${Date.now().toString(36)}-${(keySeq += 1)}`;

/** One change as `settings_history` answers it. */
interface ChangeView {
  id: string;
  key: string;
  kind: 'set' | 'reset';
  oldValue: SettingValue | null;
  newValue: SettingValue | null;
  actor: string;
  seat: string | null;
  via: string | null;
  approvedBy: string | null;
  proposedBy: string | null;
  at: string;
}

interface Toast {
  label: string;
  undo: (() => void) | null;
}

type Write = (s: SettingEntryView, next: SettingValue | null, isUndo?: boolean) => Promise<void>;

/** The route's area id: `/settings` is null (the first area shows), `/settings/bank` the Bank area. */
function areaFromPath(pathname: string): string | null {
  const m = /^\/settings\/([a-z]+)\/?$/.exec(pathname);
  return m === null ? null : (m[1] ?? null);
}

export function Settings() {
  const { t, locale: rawLocale } = useI18n();
  const locale = rawLocale as Locale;
  const workspaceId = useWorkspaceId();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('focus');
  const { catalog, error, reload } = useSettingsCatalog(workspaceId);
  const titleId = useId();
  const areaId = areaFromPath(pathname);
  const [query, setQuery] = useState('');
  const { pending, errors, toast, setToast, write } = useSettingWrites(workspaceId, locale);
  const index = useMemo(() => (catalog === null ? [] : buildSettingsIndex(catalog, locale)), [catalog, locale]);

  // A new area or a workspace switch starts with an empty search (D153: a switch resets the surface).
  useEffect(() => setQuery(''), [pathname, workspaceId]);

  // `?focus=<key>`: scroll to the row and focus its control (D152 rule 5's precedent), once per deep link: a
  // later read of the catalog (after a write, on window focus) never pulls focus back to it.
  const focused = useRef<string | null>(null);
  useEffect(() => {
    const target = focus === null ? null : `${pathname}?${focus}`;
    if (target === null || catalog === null || focused.current === target) return;
    const row = document.querySelector(`.setting-row[data-key="${CSS.escape(focus ?? '')}"]`);
    if (row === null) return;
    focused.current = target;
    (row as HTMLElement).scrollIntoView?.({ block: 'center' });
    (row.querySelector(CONTROL) as HTMLElement | null)?.focus();
  }, [focus, pathname, catalog]);

  if (workspaceId === null) return <NoWorkspaceState />;
  const area = catalog === null ? null : areaId === null ? (catalog.areas[0] ?? null) : (catalog.areas.find((a) => a.id === areaId) ?? null);
  if (areaId !== null && catalog !== null && area === null) return <NotFound />;

  let body: ReactNode;
  if (catalog === null && error !== null) body = <ErrorBanner context="read" error={error} onRetry={reload} />;
  else if (catalog === null || area === null) body = <Skeleton rows={6} labelKey="settingsHub.loading" />;
  else {
    const rows = (list: readonly SettingEntryView[]) =>
      list.map((s) => (
        <Row
          key={s.key}
          setting={s}
          areas={catalog.areas}
          workspaceId={workspaceId}
          locale={locale}
          value={pending[s.key] ?? s.value}
          error={errors[s.key] ?? null}
          onChange={(next) => void write(s, next)}
          onReset={() => void write(s, null)}
        />
      ));
    body = (
      <TooltipPortalContext.Provider value={true}>
        <div className="settings-layout">
          <AreaRail catalog={catalog} selected={query.trim() === '' ? area.id : null} locale={locale} />
          <div className="settings-main">
            {query.trim() === '' ? (
              <AreaRows catalog={catalog} area={area} locale={locale} rows={rows} />
            ) : (
              <SearchResults catalog={catalog} index={index} query={query} rows={rows} />
            )}
          </div>
        </div>
      </TooltipPortalContext.Provider>
    );
  }

  return (
    <section className="settings-surface" aria-labelledby={titleId}>
      <SurfaceHeader
        title={t('settingsHub.title')}
        titleId={titleId}
        help={<SurfaceHelp surface="Settings" />}
        actions={<SettingsSearch query={query} onQuery={setQuery} autoFocus={focus === null} />}
      />
      {body}
      {toast !== null && (
        <div className="settings-toast" role="status">
          <span>{t('settingsHub.saved', { setting: toast.label })}</span>
          {toast.undo !== null && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                const undo = toast.undo;
                setToast(null);
                undo?.();
              }}
            >
              {t('settingsHub.undo')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export default Settings;

/** Saving on change: the value in flight, the refusals per row, the toast with Rückgängig. */
function useSettingWrites(workspaceId: string | null, locale: Locale) {
  const client = useClient();
  const [pending, setPending] = useState<Record<string, SettingValue>>({});
  const [errors, setErrors] = useState<Record<string, Err>>({});
  const [toast, setToast] = useState<Toast | null>(null);

  useEffect(() => {
    setPending({});
    setErrors({});
    setToast(null);
  }, [workspaceId]);
  useEffect(() => {
    if (toast === null) return;
    const id = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  const write: Write = useCallback(
    async (s, next, isUndo = false) => {
      if (workspaceId === null) return;
      const before = { overridden: s.overridden, value: s.value };
      setPending((p) => ({ ...p, [s.key]: next ?? s.default }));
      setErrors((e) => {
        const { [s.key]: _drop, ...rest } = e;
        return rest;
      });
      const { body } =
        next === null
          ? await client.call('settings_reset', { workspaceId, key: s.key, idempotencyKey: newKey() })
          : await client.call('settings_set', { workspaceId, key: s.key, value: next, idempotencyKey: newKey() });
      setPending((p) => {
        const { [s.key]: _drop, ...rest } = p;
        return rest;
      });
      if (isErr(body)) {
        setErrors((e) => ({ ...e, [s.key]: body }));
        return;
      }
      reloadSettingsCatalog();
      setToast({
        label: textOf(s.presentation.label, locale),
        undo: isUndo ? null : () => void write({ ...s, overridden: true }, before.overridden ? before.value : null, true),
      });
    },
    [client, workspaceId, locale],
  );
  return { pending, errors, toast, setToast, write };
}

// --- the search ---------------------------------------------------------------------------------------

function SettingsSearch({ query, onQuery, autoFocus }: { query: string; onQuery: (q: string) => void; autoFocus: boolean }) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (autoFocus && window.matchMedia?.('(min-width: 768px)').matches !== false) inputRef.current?.focus();
  }, [autoFocus]);
  return (
    <div className="settings-search" role="search">
      <span className="settings-search-glyph" aria-hidden="true">
        <SearchGlyph size={16} />
      </span>
      <input
        ref={inputRef}
        type="search"
        className="field settings-search-field"
        aria-label={t('settingsHub.search.label')}
        placeholder={t('settingsHub.search.placeholder')}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onQuery('');
          if (e.key === 'Enter' || e.key === 'ArrowDown') {
            const first = document.querySelector(`.settings-main ${CONTROL.split(', ').join(', .settings-main ')}`) as HTMLElement | null;
            if (first !== null) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      />
    </div>
  );
}

/** Every matching setting and page of every area, under its area's name, best area first. */
function SearchResults({
  catalog,
  index,
  query,
  rows,
}: {
  catalog: SettingsCatalog;
  index: readonly SettingsIndexEntry[];
  query: string;
  rows: (list: readonly SettingEntryView[]) => ReactNode;
}) {
  const { t, locale } = useI18n();
  const hits = searchSettings(index, query);
  if (hits.length === 0) return <p className="settings-none">{t('settingsHub.search.none', { query: query.trim() })}</p>;
  const groups: { area: SettingsAreaEntry; entries: SettingsIndexEntry[] }[] = [];
  for (const { entry } of hits) {
    const area = catalog.areas.find((a) => a.id === entry.area);
    if (area === undefined) continue;
    const g = groups.find((x) => x.area.id === area.id);
    if (g === undefined) groups.push({ area, entries: [entry] });
    else g.entries.push(entry);
  }
  return (
    <div className="settings-groups" role="region" aria-label={t('settingsHub.search.results')}>
      {groups.map((g) => {
        const settings = g.entries.flatMap((e) => (e.kind === 'setting' ? catalog.settings.filter((s) => s.key === e.id) : []));
        const pages = g.entries.flatMap((e) => (e.kind === 'page' ? g.area.pages.filter((p) => p.id === e.id) : []));
        return (
          <SettingGroup key={g.area.id} title={textOf(g.area.label, locale as Locale)} dataKey={g.area.id}>
            {rows(settings)}
            {pages.map((p) => (
              <PageRow key={p.id} label={textOf(p.label, locale as Locale)} id={p.id} route={p.route} />
            ))}
          </SettingGroup>
        );
      })}
    </div>
  );
}

// --- the rail -----------------------------------------------------------------------------------------

/** `selected` is null while the search has text: the results span every area, so none is the chosen one. */
function AreaRail({ catalog, selected, locale }: { catalog: SettingsCatalog; selected: string | null; locale: Locale }) {
  const { t } = useI18n();
  return (
    <nav className="settings-rail" aria-label={t('settingsHub.areas')}>
      <ul className="settings-rail-list">
        {catalog.areas.map((a) => {
          const rows = catalog.settings.filter((s) => s.section === a.id);
          const open = rows.filter((s) => catalog.unanswered.includes(s.key)).length;
          const subgroups = [...new Set(rows.map((s) => textOf(s.presentation.subgroup, locale)))];
          const tip = [...subgroups, ...a.pages.map((p) => textOf(p.label, locale))].join(', ');
          const openWords = open > 0 ? t('settingsHub.openQuestions', { n: String(open) }) : '';
          const link = (
            <Link className="settings-rail-item" to={`/settings/${a.id}`} aria-current={a.id === selected ? 'page' : undefined} data-area={a.id}>
              <NavIcon name={a.icon as NavIconName} size={16} />
              <span className="settings-rail-name">{textOf(a.label, locale)}</span>
              {open > 0 && (
                <>
                  <span className="settings-rail-dot" aria-hidden="true" />
                  <span className="visually-hidden">{openWords}</span>
                </>
              )}
            </Link>
          );
          const content = [tip, openWords].filter((x) => x !== '').join(' · ');
          return (
            <li key={a.id}>
              {content === '' ? (
                link
              ) : (
                <Tooltip content={content} align="start">
                  {link}
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// --- the chosen area ----------------------------------------------------------------------------------

function AreaRows({
  catalog,
  area,
  locale,
  rows,
}: {
  catalog: SettingsCatalog;
  area: SettingsAreaEntry;
  locale: Locale;
  rows: (list: readonly SettingEntryView[]) => ReactNode;
}) {
  const { t } = useI18n();
  const groups: { label: string; rows: SettingEntryView[] }[] = [];
  for (const s of catalog.settings.filter((x) => x.section === area.id)) {
    const label = textOf(s.presentation.subgroup, locale);
    const g = groups.find((x) => x.label === label);
    if (g === undefined) groups.push({ label, rows: [s] });
    else g.rows.push(s);
  }
  return (
    <div className="settings-groups" data-area={area.id}>
      {groups.map((g) => (
        <SettingGroup key={g.label} title={g.label}>
          {rows(g.rows)}
        </SettingGroup>
      ))}
      {area.pages.length > 0 && (
        <SettingGroup title={t('settingsHub.pages')}>
          {area.pages.map((p) => (
            <PageRow key={p.id} label={textOf(p.label, locale)} id={p.id} route={p.route} />
          ))}
        </SettingGroup>
      )}
    </div>
  );
}

/** A settings page of the area: its name, and Öffnen in the control column. */
function PageRow({ label, id, route }: { label: string; id: string; route: string }) {
  const navigate = useNavigate();
  return (
    <SettingRow label={label} dataKey={`page:${id}`}>
      <IconButton icon="open" small context={label} onClick={() => navigate(route)} />
    </SettingRow>
  );
}

function Row({
  setting: s,
  areas,
  workspaceId,
  locale,
  value,
  error,
  onChange,
  onReset,
}: {
  setting: SettingEntryView;
  areas: readonly SettingsAreaEntry[];
  workspaceId: string;
  locale: Locale;
  value: SettingValue;
  error: Err | null;
  onChange: (next: SettingValue) => void;
  onReset: () => void;
}) {
  const { t } = useI18n();
  const { can } = useCapabilities();
  const labelId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const allowed = can(s.owningCapability);
  const label = textOf(s.presentation.label, locale);
  const description = plainDescription(s, locale);
  // A41 ask-first, unanswered: the row's dot in the warn ink and these words first on the label's tip; the
  // answer is the row's own "Vorschlag übernehmen" (or any pick in the control), never a line under the row.
  const open = s.askFirst && !s.answered;
  const question = open ? t('settingsHub.question', { value: valueWords(s, s.default, locale, areas) }) : '';
  const tip =
    description === '' && !s.humanOnly && !open ? undefined : (
      <>
        {open && <span className="settings-tip-line">{question}</span>}
        {description !== '' && <span className="settings-tip-line">{description}</span>}
        {s.humanOnly && <span className="settings-tip-line">{t('settingsHub.humanOnly')}</span>}
      </>
    );
  return (
    <SettingRow
      label={label}
      labelId={labelId}
      dataKey={s.key}
      {...(tip !== undefined ? { description: tip } : {})}
      changed={s.overridden}
      open={open}
      reset={allowed && (s.overridden || s.stale === true) ? { defaultLabel: valueWords(s, s.default, locale, areas), onReset } : undefined}
      tools={
        <>
          {open && allowed && (
            <IconButton icon="done" small name={t('settingsHub.accept')} context={question} onClick={() => onChange(s.default)} />
          )}
          <IconButton icon="history" small context={label} aria-expanded={historyOpen} onClick={() => setHistoryOpen((o) => !o)} />
        </>
      }
      mark={
        allowed ? undefined : (
          <Tooltip content={t('settingsHub.lock.noRight')}>
            <span className="settings-lock" tabIndex={0} aria-label={t('settingsHub.lock.noRight')}>
              <LockGlyph size={14} />
            </span>
          </Tooltip>
        )
      }
      status={
        <>
          {error !== null && (
            <p className="status-line status-error" role="alert">
              {refusalText(t, error, { own: 'settingsHub.refusal' })}
            </p>
          )}
          {historyOpen && <History setting={s} areas={areas} workspaceId={workspaceId} locale={locale} />}
        </>
      }
    >
      <SettingControl setting={s} value={value} areas={areas} labelId={labelId} disabled={!allowed} locale={locale} onChange={onChange} />
    </SettingRow>
  );
}

// --- the row's Änderungen -----------------------------------------------------------------------------

type NameOf = (id: string) => string;

function who(c: ChangeView, t: (key: string, p?: Record<string, string>) => string, nameOf: NameOf): string {
  if (c.via === 'vorschlag') return t('settingsHub.history.viaProposal', { person: seatName(c.approvedBy ?? c.actor, t, nameOf) });
  if (c.via === 'standing') return t('settingsHub.history.viaStanding');
  // Re-check L3: a plugin's change says a plugin made it, under whose installation (the plugin runs as them).
  if (c.seat === 'plugin') return t('settingsHub.history.plugin', { person: seatName(c.actor, t, nameOf) });
  if (c.seat === 'agent') return t('settingsHub.history.agent');
  return seatName(c.actor, t, nameOf);
}

/** Critic L4: a person by the name the roster knows (`useSeatNames`), never the raw member id. */
function seatName(actor: string, t: (key: string) => string, nameOf: NameOf): string {
  if (actor === 'studio') return t('settingsHub.history.you');
  if (actor === 'agent') return t('settingsHub.history.agent');
  return nameOf(actor);
}

/** The roster's names for the history lines. */
function useNameOf(): NameOf {
  const names = useSeatNames();
  return (id: string) => names(id).label;
}

function when(at: string, locale: Locale): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : d.toLocaleDateString(locale === 'en' ? 'en-GB' : 'de-CH');
}

/** The row's Änderungen: who, from what, to what, when, how. */
function History({ setting: s, areas, workspaceId, locale }: { setting: SettingEntryView; areas: readonly SettingsAreaEntry[]; workspaceId: string; locale: Locale }) {
  const { t } = useI18n();
  const client = useClient();
  const nameOf = useNameOf();
  const [changes, setChanges] = useState<ChangeView[] | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      const { body } = await client.call('settings_history', { workspaceId, key: s.key, limit: 10 });
      if (live) setChanges(isErr(body) ? [] : ((body as { changes?: ChangeView[] }).changes ?? []));
    })();
    return () => {
      live = false;
    };
  }, [client, workspaceId, s.key, s.value]);
  if (changes === null) return null;
  if (changes.length === 0) return <p className="settings-history-empty">{t('settingsHub.history.none')}</p>;
  const words = (v: SettingValue | null) => valueWords(s, v ?? s.default, locale, areas);
  return (
    <ul className="settings-history" aria-label={t('settingsHub.history.name')}>
      {changes.map((c) => (
        <li key={c.id}>
          <span className="t-num">{when(c.at, locale)}</span> {words(c.oldValue)} → {c.kind === 'reset' ? t('settingsHub.history.default') : words(c.newValue)} · {who(c, t, nameOf)}
        </li>
      ))}
    </ul>
  );
}
