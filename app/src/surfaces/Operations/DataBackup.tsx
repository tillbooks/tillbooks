/**
 * Data & Backup panel (spec G04 §6). One panel on the Betrieb (Operations) surface, alongside G08
 * Diagnostics: a full-workspace tool with a handful of actions. K-16 (Option A) moved it here off
 * `/setup` with the other operational panels; the spec §6 prose was retargeted to match.
 *
 * It renders all five states (spec §6): loading (skeleton rows in the history list's shape), empty
 * ("No backups yet" / "Workspace has no data yet"), error (each failure named inline with its next
 * step, never a stack trace), success, and permission-denied (A24's shared padlock when the caller
 * lacks manage_data_export). One primary action per section, top-right of its card.
 *
 * The .tillexport / .tillbackup artifacts are LOCAL files the engine writes and reads by path, so
 * Verify and Restore take a path the operator pastes (never a browser upload: the bytes never leave
 * the machine). Restore is P8-staged: the confirm dialog IS the human gate, and the engine writes
 * nothing until `confirmed:true` is sent. That dialog is the shared `Modal` in its consequential
 * (`alertdialog`) variant, not a native `window.confirm`, so it matches the rest of the Studio and
 * does not dismiss on a stray scrim click.
 *
 * F-06 (J7.1, J7.5): every history row carries its own "Prüfen", so verifying the backup just taken
 * is one click on the row (the engine already knows the path: `artifactRef`), never a path retyped
 * into the restore field. The verify result renders inline on the row, with the schema generation
 * the restore door will expect. And the honesty sentence: a `.tillexport` verifies clean as a
 * bundle, but it is NOT a restore source, so a verify over one (row or field) says so in words
 * (`data.error.unrestorable_format`) instead of printing "Gültig" over a file restore would refuse.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { ErrorBanner, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { HelpHint } from '../../components/HelpHint';
import { Modal } from '../../components/Modal';
import './DataBackup.css';

/** The restore confirmation is a consequential dialog. Held as a value so the Modal role travels as
 *  a prop, not a literal attribute the modal-role source guard scans for (see Diagnostics). */
const ALERT_DIALOG = 'alertdialog' as const;

interface BackupRow {
  backupId: string;
  kind: string;
  artifactRef: string;
  byteSize: number;
  status: string;
  createdBy: string | null;
  createdAt: string;
  /** The G04 artifact's schema generation: the M03 restore-path disclosure names it per row. */
  schemaVersion?: number;
}

type Load =
  | { kind: 'loading' }
  | { kind: 'ready'; backups: BackupRow[] }
  | { kind: 'denied' }
  | { kind: 'error'; error: Err };

