/**
 * The copy affordance, and the one thing it must never do: claim a copy it did not make.
 *
 * `navigator.clipboard` is absent outside a secure context and can be refused by permission. A
 * button that flashes "Kopiert" over an empty clipboard sends someone to paste a payment reference
 * into e-banking that is not there, which is worse than no button.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { I18nProvider } from '../i18n';
import { CopyButton } from './CopyButton';

function renderCopy(value = '210000000003139471430009017') {
  return render(
    <I18nProvider>
      <CopyButton value={value} label="Referenz kopieren" />
    </I18nProvider>,
  );
}

/** Replace the clipboard for one test. jsdom ships none, so this is a define, not an override. */
function stubClipboard(clipboard: unknown) {
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

afterEach(() => {
  stubClipboard(undefined);
});

describe('CopyButton', () => {
  it('copies the exact value and confirms on the control itself', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard({ writeText });
    renderCopy();

    // Resting state: the caller's accessible name, so a screen reader hears what gets copied.
    await userEvent.click(screen.getByRole('button', { name: 'Referenz kopieren' }));

    expect(writeText).toHaveBeenCalledWith('210000000003139471430009017');
    expect(await screen.findByRole('button', { name: 'Kopiert' })).toBeInTheDocument();
  });

  it('says so when there is no clipboard, instead of claiming a copy', async () => {
    stubClipboard(undefined);
    renderCopy();
    await userEvent.click(screen.getByRole('button', { name: 'Referenz kopieren' }));

    expect(await screen.findByRole('button', { name: 'Kopieren geht hier nicht' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kopiert' })).not.toBeInTheDocument();
  });

  it('says so when the clipboard write is refused, instead of claiming a copy', async () => {
    stubClipboard({ writeText: vi.fn().mockRejectedValue(new Error('NotAllowedError')) });
    renderCopy();
    await userEvent.click(screen.getByRole('button', { name: 'Referenz kopieren' }));

    expect(await screen.findByRole('button', { name: 'Kopieren geht hier nicht' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kopiert' })).not.toBeInTheDocument();
  });
});
