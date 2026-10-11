import { renderMarkdown, setImageSession } from "./markdown.js";
import { applyEvent } from "./reduce.js";
import { copyText } from "./clipboard.js";
import { composerAction, hasComposerContent } from "./composer.js";

const EFFORTS = [
  ["high", "High"],
  ["xhigh", "Extra high"],
  ["medium", "Medium"],
  ["low", "Low"],
];

const MODES = [
  ["default", "Ask"],
  ["auto", "Auto-review"],
  ["acceptEdits", "Accept edits"],
  ["dontAsk", "Read-only"],
  ["bypassPermissions", "Always approve"],
];

const MODE_HINT = {
  default: "Grok asks before commands and edits. You approve on the phone.",
  auto: "A reviewer lets routine work run and asks you about anything risky.",
  acceptEdits: "File edits run without asking. Commands still ask.",
  dontAsk: "Read-only. Anything that needs approval is denied.",
  bypassPermissions: "Always approve is on. Tools run without asking.",
};

const TOOL_LABEL = {
  run_terminal_command: "Terminal",
  read_file: "Read",
  write_file: "Write",
  edit_file: "Edit",
  search_replace: "Edit",
  list_dir: "List",
  grep: "Search",
  glob: "Find files",
  web_search: "Web search",
  web_fetch: "Fetch",
  todo_write: "Todos",
  task: "Subagent",
  spawn_subagent: "Start subagent",
  get_command_or_subagent_output: "Wait for subagents",
  send_subagent_message: "Message subagent",
};

const KIND_LABEL = { execute: "Terminal", edit: "Edit", read: "Read", search: "Search", fetch: "Fetch", think: "Think", delete: "Delete", move: "Move" };

const STATUS_LABEL = {
  in_progress: "running",
  pending: "running",
  waiting: "needs approval",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  denied: "denied",
};

function kindText(kind) {
  if (kind === "execute") return "terminal commands";
  if (kind === "edit") return "file edits";
  if (kind === "fetch") return "web fetches";
  if (String(kind).startsWith("tool:")) return String(kind).slice(5) + " calls";
  return kind + " requests";
}

const app = {
  gen: 0,
  home: "",
  dirs: [],
  models: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6", "grok-4.5"],
  sessionId: null,
  session: null,
  streamState: { messages: [], n: 0 },
  running: false,
  stick: true,
  es: null,
  quietClose: false,
  sending: false,
  draft: { cwd: "", model: "grok-4.7", effort: "high", permissionMode: "default", ultra: false },
  images: [],
  imageRoute: "",
  queue: [],
  loops: [],
};

const main = document.getElementById("main");
const top = document.getElementById("top");
const composer = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
const jump = document.getElementById("jump");
const notice = document.getElementById("notice");
const thumbs = document.getElementById("thumbs");
const photos = document.getElementById("photos");
const attachBtn = document.getElementById("attach");

function clearImages() {
  for (const image of app.images) {
    if (image.url) URL.revokeObjectURL(image.url);
  }
  app.images = [];
  renderThumbs();
}

function noteRoute(key) {
  if (app.imageRoute === key) return;
  app.imageRoute = key;
  clearImages();
}

function renderThumbs() {
  thumbs.replaceChildren();
  thumbs.hidden = app.images.length === 0;
  for (const image of app.images) {
    const wrap = document.createElement("div");
    wrap.className = "thumb";
    const img = document.createElement("img");
    img.alt = "";
    img.src = image.url;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "x";
    remove.setAttribute("aria-label", "Remove photo");
    remove.addEventListener("click", () => {
      URL.revokeObjectURL(image.url);
      app.images = app.images.filter((item) => item !== image);
      renderThumbs();
      growInput();
      paintSend();
    });
    wrap.append(img, remove);
    thumbs.append(wrap);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      const comma = value.indexOf(",");
      resolve(comma >= 0 ? value.slice(comma + 1) : value);
    };
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(blob);
  });
}

function canvasBlob(img, edge, quality) {
  let width = img.naturalWidth || img.width;
  let height = img.naturalHeight || img.height;
  const longest = Math.max(width, height);
  if (longest > edge) {
    const scale = edge / longest;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  if (width * height < 512) {
    const scale = Math.sqrt(512 / Math.max(1, width * height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(img, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

function prepareImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      URL.revokeObjectURL(url);
      try {
        let edge = 1600;
        let quality = 0.82;
        let blob = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          blob = await canvasBlob(img, edge, quality);
          if (blob && blob.size <= 180_000) break;
          edge = Math.round(edge * 0.75);
          quality = Math.max(0.55, quality - 0.08);
        }
        if (!blob || blob.size > 280_000) throw new Error("large");
        const data = await blobToBase64(blob);
        resolve({ mime: "image/jpeg", data, url: URL.createObjectURL(blob) });
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("read"));
    };
    img.src = url;
  });
}

async function addFiles(files) {
  let rejected = false;
  for (const file of files) {
    if (!file || !String(file.type || "").startsWith("image/")) continue;
    if (app.images.length >= 4) {
      setNotice("Attach up to 4 photos.");
      break;
    }
    try {
      app.images.push(await prepareImage(file));
    } catch {
      rejected = true;
    }
  }
  if (rejected) setNotice("That photo could not be read. Try a JPEG or PNG.");
  renderThumbs();
  growInput();
  paintSend();
}

function safeDataUrl(image) {
  if (!image || !/^image\/(jpeg|png|webp|gif)$/.test(image.mime || "")) return "";
  const data = String(image.data || "").replace(/\s/g, "");
  if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return "";
  return "data:" + image.mime + ";base64," + data;
}

function renderShots(node, images) {
  const list = Array.isArray(images) ? images : [];
  const key = list.map((image) => (image.mime || "") + ":" + String(image.data || "").length + ":" + String(image.data || "").slice(0, 24)).join("|");
  if (node._shots === key) return;
  node._shots = key;
  node.querySelector(":scope > .shots")?.remove();
  if (!list.length) return;
  const row = document.createElement("div");
  row.className = "shots";
  for (const image of list) {
    const src = safeDataUrl(image);
    if (!src) continue;
    const img = document.createElement("img");
    img.alt = "Image";
    img.src = src;
    row.append(img);
  }
  if (row.childElementCount) node.append(row);
}

function applyViewport(vv) {
  const topPx = vv && vv.offsetTop ? vv.offsetTop : 0;
  const height = vv && vv.height ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty("--vv-top", topPx + "px");
  document.documentElement.style.setProperty("--vv-height", height + "px");
}

function nearBottom() {
  return main.scrollHeight - main.scrollTop - main.clientHeight < 80;
}

function scrollToEnd(behavior) {
  main.scrollTo({ top: main.scrollHeight, behavior: behavior || "auto" });
}

function handleViewport() {
  const stick = app.stick || nearBottom();
  const vv = window.visualViewport;
  applyViewport(vv || { offsetTop: 0, height: window.innerHeight });
  if (stick) requestAnimationFrame(() => scrollToEnd("auto"));
}

window.__gm = { applyViewport, nearBottom, scrollToEnd, handleViewport };

function growInput() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  document.documentElement.style.setProperty("--composer-h", composer.offsetHeight + "px");
}

function setNotice(text) {
  notice.hidden = !text;
  notice.textContent = text || "";
}

function setBanner(mode) {
  app.bypass = mode === "bypassPermissions";
  paintPlus();
}

// The + button carries a small dot when something in the menu needs attention.
function paintPlus() {
  const chat = route().name === "chat";
  const waiting = chat && app.running && !!main.querySelector(".toolcard.asking");
  const auto = chat && activeAuto().length > 0;
  attachBtn.classList.toggle("flag-wait", waiting);
  attachBtn.classList.toggle("flag-auto", !waiting && (auto || (chat && app.bypass)));
}

function activeAuto() {
  if (!app.sessionId || !app.session) return [];
  return [...new Set([...(app.session.autoApprove || [])])];
}

function paintAuto() {
  paintPlus();
}

async function setAuto(kinds) {
  if (!app.sessionId) return;
  try {
    const saved = await api("/api/sessions/" + app.sessionId, { method: "PATCH", body: JSON.stringify({ autoApprove: kinds }) });
    app.session = saved.session;
    paintAuto();
    paintAutoSettings();
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

function paintAutoSettings() {
  const box = document.getElementById("auto-settings");
  if (!box) return;
  box.replaceChildren();
  const kinds = activeAuto();
  const label = document.createElement("div");
  label.className = "field-label";
  label.textContent = "Auto approve";
  box.append(label);
  if (!kinds.length) {
    const none = document.createElement("p");
    none.className = "mode-note";
    none.textContent = "Off. Tap Auto approve on any request to approve everything in this session, including subagents, until you turn it off.";
    box.append(none);
    return;
  }
  const row = document.createElement("div");
  row.className = "auto-row";
  const t = document.createElement("span");
  t.textContent = "On: every request in this session, including subagents";
  row.append(t, button("Turn off", () => setAuto([]), "mini"));
  box.append(row);
}

function paintWaiting() {
  paintPlus();
}

function setRunning(on) {
  app.running = on;
  if (!on) setTimeout(() => paintLive(app.streamState.messages), 0);
  if (!on && app.sessionId) setTimeout(() => paintContext(app.sessionId), 1500);
  top.classList.toggle("live", on);
  if (on) app.justDone = false;
  paintSend();
  paintWaiting();
}

function shortPath(dir) {
  if (!dir) return "";
  if (app.home && (dir === app.home || dir.startsWith(app.home + "/"))) {
    return "~" + dir.slice(app.home.length);
  }
  return dir;
}

function relTime(iso) {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const seconds = (Date.now() - then) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
  if (seconds < 86400 * 14) return Math.floor(seconds / 86400) + "d";
  return new Date(then).toLocaleDateString();
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    closeStream();
    await showAuth();
    const error = new Error("Login required");
    error.auth = true;
    throw error;
  }
  if (!res.ok) {
    const error = new Error(data.error || "Request failed");
    error.status = res.status;
    throw error;
  }
  return data;
}

function route() {
  const path = location.pathname;
  if (path === "/new") return { name: "new" };
  const match = path.match(/^\/s\/([0-9a-f-]{36})$/i);
  if (match) return { name: "chat", id: match[1] };
  return { name: "list" };
}

function go(path) {
  history.pushState({}, "", path);
  renderRoute();
}

// Session settings live in a bottom sheet. Every change saves at once.
const setsheet = document.createElement("div");
setsheet.id = "setsheet";
setsheet.hidden = true;
document.getElementById("app").append(setsheet);

function closeSettings() {
  if (setsheet.hidden) return;
  setsheet.hidden = true;
  const panel = setsheet.querySelector(".set-panel");
  if (panel) panel.style.transform = "";
}

function openSettings() {
  if (!setsheet.firstChild) return;
  setsheet.hidden = false;
  const panel = setsheet.querySelector(".set-panel");
  panel.scrollTop = 0;
  if (app.sessionId) loadUsage(app.sessionId);
}

setsheet.addEventListener("click", (event) => {
  if (event.target === setsheet) closeSettings();
});

function settingsGroup(title, ...nodes) {
  const sec = document.createElement("section");
  sec.className = "set-group";
  const h = document.createElement("h2");
  h.textContent = title;
  sec.append(h, ...nodes.filter(Boolean));
  return sec;
}

function buildSettings(id, session) {
  const save = async (patch) => {
    try {
      const saved = await api("/api/sessions/" + id, { method: "PATCH", body: JSON.stringify(patch) });
      app.session = saved.session;
      setBanner(saved.session.permissionMode);
      applyCurrentTheme();
      headerForChat();
      paintAuto();
      paintAutoSettings();
    } catch (error) {
      if (!error.auth) setNotice(error.message);
    }
  };
  const panel = document.createElement("div");
  panel.className = "set-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Session settings");
  const head = document.createElement("div");
  head.className = "set-head";
  const grip = document.createElement("span");
  grip.className = "grip";
  const h = document.createElement("h2");
  h.textContent = "Session settings";
  const done = button("Done", () => closeSettings(), "set-done");
  done.setAttribute("aria-label", "Close settings");
  head.append(grip, h, done);
  const name = document.createElement("input");
  name.id = "set-name";
  name.value = session.title || "";
  name.maxLength = 120;
  name.addEventListener("change", () => {
    const title = name.value.trim();
    if (title) save({ title });
  });
  const prefs = prefsBlock(session, (next) => save({ model: next.model, effort: next.effort, permissionMode: next.permissionMode, ultra: next.ultra, plan: next.plan }), { cwdEditable: false });
  const fields = [...prefs.querySelectorAll(":scope > .field")];
  const [dirField, modelField, effortField, permField] = fields;
  const modeNote = prefs.querySelector(":scope > .mode-note");
  const ultra = prefs.querySelector(":scope > .switch:not(.plan-switch)");
  const planSw = prefs.querySelector(":scope > .plan-switch");
  const themeGrid = themePicker(session.theme || "", (theme) => save({ theme }), { allowDefault: true });
  themeGrid.id = "set-theme";
  const autoBox = document.createElement("div");
  autoBox.id = "auto-settings";
  autoBox.className = "auto-settings";
  const usage = document.createElement("div");
  usage.className = "usage";
  usage.id = "usage";
  const body = document.createElement("div");
  body.className = "set-body";
  body.append(
    field("Name", name),
    settingsGroup("Theme", themeGrid),
    settingsGroup("Model and effort", modelField, effortField),
    settingsGroup("Approvals", permField, modeNote, autoBox),
    settingsGroup("Plan", planSw),
    settingsGroup("Ultra", ultra),
    settingsGroup("Skeptical review", skepticSessionBlock(id, session)),
    settingsGroup("Usage", usage),
    settingsGroup("Session", dirField, sessionActions(id))
  );
  panel.append(head, body);
  setsheet.replaceChildren(panel);
  paintAutoSettings();
  // Swipe down from the top of the sheet to close it.
  let startY = null;
  panel.addEventListener("touchstart", (event) => {
    startY = panel.scrollTop <= 0 || head.contains(event.target) ? event.touches[0].clientY : null;
  }, { passive: true });
  panel.addEventListener("touchmove", (event) => {
    if (startY == null) return;
    const dy = event.touches[0].clientY - startY;
    if (dy > 0) panel.style.transform = "translateY(" + dy + "px)";
  }, { passive: true });
  panel.addEventListener("touchend", (event) => {
    if (startY == null) return;
    const dy = (event.changedTouches[0]?.clientY || startY) - startY;
    startY = null;
    if (dy > 90) closeSettings();
    else panel.style.transform = "";
  });
}

