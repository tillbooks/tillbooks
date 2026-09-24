/**
 * G02, the Erweiterungen surface (spec §6): the human oversight face over installed extensions, the
 * permission-review dialog that gates every install, the registry-browse tab, and the sandboxed
 * iframe a plugin's Studio screen mounts in.
 *
 * The five states are all here (loading skeletons, empty, error, permission-denied padlock, success),
 * status is glyph + label (never colour alone, the DESIGN.md rule), and the single teal accent goes to
 * the one primary action (Installieren). A plugin's registered Studio screen renders in an iframe with
 * `sandbox="allow-scripts"` and NO `allow-same-origin`, its CSP `connect-src` built from the plugin's
 * granted `network:*` scopes only, talking to the shell over `postMessage` alone: the boundary the
 * engine's `iframeSandboxDescriptor` states, realized in the Studio.
 *
 * ## BUILT ON THE SHARED UI PRIMITIVES (D118 Phase 2, 2026-08-24)
 *
 * The page header is the shared `SurfaceHeader` (title, lede subtitle, inline help, and the one
 * primary Install action pinned right), the Installed/Browse switch is the shared WAI-ARIA `Tabs`
 * (replacing the hand-rolled tablist and its right-aligned action strip), and both overlays (the
 * permission-review consent dialog and the sandboxed plugin-screen dialog) are the shared `Modal`,
 * so focus-trap, Escape, scrim-dismiss and the typed dialog role live in one place. The plugin cards
 * stay a bespoke responsive card grid: that is not a table, so `DataTable` does not fit, and the
 * Browse search stays hand-rolled because it is a submit-to-apply registry lookup, not the live
 * keystroke filter `FilterBar` models.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useCapabilities, CAP } from '../../lib/capabilities';
import { useT } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { Status } from '../../components/Status';
import { Tabs } from '../../components/Tabs';
import { Modal } from '../../components/Modal';
import { EmptyState, ErrorBanner, NoWorkspaceState, Skeleton } from '../../components/states';
import { pluginStatusKind, type PluginDto, type PreviewDto, type RegistryEntryDto } from './model';
import './Extensions.css';

function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/** Read a picked file as text, tolerant of environments where `Blob.text()` is not wired. */
async function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    try {
      return await file.text();
    } catch {
      // fall through to the FileReader path
    }
  }
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('read_failed'));
    reader.readAsText(file);
  });
}

type Tab = 'installed' | 'browse';

type Feedback = { tone: 'success' | 'error'; text: string };

type InstalledState =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | { kind: 'ok'; plugins: readonly PluginDto[] };

type BrowseState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'needs_registry' }
  | { kind: 'unreachable'; entries: readonly RegistryEntryDto[] }
  | { kind: 'ok'; entries: readonly RegistryEntryDto[]; query: string };

/** The review dialog's working state: the parsed preview plus the bundle to install and the checked scopes. */
interface ReviewState {
  preview: PreviewDto;
  packageRef: unknown;
  source: string;
  checked: Record<string, boolean>;
}

/** Parse a plugin's granted network scopes into a CSP connect-src (the engine's iframe descriptor, mirrored). */
function connectSrcFor(granted: readonly string[]): string {
  const hosts = granted.filter((s) => s.startsWith('network:')).map((s) => s.slice('network:'.length)).filter((h) => h.length > 0);
  return hosts.length === 0 ? "'none'" : hosts.join(' ');
}

