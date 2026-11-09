/**
 * M00, the first-run flow (spec §6, surface 1): the resolver for the pre-workspace dead end.
 *
 * When `till up` runs against a home with no ledger, the Studio used to load into nothing an operator
 * could act on. This surface is the three DOORS the spec names, each a real decision, each naming the
 * MCP twin so an agent can drive the same first run:
 *
 *   1. CREATE a new ledger        -> A23 `create_workspace`
 *   2. RESTORE a backup           -> G04 `restore_backup` (pre-workspace, re-mints ids)
 *   3. ADOPT an existing database -> the host door `POST /studio/adopt-book` + a restart, NOT a verb: a
 *      path is deployment state, not tenant data. D166 point 8 (owner, 14.10.2026): no terminal step.
 *      Inside TILL.app the native open panel picks the file (`tillPick`); a browser names its path.
 *      The host probes the file read-only, remembers it and restarts onto it; this surface then shows
 *      one calm "opening" state. TILL.app reloads its own window; a browser tab waits for the new
 *      process (`reloadAfterRestart`) and reloads, and its paired device signs it in again.
 *
 * Nothing is created silently: creation and restore are explicit button presses, and the process
 * stays up serving these same doors if the operator does nothing (US-M00.3 Empty). Refusals render
 * with their remedy (`not_a_till_database`, `schema_newer_than_runtime`), never a partial open.
 *
 * The runtime line rides at the foot so the operator sees the mode (and, in a cloud agent session,
 * the residency caveat) before they commit a ledger to it.
 *
 * F-06 (J7.2): the restore door LISTS what it can restore. `list_restorable_backups` reads the
 * bundles in this machine's backup directory (the support dir's `backups/`) with their date, schema
 * generation and entry count, and the door names the generation this install expects, so a person
 * picks a backup and reads its generation BEFORE the act instead of typing an absolute path and
 * finding out after. The typed path stays as the fallback (a bundle copied somewhere else). Either
 * way the act runs `verify_backup` first and names what it found, then `restore_backup`.
 *
 * K-14: the route stays reachable AFTER provisioning (a bookmark, a deep link), so it may not
 * claim "no ledger found" unconditionally. It lists workspaces on mount (the same cross-tenant read
 * the WorkspaceSwitcher runs); with at least one, the lead says how many Hauptbücher this device
 * already carries, the create door reframes to "another ledger", and a primary link leads back to
 * the Übersicht. With zero (or a failed read) the unprovisioned render stands.
 *
 * K-05 (D137): the lead never speaks before the list has answered. It used to render "kein Hauptbuch
 * gefunden" until the read landed, while the rail beside it listed two; now a placeholder line holds
 * its place until then. The page wears the shared SurfaceHeader (K-07), the "Agent: verb" lines are
 * gone (the palette footer is the one place a verb name appears), the door is no longer an
 * Einstellungen leaf (`nav.ts` OFF_RAIL), and on an empty ledger the Shell draws the rail as the inert
 * icon column, because every row of a full rail would lead into a workspace that does not exist yet.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspace } from '../../app/workspace';
import { NAV_ITEMS } from '../../app/nav';
import { useT, formatDate } from '../../i18n';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { IconButton } from '../../components/IconButton';
import { Field } from '../../components/Field';
import { Tooltip } from '../../components/Tooltip';
import { ErrorBanner, refusalText } from '../../components/states';
import { adoptBook, forgetAdoptedBook, hasNativeBookPicker, pickBookNatively, reloadAfterRestart, restartBaseline } from '../../lib/studio-key';
import { RuntimeLine } from './RuntimeLine';
import './FirstRun.css';

/** The adopt refusals that have their own sentence (`firstrun.adopt.error.<code>`); any other code
 *  reads the calm fallback, never the raw code. */
const ADOPT_ERRORS = new Set([
  'book_path_pinned',
  'book_path_not_absolute',
  'book_not_found',
  'book_unreadable',
  'not_a_till_database',
  'schema_newer_than_runtime',
  'book_already_open',
  'book_not_saved',
  'book_not_forgotten',
  'restart_unavailable',
]);

