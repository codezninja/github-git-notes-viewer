# Plan: GitHub Enterprise Server (GHES) support

Status: **implemented and verified end-to-end** — all five phases landed together in
[#2](https://github.com/Trailblaze-work/github-git-notes-viewer/pull/2), and notes have been
confirmed rendering on a real GHES instance and on github.com. Retained as the design record;
§10 lists the narrower cases still unverified.
Scope: add GHES as an *optional*, user-configured host alongside github.com, without
regressing the current zero-config public-repo experience.

> The code review in §1 and the design in §2 describe the state *before* this change and
> the target it aimed at. Both are preserved as written; §3 records what actually shipped.

---

## 1. Code review: where github.com is baked in

| # | File | Line(s) | Hardcoding | Impact |
|---|------|---------|-----------|--------|
| 1 | `manifest.json` | 26 | `content_scripts[0].matches = ["https://github.com/*/*/commit/*"]` | content script never runs on a GHES host |
| 2 | `manifest.json` | 17-18 | `host_permissions` = `raw.githubusercontent.com`, `api.github.com` | no permission to reach a GHES origin |
| 3 | `content.js` | 116, 129 | `https://raw.githubusercontent.com/...` | GHES has no such host; raw lives at `HOSTNAME/raw/...` or `raw.HOSTNAME/...` |
| 4 | `content.js` | 146 | `https://api.github.com/repos/...` | GHES API root is `HOSTNAME/api/v3` |
| 5 | `content.js` | 232 | `https://api.github.com/.../git/matching-refs/notes` | same |
| 6 | `content.js` | 74, 186 | relative `/{owner}/{repo}/tree/{branch}` with `Accept: application/json` | this is github.com's React tree JSON payload; older GHES releases return HTML, so tree discovery silently fails |
| 7 | `background.js` | 12 | `fetch("https://api.github.com" + path)` | every background API call (incl. `CHECK_AUTH`) is github.com-only |
| 8 | `background.js` | 16 | `X-GitHub-Api-Version: 2022-11-28` | github.com-only header; harmless but should be conditional |
| 9 | `background.js` | 46, 181, 219 | single `githubToken` in storage; cache key `owner/repo:ref` | one token for all hosts, and cache collides across hosts |
| 10 | `options.html` | 18 | link to `github.com/settings/personal-access-tokens/new` | wrong URL for GHES; GHES needs `HOSTNAME/settings/tokens` (classic) |
| 11 | `options.js` / `popup.js` | — | no host concept at all | can't pick which host to validate against |
| 12 | `test/e2e.mjs` | 300-302 | asserts the two github.com host permissions and the github.com match pattern | tests must be rewritten alongside the manifest |
| 13 | `PRIVACY.md`, `README.md` | — | "only communicates with api.github.com / raw.githubusercontent.com" | must be updated: user-supplied enterprise origins |

### Architectural observations

- **Two independent fetch paths exist.** `content.js` does all real work (cookie/same-origin
  + PAT), while `background.js` has a *complete second implementation* (`fetchNotesTree`,
  `resolveNoteBlob`, `fetchBlobContent`) that is only reachable via the unused
  `FETCH_GIT_NOTE` message. Only `CHECK_AUTH`, `CLEAR_CACHE`, `GET_NOTE_REFS`,
  `OPEN_OPTIONS` are actually used. **Decision point below (§3.0).**
- **GHES is architecturally easier than github.com** in one respect: with subdomain
  isolation off, web UI, API (`/api/v3`) and raw (`/raw/...`) are all *same-origin* with the
  commit page, so the session cookie covers everything and no PAT is needed for private
  repos. This is a strictly better path than the current raw.githubusercontent.com dance.
- **Enterprise hostnames are unknown at build time**, so host permissions must be
  *optional* and requested at runtime, and the content script must be *dynamically
  registered*. This is the single biggest structural change.

### GHES endpoint facts the design relies on

| Concern | github.com | GHES |
|---|---|---|
| REST API root | `https://api.github.com` | `https://HOSTNAME/api/v3` (unchanged by subdomain isolation) |
| Raw content (same-origin) | `https://github.com/{o}/{r}/raw/{ref}/{path}` (302 → raw.githubusercontent.com) | `https://HOSTNAME/{o}/{r}/raw/{ref}/{path}` (302 → `raw.HOSTNAME` when isolation is on) |
| Contents API | `/repos/{o}/{r}/contents/{path}?ref=` | identical under `/api/v3` |
| `git/matching-refs/notes` | available | available (GHES 2.x+) |
| Tree JSON payload (`Accept: application/json` on `/tree/`) | available | **version-dependent** — must be probed |
| PAT type | fine-grained or classic | classic (`ghp_`) on most releases; fine-grained only on recent GHES with the feature enabled |
| Api-Version header | required-ish | ignore |

---

## 2. Target design

### 2.1 Host model

Introduce a first-class `host` object threaded through every fetch:

```js
// lib/host.js  (new, shared by content.js / background.js / options.js)
{
  origin:   "https://ghe.example.com",   // no trailing slash, scheme included
  kind:     "ghes" | "dotcom",
  apiBase:  "https://ghe.example.com/api/v3" | "https://api.github.com",
  label:    "ghe.example.com",           // display only
  hasToken: true                          // token itself stored separately
}
```

Derivation rules (pure function, unit-testable):

```
deriveHost(origin):
  if hostname === "github.com"        -> kind dotcom, apiBase https://api.github.com
  else                                -> kind ghes,   apiBase `${origin}/api/v3`
```

`getCurrentHost()` in `content.js` is just `deriveHost(location.origin)`.

### 2.2 Storage schema (v2) + migration

```js
{
  schemaVersion: 2,
  hosts: {
    "https://github.com":       { kind: "dotcom", addedAt: 1700000000000 },
    "https://ghe.example.com":  { kind: "ghes",   addedAt: 1700000000000 }
  },
  tokens: {
    "https://github.com":      "ghp_...",
    "https://ghe.example.com": "ghp_..."
  },
  noteRefs: ["refs/notes/commits"],           // unchanged, global
  capabilities: {                              // probe cache, TTL 24h
    "https://ghe.example.com": { treeJson: false, matchingRefs: true, ts: 0 }
  }
}
```

Migration (runs in `background.js` on `runtime.onInstalled` **and** lazily on first read,
because Firefox event pages can miss `onInstalled`):

```
if (!schemaVersion && githubToken) {
  tokens["https://github.com"] = githubToken
  delete githubToken
  schemaVersion = 2
}
```

`github.com` is always present in `hosts` and cannot be removed — it keeps working with the
statically declared content script and host permissions, so existing users see zero change.

### 2.3 Permissions & dynamic content-script registration

`manifest.json`:

```jsonc
{
  "permissions": ["storage", "scripting"],
  "host_permissions": [
    "https://github.com/*",
    "https://raw.githubusercontent.com/*",
    "https://api.github.com/*"
  ],
  "optional_host_permissions": ["https://*/*"],   // Chrome MV3
  "optional_permissions":      ["https://*/*"],   // Firefox MV3
  "content_scripts": [ /* unchanged github.com entry stays static */ ]
}
```

Notes:
- `https://*/*` is broad, but there is no way to request an unknown-at-build-time origin
  otherwise. Chrome Web Store review will ask for justification — see §7.
- `permissions.request()` **must** come from a user gesture on an extension page. The
  options page "Add enterprise host" button is that gesture. It cannot be done from the
  service worker.
- On grant, register the content script for that origin:

```js
await browser.scripting.registerContentScripts([{
  id: `ghn-${origin}`,
  matches: [`${origin}/*/*/commit/*`],
  js: ["lib/purify.min.js", "lib/marked.min.js", "lib/host.js", "content.js"],
  css: ["content.css"],
  runAt: "document_idle",
  persistAcrossSessions: true,
}]);
```
  On host removal: `unregisterContentScripts({ ids: [...] })` + `permissions.remove()`.
- Reconciliation on startup (`onStartup` + `onInstalled`): compare
  `permissions.getAll()` ∪ stored `hosts` against `getRegisteredContentScripts()` and
  fix drift (user can revoke permissions from the browser UI at any time).

### 2.4 Fetch strategy, reordered and host-aware

Current order (raw-no-auth → raw-with-PAT → contents API) is github.com-shaped. New order,
per host kind:

**GHES** (all same-origin, cookie auth — no PAT needed in the common case):
1. `GET ${origin}/${o}/${r}/raw/${branch}/${path}` with `credentials: "same-origin"`
2. `GET ${apiBase}/repos/${o}/${r}/contents/${path}?ref=${ref}` with
   `Accept: application/vnd.github.raw`, cookie creds; add `Authorization` only if a token
   is stored for this host
3. Tree discovery for the full SHA (see §2.5), then retry 1–2

**github.com** (unchanged behaviour, so no regression risk):
1. `raw.githubusercontent.com` unauthenticated
2. `raw.githubusercontent.com` + PAT
3. Contents API + PAT

Implementation: keep one `fetchNoteContent(host, ...)` that builds its candidate list from
`host.kind`. All URL construction moves behind `host.apiBase` / `host.origin` — no literal
`api.github.com` outside `deriveHost`.

### 2.5 Tree discovery with capability probe

`fetchNotesTreeEntries(host, owner, repo, noteRef)` becomes a three-tier ladder:

1. **Tree JSON payload** (`/{o}/{r}/tree/{branch}` + `Accept: application/json`) — try
   once per host, cache the result in `capabilities[origin].treeJson`. If the response is
   not JSON or lacks `payload.tree.items`, mark unsupported and never try again for 24h.
2. **REST git trees** — `GET ${apiBase}/repos/{o}/{r}/git/ref/refs%2Fnotes%2F...` →
   `git/commits/{sha}` → `git/trees/{treeSha}`. This is exactly the logic already written in
   `background.js` (`fetchNotesTree` / `resolveNoteBlob`), including fanout handling. Reuse
   it rather than rewriting.
3. Give up → return `null` (current behaviour: render nothing).

Ref discovery (`discoverNoteRefs`) becomes `${apiBase}/repos/{o}/{r}/git/matching-refs/notes`
with cookie creds on GHES; on 404/403 fall back to `DEFAULT_NOTE_REFS`.

### 2.6 Cache keys

`treeCache` key becomes `${host.origin}|${owner}/${repo}:${noteRef}`. Same for the
in-content-script token cache (`_cachedToken` → `Map<origin, token>`), which today is a
module-level single value and would leak the wrong token across hosts if the same content
script instance ever saw two origins (it can't today, but the Map is free).

### 2.7 UI changes

**options.html / options.js** — replace the single token field with a host list:

```
Hosts
┌──────────────────────────────────────────────────────────────┐
│ github.com                    [token: •••• ] [Validate]      │  (not removable)
│ ghe.example.com               [token: •••• ] [Validate] [×]  │
└──────────────────────────────────────────────────────────────┘
[ https://ghe.example.com        ] [ Add enterprise host ]
```

- Validation: `GET ${apiBase}/user` → show `login`. Add a "cookie session works" indicator
  for GHES: a token-less `${apiBase}/user` with `credentials: "include"` succeeding means no
  PAT is needed.
- The PAT help link becomes host-aware: `${origin}/settings/tokens` for GHES (classic,
  `repo` scope), the existing fine-grained URL for github.com.
- Input normalisation: accept `ghe.example.com`, `https://ghe.example.com`,
  `https://ghe.example.com/` and pasted deep links; reject `github.com` duplicates,
  non-https, and anything with a path. Warn (don't block) on `api.` prefixes — a common
  paste mistake.

**popup.js** — resolve the active tab's origin, show that host's status
(`Authenticated as X on ghe.example.com` / `Session cookie (no token needed)` /
`Host not configured — Add`), with a one-click "Add this host" when the current tab is on an
unconfigured origin. That is the discoverability win: users land on a GHES commit page and
the popup offers to enable it.

---

## 3. Implementation plan

### 3.0 Decision to make first — RESOLVED: Option A

**Consolidate or keep two fetch implementations?**
- *Option A (chosen)* — extract the REST ladder from `background.js` into
  `lib/notes.js`, used by both the content script (tier 2 of §2.5) and background.
  Deletes the dead `FETCH_GIT_NOTE` path. Net LOC roughly flat, one code path to make
  host-aware.
- *Option B* — leave `background.js` alone and duplicate the REST ladder in `content.js`.
  Faster to land, doubles the surface that has to be kept host-aware.

**Shipped as A.** `background.js` lost its duplicate REST implementation entirely, and both
`FETCH_GIT_NOTE` and `GET_NOTE_REFS` were removed — they were unreachable before the change
and stayed unused after it, since `content.js` calls `lib/notes.js` directly.

One consequence worth noting: `GhnNotes.fetchGitNote` is now itself uncalled. It was kept
as a coherent lib export (it composes `resolveNotePath` + `fetchBlobContent`) rather than
wiring cruft, but it is dead code today.

### 3.1 What actually shipped

All five phases landed in a single commit rather than the 4–5 PRs anticipated in §8,
because the phases were executed concurrently against the frozen `lib/` contracts.

| Phase | Status | Notes |
|---|---|---|
| 1 Host abstraction | done | `lib/host.js`, `lib/storage.js`, `lib/notes.js` |
| 2 Permissions/registration | done | `scripting` + `activeTab`; `activeTab` was not in the original plan — the popup needs it to read the active tab's origin |
| 3 GHES fetch paths | done | per-kind ladders + capability probe + REST fallback |
| 4 UI | done | multi-host options page, active-tab-aware popup |
| 5 Docs/packaging | done | `build-zip.sh` now asserts every declared file is in the zip |

Exit criteria met by automated test: §4's unit and e2e plans, plus the anti-leak test.

The Phase 3 and Phase 4 criteria both require a real GHES instance ("notes render on a real
GHES commit page", "full add → grant → navigate loop"). **Both were confirmed manually against
a live GHES instance, with github.com re-checked for regression.** The remaining gaps are
configuration variants rather than the core paths — see §10.

### Phase 1 — Host abstraction, no behaviour change
- Add `lib/host.js`: `deriveHost`, `normalizeHostInput`, `parseCommitPath`.
- Add `lib/storage.js`: schema-v2 read/write + migration + `getToken(origin)`.
- Thread `host` through `content.js` and `background.js`; for now every call site resolves
  to `deriveHost("https://github.com")` / `location.origin`.
- Cache keys prefixed with origin.
- Unit tests for the new pure functions.
- **Exit criteria:** existing e2e/unit suite green, zero user-visible change.

### Phase 2 — Manifest, permissions, dynamic registration
- Manifest: add `scripting`, `optional_host_permissions` / `optional_permissions`, add
  `https://github.com/*` to static `host_permissions`.
- `background.js`: `registerHost(origin)` / `unregisterHost(origin)` +
  startup reconciliation + `permissions.onRemoved` listener.
- New messages: `ADD_HOST`, `REMOVE_HOST`, `LIST_HOSTS`, `CHECK_AUTH {origin}`.
- Update `test/e2e.mjs` manifest assertions (item 12 above).
- **Exit criteria:** can add a fake host (e.g. a local https server) and see the content
  script register/unregister; `getRegisteredContentScripts()` matches storage.

### Phase 3 — GHES fetch paths
- `fetchNoteContent`: per-kind candidate URL lists (§2.4).
- `fetchNotesTreeEntries`: capability probe + REST fallback via `lib/notes.js` (§2.5).
- `discoverNoteRefs`: `apiBase`-relative.
- Drop `X-GitHub-Api-Version` for `kind === "ghes"`.
- `showTokenNeeded` copy branches on host kind (GHES message should say "sign in to
  ghe.example.com or add a token", since cookie auth is the normal answer there).
- **Exit criteria:** notes render on a real GHES commit page for a private repo with **no**
  PAT configured (cookie path), and with a PAT (token path).

### Phase 4 — UI
- `options.html` / `options.css` / `options.js`: host list, add/remove, per-host validate,
  host-aware PAT link.
- `popup.js` / `popup.html`: active-tab host status + "Add this host".
- **Exit criteria:** full add → grant → navigate → notes render loop with no reload of the
  extension.

### Phase 5 — Docs, packaging, store
- `README.md`: GHES setup section, subdomain-isolation note, GHES-version caveat for tree
  JSON, classic-PAT (`repo` scope) instruction.
- `PRIVACY.md`: amend "communicates only with GitHub" to include user-configured enterprise
  origins; state explicitly that per-host tokens are stored in `storage.local`, are never
  cross-sent between hosts, and that no data leaves the configured hosts.
- `scripts/build-zip.sh`: add `lib/host.js`, `lib/storage.js`, `lib/notes.js` to
  `EXTENSION_FILES` (easy to forget — the zip list is explicit, not a glob).
- Store listing: justification text for `https://*/*` (§7), updated screenshots.
- **Exit criteria:** `npm test` green, `scripts/build-zip.sh` output contains every new file.

---

## 4. Test plan

**Unit (`test/unit.mjs`)** — pure functions, no browser needed:
- `deriveHost`: github.com, `ghe.example.com`, host with port, uppercase hostname,
  `api.github.com` mistakenly entered.
- `normalizeHostInput`: bare hostname, trailing slash, deep link, `http://` (reject),
  duplicate github.com (reject).
- `parseCommitPath`: 7-char and 40-char SHAs, repo names containing `commit`, non-commit
  paths, GHES paths (identical shape — assert no regression).
- Storage migration: v1 `{githubToken}` → v2 `{tokens:{...}}`; idempotent on re-run.
- Candidate-URL builder: assert exact URL lists per host kind (this is the regression net
  for "did we leak api.github.com into a GHES call").

**E2E (`test/e2e.mjs`)** — add `test/mock-ghes-commit.html` (a copy of the github.com mock
served from a different origin via a local https server) and assert:
- notes render from the same-origin raw path with no PAT,
- no request is ever made to `api.github.com` or `raw.githubusercontent.com` while on a
  GHES origin (use `page.setRequestInterception` and fail the test on any such request —
  this is the highest-value new test),
- manifest assertions updated for the new permission shape.

**Manual matrix** (document results in the PR):

| GHES version | subdomain isolation | repo | auth | expected |
|---|---|---|---|---|
| latest | off | public | cookie | renders |
| latest | on | private | cookie | renders |
| latest | on | private | classic PAT, signed out | renders |
| n-2 (no tree JSON) | off | private | cookie | renders via REST fallback |
| any | — | repo with no notes ref | — | nothing injected, no console errors |

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `https://*/*` optional permission triggers Chrome Web Store / AMO review friction | Request per-origin at runtime (`permissions.request({origins:[origin+"/*"]})`), never the wildcard itself; document that the wildcard is only the *allowed set*. Prepare reviewer justification text up front. |
| Tree JSON payload absent on older GHES → silent "no notes" | Capability probe + REST `git/trees` fallback (§2.5); log once to console at `debug`. |
| Content script registered on a non-GitHub host by user error | Probe the origin during "Add host" (`GET ${apiBase}/meta`, expect `installed_version`) and refuse to add if it doesn't look like GHES. |
| Token sent to the wrong host | Tokens keyed by origin; `Authorization` header only added when `tokenOrigin === host.origin`. Enforced by the URL-builder unit test and the request-interception e2e test. |
| Self-signed / internal CA on GHES | Out of scope — the browser's trust store governs. Document that the user must already be able to browse the GHES host without a cert warning. |
| Firefox MV3 differences (`optional_permissions` vs `optional_host_permissions`, `scripting` availability) | Declare both keys; feature-detect `browser.scripting?.registerContentScripts` and surface a clear "unsupported browser version" message in options. `strict_min_version` is already 140.0, which has `scripting`. |
| SPA/Turbo navigation on GHES | GHES also uses Turbo; the existing `turbo:load` + MutationObserver handling is unchanged. Verify on the manual matrix. |
| Storage migration runs twice / partially | Migration is idempotent and gated on `schemaVersion`; run lazily on read as well as `onInstalled`. |

---

## 6. Non-goals

- GitHub Enterprise **Cloud** with data residency (`*.ghe.com`) — it uses
  `api.HOSTNAME`-style routing; it would slot into `deriveHost` as a third `kind` later,
  but is not part of this change.
- OAuth / GitHub App device flow instead of PATs.
- Writing or editing notes.
- Per-host `noteRefs` (refs stay global; revisit only if requested).
- Syncing hosts/tokens via `storage.sync`.

---

## 7. Store-review justification (draft)

> The extension displays git notes on commit pages. GitHub Enterprise Server is
> self-hosted, so its hostname is unique to each customer and unknowable at publish time.
> The extension therefore declares `https://*/*` as an *optional* host permission and
> requests access to exactly one origin at a time, only after the user explicitly enters
> that hostname in the options page and confirms the browser permission prompt. No host
> permission is granted without that action, and the extension never requests the wildcard
> itself. Granted origins are shown in the options page and can be revoked there.

---

## 8. Rough sizing

| Phase | Files touched | Est. |
|---|---|---|
| 1 Host abstraction | +3 new `lib/`, `content.js`, `background.js`, `test/unit.mjs` | ~250 LOC |
| 2 Permissions/registration | `manifest.json`, `background.js`, `test/e2e.mjs` | ~150 LOC |
| 3 GHES fetch | `content.js`, `lib/notes.js` | ~200 LOC |
| 4 UI | `options.*`, `popup.*` | ~250 LOC |
| 5 Docs/packaging | `README.md`, `PRIVACY.md`, `scripts/build-zip.sh`, store assets | ~100 lines |

Phases 1–3 are independently shippable behind "no host added yet" (dead code until Phase 4
exposes the UI), so this can land as 4–5 reviewable PRs rather than one.

**Actual:** 21 files, +3752 / −465, landed as one PR. The estimate of ~950 LOC undershot by
roughly 4×. Two things the estimate omitted account for most of the gap:

| Area | Insertions | vs. estimate |
|---|---|---|
| Tests (`unit.mjs` 397, `e2e.mjs` 243, `mock-ghes-commit.html` 321) | 961 | not estimated at all |
| Options + popup (`.js`/`.css`/`.html`) | 1045 | est. ~250 |

```sh
# insertions per file for this change
git show --numstat HEAD -- test/unit.mjs test/e2e.mjs test/mock-ghes-commit.html
git show --numstat HEAD -- options.js options.css options.html popup.js popup.css popup.html \
  | awk '{s+=$1} END {print s}'
```

---

## 9. Open questions — as resolved during implementation

These were answered by implementation choice, not by an explicit decision from the repo
owner. Any of them can still be revisited.

1. **Consolidate the duplicate fetch logic (§3.0 Option A) or keep `background.js` as-is?**
   → **Consolidated (Option A).** See §3.0.
2. **Minimum GHES version to support?**
   → **n-2 assumed.** The capability probe plus REST `git/trees` fallback (§2.5) was built,
   so releases without the internal `/tree/` JSON payload still work. If latest-only were
   acceptable, tier 2 of `fetchNotesTreeEntries` and the `capabilities` storage key could
   both be deleted.
3. **Is `https://*/*` optional-permission store friction acceptable?**
   → **Assumed yes.** Declared as an optional permission only; the extension requests a
   single concrete origin at a time and never the wildcard. Justification text is in §7.
   Not yet tested against store review.
4. **Do you need `ghe.coxautoinc.com` specifically validated in the manual matrix?**
   → **Kept vendor-neutral.** No CAI-specific host appears anywhere in the code, tests, or
   docs.

---

## 10. Still open after implementation

The core add-host → grant → render flow is confirmed working on a live GHES instance and on
github.com. What remains is narrower:

1. **Only one GHES configuration was exercised.** The §4 matrix also lists a release without
   the tree JSON endpoint (exercising the REST `git/trees` fallback), subdomain isolation in
   both states, and the token-only path with no browser session. Those rows are still open.
   The instance version and isolation mode used for the successful test were not recorded —
   worth capturing here so the coverage claim is specific.
2. **`optional_permissions: ["https://*/*"]` console behaviour in Chrome.** The extension
   loads and works, so this is not a blocker. But Chrome MV3 expects API permissions in
   `optional_permissions` rather than host patterns (`optional_host_permissions` is the
   Chrome key; both are declared for cross-browser support), so Chrome may still be logging
   a benign manifest warning. Worth a glance at the extensions page before store submission.
3. **Store review has not been attempted** — the `https://*/*` justification in §7 is
   untested against an actual reviewer.
4. **`GhnNotes.fetchGitNote` is dead code** (see §3.0).
5. **Pre-existing, out of scope:** `README.md`'s Configuration section advertises
   "Additional note refs", but no options UI has ever existed for it, so the stored value is
   permanently `[]`. `getNoteRefs`/`setNoteRefs` are wired in `lib/storage.js` and consumed
   by `content.js`, so this needs either a small input in the options page or the bullet
   removed.
