/**
 * D203, the Regeln tab: what decides where each event goes, in place (pick B, DESIGN.md rule 7: the rules have
 * their own screen, the figures stay calm).
 *
 *  - THE BOOKING TEMPLATE per source: the A43 editor (`BankAccounts/SettlementTemplateEditor`), reused, never
 *    rebuilt. It sends the whole template to `set_settlement_template` and the engine checks it.
 *  - THE SETTINGS behind the review (`settlement.review_period`, `test_events`, `test_fees`, `pull_mode`,
 *    `agent_sees_email`): one shared Select each, German value words, saved on change through `settings_set`
 *    with no reason (D202, D203 point 5).
 *  - THE BANK RULES that book a payout against a clearing account (`list_bank_standards`): read here, edited in
 *    the bank inbox's rules sheet (the banking code owns the rule editor).
 *
 * Five states per block: the skeleton, the error, the padlock (the page's own), the empty block, the content.
 */
import { useCallback, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useI18n } from '../../i18n';
import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';
import { ErrorBanner, Skeleton, refusalText } from '../../components/states';
import { Select } from '../../components/Select';
import { IconButton } from '../../components/IconButton';
import { SettlementTemplateEditor } from '../BankAccounts/SettlementTemplateEditor';

/** The settings this tab shows, in the order a person meets them, with their values. */
export const UMSATZ_SETTINGS: readonly { key: string; values: readonly string[] }[] = [
  { key: 'settlement.review_period', values: ['quarter', 'month', 'year'] },
  { key: 'settlement.test_events', values: ['skip', 'book'] },
  { key: 'settlement.test_fees', values: ['book', 'skip'] },
  { key: 'settlement.pull_mode', values: ['manual', 'daily'] },
  { key: 'settlement.agent_sees_email', values: ['masked', 'shown'] },
];

interface SourceRef {
  system: string;
  processor: string;
}

interface BankRule {
  id: string;
  label: string | null;
  counterpartyLabel: string | null;
  viaAccountNumber?: string | null;
  legs: { accountNumber: string; accountName?: string }[];
  accountNumber?: string | null;
}

let seq = 0;
const key = (what: string) => `umsatz-rules-${what}-${Date.now().toString(36)}-${(seq += 1)}`;

