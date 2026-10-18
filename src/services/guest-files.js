// ---------------------------------------------------------------------------
// Reading files out of a guest — without executing anything in it
// ---------------------------------------------------------------------------
/**
 * The capability App2Container has and this agent did not: seeing the guest's
 * filesystem.
 *
 * A2C gets it by installing a CLI on the machine and running it as root. That
 * is the whole of its advantage, and it is also why it needs an agent, a Docker
 * daemon and administrator rights on a production server. This module gets the
 * same facts a different way: `InitiateFileTransferFromGuest` hands back a
 * one-shot URL for a path inside the guest, over the vCenter API, using the
 * credential the product already takes for `ListProcessesInGuest`.
 *
 * What that buys, and the line it does not cross:
 *
 *   READS  a named file out of the guest. Nothing is installed, nothing is
 *          executed, and nothing is written to the machine. On Linux /proc is
 *          a filesystem, so reading files also yields facts that normally need
 *          a shell — listening sockets most of all.
 *   NEVER  StartProgramInGuest, and never a write. The moment this module runs
 *          a command in somebody's production guest it stops being a thing a
 *          customer can safely point at their estate, and the assessment is
 *          not worth that.
 *
 * Three rules that are refusals, not warnings:
 *
 *  1. ONLY PATHS ON THE ALLOW-LIST. The caller may not pass an arbitrary path
 *     through from a prompt or an API body. A tool that reads any file a
 *     caller names, using a credential the customer supplied for assessment,
 *     is an exfiltration primitive with a nice banner.
 *  2. EVERY READ IS CAPPED. A path that turns out to be a 40GB log is refused
 *     at the byte ceiling rather than streamed into the pod.
 *  3. WHAT IS READ IS REDACTED BEFORE IT TRAVELS. Config files carry
 *     connection strings and passwords. Redaction happens here, on the way in,
 *     so nothing downstream — a report, a model call, a log line — can leak
 *     something this module chose not to hold.
 *
 * Everything except `readGuestFile` is pure and testable without a vCenter.
 */

import {
  vcSoap, vcSoapSession, vcDownload, vcenterConfig, xmlEscape,
} from "../utils/vcenter-client.js";
import { describeGuestOpError } from "./guest-discovery.js";

/** Nothing larger than this comes out of a guest in one read. */
export const MAX_READ_BYTES = 1_000_000;

// ---------------------------------------------------------------------------
// The allow-list
// ---------------------------------------------------------------------------
/**
 * Which paths this agent will ever ask a guest for, and why each one earns it.
 *
 * Adding a row is a deliberate act with a stated purpose, reviewable in a diff.
 * The alternative — a `path` parameter on the tool — reads well in a demo and
 * is indefensible in a security review.
 *
 * `kind` drives redaction: `proc` files are kernel tables with no secrets in
 * them, `config` files are assumed to carry credentials until proven otherwise.
 */
export const READABLE = Object.freeze([
  {
    id: "net-tcp",
    path: "/proc/net/tcp",
    kind: "proc",
    os: "linux",
    why: "Listening TCP sockets. This is the single assumption the agent most wants to retire: the container port is otherwise a per-runtime convention, and a wrong port builds, starts, passes a TCP probe and serves nothing.",
  },
  {
    id: "net-tcp6",
    path: "/proc/net/tcp6",
    kind: "proc",
    os: "linux",
    why: "The IPv6 half of the same table. A service bound only to :: is invisible in /proc/net/tcp and would be reported as not listening.",
  },
  {
    id: "mounts",
    path: "/proc/mounts",
    kind: "proc",
    os: "linux",
    why: "Where the real filesystems are. guest.disk gives capacity per mount for free; this gives the device and the filesystem type behind it, which is how a network mount or a read-only filesystem is told from a local disk.",
  },
  {
    id: "os-release",
    path: "/etc/os-release",
    kind: "proc",
    os: "linux",
    why: "The distribution and version as the guest states it, rather than the guestFullName string vCenter infers from VMware Tools.",
  },
]);

const BY_ID = new Map(READABLE.map((r) => [r.id, r]));

