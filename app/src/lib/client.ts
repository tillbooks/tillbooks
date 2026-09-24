/**
 * The typed REST client for Studio.
 *
 * The browser cannot import the engine (better-sqlite3 is native and Node-only). It reaches the
 * engine ONLY over HTTP, which calls the shared REST dispatcher (`handleRest`). This client is
 * generic over `(action, input) -> Promise<RestResponse>`: F1 wires the plumbing, not specific
 * actions. A pluggable `Transport` lets surfaces run against the real bridge and tests inject a fake.
 *
 * `Ok`, `Err` and `Result` are the ENGINE'S OWN TYPES, imported (`import type`) rather than
 * re-declared. Until 2026-07-26 this file hand-mirrored them, and the mirror carried the open index
 * signature `Ok` used to have:
 *
 *     export interface Ok { readonly ok: true; readonly [key: string]: unknown }
 *
 * That index signature answered for every field name, so the Studio's half of "the Studio assumed a
 * shape the engine never sends" was structurally unprovable: `body.entryId` type-checked whatever
 * the engine actually sent, and a picker rendered "1000 undefined" in a live browser with its unit
 * test green. `src/core/result.ts` made the payload generic (`Ok<T>` / `Result<T>`) and `postEntry`
 * declared `PostEntryOk`, but NONE of that reached here: `cd app && npx tsc --noEmit` was green
 * because it could not see the change, not because it agreed with it. Renaming `entryId` in the
 * engine put 9 errors on `src/` and 0 on the Studio.
 *
 * WHY A TYPE-ONLY IMPORT AND NOT A RUNTIME ONE. The reason the mirror existed is real: the browser
 * cannot import the engine (better-sqlite3 is native and Node-only), so the bundle must never gain a
 * runtime dependency on engine code. `import type` is ERASED by the compiler, so it satisfies both
 * halves: the types are the engine's, the bundle is unchanged. `test/style/studio-sees-payloads.test.mjs`
 * re-proves that on the real emitted JS every run, so this cannot rot into a runtime import.
 *
 * The declared payloads themselves live in `./payloads`, keyed to the wire action name.
 *
 * D12: the DEFAULT transport is now MCP over StreamableHTTP (`./mcp-transport`), not the HTTP
 * bridge. Nothing else in this file changed, because that was the point of the seam.
 */
import type { Err, Ok, OkFields, Result } from '../../../src/core/result';

import { mcpTransport } from './mcp-transport';
import type { ActionPayloads } from './payloads';

export type { Err, Ok, OkFields, Result };

/**
 * Mirrors `RestResponse` in `src/api/rest.ts`: 200 ok, 422 domain rejection, 404 unknown action.
 *
 * Generic over the success payload, defaulting to the open shape, so every existing annotation
 * (`const r: RestResponse = ...`) means exactly what it meant before. A canned response that claims
 * a DECLARED payload says so: `RestResponse<PostEntryOk>` judges its own body literal against what
 * the engine's verb promises to send, missing field and stale field alike.
 */
export interface RestResponse<T extends OkFields = OkFields> {
  status: number;
  body: Result<T>;
}

/**
 * The seam every transport implements. Given an action and its input, resolve a `RestResponse`.
 *
 * `resetSession` (optional) drops any live session so the NEXT call re-handshakes. M01 pins the
 * served identity at MCP session open (src/api/mcp-http.ts, a documented contract, not a bug), so
 * a client whose identity RESOLUTION just changed server-side (accepting an invite turns the
 * pinned stranger into a member) must open a fresh session before the next `whoami` answers
 * truthfully. A sessionless transport (the REST bridge) simply omits it.
 */
export type Transport = ((action: string, input: Record<string, unknown>) => Promise<RestResponse>) & {
  resetSession?: () => void;
};

/** Narrow a body to the rejection arm. Payload-agnostic: the rejection arm is the same for every verb. */
export function isErr<T extends OkFields>(body: Result<T>): body is Err {
  return body.ok === false;
}

