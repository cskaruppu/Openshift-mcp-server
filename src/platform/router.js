/**
 * Platform Router
 *
 * Routes API calls to the correct backend based on detected platform.
 * When platform is OpenShift, delegates to existing ocpGet/ocpPost.
 * When platform is anything else, uses the generic k8s-client.
 *
 * This is the ONLY integration point with the existing codebase.
 * The existing code path is NEVER modified — the router wraps it.
 */

import { getPlatform, isOpenShiftFamily } from "./detect.js";
import { k8sGet, k8sPost, k8sPatch, k8sDelete } from "./k8s-client.js";

let _ocpGetFn = null;
let _ocpPostFn = null;
let _ocpPatchFn = null;
let _ocpDeleteFn = null;
let _ocpFetchFn = null;

/**
 * Register the existing OpenShift client functions.
 * Called once at startup so the router can delegate to them.
 */
function registerOcpClient({ ocpGet, ocpPost, ocpPatch, ocpDelete, ocpFetch }) {
  _ocpGetFn = ocpGet;
  _ocpPostFn = ocpPost;
  _ocpPatchFn = ocpPatch;
  _ocpDeleteFn = ocpDelete;
  _ocpFetchFn = ocpFetch;
}

/**
 * Smart GET — routes to the correct backend.
 * OpenShift family → existing ocpGet (preserves all caching, tracing, etc.)
 * Other platforms → generic k8sGet
 */
async function platformGet(path) {
  if (isOpenShiftFamily(getPlatform()) && _ocpGetFn) {
    return _ocpGetFn(path);
  }
  return k8sGet(path);
}

async function platformPost(path, body) {
  if (isOpenShiftFamily(getPlatform()) && _ocpPostFn) {
    return _ocpPostFn(path, body);
  }
  return k8sPost(path, body);
}

async function platformPatch(path, body) {
  if (isOpenShiftFamily(getPlatform()) && _ocpPatchFn) {
    return _ocpPatchFn(path, body);
  }
  return k8sPatch(path, body);
}

async function platformDelete(path) {
  if (isOpenShiftFamily(getPlatform()) && _ocpDeleteFn) {
    return _ocpDeleteFn(path);
  }
  return k8sDelete(path);
}

/**
 * Get the appropriate API getter function for the current platform.
 * This is what providers use internally.
 */
function getApiGet() {
  if (isOpenShiftFamily(getPlatform()) && _ocpGetFn) {
    return _ocpGetFn;
  }
  return k8sGet;
}

/**
 * Check if the current platform uses OpenShift-specific APIs.
 * Used by chat-api.js to decide whether to run OCP-specific handlers.
 */
function useOpenShiftHandlers() {
  return isOpenShiftFamily(getPlatform());
}

/**
 * Get platform-specific command prefix (oc vs kubectl).
 */
function getCommandPrefix() {
  return isOpenShiftFamily(getPlatform()) ? "oc" : "kubectl";
}

/**
 * Generate platform-appropriate command strings.
 * Replaces "oc" with "kubectl" for non-OpenShift platforms.
 */
function adaptCommand(ocCommand) {
  if (isOpenShiftFamily(getPlatform())) return ocCommand;
  return ocCommand
    .replace(/^oc\s/, "kubectl ")
    .replace(/\boc\s/g, "kubectl ")
    .replace(/\boc$/g, "kubectl");
}

export {
  registerOcpClient,
  platformGet,
  platformPost,
  platformPatch,
  platformDelete,
  getApiGet,
  useOpenShiftHandlers,
  getCommandPrefix,
  adaptCommand,
};
