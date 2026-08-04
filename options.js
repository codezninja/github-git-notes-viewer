if (typeof browser === "undefined") globalThis.browser = chrome;

const H = globalThis.GhnHost;

const hostsListEl = document.getElementById("hosts-list");
const hostsEmptyEl = document.getElementById("hosts-empty");
const hostsRetryBtn = document.getElementById("hosts-retry");
const newHostInput = document.getElementById("new-host");
const addHostBtn = document.getElementById("add-host");
const addHostStatus = document.getElementById("add-host-status");
const clearCacheBtn = document.getElementById("clear-cache");
const cacheStatus = document.getElementById("cache-status");

// Track per-row unsaved input state so Validate can implicitly save.
// Keyed by origin.
const rowState = new Map();

// ---- rendering ----

function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeEl(tag, opts) {
  const el = document.createElement(tag);
  if (!opts) return el;
  if (opts.className) el.className = opts.className;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.type) el.type = opts.type;
  if (opts.id) el.id = opts.id;
  if (opts.placeholder != null) el.placeholder = opts.placeholder;
  if (opts.title) el.title = opts.title;
  if (opts.attrs) {
    for (const [k, v] of Object.entries(opts.attrs)) el.setAttribute(k, v);
  }
  return el;
}

function renderHostRow(host) {
  const row = makeEl("div", { className: "host-row" });
  row.dataset.origin = host.origin;
  if (host.granted === false) row.classList.add("warning");

  // Header: label + kind badge + remove button
  const header = makeEl("div", { className: "host-header" });
  header.appendChild(makeEl("span", { className: "host-label", text: host.label }));
  const badge = makeEl("span", {
    className: `host-kind-badge ${host.kind === "dotcom" ? "dotcom" : "ghes"}`,
    text: host.kind === "dotcom" ? "github.com" : "enterprise",
  });
  header.appendChild(badge);
  if (host.removable) {
    const removeBtn = makeEl("button", {
      className: "host-remove",
      text: "×",
      title: `Remove ${host.label}`,
    });
    removeBtn.type = "button";
    removeBtn.addEventListener("click", () => onRemoveHost(host));
    header.appendChild(removeBtn);
  }
  row.appendChild(header);

  // Permission-revoked warning
  if (host.granted === false) {
    const banner = makeEl("div", { className: "host-warning-banner" });
    banner.appendChild(
      makeEl("span", {
        text: "Permission revoked — re-grant to keep using this host.",
      }),
    );
    const regrantBtn = makeEl("button", { text: "Re-grant" });
    regrantBtn.type = "button";
    regrantBtn.addEventListener("click", () => onRegrant(host, regrantBtn));
    banner.appendChild(regrantBtn);
    row.appendChild(banner);
  }

  // Token help link
  const helpP = makeEl("p", { className: "host-token-help" });
  helpP.appendChild(document.createTextNode("Token: "));
  const helpLink = makeEl("a", { text: H.tokenHint(host) });
  helpLink.href = H.tokenCreateUrl(host);
  helpLink.target = "_blank";
  helpLink.rel = "noopener";
  helpP.appendChild(helpLink);
  helpP.appendChild(document.createTextNode("."));
  row.appendChild(helpP);

  // Token input row
  const fieldRow = makeEl("div", { className: "field-row" });
  const input = makeEl("input", {
    type: "password",
    placeholder: host.hasToken ? "•••••••• saved" : "Personal access token (optional)",
    attrs: { spellcheck: "false", autocomplete: "off" },
  });
  input.addEventListener("input", () => {
    const st = rowState.get(host.origin) || {};
    st.dirty = true;
    rowState.set(host.origin, st);
  });
  fieldRow.appendChild(input);

  const toggleBtn = makeEl("button", { text: "Show", title: "Show/hide token" });
  toggleBtn.type = "button";
  toggleBtn.addEventListener("click", () => {
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    toggleBtn.textContent = isPassword ? "Hide" : "Show";
  });
  fieldRow.appendChild(toggleBtn);
  row.appendChild(fieldRow);

  // Actions
  const actions = makeEl("div", { className: "host-actions" });
  const saveBtn = makeEl("button", { className: "primary", text: "Save" });
  saveBtn.type = "button";
  saveBtn.addEventListener("click", () => onSaveToken(host, input, statusEl));
  actions.appendChild(saveBtn);

  const validateBtn = makeEl("button", { text: "Validate" });
  validateBtn.type = "button";
  validateBtn.addEventListener("click", () => onValidate(host, input, statusEl));
  actions.appendChild(validateBtn);

  if (host.hasToken) {
    const clearBtn = makeEl("button", { text: "Clear saved token" });
    clearBtn.type = "button";
    clearBtn.addEventListener("click", () => onClearToken(host, input, statusEl));
    actions.appendChild(clearBtn);
  }
  row.appendChild(actions);

  // Per-row status
  const statusEl = makeEl("div", { className: "host-status", attrs: { hidden: "" } });
  statusEl.hidden = true;
  row.appendChild(statusEl);

  return row;
}

