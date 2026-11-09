/**
 * D178 point 7, Meine Einstellungen (`/my-settings`): every per-person preference on one page.
 *
 * Generic over `prefs_list` (G00 spec §10, US-G00.6): the areas, the defs, the values in force, the
 * defaults, the schemas and the en/de-CH texts all arrive from the engine's preference registry, so a
 * preference a later node adds (the rail arrangement, the bank columns) appears here with no edit. The
 * page reads the Studio's ONE preference store (`lib/prefs.ts`), so a change here moves the rail's theme
 * toggle in the same render, and the other way round.
 *
 * A choice applies at once: a preference is the person's own look, not a money commit and not a
 * workspace setting, so there is no Speichern, no reason and no dialog (D172's Einstellungen on the
 * Setup surface keep theirs). Each row carries "Standard" or the default it differs from and a reset;
 * each group carries a reset for the whole area. A refused write puts the value back and says why
 * beside the control it came from.
 *
 * Structured (`json`) preferences, such as an ordered list or the rail's arrangement, are shown in one
 * line as "Standard" or "Angepasst" with their reset and are edited where they live (the rail, the bank
 * columns), never as raw JSON here; that one line is also their whole state, so the meta line does not
 * repeat a default it cannot spell.
 *
 * Five states: the skeleton while `prefs_list` is in flight, the empty registry (with the way to the
 * workspace settings), the read error with Erneut versuchen, the groups, and the filtered-empty state of
 * the search with Filter zurücksetzen.
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react';

import { useI18n } from '../../i18n';
import { useWorkspaceId } from '../../app/workspace';
import { usePrefsCatalog, usePrefsStore, type PrefValue, type PrefView } from '../../lib/prefs';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton, refusalText } from '../../components/states';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { Segmented } from '../../components/Segmented';
import { Select } from '../../components/Select';
import { parseDraft } from '../Setup/WorkspaceSettings';
import './MySettings.css';

type Localised = { en: string; 'de-CH': string };

function textOf(text: Localised, locale: string): string {
  return locale === 'en' ? text.en : text['de-CH'];
}

/** The areas in registry order, each with its preferences in registry order. */
export function groupPrefs(prefs: readonly PrefView[]): { id: string; label: Localised; prefs: PrefView[] }[] {
  const groups: { id: string; label: Localised; prefs: PrefView[] }[] = [];
  for (const p of prefs) {
    const g = groups.find((x) => x.id === p.area.id);
    if (g === undefined) groups.push({ id: p.area.id, label: p.area.label, prefs: [p] });
    else g.prefs.push(p);
  }
  return groups;
}

/** Does `pref` match the search, in the current locale (label, description, area, key)? */
export function prefMatches(pref: PrefView, query: string, locale: string): boolean {
  const q = query.trim().toLocaleLowerCase();
  if (q === '') return true;
  return [textOf(pref.label, locale), textOf(pref.description, locale), textOf(pref.area.label, locale), pref.key]
    .some((s) => s.toLocaleLowerCase().includes(q));
}

