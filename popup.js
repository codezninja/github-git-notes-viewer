if (typeof browser === "undefined") globalThis.browser = chrome;

const els = {
  context: document.getElementById("context"),
  contextDot: document.getElementById("context-dot"),
  contextLabel: document.getElementById("context-label"),
  contextDetail: document.getElementById("context-detail"),
  contextPrimary: document.getElementById("context-primary"),
  contextSecondary: document.getElementById("context-secondary"),
  contextMessage: document.getElementById("context-message"),
  hostList: document.getElementById("host-list"),
  settingsBtn: document.getElementById("open-settings"),
};

let activeTabId = null;

async function safeSendMessage(msg) {
  try {
    const res = await browser.runtime.sendMessage(msg);
    return res;
  } catch (err) {
    return { __error: err && err.message ? err.message : String(err) };
  }
}

async function listHosts() {
  const res = await safeSendMessage({ type: "LIST_HOSTS" });
  if (!res || res.__error || !Array.isArray(res.hosts)) return [];
  return res.hosts;
}

function setDot(el, state) {
  el.classList.remove("connected", "disconnected", "warning");
  if (state) el.classList.add(state);
}

function setMessage(text, kind) {
  const el = els.contextMessage;
  el.classList.remove("error", "success");
  if (!text) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  if (kind) el.classList.add(kind);
  el.textContent = text;
  el.hidden = false;
}

function showButton(btn, text, handler, opts) {
  const primary = opts && opts.primary;
  btn.textContent = text;
  btn.hidden = false;
  btn.disabled = false;
  if (primary) btn.classList.add("primary");
  else btn.classList.remove("primary");
  btn.onclick = handler;
}

function hideButton(btn) {
  btn.hidden = true;
  btn.onclick = null;
  btn.disabled = false;
  btn.classList.remove("primary");
}

function resetContext() {
  els.context.hidden = false;
  els.context.classList.remove("warning");
  setDot(els.contextDot, null);
  els.contextLabel.textContent = "";
  els.contextDetail.textContent = "";
  hideButton(els.contextPrimary);
  hideButton(els.contextSecondary);
  setMessage("", null);
}

function renderHostList(hosts) {
  const ul = els.hostList;
  ul.textContent = "";
  if (!hosts.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No hosts configured.";
    ul.appendChild(li);
    return;
  }
  for (const h of hosts) {
    const li = document.createElement("li");

    const dot = document.createElement("span");
    dot.className = "dot";
    if (h.granted === false) dot.classList.add("disconnected");
    else if (h.hasToken) dot.classList.add("connected");
    else dot.classList.add("warning");
    li.appendChild(dot);

    const label = document.createElement("span");
    label.className = "host-label";
    label.textContent = h.label || h.hostname || h.origin || "(unknown)";
    li.appendChild(label);

    const meta = document.createElement("span");
    meta.className = "host-meta";
    if (h.granted === false) meta.textContent = "revoked";
    else if (h.hasToken) meta.textContent = "token";
    else meta.textContent = "cookie";
    li.appendChild(meta);

    ul.appendChild(li);
  }
}

async function getActiveTab() {
  try {
    const tabs = await browser.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0] ? tabs[0] : null;
  } catch {
    return null;
  }
}

