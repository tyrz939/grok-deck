import { parseMedia, renderMarkdown } from "./markdown.js";
import { docBody, hydrateEmbeds, sizeText } from "./embeds.js";
import { applyEvent } from "./reduce.js";
import { copyText } from "./clipboard.js";
import { composerAction, hasComposerContent } from "./composer.js";
import { applyReasoning, applyReview, longRunActive, modeChoice, reasoningChoice, reasoningChipParts, REVIEW_HELP } from "./options.js";

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
  draft: { cwd: "", model: "grok-4.7", effort: "high", permissionMode: "default", ultra: false, plan: false, longRun: false, longHours: 12 },
  images: [],
  files: [],
  imageRoute: "",
  queue: [],
  loops: [],
  appearance: "dark",
  appearanceRemote: false,
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
const filePick = document.getElementById("files");
const attachBtn = document.getElementById("attach");

function clearImages() {
  for (const image of app.images) {
    if (image.url) URL.revokeObjectURL(image.url);
  }
  app.images = [];
  app.files = [];
  renderThumbs();
}

function noteRoute(key) {
  const view = String(key || "").split(":")[0] || "";
  document.body.dataset.view = view;
  if (view !== "chat") applyNeutralChrome();
  if (app.imageRoute === key) return;
  app.imageRoute = key;
  clearImages();
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 8;
const FILE_ICON = { pdf: "doc", markdown: "doc", code: "code", video: "video", audio: "audio" };

function filesBusy() {
  return app.files.some((file) => file.status === "uploading");
}

// Files ready to send, as the server wants them.
function readyFiles() {
  return app.files.filter((file) => file.status === "ready").map((file) => ({ id: file.id, name: file.name }));
}

function renderThumbs() {
  thumbs.replaceChildren();
  thumbs.hidden = app.images.length === 0 && app.files.length === 0;
  for (const file of app.files) {
    const chip = document.createElement("div");
    chip.className = "filechip" + (file.status === "uploading" ? " busy" : "");
    chip.dataset.name = file.name;
    const icon = document.createElement("span");
    icon.className = "filechip-icon";
    icon.append(lineIcon(file.status === "uploading" ? "progress" : FILE_ICON[file.kind] || "file"));
    const name = document.createElement("span");
    name.className = "filechip-name";
    name.textContent = file.name;
    const meta = document.createElement("span");
    meta.className = "filechip-meta";
    meta.textContent = file.status === "uploading" ? "Uploading" : sizeText(file.size);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-btn filechip-x";
    remove.setAttribute("aria-label", "Remove " + file.name);
    remove.append(lineIcon("x"));
    remove.addEventListener("click", () => {
      app.files = app.files.filter((item) => item !== file);
      renderThumbs();
      growInput();
      paintSend();
    });
    chip.append(icon, name, meta, remove);
    thumbs.append(chip);
  }
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

async function uploadFile(file) {
  const entry = { name: file.name || "file", size: file.size, kind: "file", status: "uploading", id: "" };
  app.files.push(entry);
  renderThumbs();
  paintSend();
  try {
    const res = await fetch("/api/uploads?name=" + encodeURIComponent(entry.name), {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: file,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
      app.files = app.files.filter((item) => item !== entry);
      closeStream();
      await showAuth();
      return;
    }
    if (!res.ok) throw new Error(data.error || "Upload failed");
    Object.assign(entry, { id: data.id, kind: data.kind, name: data.name, size: data.size, status: "ready" });
  } catch (error) {
    app.files = app.files.filter((item) => item !== entry);
    setNotice(entry.name + " could not be attached: " + (error.message || "upload failed"));
  }
  renderThumbs();
  growInput();
  paintSend();
}

// Photos keep their own path (shrunk, sent with the message). Any other file is uploaded and attached by its name.
async function addFiles(files) {
  let rejected = false;
  for (const file of files) {
    if (!file) continue;
    if (String(file.type || "").startsWith("image/")) {
      if (app.images.length >= 4) {
        setNotice("Attach up to 4 photos.");
        continue;
      }
      try {
        app.images.push(await prepareImage(file));
      } catch {
        rejected = true;
      }
      continue;
    }
    if (app.files.length >= MAX_FILES) {
      setNotice("Attach up to " + MAX_FILES + " files.");
      break;
    }
    if (file.size > MAX_FILE_BYTES) {
      setNotice((file.name || "That file") + " is " + sizeText(file.size) + ", over the " + sizeText(MAX_FILE_BYTES) + " limit.");
      continue;
    }
    if (!file.size) {
      setNotice((file.name || "That file") + " is empty.");
      continue;
    }
    uploadFile(file);
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

// The files a sent message carried, as the same cards a linked file gets in a reply.
// A "moved or deleted" card for a reference that may only have been early: ask the server to look again. It copies the
// file into the store if it is there now, and the card becomes the file. Asked when the card is drawn and when the
// page comes back into view, and at most every 15 s for one reference otherwise.
const recheckedAt = new Map();
async function recheckMissing(root, force) {
  const id = app.sessionId;
  if (!id) return;
  for (const card of root.querySelectorAll(".md-missing[data-target]")) {
    const target = card.dataset.target;
    const key = id + "\0" + target;
    if (!force && Date.now() - (recheckedAt.get(key) || 0) < 15000) continue;
    recheckedAt.set(key, Date.now());
    let url = "";
    try {
      url = (await api("/api/sessions/" + id + "/media", { method: "POST", body: JSON.stringify({ target }) })).url || "";
    } catch {
      continue;
    }
    if (!url || !card.isConnected) continue;
    const label = (card.dataset.label || "").replace(/[\[\]]/g, "");
    const wrap = document.createElement("div");
    wrap.innerHTML = renderMarkdown("[" + label + "](" + url + ")");
    const made = wrap.querySelector("p")?.firstElementChild;
    if (!made) continue;
    const msg = card.closest(".msg");
    card.replaceWith(made);
    if (msg) hydrateEmbeds(made.parentElement || msg, msg._embeds || (msg._embeds = new Map()), embedUi);
  }
}

function renderAttached(node, files) {
  const key = JSON.stringify((files || []).map((file) => file.id + file.name));
  if (node._filesKey === key) return;
  node._filesKey = key;
  node.querySelector(":scope > .msg-files")?.remove();
  if (!files || !files.length) return;
  const box = document.createElement("div");
  box.className = "msg-files";
  for (const file of files) {
    const info = parseMedia("/api/media/" + file.id);
    const holder = document.createElement("span");
    holder.className = "embed";
    holder.dataset.src = "/api/media/" + file.id;
    holder.dataset.kind = info ? info.kind : "file";
    holder.dataset.name = file.name;
    box.append(holder);
  }
  hydrateEmbeds(box, node._embeds || (node._embeds = new Map()), embedUi);
  node.insertBefore(box, node.querySelector(":scope > .msg-actions"));
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
  if (!row.childElementCount) return;
  const copy = node.querySelector(":scope > .msg-actions") || node.querySelector(":scope > .msg-copy");
  if (copy) node.insertBefore(row, copy);
  else node.append(row);
}

// The shell is sized by CSS (--vv-height, 100dvh or 100vh) and JS does not touch it while the keyboard is closed.
// Installed iOS leaves window.innerHeight and visualViewport.height short after the keyboard closes, and sizing the
// shell from either painted that shortfall as a gap under the composer (found on a real iPhone, 12 Oct 2026). So the
// reference for "full height" is a hidden 100vh element, which does not follow the keyboard, and the inline
// variables below exist only while a text field has focus and the visual viewport is well short of that height.
// On blur they are removed and the CSS takes over. The page never scrolls (html and body are overflow hidden, only
// #main scrolls); iPhone scrolls the document when a field gets focus, so every viewport event and focus change puts
// it back at 0. The bottom safe area is CSS padding on the shell, once, and is 0 while the keyboard covers it.
const KEYBOARD_GAP = 140;
const heightProbe = document.createElement("div");
heightProbe.setAttribute("aria-hidden", "true");
heightProbe.style.cssText = "position:absolute;left:0;top:0;width:0;height:100vh;visibility:hidden;pointer-events:none;";
document.body.append(heightProbe);

function typingInField() {
  const el = document.activeElement;
  return !!el && (el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el.tagName === "INPUT" && !/^(button|checkbox|radio|file|submit|range|color|image|reset)$/.test(el.type)) || el.isContentEditable);
}

function resetDocumentScroll() {
  const doc = document.scrollingElement || document.documentElement;
  if (window.scrollY || window.scrollX || doc.scrollTop || document.body.scrollTop) window.scrollTo(0, 0);
}

function applyViewport(vv) {
  const layout = Math.round(heightProbe.getBoundingClientRect().height) || window.innerHeight;
  const vvHeight = vv && vv.height ? vv.height : layout;
  const offsetTop = vv && vv.offsetTop > 0 ? vv.offsetTop : 0;
  // Short by the keyboard whether iOS scrolled the page (offsetTop 0) or panned the viewport (offsetTop > 0).
  const keyboard = typingInField() && layout - vvHeight > KEYBOARD_GAP;
  const root = document.documentElement;
  if (keyboard) {
    root.style.setProperty("--vv-top", Math.round(offsetTop) + "px");
    root.style.setProperty("--vv-height", Math.max(1, Math.round(offsetTop + vvHeight)) + "px");
    root.style.setProperty("--vv-visible", Math.max(1, Math.round(vvHeight)) + "px");
  } else {
    for (const name of ["--vv-top", "--vv-height", "--vv-visible"]) root.style.removeProperty(name);
  }
  root.classList.toggle("keyboard", keyboard);
  resetDocumentScroll();
}

function nearBottom() {
  return main.scrollHeight - main.scrollTop - main.clientHeight < 80;
}

function scrollToEnd(behavior) {
  main.scrollTo({ top: main.scrollHeight, behavior: behavior || "auto" });
}

function handleViewport() {
  placePopover();
  const stick = app.stick || nearBottom();
  applyViewport(window.visualViewport || null);
  paintDebug();
  if (stick) requestAnimationFrame(() => scrollToEnd("auto"));
}

// ?debug=vv: the numbers that decide the shell height, on screen, so a real iPhone can be screenshotted.
const debugBox = new URLSearchParams(location.search).get("debug") === "vv" ? document.createElement("pre") : null;
if (debugBox) {
  debugBox.id = "vv-debug";
  document.body.append(debugBox);
  setInterval(() => paintDebug(), 500);
}

function paintDebug() {
  if (!debugBox) return;
  const vv = window.visualViewport;
  const doc = document.scrollingElement || document.documentElement;
  const shell = document.getElementById("app").getBoundingClientRect();
  const composerBox = document.getElementById("composer").getBoundingClientRect();
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const rows = [
    ["innerHeight", window.innerHeight],
    ["innerWidth", window.innerWidth],
    ["100vh probe", Math.round(heightProbe.getBoundingClientRect().height)],
    ["vv.height", vv ? Math.round(vv.height * 10) / 10 : "n/a"],
    ["vv.offsetTop", vv ? Math.round(vv.offsetTop * 10) / 10 : "n/a"],
    ["vv.pageTop", vv ? Math.round(vv.pageTop * 10) / 10 : "n/a"],
    ["scrollY", Math.round(window.scrollY * 10) / 10],
    ["doc.scrollTop", Math.round(doc.scrollTop)],
    ["shell h", Math.round(shell.height * 10) / 10],
    ["shell top", Math.round(shell.top * 10) / 10],
    ["composer bottom", composerBox.height ? Math.round(composerBox.bottom * 10) / 10 : "hidden"],
    ["--vv-height", document.documentElement.style.getPropertyValue("--vv-height") || "(css)"],
    ["keyboard", document.documentElement.classList.contains("keyboard")],
    ["focus", document.activeElement ? document.activeElement.tagName.toLowerCase() : "-"],
    ["standalone", standalone],
  ];
  debugBox.textContent = rows.map(([k, v]) => k.padEnd(16) + v).join("\n");
}

window.__gm = { applyViewport, nearBottom, scrollToEnd, handleViewport };

function growInput() {
  const bar = input.closest(".composer-bar");
  bar?.classList.remove("tall");
  input.style.height = "auto";
  const plain = input.scrollHeight;
  bar?.classList.toggle("tall", plain > 56);
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
  const desktopMenu = isDesktop() && chat;
  const waiting = chat && app.running && !!main.querySelector(".toolcard.asking, .qcard.asking");
  const auto = chat && activeAuto().length > 0;
  const attention = auto || (chat && app.bypass);
  attachBtn.classList.toggle("flag-wait", !desktopMenu && waiting);
  attachBtn.classList.toggle("flag-auto", !desktopMenu && !waiting && attention);
  attachBtn.setAttribute("aria-label", desktopMenu ? "Add photo" : "Menu");
  const menu = document.querySelector(".side-menu");
  if (menu) {
    menu.classList.toggle("flag-wait", desktopMenu && waiting);
    menu.classList.toggle("flag-auto", desktopMenu && !waiting && attention);
  }
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
  const restoreSession = !setsheet.hidden && !!setsheet.querySelector("[aria-label='App settings']") && route().name === "chat" && app.session;
  if (!setsheet.hidden) {
    setsheet.hidden = true;
    const panel = setsheet.querySelector(".set-panel");
    if (panel) panel.style.transform = "";
  }
  if (restoreSession) {
    buildSettings(app.sessionId, app.session);
    setsheet.hidden = true;
  }
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

// A settings group: a small muted-caps label over a rounded card. The gap between cards is the only separator.
function settingsGroup(title, ...nodes) {
  const sec = document.createElement("section");
  sec.className = "set-group";
  const h = document.createElement("h2");
  h.textContent = title;
  const card = document.createElement("div");
  card.className = "set-card";
  card.append(...nodes.filter(Boolean));
  sec.append(h, card);
  return sec;
}

// The sheet every settings screen shares: grip, title, Done. Returns the panel and the body to fill.
function settingsSheet(title) {
  const panel = document.createElement("div");
  panel.className = "set-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", title);
  const head = document.createElement("div");
  head.className = "set-head";
  const grip = document.createElement("span");
  grip.className = "grip";
  const h = document.createElement("h2");
  h.textContent = title;
  const done = button("Done", () => closeSettings(), "set-done");
  done.setAttribute("aria-label", "Close settings");
  head.append(grip, h, done);
  const body = document.createElement("div");
  body.className = "set-body";
  panel.append(head, body);
  return { panel, head, body };
}

// The group label already says what a control is, so its own visible label becomes an aria-label.
function bareField(field, label) {
  if (!field) return field;
  const text = [...field.childNodes].find((node) => node.nodeType === 3);
  text?.remove();
  const control = field.querySelector("select, input, textarea");
  if (control && !control.getAttribute("aria-label")) control.setAttribute("aria-label", label || text?.textContent || "");
  return field;
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
      paintOptbar();
    } catch (error) {
      if (!error.auth) setNotice(error.message);
    }
  };
  const { panel, head, body } = settingsSheet("Session settings");
  const name = document.createElement("input");
  name.id = "set-name";
  name.value = session.title || "";
  name.maxLength = 120;
  name.setAttribute("aria-label", "Session name");
  name.placeholder = "Name";
  name.addEventListener("change", () => {
    const title = name.value.trim();
    if (title) save({ title });
  });
  const prefs = prefsBlock(session, (next) => save({ model: next.model, permissionMode: next.permissionMode }), { cwdEditable: false });
  const fields = [...prefs.querySelectorAll(":scope > .field")];
  const [dirField, modelField, , permField] = fields;
  const modeNote = prefs.querySelector(":scope > .mode-note");
  const themeGrid = themePicker(session.theme || "", (theme) => save({ theme }), { allowDefault: true });
  themeGrid.id = "set-theme";
  const autoBox = document.createElement("div");
  autoBox.id = "auto-settings";
  autoBox.className = "auto-settings";
  const usage = document.createElement("div");
  usage.className = "usage";
  usage.id = "usage";
  body.append(
    settingsGroup("Name", name),
    settingsGroup("Appearance", appearanceControl()),
    settingsGroup("Theme", themeGrid),
    settingsGroup("Model", bareField(modelField, "Model")),
    settingsGroup("Approvals", bareField(permField, "Permission"), modeNote, autoBox),
    settingsGroup("Skeptical review", skepticSessionBlock(id, session)),
    settingsGroup("Usage", usage),
    settingsGroup("Directory", bareField(dirField, "Directory"))
  );
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
      paintOptbar();
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
  const sessionPanel = setsheet.querySelector("[aria-label='Session settings']");
  const named = (label) => {
    if (!sessionPanel) return null;
    for (const sel of sessionPanel.querySelectorAll("select")) {
      if (sel.closest(".field")?.firstChild?.textContent === label) return sel;
    }
    return null;
  };
  const model = named("Model");
  const effort = named("Effort");
  const mode = named("Permission");
  const skepticMode = named("Skeptical review");
  const skepticLoop = named("Auto-loop");
  if (model && s.model) model.value = s.model;
  if (effort && s.effort) effort.value = s.effort;
  if (mode && s.permissionMode) mode.value = s.permissionMode;
  if (skepticMode && s.skeptic) skepticMode.value = s.skeptic;
  if (skepticLoop && s.skepticLoop) skepticLoop.value = s.skepticLoop;
  const ultra = setsheet.querySelector(".switch:not(.plan-switch) input");
  if (ultra) ultra.checked = !!s.ultra;
  const planIn = setsheet.querySelector(".plan-switch input");
  if (planIn) planIn.checked = !!s.plan;
  paintOptbar();
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
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && theme.vars && theme.vars["--bg-darker"]) meta.setAttribute("content", theme.vars["--bg-darker"]);
  app.themeName = theme.name || "";
  if (theme.pref) app.themePref = theme.pref;
}

// Same colors as neutralVars() in lib/theme.js. List, sidebar, and new-session chrome use these.
function neutralVars(mode) {
  if (mode === "light") {
    return {
      "--bg": "#ffffff",
      "--bg-dark": "#ffffff",
      "--bg-darker": "#ffffff",
      "--bg-light": "#f2f2f2",
      "--fg": "#000000",
      "--fg-dim": "#5c636a",
      "--fg-soft": "#5c636a",
      "--fg-bright": "#000000",
      "--accent": "#000000",
      "--on-accent": "#ffffff",
      "--line": "#e2e2e2",
      "--muted": "#5c636a",
      "--selection": "#e2e2e2",
      "--banner-bg": "#f2f2f2",
      "--banner-fg": "#000000",
      "--red": "#c42b3a",
      "--green": "#1a7f37",
      "--yellow": "#9a6700",
      "--orange": "#bc4c00",
      "--blue": "#0969da",
      "--cyan": "#1b7c83",
    };
  }
  return {
    "--bg": "#000000",
    "--bg-dark": "#000000",
    "--bg-darker": "#000000",
    "--bg-light": "#16181c",
    "--fg": "#ffffff",
    "--fg-dim": "#8b9196",
    "--fg-soft": "#8b9196",
    "--fg-bright": "#ffffff",
    "--accent": "#ffffff",
    "--on-accent": "#000000",
    "--line": "#2f3336",
    "--muted": "#8b9196",
    "--selection": "#2f3336",
    "--banner-bg": "#16181c",
    "--banner-fg": "#ffffff",
    "--red": "#f7768e",
    "--green": "#9ece6a",
    "--yellow": "#e0af68",
    "--orange": "#ff9e64",
    "--blue": "#8cb4ff",
    "--cyan": "#7dcfff",
  };
}

function applyNeutralChrome() {
  applyTheme({ vars: neutralVars(app.appearance === "light" ? "light" : "dark"), name: "", pref: "" });
}

// Themes color a session's header and accents. The list and the sidebar stay neutral.
function themeById(id) {
  return (app.themes || []).find((theme) => theme.id === id) || null;
}

function sessionThemeId() {
  if (route().name !== "chat") return "";
  const id = app.session && app.session.theme;
  if (id && themeById(id)) return id;
  return app.globalTheme || "purple";
}

function applyCurrentTheme() {
  if (route().name !== "chat") {
    applyNeutralChrome();
    return;
  }
  const theme = themeById(sessionThemeId());
  if (theme) applyTheme(theme);
}

function sessionAccent(themeId) {
  const theme = themeById(themeId || app.globalTheme || "purple");
  return theme && theme.vars ? theme.vars["--accent"] : "";
}

function paintSessionDots() {
  for (const row of document.querySelectorAll(".row[data-theme], .side-row[data-theme], .switch-row[data-theme]")) {
    const dot = row.querySelector(".row-dot, .side-dot");
    const color = sessionAccent(row.dataset.theme);
    if (dot && color) dot.style.background = color;
    if (color && row.classList.contains("side-row")) row.style.setProperty("--row-accent", color);
  }
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
    if (base) options.unshift({ ...base, id: "", name: "Default", label: "App default" });
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
    name.textContent = theme.id === "desktop" ? "Desktop" : theme.name;
    const foot = document.createElement("span");
    foot.className = "sw-foot";
    const check = lineIcon("check");
    check.classList.add("sw-check");
    foot.append(name, check);
    el.append(prev, foot);
    el.setAttribute("aria-label", theme.id === "desktop" ? "Follow desktop" : theme.label || theme.name);
    el.addEventListener("click", () => {
      paint(theme.id);
      onPick(theme.id);
    });
    grid.append(el);
  }
  paint(value || "");
  return grid;
}

