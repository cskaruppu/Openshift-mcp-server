// Name resolution for other clusters in the lab (e.g. api.aiinfra.tcs.local,
// *.apps.aiinfra.tcs.local). The cluster's own DNS answers "no such name" for
// zones it does not forward, so a lookup that fails the normal way is retried
// against SPOKE_DNS_SERVER — one or more lab DNS servers, comma-separated.
// Nothing changes when neither SPOKE_DNS_SERVER nor LAN_HOSTS is set.
//
// The normal resolver goes first, so in-cluster and public names never depend
// on the lab DNS.
//
// LAN_HOSTS is the hosts-file alternative when no DNS server knows the lab
// domain — like the pod's hostAliases, but with wildcards, so one line covers
// every Route of a cluster:
//   LAN_HOSTS="api.aiinfra.tcs.local=<API VIP>,*.apps.aiinfra.tcs.local=<ingress VIP>"

import { Resolver, lookup as systemLookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

const configured = (process.env.SPOKE_DNS_SERVER || "").split(",").map((s) => s.trim()).filter(Boolean);
const servers = [];
// One resolver per server, asked in turn: each lab DNS may know only its own
// domain, and a resolver given several servers stops at the first "no such name".
// An entry that is not an IP is skipped with a warning: it must never stop the pod starting.
const _resolvers = configured.flatMap((srv) => {
  try { const r = new Resolver({ timeout: 4000, tries: 2 }); r.setServers([srv]); servers.push(srv); return [r]; }
  catch (e) { console.warn(`[lan-dns] Ignoring SPOKE_DNS_SERVER entry "${srv}": ${e.message}`); return []; }
});
const _resolver = _resolvers.length ? true : null;

function resolveViaLab(hostname, i, cb) {
  if (i >= _resolvers.length) return cb(null, []);
  _resolvers[i].resolve4(hostname, (err, addrs) => (!err && addrs?.length ? cb(null, addrs) : resolveViaLab(hostname, i + 1, cb)));
}

// "name=ip" pairs; "*.zone" matches any name under zone (not zone itself).
export function parseLanHosts(text) {
  const out = [];
  for (const part of String(text || "").split(/[,\n]/).map((x) => x.trim()).filter(Boolean)) {
    const m = part.match(/^([*a-z0-9.-]+)\s*=\s*(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (m) out.push({ name: m[1].toLowerCase(), ip: m[2] });
  }
  return out;
}
const hosts = parseLanHosts(process.env.LAN_HOSTS);

/** The LAN_HOSTS address for `hostname`: an exact entry wins over a wildcard. */
export function lanHostsMatch(hostname, list = hosts) {
  const h = String(hostname).toLowerCase().replace(/\.$/, "");
  const exact = list.find((e) => e.name === h);
  if (exact) return exact.ip;
  const wild = list.filter((e) => e.name.startsWith("*.") && h.endsWith(e.name.slice(1))).sort((a, b) => b.name.length - a.name.length)[0];
  return wild ? wild.ip : null;
}

export function lanDnsServers() { return servers.slice(); }

/** dns.lookup-compatible: system resolver first, then the lab DNS. */
export function lanLookup(hostname, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  const reply = (addrs) => (opts && opts.all ? cb(null, addrs.map((a) => ({ address: a, family: 4 }))) : cb(null, addrs[0], 4));
  systemLookup(hostname, opts, (err, address, family) => {
    if (!err || !["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(err.code)) return cb(err, address, family);
    const pinned = lanHostsMatch(hostname);
    if (pinned) return reply([pinned]);
    if (!_resolver) {
      if (hosts.length) err.message = `${err.message} (not in LAN_HOSTS either)`;
      return cb(err);
    }
    resolveViaLab(hostname, 0, (e2, addrs) => {
      if (e2 || !addrs?.length) {
        // Name where else it looked, so "not found" says what to change.
        err.message = `${err.message} (also not found via SPOKE_DNS_SERVER ${servers.join(", ")}${hosts.length ? " or LAN_HOSTS" : ""})`;
        return cb(err);
      }
      return reply(addrs);
    });
  });
}

/** Connect options with the lab lookup added (when a lab DNS is configured). */
export function withLanDns(connect = {}) {
  return _resolver || hosts.length ? { ...connect, lookup: lanLookup } : connect;
}

let _agent = null;
/** fetch() that resolves lab names; plain fetch when no lab DNS is configured. */
export function lanFetch(url, opts = {}) {
  if (!_resolver && !hosts.length) return fetch(url, opts);
  _agent = _agent || new Agent({ connect: withLanDns({ timeout: 15_000 }) });
  return undiciFetch(url, { ...opts, dispatcher: _agent });
}