// Live sync between devices: settings, theme, Auto approve, queue and new turns.
function openWatch(id) {
  if (app.watch && app.watchId === id) return;
  app.watch?.close();
  app.watchId = id;
  const es = new EventSource("/api/sessions/" + id + "/watch");
  app.watch = es;
  es.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (app.sessionId !== id) return;
    if (msg.what === "loops") {
      app.loops = msg.loops || [];
    } else if (msg.what === "queue") {
      app.queue = msg.items || [];
      paintQueue();
    } else if (msg.what === "skeptic") {
      paintSkeptic(msg.review);
    } else if (msg.what === "prefs") {
      try {
        const data = await api("/api/sessions/" + id);
        if (app.sessionId !== id) return;
        app.session = data.session;
        syncSettingsUi();
      } catch {
        // Next change will retry.
      }
    } else if (msg.what === "turn") {
      if (!app.es || app.es.readyState === EventSource.CLOSED) setTimeout(() => app.sessionId === id && reloadSettled(), 300);
    }
  };
}

function closeWatch() {
  app.watch?.close();
  app.watch = null;
  app.watchId = null;
}

function syncSettingsUi() {
  const s = app.session;
  if (!s) return;
  setBanner(s.permissionMode);
  applyCurrentTheme();
  headerForChat();
  paintAuto();
  paintAutoSettings();
  const name = document.getElementById("set-name");
  if (name && document.activeElement !== name) name.value = s.title || "";
  const grid = document.getElementById("set-theme");
  if (grid) for (const el of grid.children) {
    el.classList.toggle("on", el.dataset.id === (s.theme || ""));
    el.setAttribute("aria-checked", el.dataset.id === (s.theme || "") ? "true" : "false");
  }
  const sels = setsheet.querySelectorAll("select");
  const [model, effort, mode] = sels;
  if (model && s.model) model.value = s.model;
  if (effort && s.effort) effort.value = s.effort;
  if (mode && s.permissionMode) mode.value = s.permissionMode;
  const ultra = setsheet.querySelector(".switch:not(.plan-switch) input");
  if (ultra) ultra.checked = !!s.ultra;
  const planIn = setsheet.querySelector(".plan-switch input");
  if (planIn) planIn.checked = !!s.plan;
}

function closeStream() {
  if (!app.es) return;
  app.quietClose = true;
  app.es.close();
  app.es = null;
}

function header(title, buttons) {
  top.replaceChildren();
  top.classList.toggle("has-back", !!(buttons.left && buttons.left.length));
  for (const button of buttons.left || []) top.append(button);
  const h1 = document.createElement("h1");
  h1.textContent = title;
  top.append(h1);
  for (const button of buttons.right || []) top.append(button);
}

function button(label, onClick, className) {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  if (className) el.className = className;
  el.addEventListener("click", onClick);
  return el;
}

function field(label, control) {
  const wrap = document.createElement("label");
  wrap.className = "field";
  wrap.append(document.createTextNode(label));
  wrap.append(control);
  return wrap;
}

function select(options, value) {
  const el = document.createElement("select");
  for (const [val, text] of options) {
    const option = document.createElement("option");
    option.value = val;
    option.textContent = text;
    if (val === value) option.selected = true;
    el.append(option);
  }
  return el;
}

function applyTheme(theme) {
  const style = document.getElementById("theme-vars");
  if (style && theme.vars) {
    const css = ":root{" + Object.entries(theme.vars).map(([key, value]) => key + ":" + value).join(";") + "}";
    if (style.textContent !== css) style.textContent = css;
  }
  document.documentElement.style.colorScheme = theme.mode === "light" ? "light" : "dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme.vars && theme.vars["--bg-darker"]) meta.setAttribute("content", theme.vars["--bg-darker"]);
  app.themeName = theme.name || "";
  app.themePref = theme.pref || "purple";
}

// Themes: one global default plus an optional palette per session.
function themeById(id) {
  return (app.themes || []).find((theme) => theme.id === id) || null;
}

function sessionThemeId() {
  const where = route().name;
  if (where === "chat" && app.session && app.session.theme && themeById(app.session.theme)) return app.session.theme;
  if (where === "new" && app.draft.theme && themeById(app.draft.theme)) return app.draft.theme;
  return app.globalTheme || "purple";
}

function applyCurrentTheme() {
  const theme = themeById(sessionThemeId());
  if (theme) applyTheme(theme);
}

// Picks a palette no other recent or running session is using, so sessions are easy to tell apart.
function freshThemeId() {
  const ids = (app.themes || []).map((t) => t.id).filter((id) => id !== "desktop");
  const busy = new Set();
  const cutoff = Date.now() - 2 * 86400000;
  for (const session of app.sessions || []) {
    if (session.archived) continue;
    const recent = session.running || Date.parse(session.updatedAt || "") > cutoff;
    if (recent) busy.add(session.theme || app.globalTheme || "purple");
  }
  const free = ids.filter((id) => !busy.has(id));
  const pool = free.length ? free : ids;
  return pool[Math.floor(Math.random() * pool.length)] || "purple";
}

function themePicker(value, onPick, { allowDefault } = {}) {
  const grid = document.createElement("div");
  grid.className = "theme-grid";
  grid.setAttribute("role", "radiogroup");
  const options = [...(app.themes || [])];
  if (allowDefault) {
    const base = themeById(app.globalTheme || "purple");
    if (base) options.unshift({ ...base, id: "", name: "App default" });
  }
  const paint = (current) => {
    for (const el of grid.children) {
      const on = el.dataset.id === current;
      el.classList.toggle("on", on);
      el.setAttribute("aria-checked", on ? "true" : "false");
    }
  };
  for (const theme of options) {
    const v = theme.vars || {};
    const el = document.createElement("button");
    el.type = "button";
    el.className = "swatch";
    el.dataset.id = theme.id;
    el.setAttribute("role", "radio");
    el.style.setProperty("--sw-bg", v["--bg"]);
    el.style.setProperty("--sw-top", v["--bg-darker"] || v["--bg"]);
    el.style.setProperty("--sw-accent", v["--accent"]);
    el.style.setProperty("--sw-fg", v["--fg"]);
    el.style.setProperty("--sw-panel", v["--bg-light"] || v["--bg"]);
    const prev = document.createElement("span");
    prev.className = "sw-prev";
    prev.innerHTML = '<i class="sw-bar"></i><i class="sw-them"></i><i class="sw-me"></i>';
    const name = document.createElement("span");
    name.className = "sw-name";
    name.textContent = theme.id === "desktop" ? "Follow desktop" : theme.name;
    el.append(prev, name);
    el.addEventListener("click", () => {
      paint(theme.id);
      onPick(theme.id);
    });
    grid.append(el);
  }
  paint(value || "");
  return grid;
}

function themeField() {
  const wrap = document.createElement("div");
  wrap.className = "field";
  wrap.append(document.createTextNode("Default theme"));
  wrap.append(themePicker(app.globalTheme || "purple", async (id) => {
    try {
      await api("/api/theme", { method: "POST", body: JSON.stringify({ pref: id }) });
      app.globalTheme = id;
      applyCurrentTheme();
    } catch (error) {
      if (!error.auth) setNotice(error.message);
    }
  }));
  return wrap;
}

async function refreshTheme() {
  try {
    const data = await fetch("/api/themes", { credentials: "same-origin" }).then((res) => (res.ok ? res.json() : null));
    if (data && Array.isArray(data.themes)) {
      app.themes = data.themes;
      app.globalTheme = data.global || "purple";
      if (data.httpsUrl) app.httpsUrl = data.httpsUrl;
      applyCurrentTheme();
      return;
    }
    applyTheme(await fetch("/api/theme").then((res) => res.json()));
  } catch {
    // Keep the last palette.
  }
}

