import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { Tooltip } from './Tooltip';

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