/** D187: how many bundles the restore door lists before "Alle zeigen". */
const BACKUPS_AT_REST = 3;

/** The adopted book `till up` could not open (`delivery_status.adoptedBookUnavailable`). */
interface AdoptedBookUnavailable {
  path: string;
  reason: 'missing' | 'unopenable';
}

function asUnavailable(value: unknown): AdoptedBookUnavailable | null {
  const v = value as { path?: unknown; reason?: unknown } | null | undefined;
  if (v === null || v === undefined || typeof v.path !== 'string') return null;
  return { path: v.path, reason: v.reason === 'missing' ? 'missing' : 'unopenable' };
}

/** The last segment of a path, for showing the picked file by its name. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}

/** One bundle the machine can see (the `list_restorable_backups` row), parsed off the open Result. */
interface RestorableRow {
  source: string;
  createdAt: string;
  schemaVersion: number;
  entryCount: number;
  compatible: boolean;
}

function asRestorable(body: unknown): { rows: RestorableRow[]; expected: number | null } {
  const b = body as { backups?: unknown; currentSchemaVersion?: unknown };
  const rows = Array.isArray(b.backups)
    ? b.backups.filter(
        (r): r is RestorableRow =>
          typeof r === 'object' && r !== null && typeof (r as RestorableRow).source === 'string' && typeof (r as RestorableRow).schemaVersion === 'number',
      )
    : [];
  return { rows, expected: typeof b.currentSchemaVersion === 'number' ? b.currentSchemaVersion : null };
}

/** A tiny idempotency key per submit, so a double-click never mints two ledgers. */
function newKey(prefix: string): string {
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now());
  return `${prefix}-${rand}`;
}