function registerWorker() {
  const secure = location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1";
  if (!secure || !("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

async function showAuth() {
  const status = await fetch("/api/auth/status").then((res) => res.json());
  noteRoute("auth");
  composer.hidden = true;
  jump.hidden = true;
  setBanner("");
  setNotice("");
  header("Grok Deck", {});
  main.replaceChildren();
  const screen = document.createElement("section");
  screen.className = "screen";
  const title = document.createElement("h2");
  title.textContent = status.needsSetup ? "Set a password" : "Log in";
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = status.needsSetup
    ? "First visit on this machine. The password stays here as a hash, and the phone keeps a long lived login."
    : "This session is tied to this machine.";
  screen.append(title, sub);
  const password = document.createElement("input");
  password.type = "password";
  password.autocomplete = status.needsSetup ? "new-password" : "current-password";
  password.minLength = 10;
  password.required = true;
  screen.append(field("Password", password));
  let confirm = null;
  if (status.needsSetup) {
    confirm = document.createElement("input");
    confirm.type = "password";
    confirm.autocomplete = "new-password";
    screen.append(field("Confirm password", confirm));
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "At least 10 characters.";
    screen.append(hint);
  }
  const submit = button(status.needsSetup ? "Save password" : "Log in", () => {}, "primary wide");
  submit.type = "submit";
  const form = document.createElement("form");
  form.className = "stack";
  while (screen.firstChild) form.append(screen.firstChild);
  form.append(submit);
  const err = document.createElement("p");
  err.className = "hint";
  err.hidden = true;
  form.append(err);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    err.hidden = true;
    if (status.needsSetup && password.value !== confirm.value) {
      err.hidden = false;
      err.textContent = "Passwords do not match.";
      return;
    }
    submit.disabled = true;
    try {
      await api(status.needsSetup ? "/api/auth/setup" : "/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ password: password.value }),
      });
      password.value = "";
      if (confirm) confirm.value = "";
      renderRoute();
    } catch (error) {
      if (error.auth) return;
      err.hidden = false;
      err.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  screen.append(form);
  main.append(screen);
  password.focus();
}

const STEP_ROLES = new Set(["tool", "thought", "plan", "note"]);

function stepLabel(message) {
  if (message.role === "thought") return "thinking";
  if (message.role === "plan") return "updating the plan";
  if (message.role === "note") return "system note";
  const tool = message.tool || {};
  const label = toolLabel(tool).toLowerCase();
  const line = oneLine(tool);
  const short = line.length > 48 ? line.slice(0, 47) + "…" : line;
  return short ? label + ": " + short : label;
}

function groupNode(id) {
  let node = main.querySelector('[data-gid="' + id + '"]');
  if (node) return node;
  node = document.createElement("details");
  node.className = "steps";
  node.dataset.gid = id;
  const summary = document.createElement("summary");
  const count = document.createElement("span");
  count.className = "steps-count";
  const chev = document.createElement("span");
  chev.className = "chev";
  summary.append(count, chev);
  const body = document.createElement("div");
  body.className = "steps-body";
  node.append(summary, body);
  return node;
}

const MAX_SUBAGENTS = 4;

function tokensText(n) {
  if (!n) return "";
  return (n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + "k" : String(n)) + " tokens";
}

function clockText(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function durationText(ms) {
  if (!ms) return "";
  const sec = Math.round(ms / 1000);
  return sec < 60 ? sec + "s" : Math.floor(sec / 60) + "m " + (sec % 60) + "s";
}

const SUB_STATUS = { running: "Running", completed: "Done", cancelled: "Stopped", failed: "Failed", error: "Failed" };

function runningSubagents(messages) {
  return messages.filter((m) => m.role === "subagent" && m.sub.status === "running");
}

function createSubagent(message, key) {
  const node = document.createElement("div");
  node.className = "subcard";
  node.dataset.mid = key;
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const head = document.createElement("div");
  head.className = "sub-head";
  const name = document.createElement("span");
  name.className = "sub-name";
  const status = document.createElement("span");
  status.className = "tool-status";
  const chev = document.createElement("span");
  chev.className = "chev";
  chev.setAttribute("aria-hidden", "true");
  head.append(name, status, chev);
  const meta = document.createElement("div");
  meta.className = "sub-meta";
  summary.append(head, meta);
  const body = document.createElement("div");
  body.className = "sub-body";
  const steps = document.createElement("div");
  steps.className = "sub-steps";
  const result = document.createElement("div");
  result.className = "sub-summary body";
  body.append(steps, result);
  details.append(summary, body);
  const stop = button("Stop", async (event) => {
    event.preventDefault();
    const el = event.currentTarget;
    el.disabled = true;
    el.textContent = "Stopping";
    try {
      await api("/api/sessions/" + app.sessionId + "/subagents/" + node._subId + "/cancel", { method: "POST", body: "{}" });
    } catch (error) {
      el.disabled = false;
      el.textContent = "Stop";
      if (!error.auth) setNotice(error.message);
    }
  }, "sub-stop");
  node.append(details, stop);
  return node;
}

function paintSubagent(node, message, keep) {
  const sub = message.sub;
  node._subId = sub.id;
  const status = sub.status || "running";
  node.dataset.status = status;
  node.querySelector(".sub-name").textContent = sub.name || "Subagent";
  const pill = node.querySelector(".tool-status");
  pill.textContent = sub.stopping && status === "running" ? "Stopping" : SUB_STATUS[status] || status;
  pill.dataset.s = status === "running" ? "in_progress" : status === "completed" ? "completed" : status === "cancelled" ? "cancelled" : "failed";
  const bits = [];
  const tier = subTier(sub.agentType, sub.name);
  node.dataset.tier = tier;
  bits.push(tier === "ultra" ? "Ultra tier" : tier === "strong" ? "Strong tier" : "Default tier");
  if (sub.agentType && sub.agentType !== "general-purpose") bits.push(sub.agentType.replace(/^grok-mobile-ultra:/, ""));
  const tokens = tokensText(sub.tokens || sub.liveTokens);
  if (tokens) bits.push(tokens);
  if (status === "running") {
    const steps = (sub.messages || []).filter((m) => STEP_ROLES.has(m.role));
    const last = steps[steps.length - 1];
    if (last) bits.push(stepLabel(last));
  } else {
    if (sub.finishedAt) bits.push("finished " + clockText(sub.finishedAt));
    if (sub.durationMs) bits.push(durationText(sub.durationMs));
  }
  const meta = bits.join(" · ");
  const metaNode = node.querySelector(".sub-meta");
  if (metaNode.textContent !== meta) metaNode.textContent = meta;
  const stop = node.querySelector(".sub-stop");
  stop.hidden = status !== "running" || !app.running;
  if (!sub.stopping && stop.textContent !== "Stop") {
    stop.textContent = "Stop";
    stop.disabled = false;
  }
  const stepsBox = node.querySelector(".sub-steps");
  const nodes = syncList(sub.messages || [], "s" + sub.id + "/", keep, true);
  nodes.forEach((child, index) => {
    if (stepsBox.children[index] !== child) stepsBox.insertBefore(child, stepsBox.children[index] || null);
  });
  while (stepsBox.children.length > nodes.length) stepsBox.lastElementChild.remove();
  const result = node.querySelector(".sub-summary");
  const lastReply = [...(sub.messages || [])].reverse().find((m) => m.role === "assistant");
  const same = lastReply && sub.summary && lastReply.text.trim() === sub.summary.trim();
  const text = same ? "" : sub.summary || "";
  if (result._text !== text) {
    result.innerHTML = text ? renderMarkdown(text) : "";
    result._text = text;
  }
  result.hidden = !text;
  const hasHistory = !(sub.messages || []).length && status !== "running" && sub.child;
  node.classList.toggle("can-load", !!hasHistory);
  const details = node.querySelector("details");
  if (!details._wired) {
    details._wired = true;
    details.addEventListener("toggle", () => {
      if (details.open && node.classList.contains("can-load") && !node._loading) loadSubagentSteps(node, message);
    });
  }
}

async function loadSubagentSteps(node, message) {
  node._loading = true;
  try {
    const data = await api("/api/sessions/" + message.sub.child);
    const live = app.streamState.messages.find((m) => m.role === "subagent" && m.sub.id === message.sub.id);
    if (live && !(live.sub.messages || []).length) {
      live.sub.messages = (data.messages || []).filter((m) => m.role !== "user").map((m) => ({ ...m, tool: m.tool ? { ...m.tool } : undefined }));
      syncDom();
    }
  } catch {
    // Steps are optional; the summary stays.
  }
}

function proxyPermission(message, tool, keep, existing) {
  const key = "proxy:" + tool.waiting.reqId;
  let node = existing.get(key);
  if (!node) {
    node = createMessage({ id: key, role: "tool", tool });
    node.classList.add("proxy");
    const from = document.createElement("div");
    from.className = "perm-from";
    node.prepend(from);
  } else updateMessage(node, { id: key, role: "tool", tool });
  node.querySelector(".perm-from").textContent = "Subagent: " + (message.sub.name || "Subagent");
  keep.add(node);
  return node;
}

let domExisting = new Map();

// Builds the nodes for one message list. Step messages between two replies fold into one "N steps" group.
function syncList(messages, prefix, keep, nested) {
  const top = [];
  let group = null;
  const closeGroup = () => {
    if (!group) return;
    const node = groupNode(group.id);
    const body = node.querySelector(".steps-body");
    group.nodes.forEach((child, index) => {
      if (body.children[index] !== child) body.insertBefore(child, body.children[index] || null);
    });
    while (body.children.length > group.nodes.length) body.lastElementChild.remove();
    const failed = group.items.filter((m) => m.tool && (m.tool.status === "failed" || m.tool.status === "denied")).length;
    const n = group.items.length;
    const tokens = group.items.reduce((sum, m) => sum + (Number(m.tokens) || 0), 0);
    node.querySelector(".steps-count").textContent = n + (n === 1 ? " step" : " steps") + (failed ? " · " + failed + " failed" : "") + (tokens ? " · " + tokensText(tokens) : "");
    node.classList.toggle("has-failed", failed > 0);
    keep.add(node);
    top.push(node);
    group = null;
  };
  for (const message of messages) {
    const key = prefix + message.id;
    let node = domExisting.get(key);
    if (message.role === "subagent") {
      if (!node) node = createSubagent(message, key);
      paintSubagent(node, message, keep);
    } else if (!node) {
      node = createMessage(message);
      node.dataset.mid = key;
    } else updateMessage(node, message);
    keep.add(node);
    const asking = !nested && message.role === "tool" && message.tool && message.tool.waiting;
    if (STEP_ROLES.has(message.role) && !asking) {
      if (!group) group = { id: "g-" + key, nodes: [], items: [] };
      group.nodes.push(node);
      group.items.push(message);
      continue;
    }
    closeGroup();
    top.push(node);
    if (message.role === "subagent" && !nested) {
      for (const inner of message.sub.messages || []) {
        if (inner.role === "tool" && inner.tool && inner.tool.waiting) top.push(proxyPermission(message, inner.tool, keep, domExisting));
      }
    }
  }
  closeGroup();
  return top;
}

function syncDom() {
  const messages = app.streamState.messages;
  domExisting = new Map([...main.querySelectorAll("[data-mid]")].map((node) => [node.dataset.mid, node]));
  const keep = new Set();
  const top = syncList(messages, "", keep, false);
  const bar = paintSubbar(messages);
  if (bar) {
    keep.add(bar);
    top.push(bar);
  }
  for (const node of main.querySelectorAll("[data-mid], [data-gid]")) {
    if (!keep.has(node)) node.remove();
  }
  const anchor = main.querySelector("#settings");
  let prev = anchor || null;
  for (const node of top) {
    const want = prev ? prev.nextSibling : main.firstChild;
    if (want !== node) main.insertBefore(node, want);
    prev = node;
  }
  paintLive(messages);
}

function paintSubbar(messages) {
  const running = runningSubagents(messages);
  let bar = main.querySelector('[data-mid="subbar"]');
  if (!running.length || !app.running) return null;
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "subbar";
    bar.dataset.mid = "subbar";
    const text = document.createElement("span");
    text.className = "subbar-text";
    const stop = button("Stop all", async (event) => {
      const el = event.currentTarget;
      el.disabled = true;
      try {
        await api("/api/sessions/" + app.sessionId + "/subagents/all/cancel", { method: "POST", body: "{}" });
      } catch (error) {
        if (!error.auth) setNotice(error.message);
      }
      el.disabled = false;
    }, "sub-stop");
    bar.append(text, stop);
  }
  const over = running.length > MAX_SUBAGENTS;
  bar.classList.toggle("over", over);
  const text = running.length + (running.length === 1 ? " subagent running" : " subagents running") + (over ? ". That is over the cap of " + MAX_SUBAGENTS + "." : "");
  const label = bar.querySelector(".subbar-text");
  if (label.textContent !== text) label.textContent = text;
  return bar;
}

function paintLive(messages) {
  let line = document.getElementById("live");
  const done = !app.running && app.justDone && route().name === "chat";
  if ((!app.running && !done) || composer.hidden) {
    line?.remove();
    return;
  }
  if (!line) {
    line = document.createElement("div");
    line.id = "live";
    line.className = "live-line";
  }
  const last = [...messages].reverse().find((m) => m.role !== "user");
  let text = "Working";
  if (done) text = "Done";
  else if ((app.streamState.waiting || 0) > 0) text = "Waiting for your approval";
  else if (last && last.role === "subagent" && runningSubagents(messages).length) text = "Working: " + runningSubagents(messages).length + " subagent" + (runningSubagents(messages).length === 1 ? "" : "s") + " running";
  else if (last && STEP_ROLES.has(last.role)) text = "Working: " + stepLabel(last);
  else if (last && last.role === "assistant" && last.open) text = "Writing";
  let spin = line.querySelector(".spin");
  let label = line.querySelector(".live-text");
  if (!label) {
    spin = document.createElement("span");
    spin.className = "spin";
    spin.setAttribute("aria-hidden", "true");
    label = document.createElement("span");
    label.className = "live-text";
    line.replaceChildren(spin, label);
  }
  line.classList.toggle("done", done);
  spin.hidden = done;
  if (label.textContent !== text) label.textContent = text;
  if (main.lastElementChild !== line) main.append(line);
}

// A small ASCII spinner in the theme colour. It changes style every few seconds.
const SPINNERS = [
  "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏",
  "✶✸✹✺✹✷",
  "⣾⣽⣻⢿⡿⣟⣯⣷",
  "·•●•",
  "◐◓◑◒",
  "▖▘▝▗",
];
let spinTick = 0;
setInterval(() => {
  const el = document.querySelector("#live .spin");
  if (!el || el.hidden) return;
  spinTick++;
  const set = SPINNERS[Math.floor(spinTick / 80) % SPINNERS.length];
  const frame = set[spinTick % set.length];
  if (el.textContent !== frame) el.textContent = frame;
}, 100);


function flashCopied(btn) {
  const prev = btn.dataset.label || btn.textContent;
  btn.dataset.label = prev;
  btn.textContent = "Copied";
  btn.classList.add("copied");
  clearTimeout(btn._flash);
  btn._flash = setTimeout(() => {
    btn.textContent = prev;
    btn.classList.remove("copied");
  }, 1200);
}

async function copyMessageText(node, btn) {
  const text = node._raw ?? "";
  const ok = await copyText(text);
  if (btn) {
    flashCopied(btn);
    if (!ok) btn.textContent = "Copy failed";
  } else if (ok) {
    node.classList.add("just-copied");
    clearTimeout(node._copyFlash);
    node._copyFlash = setTimeout(() => node.classList.remove("just-copied"), 1200);
  }
  return ok;
}

function addMsgCopy(node) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-copy";
  btn.textContent = "Copy";
  btn.setAttribute("aria-label", "Copy message");
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    copyMessageText(node, btn);
  });
  node.append(btn);
  let timer = 0;
  node.addEventListener("touchstart", (event) => {
    if (event.target.closest("button, a, .copy, .msg-copy")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      if (navigator.vibrate) navigator.vibrate(20);
      copyMessageText(node, null);
    }, 500);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = 0; };
  node.addEventListener("touchend", cancel);
  node.addEventListener("touchmove", cancel);
  node.addEventListener("touchcancel", cancel);
}

function createMessage(message) {
  if (message.role === "planreview") {
    const node = document.createElement("div");
    node.className = "plancard toolcard";
    node.dataset.mid = message.id;
    updateMessage(node, message);
    return node;
  }
  if (message.role === "user") {
    const node = document.createElement("div");
    node.className = "msg bubble user";
    node.dataset.mid = message.id;
    const text = document.createElement("div");
    text.className = "msg-text";
    node.append(text);
    addMsgCopy(node);
    updateMessage(node, message);
    return node;
  }
  if (message.role === "assistant") {
    const node = document.createElement("div");
    node.className = "msg bubble assistant";
    node.dataset.mid = message.id;
    const body = document.createElement("div");
    body.className = "body";
    node.append(body);
    addMsgCopy(node);
    updateMessage(node, message);
    return node;
  }
  if (message.role === "tool") {
    const node = document.createElement("div");
    node.className = "toolcard";
    node.dataset.mid = message.id;
    const details = document.createElement("details");
    details.className = "step tool";
    const summary = document.createElement("summary");
    const head = document.createElement("div");
    head.className = "tool-head";
    const name = document.createElement("span");
    name.className = "tool-name";
    const status = document.createElement("span");
    status.className = "tool-status";
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.setAttribute("aria-hidden", "true");
    head.append(name, status, chev);
    const line = document.createElement("div");
    line.className = "tool-line";
    summary.append(head, line);
    const body = document.createElement("div");
    body.className = "tool-body";
    details.append(summary, body);
    const perm = document.createElement("div");
    perm.className = "perm";
    perm.hidden = true;
    node.append(details, perm);
    updateMessage(node, message);
    return node;
  }
  if (message.role === "thought" || message.role === "plan" || message.role === "note") {
    const node = document.createElement("details");
    node.className = "step " + message.role;
    node.dataset.mid = message.id;
    const summary = document.createElement("summary");
    node.append(summary);
    const body = document.createElement("div");
    body.className = "step-body";
    node.append(body);
    updateMessage(node, message);
    return node;
  }
  const node = document.createElement("div");
  node.className = message.role === "error" ? "msg bubble error" : message.tone ? "status proof " + message.tone : "status";
  node.dataset.mid = message.id;
  updateMessage(node, message);
  return node;
}

function toolStatus(status) {
  return STATUS_LABEL[status || "in_progress"] || status;
}

function toolLabel(tool) {
  return TOOL_LABEL[tool.name] || KIND_LABEL[tool.kind] || (tool.name ? tool.name.replace(/_/g, " ") : "Tool");
}

