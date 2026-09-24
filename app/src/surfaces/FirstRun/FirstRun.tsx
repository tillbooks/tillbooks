/**
 * M00, the first-run flow (spec §6, surface 1): the resolver for the pre-workspace dead end.
 *
 * When `till up` runs against a home with no ledger, the Studio used to load into nothing an operator
 * could act on. This surface is the three DOORS the spec names, each a real decision, each naming the
 * MCP twin so an agent can drive the same first run:
 *
 *   1. CREATE a new ledger        -> A23 `create_workspace`
 *   2. RESTORE a backup           -> G04 `restore_backup` (pre-workspace, re-mints ids)
 *   3. ADOPT an existing database -> configuration (TILL_DB_PATH) + restart, NOT a verb: a path is
 *      deployment state, not tenant data, so adoption is config + restart and this door shows how.
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
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspace } from '../../app/workspace';
import { NAV_ITEMS } from '../../app/nav';
import { useT, formatDate } from '../../i18n';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { ErrorBanner, Skeleton } from '../../components/states';
import { RuntimeLine } from './RuntimeLine';
import './FirstRun.css';

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
  const [adoptPath, setAdoptPath] = useState('');
  const [busy, setBusy] = useState<null | 'create' | 'restore' | 'demo'>(null);
  const [error, setError] = useState<string | null>(null);
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
      const { mode } = resp.body as unknown as { mode?: string };
      if (typeof mode === 'string') setRuntimeMode(mode);
    });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const provisioned = existingCount > 0;
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
    return KNOWN_ERRORS.has(body.error)
      ? t(`firstrun.error.${body.error}`)
      : t('firstrun.error.generic', { code: body.error });
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

  return (
    <section className="firstrun" aria-labelledby="firstrun-title">
      <SurfaceHeader
        title={t('firstrun.title')}
        titleId="firstrun-title"
        help={<SurfaceHelp surface="FirstRun" />}
        actions={
          provisioned ? (
            <Link to={landing} className="btn btn--primary firstrun-overview-link">
              {t('firstrun.existing.overview')}
            </Link>
          ) : undefined
        }
      />
      <div className="firstrun-intro">
        {/* K-05: a placeholder line until the list has answered, never the premature sentence. */}
        {listSettled ? (
          <p className="firstrun-lead">
            {provisioned
              ? existingCount === 1
                ? t('firstrun.lead_existing_one')
                : t('firstrun.lead_existing_many', { count: existingCount })
              : t('firstrun.lead')}
          </p>
        ) : (
          <Skeleton rows={1} height={20} width="60%" />
        )}
        {/* M03 (V1, S1.2): the residency answer BEFORE the first door is pressed. One sentence of
            prose above the doors, below the title; the doors stay the visual centre and unchanged.
            The local-first claim is true only outside a cloud agent session, so it is dropped there and
            the RuntimeLine caveat at the foot answers residency instead. */}
        {!cloudSession && <p className="firstrun-residency">{t('journey.residency.lead')}</p>}
      </div>

      {/* A refused write names its remedy in the one shared banner (K-35), never a hand-drawn box. */}
      {error !== null && <ErrorBanner message={error} />}

      <div className="firstrun-doors">
        {/* Door 1: create. */}
        <article className="firstrun-door" aria-labelledby="door-create">
          <h2 id="door-create" className="firstrun-door-title">
            {provisioned ? t('firstrun.create.label_existing') : t('firstrun.create.label')}
          </h2>
          <p className="firstrun-door-hint">{t('firstrun.create.hint')}</p>
          <form onSubmit={onCreate}>
            <label className="firstrun-field">
              <span>{t('firstrun.create.name_label')}</span>
              <input
                type="text"
                className="field"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('firstrun.create.name_placeholder')}
                autoComplete="off"
              />
            </label>
            {/* K-08: one primary per surface. With books on this device the header's "Zur Übersicht"
                is it, and creating another ledger is a secondary door like the other two. */}
            <button
              type="submit"
              className={provisioned ? 'btn btn--secondary' : 'btn btn--primary'}
              disabled={busy !== null || name.trim() === ''}
            >
              {busy === 'create' ? t('firstrun.create.busy') : t('firstrun.create.action')}
            </button>
          </form>
        </article>

        {/* Door 2: restore. */}
        <article className="firstrun-door" aria-labelledby="door-restore">
          <h2 id="door-restore" className="firstrun-door-title">
            {t('firstrun.restore.label')}
          </h2>
          <p className="firstrun-door-hint">{t('firstrun.restore.hint')}</p>
          {/* F-06 (J7.2): the door names the generation it expects BEFORE the act. */}
          {expectedGeneration !== null && (
            <p className="firstrun-door-hint firstrun-generation">{t('firstrun.restore.expects', { generation: String(expectedGeneration) })}</p>
          )}
          <form onSubmit={onRestore}>
            {restorable !== null && restorable.length > 0 && (
              <fieldset className="firstrun-picklist">
                <legend>{t('firstrun.restore.pick_label', { count: String(restorable.length) })}</legend>
                {restorable.map((row) => (
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
                      {!row.compatible && (
                        <span className="firstrun-pick-note">{t('firstrun.restore.pick_incompatible', { generation: String(row.schemaVersion) })}</span>
                      )}
                    </span>
                  </label>
                ))}
                <label className="firstrun-pick">
                  <input
                    type="radio"
                    name="firstrun-restore-pick"
                    value=""
                    checked={otherPath}
                    disabled={busy !== null}
                    onChange={() => setOtherPath(true)}
                  />
                  <span className="firstrun-pick-text">{t('firstrun.restore.pick_other')}</span>
                </label>
              </fieldset>
            )}
            {(restorable === null || restorable.length === 0 || otherPath) && (
              <label className="firstrun-field">
                <span>{t('firstrun.restore.source_label')}</span>
                <input
                  type="text"
                  className="field"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder={t('firstrun.restore.source_placeholder')}
                  autoComplete="off"
                />
              </label>
            )}
            <label className="firstrun-field">
              <span>{t('firstrun.restore.name_label')}</span>
              <input
                type="text"
                className="field"
                value={restoreName}
                onChange={(e) => setRestoreName(e.target.value)}
                autoComplete="off"
              />
            </label>
            {verified !== null && (
              <p className="firstrun-door-hint firstrun-verified" role="status">
                {verified}
              </p>
            )}
            <button type="submit" className="btn btn--secondary" disabled={busy !== null || chosenSource === ''}>
              {busy === 'restore' ? t('firstrun.restore.busy') : t('firstrun.restore.action')}
            </button>
          </form>
        </article>

        {/* Door 3: adopt. Configuration, not a verb: show how, do not call anything. */}
        <article className="firstrun-door" aria-labelledby="door-adopt">
          <h2 id="door-adopt" className="firstrun-door-title">
            {t('firstrun.adopt.label')}
          </h2>
          <p className="firstrun-door-hint">{t('firstrun.adopt.hint')}</p>
          <label className="firstrun-field">
            <span>{t('firstrun.adopt.path_label')}</span>
            <input
              type="text"
              className="field"
              value={adoptPath}
              onChange={(e) => setAdoptPath(e.target.value)}
              placeholder={t('firstrun.adopt.path_placeholder')}
              autoComplete="off"
            />
          </label>
          <pre className="firstrun-adopt-cmd" aria-label={t('firstrun.adopt.cmd_label')}>
            TILL_DB_PATH={adoptPath.trim() === '' ? '/path/to/till.db' : adoptPath.trim()} till up
          </pre>
          <p className="firstrun-door-hint firstrun-door-foot">{t('firstrun.adopt.verb')}</p>
        </article>
      </div>

      {/* F-05: the demo door, a quiet line under the three doors while nothing is provisioned. Not a
          fourth door (the M03 doors are the three real decisions); a way to look first. */}
      {!provisioned && (
        <p className="firstrun-demo">
          <span>{t('firstrun.demo.lead')}</span>{' '}
          <button type="button" className="btn btn--ghost btn--sm" disabled={busy !== null} onClick={() => void onDemo()}>
            {busy === 'demo' ? t('firstrun.demo.busy') : t('firstrun.demo.action')}
          </button>
          <span className="firstrun-demo-hint">{t('firstrun.demo.hint')}</span>
        </p>
      )}

      <footer className="firstrun-foot">
        <RuntimeLine />
      </footer>
    </section>
  );
}

export default FirstRun;
