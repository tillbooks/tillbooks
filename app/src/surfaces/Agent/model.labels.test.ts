/**
 * The Agent surface labels a drafted verb from the shared `agent.verb.*` catalogue as well as its own
 * slice. Before this, a verb labelled only in the shared catalogue (the A39 bank-line verbs among
 * them) rendered as its raw name on /agent while the Pendenzen surface showed its words.
 */
import { describe, expect, it } from 'vitest';

import { LABELLED_VERBS } from './model';

const A39_WRITES = ['book_bank_line', 'ignore_bank_line', 'reopen_bank_line'];

describe('the Agent surface verb labels', () => {
  it.each(A39_WRITES)('labels %s', (verb) => {
    expect(LABELLED_VERBS.has(verb)).toBe(true);
  });
});
