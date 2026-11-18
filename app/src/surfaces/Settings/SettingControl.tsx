/**
 * D202: ONE CONTROL PER SETTING, chosen by the value's shape (G00 §11.7), saved on change.
 *
 *  - a boolean, or an enum whose two values are on and off: a switch;
 *  - an enum of two to four values whose every label fits its share of 240px uncut, in both locales
 *    (`SEGMENT_MAX_CHARS`): the shared `Segmented`;
 *  - any other enum: the shared `Select`, opening below its trigger;
 *  - an integer or a number: a number field with its unit, committed on Enter or on leaving it;
 *  - a text: a text field, committed the same way;
 *  - `agent.settings_sections`: ONE shared multi-select of the ten areas ("6 von 10"; the owner's pick A of
 *    the redesign, 18.11.2026, replaced ten bordered toggles and the per-area switch in the page head);
 *  - a text whose values have words (`agent.owner_word_excluded`, a list of dial families, D209): the same
 *    shared multi-select, the chosen names on the trigger, `none` stored when nothing is chosen.
 * The raw value never shows: every enum value arrives in words from the engine's presentation.
 *
 * Every control fits the row's one 240px column (DESIGN.md, Settings): Segmented and Select exactly 240px,
 * a number field 72px with its unit before it, a switch at the right edge, a text field 240px.
 */
import { useEffect, useState, type KeyboardEvent } from 'react';

import { Segmented } from '../../components/Segmented';
import { MultiSelect, Select } from '../../components/Select';
import { SET_NONE, textOf, type Locale, type SettingEntryView, type SettingSchema, type SettingValue, type SettingsAreaEntry } from '../../lib/settings-index';
import { useT } from '../../i18n';

/**
 * The longest option label a segment of the 240px column carries WITHOUT cutting it, at 13px, by the
 * number of options (the coordinator's check of 18.11.2026 found "Nur Ba…" and "Regel zuerst z…"). Measured
 * on the de-CH AND the en labels, so a switch of language never turns a whole label into a cut one. More
 * options, or a longer label, take the shared Select. An option text is never truncated.
 */
const SEGMENT_MAX_CHARS: Readonly<Record<number, number>> = { 2: 14, 3: 9, 4: 6 };

export type ControlShape = 'switch' | 'segmented' | 'select' | 'number' | 'text' | 'areas' | 'set';

export function shapeOf(s: Pick<SettingEntryView, 'key' | 'schema' | 'presentation'>, _locale?: Locale): ControlShape {
  if (s.key === 'agent.settings_sections') return 'areas';
  const schema = s.schema;
  if (schema.type === 'boolean') return 'switch';
  if (schema.type === 'enum') {
    const v = [...schema.values].sort();
    if (v.length === 2 && v[0] === 'off' && v[1] === 'on') return 'switch';
    const max = SEGMENT_MAX_CHARS[schema.values.length];
    if (max === undefined) return 'select';
    const fits = schema.values.every((value) =>
      (['de-CH', 'en'] as const).every((l) => (textOf(s.presentation.valueLabels?.[value], l) || value).length <= max),
    );
    return fits ? 'segmented' : 'select';
  }
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (schema.type === 'string' && s.presentation.valueLabels !== undefined) return 'set';
  return 'text';
}

/** The typed draft parsed against the schema; undefined while it does not fit. */
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

export interface SettingControlProps {
  setting: SettingEntryView;
  /** The value shown (the pending one while a write is in flight). */
  value: SettingValue;
  areas: readonly SettingsAreaEntry[];
  labelId: string;
  disabled: boolean;
  locale: Locale;
  onChange: (next: SettingValue) => void;
}

