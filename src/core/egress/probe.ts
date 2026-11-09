/**
 * E07, the OP6 zero-egress socket probe: the RUNTIME proof that the drafting loop opens no network
 * connection, our own code and every dependency alike.
 *
 * THIS IS THE LOAD-BEARING MECHANISM OF THE WHOLE E04-E07 CLUSTER (spec §4: "the same code in three
 * places", one mechanism for three audiences). The sibling `test/mail/egress-probe.mjs` wraps the
 * CI suites with the same idea (US-E07.3, the build gate); THIS module is the two runtime audiences:
 * `egress.selfTest` installs it in HARD mode for a user's on-demand ritual (US-E07.1), and
 * `monitor.ts` installs it in RECORD mode for the standing indicator (US-E07.2). The claim it
 * enforces: the local-correspondence loop (mail read -> voice retrieve -> draft compose -> Drafts
 * write) opens ZERO outbound sockets, because a transitive dependency phoning home is the realistic
 * threat, not us deciding to betray the user (US-E07.3 Boundary).
 *
 * THE THREAT MODEL, AND HOW EACH VECTOR IS COVERED. Node has more than one door to the network, so a
 * probe that wraps only one is decoration at the others. The enumeration below is deliberately a
 * SUPERSET of the sibling test probe (which covers TCP/UDP/DNS), because the runtime proof is the one
 * a knowledgeable user will try to break:
 *
 *   TCP        `net.Socket.prototype.connect`, the choke point EVERY TCP path funnels through
 *              (`http`, `https`, `tls`, `net.connect`, and every client library built on them). One
 *              wrap catches them all, which is why it is the LEAF layer the record-mode monitor uses.
 *   UDP        `dgram.Socket.prototype.send` (QUIC/HTTP3, DNS-over-UDP, any datagram exfiltration).
 *   DNS        `dns.lookup/resolve*` and `dns.promises.*`. A hostname resolution is a network round
 *              trip to a resolver and can itself carry data in the query name, so it counts even
 *              before any socket opens.
 *   TLS        `tls.connect`, named explicitly for legibility (it reaches TCP underneath, so it is a
 *              HIGH-layer wrap used only in hard mode, where the throw-before-delegate below stops it
 *              double-counting at the leaf).
 *   HTTP(S)    `http.request/get`, `https.request/get`, named for legibility (same high-layer story).
 *   fetch      `globalThis.fetch` (undici), named so a `fetch()` is refused as `fetch` with its URL
 *              rather than as a bare `tcp_connect host:443` three layers down.
 *   WebSocket  `globalThis.WebSocket` (Node 21+), the streaming exfiltration channel a socket count
 *              alone would still catch but a named wrap reports honestly.
 *   subprocess `child_process` exec/spawn/fork and their sync twins. THIS IS THE ONE VECTOR AN
 *              IN-PROCESS SOCKET PATCH CANNOT SEE: a spawned `curl` opens its socket in ANOTHER OS
 *              process, invisible to every wrap above, so the only defence is to intercept the SPAWN.
 *              Its coverage is best-effort and honestly bounded (see the note on the wrapper), and it
 *              is the vector this module flags hardest for review.
 *
 * WHAT THIS PROBE DOES NOT COVER, STATED FIRST NOT LAST (spec §3, the honest threat model): a
 * FILE WRITE outside the sanctioned SQLite/Drafts sandbox is local data spillage, not network
 * egress, and is a different threat class proven by a different mechanism (the E04/E05/E06 §8
 * sentinel/containment suites that grep the raw database, plus FileVault at rest). A socket probe
 * that also policed the filesystem would fire on the legitimate SQLite and Drafts writes the loop
 * makes, so conflating the two would make the trust indicator cry wolf. The boundary is named in the
 * Vertrauen panel's limits list, never hidden.
 *
 * ASSERT THE RECORD, NOT ONLY THE THROW. Engine code may legitimately catch errors around I/O (E06's
 * `draft_generate` turns an adapter throw into `generation_failed`), so a hard throw alone can be
 * swallowed into a structured refusal. A caller therefore inspects `violations` (the record survives
 * any catch), never only whether something threw. `egress.selfTest` does exactly this.
 *
 * A PROBE THAT HAS NEVER BEEN SEEN TO FAIL IS DECORATION (spec §7), so
 * `test/egress/probe-bites.test.mjs` plants a deliberate offender on EACH vector above and asserts
 * every one is caught and named. That non-vacuity test is the single most important test in the
 * capability.
 */

import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import childProcess from 'node:child_process';