const APPEARANCE_KEY = "gm-appearance";

function storedAppearance() {
  try {
    const value = localStorage.getItem(APPEARANCE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // Private mode can throw. Dark stays the default.
  }
  return null;
}

function paintAppearance() {
  const mode = app.appearance === "light" ? "light" : "dark";
  for (const btn of document.querySelectorAll(".appearance-opt")) {
    const on = btn.dataset.value === mode;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-checked", on ? "true" : "false");
  }
}

function applyAppearance(mode) {
  const next = mode === "light" ? "light" : "dark";
  app.appearance = next;
  document.documentElement.dataset.appearance = next;
  paintAppearance();
  applyCurrentTheme();
}

function chooseAppearance(mode) {
  const next = mode === "light" ? "light" : "dark";
  try {
    localStorage.setItem(APPEARANCE_KEY, next);
  } catch {
    // Still apply it for this visit.
  }
  applyAppearance(next);
  syncAppearance(next);
}

async function syncAppearance(next) {
  if (!app.authed || !app.appearanceRemote || !app.globalTheme) return;
  try {
    await api("/api/theme", {
      method: "POST",
      body: JSON.stringify({ appearance: next, pref: app.globalTheme }),
    });
  } catch {
    // The running server may not store appearance yet. localStorage already has it.
  }
}

function appearanceControl() {
  const group = document.createElement("div");
  group.className = "appearance";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Appearance");
  const mode = app.appearance === "light" ? "light" : "dark";
  for (const [value, label] of [["dark", "Dark"], ["light", "Light"]]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "appearance-opt" + (value === mode ? " on" : "");
    btn.dataset.value = value;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", value === mode ? "true" : "false");
    btn.append(lineIcon(value === "dark" ? "moon" : "sun"), document.createTextNode(label));
    btn.addEventListener("click", () => chooseAppearance(value));
    group.append(btn);
  }
  return group;
}

function themeGroup() {
  const hint = document.createElement("p");
  hint.className = "field-hint";
  hint.textContent = "The list stays black or white. Sessions set to Default use this palette.";
  return settingsGroup("Default session theme", hint, themePicker(app.globalTheme || "purple", async (id) => {
    try {
      await api("/api/theme", { method: "POST", body: JSON.stringify({ pref: id }) });
      app.globalTheme = id;
      applyCurrentTheme();
      paintSessionDots();
    } catch (error) {
      if (!error.auth) setNotice(error.message);
    }
  }));
}

async function refreshTheme() {
  try {
    const data = await fetch("/api/themes", { credentials: "same-origin" }).then((res) => (res.ok ? res.json() : null));
    if (data && Array.isArray(data.themes)) {
      app.themes = data.themes;
      app.globalTheme = data.global || "purple";
      if (data.httpsUrl) app.httpsUrl = data.httpsUrl;
      if (data.appearance === "light" || data.appearance === "dark") {
        app.appearanceRemote = true;
        const local = storedAppearance();
        if (local && local !== data.appearance) syncAppearance(local);
        else if (!local) {
          try { localStorage.setItem(APPEARANCE_KEY, data.appearance); } catch { /* keep the visit */ }
          applyAppearance(data.appearance);
        }
      }
      applyCurrentTheme();
      paintSessionDots();
      return;
    }
    const theme = await fetch("/api/theme").then((res) => (res.ok ? res.json() : null));
    if (theme && theme.id) {
      app.themes = [theme];
      app.globalTheme = theme.pref || theme.id;
    }
    applyCurrentTheme();
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
  chev.append(lineIcon("chevron"));
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
  chev.append(lineIcon("chevron"));
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
  bits.push(tier === "ultra" ? "Deep tier" : tier === "strong" ? "Strong tier" : "Default tier");
  if (sub.agentType && sub.agentType !== "general-purpose") bits.push(sub.agentType.replace(/^grok-deck-ultra:/, ""));
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

// One answer per turn, by position: in a turn (the messages after one user message), every assistant text
// message except the last has been followed by a newer one, so it moves into the steps. While the turn runs
// the newest message is the last one, so it stays on screen until a later one supersedes it.
function supersededReplies(messages) {
  const folded = new Set();
  let turn = [];
  const close = () => {
    for (const message of turn.slice(0, -1)) folded.add(message);
    turn = [];
  };
  for (const message of messages) {
    if (message.role === "user") close();
    else if (message.role === "assistant" && String(message.text || "").trim()) turn.push(message);
  }
  close();
  return folded;
}

function stepsLabel(items, folded) {
  const earlier = items.filter((m) => folded.has(m)).length;
  const steps = items.length - earlier;
  const failed = items.filter((m) => m.tool && (m.tool.status === "failed" || m.tool.status === "denied")).length;
  const tokens = items.reduce((sum, m) => sum + (Number(m.tokens) || 0), 0);
  const parts = [];
  if (steps) parts.push(steps + (steps === 1 ? " step" : " steps"));
  if (earlier) parts.push(earlier === 1 && !steps ? "Earlier message" : earlier + " earlier " + (earlier === 1 ? "message" : "messages"));
  if (failed) parts.push(failed + " failed");
  if (tokens) parts.push(tokensText(tokens));
  return parts.join(" · ");
}

// Builds the nodes for one message list. Step messages between two replies fold into one "N steps" group.
function syncList(messages, prefix, keep, nested) {
  const top = [];
  const earlier = nested ? new Set() : supersededReplies(messages);
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
    node.querySelector(".steps-count").textContent = stepsLabel(group.items, earlier);
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
    node.classList.toggle("earlier-reply", earlier.has(message));
    if ((STEP_ROLES.has(message.role) || earlier.has(message)) && !asking) {
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


function svgEl(name, attrs) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function copyIcons() {
  const copy = svgEl("svg", { viewBox: "0 0 18 18", class: "ico ico-copy" });
  copy.append(
    svgEl("rect", { x: "6.25", y: "2.25", width: "9.5", height: "9.5", rx: "1.5" }),
    svgEl("rect", { x: "2.25", y: "6.25", width: "9.5", height: "9.5", rx: "1.5" }),
  );
  const check = svgEl("svg", { viewBox: "0 0 18 18", class: "ico ico-check" });
  check.append(svgEl("path", { d: "M4 9.5 7.5 13 14 5.5" }));
  for (const icon of [copy, check]) icon.setAttribute("aria-hidden", "true");
  return [copy, check];
}

function flashCopied(btn) {
  if (btn.querySelector(".ico-copy")) {
    const rest = btn.classList.contains("msg-copy") ? "Copy message" : "Copy code";
    btn.classList.add("copied");
    btn.setAttribute("aria-label", "Copied");
    clearTimeout(btn._flash);
    btn._flash = setTimeout(() => {
      btn.classList.remove("copied");
      btn.setAttribute("aria-label", rest);
    }, 1200);
    return;
  }
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
    if (ok) flashCopied(btn);
    else if (btn.classList.contains("msg-copy")) {
      btn.setAttribute("aria-label", "Copy failed");
      clearTimeout(btn._flash);
      btn._flash = setTimeout(() => btn.setAttribute("aria-label", "Copy message"), 1200);
    } else {
      flashCopied(btn);
      btn.textContent = "Copy failed";
    }
  } else if (ok) {
    node.classList.add("just-copied");
    clearTimeout(node._copyFlash);
    node._copyFlash = setTimeout(() => node.classList.remove("just-copied"), 1200);
  }
  return ok;
}

function addMsgCopy(node) {
  const row = document.createElement("div");
  row.className = "msg-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "msg-copy";
  btn.setAttribute("aria-label", "Copy message");
  btn.append(...copyIcons());
  btn.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    copyMessageText(node, btn);
  });
  row.append(btn);
  node.append(row);
  let timer = 0;
  node.addEventListener("touchstart", (event) => {
    if (event.target.closest("button, a, .copy, .msg-copy")) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = 0;
      if (navigator.vibrate) navigator.vibrate(20);
      copyMessageText(node, btn);
    }, 500);
  }, { passive: true });
  const cancel = () => { clearTimeout(timer); timer = 0; };
  node.addEventListener("touchend", cancel);
  node.addEventListener("touchmove", cancel);
  node.addEventListener("touchcancel", cancel);
}

