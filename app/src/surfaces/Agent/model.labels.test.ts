/**
 * The Agent surface labels a drafted verb from the shared `agent.verb.*` catalogue as well as its own
 * slice. Before this, a verb labelled only in the shared catalogue (the A39 bank-line verbs among
 * them) rendered as its raw name on /agent while the Pendenzen surface showed its words.
 */
import { describe, expect, it } from 'vitest';

import { LABELLED_VERBS } from './model';

const A39_WRITES = ['book_bank_line', 'ignore_bank_line', 'reopen_bank_line'];
/** The verbs TILL itself drafts as offers (actor `system`): the rule miner, the Autopilot offer, a Dauerbuchung. */
const SYSTEM_OFFERS = ['set_bank_standard', 'grant_rule_autobook', 'post_entry'];

describe('the Agent surface verb labels', () => {
  it.each(A39_WRITES)('labels %s', (verb) => {
    expect(LABELLED_VERBS.has(verb)).toBe(true);
  });

  // The D196 live verification saw the Autopilot offer listed as "grant rule autobook" (D197: never a machine label).
  it.each(SYSTEM_OFFERS)('labels TILL\'s own offer %s', (verb) => {
    expect(LABELLED_VERBS.has(verb)).toBe(true);
  });
});