/** The closed set of egress kinds the probe attributes a violation to (§H-ENUM discipline). */
export type EgressKind =
  | 'tcp_connect'
  | 'udp_send'
  | 'dns'
  | 'tls_connect'
  | 'http_request'
  | 'https_request'
  | 'fetch'
  | 'websocket'
  | 'subprocess';

/** One recorded egress attempt: what door was used, what was dialled, and the stack that did it. */
export interface EgressViolation {
  kind: EgressKind;
  target: string;
  stack: string;
}

export interface InstalledProbe {
  /** Every attempt seen since install, in order. Empty is the claim; non-empty is the violation. */
  readonly violations: EgressViolation[];
  /** Restore exactly what this install replaced. Stacks safely with other installs. */
  uninstall(): void;
}

export interface ProbeOptions {
  /**
   * `hard` (the self-test default) throws AT the attempt as well as recording it, which both BLOCKS
   * the dial (the offender never reaches the real socket) and, because the throw precedes delegation,
   * stops a high-layer door double-counting at the leaf. `hard:false` (the standing monitor) only
   * records, so it observes without ever changing behaviour: a monitor that threw would turn a
   * dependency's stray connect into a crash instead of a reported fact.
   */
  hard?: boolean;
  /**
   * `leaf` wraps only TCP/UDP/DNS, the layer every real connection funnels through, so the count is
   * exact and never doubled: this is what the RECORD-mode monitor uses. `all` (the default) adds the
   * high-layer doors (tls/http/https/fetch/websocket) and the subprocess spawn, for the legible,
   * blocking self-test where the throw-before-delegate keeps each attempt attributed to its own door.
   */
  layers?: 'leaf' | 'all';
}

function stackHere(): string {
  return new Error('egress attempt').stack ?? '(no stack)';
}

/**
 * Install the probe for this process. Returns `{ violations, uninstall }`.
 *
 * Every install captures the exact functions it replaces and its `uninstall` restores those, so two
 * installs (the standing monitor and a self-test on top of it) stack without either corrupting the
 * other's teardown. In HARD mode a high-layer wrapper throws BEFORE delegating, so the leaf wrapper
 * beneath it is never reached and the attempt is counted once, at the door the caller actually used.
 */
