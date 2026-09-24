/**
 * The detail drawer: download, metadata, tags, retention, version history, and the pending badge.
 *
 * THE PRIMARY ACTION IS A REAL DOWNLOAD. `files_get_content` re-hashes the stored bytes and compares
 * them against the stored checksum before it answers, so what leaves this button is provably what went
 * in: that is the OR 958f Abs. 3 / GeBüV Art. 6 half of the retention duty, and a preview stub would
 * satisfy neither. When the engine answers `integrity_mismatch` the drawer shows a WARNING BANNER and
 * saves nothing, because handing over bytes the checksum disowns is worse than refusing to.
 *
 * AND THE DOWNLOAD IS THE ONE CONTROL HERE THAT IS NOT OFFERED FAIL-OPEN. Reading the bytes needs
 * `read_file_content` (F7), which a `viewer` deliberately does not hold, so both download controls
 * become a padlock rather than a button that returns `permission_denied`. That is a departure from the
 * surface's usual convenience-gate posture and it is deliberate: everywhere else the engine's refusal is
 * informative where it lands, but here the operator is looking at a record they CAN read, so a refused
 * download would read as a malfunction instead of as a boundary.
 *
 * RETENTION IS EDITABLE ONLY WHERE THE ENGINE WOULD ALLOW IT, and the Studio's gate here is a
 * CONVENIENCE and not the enforcement (`lib/capabilities.ts` states that rule and why it fails open).
 * The engine's refusal is rendered where it was attempted, with the statutory floor it named, so an
 * operator who tries to shorten a lock learns the date rather than the word "no".
 *
 * THE SHELL IS THE SHARED `DetailDrawer` (D118 B2), so the scrim, the focus trap, the Escape close and
 * the header/body split come from the one primitive rather than being hand-rolled here. What stays E00's
 * own is the content: the download-or-padlock header control, the retention and tags editors, the
 * Signatur section and the version chain.
 */
import { useEffect, useState } from 'react';

import { useT, formatDate } from '../../i18n';
import { DetailDrawer } from '../../components/DetailDrawer';
import { FileDrop } from '../../components/FileDrop';
import { ErrorBanner } from '../../components/states';
import { LockGlyph, PendingGlyph, VersionsGlyph } from './glyphs';
import { SignSection, type SignSectionProps } from './SignSection';
import { formatBytes, type StoredFile } from './model';

export interface FileDrawerProps {
  file: StoredFile;
  onClose: () => void;
  onDownload: (fileId: string) => void;
  onSaveTags: (fileId: string, tags: string[]) => void;
  onSaveRetention: (fileId: string, retentionUntil: string) => void;
  onNewVersion: (fileId: string, file: File) => void;
  onDelete: (fileId: string) => void;
  onCancelPending: (fileId: string) => void;
  canWrite: boolean;
  canAdmin: boolean;
  /**
   * Does the actor hold E00's content right (F7)? A viewer sees the filing and may not open it, and this
   * is the prop that renders the padlock INSTEAD of a control the engine would refuse.
   */
  canDownload: boolean;
  /** The engine's own words for whatever was last attempted here, or null. */
  error: { error: string; statutoryFloor?: unknown } | null;
  busy: boolean;
  /** E01's Signatur section, one component hosted here (spec §6: no new route). */
  sign: SignSectionProps;
}

