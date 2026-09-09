/**
 * G16, the command palette: ONE relevance-ranked overlay for going somewhere, finding something and
 * doing something (D90 D-1). It extends G07's entity-search overlay (records stay G07's) with two
 * things G07 lacked: navigation and verbs. The open state lives in the shell's keyboard dispatcher
 * (there is exactly one document listener, `app/src/app/keyboard.tsx`), so this component reads
 * `useKeyboard()` rather than owning its own Cmd+K listener.
 *
 * THE THREE ROW KINDS (command-source.ts): a navigate row routes; a direct-run row executes inline
 * and renders the humanized result in the fixed region; a handoff row routes to the owning surface's
 * flow, injecting no input (D84). Safety, not arity, decides run-vs-handoff (D89 #6).
 *
 * DENIED VERBS ARE SHOWN, disabled and sorted last, with the required capability and, via the empty
 * state, a path to `/members` (D90 D-4): a verb is the product's feature list, identical per
 * workspace, and leaks nothing; a denied RECORD stays invisible (G07's per-result RBAC). While
 * `whoami` is unknown nothing is disabled (the Studio's fail-open posture; the engine stays the gate).
 *
 * DESIGN LAW (spec §6): an ELEVATED opaque panel over a plain dim scrim, no blur/translucency; one
 * accent, on the active row only; the palette input has no visible label (a named exception carried
 * by aria-label + the announced count + the footer legend); the active row's verb NAME shows as a
 * persistent dim monospace token in the FOOTER, never a row label, never a hover-only tooltip, never
 * nested-interactive inside the listbox (US-G16.7).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useClient } from '../../lib/client-context';
import { isErr } from '../../lib/client';
import { useCapabilities } from '../../lib/capabilities';
import { useWorkspaceId } from '../../app/workspace';
import { useFocusTrap, useKeyboard } from '../../app/keyboard';
import { useIdempotencyKey } from '../../lib/idempotency';
import { useT, formatMoney } from '../../i18n';

/** The translate function's shape (i18n does not export a named alias). */
type TFunction = (key: string, params?: Record<string, string | number>) => string;
import {
  NAV_COMMANDS,
  VERB_COMMANDS,
  rankScore,
  type NavCommand,
  type VerbCommand,
} from '../../lib/command-source';
import { pushRecent, readRecords, readVerbs, recordRef } from './recents';
import { parseSearch, type SearchHit } from './model';
import { MIN_QUERY_LENGTH } from './Search';
import { matchConcepts } from '../../lib/guidance';
import { ConceptPanel } from '../../components/ConceptPanel';
import { useI18n } from '../../i18n';
import './Search.css';

const DEBOUNCE_MS = 150;
const SECTION_ROW_CAP = 5;
/**
 * F-13 (J2.6): how many contact hits are probed for an open balance per query. A customer on the
 * phone is one name, so three covers the near-duplicates a short query surfaces without turning the
 * palette into a debtor sweep.
 */
const CUSTOMER_PROBE_CAP = 3;

/** A contact hit's open position, as `customer_balance` answers it, keyed by contact id. */
type OpenByContact = Record<string, { minor: number; currency: string }>;
const VISIBLE_SECTION_CAP = 4;

type SectionId = 'recent' | 'nav' | 'actionsHere' | 'actions' | 'records' | 'concepts' | 'ask';

/** One rendered row. Grouping is cosmetic; ranking is global. */
interface Row {
  key: string;
  label: string;
  score: number;
  /** True for a direct-run verb: the row shows "run", not "open". */
  runnable: boolean;
  /** The verb name for the footer token; absent on nav and record rows. */
  verb?: string;
  /** An explicit kind hint for a non-verb row (C1's ask row shows "fragen"); overrides open/run. */
  kindLabel?: string;
  disabled: boolean;
  deniedCapability?: string;
  activate: () => void;
}

