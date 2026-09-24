/**
 * A real tooltip: a supplemental description tied to its trigger via `aria-describedby`, never the
 * native `title` attribute (which is invisible to keyboard users and inconsistent across browsers).
 *
 * The description element is always in the DOM carrying its id, so assistive tech can reach it and
 * `aria-describedby` always resolves; visibility is a purely visual layer toggled on hover AND
 * keyboard focus, and dismissed on Escape or blur. Tooltips hold plain text only (no interactive
 * content): for a titled help panel with a link, reach for HelpHint instead.
 *
 * The trigger is any single element passed as the child. An icon-only trigger must carry its own
 * `aria-label` so it has an accessible name independent of the tooltip.
 */
import {
  cloneElement,
  useId,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

export interface TooltipProps {
  /** The tooltip text. Plain content only: no links or buttons. */
  content: ReactNode;
  /** The single trigger element the tooltip describes. */
  children: ReactElement;
  /** Where the bubble sits relative to the trigger. Defaults to above. */
  placement?: 'top' | 'bottom';
}

/** Props the tooltip injects onto its trigger child. Kept loose so any element type composes. */
interface TriggerProps {
  'aria-describedby'?: string;
  onMouseEnter?: (event: MouseEvent) => void;
  onMouseLeave?: (event: MouseEvent) => void;
  onFocus?: (event: FocusEvent) => void;
  onBlur?: (event: FocusEvent) => void;
  onKeyDown?: (event: KeyboardEvent) => void;
}

export function Tooltip({ content, children, placement = 'top' }: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  const childProps = children.props as TriggerProps;

  const trigger = cloneElement(children, {
    'aria-describedby': id,
    onMouseEnter: (event: MouseEvent) => {
      setOpen(true);
      childProps.onMouseEnter?.(event);
    },
    onMouseLeave: (event: MouseEvent) => {
      setOpen(false);
      childProps.onMouseLeave?.(event);
    },
    onFocus: (event: FocusEvent) => {
      setOpen(true);
      childProps.onFocus?.(event);
    },
    onBlur: (event: FocusEvent) => {
      setOpen(false);
      childProps.onBlur?.(event);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
      childProps.onKeyDown?.(event);
    },
  } as TriggerProps);

  return (
    <span className="tooltip-wrap">
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={`tooltip tooltip-${placement}${open ? ' is-open' : ''}`}
      >
        {content}
      </span>
    </span>
  );
}