async function loadHosts() {
  clearChildren(hostsListEl);
  hostsEmptyEl.hidden = true;

  let resp;
  try {
    resp = await browser.runtime.sendMessage({ type: "LIST_HOSTS" });
  } catch (err) {
    showEmptyRetry("Couldn't reach the extension background — try again.");
    return;
  }
  if (!resp || !Array.isArray(resp.hosts) || resp.hosts.length === 0) {
    showEmptyRetry("No hosts found. The extension may still be starting up.");
    return;
  }
  for (const host of resp.hosts) {
    hostsListEl.appendChild(renderHostRow(host));
  }
}

function showEmptyRetry(msg) {
  clearChildren(hostsEmptyEl);
  hostsEmptyEl.appendChild(document.createTextNode(msg + " "));
  const retry = makeEl("button", { className: "link-button", text: "Retry" });
  retry.type = "button";
  retry.addEventListener("click", loadHosts);
  hostsEmptyEl.appendChild(retry);
  hostsEmptyEl.hidden = false;
}

// ---- per-row actions ----

async function onSaveToken(host, input, statusEl) {
  const token = input.value.trim();
  try {
    const resp = await browser.runtime.sendMessage({
      type: "SET_TOKEN",
      origin: host.origin,
      token,
    });
    if (resp && resp.ok) {
      showStatus(statusEl, token ? "Token saved." : "Token cleared.", "success");
      rowState.delete(host.origin);
      // Re-render so the placeholder / Clear button reflect the new state.
      await loadHosts();
    } else {
      showStatus(statusEl, "Failed to save token.", "error");
    }
  } catch (err) {
    showStatus(statusEl, `Failed to save token: ${err && err.message ? err.message : err}`, "error");
  }
}

async function onClearToken(host, input, statusEl) {
  input.value = "";
  try {
    const resp = await browser.runtime.sendMessage({
      type: "SET_TOKEN",
      origin: host.origin,
      token: "",
    });
    if (resp && resp.ok) {
      showStatus(statusEl, "Saved token cleared.", "success");
      rowState.delete(host.origin);
      await loadHosts();
    } else {
      showStatus(statusEl, "Failed to clear token.", "error");
    }
  } catch (err) {
    showStatus(statusEl, `Failed to clear token: ${err && err.message ? err.message : err}`, "error");
  }
}

async function onValidate(host, input, statusEl) {
  showStatus(statusEl, "Validating…", "info");
  const pending = input.value.trim();
  const st = rowState.get(host.origin) || {};
  // If the user typed something new, save it first — matches previous behaviour.
  if (st.dirty && pending) {
    try {
      await browser.runtime.sendMessage({
        type: "SET_TOKEN",
        origin: host.origin,
        token: pending,
      });
      rowState.delete(host.origin);
    } catch (err) {
      showStatus(
        statusEl,
        `Failed to save token before validating: ${err && err.message ? err.message : err}`,
        "error",
      );
      return;
    }
  }

  let result;
  try {
    result = await browser.runtime.sendMessage({ type: "CHECK_AUTH", origin: host.origin });
  } catch (err) {
    showStatus(statusEl, `Validation failed: ${err && err.message ? err.message : err}`, "error");
    return;
  }
  if (result && result.authenticated) {
    if (result.usedCookie) {
      showStatus(
        statusEl,
        `Signed in as ${result.username} (browser session — no token needed)`,
        "success",
      );
    } else {
      showStatus(statusEl, `Authenticated as ${result.username}`, "success");
    }
  } else {
    const err = (result && result.error) || "unknown error";
    showStatus(statusEl, `Authentication failed: ${err}`, "error");
  }
}

