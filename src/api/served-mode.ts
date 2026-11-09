/**
 * M01, the served-mode trust boundary: the ONE fact TILL consumes from an authenticating reverse
 * proxy, and the fail-closed rules around it.
 *
 * **TILL NEVER BECOMES AN IDENTITY PROVIDER (D105).** Authentication (passwords, OIDC, mTLS, WebAuthn,
 * session cookies) happens in the reverse proxy IN FRONT OF TILL. This module reads exactly one fact,
 * the authenticated subject, from one HTTP header, and ONLY when served mode is explicitly configured.
 * There is no password column, no token stack, no OIDC client here or anywhere in the core. Every
 * deployment brings its own IdP (Authelia, Keycloak, Cloudflare Access, corporate OIDC, plain mTLS)
 * and TILL does not change to accommodate any of them.
 *
 * THE REVERSE-PROXY CONTRACT (spec §4, normative for any served deployment):
 *  1. The proxy authenticates the human or machine by whatever it trusts.
 *  2. The proxy STRIPS any inbound header of the configured name from the client request and SETS its
 *     own, carrying exactly one value: the stable subject (an email or an IdP `sub`).
 *  3. The proxy reaches TILL over a link the host OS makes private (loopback / unix socket / mTLS
 *     private network). TILL's non-loopback bind refusal is UNCHANGED: served mode does not open the
 *     bind, it changes what a request must carry.
 *  4. TILL trusts the header IF AND ONLY IF served mode is explicitly configured. Absent that, the
 *     header is inert. Misconfiguration fails closed: an unrecognised mode value, or a blank header
 *     name, refuses to start.
 *
 * WHY ENV AND NOT TENANT DATA (spec §6b, D42 machine scope). Tenant-writable trust configuration would
 * let a compromised workspace widen its own door. The switch that decides whom the transport trusts is
 * a property of the DEPLOYMENT, read from the environment beside `TILL_EXPOSE_LEDGER_UNAUTHENTICATED`
 * and `TILL_RUNTIME_MODE`, never from a `workspace` row.
 */

import type { IncomingHttpHeaders } from 'node:http';

// §H-ENUM: `IdentitySource` is owned in core (next to the D13 actor set in `core/access/actors.ts`),
// so `WorkspaceContext` can carry it without core importing this api layer. Re-exported here so api
// consumers reach it through the served-mode module they already import.
export type { IdentitySource } from '../core/access/index.js';
export { IDENTITY_SOURCES } from '../core/access/index.js';

/** The env var that turns served mode on. Only the exact value `proxy` is honoured. */
export const SERVED_MODE_ENV = 'TILL_SERVED_MODE';

/** The only supported served mode. A reverse proxy in front is the whole design (D105). */
export const SERVED_MODE_PROXY = 'proxy';

/** The env var naming the header the proxy sets. Optional: defaults to `DEFAULT_SUBJECT_HEADER`. */
export const SUBJECT_HEADER_ENV = 'TILL_SUBJECT_HEADER';

/** The default subject header name (spec §4.4). Lowercased: Node lowercases every request header. */
export const DEFAULT_SUBJECT_HEADER = 'till-authenticated-subject';

/** The resolved served-mode configuration for this process. */
export interface ServedModeConfig {
  /** True only when `TILL_SERVED_MODE=proxy`. In local mode the header is never read. */
  readonly enabled: boolean;
  /** The lowercased header name TILL reads the subject from. Meaningful only when `enabled`. */
  readonly headerName: string;
}

/** The refusal for a served-mode misconfiguration, thrown before anything binds (fail closed). */
export function servedModeRefusal(reason: string): string {
  return [
    `till: refusing to start, served-mode configuration is invalid: ${reason}`,
    '',
    `${SERVED_MODE_ENV} enables served identity and accepts exactly one value, ${JSON.stringify(SERVED_MODE_PROXY)}`,
    '(an authenticating reverse proxy sets the subject header). Leave it unset for a local install.',
    '',
    `${SUBJECT_HEADER_ENV} names the header the proxy sets; it defaults to ${JSON.stringify(DEFAULT_SUBJECT_HEADER)}`,
    'and, if set, must be a non-blank HTTP header token (RFC 9110 letters, digits and punctuation).',
  ].join('\n');
}

