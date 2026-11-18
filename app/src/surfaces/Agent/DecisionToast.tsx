/**
 * D197 (the fresh-eyes judge): the outcome of a decision is a TRANSIENT toast that names the row, with
 * Rückgängig where the engine has an undo. It floats over the page (no boxed banner above the list, so
 * nothing below it moves), goes by itself after a few seconds or with the next click outside it, and holds
 * while the pointer rests on it or the focus is in it, so its Rückgängig stays reachable (the bank status
 * line's rule, UX judge round 2 item 12). A glyph and words, never colour alone.
 */
import { useEffect, useRef, useState } from 'react';

import { useT } from '../../i18n';
import { IconButton } from '../../components/IconButton';
import { AlertGlyph, CheckGlyph, InfoGlyph } from '../../components/states/glyphs';
import './DecisionToast.css';

/** How long a toast stays when nobody holds it. */
export const TOAST_MS = 6000;

export interface ToastState {
  id: number;
  tone: 'success' | 'info' | 'warn';
  message: string;
  undo?: { label: string; run: () => void };
}

const GLYPH = { success: CheckGlyph, info: InfoGlyph, warn: AlertGlyph } as const;

export function DecisionToast({ toast, onDone }: { toast: ToastState | null; onDone: () => void }) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (toast === null || held) return undefined;
    const timer = window.setTimeout(onDone, TOAST_MS);
    const onPointer = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || ref.current?.contains(e.target) !== true) onDone();
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [toast, held, onDone]);

  // The live region is always there, so a screen reader hears each new message.
  return (
    <div className="vtoast-region" role="status" aria-live="polite">
      {toast !== null && (
        <div
          key={toast.id}
          ref={ref}
          className="vtoast"
          data-tone={toast.tone}
          onPointerEnter={() => setHeld(true)}
          onPointerLeave={() => setHeld(false)}
          onFocus={() => setHeld(true)}
          onBlur={(e) => {
            if (!(e.relatedTarget instanceof Node) || ref.current?.contains(e.relatedTarget) !== true) setHeld(false);
          }}
        >
          {(() => {
            const Glyph = GLYPH[toast.tone];
            return <Glyph size={16} aria-hidden="true" className="vtoast-glyph" />;
          })()}
          <span className="vtoast-message">{toast.message}</span>
          {toast.undo !== undefined && (
            <button
              type="button"
              className="btn btn--ghost btn--sm vtoast-undo"
              onClick={() => {
                toast.undo?.run();
              }}
            >
              {toast.undo.label}
            </button>
          )}
          <IconButton icon="close" small context={t('agent.vq.toastClose')} onClick={onDone} />
        </div>
      )}
    </div>
  );
}