function safeOrigin(url) {
  if (!url || typeof url !== "string") return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

async function renderAuthStatusFor(host) {
  const res = await safeSendMessage({ type: "CHECK_AUTH", origin: host.origin });
  setDot(els.contextDot, null);
  if (!res || res.__error) {
    setDot(els.contextDot, "disconnected");
    els.contextLabel.textContent = res && res.__error
      ? `Auth error: ${res.__error}`
      : "Auth check failed";
    return;
  }
  if (res.authenticated) {
    setDot(els.contextDot, "connected");
    if (res.usedCookie) {
      els.contextLabel.textContent =
        `Signed in as ${res.username} — browser session`;
    } else {
      els.contextLabel.textContent = `Authenticated as ${res.username}`;
    }
  } else {
    setDot(els.contextDot, "disconnected");
    els.contextLabel.textContent = res.error
      ? `Auth error: ${res.error}`
      : "No token configured";
  }
}

async function enableHostFlow(origin, label) {
  // Step i: request permission FIRST (must be first await to preserve user gesture).
  const pattern = GhnHost.hostPermissionPattern(origin);
  let granted = false;
  try {
    granted = await browser.permissions.request({ origins: [pattern] });
  } catch (err) {
    setMessage(`Permission request failed: ${err && err.message ? err.message : err}`, "error");
    return;
  }

  if (!granted) {
    setMessage("Permission denied.", "error");
    return;
  }

  // Step iii: probe.
  els.contextPrimary.disabled = true;
  setMessage(`Probing ${label}...`, null);
  const probe = await safeSendMessage({ type: "PROBE_HOST", origin });
  if (!probe || probe.__error || !probe.ok) {
    const err = (probe && (probe.error || probe.__error)) || "Probe failed";
    setMessage(`Probe failed: ${err}`, "error");
    try {
      await browser.permissions.remove({ origins: [pattern] });
    } catch {
      // best-effort rollback
    }
    els.contextPrimary.disabled = false;
    return;
  }

  // Step iv: add host.
  setMessage(`Enabling ${label}...`, null);
  const added = await safeSendMessage({ type: "ADD_HOST", origin });
  if (!added || added.__error || !added.ok) {
    const err = (added && (added.error || added.__error)) || "Add failed";
    setMessage(`Could not enable host: ${err}`, "error");
    try {
      await browser.permissions.remove({ origins: [pattern] });
    } catch {
      // best-effort rollback
    }
    els.contextPrimary.disabled = false;
    return;
  }

  setMessage("Enabled — reload the page to see notes.", "success");
  hideButton(els.contextPrimary);
  showButton(
    els.contextSecondary,
    "Reload page",
    async () => {
      if (activeTabId != null) {
        try {
          await browser.tabs.reload(activeTabId);
        } catch {
          // ignore
        }
      }
      window.close();
    },
    { primary: true },
  );
}

function renderNoContext(hosts) {
  resetContext();
  setDot(els.contextDot, null);
  els.contextLabel.textContent = "No GitHub host on this tab";
  const count = hosts.length;
  els.contextDetail.textContent =
    count === 1
      ? "1 host configured."
      : `${count} hosts configured.`;

  // Show github.com auth status as the neutral summary.
  const dotcom = hosts.find((h) => h.kind === "dotcom");
  if (dotcom) {
    renderAuthStatusFor(dotcom).catch(() => {
      // renderAuthStatusFor already handles its own errors.
    });
  }
}

function renderConfiguredHost(host) {
  resetContext();
  els.contextLabel.textContent = host.label || host.hostname || host.origin;
  els.contextDetail.textContent = host.origin;
  renderAuthStatusFor(host).catch(() => {});
}

function renderRevokedHost(host) {
  resetContext();
  els.context.classList.add("warning");
  setDot(els.contextDot, "warning");
  els.contextLabel.textContent = host.label || host.hostname || host.origin;
  els.contextDetail.textContent = "Permission revoked";
  showButton(
    els.contextPrimary,
    "Re-grant access",
    () => enableHostFlow(host.origin, host.label || host.hostname || host.origin),
    { primary: true },
  );
}

function renderUnconfiguredHost(origin, label) {
  resetContext();
  setDot(els.contextDot, "warning");
  els.contextLabel.textContent = `${label} is not enabled`;
  els.contextDetail.textContent = origin;
  showButton(
    els.contextPrimary,
    "Enable this host",
    () => enableHostFlow(origin, label),
    { primary: true },
  );
}

async function init() {
  const hosts = await listHosts();
  renderHostList(hosts);

  const tab = await getActiveTab();
  activeTabId = tab && typeof tab.id === "number" ? tab.id : null;
  const origin = tab ? safeOrigin(tab.url) : null;

  if (!origin) {
    renderNoContext(hosts);
    return;
  }

  const configured = hosts.find((h) => h.origin === origin);

  if (configured) {
    if (configured.granted === false) {
      renderRevokedHost(configured);
    } else {
      renderConfiguredHost(configured);
    }
    return;
  }

  // Not configured — see if it looks like it could be a GitHub-shaped host.
  const norm = GhnHost.normalizeHostInput(origin);
  if (norm && norm.ok === true) {
    let label;
    try {
      label = GhnHost.deriveHost(norm.origin).label;
    } catch {
      label = new URL(norm.origin).host;
    }
    renderUnconfiguredHost(norm.origin, label);
    return;
  }

  renderNoContext(hosts);
}

function renderFatal(err) {
  resetContext();
  setDot(els.contextDot, "disconnected");
  els.contextLabel.textContent = "Popup error";
  els.contextDetail.textContent =
    err && err.message ? err.message : "Something went wrong.";
}

els.settingsBtn.addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

init().catch(renderFatal);