function oneLine(tool) {
  const fromInput = String(tool.input || "").split("\n").find((line) => line.trim()) || "";
  let title = String(tool.title || "");
  const tick = title.match(/^[A-Z][a-z]+ `([\s\S]*)`$/);
  if (tick) title = tick[1];
  const text = tool.description || (fromInput && !/^[{[]/.test(fromInput.trim()) ? fromInput : "") || title || fromInput;
  return text.replace(/\s+/g, " ").trim().slice(0, 240);
}

function codeBlock(label, text) {
  const wrap = document.createElement("div");
  wrap.className = "tool-block";
  const cap = document.createElement("div");
  cap.className = "tool-cap";
  cap.textContent = label;
  const pre = document.createElement("pre");
  pre.className = "tool-pre";
  pre.textContent = text;
  wrap.append(cap, pre);
  return wrap;
}

function renderTool(node, tool) {
  const details = node.querySelector("details");
  const status = tool.status || "in_progress";
  const key = JSON.stringify([status, tool.title, tool.name, tool.kind, tool.input, tool.output, tool.description, tool.permission, tool.waiting && tool.waiting.reqId, (tool.images || []).length]);
  if (node._key === key) return;
  node._key = key;
  node.dataset.status = status;
  node.querySelector(".tool-name").textContent = toolLabel(tool);
  const pill = node.querySelector(".tool-status");
  let pillText = toolStatus(status);
  if (tool.permission === "auto" && status !== "denied") pillText += " · auto";
  pill.textContent = pillText;
  pill.dataset.s = status;
  node.querySelector(".tool-line").textContent = oneLine(tool);
  const body = node.querySelector(".tool-body");
  body.replaceChildren();
  if (tool.input) body.append(codeBlock(tool.kind === "execute" || tool.name === "run_terminal_command" ? "Command" : "Input", tool.input));
  if (tool.output) body.append(codeBlock(status === "denied" ? "Result" : "Output", tool.output));
  if (!tool.input && !tool.output && !tool.images?.length) {
    const none = document.createElement("p");
    none.className = "tool-desc";
    none.textContent = tool.title || "No details yet.";
    body.append(none);
  }
  body._shots = undefined;
  renderShots(body, tool.images);
  if (tool.images && tool.images.length && node.dataset.shotOpen !== "1") {
    details.open = true;
    node.dataset.shotOpen = "1";
  }
  renderPermission(node, tool);
}

function renderPermission(node, tool) {
  const perm = node.querySelector(".perm");
  const waiting = tool.waiting;
  if (!waiting) {
    perm.hidden = true;
    perm.replaceChildren();
    node.classList.remove("asking");
    return;
  }
  node.classList.add("asking");
  perm.hidden = false;
  perm.replaceChildren();
  const title = document.createElement("div");
  title.className = "perm-title";
  title.textContent = (waiting.kind === "execute" ? "Run this command?" : waiting.kind === "edit" ? "Make this edit?" : "Allow this?");
  perm.append(title);
  if (waiting.description) {
    const desc = document.createElement("p");
    desc.className = "perm-desc";
    desc.textContent = waiting.description;
    perm.append(desc);
  }
  const pre = document.createElement("pre");
  pre.className = "tool-pre perm-pre";
  pre.textContent = waiting.detail || tool.input || waiting.title || "";
  perm.append(pre);
  const row = document.createElement("div");
  row.className = "perm-actions";
  const answer = async (decision, el) => {
    for (const b of row.querySelectorAll("button")) b.disabled = true;
    el.textContent = decision === "deny" ? "Denying" : "Approving";
    try {
      await api("/api/sessions/" + app.sessionId + "/permission", {
        method: "POST",
        body: JSON.stringify({ reqId: waiting.reqId, decision }),
      });
      if (decision === "auto" && app.session) {
        app.session.autoApprove = ["all"];
        paintAuto();
      }
    } catch (error) {
      if (error.status === 409) {
        row.replaceChildren();
        const done = document.createElement("p");
        done.className = "perm-note";
        done.textContent = "Already answered on another device.";
        row.append(done);
        return;
      }
      for (const b of row.querySelectorAll("button")) b.disabled = false;
      el.textContent = decision === "deny" ? "Deny" : decision === "auto" ? "Auto approve" : "Approve once";
      if (!error.auth) setNotice(error.message);
    }
  };
  const deny = button("Deny", (event) => answer("deny", event.currentTarget), "deny");
  const auto = button("Auto approve", (event) => answer("auto", event.currentTarget), "auto");
  const once = button("Approve once", (event) => answer("once", event.currentTarget), "primary");
  row.append(deny, auto, once);
  perm.append(row);
  const note = document.createElement("p");
  note.className = "perm-note";
  note.textContent = "Auto approve allows this and every later request in this session, including subagents. Turn it off from the + menu.";
  perm.append(note);
}

function updateMessage(node, message) {
  if (message.role === "planreview") {
    paintPlanCard(node, message);
    return;
  }
  if (message.role === "user") {
    node._raw = message.text || "";
    const text = node.querySelector(".msg-text");
    if (text && text.textContent !== (message.text || "")) text.textContent = message.text || "";
    renderShots(node, message.images);
    return;
  }
  if (message.role === "assistant") {
    node._raw = message.text || "";
    if (node._text !== message.text) {
      node.querySelector(".body").innerHTML = renderMarkdown(message.text || "");
      node._text = message.text;
    }
    renderShots(node, message.images);
    return;
  }
  if (message.role === "thought" || message.role === "plan" || message.role === "note") {
    const summary = node.querySelector("summary");
    const label = message.role === "thought" ? "Thinking" : message.role === "note" ? "System note" : "Plan";
    if (summary.textContent !== label) summary.textContent = label;
    const body = node.querySelector(".step-body");
    let pre = body.querySelector(".step-text");
    if (!pre) {
      pre = document.createElement("div");
      pre.className = "step-text";
      body.prepend(pre);
    }
    if (pre.textContent !== (message.text || "")) pre.textContent = message.text || "";
    renderShots(body, message.images);
    return;
  }
  if (message.role === "tool") {
    renderTool(node, message.tool || {});
    return;
  }
  if (node.textContent !== (message.text || "")) node.textContent = message.text || "";
}

function setMessages(messages) {
  app.streamState = {
    messages: messages.map((message) => ({ ...message, tool: message.tool ? { ...message.tool } : undefined })),
    n: messages.length,
  };
  for (const node of [...main.querySelectorAll("[data-mid]")]) node.remove();
  syncDom();
  if (app.stick) requestAnimationFrame(() => scrollToEnd("auto"));
  refreshJump();
}

function refreshJump() {
  jump.hidden = composer.hidden || nearBottom();
}

function onStreamEvent(ev) {
  app.lastStreamAt = Date.now();
  if (ev && ev.type === "ping") return;
  if (!ev || ev.type === "idle") {
    closeStream();
    if (app.running) reloadSettled();
    return;
  }
  if (ev.type === "permission_resolved" && ev.decision === "auto" && app.session) {
    app.session.autoApprove = ["all"];
    paintAuto();
    paintAutoSettings();
  }
  if (ev.type === "longrun") paintLongRun(ev.run);
  if (ev.type === "queue") {
    app.queue = ev.items || [];
    paintQueue();
    return;
  }
  if (ev.type === "title" && app.session && !app.session.title) {
    app.session.title = ev.title;
    headerForChat();
  }
  if (ev.type === "permission" && document.visibilityState === "visible") {
    navigator.vibrate?.(30);
  }
  if (ev.type === "settled") {
    app.justDone = app.streamState.stopReason === "end_turn";
    setRunning(false);
    reloadSettled();
    return;
  }
  const stick = app.stick || nearBottom();
  applyEvent(app.streamState, ev);
  syncDom();
  paintWaiting();
  if (ev.type === "end") setRunning(false);
  if (stick) {
    app.stick = true;
    requestAnimationFrame(() => {
      scrollToEnd("auto");
      refreshJump();
    });
  } else refreshJump();
  setNotice("");
}

function connectStream(cursor) {
  closeStream();
  if (!app.sessionId) return;
  app.quietClose = false;
  const es = new EventSource("/api/sessions/" + app.sessionId + "/stream?after=" + (cursor || 0));
  app.es = es;
  app.lastStreamAt = Date.now();
  es.onmessage = (event) => {
    try {
      onStreamEvent(JSON.parse(event.data));
    } catch {
      // Ignore a bad frame.
    }
  };
  es.onopen = () => {
    if (notice.textContent === "Reconnecting") setNotice("");
  };
  es.onerror = () => {
    if (app.quietClose) return;
    if (app.running) setNotice("Reconnecting");
    if (es.readyState === EventSource.CLOSED) {
      app.es = null;
      setTimeout(() => {
        if (app.sessionId && !app.es && route().name === "chat") renderRoute();
      }, 2000);
    }
  };
}

async function reloadSettled() {
  const id = app.sessionId;
  if (!id) return;
  try {
    const data = await api("/api/sessions/" + id);
    if (app.sessionId !== id) return;
    app.session = data.session;
    app.queue = data.queue || [];
  app.loops = data.loops || [];
    app.loops = data.loops || [];
    paintQueue();
    paintLongRun(data.longRun);
    paintSkeptic(data.skeptic);
    app.stick = true;
    setMessages(data.messages || []);
    setRunning(!!data.running);
    if (data.running) {
      connectStream(data.cursor || 0);
      return;
    }
    if (app.queue.length && (app.queueWaits = (app.queueWaits || 0) + 1) < 15) {
      setTimeout(() => app.sessionId === id && reloadSettled(), 1200);
    } else app.queueWaits = 0;
    setBanner(data.session && data.session.permissionMode);
    headerForChat();
    closeStream();
    paintAuto();
    paintWaiting();
    setNotice("");
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

async function loadDirs() {
  const data = await api("/api/dirs");
  app.dirs = data.dirs || [];
  app.home = data.home || "";
  app.defaultDir = data.defaultDir || app.home;
  if (!app.draft.cwd) app.draft.cwd = app.defaultDir || app.dirs[0] || "";
}

function openPicker(start, onSelect) {
  const overlay = document.createElement("div");
  overlay.className = "picker";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Choose a folder");
  const head = document.createElement("div");
  head.className = "picker-head";
  const title = document.createElement("div");
  title.className = "picker-path";
  const close = button("Cancel", () => overlay.remove());
  head.append(close, title);
  const list = document.createElement("div");
  list.className = "picker-list";
  const foot = document.createElement("div");
  foot.className = "picker-foot";
  const hiddenWrap = document.createElement("label");
  hiddenWrap.className = "picker-hidden";
  const hidden = document.createElement("input");
  hidden.type = "checkbox";
  hiddenWrap.append(hidden, document.createTextNode(" Show hidden"));
  const up = button("Up", () => state.parent && load(state.parent));
  const pick = button("Select", () => {
    onSelect(state.path);
    overlay.remove();
  }, "primary");
  const make = button("New folder", async () => {
    const name = (prompt("New folder name (inside " + shortPath(state.path) + ")") || "").trim();
    if (!name) return;
    try {
      const made = await api("/api/mkdir", { method: "POST", body: JSON.stringify({ parent: state.path, name, hidden: hidden.checked }) });
      setNotice(made.created ? "Created " + shortPath(made.path) : "Folder already existed, opened it");
      await load(made.path);
    } catch (error) {
      if (!error.auth) alert(error.message);
    }
  });
  head.append(make);
  foot.append(hiddenWrap, up, pick);
  overlay.append(head, list, foot);
  document.body.append(overlay);
  const state = { path: "", parent: null };
  const row = (label, dir, extra, cls) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "picker-row" + (cls ? " " + cls : "");
    const name = document.createElement("span");
    name.className = "picker-name";
    name.textContent = label;
    el.append(name);
    if (extra) {
      const tag = document.createElement("span");
      tag.className = "picker-tag";
      tag.textContent = extra;
      el.append(tag);
    }
    el.addEventListener("click", () => load(dir));
    return el;
  };
  const load = async (dir) => {
    list.classList.add("loading");
    try {
      const data = await api("/api/browse?path=" + encodeURIComponent(dir || "") + (hidden.checked ? "&hidden=1" : ""));
      state.path = data.path;
      state.parent = data.parent;
      title.textContent = shortPath(data.path) + (data.git ? "  · git" : "");
      title.title = data.path;
      up.disabled = !data.parent;
      list.replaceChildren();
      const recent = (app.dirs || []).filter((d) => d !== data.path && (d === data.home || d.startsWith(data.home + "/"))).slice(0, 5);
      if (recent.length) {
        const cap = document.createElement("div");
        cap.className = "picker-cap";
        cap.textContent = "Recent";
        list.append(cap, ...recent.map((d) => row(shortPath(d), d, "", "recent")));
        const cap2 = document.createElement("div");
        cap2.className = "picker-cap";
        cap2.textContent = "In this folder";
        list.append(cap2);
      }
      if (!data.entries.length) {
        const none = document.createElement("p");
        none.className = "picker-empty";
        none.textContent = "No subfolders.";
        list.append(none);
      }
      for (const entry of data.entries) list.append(row(entry.name, entry.path, entry.git ? "git" : ""));
      list.scrollTop = 0;
    } catch (error) {
      if (!error.auth) setNotice(error.message);
      if (!state.path && dir !== app.home) load(app.home);
    } finally {
      list.classList.remove("loading");
    }
  };
  hidden.addEventListener("change", () => load(state.path));
  load(start || app.defaultDir || app.home);
}

function prefsBlock(prefs, onChange, { cwdEditable }) {
  const box = document.createElement("div");
  const cwd = document.createElement("input");
  cwd.value = prefs.cwd || "";
  cwd.spellcheck = false;
  cwd.autocapitalize = "off";
  cwd.placeholder = "/home/you/Projects";
  cwd.readOnly = !cwdEditable;
  const modelOptions = app.models.map((model) => [model, model]);
  if (prefs.model && !app.models.includes(prefs.model)) modelOptions.unshift([prefs.model, prefs.model]);
  const model = select(modelOptions, prefs.model || "grok-4.7");
  const effort = select(EFFORTS, prefs.effort || "high");
  const mode = select(MODES, prefs.permissionMode || "default");
  const ultraWrap = document.createElement("label");
  ultraWrap.className = "switch";
  const ultra = document.createElement("input");
  ultra.type = "checkbox";
  ultra.checked = !!prefs.ultra;
  const ultraText = document.createElement("span");
  ultraText.innerHTML = "<b>Ultra code</b><small>Routes work through pstack's poteto-mode: plan, build, verify, review, unslop. Uses Extra high effort and keeps going until done. Slower and costs more.</small>";
  ultraWrap.append(ultra, ultraText);
  const planWrap = document.createElement("label");
  planWrap.className = "switch plan-switch";
  const planBox = document.createElement("input");
  planBox.type = "checkbox";
  planBox.checked = !!prefs.plan;
  const planText = document.createElement("span");
  planText.innerHTML = "<b>Plan mode</b><small>Grok reads and plans but changes nothing. You approve the plan before it starts work.</small>";
  planWrap.append(planBox, planText);
  const longWrap = document.createElement("label");
  longWrap.className = "switch long-switch";
  const longBox = document.createElement("input");
  longBox.type = "checkbox";
  longBox.checked = !!prefs.longRun;
  const longText = document.createElement("span");
  longText.innerHTML = "<b>Long run</b><small>Autonomous goal loop for hours: Grok keeps GOAL.md and PROGRESS.md, commits local checkpoints, and is resumed automatically until the goal is verified or the time budget ends. Approvals still apply.</small>";
  const longHours = document.createElement("input");
  longHours.type = "number";
  longHours.min = "0.5";
  longHours.max = "48";
  longHours.step = "0.5";
  longHours.value = String(prefs.longHours || 12);
  longHours.className = "long-hours";
  longHours.setAttribute("aria-label", "Long run hours");
  longWrap.append(longBox, longText);
  const note = document.createElement("p");
  note.className = "mode-note";
  const paintNote = () => {
    note.textContent = MODE_HINT[mode.value] || "";
    note.classList.toggle("warn", mode.value === "bypassPermissions");
  };
  paintNote();
  const emit = () => {
    onChange({
      cwd: cwd.value.trim(),
      model: model.value,
      effort: effort.value,
      permissionMode: mode.value,
      ultra: ultra.checked,
      plan: planBox.checked,
      longRun: longBox.checked,
      longHours: Number(longHours.value) || 12,
    });
    paintNote();
    setBanner(mode.value);
  };
  for (const el of [cwd, model, effort, mode, ultra, planBox, longBox, longHours]) el.addEventListener("change", emit);
  cwd.addEventListener("input", emit);
  if (cwdEditable) {
    const row = document.createElement("div");
    row.className = "cwd-row";
    const browse = button("Browse", () => openPicker(cwd.value.trim(), (dir) => {
      cwd.value = dir;
      emit();
    }), "browse");
    browse.setAttribute("aria-label", "Browse folders");
    row.append(cwd, browse);
    box.append(field("Directory", row));
  } else box.append(field("Directory", cwd));
  if (cwdEditable && app.dirs.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const dir of app.dirs) {
      const chip = button(shortPath(dir), () => {
        cwd.value = dir;
        emit();
      });
      chip.title = dir;
      chips.append(chip);
    }
    box.append(chips);
  }
  box.append(field("Model", model), field("Effort", effort), field("Permission", mode), note, planWrap, ultraWrap);
  if (cwdEditable) {
    const hoursRow = document.createElement("div");
    hoursRow.className = "long-row";
    hoursRow.append(longWrap, field("Hours", longHours));
    box.append(hoursRow);
  }
  const apply = document.createElement("p");
  apply.className = "mode-note";
  apply.textContent = "Changes apply from the next message.";
  box.append(apply);
  return box;
}

async function renderList(token) {
  paintLongRun(null);
  noteRoute("list");
  closeStream();
  app.sessionId = null;
  composer.hidden = true;
  jump.hidden = true;
  setBanner("");
  setNotice("");
  setRunning(false);
  app.session = null;
  app.queue = [];
  closeWatch();
  closeSettings();
  setsheet.replaceChildren();
  paintQueue();
  paintAuto();
  paintWaiting();
  header("Sessions", {});
  applyCurrentTheme();
  main.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading sessions";
  main.append(loading);
  let data;
  try {
    data = await api("/api/sessions");
    await loadDirs();
  } catch (error) {
    if (error.auth || token !== app.gen) return;
    loading.textContent = error.message;
    return;
  }
  if (token !== app.gen) return;
  app.sessions = data.sessions || [];
  main.replaceChildren();
  const wrap = document.createElement("div");
  wrap.className = "screen";
  let showArchived = false;
  const fresh = button("New session", () => go("/new"), "primary wide");
  wrap.append(fresh);
  const filter = document.createElement("input");
  filter.className = "filter";
  filter.placeholder = "Filter";
  filter.setAttribute("aria-label", "Filter sessions");
  wrap.append(filter);
  const list = document.createElement("div");
  const draw = () => {
    list.replaceChildren();
    const query = filter.value.trim().toLowerCase();
    const all = data.sessions || [];
    const rows = all.filter((session) => {
      if (!!session.archived !== showArchived) return false;
      if (!query) return true;
      return (session.title + " " + session.cwd + " " + session.model).toLowerCase().includes(query);
    });
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = showArchived ? "No archived sessions." : all.length ? "No matches." : "No sessions yet.";
      list.append(empty);
      list.append(archToggle(all));
      return;
    }
    for (const session of rows) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "row";
      const swatch = themeById(session.theme || app.globalTheme || "purple");
      if (swatch) row.style.setProperty("--row-accent", swatch.vars["--accent"]);
      const title = document.createElement("span");
      title.className = "row-title";
      title.textContent = session.title || "New session";
      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = [shortPath(session.cwd), relTime(session.updatedAt), session.model].filter(Boolean).join(" · ");
      row.append(title, meta);
      const badges = document.createElement("span");
      badges.className = "badges";
      if (session.running) {
        const badge = document.createElement("span");
        badge.className = "badge run";
        badge.textContent = "Running";
        badges.append(badge);
      }
      if (session.waiting) {
        const badge = document.createElement("span");
        badge.className = "badge wait";
        badge.textContent = "Needs approval";
        badges.append(badge);
      }
      if (session.ultra) {
        const badge = document.createElement("span");
        badge.className = "badge ultra";
        badge.textContent = "Ultra";
        badges.append(badge);
      }
      if (badges.childElementCount) row.append(badges);
      if (session.permissionMode === "bypassPermissions") {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "Always approve";
        row.append(badge);
      }
      row.addEventListener("click", () => go("/s/" + session.id));
      list.append(row);
    }
    list.append(archToggle(all));
  };
  const archToggle = (all) => {
    const count = all.filter((session) => session.archived).length;
    if (!count && !showArchived) return document.createTextNode("");
    return button(showArchived ? "Back to sessions" : "Archived (" + count + ")", () => {
      showArchived = !showArchived;
      draw();
    }, "linkish");
  };
  filter.addEventListener("input", draw);
  draw();
  wrap.append(list);
  const appSettings = document.createElement("details");
  appSettings.className = "step settings app-settings";
  const appSum = document.createElement("summary");
  appSum.textContent = "App settings";
  appSettings.append(appSum, themeField(), skepticDefaultsBlock(), notifyBlock(), button("Log out", logout, "wide"));
  wrap.append(appSettings);
  main.append(wrap);
}