export function installEgressProbe(options: ProbeOptions = {}): InstalledProbe {
  const hard = options.hard ?? true;
  const layers = options.layers ?? 'all';
  const violations: EgressViolation[] = [];

  const refuse = (kind: EgressKind, target: string): void => {
    violations.push({ kind, target, stack: stackHere() });
    if (hard) {
      const error = new Error(`OP6 egress refused: ${kind} ${target}`);
      error.name = 'EgressViolation';
      throw error;
    }
  };

  const restores: Array<() => void> = [];

  // --- LEAF LAYER: TCP / UDP / DNS -------------------------------------------------------------
  // The one layer every real outbound connection reaches, so the monitor's count is taken here and
  // is never doubled.

  const netConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(this: unknown, ...args: unknown[]) {
    // `net.connect(options)` normalises its arguments into an ARRAY it passes as the single first
    // argument, so unwrap one level before reading host/port off it.
    const head = Array.isArray(args[0]) ? args[0][0] : args[0];
    const target =
      typeof head === 'object' && head !== null
        ? `${(head as { host?: string; path?: string }).host ?? (head as { path?: string }).path ?? 'unknown'}:${(head as { port?: number }).port ?? ''}`
        : String(head);
    refuse('tcp_connect', target);
    return (netConnect as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof net.Socket.prototype.connect;
  restores.push(() => {
    net.Socket.prototype.connect = netConnect;
  });

  const dgramSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function patchedSend(this: unknown, ...args: unknown[]) {
    refuse('udp_send', String(args[3] ?? args[2] ?? 'unknown'));
    return (dgramSend as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof dgram.Socket.prototype.send;
  restores.push(() => {
    dgram.Socket.prototype.send = dgramSend;
  });

  const dnsNames = ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt'] as const;
  for (const name of dnsNames) {
    const original = (dns as unknown as Record<string, unknown>)[name];
    if (typeof original !== 'function') continue;
    (dns as unknown as Record<string, unknown>)[name] = function patchedDns(...args: unknown[]) {
      refuse('dns', String(args[0]));
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    restores.push(() => {
      (dns as unknown as Record<string, unknown>)[name] = original;
    });
  }
  if (dns.promises !== undefined) {
    for (const name of dnsNames) {
      const original = (dns.promises as unknown as Record<string, unknown>)[name];
      if (typeof original !== 'function') continue;
      (dns.promises as unknown as Record<string, unknown>)[name] = function patchedDnsP(...args: unknown[]) {
        refuse('dns', String(args[0]));
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      };
      restores.push(() => {
        (dns.promises as unknown as Record<string, unknown>)[name] = original;
      });
    }
  }

  // --- HIGH LAYER: TLS / HTTP / HTTPS / fetch / WebSocket / subprocess --------------------------
  // Only when `layers === 'all'` (the blocking self-test). Each throws before delegating, so it
  // names itself at its own door and never falls through to be counted a second time at the leaf.

  if (layers === 'all') {
    const tlsConnect = tls.connect;
    (tls as unknown as Record<string, unknown>).connect = function patchedTlsConnect(...args: unknown[]) {
      const head = args[0];
      const target =
        typeof head === 'object' && head !== null
          ? `${(head as { host?: string }).host ?? 'unknown'}:${(head as { port?: number }).port ?? ''}`
          : `${String(head)}:${typeof args[1] === 'string' ? args[1] : ''}`;
      refuse('tls_connect', target);
      return (tlsConnect as (...a: unknown[]) => unknown).apply(this, args);
    };
    restores.push(() => {
      (tls as unknown as Record<string, unknown>).connect = tlsConnect;
    });

    const wrapHttp = (moduleObj: unknown, modName: 'http_request' | 'https_request') => {
      const mod = moduleObj as Record<string, unknown>;
      for (const fn of ['request', 'get'] as const) {
        const original = mod[fn];
        mod[fn] = function patchedHttp(this: unknown, ...args: unknown[]) {
          const head = args[0];
          let target = 'unknown';
          if (typeof head === 'string') target = head;
          else if (head instanceof URL) target = head.href;
          else if (typeof head === 'object' && head !== null) {
            const h = head as { host?: string; hostname?: string; port?: number; path?: string };
            target = `${h.hostname ?? h.host ?? 'unknown'}:${h.port ?? ''}${h.path ?? ''}`;
          }
          refuse(modName, target);
          return (original as (...a: unknown[]) => unknown).apply(this, args);
        };
        restores.push(() => {
          mod[fn] = original;
        });
      }
    };
    wrapHttp(http, 'http_request');
    wrapHttp(https, 'https_request');

    const g = globalThis as unknown as Record<string, unknown>;
    if (typeof g.fetch === 'function') {
      const originalFetch = g.fetch as (...a: unknown[]) => unknown;
      g.fetch = function patchedFetch(this: unknown, ...args: unknown[]) {
        const head = args[0];
        const target = head instanceof URL ? head.href : typeof head === 'string' ? head : String((head as { url?: string })?.url ?? 'unknown');
        refuse('fetch', target);
        return originalFetch.apply(this, args);
      };
      restores.push(() => {
        g.fetch = originalFetch;
      });
    }
    if (typeof g.WebSocket === 'function') {
      const OriginalWs = g.WebSocket as new (...a: unknown[]) => unknown;
      const PatchedWs = function patchedWebSocket(this: unknown, ...args: unknown[]) {
        refuse('websocket', String(args[0] ?? 'unknown'));
        return Reflect.construct(OriginalWs, args, PatchedWs as unknown as new () => unknown);
      } as unknown as new (...a: unknown[]) => unknown;
      PatchedWs.prototype = OriginalWs.prototype;
      g.WebSocket = PatchedWs;
      restores.push(() => {
        g.WebSocket = OriginalWs;
      });
    }

    // subprocess: the vector an in-process socket patch CANNOT see, so we intercept the spawn. The
    // wrap is on the module namespace, which catches `cp.exec(...)` / `require('child_process').spawn`,
    // the realistic dependency shape. A module that captured a named import BEFORE this install is a
    // known, documented limitation (spec §3 "our own future code" / supply chain): the honest bound is
    // that this covers the common call styles, not that it is a sandbox.
    for (const fn of ['exec', 'execFile', 'spawn', 'fork', 'execSync', 'execFileSync', 'spawnSync'] as const) {
      const original = (childProcess as unknown as Record<string, unknown>)[fn];
      if (typeof original !== 'function') continue;
      const originalFn = original as (...a: unknown[]) => unknown;
      (childProcess as unknown as Record<string, unknown>)[fn] = function patchedSpawn(this: unknown, ...args: unknown[]) {
        refuse('subprocess', String(args[0] ?? 'unknown'));
        return originalFn.apply(this, args);
      };
      restores.push(() => {
        (childProcess as unknown as Record<string, unknown>)[fn] = original;
      });
    }
  }

  return {
    violations,
    uninstall() {
      // Reverse order, so a stacked install unwinds to exactly the state it found.
      for (let i = restores.length - 1; i >= 0; i--) {
        const restore = restores[i];
        if (restore !== undefined) restore();
      }
    },
  };
}
