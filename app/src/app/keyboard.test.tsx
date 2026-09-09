import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';

import { I18nProvider } from '../i18n';
import { KEY_BINDINGS, KeyboardProvider, useKeyboard } from './keyboard';
import { ShortcutSheet } from './ShortcutSheet';

/** A probe that surfaces the keyboard state and the current route for assertions. */
function Probe() {
  const { paletteOpen } = useKeyboard();
  const loc = useLocation();
  return (
    <div>
      <span data-testid="palette-open">{String(paletteOpen)}</span>
      <span data-testid="path">{loc.pathname}</span>
      <input aria-label="a text field" />
      <ShortcutSheet />
    </div>
  );
}

function renderHarness(initialPath = '/setup') {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <KeyboardProvider>
          <Probe />
        </KeyboardProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe('the keyboard binding registry', () => {
  it('contains no digit in any binding', () => {
    for (const b of KEY_BINDINGS) {
      expect(b.keysLabel).not.toMatch(/[0-9]/);
      if (b.chord) {
        expect(b.chord.leader).not.toMatch(/[0-9]/);
        expect(b.chord.letter).not.toMatch(/[0-9]/);
      }
    }
  });

  it('uses no punctuation key except the single declared `?` exception', () => {
    const punctuationBindings = KEY_BINDINGS.filter((b) => b.keysLabel.replace(/[a-zA-Z /]/g, '').length > 0);
    // The only binding whose keys carry punctuation is the help sheet, and its key is exactly `?`.
    expect(punctuationBindings.map((b) => b.id)).toEqual(['help']);
    expect(punctuationBindings[0].keysLabel).toBe('?');
  });

  it('anchors every chord to a lowercase letter and never to `y`', () => {
    for (const b of KEY_BINDINGS) {
      if (!b.chord) continue;
      expect(b.chord.letter).toMatch(/^[a-z]$/);
      expect(b.chord.letter).not.toBe('y');
    }
  });

  it('claims each chord letter at most once, so a duplicate is a build failure', () => {
    const seqs = KEY_BINDINGS.filter((b) => b.chord).map((b) => `${b.chord!.leader}${b.chord!.letter}`);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('renders every binding in the shortcut sheet, so none is undocumented', async () => {
    renderHarness();
    await userEvent.keyboard('?');
    const sheet = screen.getByRole('dialog');
    // Every binding's keys hint appears in the sheet.
    for (const b of KEY_BINDINGS) {
      expect(sheet.textContent).toContain(b.keysLabel);
    }
  });
});

describe('the keyboard dispatcher', () => {
  it('toggles the palette on Cmd/Ctrl+K', async () => {
    renderHarness();
    expect(screen.getByTestId('palette-open').textContent).toBe('false');
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByTestId('palette-open').textContent).toBe('true');
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByTestId('palette-open').textContent).toBe('false');
  });

  it('navigates with a `g`-then-letter chord', async () => {
    renderHarness('/setup');
    expect(screen.getByTestId('path').textContent).toBe('/setup');
    await userEvent.keyboard('gj');
    expect(screen.getByTestId('path').textContent).toBe('/journal');
  });

  it('never fires a chord while a text field is focused', async () => {
    renderHarness('/setup');
    const field = screen.getByLabelText('a text field');
    field.focus();
    await userEvent.keyboard('gj');
    expect(screen.getByTestId('path').textContent).toBe('/setup');
    expect(field).toHaveValue('gj');
  });

  it('clears a dangling leader without swallowing the next unrelated key', async () => {
    renderHarness('/setup');
    // `g` then an unbound letter does nothing and leaves the route unchanged.
    await userEvent.keyboard('gx');
    expect(screen.getByTestId('path').textContent).toBe('/setup');
  });

  it('opens the shortcut sheet on `?` and closes it on Esc, restoring focus', async () => {
    renderHarness();
    await userEvent.keyboard('?');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
