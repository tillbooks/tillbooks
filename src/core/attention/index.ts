/**
 * G15, the attention hub: the composition contract between many module-local work queues and one
 * shared surface. Two read verbs, one provider registry, no table.
 *
 * The registration guard runs at MODULE LOAD (the `assertEveryActionIsGated` idiom): a provider whose
 * read capability does not resolve or whose deep link is not routed crashes the import with the queue
 * named, rather than rendering a hub row that opens a Placeholder.
 */

import { assertProvidersRegistrable } from './compose.js';
import { ATTENTION_PROVIDERS } from './providers.js';

export { attentionSummary, attentionList, assertProvidersRegistrable } from './compose.js';
export type { AttentionSummaryInput, AttentionListInput } from './compose.js';
export { ATTENTION_PROVIDERS, ROUTED_SURFACES } from './providers.js';
export {
  ATTENTION_URGENCY,
  ATTENTION_LIST_CAP,
  URGENCY_RANK,
} from './types.js';
export type {
  AttentionItem,
  AttentionDecisionOption,
  DecisionRole,
  AttentionUrgency,
  AttentionQueueSummary,
  QueueProvider,
  DeepLink,
  Freshness,
  Dismissal,
} from './types.js';

// A queue that is shown is a queue that is real: refuse an unresolvable capability or an unrouted deep
// link at load, not in production.
assertProvidersRegistrable(ATTENTION_PROVIDERS);