/**
 * The default transport: `POST /api/${action}` with a JSON body, reading the verb `Result` back.
 * The dev bridge (see `app/dev-api.ts`) mounts the matching route; in production a host serves it.
 * A non-JSON or unreachable endpoint is surfaced as a synthetic `transport_error` Result rather than
 * a thrown exception, so callers always get a readable state.
 */
export function fetchTransport(baseUrl = ''): Transport {
  return async (action, input) => {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input ?? {}),
      });
    } catch (cause) {
      return {
        status: 0,
        body: { ok: false, error: 'transport_error', detail: String(cause) },
      };
    }

    try {
      const body = (await response.json()) as Result;
      return { status: response.status, body };
    } catch {
      return {
        status: response.status,
        body: { ok: false, error: 'transport_error', detail: 'non_json_response' },
      };
    }
  };
}

/** A thin, testable client over a `Transport`. */
export class TillClient {
  constructor(private readonly transport: Transport) {}

  /**
   * Dispatch one action whose payload the ENGINE declares, and answer with THAT payload.
   *
   * This is the last link of the declared-payload chain, and the one that points it at the Studio.
   * `src/core/result.ts` made the success payload generic, `ActionDef<N, T>` stopped the dispatcher
   * erasing it, and `./payloads` derives the wire map off the definitions. None of it reached a
   * single Studio call site, because `call` took a bare `string` and answered with the OPEN
   * `RestResponse`: `body` was `Result<OkFields>` at all 83 of them, `OkFields` carries an index
   * signature, and an index signature answers for every field name. So `body.canPost` type-checked
   * against `list_journal`, which has never sent a `canPost`, and the Post/Save/Reverse gate it feeds
   * read `undefined !== false` and stood open. That is "the Studio assumed a shape the engine never
   * sends" in its purest form: not a renamed field, a field that never existed.
   *
   * Naming the action as a LITERAL is what buys the check. `A extends keyof ActionPayloads` resolves
   * to the payload the action's own `run` promises, so reading a field it does not carry is TS2339
   * (or TS2551 when the name is a near-miss) at the call site, in the surface, in the Studio's own
   * `tsc`.
   */
  call<A extends keyof ActionPayloads>(
    action: A,
    input?: Record<string, unknown>,
  ): Promise<RestResponse<ActionPayloads[A]>>;
  /**
   * Dispatch any other action, exactly as before.
   *
   * The overload is ADDITIVE, which is the only reason it lands at all. An action the engine has not
   * declared, and a call site that passes a `string` VARIABLE rather than a literal (`useSaver` in
   * `Setup/CompanyProfile.tsx`, `runWrite` in `Periods/Periods.tsx`), both fall to this signature and
   * keep precisely the open `RestResponse` they had. 104 of the engine's 110 result signatures are
   * still open; declaring a payload stays a per-verb decision, and an undeclared verb pays nothing.
   */
  call(action: string, input?: Record<string, unknown>): Promise<RestResponse>;
  call(action: string, input: Record<string, unknown> = {}): Promise<RestResponse> {
    return this.transport(action, input);
  }

  /**
   * Drop the live session so the next call re-handshakes (see `Transport.resetSession`). Called
   * after `accept_invite` succeeds: the served MCP session pins its identity at open, so only a
   * FRESH session resolves the new membership. A no-op on a sessionless transport.
   */
  resetSession(): void {
    this.transport.resetSession?.();
  }
}

/**
 * The default client (D12): one MCP session over StreamableHTTP against the same-origin engine.
 *
 * `fetchTransport` above is kept, not deleted. It is the same seam, it still works against the REST
 * twins the engine also mounts, and keeping it means the swap back is this one line rather than an
 * archaeology exercise. The import is deliberately down here, next to its single use, so the seam
 * definition at the top of this file stays free of any particular transport.
 */
export function defaultClient(): TillClient {
  return new TillClient(mcpTransport());
}
