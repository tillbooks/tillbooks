/**
 * G07, global search: the barrel. One read verb (`searchGlobal`) over a declarative kind roster.
 * The roster is the extension point (one row per kind, the OP3 growth rule); the verb owns no
 * table, posts nothing, and never reaches the E04-E07 confidentiality boundary (US-G07.6).
 */
export {
  searchGlobal,
  SEARCH_MIN_QUERY_LENGTH,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  SEARCHED_FIELD_TYPES,
  type SearchGlobalInput,
  type SearchResultRow,
} from './searchGlobal.js';
export {
  SEARCHABLE_ENTITY_KINDS,
  SEARCHABLE_KIND_IDS,
  searchableKindDef,
  type SearchableKindDef,
} from './registry.js';