async function renderNew(token) {
  paintLongRun(null);
  paintSkeptic(null);
  noteRoute("new");
  closeStream();
  app.sessionId = null;
  app.session = null;
  app.queue = [];
  closeWatch();
  closeSettings();
  setsheet.replaceChildren();
  paintQueue();
  setRunning(false);
  setNotice("");
  composer.hidden = false;
  jump.hidden = true;
  paintAuto();
  paintWaiting();
  header("New session", isDesktop() ? {} : { left: [backButton()] });
  planBadge();
  try {
    await loadDirs();
  } catch (error) {
    if (error.auth || token !== app.gen) return;
    setNotice(error.message);
  }
  if (token !== app.gen) return;
  if (!app.sessions) app.sessions = (await api("/api/sessions").catch(() => ({ sessions: [] }))).sessions || [];
  if (!app.draft.theme) app.draft.theme = freshThemeId();
  applyCurrentTheme();
  main.replaceChildren();
  const screen = document.createElement("section");
  screen.className = "screen";
  const intro = document.createElement("p");
  intro.className = "sub";
  intro.textContent = "Send a message to start. Grok asks before running commands or editing files.";
  screen.append(intro);
  screen.append(
    prefsBlock(app.draft, (next) => {
      app.draft = { ...next, theme: app.draft.theme };
      headerNewBadge();
    }, { cwdEditable: true })
  );
  const themeWrap = document.createElement("div");
  themeWrap.className = "field";
  themeWrap.append(document.createTextNode("Theme"));
  themeWrap.append(themePicker(app.draft.theme, (id) => {
    app.draft.theme = id;
    applyCurrentTheme();
  }));
  screen.append(themeWrap);
  main.append(screen);
  setBanner(app.draft.permissionMode);
  growInput();
  input.focus();
}

function headerForChat() {
  const title = (app.session && app.session.title) || "New session";
  // Desktop already has the sessions sidebar, so skip the back arrow there.
  header(title, isDesktop() ? {} : { left: [backButton()] });
  planBadge();
  if (app.sessionId) paintContext(app.sessionId);
}

function subTier(type, name) {
  const t = String(type || "");
  const n = String(name || "");
  if (/(^|:)ultra-|^grok-mobile-ultra:/.test(t) || /^ultra\b/i.test(n)) return "ultra";
  if (/(^|:)strong$/.test(t) || /^strong\b/i.test(n)) return "strong";
  return "default";
}

function kTokens(n) {
  return n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
}

function contextPill(ctx) {
  const pill = document.createElement("span");
  const pct = ctx.used / ctx.window;
  pill.className = "ctx" + (pct >= 0.9 ? " hot" : pct >= 0.75 ? " warm" : "");
  pill.textContent = kTokens(ctx.used) + " / " + kTokens(ctx.window);
  pill.title = "Context used: " + Math.round(pct * 100) + "%";
  return pill;
}

async function paintContext(id) {
  try {
    const u = await api("/api/sessions/" + id + "/usage");
    if (app.sessionId !== id || !u.context) return;
    top.querySelector(".ctx")?.remove();
    top.querySelector("h1")?.after(contextPill(u.context));
  } catch {
    // Header pill is optional.
  }
}

function planBadge() {
  if (!planOn()) return;
  const badge = document.createElement("span");
  badge.className = "badge plan";
  badge.textContent = "Plan";
  top.querySelector("h1")?.after(badge);
}

function backButton() {
  const el = button("‹", () => go("/"), "back");
  el.setAttribute("aria-label", "Back to sessions");
  return el;
}

async function renderChat(token, id) {
  paintLongRun(null);
  if (app.sessionId !== id) app.justDone = false;
  noteRoute("chat:" + id);
  closeStream();
  app.sessionId = id;
  setImageSession(id);
  setNotice("");
  composer.hidden = false;
  main.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading";
  main.append(loading);
  let data;
  try {
    data = await api("/api/sessions/" + id);
  } catch (error) {
    if (error.auth || token !== app.gen) return;
    loading.textContent = error.message;
    composer.hidden = true;
    return;
  }
  if (token !== app.gen) return;
  app.session = data.session;
  app.queue = data.queue || [];
  paintLongRun(data.longRun);
  paintSkeptic(data.skeptic);
  loadSkepticDefaults();
  applyCurrentTheme();
  app.stick = true;
  setRunning(!!data.running);
  paintQueue();
  setBanner(data.session && data.session.permissionMode);
  headerForChat();
  main.replaceChildren();
  buildSettings(id, data.session);
  openWatch(id);
  paintAutoSettings();
  paintAuto();
  setMessages(data.messages || []);
  paintWaiting();
  if (data.running) connectStream(data.cursor || 0);
  growInput();
}

async function renderRoute() {
  const token = ++app.gen;
  closeSettings();
  const status = await fetch("/api/auth/status")
    .then((res) => res.json())
    .catch(() => null);
  if (token !== app.gen) return;
  if (!status) {
    main.replaceChildren();
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = "Can't reach Grok Deck.";
    const retry = button("Retry", () => renderRoute(), "primary");
    main.append(p, retry);
    return;
  }
  app.authed = !!status.authenticated;
  renderSide();
  if (!status.authenticated) {
    await showAuth();
    return;
  }
  const where = route();
  if (where.name === "new") return renderNew(token);
  if (where.name === "chat") return renderChat(token, where.id);
  return renderList(token);
}

async function logout() {
  try {
    await api("/api/auth/logout", { method: "POST", body: "{}" });
  } catch {
    // Still show the login screen.
  }
  closeStream();
  if (location.pathname !== "/") history.pushState({}, "", "/");
  renderRoute();
}

async function sendPrompt(prompt, images) {
  const where = route();
  const body = { prompt };
  if (images && images.length) body.images = images;
  if (where.name === "chat") {
    body.sessionId = where.id;
    if (app.session) {
      body.model = app.session.model;
      body.effort = app.session.effort;
      body.permissionMode = app.session.permissionMode;
      body.ultra = !!app.session.ultra;
    }
  } else {
    body.cwd = app.draft.cwd;
    body.model = app.draft.model;
    body.effort = app.draft.effort;
    body.permissionMode = app.draft.permissionMode;
    body.ultra = !!app.draft.ultra;
    body.plan = !!app.draft.plan;
    body.theme = app.draft.theme || "";
    if (app.draft.longRun) body.longRun = { hours: app.draft.longHours || 12 };
  }
  const result = await api("/api/turns", { method: "POST", body: JSON.stringify(body) });
  app.stick = true;
  if (where.name !== "chat") {
    app.sessions = [...(app.sessions || []), { id: result.sessionId, theme: app.draft.theme, running: true }];
    app.draft.theme = "";
  }
  if (location.pathname !== "/s/" + result.sessionId) {
    history.pushState({}, "", "/s/" + result.sessionId);
  }
  await renderChat(++app.gen, result.sessionId);
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (app.sending) return;
  const prompt = input.value.trim();
  const images = app.images.map((image) => ({ mime: image.mime, data: image.data }));
  if (/^\/loops?(\s|$)/i.test(prompt) && !images.length) {
    app.sending = true;
    try {
      await sendLoopCommand(prompt);
    } catch (error) {
      if (!error.auth) setNotice(error.message);
    } finally {
      app.sending = false;
    }
    return;
  }
  if (app.running && route().name === "chat") {
    // Desktop Enter / requestSubmit: queue as Send next. The button itself does Stop / Send now.
    if (!prompt && !images.length) return;
    app.sending = true;
    try {
      const body = { prompt, images, model: app.session?.model, effort: app.session?.effort, permissionMode: app.session?.permissionMode, ultra: !!app.session?.ultra };
      const saved = await api("/api/sessions/" + app.sessionId + "/queue", { method: "POST", body: JSON.stringify(body) });
      app.queue = saved.queue || [];
      input.value = "";
      clearImages();
      growInput();
      paintQueue();
    } catch (error) {
      if (!error.auth) setNotice(error.message);
    } finally {
      app.sending = false;
    }
    return;
  }
  if (!prompt && !images.length) {
    setNotice("Write a message or attach a photo.");
    return;
  }
  const where = route();
  if (where.name === "new" && !app.draft.cwd.trim()) {
    setNotice("Choose a directory.");
    return;
  }
  app.sending = true;
  sendBtn.disabled = true;
  const missing = document.getElementById("missing-dir");
  if (missing) missing.remove();
  try {
    await sendPrompt(prompt, images);
    input.value = "";
    clearImages();
    app.imageRoute = "chat:" + (route().id || "");
    growInput();
  } catch (error) {
    if (!error.auth && where.name === "new" && /does not exist/i.test(error.message)) showMissingDir(app.draft.cwd.trim());
    else if (!error.auth) setNotice(error.message);
  } finally {
    app.sending = false;
    sendBtn.disabled = false;
  }
});

