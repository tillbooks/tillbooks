/**
 * G16, the shell's ONE keyboard dispatcher and its binding registry.
 *
 * WHY ONE LISTENER. Before G16 there was no document-level keydown handling anywhere; the only key
 * handling lived inside `OverflowMenu`, `WorkspaceSwitcher` and `FeedbackDialog`, each local to its
 * own subtree, and `SearchPalette` owned a lone `window` listener for Cmd+K. G16 centralises the
 * global keyboard into exactly one `document`-level listener that belongs to this provider. Three
 * properties follow and each is why the indirection earns its keep:
 *
 *   1. A duplicate binding is a build failure, not a bug report (`keyboard.test.tsx`).
 *   2. The `?` shortcut sheet is GENERATED from the same `KEY_BINDINGS` array the dispatcher reads,
 *      so a binding that exists but is undocumented cannot happen.
 *   3. The suppression rule (never inside an input/textarea/contenteditable, never with a modifier,
 *      never while a modal owns focus) is written once and cannot be forgotten in the 23rd surface.
 *
 * THE LAYOUT CONSTRAINT (de-CH / QWERTZ, design §4b): no binding uses a digit (Cmd+digit switches
 * browser tabs) or a punctuation key that needs AltGr (`[ ] { } \ @`) or Shift-heavy `/`. What
 * survives is unmodified letter chords, identical on de-CH, fr-CH, it-CH and en-US. `?` is the single
 * declared punctuation exception, taken because it is the universal "show shortcuts" convention.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useNavigate } from 'react-router-dom';

/** A `g`-then-letter navigation chord, or a global/overlay binding, described once for both faces. */
export interface KeyBinding {
  /** Stable id, used by tests and as the sheet row key. */
  id: string;
  /** i18n key for the sheet's human description of what the binding does. */
  labelKey: string;
  /** The human-readable key hint the sheet prints (`g j`, `?`, `Esc`). */
  keysLabel: string;
  /** Where the binding sits in the sheet's three groups. */
  group: 'global' | 'chord' | 'overlay';
  /** For a `chord`: the leader letter, the second letter, and the destination it navigates to. */
  chord?: { leader: string; letter: string; path: string };
}

/**
 * The complete binding registry. The dispatcher dispatches from this array and the shortcut sheet
 * renders from it, so the two cannot disagree. Chord letters are anchored to the de-CH label (design
 * §4d): `b` for Belege, `k` for Kontakte, `z` for Zahlungen, `m` for MWST. Nothing is bound to `y`,
 * the one letter whose physical position moves between QWERTZ and QWERTY.
 */
export const KEY_BINDINGS: readonly KeyBinding[] = [
  { id: 'palette', labelKey: 'shortcut.palette', keysLabel: 'Cmd K / Ctrl K', group: 'global' },
  { id: 'help', labelKey: 'shortcut.help', keysLabel: '?', group: 'global' },
  { id: 'nav-journal', labelKey: 'nav.journal', keysLabel: 'g j', group: 'chord', chord: { leader: 'g', letter: 'j', path: '/journal' } },
  { id: 'nav-belege', labelKey: 'nav.documents', keysLabel: 'g b', group: 'chord', chord: { leader: 'g', letter: 'b', path: '/documents' } },
  { id: 'nav-open-items', labelKey: 'nav.openItems', keysLabel: 'g o', group: 'chord', chord: { leader: 'g', letter: 'o', path: '/open-items' } },
  { id: 'nav-payments', labelKey: 'nav.payments', keysLabel: 'g z', group: 'chord', chord: { leader: 'g', letter: 'z', path: '/payments' } },
  { id: 'nav-contacts', labelKey: 'nav.contacts', keysLabel: 'g k', group: 'chord', chord: { leader: 'g', letter: 'k', path: '/contacts' } },
  { id: 'nav-mwst', labelKey: 'nav.mwst.settings', keysLabel: 'g m', group: 'chord', chord: { leader: 'g', letter: 'm', path: '/mwst' } },
  // G15, Pendenzen: G16 reserved `g a` ("Alles was ansteht") for the attention hub (D90 / the orchestrator's
  // ruling). The letter is `a`, not the de-CH-anchored `p`, per that reservation; it carries no digit
  // (story 8.3). The roving selection over the hub's item list is component-local (the surface's own
  // onKeyDown), so the hub attaches no document listener of its own; only this chord is registered here.
  { id: 'nav-attention', labelKey: 'nav.attention', keysLabel: 'g a', group: 'chord', chord: { leader: 'g', letter: 'a', path: '/attention' } },
  // A35, Gespräche: `g g` per the design's §6b reservation (`g a` was already the hub's). A doubled
  // leader works in the chord machine: the first `g` arms the leader, the second resolves `gg`.
  { id: 'nav-agent', labelKey: 'nav.agent', keysLabel: 'g g', group: 'chord', chord: { leader: 'g', letter: 'g', path: '/agent' } },
  { id: 'escape', labelKey: 'shortcut.escape', keysLabel: 'Esc', group: 'overlay' },
];

