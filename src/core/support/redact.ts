/**
 * G08 §4, the redactor. One function, two entry points.
 *
 * The rule this file exists to enforce: **no free text is ever captured automatically.** A
 * diagnostic entry may hold codes, verb names from the closed registry, route PATTERNS, allow-listed
 * field key names and install-relative stack frames. It may never hold a value from an `Err`'s
 * extras, and it may never hold `error.message`.
 *
 * The reason is concrete rather than theoretical. `guarded()` in `src/api/registry.ts` attaches
 * `message: e.message` to every `unexpected_error`, and an exception raised inside a posting path
 * can carry an amount, a counterparty name and an IBAN in that one string. `error.stack` carries the
 * same message on its first line and the OS username in every absolute path after it.
 *
 * Three rules here are easy to get subtly wrong, so each is stated where it is implemented:
 *   1. the stack's HEAD line is the message, and dropping the message means dropping that line too;
 *   2. denying VALUES is not enough once OP7 custom fields ship, because a field's KEY is
 *      user-authored, so key names are ALLOW-listed rather than value-denied;
 *   3. a concrete route is an entity id, so `surface` stores a pattern and ids are masked even when
 *      a caller passes a concrete path by mistake.
 */

/** §H-ENUM. The three shapes of thing that can be recorded. */
export const DIAGNOSTIC_ENTRY_KINDS = Object.freeze([
  'verb_error',
  'unhandled_exception',
  'transport_error',
] as const);

export type DiagnosticEntryKind = (typeof DIAGNOSTIC_ENTRY_KINDS)[number];

/**
 * §H-ENUM. What counts as a defect, single-sourced.
 *
 * Read by the journal filter AND by the Studio's `ErrorBanner` "Report this error" predicate, so the
 * two faces cannot drift on the question. Domain rejections (`period_locked`, `invalid_input`) are
 * the system working correctly and are deliberately absent: journaling every P9 rejection would bury
 * one real defect under a hundred form validations. `store_busy` IS here, because a user who sees it
 * repeatedly is seeing a defect even though any single occurrence is benign.
 */
export const DEFECT_SHAPED_CODES = Object.freeze([
  'unexpected_error',
  'store_busy',
  'transport_error',
] as const);

export function isDefectShaped(code: string): boolean {
  return (DEFECT_SHAPED_CODES as readonly string[]).includes(code);
}

/**
 * The allow-list of `Err` extra key names that may be recorded verbatim.
 *
 * Every entry is a key minted in our own source. Anything else collapses to `<custom>`, which is
 * what keeps an OP7 custom field named after a client out of the journal. Adding a key here is a
 * deliberate act: it must be one WE name, never one a user can choose.
 */
export const REDACTABLE_DETAIL_KEYS = Object.freeze([
  'action',
  'allowed',
  'capability',
  'expected',
  'field',
  'got',
  'kind',
  'path',
  'period',
  'reason',
  'retryable',
  'source',
  'target',
] as const);

const CUSTOM_KEY = '<custom>';
const EXTERNAL_FRAME = '<external>';
const NON_ERROR = '<non-error>';
const MAX_FRAMES = 12;

export interface DiagnosticEntry {
  readonly at: string;
  readonly kind: DiagnosticEntryKind;
  readonly name: string | undefined;
  readonly code: string | undefined;
  readonly action: string | undefined;
  readonly surface: string | undefined;
  readonly detailKeys: readonly string[];
  readonly frames: readonly string[];
}

export interface RawDiagnostic {
  readonly kind: DiagnosticEntryKind;
  readonly at: string;
  readonly code?: string | undefined;
  readonly action?: string | undefined;
  readonly surface?: string | undefined;
  readonly detail?: Record<string, unknown> | undefined;
  readonly error?: unknown;
}