function showMissingDir(dir) {
  setNotice("");
  const box = document.createElement("div");
  box.id = "missing-dir";
  box.className = "missing-dir";
  const text = document.createElement("p");
  text.innerHTML = "<b>Folder doesn't exist</b>";
  const where = document.createElement("code");
  where.textContent = dir;
  const row = document.createElement("div");
  row.className = "perm-actions";
  const cancel = button("Cancel", () => box.remove());
  const go = button("Create and start", async (event) => {
    const el = event.currentTarget;
    el.disabled = true;
    el.textContent = "Creating";
    try {
      const made = await api("/api/mkdir", { method: "POST", body: JSON.stringify({ path: dir }) });
      app.draft.cwd = made.path;
      const field = document.querySelector(".cwd-row input");
      if (field) field.value = made.path;
      box.remove();
      composer.requestSubmit();
    } catch (error) {
      el.disabled = false;
      el.textContent = "Create and start";
      if (!error.auth) setNotice(error.message);
    }
  }, "primary");
  row.append(cancel, go);
  box.append(text, where, row);
  const screen = main.querySelector(".screen") || main;
  screen.prepend(box);
  box.scrollIntoView({ block: "nearest" });
}

// Plan mode: Grok's plan arrives as a card with Approve plan / Revise.
function paintPlanCard(node, message) {
  const key = message.status + "|" + message.plan.length + "|" + app.running;
  if (node._key === key) return;
  node._key = key;
  const waiting = message.status === "waiting";
  node.classList.toggle("asking", waiting && app.running);
  node.replaceChildren();
  const head = document.createElement("div");
  head.className = "plan-head";
  head.textContent = message.status === "history" ? "Plan" : waiting ? (app.running ? "Plan ready for review" : "Plan (not answered)") : message.status === "approved" ? "Plan approved, carrying it out" : "Plan sent back for revision";
  const body = document.createElement("div");
  body.className = "plan-body md";
  body.innerHTML = renderMarkdown(message.plan || "(empty plan)");
  node.append(head, body);
  if (!waiting || !app.running) return;
  const row = document.createElement("div");
  row.className = "perm-actions";
  const answer = async (decision, el) => {
    for (const b of row.querySelectorAll("button")) b.disabled = true;
    el.textContent = decision === "approve" ? "Approving" : "Revise";
    try {
      await api("/api/sessions/" + app.sessionId + "/plan", { method: "POST", body: JSON.stringify({ reqId: message.reqId, decision }) });
      if (decision === "approve" && app.session) {
        app.session.plan = false;
        headerForChat();
      }
      if (decision === "revise") {
        input.focus();
        if (!input.value) input.placeholder = "What should change in the plan?";
      }
    } catch (error) {
      if (error.status === 409) {
        row.replaceChildren();
        const done = document.createElement("p");
        done.className = "perm-note";
        done.textContent = "Already answered on another device.";
        row.append(done);
        return;
      }
      for (const b of row.querySelectorAll("button")) b.disabled = false;
      el.textContent = decision === "approve" ? "Approve plan" : "Revise";
      if (!error.auth) setNotice(error.message);
    }
  };
  row.append(
    button("Revise", (event) => answer("revise", event.currentTarget), "revise"),
    button("Approve plan", (event) => answer("approve", event.currentTarget), "primary")
  );
  const note = document.createElement("p");
  note.className = "perm-note";
  note.textContent = activeAuto().length ? "Approve switches off Plan mode and Grok carries out the plan. Auto approve stays on." : "Approve switches off Plan mode; Grok carries out the plan and asks before commands and edits.";
  node.append(row, note);
}

async function setPlan(on) {
  if (route().name !== "chat") {
    app.draft.plan = on;
    renderRoute();
    return;
  }
  try {
    const saved = await api("/api/sessions/" + app.sessionId, { method: "PATCH", body: JSON.stringify({ plan: on }) });
    app.session = saved.session;
    syncSettingsUi();
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

function headerNewBadge() {
  top.querySelector(".badge.plan")?.remove();
  planBadge();
}

function planOn() {
  return route().name === "chat" ? !!app.session?.plan : !!app.draft.plan;
}

// One action slot: Send (idle), Stop (running + empty), Send now (running + content).
// "Send next" stays on form submit / desktop Enter, not on this button.
function paintSend() {
  const chat = route().name === "chat";
  const hasContent = hasComposerContent(input.value, app.images.length);
  const { label, mode } = composerAction({ running: app.running, chat, hasContent });
  if (sendBtn.textContent !== label) sendBtn.textContent = label;
  sendBtn.classList.toggle("stop-mode", mode === "stop");
  sendBtn.classList.toggle("now-mode", mode === "now");
  sendBtn.classList.toggle("queue-mode", false);
  sendBtn.setAttribute("aria-label", label);
}

function paintQueue() {
  const box = document.getElementById("queue");
  const items = route().name === "chat" ? app.queue || [] : [];
  box.hidden = !items.length;
  box.replaceChildren();
  items.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "queued";
    const tag = document.createElement("span");
    tag.className = "q-tag";
    tag.textContent = item.now ? "Sending" : index === 0 ? "Next" : "#" + (index + 1);
    const text = document.createElement("span");
    text.className = "q-text";
    text.textContent = (item.text || "") + (item.images ? " · " + item.images + " photo" + (item.images > 1 ? "s" : "") : "");
    const now = button("Now", () => queueNow(item.id), "mini");
    const cancel = button("✕", () => queueCancel(item.id), "mini q-x");
    cancel.setAttribute("aria-label", "Cancel queued message");
    row.append(tag, text, now, cancel);
    box.append(row);
  });
  paintSend();
}

async function queueNow(qid) {
  try {
    const saved = await api("/api/sessions/" + app.sessionId + "/queue/" + qid + "/now", { method: "POST", body: "{}" });
    app.queue = saved.queue || [];
    paintQueue();
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

async function queueCancel(qid) {
  try {
    const saved = await api("/api/sessions/" + app.sessionId + "/queue/" + qid, { method: "DELETE", body: "{}" });
    app.queue = saved.queue || [];
    paintQueue();
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

// Usage for this session: tokens and time.
async function loadUsage(id) {
  const box = document.getElementById("usage");
  if (!box) return;
  try {
    const u = await api("/api/sessions/" + id + "/usage");
    const parts = [
      ["Tokens", u.tokens ? tokensText(u.tokens).replace(" tokens", "") : "0"],
      ["Subagents", u.subagentTokens ? tokensText(u.subagentTokens).replace(" tokens", "") : "0"],
      ["Time", u.ms ? durationText(u.ms) : "0s"],
      ["Turns", String(u.turns || 0)],
    ];
    parts.push(["Escalations", String(u.escalations || 0)]);
    if (u.skeptic?.reviews) parts.push(["Skeptic", u.skeptic.reviews + " · " + kTokens(u.skeptic.tokens)]);
    const skUsage = document.getElementById("skeptic-usage");
    if (skUsage) skUsage.textContent = u.skeptic?.reviews ? "This session: " + u.skeptic.reviews + " review" + (u.skeptic.reviews === 1 ? "" : "s") + ", " + kTokens(u.skeptic.tokens) + " tokens" + (u.skeptic.costUsd ? ", about $" + u.skeptic.costUsd.toFixed(2) : "") + "." : "";
    if (u.context) parts.push(["Context", kTokens(u.context.used) + " / " + kTokens(u.context.window)]);
    box.replaceChildren();
    const label = document.createElement("div");
    label.className = "field-label";
    label.textContent = "Usage";
    const grid = document.createElement("div");
    grid.className = "usage-grid";
    for (const [k, v] of parts) {
      const cell = document.createElement("div");
      cell.innerHTML = "<b></b><small></small>";
      cell.querySelector("b").textContent = v;
      cell.querySelector("small").textContent = k;
      grid.append(cell);
    }
    box.append(label, grid);
  } catch (error) {
    if (!error.auth) box.textContent = "Usage unavailable.";
  }
}

function sessionActions(id) {
  const row = document.createElement("div");
  row.className = "session-actions";
  const archived = !!app.session?.archived;
  row.append(
    button(archived ? "Unarchive" : "Archive", () => archiveSession(id, !archived)),
    button("Delete", () => confirmDelete(id), "danger")
  );
  return row;
}

async function archiveSession(id, on) {
  try {
    await api("/api/sessions/" + id, { method: "PATCH", body: JSON.stringify({ archived: on }) });
    closeSheet();
    go("/");
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

function confirmDelete(id) {
  const title = (app.session && app.session.title) || "this session";
  openSheet([
    { text: "Delete “" + title + "”? It moves to Grok Deck's trash and disappears from the list.", info: true },
    { label: "Delete session", danger: true, run: async () => {
      try {
        await api("/api/sessions/" + id, { method: "DELETE", body: "{}" });
        closeSheet();
        go("/");
      } catch (error) {
        closeSheet();
        if (!error.auth) setNotice(error.message);
      }
    } },
    { label: "Cancel", run: () => closeSheet() },
  ]);
}

// Notifications (Web Push). iOS only allows them from the Home Screen app over HTTPS.
function pushState() {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (!window.isSecureContext) return { ok: false, why: "Notifications need the HTTPS address. Open " + (app.httpsUrl || "the https:// tailnet address") + ", then add it to your Home Screen." };
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, why: /iPhone|iPad/.test(navigator.userAgent) && !standalone ? "On iPhone: tap Share, then Add to Home Screen, open Grok from there and enable notifications." : "This browser doesn't support push notifications." };
  }
  return { ok: true, perm: Notification.permission };
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

async function enableNotifications() {
  const st = pushState();
  if (!st.ok) {
    setNotice(st.why);
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") {
    setNotice("Notifications are blocked. Allow them in Settings for Grok.");
    return false;
  }
  try {
    const { publicKey } = await api("/api/push/key");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)) });
    await api("/api/push/subscribe", { method: "POST", body: JSON.stringify({ subscription: sub.toJSON(), label: navigator.userAgent.slice(0, 80) }) });
    await api("/api/push/test", { method: "POST", body: "{}" });
    setNotice("Notifications on. You'll hear when a job finishes, needs approval or fails.");
    return true;
  } catch (error) {
    if (!error.auth) setNotice("Couldn't turn on notifications: " + error.message);
    return false;
  }
}

async function disableNotifications() {
  try {
    const sub = await currentSubscription();
    if (sub) {
      await api("/api/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    setNotice("Notifications off on this device.");
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

async function notifyItem() {
  const st = pushState();
  if (!st.ok) return { label: "Enable notifications", run: () => { closeSheet(); setNotice(st.why); } };
  let sub = null;
  try {
    if (st.perm === "granted") sub = await Promise.race([currentSubscription(), new Promise((r) => setTimeout(() => r(null), 800))]);
  } catch {
    sub = null;
  }
  if (sub) return { label: "Notifications on · Turn off", run: () => { closeSheet(); disableNotifications(); } };
  return { label: "Enable notifications", run: () => { closeSheet(); enableNotifications(); } };
}

function notifyBlock() {
  const box = document.createElement("div");
  box.className = "notify-block";
  notifyItem().then((item) => box.append(button(item.label, item.run, "wide")));
  return box;
}

// The + menu: everything that used to live in bars at the top.
const sheet = document.getElementById("sheet");
const sheetPanel = sheet.querySelector(".sheet-panel");

function closeSheet() {
  sheet.hidden = true;
  sheetPanel.replaceChildren();
}

sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});

async function menuItems() {
  const chat = route().name === "chat";
  const items = [{ label: "Add photo", run: () => { closeSheet(); photos.click(); } }];
  if (route().name === "chat" || route().name === "new") {
    items.push({ label: planOn() ? "Plan mode on · Turn off" : "Plan mode (read and plan only)", accent: planOn(), run: () => { closeSheet(); setPlan(!planOn()); } });
  }
  if (chat) {
    const waiting = main.querySelector(".toolcard.asking");
    if (waiting && app.running) items.unshift({ label: "Go to approval", accent: true, run: () => { closeSheet(); waiting.scrollIntoView({ block: "center", behavior: "smooth" }); } });
    const lr = app.longRun;
    if (lr && lr.status === "running") items.push({ label: "Long run on · Stop", accent: true, run: () => { closeSheet(); longRunAction("stop"); } });
    else if (lr) items.push({ label: "Resume long run", run: () => { closeSheet(); longRunAction("resume"); } });
    else items.push({ label: "Start long run…", run: () => { closeSheet(); startLongRun(); } });
    items.push(skepticMenuRow());
    const activeLoops = (app.loops || []).filter((l) => l.status === "active");
    items.push({ label: (app.loops || []).length ? "Loops · " + activeLoops.length + " active" : "Loops…", accent: activeLoops.length > 0, run: () => openLoops() });
    if (activeAuto().length) items.push({ label: "Auto approve on · Turn off", accent: true, run: () => { closeSheet(); setAuto([]); } });
    if (app.bypass) items.push({ text: "Always approve is on for this session. Change it in Session settings.", info: true });
    items.push({ label: "Session settings", run: () => {
      closeSheet();
      openSettings();
    } });
  }
  items.push(await notifyItem());
  if (chat) {
    const archived = !!app.session?.archived;
    items.push({ label: archived ? "Unarchive session" : "Archive session", run: () => archiveSession(app.sessionId, !archived) });
    items.push({ label: "Delete session", danger: true, run: () => confirmDelete(app.sessionId) });
  }
  return items;
}

// Loops: "/loop 30m <prompt>" re-sends a prompt on a timer (server-side, see lib/loops.js).
function loopWhen(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const same = d.toDateString() === new Date().toDateString();
  return (same ? "" : d.toLocaleDateString([], { weekday: "short" }) + " ") + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function loopSummary(l) {
  const runs = l.maxRuns ? l.runs + " of " + l.maxRuns + " runs" : l.runs + " run" + (l.runs === 1 ? "" : "s");
  const state = l.status === "active" ? (l.pending ? "run waiting · " : "") + "next " + loopWhen(l.nextAt) : l.status === "paused" ? "paused" : "finished" + (l.note ? ": " + l.note : "");
  return "Every " + l.label + (l.untilDone ? " until DONE" : "") + " · " + runs + " · " + state + (l.lastError ? " · last error: " + l.lastError : "") + "\n" + l.prompt.slice(0, 160);
}

async function loopAction(lid, action) {
  try {
    const data = lid && action === "delete"
      ? await api("/api/sessions/" + app.sessionId + "/loops/" + lid, { method: "DELETE" })
      : await api("/api/sessions/" + app.sessionId + "/loops/" + lid, { method: "PATCH", body: JSON.stringify({ action }) });
    app.loops = data.loops || [];
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
  openLoops();
}

async function openLoops() {
  try {
    const data = await api("/api/sessions/" + app.sessionId + "/loops");
    app.loops = data.loops || [];
  } catch {
    // show what we have
  }
  const items = [];
  if (!app.loops.length) items.push({ text: "No loops. Type /loop 30m <prompt> to repeat a prompt every 30 minutes (5 min minimum). Add x10 for at most 10 runs, or \"until DONE\" to stop when the reply says DONE.", info: true });
  for (const l of app.loops) {
    items.push({ text: loopSummary(l), info: true });
    if (l.status === "active") items.push({ label: "Pause", run: () => loopAction(l.id, "pause") });
    else items.push({ label: "Resume", accent: true, run: () => loopAction(l.id, "resume") });
    items.push({ label: "Delete loop", danger: true, run: () => loopAction(l.id, "delete") });
  }
  items.push({ label: "Back", run: () => openSheet() });
  openSheet(items);
}

async function sendLoopCommand(text) {
  if (route().name !== "chat" || !app.sessionId) {
    setNotice("Loops run in an existing session. Send a first message, then use /loop.");
    return true;
  }
  const s = app.session || {};
  const data = await api("/api/sessions/" + app.sessionId + "/loops", { method: "POST", body: JSON.stringify({ command: text, opts: { model: s.model, effort: s.effort, permissionMode: s.permissionMode, ultra: !!s.ultra } }) });
  app.loops = data.loops || [];
  if (data.queue) {
    app.queue = data.queue;
    paintQueue();
  }
  input.value = "";
  growInput();
  paintSend();
  if (data.action === "list") openLoops();
  else if (data.action === "stop") setNotice(data.removed ? "Stopped " + data.removed + " loop" + (data.removed === 1 ? "" : "s") + "." : "No loops to stop.");
  else setNotice("Loop set: every " + data.loop.label + ". First run " + (app.running ? "queued after this turn." : "starting now."));
  return true;
}

async function openSheet(items) {
  const list = items || (await menuItems());
  sheetPanel.replaceChildren();
  for (const item of list) {
    if (item.info) {
      const p = document.createElement("p");
      p.className = "sheet-info";
      p.textContent = item.text;
      sheetPanel.append(p);
      continue;
    }
    const el = button(item.label, item.run, "sheet-item" + (item.danger ? " danger" : "") + (item.accent ? " accent" : ""));
    sheetPanel.append(el);
  }
  if (!items) sheetPanel.append(button("Close", () => closeSheet(), "sheet-item close"));
  sheet.hidden = false;
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!sheet.hidden) closeSheet();
  else closeSettings();
});

// Desktop keyboard: Enter sends, Shift+Enter newline. Mobile/touch keep Enter as newline.
// Detect a real keyboard + mouse, not viewport width (a phone in landscape is still a phone).
const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
function isFinePointerDesktop() {
  return finePointer.matches;
}

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  // IME composition: let the input method finish (isComposing, or keyCode 229).
  if (event.isComposing || event.keyCode === 229) return;
  const modSend = event.metaKey || event.ctrlKey;
  const desktopSend = isFinePointerDesktop() && !event.shiftKey;
  if (!modSend && !desktopSend) return;
  event.preventDefault();
  // Idle: Send. Running: Send next (queue). The Stop / Send now button is click-only.
  composer.requestSubmit();
});

input.addEventListener("input", () => {
  growInput();
  paintSend();
});

attachBtn.addEventListener("click", () => openSheet());

photos.addEventListener("change", () => {
  const files = [...(photos.files || [])];
  photos.value = "";
  addFiles(files);
});

document.addEventListener("paste", (event) => {
  if (composer.hidden) return;
  const items = [...(event.clipboardData?.items || [])];
  const images = items.filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"));
  if (!images.length) return;
  event.preventDefault();
  addFiles(images.map((item) => item.getAsFile()).filter(Boolean));
});

composer.addEventListener("dragover", (event) => {
  const items = [...(event.dataTransfer?.items || [])];
  if (items.some((item) => String(item.type || "").startsWith("image/"))) event.preventDefault();
});

composer.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files || [])].filter((file) => String(file.type || "").startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
});