async function onRemoveHost(host) {
  try {
    const resp = await browser.runtime.sendMessage({
      type: "REMOVE_HOST",
      origin: host.origin,
    });
    if (resp && resp.ok) {
      // Best-effort revoke the host permission too. Not strictly required, but
      // avoids leaving orphaned permissions in the browser UI.
      try {
        await browser.permissions.remove({
          origins: [H.hostPermissionPattern(host.origin)],
        });
      } catch {
        /* ignore — user can revoke manually */
      }
      await loadHosts();
    } else {
      // Surface removal errors in the add-host status area (row is gone by design).
      showStatus(addHostStatus, "Failed to remove host.", "error");
    }
  } catch (err) {
    showStatus(
      addHostStatus,
      `Failed to remove host: ${err && err.message ? err.message : err}`,
      "error",
    );
  }
}

async function onRegrant(host, btn) {
  btn.disabled = true;
  try {
    const granted = await browser.permissions.request({
      origins: [H.hostPermissionPattern(host.origin)],
    });
    if (!granted) {
      btn.disabled = false;
      return;
    }
    // Re-notify background so it can re-register the content script.
    await browser.runtime.sendMessage({ type: "ADD_HOST", origin: host.origin });
    await loadHosts();
  } catch (err) {
    btn.disabled = false;
    /* leave the banner in place; user can retry */
  }
}

// ---- add host flow ----

addHostBtn.addEventListener("click", async () => {
  const raw = newHostInput.value;
  const norm = H.normalizeHostInput(raw);
  if (!norm.ok) {
    showStatus(addHostStatus, norm.error, "error");
    return;
  }

  // Must call permissions.request() synchronously from the gesture — no awaits before it.
  let granted;
  try {
    granted = await browser.permissions.request({
      origins: [H.hostPermissionPattern(norm.origin)],
    });
  } catch (err) {
    showStatus(
      addHostStatus,
      `Permission request failed: ${err && err.message ? err.message : err}`,
      "error",
    );
    return;
  }
  if (!granted) {
    showStatus(
      addHostStatus,
      "Permission denied — the host can't be enabled without it.",
      "error",
    );
    return;
  }

  showStatus(addHostStatus, "Checking host…", "info");

  // Probe to make sure this really looks like GHES.
  let probe;
  try {
    probe = await browser.runtime.sendMessage({ type: "PROBE_HOST", origin: norm.origin });
  } catch (err) {
    probe = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (!probe || !probe.ok) {
    const errMsg = (probe && probe.error) || "Host probe failed.";
    // Roll back the permission we just requested.
    try {
      await browser.permissions.remove({
        origins: [H.hostPermissionPattern(norm.origin)],
      });
    } catch {
      /* ignore */
    }
    showStatus(addHostStatus, `Couldn't verify host: ${errMsg}`, "error");
    return;
  }

  // Add the host.
  let addResp;
  try {
    addResp = await browser.runtime.sendMessage({ type: "ADD_HOST", origin: norm.origin });
  } catch (err) {
    addResp = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  if (!addResp || !addResp.ok) {
    const errMsg = (addResp && addResp.error) || "unknown error";
    showStatus(addHostStatus, `Failed to add host: ${errMsg}`, "error");
    return;
  }

  newHostInput.value = "";
  const label = addResp.host && addResp.host.label ? addResp.host.label : norm.origin;
  showStatus(addHostStatus, `Added ${label}.`, "success");
  await loadHosts();
});

// ---- cache ----

clearCacheBtn.addEventListener("click", async () => {
  try {
    await browser.runtime.sendMessage({ type: "CLEAR_CACHE" });
    showStatus(cacheStatus, "Cache cleared.", "success");
  } catch (err) {
    showStatus(
      cacheStatus,
      `Failed to clear cache: ${err && err.message ? err.message : err}`,
      "error",
    );
  }
});

// ---- retry button in the empty state (initial pointer, replaced dynamically) ----
if (hostsRetryBtn) {
  hostsRetryBtn.addEventListener("click", loadHosts);
}

// ---- status helper ----

function showStatus(el, text, type) {
  el.textContent = text;
  const base = el.classList.contains("host-status") ? "host-status" : "status";
  el.className = `${base} ${type}`;
  el.hidden = false;
  if (type !== "info") {
    setTimeout(() => {
      el.hidden = true;
    }, 4000);
  }
}

// ---- init ----

loadHosts();
