/**
 * E00, Dateien (`/files`): the filing tree, the searchable list, and the detail drawer.
 *
 * WHY IT IS A RAIL ITEM UNDER STAMMDATEN. A stored file is not an A10 document: Belege (`/documents`)
 * is the quote/order/invoice/credit-note lifecycle, and a file attaches to ANY record, a contract to a
 * contact, a bank statement to a payment, a receipt to a journal entry. What it shares with the three
 * registers above it in that group is the rhythm: something you browse and search, not a daily verb.
 *
 * THE STATE MODEL IS IN THE URL, not in this component. `?folder=`, `?q=` and `?file=` are the whole of
 * it, which buys three things for free: the back button works, a filtered view is a link somebody can
 * send, and a reload lands where the operator was. That is the same choice `/bank-accounts` makes with
 * `?account=`.
 *
 * ONE READ ANSWERS THE LIST AND THE DRAWER. `files_search` is called with `includeVersions: true`, so a
 * head arrives with its own history nested underneath it and opening the drawer needs no second call.
 * The alternative, a per-file read when the drawer opens, would show a version count that could differ
 * from the list it was opened from.
 *
 * THE PERMISSION GATES HERE ARE A CONVENIENCE AND NOT THE ENFORCEMENT. `lib/capabilities.ts` is the one
 * source (`whoami`), it fails OPEN by design, and the engine is the real gate at `ctxAction`. So a
 * denied write renders the engine's own refusal where it was attempted, and a denied READ renders the
 * padlock panel. Nothing here is pre-disabled on a permission field invented in a list payload: three
 * Studio gates once did exactly that and stood open in every shipped build.
 *
 * ROUND 2 (D137). The search filters as you type, 250ms after the last keystroke (K-16), with no
 * "Suchen" button; the active narrowings and the Offene-Signaturen facet are one `FilterChips` row
 * (K-11); the row opens the drawer (K-21); upload is the shared `FileDrop` (K-13); the pending-delete
 * marker is a `Status` word (K-22).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useT, formatDate } from '../../i18n';
import { SurfaceHelp } from '../../components/SurfaceHelp';
import { EmptyState, ErrorBanner, NoWorkspaceState, PermissionDenied } from '../../components/states';
import { DataTable, type DataTableColumn } from '../../components/DataTable';
import { FileDrop } from '../../components/FileDrop';
import { FilterChips } from '../../components/FilterChips';
import { Status } from '../../components/Status';
import { SurfaceHeader } from '../../components/SurfaceHeader';
import { FolderTree } from './FolderTree';
import { FileDrawer } from './FileDrawer';
import type { SignContact, SignRequestItem } from './SignSection';
import { LockGlyph, MimeGlyph } from './glyphs';
import {
  downloadContent,
  formatBytes,
  mimeKind,
  parseFiles,
  parseFolders,
  parseTruncation,
  readFileAsUpload,
  type FileFolder,
  type StoredFile,
} from './model';

/** A fresh key per write, so a retry after a transport failure is a retry and not a second filing. */
const newKey = () => crypto.randomUUID();

/** The search follows the typing this long after the last keystroke (K-16: live, never a button). */
const SEARCH_DEBOUNCE_MS = 250;

/** The header upload's real file input, so the empty state's "Datei hochladen" opens the same picker. */
const UPLOAD_INPUT_ID = 'files-upload-input';

