// lib/storage.js — schema-v2 storage access + migration from v1.
//
// v1 schema: { githubToken: "ghp_...", noteRefs: [...] }
// v2 schema: {
//   schemaVersion: 2,
//   hosts:  { "https://ghe.example.com": { kind, addedAt } },   // github.com implicit
//   tokens: { "https://github.com": "ghp_...", ... },
//   noteRefs: [...],
//   capabilities: { "https://ghe.example.com": { treeJson, matchingRefs, ts } }
// }
//
// Tokens are keyed by origin so a token can never be sent to a host it wasn't
// entered for. Attached to globalThis (classic script), depends on lib/host.js.

(function (root) {
  "use strict";

  const H = root.GhnHost || (typeof require !== "undefined" ? require("./host.js") : null);
  if (!H) throw new Error("lib/storage.js requires lib/host.js to be loaded first");

  const SCHEMA_VERSION = 2;
  const CAPABILITY_TTL = 24 * 60 * 60 * 1000; // 24h
  const DEFAULT_NOTE_REFS = ["refs/notes/commits", "refs/notes/claude-prompt-trail"];

  function storage() {
    const b = root.browser || root.chrome;
    if (!b || !b.storage || !b.storage.local) {
      throw new Error("browser.storage.local unavailable");
    }
    return b.storage.local;
  }

  /**
   * Read the whole store, migrating v1 → v2 in place if needed.
   * Idempotent: safe to call on every read (Firefox event pages can miss onInstalled).
   */
  async function getStore() {
    const data = await storage().get(null);
    if (data && data.schemaVersion === SCHEMA_VERSION) return withDefaults(data);
    return withDefaults(await migrate(data || {}));
  }

  function withDefaults(data) {
    return {
      schemaVersion: SCHEMA_VERSION,
      hosts: data.hosts || {},
      tokens: data.tokens || {},
      noteRefs: Array.isArray(data.noteRefs) ? data.noteRefs : [],
      capabilities: data.capabilities || {},
    };
  }

  async function migrate(data) {
    // Already migrated by a concurrent caller?
    if (data.schemaVersion === SCHEMA_VERSION) return data;

    const next = {
      schemaVersion: SCHEMA_VERSION,
      hosts: data.hosts || {},
      tokens: data.tokens || {},
      noteRefs: Array.isArray(data.noteRefs) ? data.noteRefs : [],
      capabilities: data.capabilities || {},
    };

    if (data.githubToken) {
      next.tokens[H.DOTCOM_ORIGIN] = data.githubToken;
    }

    await storage().set(next);
    if (data.githubToken !== undefined) {
      await storage().remove("githubToken");
    }
    return next;
  }

  /** Explicit migration entry point for runtime.onInstalled / onStartup. */
  async function ensureMigrated() {
    await getStore();
  }

  // --- hosts ---

  /**
   * All configured hosts, github.com always first and always present.
   * @returns {Promise<Array<{origin,kind,apiBase,label,removable,hasToken,addedAt}>>}
   */
  async function listHosts() {
    const store = await getStore();
    const origins = [H.DOTCOM_ORIGIN, ...Object.keys(store.hosts).filter((o) => !H.isDotcomOrigin(o))];
    const seen = new Set();
    const out = [];
    for (const origin of origins) {
      if (seen.has(origin)) continue;
      seen.add(origin);
      let host;
      try {
        host = H.deriveHost(origin);
      } catch {
        continue; // skip corrupt entry
      }
      out.push({
        ...host,
        removable: host.kind !== "dotcom",
        hasToken: Boolean(store.tokens[host.origin]),
        addedAt: (store.hosts[host.origin] && store.hosts[host.origin].addedAt) || null,
      });
    }
    return out;
  }

  async function addHost(origin) {
    const host = H.deriveHost(origin);
    if (host.kind === "dotcom") return host; // implicit, nothing to store
    const store = await getStore();
    store.hosts[host.origin] = {
      kind: host.kind,
      addedAt: store.hosts[host.origin]?.addedAt || Date.now(),
    };
    await storage().set({ hosts: store.hosts });
    return host;
  }

  async function removeHost(origin) {
    const host = H.deriveHost(origin);
    if (host.kind === "dotcom") throw new Error("github.com cannot be removed");
    const store = await getStore();
    delete store.hosts[host.origin];
    delete store.tokens[host.origin];
    delete store.capabilities[host.origin];
    await storage().set({
      hosts: store.hosts,
      tokens: store.tokens,
      capabilities: store.capabilities,
    });
  }

  async function hasHost(origin) {
    try {
      const host = H.deriveHost(origin);
      if (host.kind === "dotcom") return true;
      const store = await getStore();
      return Boolean(store.hosts[host.origin]);
    } catch {
      return false;
    }
  }

  // --- tokens ---

  /** Token for exactly this origin, or null. Never falls back to another host's token. */
  async function getToken(origin) {
    let host;
    try {
      host = H.deriveHost(origin);
    } catch {
      return null;
    }
    const store = await getStore();
    return store.tokens[host.origin] || null;
  }

  async function setToken(origin, token) {
    const host = H.deriveHost(origin);
    const store = await getStore();
    if (token) {
      store.tokens[host.origin] = token;
    } else {
      delete store.tokens[host.origin];
    }
    await storage().set({ tokens: store.tokens });
  }

  // --- note refs ---

  async function getNoteRefs() {
    const store = await getStore();
    const refs = new Set(DEFAULT_NOTE_REFS);
    for (const r of store.noteRefs) refs.add(r);
    return [...refs];
  }

  async function setNoteRefs(refs) {
    await storage().set({ noteRefs: Array.isArray(refs) ? refs : [] });
  }

  // --- capability probe cache ---

  /** @returns {Promise<object|null>} cached capabilities if fresh, else null */
  async function getCapabilities(origin) {
    const host = H.deriveHost(origin);
    const store = await getStore();
    const entry = store.capabilities[host.origin];
    if (!entry || Date.now() - (entry.ts || 0) > CAPABILITY_TTL) return null;
    return entry;
  }

  async function setCapability(origin, patch) {
    const host = H.deriveHost(origin);
    const store = await getStore();
    store.capabilities[host.origin] = {
      ...(store.capabilities[host.origin] || {}),
      ...patch,
      ts: Date.now(),
    };
    await storage().set({ capabilities: store.capabilities });
  }

  async function clearCapabilities() {
    await storage().set({ capabilities: {} });
  }

  const api = {
    SCHEMA_VERSION,
    CAPABILITY_TTL,
    DEFAULT_NOTE_REFS,
    getStore,
    migrate,
    ensureMigrated,
    listHosts,
    addHost,
    removeHost,
    hasHost,
    getToken,
    setToken,
    getNoteRefs,
    setNoteRefs,
    getCapabilities,
    setCapability,
    clearCapabilities,
  };

  root.GhnStorage = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
