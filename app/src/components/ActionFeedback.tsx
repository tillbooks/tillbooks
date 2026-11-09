/**
 * Transient / success action feedback: the confirmation half of a write.
 *
 * The Studio had NO shared primitive for "that worked" (or "that could not"), so every surface
 * rolled its own `*-notice` / `*-banner` / `*-toast` with divergent class names, placement and
 * status colours. This is the one shape they all fold into, built the way `ErrorBanner` established:
 * a glyph plus text, never colour alone (the glyph SHAPE differs per tone, so a colour-blind
 * operator and a grayscale printout read the same status), and only `--t-*` tokens, never a hex.
 *
 * WHAT THIS IS NOT. It is not `ErrorBanner`. A raw engine rejection (`{ ok:false, error }`) that a
 * person could report as a defect stays on `ErrorBanner`, which carries the G08 "Report this error"
 * affordance; rendering such a failure here would be a dead end by construction (DESIGN.md, the
 * error-reporting rule). The `error` tone here is for a LOCALIZED, actionable message that carries
 * its own recovery, exactly like a mistyped field: a plan rejection, an outcome state, a
 * needs-configuration notice. Those are not defect codes and get no report link, here or anywhere.
 *
 * The `role` defaults from the tone (`error` announces as `alert`, everything else as `status`) and
 * can be overridden for the advisory cases that deliberately do not interrupt.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { AlertGlyph, CheckGlyph, InfoGlyph } from './states/glyphs';
import { commitAck } from '../lib/motion';
import './ActionFeedback.css';

export type FeedbackTone = 'success' | 'info' | 'warn' | 'error';

export interface ActionFeedbackProps {
  /** Which of the four semantics this feedback carries. Drives the glyph, the border and the role. */
  tone: FeedbackTone;
  /** The primary line. Already localized by the caller (a string or inline nodes). */
  message: ReactNode;
  /** Optional dim secondary line(s) under the message. */
  detail?: ReactNode;
  /** Override the tone-derived ARIA role. `note` is for a standing advisory that never interrupts. */
  role?: 'status' | 'alert' | 'note';
  /** When set, renders the shared dismiss control. `dismissLabel` is its text and accessible name. */
  onDismiss?: () => void;
  dismissLabel?: string;
  /** Extra body content: an inline CTA, a copy affordance, a custom detail block. */
  children?: ReactNode;
  /** Passed through for the rare layout tweak (e.g. a max-width notice). */
  className?: string;
  /**
   * The Commit moment (D122 D-I): when true, the banner itself is the thing that just landed. It
   * enters from 8 px above in `--t-motion-commit` with the decaying accent-soft tint, exactly like a
   * new table row would, and the success check draws itself beside the words. For a surface whose
   * write produced no row to acknowledge (a period lock, an issued document seen on its detail),
   * this is where the ack lands. Under reduced motion nothing is stamped and the words carry it.
   */
  landed?: boolean;
}

const GLYPH = {
  success: CheckGlyph,
  info: InfoGlyph,
  warn: AlertGlyph,
  error: AlertGlyph,
} as const;

export function ActionFeedback({
  tone,
  message,
  detail,
  role,
  onDismiss,
  dismissLabel,
  children,
  className,
  landed = false,
}: ActionFeedbackProps) {
  const Glyph = GLYPH[tone];
  const resolvedRole = role ?? (tone === 'error' ? 'alert' : 'status');
  const ref = useRef<HTMLDivElement>(null);

  // The stamp is set on mount and lifted when the tint has decayed (or on unmount), so a banner
  // that stays on screen does not keep re-landing on every render.
  useEffect(() => (landed ? commitAck(ref.current) : undefined), [landed]);

  return (
    <div
      ref={ref}
      className={`action-feedback action-feedback--${tone}${className !== undefined ? ` ${className}` : ''}`}
      role={resolvedRole}
    >
      <Glyph className="action-feedback__glyph" size={18} />
      <div className="action-feedback__body">
        <div className="action-feedback__message">{message}</div>
        {detail !== undefined && <div className="action-feedback__detail">{detail}</div>}
        {children}
      </div>
      {onDismiss !== undefined && (
        <button
          type="button"
          className="btn btn--secondary btn--sm action-feedback__dismiss"
          onClick={onDismiss}
        >
          {dismissLabel}
        </button>
      )}
    </div>
  );
}
