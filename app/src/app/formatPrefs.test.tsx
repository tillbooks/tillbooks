/**
 * D195: `FormatPrefsStamp` hands the person's `appearance.date_format` and `appearance.amount_sign` to the plain
 * formatters, and the defaults (ch, plus_minus) are what a person without a choice sees.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { PrefsProvider, PrefsStore } from '../lib/prefs';
import { TillClientProvider } from '../lib/client-context';
import { TillClient, type Transport } from '../lib/client';
import { WorkspaceProvider } from './workspace';
import { formatDate, formatMoney, resetFormatPrefs } from '../i18n';
import { FormatPrefsStamp } from './formatPrefs';

const NOTHING: Transport = async () => ({ status: 404, body: { ok: false, error: 'unknown_action' } });

function withPrefs(seed: Record<string, string>) {
  return render(
    <TillClientProvider client={new TillClient(NOTHING)}>
      <WorkspaceProvider initialId="ws_test">
        <PrefsProvider store={storeWith(seed)}>
          <FormatPrefsStamp />
        </PrefsProvider>
      </WorkspaceProvider>
    </TillClientProvider>,
  );
}

function storeWith(seed: Record<string, string>): PrefsStore {
  const store = new PrefsStore(null, null, { useCache: false });
  for (const [key, value] of Object.entries(seed)) store.seed(key, value);
  return store;
}

afterEach(() => resetFormatPrefs());

describe('FormatPrefsStamp (D195)', () => {
  it('the defaults: 31.12.2026 and a plus before money in', () => {
    withPrefs({});
    expect(formatDate('2026-12-31')).toBe('31.12.2026');
    expect(formatMoney(2375, 'CHF', { signed: true })).toBe('CHF +23.75');
  });

  it('the person chose iso and minus_only: every formatter follows', () => {
    withPrefs({ 'appearance.date_format': 'iso', 'appearance.amount_sign': 'minus_only' });
    expect(formatDate('2026-12-31')).toBe('2026-12-31');
    expect(formatMoney(2375, 'CHF', { signed: true })).toBe('CHF 23.75');
    expect(formatMoney(-2375, 'CHF', { signed: true })).toBe('CHF −23.75');
  });
});
