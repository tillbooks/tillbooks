import { describe, it, expect, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { createPortal } from 'react-dom';
import userEvent from '@testing-library/user-event';

import { Tooltip, TooltipPortalContext, tooltipConsumedEscape } from './Tooltip';

describe('Tooltip', () => {
  it('ties the trigger to the description via aria-describedby (not the title attribute)', () => {
    render(
      <Tooltip content="Saldo je Konto">
        <button type="button" aria-label="Hilfe">
          i
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Hilfe' });
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Saldo je Konto');
    expect(trigger).toHaveAttribute('aria-describedby', tip.id);
    expect(trigger).not.toHaveAttribute('title');
  });

  it('D180: an Escape that closed an open bubble is marked for opt-in handlers and prevents nothing', () => {
    const seen: [boolean, boolean][] = [];
    render(
      <div
        onKeyDown={(event) => {
          if (event.key === 'Escape') seen.push([event.defaultPrevented, tooltipConsumedEscape(event)]);
        }}
      >
        <Tooltip content="Hinweis">
          <button type="button" aria-label="Hilfe">
            i
          </button>
        </Tooltip>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: 'Hilfe' });
    fireEvent.focus(trigger);
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-open');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(seen).toEqual([
      [false, true],
      [false, false],
    ]);
  });

  it('D180: where the engine knows :focus-visible, only keyboard focus opens the bubble, never a script focus()', () => {
    const realCss = (globalThis as { CSS?: unknown }).CSS;
    (globalThis as { CSS?: unknown }).CSS = { supports: (q: string) => q === 'selector(:focus-visible)', escape: (v: string) => v };
    let keyboard = false;
    const realMatches = Element.prototype.matches;
    const matches = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' ? keyboard : realMatches.call(this, selector);
    });
    try {
      render(
        <Tooltip content="Hinweis">
          <button type="button" aria-label="Hilfe">
            i
          </button>
        </Tooltip>,
      );
      const trigger = screen.getByRole('button', { name: 'Hilfe' });
      const tip = () => screen.getByRole('tooltip');
      fireEvent.focus(trigger);
      expect(tip()).not.toHaveClass('is-open');
      fireEvent.blur(trigger);
      keyboard = true;
      fireEvent.focus(trigger);
      expect(tip()).toHaveClass('is-open');
    } finally {
      matches.mockRestore();
      (globalThis as { CSS?: unknown }).CSS = realCss;
    }
  });

  it('reveals on keyboard focus and dismisses on Escape and blur', () => {
    render(
      <Tooltip content="Hinweis">
        <button type="button" aria-label="Hilfe">
          i
        </button>
      </Tooltip>,
    );
    const trigger = screen.getByRole('button', { name: 'Hilfe' });
    const tip = screen.getByRole('tooltip');
    expect(tip).not.toHaveClass('is-open');

    fireEvent.focus(trigger);
    expect(tip).toHaveClass('is-open');

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(tip).not.toHaveClass('is-open');

    fireEvent.focus(trigger);
    fireEvent.blur(trigger);
    expect(tip).not.toHaveClass('is-open');
  });
});

describe('Tooltip long press and portals', () => {
  it('a long press inside a portalled child of the trigger does not arm the tooltip', () => {
    vi.useFakeTimers();
    try {
      render(
        <Tooltip content="Code">
          <span>
            Trigger
            {createPortal(<input aria-label="Suche im Popover" />, document.body)}
          </span>
        </Tooltip>,
      );
      const field = screen.getByRole('textbox', { name: 'Suche im Popover' });
      fireEvent.pointerDown(field, { pointerType: 'touch', clientX: 0, clientY: 0 });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByRole('tooltip')).not.toHaveClass('is-open');
      const menu = fireEvent.contextMenu(field);
      expect(menu).toBe(true); // not prevented: the platform's own menu stays
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Tooltip with real user-event sequences (Ruhig 3 critic round 2)', () => {
  function Probe({ onClick }: { onClick: () => void }) {
    return (
      <Tooltip content="Zahlung buchen und Beleg verknüpfen">
        <button type="button" onClick={onClick}>
          Buchen
        </button>
      </Tooltip>
    );
  }

  it('hover, click, unhover: the bubble closes when the mouse leaves, even though the click focused the button', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Probe onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Buchen' });
    const tip = screen.getByRole('tooltip');
    await user.hover(button);
    expect(tip).toHaveClass('is-open', 'is-hoverable');
    await user.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
    expect(tip).toHaveClass('is-open', 'is-hoverable');
    await user.unhover(button);
    expect(tip).not.toHaveClass('is-open');
  });

  it('a touch tap acts and opens no bubble, though it focuses the button', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Probe onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Buchen' });
    await user.pointer({ keys: '[TouchA]', target: button });
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('tooltip')).not.toHaveClass('is-open');
  });

  it('keyboard focus (Tab) opens a click-through bubble, and blur closes it', async () => {
    const user = userEvent.setup();
    render(<Probe onClick={() => {}} />);
    const tip = screen.getByRole('tooltip');
    await user.tab();
    expect(screen.getByRole('button', { name: 'Buchen' })).toHaveFocus();
    expect(tip).toHaveClass('is-open');
    expect(tip).not.toHaveClass('is-hoverable');
    await user.tab();
    expect(tip).not.toHaveClass('is-open');
  });
});

/**
 * D177: in the overlay layer (TooltipPortalContext) the component places the bubble itself. jsdom has no
 * layout, so the trigger's and the bubble's boxes are given here.
 */
describe('Tooltip in the overlay layer (D177)', () => {
  const box = (x: number, y: number, w: number, h: number) => ({ x, y, left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  function place(placement: 'top' | 'bottom' | 'left', align: 'center' | 'start', trigger: DOMRect, bubble: DOMRect) {
    const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.getAttribute('role') === 'tooltip' ? bubble : trigger;
    });
    render(
      <TooltipPortalContext.Provider value={true}>
        <Tooltip content="Konto wählen" placement={placement} align={align}>
          <button type="button">Buchen</button>
        </Tooltip>
      </TooltipPortalContext.Provider>,
    );
    act(() => screen.getByRole('button', { name: 'Buchen' }).focus());
    const tip = screen.getByRole('tooltip', { hidden: true });
    spy.mockRestore();
    return tip;
  }

  it('left: beside the trigger, vertically centred, 8px off it', () => {
    const tip = place('left', 'center', box(600, 300, 80, 20), box(0, 0, 200, 36));
    expect(tip.parentElement).toBe(document.body);
    expect(tip).toHaveClass('tooltip-left');
    expect(tip.style.left).toBe('392px');
    expect(tip.style.top).toBe('292px');
  });

  it('left without room on the left: above the trigger instead', () => {
    const tip = place('left', 'center', box(40, 300, 80, 20), box(0, 0, 200, 36));
    expect(tip).toHaveClass('tooltip-top');
    expect(tip.style.top).toBe('256px');
  });

  it('bottom + start: below the trigger, its left edge at the trigger\'s, wrapping instead of sliding left', () => {
    window.innerWidth = 1440;
    const tip = place('bottom', 'start', box(1290, 340, 72, 32), box(0, 0, 220, 18));
    expect(tip).toHaveClass('tooltip-bottom');
    expect(tip.style.top).toBe('380px');
    expect(tip.style.left).toBe('1290px');
    expect(tip.style.maxWidth).toBe('142px');
  });
});
