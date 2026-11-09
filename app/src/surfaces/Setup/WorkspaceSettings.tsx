/**
 * D172, the Einstellungen section: every setting of the workspace settings registry, generic over it.
 *
 * The engine's `settings_list` is the only source: the keys, the values in force, the defaults, the value
 * schemas, the owning capability and the en/de-CH texts all arrive from the registry, so a setting a later
 * capability adds appears here with no Studio edit. Settings are grouped by the capability that owns them
 * (`area`), in registry order. A row shows the value in force and, when it differs, the default; "Ändern"
 * opens a dialog with a control fitted to the schema (a number field with its bounds, a yes/no choice, a
 * list for an enum, a text field) and a REQUIRED reason, because every change is recorded with its old and
 * new value in the setting's history. An overridden setting can be reset to its default from the same
 * dialog, with a reason too. A person without the owning capability sees the values and no Ändern.
 *
 * Design law: one panel, plain rows, the vocabulary IconButton for the explanation (Info) and for the
 * edit (Bearbeiten); Speichern is a plain primary (a setting is not a money commit), Zurücksetzen a
 * secondary.
 */
import { useCallback, useEffect, useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr, type Err } from '../../lib/client';

/**
 * A refusal's own scalar facts (`display`, `characters`), so the sentence can name what was refused: the
 * Belegnummer settings (D178 point 2) answer which existing voucher number a change would repeat.
 */
function refusalFacts(error: Err): Record<string, string | number> {
  const facts: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(error)) {
    if (typeof value === 'string' || typeof value === 'number') facts[name] = value;
  }
  return facts;
}
import { useI18n } from '../../i18n';
import { ErrorBanner, refusalText } from '../../components/states';
import { IconButton } from '../../components/IconButton';
import { Modal } from '../../components/Modal';
import { Select } from '../../components/Select';
import { useCapabilities } from '../../lib/capabilities';
import './WorkspaceSettings.css';

type Localised = { en: string; 'de-CH': string };
type SettingValue = number | boolean | string;
type SettingSchema =
  | { type: 'integer'; min: number; max: number; unit?: 'days' | 'items' | 'percent' }
  | { type: 'number'; min: number; max: number }
  | { type: 'boolean' }
  | { type: 'string'; maxLength: number }
  | { type: 'enum'; values: string[] };

export interface SettingView {
  key: string;
  value: SettingValue;
  default: SettingValue;
  overridden: boolean;
  schema: SettingSchema;
  owningCapability: string;
  dialCapability: string;
  area: { id: string; label: Localised };
  label: Localised;
  description: Localised;
  updatedAt: string | null;
  updatedBy: string | null;
  /** A stored override that no longer fits its schema: ignored, the default applies (critic D172 r1). */
  stale?: boolean;
  ignoredStoredValue?: string | null;
}

/** Group the registry rows by owning capability, keeping registry order inside and between groups. */
export function groupSettings(settings: readonly SettingView[]): { id: string; label: Localised; settings: SettingView[] }[] {
  const groups: { id: string; label: Localised; settings: SettingView[] }[] = [];
  for (const s of settings) {
    const g = groups.find((x) => x.id === s.area.id);
    if (g === undefined) groups.push({ id: s.area.id, label: s.area.label, settings: [s] });
    else g.settings.push(s);
  }
  return groups;
}

function textOf(text: Localised, locale: string): string {
  return locale === 'en' ? text.en : text['de-CH'];
}

/** The value as words: a unit for an integer that has one, Ja/Nein for a boolean. */
function useFormat() {
  const { t } = useI18n();
  return (schema: SettingSchema, value: SettingValue): string => {
    if (schema.type === 'boolean') return value === true ? t('workspaceSettings.yes') : t('workspaceSettings.no');
    if (schema.type === 'integer' && schema.unit !== undefined && typeof value === 'number') {
      return t(`workspaceSettings.unit.${schema.unit}`, { n: String(value) });
    }
    return String(value);
  };
}

/** The draft as typed into the dialog, parsed against the schema; undefined while it does not fit. */
export function parseDraft(schema: SettingSchema, draft: string): SettingValue | undefined {
  switch (schema.type) {
    case 'integer': {
      if (!/^-?\d+$/.test(draft.trim())) return undefined;
      const n = Number(draft.trim());
      return n >= schema.min && n <= schema.max ? n : undefined;
    }
    case 'number': {
      const n = Number(draft.trim());
      return draft.trim() !== '' && Number.isFinite(n) && n >= schema.min && n <= schema.max ? n : undefined;
    }
    case 'boolean':
      return draft === 'true' ? true : draft === 'false' ? false : undefined;
    case 'string':
      return draft.length <= schema.maxLength ? draft : undefined;
    case 'enum':
      return schema.values.includes(draft) ? draft : undefined;
  }
}

let keySeq = 0;
const newKey = () => `ws-setting-${Date.now().toString(36)}-${(keySeq += 1)}`;