export function FirstRun() {
  const t = useT();
  const client = useClient();
  const { setWorkspaceId } = useWorkspace();
  const navigate = useNavigate();

  const [name, setName] = useState('');
  const [source, setSource] = useState('');
  const [restoreName, setRestoreName] = useState('');
  /** F-06: the bundles this machine can see, null until the read lands (or when it failed: the
   *  typed path is then the whole door, exactly as before). */
  const [restorable, setRestorable] = useState<RestorableRow[] | null>(null);
  const [expectedGeneration, setExpectedGeneration] = useState<number | null>(null);
  /** The bundle picked from the list (its source path), or null when the typed path is in use. */
  const [picked, setPicked] = useState<string | null>(null);
  /** What verify_backup found on the chosen source, named before the restore writes. */
  const [verified, setVerified] = useState<string | null>(null);
  const [otherPath, setOtherPath] = useState(false);
  /** The book to adopt: the path typed in a browser, or the file TILL.app's open panel returned. */
  const [adoptPath, setAdoptPath] = useState('');
  /** D166 point 8: inside TILL.app the door offers the native open panel instead of a path field. */
  const [nativePicker] = useState(() => hasNativeBookPicker());
  /** Set once the host accepted the book (or forgot it) and restarts: the whole surface says so, calmly. */
  const [opening, setOpening] = useState<null | 'adopt' | 'forget'>(null);
  /** D166 point 8 (critic F1/F2): the adopted book this `till up` could not open, from delivery_status. */
  const [unavailable, setUnavailable] = useState<AdoptedBookUnavailable | null>(null);
  /** D187: the restore list shows a few rows until the person asks for all of them. */
  const [allBackups, setAllBackups] = useState(false);
  /** D187: which rarer door is open beneath the icon row, if any. One at a time. */
  const [alt, setAlt] = useState<null | 'restore' | 'adopt'>(null);
  /** On the "not reachable" page: the person asked to choose another book (the adopt form shows). */
  const [choosingOther, setChoosingOther] = useState(false);
  /** On the "not reachable" page: "Vergessen und neu beginnen" waits for its confirmation. */
  const [confirmForget, setConfirmForget] = useState(false);
  /** Stops a browser tab's wait for the restarted host if this surface goes away first. */
  const waitAbort = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    waitAbort.current = controller;
    return () => controller.abort();
  }, []);
  const [busy, setBusy] = useState<null | 'create' | 'restore' | 'demo' | 'pick' | 'adopt' | 'forget'>(null);
  const [error, setError] = useState<string | null>(null);
  const [portalNotice, setPortalNotice] = useState<string | null>(null);
  /** K-14: how many workspaces this device already carries. Zero until the list read lands; a
   *  failed read stays zero on purpose, because the unprovisioned render is the honest fallback. */
  const [existingCount, setExistingCount] = useState(0);
  /** K-05: whether the list read has answered (or failed). Until then the lead is a placeholder. */
  const [listSettled, setListSettled] = useState(false);
  /** M03: the runtime mode, read the same way RuntimeLine reads it (delivery_status.mode). Null until
   *  the read lands. The local-residency lead ("a single file on this device, nothing is sent") is
   *  FALSE in a cloud agent session, so it is suppressed once we KNOW mode is `agent_session`; the
   *  RuntimeLine caveat at the foot carries the residency truth in that mode. Any other mode, or an
   *  unresolved/failed read, keeps the local lead (the honest fallback for a local-first process). */
  const [runtimeMode, setRuntimeMode] = useState<string | null>(null);

  const landing = NAV_ITEMS[0]?.path ?? '/';

  useEffect(() => {
    let cancelled = false;
    void client.call('list_workspaces', {}).then((resp) => {
      if (cancelled) return;
      setListSettled(true);
      if (isErr(resp.body)) return;
      const { workspaces } = resp.body as unknown as { workspaces?: unknown[] };
      if (Array.isArray(workspaces)) setExistingCount(workspaces.length);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void client.call('list_restorable_backups', {}).then((resp) => {
      if (cancelled || isErr(resp.body)) return;
      const { rows, expected } = asRestorable(resp.body);
      setRestorable(rows);
      setExpectedGeneration(expected);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    let cancelled = false;
    void client.call('delivery_status', {}).then((resp) => {
      if (cancelled || isErr(resp.body)) return;
      const { mode, adoptedBookUnavailable } = resp.body as unknown as { mode?: string; adoptedBookUnavailable?: unknown };
      if (typeof mode === 'string') setRuntimeMode(mode);
      setUnavailable(asUnavailable(adoptedBookUnavailable));
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const provisioned = existingCount > 0;
  /** D187: the bundles this install can take first, newest first within each, a few until "Alle zeigen". */
  const orderedBackups = [...(restorable ?? [])].sort(
    (a, b) => Number(b.compatible) - Number(a.compatible) || b.createdAt.localeCompare(a.createdAt),
  );
  const shownBackups = allBackups ? orderedBackups : orderedBackups.slice(0, BACKUPS_AT_REST);
  const hiddenBackups = orderedBackups.length - shownBackups.length;
  const incompatibleGenerations = [...new Set(shownBackups.filter((r) => !r.compatible).map((r) => r.schemaVersion))];
  /** One primary on the page (K-08): the header's "Zur Übersicht" once books exist, else the open door's
   *  act while a door is open, else "Anlegen". */
  const mainPrimary = !provisioned && alt === null;
  const altPrimary = !provisioned && unavailable === null;
  /** True only once we KNOW this is a cloud agent session. Null (unresolved/failed) reads as local. */
  const cloudSession = runtimeMode === 'agent_session';

  /** Map a known engine error code to its localised remedy; any other code uses the generic line
   *  (never look up an unknown key: a missing-translation lookup logs, which tests treat as failure). */
  const KNOWN_ERRORS = new Set(['not_a_till_database', 'schema_newer_than_runtime']);
  const errorText = (body: Err): string => {
    // S7.3: the restore refusal names BOTH generations from the refusal payload (verify_backup
    // sends artifactSchemaVersion + currentSchemaVersion) and the install-current-release remedy,
    // never the raw code.
    if (body.error === 'incompatible_schema_version') {
      return t('firstrun.error.incompatible_schema_version', {
        backup: String(body.artifactSchemaVersion ?? '?'),
        runtime: String(body.currentSchemaVersion ?? '?'),
      });
    }
    // A refusal after the action had written (a restore or a demo saved, then the book moved on to a
    // newer TILL, critic R4-1) must not say "the file was not changed, try again": `refusalText` gives
    // the shared sentence that says what was saved, and never invites a repeat that would do it twice.
    return refusalText(t, body, {
      own: 'firstrun.error',
      known: KNOWN_ERRORS,
      fallback: 'firstrun.error.generic',
      fallbackParams: { code: body.error },
    });
  };

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === '' || busy !== null) return;
    setBusy('create');
    setError(null);
    const response = await client.call('create_workspace', { name: name.trim(), idempotencyKey: newKey('create') });
    setBusy(null);
    if (isErr(response.body)) {
      setError(errorText(response.body));
      return;
    }
    const id = (response.body as { workspaceId?: string }).workspaceId;
    if (typeof id === 'string') {
      setWorkspaceId(id);
      navigate(landing, { replace: true });
    }
  }

  /** The source the act runs on: the picked bundle, else the typed path. */
  const chosenSource = picked !== null && !otherPath ? picked : source.trim();

  async function onRestore(e: React.FormEvent) {
    e.preventDefault();
    if (chosenSource === '' || busy !== null) return;
    setBusy('restore');
    setError(null);
    setVerified(null);
    // verify_backup FIRST (J7.2 ideal step 1): the generation and the entry count are named before
    // anything is written, and a bundle this runtime cannot take is refused here with its remedy
    // rather than after a restore attempt.
    const check = await client.call('verify_backup', { source: chosenSource });
    if (isErr(check.body)) {
      setBusy(null);
      setError(errorText(check.body));
      return;
    }
    const v = check.body as unknown as { schemaVersion?: unknown; entryCount?: unknown; format?: unknown; balanceOk?: unknown };
    if (v.format !== 'sqlite_snapshot') {
      setBusy(null);
      setError(t('firstrun.error.unrestorable_format'));
      return;
    }
    // Critic F4 (2026-09-05): `verifyBackup` answers `ok` with `balanceOk: false` on an unbalanced
    // snapshot. The "ausgeglichen" sentence below claims balance, so it is only rendered once the
    // engine has said so; an unbalanced bundle stops here with the honest sentence (the DataBackup
    // panel's twin), before the act, instead of claiming balance and then meeting the restore's own
    // invariant refusal.
    if (v.balanceOk === false) {
      setBusy(null);
      setError(
        t('firstrun.error.unbalanced', {
          generation: String(typeof v.schemaVersion === 'number' ? v.schemaVersion : '?'),
          entries: String(typeof v.entryCount === 'number' ? v.entryCount : 0),
        }),
      );
      return;
    }
    setVerified(
      t('firstrun.restore.verified', {
        generation: String(typeof v.schemaVersion === 'number' ? v.schemaVersion : '?'),
        entries: String(typeof v.entryCount === 'number' ? v.entryCount : 0),
      }),
    );
    // The engine REQUIRES newWorkspaceName (portability.ts refuses an empty one with a raw
    // invalid_input), so the "(optional)" label is kept honest by supplying a sensible default:
    // an empty field restores under the localised default name instead of refusing.
    const response = await client.call('restore_backup', {
      source: chosenSource,
      newWorkspaceName: restoreName.trim() === '' ? t('firstrun.restore.name_default') : restoreName.trim(),
      confirmed: true,
      idempotencyKey: newKey('restore'),
    });
    setBusy(null);
    if (isErr(response.body)) {
      setError(errorText(response.body));
      return;
    }
    const id = (response.body as { workspaceId?: string }).workspaceId;
    if (typeof id === 'string') {
      setWorkspaceId(id);
      // D161.2 (critic F2): restored portal links wait for a new hand-over. Say so before leaving,
      // so nobody learns it from a customer whose link stopped working.
      const waiting = (response.body as { portalLinksAwaitingHandover?: number }).portalLinksAwaitingHandover ?? 0;
      if (waiting > 0) {
        setPortalNotice(t(`data.restore.portalLinks.${waiting === 1 ? 'one' : 'other'}`, { count: String(waiting) }));
        return;
      }
      navigate(landing, { replace: true });
    }
  }

  /** F-05 (J1.3 step 1): the demo door on the landing. The same verb the Erste Schritte door calls;
   *  the minted demo workspace is adopted and the home renders it under the shared demo banner. */
  async function onDemo(): Promise<void> {
    if (busy !== null) return;
    setBusy('demo');
    setError(null);
    const response = await client.call('create_demo_workspace', { idempotencyKey: newKey('demo') });
    setBusy(null);
    if (isErr(response.body)) {
      setError(errorText(response.body));
      return;
    }
    const id = (response.body as { workspaceId?: string }).workspaceId;
    if (typeof id === 'string') {
      setWorkspaceId(id);
      navigate(landing, { replace: true });
    }
  }

  /** TILL.app: the native open panel. A cancel keeps whatever was picked before. */
  async function onPick(): Promise<void> {
    if (busy !== null) return;
    setBusy('pick');
    setError(null);
    const chosen = await pickBookNatively();
    setBusy(null);
    if (chosen !== null) setAdoptPath(chosen);
  }

  /**
   * D166 point 8: hand the host a book (adopt) or tell it to forget the adopted one, then show the
   * calm restart state. The host restarts onto the result; nothing else is called.
   */
  async function hostChoice(kind: 'adopt' | 'forget', path: string): Promise<void> {
    if (busy !== null) return;
    setBusy(kind);
    setError(null);
    // A browser tab must tell the restarted host from the old one: take the "before" proof first.
    const before = nativePicker ? null : await restartBaseline();
    const outcome = kind === 'adopt' ? await adoptBook(path) : await forgetAdoptedBook();
    setBusy(null);
    if (!outcome.ok) {
      setError(refusalText(t, outcome.error, { own: 'firstrun.adopt.error', known: ADOPT_ERRORS, fallback: 'firstrun.adopt.error.fallback' }));
      return;
    }
    setOpening(kind);
    // TILL.app restarts the server and reloads this window itself; a browser tab waits and reloads.
    if (before !== null) void reloadAfterRestart(window, { ...before, signal: waitAbort.current.signal });
  }

  function onAdopt(e: React.FormEvent): void {
    e.preventDefault();
    const path = adoptPath.trim();
    if (path === '') return;
    void hostChoice('adopt', path);
  }

  if (opening !== null) {
    return (
      <section className="firstrun firstrun-opening" aria-labelledby="firstrun-opening-title">
        <h1 id="firstrun-opening-title" className="firstrun-opening-title">
          {t(opening === 'adopt' ? 'firstrun.adopt.opening_title' : 'firstrun.unavailable.forgetting_title')}
        </h1>
        <p className="firstrun-lead">{t('firstrun.adopt.opening_body')}</p>
        {opening === 'adopt' && <p className="firstrun-lead">{t('firstrun.adopt.opening_agents')}</p>}
      </section>
    );
  }

  /** The adopt form: TILL.app's native picker, or a path field in a browser, then one action. The how-to
   *  (the Finder hint, the file never moves) is words on demand behind the (i) (D187). */
  const adoptForm = (
    <form className="firstrun-adopt-form" onSubmit={onAdopt}>
      {nativePicker ? (
        <div className="firstrun-pickline">
          <button type="button" className="btn btn--secondary firstrun-adopt-pick" disabled={busy !== null} onClick={() => void onPick()}>
            {t('firstrun.adopt.pick')}
          </button>
          <p className="firstrun-adopt-file" aria-live="polite">
            {adoptPath === '' ? null : t('firstrun.adopt.picked', { name: fileName(adoptPath) })}
          </p>
        </div>
      ) : (
        <div className="firstrun-combo">
          <input
            type="text"
            className="firstrun-combo-input"
            value={adoptPath}
            onChange={(e) => setAdoptPath(e.target.value)}
            placeholder={t('firstrun.adopt.path_placeholder')}
            aria-label={t('firstrun.adopt.path_label')}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className={`btn ${altPrimary ? 'btn--primary' : 'btn--secondary'}`} disabled={busy !== null || adoptPath.trim() === ''}>
            {busy === 'adopt' ? t('firstrun.adopt.busy') : t('firstrun.adopt.action')}
          </button>
        </div>
      )}
      <div className="firstrun-panel-foot">
        {nativePicker && (
          <button type="submit" className={`btn ${altPrimary ? 'btn--primary' : 'btn--secondary'}`} disabled={busy !== null || adoptPath.trim() === ''}>
            {busy === 'adopt' ? t('firstrun.adopt.busy') : t('firstrun.adopt.action')}
          </button>
        )}
        <IconButton icon="info" small context={nativePicker ? t('firstrun.adopt.hint') : `${t('firstrun.adopt.hint')} ${t('firstrun.adopt.path_hint')}`} />
      </div>
    </form>
  );

  // D166 point 8 (critic F1/F2): the adopted book is not reachable. TILL opened nothing in its place
  // and writes nowhere; the person decides here, without a terminal.
  if (unavailable !== null) {
    return (
      <section className="firstrun firstrun-unavailable" aria-labelledby="firstrun-unavailable-title">
        <SurfaceHeader title={t('firstrun.unavailable.title')} titleId="firstrun-unavailable-title" help={<SurfaceHelp surface="FirstRun" />} />
        <div className="firstrun-intro">
          <p className="firstrun-lead">
            {t(unavailable.reason === 'missing' ? 'firstrun.unavailable.missing' : 'firstrun.unavailable.unopenable', { path: unavailable.path })}
          </p>
          <p className="firstrun-lead">{t('firstrun.unavailable.nothing_written')}</p>
        </div>
        {error !== null && <ErrorBanner message={error} />}
        <div className="firstrun-unavailable-actions">
          <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => void hostChoice('adopt', unavailable.path)}>
            {busy === 'adopt' && !choosingOther ? t('firstrun.adopt.busy') : t('firstrun.unavailable.retry')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            aria-expanded={choosingOther}
            disabled={busy !== null}
            onClick={() => {
              setChoosingOther((v) => !v);
              setConfirmForget(false);
            }}
          >
            {t('firstrun.unavailable.choose_other')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            aria-expanded={confirmForget}
            disabled={busy !== null}
            onClick={() => {
              setConfirmForget((v) => !v);
              setChoosingOther(false);
            }}
          >
            {t('firstrun.unavailable.forget')}
          </button>
        </div>
        {choosingOther && <div className="firstrun-door firstrun-unavailable-panel">{adoptForm}</div>}
        {confirmForget && (
          <div className="firstrun-door firstrun-unavailable-panel" role="group" aria-labelledby="firstrun-forget-confirm">
            <p id="firstrun-forget-confirm" className="firstrun-door-hint">
              {t('firstrun.unavailable.forget_confirm', { path: unavailable.path })}
            </p>
            <div className="firstrun-unavailable-actions">
              <button type="button" className="btn btn--secondary" disabled={busy !== null} onClick={() => void hostChoice('forget', '')}>
                {busy === 'forget' ? t('firstrun.adopt.busy') : t('firstrun.unavailable.forget_yes')}
              </button>
              <button type="button" className="btn btn--ghost" disabled={busy !== null} onClick={() => setConfirmForget(false)}>
                {t('firstrun.unavailable.forget_no')}
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  /** What TILL found and what stays on this device: words on demand behind the title's (i) (D187). K-05:
   *  nothing about the device is claimed before the list read has answered. M03: the local-first sentence
   *  is dropped in a cloud agent session, where the runtime line at the foot carries residency. */
  const info = [
    listSettled
      ? provisioned
        ? existingCount === 1
          ? t('firstrun.lead_existing_one')
          : t('firstrun.lead_existing_many', { count: existingCount })
        : t('firstrun.lead')
      : null,
    t('firstrun.create.hint'),
    cloudSession ? null : t('journey.residency.lead'),
  ]
    .filter((line): line is string => line !== null)
    .join(' ');

  const toggle = (which: 'restore' | 'adopt'): void => {
    setAlt((current) => (current === which ? null : which));
    setError(null);
  };

  return (
    <section className="firstrun" aria-labelledby="firstrun-title">
      <SurfaceHeader
        title={provisioned ? t('firstrun.create.label_existing') : t('firstrun.title')}
        titleId="firstrun-title"
        help={<IconButton icon="info" small context={info} />}
        actions={
          provisioned ? (
            <Link to={landing} className="btn btn--primary firstrun-overview-link">
              {t('firstrun.existing.overview')}
            </Link>
          ) : undefined
        }
      />

      {/* A refused write names its remedy in the one shared banner (K-35), never a hand-drawn box. */}
      {error !== null && <ErrorBanner message={error} />}
      {portalNotice !== null && (
        <div className="firstrun-restore-notice" role="status">
          <p>{portalNotice}</p>
          <button type="button" className="btn btn--primary" onClick={() => navigate(landing, { replace: true })}>
            {t('data.restore.continue')}
          </button>
        </div>
      )}

      {/* The one main act: a name and "Anlegen" (D187). K-08: with books on this device the header's
          "Zur Übersicht" is the primary, and while a door below is open its own act is. */}
      <form className="firstrun-create" onSubmit={onCreate}>
        <div className="firstrun-combo firstrun-combo--main">
          <input
            type="text"
            className="firstrun-combo-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('firstrun.create.name_placeholder')}
            aria-label={t('firstrun.create.name_label')}
            autoComplete="off"
          />
          <button type="submit" className={`btn ${mainPrimary ? 'btn--primary' : 'btn--secondary'}`} disabled={busy !== null || name.trim() === ''}>
            {busy === 'create' ? t('firstrun.create.busy') : t('firstrun.create.action')}
          </button>
        </div>
      </form>

      {/* The rarer doors as icons, each named on hover, each opening its form in place beneath. */}
      <div className="firstrun-alts">
        <IconButton
          icon="restore"
          size={20}
          name={t('firstrun.restore.label')}
          context={t('firstrun.restore.context')}
          aria-expanded={alt === 'restore'}
          aria-controls="firstrun-restore"
          className={alt === 'restore' ? 'is-on' : undefined}
          onClick={() => toggle('restore')}
        />
        <IconButton
          icon="folder"
          size={20}
          name={t('firstrun.adopt.label')}
          context={t('firstrun.adopt.context')}
          aria-expanded={alt === 'adopt'}
          aria-controls="firstrun-adopt"
          className={alt === 'adopt' ? 'is-on' : undefined}
          onClick={() => toggle('adopt')}
        />
        {/* F-05: a way to look first while nothing is provisioned; not a door of its own. */}
        {!provisioned && (
          <>
            <span className="firstrun-alts-sep" aria-hidden="true" />
            <Tooltip content={<span className="tooltip-context">{t('firstrun.demo.hint')}</span>}>
              <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => void onDemo()}>
                {busy === 'demo' ? t('firstrun.demo.busy') : t('firstrun.demo.action')}
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {alt === 'restore' && (
        <section id="firstrun-restore" className="firstrun-panel" aria-label={t('firstrun.restore.label')}>
          <form className="form-stack" onSubmit={onRestore}>
            {restorable !== null && restorable.length > 0 && (
              <fieldset className="firstrun-picklist">
                <legend className="visually-hidden">{t('firstrun.restore.pick_label', { count: String(restorable.length) })}</legend>
                {/* D187: the ones this install can take first, then at most a few rows until "Alle zeigen";
                    a bundle from another generation stays named and disabled, never hidden, and why it
                    does not fit is one (i) under the list instead of a sentence on every row. */}
                {shownBackups.map((row) => (
                  <label key={row.source} className={`firstrun-pick${row.compatible ? '' : ' firstrun-pick--incompatible'}`}>
                    <input
                      type="radio"
                      name="firstrun-restore-pick"
                      value={row.source}
                      checked={picked === row.source && !otherPath}
                      disabled={!row.compatible || busy !== null}
                      onChange={() => {
                        setPicked(row.source);
                        setOtherPath(false);
                      }}
                    />
                    <span className="firstrun-pick-text">
                      <span className="firstrun-pick-main">
                        {t('firstrun.restore.pick_row', {
                          date: row.createdAt === '' ? '' : formatDate(row.createdAt),
                          generation: String(row.schemaVersion),
                          entries: String(row.entryCount),
                        })}
                      </span>
                    </span>
                  </label>
                ))}
                <label className="firstrun-pick">
                  <input type="radio" name="firstrun-restore-pick" value="" checked={otherPath} disabled={busy !== null} onChange={() => setOtherPath(true)} />
                  <span className="firstrun-pick-text">{t('firstrun.restore.pick_other')}</span>
                </label>
                <div className="firstrun-picklist-foot">
                  {hiddenBackups > 0 && (
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setAllBackups(true)}>
                      {t('firstrun.restore.pick_more', { count: String(restorable.length) })}
                    </button>
                  )}
                  {incompatibleGenerations.length > 0 && (
                    <span className="firstrun-pick-note">
                      {t('firstrun.restore.pick_incompatible_short')}
                      <IconButton icon="info" small context={t('firstrun.restore.pick_incompatible', { generation: incompatibleGenerations.join(', ') })} />
                    </span>
                  )}
                </div>
              </fieldset>
            )}
            {(restorable === null || restorable.length === 0 || otherPath) && (
              <Field label={t('firstrun.restore.source_label')}>
                <input
                  type="text"
                  className="field"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder={t('firstrun.restore.source_placeholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            )}
            <Field label={t('firstrun.restore.name_label')}>
              <input type="text" className="field" value={restoreName} onChange={(e) => setRestoreName(e.target.value)} placeholder={t('firstrun.restore.name_default')} autoComplete="off" />
            </Field>
            {verified !== null && (
              <p className="status-line status-ok" role="status">
                {verified}
              </p>
            )}
            <div className="form-actions">
              <button type="submit" className={`btn ${altPrimary ? 'btn--primary' : 'btn--secondary'}`} disabled={busy !== null || chosenSource === ''}>
                {busy === 'restore' ? t('firstrun.restore.busy') : t('firstrun.restore.action')}
              </button>
              {/* F-06 (J7.2): the generation this install expects is named BEFORE the act, on demand. */}
              <IconButton
                icon="info"
                small
                context={
                  expectedGeneration === null
                    ? t('firstrun.restore.hint')
                    : `${t('firstrun.restore.hint')} ${t('firstrun.restore.expects', { generation: String(expectedGeneration) })}`
                }
              />
            </div>
          </form>
        </section>
      )}

      {/* Door 3: adopt (D166 point 8). The host probes the file read-only, remembers it and restarts
          onto it: no terminal, no command to copy. */}
      {alt === 'adopt' && (
        <section id="firstrun-adopt" className="firstrun-panel" aria-label={t('firstrun.adopt.label')}>
          {adoptForm}
        </section>
      )}

      <footer className="firstrun-foot">
        <RuntimeLine />
      </footer>
    </section>
  );
}

export default FirstRun;