async function stopTurn() {
  if (!app.sessionId) return;
  sendBtn.disabled = true;
  try {
    await api("/api/sessions/" + app.sessionId + "/cancel", { method: "POST", body: "{}" });
  } catch (error) {
    if (!error.auth && error.status !== 409) setNotice(error.message);
  } finally {
    sendBtn.disabled = false;
  }
}

async function sendNowFromComposer() {
  if (app.sending || !app.sessionId) return;
  const prompt = input.value.trim();
  const images = app.images.map((image) => ({ mime: image.mime, data: image.data }));
  if (!prompt && !images.length) return;
  if (/^\/loops?(\s|$)/i.test(prompt) && !images.length) {
    composer.requestSubmit(); // a /loop command never interrupts the running turn
    return;
  }
  app.sending = true;
  sendBtn.disabled = true;
  try {
    const body = {
      prompt,
      images,
      model: app.session?.model,
      effort: app.session?.effort,
      permissionMode: app.session?.permissionMode,
      ultra: !!app.session?.ultra,
    };
    const saved = await api("/api/sessions/" + app.sessionId + "/queue", { method: "POST", body: JSON.stringify(body) });
    app.queue = saved.queue || [];
    input.value = "";
    clearImages();
    growInput();
    if (saved.id) {
      const now = await api("/api/sessions/" + app.sessionId + "/queue/" + saved.id + "/now", { method: "POST", body: "{}" });
      app.queue = now.queue || [];
    }
    paintQueue();
  } catch (error) {
    if (!error.auth) setNotice(error.message);
    paintSend();
  } finally {
    app.sending = false;
    sendBtn.disabled = false;
  }
}

// Click: Stop or Send now while a turn runs. Idle Send and Send next (Enter) use form submit.
sendBtn.addEventListener("click", (event) => {
  if (!app.running || route().name !== "chat") return;
  event.preventDefault();
  if (!hasComposerContent(input.value, app.images.length)) stopTurn();
  else sendNowFromComposer();
});

main.addEventListener("scroll", () => {
  app.stick = nearBottom();
  jump.hidden = app.stick || composer.hidden;
});

jump.addEventListener("click", () => {
  app.stick = true;
  scrollToEnd("smooth");
  jump.hidden = true;
});

main.addEventListener("click", async (event) => {
  const copy = event.target.closest(".copy");
  if (!copy) return;
  const code = copy.parentElement.querySelector("code");
  if (!code) return;
  const ok = await copyText(code.textContent || "");
  flashCopied(copy);
  if (!ok) copy.textContent = "Copy failed";
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  refreshTheme();
  const where = route();
  if (where.name === "chat" && (!app.es || app.es.readyState !== EventSource.OPEN)) {
    renderRoute();
  } else if (where.name === "chat" && app.running && Date.now() - (app.lastStreamAt || 0) > 20000) {
    // A phone that slept can keep a dead socket "open": re-check the real state instead of showing a stale "running".
    reloadSettled();
  }
});

// The server sends a ping every 15 s while a turn runs. No frames for 45 s means the socket is dead even if it
// looks open, so reload the real state (which reconnects if the turn is still running, or shows it finished).
setInterval(() => {
  if (!app.running || !app.es || route().name !== "chat") return;
  if (Date.now() - (app.lastStreamAt || Date.now()) > 45000) {
    app.lastStreamAt = Date.now();
    reloadSettled();
  }
}, 10000);

window.addEventListener("popstate", () => renderRoute());
window.addEventListener("online", () => {
  if (route().name === "chat" && (!app.es || app.es.readyState !== EventSource.OPEN)) renderRoute();
});

const viewer = document.getElementById("viewer");
main.addEventListener("click", (event) => {
  const img = event.target.closest(".shots img");
  if (!img) return;
  viewer.querySelector("img").src = img.src;
  viewer.hidden = false;
});
viewer.addEventListener("click", () => {
  viewer.hidden = true;
  viewer.querySelector("img").removeAttribute("src");
});
window.visualViewport?.addEventListener("resize", handleViewport);
window.visualViewport?.addEventListener("scroll", handleViewport);
window.addEventListener("resize", handleViewport);
handleViewport();
growInput();
refreshTheme();
registerWorker();
renderRoute();
setInterval(refreshTheme, 15000);


// ---- Desktop: sessions sidebar, shortcuts, help overlay (only at 1024px and up) ----
const side = document.getElementById("side");
const keys = document.getElementById("keys");
const wide = matchMedia("(min-width: 1024px)");
let sideRows = [];
let sideArchived = false;

function isDesktop() {
  return wide.matches;
}

async function renderSide() {
  if (!isDesktop() || !app.authed) {
    side.hidden = true;
    return;
  }
  side.hidden = false;
  let data;
  try {
    const res = await fetch("/api/sessions", { credentials: "same-origin" });
    if (!res.ok) return;
    data = await res.json();
  } catch {
    return;
  }
  app.sessions = data.sessions || [];
  const current = route().id || "";
  const all = app.sessions;
  sideRows = all.filter((x) => !!x.archived === sideArchived);
  side.replaceChildren();
  const head = document.createElement("div");
  head.className = "side-head";
  const h = document.createElement("h2");
  h.textContent = "Grok Deck";
  const fresh = button("+ New", () => go("/new"), "primary side-new");
  fresh.title = "New session (Ctrl+N)";
  head.append(h, fresh);
  const list = document.createElement("nav");
  list.className = "side-list";
  for (const session of sideRows) {
    const row = document.createElement("a");
    row.href = "/s/" + session.id;
    row.className = "side-row" + (session.id === current ? " on" : "");
    row.addEventListener("click", (event) => {
      event.preventDefault();
      go("/s/" + session.id);
    });
    const dot = document.createElement("i");
    dot.className = "side-dot" + (session.running ? " run" : "") + (session.waiting ? " wait" : "");
    const theme = themeById(session.theme || app.globalTheme || "purple");
    if (theme) dot.style.background = theme.vars["--accent"];
    const title = document.createElement("span");
    title.className = "side-title";
    title.textContent = session.title || "New session";
    const meta = document.createElement("small");
    meta.textContent = session.waiting ? "Needs approval" : session.running ? "Running" : relTime(session.updatedAt);
    row.append(dot, title, meta);
    list.append(row);
  }
  if (!sideRows.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = sideArchived ? "No archived sessions." : "No sessions yet.";
    list.append(p);
  }
  const count = all.filter((x) => x.archived).length;
  const foot = document.createElement("div");
  foot.className = "side-foot";
  if (count || sideArchived) foot.append(button(sideArchived ? "Back to sessions" : "Archived (" + count + ")", () => { sideArchived = !sideArchived; renderSide(); }, "linkish"));
  foot.append(button("? Shortcuts", () => showKeys(), "linkish"));
  side.append(head, list, foot);
}

setInterval(() => {
  if (isDesktop() && document.visibilityState === "visible") renderSide();
}, 5000);
wide.addEventListener("change", () => {
  renderSide();
  // Rebuild the chat header so the back arrow appears/disappears with the sidebar.
  if (app.sessionId || route().name === "new") headerForChat();
});

function moveSession(step) {
  const ids = sideRows.length ? sideRows.map((x) => x.id) : (app.sessions || []).filter((x) => !x.archived).map((x) => x.id);
  if (!ids.length) return;
  const at = ids.indexOf(route().id || "");
  const next = at < 0 ? (step > 0 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, at + step));
  if (ids[next] && ids[next] !== route().id) go("/s/" + ids[next]);
}

function showKeys() {
  keys.replaceChildren();
  const box = document.createElement("div");
  box.className = "keys-box";
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";
  box.innerHTML = "<h2>Keyboard shortcuts</h2>";
  const rows = [
    ["Enter", "Send; while running, queue as Send next. Shift+Enter for a new line"],
    [mod + " + Enter", "Send (also works on phone keyboards)"],
    ["Ctrl + K", "Switch session"],
    ["Ctrl + N", "New session"],
    ["Alt + ↑ / ↓", "Previous / next session"],
    ["Esc", "Close panels and menus"],
    ["?", "This help"],
    ["Paste or drop", "Attach images"],
  ];
  const dl = document.createElement("dl");
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.innerHTML = k.split(" + ").map((x) => "<kbd></kbd>").join(" + ");
    dt.querySelectorAll("kbd").forEach((el, i) => (el.textContent = k.split(" + ")[i]));
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  box.append(dl, button("Close", () => hideKeys(), "wide"));
  keys.append(box);
  keys.hidden = false;
}

function hideKeys() {
  keys.hidden = true;
}

keys.addEventListener("click", (event) => {
  if (event.target === keys) hideKeys();
});

