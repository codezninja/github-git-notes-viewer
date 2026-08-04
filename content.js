if (typeof browser === "undefined") globalThis.browser = chrome;

// --- Shared library handles ---
// lib/host.js, lib/storage.js, lib/notes.js are injected before content.js by the
// manifest. When absent (unit-test harness loads content.js at about:blank with no
// libs), skip all network/DOM work but keep every function defined and callable.
const H = globalThis.GhnHost;
const S = globalThis.GhnStorage;
const N = globalThis.GhnNotes;
const LIBS_READY = Boolean(H && S && N);
if (!LIBS_READY) {
  console.warn(
    "github-git-notes-viewer: GhnHost/GhnStorage/GhnNotes not loaded; content script will not run."
  );
}

// Resolve the current host once, tolerating unusual origins (about:blank in tests).
let HOST = null;
if (LIBS_READY) {
  try {
    HOST = H.deriveHost(location.origin);
  } catch {
    HOST = null;
  }
}

const CONTAINER_ID = "ghn-notes-container";
const COMMIT_URL_RE = /^\/([^/]+)\/([^/]+)\/commit\/([0-9a-f]{5,40})$/i;
const COLLAPSE_HEIGHT = 800; // px — notes taller than this start collapsed

// Preserved for test compatibility; source of truth is lib/storage.js.
const DEFAULT_NOTE_REFS = (S && S.DEFAULT_NOTE_REFS) || [
  "refs/notes/commits",
  "refs/notes/claude-prompt-trail",
];

let lastProcessedUrl = null;
let processGeneration = 0;

// Per-origin token cache. One content-script instance only ever sees one origin,
// but keying by origin makes the invariant explicit and prevents a token from
// ever being sent to the wrong host if that assumption breaks.
const tokenCache = new Map();

function parseCommitUrl() {
  if (!LIBS_READY) return null;
  return H.parseCommitPath(location.pathname);
}

function removeExisting() {
  const el = document.getElementById(CONTAINER_ID);
  if (el) el.remove();
}

function findInjectionPoint() {
  const selectors = [
    "#diff-content-parent",
    "#diff-stats",
    ".js-diff-progressive-container",
    "#files",
    '[data-target="diff-layout.mainContainer"]',
    ".commit.full-commit",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return { el, mode: sel === "#diff-content-parent" ? "prepend" : "before" };
  }
  return null;
}

function injectContainer(injection) {
  const container = document.createElement("div");
  container.id = CONTAINER_ID;
  if (injection.mode === "prepend") {
    injection.el.prepend(container);
  } else {
    injection.el.parentNode.insertBefore(container, injection.el);
  }
  return container;
}

