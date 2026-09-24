/**
 * E04, the local mail store: the barrel `src/api/` imports from.
 *
 * The adapters are exported for the fixture-driven round-trip tests; `purgeMailForContact` is
 * exported for C00's `contacts_anonymise` (it is called INSIDE that verb's transaction and is
 * deliberately not an MCP tool of its own, spec §5); the schema constants feed the store and the
 * erasure-coverage guard.
 */

export {
  connectMailStore,
  listMailAccounts,
  reindexMailStore,
  listMailThreads,
  getMailThread,
  writeMailDraft,
  replaceMailDraft,
  listMailDrafts,
  purgeMailForContact,
} from './mailstore.js';
export type { ConnectMailInput, ReindexInput, DraftWriteInput, DraftReplaceInput, ThreadsListFilter } from './mailstore.js';
export { ADAPTERS, bodySha256, parseHeaders, directionOf } from './adapters.js';
export type { MailStoreAdapter, WalkedMessage, ParsedHeaders } from './adapters.js';
export {
  MAIL_ADAPTERS,
  MAIL_DIRECTIONS,
  MAIL_BUCKETS,
  isMailAdapter,
  isMailDirection,
  isMailBucket,
} from './enums.js';
export type { MailAdapterKind, MailDirection, MailBucket } from './enums.js';
export { MAIL_SCHEMA_SQL, MAIL_TABLES } from './schema.js';
