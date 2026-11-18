/**
 * D197 point 2: Ablehnen as an icon (the vocabulary's `reject`), or in words on a selection bar.
 *
 * D204 (owner, 15.11.2026): "Rejecting is one click. It asks nothing and books nothing." One press rejects:
 * no step, no reason field in front of the act. A rejection posts nothing, so there is nothing to confirm.
 * Asking for a reason at all becomes the workspace setting `audit.ask_reason` (default `never`); when it is
 * switched on, the optional field sits AFTER the act, never in front of the button. Until that setting lands
 * this control sends no reason, and `onReject` keeps its optional `reason` so a caller never changes shape.
 */
import { IconButton } from '../../components/IconButton';
import './RejectControl.css';

export interface RejectControlProps {
  /** What is rejected, for the tooltip's second line ("Vorschlag: Velowerkstatt Beispiel"). */
  context: string;
  onReject: (reason?: string) => void;
  busy?: boolean;
  /** The accessible name when the act is more specific (a mined rule: "Nicht vorschlagen"). */
  name?: string;
  /** 24 in the detail pane (large icons), 16 on a dense row. */
  size?: 16 | 20 | 24;
  small?: boolean;
  /** Kept for callers of the two-step control; the one-click control has no inner commit. */
  commitLabel?: string;
  /** A worded trigger instead of the icon (the selection bar's "Ablehnen (n)"). */
  triggerLabel?: string;
}

export function RejectControl({ context, onReject, busy = false, name, size = 16, small = false, triggerLabel }: RejectControlProps) {
  return (
    <span className="reject-control">
      {triggerLabel !== undefined ? (
        <button type="button" className="btn btn--ghost btn--sm reject-control-trigger" disabled={busy} onClick={() => onReject()}>
          {triggerLabel}
        </button>
      ) : (
        <IconButton
          icon="reject"
          size={size}
          small={small}
          className="reject-control-trigger"
          {...(name !== undefined ? { name } : {})}
          context={context}
          disabled={busy}
          onClick={() => onReject()}
        />
      )}
    </span>
  );
}