interface Section {
  id: SectionId;
  labelKey: string;
  rows: Row[];
  overflow: number;
  /**
   * G17's Begriffe overflow: an INERT narrow-the-query line rather than a button. It navigates
   * nowhere (there is no concept route to point at) and, not being a Row, can never be the default
   * selection (design row 2.3).
   */
  inertOverflowKey?: string;
}

const SECTION_LABEL: Record<SectionId, string> = {
  recent: 'palette.section.recent',
  nav: 'palette.section.nav',
  actionsHere: 'palette.section.actionsHere',
  actions: 'palette.section.actions',
  records: 'palette.section.records',
  concepts: 'palette.section.concepts',
  ask: 'palette.askSection',
};

export function SearchPalette() {
  const t = useT();
  const { locale } = useI18n();
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const navigate = useNavigate();
  const location = useLocation();
  const { paletteOpen, closePalette, requestAgentDock } = useKeyboard();
  const { whoami, can } = useCapabilities();
  /**
   * G17: the concept the palette handed off to. The palette overlay closes when a Begriff row is
   * chosen and the centred panel opens over the current surface (no route change, no write); on
   * the panel's close, focus returns to the palette's own restore target, which is the element
   * that opened the palette (the "back to the palette trigger" half of §12's focus contract).
   */
  const [conceptOpen, setConceptOpen] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  /**
   * F-13 (J2.6): the open amount behind a contact hit. "Type the name, see the open amount, done":
   * for the first contact hits the palette reads `customer_balance` (the same verb an agent calls)
   * and offers "Offene Posten von {name}" AHEAD of the contact record, landing on `/open-items`
   * filtered to that customer. A contact with nothing open gets no such row: the palette claims no
   * receivable the engine does not hold. A refused read (a role without `read_sales`) simply leaves
   * the row absent; the contact record stays reachable.
   */
  const [openByContact, setOpenByContact] = useState<OpenByContact>({});
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const [result, setResult] = useState<{ ok: boolean; verb: VerbCommand; message: string } | null>(null);
  const [running, setRunning] = useState(false);
  // C1: the ask lane's own feedback. A failed `agent_ask` (no runtime, or a transport slip) stays IN
  // the palette rather than opening an empty dock, so the operator sees why nothing happened.
  const [askError, setAskError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const requestSeq = useRef(0);

  // Contain Tab within the open overlay (WCAG 2.4.3 / the spec's aria-modal palette). This is the
  // real trap: it keeps focus inside AND leaves the palette's own controls (the empty-state escape,
  // an overflow row, a direct-run result's remedy) keyboard-reachable, where the previous bare
  // Tab-preventDefault contained focus by making every one of those controls unreachable.
  useFocusTrap(dialogRef, paletteOpen);

  const query = q.trim();
  const browse = query.length === 0;

  const askKey = useIdempotencyKey([workspaceId, query]);

  const close = useCallback(() => {
    setQ('');
    setHits([]);
    setOpenByContact({});
    setActive(0);
    setResult(null);
    setAskError(null);
    closePalette();
    restoreFocusRef.current?.focus();
  }, [closePalette]);

  useEffect(() => {
    if (paletteOpen) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      inputRef.current?.focus();
    }
  }, [paletteOpen]);

  // §H-TENANT in a UI buffer: a workspace switch drops any in-flight query, hits and result, so a
  // client's record titles never survive a switch (record recents are keyed by workspace, see recents.ts).
  useEffect(() => {
    setQ('');
    setHits([]);
    setOpenByContact({});
    setResult(null);
    setAskError(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!paletteOpen || workspaceId === null || query.length < MIN_QUERY_LENGTH) {
      setHits([]);
      setSearching(false);
      return;
    }
    const seq = (requestSeq.current += 1);
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        const response = await client.call('search_global', { workspaceId, q: query, limit: 50 });
        if (seq !== requestSeq.current) return;
        setSearching(false);
        if (isErr(response.body)) {
          setHits([]);
          return;
        }
        const parsed = parseSearch(response.body);
        const found = parsed === null ? [] : parsed.hits;
        setHits(found);
        setOpenByContact({});
        // The open-amount probe, in parallel per contact, discarded if a newer query overtook it.
        const contacts = found.filter((h) => h.entityKind === 'contact').slice(0, CUSTOMER_PROBE_CAP);
        if (contacts.length === 0) return;
        const balances = await Promise.all(
          contacts.map(async (hit) => {
            const res = await client.call('customer_balance', { workspaceId, customerId: hit.entityId });
            if (isErr(res.body)) return null;
            const b = res.body as { items?: unknown; baseTotalOpenMinor?: unknown; baseCurrency?: unknown };
            if (!Array.isArray(b.items) || b.items.length === 0) return null;
            if (typeof b.baseTotalOpenMinor !== 'number' || typeof b.baseCurrency !== 'string') return null;
            return [hit.entityId, { minor: b.baseTotalOpenMinor, currency: b.baseCurrency }] as const;
          }),
        );
        if (seq !== requestSeq.current) return;
        const next: OpenByContact = {};
        for (const entry of balances) if (entry !== null) next[entry[0]] = entry[1];
        setOpenByContact(next);
      })();
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [paletteOpen, query, client, workspaceId]);

  const denialOf = useCallback(
    (cmd: VerbCommand): string | undefined => {
      if (whoami === null || cmd.gateDynamic) return undefined; // fail-open / engine-gated
      return cmd.capabilities.find((c) => !can(c));
    },
    [whoami, can],
  );

  const runDirect = useCallback(
    (cmd: VerbCommand) => {
      if (workspaceId === null) return;
      setRunning(true);
      setResult(null);
      void (async () => {
        const response = await client.call(cmd.name, { workspaceId });
        setRunning(false);
        const failed = isErr(response.body);
        setResult({ ok: !failed, verb: cmd, message: failed ? errorCode(response.body) : t('palette.legend') });
        pushRecent('till.recent.verbs', readVerbs, cmd.name);
      })();
    },
    [client, workspaceId, t],
  );

  const activateVerb = useCallback(
    (cmd: VerbCommand) => {
      if (cmd.kind === 'direct-run' && cmd.directRunSafe) {
        runDirect(cmd);
        return;
      }
      pushRecent('till.recent.verbs', readVerbs, cmd.name);
      if (cmd.targetRoute !== undefined) navigate(cmd.targetRoute);
      close();
    },
    [runDirect, navigate, close],
  );

  const activateNav = useCallback(
    (cmd: NavCommand) => {
      navigate(cmd.path);
      close();
    },
    [navigate, close],
  );

  const openHit = useCallback(
    (hit: SearchHit) => {
      if (workspaceId !== null) pushRecent(`till.recent.records.${workspaceId}`, () => readRecords(workspaceId), recordRef(hit));
      close();
      navigate(`${hit.route}?focus=${encodeURIComponent(hit.entityId)}`);
    },
    [navigate, close, workspaceId],
  );

  const showAll = useCallback(() => {
    close();
    navigate(`/search?q=${encodeURIComponent(query)}`);
  }, [navigate, close, query]);

  /** F-13 (J2.6): land on the customer's open amount, the OP-Liste filtered to that customer. */
  const openOpenItems = useCallback(
    (customerId: string) => {
      close();
      navigate(`/open-items?customer=${encodeURIComponent(customerId)}`);
    },
    [navigate, close],
  );

  /**
   * Open a Begriff: the palette overlay closes, the centred panel opens over the current surface.
   * Deliberately NOT `close()`: focus must move INTO the panel, not back to the restore target
   * (that return happens when the panel itself closes). Nothing navigates, nothing is written, and
   * no recent is recorded: a concept lookup leaves no trace in shell persistence.
   */
  const openConcept = useCallback(
    (key: string) => {
      setQ('');
      setHits([]);
      setActive(0);
      setResult(null);
      closePalette();
      setConceptOpen(key);
    },
    [closePalette],
  );

  /**
   * C1's ask lane. One input, two lanes: a command row navigates or runs, this row hands the free
   * text to `agent_ask` (whose executed verb is always a READ, so no write is reachable from prose)
   * and, on success, asks the dock to open onto the answer. A failure stays in the palette so the
   * operator sees why. `agent_ask` is idempotent per question (`askKey`), the shell-wide law.
   */
  const ask = useCallback(() => {
    if (workspaceId === null || query.length === 0 || running) return;
    setRunning(true);
    setAskError(null);
    setResult(null);
    void (async () => {
      const response = await client.call('agent_ask', { workspaceId, text: query, idempotencyKey: askKey });
      setRunning(false);
      if (isErr(response.body)) {
        const code = errorCode(response.body);
        setAskError(code === 'needs_local_runtime' ? t('palette.askNoRuntime') : t('palette.askFailed'));
        return;
      }
      requestAgentDock();
      close();
    })();
  }, [workspaceId, query, running, client, askKey, requestAgentDock, close, t]);

  const sections = useMemo<Section[]>(
    () =>
      buildSections({
        query,
        browse,
        hits,
        openByContact,
        currentPath: location.pathname,
        workspaceId,
        locale,
        t,
        denialOf,
        activateNav,
        activateVerb,
        openHit,
        openOpenItems,
        openConcept,
      }),
    [query, browse, hits, openByContact, location.pathname, workspaceId, locale, t, denialOf, activateNav, activateVerb, openHit, openOpenItems, openConcept],
  );

  // The command/record/concept rows, before the ask lane. `nothing` is judged on THESE alone, so the
  // "search all data" escape still appears when no screen, verb or record matched, even though the
  // ask row keeps the list non-empty.
  const commandRows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  // C1: the single "Frag den Agenten" tail row. Present only with a query, scored 0 so it is never
  // the auto-selected default over a real command, and rendered as the last section.
  const askSection = useMemo<Section | null>(() => {
    if (query.length === 0) return null;
    return {
      id: 'ask',
      labelKey: SECTION_LABEL.ask,
      overflow: 0,
      rows: [
        {
          key: 'ask:agent',
          label: t('palette.ask', { query }),
          score: 0,
          runnable: false,
          kindLabel: t('palette.askKind'),
          disabled: false,
          activate: ask,
        },
      ],
    };
  }, [query, t, ask]);

  const renderSections = useMemo(
    () => (askSection === null ? sections : [...sections, askSection]),
    [sections, askSection],
  );

  const flatRows = useMemo(() => renderSections.flatMap((s) => s.rows), [renderSections]);

  useEffect(() => {
    let best = -1;
    let bestScore = -1;
    flatRows.forEach((row, index) => {
      if (row.disabled) return;
      if (row.score > bestScore) {
        bestScore = row.score;
        best = index;
      }
    });
    setActive(best < 0 ? 0 : best);
  }, [flatRows]);

  const moveActive = useCallback(
    (delta: number) => {
      if (flatRows.length === 0) return;
      setActive((current) => {
        let next = current;
        for (let step = 0; step < flatRows.length; step += 1) {
          next = (next + delta + flatRows.length) % flatRows.length;
          if (!flatRows[next].disabled) return next;
        }
        return current;
      });
    },
    [flatRows],
  );

  const onInputKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = flatRows[active];
      if (row !== undefined && !row.disabled) row.activate();
      else if (query.length >= MIN_QUERY_LENGTH) showAll();
    }
    // Escape is handled at the dialog level (onDialogKeyDown), so it closes the palette no matter
    // which control holds focus, and Tab is owned by the dialog-level focus trap (useFocusTrap),
    // which keeps focus inside the overlay while leaving its buttons reachable; the rows themselves
    // are driven by the arrows.
  };

  // Esc closes from anywhere inside the overlay. It lives on the dialog, not the input, because the
  // focus trap now lets focus rest on the palette's own buttons, and Esc from one of those must
  // still dismiss the overlay and return focus to the trigger (§12's focus contract).
  const onDialogKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  };

  // The centred panel outlives the overlay (the palette closed when the Begriff was chosen). On
  // close, focus returns to the element that opened the palette, per §12's focus contract.
  const conceptPanel =
    conceptOpen !== null ? (
      <ConceptPanel
        conceptKey={conceptOpen}
        onClose={() => {
          setConceptOpen(null);
          restoreFocusRef.current?.focus();
        }}
      />
    ) : null;

  if (!paletteOpen) return conceptPanel;

  const listId = 'command-palette-list';
  const activeRow = flatRows[active];
  const nothing = !browse && !searching && commandRows.length === 0;

  return (
    <div className="palette-overlay" role="presentation" onClick={close}>
      <div
        ref={dialogRef}
        className="palette panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('palette.aria')}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onDialogKeyDown}
      >
        <input
          ref={inputRef}
          type="search"
          className="palette-input"
          role="combobox"
          aria-expanded={flatRows.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeRow !== undefined ? `palette-row-${active}` : undefined}
          aria-label={t('palette.aria')}
          placeholder={t('palette.aria')}
          value={q}
          onChange={(event) => setQ(event.target.value)}
          onKeyDown={onInputKeyDown}
        />

        {/* The announced count. The palette input carries no visible label (a named §6 exception),
            and that exception is justified by "aria-label + the announced count + the footer legend":
            this polite, screen-reader-only region is the announced-count half, telling a non-sighted
            operator how many rows the query surfaced without adding visible chrome. Absent at zero,
            where the empty state's own role=status speaks instead. */}
        {flatRows.length > 0 && (
          <p className="visually-hidden" role="status" aria-live="polite">
            {t('palette.resultCount', { count: flatRows.length })}
          </p>
        )}

        {nothing && (
          <div className="palette-empty">
            <p className="palette-hint" role="status">
              {t('palette.empty')}
            </p>
            <button type="button" className="btn btn--ghost btn--sm" onClick={showAll}>
              {t('palette.searchAll')}
            </button>
          </div>
        )}

        {flatRows.length > 0 && (
          // A combobox listbox, built from divs, not ul/li: an `option` must be owned by a `listbox`
          // or `group` and a `group` by a `listbox`, and interposing list/listitem semantics between
          // them is the exact aria-required-parent/children violation axe flags. So the roles carry
          // the structure and the list elements are gone (each `group` is a section; its label is a
          // real aria-label, and the visible heading is decorative).
          <div className="palette-list" role="listbox" id={listId} aria-label={t('palette.aria')}>
            {renderSections.map((section) => (
              <div
                key={section.id}
                role="group"
                aria-label={t(section.labelKey)}
                className={section.id === 'ask' ? 'palette-section palette-section--ask' : 'palette-section'}
              >
                <p className="palette-group" aria-hidden="true">
                  {t(section.labelKey)}
                </p>
                <div className="palette-section-rows">
                  {section.rows.map((row) => {
                    const index = flatRows.indexOf(row);
                    return (
                      <div
                        key={row.key}
                        id={`palette-row-${index}`}
                        role="option"
                        aria-selected={index === active}
                        aria-disabled={row.disabled || undefined}
                        className={
                          (index === active ? 'palette-row palette-row--active' : 'palette-row') +
                          (row.disabled ? ' palette-row--disabled' : '')
                        }
                        onMouseEnter={() => !row.disabled && setActive(index)}
                        onClick={() => !row.disabled && row.activate()}
                      >
                        <span className="palette-row-title">{row.label}</span>
                        {row.verb !== undefined && !row.disabled && (
                          <span className="palette-row-kind">
                            {t(row.runnable ? 'palette.kind.run' : 'palette.kind.open')}
                          </span>
                        )}
                        {row.verb === undefined && row.kindLabel !== undefined && !row.disabled && (
                          <span className="palette-row-kind">{row.kindLabel}</span>
                        )}
                        {row.disabled && row.deniedCapability !== undefined && (
                          <span className="palette-row-denied">
                            {t('palette.denied', { capability: row.deniedCapability })}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
                {section.overflow > 0 && (
                  <button type="button" className="palette-overflow" onClick={showAll}>
                    {t('palette.overflow', { count: section.overflow })}
                  </button>
                )}
                {section.inertOverflowKey !== undefined && (
                  <p className="palette-narrow">{t(section.inertOverflowKey)}</p>
                )}
              </div>
            ))}
          </div>
        )}

        {askError !== null && (
          <div className="palette-result palette-result--error" role="status">
            <span className="palette-result-text">{askError}</span>
          </div>
        )}

        {result !== null && (
          <div className={result.ok ? 'palette-result' : 'palette-result palette-result--error'} role="status">
            <span className="palette-result-text">{result.message}</span>
            {result.verb.targetRoute !== undefined && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  const route = result.verb.targetRoute as string;
                  close();
                  navigate(route);
                }}
              >
                {t('palette.remedy', { surface: result.verb.targetRoute })}
              </button>
            )}
          </div>
        )}

        <div className="palette-foot">
          <span className="palette-legend">{running ? t('palette.running') : t('palette.legend')}</span>
          {activeRow?.verb !== undefined && <code className="palette-verb-token">{activeRow.verb}</code>}
        </div>
      </div>
    </div>
  );
}

/** Read an engine rejection's stable code for the humanized result line. */
function errorCode(body: unknown): string {
  const b = body as { error?: unknown } | null;
  return b !== null && typeof b === 'object' && typeof b.error === 'string' ? b.error : 'unexpected_error';
}

interface BuildArgs {
  query: string;
  browse: boolean;
  hits: SearchHit[];
  openByContact: OpenByContact;
  currentPath: string;
  workspaceId: string | null;
  locale: 'de-CH' | 'en';
  t: TFunction;
  denialOf: (cmd: VerbCommand) => string | undefined;
  activateNav: (cmd: NavCommand) => void;
  activateVerb: (cmd: VerbCommand) => void;
  openHit: (hit: SearchHit) => void;
  openOpenItems: (customerId: string) => void;
  openConcept: (key: string) => void;
}

/**
 * Build the palette sections. Grouping is for the eye; the caller ranks globally. At most four
 * visible sections of at most five rows each, with a records overflow row into `Suche` (US-G16.4).
 * Disabled verb rows are sorted last within their section (US-G16.6).
 */
function buildSections(args: BuildArgs): Section[] {
  const { query, browse, hits, openByContact, currentPath, workspaceId, locale, t, denialOf, activateNav, activateVerb, openHit, openOpenItems, openConcept } = args;

  const navRow = (cmd: NavCommand): Row => ({
    key: `nav:${cmd.path}`,
    label: t(cmd.labelKey),
    score: browse ? 1 : rankScore(query, t(cmd.labelKey)),
    runnable: false,
    disabled: false,
    activate: () => activateNav(cmd),
  });

  const verbRow = (cmd: VerbCommand): Row => {
    const label = t(cmd.labelKey);
    const denied = denialOf(cmd);
    const row: Row = {
      key: `verb:${cmd.name}`,
      label,
      score: browse ? 1 : rankScore(query, label),
      runnable: cmd.kind === 'direct-run' && cmd.directRunSafe,
      verb: cmd.name,
      disabled: denied !== undefined,
      activate: () => activateVerb(cmd),
    };
    if (denied !== undefined) row.deniedCapability = denied;
    return row;
  };

  /** Enabled rows before disabled rows; each block kept in descending score. */
  const order = (rows: Row[]): Row[] =>
    [...rows].sort((a, b) => Number(a.disabled) - Number(b.disabled) || b.score - a.score).slice(0, SECTION_ROW_CAP);

  const sections: Section[] = [];

  if (browse) {
    const recentVerbs = readVerbs()
      .map((name) => VERB_COMMANDS.find((c) => c.name === name))
      .filter((c): c is VerbCommand => c !== undefined)
      .map(verbRow);
    if (recentVerbs.length > 0) sections.push({ id: 'recent', labelKey: SECTION_LABEL.recent, rows: order(recentVerbs), overflow: 0 });

    sections.push({ id: 'nav', labelKey: SECTION_LABEL.nav, rows: order(NAV_COMMANDS.map(navRow)), overflow: 0 });

    const here = VERB_COMMANDS.filter((c) => c.targetRoute === currentPath).map(verbRow);
    if (here.length > 0) sections.push({ id: 'actionsHere', labelKey: SECTION_LABEL.actionsHere, rows: order(here), overflow: 0 });
  } else {
    const navMatches = NAV_COMMANDS.map(navRow).filter((r) => r.score > 0);
    if (navMatches.length > 0) sections.push({ id: 'nav', labelKey: SECTION_LABEL.nav, rows: order(navMatches), overflow: 0 });

    const verbMatches = VERB_COMMANDS.map(verbRow).filter((r) => r.score > 0);
    if (verbMatches.length > 0) sections.push({ id: 'actions', labelKey: SECTION_LABEL.actions, rows: order(verbMatches), overflow: 0 });

    if (workspaceId !== null && hits.length > 0) {
      const recordRows: Row[] = hits.flatMap((hit) => {
        const score = rankScore(query, hit.title) || 1;
        const record: Row = {
          key: `rec:${hit.entityKind}:${hit.entityId}`,
          label: `${t(kindLabelKey(hit))}, ${hit.title}`,
          score,
          runnable: false,
          disabled: false,
          activate: () => openHit(hit),
        };
        // F-13 (J2.6): a customer with open items gets its open amount FIRST, the record second. The
        // row is a navigation entry into the filtered OP-Liste, derived from the live hit and the
        // engine's balance, never a hand list of verbs (D118 C2). Same score, earlier position: the
        // stable order sort keeps it ahead of the record it belongs to.
        const open = hit.entityKind === 'contact' ? openByContact[hit.entityId] : undefined;
        if (open === undefined) return [record];
        const openRow: Row = {
          key: `open:${hit.entityId}`,
          label: t('palette.openItemsOf', { name: hit.title, total: formatMoney(open.minor, open.currency) }),
          score,
          runnable: false,
          kindLabel: t('palette.kind.open'),
          disabled: false,
          activate: () => openOpenItems(hit.entityId),
        };
        return [openRow, record];
      });
      const shown = order(recordRows);
      sections.push({ id: 'records', labelKey: SECTION_LABEL.records, rows: shown, overflow: Math.max(0, hits.length - shown.length) });
    }

    // G17's Begriffe group: search mode's FOURTH group, after Datensätze (the G16 spec carries the
    // one-line cap amendment). Matching is per token, local and synchronous against the generated
    // corpus projection, so it works with the engine down; absent entirely on no match (row 2.2).
    // A concept row never outranks a real prefix match on a screen or verb (score floor 0.5), a
    // person typing a word most often wanting the screen or the record before the meaning.
    const conceptEntries = matchConcepts(query);
    if (conceptEntries.length > 0) {
      const conceptRows: Row[] = conceptEntries.slice(0, SECTION_ROW_CAP).map((entry) => ({
        key: `concept:${entry.key}`,
        label: entry.term[locale],
        score: rankScore(query, entry.term[locale]) || 0.5,
        runnable: false,
        disabled: false,
        activate: () => openConcept(entry.key),
      }));
      const section: Section = {
        id: 'concepts',
        labelKey: SECTION_LABEL.concepts,
        rows: conceptRows,
        overflow: 0,
      };
      if (conceptEntries.length > SECTION_ROW_CAP) section.inertOverflowKey = 'palette.concepts.narrow';
      sections.push(section);
    }
  }

  return sections.slice(0, VISIBLE_SECTION_CAP);
}

/** The i18n label key for a record hit's kind, falling back to a generic label. */
function kindLabelKey(hit: SearchHit): string {
  return `search.kind.${hit.entityKind}`;
}