export function Extensions() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const caps = useCapabilities();
  const searchId = useId();
  const titleId = useId();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canManage = caps.can(CAP.managePlugins);

  const [tab, setTab] = useState<Tab>('installed');
  const [installed, setInstalled] = useState<InstalledState>({ kind: 'loading' });
  const [browse, setBrowse] = useState<BrowseState>({ kind: 'idle' });
  const [query, setQuery] = useState('');
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<ReviewState | null>(null);
  const [openScreen, setOpenScreen] = useState<PluginDto | null>(null);

  const load = useCallback(async () => {
    if (workspaceId === null) return;
    setInstalled({ kind: 'loading' });
    const response = await client.call('list_plugins', { workspaceId });
    if (isErr(response.body)) {
      setInstalled({ kind: 'error', code: response.body.error });
      return;
    }
    const body = response.body as unknown as { plugins: readonly PluginDto[] };
    setInstalled({ kind: 'ok', plugins: body.plugins });
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  // --- install / review ------------------------------------------------------------------------

  const openReviewFromBundle = useCallback(
    async (packageRef: unknown, source: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      const response = await client.call('preview_plugin_install', { workspaceId, source, packageRef });
      setBusy(false);
      if (isErr(response.body)) {
        setFeedback({ tone: 'error', text: t(`plugin.error.${response.body.error}`) });
        return;
      }
      const preview = response.body as unknown as PreviewDto;
      const checked: Record<string, boolean> = {};
      for (const scope of preview.requested) checked[scope] = true;
      setReview({ preview, packageRef, source, checked });
    },
    [client, workspaceId, t],
  );

  const onFilePicked = useCallback(
    async (file: File | undefined) => {
      if (file === undefined) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFileText(file));
      } catch {
        setFeedback({ tone: 'error', text: t('plugin.error.invalid_manifest') });
        return;
      }
      await openReviewFromBundle(parsed, 'local');
    },
    [openReviewFromBundle, t],
  );

  const confirmInstall = useCallback(async () => {
    if (review === null || workspaceId === null) return;
    const grantedScopes = Object.entries(review.checked).filter(([, on]) => on).map(([scope]) => scope);
    setBusy(true);
    const response = await client.call('install_plugin', {
      workspaceId,
      source: review.source,
      packageRef: review.packageRef,
      grantedScopes,
      idempotencyKey: newIdempotencyKey(),
    });
    setBusy(false);
    if (isErr(response.body)) {
      setFeedback({ tone: 'error', text: t(`plugin.error.${response.body.error}`, { name: String(response.body.name ?? '') }) });
      return;
    }
    setReview(null);
    setFeedback({ tone: 'success', text: t('plugin.feedback.installed') });
    await load();
  }, [client, workspaceId, review, t, load]);

  // --- lifecycle writes ------------------------------------------------------------------------

  const runWrite = useCallback(
    async (action: string, pluginId: string, successKey: string) => {
      if (workspaceId === null) return;
      setBusy(true);
      const response = await client.call(action, { workspaceId, pluginId, idempotencyKey: newIdempotencyKey() });
      setBusy(false);
      if (isErr(response.body)) {
        setFeedback({ tone: 'error', text: t(`plugin.error.${response.body.error}`) });
        return;
      }
      setFeedback({ tone: 'success', text: t(successKey) });
      await load();
    },
    [client, workspaceId, t, load],
  );

  const onToggle = useCallback(
    (plugin: PluginDto) => {
      if (plugin.status === 'installed') void runWrite('disable_plugin', plugin.id, 'plugin.feedback.disabled');
      else void runWrite('enable_plugin', plugin.id, 'plugin.feedback.enabled');
    },
    [runWrite],
  );

  const onUninstall = useCallback(
    (plugin: PluginDto) => {
      if (!window.confirm(t('plugin.confirm.uninstall', { name: plugin.name }))) return;
      void runWrite('uninstall_plugin', plugin.id, 'plugin.feedback.uninstalled');
    },
    [runWrite, t],
  );

  // --- browse ----------------------------------------------------------------------------------

  const runSearch = useCallback(async () => {
    if (workspaceId === null) return;
    setBrowse({ kind: 'loading' });
    const response = await client.call('search_plugin_registry', { workspaceId, query });
    if (isErr(response.body)) {
      if (response.body.error === 'needs_registry') {
        setBrowse({ kind: 'needs_registry' });
      } else if (response.body.error === 'registry_unreachable') {
        setBrowse((prev) => ({ kind: 'unreachable', entries: prev.kind === 'ok' ? prev.entries : [] }));
        setFeedback({ tone: 'error', text: t('plugin.error.registry_unreachable') });
      } else {
        setBrowse({ kind: 'needs_registry' });
      }
      return;
    }
    const body = response.body as unknown as { entries: readonly RegistryEntryDto[] };
    setBrowse({ kind: 'ok', entries: body.entries, query });
  }, [client, workspaceId, query, t]);

  const clearSearch = useCallback(() => {
    setQuery('');
    setBrowse({ kind: 'idle' });
  }, []);

  // --- render ----------------------------------------------------------------------------------

  const compatReasonFor = useMemo(
    () => (plugin: PluginDto) => t('plugin.incompatible.reason', { range: plugin.compatRange, version: plugin.coreVersion }),
    [t],
  );

  if (workspaceId === null) {
    return <NoWorkspaceState body={t('plugin.lede')} />;
  }

  // The Installed tab's five states (loading / error / empty / list), rendered inside the Tabs panel.
  const installedPanel: ReactNode =
    installed.kind === 'loading' ? (
      <div className="extensions__grid">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </div>
    ) : installed.kind === 'error' ? (
      <ErrorBanner error={{ ok: false, error: installed.code }} context="read" message={t(`plugin.error.${installed.code}`)} onRetry={() => void load()} />
    ) : installed.plugins.length === 0 ? (
      <EmptyState title={t('plugin.empty')} action={canManage ? { label: t('plugin.action.install'), onClick: () => fileInputRef.current?.click() } : undefined} />
    ) : (
      <ul className="extensions__grid" aria-label={t('plugin.tab.installed')}>
        {installed.plugins.map((plugin) => (
          <li key={plugin.id} className="plugin-card">
            <div className="plugin-card__head">
              <h2 className="plugin-card__name">{plugin.name}</h2>
              {/* K-22: the shared Status (a drawn glyph plus the word), never ●/○/✕ dingbats. */}
              <Status kind={pluginStatusKind(plugin.status)} label={t(`plugin.status.${plugin.status}`)} className="plugin-card__status" />
            </div>
            <p className="plugin-card__meta">{t('plugin.card.version', { version: plugin.version })}</p>
            <p className="plugin-card__meta">{t('plugin.card.capabilities', { count: plugin.capabilityCount })}</p>
            <p className="plugin-card__meta">{t('plugin.card.grantedOf', { granted: plugin.granted.length, requested: plugin.requested.length })}</p>
            {plugin.status === 'incompatible' ? <p className="plugin-card__reason">{compatReasonFor(plugin)}</p> : null}
            <div className="plugin-card__actions">
              {plugin.status !== 'incompatible' ? (
                <button type="button" className="btn btn--secondary" disabled={!canManage || busy} onClick={() => onToggle(plugin)}>
                  {plugin.status === 'installed' ? t('plugin.action.disable') : t('plugin.action.enable')}
                </button>
              ) : null}
              {plugin.capabilities.some((c) => c.kind === 'studio_screen') && plugin.status === 'installed' ? (
                <button type="button" className="btn btn--secondary" onClick={() => setOpenScreen(plugin)}>
                  {t('plugin.action.viewScreen')}
                </button>
              ) : null}
              {/* K-08: the danger colour belongs to the confirmation, never to a resting card button. */}
              <button type="button" className="btn btn--secondary" disabled={!canManage || busy} onClick={() => onUninstall(plugin)}>
                {t('plugin.action.uninstall')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    );

  // The Browse tab: a submit-to-apply registry search (an explicit Search button fires a network
  // lookup), so the shared FilterBar (a live keystroke filter, no submit) does not fit; kept bespoke.
  const browsePanel: ReactNode = (
    <div className="extensions__browse">
      <div className="extensions__search">
        <label htmlFor={searchId} className="extensions__search-label">
          {t('plugin.registry.searchLabel')}
        </label>
        <input className="field" id={searchId} type="search" value={query} placeholder={t('plugin.registry.searchPlaceholder')} onChange={(e) => setQuery(e.target.value)} />
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void runSearch()}>
          {t('plugin.registry.search')}
        </button>
      </div>
      {browse.kind === 'loading' ? (
        <div className="extensions__grid">
          <Skeleton />
          <Skeleton />
        </div>
      ) : browse.kind === 'needs_registry' || browse.kind === 'idle' ? (
        <EmptyState title={t('plugin.registry.empty')} hint={t('plugin.registry.emptyHint')} action={canManage ? { label: t('plugin.action.install'), onClick: () => fileInputRef.current?.click() } : undefined} />
      ) : browse.kind === 'unreachable' && browse.entries.length === 0 ? (
        // K-35: a failed read with nothing cached is a read error with a retry, not an empty list.
        <ErrorBanner context="read" message={t('plugin.registry.unreachable')} onRetry={() => void runSearch()} />
      ) : (browse.kind === 'ok' && browse.entries.length === 0) ? (
        // K-33: no hit for a search offers the way back, never create.
        <EmptyState
          title={t('plugin.registry.no_results', { query: browse.query })}
          filtered={{ onClear: clearSearch, clearLabel: t('plugin.registry.clear') }}
        />
      ) : (
        <>
          {browse.kind === 'unreachable' ? <p className="extensions__stale" role="status">{t('plugin.registry.stale')}</p> : null}
          <ul className="extensions__grid" aria-label={t('plugin.tab.browse')}>
            {browse.entries.map((entry) => (
              <li key={entry.registryRef} className="plugin-card">
                <h2 className="plugin-card__name">{entry.name}</h2>
                <p className="plugin-card__meta">{entry.publisher}</p>
                <p className="plugin-card__meta">{entry.summary}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );

  // The one primary action (Install), pinned in the SurfaceHeader; the hidden file input it drives
  // rides alongside it. Capability-gated by disabling, matched by the lock note below.
  const installAction: ReactNode = (
    <>
      <button type="button" className="btn btn--primary" disabled={!canManage || busy} onClick={() => fileInputRef.current?.click()}>
        {t('plugin.action.install')}
      </button>
      {/* The visible button is the keyboard target; the hidden input stays out of the tab order so
          focus never lands on something invisible. */}
      <input
        ref={fileInputRef}
        tabIndex={-1}
        type="file"
        accept=".tillplugin,application/json"
        className="extensions__file"
        aria-label={t('plugin.action.install')}
        onChange={(e) => void onFilePicked(e.target.files?.[0] ?? undefined)}
      />
    </>
  );

  return (
    <section className="extensions" aria-labelledby={titleId}>
      <SurfaceHeader
        title={t('plugin.panel.title')}
        titleId={titleId}
        subtitle={t('plugin.lede')}
        help={<SurfaceHelp surface="Extensions" />}
        actions={installAction}
      />

      {!canManage ? <p className="lock-note">{t('plugin.needsPermission')}</p> : null}

      {feedback !== null ? (
        <p className={`extensions__feedback extensions__feedback--${feedback.tone}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>
          {feedback.text}
        </p>
      ) : null}

      <Tabs
        label={t('plugin.panel.title')}
        activeId={tab}
        onChange={(id) => setTab(id as Tab)}
        tabs={[
          { id: 'installed', label: t('plugin.tab.installed'), panel: installedPanel },
          { id: 'browse', label: t('plugin.tab.browse'), panel: browsePanel },
        ]}
      />

      <Modal
        open={review !== null}
        onClose={() => setReview(null)}
        title={t('plugin.review.title')}
        closeLabel={t('plugin.review.cancel')}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setReview(null)}>
              {t('plugin.review.cancel')}
            </button>
            <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void confirmInstall()}>
              {t('plugin.review.confirm')}
            </button>
          </>
        }
      >
        {review !== null ? (
          <>
            <p className="review__subtitle">{t('plugin.review.subtitle', { name: review.preview.name, version: review.preview.version })}</p>
            {!review.preview.compatible ? <p className="review__warning" role="alert">{t('plugin.review.compatWarning')}</p> : null}
            {review.preview.requested.length === 0 ? (
              <p className="review__none">{t('plugin.review.noScopes')}</p>
            ) : (
              <ul className="review__scopes">
                {review.preview.requested.map((scope) => (
                  <li key={scope}>
                    <label>
                      <input
                        type="checkbox"
                        checked={review.checked[scope] ?? false}
                        onChange={(e) => setReview((prev) => (prev === null ? prev : { ...prev, checked: { ...prev.checked, [scope]: e.target.checked } }))}
                      />
                      <code>{scope}</code>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}
      </Modal>

      <Modal
        open={openScreen !== null}
        onClose={() => setOpenScreen(null)}
        title={openScreen !== null ? t('plugin.screen.title', { name: openScreen.name }) : ''}
        closeLabel={t('plugin.review.cancel')}
      >
        {openScreen !== null ? (
          <>
            <p className="plugin-screen__note">{t('plugin.screen.sandboxNote')}</p>
            {/* The plugin's own screen, isolated: allow-scripts only, NEVER allow-same-origin, network
                fenced to the granted network:* scopes, postMessage-only. src is a blank placeholder in
                the OSS core (no runtime host serves a plugin URL); a host wires the real one. */}
            <iframe
              className="plugin-screen__frame"
              title={t('plugin.screen.title', { name: openScreen.name })}
              sandbox="allow-scripts"
              src="about:blank"
              data-connect-src={connectSrcFor(openScreen.granted)}
            />
          </>
        ) : null}
      </Modal>
    </section>
  );
}

export default Extensions;
