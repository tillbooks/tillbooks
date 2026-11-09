/**
 * The composer's balance figure takes the Commit moment's tint when its value changes (D122 D-I): the
 * stamp the shared CSS keys on, set by `commitAck`, and never on the first render. The stylesheet keeps
 * the tint and drops the landing, so the figure neither rolls nor shifts.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, waitFor } from '@testing-library/react';

import { I18nProvider } from '../../i18n';
import { BalanceStatus } from './ComposerParts';

function status(debitTotal: number, creditTotal: number) {
  return (
    <I18nProvider>
      <BalanceStatus debitTotal={debitTotal} creditTotal={creditTotal} currency="CHF" />
    </I18nProvider>
  );
}

describe('BalanceStatus, the changed figure', () => {
  it('an entry opened in balance tints nothing: the first render is not a change', () => {
    const { container } = render(status(12_000, 12_000));
    expect(container.querySelector('.journal-balance--ok')).not.toHaveAttribute('data-just-committed');
  });

  it('under StrictMode (as main.tsx renders) an entry opened in balance still tints nothing: the doubled mount effect is not a change', () => {
    const { container } = render(<StrictMode>{status(12_000, 12_000)}</StrictMode>);
    expect(container.querySelector('.journal-balance--ok')).not.toHaveAttribute('data-just-committed');
  });

  it('a keystroke that moves the difference tints the figure, and coming into balance tints it again', async () => {
    const { container, rerender } = render(status(0, 0));
    expect(container.querySelector('.journal-balance')).toBeNull();
    rerender(status(12_000, 0));
    expect(container.querySelector('.journal-balance--off')).toHaveAttribute('data-just-committed');
    await waitFor(() => expect(container.querySelector('[data-just-committed]')).toBeNull(), { timeout: 2000 });
    rerender(status(12_000, 12_000));
    expect(container.querySelector('.journal-balance--ok')).toHaveAttribute('data-just-committed');
  });

  it('totals that move without moving the difference are not a changed figure', () => {
    const { container, rerender } = render(status(12_000, 0));
    // Both sides grew by the same amount: the difference the person reads is still CHF 120.00.
    rerender(status(13_000, 1_000));
    expect(container.querySelector('.journal-balance--off')).not.toHaveAttribute('data-just-committed');
  });

  it('a second change inside the tint restarts it: the stamp is lifted and a style flush forced before it is set again', () => {
    const { container, rerender } = render(status(0, 0));
    rerender(status(12_000, 0));
    const figure = container.querySelector('.journal-balance--off') as HTMLElement;
    expect(figure).toHaveAttribute('data-just-committed');
    const flush = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
    const seen: boolean[] = [];
    flush.mockImplementation(function (this: HTMLElement) {
      seen.push(this.hasAttribute('data-just-committed'));
      return 0;
    });
    try {
      rerender(status(12_000, 2_000));
    } finally {
      flush.mockRestore();
    }
    // The flush ran with the stamp OFF, so the style engine saw it lift, and the stamp is back on.
    expect(seen).toContain(false);
    expect(figure).toHaveAttribute('data-just-committed');
  });

  it('the stylesheet keeps the tint and drops the landing', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Journal.css'), 'utf8');
    const rule = /\.journal-balance\[data-just-committed\]\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toMatch(/animation:\s*motion-tint var\(--t-motion-tint\) var\(--t-ease-out\)/);
    expect(rule).not.toMatch(/motion-land/);
  });
});
