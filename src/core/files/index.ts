/**
 * E00, file management: the local-first filing spine (files, folders, tags, versioning, entity links,
 * OR 958f retention) and the OP3 link half built over G00's entity registry.
 *
 * The barrel `src/api/` imports from. Nothing outside this directory reaches a file in it directly.
 */

export {
  uploadFile,
  updateFile,
  newFileVersion,
  linkFile,
  fileLinkedTo,
  listLinkedFiles,
  searchFiles,
  getFileContent,
  setFileRetention,
  deleteFile,
  fileVersions,
  repointFileLinks,
  fileUploadBegin,
  fileUploadChunk,
  fileUploadCommit,
  readBlobByteSource,
  readBlobSegmentsSync,
  fileIsStreamOnly,
  MAX_FILE_BYTES,
  MAX_MIGRATION_FILE_BYTES,
  MAX_CHUNK_BYTES,
  UPLOAD_TTL_MS,
  FILE_LIST_CEILING,
} from './files.js';
export type {
  UploadFileInput,
  UpdateFilePatch,
  StoredFileRow,
  FileUploadBeginInput,
  FileUploadChunkInput,
  FileUploadCommitInput,
} from './files.js';

// A LEAF, NOT PART OF files.ts: the posting paths import it directly (never this barrel, which pulls
// `node:crypto` in through the upload hash) so `postEntry`'s runtime closure stays browser-pure. The
// boundary is held by `test/style/studio-sees-payloads.test.mjs`.
export { deriveStatutoryOnPost } from './postedFloor.js';

export { upsertFolder, deleteFolder, listFolders, MAX_FOLDER_NAME } from './folders.js';
export type { UpsertFolderInput, FolderRow } from './folders.js';

export {
  RETENTION_SOURCES,
  OR_958F_YEARS,
  ACCOUNTING_ENTITY_KINDS,
  isAccountingEntityKind,
  isPostedAccountingRecord,
  isRegisteredEntityKind,
  fiscalYearEnd,
  statutoryRetentionUntil,
  retentionFloor,
  effectiveRetentionUntil,
  accountingRecordDate,
  ACCOUNTING_DATE_COLUMNS,
  ACCOUNTING_POSTED_CLAUSES,
  ACCOUNTING_DATE_ALSO,
  later,
} from './retention.js';
export type { RetentionSource, RetentionFacts } from './retention.js';

export { IS_HEAD } from './head.js';
export { FILES_SCHEMA_SQL } from './schema.js';
export { FILE_UPLOAD_SCHEMA_SQL } from './uploadSchema.js';

// N02 (D183), Chat Belege: the confined reader, the attach seam, pending files, the drop link and the
// Belegeingang.
export { uploadFileBytes, isPendingFile, headFilesBySha, fileView, fileContentRefusal, storedFileRow } from './files.js';
export type { UploadBytesMeta } from './files.js';
export { readConfinedFile, sniffType, expandHome, parseRoots, realRoots, isInside, SOURCE_PATH_TYPES } from './sourcePath.js';
export type { LocalFileGrant, ConfinedFile, SourcePathType } from './sourcePath.js';
export {
  ATTACH_TARGET_KIND,
  MAX_ATTACHMENTS,
  isAttachAct,
  parseAttach,
  sourceRoots,
  readSourcePath,
  withAttach,
  prepareDraftAttach,
  attachBytes,
} from './attach.js';
export type { AttachAct, AttachEntry, AttachedFile, DraftAttachPrep, BytesInHand } from './attach.js';
export { sweepPendingFiles, pendingFilesOf, pendingRowOf } from './pending.js';
export {
  DROP_TARGET_KINDS,
  DROP_PATH_PREFIX,
  mintDropLink,
  pruneDropLinks,
  resolveDropLink,
  redeemDropLinkGuarded,
  dropLinkByToken,
  hashDropToken,
} from './dropLink.js';
export type { DropTargetKind, DropTargetView, ResolvedDropLink, DropLinkState } from './dropLink.js';
export {
  ERLEDIGT,
  BELEGEINGANG_STATES,
  scanBelegeingang,
  belegeingangStatus,
  belegeingangFolder,
  existingFolder,
} from './belegeingang.js';
export type { BelegeingangReport, BelegeingangState, BelegeingangError, BelegeingangCapture } from './belegeingang.js';
export { CHAT_BELEGE_SCHEMA_SQL } from './chatBelegeSchema.js';
export { vorschlagBelege } from './belegeView.js';
export type { VorschlagBeleg } from './belegeView.js';
export { previewVorschlagBeleg } from './preview.js';
