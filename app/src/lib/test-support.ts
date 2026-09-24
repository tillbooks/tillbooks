/**
 * Shared test seams for the app suites (not shipped code paths, but plain TS so any suite can import
 * it). `installMemoryStorage` mirrors the helper `app/src/app/theme.test.tsx` already grew: the jsdom
 * `localStorage` shape is not dependable here, and a persistence test must not depend on it.
 */
import type { Ok, RestResponse } from './client';
import type { ActionPayloads } from './payloads';
import { REQUIRED_FIELDS } from './payloads';

/** A minimal in-memory `Storage`. */
export function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

/** Replace `window.localStorage` with a fresh in-memory one. Call it in `beforeEach`. */
export function installMemoryStorage(): Storage {
  const storage = memoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
  return storage;
}

/**
 * A response recorded off the live engine, seen as the `Ok` body it is.
 *
 * A JSON module types `"ok": true` as `boolean`, never as the literal `true`, so a recorded payload
 * is not assignable to `Ok` and `{ status: 200, body: someFixture }` does not type-check as a
 * `RestResponse`. That is not pedantry: it means every "pin the recording into a canned response"
 * site in the suites was unchecked, which is the exact opposite of what recording a fixture is for.
 *
 * The narrowing is a RUNTIME check rather than a cast, deliberately. A fixture recaptured from a
 * rejection throws here, loudly, instead of being quietly relabelled a success and rendered as one.
 */
export function recordedOk(body: { ok: boolean } & Record<string, unknown>): Ok {
  if (body.ok !== true) {
    throw new Error(`the recording is a rejection, not an ok body: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return { ...body, ok: true };
}

/**
 * A canned 200 for an action whose payload the ENGINE declares (`./payloads`).
 *
 * A hand-written test double is where "the Studio assumed a shape the engine never sends" is cheapest
 * to introduce and hardest to see: the double agrees with the surface by construction, so the suite
 * goes green against a shape the engine stopped sending. The account picker that rendered
 * "1000 undefined" in a live browser had a hand-written fixture that set BOTH key spellings, so it
 * agreed with the bug.
 *
 * Naming the action here is what buys the check. `body` is judged against the payload
 * `postEntry` itself declares, so a field the engine renamed is a compile error in the double, and a
 * field it never had is an excess-property error. The runtime loop is the belt to that braces: it
 * refuses a double that omits a required field outright, naming the field, rather than letting the
 * surface read `undefined` off it.
 */
export function cannedOk<A extends keyof ActionPayloads>(
  action: A,
  body: Ok<ActionPayloads[A]>,
): RestResponse<ActionPayloads[A]> {
  for (const field of REQUIRED_FIELDS[action]) {
    if (!(field in body)) {
      throw new Error(
        `the canned ${action} success is missing \`${field}\`, which the engine's payload declares as ` +
          `required. A double that omits it stands in for a response the engine cannot send. Got: ` +
          `${JSON.stringify(body).slice(0, 200)}`,
      );
    }
  }
  return { status: 200, body };
}
