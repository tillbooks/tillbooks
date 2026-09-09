/**
 * The "Dateien" panel for ANY record: one component, mounted per entity, never a per-entity copy.
 *
 * This is E00's second insertion point and the spec's own DRY requirement: an invoice detail view, a
 * contact drawer and a payment panel all render THIS, parameterised by the OP3 pair, so there is no
 * bespoke attachment UI anywhere in the product. It takes `entityKind` and `entityId` and nothing
 * else, because the engine's `files_list_linked` takes exactly that, and the attach gate's second
 * half (the target kind's own edit right, D62 / F8) is derived from the kind through the engine's
 * own `editCapabilityForKind` rather than passed in beside it (see the prop's doc).
 *
 * IT IS NOT MOUNTED ANYWHERE YET, and that is a deliberate boundary rather than dead code. The entity
 * detail views belong to A10/A11 (`surfaces/Documents/`), C00 (`surfaces/Contacts/`) and A14
 * (`surfaces/Payments/`), and mounting a panel inside another capability's surface is exactly the
 * file-ownership collision the loop's rules exist to prevent. The component and its test are what make
 * the mount a one-line change for whoever owns each of those screens.
 */
import { useCallback, useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { CAP, editCapabilityForKind, useCapabilities, type EntityKind } from '../../lib/capabilities';
import { useT, formatDate } from '../../i18n';
import { EmptyState, ErrorBanner, Skeleton } from '../../components/states';
import { LockGlyph, MimeGlyph } from './glyphs';
import { formatBytes, mimeKind, parseFiles, readFileAsUpload, type StoredFile } from './model';

export interface LinkedFilesProps {
  workspaceId: string;
  /**
   * An OP3 entity kind, as the shared registry spells it, and the ONLY per-entity fact a host
   * passes. The attach gate needs the target kind's own edit right (D62 / F8: attaching is upload
   * THEN link, so it costs `manage_files` AND that right, a pair no precomputed boolean can carry),
   * and the right is DERIVED in here through `editCapabilityForKind`, the engine's own lookup: a
   * host handing it in beside the kind would be a second source of truth that could disagree with
   * the refusal the engine would give.
   */
  entityKind: EntityKind;
  entityId: string;
}

export function LinkedFiles({ workspaceId, entityKind, entityId }: LinkedFilesProps) {
  const t = useT();
  const client = useClient();
  const { can } = useCapabilities();
  // Both halves of the attach flow (F8): `files_upload` needs the filing right, `files_link` the
  // target's own edit right, derived from the kind by the engine's own map. Fail-open while
  // `whoami` is unanswered, like every Studio gate: the engine is the enforcement, this is the
  // courtesy of not offering a control it would refuse.
  const canAttach = can(CAP.manageFiles) && can(editCapabilityForKind(entityKind));
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [error, setError] = useState<Err | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    const response = await client.call('files_list_linked', { workspaceId, entityKind, entityId });
    if (isErr(response.body)) {
      setFailed(true);
      setLoading(false);
      return;
    }
    const parsed = parseFiles(response.body);
    if (parsed === null) {
      setFailed(true);
      setLoading(false);
      return;
    }
    setFiles(parsed);
    setLoading(false);
  }, [client, workspaceId, entityKind, entityId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Attach: upload, then link, as TWO calls.
   *
   * The engine has no combined verb and should not: `files_upload` files bytes and `files_link` says
   * what they evidence, and folding them together would make "the upload succeeded but the link did
   * not" unrepresentable rather than merely rare. Both keys are minted here, so a retry after a
   * transport failure repeats the same two writes instead of filing a second copy.
   */
  const attach = useCallback(
    async (picked: File) => {
      setError(null);
      const payload = await readFileAsUpload(picked);
      const uploaded = await client.call('files_upload', {
        workspaceId,
        ...payload,
        title: payload.filename,
        idempotencyKey: crypto.randomUUID(),
      });
      if (isErr(uploaded.body)) {
        setError(uploaded.body);
        return;
      }
      const file = (uploaded.body as unknown as { file: { id: string } }).file;
      const linked = await client.call('files_link', {
        workspaceId,
        fileId: file.id,
        entityKind,
        entityId,
        idempotencyKey: crypto.randomUUID(),
      });
      if (isErr(linked.body)) {
        // The bytes ARE stored and reachable from the Dateien surface, so the message says so instead
        // of implying the upload was lost.
        setError(linked.body);
        return;
      }
      await load();
    },
    [client, workspaceId, entityKind, entityId, load],
  );

  return (
    <section className="files-linked" aria-labelledby="files-linked-heading">
      <header className="files-linked-head">
        <h3 id="files-linked-heading" className="files-section-title">
          {t('files.linked.title')}
        </h3>
        {/* The padlock replaces the control, it does not merely disable it: the FileDrawer download
            pattern. A missing right on EITHER half of upload-then-link locks the affordance, because
            offering the picker and refusing after the bytes were chosen is the shown-then-rejected
            shape this Studio avoids. Glyph AND text, never colour alone. */}
        {canAttach ? (
          <label className="btn btn--secondary btn--sm files-file-label">
            {t('files.action.link')}
            <input
              type="file"
              className="files-file-input"
              onChange={(event) => {
                const picked = event.target.files?.[0];
                if (picked !== undefined) void attach(picked);
                event.target.value = '';
              }}
            />
          </label>
        ) : (
          <span className="files-badge files-download-locked" title={t('files.error.permissionDenied.link')}>
            <LockGlyph size={14} />
            {t('files.action.linkDenied')}
          </span>
        )}
      </header>

      {error !== null && (
        <ErrorBanner
          message={
            error.error === 'entity_not_found'
              ? t('files.error.entity_not_found')
              : error.error === 'unknown_entity_kind'
                ? t('files.error.unknown_entity_kind')
                : error.error === 'file_too_large'
                  ? t('files.error.file_too_large')
                  : error.error === 'permission_denied'
                    ? t('files.error.permissionDenied.write')
                    : t('errors.fallback')
          }
        />
      )}
      {failed && <ErrorBanner message={t('files.error.transport')} onRetry={() => void load()} />}

      {loading ? (
        <div role="status" aria-busy="true" aria-live="polite">
          <span className="files-sr">{t('files.loading')}</span>
          <Skeleton rows={2} />
        </div>
      ) : failed ? null : files.length === 0 ? (
        <EmptyState title={t('files.linked.empty')} hint={t('files.linked.emptyHint')} />
      ) : (
        <ul className="files-linked-list">
          {files.map((file) => (
            <li key={file.id} className="files-linked-row">
              <MimeGlyph kind={mimeKind(file.mime)} />
              <span className="files-linked-name">{file.title}</span>
              <span className="files-num">{t('files.version.label', { n: file.version })}</span>
              <span className="files-num">{formatBytes(file.bytes)}</span>
              {file.retentionUntil !== null && (
                <span className="files-num files-retention-cell">
                  {file.retentionLocked && <LockGlyph size={14} />}
                  {formatDate(file.retentionUntil)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