export function SettingControl({ setting, value, areas, labelId, disabled, locale, onChange }: SettingControlProps) {
  const t = useT();
  const shape = shapeOf(setting, locale);
  const schema = setting.schema;
  const label = textOf(setting.presentation.label, locale);

  if (shape === 'switch') {
    const on = schema.type === 'boolean' ? value === true : value === 'on';
    const next: SettingValue = schema.type === 'boolean' ? !on : on ? 'off' : 'on';
    return (
      <button
        type="button"
        role="switch"
        className="settings-switch"
        aria-checked={on}
        aria-labelledby={labelId}
        disabled={disabled}
        onClick={() => onChange(next)}
      >
        <span className="settings-switch-knob" aria-hidden="true" />
      </button>
    );
  }

  if (shape === 'segmented' || shape === 'select') {
    const values = schema.type === 'enum' ? schema.values : [];
    const options = values.map((v) => ({ value: v, label: textOf(setting.presentation.valueLabels?.[v], locale) || v }));
    const current = String(value);
    return shape === 'segmented' ? (
      <Segmented className="settings-segmented" options={options} value={current} onChange={(v) => onChange(v)} labelledBy={labelId} disabled={disabled} />
    ) : (
      <Select className="settings-select" value={current} options={options} onChange={(v) => onChange(v)} ariaLabel={label} disabled={disabled} />
    );
  }

  if (shape === 'areas') {
    const chosen = String(value).split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    const known = chosen.filter((id) => areas.some((a) => a.id === id));
    return (
      <MultiSelect
        className="settings-select"
        values={known}
        options={areas.map((a) => ({ value: a.id, label: textOf(a.label, locale) }))}
        onChange={(next) => onChange(next.join(','))}
        ariaLabel={label}
        displayLabel={t('settingsHub.areasChosen', { n: String(known.length), total: String(areas.length) })}
        disabled={disabled}
      />
    );
  }

  if (shape === 'set') {
    const labels = setting.presentation.valueLabels ?? {};
    const chosen = String(value).split(',').map((x) => x.trim()).filter((x) => x.length > 0 && x !== SET_NONE && labels[x] !== undefined);
    return (
      <MultiSelect
        className="settings-select"
        values={chosen}
        options={Object.entries(labels).map(([id, l]) => ({ value: id, label: textOf(l, locale) }))}
        // A list of named values stores `none` when nothing is chosen (the settings verbs refuse an empty value).
        onChange={(next) => onChange(next.length === 0 ? SET_NONE : next.join(','))}
        ariaLabel={label}
        placeholder={t('settingsHub.noneChosen')}
        disabled={disabled}
      />
    );
  }

  return <TypedField setting={setting} value={value} labelId={labelId} disabled={disabled} onChange={onChange} unitLabel={unitWord(schema, t)} />;
}

function unitWord(schema: SettingSchema, t: (key: string) => string): string {
  if (schema.type !== 'integer' || schema.unit === undefined || schema.unit === 'items') return '';
  return t(`settingsHub.unit.${schema.unit}`);
}

function TypedField({
  setting,
  value,
  labelId,
  disabled,
  onChange,
  unitLabel,
}: {
  setting: SettingEntryView;
  value: SettingValue;
  labelId: string;
  disabled: boolean;
  onChange: (next: SettingValue) => void;
  unitLabel: string;
}) {
  const t = useT();
  const schema = setting.schema;
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const parsed = parseDraft(schema, draft);
  const numeric = schema.type === 'integer' || schema.type === 'number';
  const bounds = numeric ? t('settingsHub.bounds', { min: String(schema.min), max: String(schema.max) }) : undefined;

  const commit = () => {
    if (parsed === undefined) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onChange(parsed);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') commit();
    if (event.key === 'Escape') setDraft(String(value));
  };
  return (
    <span className="settings-typed">
      {unitLabel !== '' && <span className="settings-unit">{unitLabel}</span>}
      <input
        className={numeric ? 'field settings-number' : 'field settings-text'}
        inputMode={numeric ? 'numeric' : undefined}
        value={draft}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-invalid={parsed === undefined || undefined}
        title={bounds}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
      />
    </span>
  );
}
