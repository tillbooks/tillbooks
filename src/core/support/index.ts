/** G08, feedback & diagnostics. Owns no SQLite table: three files under `~/.till/`. */

export { supportPaths, readConfig, writeCapture } from './config.js';
export type { SupportPaths, ConfigRead } from './config.js';

export { appendEntry, clearJournal, readJournal, JOURNAL_CAP } from './diagnostics.js';

export {
  redactEntry,
  isDefectShaped,
  DEFECT_SHAPED_CODES,
  DIAGNOSTIC_ENTRY_KINDS,
  REDACTABLE_DETAIL_KEYS,
} from './redact.js';
export type { DiagnosticEntry, DiagnosticEntryKind, RawDiagnostic } from './redact.js';

export {
  buildMailto,
  renderReport,
  FEEDBACK_KINDS,
  FEEDBACK_RECIPIENT,
  FEEDBACK_STATES,
  MAILTO_MAX,
  MESSAGE_MAX,
  SUBJECT_MAX,
} from './report.js';
export type { FeedbackKind, ReportEnvironment, ReportInput } from './report.js';

export {
  clearDiagnostics,
  feedbackIdFor,
  getDiagnostics,
  listFeedback,
  prepareFeedback,
  previewFeedback,
  recordDiagnostic,
  setDiagnostics,
} from './feedback.js';
export type { SupportDeps, FeedbackInput, FeedbackRow } from './feedback.js';
