if (typeof browser === "undefined") globalThis.browser = chrome;

// Chrome MV3 loads this as a service worker (importScripts); Firefox loads it via
// background.scripts, which already pulls the libs in as separate <script>s.
if (typeof importScripts === "function" && typeof globalThis.GhnHost === "undefined") {
  importScripts("lib/host.js", "lib/storage.js", "lib/notes.js");
}
const H = globalThis.GhnHost;
const S = globalThis.GhnStorage;
const N = globalThis.GhnNotes;

// Files a per-host content script needs, in load order. Static github.com registration
// in the manifest uses the same list.
const CONTENT_SCRIPT_FILES = [
  "lib/purify.min.js",
  "lib/marked.min.js",
  "lib/host.js",
  "lib/storage.js",
  "lib/notes.js",
  "content.js",
];
const CONTENT_SCRIPT_CSS = ["content.css"];

// --- lifecycle --------------------------------------------------------------

browser.runtime.onInstalled.addListener(() => {
  S.ensureMigrated().catch((err) => console.error("[ghn] migration failed", err));
  reconcileHosts().catch((err) => console.error("[ghn] reconcile failed", err));
});

browser.runtime.onStartup.addListener(() => {
  S.ensureMigrated().catch((err) => console.error("[ghn] migration failed", err));
  reconcileHosts().catch((err) => console.error("[ghn] reconcile failed", err));
});

// Users can revoke a host permission from the browser UI at any time; keep the storage
// entry so re-granting later restores their token, but drop the content script.
if (browser.permissions?.onRemoved?.addListener) {
  browser.permissions.onRemoved.addListener((perms) => {
    for (const origin of extractOrigins(perms)) {
      unregisterHost(origin).catch((err) =>
        console.warn("[ghn] unregister after permission removal failed", err)
      );
    }
  });
}
if (browser.permissions?.onAdded?.addListener) {
  browser.permissions.onAdded.addListener((perms) => {
    for (const origin of extractOrigins(perms)) {
      registerHost(origin).catch((err) =>
        console.warn("[ghn] register after permission grant failed", err)
      );
    }
  });
}

function extractOrigins(perms) {
  const out = [];
  for (const pattern of (perms && perms.origins) || []) {
    // pattern looks like "https://ghe.example.com/*"; strip the trailing "/*".
    const match = String(pattern).match(/^(https:\/\/[^/]+)\/\*$/);
    if (match && !H.isDotcomOrigin(match[1])) out.push(match[1]);
  }
  return out;
}

// --- dynamic content-script registration ------------------------------------

