/**
 * The localhost guard: DNS-rebinding protection for every HTTP face of the engine.
 *
 * TILL is local-first, so the ledger is served on a loopback port that ANY page in the user's browser
 * can reach. A malicious site rebinds its own domain to 127.0.0.1 and scripts `fetch` at that port;
 * the browser delivers the request happily, because from its point of view the page is talking to its
 * own origin. The only reliable local defence is to validate Host and Origin at the endpoint, which
 * is what the MCP specification prescribes for locally hosted StreamableHTTP servers.
 *
 * This module is the ONE implementation. It has no engine imports on purpose: nothing about it can
 * fail to load, and there is no reason for a second copy to exist anywhere. `local-http.ts` applies
 * it in front of every registry-reaching face, and `mcp-http.ts` applies it again on the handler
 * itself so a caller mounting that handler directly is still covered.
 *
 * Blocker-2 (2026-07-25) is why this file exists as a file. The check used to live inside
 * `mcp-http.ts`, which guarded `/mcp` and nothing else: the Studio bridge mounted a second face,
 * `POST /api/:action`, over the SAME 60-action registry, and it had no check at all. Any website
 * could post an immutable journal entry into the real ledger by changing four characters in the URL.
 */

/** Just the shape the guard reads. Kept structural so it takes a real `IncomingMessage` or a stub. */
export interface GuardableRequest {
  headers: { host?: string | undefined; origin?: string | undefined };
}

/** A refusal: the machine-readable code and the human-readable reason. */
export interface LocalRejection {
  error: 'forbidden_host' | 'forbidden_origin';
  detail: string;
}

/**
 * The hostnames a local endpoint may legitimately be addressed by. Anything else in Host means the
 * browser resolved an attacker's domain to 127.0.0.1, or the request was proxied in from outside;
 * either way it is not this machine's user.
 */
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * True when a hostname is loopback: the set above, or an RFC 6761 `*.localhost` name.
 *
 * ACCEPTED DELIBERATELY (1 of 2): `*.localhost`. RFC 6761 section 6.3 makes the localhost name
 * special, and users "may presume that IPv4 and IPv6 address queries for localhost names will always
 * resolve to the respective IP loopback address": resolvers SHOULD always return loopback for them
 * and caching servers SHOULD answer them immediately without recursion. A name like
 * `studio.localhost` therefore cannot be rebound to an attacker's address by a hostile DNS server
 * the way `evil.com` can, which is precisely the attack this guard exists to stop. Accepting it lets
 * a developer address the bridge by a readable name. The suffix test is anchored on the DOT
 * (`.localhost`), never the substring, so `evil-localhost.com` and `localhost.evil.com` are refused.
 */
function isLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOCAL_HOSTNAMES.has(h) || h.endsWith('.localhost');
}

/** True when a Host header value (`host` or `host:port`) names a loopback host. */
function isLocalHostHeader(value: string): boolean {
  try {
    return isLocalHostname(new URL(`http://${value}`).hostname);
  } catch {
    return false;
  }
}

/** True when an Origin header names a loopback origin. `null` (a sandboxed page) is NOT local. */
function isLocalOrigin(value: string): boolean {
  try {
    return isLocalHostname(new URL(value).hostname);
  } catch {
    return false;
  }
}

/**
 * Validate Host and Origin. Returns the rejection reason, or null to proceed.
 *
 * Port-agnostic on purpose: `till serve` and the tests bind ephemeral ports, so an exact `host:port`
 * allowlist (the SDK's deprecated transport option) would be brittle without being safer. The port
 * is not a security boundary here; the hostname is.
 *
 * ACCEPTED DELIBERATELY (2 of 2): a MISSING Origin passes. Origin is a browser-imposed header, and
 * the browser is the threat model: a rebound page ALWAYS carries one (its own attacker origin), and
 * cannot suppress it on a cross-origin `fetch`. Non-browser clients (the `till` CLI, an agent
 * subprocess, curl, the MCP SDK's own HTTP client) legitimately send none. Requiring Origin would
 * therefore lock out every real local client while stopping no browser attack. Host is checked
 * unconditionally and is what a rebound request cannot forge into a loopback name: `null`, absent,
 * or foreign Host is refused before anything else runs.
 */
export function rejectNonLocal(req: GuardableRequest): LocalRejection | null {
  const hostHeader = req.headers.host;
  if (hostHeader === undefined || !isLocalHostHeader(hostHeader)) {
    return {
      error: 'forbidden_host',
      detail: `Host is not a localhost host: ${hostHeader ?? '(missing)'}`,
    };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !isLocalOrigin(origin)) {
    return { error: 'forbidden_origin', detail: `Origin is not a localhost origin: ${origin}` };
  }
  return null;
}