/** The sources a template or a feed names, one each (matched case-insensitively, as the engine does). */
export function sourcesOf(templates: SourceRef[], feeds: SourceRef[]): SourceRef[] {
  const seen = new Map<string, SourceRef>();
  for (const s of [...templates, ...feeds]) {
    const k = `${s.system.toLowerCase()}|${s.processor.toLowerCase()}`;
    if (!seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()];
}

/** The bank rules whose route touches a clearing account (the payout booking, 1020 against 1095). */
export function payoutRulesOf(rules: BankRule[], clearing: readonly string[]): BankRule[] {
  const set = new Set(clearing);
  return rules.filter((r) => set.has(r.accountNumber ?? '') || set.has(r.viaAccountNumber ?? '') || r.legs.some((l) => set.has(l.accountNumber)));
}

export function UmsatzRules({ workspaceId, clearing, onChanged }: { workspaceId: string; clearing: readonly string[]; onChanged: () => void }) {
  const { t } = useI18n();
  const client = useClient();
  const navigate = useNavigate();
  const id = useId();
  const [sources, setSources] = useState<SourceRef[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [rules, setRules] = useState<BankRule[] | null>(null);
  const [error, setError] = useState<Err | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [tpl, src, set, bank] = await Promise.all([
      client.call('get_settlement_template', { workspaceId }),
      client.call('get_settlement_source', { workspaceId }),
      client.call('settings_list', { workspaceId }),
      client.call('list_bank_standards', { workspaceId, scope: 'bank' }),
    ]);
    const templates = isErr(tpl.body) ? [] : (((tpl.body as unknown as { templates?: SourceRef[] }).templates ?? []) as SourceRef[]);
    const feeds = isErr(src.body) ? [] : (((src.body as unknown as { sources?: SourceRef[] }).sources ?? []) as SourceRef[]);
    const list = sourcesOf(templates, feeds);
    setSources(list);
    setOpen((o) => o ?? (list.length === 1 ? `${list[0]!.system}|${list[0]!.processor}` : null));
    if (!isErr(set.body)) {
      const values: Record<string, string> = {};
      for (const s of ((set.body as unknown as { settings?: { key: string; value: unknown }[] }).settings ?? [])) values[s.key] = String(s.value);
      setSettings(values);
    } else setSettings({});
    setRules(isErr(bank.body) ? [] : ((bank.body as unknown as { standards?: BankRule[] }).standards ?? []));
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setSetting(settingKey: string, value: string) {
    setError(null);
    setSaved(null);
    const { body } = await client.call('settings_set', { workspaceId, key: settingKey, value, idempotencyKey: key('setting') });
    if (isErr(body)) {
      setError(body);
      return;
    }
    setSettings((s) => ({ ...(s ?? {}), [settingKey]: value }));
    setSaved(settingKey);
    onChanged();
  }

  const payoutRules = rules === null ? null : payoutRulesOf(rules, clearing);
  return (
    <div className="umsatz-rules">
      {error !== null && <ErrorBanner message={refusalText(t, error, { own: 'umsatz.refusal', known: [] })} />}
      <section className="umsatz-rules-block" aria-labelledby={`${id}-tpl`}>
        <h2 id={`${id}-tpl`} className="umsatz-subhead">{t('umsatz.rules.templates')}</h2>
        {sources === null ? (
          <Skeleton rows={2} />
        ) : sources.length === 0 ? (
          <p className="umsatz-none">{t('umsatz.rules.noSource')}</p>
        ) : (
          <ul className="umsatz-rules-sources">
            {sources.map((s) => {
              const k = `${s.system}|${s.processor}`;
              return (
                <li key={k} className="umsatz-rules-source">
                  <span className="umsatz-rules-source-head">
                    <span>{`${s.system} · ${s.processor}`}</span>
                    {open === k ? (
                      <IconButton icon="close" small context={`${s.system} · ${s.processor}`} onClick={() => setOpen(null)} />
                    ) : (
                      <IconButton icon="edit" small name={t('umsatz.rules.editTemplate')} context={`${s.system} · ${s.processor}`} onClick={() => setOpen(k)} />
                    )}
                  </span>
                  {open === k && (
                    <SettlementTemplateEditor
                      workspaceId={workspaceId}
                      system={s.system}
                      processor={s.processor}
                      canPost
                      onSaved={() => {
                        setSaved('template');
                        onChanged();
                      }}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="umsatz-rules-block" aria-labelledby={`${id}-set`}>
        <h2 id={`${id}-set`} className="umsatz-subhead">{t('umsatz.rules.settings')}</h2>
        {settings === null ? (
          <Skeleton rows={3} />
        ) : (
          <dl className="umsatz-rules-settings">
            {UMSATZ_SETTINGS.map((s) => {
              const label = t(`umsatz.rules.setting.${s.key.replace('settlement.', '')}.label`);
              return (
                <div key={s.key} className="umsatz-rules-setting" data-setting={s.key}>
                  <dt>{label}</dt>
                  <dd>
                    <Select
                      ariaLabel={label}
                      value={settings[s.key] ?? s.values[0]!}
                      options={s.values.map((v) => ({ value: v, label: t(`umsatz.rules.setting.${s.key.replace('settlement.', '')}.${v}`) }))}
                      onChange={(v) => void setSetting(s.key, v)}
                    />
                    {saved === s.key && (
                      <span role="status" className="umsatz-rules-saved">
                        {t('umsatz.rules.saved')}
                      </span>
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </section>

      <section className="umsatz-rules-block" aria-labelledby={`${id}-bank`}>
        <h2 id={`${id}-bank`} className="umsatz-subhead">
          {t('umsatz.rules.bankRules')}
          <IconButton icon="open" small name={t('umsatz.rules.openBankRules')} context={t('umsatz.rules.openBankRulesContext')} onClick={() => navigate('/bank')} />
        </h2>
        {payoutRules === null ? (
          <Skeleton rows={1} />
        ) : payoutRules.length === 0 ? (
          <p className="umsatz-none">{t('umsatz.rules.noBankRule')}</p>
        ) : (
          <ul className="umsatz-rules-bank">
            {payoutRules.map((r) => (
              <li key={r.id}>
                <span>{r.label ?? r.counterpartyLabel ?? r.id}</span>
                <span className="umsatz-rules-route">{[r.accountNumber, ...r.legs.map((l) => l.accountNumber)].filter((x): x is string => typeof x === 'string' && x.length > 0).filter((x, i, a) => a.indexOf(x) === i).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {saved === 'template' && (
        <p role="status" className="umsatz-rules-saved">
          {t('umsatz.rules.saved')}
        </p>
      )}
    </div>
  );
}