async function registerHost(origin) {
  if (!browser.scripting?.registerContentScripts) {
    console.warn("[ghn] browser.scripting.registerContentScripts unavailable");
    return;
  }
  if (H.isDotcomOrigin(origin)) return; // static content script covers github.com

  const id = H.contentScriptId(origin);
  try {
    await browser.scripting.registerContentScripts([
      {
        id,
        matches: [H.commitMatchPattern(origin)],
        js: CONTENT_SCRIPT_FILES,
        css: CONTENT_SCRIPT_CSS,
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    // Chrome: "Duplicate script ID '...'"; Firefox: "already registered".
    if (/duplicate|already/i.test(msg)) return;
    throw err;
  }
}

async function unregisterHost(origin) {
  if (!browser.scripting?.unregisterContentScripts) return;
  if (H.isDotcomOrigin(origin)) return;

  const id = H.contentScriptId(origin);
  try {
    await browser.scripting.unregisterContentScripts({ ids: [id] });
  } catch (err) {
    const msg = (err && err.message) || String(err);
    if (/does not exist|nonexistent|not found/i.test(msg)) return;
    throw err;
  }
}

// Bring registered scripts back in sync with stored+granted hosts. User revocations from
// the browser UI, uninstalled hosts left behind by a crash, etc. all get repaired here.
async function reconcileHosts() {
  if (!browser.scripting?.getRegisteredContentScripts) {
    console.warn("[ghn] browser.scripting.getRegisteredContentScripts unavailable");
    return;
  }

  const stored = await S.listHosts();
  const granted = new Set();
  for (const entry of stored) {
    if (entry.kind === "dotcom") continue;
    try {
      const has = await browser.permissions.contains({
        origins: [H.hostPermissionPattern(entry.origin)],
      });
      if (has) granted.add(entry.origin);
    } catch (err) {
      console.warn("[ghn] permissions.contains failed for", entry.origin, err);
    }
  }

  const registered = await browser.scripting.getRegisteredContentScripts();
  const registeredIds = new Set(
    registered.filter((s) => s.id && s.id.startsWith("ghn-")).map((s) => s.id)
  );

  // Register anything missing.
  for (const origin of granted) {
    if (!registeredIds.has(H.contentScriptId(origin))) {
      try {
        await registerHost(origin);
      } catch (err) {
        console.warn("[ghn] register failed for", origin, err);
      }
    }
  }

  // Unregister anything registered but no longer backed by a stored+granted host.
  const wantedIds = new Set([...granted].map((o) => H.contentScriptId(o)));
  for (const id of registeredIds) {
    if (!wantedIds.has(id)) {
      try {
        await browser.scripting.unregisterContentScripts({ ids: [id] });
      } catch (err) {
        console.warn("[ghn] unregister stale script failed", id, err);
      }
    }
  }
}

// --- message handlers -------------------------------------------------------

browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return;

  switch (message.type) {
    case "CHECK_AUTH":
      handleCheckAuth(message).then(sendResponse);
      return true;

    case "PROBE_HOST":
      handleProbeHost(message).then(sendResponse);
      return true;

    case "LIST_HOSTS":
      handleListHosts().then(sendResponse);
      return true;

    case "ADD_HOST":
      handleAddHost(message).then(sendResponse);
      return true;

    case "REMOVE_HOST":
      handleRemoveHost(message).then(sendResponse);
      return true;

    case "SET_TOKEN":
      handleSetToken(message).then(sendResponse);
      return true;

    case "CLEAR_CACHE":
      handleClearCache().then(sendResponse);
      return true;

    case "OPEN_OPTIONS":
      browser.runtime.openOptionsPage();
      return; // no response

    default:
      return; // unknown type — ignore
  }
});

async function handleCheckAuth({ origin }) {
  const targetOrigin = origin || H.DOTCOM_ORIGIN;
  let host;
  try {
    host = H.deriveHost(targetOrigin);
  } catch (err) {
    return { authenticated: false, error: (err && err.message) || "Invalid host" };
  }

  const token = await S.getToken(host.origin);
  try {
    const { username } = await N.checkAuth(host, token);
    return { authenticated: true, username, usedCookie: !token };
  } catch (err) {
    return { authenticated: false, error: (err && err.message) || "Auth failed" };
  }
}

async function handleProbeHost({ origin }) {
  const normalized = H.normalizeHostInput(origin);
  if (!normalized.ok) return { ok: false, error: normalized.error };
  const host = H.deriveHost(normalized.origin);
  return N.probeHost(host);
}

async function handleListHosts() {
  const hosts = await S.listHosts();
  const out = [];
  for (const h of hosts) {
    let granted = h.kind === "dotcom";
    if (!granted) {
      try {
        granted = await browser.permissions.contains({
          origins: [H.hostPermissionPattern(h.origin)],
        });
      } catch {
        granted = false;
      }
    }
    out.push({ ...h, granted });
  }
  return { hosts: out };
}

async function handleAddHost({ origin }) {
  const normalized = H.normalizeHostInput(origin);
  if (!normalized.ok) return { ok: false, error: normalized.error };

  // permissions.request() cannot run from a service worker — the options page must have
  // already prompted the user. We only accept origins that are already granted.
  let has = false;
  try {
    has = await browser.permissions.contains({
      origins: [H.hostPermissionPattern(normalized.origin)],
    });
  } catch (err) {
    return { ok: false, error: (err && err.message) || "Permission check failed" };
  }
  if (!has) {
    return { ok: false, error: "Permission not granted for that host." };
  }

  const host = await S.addHost(normalized.origin);
  try {
    await registerHost(host.origin);
  } catch (err) {
    return { ok: false, error: `Registered host, but content-script setup failed: ${err && err.message}` };
  }
  return { ok: true, host };
}

async function handleRemoveHost({ origin }) {
  let host;
  try {
    host = H.deriveHost(origin);
  } catch (err) {
    return { ok: false, error: (err && err.message) || "Invalid host" };
  }
  if (host.kind === "dotcom") {
    return { ok: false, error: "github.com cannot be removed." };
  }

  try {
    await unregisterHost(host.origin);
  } catch (err) {
    console.warn("[ghn] unregister failed during REMOVE_HOST", err);
  }
  await S.removeHost(host.origin);
  try {
    await browser.permissions.remove({
      origins: [H.hostPermissionPattern(host.origin)],
    });
  } catch (err) {
    console.warn("[ghn] permissions.remove failed", err);
  }
  return { ok: true };
}

async function handleSetToken({ origin, token }) {
  const targetOrigin = origin || H.DOTCOM_ORIGIN;
  try {
    await S.setToken(targetOrigin, token || "");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err && err.message) || "Failed to save token" };
  }
}

async function handleClearCache() {
  N.clearCache();
  await S.clearCapabilities();
  return { ok: true };
}