export function FileDrawer({
  file,
  onClose,
  onDownload,
  onSaveTags,
  onSaveRetention,
  onNewVersion,
  onDelete,
  onCancelPending,
  canWrite,
  canAdmin,
  canDownload,
  error,
  busy,
  sign,
}: FileDrawerProps) {
  const t = useT();
  const [tagDraft, setTagDraft] = useState(file.tags.join(', '));
  const [retentionDraft, setRetentionDraft] = useState(file.retentionUntil ?? '');

  // Re-seeded when the drawer moves to another file, so file A's half-typed tags never open file B.
  useEffect(() => {
    setTagDraft(file.tags.join(', '));
    setRetentionDraft(file.retentionUntil ?? '');
  }, [file.id, file.tags, file.retentionUntil]);

  const history = file.versions ?? [];

  // THE PADLOCK REPLACES THE CONTROL, it does not merely disable it. A download button offered to a
  // role the engine will refuse is the shown-then-rejected pattern five other surfaces avoid through
  // `lib/capabilities.ts`, and it is worse here than elsewhere: the refusal would arrive as a banner
  // over a record the operator can otherwise read in full, which reads like a transport failure rather
  // than a permission. Glyph AND text, never colour alone. It sits beside the title as the drawer's one
  // primary action (DetailDrawer `headerExtra`).
  const headerExtra = canDownload ? (
    <button
      type="button"
      className="btn btn--primary btn--sm"
      disabled={busy}
      onClick={() => onDownload(file.id)}
    >
      {busy ? t('files.action.downloading') : t('files.action.download')}
    </button>
  ) : (
    <span className="files-badge files-download-locked" title={t('files.error.permissionDenied.download')}>
      <LockGlyph size={14} />
      {t('files.action.downloadDenied')}
    </span>
  );

  // The action row pinned below the scrolling body: a new version, and the delete that is separated to
  // the far edge so it never sits beside the primary. The close (X) is DetailDrawer's own header control.
  const footer = (
    <>
      {canAdmin && !file.pendingDelete && (
        <button
          type="button"
          className="btn btn--ghost files-delete"
          // Disabled from the ENGINE's own answer rather than from a date this component compares
          // itself: the lock is judged against the engine's clock, and a browser in another
          // timezone must not be the thing that decides whether a statutory period has run.
          disabled={file.retentionLocked}
          title={file.retentionLocked ? t('files.error.retention_locked') : undefined}
          onClick={() => onDelete(file.id)}
        >
          {t('files.action.delete')}
        </button>
      )}
      {canWrite && (
        <FileDrop
          variant="button"
          label={t('files.action.newVersion')}
          onFiles={(picked) => {
            const first = picked[0];
            if (first !== undefined) onNewVersion(file.id, first);
          }}
        />
      )}
    </>
  );

  return (
    <DetailDrawer
      open
      onClose={onClose}
      title={file.title}
      closeLabel={t('files.action.close')}
      headerExtra={headerExtra}
      footer={footer}
    >
      <div className="files-drawer-content">
        {/* The integrity failure is a BANNER and not a toast: it is a standing fact about the stored
            record, and a message that fades is the wrong shape for "this file no longer matches its
            checksum". */}
        {error !== null && (
          <ErrorBanner
            message={
              error.error === 'integrity_mismatch'
                ? t('files.error.integrity_mismatch')
                : error.error === 'content_not_found'
                  ? t('files.error.content_not_found')
                  : error.error === 'retention_below_statutory'
                    ? t('files.error.retention_below_statutory', {
                        floor:
                          typeof error.statutoryFloor === 'string' ? formatDate(error.statutoryFloor) : '',
                      })
                    : error.error === 'retention_locked'
                      ? t('files.error.retention_locked')
                      : error.error === 'not_head_version'
                        ? t('files.error.not_head_version')
                        : error.error === 'permission_denied'
                          ? t('files.error.permissionDenied.write')
                          : t('errors.fallback')
            }
          />
        )}

        {file.pendingDelete && (
          <div className="files-pending" role="status">
            <p className="files-pending-text">
              <PendingGlyph />
              <strong>{t('files.delete.pending.badge')}</strong> {t('files.delete.pending.body')}
            </p>
            {/* Both actions, always, so the badge is never a dead end. Without `documents.admin` the
                operator sees the state and neither control, which is the honest rendering. */}
            {canAdmin && (
              <div className="files-pending-actions">
                <button type="button" className="btn btn--danger btn--sm" onClick={() => onDelete(file.id)}>
                  {t('files.action.confirm')}
                </button>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => onCancelPending(file.id)}>
                  {t('files.action.cancel')}
                </button>
              </div>
            )}
          </div>
        )}

        <dl className="files-meta">
          <dt>{t('files.field.filename')}</dt>
          <dd>{file.filename}</dd>
          <dt>{t('files.field.size')}</dt>
          <dd className="files-num">{formatBytes(file.bytes)}</dd>
          <dt>{t('files.field.version')}</dt>
          <dd className="files-num">{t('files.version.label', { n: file.version })}</dd>
          <dt>{t('files.field.created')}</dt>
          <dd className="files-num">{formatDate(file.createdAt)}</dd>
          <dt>{t('files.field.checksum')}</dt>
          {/* The whole hash, in a monospaced run: a truncated checksum cannot be compared against
              anything, which is the only thing a checksum is for. */}
          <dd className="files-hash">{file.sha256}</dd>
          {file.entityKind !== null && (
            <>
              <dt>{t('files.field.linkedTo')}</dt>
              <dd>{t(`files.entityKind.${file.entityKind}`)}</dd>
            </>
          )}
        </dl>

        <section className="files-section" aria-labelledby="files-tags-heading">
          <h3 id="files-tags-heading" className="files-section-title">
            {t('files.field.tags')}
          </h3>
          {canWrite ? (
            <div className="files-field">
              <label className="files-label" htmlFor="files-tags">
                {t('files.field.tagsHint')}
              </label>
              <input
                id="files-tags"
                type="text"
                className="field"
                value={tagDraft}
                onChange={(event) => setTagDraft(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() =>
                  onSaveTags(
                    file.id,
                    tagDraft
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter((tag) => tag.length > 0),
                  )
                }
              >
                {t('files.action.save')}
              </button>
            </div>
          ) : file.tags.length === 0 ? (
            <p className="files-muted">{t('files.tags.none')}</p>
          ) : (
            <p className="files-tags">{file.tags.join(', ')}</p>
          )}
        </section>

        <section className="files-section" aria-labelledby="files-retention-heading">
          <h3 id="files-retention-heading" className="files-section-title">
            {t('files.field.retentionUntil')}
          </h3>
          <p className="files-retention-state">
            {file.retentionUntil === null ? (
              <span className="files-muted">{t('files.retention.none')}</span>
            ) : (
              <>
                {/* GLYPH PLUS TEXT: the lock never carries the meaning on its own. */}
                {file.retentionLocked && <LockGlyph />}
                <span className="files-num">{formatDate(file.retentionUntil)}</span>
                <span className="files-provenance">
                  {file.retentionSource === 'statutory_auto'
                    ? t('files.retention.auto')
                    : t('files.retention.manual')}
                </span>
              </>
            )}
          </p>
          {canAdmin ? (
            <div className="files-field">
              <label className="files-label" htmlFor="files-retention">
                {t('files.retention.editHint')}
              </label>
              <input
                id="files-retention"
                type="date"
                className="field"
                value={retentionDraft}
                onChange={(event) => setRetentionDraft(event.target.value)}
              />
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                disabled={retentionDraft.length === 0}
                onClick={() => onSaveRetention(file.id, retentionDraft)}
              >
                {t('files.action.save')}
              </button>
            </div>
          ) : (
            <p className="files-muted">{t('files.retention.readOnly')}</p>
          )}
        </section>

        <SignSection {...sign} />

        {history.length > 1 && (
          <section className="files-section" aria-labelledby="files-versions-heading">
            <h3 id="files-versions-heading" className="files-section-title">
              <VersionsGlyph />
              {t('files.versions.title')}
            </h3>
            <ul className="files-versions">
              {/* Newest first here, though the engine sends oldest first: the chain is stored in the
                  order it happened and read in the order a person asks about it. */}
              {[...history].reverse().map((version) => (
                <li key={version.id} className="files-version">
                  <span className="files-num">{t('files.version.label', { n: version.version })}</span>
                  <span className="files-num files-version-date">{formatDate(version.createdAt)}</span>
                  <span className="files-num">{formatBytes(version.bytes)}</span>
                  {canDownload ? (
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      disabled={busy}
                      aria-label={`${t('files.action.download')}: ${t('files.version.label', { n: version.version })}`}
                      onClick={() => onDownload(version.id)}
                    >
                      {t('files.action.download')}
                    </button>
                  ) : (
                    // The same rule one level down: a superseded version is content too, and offering it
                    // here while the head is padlocked would be a hole in the shape of a smaller button.
                    <span className="files-download-locked" title={t('files.error.permissionDenied.download')}>
                      <LockGlyph size={12} />
                      <span className="visually-hidden">{t('files.action.downloadDenied')}</span>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </DetailDrawer>
  );
}
