/** N00, the workspace brief and the Hausbuch: the public surface of `src/core/hausbuch/`. */
export { workspaceBrief, legsLine, NO_NOTES_HINT, SECTION_CAPABILITY } from './brief.js';
export type { BriefRule, BriefTable, WorkspaceBriefInput, WorkspaceBriefOk } from './brief.js';
export {
  activeNotes,
  archiveNote,
  BANK_READ_CAPABILITY,
  counterpartyKeysOf,
  listNotes,
  resolveScope,
  setNote,
  NOTE_COUNTERPARTY_MAX,
  NOTE_SCOPE_KINDS,
  NOTE_STATUSES,
  NOTE_TEXT_MAX,
  NOTE_TOPIC_MAX,
} from './notes.js';
export type { ArchiveNoteInput, HausbuchNote, ListNotesInput, ListNotesOk, NoteScope, NoteScopeKind, NoteStatus, NoteWriteOk, SetNoteInput } from './notes.js';
export { BRIEF_SECTIONS, BRIEF_SECTIONS_DEFAULT, BRIEF_SECTIONS_MAX_LENGTH, briefSectionsProblem, isBriefSection, parseBriefSections } from './sections.js';
export type { BriefSection } from './sections.js';
export { HAUSBUCH_SCHEMA_SQL } from './schema.js';
