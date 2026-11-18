/**
 * D208 (D172): the three settings of the calm Vorschlag rows, read once per workspace. Until the answer lands,
 * and for any value this build cannot read, each takes its default: `attention.row_hints` `missing`,
 * `attention.undo_seconds` 10, `attention.keys` on. None of them changes what a click books.
 */
import { useEffect, useState } from 'react';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';

export interface AttentionSettings {
  rowHints: 'missing' | 'none';
  undoSeconds: number;
  keys: boolean;
}

export const ATTENTION_DEFAULTS: AttentionSettings = { rowHints: 'missing', undoSeconds: 10, keys: true };

export function useAttentionSettings(workspaceId: string | null): AttentionSettings {
  const client = useClient();
  const [settings, setSettings] = useState<AttentionSettings>(ATTENTION_DEFAULTS);
  useEffect(() => {
    setSettings(ATTENTION_DEFAULTS);
    if (workspaceId === null) return undefined;
    let live = true;
    const read = async (key: string): Promise<unknown> => {
      try {
        const res = await client.call('settings_get', { workspaceId, key });
        if (isErr(res.body)) return undefined;
        return (res.body as { setting?: { value?: unknown } }).setting?.value;
      } catch {
        return undefined;
      }
    };
    void Promise.all([read('attention.row_hints'), read('attention.undo_seconds'), read('attention.keys')]).then(([hints, seconds, keys]) => {
      if (!live) return;
      setSettings({
        rowHints: hints === 'none' ? 'none' : 'missing',
        undoSeconds: typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 && seconds <= 60 ? seconds : ATTENTION_DEFAULTS.undoSeconds,
        keys: keys !== false,
      });
    });
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  return settings;
}