/**
 * An HTTP field-name token per RFC 9110 section 5.1 (the `token` production). We do not need to be
 * maximally permissive: we need to reject a blank or whitespace or otherwise unusable header name so a
 * misconfiguration fails closed rather than silently reading nothing forever.
 */
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Resolve served mode from the environment, or THROW the refusal (fail closed).
 *
 * `TILL_SERVED_MODE` unset (or empty) means local mode: the header is inert and nothing else here
 * matters. Set to exactly `proxy` means served mode. ANY OTHER value refuses to start, because an
 * unrecognised mode must never be read as "off": a typo'd `TILL_SERVED_MODE=Proxy` that silently
 * dropped to local mode would leave a deployment believing it was authenticating when it was not.
 *
 * When served mode is on, the header name is the trimmed `TILL_SUBJECT_HEADER` (lowercased) or the
 * default. A header name that is set but blank, or not a valid token, refuses to start: a server that
 * reads its subject from `""` reads it from nowhere.
 */
export function resolveServedMode(env: NodeJS.ProcessEnv = process.env): ServedModeConfig {
  const raw = env[SERVED_MODE_ENV]?.trim() ?? '';
  if (raw === '') return { enabled: false, headerName: DEFAULT_SUBJECT_HEADER };
  if (raw !== SERVED_MODE_PROXY) {
    throw new Error(servedModeRefusal(`${SERVED_MODE_ENV}=${JSON.stringify(env[SERVED_MODE_ENV])} is not a supported mode`));
  }

  const headerRaw = env[SUBJECT_HEADER_ENV];
  if (headerRaw === undefined) return { enabled: true, headerName: DEFAULT_SUBJECT_HEADER };
  const headerName = headerRaw.trim().toLowerCase();
  if (headerName === '') {
    throw new Error(servedModeRefusal(`${SUBJECT_HEADER_ENV} is set but blank`));
  }
  if (!HEADER_TOKEN.test(headerName)) {
    throw new Error(servedModeRefusal(`${SUBJECT_HEADER_ENV}=${JSON.stringify(headerRaw)} is not a valid header name`));
  }
  return { enabled: true, headerName };
}

/**
 * The subject a request carries, or null. THE TRUST BOUNDARY IN ONE FUNCTION.
 *
 * In LOCAL mode this ALWAYS returns null: the header is never even read, so a client-supplied
 * `Till-Authenticated-Subject` on a loopback dev server can never grant identity (spec §2 US-M01.1
 * boundary, spec §7). This is the "stripped-and-reset in effect" posture on TILL's side: TILL does not
 * trust the header, so nothing a client writes there is consulted unless a proxy configuration turns
 * served mode on, and in that configuration the CONTRACT (step 2) has the proxy overwrite it.
 *
 * In SERVED mode it reads exactly the configured header. Node lowercases every header name and joins a
 * repeated header with `, `; a subject with a comma in it is not a subject we accept (a well-behaved
 * proxy sets exactly one value), so a multi-valued header is treated as absent rather than parsed.
 */
export function extractSubject(headers: IncomingHttpHeaders, config: ServedModeConfig): string | null {
  if (!config.enabled) return null;
  const value = headers[config.headerName];
  // A repeated header arrives as an array (or Node joins it); either way, more than one value is not a
  // single attested subject. Refuse rather than guess which one the proxy meant.
  if (Array.isArray(value)) return null;
  if (typeof value !== 'string') return null;
  const subject = value.trim();
  if (subject === '') return null;
  // Defence in depth against a proxy that folded two values into one comma-joined header: a real
  // subject (an email or an IdP sub) never contains a comma, so this can only be a misconfiguration.
  if (subject.includes(',')) return null;
  return subject;
}