function waitForInjectionPoint(timeout = 5000) {
  return new Promise((resolve) => {
    const injection = findInjectionPoint();
    if (injection) return resolve(injection);

    const obs = new MutationObserver(() => {
      const injection = findInjectionPoint();
      if (injection) {
        obs.disconnect();
        resolve(injection);
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      obs.disconnect();
      resolve(null);
    }, timeout);
  });
}

// --- Token access ---

async function getStoredToken(origin) {
  if (!LIBS_READY || !origin) return null;
  if (tokenCache.has(origin)) return tokenCache.get(origin);
  let token = null;
  try {
    token = await S.getToken(origin);
  } catch {
    token = null;
  }
  tokenCache.set(origin, token || null);
  return token || null;
}

// --- Note content fetching (per-host candidate ladder in lib/host.js) ---

async function fetchNoteContent(host, owner, repo, noteRef, commitSha) {
  if (!LIBS_READY || !host) return null;

  const token = await getStoredToken(host.origin);
  const hasToken = Boolean(token);
  const cacheBust = Date.now();

  // Try both flat (<sha>) and fanout (<sha[0:2]>/<sha[2:]>) path shapes.
  const notePaths = [
    commitSha,
    `${commitSha.slice(0, 2)}/${commitSha.slice(2)}`,
  ];

  for (const notePath of notePaths) {
    const candidates = H.buildNoteContentCandidates(
      host, owner, repo, noteRef, notePath, { hasToken, cacheBust }
    );
    for (const candidate of candidates) {
      try {
        const headers = {};
        if (candidate.accept) headers.Accept = candidate.accept;
        // Only attach the Authorization header when the candidate explicitly
        // asks for it. Never send a token to an auth:"none" candidate.
        if (candidate.auth === "token" && token) {
          headers.Authorization = `Bearer ${token}`;
        }
        const res = await fetch(candidate.url, {
          headers,
          credentials: candidate.credentials,
        });
        if (res.ok) return await res.text();
      } catch {
        continue;
      }
    }
  }

  return null;
}

// --- Tree discovery (capability-probed ladder) ---
//
// Downstream code expects [{ name, contentType: "file"|"directory" }, ...]. Tier 1
// returns that shape from the GitHub tree JSON payload. Tier 2 adapts the REST
// tree Map<path,{type,sha}> from lib/notes.js into the same shape.

async function fetchNotesTreeEntries(host, owner, repo, noteRef) {
  if (!LIBS_READY || !host) return null;

  // Tier 1: tree JSON payload (github.com; supported on newer GHES).
  let treeJsonKnownBroken = false;
  try {
    const caps = await S.getCapabilities(host.origin);
    if (caps && caps.treeJson === false) treeJsonKnownBroken = true;
  } catch {
    // Capability cache unavailable — proceed with the probe.
  }

  if (!treeJsonKnownBroken) {
    try {
      const branch = H.refToBranchPath(noteRef);
      const res = await fetch(`${host.origin}/${owner}/${repo}/tree/${branch}`, {
        headers: {
          Accept: "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        credentials: "same-origin",
      });
      if (res.ok) {
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        const items = data && data.payload && data.payload.tree && data.payload.tree.items;
        if (Array.isArray(items)) {
          try { await S.setCapability(host.origin, { treeJson: true }); } catch { /* ignore */ }
          return items;
        }
      }
      // Non-ok, non-JSON, or missing shape — remember this host can't do it.
      try { await S.setCapability(host.origin, { treeJson: false }); } catch { /* ignore */ }
    } catch {
      try { await S.setCapability(host.origin, { treeJson: false }); } catch { /* ignore */ }
    }
  }

  // Tier 2: REST fallback via lib/notes.js.
  try {
    const token = await getStoredToken(host.origin);
    const tree = await N.fetchNotesTree(host, owner, repo, noteRef, token);
    const items = [];
    for (const [name, entry] of tree) {
      items.push({
        name,
        contentType: entry.type === "tree" ? "directory" : "file",
      });
    }
    return items;
  } catch {
    // Tier 3: give up.
    return null;
  }
}

// Fetch git note, resolving the full commit SHA if needed.
// Returns { content } | { content: null, needsToken: true } | null.
async function fetchGitNote(host, owner, repo, noteRef, commitSha) {
  if (!LIBS_READY || !host) return null;

  // Tier a: direct content fetch (flat + fanout paths).
  try {
    const directContent = await fetchNoteContent(host, owner, repo, noteRef, commitSha);
    if (directContent !== null) return { content: directContent };
  } catch {
    // Swallow — fall through to tree discovery.
  }

  // Tier b: tree JSON to resolve an abbreviated or actual entry name.
  try {
    const entries = await fetchNotesTreeEntries(host, owner, repo, noteRef);
    if (entries) {
      const match = entries.find(
        (e) => e.name === commitSha || e.name.startsWith(commitSha)
      );

      if (match && match.contentType === "file") {
        const content = await fetchNoteContent(host, owner, repo, noteRef, match.name);
        if (content !== null) return { content };
        return { content: null, needsToken: true };
      }

      // Fanout subdirectory listing — same-origin JSON, capability-guarded.
      const prefix = commitSha.slice(0, 2);
      const fanoutDir = entries.find(
        (e) => e.name === prefix && e.contentType === "directory"
      );
      if (fanoutDir) {
        let treeJsonKnownBroken = false;
        try {
          const caps = await S.getCapabilities(host.origin);
          if (caps && caps.treeJson === false) treeJsonKnownBroken = true;
        } catch { /* ignore */ }

        if (!treeJsonKnownBroken) {
          const branch = H.refToBranchPath(noteRef);
          try {
            const subRes = await fetch(
              `${host.origin}/${owner}/${repo}/tree/${branch}/${prefix}`,
              {
                headers: {
                  Accept: "application/json",
                  "X-Requested-With": "XMLHttpRequest",
                },
                credentials: "same-origin",
              }
            );
            if (subRes.ok) {
              let subData = null;
              try {
                subData = await subRes.json();
              } catch {
                subData = null;
              }
              const subEntries =
                (subData && subData.payload && subData.payload.tree &&
                  subData.payload.tree.items) || [];
              const suffix = commitSha.slice(2);
              const subMatch = subEntries.find(
                (e) => e.name === suffix || e.name.startsWith(suffix)
              );
              if (subMatch) {
                const content = await fetchNoteContent(
                  host, owner, repo, noteRef, `${prefix}/${subMatch.name}`
                );
                if (content !== null) return { content };
                return { content: null, needsToken: true };
              }
            }
          } catch {
            // Fall through to REST fallback.
          }
        }
      }
    }
  } catch {
    // Swallow — fall through to REST fallback.
  }

  // Tier c: REST fallback — resolve path via lib/notes.js, fetch content,
  // and if the raw path 404s, decode the blob directly.
  try {
    const token = await getStoredToken(host.origin);
    const resolved = await N.resolveNotePath(host, owner, repo, noteRef, commitSha, token);
    if (resolved) {
      const content = await fetchNoteContent(host, owner, repo, noteRef, resolved.path);
      if (content !== null) return { content };
      try {
        const blobContent = await N.fetchBlobContent(host, owner, repo, resolved.blobSha, token);
        if (blobContent !== null && blobContent !== undefined) return { content: blobContent };
      } catch {
        // Blob fetch failed — note exists but we can't read it.
      }
      return { content: null, needsToken: true };
    }
  } catch {
    // Swallow — final tier gives up.
  }

  return null;
}

// Auto-discover note refs — delegates to lib/notes.js (returns [] on failure).
async function discoverNoteRefs(host, owner, repo) {
  if (!LIBS_READY || !host) return [];
  const token = await getStoredToken(host.origin);
  return N.discoverNoteRefs(host, owner, repo, token);
}

// Get note refs: defaults ∪ discovered ∪ user-configured.
async function getNoteRefs(owner, repo) {
  const refs = new Set(DEFAULT_NOTE_REFS);
  if (!LIBS_READY || !HOST) return [...refs];

  const discovered = await discoverNoteRefs(HOST, owner, repo);
  for (const r of discovered) refs.add(r);

  try {
    const userRefs = await S.getNoteRefs();
    for (const r of userRefs) refs.add(r);
  } catch {
    // storage might not be available
  }
  return [...refs];
}

// --- Format detection ---

function detectFormat(content) {
  const trimmed = content.trim();

  if (/^[\[{]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch { /* not valid JSON */ }
  }

  if (
    /^#{1,6}\s/m.test(trimmed) ||
    /\*\*[^*]+\*\*/m.test(trimmed) ||
    /^\|.+\|$/m.test(trimmed) ||
    /^[-*]\s/m.test(trimmed) ||
    /^\d+\.\s/m.test(trimmed) ||
    /^```/m.test(trimmed) ||
    /<!--.*-->/m.test(trimmed)
  ) {
    return "markdown";
  }

  if (
    /^[a-zA-Z_][a-zA-Z0-9_]*:\s/m.test(trimmed) &&
    (trimmed.match(/^[a-zA-Z_][a-zA-Z0-9_]*:\s/gm) || []).length >= 2
  ) {
    return "yaml";
  }

  return "plain";
}

// --- Rendering ---
// Rendered content is sanitized by DOMPurify and inserted directly into the
// page. No iframe needed — DOMPurify with a strict allowlist is the industry
// standard for safe HTML rendering (same approach GitHub uses for user markdown).

function renderContentToHtml(content, format) {
  switch (format) {
    case "markdown":
      if (typeof marked !== "undefined") {
        const rawHtml = marked.parse(content, { breaks: true, gfm: true });
        const cleanHtml =
          typeof DOMPurify !== "undefined"
            ? DOMPurify.sanitize(rawHtml, {
                ALLOWED_TAGS: [
                  "h1","h2","h3","h4","h5","h6","p","br","strong","em","del",
                  "ul","ol","li","a","code","pre","blockquote","table","thead",
                  "tbody","tr","th","td","img","hr","div","span","sup","sub",
                ],
                ALLOWED_ATTR: ["href","src","alt","title","class","id","align"],
                ALLOW_DATA_ATTR: false,
              })
            : escapeHtml(rawHtml);
        return cleanHtml;
      }
      return `<pre class="ghn-content">${escapeHtml(content)}</pre>`;

    case "json":
      try {
        const formatted = JSON.stringify(JSON.parse(content.trim()), null, 2);
        return `<pre class="ghn-content">${escapeHtml(formatted)}</pre>`;
      } catch {
        return `<pre class="ghn-content">${escapeHtml(content)}</pre>`;
      }

    case "yaml": {
      const lines = escapeHtml(content).split("\n");
      const highlighted = lines
        .map((line) => {
          const m = line.match(/^(\s*)([\w.-]+)(:)(\s.*)?$/);
          if (m) {
            return `${m[1]}<span class="ghn-yaml-key">${m[2]}</span>${m[3]}${m[4] || ""}`;
          }
          return line;
        })
        .join("\n");
      return `<pre class="ghn-content">${highlighted}</pre>`;
    }

    default:
      return `<pre class="ghn-content">${escapeHtml(content)}</pre>`;
  }
}

// --- UI rendering ---

function showLoading(container) {
  container.innerHTML = `
    <div class="ghn-box ghn-loading">
      <div class="ghn-header">
        <span class="ghn-icon">${noteIcon()}</span>
        <span class="ghn-title">Git Notes</span>
      </div>
      <div class="ghn-body">
        <span class="ghn-spinner"></span> Loading notes...
      </div>
    </div>
  `;
}

function showNotes(container, notes) {
  if (!notes || notes.length === 0) {
    removeExisting();
    return;
  }

  container.innerHTML = "";

  for (const note of notes) {
    const format = detectFormat(note.content);
    const formatLabel = format !== "plain" ? format : "";

    const box = document.createElement("div");
    box.className = "ghn-box";
    box.dataset.format = format;

    // Header
    const header = document.createElement("div");
    header.className = "ghn-header";
    header.innerHTML = `
      <span class="ghn-icon">${noteIcon()}</span>
      <span class="ghn-title">Git Notes</span>
      ${formatLabel ? `<span class="ghn-format-badge">${formatLabel}</span>` : ""}
      <span class="ghn-ref">${escapeHtml(note.ref)}</span>
      ${format !== "plain" ? `<button class="ghn-toggle-raw" title="Toggle raw view">${codeIcon()}</button>` : ""}
    `;
    box.appendChild(header);

    // Rendered body — sanitized HTML injected directly (no iframe)
    const renderedBody = document.createElement("div");
    renderedBody.className = "ghn-body ghn-rendered";
    if (format === "markdown") {
      renderedBody.classList.add("markdown-body");
    }
    renderedBody.innerHTML = renderContentToHtml(note.content, format);
    box.appendChild(renderedBody);

    // Raw body (hidden by default, safe — textContent)
    if (format !== "plain") {
      const rawBody = document.createElement("div");
      rawBody.className = "ghn-body ghn-raw";
      rawBody.hidden = true;
      const pre = document.createElement("pre");
      pre.className = "ghn-content";
      pre.textContent = note.content;
      rawBody.appendChild(pre);
      box.appendChild(rawBody);

      // Toggle handler
      const btn = header.querySelector(".ghn-toggle-raw");
      btn.addEventListener("click", () => {
        const showingRaw = !rawBody.hidden;
        renderedBody.hidden = !showingRaw;
        rawBody.hidden = showingRaw;
        btn.classList.toggle("ghn-active", !showingRaw);
      });
    }

    // "Show full note" / "Collapse" — check after appending to DOM
    const showMoreBtn = document.createElement("button");
    showMoreBtn.className = "ghn-show-more";
    showMoreBtn.textContent = "Show full note";
    showMoreBtn.hidden = true;
    showMoreBtn.addEventListener("click", () => {
      const isExpanded = box.classList.toggle("ghn-expanded");
      showMoreBtn.textContent = isExpanded ? "Collapse note" : "Show full note";
    });
    box.appendChild(showMoreBtn);

    container.appendChild(box);

    // Measure after it's in the DOM
    requestAnimationFrame(() => {
      const bodyHeight = renderedBody.scrollHeight;
      if (bodyHeight > COLLAPSE_HEIGHT) {
        box.classList.add("ghn-collapsed");
        showMoreBtn.hidden = false;
      }
    });
  }
}

function showTokenNeeded(container) {
  container.innerHTML = "";
  const box = document.createElement("div");
  box.className = "ghn-box ghn-error";

  const header = document.createElement("div");
  header.className = "ghn-header";
  header.innerHTML = `
    <span class="ghn-icon">${noteIcon()}</span>
    <span class="ghn-title">Git Notes</span>
  `;
  box.appendChild(header);

  const body = document.createElement("div");
  body.className = "ghn-body";

  const link = document.createElement("a");
  link.className = "ghn-settings-link";
  link.href = "#";
  link.addEventListener("click", (e) => {
    e.preventDefault();
    browser.runtime.sendMessage({ type: "OPEN_OPTIONS" });
  });

  if (HOST && HOST.kind === "ghes") {
    body.appendChild(
      document.createTextNode("Notes found but can’t be read — sign in to ")
    );
    body.appendChild(document.createTextNode(HOST.label));
    body.appendChild(document.createTextNode(" or "));
    link.textContent = "configure a token";
    body.appendChild(link);
    body.appendChild(document.createTextNode("."));
  } else {
    body.appendChild(
      document.createTextNode("Notes found but can’t be read — ")
    );
    link.textContent = "configure a GitHub token";
    body.appendChild(link);
    body.appendChild(document.createTextNode(" for private repo support."));
  }

  box.appendChild(body);
  container.appendChild(box);
}

function showError(container, message) {
  container.innerHTML = `
    <div class="ghn-box ghn-error">
      <div class="ghn-header">
        <span class="ghn-icon">${noteIcon()}</span>
        <span class="ghn-title">Git Notes</span>
      </div>
      <div class="ghn-body">${escapeHtml(message)}</div>
    </div>
  `;
}

function noteIcon() {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
    <path d="M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 2.25a.75.75 0 0 0 0 1.5h4a.75.75 0 0 0 0-1.5Z"/>
  </svg>`;
}

function codeIcon() {
  return `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" class="ghn-octicon">
    <path d="m11.28 3.22 4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734L13.94 8l-3.72-3.72a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215Zm-6.56 0a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L2.06 8l3.72 3.72a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L.47 8.53a.75.75 0 0 1 0-1.06Z"/>
  </svg>`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// --- Main flow ---

async function processCommitPage() {
  // Bail immediately if libs are missing or the current origin isn't a supported host.
  if (!LIBS_READY || !HOST) return;

  const url = location.href;
  if (url === lastProcessedUrl) return;
  lastProcessedUrl = url;

  const generation = ++processGeneration;

  const commit = parseCommitUrl();
  if (!commit) {
    removeExisting();
    return;
  }

  removeExisting();

  // Fetch notes before injecting anything into the page
  let results = [];
  let needsToken = false;
  let fetchError = null;

  try {
    const noteRefs = await getNoteRefs(commit.owner, commit.repo);
    for (const ref of noteRefs) {
      try {
        const result = await fetchGitNote(
          HOST, commit.owner, commit.repo, ref, commit.commitSha
        );
        if (result && result.content !== null && result.content !== undefined) {
          results.push({ ref, content: result.content });
        } else if (result && result.needsToken) {
          needsToken = true;
        }
      } catch {
        continue;
      }
    }
  } catch (err) {
    fetchError = err;
  }

  // Bail out if a newer call has started while we were fetching
  if (generation !== processGeneration) return;

  // Only inject into the page if there's something to show
  if (results.length === 0 && !needsToken && !fetchError) return;
  if (location.href !== url) return;

  const injection = await waitForInjectionPoint();
  if (!injection) return;
  if (location.href !== url) return;

  removeExisting();
  const container = injectContainer(injection);

  if (fetchError) {
    showError(container, fetchError.message || "Error loading notes");
  } else if (results.length > 0) {
    showNotes(container, results);
  } else if (needsToken) {
    showTokenNeeded(container);
  }
}

// 1. Handle initial page load
processCommitPage();

// 2. Handle GitHub's Turbo Drive SPA navigation
document.addEventListener("turbo:load", () => {
  lastProcessedUrl = null;
  processCommitPage();
});

// 3. MutationObserver fallback for URL changes
let currentUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    lastProcessedUrl = null;
    processCommitPage();
  }
});
observer.observe(document.body, { childList: true, subtree: true });
