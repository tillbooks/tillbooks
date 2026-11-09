/**
 * G16, the shortcut sheet: every keyboard binding, rendered from the SAME registry the dispatcher
 * dispatches from (design §3e, US-G16.8). A binding that exists but is missing here cannot happen,
 * because both read `KEY_BINDINGS`. It is a read surface: no primary action, Esc closes it and
 * returns focus to whatever opened it (the house Esc pattern).
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../i18n';
import { KEY_BINDINGS, useFocusTrap, useKeyboard, type KeyBinding } from './keyboard';

const GROUP_ORDER: readonly KeyBinding['group'][] = ['global', 'chord', 'overlay'];
const GROUP_LABEL: Record<KeyBinding['group'], string> = {
  global: 'shortcut.group.global',
  chord: 'shortcut.group.chord',
  overlay: 'shortcut.group.overlay',
};

export function ShortcutSheet() {
  const t = useT();
  const { helpOpen, closeHelp } = useKeyboard();
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // A read-only modal still owns focus while open: Tab must not walk out onto the surface behind it.
  // The sheet holds no controls, so the trap simply keeps focus on the panel until Esc returns it.
  useFocusTrap(panelRef, helpOpen);

  useEffect(() => {
    if (helpOpen) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      panelRef.current?.focus();
    } else {
      restoreFocusRef.current?.focus();
    }
  }, [helpOpen]);

  if (!helpOpen) return null;

  // K-28: portaled to <body> at the palette tier, like the palette, so it is never under a drawer.
  return createPortal(
    <div className="palette-overlay" role="presentation" onClick={closeHelp}>
      <div
        ref={panelRef}
        className="palette panel shortcut-sheet motion-reveal--center"
        role="dialog"
        aria-modal="true"
        aria-label={t('shortcut.title')}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeHelp();
          }
        }}
      >
        <p className="shortcut-heading" data-motion-item="1">
          {t('shortcut.title')}
        </p>
        {/* The Reveal stagger runs over at most three items: the heading, then the first two groups. */}
        {GROUP_ORDER.filter((group) => KEY_BINDINGS.some((b) => b.group === group)).map((group, index) => {
          const rows = KEY_BINDINGS.filter((b) => b.group === group);
          return (
            <div className="shortcut-group" key={group} data-motion-item={index < 2 ? String(index + 2) : undefined}>
              <p className="shortcut-group-label">{t(GROUP_LABEL[group])}</p>
              <ul className="shortcut-list">
                {rows.map((b) => (
                  <li className="shortcut-row" key={b.id}>
                    <span className="shortcut-desc">{t(b.labelKey)}</span>
                    <kbd className="shortcut-keys">{b.keysLabel}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