function createMessage(message) {
  if (message.role === "question") {
    const node = document.createElement("div");
    node.className = "qcard";
    node.dataset.mid = message.id;
    updateMessage(node, message);
    return node;
  }
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
    const line = document.createElement("span");
    line.className = "tool-line";
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.setAttribute("aria-hidden", "true");
    chev.append(lineIcon("chevron"));
    head.append(status, name, line, chev);
    summary.append(head);
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

const STATUS_ICON = { completed: "check", failed: "x", denied: "x", in_progress: "progress", pending: "progress", waiting: "clock", cancelled: "minus" };

// A step's status is an icon in its row; the words are its accessible name and the tooltip.
function paintToolStatus(pill, status, text) {
  pill.dataset.s = status;
  pill.title = text;
  pill.setAttribute("role", "img");
  pill.setAttribute("aria-label", text);
  pill.replaceChildren(lineIcon(STATUS_ICON[status] || "minus"));
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
  paintToolStatus(pill, status, pillText);
  const doing = oneLine(tool);
  // The line says what the step did; when it only repeats the name, it says nothing.
  node.querySelector(".tool-line").textContent = doing.toLowerCase() === toolLabel(tool).toLowerCase() ? "" : doing;
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
  const details = node.querySelector(":scope > details");
  const waiting = tool.waiting;
  if (!waiting) {
    perm.hidden = true;
    perm.replaceChildren();
    if (details) details.hidden = false;
    node.classList.remove("asking");
    return;
  }
  node.classList.add("asking");
  if (details) details.hidden = !(tool.images && tool.images.length);
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
  if (message.role === "question") {
    paintQuestionCard(node, message);
    return;
  }
  if (message.role === "planreview") {
    paintPlanCard(node, message);
    return;
  }
  if (message.role === "user") {
    node._raw = message.text || "";
    const text = node.querySelector(".msg-text");
    if (text && text.textContent !== (message.text || "")) text.textContent = message.text || "";
    renderShots(node, message.images);
    renderAttached(node, message.files);
    return;
  }
  if (message.role === "assistant") {
    node._raw = message.text || "";
    if (node._text !== message.text) {
      const body = node.querySelector(".body");
      body.innerHTML = renderMarkdown(message.text || "");
      hydrateEmbeds(body, node._embeds || (node._embeds = new Map()), embedUi);
      node._text = message.text;
      recheckMissing(body, false);
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
    notePlanUsageStale();
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

function prefsBlock(prefs, onChange, { cwdEditable, onlyDirectory = false }) {
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
  const ultraName = document.createElement("b");
  ultraName.textContent = "Deep mode";
  const ultraHelp = document.createElement("small");
  ultraHelp.textContent = REVIEW_HELP;
  ultraText.append(ultraName, ultraHelp);
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
  const emit = (event) => {
    if (event?.target === ultra && ultra.checked) effort.value = "xhigh";
    if (event?.target === effort && effort.value !== "xhigh") ultra.checked = false;
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
    if (onlyDirectory) return;
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
  } else {
    cwd.readOnly = true;
    cwd.setAttribute("aria-readonly", "true");
    box.append(field("Directory", cwd));
  }
  if (cwdEditable && app.dirs.length) {
    const chips = document.createElement("div");
    chips.className = "chips";
    for (const dir of app.dirs) {
      const chip = button(shortPath(dir), () => {
        cwd.value = dir;
        for (const other of chips.querySelectorAll("button")) other.classList.toggle("on", other === chip);
        emit();
      });
      chip.title = dir;
      if (cwd.value === dir) chip.classList.add("on");
      chips.append(chip);
    }
    box.append(chips);
  }
  if (onlyDirectory) return box;
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

const PLAN_MS = 5 * 60 * 1000;
let planSnap = null;
let planAt = 0;
let planGen = 0;
let planFlight = null;
let planFlightGen = -1;

function planUsageNode() {
  const box = document.createElement("div");
  box.className = "plan-usage";
  box.hidden = true;
  const name = document.createElement("span");
  name.className = "plan-usage-label";
  const track = document.createElement("div");
  track.className = "plan-usage-track";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("div");
  fill.className = "plan-usage-fill";
  track.append(fill);
  box.append(name, track);
  return box;
}

function fillPlanUsage(box, data) {
  const percent = Number(data && data.percent);
  const label = data && typeof data.label === "string" ? data.label : "";
  if (!data || data.available !== true || !Number.isFinite(percent) || !label) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const name = box.querySelector(".plan-usage-label");
  if (name.textContent !== label) name.textContent = label;
  const fill = box.querySelector(".plan-usage-fill");
  fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
  const track = box.querySelector(".plan-usage-track");
  track.setAttribute("aria-valuenow", String(Math.round(Math.max(0, Math.min(100, percent)))));
  track.setAttribute("aria-label", label);
}

function loadPlanUsage(force) {
  const gen = planGen;
  if (!force && planSnap && Date.now() - planAt < PLAN_MS) return Promise.resolve(planSnap);
  if (planFlight && planFlightGen === gen && !force) return planFlight;
  planFlightGen = gen;
  planFlight = api("/api/account")
    .then((data) => {
      if (gen !== planGen) return loadPlanUsage(true);
      planSnap = data;
      planAt = Date.now();
      return data;
    })
    .catch(() => {
      if (gen !== planGen) return loadPlanUsage(true);
      planSnap = { available: false };
      planAt = Date.now();
      return planSnap;
    })
    .finally(() => {
      if (planFlightGen === gen) planFlight = null;
    });
  return planFlight;
}

function mountPlanUsage(parent) {
  const box = planUsageNode();
  parent.append(box);
  if (planSnap) fillPlanUsage(box, planSnap);
  if (!planSnap || Date.now() - planAt >= PLAN_MS) {
    loadPlanUsage(false).then((data) => {
      if (box.isConnected) fillPlanUsage(box, data);
    });
  }
  return box;
}

function notePlanUsageStale() {
  planGen += 1;
  planAt = 0;
  if (!document.querySelector(".plan-usage")) return;
  loadPlanUsage(true).then((data) => {
    for (const box of document.querySelectorAll(".plan-usage")) fillPlanUsage(box, data);
  });
}

function sameDay(iso) {
  const then = Date.parse(iso || "");
  if (!Number.isFinite(then)) return false;
  const day = new Date(then);
  const now = new Date();
  return day.getFullYear() === now.getFullYear() && day.getMonth() === now.getMonth() && day.getDate() === now.getDate();
}

function sessionStatusText(session) {
  if (session.waiting) return "Needs approval";
  if (session.running) return "Running";
  return "Idle";
}

function sessionSnippetText(session) {
  const text = String(session.snippet || "").replace(/\s+/g, " ").trim();
  return text || "No messages yet";
}

function sessionGroups(rows) {
  const today = [];
  const earlier = [];
  for (const session of rows) (sameDay(session.updatedAt) ? today : earlier).push(session);
  return [["Today", today], ["Earlier", earlier]].filter((pair) => pair[1].length);
}

function sessionMatches(session, query) {
  if (!query) return true;
  return (session.title + " " + (session.snippet || "") + " " + session.cwd).toLowerCase().includes(query);
}

function listEmpty(kind) {
  const box = document.createElement("div");
  box.className = "list-empty";
  const title = document.createElement("p");
  title.className = "list-empty-title";
  const sub = document.createElement("p");
  sub.className = "list-empty-sub";
  if (kind === "archived") {
    title.textContent = "No archived sessions";
    sub.textContent = "Sessions you archive will show up here.";
  } else if (kind === "search") {
    title.textContent = "No matches";
    sub.textContent = "Try a different search.";
  } else {
    title.textContent = "No sessions yet";
    sub.textContent = "Start one and the latest message will show up here.";
  }
  box.append(title, sub);
  return box;
}

// Swipe left on a phone row to reveal Delete. The row scrolls sideways inside its own box, so Delete sits beside it in
// flow and nothing overlaps. Only one row stays open, and a tap anywhere else closes it.
function closeSwipe(swipe) {
  swipe.scrollTo({ left: 0, behavior: "smooth" });
}

function closeOtherSwipes(keep) {
  for (const swipe of document.querySelectorAll(".row-wrap")) if (swipe !== keep && swipe.scrollLeft > 0) closeSwipe(swipe);
}

document.addEventListener("pointerdown", (event) => {
  for (const swipe of document.querySelectorAll(".row-wrap")) if (swipe.scrollLeft > 8 && !swipe.contains(event.target)) closeSwipe(swipe);
});

function sessionMain(session, prefix) {
  const main = document.createElement("span");
  main.className = prefix + "-main";
  const title = document.createElement("span");
  title.className = prefix === "side" ? "side-title" : "row-title";
  title.textContent = session.title || "New session";
  const time = document.createElement("span");
  time.className = prefix + "-time";
  time.textContent = relTime(session.updatedAt);
  const snippet = document.createElement("span");
  snippet.className = prefix + "-snippet";
  snippet.textContent = sessionSnippetText(session);
  const status = document.createElement("span");
  status.className = prefix + "-status" + (session.waiting ? " wait" : "") + (session.running ? " run" : "");
  status.textContent = sessionStatusText(session);
  main.append(title, time, snippet, status);
  return main;
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
  header("Sessions", isDesktop() ? {} : { right: [appSettingsButton()] });
  paintChatStatus();
  applyCurrentTheme();
  if (isDesktop()) {
    main.replaceChildren();
    const screen = document.createElement("section");
    screen.className = "screen home-empty";
    const title = document.createElement("h2");
    title.textContent = "Grok Deck";
    const sub = document.createElement("p");
    sub.className = "sub";
    sub.textContent = "Choose a session, or start a new one.";
    screen.append(title, sub);
    main.append(screen);
    return;
  }
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
  wrap.className = "screen list-screen";
  let showArchived = false;
  const tools = document.createElement("div");
  tools.className = "list-tools";
  const fresh = button("New session", () => go("/new"), "list-new primary");
  fresh.setAttribute("aria-label", "New session");
  const filter = document.createElement("input");
  filter.className = "filter list-search";
  filter.placeholder = "Search";
  filter.setAttribute("aria-label", "Search sessions");
  tools.append(filter, fresh);
  const list = document.createElement("div");
  list.className = "list-body";
  const draw = () => {
    list.replaceChildren();
    const query = filter.value.trim().toLowerCase();
    const all = data.sessions || [];
    const rows = all.filter((session) => !!session.archived === showArchived && sessionMatches(session, query));
    if (!rows.length) {
      list.append(listEmpty(showArchived ? "archived" : query ? "search" : "none"));
      list.append(archToggle(all));
      return;
    }
    for (const [label, items] of sessionGroups(rows)) {
      const heading = document.createElement("h3");
      heading.className = "list-group";
      heading.textContent = label;
      list.append(heading);
      for (const session of items) {
        const swipe = document.createElement("div");
        swipe.className = "row-wrap";
        const row = document.createElement("button");
        row.type = "button";
        row.className = "row";
        row.dataset.theme = session.theme || "";
        const dot = document.createElement("i");
        dot.className = "row-dot";
        dot.setAttribute("aria-hidden", "true");
        const accent = sessionAccent(session.theme);
        if (accent) dot.style.background = accent;
        row.append(dot, sessionMain(session, "row"));
        row.addEventListener("click", () => {
          if (swipe.scrollLeft > 8) closeSwipe(swipe);
          else go("/s/" + session.id);
        });
        const remove = button("Delete", () => askDeleteSession(session), "row-delete");
        remove.setAttribute("aria-label", "Delete " + (session.title || "New session"));
        swipe.append(row, remove);
        swipe.addEventListener("scroll", () => {
          if (swipe.scrollLeft > 8) closeOtherSwipes(swipe);
        }, { passive: true });
        list.append(swipe);
      }
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
  const foot = document.createElement("footer");
  foot.className = "list-foot";
  mountPlanUsage(foot);
  wrap.append(tools, list, foot);
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
  paintPlus();
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
  screen.append(prefsBlock(app.draft, (next) => {
    app.draft.cwd = next.cwd;
  }, { cwdEditable: true, onlyDirectory: true }));
  main.append(screen);
  setBanner(app.draft.permissionMode);
  paintOptbar();
  growInput();
  input.focus();
}

function headerForChat() {
  const title = (app.session && app.session.title) || "New session";
  // Desktop chat has no top bar. The name is the sidebar row. Plan and context sit by the composer.
  if (isDesktop() && route().name === "chat") {
    top.replaceChildren();
    paintChatStatus();
    if (app.sessionId) paintContext(app.sessionId);
    paintPlus();
    return;
  }
  header(title, isDesktop() ? {} : { left: [backButton()] });
  planBadge();
  if (app.sessionId) paintContext(app.sessionId);
  paintPlus();
}

function paintChatStatus() {
  const box = document.getElementById("chat-meta");
  if (!box) return;
  const pill = box.querySelector(".ctx");
  const show = isDesktop() && route().name === "chat";
  box.replaceChildren();
  if (show && pill) box.append(pill);
  box.hidden = !show || box.childElementCount === 0;
}

function subTier(type, name) {
  const t = String(type || "");
  const n = String(name || "");
  if (/(^|:)ultra-|^grok-deck-ultra:/.test(t) || /^ultra\b/i.test(n)) return "ultra";
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
    const pill = contextPill(u.context);
    if (isDesktop() && route().name === "chat") {
      const box = document.getElementById("chat-meta");
      if (!box) return;
      box.querySelector(".ctx")?.remove();
      box.hidden = false;
      box.append(pill);
      return;
    }
    top.querySelector(".ctx")?.remove();
    top.querySelector("h1")?.after(pill);
  } catch {
    // The meter is optional.
  }
}

function planBadge() {
  top.querySelector(".badge.plan")?.remove();
  paintChatStatus();
}

function backButton() {
  const el = button("", () => go("/"), "back");
  el.append(lineIcon("back"));
  el.setAttribute("aria-label", "Back to sessions");
  return el;
}

async function renderChat(token, id) {
  paintLongRun(null);
  if (app.sessionId !== id) app.justDone = false;
  noteRoute("chat:" + id);
  const chatMeta = document.getElementById("chat-meta");
  if (chatMeta) {
    chatMeta.hidden = true;
    chatMeta.replaceChildren();
  }
  closeStream();
  app.sessionId = id;
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
  paintOptbar();
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

async function sendPrompt(prompt, images, files) {
  const where = route();
  const body = { prompt };
  if (images && images.length) body.images = images;
  if (files && files.length) body.files = files;
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
  const files = readyFiles();
  if (filesBusy()) {
    setNotice("Wait for the files to finish uploading.");
    return;
  }
  if (/^\/loops?(\s|$)/i.test(prompt) && !images.length && !files.length) {
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
    if (!prompt && !images.length && !files.length) return;
    app.sending = true;
    try {
      const body = { prompt, images, files, model: app.session?.model, effort: app.session?.effort, permissionMode: app.session?.permissionMode, ultra: !!app.session?.ultra };
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
  if (!prompt && !images.length && !files.length) {
    setNotice("Write a message or attach a file.");
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
    await sendPrompt(prompt, images, files);
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
// Grok's ask_user_question: one card, a button per option, a text field for "Other", and Send. A single question with
// one choice answers on the tap. The answer goes back to the agent exactly as given; Skip tells it the user declined.
function paintQuestionCard(node, message) {
  const key = message.status + "|" + app.running;
  if (node._key === key) return;
  node._key = key;
  const waiting = message.status === "waiting" && app.running;
  node.classList.toggle("asking", waiting);
  node.classList.toggle("answered", message.status === "answered");
  node.replaceChildren();
  const head = document.createElement("div");
  head.className = "q-head";
  head.textContent = waiting
    ? (message.from ? message.from + " asks" : "Grok asks")
    : message.status === "answered" ? "You answered" : message.status === "cancelled" && message.by === "user" ? "You skipped this" : "Not answered";
  node.append(head);
  const questions = message.questions || [];
  const picked = questions.map(() => new Set());
  const typed = questions.map(() => "");
  const block = [];
  questions.forEach((q, qi) => {
    const wrap = document.createElement("div");
    wrap.className = "q-block";
    const text = document.createElement("div");
    text.className = "q-text";
    text.textContent = q.question;
    wrap.append(text);
    if (!waiting) {
      if (message.status === "answered") {
        const answer = document.createElement("div");
        answer.className = "q-answer";
        const given = (message.answers || [])[qi];
        answer.textContent = Array.isArray(given) ? given.join(", ") : String(given ?? "");
        wrap.append(answer);
      }
      node.append(wrap);
      return;
    }
    const opts = document.createElement("div");
    opts.className = "q-opts";
    opts.setAttribute("role", "group");
    opts.setAttribute("aria-label", q.question);
    const optButtons = [];
    for (const option of q.options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "q-opt";
      b.setAttribute("aria-pressed", "false");
      const mark = document.createElement("span");
      mark.className = "q-mark";
      mark.append(lineIcon("check"));
      const words = document.createElement("span");
      words.className = "q-words";
      const label = document.createElement("span");
      label.className = "q-label";
      label.textContent = option.label;
      words.append(label);
      if (option.description && option.description !== option.label) {
        const d = document.createElement("span");
        d.className = "q-desc";
        d.textContent = option.description;
        words.append(d);
      }
      b.append(mark, words);
      b.addEventListener("click", () => {
        if (q.multiSelect) {
          if (picked[qi].has(option.label)) picked[qi].delete(option.label);
          else picked[qi].add(option.label);
        } else {
          picked[qi].clear();
          picked[qi].add(option.label);
          typed[qi] = "";
          other.value = "";
        }
        paint();
        if (questions.length === 1 && !q.multiSelect) send();
      });
      optButtons.push([b, option.label]);
      opts.append(b);
    }
    const other = document.createElement("input");
    other.type = "text";
    other.className = "q-other";
    other.placeholder = "Other";
    other.setAttribute("aria-label", "Other answer for: " + q.question);
    other.autocomplete = "off";
    other.addEventListener("input", () => {
      typed[qi] = other.value;
      if (!q.multiSelect && other.value.trim()) picked[qi].clear();
      paint();
    });
    other.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && ready()) {
        event.preventDefault();
        send();
      }
    });
    wrap.append(opts, other);
    block.push(() => {
      for (const [b, label] of optButtons) b.setAttribute("aria-pressed", picked[qi].has(label) ? "true" : "false");
    });
    node.append(wrap);
  });
  if (!waiting) return;
  const values = () => questions.map((q, qi) => {
    const list = [...picked[qi]];
    if (typed[qi].trim()) list.push(typed[qi].trim());
    return q.multiSelect ? list : list[0] || "";
  });
  const ready = () => values().every((v) => (Array.isArray(v) ? v.length : !!v));
  const row = document.createElement("div");
  row.className = "q-actions";
  let sending = false;
  const submit = async (body) => {
    if (sending) return;
    sending = true;
    for (const b of node.querySelectorAll("button, input")) b.disabled = true;
    try {
      await api("/api/sessions/" + app.sessionId + "/question", { method: "POST", body: JSON.stringify({ reqId: message.reqId, ...body }) });
    } catch (error) {
      if (error.status === 409) {
        row.replaceChildren();
        const done = document.createElement("p");
        done.className = "perm-note";
        done.textContent = "Already answered on another device.";
        row.append(done);
        return;
      }
      sending = false;
      for (const b of node.querySelectorAll("button, input")) b.disabled = false;
      paint();
      if (!error.auth) setNotice(error.message);
    }
  };
  const send = () => ready() && submit({ answers: values() });
  const sendBtn2 = button("Send answer", send, "primary q-send");
  const skip = button("Skip", () => submit({ cancel: true }), "revise q-skip");
  row.append(skip, sendBtn2);
  node.append(row);
  function paint() {
    for (const fn of block) fn();
    sendBtn2.disabled = !ready() || sending;
  }
  paint();
}

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
        paintOptbar();
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
    headerNewBadge();
    paintOptbar();
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

function currentModeState() {
  if (route().name === "chat") return { plan: !!app.session?.plan, longRun: app.longRun, loops: app.loops || [] };
  return { plan: !!app.draft.plan, longRun: !!app.draft.longRun, loops: [] };
}

function currentReasoningState() {
  const src = route().name === "chat" ? (app.session || {}) : app.draft;
  return { effort: src.effort, ultra: !!src.ultra, model: src.model };
}

// One icon set: 18px grid, 1.5px round stroke, drawn in currentColor. Every icon in the app comes from here.
function gearPath() {
  const points = [];
  for (let i = 0; i < 8; i++) {
    const centre = (i * 45 * Math.PI) / 180;
    for (const [turn, radius] of [[-13, 5.3], [-8, 7.4], [8, 7.4], [13, 5.3]]) {
      const angle = centre + (turn * Math.PI) / 180;
      points.push((9 + radius * Math.cos(angle)).toFixed(2) + " " + (9 + radius * Math.sin(angle)).toFixed(2));
    }
  }
  return "M" + points.join("L") + "Z";
}

const ICON_PATHS = {
  cog: [gearPath(), "M11.3 9a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z"],
  trash: ["M3 5h12", "M7 5V3.5h4V5", "M4.5 5l.7 9.5h7.6l.7-9.5", "M7.5 8v4.5", "M10.5 8v4.5"],
  check: ["M4 9.5 7.5 13 14 5.5"],
  back: ["M10.5 4.5 6 9l4.5 4.5"],
  photo: ["M4.5 3.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z", "M3.5 12.5 7 9l3 3 2-2 2.5 2.5", "M11.75 7a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"],
  archive: ["M3 4.5h12v3H3Z", "M4 7.5V14h10V7.5", "M7.5 10.5h3"],
  bell: ["M9 2.5a4 4 0 0 0-4 4V10l-1.5 2.5h11L13 10V6.5a4 4 0 0 0-4-4Z", "M7.5 14.5a1.6 1.6 0 0 0 3 0"],
  shield: ["M9 2.5l5 2v4.2c0 3-2.1 5.2-5 6.3-2.9-1.1-5-3.3-5-6.3V4.5Z", "M6.8 9l1.7 1.7 2.9-3.1"],
  approve: ["M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z", "M6.5 9l2 2 3.5-4"],
  bolt: ["M10 2.5 4.5 10H9l-1 5.5L13.5 8H9Z"],
  chat: ["M3.5 4.5h11v7h-6l-3 2.5v-2.5h-2Z"],
  plan: ["M4.5 4.5h9v10h-9Z", "M7 3.5h4v2H7Z", "M7 9h4", "M7 11.75h2.5"],
  clock: ["M9 15.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Z", "M9 5.5V9l2.5 1.5"],
  repeat: ["M3.5 8V7a2 2 0 0 1 2-2h8", "M11.5 3l2 2-2 2", "M14.5 10v1a2 2 0 0 1-2 2h-8", "M6.5 15l-2-2 2-2"],
  level: ["M4 14.5v-3", "M7.5 14.5v-6", "M11 14.5v-9", "M14.5 14.5v-12"],
  chevron: ["M5.5 7.5 9 11l3.5-3.5"],
  plus: ["M9 3.5v11", "M3.5 9h11"],
  x: ["M5 5l8 8", "M13 5l-8 8"],
  minus: ["M5 9h8"],
  progress: ["M9 3.5a5.5 5.5 0 1 0 5.5 5.5"],
  more: ["M4.5 9.9a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z", "M9 9.9a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z", "M13.5 9.9a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8Z"],
  sparkle: ["M9 2.5l1.6 4.9 4.9 1.6-4.9 1.6L9 15.5l-1.6-4.9L2.5 9l4.9-1.6Z"],
  moon: ["M14.5 10.5A6 6 0 0 1 7.5 3.5a6 6 0 1 0 7 7Z"],
  file: ["M5 2.5h5.5L14 6v9.5H5Z", "M10.5 2.5V6H14"],
  doc: ["M5 2.5h5.5L14 6v9.5H5Z", "M10.5 2.5V6H14", "M7 9.5h5", "M7 12h5"],
  code: ["M7 5 3.5 9 7 13", "M11 5l3.5 4L11 13"],
  video: ["M3 5h8.5v8H3Z", "M11.5 8l3.5-2v6l-3.5-2"],
  audio: ["M7.5 13V4.5l6-1.5V11.5", "M5.75 15a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z", "M11.75 13.5a1.75 1.75 0 1 0 0-3.5 1.75 1.75 0 0 0 0 3.5Z"],
  expand: ["M10.5 3.5h4v4", "M14.5 3.5 10 8", "M7.5 14.5h-4v-4", "M3.5 14.5 8 10"],
  download: ["M9 3v8.5", "M5.5 8.5 9 12l3.5-3.5", "M3.5 14.5h11"],
  sun: ["M9 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M9 2v1.5M9 14.5V16M2 9h1.5M14.5 9H16M4.1 4.1l1 1M12.9 12.9l1 1M13.9 4.1l-1 1M5.1 12.9l-1 1"],
};

function lineIcon(name) {
  // level1..level4 are the same four bars; the ones above the level are dimmed.
  const level = /^level([1-4])$/.exec(name);
  const svg = svgEl("svg", { viewBox: "0 0 18 18", class: "ico", "aria-hidden": "true" });
  (ICON_PATHS[level ? "level" : name] || []).forEach((d, i) => {
    const path = svgEl("path", { d });
    if (level && i >= Number(level[1])) path.setAttribute("class", "dim");
    svg.append(path);
  });
  return svg;
}

function cogIcon() {
  return lineIcon("cog");
}

attachBtn.replaceChildren(lineIcon("plus"));

function appSettingsButton() {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "icon-btn";
  el.setAttribute("aria-label", "App settings");
  el.append(cogIcon());
  el.addEventListener("click", () => openAppSettings());
  return el;
}

function openAppSettings() {
  const { panel, body } = settingsSheet("App settings");
  body.append(
    settingsGroup("Appearance", appearanceControl()),
    themeGroup(),
    settingsGroup("Skeptical review", skepticDefaultsBlock()),
    settingsGroup("Notifications", notifyBlock()),
    button("Log out", logout, "wide")
  );
  setsheet.replaceChildren(panel);
  setsheet.hidden = false;
  panel.scrollTop = 0;
}

function paintOptbar() {
  const bar = document.getElementById("optbar");
  if (!bar) return;
  const where = route().name;
  if (where !== "chat" && where !== "new") {
    bar.hidden = true;
    return;
  }
  const mode = modeChoice(currentModeState());
  const state = currentReasoningState();
  const reason = reasoningChoice(state);
  const reasonParts = reasoningChipParts(reason.id, state.model);
  const reasonText = reasonParts.model + " " + reasonParts.effort;
  let cog = bar.querySelector(".opt-cog");
  let modeBtn = bar.querySelector("[data-mode]");
  let reasonBtn = bar.querySelector("[data-reasoning]");
  let reviewBtn = bar.querySelector("[data-review]");
  if (!cog || !modeBtn || !reasonBtn || !reviewBtn) {
    bar.replaceChildren();
    cog = document.createElement("button");
    cog.type = "button";
    cog.className = "opt-cog";
    cog.setAttribute("aria-label", "Session settings");
    cog.append(cogIcon());
    cog.addEventListener("click", (event) => openSettingsMenu(event.currentTarget));
    modeBtn = document.createElement("button");
    modeBtn.type = "button";
    modeBtn.className = "opt-chip";
    modeBtn.addEventListener("click", (event) => openModeSheet(event.currentTarget));
    reasonBtn = document.createElement("button");
    reasonBtn.type = "button";
    reasonBtn.className = "opt-chip";
    reasonBtn.addEventListener("click", (event) => openReasoningSheet(event.currentTarget));
    reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "opt-chip";
    reviewBtn.addEventListener("click", () => chooseReview(!reasoningChoice(currentReasoningState()).ultra));
    bar.append(cog, modeBtn, reasonBtn, reviewBtn);
  }
  bar.hidden = false;
  modeBtn.dataset.mode = mode.id;
  modeBtn.textContent = mode.label;
  modeBtn.setAttribute("aria-label", "Mode, " + mode.label);
  reasonBtn.dataset.reasoning = reason.id;
  let modelEl = reasonBtn.querySelector(".opt-model");
  let effortEl = reasonBtn.querySelector(".opt-effort");
  if (!modelEl || !effortEl) {
    reasonBtn.replaceChildren();
    modelEl = document.createElement("span");
    modelEl.className = "opt-model";
    effortEl = document.createElement("span");
    effortEl.className = "opt-effort";
    reasonBtn.append(modelEl, effortEl);
  }
  modelEl.textContent = reasonParts.model + " ";
  effortEl.textContent = reasonParts.effort;
  reasonBtn.setAttribute("aria-label", "Reasoning, " + reasonText);
  reasonBtn.removeAttribute("title");
  reviewBtn.dataset.review = reason.ultra ? "on" : "off";
  reviewBtn.textContent = "Deep";
  reviewBtn.setAttribute("aria-pressed", reason.ultra ? "true" : "false");
  reviewBtn.setAttribute("aria-label", "Deep mode");
  reviewBtn.title = REVIEW_HELP;
  markOptbarScroll();
}

// The chip strip scrolls inside its own box when the row is short (a phone with Send now showing);
// a fade on the clipped side says there is more.
function markOptbarScroll() {
  const bar = document.getElementById("optbar");
  if (!bar || bar.hidden) return;
  const more = [];
  if (bar.scrollLeft > 1) more.push("start");
  if (bar.scrollWidth - bar.scrollLeft - bar.clientWidth > 1) more.push("end");
  const value = more.join(" ");
  if ((bar.dataset.more || "") !== value) bar.dataset.more = value;
}
{
  const bar = document.getElementById("optbar");
  bar?.addEventListener("scroll", markOptbarScroll, { passive: true });
  if (bar && "ResizeObserver" in window) new ResizeObserver(markOptbarScroll).observe(bar);
}

// The cog: Dark and Light apply at once; the rest of a session's settings open in the full panel.
function openSettingsMenu(anchor) {
  const dark = (document.documentElement.dataset.appearance || "dark") !== "light";
  openSheet([
    { label: "Dark", icon: "moon", selected: dark, run: () => { closeSheet(); chooseAppearance("dark"); } },
    { label: "Light", icon: "sun", selected: !dark, run: () => { closeSheet(); chooseAppearance("light"); } },
    { label: "Session settings", icon: "cog", run: () => { closeSheet(); if (route().name === "chat") openSettings(); else openDraftSettings(); } },
  ], anchor);
}

function openDraftSettings() {
  const { panel, body } = settingsSheet("Session settings");
  const prefs = prefsBlock(app.draft, (next) => {
    app.draft.model = next.model;
    app.draft.permissionMode = next.permissionMode;
    setBanner(next.permissionMode);
  }, { cwdEditable: false });
  const fields = [...prefs.querySelectorAll(":scope > .field")];
  const labeled = (name) => fields.find((el) => el.firstChild && el.firstChild.textContent === name);
  const themeGrid = themePicker(app.draft.theme || "", (id) => {
    app.draft.theme = id;
  });
  const note = document.createElement("p");
  note.className = "mode-note";
  note.textContent = "Context use appears after the first turn.";
  body.append(
    settingsGroup("Appearance", appearanceControl()),
    settingsGroup("Theme", themeGrid),
    settingsGroup("Model", bareField(labeled("Model"), "Model")),
    settingsGroup("Approvals", bareField(labeled("Permission"), "Permission"), prefs.querySelector(":scope > .mode-note")),
    settingsGroup("Context", note)
  );
  setsheet.replaceChildren(panel);
  setsheet.hidden = false;
  panel.scrollTop = 0;
}

function openModeSheet(anchor) {
  const current = modeChoice(currentModeState());
  const options = [
    ["normal", "Normal", "chat"],
    ["plan", "Plan", "plan"],
    ["long", "Long run", "clock"],
    ["loops", "Loops", "repeat"],
  ];
  openSheet(options.map(([id, label, icon]) => ({ label, icon, selected: current.id === id, run: () => chooseMode(id) })), anchor);
}

function openReasoningSheet(anchor) {
  const current = reasoningChoice(currentReasoningState());
  const options = [["low", "Low", "level1"], ["medium", "Medium", "level2"], ["high", "High", "level3"], ["xhigh", "Extra high", "level4"]];
  openSheet([
    ...options.map(([id, label, icon]) => ({ label, icon, selected: current.id === id, run: () => chooseReasoning(id) })),
  ], anchor);
}

async function saveReasoning(next) {
  closeSheet();
  if (route().name !== "chat") {
    if (next.effort != null) app.draft.effort = next.effort;
    if (next.ultra != null) app.draft.ultra = next.ultra;
    paintOptbar();
    return;
  }
  try {
    const saved = await api("/api/sessions/" + app.sessionId, { method: "PATCH", body: JSON.stringify(next) });
    app.session = saved.session;
    syncSettingsUi();
  } catch (error) {
    if (!error.auth) setNotice(error.message);
  }
}

function chooseReasoning(id) {
  const current = reasoningChoice(currentReasoningState());
  return saveReasoning(applyReasoning(id, { review: current.ultra }));
}

function chooseReview(on) {
  return saveReasoning(applyReview(on));
}

async function chooseMode(id) {
  closeSheet();
  if (id === "loops") {
    await openLoops();
    return;
  }
  if (id === "long") {
    await chooseLongRun();
    return;
  }
  const on = id === "plan";
  if (route().name !== "chat") {
    app.draft.plan = on;
    app.draft.longRun = false;
    headerNewBadge();
    paintOptbar();
    return;
  }
  if (longRunActive(app.longRun)) {
    const stopped = await longRunAction("stop");
    if (!stopped) return;
  }
  await setPlan(on);
}

function openDraftHours() {
  const form = document.createElement("form");
  form.className = "sheet-form";
  const hours = document.createElement("input");
  hours.type = "number";
  hours.min = "0.5";
  hours.max = "48";
  hours.step = "0.5";
  hours.value = String(app.draft.longHours || 12);
  hours.setAttribute("aria-label", "Long run hours");
  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Set budget";
  form.append(hours, save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    app.draft.longHours = Number(hours.value) || 12;
    closeSheet();
    setNotice("Long run starts with your first message. Budget is " + app.draft.longHours + " hours.");
    paintOptbar();
  });
  openSheet([
    { text: "Long run starts with your first message. The budget is the number of hours below.", info: true },
    { node: form },
  ]);
}

function openLongStart() {
  const form = document.createElement("form");
  form.className = "sheet-form";
  const goal = document.createElement("input");
  goal.placeholder = "Goal";
  goal.setAttribute("aria-label", "Long run goal");
  const hours = document.createElement("input");
  hours.type = "number";
  hours.min = "0.5";
  hours.max = "48";
  hours.step = "0.5";
  hours.value = "12";
  hours.setAttribute("aria-label", "Long run hours");
  const start = document.createElement("button");
  start.type = "submit";
  start.textContent = "Start";
  form.append(goal, hours, start);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = goal.value.trim();
    const n = Number(hours.value) || 12;
    if (!text) {
      setNotice("Enter a goal for the long run.");
      return;
    }
    closeSheet();
    if (app.session?.plan) await setPlan(false);
    await longRunAction("start", { goal: text, hours: n });
  });
  openSheet([
    { text: "A long run keeps going until the goal is done or the time budget ends.", info: true },
    { node: form },
  ]);
}

function openLongStatus() {
  openSheet([
    { text: "This session is already in a long run.", info: true },
    { label: "Stop long run", danger: true, run: async () => { closeSheet(); await longRunAction("stop"); } },
  ]);
}

async function chooseLongRun() {
  if (route().name !== "chat") {
    app.draft.plan = false;
    app.draft.longRun = true;
    if (!app.draft.longHours) app.draft.longHours = 12;
    headerNewBadge();
    paintOptbar();
    setNotice("Long run starts with your first message. Budget is " + (app.draft.longHours || 12) + " hours.");
    openDraftHours();
    return;
  }
  const lr = app.longRun;
  if (lr && lr.status === "running") {
    openLongStatus();
    return;
  }
  if (lr && ["paused", "stalled", "blocked"].includes(lr.status)) {
    if (app.session?.plan) await setPlan(false);
    await longRunAction("resume");
    return;
  }
  openLongStart();
}

// One action slot: Send (idle), Stop (running + empty), Send now (running + content).
// "Send next" stays on form submit / desktop Enter, not on this button.
function paintSend() {
  const chat = route().name === "chat";
  const hasContent = hasComposerContent(input.value, app.images.length + app.files.length);
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
    const steer = app.longRun?.status === "running" && !item.loop;
    tag.textContent = item.now ? (steer ? "Steering" : "Sending") : index === 0 ? (steer ? "Steers next" : "Next") : "#" + (index + 1);
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
    const grid = document.createElement("div");
    grid.className = "usage-grid";
    for (const [k, v] of parts) {
      const cell = document.createElement("div");
      cell.innerHTML = "<b></b><small></small>";
      cell.querySelector("b").textContent = v;
      cell.querySelector("small").textContent = k;
      grid.append(cell);
    }
    box.append(grid);
  } catch (error) {
    if (!error.auth) box.textContent = "Usage unavailable.";
  }
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

// Deleting a session: swipe a phone row, the trash button on a desktop row, or the + menu. One confirm for all three.
// The server moves the folder to data/trash and refuses a running session, so the confirm says that up front.
const confirmBox = document.getElementById("confirm");

function closeConfirm() {
  confirmBox.hidden = true;
  confirmBox.querySelector(".confirm-panel").replaceChildren();
}

function openConfirm({ title, text, label, danger, run, cancel = "Cancel" }) {
  const panel = confirmBox.querySelector(".confirm-panel");
  panel.setAttribute("aria-label", title);
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("p");
  body.textContent = text;
  const actions = document.createElement("div");
  actions.className = "confirm-actions";
  if (run) {
    const go = button(label, async () => {
      closeConfirm();
      await run();
    }, "confirm-go" + (danger ? " danger" : " primary"));
    actions.append(go);
  }
  actions.append(button(cancel, () => closeConfirm(), "confirm-cancel"));
  panel.replaceChildren(heading, body, actions);
  confirmBox.hidden = false;
  actions.querySelector("button").focus();
}

confirmBox.addEventListener("click", (event) => {
  if (event.target === confirmBox) closeConfirm();
});

async function deleteSession(id) {
  try {
    await api("/api/sessions/" + id, { method: "DELETE", body: "{}" });
  } catch (error) {
    if (!error.auth) setNotice(error.message);
    return;
  }
  app.sessions = (app.sessions || []).filter((session) => session.id !== id);
  const where = route();
  if (where.name === "chat" && where.id === id) go("/");
  else if (where.name === "list" && !isDesktop()) renderList(++app.gen);
  if (isDesktop()) renderSide();
}

function askDeleteSession(session) {
  const name = (session && session.title) || "New session";
  const running = !!(session && (session.running || (session.id === app.sessionId && app.running)));
  if (running) {
    openConfirm({
      title: "Stop it first",
      text: "“" + name + "” is running. Stop the turn, then delete the session.",
      cancel: "OK",
    });
    return;
  }
  openConfirm({
    title: "Delete “" + name + "”?",
    text: "It moves to Grok Deck's trash and leaves the list.",
    label: "Delete",
    danger: true,
    run: () => deleteSession(session.id),
  });
}

function confirmDelete(id) {
  const known = (app.sessions || []).find((session) => session.id === id);
  askDeleteSession({ ...(app.session || {}), ...(known || {}), id });
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
  if (!st.ok) return { label: "Enable notifications", icon: "bell", run: () => { closeSheet(); setNotice(st.why); } };
  let sub = null;
  try {
    if (st.perm === "granted") sub = await Promise.race([currentSubscription(), new Promise((r) => setTimeout(() => r(null), 800))]);
  } catch {
    sub = null;
  }
  if (sub) return { label: "Notifications on · Turn off", icon: "bell", run: () => { closeSheet(); disableNotifications(); } };
  return { label: "Enable notifications", icon: "bell", run: () => { closeSheet(); enableNotifications(); } };
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
  skillsOpen = false;
  sheet.hidden = true;
  sheetPanel.replaceChildren();
  sheetPanel.removeAttribute("style");
}

sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeSheet();
});

async function menuItems() {
  const chat = route().name === "chat";
  const items = [
    { label: "Add photo", icon: "photo", run: () => { closeSheet(); photos.click(); } },
    { label: "Choose file", icon: "file", run: () => { closeSheet(); filePick.click(); } },
    { label: "Skills", icon: "sparkle", run: () => openSkills("", attachBtn) },
  ];
  if (chat) {
    const waiting = main.querySelector(".toolcard.asking, .qcard.asking");
    if (waiting && app.running) items.unshift({ label: "Go to approval", icon: "approve", accent: true, run: () => { closeSheet(); waiting.scrollIntoView({ block: "center", behavior: "smooth" }); } });
    items.push(skepticMenuRow());
    if (activeAuto().length) items.push({ label: "Auto approve on · Turn off", icon: "bolt", accent: true, run: () => { closeSheet(); setAuto([]); } });
    if (app.bypass) items.push({ text: "Always approve is on for this session. Change it in Session settings.", info: true });
  }
  items.push(await notifyItem());
  if (chat) {
    const archived = !!app.session?.archived;
    items.push({ label: archived ? "Unarchive session" : "Archive session", icon: "archive", run: () => archiveSession(app.sessionId, !archived) });
    items.push({ label: "Delete session", icon: "trash", danger: true, run: () => { closeSheet(); confirmDelete(app.sessionId); } });
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

function loopCreateForm() {
  const form = document.createElement("form");
  form.className = "sheet-form";
  const interval = document.createElement("input");
  interval.placeholder = "30m";
  interval.setAttribute("aria-label", "Loop interval");
  interval.autocomplete = "off";
  interval.spellcheck = false;
  const prompt = document.createElement("input");
  prompt.placeholder = "Prompt";
  prompt.setAttribute("aria-label", "Loop prompt");
  const create = document.createElement("button");
  create.type = "submit";
  create.className = "primary";
  create.textContent = "Create";
  form.append(interval, prompt, create);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const every = interval.value.trim();
    const text = prompt.value.trim();
    if (!every || !text) {
      setNotice("Enter an interval and a prompt.");
      return;
    }
    const saved = input.value;
    try {
      await sendLoopCommand("/loop " + every + " " + text);
      input.value = saved;
      growInput();
      paintSend();
      await openLoops();
    } catch (error) {
      input.value = saved;
      growInput();
      paintSend();
      if (!error.auth) setNotice(error.message);
    }
  });
  return form;
}

async function openLoops() {
  if (route().name !== "chat" || !app.sessionId) {
    setNotice("Loops run in an existing session. Send a first message, then create a loop.");
    return;
  }
  try {
    const data = await api("/api/sessions/" + app.sessionId + "/loops");
    app.loops = data.loops || [];
  } catch {
    // show what we have
  }
  const items = [{ node: loopCreateForm() }];
  if (!app.loops.length) items.push({ text: "No loops yet. Set an interval and a prompt above (5 min minimum). Add x10 for at most 10 runs, or until DONE to stop when the reply says DONE.", info: true });
  for (const l of app.loops) {
    items.push({ text: loopSummary(l), info: true });
    if (l.status === "active") items.push({ label: "Pause", run: () => loopAction(l.id, "pause") });
    else items.push({ label: "Resume", accent: true, run: () => loopAction(l.id, "resume") });
    items.push({ label: "Delete loop", danger: true, run: () => loopAction(l.id, "delete") });
  }
  openSheet(items);
  paintOptbar();
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
  paintOptbar();
  return true;
}

// One popover for every composer menu (+, Mode, Reasoning, settings) and the session menu on a desktop row. It floats
// above the button that opened it, on the phone and on desktop, and clamps to the screen. Outside tap or Esc closes it.
// An item is { label, icon, run, selected, danger, accent }, { text, info } for a caption, or { node } for a form.
let sheetAnchor = null;

// Skills are Grok's own list (name and one-line description; the full SKILL.md loads only when used).
// Typing / at the start of the field filters it; a pick puts "/name " in the field, sent to Grok as typed.
let skillsOpen = false;
let skillList = null;

async function loadSkills() {
  const key = app.sessionId || "";
  if (skillList?.key === key) return skillList;
  try {
    const data = await api("/api/skills" + (key ? "?session=" + key : ""));
    skillList = { key, skills: data.skills || [], credit: data.credit || "" };
  } catch {
    skillList = { key, skills: [], credit: "" };
  }
  return skillList;
}

function slashQuery() {
  const m = /^\/(\S*)$/.exec(input.value);
  return m ? m[1].toLowerCase() : null;
}

function matchingSkills(skills, query) {
  const q = query || "";
  const hit = skills.filter((s) => s.name.toLowerCase().includes(q));
  return q ? [...hit.filter((s) => s.name.toLowerCase().startsWith(q)), ...hit.filter((s) => !s.name.toLowerCase().startsWith(q))] : hit;
}

function pickSkill(skill) {
  closeSheet();
  input.value = "/" + skill.name + " ";
  input.focus();
  growInput();
  paintSend();
}

async function openSkills(query, anchor) {
  const { skills, credit } = await loadSkills();
  const shown = matchingSkills(skills, query);
  const row = (s) => ({ label: "/" + s.name, detail: s.description, icon: "sparkle", run: () => pickSkill(s) });
  const items = query ? [] : [{ text: "Grok reads a skill only when a task calls for it or you send /name.", info: true }];
  const pstack = shown.filter((s) => s.source === "pstack");
  const other = shown.filter((s) => s.source !== "pstack");
  if (pstack.length) items.push({ text: credit, info: true }, ...pstack.map(row));
  if (other.length) items.push({ text: "Other skills", info: true }, ...other.map(row));
  if (!shown.length) items.push({ text: skills.length ? "No skill matches /" + query + "." : "No skills loaded.", info: true });
  // The list may arrive after the field changed; only the latest query paints.
  if (anchor === input && slashQuery() !== query) return;
  await openSheet(items, anchor);
  skillsOpen = true;
  return shown;
}

function menuRow(item) {
  const el = button("", item.run, "sheet-item" + (item.danger ? " danger" : "") + (item.accent ? " accent" : ""));
  if (item.title) el.title = item.title;
  el.setAttribute("role", item.selected === undefined ? "menuitem" : "menuitemradio");
  if (item.selected !== undefined) el.setAttribute("aria-checked", item.selected ? "true" : "false");
  if (item.icon) el.append(lineIcon(item.icon));
  const label = document.createElement("span");
  label.className = "sheet-label";
  label.textContent = item.label;
  if (item.detail) {
    const detail = document.createElement("small");
    detail.className = "sheet-detail";
    detail.textContent = item.detail;
    label.append(detail);
  }
  el.append(label);
  if (item.selected) {
    const mark = lineIcon("check");
    mark.classList.add("sheet-check");
    el.append(mark);
  }
  return el;
}

function placePopover() {
  if (sheet.hidden) return;
  const margin = 8;
  const vv = window.visualViewport;
  const width = Math.round(vv?.width || window.innerWidth);
  const top = Math.round(vv?.offsetTop || 0);
  const height = Math.round(vv?.height || window.innerHeight);
  const box = Math.min(320, width - margin * 2);
  sheetPanel.style.width = box + "px";
  sheetPanel.style.maxHeight = "";
  const anchor = sheetAnchor && sheetAnchor.isConnected ? sheetAnchor.getBoundingClientRect() : null;
  if (!anchor) {
    sheetPanel.style.left = Math.round((width - box) / 2) + "px";
    sheetPanel.style.bottom = "auto";
    sheetPanel.style.maxHeight = height - margin * 2 + "px";
    sheetPanel.style.top = Math.round(top + height - sheetPanel.getBoundingClientRect().height - margin) + "px";
    return;
  }
  const above = anchor.top - top - margin * 2;
  const below = top + height - anchor.bottom - margin * 2;
  const wanted = sheetPanel.scrollHeight;
  const up = above >= Math.min(wanted, 360) || above >= below;
  sheetPanel.style.left = Math.round(Math.min(Math.max(anchor.left, margin), width - box - margin)) + "px";
  // Placed by top only: no viewport height is read, so a stale innerHeight on iOS cannot misplace it.
  sheetPanel.style.bottom = "auto";
  sheetPanel.style.maxHeight = Math.max(120, up ? above : below) + "px";
  sheetPanel.style.top = Math.round(up ? anchor.top - sheetPanel.getBoundingClientRect().height - margin : anchor.bottom + margin) + "px";
}

async function openSheet(items, anchor) {
  const list = items || (await menuItems());
  if (anchor) sheetAnchor = anchor;
  sheetPanel.replaceChildren();
  for (const item of list) {
    if (item.node) {
      sheetPanel.append(item.node);
    } else if (item.info) {
      const p = document.createElement("p");
      p.className = "sheet-info";
      p.textContent = item.text;
      sheetPanel.append(p);
    } else {
      sheetPanel.append(menuRow(item));
    }
  }
  sheet.hidden = false;
  placePopover();
}

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!confirmBox.hidden) closeConfirm();
  else if (!sheet.hidden) closeSheet();
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
  // Enter in the / picker takes the best match instead of sending a half-typed name.
  if (skillsOpen && slashQuery() !== null && skillList) {
    const best = matchingSkills(skillList.skills, slashQuery())[0];
    if (best) {
      event.preventDefault();
      pickSkill(best);
      return;
    }
  }
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
  const query = slashQuery();
  if (query !== null) openSkills(query, input);
  else if (skillsOpen) closeSheet();
});

