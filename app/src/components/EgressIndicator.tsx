/**
 * E07's trust indicator (spec §6, US-E07.2): glyph + label for the three honest egress states. This
 * is the reusable signal G15 places in the shell rail (D89: the rail SLOT is G15's; E07 supplies the
 * states, the glyphs and the copy, which are FIXED per §6b so a plugin cannot restyle the indicator
 * into a lie). The Vertrauen panel on Setup uses it too, one component for both audiences.
 *
 * DESIGN LAW (brand/DESIGN.md, spec §6): glyph + label, NEVER colour alone (WCAG 2.2 AA), NEVER an
 * emoji ("status is a glyph, not a face"), and NEVER the Brass accent, which stays reserved as the
 * single go/safe/confirmed signal and stops working as one the moment it is spent on a permanent
 * badge. `violated` uses the danger colour WITH the ✕ glyph and the label, never colour alone. The
 * icon-only rail form still carries an `aria-label` matching the state text, never just the glyph.
 */
import './EgressIndicator.css';

export type EgressIndicatorState = 'local' | 'unknown' | 'violated';

/** The fixed glyph per state (§6b): ● local, ◌ not verified, ✕ a connection was opened. */
const GLYPH: Record<EgressIndicatorState, string> = {
  local: '●', // ●
  unknown: '◌', // ◌
  violated: '✕', // ✕
};

export interface EgressIndicatorProps {
  state: EgressIndicatorState;
  /** The state's label text (already localised by the caller), e.g. "Lokal, keine Verbindung". */
  label: string;
  /** Icon-only (the rail form): the glyph shows, the label rides only the aria-label. */
  iconOnly?: boolean;
  /** Clicking opens the Vertrauen panel (US-E07.2). Optional: the panel-embedded form is static. */
  onClick?: () => void;
}

export function EgressIndicator({ state, label, iconOnly = false, onClick }: EgressIndicatorProps) {
  const className = `egress-indicator egress-indicator--${state}${iconOnly ? ' egress-indicator--icon' : ''}`;
  const content = (
    <>
      <span className="egress-indicator-glyph" aria-hidden="true">
        {GLYPH[state]}
      </span>
      {!iconOnly && <span className="egress-indicator-label">{label}</span>}
    </>
  );

  if (onClick !== undefined) {
    return (
      <button type="button" className={className} aria-label={label} onClick={onClick}>
        {content}
      </button>
    );
  }
  return (
    <span className={className} role="status" aria-label={label}>
      {content}
    </span>
  );
}
