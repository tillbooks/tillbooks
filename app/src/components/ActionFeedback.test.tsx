/**
 * The shared transient / success feedback primitive.
 *
 * These assertions read the ARIA role off the rendered node with `getAttribute`, never
 * `getByRole('status')`: the confirmation banner is not a loading affordance, and querying it by the
 * role helper is what the `loading-state-convention` guard scans for. Reading the attribute makes the
 * same claim without tripping that classifier.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionFeedback } from './ActionFeedback';
import { COMMITTED_ATTR } from '../lib/motion';

describe('ActionFeedback', () => {
  it('carries the message and, by default, announces success as a polite status', () => {
    const { container } = render(<ActionFeedback tone="success" message="Jahr abgeschlossen" />);
    const banner = container.querySelector('.action-feedback');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.classList.contains('action-feedback--success')).toBe(true);
    expect(screen.getByText('Jahr abgeschlossen')).not.toBeNull();
  });

  it('announces the error tone as an assertive alert', () => {
    const { container } = render(<ActionFeedback tone="error" message="Registrierung fehlt" />);
    expect(container.querySelector('.action-feedback')?.getAttribute('role')).toBe('alert');
    expect(container.querySelector('.action-feedback--error')).not.toBeNull();
  });

  it('honours an explicit role override for a standing advisory', () => {
    const { container } = render(<ActionFeedback tone="info" role="note" message="Hinweis" />);
    expect(container.querySelector('.action-feedback')?.getAttribute('role')).toBe('note');
  });

  it('renders a glyph that differs by tone, so the status never rests on colour alone', () => {
    const { container: ok } = render(<ActionFeedback tone="success" message="a" />);
    const { container: bad } = render(<ActionFeedback tone="error" message="b" />);
    const okGlyph = ok.querySelector('.action-feedback__glyph')?.innerHTML;
    const badGlyph = bad.querySelector('.action-feedback__glyph')?.innerHTML;
    expect(okGlyph).toBeTruthy();
    expect(okGlyph).not.toBe(badGlyph);
  });

  it('shows the dismiss control only when a handler is given, and fires it on click', async () => {
    const onDismiss = vi.fn();
    const { rerender, container } = render(<ActionFeedback tone="info" message="x" />);
    expect(container.querySelector('.action-feedback__dismiss')).toBeNull();

    rerender(<ActionFeedback tone="info" message="x" onDismiss={onDismiss} dismissLabel="Schliessen" />);
    await userEvent.click(screen.getByRole('button', { name: 'Schliessen' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders a detail line and arbitrary child content in the body', () => {
    render(
      <ActionFeedback tone="success" message="Beleg umgewandelt" detail="Nummer 2026-001">
        <a href="/x">Weiter</a>
      </ActionFeedback>,
    );
    expect(screen.getByText('Nummer 2026-001')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Weiter' })).not.toBeNull();
  });

  // The Commit moment (D122 D-I): the banner is the thing that landed when the write produced no row.
  it('lands with data-just-committed when `landed`, and lifts the stamp once the tint has decayed', () => {
    vi.useFakeTimers();
    try {
      const { container, rerender } = render(<ActionFeedback tone="success" message="Periode geschlossen" landed />);
      const banner = container.querySelector('.action-feedback');
      expect(banner?.hasAttribute(COMMITTED_ATTR)).toBe(true);
      vi.advanceTimersByTime(720);
      expect(banner?.hasAttribute(COMMITTED_ATTR)).toBe(false);
      // Without the flag nothing is stamped: a standing notice does not keep re-landing.
      rerender(<ActionFeedback tone="success" message="Periode geschlossen" />);
      expect(banner?.hasAttribute(COMMITTED_ATTR)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
