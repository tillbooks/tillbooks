/**
 * D198, THE SHIPPED HOST FOR THE SETTLEMENT FEED (`SettlementFeedPort`): the token in the macOS login
 * Keychain, the fetch in a child process.
 *
 * THE TOKEN NEVER TOUCHES THE BOOK, A FILE, A LOG OR A PROCESS ARGUMENT LIST.
 *  - Stored with `security -i`, the command read from STDIN (`add-generic-password -U ... -w "<token>"`), so
 *    the token is not in `ps` output. The engine admits only tokens of a quoting-safe shape (letters,
 *    digits and `. _ ~ + / = -`, `source.ts`), and this module checks the shape again before it writes.
 *  - Read with `security find-generic-password -w`: the token arrives on the child's stdout, into this
 *    process's memory only.
 *  - The fetch runs in a child `node` process that receives `{ url, token, timeoutMs, maxBytes }` as JSON
 *    on STDIN and answers `{ kind, status, body }` on stdout. Synchronous (`spawnSync`), so every door
 *    (MCP, REST, the approval replay, the scheduler) can run the pull; the cost is that the calling
 *    process waits for the answer, at most `timeoutMs`.
 *
 * Service `till-settlement-feed`, account = the engine's locator (`stl-<hash>`): a deterministic, opaque
 * name per (workspace, system, processor), so a new save overwrites the old token.
 *
 * Only on macOS. Elsewhere `resolveSettlementFeedPort` answers undefined and the verbs say so
 * (`secret_store_unavailable`, `feed_transport_missing`): no fallback to the environment or a file.
 * `TILL_SETTLEMENT_FEED=off` switches the port off on a Mac too (a test host, a served install).
 */

import { spawnSync } from 'node:child_process';

import type { SettlementFeedFetch, SettlementFeedPort } from '../core/context.js';

export const SETTLEMENT_KEYCHAIN_SERVICE = 'till-settlement-feed';
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const REF_SHAPE = /^stl-[0-9a-f]{8,64}$/;

