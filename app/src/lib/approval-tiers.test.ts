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
  tierForCapability,
  requiresSyncApproval,
  consequenceForVerb,
  consequenceSentence,
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

  it('D160.5: enabling a plugin or reviving it on a compat refresh sits beside install, each with its own consequence', () => {
    const families = generated.consequenceFamilies as Record<string, { en: string }>;
    for (const verb of ['enable_plugin', 'refresh_plugin_compat']) {
      expect(dialCapabilityForVerb(verb), verb).toBe('plugin-install');
      expect(tierForVerb(verb), verb).toBe('filing');
      expect(consequenceSentence(verb, 'en'), verb).not.toBe(families['plugin-install']?.en);
      expect(consequenceSentence(verb, 'de-CH')?.length ?? 0, verb).toBeGreaterThan(40);
    }
    // D161.1: uninstall is an access verb and waits too; the stop button stays ungoverned.
    expect(dialCapabilityForVerb('uninstall_plugin')).toBe('plugin-install');
    expect(tierForVerb('uninstall_plugin')).toBe('filing');
    expect(consequenceForVerb('uninstall_plugin')?.reversibility).toBe('final');
    expect(dialCapabilityForVerb('disable_plugin')).toBe(null);
  });

  it('D156: puts the erase family in the top tier and the share consent at the post tier', () => {
    expect(tierForCapability('erase')).toBe('filing');
    for (const verb of ['contacts_anonymise', 'contacts_merge', 'files_delete', 'price_lists_delete']) {
      expect(dialCapabilityForVerb(verb), verb).toBe('erase');
      expect(tierForVerb(verb), verb).toBe('filing');
    }
    expect(tierForCapability('share')).toBe('post');
    for (const verb of ['sync_publish_enable', 'vendor_portal_grant']) {
      expect(dialCapabilityForVerb(verb), verb).toBe('share');
      expect(requiresSyncApproval(tierForVerb(verb)), verb).toBe(true);
    }
  });

  it('D161: stock tiers at post, the key-destroying disconnect at filing, the MWST elections at filing', () => {
    expect(tierForCapability('stock')).toBe('post');
    for (const verb of ['stock_move', 'inventory_adjust', 'goods_receipt_post', 'stock_run_valuation']) {
      expect(dialCapabilityForVerb(verb), verb).toBe('stock');
      expect(requiresSyncApproval(tierForVerb(verb)), verb).toBe(true);
    }
    expect(dialCapabilityForVerb('bank_channel_disconnect')).toBe('erase');
    expect(tierForVerb('bank_channel_disconnect')).toBe('filing');
    for (const verb of ['set_vat_method', 'vat_configure', 'set_fx_method', 'vat_saldo_declaration_basis']) {
      expect(dialCapabilityForVerb(verb), verb).toBe('vat-file');
      expect(tierForVerb(verb), verb).toBe('filing');
    }
    expect(dialCapabilityForVerb('set_write_off_threshold')).toBe('pay');
    expect(dialCapabilityForVerb('requisition_approve')).toBe('pay');
    expect(consequenceForVerb('bank_channel_disconnect')?.reversibility).toBe('final');
  });

  it('D158: the five irreversible writes and the checklist abandon tier at post (the plan abandon, which deletes, at filing), each with its own consequence', () => {
    const expected: Record<string, string> = {
      set_opening_balances: 'post',
      stock_stocktake_commit: 'close-period',
      inventory_stocktake_commit: 'close-period',
      delivery_note_issue: 'issue',
      time_lock: 'close-period',
      checklist_abandon: 'close-period',
      migration_abandon_plan: 'erase',
      approve_entry: 'close-period',
      match_bill: 'pay',
    };
    for (const [verb, family] of Object.entries(expected)) {
      expect(dialCapabilityForVerb(verb), verb).toBe(family);
      // Abandoning a plan deletes the Testmandant (11.10.2026), so it sits in the erase family's top tier.
      expect(tierForVerb(verb), verb).toBe(family === 'erase' ? 'filing' : 'post');
      expect(requiresSyncApproval(tierForVerb(verb)), verb).toBe(true);
      // Its own sentence, not the family fallback.
      const families = generated.consequenceFamilies as Record<string, { en: string }>;
      expect(consequenceSentence(verb, 'en'), verb).not.toBe(families[family]?.en);
      expect(consequenceSentence(verb, 'de-CH')?.length ?? 0, verb).toBeGreaterThan(40);
    }
    expect(consequenceForVerb('time_lock')?.reversibility).toBe('final');
    expect(consequenceForVerb('set_opening_balances')?.reversibility).toBe('correctable');
  });

  it('a plain read needs no synchronous confirmation and carries no consequence sentence', () => {
    expect(tierForVerb('list_journal')).toBe('read');
    expect(requiresSyncApproval('read')).toBe(false);
    expect(requiresSyncApproval('draft')).toBe(false);
    expect(consequenceForVerb('list_journal')).toBe(null);
    expect(dialCapabilityForVerb('list_journal')).toBe(null);
  });

  it('resolves the engine consequence a human and the agent both read (D156: verb first, then family)', () => {
    const families = generated.consequenceFamilies as Record<string, { en: string; 'de-CH': string }>;
    // A verb with no entry of its own reads its dial family's sentence, in both locales.
    expect(consequenceSentence('post_entry', 'en')).toBe(families.post.en);
    expect(consequenceSentence('post_entry', 'de-CH')).toBe(families.post['de-CH']);
    expect(consequenceSentence('vat_mark_filed', 'de-CH')).toBe(families['vat-file']['de-CH']);
    expect(consequenceSentence('record_payment', 'de-CH')).toBe(families.pay['de-CH']);
    // A verb with its own entry reads it, whatever family a caller names.
    expect(consequenceForVerb('close_year')?.reversibility).toBe('final');
    expect(consequenceSentence('close_year', 'de-CH', 'post')).toBe(consequenceSentence('close_year', 'de-CH'));
    expect(consequenceSentence('close_year', 'de-CH')).not.toBe(families['close-period']['de-CH']);
    // An input-keyed call with no verb entry falls back to the family the call resolved to.
    expect(consequenceSentence('not_a_verb', 'en', 'pay')).toBe(families.pay.en);
    expect(consequenceSentence('not_a_verb', 'en')).toBe(null);
    // The two D-added capabilities stay at the sync-approval post tier.
    expect(tierForVerb('lock_period')).toBe('post');
    expect(tierForVerb('go_productive')).toBe('post');
  });

  it('every dial-governed verb carries an engine consequence in both locales', () => {
    for (const v of generated.verbs.filter((row) => row.dialCapability !== null)) {
      const c = consequenceForVerb(v.name);
      expect(c, v.name).not.toBe(null);
      expect(c?.en.length ?? 0, v.name).toBeGreaterThan(20);
      expect(c?.['de-CH'].length ?? 0, v.name).toBeGreaterThan(20);
    }
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
