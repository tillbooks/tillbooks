/**
 * G17, in-product guidance: the Begriffe corpus and its two read verbs. No table, no write verb,
 * no route, no per-user state: the corpus is a build-time constant and the wording of record for
 * the GUI panel and the agent face alike.
 */
export {
  CONCEPTS,
  CONCEPT_KEYS,
  conceptByKey,
  type ConceptArea,
  type ConceptEntry,
  type GuidanceLocale,
  type LocalizedText,
} from './corpus.js';
export { listConcepts, getConcept, matchesConcept, conceptMatchScore } from './concepts.js';
