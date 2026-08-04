# GitHub Git Notes Viewer

A browser extension that displays [git notes](https://git-scm.com/docs/git-notes) inline on GitHub commit pages.

Git notes are a powerful but underused Git feature -- they let you attach metadata to commits without modifying them. However, GitHub's web UI doesn't display git notes at all. This extension fills that gap: when you view a commit on GitHub, it fetches and displays any associated git notes right on the page, with automatic format detection and rich rendering.

## Screenshots

**Rendered markdown note** -- a [claude-prompt-trail](https://github.com/Trailblaze-work/claude-prompt-trail) note displayed with full markdown rendering, format badge, and raw/rendered toggle:

![Git notes displayed on a GitHub commit page](screenshots/notes-displayed.png)

**Multiple note refs** -- two different refs shown together, each with its own detected format (Markdown and JSON):

![Multiple git note refs displayed](screenshots/multiple-refs.png)

## Features

- **Zero config for public repos on github.com** -- uses your GitHub session for note discovery, fetches content from `raw.githubusercontent.com`. Works out of the box.
- **Private repo support on github.com** -- requires a GitHub fine-grained PAT with **Contents: Read-only** permission, scoped to the repos you need. GitHub's `raw.githubusercontent.com` doesn't expose raw note content for private repos through any cookie-authenticated endpoint.
- **GitHub Enterprise Server (GHES) support** -- add your enterprise host in the options page or via the popup on any GHES commit page. On GHES the API and raw content are same-origin with the commit page, so your normal browser session usually covers private repos with **no token needed**.
- **Auto-discovery** -- automatically discovers all note refs in a repo via the GitHub API, plus tries common defaults (`refs/notes/commits`, `refs/notes/claude-prompt-trail`). No need to configure which refs to check.
- **Auto format detection** -- detects Markdown, JSON, and YAML content and renders it appropriately
- **Rich rendering** -- Markdown notes are rendered with full GFM support (tables, code blocks, lists, etc.) via [marked](https://github.com/markedjs/marked)
- **Format badge** -- shows the detected format (MARKDOWN, JSON, YAML) in the note header
- **Raw/rendered toggle** -- click the `</>` button to switch between rendered and raw views
- **Multiple refs** -- check several note refs at once (e.g. `refs/notes/commits` + `refs/notes/claude-prompts`)
- **Collapse/expand** -- long notes start collapsed with a "Show full note" button
- **XSS protection** -- all rendered HTML is sanitized with [DOMPurify](https://github.com/cure53/DOMPurify) using a strict tag/attribute allowlist

## Install

1. Clone this repository
2. **Chrome/Edge**: Go to `chrome://extensions`, enable "Developer mode", click "Load unpacked", select this directory
3. **Firefox**: Go to `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on", select `manifest.json`

The extension works immediately for **public repos on github.com** -- no token needed.

For **private repos on github.com**, open the extension options and add a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) scoped to the repos you need with **Contents: Read-only** permission.

## GitHub Enterprise Server

The extension also works on self-hosted GitHub Enterprise Server (GHES). Because enterprise hostnames are unique per install and unknowable at publish time, you enable each host yourself.

**Enable a host:**

- Open the options page, enter your GHES hostname (e.g. `ghe.example.com`), and click *Add*, **or**
- On any GHES commit page, click the extension icon and use *Enable this host*.

Either path triggers a browser permission prompt for that single origin. That prompt is why the extension declares `https://*/*` as an *optional* host permission -- the wildcard is the allowed set the user can grant *from*, not something the extension asks for up front. Granted origins are listed in the options page and can be revoked there or in your browser's extension settings.

**Tokens are usually not needed.** On GHES the API (`https://YOUR-GHES-HOST/api/v3`) and raw content (`https://YOUR-GHES-HOST/{owner}/{repo}/raw/...`) are same-origin with the commit page, so your existing signed-in browser session already covers private repos. This is a genuine advantage over github.com, where `raw.githubusercontent.com` won't accept your session cookie.

**If you do need a token** (e.g. session-less use, or a token-only network policy), create a **classic PAT** with the `repo` scope at `https://YOUR-GHES-HOST/settings/tokens`. Fine-grained tokens aren't available on all GHES releases.

**Subdomain isolation** is handled automatically. When your admin has enabled it, raw content 302s from `YOUR-HOST/{...}/raw/...` to `raw.YOUR-HOST/...`; the browser follows the redirect using the permission you granted.

**Older GHES releases** may lack the internal `/tree/` JSON payload the extension uses on github.com for fast note discovery. When that endpoint is absent the extension automatically falls back to the REST `git/trees` API -- no configuration required.

**Remove a host** by clicking the ✕ next to it in the options page. That unregisters the content script, deletes the stored token for that host, and revokes the browser permission.

## How It Works

The extension runs as a content script on GitHub commit pages. It uses same-origin `fetch` requests with your existing GitHub session cookies to retrieve note content:

1. `GET /{owner}/{repo}/tree/{noteRef}` (JSON) -- list entries in the notes tree
2. `GET /{owner}/{repo}/raw/{noteRef}/{commitSha}` -- fetch the raw note content

For private repos, `raw.githubusercontent.com` requires authentication. The extension uses a stored PAT (if configured) to fetch note content.

The notes tree response is used to match the current commit SHA (handling abbreviated SHAs and fanout directory layouts used by large repos). Content is fetched directly as raw text.

### Format detection and rendering

Once a note's content is fetched, the extension detects its format:

| Format | Detection | Rendering |
|---|---|---|
| Markdown | Headers, bold, lists, tables, code blocks, HTML comments | Full GFM via marked + DOMPurify sanitization |
| JSON | Starts with `{` or `[` and parses successfully | Pretty-printed with 2-space indent |
| YAML | Multiple `key: value` lines | Syntax-highlighted keys |
| Plain text | Fallback | Monospace `<pre>` block |

## Security

All rendered HTML (from Markdown) is sanitized by **DOMPurify** with a strict allowlist of tags and attributes. Scripts, event handlers, forms, iframes, and other XSS vectors are stripped before content is injected into the page.

## Configuration

Open the extension options page to configure:

- **Hosts** -- github.com is always enabled. Add GHES hosts here; each gets its own token slot.
- **Per-host token** -- on github.com, a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with **Contents: Read-only** permission for private repos. On GHES, a classic token with the `repo` scope, usually not needed if you're signed in.
- **Additional note refs** -- extra refs to check beyond the auto-discovered ones and defaults (`refs/notes/commits`, `refs/notes/claude-prompt-trail`)
- **Clear cache** -- flush the in-memory notes tree cache

## Development

```
npm install
npm test              # Run unit + E2E tests
npm run screenshots   # Regenerate README screenshots
```

### Project structure

```
├── manifest.json       MV3 manifest (Chrome + Firefox)
├── background.js       Service worker: host registration, messages, auth checks
├── content.js          Content script: per-host fetch ladder, format detection, rendering
├── content.css         Styles matching GitHub's design language
├── lib/host.js         Host abstraction (github.com vs GHES); all host URLs live here
├── lib/storage.js      Per-host settings + tokens, schema migration
├── lib/notes.js        Host-aware REST ladder for resolving notes
├── lib/                marked.min.js + purify.min.js (vendored)
├── popup.html/js/css   Toolbar popup: auth status, settings link
├── options.html/js/css Options page: PAT, note refs, cache
├── icons/              Extension icons
├── test/               E2E tests and screenshot generator
└── screenshots/        Generated screenshots for README
```

## Cross-browser support

- **Chrome / Edge**: Manifest V3 service worker
- **Firefox**: Manifest V3 background scripts (dual declaration in manifest)
- Uses `browser.storage.local` for persistence (works everywhere)

## License

MIT

---

<p align="center">
  <a href="https://trailblaze.work">
    <img src="https://raw.githubusercontent.com/Trailblaze-work/trailblaze.work/main/trailblaze-mark.svg" alt="Trailblaze" width="50" />
  </a>
</p>
<h3 align="center">Built by <a href="https://trailblaze.work">Trailblaze</a></h3>
<p align="center">
  We help companies deploy AI across their workforce.<br>
  Strategy, implementation, training, and governance.<br><br>
  <a href="mailto:hello@trailblaze.work"><strong>hello@trailblaze.work</strong></a>
</p>
