import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { IconButton } from './IconButton';
import { VOCABULARY } from './icons';
import { LONG_PRESS_MS } from './Tooltip';

describe('IconButton (Ruhig 3, D154)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is named by its vocabulary entry and described by its context, never the name twice', () => {
    render(<IconButton icon="attach" context="Beleg zu dieser Buchung" onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'Anhängen' });
    expect(button).toHaveAccessibleDescription('Beleg zu dieser Buchung');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).not.toHaveAttribute('title');
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Anhängen');
    expect(tip).toHaveTextContent('Beleg zu dieser Buchung');
    // The glyph is decoration: the button carries the meaning.
    expect(button.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('shows its tooltip on hover and on keyboard focus, and Escape dismisses it', () => {
    render(<IconButton icon="close" context="Ohne Buchen" onClick={() => {}} />);
    const button = screen.getByRole('button', { name: 'Schliessen' });
    const tip = screen.getByRole('tooltip');
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(tip).toHaveClass('is-open', 'is-hoverable');
    fireEvent.pointerLeave(button, { pointerType: 'mouse' });
    expect(tip).not.toHaveClass('is-open');
    fireEvent.focus(button);
    expect(tip).toHaveClass('is-open');
    fireEvent.keyDown(button, { key: 'Escape' });
    expect(tip).not.toHaveClass('is-open');
  });

  it('opens on a 450ms touch long press, and the click that ends it does not act', () => {
    const onClick = vi.fn();
    render(<IconButton icon="copy" context="Als neuen Entwurf" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Kopieren' });
    const tip = screen.getByRole('tooltip');

    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1));
    expect(tip).not.toHaveClass('is-open');
    act(() => vi.advanceTimersByTime(1));
    expect(tip).toHaveClass('is-open');

    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.click(button, { detail: 1 });
    expect(onClick).not.toHaveBeenCalled();

    // It lingers long enough to read, then goes.
    expect(tip).toHaveClass('is-open');
    act(() => vi.advanceTimersByTime(2000));
    expect(tip).not.toHaveClass('is-open');

    // The next ordinary tap acts.
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.click(button, { detail: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a short tap acts and opens nothing; a drifting finger is a scroll, not a long press', () => {
    const onClick = vi.fn();
    render(<IconButton icon="flag" context="Für den Zahlungslauf" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Markieren' });
    const tip = screen.getByRole('tooltip');

    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    fireEvent.click(button, { detail: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(tip).not.toHaveClass('is-open');

    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 10, clientY: 10 });
    fireEvent.pointerMove(button, { pointerType: 'touch', clientX: 10, clientY: 30 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(tip).not.toHaveClass('is-open');
  });

  it('a long press abandoned without a click does not swallow the next mouse click', () => {
    const onClick = vi.fn();
    render(<IconButton icon="download" context="CSV" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Herunterladen' });
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerCancel(button, { pointerType: 'touch' });
    fireEvent.pointerDown(button, { pointerType: 'mouse', clientX: 0, clientY: 0 });
    fireEvent.click(button, { detail: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a keyboard or assistive-technology click is never swallowed, even straight after a long press', () => {
    const onClick = vi.fn();
    render(<IconButton icon="edit" context="Entwurf" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Bearbeiten' });
    // A long press the platform ends with no click (Android turns it into a context-menu gesture).
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    // Enter, Space and a screen reader's click action arrive as a click with detail 0.
    fireEvent.click(button, { detail: 0 });
    expect(onClick).toHaveBeenCalledTimes(1);
    // And long after the lift, even a pointer click acts.
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    fireEvent.pointerUp(button, { pointerType: 'touch' });
    act(() => vi.advanceTimersByTime(5000));
    fireEvent.click(button, { detail: 1 });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it('a pointercancel after the long press fired closes the bubble and arms nothing', () => {
    const onClick = vi.fn();
    render(<IconButton icon="search" context="In dieser Liste" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Suchen' });
    const tip = screen.getByRole('tooltip');
    fireEvent.pointerDown(button, { pointerType: 'touch', clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS));
    expect(tip).toHaveClass('is-open');
    fireEvent.pointerCancel(button, { pointerType: 'touch' });
    expect(tip).not.toHaveClass('is-open');
    fireEvent.click(button, { detail: 1 });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('a touch tap opens no bubble from its compatibility events; focus opens a click-through one', () => {
    render(<IconButton icon="info" context="Was das heisst" />);
    const button = screen.getByRole('button', { name: 'Info' });
    const tip = screen.getByRole('tooltip');
    fireEvent.pointerEnter(button, { pointerType: 'touch' });
    fireEvent.mouseEnter(button);
    expect(tip).not.toHaveClass('is-open');
    fireEvent.focus(button);
    expect(tip).toHaveClass('is-open');
    expect(tip).not.toHaveClass('is-hoverable');
  });

  it('Escape closes a hover-opened bubble wherever focus is', () => {
    render(<IconButton icon="filter" context="Facetten" />);
    const button = screen.getByRole('button', { name: 'Filter' });
    const tip = screen.getByRole('tooltip');
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(tip).toHaveClass('is-open');
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(tip).not.toHaveClass('is-open');
  });

  it('keeps the caller’s own handlers and composes the shared button classes', () => {
    const onFocus = vi.fn();
    render(<IconButton icon="more" context="Weitere Aktionen" small className="row-more" onFocus={onFocus} />);
    const button = screen.getByRole('button', { name: 'Mehr' });
    fireEvent.focus(button);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(button).toHaveClass('btn', 'btn--ghost', 'btn--icon', 'btn--sm', 'icon-button', 'row-more');
  });

  it('the vocabulary is the twelve of D154 plus the five of D177 and the five of D180, and no money commit or destructive act is one of them (Ignorieren excepted by D177 point 5)', () => {
    expect(Object.values(VOCABULARY).map((entry) => entry.name)).toEqual([
      'Bearbeiten',
      'Anhängen',
      'Kommentieren',
      'Markieren',
      'Kopieren',
      'Herunterladen',
      'Öffnen',
      'Suchen',
      'Filter',
      'Mehr',
      'Schliessen',
      'Info',
      'Aufteilen',
      'Abgleichen',
      'Als Regel speichern',
      'Ignorieren',
      'Position entfernen',
      'Anpassen',
      'Fertig',
      'Ausblenden',
      'Einblenden',
      'Grösse ändern',
    ]);
    for (const { name } of Object.values(VOCABULARY)) {
      if (name === 'Ignorieren') continue;
      expect(name).not.toMatch(/buchen|ausstellen|sperren|stornieren|löschen|ignorieren/i);
    }
  });
});
