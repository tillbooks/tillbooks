/**
 * The OP6 zero-egress socket probe: the test-time guard that fails a suite if the code under it
 * ever tries to open a network socket.
 *
 * THIS IS THE LOAD-BEARING MECHANISM OF THE E04–E07 CLUSTER (E07 spec §4: "the same code in three
 * places"). It wraps the E04 suites from E04's first commit (the W9 sequencing rule), E05 and E06
 * import it the day they land, and E07 later builds the user-facing `egress_self_test` and the
 * standing indicator around the same idea. The claim it enforces: the whole local-correspondence
 * loop (connect → reindex → threadGet → draftWrite) opens ZERO sockets, our own code and every
 * dependency alike, because a transitive dependency phoning home is the realistic threat
 * (US-E07.3 Boundary).
 *
 * HOW IT WORKS. `node:net`'s `Socket.prototype.connect` is the choke point every TCP path in Node
 * funnels through (`http`, `https`, `tls`, `net.connect` and every client library built on them),
 * so wrapping it catches them all. UDP (`node:dgram`) and DNS resolution (`node:dns`, both
 * callback and promise faces) are wrapped separately because they do not pass through it. Every
 * attempt is RECORDED with its target and stack, and in hard mode (the default) it also THROWS at
 * the attempt so the offending call fails fast and names itself.
 *
 * ASSERT THE RECORD, NOT ONLY THE THROW. Engine code may legitimately catch errors around I/O
 * (E04's `draftWrite` turns an adapter throw into `drafts_not_writable`), so a hard throw alone
 * can be swallowed into a structured refusal. A suite therefore finishes by asserting
 * `probe.violations` is empty: the record survives any catch.
 *
 * A PROBE THAT HAS NEVER BEEN SEEN TO FAIL IS DECORATION (E07 §7), so
 * `test/mail/egress-probe-bites.test.mjs` keeps a deliberate offender that must be caught, and
 * the E04 build additionally proved the wired path once by inserting a socket call into the mail
 * engine and watching the suite go red (removed again; the report records it).
 */

import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';

/** One recorded egress attempt: what was dialled, and by whom. */
function violation(kind, target) {
  return { kind, target, stack: new Error('egress attempt').stack ?? '(no stack)' };
}

/**
 * Install the probe for this process. Returns `{ violations, uninstall }`.
 *
 * `hard: true` (the default) throws at the attempt as well as recording it; `hard: false` only
 * records, which is what a future `egress_status`-style observer would use. Repeated installs
 * stack safely: each `uninstall` restores exactly what its install replaced.
 */
export function installEgressProbe({ hard = true } = {}) {
  const violations = [];

  const refuse = (kind, target) => {
    violations.push(violation(kind, target));
    if (hard) {
      const error = new Error(`OP6 egress refused: ${kind} ${target}`);
      error.name = 'EgressViolation';
      throw error;
    }
  };

  const netConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function patchedConnect(...args) {
    // `net.connect(options)` normalizes its arguments into an ARRAY it passes as the single first
    // argument, so unwrap one level before reading host/port off it.
    const head = Array.isArray(args[0]) ? args[0][0] : args[0];
    const target =
      typeof head === 'object' && head !== null
        ? `${head.host ?? head.path ?? 'unknown'}:${head.port ?? ''}`
        : String(head);
    refuse('tcp_connect', target);
    return netConnect.apply(this, args);
  };

  const dgramSend = dgram.Socket.prototype.send;
  dgram.Socket.prototype.send = function patchedSend(...args) {
    refuse('udp_send', String(args[3] ?? args[2] ?? 'unknown'));
    return dgramSend.apply(this, args);
  };

  const dnsPatches = [];
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt']) {
    const original = dns[name];
    if (typeof original !== 'function') continue;
    dns[name] = function patchedDns(...args) {
      refuse('dns', String(args[0]));
      return original.apply(this, args);
    };
    dnsPatches.push({ name, original });
  }
  const dnsPromisePatches = [];
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveMx', 'resolveTxt']) {
    const original = dns.promises?.[name];
    if (typeof original !== 'function') continue;
    dns.promises[name] = function patchedDnsPromise(...args) {
      refuse('dns', String(args[0]));
      return original.apply(this, args);
    };
    dnsPromisePatches.push({ name, original });
  }

  return {
    violations,
    uninstall() {
      net.Socket.prototype.connect = netConnect;
      dgram.Socket.prototype.send = dgramSend;
      for (const { name, original } of dnsPatches) dns[name] = original;
      for (const { name, original } of dnsPromisePatches) dns.promises[name] = original;
    },
  };
}