/** Chord map, derived once from the registry so there is no second list to drift. */
const CHORDS = new Map(
  KEY_BINDINGS.filter((b) => b.chord !== undefined).map((b) => [`${b.chord!.leader}${b.chord!.letter}`, b.chord!.path]),
);

/** The leader letter the chords share. All chords use `g` (design §4d). */
const CHORD_LEADER = 'g';

/** How long a dangling leader survives before it clears (design tuning constant). */
const CHORD_TIMEOUT_MS = 1200;

interface KeyboardApi {
  paletteOpen: boolean;
  /**
   * Open the palette. K-04 (D137): a caller may hand it the query to open with (the `/search` page's
   * "Suche ändern", a `/search?q=` deep link), so the one omnibox is also the only search field. An
   * argument that is not a string (a click event, when this is wired straight to `onClick`) opens it
   * blank.
   */
  openPalette: (query?: unknown) => void;
  /** The query the palette opens with: the last `openPalette` argument, '' for a blank palette. */
  paletteSeed: string;
  closePalette: () => void;
  togglePalette: () => void;
  helpOpen: boolean;
  openHelp: () => void;
  closeHelp: () => void;
  /**
   * C1 (D118), the omnibox bridge. The palette's "Frag den Agenten" lane runs `agent_ask` itself and
   * then asks the dock to open and refresh onto the new turn. The provider is the common ancestor of
   * both the palette and the dock (both mount inside it), so this monotonic counter carries the
   * request between two siblings without a window event or a shared store: the dock watches the
   * number and acts once per increment. It is a request, not the answer: the dock owns the display.
   */
  agentDockRequest: number;
  requestAgentDock: () => void;
}

const KeyboardContext = createContext<KeyboardApi | null>(null);

/** True while the event target is a place a person is typing text, where chords must not fire. */
function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (el === null) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
}

/**
 * The provider owns the single document listener, the overlay open-state and the chord machine. It
 * renders inside the router (as a child of the Shell route element), so `useNavigate` is in context.
 */
export function KeyboardProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [agentDockRequest, setAgentDockRequest] = useState(0);
  const leaderRef = useRef<{ at: number } | null>(null);
  const leaderTimer = useRef<number | null>(null);

  const [paletteSeed, setPaletteSeed] = useState('');
  const openPalette = useCallback((query?: unknown) => {
    setPaletteSeed(typeof query === 'string' ? query : '');
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const togglePalette = useCallback(() => {
    setPaletteSeed('');
    setPaletteOpen((v) => !v);
  }, []);
  const openHelp = useCallback(() => setHelpOpen(true), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);
  const requestAgentDock = useCallback(() => setAgentDockRequest((n) => n + 1), []);

  const clearLeader = useCallback(() => {
    leaderRef.current = null;
    if (leaderTimer.current !== null) {
      window.clearTimeout(leaderTimer.current);
      leaderTimer.current = null;
    }
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Cmd/Ctrl+K: the one modifier shortcut. Works everywhere, including a focused input, and
      // toggles so "I opened this by mistake" has a hatch. `preventDefault` covers Firefox's Ctrl+K.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        clearLeader();
        setPaletteOpen((v) => !v);
        return;
      }

      // Everything below is suppressed while a modifier is held, inside a text field, or while an
      // overlay owns focus. Written once, here, so it cannot be forgotten downstream.
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTextTarget(event.target)) return;
      if (paletteOpen || helpOpen) return;

      // `?` opens the shortcut sheet: the single declared punctuation exception.
      if (event.key === '?') {
        event.preventDefault();
        clearLeader();
        setHelpOpen(true);
        return;
      }

      const key = event.key.toLowerCase();

      // A dangling leader is waiting for its second letter.
      if (leaderRef.current !== null) {
        const path = CHORDS.get(`${CHORD_LEADER}${key}`);
        clearLeader();
        if (path !== undefined) {
          event.preventDefault();
          navigate(path);
        }
        // An unbound or reserved second letter clears the leader and does nothing else (row 8.3).
        return;
      }

      // Start a chord: the leader is armed and expires on its own if nothing follows.
      if (key === CHORD_LEADER) {
        leaderRef.current = { at: Date.now() };
        leaderTimer.current = window.setTimeout(clearLeader, CHORD_TIMEOUT_MS);
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      clearLeader();
    };
  }, [navigate, paletteOpen, helpOpen, clearLeader]);

  const api = useMemo<KeyboardApi>(
    () => ({
      paletteOpen,
      openPalette,
      paletteSeed,
      closePalette,
      togglePalette,
      helpOpen,
      openHelp,
      closeHelp,
      agentDockRequest,
      requestAgentDock,
    }),
    [paletteOpen, openPalette, paletteSeed, closePalette, togglePalette, helpOpen, openHelp, closeHelp, agentDockRequest, requestAgentDock],
  );

  return <KeyboardContext.Provider value={api}>{children}</KeyboardContext.Provider>;
}

