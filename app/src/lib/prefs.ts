/**
 * D178 point 7, THE STUDIO'S PER-PERSON PREFERENCES: one store, `usePref(key)`, and the legacy import.
 *
 * The engine owns a person's preferences (`prefs_list` / `prefs_set` / `prefs_reset`, G00 spec §10): a
 * theme, a density, a rail arrangement follow the PERSON, not the browser, and an agent can read them.
 * This module is how the Studio holds them.
 *
 * ONE STORE PER STUDIO. `PrefsProvider` (inside the client and workspace providers) owns a `PrefsStore`;
 * every `usePref` on the same key reads the same entry, so the rail's theme toggle and the Meine
 * Einstellungen page move together. The store is re-created when the workspace changes (a `workspace`
 * preference is per mandate); a `person` preference is the same in both, and the boot cache below keeps
 * it on screen across the switch.
 *
 * WHAT `usePref` ANSWERS, in this order: the OPTIMISTIC value while a write is in flight; the ENGINE value
 * once `prefs_list` answered; the BOOT CACHE (the engine's last answer, kept in this browser so a person
 * who chose Dunkel sees no light flash on reload); the registry DEFAULT, read from the engine's own def
 * registry (`src/core/customization/prefDefs/`, imported at runtime: pure data, one implementation, never a
 * mirror). A refused write rolls the optimistic value back and keeps the refusal on `meta.error`.
 *
 * OUTSIDE A PROVIDER (a component test that mounts one control) the hook keeps local state, seeded from
 * `options.initial` or the default, and never calls anything.
 *
 * THE CACHE IS NOT A SOURCE. It is overwritten by every engine answer and holds only values that differ
 * from the default. The source of truth is the engine; the D38 P9 payment-confirmation choice, which the
 * owner kept in the browser on purpose, is not handled here.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import {
  prefDef,
  prefValueFits,
  type PrefDef,
  type PrefValue,
} from '../../../src/core/customization/prefDefs/index.js';
import type { PrefView, PrefsListOk, PrefsSetOk } from '../../../src/core/customization/prefs.js';
import { isErr, type Err, type TillClient } from './client';
import { useClient } from './client-context';
import { useWorkspaceId } from '../app/workspace';

export type { PrefValue } from '../../../src/core/customization/prefDefs/index.js';
export type { PrefView } from '../../../src/core/customization/prefs.js';

/** Where the store is: nothing asked yet, a read in flight, answered, or the read failed. */
export type PrefStatus = 'idle' | 'loading' | 'ready' | 'error';

/** The browser cache of the engine's last answer (non-default values only). */
export const PREF_CACHE_KEY = 'till-prefs-cache';

/** A value set while no workspace was open waits here until a workspace answers. */
export const PREF_PENDING_PREFIX = 'till-pref-pending:';

/** What one legacy import did. */
export type LegacyImportOutcome =
  /** The browser value is now the engine value, and the browser copy is gone. */
  | 'imported'
  /** The engine already held a value for the person: it wins, the browser copy is gone. */
  | 'engine_kept'
  /** The browser held nothing under the legacy key. */
  | 'nothing'
  /** The browser value did not parse or does not fit the def: it is gone, nothing was written. */
  | 'discarded'
  /** The engine refused or could not be reached: the browser copy stays for the next start. */
  | 'failed';