export function Files() {
  const t = useT();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const { can } = useCapabilities();
  const [params, setParams] = useSearchParams();

  const folderParam = params.get('folder');
  const queryParam = params.get('q') ?? '';
  const openId = params.get('file');
  // E01's tracking filter (spec §6): `?sign=open` narrows the list to files carrying an open
  // signature request (draft|sent|viewed), the URL-state rule this surface already follows.
  const signParam = params.get('sign');

  const [files, setFiles] = useState<StoredFile[]>([]);
  const [folders, setFolders] = useState<FileFolder[]>([]);
  const [truncation, setTruncation] = useState<{ total: number; ceiling: number } | null>(null);
  const [search, setSearch] = useState(queryParam);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const [listError, setListError] = useState<Err | null>(null);
  const [drawerError, setDrawerError] = useState<Err | null>(null);
  const [busy, setBusy] = useState(false);
  // E01: the open file's sign requests (null while in flight), the signer picker's contacts, the
  // engine's last sign refusal, and the id set behind the "Offene Signaturen" list filter.
  const [signRequests, setSignRequests] = useState<SignRequestItem[] | null>(null);
  const [signContacts, setSignContacts] = useState<SignContact[]>([]);
  const [signError, setSignError] = useState<Err | null>(null);
  const [openSignFileIds, setOpenSignFileIds] = useState<ReadonlySet<string> | null>(null);

  // The Studio's convenience gates, from the ONE permission source, and each one mirrors an engine
  // declaration exactly rather than approximating it.
  //
  //   canWrite     `manage_files`, E00's own filing right since F8. It was `manage_master_data`, which a
  //                Treuhänder does not hold, so this surface hid the upload control from the very role
  //                whose job is to file the vouchers.
  //   canAdmin     plus `manage_settings`, the second capability the engine requires for retention and
  //                deletion, rather than a `documents.admin` that A24 does not ship.
  //   canDownload  BOTH halves of the engine's ALL-OF on `files_get_content` (F7). Mirroring both, and
  //                not just the new name, is what keeps this gate honest if the declaration changes.
  const canWrite = can(CAP.manageFiles);
  const canAdmin = canWrite && can(CAP.manageSettings);
  const canDownload = can(CAP.readMasterData) && can(CAP.readFileContent);
  //   canSignWrite E01's `sign.write`: the Signatur section's lifecycle controls. Hidden without it.
  //   canSignSend  additionally `sign.send`, the engine's ALL-OF on `sign_requests_send`: Senden
  //                renders DISABLED with the Berechtigung-fehlt hint (US-E01.2), never hidden.
  const canSignWrite = can(CAP.signWrite);
  const canSignSend = canSignWrite && can(CAP.signSend);

  const load = useCallback(async () => {
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setFailed(false);
    setDenied(false);

    const [listed, tree] = await Promise.all([
      client.call('files_search', {
        workspaceId,
        includeVersions: true,
        ...(queryParam === '' ? {} : { q: queryParam }),
        ...(folderParam === null ? {} : { folderId: folderParam }),
      }),
      client.call('folders_list', { workspaceId }),
    ]);

    if (isErr(listed.body) || isErr(tree.body)) {
      const first = isErr(listed.body) ? listed.body : (tree.body as Err);
      if (first.error === 'permission_denied' || listed.status === 403) setDenied(true);
      else setFailed(true);
      setLoading(false);
      return;
    }

    const parsedFiles = parseFiles(listed.body);
    const parsedFolders = parseFolders(tree.body);
    // A shape this surface cannot read is a failed READ and never an empty list: rendering "Noch keine
    // Dateien" for an unreadable payload makes a broken build look exactly like a new workspace.
    if (parsedFiles === null || parsedFolders === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setFiles(parsedFiles);
    setFolders(parsedFolders);
    setTruncation(parseTruncation(listed.body));
    setLoading(false);
  }, [client, workspaceId, queryParam, folderParam]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Read the wire shape of one sign request into the section's item (envelope signer included). */
  const parseSignRequest = (raw: unknown): SignRequestItem => {
    const row = raw as Record<string, unknown> & { localArtifact?: { signer?: { name?: string | null; email?: string } } };
    return {
      id: String(row.id),
      status: String(row.status),
      signatureLevel: String(row.signatureLevel),
      signerName: row.localArtifact?.signer?.name ?? null,
      signerEmail: row.localArtifact?.signer?.email ?? '',
      message: (row.message as string | null) ?? null,
      expiresAt: (row.expiresAt as string | null) ?? null,
      declinedReason: (row.declinedReason as string | null) ?? null,
      expiredReason: (row.expiredReason as string | null) ?? null,
      signedFileId: (row.signedFileId as string | null) ?? null,
    };
  };

  // The drawer's Signatur data: the open file's requests, and the signer picker's contacts. One
  // read each when the drawer opens; the request list re-reads after every sign write.
  const loadSign = useCallback(async () => {
    if (workspaceId === null || openId === null) return;
    const listed = await client.call('sign_requests_list', { workspaceId, fileId: openId });
    if (isErr(listed.body)) {
      setSignRequests([]);
      return;
    }
    setSignRequests(((listed.body as { signRequests?: unknown[] }).signRequests ?? []).map(parseSignRequest));
  }, [client, workspaceId, openId]);

  useEffect(() => {
    setSignRequests(null);
    setSignError(null);
    if (openId !== null) void loadSign();
  }, [openId, loadSign]);

  useEffect(() => {
    if (workspaceId === null || openId === null || !canSignWrite || signContacts.length > 0) return;
    void (async () => {
      const listed = await client.call('list_contacts', { workspaceId });
      if (isErr(listed.body)) return;
      const rows = (listed.body as { contacts?: { id: string; name: string | null; email: string | null }[] }).contacts ?? [];
      setSignContacts(rows.map((c) => ({ id: c.id, name: c.name ?? c.id, email: c.email })));
    })();
  }, [client, workspaceId, openId, canSignWrite, signContacts.length]);

  // The "Offene Signaturen" filter's id set: one list read over the OPEN statuses, refreshed with
  // the file list. Kept as a set of file ids so the file table's own search/folder filters compose.
  useEffect(() => {
    if (workspaceId === null || signParam !== 'open') {
      setOpenSignFileIds(null);
      return;
    }
    void (async () => {
      const listed = await client.call('sign_requests_list', { workspaceId });
      if (isErr(listed.body)) {
        setOpenSignFileIds(new Set());
        return;
      }
      const rows = (listed.body as { signRequests?: { fileId: string; status: string }[] }).signRequests ?? [];
      setOpenSignFileIds(
        new Set(rows.filter((r) => r.status === 'draft' || r.status === 'sent' || r.status === 'viewed').map((r) => r.fileId)),
      );
    })();
  }, [client, workspaceId, signParam, files]);

  /** Run a sign write, record the engine's refusal in the section, and re-read the request list. */
  const signWrite = useCallback(
    async (action: string, input: Record<string, unknown>) => {
      if (workspaceId === null) return;
      setSignError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setSignError(response.body);
        return;
      }
      await loadSign();
      // Completion lands a new E00 version, so the file list itself is stale too.
      if (action === 'sign_requests_complete') await load();
    },
    [client, workspaceId, loadSign, load],
  );

  // The field is local so typing is not a route change per keystroke: the URL follows 250ms after the
  // last keystroke (K-16), and a change from outside (a removed chip, a back step) flows back in.
  useEffect(() => {
    setSearch(queryParam);
  }, [queryParam]);

  const setParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params);
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
      setParams(next, { replace: false });
    },
    [params, setParams],
  );

  useEffect(() => {
    const next = search.trim();
    if (next === queryParam) return undefined;
    const timer = setTimeout(() => setParam('q', next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search, queryParam, setParam]);

  /** Run a write, record the engine's refusal where it belongs, and re-read on success. */
  const write = useCallback(
    async (action: string, input: Record<string, unknown>, target: 'list' | 'drawer'): Promise<boolean> => {
      if (workspaceId === null) return false;
      const setError = target === 'drawer' ? setDrawerError : setListError;
      setError(null);
      const response = await client.call(action, { workspaceId, ...input });
      if (isErr(response.body)) {
        setError(response.body);
        return false;
      }
      await load();
      return true;
    },
    [client, workspaceId, load],
  );

  const upload = useCallback(
    async (picked: File) => {
      const payload = await readFileAsUpload(picked);
      await write(
        'files_upload',
        {
          ...payload,
          title: payload.filename,
          ...(folderParam === null ? {} : { folderId: folderParam }),
          idempotencyKey: newKey(),
        },
        'list',
      );
    },
    [write, folderParam],
  );

  const download = useCallback(
    async (fileId: string) => {
      if (workspaceId === null) return;
      setDrawerError(null);
      setBusy(true);
      const response = await client.call('files_get_content', { workspaceId, fileId });
      setBusy(false);
      if (isErr(response.body)) {
        // `integrity_mismatch` lands here, and NOTHING is saved: the engine refused to hand over bytes
        // whose re-hash disagreed with the stored checksum, and the drawer says so rather than writing
        // a file the operator would then believe.
        setDrawerError(response.body);
        return;
      }
      const body = response.body as unknown as { contentBase64: string; mime: string; filename: string };
      downloadContent(body);
    },
    [client, workspaceId],
  );

  const open = openId === null ? null : (files.find((f) => f.id === openId) ?? null);

  // A drawer whose file left the list (deleted, or filtered away by a new search) closes itself rather
  // than rendering a stale copy of a record that is no longer there.
  useEffect(() => {
    if (openId !== null && !loading && open === null) setParam('file', null);
  }, [openId, loading, open, setParam]);

  const visible = useMemo(
    () => (openSignFileIds === null ? files : files.filter((f) => openSignFileIds.has(f.id))),
    [files, openSignFileIds],
  );

  if (workspaceId === null) return <NoWorkspaceState />;
  if (denied) return <PermissionDenied body={t('files.error.permissionDenied.read')} />;

  // The list columns for the shared DataTable. The three number columns keep the surface's LEFT
  // alignment (`align: 'start'`) while opting into the tabular, density-aware `.t-num` cell class
  // (`numeric: true`), so the figures still line up down the page without becoming right-aligned money.
  const columns: DataTableColumn<StoredFile>[] = [
    {
      key: 'title',
      header: t('files.field.title'),
      // The leading cell of a row that opens the drawer (K-21): the kind glyph and the title in ink.
      render: (file) => (
        <span className="files-title-cell">
          <MimeGlyph kind={mimeKind(file.mime)} />
          <span>{file.title}</span>
          {/* A state, so the one Status word (K-22): glyph AND text, never colour alone. */}
          {file.pendingDelete && <Status kind="warn" label={t('files.delete.pending.badge')} />}
        </span>
      ),
    },
    {
      key: 'tags',
      header: t('files.field.tags'),
      render: (file) =>
        file.tags.length === 0 ? <span className="files-muted">&ndash;</span> : file.tags.join(', '),
    },
    {
      key: 'version',
      header: t('files.field.version'),
      numeric: true,
      align: 'start',
      render: (file) => file.version,
    },
    {
      key: 'size',
      header: t('files.field.size'),
      numeric: true,
      align: 'start',
      render: (file) => formatBytes(file.bytes),
    },
    {
      key: 'retention',
      header: t('files.field.retentionUntil'),
      numeric: true,
      align: 'start',
      render: (file) =>
        file.retentionUntil === null ? (
          <span className="files-muted">&ndash;</span>
        ) : (
          <span className="files-retention-cell">
            {file.retentionLocked && <LockGlyph size={14} />}
            {formatDate(file.retentionUntil)}
          </span>
        ),
    },
  ];

  return (
    <section className="files" aria-labelledby="files-title">
      <SurfaceHeader
        title={t('files.route.title')}
        titleId="files-title"
        help={<SurfaceHelp surface="Files" />}
        actions={
          canWrite ? (
            // The shared FileDrop (K-13): a real, keyboard-operable file input behind a labelled
            // button in the product's language, never the browser's own "Choose File".
            <FileDrop
              variant="button"
              id={UPLOAD_INPUT_ID}
              label={t('files.action.upload')}
              onFiles={(picked) => {
                const first = picked[0];
                if (first !== undefined) void upload(first);
              }}
            />
          ) : undefined
        }
      />

      <div className="files-search" role="search">
        <label className="visually-hidden" htmlFor="files-q">
          {t('files.search.label')}
        </label>
        <input
          id="files-q"
          type="search"
          className="field files-search-input"
          value={search}
          placeholder={t('files.search.placeholder')}
          onChange={(event) => setSearch(event.target.value)}
        />
        {/* One FilterChips row (K-11): whatever is narrowing the list shows as a pressed chip, so an
            empty result is never a mystery about a filter the operator forgot was on, and pressing
            it lifts that filter. The Offene-Signaturen facet (E01) is the one chip that is also
            offered while off. */}
        <FilterChips
          label={t('files.filter.group')}
          chips={[
            ...(queryParam !== '' ? [{ value: 'q', label: t('files.filter.query', { q: queryParam }) }] : []),
            ...(folderParam !== null
              ? [
                  {
                    value: 'folder',
                    label: t('files.filter.folder', {
                      name: folders.find((f) => f.id === folderParam)?.name ?? folderParam,
                    }),
                  },
                ]
              : []),
            { value: 'sign', label: t('sign.filter.open') },
          ]}
          selected={[
            ...(queryParam !== '' ? ['q'] : []),
            ...(folderParam !== null ? ['folder'] : []),
            ...(signParam === 'open' ? ['sign'] : []),
          ]}
          onChange={(next) => {
            if (queryParam !== '' && !next.includes('q')) {
              setSearch('');
              setParam('q', null);
            } else if (folderParam !== null && !next.includes('folder')) setParam('folder', null);
            else setParam('sign', next.includes('sign') ? 'open' : null);
          }}
        />
      </div>

      {listError !== null && (
        <ErrorBanner
          message={
            listError.error === 'folder_not_empty'
              ? t('files.error.folder_not_empty')
              : listError.error === 'folder_name_taken'
                ? t('files.error.folder_name_taken')
                : listError.error === 'folder_cycle'
                  ? t('files.error.folder_cycle')
                  : listError.error === 'file_too_large'
                    ? t('files.error.file_too_large')
                    : listError.error === 'file_unreadable'
                      ? t('files.error.file_unreadable')
                      : listError.error === 'permission_denied'
                        ? t('files.error.permissionDenied.write')
                        : t('errors.fallback')
          }
        />
      )}
      {failed && <ErrorBanner context="read" message={t('files.error.transport')} onRetry={() => void load()} />}

      <div className="files-body">
        <FolderTree
          folders={folders}
          selectedId={folderParam}
          canWrite={canWrite}
          onSelect={(id) => setParam('folder', id)}
          onCreate={(name, parentId) =>
            write('folders_upsert', { name, ...(parentId === null ? {} : { parentId }), idempotencyKey: newKey() }, 'list')
          }
          onRename={(folderId, name) => write('folders_upsert', { folderId, name, idempotencyKey: newKey() }, 'list')}
          onDelete={(folderId) => {
            void write('folders_delete', { folderId, idempotencyKey: newKey() }, 'list');
          }}
        />

        <div className="files-list-wrap">
          {loading ? (
            // The table's own shape while the read is in flight (K-34), named for a screen reader.
            <div role="status" aria-live="polite">
              <span className="visually-hidden">{t('files.loading')}</span>
              <DataTable columns={columns} rows={[]} rowKey={(file) => file.id} loading skeletonRows={4} />
            </div>
          ) : failed ? null : (
            <>
              {/* D34: the engine caps the list and says so. A `status` region rather than an error, and
                  it names the numbers, because "narrow the search" is only actionable advice next to how
                  much is missing. Shown above the table, so only when the table has rows. */}
              {truncation !== null && visible.length > 0 && (
                <p className="files-truncated" role="status">
                  {t('files.list.truncated', { shown: truncation.ceiling, total: truncation.total })}
                </p>
              )}
              {/* The one shared list table (D118 B2): frame overflow, sticky header, density and the five
                  states from the primitive; the row name stays a button so opening the drawer is a named
                  affordance (the Contacts idiom). This surface has no multi-select or per-row selection,
                  and the pending-delete state is carried by the in-cell badge, so no `rowClassName` hook
                  is needed. */}
              <DataTable
                columns={columns}
                rows={visible}
                rowKey={(file) => file.id}
                caption={t('files.table.caption')}
                onRowClick={(file) => setParam('file', file.id)}
                rowLabel={(file) => file.title}
                isRowCurrent={(file) => file.id === openId}
                emptyState={
                  // K-33: a search or the signature facet that hides every row offers the way back,
                  // never a create; an empty book or an empty folder offers the upload.
                  signParam === 'open' || queryParam !== '' ? (
                    <EmptyState
                      title={signParam === 'open' ? t('sign.filter.empty') : t('files.search.noResults')}
                      hint={t('files.search.noResultsHint')}
                      filtered={{
                        onClear: () => {
                          setSearch('');
                          const next = new URLSearchParams(params);
                          next.delete('q');
                          next.delete('sign');
                          setParams(next, { replace: false });
                        },
                      }}
                    />
                  ) : (
                    <EmptyState
                      title={folderParam !== null ? t('files.folder.empty') : t('files.empty')}
                      hint={t('files.emptyHint')}
                      {...(canWrite
                        ? {
                            action: {
                              label: t('files.action.upload'),
                              onClick: () => document.getElementById(UPLOAD_INPUT_ID)?.click(),
                            },
                          }
                        : {})}
                    />
                  )
                }
              />
            </>
          )}
        </div>
      </div>

      {open !== null && (
        <FileDrawer
          // KEYED ON THE FILE, so the drawer's drafts cannot outlive the file they were typed for:
          // `?file=` moving straight from one id to another keeps the component mounted otherwise.
          key={open.id}
          file={open}
          canWrite={canWrite}
          canAdmin={canAdmin}
          canDownload={canDownload}
          error={drawerError}
          busy={busy}
          onClose={() => {
            setDrawerError(null);
            setParam('file', null);
          }}
          onDownload={(fileId) => void download(fileId)}
          onSaveTags={(fileId, tags) => {
            void write('files_update', { fileId, patch: { tags }, idempotencyKey: newKey() }, 'drawer');
          }}
          onSaveRetention={(fileId, retentionUntil) => {
            void write('files_set_retention', { fileId, retentionUntil, idempotencyKey: newKey() }, 'drawer');
          }}
          onNewVersion={(fileId, picked) => {
            void (async () => {
              const payload = await readFileAsUpload(picked);
              await write(
                'files_new_version',
                {
                  fileId,
                  contentBase64: payload.contentBase64,
                  mime: payload.mime,
                  filename: payload.filename,
                  idempotencyKey: newKey(),
                },
                'drawer',
              );
            })();
          }}
          onDelete={(fileId) => {
            // `confirmed: true` because a human at this button has already decided. The P8 staging path
            // exists for an AGENT caller; sending the flag from a control the operator just clicked is
            // what makes the badge's Confirm the same verb rather than a second one.
            void write('files_delete', { fileId, confirmed: true, idempotencyKey: newKey() }, 'drawer');
          }}
          onCancelPending={(fileId) => {
            void write('files_update', { fileId, patch: { pendingDelete: false }, idempotencyKey: newKey() }, 'drawer');
          }}
          sign={{
            requests: signRequests,
            contacts: signContacts,
            canWrite: canSignWrite,
            canSend: canSignSend,
            busy,
            error: signError,
            onCreate: (input) => {
              void signWrite('sign_requests_create', { fileId: open.id, ...input, idempotencyKey: newKey() });
            },
            // `confirmed: true` for the same reason `files_delete` sends it: the P8 gate exists for
            // an unattended caller, and a human at this button has already decided.
            onSend: (signRequestId) => {
              void signWrite('sign_requests_send', { signRequestId, confirmed: true, idempotencyKey: newKey() });
            },
            onMarkSigned: (signRequestId, picked) => {
              void (async () => {
                const payload = await readFileAsUpload(picked);
                await signWrite('sign_requests_complete', {
                  signRequestId,
                  signedContentBase64: payload.contentBase64,
                  // The integrity anchor: the open file's OWN stored checksum, so a swapped upload
                  // is refused by the engine (`document_hash_mismatch`), never silently accepted.
                  originalSha256: open.sha256,
                  mime: payload.mime,
                  idempotencyKey: newKey(),
                });
              })();
            },
            onDecline: (signRequestId) => {
              void signWrite('sign_requests_record_event', { signRequestId, status: 'declined', idempotencyKey: newKey() });
            },
            onWithdraw: (signRequestId) => {
              void signWrite('sign_requests_withdraw', { signRequestId, idempotencyKey: newKey() });
            },
            onDeleteDraft: (signRequestId) => {
              void signWrite('sign_requests_delete_draft', { signRequestId, idempotencyKey: newKey() });
            },
          }}
        />
      )}
    </section>
  );
}
