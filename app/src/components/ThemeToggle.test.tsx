/**
 * ThemeToggle, the icon-only light/dark switch in the rail.
 *
 * Asserted: the accessible name comes from `theme.toggle` (de-CH `Design wechseln`, en
 * `Switch colour scheme`), `aria-pressed` exposes the dark state, a click flips it and sets
 * `data-theme` on the document root, the glyph is decorative, and axe is clean in both themes.
 * State is reset between tests (prefs module, `data-theme`, `matchMedia`) so run order is irrelevant.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';

import { I18nProvider, type Locale } from '../i18n';
import { ThemeProvider, type Theme } from '../app/theme';
import { resetPrefsModuleForTests } from '../lib/prefs';
import { ThemeToggle } from './ThemeToggle';

/** A matchMedia mock that never prefers dark, so nothing leaks in from the OS or an earlier test. */
function mockMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderToggle(theme: Theme, locale?: Locale) {
  return render(
    <I18nProvider initialLocale={locale}>
      <ThemeProvider initialTheme={theme}>
        <ThemeToggle />
      </ThemeProvider>
    </I18nProvider>,
  );
}

describe('ThemeToggle', () => {
  beforeEach(() => {
    resetPrefsModuleForTests();
    document.documentElement.removeAttribute('data-theme');
    mockMatchMedia();
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'matchMedia');
  });

  it('is named "Design wechseln" and not pressed in light mode', () => {
    renderToggle('light');
    const button = screen.getByRole('button', { name: 'Design wechseln' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('is pressed in dark mode', () => {
    renderToggle('dark');
    const button = screen.getByRole('button', { name: 'Design wechseln' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('flips aria-pressed and data-theme on click, in both directions', async () => {
    renderToggle('light');
    const button = screen.getByRole('button', { name: 'Design wechseln' });

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');

    await userEvent.click(button);
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('is named "Switch colour scheme" in English', () => {
    renderToggle('light', 'en');
    expect(screen.getByRole('button', { name: 'Switch colour scheme' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Design wechseln' })).toBeNull();
  });

  it('keeps the glyph decorative, and swaps it with the theme', () => {
    const { container, unmount } = renderToggle('light');
    const lightSvg = container.querySelector('button svg');
    expect(lightSvg).not.toBeNull();
    expect(lightSvg).toHaveAttribute('aria-hidden', 'true');
    const lightMarkup = lightSvg?.outerHTML;
    unmount();

    const dark = renderToggle('dark');
    const darkSvg = dark.container.querySelector('button svg');
    expect(darkSvg).toHaveAttribute('aria-hidden', 'true');
    // The sun (dark mode) and the moon (light mode) are different shapes.
    expect(darkSvg?.outerHTML).not.toBe(lightMarkup);
  });

  it.each(['light', 'dark'] as const)('has no axe violations in the %s theme', async (theme: Theme) => {
    const { container } = renderToggle(theme);
    const results = await axe(container, {
      rules: { region: { enabled: false }, 'page-has-heading-one': { enabled: false } },
    });
    expect(results).toHaveNoViolations();
  });
});