/** Read the keyboard API. Throws outside the provider, which is a wiring bug. */
export function useKeyboard(): KeyboardApi {
  const ctx = useContext(KeyboardContext);
  if (ctx === null) throw new Error('useKeyboard must be used within a KeyboardProvider.');
  return ctx;
}

/**
 * Read the keyboard API WITHOUT throwing when no provider is present. Returns `null` in that case.
 *
 * WHY THIS EXISTS. The rail's "Suche" leaf reaches for `openPalette` to open the command palette over
 * the current surface instead of routing to the full-screen `/search` page. In the real shell the
 * `KeyboardProvider` always wraps the rail, but `NavTree` is also rendered in isolation (its treeview
 * unit tests mount it under a bare `MemoryRouter`), where the throwing `useKeyboard` would crash the
 * render. This optional read lets the rail degrade to plain routing in that harness while using the
 * palette in production, without a second permanent tab stop or a window event.
 */
export function useKeyboardOptional(): KeyboardApi | null {
  return useContext(KeyboardContext);
}

/**
 * The elements a person can Tab to, in DOM order, within `root`: rendered, enabled, tabbable.
 *
 * Presence-based on purpose, NOT layout-based. The two containers this serves (the palette overlay,
 * the collapse drawer) are only trapped while open and on screen, and every focusable they hold is
 * conditionally RENDERED rather than merely `display:none`-hidden, so DOM presence is the honest
 * signal. Reading `offsetParent`/`getClientRects` here would only add a dependency on a real layout
 * engine, which is exactly what a jsdom component test does not have.
 */
function tabbablesWithin(root: HTMLElement): HTMLElement[] {
  const selector = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      !el.hasAttribute('hidden'),
  );
}

/**
 * Contain Tab / Shift+Tab within `containerRef` while `active` (WAI-ARIA modal-dialog focus trap).
 *
 * WHY A REAL TRAP, not a Tab-kill. The palette used to answer Tab with a bare `preventDefault()` on
 * its input: focus never escaped, but the palette's own controls (the empty-state "in allen Daten
 * suchen" escape, an overflow row, a direct-run result's remedy link) became keyboard-UNREACHABLE,
 * a WCAG 2.1.1 failure hiding inside a focus fix. The collapse drawer had the opposite gap: it set
 * `aria-modal` in spirit but let Tab walk straight out onto the surface behind the scrim. One helper
 * closes both: Tab wraps to the first tabbable, Shift+Tab to the last, and focus that has somehow
 * left the container is pulled back in. A container with no tabbable at all keeps focus on itself.
 */
export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (container === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const items = tabbablesWithin(container);
      if (items.length === 0) {
        event.preventDefault();
        if (typeof container.focus === 'function') container.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;
      const inside = activeEl !== null && container.contains(activeEl);
      if (event.shiftKey) {
        if (!inside || activeEl === first) {
          event.preventDefault();
          last.focus();
        }
      } else if (!inside || activeEl === last) {
        event.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', onKeyDown);
    return () => container.removeEventListener('keydown', onKeyDown);
  }, [containerRef, active]);
}