export function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const { t, locale } = useI18n();
  const client = useClient();
  const caps = useCapabilities();
  const format = useFormat();
  const headingId = useId();
  const [settings, setSettings] = useState<SettingView[] | null>(null);
  const [loadError, setLoadError] = useState<Err | null>(null);
  const [editing, setEditing] = useState<SettingView | null>(null);

  const load = useCallback(async () => {
    const { body } = await client.call('settings_list', { workspaceId });
    if (isErr(body)) {
      setLoadError(body);
      return;
    }
    setLoadError(null);
    setSettings((body as unknown as { settings: SettingView[] }).settings);
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loadError !== null) {
    return (
      <section className="panel setup-panel ws-settings" aria-labelledby={headingId}>
        <h2 id={headingId} className="setup-panel-title">
          {t('workspaceSettings.title')}
        </h2>
        <ErrorBanner error={loadError} context="read" onRetry={() => void load()} />
      </section>
    );
  }
  if (settings === null || settings.length === 0) return null;

  return (
    <section className="panel setup-panel ws-settings" aria-labelledby={headingId}>
      <h2 id={headingId} className="setup-panel-title">
        {t('workspaceSettings.title')}
      </h2>
      {groupSettings(settings).map((group) => (
        <div key={group.id} className="ws-settings-group" role="group" aria-label={textOf(group.label, locale)}>
          <h3 className="ws-settings-group-title">{textOf(group.label, locale)}</h3>
          <ul className="ws-settings-list">
            {group.settings.map((s) => {
              const label = textOf(s.label, locale);
              const canEdit = caps.can(s.owningCapability);
              return (
                <li key={s.key} className="ws-settings-row" data-key={s.key}>
                  <div className="ws-settings-text">
                    <span className="ws-settings-label">{label}</span>
                    <IconButton icon="info" small context={textOf(s.description, locale)} />
                  </div>
                  <div className="ws-settings-value">
                    <span className="ws-settings-current">{format(s.schema, s.value)}</span>
                    <span className="ws-settings-default">
                      {s.overridden ? t('workspaceSettings.defaultIs', { value: format(s.schema, s.default) }) : t('workspaceSettings.isDefault')}
                    </span>
                    {canEdit && <IconButton icon="edit" small context={label} onClick={() => setEditing(s)} />}
                  </div>
                  {s.stale === true && (
                    <p className="status-line ws-settings-stale" role="status">
                      {t('workspaceSettings.stale', { stored: s.ignoredStoredValue ?? '', value: format(s.schema, s.default) })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {editing !== null && (
        <EditSetting
          workspaceId={workspaceId}
          setting={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function EditSetting({
  workspaceId,
  setting,
  onClose,
  onSaved,
}: {
  workspaceId: string;
  setting: SettingView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, locale } = useI18n();
  const client = useClient();
  const format = useFormat();
  const ids = { value: useId(), reason: useId(), hint: useId(), body: useId() };
  const [draft, setDraft] = useState(String(setting.value));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Err | null>(null);
  const parsed = parseDraft(setting.schema, draft);
  const reasonOk = reason.trim().length > 0;
  const changed = parsed !== undefined && parsed !== setting.value;
  const label = textOf(setting.label, locale);

  async function write(verb: 'settings_set' | 'settings_reset') {
    setBusy(true);
    const input: Record<string, unknown> = { workspaceId, key: setting.key, reason: reason.trim(), idempotencyKey: newKey() };
    if (verb === 'settings_set') input.value = parsed;
    const { body } = await client.call(verb, input);
    setBusy(false);
    if (isErr(body)) {
      setError(body);
      return;
    }
    onSaved();
  }

  const schema = setting.schema;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('workspaceSettings.editTitle', { setting: label })}
      closeLabel={t('workspaceSettings.cancel')}
      describedById={ids.body}
      footer={
        <>
          {(setting.overridden || setting.stale === true) && (
            <button type="button" className="btn btn--secondary" disabled={!reasonOk || busy} onClick={() => void write('settings_reset')}>
              {t('workspaceSettings.reset', { value: format(schema, setting.default) })}
            </button>
          )}
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            {t('workspaceSettings.cancel')}
          </button>
          <button type="button" className="btn btn--primary" disabled={!changed || !reasonOk || busy} onClick={() => void write('settings_set')}>
            {t('workspaceSettings.save')}
          </button>
        </>
      }
    >
      <div className="form-stack">
        <p id={ids.body} className="ws-settings-help">
          {textOf(setting.description, locale)} {t('workspaceSettings.consequence')}
        </p>
        <div className="form-row">
          <label htmlFor={ids.value}>{t('workspaceSettings.value')}</label>
          {schema.type === 'boolean' || schema.type === 'enum' ? (
            <Select
              id={ids.value}
              value={draft}
              onChange={setDraft}
              options={
                schema.type === 'boolean'
                  ? [
                      { value: 'true', label: t('workspaceSettings.yes') },
                      { value: 'false', label: t('workspaceSettings.no') },
                    ]
                  : schema.values.map((v) => ({ value: v, label: v }))
              }
            />
          ) : (
            <input
              id={ids.value}
              className="field"
              inputMode={schema.type === 'string' ? undefined : 'numeric'}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              aria-invalid={parsed === undefined || undefined}
              aria-describedby={ids.hint}
            />
          )}
          {(schema.type === 'integer' || schema.type === 'number') && (
            <p id={ids.hint} className="field-hint">
              {t('workspaceSettings.bounds', { min: String(schema.min), max: String(schema.max), value: format(schema, setting.default) })}
            </p>
          )}
        </div>
        <div className="form-row">
          <label htmlFor={ids.reason}>{t('workspaceSettings.reason')}</label>
          <textarea id={ids.reason} className="field" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required />
        </div>
        {error !== null && (
          <p className="status-line status-error" role="alert">
            {refusalText(t, error, { own: 'workspaceSettings.refusal', params: refusalFacts(error) })}
          </p>
        )}
      </div>
    </Modal>
  );
}