interface CacheShape {
  v: 1;
  person: Record<string, PrefValue>;
  ws: Record<string, Record<string, PrefValue>>;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readCache(): CacheShape {
  const empty: CacheShape = { v: 1, person: {}, ws: {} };
  try {
    const raw = storage()?.getItem(PREF_CACHE_KEY);
    if (raw === null || raw === undefined) return empty;
    const parsed = JSON.parse(raw) as Partial<CacheShape>;
    if (parsed.v !== 1 || typeof parsed.person !== 'object' || typeof parsed.ws !== 'object') return empty;
    return { v: 1, person: parsed.person ?? {}, ws: parsed.ws ?? {} };
  } catch {
    return empty;
  }
}

function writeCache(cache: CacheShape): void {
  try {
    storage()?.setItem(PREF_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* storage unavailable: the next boot starts from the defaults and the engine answers a moment later */
  }
}

function removeItem(key: string): void {
  try {
    storage()?.removeItem(key);
  } catch {
    /* storage unavailable */
  }
}

function getItem(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Key order is not meaning (the engine's own rule, `prefs.ts`). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function samePrefValue(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

interface EngineEntry {
  value: PrefValue;
  isDefault: boolean;
}

interface LegacyJob {
  key: string;
  legacyKey: string;
  parse: (raw: string) => PrefValue | undefined;
  /** A value set while no workspace was open: it is the person's latest word and wins over the engine. */
  force: boolean;
  resolve: (outcome: LegacyImportOutcome) => void;
}

/**
 * The store. `client` and `workspaceId` null means DETACHED: no engine to ask (a component test, or the
 * first-run screen before any workspace exists). A detached write applies at once; with `pendingSync` it
 * also waits in the browser for the first workspace to answer.
 */
export class PrefsStore {
  private readonly listeners = new Set<() => void>();
  private readonly engine = new Map<string, EngineEntry>();
  private readonly optimistic = new Map<string, { value: PrefValue; seq: number; reset: boolean }>();
  private readonly errors = new Map<string, Err>();
  private readonly cached = new Map<string, PrefValue>();
  private catalogRows: PrefView[] | null = null;
  private seq = 0;
  private loadSeq = 0;
  private statusValue: PrefStatus = 'idle';
  private loadErrorValue: Err | null = null;
  version = 0;

  constructor(
    private readonly client: TillClient | null,
    private readonly workspaceId: string | null,
    private readonly options: { pendingSync?: boolean; useCache?: boolean } = {},
  ) {
    if (options.useCache !== false) {
      const cache = readCache();
      for (const [k, v] of Object.entries(cache.person)) this.cached.set(k, v);
      if (workspaceId !== null) for (const [k, v] of Object.entries(cache.ws[workspaceId] ?? {})) this.cached.set(k, v);
    }
  }

  get connected(): boolean {
    return this.client !== null && this.workspaceId !== null;
  }

  get status(): PrefStatus {
    return this.statusValue;
  }

  get loadError(): Err | null {
    return this.loadErrorValue;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const l of [...this.listeners]) l();
  }

  /** The def the engine answered for `key`, else the one bundled with this Studio. */
  private defOf(key: string): { default: PrefValue; def: PrefDef | undefined; view: PrefView | undefined } {
    const view = this.catalogRows?.find((p) => p.key === key);
    const def = prefDef(key);
    return { default: view?.default ?? def?.default ?? (undefined as unknown as PrefValue), def, view };
  }

  /** Seed a detached store (a test's `initial`). Never reaches the engine. */
  seed(key: string, value: PrefValue): void {
    this.engine.set(key, { value, isDefault: samePrefValue(value, this.defOf(key).default) });
  }

  value(key: string): PrefValue {
    const optimistic = this.optimistic.get(key);
    if (optimistic !== undefined) return optimistic.value;
    const engine = this.engine.get(key);
    if (engine !== undefined) return engine.value;
    if (this.cached.has(key)) return this.cached.get(key) as PrefValue;
    return this.defOf(key).default;
  }

  /** Whether the default applies, before any in-flight write. */
  private settledIsDefault(key: string): boolean {
    const engine = this.engine.get(key);
    if (engine !== undefined) return engine.isDefault;
    return !this.cached.has(key);
  }

  /**
   * Whether the default applies. A set to the default value while nothing is stored stores nothing (the
   * engine's rule), so it stays the default; a set to the default over a stored value pins it.
   */
  private wouldBeDefault(key: string, next: PrefValue): boolean {
    return samePrefValue(next, this.defOf(key).default) && this.settledIsDefault(key);
  }

  isDefault(key: string): boolean {
    const optimistic = this.optimistic.get(key);
    if (optimistic !== undefined) return optimistic.reset || this.wouldBeDefault(key, optimistic.value);
    return this.settledIsDefault(key);
  }

  error(key: string): Err | null {
    return this.errors.get(key) ?? null;
  }

  /** The engine's catalogue with the in-flight and stored values overlaid, for Meine Einstellungen. */
  catalog(): PrefView[] | null {
    if (this.catalogRows === null) return null;
    return this.catalogRows.map((row) => ({ ...row, value: this.value(row.key), isDefault: this.isDefault(row.key) }));
  }

  /** Read `prefs_list` and replace every engine value with its answer. */
  async load(): Promise<void> {
    if (this.client === null || this.workspaceId === null) return;
    const mine = (this.loadSeq += 1);
    this.statusValue = 'loading';
    this.notify();
    const { body } = await this.client.call('prefs_list', { workspaceId: this.workspaceId });
    if (mine !== this.loadSeq) return;
    if (isErr(body)) {
      this.statusValue = 'error';
      this.loadErrorValue = body;
      this.notify();
      return;
    }
    const { prefs } = body as unknown as PrefsListOk;
    this.catalogRows = prefs;
    for (const p of prefs) this.engine.set(p.key, { value: p.value, isDefault: p.isDefault });
    this.statusValue = 'ready';
    this.loadErrorValue = null;
    this.saveCache();
    this.notify();
    await this.drainLegacy();
  }

  /** Write the engine's non-default values to the boot cache, person and this workspace's. */
  private saveCache(): void {
    if (this.options.useCache === false) return;
    const cache = readCache();
    const rows = this.catalogRows ?? [];
    const person: Record<string, PrefValue> = { ...cache.person };
    const ws: Record<string, PrefValue> = { ...(this.workspaceId === null ? {} : (cache.ws[this.workspaceId] ?? {})) };
    for (const row of rows) {
      const entry = this.engine.get(row.key);
      const target = row.scope === 'person' ? person : ws;
      if (entry === undefined || entry.isDefault) delete target[row.key];
      else target[row.key] = entry.value;
    }
    cache.person = person;
    if (this.workspaceId !== null) cache.ws[this.workspaceId] = ws;
    writeCache(cache);
  }

  /**
   * Set `key`. Optimistic: the value shows at once and rolls back if the engine refuses. Answers whether
   * the engine (or, detached, the store) accepted it.
   */
  async set(key: string, next: PrefValue): Promise<boolean> {
    this.errors.delete(key);
    if (!this.connected) {
      this.engine.set(key, { value: next, isDefault: this.wouldBeDefault(key, next) });
      if (this.options.pendingSync === true) {
        try {
          storage()?.setItem(`${PREF_PENDING_PREFIX}${key}`, JSON.stringify(next));
        } catch {
          /* storage unavailable: the choice lives for this session */
        }
      }
      this.notify();
      return true;
    }
    const mine = (this.seq += 1);
    this.optimistic.set(key, { value: next, seq: mine, reset: false });
    this.notify();
    const { body } = await (this.client as TillClient).call('prefs_set', { workspaceId: this.workspaceId, key, value: next });
    if (this.optimistic.get(key)?.seq === mine) this.optimistic.delete(key);
    if (isErr(body)) {
      this.errors.set(key, body);
      this.notify();
      return false;
    }
    const answer = body as unknown as PrefsSetOk;
    this.engine.set(key, { value: answer.value, isDefault: answer.isDefault });
    this.saveCache();
    this.notify();
    return true;
  }

  /** Return `key` to its default. Optimistic like `set`. */
  async reset(key: string): Promise<boolean> {
    return this.resetKeys({ key }, [key]);
  }

  /** Return every preference of `area` to its default. */
  async resetArea(area: string): Promise<boolean> {
    const keys = (this.catalogRows ?? []).filter((p) => p.area.id === area).map((p) => p.key);
    return this.resetKeys({ area }, keys);
  }

  private async resetKeys(input: { key: string } | { area: string }, keys: readonly string[]): Promise<boolean> {
    for (const k of keys) this.errors.delete(k);
    if (!this.connected) {
      for (const k of keys) {
        this.engine.set(k, { value: this.defOf(k).default, isDefault: true });
        removeItem(`${PREF_PENDING_PREFIX}${k}`);
      }
      this.notify();
      return true;
    }
    const mine = (this.seq += 1);
    for (const k of keys) this.optimistic.set(k, { value: this.defOf(k).default, seq: mine, reset: true });
    this.notify();
    const { body } = await (this.client as TillClient).call('prefs_reset', { workspaceId: this.workspaceId, ...input });
    for (const k of keys) if (this.optimistic.get(k)?.seq === mine) this.optimistic.delete(k);
    if (isErr(body)) {
      for (const k of keys) this.errors.set(k, body);
      this.notify();
      return false;
    }
    for (const k of keys) this.engine.set(k, { value: this.defOf(k).default, isDefault: true });
    this.saveCache();
    this.notify();
    return true;
  }

  // --- the legacy import ------------------------------------------------------------------------

  /** Run every queued legacy import and every value that waited for a workspace. */
  private async drainLegacy(): Promise<void> {
    if (!this.connected || this.statusValue !== 'ready') return;
    const jobs = queue.splice(0, queue.length);
    const store = storage();
    if (store !== null) {
      const pending: string[] = [];
      try {
        for (let i = 0; i < store.length; i += 1) {
          const k = store.key(i);
          if (k !== null && k.startsWith(PREF_PENDING_PREFIX)) pending.push(k);
        }
      } catch {
        /* storage unavailable */
      }
      for (const legacyKey of pending) {
        jobs.push({
          key: legacyKey.slice(PREF_PENDING_PREFIX.length),
          legacyKey,
          parse: (raw) => JSON.parse(raw) as PrefValue,
          force: true,
          resolve: () => {},
        });
      }
    }
    for (const job of jobs) job.resolve(await this.runLegacy(job));
  }

  /** One import: move the browser value into the engine once, then clear it (spec §10.5). */
  async runLegacy(job: LegacyJob): Promise<LegacyImportOutcome> {
    const raw = getItem(job.legacyKey);
    if (raw === null) return 'nothing';
    const { def, view } = this.defOf(job.key);
    const schema = view?.schema ?? def?.schema;
    let parsed: PrefValue | undefined;
    try {
      parsed = job.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (schema === undefined) return 'failed';
    if (parsed === undefined || !prefValueFits(schema, parsed)) {
      removeItem(job.legacyKey);
      return 'discarded';
    }
    const engine = this.engine.get(job.key);
    if (!job.force && engine !== undefined && !engine.isDefault) {
      removeItem(job.legacyKey);
      return 'engine_kept';
    }
    const accepted = await this.set(job.key, parsed);
    if (!accepted) return 'failed';
    removeItem(job.legacyKey);
    return 'imported';
  }

  /** Queue `job`, or run it now when this store is the live, loaded one. */
  schedule(job: LegacyJob): void {
    if (this.connected && this.statusValue === 'ready') void this.runLegacy(job).then(job.resolve);
    else queue.push(job);
  }
}

/** Imports waiting for a store that has loaded. Module state: the import is once per browser, not per tree. */
const queue: LegacyJob[] = [];

/** The live store a call to `importLegacyPref` reaches, set by the mounted provider. */
let liveStore: PrefsStore | null = null;

/**
 * THE ONE-TIME LEGACY IMPORT (spec §10.5). Moves a value this browser stored under the old scheme
 * (`localStorage[legacyLocalStorageKey]`) into the engine preference `key` ONCE, then clears it. Call it
 * at module scope (it waits for the provider's first answer) or from an effect (it runs at once against
 * the loaded store). When the engine already holds a value for the person, the engine wins and the
 * browser copy is discarded; a value `parse` rejects (answers undefined) or the def refuses is discarded;
 * a refusal or a transport failure keeps the browser copy for the next start.
 */
export function importLegacyPref<T extends PrefValue>(
  key: string,
  legacyLocalStorageKey: string,
  parse: (raw: string) => T | undefined,
): Promise<LegacyImportOutcome> {
  return new Promise((resolve) => {
    const job: LegacyJob = { key, legacyKey: legacyLocalStorageKey, parse, force: false, resolve };
    if (liveStore !== null) liveStore.schedule(job);
    else queue.push(job);
  });
}

/** Test seam: forget queued imports and the live store between tests. */
export function resetPrefsModuleForTests(): void {
  queue.splice(0, queue.length);
  liveStore = null;
}

// --- React ------------------------------------------------------------------------------------------

const PrefsContext = createContext<PrefsStore | null>(null);

/**
 * Owns the Studio's one store. Mount it inside `TillClientProvider` and `WorkspaceProvider`. A test may
 * hand in its own `store`.
 */
export function PrefsProvider({ children, store }: { children: ReactNode; store?: PrefsStore }) {
  const client = useClient();
  const workspaceId = useWorkspaceId();
  const owned = useMemo(
    () => store ?? new PrefsStore(client, workspaceId, { pendingSync: true }),
    [store, client, workspaceId],
  );
  useEffect(() => {
    liveStore = owned;
    void owned.load();
    return () => {
      if (liveStore === owned) liveStore = null;
    };
  }, [owned]);
  return createElement(PrefsContext.Provider, { value: owned }, children);
}

/** The store this tree reads, or null outside a provider. */
export function usePrefsStore(): PrefsStore | null {
  return useContext(PrefsContext);
}

export interface PrefMeta {
  /** No stored value is in force: the default applies. */
  isDefault: boolean;
  /** Return the preference to its default. */
  reset: () => Promise<boolean>;
  status: PrefStatus;
  /** The last refusal for this key, cleared by the next write. */
  error: Err | null;
}

/**
 * One preference, as `[value, setValue, { isDefault, reset, status, error }]`.
 *
 * `setValue` is optimistic and answers whether the engine accepted the value; a refusal rolls the value
 * back and lands on `error`. Outside a `PrefsProvider` the hook keeps local state seeded from
 * `options.initial` (or the default) and never calls the engine. An unknown key is a programming error
 * and throws, the `getSetting` rule.
 */
export function usePref<T extends PrefValue = PrefValue>(
  key: string,
  options?: { initial?: T },
): [T, (next: T) => Promise<boolean>, PrefMeta] {
  if (prefDef(key) === undefined) {
    throw new Error(`usePref: '${key}' is not in the preference registry (src/core/customization/prefDefs/)`);
  }
  const shared = useContext(PrefsContext);
  const [local] = useState(() => {
    const s = new PrefsStore(null, null, { useCache: false });
    if (options?.initial !== undefined) s.seed(key, options.initial);
    return s;
  });
  const store = shared ?? local;
  useSyncExternalStore(store.subscribe, store.getVersion, store.getVersion);
  // Stable across renders, so a provider that hands them on (theme, density) does not re-render its
  // whole subtree whenever any other preference moves.
  const setValue = useCallback((next: T) => store.set(key, next), [store, key]);
  const reset = useCallback(() => store.reset(key), [store, key]);
  const value = store.value(key) as T;
  const meta: PrefMeta = {
    isDefault: store.isDefault(key),
    reset,
    status: store.connected ? store.status : 'ready',
    error: store.error(key),
  };
  return [value, setValue, meta];
}

/** The catalogue for Meine Einstellungen: every preference with its value, status, and the writes. */
export function usePrefsCatalog(): {
  status: PrefStatus;
  error: Err | null;
  prefs: PrefView[] | null;
  reload: () => Promise<void>;
  store: PrefsStore | null;
} {
  const store = useContext(PrefsContext);
  const [fallback] = useState(() => new PrefsStore(null, null, { useCache: false }));
  const s = store ?? fallback;
  useSyncExternalStore(s.subscribe, s.getVersion, s.getVersion);
  return { status: s.status, error: s.loadError, prefs: s.catalog(), reload: () => s.load(), store };
}