/** The allow-list entry for an id, or null. Never falls through to a raw path. */
export function readable(id) {
  return BY_ID.get(String(id)) || null;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------
/**
 * Strip anything that looks like a credential before the content travels.
 *
 * Deliberately blunt and deliberately over-eager. A false positive costs a
 * line of a config file in a report; a false negative puts a production
 * database password into an assessment document, a model prompt and a log
 * aggregator in one step. The asymmetry is not close.
 */
const SECRET_PATTERNS = [
  // key = value / key: value / <key>value</key> for anything credential-shaped
  /\b(pass(?:word|wd)?|secret|token|apikey|api[_-]?key|credential|private[_-]?key|accesskey)\b\s*[:=]\s*\S+/gi,
  /<\s*(pass(?:word|wd)?|secret|token|credential)\s*>[^<]*<\s*\/\s*\1\s*>/gi,
  // A URI with inline credentials: scheme://user:pass@host
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:/@]+):([^\s@]+)@/gi,
  // PEM blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redact(text = "") {
  let out = String(text);
  out = out.replace(SECRET_PATTERNS[0], (m) => `${m.split(/[:=]/)[0]}=[REDACTED]`);
  out = out.replace(SECRET_PATTERNS[1], (_m, k) => `<${k}>[REDACTED]</${k}>`);
  out = out.replace(SECRET_PATTERNS[2], (_m, scheme, user) => `${scheme}${user}:[REDACTED]@`);
  out = out.replace(SECRET_PATTERNS[3], "[REDACTED PRIVATE KEY]");
  return out;
}

// ---------------------------------------------------------------------------
// Request builders — pure
// ---------------------------------------------------------------------------

/** GuestOperationsManager owns a fileManager, same as it owns a processManager. */
export function buildFileManagerLookupBody({ propertyCollector = "propertyCollector", guestOperationsManager }) {
  return `<RetrievePropertiesEx xmlns="urn:vim25">`
    + `<_this type="PropertyCollector">${xmlEscape(propertyCollector)}</_this>`
    + `<specSet>`
    + `<propSet><type>GuestOperationsManager</type><all>false</all><pathSet>fileManager</pathSet></propSet>`
    + `<objectSet><obj type="GuestOperationsManager">${xmlEscape(guestOperationsManager)}</obj><skip>false</skip></objectSet>`
    + `</specSet><options/></RetrievePropertiesEx>`;
}

/**
 * InitiateFileTransferFromGuest — ask for a download URL for one path.
 *
 * This does not transfer anything. It returns a short-lived URL that has to be
 * fetched separately, which is why the session cookie has to travel with it.
 */
export function buildFileTransferFromGuestBody({ fileManager, vmId, username, password, guestFilePath }) {
  return `<InitiateFileTransferFromGuest xmlns="urn:vim25">`
    + `<_this type="GuestFileManager">${xmlEscape(fileManager)}</_this>`
    + `<vm type="VirtualMachine">${xmlEscape(vmId)}</vm>`
    + `<auth xsi:type="NamePasswordAuthentication">`
    + `<interactiveSession>false</interactiveSession>`
    + `<username>${xmlEscape(username)}</username>`
    + `<password>${xmlEscape(password)}</password>`
    + `</auth>`
    + `<guestFilePath>${xmlEscape(guestFilePath)}</guestFilePath>`
    + `</InitiateFileTransferFromGuest>`;
}

// ---------------------------------------------------------------------------
// Response parsers — pure
// ---------------------------------------------------------------------------

export function parseFileManager(xml = "") {
  return /<propSet><name>fileManager<\/name><val[^>]*>([^<]+)<\/val><\/propSet>/.exec(String(xml))?.[1] || null;
}

/** FileTransferInformation: a url and the size vCenter says the file is. */
export function parseFileTransferInfo(xml = "") {
  const block = /<returnval>([\s\S]*?)<\/returnval>/.exec(String(xml))?.[1] || String(xml);
  const url = /<url>([\s\S]*?)<\/url>/.exec(block)?.[1] || null;
  const size = /<size>(\d+)<\/size>/.exec(block)?.[1] || null;
  if (!url) return null;
  return {
    url: url.replace(/&amp;/g, "&").trim(),
    size: size == null ? null : Number(size),
  };
}

/**
 * vCenter returns the transfer URL with `*` where the host should be.
 *
 * It does this whenever it cannot decide which address the client will reach
 * it on — which, behind any ingress or NAT, is most of the time. Fetching the
 * URL verbatim resolves `*` as a hostname and fails with a DNS error that
 * reads as a network problem rather than the documented behaviour it is.
 */
export function normaliseTransferUrl(url, vcenterUrl) {
  const raw = String(url || "");
  if (!raw) return null;
  let host;
  try { host = new URL(String(vcenterUrl)).host; } catch { return raw; }
  return raw.replace(/^(https?:\/\/)\*(?=[:/]|$)/i, `$1${host}`);
}

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------
/**
 * Read one allow-listed file out of one guest.
 *
 * Never throws: every failure comes back as `{ ok:false, reason }` phrased for
 * the guest's owner, because "could not read" without the reason sends someone
 * to the wrong team. The reasons are the same four guest-discovery already
 * categorises, plus the two that are specific to files — not present, and not
 * readable by this credential.
 *
 * @returns {{ok:boolean, id, path, text?:string, bytes?:number, truncated?:boolean, reason?:string, failure?:string}}
 */
