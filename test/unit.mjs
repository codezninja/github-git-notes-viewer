import puppeteer from "puppeteer";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import fs from "fs";
import assert from "assert";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

let browser, page;
let passed = 0;
let failed = 0;

async function setup() {
  browser = await puppeteer.launch({
    headless: true,
    args: process.env.CI ? ["--no-sandbox", "--disable-setuid-sandbox"] : [],
  });
  page = await browser.newPage();
}

async function teardown() {
  await browser.close();
}

async function loadContentFunctions() {
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });

  // Mock browser globals before loading content.js
  await page.evaluate(() => {
    window.browser = {
      storage: { local: { get: async () => ({}) } },
      runtime: { sendMessage: async () => ({}) },
    };
  });

  // Load libraries and content.js via script tags (global scope)
  const purifyJs = fs.readFileSync(path.join(ROOT, "lib/purify.min.js"), "utf-8");
  const markedJs = fs.readFileSync(path.join(ROOT, "lib/marked.min.js"), "utf-8");
  const contentJs = fs.readFileSync(path.join(ROOT, "content.js"), "utf-8");

  await page.addScriptTag({ content: purifyJs });
  await page.addScriptTag({ content: markedJs });
  await page.addScriptTag({ content: contentJs });
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

async function run() {
  await setup();

  console.log("GitHub Git Notes Viewer — Unit Tests\n");

  // Load once — all tested functions are pure/deterministic
  await loadContentFunctions();

  // ========== COMMIT_URL_RE ==========
  console.log("  COMMIT_URL_RE");

  await test("matches standard commit URL", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/abc123def456")
    );
    assert.ok(result);
  });

  await test("captures owner, repo, and SHA", async () => {
    const result = await page.evaluate(() => {
      const m = "/owner/repo/commit/abc123def456".match(COMMIT_URL_RE);
      return m ? [m[1], m[2], m[3]] : null;
    });
    assert.deepStrictEqual(result, ["owner", "repo", "abc123def456"]);
  });

  await test("matches minimum SHA length (5 chars)", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/a1b2c")
    );
    assert.ok(result);
  });

  await test("matches full 40-char SHA", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/o/r/commit/abcdef0123456789abcdef0123456789abcdef01")
    );
    assert.ok(result);
  });

  await test("rejects SHA shorter than 5 chars", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/abc1")
    );
    assert.ok(!result);
  });

  await test("rejects SHA longer than 40 chars", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/o/r/commit/abcdef0123456789abcdef0123456789abcdef012")
    );
    assert.ok(!result);
  });

  await test("rejects non-commit pages", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/tree/main")
    );
    assert.ok(!result);
  });

  await test("rejects extra path segments after SHA", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/abc123/extra")
    );
    assert.ok(!result);
  });

  await test("matches uppercase hex (case-insensitive)", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/Owner/Repo/commit/ABCDEF")
    );
    assert.ok(result);
  });

  await test("rejects non-hex characters in SHA", async () => {
    const result = await page.evaluate(() =>
      COMMIT_URL_RE.test("/owner/repo/commit/ghijk")
    );
    assert.ok(!result);
  });

  // ========== detectFormat ==========
  console.log("\n  detectFormat");

  await test("detects JSON object", async () => {
    const result = await page.evaluate(() => detectFormat('{"key": "value"}'));
    assert.strictEqual(result, "json");
  });

  await test("detects JSON array", async () => {
    const result = await page.evaluate(() => detectFormat("[1, 2, 3]"));
    assert.strictEqual(result, "json");
  });

  await test("rejects invalid JSON starting with {", async () => {
    const result = await page.evaluate(() => detectFormat("{not json}"));
    assert.notStrictEqual(result, "json");
  });

  await test("detects markdown heading", async () => {
    const result = await page.evaluate(() => detectFormat("# Title\nSome text"));
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown bold", async () => {
    const result = await page.evaluate(() =>
      detectFormat("This has **bold** text")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown unordered list", async () => {
    const result = await page.evaluate(() =>
      detectFormat("- item 1\n- item 2")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown ordered list", async () => {
    const result = await page.evaluate(() =>
      detectFormat("1. first\n2. second")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown table", async () => {
    const result = await page.evaluate(() =>
      detectFormat("|col1|col2|\n|---|---|")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown code block", async () => {
    const result = await page.evaluate(() =>
      detectFormat("```js\nconst x = 1;\n```")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects markdown HTML comment", async () => {
    const result = await page.evaluate(() =>
      detectFormat("<!-- prompt -->\nSome content")
    );
    assert.strictEqual(result, "markdown");
  });

  await test("detects YAML with multiple keys", async () => {
    const result = await page.evaluate(() =>
      detectFormat("key1: value1\nkey2: value2")
    );
    assert.strictEqual(result, "yaml");
  });

  await test("returns plain for single YAML-like line", async () => {
    const result = await page.evaluate(() => detectFormat("key: value"));
    assert.strictEqual(result, "plain");
  });

  await test("returns plain for simple text", async () => {
    const result = await page.evaluate(() =>
      detectFormat("just some plain text")
    );
    assert.strictEqual(result, "plain");
  });

  await test("returns plain for empty string", async () => {
    const result = await page.evaluate(() => detectFormat(""));
    assert.strictEqual(result, "plain");
  });

  await test("returns plain for whitespace only", async () => {
    const result = await page.evaluate(() => detectFormat("   \n  \n"));
    assert.strictEqual(result, "plain");
  });

  // ========== escapeHtml ==========
  console.log("\n  escapeHtml");

  await test("escapes script tags", async () => {
    const result = await page.evaluate(() =>
      escapeHtml('<script>alert("xss")</script>')
    );
    assert.ok(result.includes("&lt;script&gt;"));
  });

  await test("escapes ampersands", async () => {
    const result = await page.evaluate(() => escapeHtml("foo & bar"));
    assert.ok(result.includes("&amp;"));
  });

  await test("returns empty string for empty input", async () => {
    const result = await page.evaluate(() => escapeHtml(""));
    assert.strictEqual(result, "");
  });

  await test("double-escapes already-escaped entities", async () => {
    const result = await page.evaluate(() => escapeHtml("&amp;"));
    assert.ok(result.includes("&amp;amp;"));
  });

  // ========== renderContentToHtml ==========
  console.log("\n  renderContentToHtml");

  await test("renders markdown headings to HTML", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("# Hello\n\nWorld", "markdown")
    );
    assert.ok(result.includes("<h1>"));
    assert.ok(result.includes("Hello"));
  });

  await test("sanitizes script tags in markdown", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<script>alert(1)</script>', "markdown")
    );
    assert.ok(!result.includes("<script>"));
  });

  await test("pretty-prints JSON with indentation", async () => {
    const result = await page.evaluate(() => {
      const el = document.createElement("div");
      el.innerHTML = renderContentToHtml('{"a":1,"b":2}', "json");
      return el.querySelector("pre").textContent;
    });
    assert.ok(result.includes('"a": 1'));
    assert.ok(result.includes("\n"));
  });

  await test("handles invalid JSON gracefully", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("{bad json}", "json")
    );
    assert.ok(result.includes("ghn-content"));
    assert.ok(result.includes("{bad json}"));
  });

  await test("highlights YAML keys", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("key1: value1\nkey2: value2", "yaml")
    );
    assert.ok(result.includes("ghn-yaml-key"));
    assert.ok(result.includes("key1"));
  });

  await test("renders plain text in pre tag", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml("hello world", "plain")
    );
    assert.ok(result.includes("<pre"));
    assert.ok(result.includes("ghn-content"));
    assert.ok(result.includes("hello world"));
  });

  // ========== XSS / Injection ==========
  console.log("\n  XSS / Injection");

  // -- Markdown attack vectors (DOMPurify) --

  await test("strips img onerror event handler", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<img onerror="alert(1)" src="x">', "markdown")
    );
    assert.ok(!result.includes("onerror"));
  });

  await test("strips iframe tags", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<iframe src="javascript:alert(1)"></iframe>', "markdown")
    );
    assert.ok(!result.includes("<iframe"));
  });

  await test("strips form tags", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<form action="https://evil.com"><input></form>', "markdown")
    );
    assert.ok(!result.includes("<form"));
    assert.ok(!result.includes("<input"));
  });

  await test("strips javascript: URLs in links", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('[click](javascript:alert(1))', "markdown")
    );
    assert.ok(!result.includes("javascript:"));
  });

  await test("strips SVG with onload handler", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<svg onload="alert(1)"><circle r="10"/></svg>', "markdown")
    );
    assert.ok(!result.includes("onload"));
    assert.ok(!result.includes("<svg"));
  });

  await test("strips style tags in markdown", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<style>body{display:none}</style>', "markdown")
    );
    assert.ok(!result.includes("<style"));
  });

  await test("neutralizes script in data: URL img src", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<img src="data:text/html,<script>alert(1)</script>">', "markdown")
    );
    // DOMPurify escapes the script inside the URL; img won't execute data:text/html
    assert.ok(!result.includes("<script>"));
  });

  await test("strips event handlers on allowed tags", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<a href="#" onclick="alert(1)">link</a>', "markdown")
    );
    assert.ok(!result.includes("onclick"));
  });

  await test("strips nested script-in-attribute attack", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<div style="background:url(javascript:alert(1))">x</div>', "markdown")
    );
    assert.ok(!result.includes("javascript:"));
  });

  await test("strips math/annotation XSS vector", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<math><annotation-xml encoding="text/html"><script>alert(1)</script></annotation-xml></math>', "markdown")
    );
    assert.ok(!result.includes("<script"));
  });

  // -- JSON injection --

  await test("escapes HTML in JSON string values", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('{"xss": "<img onerror=alert(1) src=x>"}', "json")
    );
    assert.ok(!result.includes("<img"));
    assert.ok(result.includes("&lt;img"));
  });

  // -- YAML injection --

  await test("escapes HTML in YAML values", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('key: <script>alert(1)</script>\nother: safe', "yaml")
    );
    assert.ok(!result.includes("<script>"));
    assert.ok(result.includes("&lt;script&gt;"));
  });

  await test("escapes HTML in YAML keys", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<img onerror=alert(1)>: value\nkey2: val2', "yaml")
    );
    // Angle brackets must be escaped — no actual <img tag in output
    assert.ok(!result.includes("<img"));
    assert.ok(result.includes("&lt;img"));
  });

  // -- Plain text injection --

  await test("escapes all HTML in plain text", async () => {
    const result = await page.evaluate(() =>
      renderContentToHtml('<div onmouseover="alert(1)">hover me</div>', "plain")
    );
    // No actual <div tag in output — only escaped entity
    assert.ok(!result.includes("<div"));
    assert.ok(result.includes("&lt;div"));
  });

  // -- escapeHtml edge cases --

  await test("escapes angle brackets in all positions", async () => {
    const result = await page.evaluate(() =>
      escapeHtml('"><img src=x onerror=alert(1)>')
    );
    assert.ok(!result.includes("<img"));
  });

  await test("escapes HTML entities in encoded payloads", async () => {
    const result = await page.evaluate(() =>
      escapeHtml("&#60;script&#62;alert(1)&#60;/script&#62;")
    );
    assert.ok(result.includes("&amp;#60;"));
  });

  // ========================================================================
  // lib/host.js and lib/storage.js — plain Node-side pure-function tests.
  // These libs support CommonJS via `if (module.exports)` at the bottom, so
  // we can require them directly. storage.js reads GhnHost from globalThis at
  // load time, so we set that first, then require. A fresh in-memory mock for
  // browser.storage.local is installed before each storage test.
  // ========================================================================

  globalThis.GhnHost = require(path.join(ROOT, "lib/host.js"));
  const GhnHost = globalThis.GhnHost;
  const GhnStorage = require(path.join(ROOT, "lib/storage.js"));

  // Fresh mock storage backed by a plain object. setStorageState() seeds it.
  function installMockStorage(seed = {}) {
    const store = { ...seed };
    globalThis.browser = {
      storage: {
        local: {
          get: async (keys) => {
            if (keys === null || keys === undefined) return { ...store };
            if (typeof keys === "string") {
              return keys in store ? { [keys]: store[keys] } : {};
            }
            if (Array.isArray(keys)) {
              const out = {};
              for (const k of keys) if (k in store) out[k] = store[k];
              return out;
            }
            // object of defaults
            const out = {};
            for (const k of Object.keys(keys)) {
              out[k] = k in store ? store[k] : keys[k];
            }
            return out;
          },
          set: async (obj) => {
            Object.assign(store, obj);
          },
          remove: async (keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete store[k];
          },
          clear: async () => {
            for (const k of Object.keys(store)) delete store[k];
          },
        },
      },
    };
    return store;
  }

  // -------------- deriveHost --------------
  console.log("\n  lib/host.js — deriveHost");

  await test("github.com origin => dotcom", async () => {
    const h = GhnHost.deriveHost("https://github.com");
    assert.strictEqual(h.kind, "dotcom");
    assert.strictEqual(h.apiBase, "https://api.github.com");
    assert.strictEqual(h.rawOrigin, "https://raw.githubusercontent.com");
    assert.strictEqual(h.origin, "https://github.com");
    assert.strictEqual(h.hostname, "github.com");
  });

  await test("GHES origin => kind ghes, apiBase /api/v3, rawOrigin null", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com");
    assert.strictEqual(h.kind, "ghes");
    assert.strictEqual(h.apiBase, "https://ghe.example.com/api/v3");
    assert.strictEqual(h.rawOrigin, null);
    assert.strictEqual(h.origin, "https://ghe.example.com");
    assert.strictEqual(h.hostname, "ghe.example.com");
  });

  await test("trailing slash tolerated", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com/");
    assert.strictEqual(h.origin, "https://ghe.example.com");
    assert.strictEqual(h.apiBase, "https://ghe.example.com/api/v3");
  });

  await test("uppercase hostname normalised to lowercase", async () => {
    const h = GhnHost.deriveHost("https://GHE.Example.COM");
    assert.strictEqual(h.hostname, "ghe.example.com");
    assert.strictEqual(h.kind, "ghes");
  });

  await test("explicit port preserved in origin/apiBase", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com:8443");
    assert.strictEqual(h.origin, "https://ghe.example.com:8443");
    assert.strictEqual(h.hostname, "ghe.example.com");
    assert.strictEqual(h.apiBase, "https://ghe.example.com:8443/api/v3");
  });

  await test("invalid input throws", async () => {
    assert.throws(() => GhnHost.deriveHost("not a url"));
    assert.throws(() => GhnHost.deriveHost(""));
    assert.throws(() => GhnHost.deriveHost(null));
  });

  // -------------- normalizeHostInput --------------
  console.log("\n  lib/host.js — normalizeHostInput");

  await test("bare hostname gets https:// prefix", async () => {
    const r = GhnHost.normalizeHostInput("ghe.example.com");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.origin, "https://ghe.example.com");
    assert.strictEqual(r.kind, "ghes");
  });

  await test("trailing slash stripped", async () => {
    const r = GhnHost.normalizeHostInput("https://ghe.example.com/");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.origin, "https://ghe.example.com");
  });

  await test("deep link reduced to origin", async () => {
    const r = GhnHost.normalizeHostInput("https://ghe.example.com/foo/bar/commit/abc123");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.origin, "https://ghe.example.com");
  });

  await test("http:// rejected", async () => {
    const r = GhnHost.normalizeHostInput("http://x.com");
    assert.strictEqual(r.ok, false);
    assert.ok(/https/i.test(r.error));
  });

  await test("github.com rejected as always-enabled", async () => {
    const r = GhnHost.normalizeHostInput("github.com");
    assert.strictEqual(r.ok, false);
    assert.ok(/always/i.test(r.error));
  });

  await test("api.HOST rejected with suggestion of web hostname", async () => {
    const r = GhnHost.normalizeHostInput("api.ghe.example.com");
    assert.strictEqual(r.ok, false);
    assert.ok(/ghe\.example\.com/.test(r.error));
  });

  await test("single-label host localhost rejected", async () => {
    const r = GhnHost.normalizeHostInput("localhost");
    assert.strictEqual(r.ok, false);
  });

  await test("empty input rejected", async () => {
    const r = GhnHost.normalizeHostInput("");
    assert.strictEqual(r.ok, false);
    const r2 = GhnHost.normalizeHostInput("   ");
    assert.strictEqual(r2.ok, false);
  });

  // -------------- parseCommitPath --------------
  console.log("\n  lib/host.js — parseCommitPath");

  await test("7-char SHA parses", async () => {
    const r = GhnHost.parseCommitPath("/owner/repo/commit/abc1234");
    assert.deepStrictEqual(r, { owner: "owner", repo: "repo", commitSha: "abc1234" });
  });

  await test("40-char SHA parses", async () => {
    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const r = GhnHost.parseCommitPath(`/o/r/commit/${sha}`);
    assert.deepStrictEqual(r, { owner: "o", repo: "r", commitSha: sha });
  });

  await test("repo literally named 'commit' parses", async () => {
    const r = GhnHost.parseCommitPath("/owner/commit/commit/abc1234");
    assert.deepStrictEqual(r, { owner: "owner", repo: "commit", commitSha: "abc1234" });
  });

  await test("non-commit tree path is null", async () => {
    assert.strictEqual(GhnHost.parseCommitPath("/o/r/tree/main"), null);
  });

  await test("PR path is null", async () => {
    assert.strictEqual(GhnHost.parseCommitPath("/o/r/pull/42"), null);
  });

  // -------------- buildNoteContentCandidates (regression net) --------------
  console.log("\n  lib/host.js — buildNoteContentCandidates");

  await test("dotcom, no token => 1 candidate (raw, anon)", async () => {
    const h = GhnHost.deriveHost("https://github.com");
    const cs = GhnHost.buildNoteContentCandidates(h, "o", "r", "refs/notes/commits", "abc", { hasToken: false });
    assert.strictEqual(cs.length, 1);
    assert.strictEqual(cs[0].url, "https://raw.githubusercontent.com/o/r/notes/commits/abc");
    assert.strictEqual(cs[0].auth, "none");
    assert.strictEqual(cs[0].credentials, "omit");
  });

  await test("dotcom, with token => 3 candidates: raw anon, raw+token, contents API+token", async () => {
    const h = GhnHost.deriveHost("https://github.com");
    const cs = GhnHost.buildNoteContentCandidates(h, "o", "r", "refs/notes/commits", "abc", { hasToken: true });
    assert.strictEqual(cs.length, 3);
    assert.strictEqual(cs[0].url, "https://raw.githubusercontent.com/o/r/notes/commits/abc");
    assert.strictEqual(cs[0].auth, "none");
    assert.strictEqual(cs[1].url, "https://raw.githubusercontent.com/o/r/notes/commits/abc");
    assert.strictEqual(cs[1].auth, "token");
    assert.ok(cs[2].url.startsWith("https://api.github.com/repos/o/r/contents/abc?ref="));
    assert.strictEqual(cs[2].auth, "token");
  });

  await test("ghes, no token => 2 candidates, same-origin, no token", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com");
    const cs = GhnHost.buildNoteContentCandidates(h, "o", "r", "refs/notes/commits", "abc", { hasToken: false });
    assert.strictEqual(cs.length, 2);
    assert.strictEqual(cs[0].url, "https://ghe.example.com/o/r/raw/notes/commits/abc");
    assert.strictEqual(cs[0].credentials, "same-origin");
    assert.strictEqual(cs[0].auth, "none");
    assert.ok(cs[1].url.startsWith("https://ghe.example.com/api/v3/repos/o/r/contents/abc?ref="));
    assert.strictEqual(cs[1].credentials, "same-origin");
    assert.strictEqual(cs[1].auth, "none");
  });

  await test("ghes, with token => 3 candidates, third is contents API + token", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com");
    const cs = GhnHost.buildNoteContentCandidates(h, "o", "r", "refs/notes/commits", "abc", { hasToken: true });
    assert.strictEqual(cs.length, 3);
    assert.strictEqual(cs[2].auth, "token");
    assert.ok(cs[2].url.startsWith("https://ghe.example.com/api/v3/repos/o/r/contents/abc"));
  });

  await test("no ghes candidate ever leaks api.github.com or raw.githubusercontent.com", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com");
    for (const hasToken of [false, true]) {
      const cs = GhnHost.buildNoteContentCandidates(h, "o", "r", "refs/notes/commits", "abc", { hasToken });
      for (const c of cs) {
        assert.ok(
          !c.url.includes("api.github.com"),
          `ghes candidate leaked api.github.com: ${c.url}`
        );
        assert.ok(
          !c.url.includes("raw.githubusercontent.com"),
          `ghes candidate leaked raw.githubusercontent.com: ${c.url}`
        );
      }
    }
  });

  // -------------- apiHeaders --------------
  console.log("\n  lib/host.js — apiHeaders");

  await test("dotcom includes X-GitHub-Api-Version", async () => {
    const h = GhnHost.deriveHost("https://github.com");
    const headers = GhnHost.apiHeaders(h, null);
    assert.strictEqual(headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.strictEqual(headers.Authorization, undefined);
  });

  await test("ghes omits X-GitHub-Api-Version", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com");
    const headers = GhnHost.apiHeaders(h, null);
    assert.strictEqual(headers["X-GitHub-Api-Version"], undefined);
  });

  await test("Authorization only when token supplied", async () => {
    const hDot = GhnHost.deriveHost("https://github.com");
    const hGhes = GhnHost.deriveHost("https://ghe.example.com");
    assert.strictEqual(GhnHost.apiHeaders(hDot, "ghp_t").Authorization, "Bearer ghp_t");
    assert.strictEqual(GhnHost.apiHeaders(hGhes, "ghp_t").Authorization, "Bearer ghp_t");
    assert.strictEqual(GhnHost.apiHeaders(hDot, null).Authorization, undefined);
    assert.strictEqual(GhnHost.apiHeaders(hGhes, null).Authorization, undefined);
  });

  // -------------- refToBranchPath --------------
  console.log("\n  lib/host.js — refToBranchPath");

  await test("refs/notes/commits => notes/commits", async () => {
    assert.strictEqual(GhnHost.refToBranchPath("refs/notes/commits"), "notes/commits");
  });

  // -------------- tokenCreateUrl --------------
  console.log("\n  lib/host.js — tokenCreateUrl");

  await test("dotcom => github.com fine-grained token URL", async () => {
    const h = GhnHost.deriveHost("https://github.com");
    assert.strictEqual(
      GhnHost.tokenCreateUrl(h),
      "https://github.com/settings/personal-access-tokens/new"
    );
  });

  await test("ghes => ${origin}/settings/tokens/new...", async () => {
    const h = GhnHost.deriveHost("https://ghe.example.com");
    const url = GhnHost.tokenCreateUrl(h);
    assert.ok(url.startsWith("https://ghe.example.com/settings/tokens/new"));
    assert.ok(url.includes("scopes=repo"));
  });

  // -------------- storage migration --------------
  console.log("\n  lib/storage.js — migration & schema");

  await test("v1 { githubToken, noteRefs } => v2 tokens[dotcom], githubToken removed", async () => {
    const backing = installMockStorage({
      githubToken: "ghp_old",
      noteRefs: ["refs/notes/x"],
    });
    const store = await GhnStorage.getStore();
    assert.strictEqual(store.schemaVersion, 2);
    assert.strictEqual(store.tokens["https://github.com"], "ghp_old");
    assert.deepStrictEqual(store.noteRefs, ["refs/notes/x"]);
    // Backing store must no longer contain the legacy key.
    assert.strictEqual(backing.githubToken, undefined);
    assert.strictEqual(backing.schemaVersion, 2);
  });

  await test("getStore() is idempotent on already-migrated data", async () => {
    installMockStorage({
      githubToken: "ghp_old",
      noteRefs: ["refs/notes/x"],
    });
    const first = await GhnStorage.getStore();
    const second = await GhnStorage.getStore();
    assert.strictEqual(second.schemaVersion, 2);
    assert.strictEqual(second.tokens["https://github.com"], first.tokens["https://github.com"]);
    // Third call should also be fine.
    await GhnStorage.getStore();
  });

  // -------------- token isolation across hosts --------------
  console.log("\n  lib/storage.js — token isolation");

  await test("setToken on GHES does not leak to github.com", async () => {
    installMockStorage();
    await GhnStorage.setToken("https://ghe.example.com", "t1");
    const dotcomTok = await GhnStorage.getToken("https://github.com");
    assert.strictEqual(dotcomTok, null);
    const gheTok = await GhnStorage.getToken("https://ghe.example.com");
    assert.strictEqual(gheTok, "t1");
  });

  await test("setToken on github.com does not appear on GHES", async () => {
    installMockStorage();
    await GhnStorage.setToken("https://github.com", "d1");
    assert.strictEqual(await GhnStorage.getToken("https://ghe.example.com"), null);
    assert.strictEqual(await GhnStorage.getToken("https://github.com"), "d1");
  });

  // -------------- listHosts / removeHost --------------
  console.log("\n  lib/storage.js — listHosts / removeHost");

  await test("github.com is always present and not removable", async () => {
    installMockStorage();
    const hosts = await GhnStorage.listHosts();
    const dot = hosts.find((h) => h.origin === "https://github.com");
    assert.ok(dot, "github.com must be listed");
    assert.strictEqual(dot.removable, false);
  });

  await test("added GHES host is removable", async () => {
    installMockStorage();
    await GhnStorage.addHost("https://ghe.example.com");
    const hosts = await GhnStorage.listHosts();
    const ghes = hosts.find((h) => h.origin === "https://ghe.example.com");
    assert.ok(ghes, "GHES host must appear in listHosts");
    assert.strictEqual(ghes.removable, true);
    assert.strictEqual(ghes.kind, "ghes");
  });

  await test("removeHost('https://github.com') throws", async () => {
    installMockStorage();
    await assert.rejects(() => GhnStorage.removeHost("https://github.com"));
  });

  // -------------- capability TTL --------------
  console.log("\n  lib/storage.js — capabilities TTL");

  await test("capability returns null past CAPABILITY_TTL", async () => {
    const stale = Date.now() - (GhnStorage.CAPABILITY_TTL + 1000);
    installMockStorage({
      schemaVersion: 2,
      hosts: { "https://ghe.example.com": { kind: "ghes", addedAt: 0 } },
      tokens: {},
      noteRefs: [],
      capabilities: {
        "https://ghe.example.com": { treeJson: true, ts: stale },
      },
    });
    const cap = await GhnStorage.getCapabilities("https://ghe.example.com");
    assert.strictEqual(cap, null);
  });

  await test("capability returns entry when fresh", async () => {
    installMockStorage({
      schemaVersion: 2,
      hosts: { "https://ghe.example.com": { kind: "ghes", addedAt: 0 } },
      tokens: {},
      noteRefs: [],
      capabilities: {
        "https://ghe.example.com": { treeJson: true, ts: Date.now() },
      },
    });
    const cap = await GhnStorage.getCapabilities("https://ghe.example.com");
    assert.ok(cap);
    assert.strictEqual(cap.treeJson, true);
  });

  // --- Summary ---
  console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
  await teardown();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