/** The child that fetches: reads its job on stdin, prints one JSON line. No dependency beyond Node's fetch. */
const FETCH_CHILD = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  const out = (o) => { process.stdout.write(JSON.stringify(o)); };
  let job;
  try { job = JSON.parse(input); } catch { out({ kind: 'unreachable', reason: 'bad job' }); return; }
  try {
    const res = await fetch(job.url, {
      headers: { authorization: 'Bearer ' + job.token, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(job.timeoutMs),
    });
    const reader = res.body ? res.body.getReader() : null;
    const chunks = [];
    let size = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > job.maxBytes) { out({ kind: 'unreachable', reason: 'the answer is larger than ' + job.maxBytes + ' bytes' }); return; }
        chunks.push(value);
      }
    }
    out({ kind: 'response', status: res.status, body: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8') });
  } catch (e) {
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    out({ kind: 'unreachable', reason: String((e && e.name) || 'error') + (cause ? ': ' + String(cause) : '') });
  }
});
`;

function keychainStore(): Pick<SettlementFeedPort, 'storeToken' | 'deleteToken' | 'hasToken'> & { read(ref: string): string | null } {
  const read = (ref: string): string | null => {
    if (!REF_SHAPE.test(ref)) return null;
    const r = spawnSync('security', ['find-generic-password', '-a', ref, '-s', SETTLEMENT_KEYCHAIN_SERVICE, '-w'], { encoding: 'utf8', timeout: 10_000 });
    if (r.status !== 0) return null;
    const token = r.stdout.replace(/\n$/, '');
    return TOKEN_SHAPE.test(token) ? token : null;
  };
  return {
    read,
    hasToken: (ref) => read(ref) !== null,
    storeToken(ref, token) {
      if (!REF_SHAPE.test(ref) || !TOKEN_SHAPE.test(token)) return { ok: false, reason: 'the token or its locator has a shape the Keychain command cannot carry' };
      const r = spawnSync('security', ['-i'], {
        input: `add-generic-password -U -a "${ref}" -s "${SETTLEMENT_KEYCHAIN_SERVICE}" -l "TILL settlement feed" -w "${token}"\n`,
        encoding: 'utf8',
        timeout: 10_000,
      });
      if (r.status !== 0 || read(ref) !== token) return { ok: false, reason: 'the Keychain did not keep the token (is the login Keychain unlocked?)' };
      return { ok: true };
    },
    deleteToken(ref) {
      if (!REF_SHAPE.test(ref)) return { ok: false, reason: 'not a settlement token locator' };
      spawnSync('security', ['delete-generic-password', '-a', ref, '-s', SETTLEMENT_KEYCHAIN_SERVICE], { encoding: 'utf8', timeout: 10_000 });
      return read(ref) === null ? { ok: true } : { ok: false, reason: 'the Keychain still holds the token' };
    },
  };
}

/** Fetch in a child process; the token travels on its stdin. */
export function childFetch(req: { url: string; token: string; timeoutMs: number; maxBytes: number }): SettlementFeedFetch {
  const r = spawnSync(process.execPath, ['--input-type=commonjs', '-e', FETCH_CHILD], {
    input: JSON.stringify(req),
    encoding: 'utf8',
    timeout: req.timeoutMs + 5_000,
    maxBuffer: req.maxBytes * 2 + 65_536,
    // The child needs nothing of this process's environment but the proxy and certificate settings.
    env: pickEnv(['PATH', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS']),
  });
  if (r.error !== undefined || r.status !== 0) return { kind: 'unreachable', reason: r.error !== undefined ? 'the fetch did not finish in time' : 'the fetch failed' };
  try {
    const parsed = JSON.parse(r.stdout) as SettlementFeedFetch;
    if (parsed.kind === 'response' && typeof parsed.status === 'number' && typeof parsed.body === 'string') return parsed;
    if (parsed.kind === 'unreachable' && typeof parsed.reason === 'string') return parsed;
  } catch {
    // fall through
  }
  return { kind: 'unreachable', reason: 'the fetch answered nothing readable' };
}

function pickEnv(keys: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of keys) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

/**
 * The body with every spelling of the token an echo may use blanked (critic r2 N2): raw, JSON-escaped
 * (`\/`, as PHP's json_encode writes it) and URL-encoded.
 */
export function blankToken(body: string, token: string): string {
  // D198 re-cut R7 (critic r3 observations): every spelling an echo may use. Raw; JSON-escaped (`\/` for a
  // slash, and any character as `\uXXXX`); percent-encoded in either hex case, with `+` or `%20` for a space;
  // and split by whitespace or a line break inside it (a wrapped header dump). Built as one pattern per
  // token: each character may arrive in any of its spellings, with optional whitespace between characters.
  if (token.length === 0) return body;
  const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const spellings = (ch: string): string => {
    const code = ch.charCodeAt(0);
    const hex = code.toString(16).padStart(2, '0');
    const u = code.toString(16).padStart(4, '0');
    const forms = new Set<string>([esc(ch), `%${hex.toLowerCase()}`, `%${hex.toUpperCase()}`, `\\\\u${u}`]);
    if (ch === '/') forms.add('\\\\/');
    if (ch === '+') forms.add('%2[bB]');
    return `(?:${[...forms].join('|')})`;
  };
  const pattern = new RegExp([...token].map(spellings).join('\\s*'), 'gi');
  return body.replace(pattern, '[token]');
}

/** The macOS host port: Keychain plus child fetch. */
export function keychainSettlementFeedPort(): SettlementFeedPort {
  const store = keychainStore();
  return {
    secretStore: 'keychain',
    storeToken: store.storeToken,
    deleteToken: store.deleteToken,
    hasToken: store.hasToken,
    fetchFeed(req) {
      const token = store.read(req.tokenRef);
      if (token === null) return { kind: 'no_token' };
      const answer = childFetch({ url: req.url, token, timeoutMs: req.timeoutMs, maxBytes: req.maxBytes });
      // Critic r1 F6: a producer or a proxy that echoes the request must never hand the token back into an
      // answer. The body is blanked wherever it carries the token, before the engine sees it.
      return answer.kind === 'response' ? { ...answer, body: blankToken(answer.body, token) } : answer;
    },
  };
}

/** The port this host wires, or undefined (not macOS, or `TILL_SETTLEMENT_FEED=off`). */
export function resolveSettlementFeedPort(): SettlementFeedPort | undefined {
  if (process.env['TILL_SETTLEMENT_FEED'] === 'off') return undefined;
  if (process.platform !== 'darwin') return undefined;
  return keychainSettlementFeedPort();
}
