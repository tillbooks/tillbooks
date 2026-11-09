/**
 * A41.7 (D184 point 6): the ONE question an ask-first setting asks before its default takes effect. A small
 * inline group (never a dialog): the question, the quick choices with the registry's suggestion pre-selected,
 * an optional own number, and Speichern, which answers it with `settings_set` (a person's act: the engine
 * refuses an agent seat `human_only`). Used by the pick bar (`bank.bulk_learned_min`) and the rule card
 * (`rules.autobook_offer_after`).
 */
import { useId, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';

export interface AskFirstChoice {
  value: number;
  label: string;
}

export interface AskFirstQuestionProps {
  workspaceId: string;
  settingKey: string;
  question: string;
  choices: readonly AskFirstChoice[];
  /** The suggestion pre-selected (the registry default). */
  preselect: number;
  /** Offer an own number within these bounds (absent: no own number). */
  own?: { min: number; max: number; label: string; ownLabel: string };
  saveLabel: string;
  failedLabel: string;
  onAnswered: (value: number) => void;
}

export function AskFirstQuestion({ workspaceId, settingKey, question, choices, preselect, own, saveLabel, failedLabel, onAnswered }: AskFirstQuestionProps) {
  const client = useClient();
  const baseId = useId();
  const [picked, setPicked] = useState<string>(String(preselect));
  const [ownValue, setOwnValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const value = picked === 'own' ? Number.parseInt(ownValue, 10) : Number(picked);
  const valid = Number.isSafeInteger(value) && (picked !== 'own' || (own !== undefined && value >= own.min && value <= own.max));

  const save = async () => {
    if (!valid) return;
    setBusy(true);
    setFailed(false);
    const { body } = await client.call('settings_set', { workspaceId, key: settingKey, value, reason: question, idempotencyKey: crypto.randomUUID() });
    setBusy(false);
    if (isErr(body)) {
      setFailed(true);
      return;
    }
    onAnswered(value);
  };

  return (
    <fieldset className="bank-askfirst" data-setting={settingKey}>
      <legend id={`${baseId}-q`} className="bank-askfirst__question">
        {question}
      </legend>
      <span className="bank-askfirst__choices">
        {choices.map((c) => (
          <label key={c.value} className="bank-askfirst__choice">
            <input type="radio" name={`${baseId}-choice`} value={String(c.value)} checked={picked === String(c.value)} onChange={() => setPicked(String(c.value))} />
            {c.label}
          </label>
        ))}
        {own !== undefined && (
          <label className="bank-askfirst__choice">
            <input type="radio" name={`${baseId}-choice`} value="own" checked={picked === 'own'} onChange={() => setPicked('own')} />
            {own.label}
          </label>
        )}
        {own !== undefined && picked === 'own' && (
          <input
            type="number"
            inputMode="numeric"
            className="field bank-askfirst__own t-num"
            aria-label={own.ownLabel}
            min={own.min}
            max={own.max}
            value={ownValue}
            onChange={(e) => setOwnValue(e.target.value)}
          />
        )}
      </span>
      <button type="button" className="btn btn--secondary btn--sm" disabled={busy || !valid} onClick={() => void save()}>
        {saveLabel}
      </button>
      {failed && (
        <span className="bank-askfirst__error" role="alert">
          {failedLabel}
        </span>
      )}
    </fieldset>
  );
}
