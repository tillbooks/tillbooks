/**
 * C4 (D118): the risk ladder tiers governed writes, and it can NEVER weaken a top-tier gate.
 *
 * The one property that matters for trust is the last test: every dial-governed verb the engine
 * knows resolves to a tier that REQUIRES synchronous approval. If a future edit slipped a money-path
 * verb down to `read` or `draft`, that verb would post without a human confirmation, and this test
 * goes red before it ships. The mapping is the drift-tested manifest, so "every governed verb" is the
 * engine's own list, not a copy that could omit the one verb that matters.
 */
import { describe, expect, it } from 'vitest';

import generated from './command-source.generated.json';
import {
  tierForVerb,
  requiresSyncApproval,
  consequenceKeyForVerb,
  dialCapabilityForVerb,
} from './approval-tiers';

describe('C4 tiers: read < draft < post < filing', () => {
  it('puts the money path at the post tier, which requires synchronous approval', () => {
    for (const verb of ['post_entry', 'reverse_entry', 'record_payment', 'issue_invoice', 'send_invoice']) {
      expect(tierForVerb(verb), verb).toBe('post');
      expect(requiresSyncApproval(tierForVerb(verb)), verb).toBe(true);
    }
  });

  it('puts statutory filing and plugin install at the top filing tier', () => {
    expect(tierForVerb('vat_mark_filed')).toBe('filing');
    expect(tierForVerb('install_plugin')).toBe('filing');
    expect(requiresSyncApproval('filing')).toBe(true);
  });

  it('a plain read needs no synchronous confirmation and carries no consequence sentence', () => {
    expect(tierForVerb('list_journal')).toBe('read');
    expect(requiresSyncApproval('read')).toBe(false);
    expect(requiresSyncApproval('draft')).toBe(false);
    expect(consequenceKeyForVerb('list_journal')).toBe(null);
    expect(dialCapabilityForVerb('list_journal')).toBe(null);
  });

  it('resolves the shared consequence key a human and the agent both read', () => {
    expect(consequenceKeyForVerb('post_entry')).toBe('agent.consequence.post');
    expect(consequenceKeyForVerb('vat_mark_filed')).toBe('agent.consequence.vat-file');
    expect(consequenceKeyForVerb('record_payment')).toBe('agent.consequence.pay');
    // The two D-added capabilities resolve their own shared key, at the sync-approval post tier.
    expect(consequenceKeyForVerb('lock_period')).toBe('agent.consequence.close-period');
    expect(consequenceKeyForVerb('go_productive')).toBe('agent.consequence.go-live');
    expect(tierForVerb('lock_period')).toBe('post');
    expect(tierForVerb('go_productive')).toBe('post');
  });

  it('PROPERTY: NO dial-governed verb is ever weakened below synchronous approval', () => {
    const governed = generated.verbs.filter((v) => v.dialCapability !== null);
    expect(governed.length).toBeGreaterThan(0);
    for (const v of governed) {
      const tier = tierForVerb(v.name);
      expect(
        requiresSyncApproval(tier),
        `${v.name} (dial ${v.dialCapability}) resolved to tier ${tier}, which does not require sync approval`,
      ).toBe(true);
    }
  });
});