/**
 * An error that has crossed a JSON boundary.
 *
 * Found while building the Studio's crash path: `parseClientError` forwards the client's `error`
 * straight here, and JSON is never an `instanceof Error`, so a browser crash reported THROUGH the
 * engine recorded `<non-error>` with zero frames while the same crash reported in-browser carried
 * its full frames. An engine-written artifact would have been the WEAKER report, which is exactly
 * backwards.
 *
 * Accepting a `stack` string from a client is safe because of what `redactFrames` does with it: only
 * lines matching an `at ...` frame are read at all, and each is either install-relative or collapses
 * to `<external>`. Arbitrary text a caller puts in `stack` is dropped rather than trusted, and
 * `message` is not read from either shape.
 */
interface ErrorLike {
  readonly name?: unknown;
  readonly stack?: unknown;
}

function errorLike(value: unknown): ErrorLike | undefined {
  if (value instanceof Error) return value;
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as ErrorLike;
  return typeof candidate.stack === 'string' ? candidate : undefined;
}

export interface RedactOptions {
  /** Absolute path of the install root. Frames outside it collapse to `<external>`. */
  readonly installRoot: string;
}

/** A path segment that identifies a specific record rather than a kind of screen. */
function looksLikeId(segment: string): boolean {
  if (segment === '') return false;
  if (/^[a-z]+_[A-Za-z0-9_-]{6,}$/.test(segment)) return true; // ws_..., doc_..., entry_...
  if (/^[0-9a-fA-F-]{8,}$/.test(segment)) return true; // uuid or hex
  if (/^\d{4,}$/.test(segment)) return true;
  return false;
}

/**
 * Reduce a route to its pattern. The Studio is expected to pass the matched pattern already; this is
 * defence in depth, because a concrete route links a report to one record and, across two reports,
 * to one set of books.
 */
function maskRoute(surface: string): string {
  return surface
    .split('/')
    .map((segment) => (looksLikeId(segment) ? ':id' : segment))
    .join('/');
}

/**
 * Parse `error.stack` into install-relative frames.
 *
 * Note what is NOT parsed: the stack's first line, which is `${name}: ${message}`. Only lines
 * matching an `at ...` frame are considered, so the message cannot survive by riding along in the
 * head. A frame outside the install root emits `<external>` and drops its function name too: a
 * dependency's function name is not ours to publish, and the path would carry the home directory.
 */
function redactFrames(stack: string, installRoot: string): string[] {
  const root = installRoot.endsWith('/') ? installRoot : `${installRoot}/`;
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('at ')) continue; // drops the `Error: <message>` head line
    const body = trimmed.slice(3);
    const parenthesised = /^(.*?)\s*\((.*)\)$/.exec(body);
    const fn = parenthesised?.[1] ?? '';
    const location = parenthesised?.[2] ?? body;
    if (location.startsWith(root)) {
      const relative = location.slice(root.length);
      frames.push(fn === '' ? relative : `${fn} (${relative})`);
    } else {
      frames.push(EXTERNAL_FRAME);
    }
    if (frames.length >= MAX_FRAMES) break;
  }
  return frames;
}

/** Allow-list the key names; every VALUE is dropped without being inspected. */
function redactDetailKeys(detail: Record<string, unknown> | undefined): string[] {
  if (detail === undefined) return [];
  const allowed = REDACTABLE_DETAIL_KEYS as readonly string[];
  const out: string[] = [];
  for (const key of Object.keys(detail)) {
    const emitted = allowed.includes(key) ? key : CUSTOM_KEY;
    if (!out.includes(emitted)) out.push(emitted);
  }
  return out;
}

/**
 * The single redactor. Applied to the `guarded()` capture path AND to an inbound `clientError`, so
 * a Studio crash and an engine throw are held to exactly the same rule and tested once.
 */
export function redactEntry(raw: RawDiagnostic, opts: RedactOptions): DiagnosticEntry {
  const like = errorLike(raw.error);
  const stack = typeof like?.stack === 'string' ? like.stack : '';
  const name = typeof like?.name === 'string' ? like.name : undefined;
  return {
    at: raw.at,
    kind: raw.kind,
    name: raw.error === undefined ? undefined : (name ?? NON_ERROR),
    code: raw.code,
    action: raw.action,
    surface: raw.surface === undefined ? undefined : maskRoute(raw.surface),
    detailKeys: redactDetailKeys(raw.detail),
    frames: redactFrames(stack, opts.installRoot),
  };
}