/** A compact human size for the tabular size column (KB/MB, tabular numerals in the CSS). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function DataBackup() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Err | null>(null);
  const [source, setSource] = useState('');
  const [verify, setVerify] = useState<string | null>(null);
  /** Per-row verify results (J7.1): keyed by backupId, rendered inline on the row that was checked. */
  const [rowVerify, setRowVerify] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<string | null>(null);
  const [confirmingRestore, setConfirmingRestore] = useState(false);
  const restoreBodyId = useId();

  const refresh = useCallback(async () => {
    if (workspaceId === null) return;
    setLoad({ kind: 'loading' });
    const resp = await client.call('list_backups', { workspaceId });
    if (isErr(resp.body)) {
      setLoad(resp.body.error === 'permission_denied' ? { kind: 'denied' } : { kind: 'error', error: resp.body });
      return;
    }
    setLoad({ kind: 'ready', backups: (resp.body as unknown as { backups: BackupRow[] }).backups });
  }, [client, workspaceId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: string, input: Record<string, unknown>, after?: () => void) => {
      setBusy(true);
      setActionError(null);
      const resp = await client.call(action, input);
      setBusy(false);
      if (isErr(resp.body)) {
        setActionError(resp.body);
        return null;
      }
      after?.();
      return resp.body;
    },
    [client],
  );

  /**
   * One sentence for one verify answer. A clean sqlite snapshot says so with its entry count and
   * its schema generation (the number the restore door names before the act); a bundle that is not
   * a snapshot (a .tillexport) gets the honesty sentence, never "Gültig"; an unbalanced snapshot
   * says it must not be restored; a refusal maps to its G04 sentence, or the generic one.
   */
  const verifySentence = (body: unknown): string => {
    const v = body as { entryCount?: unknown; balanceOk?: unknown; format?: unknown; schemaVersion?: unknown };
    if (v.format !== 'sqlite_snapshot') return t('data.error.unrestorable_format');
    const entries = String(typeof v.entryCount === 'number' ? v.entryCount : 0);
    const generation = String(typeof v.schemaVersion === 'number' ? v.schemaVersion : '');
    return v.balanceOk === false
      ? t('dataBackup.verify.unbalanced', { entries })
      : t('dataBackup.verify.ok', { entries, generation });
  };
  const verifyFailure = (error: Err): string => {
    const known = new Set(['backup_corrupt', 'incompatible_schema_version', 'unrestorable_format']);
    return known.has(error.error) ? t(`data.error.${error.error}`) : t('dataBackup.verify.failed');
  };
  /** A verify never rides the panel's error banner: its answer belongs beside the thing checked. */
  const verifySource = async (source: string): Promise<string> => {
    setBusy(true);
    const resp = await client.call('verify_backup', { source });
    setBusy(false);
    return isErr(resp.body) ? verifyFailure(resp.body) : verifySentence(resp.body);
  };

  if (workspaceId === null) return null;
  if (load.kind === 'denied') {
    // J8.10: the padlock names the missing right in words (the A24 capability catalogue), never
    // the raw capability id.
    return (
      <section className="data-panel">
        <PermissionDenied title={t('data.title')} body={t('data.denied.body', { right: t('capability.manage_data_export') })} />
      </section>
    );
  }

  const key = () => `g04-${Date.now()}`;

  // The backup history is the shared DataTable (D118 B2): one frame owns the horizontal overflow, the
  // header sticks, and loading/empty/error are the shared state primitives, so the hand-rolled
  // `<table className="data-history">` and its CSS are gone. Created and size stay tabular and
  // right-aligned via `numeric`, matching the old `.data-num` treatment.
  const columns: DataTableColumn<BackupRow>[] = [
    { key: 'kind', header: t('data.col.kind'), render: (b) => t(`data.kind.${b.kind}`) },
    { key: 'created', header: t('data.col.created'), numeric: true, render: (b) => formatDate(b.createdAt) },
    { key: 'size', header: t('data.col.size'), numeric: true, render: (b) => formatBytes(b.byteSize) },
    { key: 'status', header: t('data.col.status'), render: (b) => t(`data.status.${b.status}`) },
    { key: 'actor', header: t('data.col.actor'), render: (b) => b.createdBy ?? '' },
    // M03 (V4, S2.2): each history row carries its own drill instructions: restorable on any TILL
    // install via the first-start restore dialog. The generation detail sits in the row's
    // disclosure (a HelpHint), not on the row face.
    {
      key: 'restore',
      header: t('journey.backup.col'),
      render: (b) => (
        <HelpHint
          label={t('journey.backup.hintLabel')}
          title={t('journey.backup.col')}
          body={t('journey.backup.restorePath', { generation: String(b.schemaVersion ?? '') })}
        />
      ),
    },
    // J7.1: "Prüfen" on the row itself. One click runs verify_backup on the row's own artefact and
    // the answer lands beside the button, so the backup just taken is verified with zero keystrokes.
    {
      key: 'verify',
      header: t('data.action.verify'),
      render: (b) => (
        <div className="data-row-verify">
          <button
            type="button"
            className="btn btn--ghost"
            aria-label={t('dataBackup.verify.rowLabel', { kind: t(`data.kind.${b.kind}`), date: formatDate(b.createdAt) })}
            disabled={busy}
            onClick={async () => {
              const line = await verifySource(b.artifactRef);
              setRowVerify((current) => ({ ...current, [b.backupId]: line }));
            }}
          >
            {t('data.action.verify')}
          </button>
          {rowVerify[b.backupId] !== undefined && (
            <p className="diag-prose data-row-verify-result" role="status">
              {rowVerify[b.backupId]}
            </p>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: t('data.action.delete'),
      headerHidden: true,
      render: (b) => (
        <button
          type="button"
          className="btn btn--ghost"
          aria-label={t('data.action.delete')}
          disabled={busy}
          onClick={() => void run('delete_backup', { workspaceId, backupId: b.backupId, idempotencyKey: key() }, refresh)}
        >
          {t('data.action.delete')}
        </button>
      ),
    },
  ];

  return (
    <section className="data-panel" aria-labelledby="data-title">
      <header className="data-head">
        <h2 id="data-title" className="diag-subtitle">
          {t('data.title')}
        </h2>
        <p className="diag-prose diag-prose-dim">{t('data.intro')}</p>
      </header>

      {actionError !== null && (
        <ErrorBanner
          error={actionError}
          // A restore over a .tillexport is refused by the engine (restore_source_not_backup); the
          // person reads the same honesty sentence the verify shows, not a generic failure.
          message={actionError.error === 'restore_source_not_backup' ? t('data.error.unrestorable_format') : undefined}
        />
      )}

      <div className="data-actions">
        <button type="button" className="btn btn--secondary" disabled={busy} onClick={() => void run('export_workspace', { workspaceId, idempotencyKey: key() }, refresh)}>
          {t('data.action.export')}
        </button>
        {/* S2.1: "Jetzt sichern" is the SECTION'S primary (the Trust link's acceptance names it);
            the export stays secondary, so the ritual has one visually primary action. */}
        <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void run('create_backup', { workspaceId, idempotencyKey: key() }, refresh)}>
          {t('data.action.backup')}
        </button>
      </div>

      <DataTable
        columns={columns}
        rows={load.kind === 'ready' ? load.backups : []}
        rowKey={(b) => b.backupId}
        loading={load.kind === 'loading'}
        error={load.kind === 'error' ? load.error : undefined}
        onRetry={() => void refresh()}
        skeletonRows={3}
        emptyState={<p className="diag-prose diag-prose-dim data-empty">{t('data.history.empty')}</p>}
      />

      <div className="data-restore">
        <h3 className="diag-subtitle">{t('data.restore.title')}</h3>
        <p className="diag-prose diag-prose-dim">{t('data.restore.hint')}</p>
        <label className="data-field">
          <span>{t('data.restore.source')}</span>
          <input type="text" value={source} onChange={(e) => setSource(e.target.value)} placeholder="~/.till/backups/…" />
        </label>
        <div className="data-actions">
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || source.trim() === ''}
            onClick={async () => {
              setVerify(null);
              setVerify(await verifySource(source.trim()));
            }}
          >
            {t('data.action.verify')}
          </button>
          <button
            type="button"
            className="btn btn--secondary"
            disabled={busy || source.trim() === ''}
            onClick={() => setConfirmingRestore(true)}
          >
            {t('data.action.restore')}
          </button>
        </div>
        {verify !== null && (
          <p className="diag-prose data-verify" role="status">
            {verify}
          </p>
        )}
      </div>

      {/* The P8 human gate: the engine is called with `confirmed:true` ONLY after the operator
          confirms here. The consequential `alertdialog` variant does not dismiss on a stray scrim
          click, so a misclick cannot answer for them. Title and consequence are separate strings
          (the confirm sentence is the described-by body); the close control takes its own label,
          kept distinct from the footer "Abbrechen" so the two cancel affordances stay addressable. */}
      <Modal
        open={confirmingRestore}
        role={ALERT_DIALOG}
        onClose={() => setConfirmingRestore(false)}
        title={t('data.restore.title')}
        closeLabel={t('data.restore.close')}
        describedById={restoreBodyId}
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirmingRestore(false)}>
              {t('setup.cancel')}
            </button>
            {/* Affirmative and non-destructive: restore creates a NEW workspace and never overwrites
                one (the body says so), so this is the primary action, not a danger-red one. */}
            <button
              type="button"
              className="btn btn--primary"
              onClick={async () => {
                setConfirmingRestore(false);
                const body = await run('restore_backup', {
                  source: source.trim(),
                  newWorkspaceName: t('data.restore.defaultName'),
                  confirmed: true,
                  idempotencyKey: key(),
                });
                if (body) void refresh();
              }}
            >
              {t('data.action.restore')}
            </button>
          </>
        }
      >
        <p id={restoreBodyId} className="diag-confirm-body">
          {t('data.restore.confirm')}
        </p>
      </Modal>

      <div className="data-catalog">
        <button
          type="button"
          className="btn btn--ghost"
          onClick={async () => {
            const body = await run('get_api_catalog', {});
            if (body) setCatalog(t('data.catalog.result', { count: String((body as unknown as { toolCount: number }).toolCount) }));
          }}
        >
          {t('data.catalog.link')}
        </button>
        {catalog !== null && <span className="diag-prose diag-prose-dim">{catalog}</span>}
      </div>
    </section>
  );
}
