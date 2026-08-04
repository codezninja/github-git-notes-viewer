// lib/notes.js — host-aware REST ladder for resolving git notes.
//
// Extracted from the previously-unreachable implementation in background.js so a single
// code path serves both the background service worker and content.js's tree-discovery
// fallback (used when a host has no tree JSON payload endpoint, i.e. older GHES).
//
// Attached to globalThis (classic script). Depends on lib/host.js.

(function (root) {
  "use strict";

  const H = root.GhnHost || (typeof require !== "undefined" ? require("./host.js") : null);
  if (!H) throw new Error("lib/notes.js requires lib/host.js to be loaded first");

  const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  // key = "<origin>|<owner>/<repo>:<noteRef>"  → { tree: Map, ts }
  const treeCache = new Map();

  function cacheKey(host, owner, repo, noteRef) {
    return `${host.origin}|${owner}/${repo}:${noteRef}`;
  }

  function isCacheValid(entry) {
    return entry && Date.now() - entry.ts < CACHE_TTL;
  }

  function clearCache() {
    treeCache.clear();
  }

  /**
   * REST call against a host's API base.
   * @param {object} host deriveHost() result
   * @param {string} path e.g. "/repos/o/r/git/trees/abc"
   * @param {string|null} token
   * @param {{credentials?:RequestCredentials, accept?:string, raw?:boolean}} opts
   */
  async function api(host, path, token, opts = {}) {
    const res = await fetch(`${host.apiBase}${path}`, {
      headers: H.apiHeaders(host, token, opts.accept),
      // GHES API is same-origin with the commit page, so the session cookie is a valid
      // auth mechanism there and avoids requiring a PAT for private repos.
      credentials: opts.credentials || (host.kind === "ghes" ? "same-origin" : "omit"),
    });

    if (res.status === 401) throw { status: 401, message: "Invalid or expired token" };
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const reset = res.headers.get("x-ratelimit-reset");
        const resetDate = reset ? new Date(Number(reset) * 1000) : null;
        throw {
          status: 403,
          message: `Rate limit exceeded${resetDate ? `. Resets at ${resetDate.toLocaleTimeString()}` : ""}`,
        };
      }
      throw { status: 403, message: "Forbidden" };
    }
    if (res.status === 404) throw { status: 404, message: "Not found" };
    if (!res.ok) throw { status: res.status, message: `API error: ${res.status}` };

    return opts.raw ? res.text() : res.json();
  }

  /**
   * Probe whether a host looks like GitHub Enterprise Server (or github.com).
   * Used by the options page to refuse adding a non-GitHub origin.
   * @returns {Promise<{ok:true, version:string|null}|{ok:false, error:string}>}
   */
  async function probeHost(host) {
    try {
      const meta = await api(host, "/meta", null, { credentials: "omit" });
      const version = meta.installed_version || null;
      // github.com /meta has no installed_version but does have verifiable_password_...
      const looksRight =
        version !== null || Array.isArray(meta.hooks) || Array.isArray(meta.web);
      if (!looksRight) {
        return { ok: false, error: "That host doesn't look like GitHub Enterprise Server." };
      }
      return { ok: true, version };
    } catch (err) {
      if (err && err.status === 401) {
        // API reachable but requires auth — still a GitHub host.
        return { ok: true, version: null };
      }
      return {
        ok: false,
        error: `Couldn't reach ${host.label}/api/v3 (${(err && err.message) || "network error"}).`,
      };
    }
  }

  /** Validate a token (or cookie session) against a host. */
  async function checkAuth(host, token) {
    const user = await api(host, "/user", token);
    return { username: user.login };
  }

  /** Discover refs/notes/* on a repo. Returns [] when unavailable. */
  async function discoverNoteRefs(host, owner, repo, token) {
    try {
      const data = await api(host, `/repos/${owner}/${repo}/git/matching-refs/notes`, token);
      if (!Array.isArray(data)) return [];
      return data.map((r) => r.ref).filter((r) => typeof r === "string" && r.startsWith("refs/notes/"));
    } catch {
      return [];
    }
  }

  /**
   * Fetch the top-level notes tree for a ref, cached per host+repo+ref.
   * @returns {Promise<Map<string,{type:"blob"|"tree",sha:string}>>}
   */
  async function fetchNotesTree(host, owner, repo, noteRef, token) {
    const key = cacheKey(host, owner, repo, noteRef);
    const cached = treeCache.get(key);
    if (isCacheValid(cached)) return cached.tree;

    const encodedRef = noteRef.replace(/\//g, "%2F");
    const refData = await api(host, `/repos/${owner}/${repo}/git/ref/${encodedRef}`, token);
    const commitSha = refData.object.sha;

    const commitData = await api(host, `/repos/${owner}/${repo}/git/commits/${commitSha}`, token);
    const treeSha = commitData.tree.sha;

    const treeData = await api(host, `/repos/${owner}/${repo}/git/trees/${treeSha}`, token);

    const tree = new Map();
    for (const entry of treeData.tree) {
      if (entry.type === "blob") {
        // Direct mapping: entry.path is the full commit SHA
        tree.set(entry.path, { type: "blob", sha: entry.sha });
      } else if (entry.type === "tree") {
        // Fanout: entry.path is the first 2 chars of the commit SHA
        tree.set(entry.path, { type: "tree", sha: entry.sha });
      }
    }

    treeCache.set(key, { tree, ts: Date.now() });
    return tree;
  }

  /**
   * Resolve a commit SHA (full or abbreviated) to the note's path within the notes tree,
   * handling both flat and fanned-out layouts.
   * @returns {Promise<{path:string, blobSha:string}|null>}
   */
  async function resolveNotePath(host, owner, repo, noteRef, commitSha, token) {
    const tree = await fetchNotesTree(host, owner, repo, noteRef, token);
    const abbreviated = commitSha.length < 40;

    // Flat layout — exact match, or prefix match for abbreviated SHAs.
    const direct = tree.get(commitSha);
    if (direct && direct.type === "blob") {
      return { path: commitSha, blobSha: direct.sha };
    }
    if (abbreviated) {
      for (const [path, entry] of tree) {
        if (entry.type === "blob" && path.startsWith(commitSha)) {
          return { path, blobSha: entry.sha };
        }
      }
    }

    // Fanout layout — first 2 chars are a subtree, the rest is the blob name.
    const prefix = commitSha.slice(0, 2);
    const suffix = commitSha.slice(2);
    const subtreeEntry = tree.get(prefix);
    if (!subtreeEntry || subtreeEntry.type !== "tree") return null;

    const subtreeData = await api(
      host,
      `/repos/${owner}/${repo}/git/trees/${subtreeEntry.sha}`,
      token
    );
    for (const entry of subtreeData.tree) {
      if (entry.type !== "blob") continue;
      if (entry.path === suffix || (abbreviated && entry.path.startsWith(suffix))) {
        return { path: `${prefix}/${entry.path}`, blobSha: entry.sha };
      }
    }

    return null;
  }

  /** Fetch and decode a blob's content. */
  async function fetchBlobContent(host, owner, repo, blobSha, token) {
    const blobData = await api(host, `/repos/${owner}/${repo}/git/blobs/${blobSha}`, token);
    if (blobData.encoding === "base64") {
      return decodeBase64Utf8(blobData.content.replace(/\s/g, ""));
    }
    return blobData.content;
  }

  // atob() yields latin1; notes are UTF-8 and frequently contain non-ASCII.
  function decodeBase64Utf8(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  /**
   * Full REST path: commit SHA → note content, or null when the commit has no note.
   * Throws {status,message} on API errors (callers treat 404 as "no notes ref").
   */
  async function fetchGitNote(host, owner, repo, noteRef, commitSha, token) {
    const resolved = await resolveNotePath(host, owner, repo, noteRef, commitSha, token);
    if (!resolved) return null;
    return fetchBlobContent(host, owner, repo, resolved.blobSha, token);
  }

  const exported = {
    CACHE_TTL,
    api,
    probeHost,
    checkAuth,
    discoverNoteRefs,
    fetchNotesTree,
    resolveNotePath,
    fetchBlobContent,
    fetchGitNote,
    clearCache,
    cacheKey,
    decodeBase64Utf8,
  };

  root.GhnNotes = exported;
  if (typeof module !== "undefined" && module.exports) module.exports = exported;
})(typeof globalThis !== "undefined" ? globalThis : self);