attachBtn.addEventListener("click", () => openSheet(undefined, attachBtn));

photos.addEventListener("change", () => {
  const files = [...(photos.files || [])];
  photos.value = "";
  addFiles(files);
});

filePick.addEventListener("change", () => {
  const files = [...(filePick.files || [])];
  filePick.value = "";
  addFiles(files);
});

const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");

document.addEventListener("paste", (event) => {
  if (composer.hidden) return;
  const items = [...(event.clipboardData?.items || [])];
  const files = items.filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  addFiles(files);
});

composer.addEventListener("dragover", (event) => {
  if (hasFiles(event)) event.preventDefault();
});

composer.addEventListener("drop", (event) => {
  const files = [...(event.dataTransfer?.files || [])];
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
  const files = readyFiles();
  if (filesBusy()) {
    setNotice("Wait for the files to finish uploading.");
    return;
  }
  if (!prompt && !images.length && !files.length) return;
  if (/^\/loops?(\s|$)/i.test(prompt) && !images.length && !files.length) {
    composer.requestSubmit(); // a /loop command never interrupts the running turn
    return;
  }
  app.sending = true;
  sendBtn.disabled = true;
  try {
    const body = {
      prompt,
      images,
      files,
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
  if (!hasComposerContent(input.value, app.images.length + app.files.length)) stopTurn();
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

const docview = document.getElementById("docview");
async function copyCodeClick(event) {
  const copy = event.target.closest(".copy");
  if (!copy) return;
  const code = copy.parentElement.querySelector("code");
  if (!code) return;
  const ok = await copyText(code.textContent || "");
  flashCopied(copy);
  if (!ok) copy.setAttribute("aria-label", "Copy failed");
}
main.addEventListener("click", copyCodeClick);
docview.addEventListener("click", copyCodeClick);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (route().name === "chat") recheckMissing(main, true);
  if (document.querySelector(".plan-usage") && Date.now() - planAt >= PLAN_MS) notePlanUsageStale();
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

// A stored image that cannot load (the store file is gone) becomes the same card as a missing source.
document.addEventListener("error", (event) => {
  const img = event.target;
  if (!(img instanceof HTMLImageElement) || !img.closest(".md-shot")) return;
  const card = document.createElement("span");
  card.className = "md-missing";
  const title = document.createElement("span");
  title.className = "md-missing-title";
  title.textContent = "Image moved or deleted";
  const name = document.createElement("span");
  name.className = "md-missing-name";
  name.textContent = img.alt || "";
  card.append(title, name);
  img.closest(".md-shot").replaceWith(card);
}, true);

// The full-screen view of a document, code file or PDF a message links to.
function closeDoc() {
  docview.hidden = true;
  docview.querySelector(".docview-body").replaceChildren();
}

function openDoc(spec) {
  const body = docview.querySelector(".docview-body");
  const tools = docview.querySelector(".docview-tools");
  docview.querySelector(".docview-name").textContent = spec.name;
  tools.replaceChildren();
  body.replaceChildren();
  if (spec.kind === "pdf") {
    const frame = document.createElement("iframe");
    frame.className = "docview-frame";
    frame.src = spec.src;
    frame.title = spec.name;
    body.append(frame);
  } else {
    let view = 0;
    const paint = () => {
      body.replaceChildren(docBody(spec.kind, spec.text, spec.ext, view));
      if (spec.cut) {
        const note = document.createElement("p");
        note.className = "embed-note";
        note.textContent = "Showing the first part of the file. Download for the rest.";
        body.append(note);
      }
    };
    if (spec.kind === "markdown") {
      const seg = document.createElement("div");
      seg.className = "embed-seg";
      seg.setAttribute("role", "group");
      ["Rendered", "Raw"].forEach((label, index) => {
        const b = button(label, () => {
          view = index;
          for (const other of seg.children) other.setAttribute("aria-pressed", other === b ? "true" : "false");
          paint();
        }, "embed-seg-btn");
        b.setAttribute("aria-pressed", index === 0 ? "true" : "false");
        seg.append(b);
      });
      tools.append(seg);
    }
    paint();
  }
  docview.hidden = false;
  docview.querySelector(".docview-close").focus();
}

const embedUi = { icon: (name) => lineIcon(name), openDoc };

const closeDocBtn = docview.querySelector(".docview-close");
closeDocBtn.append(lineIcon("x"));
closeDocBtn.addEventListener("click", closeDoc);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !docview.hidden) closeDoc();
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
window.addEventListener("scroll", resetDocumentScroll, { passive: true });
// iOS moves the page after focus and, installed, sends no resize when the keyboard closes: look again while it settles.
function settleViewport() {
  handleViewport();
  for (const ms of [120, 400]) setTimeout(handleViewport, ms);
}
document.addEventListener("focusin", settleViewport);
document.addEventListener("focusout", settleViewport);
handleViewport();
growInput();
applyAppearance(storedAppearance() || "dark");
refreshTheme();
registerWorker();
renderRoute();
setInterval(refreshTheme, 15000);


// ---- Desktop: sessions sidebar, shortcuts, help overlay (only at 1024px and up) ----
const side = document.getElementById("side");
const sideResize = document.getElementById("side-resize");
const keys = document.getElementById("keys");
const wide = matchMedia("(min-width: 1024px)");
let sideRows = [];
let sideArchived = false;
let sideQuery = "";
const SIDEBAR_KEY = "gm-sidebar-w";
const SIDEBAR_DEFAULT = 280;
const SIDEBAR_MIN = 220;
const SIDEBAR_MAX = 480;
const SIDEBAR_STEP = 16;
let sideDrag = null;

function sidebarLimit() {
  return Math.min(SIDEBAR_MAX, Math.round(window.innerWidth * 0.4));
}

function clampSidebar(px) {
  const cap = sidebarLimit();
  const min = Math.min(SIDEBAR_MIN, cap);
  const n = Number(px);
  return Math.round(Math.min(cap, Math.max(min, Number.isFinite(n) ? n : SIDEBAR_DEFAULT)));
}

function storedSidebar() {
  try {
    const raw = localStorage.getItem(SIDEBAR_KEY);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function paintSidebarWidth(px, persist) {
  const next = clampSidebar(px);
  document.documentElement.style.setProperty("--sidebar-w", next + "px");
  sideResize.setAttribute("aria-valuemin", String(Math.min(SIDEBAR_MIN, sidebarLimit())));
  sideResize.setAttribute("aria-valuemax", String(sidebarLimit()));
  sideResize.setAttribute("aria-valuenow", String(next));
  if (persist) {
    try { localStorage.setItem(SIDEBAR_KEY, String(next)); } catch { /* private mode keeps the visit */ }
  }
  return next;
}

function currentSidebar() {
  const n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"));
  return Number.isFinite(n) ? n : SIDEBAR_DEFAULT;
}

function resetSidebar() {
  try { localStorage.removeItem(SIDEBAR_KEY); } catch { /* keep the painted default */ }
  paintSidebarWidth(SIDEBAR_DEFAULT, false);
}

paintSidebarWidth(storedSidebar() ?? SIDEBAR_DEFAULT, false);

sideResize.addEventListener("pointerdown", (event) => {
  if (!isDesktop() || side.hidden || event.button !== 0) return;
  event.preventDefault();
  sideResize.setPointerCapture(event.pointerId);
  sideDrag = { id: event.pointerId, x: event.clientX, w: currentSidebar() };
  sideResize.classList.add("dragging");
  document.documentElement.classList.add("side-drag");
});
sideResize.addEventListener("pointermove", (event) => {
  if (!sideDrag || event.pointerId !== sideDrag.id) return;
  paintSidebarWidth(sideDrag.w + event.clientX - sideDrag.x, false);
});
function endSideDrag(event) {
  if (!sideDrag || event.pointerId !== sideDrag.id) return;
  const next = sideDrag.w + event.clientX - sideDrag.x;
  sideDrag = null;
  sideResize.classList.remove("dragging");
  document.documentElement.classList.remove("side-drag");
  paintSidebarWidth(next, true);
}
sideResize.addEventListener("pointerup", endSideDrag);
sideResize.addEventListener("pointercancel", endSideDrag);
sideResize.addEventListener("dblclick", (event) => {
  event.preventDefault();
  resetSidebar();
});
sideResize.addEventListener("keydown", (event) => {
  if (!isDesktop() || side.hidden) return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const step = (event.shiftKey ? SIDEBAR_STEP * 2 : SIDEBAR_STEP) * (event.key === "ArrowLeft" ? -1 : 1);
  paintSidebarWidth(currentSidebar() + step, true);
});
window.addEventListener("resize", () => {
  if (sideDrag) return;
  paintSidebarWidth(storedSidebar() ?? SIDEBAR_DEFAULT, false);
});

function isDesktop() {
  return wide.matches;
}

async function renderSide() {
  if (!isDesktop() || !app.authed) {
    side.hidden = true;
    sideResize.hidden = true;
    return;
  }
  side.hidden = false;
  sideResize.hidden = false;
  paintSidebarWidth(storedSidebar() ?? SIDEBAR_DEFAULT, false);
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
  const previous = document.querySelector("#side .side-search");
  if (previous) sideQuery = previous.value;
  const restoreFocus = previous && document.activeElement === previous;
  const caret = restoreFocus ? previous.selectionStart : null;
  side.replaceChildren();
  const head = document.createElement("div");
  head.className = "side-head";
  const headRow = document.createElement("div");
  headRow.className = "side-head-row";
  const h = document.createElement("h2");
  h.textContent = "Grok Deck";
  const fresh = button("New", () => go("/new"), "side-new");
  fresh.title = "New session (Ctrl+N)";
  fresh.setAttribute("aria-label", "New session");
  headRow.append(h, fresh);
  const search = document.createElement("input");
  search.className = "filter side-search";
  search.placeholder = "Search";
  search.setAttribute("aria-label", "Search sessions");
  search.value = sideQuery;
  head.append(headRow, search);
  const list = document.createElement("nav");
  list.className = "side-list";
  const paintList = () => {
    const query = search.value.trim().toLowerCase();
    sideQuery = search.value;
    sideRows = all.filter((session) => !!session.archived === sideArchived && sessionMatches(session, query));
    list.replaceChildren();
    if (!sideRows.length) {
      list.append(listEmpty(sideArchived ? "archived" : query ? "search" : "none"));
      return;
    }
    for (const [label, items] of sessionGroups(sideRows)) {
      const heading = document.createElement("h3");
      heading.className = "list-group";
      heading.textContent = label;
      list.append(heading);
      for (const session of items) {
        const active = session.id === current;
        const row = document.createElement("div");
        row.className = "side-row" + (active ? " on" : "");
        row.dataset.theme = session.theme || "";
        const accent = sessionAccent(session.theme);
        if (accent) row.style.setProperty("--row-accent", accent);
        const hit = document.createElement("a");
        hit.href = "/s/" + session.id;
        hit.className = "side-hit";
        hit.addEventListener("click", (event) => {
          event.preventDefault();
          go("/s/" + session.id);
        });
        const mark = document.createElement("span");
        mark.className = "side-mark";
        mark.setAttribute("aria-hidden", "true");
        const dot = document.createElement("i");
        dot.className = "side-dot" + (session.running ? " run" : "") + (session.waiting ? " wait" : "");
        if (accent) dot.style.background = accent;
        hit.append(mark, dot, sessionMain(session, "side"));
        row.append(hit);
        // One way to delete from a row: the open session has the ⋯ menu (it lists Delete); the others show a trash on hover.
        const actions = document.createElement("span");
        actions.className = "side-actions";
        if (!active) {
          const trash = button("", () => askDeleteSession(session), "side-del");
          trash.setAttribute("aria-label", "Delete " + (session.title || "New session"));
          trash.title = "Delete session";
          trash.append(lineIcon("trash"));
          actions.append(trash);
        }
        row.append(actions);
        if (active && isDesktop()) {
          const menu = document.createElement("button");
          menu.type = "button";
          menu.className = "side-menu";
          menu.setAttribute("aria-label", "Session menu");
          menu.append(lineIcon("more"));
          const flag = document.createElement("span");
          flag.className = "flag-dot";
          flag.setAttribute("aria-hidden", "true");
          menu.append(flag);
          menu.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            openSheet(undefined, menu);
          });
          actions.prepend(menu);
        }
        list.append(row);
      }
    }
  };
  search.addEventListener("input", paintList);
  paintList();
  if (restoreFocus) {
    search.focus();
    if (caret != null) search.setSelectionRange(caret, caret);
  }
  const count = all.filter((x) => x.archived).length;
  const foot = document.createElement("div");
  foot.className = "side-foot";
  if (count || sideArchived) foot.append(button(sideArchived ? "Back to sessions" : "Archived (" + count + ")", () => { sideArchived = !sideArchived; renderSide(); }, "linkish"));
  const settings = button("Settings", () => openAppSettings(), "linkish");
  settings.setAttribute("aria-label", "App settings");
  foot.append(settings);
  foot.append(button("? Shortcuts", () => showKeys(), "linkish"));
  mountPlanUsage(foot);
  side.append(head, list, foot);
  paintPlus();
}

setInterval(() => {
  if (isDesktop() && document.visibilityState === "visible") renderSide();
}, 5000);
setInterval(() => {
  if (document.visibilityState !== "visible" || !app.authed) return;
  if (!document.querySelector(".plan-usage")) return;
  notePlanUsageStale();
}, PLAN_MS);
wide.addEventListener("change", () => {
  renderSide();
  const where = route();
  if (where.name === "chat" || where.name === "new") headerForChat();
  else if (app.authed) renderList(++app.gen);
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
    ["← / →", "Resize the sessions pane when its edge is focused"],
    ["Esc", "Close panels and menus"],
    ["?", "This help"],
    ["Paste or drop", "Attach images"],
    ["/", "Skills, with pstack by Lauren Tan (poteto); Enter picks the top match"],
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
      b.dataset.theme = x.theme || "";
      const dot = document.createElement("i");
      dot.className = "row-dot";
      dot.setAttribute("aria-hidden", "true");
      const accent = sessionAccent(x.theme);
      if (accent) dot.style.background = accent;
      b.prepend(dot);
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

// Drop files anywhere in the window on desktop.
document.addEventListener("dragover", (event) => {
  if (composer.hidden) return;
  if (hasFiles(event)) {
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
  const files = [...(event.dataTransfer?.files || [])];
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


// Long run panel: one summary row (status, current step, elapsed, Stop or Resume) that opens
// into the goal board: now / last done / next from PROGRESS.md, GOAL.md items and checks, budget.
const longbar = document.getElementById("longbar");
const LONG_OPEN_KEY = "deck.longrun.open";
function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? s + "s ago" : Math.round(s / 60) + " min ago";
}
function hoursText(ms) {
  const min = Math.max(0, Math.round(ms / 60000));
  return min < 60 ? min + "m" : Math.floor(min / 60) + "h " + (min % 60) + "m";
}
function bigTokens(n) {
  n = Number(n) || 0;
  return n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M" : kTokens(n);
}
function longOpen() {
  try {
    return localStorage.getItem(LONG_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
function setLongOpen(open) {
  try {
    localStorage.setItem(LONG_OPEN_KEY, open ? "1" : "0");
  } catch {
    // private mode keeps the visit
  }
  paintLongRun();
}
const LONG_LABELS = { running: "Running", paused: "Paused", done: "Done", blocked: "Blocked", budget: "Hit budget", stalled: "Stalled", stopped: "Stopped" };
function longSub(lr) {
  const steering = lr.steering;
  if (lr.status === "running" && steering?.state === "replying") return "Steering with your message. The run resumes after.";
  if (lr.status !== "running") return lr.note || "";
  if (steering?.state === "done" && steering.changed && Date.now() - steering.at < 10 * 60000) return "Resumed the goal. Changed: " + steering.changed;
  if (lr.board?.now) return "Now: " + lr.board.now;
  return lr.note || "Working toward the goal";
}
function longGroup(title, ...rows) {
  const group = document.createElement("div");
  group.className = "lr-group";
  const head = document.createElement("div");
  head.className = "lr-head-label";
  head.textContent = title;
  group.append(head, ...rows);
  return group;
}
function longRow(label, value, empty) {
  const row = document.createElement("div");
  row.className = "lr-row";
  const k = document.createElement("span");
  k.className = "lr-k";
  k.textContent = label;
  const v = document.createElement("span");
  v.className = "lr-v" + (value ? "" : " lr-empty");
  v.textContent = value || empty;
  row.append(k, v);
  return row;
}
function longItem(icon, state, text, status, code) {
  const row = document.createElement("div");
  row.className = "lr-item";
  row.dataset.state = state;
  const mark = lineIcon(icon);
  const label = document.createElement(code ? "code" : "span");
  label.className = "lr-text";
  label.textContent = text;
  row.append(mark, label);
  if (status) {
    const word = document.createElement("span");
    word.className = "lr-status";
    word.textContent = status;
    row.append(word);
  }
  return row;
}
function longBody(lr) {
  const body = document.createElement("div");
  body.className = "lr-body";
  body.id = "longbar-body";
  const board = lr.board || {};
  const steering = lr.steering;
  if (steering) {
    body.append(longGroup(
      steering.state === "replying" ? "Steering now" : "Last steering",
      longRow("You said", steering.text, ""),
      longRow("Changed", steering.state === "replying" ? "" : steering.changed, steering.state === "replying" ? "Grok is replying, then resumes" : "Nothing named"),
    ));
  }
  body.append(longGroup(
    "Progress",
    longRow("Now", board.now, board.hasProgress ? "Nothing in progress" : "PROGRESS.md comes with the first turn"),
    longRow("Last done", board.last, "Nothing finished yet"),
    longRow("Next", board.next, "No next step listed"),
  ));
  const items = board.items || [];
  const checks = board.checks || [];
  const goalRows = items.map((item) => longItem(item.done ? "check" : "minus", item.done ? "done" : "open", item.text));
  const checkRows = checks.map((check) => longItem(check.ok === true ? "check" : check.ok === false ? "x" : "minus", check.ok === true ? "pass" : check.ok === false ? "fail" : "open", check.cmd, check.ok === true ? "Pass" : check.ok === false ? "Fail" : "Not run", true));
  if (!goalRows.length) goalRows.push(longRow("Goal", "", board.hasGoal ? "No checklist in GOAL.md" : "GOAL.md comes with the first turn"));
  body.append(longGroup("Goal", ...goalRows));
  body.append(longGroup("Checks", ...(checkRows.length ? checkRows : [longRow("Checks", "", "No ## Checks in GOAL.md yet")])));
  const elapsed = Date.now() - (lr.startedAt || Date.now());
  const used = (lr.usedTokens || 0) + (lr.skepticTokens || 0);
  body.append(longGroup(
    "Budget",
    longRow("Time", hoursText(elapsed) + " of " + lr.hours + "h", ""),
    longRow("Turns", lr.turns + (lr.steers ? " · " + lr.steers + " steering" : "") + (lr.resumes ? " · " + lr.resumes + " resumes" : ""), ""),
    longRow("Tokens", bigTokens(used) + " of " + bigTokens(lr.tokens), ""),
    longRow("Active", lr.status === "running" && lr.lastActivity ? agoText(Date.now() - lr.lastActivity) : "", LONG_LABELS[lr.status] || ""),
  ));
  return body;
}
function paintLongRun(run) {
  if (run !== undefined) app.longRun = run || null;
  const lr = app.longRun;
  paintOptbar();
  const steerHint = "Steer the long run";
  const running = lr?.status === "running" && route().name === "chat";
  if (running && input.placeholder === "Message") input.placeholder = steerHint;
  else if (!running && input.placeholder === steerHint) input.placeholder = "Message";
  if (!longbar) return;
  if (!lr) {
    longbar.hidden = true;
    return;
  }
  const open = longOpen();
  const keepScroll = longbar.querySelector(".lr-body")?.scrollTop || 0;
  longbar.hidden = false;
  longbar.dataset.status = lr.status;
  longbar.dataset.steering = lr.status === "running" && lr.steering?.state === "replying" ? "on" : "off";
  longbar.replaceChildren();
  const head = document.createElement("div");
  head.className = "lr-top";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "lr-toggle";
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-controls", "longbar-body");
  toggle.addEventListener("click", () => setLongOpen(!longOpen()));
  const dot = document.createElement("span");
  dot.className = "lr-dot";
  const words = document.createElement("span");
  words.className = "lr-words";
  const title = document.createElement("span");
  title.className = "lr-title";
  const steeringNow = longbar.dataset.steering === "on";
  title.textContent = "Long run · " + (steeringNow ? "Steering" : LONG_LABELS[lr.status] || lr.status);
  const sub = document.createElement("span");
  sub.className = "lr-sub";
  sub.textContent = longSub(lr);
  words.append(title, sub);
  const meta = document.createElement("span");
  meta.className = "lr-meta";
  meta.textContent = hoursText(Date.now() - (lr.startedAt || Date.now())) + " / " + lr.hours + "h";
  toggle.append(dot, words, meta, lineIcon("chevron"));
  const act = button(lr.status === "running" ? "Stop run" : "Resume run", () => longRunAction(lr.status === "running" ? "stop" : "resume"), "lr-act");
  head.append(toggle, act);
  longbar.append(head);
  if (open) {
    const body = longBody(lr);
    longbar.append(body);
    body.scrollTop = keepScroll;
  }
}
async function longRunAction(action, extra = {}) {
  if (!app.sessionId) return false;
  try {
    const r = await api("/api/sessions/" + app.sessionId + "/longrun", { method: "POST", body: JSON.stringify({ action, ...extra }) });
    paintLongRun(r.longRun);
    return true;
  } catch (error) {
    if (!error.auth) alert(error.message || "Long run change failed");
    return false;
  }
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
  if (r?.state === "running") return { label: "Skeptical review running · Cancel", icon: "shield", accent: true, run: () => { closeSheet(); skepticAction("cancel"); } };
  const mode = skepticEffective();
  return {
    label: "Skeptical review: " + (SKEPTIC_NAMES[mode] || mode) + (app.session?.skeptic === "default" ? " (app default)" : ""),
    icon: "shield",
    accent: mode !== "off",
    run: () => openSheet([
      { label: "Review this turn now", icon: "shield", run: () => { closeSheet(); skepticAction("run"); } },
      ...SKEPTIC_MODES.map(([value, text]) => ({ label: text, selected: (app.session?.skeptic || "default") === value, run: async () => { await setSkepticPref({ skeptic: value }); closeSheet(); } })),
      { label: "Back", icon: "back", run: () => openSheet() },
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
  const note = document.createElement("p");
  note.className = "mode-note";
  note.textContent = "Default for new sessions.";
  const holder = document.createElement("div");
  wrap.append(note, holder);
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