export function MySettings() {
  const { t, locale } = useI18n();
  const workspaceId = useWorkspaceId();
  const { status, error, prefs, reload, store } = usePrefsCatalog();
  const [query, setQuery] = useState('');
  const searchId = useId();

  const shown = useMemo(() => (prefs ?? []).filter((p) => prefMatches(p, query, locale)), [prefs, query, locale]);

  if (workspaceId === null) return <NoWorkspaceState />;

  const header = (
    <SurfaceHeader
      title={t('mySettings.title')}
      titleId="my-settings-title"
      subtitle={t('mySettings.subtitle')}
      help={<SurfaceHelp surface="MySettings" />}
    />
  );

  let body;
  if (prefs === null && status === 'error') {
    body = <ErrorBanner context="read" error={error ?? undefined} onRetry={() => void reload()} />;
  } else if (prefs === null) {
    // Skeleton carries its own role="status" wrapper.
    body = <Skeleton rows={4} labelKey="mySettings.loading" />;
  } else if (prefs.length === 0) {
    body = (
      <EmptyState
        title={t('mySettings.empty.title')}
        hint={t('mySettings.empty.hint')}
        action={{ label: t('mySettings.empty.action'), to: '/setup' }}
      />
    );
  } else {
    body = (
      <>
        {status === 'error' && <ErrorBanner context="read" error={error ?? undefined} onRetry={() => void reload()} />}
        <div className="my-settings-search">
          <label htmlFor={searchId}>{t('mySettings.search.label')}</label>
          <input
            id={searchId}
            className="field"
            type="search"
            value={query}
            placeholder={t('mySettings.search.placeholder')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {shown.length === 0 ? (
          <EmptyState
            title={t('mySettings.filtered.title', { query: query.trim() })}
            hint={t('mySettings.filtered.hint')}
            filtered={{ onClear: () => setQuery('') }}
          />
        ) : (
          groupPrefs(shown).map((group) => {
            const areaLabel = textOf(group.label, locale);
            const allInArea = (prefs ?? []).filter((p) => p.area.id === group.id);
            const anyStored = allInArea.some((p) => !p.isDefault || p.stale);
            return (
              <section key={group.id} className="panel my-settings-group" aria-label={areaLabel} data-area={group.id}>
                <div className="my-settings-group-head">
                  <h2 className="my-settings-group-title">{areaLabel}</h2>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={!anyStored || store === null}
                    aria-label={t('mySettings.resetGroupContext', { area: areaLabel })}
                    onClick={() => void store?.resetArea(group.id)}
                  >
                    {t('mySettings.resetGroup')}
                  </button>
                </div>
                <ul className="my-settings-list">
                  {group.prefs.map((p) => (
                    <PrefRow key={p.key} pref={p} />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </>
    );
  }

  return (
    <section className="my-settings" aria-labelledby="my-settings-title">
      {header}
      {body}
    </section>
  );
}

/** One preference: its words, its control, its default, its reset and its last refusal. */
function PrefRow({ pref }: { pref: PrefView }) {
  const { t, locale } = useI18n();
  // The parent subscribes to the store and re-renders every row on a change, so a plain read is enough.
  const store = usePrefsStore();
  const ids = { label: useId(), description: useId() };
  const label = textOf(pref.label, locale);
  const error = store?.error(pref.key) ?? null;

  const format = (value: PrefValue): string => {
    const schema = pref.schema;
    if (schema.type === 'enum' && typeof value === 'string' && pref.valueLabels?.[value] !== undefined) {
      return textOf(pref.valueLabels[value] as Localised, locale);
    }
    if (schema.type === 'boolean') return value === true ? t('mySettings.yes') : t('mySettings.no');
    if (schema.type === 'json') return t('mySettings.json.default');
    return String(value);
  };

  const set = (next: PrefValue) => void store?.set(pref.key, next);

  return (
    <li className="my-settings-row" data-key={pref.key}>
      <div className="my-settings-text">
        <span className="my-settings-label" id={ids.label}>
          {label}
        </span>
        <p className="my-settings-description" id={ids.description}>
          {textOf(pref.description, locale)}
        </p>
        <p className="my-settings-meta">
          <span>{t(pref.scope === 'person' ? 'mySettings.scope.person' : 'mySettings.scope.workspace')}</span>
          {pref.schema.type !== 'json' && (
            <span className="my-settings-default">
              {pref.isDefault ? t('mySettings.isDefault') : t('mySettings.defaultIs', { value: format(pref.default) })}
            </span>
          )}
        </p>
        {pref.stale && (
          <p className="status-line my-settings-stale" role="status">
            {t('mySettings.stale')}
          </p>
        )}
      </div>
      <div className="my-settings-control">
        <PrefControl pref={pref} labelId={ids.label} describedBy={ids.description} disabled={store === null} onChange={set} />
        {(!pref.isDefault || pref.stale) && (
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            aria-label={t('mySettings.resetKey', { setting: label })}
            onClick={() => void store?.reset(pref.key)}
          >
            {t('mySettings.reset')}
          </button>
        )}
      </div>
      {error !== null && (
        <p className="status-line status-error my-settings-error" role="alert">
          {refusalText(t, error, { own: 'mySettings.refusal' })}
        </p>
      )}
    </li>
  );
}

/** A control fitted to the schema. A choice applies at once; a typed value applies on Enter or on leaving. */
function PrefControl({
  pref,
  labelId,
  describedBy,
  disabled,
  onChange,
}: {
  pref: PrefView;
  labelId: string;
  describedBy: string;
  disabled: boolean;
  onChange: (next: PrefValue) => void;
}) {
  const { t, locale } = useI18n();
  const schema = pref.schema;

  if (schema.type === 'enum') {
    const options = schema.values.map((v) => ({
      value: v,
      label: pref.valueLabels?.[v] === undefined ? v : textOf(pref.valueLabels[v] as Localised, locale),
    }));
    const current = typeof pref.value === 'string' ? pref.value : String(pref.value);
    return options.length <= 5 ? (
      <Segmented options={options} value={current} onChange={onChange} labelledBy={labelId} disabled={disabled} />
    ) : (
      <Select
        value={current}
        options={options}
        onChange={onChange}
        ariaLabel={textOf(pref.label, locale)}
        describedBy={describedBy}
        disabled={disabled}
      />
    );
  }

  if (schema.type === 'boolean') {
    return (
      <Segmented
        options={[
          { value: 'true', label: t('mySettings.yes') },
          { value: 'false', label: t('mySettings.no') },
        ]}
        value={pref.value === true ? 'true' : 'false'}
        onChange={(v) => onChange(v === 'true')}
        labelledBy={labelId}
        disabled={disabled}
      />
    );
  }

  if (schema.type === 'json') {
    return (
      <span className="my-settings-json" id={`${labelId}-json`}>
        {pref.isDefault ? t('mySettings.json.default') : t('mySettings.json.custom')}
        <span className="my-settings-json-hint">{t('mySettings.json.hint')}</span>
      </span>
    );
  }

  return <TypedField pref={pref} labelId={labelId} describedBy={describedBy} disabled={disabled} onChange={onChange} />;
}

/** A number or a text: the draft applies on Enter or on leaving the field, and only when it fits. */
function TypedField({
  pref,
  labelId,
  describedBy,
  disabled,
  onChange,
}: {
  pref: PrefView;
  labelId: string;
  describedBy: string;
  disabled: boolean;
  onChange: (next: PrefValue) => void;
}) {
  const { t } = useI18n();
  const schema = pref.schema;
  const [draft, setDraft] = useState(String(pref.value));
  useEffect(() => setDraft(String(pref.value)), [pref.value]);
  if (schema.type !== 'integer' && schema.type !== 'number' && schema.type !== 'string') return null;
  const parsed = parseDraft(schema, draft);
  const hintId = `${labelId}-bounds`;

  const commit = () => {
    if (parsed === undefined) {
      setDraft(String(pref.value));
      return;
    }
    if (parsed !== pref.value) onChange(parsed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') setDraft(String(pref.value));
  };

  return (
    <span className="my-settings-typed">
      <input
        className="field"
        inputMode={schema.type === 'string' ? undefined : 'numeric'}
        value={draft}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={schema.type === 'string' ? describedBy : `${describedBy} ${hintId}`}
        aria-invalid={parsed === undefined || undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
      {(schema.type === 'integer' || schema.type === 'number') && (
        <span className="field-hint" id={hintId}>
          {t('mySettings.bounds', { min: String(schema.min), max: String(schema.max) })}
        </span>
      )}
    </span>
  );
}

export default MySettings;
