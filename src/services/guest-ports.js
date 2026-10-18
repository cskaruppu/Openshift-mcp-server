// ---------------------------------------------------------------------------
// Listening ports, from /proc — without running a command in the guest
// ---------------------------------------------------------------------------
/**
 * The port the container should expose, read instead of assumed.
 *
 * Until now the agent put a per-runtime convention in the Containerfile and
 * labelled it an assumption: 8080 for Tomcat, 3000 for Node, 9080 for
 * WebSphere. That assumption is the most expensive one it makes, because a
 * wrong port is not a build failure. The image builds, the pod starts, a TCP
 * probe on the wrong port fails open or fails closed for reasons nobody
 * connects to the port, and the application serves nothing — and it all looks
 * like success until cutover.
 *
 * `ss -ltnp` would answer it in one line, and running `ss` inside somebody's
 * production guest is exactly what this product does not do. But `ss` is only
 * a formatter: the kernel publishes the same table at /proc/net/tcp, which is
 * a FILE. Reading a file needs no shell, no interpreter and no write.
 *
 * So the port stops being a convention and becomes a reading, with no change
 * to what the customer is asked to permit.
 *
 * What this still cannot do, stated rather than glossed:
 *   · Attributing a socket to a PID needs /proc/<pid>/fd, a directory of
 *     symlinks that guest file transfer will not usefully return. So the
 *     answer is "this machine listens on 8080, 8009 and 22", not "Tomcat
 *     listens on 8080". With one application runtime detected that is enough;
 *     with two it narrows rather than decides, and says so.
 *   · Windows has no /proc. These reads come back not-found and the port
 *     stays an assumption, which is the honest outcome.
 *
 * Everything here is pure.
 */

/** /proc/net/tcp st column: 0A is TCP_LISTEN. Nothing else is a served port. */
const TCP_LISTEN = "0A";

/**
 * Ports the kernel never serves an application on, and that would only add
 * noise to a proposal. SSH and RPC are on every Linux box; the container does
 * not inherit them and should not expose them.
 */
export const INFRASTRUCTURE_PORTS = Object.freeze(new Set([22, 111, 25, 631, 5353]));

/**
 * Parse one /proc/net/tcp or /proc/net/tcp6 table.
 *
 * Format, per line after the header:
 *   sl  local_address rem_address st tx_queue:rx_queue tr:tmwhen retrnsmt uid timeout inode
 *   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 12345 1 ...
 *
 * local_address is HEX, little-endian for the v4 address and big-endian for
 * the port — a detail worth stating because reading the port as decimal gives
 * plausible wrong answers (1F90 is 8080, but reads as 1990 if you squint).
 *
 * @returns {Array<{port:number, address:string, uid:number|null, inode:number|null}>}
 */
export function parseProcNetTcp(text = "") {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t || /^sl\s/.test(t)) continue;                 // header
    const f = t.split(/\s+/);
    // sl local rem st tx:rx tr:when retr uid timeout inode
    if (f.length < 10) continue;
    const [local, , st] = [f[1], f[2], f[3]];
    if (st !== TCP_LISTEN) continue;
    const [addrHex, portHex] = String(local).split(":");
    const port = parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    out.push({
      port,
      address: addrHex || null,
      uid: Number.isInteger(Number(f[7])) ? Number(f[7]) : null,
      inode: Number.isInteger(Number(f[9])) ? Number(f[9]) : null,
    });
  }
  return out;
}

/** An all-zero local address means the socket is bound to every interface. */
export function isWildcard(addressHex = "") {
  return /^0+$/.test(String(addressHex));
}

/**
 * The listening ports of a machine, from both address families.
 *
 * Deduplicated: a service bound to both 0.0.0.0 and :: appears in both tables
 * and is one port, not two. Sorted so the output is stable between runs —
 * a report that reorders itself looks like a change that did not happen.
 *
 * @returns {{ports:Array<{port:number,wildcard:boolean,infrastructure:boolean}>, read:boolean}}
 */
export function listeningPorts({ tcp = null, tcp6 = null } = {}) {
  if (tcp == null && tcp6 == null) return { ports: [], read: false };
  const seen = new Map();
  for (const text of [tcp, tcp6]) {
    if (text == null) continue;
    for (const s of parseProcNetTcp(text)) {
      const held = seen.get(s.port);
      const wildcard = isWildcard(s.address);
      if (held) { held.wildcard = held.wildcard || wildcard; continue; }
      seen.set(s.port, {
        port: s.port,
        wildcard,
        infrastructure: INFRASTRUCTURE_PORTS.has(s.port),
      });
    }
  }
  return {
    ports: [...seen.values()].sort((a, b) => a.port - b.port),
    read: true,
  };
}

/** The ports worth proposing a container port from — infrastructure removed. */
export function applicationPorts(ports = []) {
  return ports.filter((p) => !p.infrastructure);
}

/**
 * Reconcile what was read against what the runtime convention assumed.
 *
 * Three outcomes, and they are genuinely different advice:
 *
 *   confirmed  — the convention is in the listening set. The assumption was
 *                right and stops being an assumption.
 *   corrected  — exactly one application port is listening and it is not the
 *                convention. The agent was wrong and now knows the answer.
 *   ambiguous  — several application ports. Narrowed, not decided, because
 *                attributing a socket to a process needs /proc/<pid>/fd.
 *
 * A machine that listens on nothing at all is NOT reported as "no ports". It
 * is a machine whose application may be down, or bound to a unix socket behind
 * a web server, and claiming a fact there would be the same mistake the empty
 * list made everywhere else in this product.
 *
 * @returns {{status:string, port:number|null, assumed:number, candidates:number[], note:string}}
 */
export function reconcilePort(assumed, read) {
  if (!read || read.read !== true) {
    return {
      status: "unread", port: assumed, assumed, candidates: [],
      note: "Listening ports were not read, so the port remains the conventional one for this runtime.",
    };
  }
  const app = applicationPorts(read.ports).map((p) => p.port);
  if (!app.length) {
    return {
      status: "none-listening", port: assumed, assumed, candidates: [],
      note: "The machine is listening on no application port. The service may be stopped, or reachable over a unix socket behind a web server — either way the conventional port is kept and still needs confirming.",
    };
  }
  if (app.includes(assumed)) {
    return {
      status: "confirmed", port: assumed, assumed, candidates: app,
      note: `The machine is listening on ${assumed}, which is what this runtime was assumed to use. Read, not assumed.`,
    };
  }
  if (app.length === 1) {
    return {
      status: "corrected", port: app[0], assumed, candidates: app,
      note: `The machine listens on ${app[0]}, not the conventional ${assumed} for this runtime. The proposal uses what was read.`,
    };
  }
  return {
    status: "ambiguous", port: assumed, assumed, candidates: app,
    note: `The machine listens on ${app.join(", ")} and none of them is the conventional ${assumed}. Attributing a socket to a process needs a read this agent does not do, so pick the one this application serves.`,
  };
}