export async function readGuestFile({ vmId, fileId, username, password, cfg = null, fileManager = null, maxBytes = MAX_READ_BYTES }) {
  const entry = readable(fileId);
  if (!entry) {
    return {
      ok: false, id: fileId, path: null, failure: "not-allow-listed",
      reason: `"${fileId}" is not a path this agent reads. The readable set is fixed in code and every entry states why it earns a read.`,
    };
  }
  cfg = cfg || vcenterConfig();
  if (!cfg.configured) return { ok: false, id: entry.id, path: entry.path, failure: "no-vcenter", reason: cfg.reason };
  if (!username || !password) {
    return {
      ok: false, id: entry.id, path: entry.path, failure: "no-credential",
      reason: "No guest credential was supplied, so nothing inside this machine was read.",
    };
  }

  try {
    if (!fileManager) fileManager = await resolveFileManager(cfg);
    if (!fileManager) {
      return {
        ok: false, id: entry.id, path: entry.path, failure: "no-file-manager",
        reason: "This vCenter did not report a guest file manager, so guest file reads are unavailable.",
      };
    }

    const session = await vcSoapSession(cfg);
    const xml = await vcSoap(() => buildFileTransferFromGuestBody({
      fileManager, vmId, username, password, guestFilePath: entry.path,
    }), { cfg, timeoutMs: 30_000 });

    const info = parseFileTransferInfo(xml);
    if (!info) {
      return {
        ok: false, id: entry.id, path: entry.path, failure: "no-url",
        reason: "vCenter accepted the request but returned no transfer URL.",
      };
    }
    // /proc files report size 0 — they are generated on read — so a zero size
    // is not a reason to skip the download.
    if (info.size != null && info.size > maxBytes) {
      return {
        ok: false, id: entry.id, path: entry.path, failure: "too-large",
        reason: `${entry.path} is ${info.size} bytes, over the ${maxBytes}-byte ceiling this agent reads. It was not downloaded.`,
      };
    }

    const url = normaliseTransferUrl(info.url, cfg.url);
    const { body, truncated } = await vcDownload(url, { cfg, cookie: session.cookie, maxBytes, timeoutMs: 60_000 });

    // Redact on the way in. Nothing downstream gets the chance to leak what
    // this module decided not to hold.
    const text = entry.kind === "proc" ? body.toString("utf8") : redact(body.toString("utf8"));
    return { ok: true, id: entry.id, path: entry.path, kind: entry.kind, text, bytes: body.length, truncated };
  } catch (e) {
    return {
      ok: false, id: entry.id, path: entry.path,
      failure: categoriseFileError(e.message),
      reason: describeFileError(e.message, entry.path),
    };
  }
}

/** The fileManager MoRef, read once per call site rather than assumed. */
export async function resolveFileManager(cfg = null) {
  const xml = await vcSoap((s) => buildFileManagerLookupBody({ guestOperationsManager: s.guestOperationsManager }), {
    cfg, timeoutMs: 30_000,
  });
  return parseFileManager(xml);
}

/**
 * File reads fail in two ways guest-discovery's process reads cannot, and both
 * are ordinary rather than broken: the path is not there (a Windows guest, a
 * distribution that mounts /proc differently), or the credential can see the
 * machine but not that file.
 */
export function categoriseFileError(message = "") {
  const m = String(message);
  if (/FileNotFound|was not found|does not exist/i.test(m)) return "file-not-found";
  if (/CannotAccessFile|NoPermission.*file|Permission denied|access is denied/i.test(m)) return "file-not-readable";
  return categoriseFromGuestOp(m);
}

function categoriseFromGuestOp(m) {
  if (/InvalidGuestLogin|Failed to authenticate/i.test(m)) return "credential-rejected";
  if (/GuestOperationsUnavailable|guest operations agent/i.test(m)) return "tools-not-answering";
  if (/NoPermission|GuestOperations\./i.test(m)) return "vcenter-privilege";
  if (/NotSupported|not supported/i.test(m)) return "guest-unsupported";
  return "other";
}

export function describeFileError(message = "", path = "") {
  const m = String(message);
  if (/FileNotFound|was not found|does not exist/i.test(m)) {
    return `${path} does not exist in this guest. On a Windows guest that is expected — these paths are Linux only.`;
  }
  if (/CannotAccessFile|Permission denied|access is denied/i.test(m)) {
    return `The guest credential can log in but may not read ${path}. An unprivileged account reads /proc/net/tcp and /etc/os-release; the rest needs more.`;
  }
  if (/NoPermission|GuestOperations\./i.test(m)) {
    return "The vCenter account is missing the Guest Operations privilege. Grant Virtual Machine → Guest Operations → Guest Operation Modifications or File Query on this machine.";
  }
  return describeGuestOpError(m);
}
