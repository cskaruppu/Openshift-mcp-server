// Name resolution for other clusters in the lab (e.g. api.aiinfra.tcs.local,
// *.apps.aiinfra.tcs.local). The cluster's own DNS answers "no such name" for
// zones it does not forward, so a lookup that fails the normal way is retried
// against SPOKE_DNS_SERVER — one or more lab DNS servers, comma-separated.
// Nothing changes when SPOKE_DNS_SERVER is not set.
//
// The normal resolver goes first, so in-cluster and public names never depend
// on the lab DNS.

import { Resolver, lookup as systemLookup } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

const servers = (process.env.SPOKE_DNS_SERVER || "").split(",").map((s) => s.trim()).filter(Boolean);
let _resolver = null;
if (servers.length) {
  _resolver = new Resolver({ timeout: 4000, tries: 2 });
  _resolver.setServers(servers);
}

export function lanDnsServers() { return servers.slice(); }

/** dns.lookup-compatible: system resolver first, then the lab DNS. */
export function lanLookup(hostname, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  systemLookup(hostname, opts, (err, address, family) => {
    if (!err || !_resolver || !["ENOTFOUND", "EAI_AGAIN", "ENODATA"].includes(err.code)) return cb(err, address, family);
    _resolver.resolve4(hostname, (e2, addrs) => {
      if (e2 || !addrs?.length) {
        // Name the lab servers in the error, so "not found" says where it looked.
        err.message = `${err.message} (also not found via SPOKE_DNS_SERVER ${servers.join(", ")})`;
        return cb(err);
      }
      if (opts && opts.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })));
      return cb(null, addrs[0], 4);
    });
  });
}

/** Connect options with the lab lookup added (when a lab DNS is configured). */
export function withLanDns(connect = {}) {
  return _resolver ? { ...connect, lookup: lanLookup } : connect;
}

let _agent = null;
/** fetch() that resolves lab names; plain fetch when no lab DNS is configured. */
export function lanFetch(url, opts = {}) {
  if (!_resolver) return fetch(url, opts);
  _agent = _agent || new Agent({ connect: withLanDns({ timeout: 15_000 }) });
  return undiciFetch(url, { ...opts, dispatcher: _agent });
}
