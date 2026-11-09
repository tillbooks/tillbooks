/**
 * The G10 mapping editor (US-G10.1/US-G10.2/US-G10.3), rendered on the Datenübernahme surface: a map
 * is never edited apart from the plan it belongs to, so there is no new route.
 *
 * WHAT THIS EDITOR IS CAREFUL ABOUT:
 *   - Three map kinds share ONE editor, switched by a tab (column, account, tax): the shape is the
 *     same source-to-target table each time, so three components for one act would be three answers.
 *   - Completeness is the honest read model the engine returns: `blocking` (an unmapped account with a
 *     non-zero balance, which OR 957a Klarheit forbids leaving silent) is named with its figure;
 *     `ignorable` (a zero-balance account) is named as skippable, never as an error; `collapsed`
 *     (many source rows onto one target) and `conflicts` (a template proposed a different target) are
 *     shown as facts, not blocks.
 *   - "Suggest" prefills from `migration_suggest_map` (adapter preset, locale pack, saved template,
 *     fuzzy) and NAMES its source, so an operator sees where a proposal came from before trusting it.
 *   - A passing (complete) map spends no colour (brand law): only a blocking gap draws attention.
 *   - Nothing is minted: it wires `migration_get_map`, `migration_suggest_map` and
 *     `migration_set_map`, all already in the registry.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { formatMoney, useT } from '../../i18n';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { Tabs } from '../../components/Tabs';
import { ErrorBanner } from '../../components/states';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

const KINDS = ['column', 'account', 'tax'] as const;
type Kind = (typeof KINDS)[number];

interface MapEntry {
  source: string;
  sourceName?: string | null;
  sourceRateBp?: number;
  balanceMinor?: number;
  target?: string | null;
  validFrom?: string;
}
interface Assessment {
  mapId: string | null;
  entries: MapEntry[];
  complete: boolean;
  blocking: Array<{ source: string; sourceName: string | null; balanceMinor: number | null }>;
  ignorable: Array<{ source: string; sourceName: string | null }>;
  collapsed: Array<{ target: string; sources: string[] }>;
  conflicts: Array<{ source: string; target: string; templateTarget: string }>;
}

type State =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'loaded'; map: Assessment };

export function MappingEditor(props: { workspaceId: string; planId: string; currency: string }): React.ReactElement {
  const { workspaceId, planId, currency } = props;
  const client = useClient();
  const t = useT();

  const [kind, setKind] = useState<Kind>('column');
  const [state, setState] = useState<State>({ status: 'loading' });
  const [draft, setDraft] = useState<MapEntry[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [suggestSource, setSuggestSource] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);
  // f7: save() used to `return` in silence on an engine refusal, so `savedNotice` never set and the
  // screen looked unchanged after a rejected write; suggest() swallowed its refusal the same way.
  // Each failure now names itself as text (role="alert").
  const [writeError, setWriteError] = useState<'save' | 'suggest' | null>(null);

  const load = useCallback(
    async (which: Kind) => {
      setState({ status: 'loading' });
      setDirty(false);
      setSuggestSource(null);
      setSavedNotice(false);
      setWriteError(null);
      const res = (await client.call('migration_get_map', { workspaceId, planId, kind: which })).body;
      if (isErr(res)) {
        setState({ status: 'error' });
        return;
      }
      const map = res as unknown as Assessment;
      setState({ status: 'loaded', map });
      setDraft((map.entries ?? []).map((e) => ({ ...e })));
    },
    [client, workspaceId, planId],
  );

  useEffect(() => {
    void load(kind);
  }, [load, kind]);

  async function suggest(): Promise<void> {
    setWriteError(null);
    const headers = draft.map((e) => e.source).filter((s) => s !== '');
    const res = (await client.call('migration_suggest_map', { workspaceId, planId, kind, headers })).body;
    if (isErr(res)) {
      setWriteError('suggest');
      return;
    }
    const entries = (res.entries ?? []) as MapEntry[];
    setSuggestSource((res.source as string) ?? 'none');
    if (entries.length === 0) return;
    // Merge proposed targets onto the existing rows by source, so a hand-typed value is not lost
    // when a proposal has nothing to say about that row. G10 map-suggest residual: a linked bexio
    // Saldenliste starts with an EMPTY draft (no map saved yet, so `migration_get_map` returns no
    // entries), and its discovered columns arrive ENTIRELY from the suggestion. An overlay-only merge
    // walks `prev` and finds nothing, so those columns were silently dropped and Vorschlagen showed
    // no columns at all. Append every suggested source the draft does not already carry.
    const bySource = new Map(entries.map((e) => [e.source, e]));
    setDraft((prev) => {
      const seen = new Set(prev.map((e) => e.source));
      const overlaid = prev.map((e) => {
        const hit = bySource.get(e.source);
        return hit === undefined || hit.target === null || hit.target === undefined ? e : { ...e, target: hit.target };
      });
      const added = entries.filter((e) => !seen.has(e.source));
      return [...overlaid, ...added];
    });
    setDirty(true);
  }

  async function save(): Promise<void> {
    setSaving(true);
    setSavedNotice(false);
    setWriteError(null);
    try {
      const res = (await client.call('migration_set_map', { workspaceId, planId, kind, entries: draft, idempotencyKey: newIdempotencyKey() })).body;
      if (isErr(res)) {
        setWriteError('save');
        return;
      }
      setSavedNotice(true);
      await load(kind);
    } finally {
      setSaving(false);
    }
  }

  function setTarget(source: string, target: string): void {
    setDraft((prev) => prev.map((e) => (e.source === source ? { ...e, target: target === '' ? null : target } : e)));
    setDirty(true);
  }

  // The source-to-target grid is genuinely tabular, so it moves onto the shared DataTable: the frame,
  // sticky header, density and the loading/empty states come from the primitive, and the per-surface
  // `.mapping-table` / `.mapping-skeleton` CSS is deleted. The source cell keeps its compound
  // (number, name, verbatim balance from the read model) and the target cell keeps its labelled input.
  const columns: DataTableColumn<MapEntry>[] = [
    {
      key: 'source',
      header: t('migration.mapping.col.source'),
      render: (e) => (
        <>
          <span className="mapping-source">{e.source}</span>
          {typeof e.sourceName === 'string' && e.sourceName !== '' && (
            <span className="mapping-source-name">{e.sourceName}</span>
          )}
          {typeof e.balanceMinor === 'number' && (
            <span className="mapping-balance">{formatMoney(e.balanceMinor, currency)}</span>
          )}
        </>
      ),
    },
    {
      key: 'target',
      header: t(`migration.mapping.col.target.${kind}`),
      render: (e) => (
        <input
          type="text"
          className="field mapping-target-input"
          value={e.target ?? ''}
          aria-label={t('migration.mapping.targetFor', { source: e.source })}
          onChange={(ev) => setTarget(e.source, ev.target.value)}
        />
      ),
    },
  ];

  return (
    <section className="mapping" aria-label={t('migration.mapping.title')}>
      <h2>{t('migration.mapping.title')}</h2>

      {/* K-11: the three mappings are views of ONE plan's mapping, so they are the shared Tabs (one
          panel, rendered here), not a hand-rolled button strip with its own selected treatment. */}
      <Tabs
        tabs={KINDS.map((k) => ({ id: k, label: t(`migration.mapping.kind.${k}`) }))}
        activeId={kind}
        onChange={(id) => setKind(id as Kind)}
        label={t('migration.mapping.title')}
      >
      <div className="mapping-panel">
      {state.status === 'error' ? (
        <ErrorBanner message={t('migration.mapping.error')} context="read" onRetry={() => void load(kind)} />
      ) : (
        <DataTable
          columns={columns}
          rows={state.status === 'loaded' ? draft : []}
          rowKey={(e) => e.source}
          loading={state.status === 'loading'}
          skeletonRows={2}
          caption={t('migration.mapping.title')}
          emptyState={<p className="mapping-empty">{t('migration.mapping.empty')}</p>}
        />
      )}

      {state.status === 'loaded' && (
        <>
          {/* The honest completeness read model: a blocking gap draws attention, a passing map does not. */}
          {state.map.complete && !dirty ? (
            <p className="mapping-complete">{t('migration.mapping.complete')}</p>
          ) : state.map.blocking.length > 0 ? (
            <div className="mapping-blocking" role="note">
              <p>{t('migration.mapping.blocking.title', { n: state.map.blocking.length })}</p>
              <ul>
                {state.map.blocking.map((b) => (
                  <li key={b.source}>
                    {b.source}
                    {b.sourceName !== null && <span className="mapping-source-name">{b.sourceName}</span>}
                    {b.balanceMinor !== null && <span className="mapping-balance">{formatMoney(b.balanceMinor, currency)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.map.ignorable.length > 0 && (
            <p className="mapping-ignorable">{t('migration.mapping.ignorable', { n: state.map.ignorable.length })}</p>
          )}

          {state.map.collapsed.length > 0 && (
            <ul className="mapping-collapsed">
              {state.map.collapsed.map((c) => (
                <li key={c.target}>{t('migration.mapping.collapsed', { target: c.target, n: c.sources.length })}</li>
              ))}
            </ul>
          )}

          {state.map.conflicts.length > 0 && (
            <ul className="mapping-conflicts" role="note">
              {state.map.conflicts.map((c) => (
                <li key={c.source}>{t('migration.mapping.conflict', { source: c.source, target: c.target, template: c.templateTarget })}</li>
              ))}
            </ul>
          )}

          {suggestSource !== null && (
            <p className="mapping-suggest-source">{t(`migration.mapping.suggestSource.${suggestSource}`)}</p>
          )}
          {savedNotice && <p className="mapping-saved" role="status">{t('migration.mapping.saved')}</p>}
          {writeError !== null && <p className="mapping-write-error" role="alert">{t(`migration.mapping.${writeError}Error`)}</p>}

          <div className="mapping-actions">
            <button type="button" className="btn btn--ghost mapping-suggest" onClick={() => void suggest()}>{t('migration.mapping.suggest')}</button>
            <button type="button" className="btn btn--secondary" disabled={saving || draft.length === 0} onClick={() => void save()}>
              {t('migration.mapping.save')}
            </button>
          </div>
        </>
      )}
      </div>
      </Tabs>
    </section>
  );
}

export default MappingEditor;