function openSwitcher() {
  keys.replaceChildren();
  const box = document.createElement("div");
  box.className = "keys-box switcher";
  const q = document.createElement("input");
  q.placeholder = "Switch to session…";
  q.setAttribute("aria-label", "Switch session");
  const list = document.createElement("div");
  list.className = "switch-list";
  let pick = 0;
  let hits = [];
  const draw = () => {
    const term = q.value.trim().toLowerCase();
    hits = (app.sessions || []).filter((x) => !x.archived && (!term || ((x.title || "") + " " + (x.cwd || "")).toLowerCase().includes(term))).slice(0, 12);
    pick = Math.min(pick, Math.max(0, hits.length - 1));
    list.replaceChildren();
    hits.forEach((x, i) => {
      const b = button(x.title || "New session", () => { hideKeys(); go("/s/" + x.id); }, "switch-row" + (i === pick ? " on" : ""));
      const t = themeById(x.theme || app.globalTheme || "purple");
      if (t) b.style.borderLeftColor = t.vars["--accent"];
      list.append(b);
    });
  };
  q.addEventListener("input", () => { pick = 0; draw(); });
  q.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") { pick = Math.min(hits.length - 1, pick + 1); draw(); event.preventDefault(); }
    else if (event.key === "ArrowUp") { pick = Math.max(0, pick - 1); draw(); event.preventDefault(); }
    else if (event.key === "Enter" && hits[pick]) { event.preventDefault(); hideKeys(); go("/s/" + hits[pick].id); }
  });
  box.append(q, list);
  keys.append(box);
  keys.hidden = false;
  draw();
  q.focus();
}

document.addEventListener("keydown", (event) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "");
  const k = event.key.toLowerCase();
  if (event.key === "Escape" && !keys.hidden) {
    hideKeys();
    return;
  }
  if (!app.authed) return;
  if (event.ctrlKey && !event.altKey && k === "k") {
    event.preventDefault();
    openSwitcher();
  } else if (event.ctrlKey && !event.altKey && k === "n") {
    event.preventDefault();
    go("/new");
  } else if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
    event.preventDefault();
    moveSession(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "?" && !typing) {
    event.preventDefault();
    showKeys();
  }
});

// Drop images anywhere in the window on desktop.
document.addEventListener("dragover", (event) => {
  if (composer.hidden) return;
  if ([...(event.dataTransfer?.items || [])].some((i) => String(i.type || "").startsWith("image/"))) {
    event.preventDefault();
    document.body.classList.add("dropping");
  }
});
document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) document.body.classList.remove("dropping");
});
document.addEventListener("drop", (event) => {
  document.body.classList.remove("dropping");
  if (composer.hidden || event.defaultPrevented) return;
  const files = [...(event.dataTransfer?.files || [])].filter((f) => String(f.type || "").startsWith("image/"));
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
});

// "Update pending" note: the server is waiting for idle to restart onto new code.
async function checkUpdatePending() {
  try {
    const r = await fetch("/api/health", { cache: "no-store" });
    const h = await r.json();
    let note = document.getElementById("update-note");
    if (h.updatePending) {
      if (!note) {
        note = document.createElement("div");
        note.id = "update-note";
        note.textContent = "Update pending · applies when no turns are running";
        document.body.append(note);
      }
    } else note?.remove();
  } catch {
    // Offline; the reconnect logic handles that.
  }
}
checkUpdatePending();
setInterval(checkUpdatePending, 60000);


// Long run status bar: heartbeat, budget and stop/resume.
const longbar = document.getElementById("longbar");
function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? s + "s ago" : Math.round(s / 60) + " min ago";
}
function paintLongRun(run) {
  if (run !== undefined) app.longRun = run || null;
  const lr = app.longRun;
  if (!longbar) return;
  if (!lr) {
    longbar.hidden = true;
    return;
  }
  const labels = { running: "Long run", paused: "Long run paused", done: "Long run done", blocked: "Long run blocked", budget: "Long run hit budget", stalled: "Long run stalled", stopped: "Long run stopped" };
  const elapsed = Date.now() - (lr.startedAt || Date.now());
  const bits = [labels[lr.status] || "Long run", durationText(elapsed) + " / " + lr.hours + "h", lr.turns + " turns"];
  if (lr.resumes) bits.push(lr.resumes + " resumes");
  if (lr.status === "running" && lr.lastActivity) bits.push("active " + agoText(Date.now() - lr.lastActivity));
  longbar.hidden = false;
  longbar.dataset.status = lr.status;
  longbar.replaceChildren();
  const text = document.createElement("span");
  text.textContent = bits.join(" · ") + (lr.note && lr.status !== "running" ? " — " + lr.note : "");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = lr.status === "running" ? "Stop" : "Resume";
  btn.addEventListener("click", () => longRunAction(lr.status === "running" ? "stop" : "resume"));
  longbar.append(text, btn);
}
async function longRunAction(action, extra = {}) {
  if (!app.sessionId) return;
  try {
    const r = await api("/api/sessions/" + app.sessionId + "/longrun", { method: "POST", body: JSON.stringify({ action, ...extra }) });
    paintLongRun(r.longRun);
  } catch (error) {
    if (!error.auth) alert(error.message || "Long run change failed");
  }
}
function startLongRun() {
  const goal = prompt("Long run goal (Grok will write GOAL.md from this):");
  if (!goal) return;
  const hours = Number(prompt("Time budget in hours:", "12")) || 12;
  longRunAction("start", { goal, hours });
}
setInterval(() => { if (app.longRun?.status === "running") paintLongRun(); }, 15000);


// ---------- Skeptical review ----------
// A second Grok in a fresh context rechecks a "done" turn. Verdict card sits above the composer.
const skepticBox = document.getElementById("skeptic");
const SKEPTIC_MODES = [["default", "Use app default"], ["off", "Off"], ["auto", "Auto (risky turns only)"], ["always", "Every turn that changed files"]];
const SKEPTIC_NAMES = { off: "Off", auto: "Auto", always: "Every turn" };

async function loadSkepticDefaults() {
  try {
    app.skepticDefaults = (await api("/api/skeptic/settings")).settings;
  } catch {
    // keep the last known
  }
}

function skepticEffective() {
  const own = app.session?.skeptic || "default";
  return own === "default" ? app.skepticDefaults?.mode || "off" : own;
}

function skepticTokensText(r) {
  const bits = [];
  if (r.tokens) bits.push(tokensText(r.tokens));
  if (r.costUsd) bits.push("$" + r.costUsd.toFixed(2));
  return bits.join(" · ");
}

function paintSkeptic(review) {
  if (review !== undefined) app.skeptic = review || null;
  const r = app.skeptic;
  if (!skepticBox) return;
  if (!r || r.dismissed || (r.state === "skipped" && r.sent)) {
    skepticBox.hidden = true;
    skepticBox.replaceChildren();
    return;
  }
  skepticBox.hidden = false;
  skepticBox.dataset.state = r.state;
  skepticBox.replaceChildren();
  const head = document.createElement("div");
  head.className = "sk-head";
  const title = document.createElement("span");
  title.className = "sk-title";
  const cost = skepticTokensText(r);
  const round = r.round > 1 ? " · round " + r.round : "";
  if (r.state === "running") title.textContent = "Skeptical review" + round + " · " + (r.model || "") + " · " + durationText(Date.now() - r.startedAt);
  else if (r.state === "pass") title.textContent = "Skeptic: Pass" + (r.ran?.length ? " · reran " + r.ran.length + " command" + (r.ran.length === 1 ? "" : "s") : "") + (cost ? " · " + cost : "");
  else if (r.state === "issues") title.textContent = "Skeptic: " + r.issues.length + " issue" + (r.issues.length === 1 ? "" : "s") + (r.unverified?.length ? ", " + r.unverified.length + " unverified" : "") + round + (cost ? " · " + cost : "");
  else if (r.state === "cancelled") title.textContent = "Skeptic review cancelled" + (r.note ? ": " + r.note.replace(/^Cancelled:?\s*/, "") : "");
  else title.textContent = r.state === "skipped" ? r.note : "Skeptic review failed: " + (r.note || "error");
  head.append(title);
  if (r.state === "running") head.append(button("Cancel", () => skepticAction("cancel"), "sk-btn"));
  skepticBox.append(head);
  if (r.state === "issues" || r.state === "pass") {
    if (r.summary) {
      const p = document.createElement("p");
      p.className = "sk-summary";
      p.textContent = r.summary;
      skepticBox.append(p);
    }
    const shown = (r.issues || []).slice(0, 5);
    if (shown.length) {
      const list = document.createElement("ol");
      list.className = "sk-list";
      for (const issue of shown) {
        const li = document.createElement("li");
        const sev = document.createElement("b");
        sev.className = "sev-" + issue.severity;
        sev.textContent = issue.severity.toUpperCase();
        li.append(sev, document.createTextNode(" " + issue.title + (issue.where ? " (" + issue.where + ")" : "")));
        const ev = document.createElement("small");
        ev.textContent = issue.evidence;
        li.append(ev);
        list.append(li);
      }
      skepticBox.append(list);
      if (r.issues.length > shown.length) {
        const more = document.createElement("p");
        more.className = "sk-summary";
        more.textContent = "+" + (r.issues.length - shown.length) + " more";
        skepticBox.append(more);
      }
    }
    if (r.unverified?.length) {
      const u = document.createElement("p");
      u.className = "sk-summary";
      u.textContent = "Unverified: " + r.unverified.join("; ");
      skepticBox.append(u);
    }
    if (r.note) {
      const n = document.createElement("p");
      n.className = "sk-summary";
      n.textContent = r.note;
      skepticBox.append(n);
    }
    const row = document.createElement("div");
    row.className = "sk-actions";
    if (r.state === "issues" && !r.sent) row.append(button("Send issues to Grok", () => skepticAction("send"), "sk-btn primary"));
    if (r.sent) {
      const sent = document.createElement("span");
      sent.className = "sk-sent";
      sent.textContent = r.sentAuto ? "Sent to Grok automatically" : "Sent to Grok";
      row.append(sent);
    }
    row.append(button("Dismiss", () => skepticAction("dismiss"), "sk-btn"));
    skepticBox.append(row);
  } else if (r.state !== "running") {
    const row = document.createElement("div");
    row.className = "sk-actions";
    if (r.state !== "skipped") row.append(button("Retry", () => skepticAction("run"), "sk-btn"));
    row.append(button("Dismiss", () => skepticAction("dismiss"), "sk-btn"));
    skepticBox.append(row);
  }
}

setInterval(() => { if (app.skeptic?.state === "running") paintSkeptic(); }, 5000);

async function skepticAction(action) {
  if (!app.sessionId) return;
  try {
    const r = await api("/api/sessions/" + app.sessionId + "/skeptic", { method: "POST", body: JSON.stringify({ action }) });
    paintSkeptic(r.skeptic);
    if (action === "send") reloadSettled();
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

async function setSkepticPref(patch) {
  if (!app.sessionId) return;
  try {
    const saved = await api("/api/sessions/" + app.sessionId, { method: "PATCH", body: JSON.stringify(patch) });
    app.session = saved.session;
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

function skepticMenuRow() {
  const r = app.skeptic;
  if (r?.state === "running") return { label: "Skeptical review running · Cancel", accent: true, run: () => { closeSheet(); skepticAction("cancel"); } };
  const mode = skepticEffective();
  return {
    label: "Skeptical review: " + (SKEPTIC_NAMES[mode] || mode) + (app.session?.skeptic === "default" ? " (app default)" : ""),
    accent: mode !== "off",
    run: () => openSheet([
      { label: "Review this turn now", run: () => { closeSheet(); skepticAction("run"); } },
      ...SKEPTIC_MODES.map(([value, text]) => ({ label: text + ((app.session?.skeptic || "default") === value ? "  ✓" : ""), run: async () => { await setSkepticPref({ skeptic: value }); closeSheet(); } })),
      { label: "Back", run: () => openSheet() },
    ]),
  };
}

function skepticSessionBlock(id, session) {
  const wrap = document.createElement("div");
  const mode = select(SKEPTIC_MODES, session.skeptic || "default");
  mode.addEventListener("change", () => setSkepticPref({ skeptic: mode.value }));
  const loop = select([["default", "Use app default"], ["off", "Off"], ["on", "On: send issues back automatically"]], session.skepticLoop || "default");
  loop.addEventListener("change", () => setSkepticPref({ skepticLoop: loop.value }));
  const note = document.createElement("p");
  note.className = "mode-note";
  note.textContent = "A second Grok in a fresh context rechecks work Grok calls done: it reruns the tests, tries edge cases and lists claims it could not confirm. It costs about as much as a short turn, and Auto only fires on risky or larger changes.";
  const usage = document.createElement("p");
  usage.className = "mode-note";
  usage.id = "skeptic-usage";
  wrap.append(field("Skeptical review", mode), field("Auto-loop", loop), note, usage);
  return wrap;
}

function skepticDefaultsBlock() {
  const wrap = document.createElement("div");
  wrap.className = "field-group";
  const title = document.createElement("h3");
  title.textContent = "Skeptical review (default for sessions)";
  const holder = document.createElement("div");
  wrap.append(title, holder);
  loadSkepticDefaults().then(() => {
    const s = app.skepticDefaults || {};
    const save = async (patch) => {
      try {
        app.skepticDefaults = (await api("/api/skeptic/settings", { method: "PATCH", body: JSON.stringify(patch) })).settings;
      } catch (error) {
        if (!error.auth) alert(error.message);
      }
    };
    const mk = (label, options, key, value, parse = (v) => v) => {
      const el = select(options, String(value));
      el.addEventListener("change", () => save({ [key]: parse(el.value) }));
      return field(label, el);
    };
    holder.replaceChildren(
      mk("Mode", [["off", "Off"], ["auto", "Auto (risky turns only)"], ["always", "Every turn that changed files"]], "mode", s.mode),
      mk("Reviewer model", [["auto", "Auto (not the session model)"], ...app.models.map((m) => [m, m])], "model", s.model),
      mk("Reviewer effort", [["medium", "Medium"], ["high", "High"], ["xhigh", "Extra high"]], "effort", s.effort),
      mk("Auto-loop", [["false", "Off"], ["true", "On"]], "autoLoop", String(!!s.autoLoop), (v) => v === "true"),
      mk("Auto-loop rounds", [["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"]], "maxRounds", s.maxRounds, Number),
      mk("Max reviews per hour", [["3", "3"], ["6", "6"], ["12", "12"], ["30", "30"]], "maxPerHour", s.maxPerHour, Number)
    );
  });
  return wrap;
}
