// lib/host.js — host abstraction shared by content.js, background.js, options.js, popup.js.
//
// Loaded as a classic script (content script / <script> tag / importScripts), so it
// attaches to globalThis rather than using ES module exports. Every github.com or
// api.github.com literal in the extension lives in THIS FILE and nowhere else.

(function (root) {
  "use strict";

  const DOTCOM_ORIGIN = "https://github.com";
  const DOTCOM_HOSTNAME = "github.com";
  const DOTCOM_API_BASE = "https://api.github.com";
  const DOTCOM_RAW_ORIGIN = "https://raw.githubusercontent.com";

  const COMMIT_PATH_RE = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{5,40})$/i;

  /**
   * Derive a host descriptor from an origin.
   *
   * @param {string} origin e.g. "https://github.com" or "https://ghe.example.com"
   * @returns {{origin:string,hostname:string,kind:"dotcom"|"ghes",apiBase:string,rawOrigin:string|null,label:string}}
   */
  function deriveHost(origin) {
    const normalized = stripTrailingSlash(String(origin || "").trim());
    let url;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error(`Invalid host origin: ${origin}`);
    }

    const hostname = url.hostname.toLowerCase();
    const isDotcom = hostname === DOTCOM_HOSTNAME;

    if (isDotcom) {
      return {
        origin: DOTCOM_ORIGIN,
        hostname: DOTCOM_HOSTNAME,
        kind: "dotcom",
        apiBase: DOTCOM_API_BASE,
        rawOrigin: DOTCOM_RAW_ORIGIN,
        label: DOTCOM_HOSTNAME,
      };
    }

    // GHES: REST API is always at HOSTNAME/api/v3, unaffected by subdomain isolation.
    // Raw content is served same-origin at HOSTNAME/{owner}/{repo}/raw/... which 302s to
    // raw.HOSTNAME when subdomain isolation is enabled — we let the browser follow that.
    const originOnly = `${url.protocol}//${url.host}`;
    return {
      origin: originOnly,
      hostname,
      kind: "ghes",
      apiBase: `${originOnly}/api/v3`,
      rawOrigin: null,
      label: url.host,
    };
  }

  /** True when the origin is github.com (the always-present, non-removable host). */
  function isDotcomOrigin(origin) {
    try {
      return deriveHost(origin).kind === "dotcom";
    } catch {
      return false;
    }
  }

  /**
   * Normalize free-form user input into a canonical origin.
   * Accepts "ghe.example.com", "https://ghe.example.com/", deep links, etc.
   *
   * @returns {{ok:true,origin:string,kind:string}|{ok:false,error:string}}
   */
  function normalizeHostInput(input) {
    let raw = String(input || "").trim();
    if (!raw) return { ok: false, error: "Enter a hostname." };

    // Reject obvious non-host input early.
    if (/\s/.test(raw)) return { ok: false, error: "Hostname cannot contain spaces." };

    if (/^http:\/\//i.test(raw)) {
      return { ok: false, error: "Only https:// hosts are supported." };
    }
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;

    let url;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, error: "That doesn't look like a valid hostname." };
    }

    if (url.protocol !== "https:") {
      return { ok: false, error: "Only https:// hosts are supported." };
    }
    if (!url.hostname.includes(".")) {
      return { ok: false, error: "Enter a fully qualified hostname (e.g. ghe.example.com)." };
    }

    const hostname = url.hostname.toLowerCase();

    if (hostname === DOTCOM_HOSTNAME) {
      return { ok: false, error: "github.com is always enabled and can't be added." };
    }
    if (hostname === "api.github.com" || hostname === DOTCOM_RAW_ORIGIN.replace("https://", "")) {
      return { ok: false, error: "Enter the web hostname, not an API hostname." };
    }
    if (hostname.startsWith("api.")) {
      return {
        ok: false,
        error: `Enter the web hostname (try ${hostname.slice(4)}), not the API hostname.`,
      };
    }

    const origin = `${url.protocol}//${url.host}`;
    return { ok: true, origin, kind: deriveHost(origin).kind };
  }

  /**
   * Parse a commit page pathname. Identical shape on github.com and GHES.
   * @returns {{owner:string,repo:string,commitSha:string}|null}
   */
  function parseCommitPath(pathname) {
    const match = String(pathname || "").match(COMMIT_PATH_RE);
    if (!match) return null;
    return { owner: match[1], repo: match[2], commitSha: match[3] };
  }

  /** The match pattern used to register a content script for a host. */
  function commitMatchPattern(origin) {
    return `${deriveHost(origin).origin}/*/*/commit/*`;
  }

  /** The host permission pattern to request for a host. */
  function hostPermissionPattern(origin) {
    return `${deriveHost(origin).origin}/*`;
  }

  /** Stable content-script registration id for a host. */
  function contentScriptId(origin) {
    return `ghn-${deriveHost(origin).origin}`;
  }

  /** Convert "refs/notes/commits" → "notes/commits" for web/raw URL paths. */
  function refToBranchPath(noteRef) {
    return String(noteRef || "").replace(/^refs\//, "");
  }

  /**
   * Build the ordered list of candidate URLs to fetch a note blob's raw content.
   *
   * Order is deliberately different per host kind:
   *  - ghes:   same-origin raw (cookie auth covers private repos), then contents API
   *  - dotcom: raw.githubusercontent.com (anon, then PAT), then contents API
   *
   * @param {object} host result of deriveHost()
   * @param {string} owner
   * @param {string} repo
   * @param {string} noteRef  e.g. "refs/notes/commits"
   * @param {string} notePath path within the notes tree, e.g. "<sha>" or "ab/<rest>"
   * @param {{hasToken:boolean, cacheBust?:string}} opts
   * @returns {Array<{url:string, auth:"none"|"token", credentials:"same-origin"|"omit", accept?:string}>}
   */
  function buildNoteContentCandidates(host, owner, repo, noteRef, notePath, opts) {
    const { hasToken = false, cacheBust } = opts || {};
    const branch = refToBranchPath(noteRef);
    const qs = cacheBust ? `?_=${cacheBust}` : "";
    const candidates = [];

    const contentsUrl =
      `${host.apiBase}/repos/${owner}/${repo}/contents/${notePath}` +
      `?ref=${encodeURIComponent(noteRef)}`;

    if (host.kind === "ghes") {
      // Same-origin raw path. Session cookie covers private repos — no PAT needed.
      candidates.push({
        url: `${host.origin}/${owner}/${repo}/raw/${branch}/${notePath}${qs}`,
        auth: "none",
        credentials: "same-origin",
      });
      // Same-origin contents API, cookie first then token.
      candidates.push({
        url: contentsUrl,
        auth: "none",
        credentials: "same-origin",
        accept: "application/vnd.github.raw",
      });
      if (hasToken) {
        candidates.push({
          url: contentsUrl,
          auth: "token",
          credentials: "omit",
          accept: "application/vnd.github.raw",
        });
      }
      return candidates;
    }

    // dotcom — preserve existing behaviour exactly.
    candidates.push({
      url: `${host.rawOrigin}/${owner}/${repo}/${branch}/${notePath}${qs}`,
      auth: "none",
      credentials: "omit",
    });
    if (hasToken) {
      candidates.push({
        url: `${host.rawOrigin}/${owner}/${repo}/${branch}/${notePath}${qs}`,
        auth: "token",
        credentials: "omit",
      });
      candidates.push({
        url: contentsUrl,
        auth: "token",
        credentials: "omit",
        accept: "application/vnd.github.raw+json",
      });
    }
    return candidates;
  }

  /** Request headers for a REST API call against a host. */
  function apiHeaders(host, token, accept) {
    const headers = { Accept: accept || "application/vnd.github+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    // X-GitHub-Api-Version is a github.com concept; GHES ignores it.
    if (host.kind === "dotcom") headers["X-GitHub-Api-Version"] = "2022-11-28";
    return headers;
  }

  /** URL where a user creates a PAT for this host. */
  function tokenCreateUrl(host) {
    return host.kind === "dotcom"
      ? "https://github.com/settings/personal-access-tokens/new"
      : `${host.origin}/settings/tokens/new?scopes=repo&description=Git%20Notes%20Viewer`;
  }

  /** Human-readable description of the token a host needs. */
  function tokenHint(host) {
    return host.kind === "dotcom"
      ? "fine-grained token with Contents: Read-only"
      : "classic token with repo scope";
  }

  function stripTrailingSlash(s) {
    return s.replace(/\/+$/, "");
  }

  const api = {
    DOTCOM_ORIGIN,
    DOTCOM_API_BASE,
    DOTCOM_RAW_ORIGIN,
    COMMIT_PATH_RE,
    deriveHost,
    isDotcomOrigin,
    normalizeHostInput,
    parseCommitPath,
    commitMatchPattern,
    hostPermissionPattern,
    contentScriptId,
    refToBranchPath,
    buildNoteContentCandidates,
    apiHeaders,
    tokenCreateUrl,
    tokenHint,
  };

  root.GhnHost = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : self);
