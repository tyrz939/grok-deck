// Artifacts: the files Grok made in a session (lib/artifacts.js), shown as a card in the turn that made or changed
// them and opened in one panel: full screen on the phone, a column beside the chat on desktop. The panel draws
// each type with the renderers the chat already has (markdown.js, highlight.js through embeds.js docBody); HTML
// runs only in a sandboxed frame with no same-origin access, served by the store with a sandbox CSP. A 3D model is
// drawn by model3d.js, loaded only when one opens.
import { docBody, sizeText } from "./embeds.js";

const TYPE = {
  html: { label: "HTML page", icon: "page", preview: "Preview" },
  markdown: { label: "Document", icon: "doc", preview: "Rendered" },
  svg: { label: "SVG image", icon: "photo", preview: "Preview" },
  csv: { label: "Table", icon: "table", preview: "Table" },
  code: { label: "Code", icon: "code", preview: "" },
  model3d: { label: "3D model", icon: "cube", preview: "" },
};
const TEXT_CAP = 1024 * 1024;

export const artifactType = (kind) => TYPE[kind] || TYPE.code;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function versionUrl(sessionId, art, version, download) {
  return "/api/sessions/" + sessionId + "/artifacts/" + art.id + "/" + version.v + "?h=" + encodeURIComponent(version.h || "") + (download ? "&download=1" : "");
}

function whenText(ms) {
  const d = new Date(ms);
  if (!ms || Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

// The card in the chat: the version this turn made. A later turn has its own card with its own version.
export function artifactCard(ui, art, version, onOpen) {
  const type = artifactType(art.kind);
  const card = el("button", "artifact-card");
  card.type = "button";
  card.dataset.artifact = art.id;
  card.dataset.v = String(version.v);
  const glyph = el("span", "artifact-glyph");
  glyph.append(ui.icon(type.icon));
  const text = el("span", "artifact-text");
  const title = el("span", "artifact-title", art.title);
  const meta = el("span", "artifact-meta");
  const changed = version.v > 1 ? "Updated" : "Created";
  meta.textContent = type.label + " · v" + version.v + " · " + changed + " " + whenText(version.at);
  text.append(title, meta);
  const go = el("span", "artifact-go");
  go.append(ui.icon("expand"));
  card.append(glyph, text, go);
  card.setAttribute("aria-label", "Open " + art.title + ", version " + version.v);
  card.addEventListener("click", () => onOpen(art, version.v));
  return card;
}

// --- CSV -------------------------------------------------------------------------------------------------------

export function parseDelimited(text, sep) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const src = String(text || "");
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
    if (rows.length > 2000) break;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvTable(text, ext) {
  const rows = parseDelimited(text, ext === "tsv" ? "\t" : ",");
  const wrap = el("div", "embed-body md-doc artifact-table");
  const scroller = el("div", "table-wrap");
  const table = el("table");
  rows.forEach((cells, index) => {
    const tr = el("tr");
    for (const value of cells) tr.append(el(index === 0 ? "th" : "td", "", value));
    (index === 0 ? table.createTHead() : table.tBodies[0] || table.createTBody()).append(tr);
  });
  scroller.append(table);
  wrap.append(scroller);
  return wrap;
}

// --- the panel -------------------------------------------------------------------------------------------------

export function createArtifactPanel(ui, root) {
  const state = { art: null, v: 0, view: 0, text: null, token: 0, viewer: null };
  root.replaceChildren();
  const head = el("div", "artifact-head");
  const glyph = el("span", "artifact-glyph");
  const titles = el("div", "artifact-titles");
  const title = el("h2", "artifact-heading");
  const sub = el("span", "artifact-sub");
  titles.append(title, sub);
  const close = el("button", "icon-btn artifact-close");
  close.type = "button";
  close.setAttribute("aria-label", "Close artifact");
  close.append(ui.icon("x"));
  close.addEventListener("click", () => hide());
  head.append(glyph, titles, close);

  const bar = el("div", "artifact-bar");
  const versionBtn = el("button", "artifact-version");
  versionBtn.type = "button";
  versionBtn.setAttribute("aria-haspopup", "menu");
  const seg = el("div", "embed-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "View");
  const actions = el("div", "artifact-actions");
  const copy = el("button", "icon-btn embed-btn");
  copy.type = "button";
  copy.setAttribute("aria-label", "Copy artifact source");
  copy.append(ui.icon("copy"));
  const download = el("a", "icon-btn embed-btn artifact-download");
  download.setAttribute("aria-label", "Download artifact");
  download.append(ui.icon("download"));
  const reset = el("button", "icon-btn embed-btn artifact-reset");
  reset.type = "button";
  reset.setAttribute("aria-label", "Reset view");
  reset.append(ui.icon("reset"));
  reset.addEventListener("click", () => state.viewer?.reset());
  actions.append(reset, copy, download);
  bar.append(versionBtn, seg, actions);
  const body = el("div", "artifact-body");
  root.append(head, bar, body);

  const current = () => state.art?.versions.find((x) => x.v === state.v) || state.art?.versions[state.art.versions.length - 1];

  versionBtn.addEventListener("click", () => {
    if (!state.art) return;
    const items = [...state.art.versions].reverse().map((version) => ({
      label: "Version " + version.v,
      detail: whenText(version.at) + " · " + sizeText(version.size),
      selected: version.v === state.v,
      run: () => { ui.closeSheet(); show(state.art, version.v); },
    }));
    ui.openSheet(items, versionBtn);
  });
  copy.addEventListener("click", async () => {
    const text = state.text ?? (await loadText());
    const ok = await ui.copyText(text || "");
    copy.replaceChildren(ui.icon(ok ? "check" : "x"));
    copy.setAttribute("aria-label", ok ? "Copied" : "Copy failed");
    clearTimeout(copy._flash);
    copy._flash = setTimeout(() => {
      copy.replaceChildren(ui.icon("copy"));
      copy.setAttribute("aria-label", "Copy artifact source");
    }, 1200);
  });

  async function loadText() {
    const version = current();
    if (!version) return "";
    const res = await fetch(versionUrl(ui.sessionId(), state.art, version));
    if (!res.ok) throw new Error("gone");
    const text = await res.text();
    return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
  }

  function paintSeg() {
    const type = artifactType(state.art.kind);
    seg.replaceChildren();
    seg.hidden = !type.preview;
    if (!type.preview) return;
    [type.preview, "Code"].forEach((label, index) => {
      const b = el("button", "embed-seg-btn", label);
      b.type = "button";
      b.setAttribute("aria-pressed", index === state.view ? "true" : "false");
      b.addEventListener("click", () => {
        state.view = index;
        paintSeg();
        paintBody();
      });
      seg.append(b);
    });
  }

  function dropViewer() {
    state.viewer?.dispose();
    state.viewer = null;
  }

  async function paintModel(art, version, token) {
    const stage = el("div", "model-stage");
    const note = el("p", "embed-note model-note", "Loading model");
    body.append(stage, note);
    try {
      const { mountModel } = await import("./model3d.js");
      if (token !== state.token) return;
      const viewer = await mountModel(stage, versionUrl(ui.sessionId(), art, version), art.ext, (info) => {
        note.textContent = info.size.join(" × ") + " · " + info.triangles.toLocaleString() + " triangles · drag to rotate, pinch to zoom";
      });
      if (token !== state.token) return viewer.dispose();
      state.viewer = viewer;
    } catch (error) {
      if (token !== state.token) return;
      stage.remove();
      note.textContent = error?.constructor?.name === "ExternalRefs"
        ? "This glTF points to files outside itself. Only a GLB or a glTF with embedded data is shown here; download it to open elsewhere."
        : error?.message === "gone" ? "This version is not in the store any more." : "This model could not be drawn.";
    }
  }

  async function paintBody() {
    const art = state.art;
    const version = current();
    const token = ++state.token;
    dropViewer();
    body.replaceChildren();
    body.classList.toggle("is-frame", (art.kind === "html" || art.kind === "svg") && state.view === 0);
    body.classList.toggle("is-model", art.kind === "model3d");
    if (art.kind === "model3d") return paintModel(art, version, token);
    if (art.kind === "html" && state.view === 0) {
      const frame = el("iframe", "artifact-frame");
      // No allow-same-origin: the page runs in an opaque origin and cannot read Grok Deck's cookies or API.
      frame.setAttribute("sandbox", "allow-scripts allow-popups allow-modals");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.title = art.title;
      frame.src = versionUrl(ui.sessionId(), art, version);
      body.append(frame);
      return;
    }
    if (art.kind === "svg" && state.view === 0) {
      const img = el("img", "artifact-image");
      img.alt = art.title;
      img.src = versionUrl(ui.sessionId(), art, version);
      body.append(img);
      return;
    }
    if (state.text == null) {
      body.append(el("p", "embed-note", "Loading"));
      try {
        state.text = await loadText();
      } catch {
        if (token !== state.token) return;
        body.replaceChildren(el("p", "embed-note", "This version is not in the store any more."));
        return;
      }
      if (token !== state.token) return;
    }
    const kind = art.kind === "markdown" ? "markdown" : "code";
    const node = art.kind === "csv" && state.view === 0 ? csvTable(state.text, art.ext) : docBody(kind, state.text, art.kind === "csv" ? "txt" : art.ext, kind === "markdown" ? state.view : 1);
    body.replaceChildren(node);
  }

  function show(art, v) {
    const same = state.art?.id === art.id;
    state.art = art;
    state.v = art.versions.some((x) => x.v === v) ? v : art.versions[art.versions.length - 1]?.v || 0;
    if (!same) state.view = 0;
    state.text = null;
    const type = artifactType(art.kind);
    glyph.replaceChildren(ui.icon(type.icon));
    title.textContent = art.title;
    sub.textContent = art.name + " · " + type.label;
    sub.title = art.path;
    const version = current();
    const many = art.versions.length > 1;
    versionBtn.replaceChildren(el("span", "", "v" + state.v + (many ? " of " + art.versions.length : "")));
    if (many) versionBtn.append(ui.icon("chevron"));
    versionBtn.disabled = !many;
    versionBtn.setAttribute("aria-label", "Version " + state.v + " of " + art.versions.length + (many ? ", choose a version" : ""));
    download.href = versionUrl(ui.sessionId(), art, version, true);
    download.setAttribute("download", art.name);
    copy.hidden = art.kind === "model3d"; // bytes, not source
    reset.hidden = art.kind !== "model3d";
    paintSeg();
    paintBody();
    root.dataset.artifact = art.id;
    if (root.hidden) {
      root.hidden = false;
      ui.onToggle(true);
    }
    close.focus({ preventScroll: true });
  }

  function hide() {
    if (root.hidden) return;
    root.hidden = true;
    state.token += 1;
    dropViewer();
    body.replaceChildren();
    state.art = null;
    delete root.dataset.artifact;
    ui.onToggle(false);
  }

  // A newer list from the server: keep the open artifact current, and follow it to a new version only when the
  // newest one was showing.
  function refresh(list) {
    if (!state.art) return;
    const next = list.find((a) => a.id === state.art.id);
    if (!next) return hide();
    const wasLatest = state.v === state.art.versions[state.art.versions.length - 1]?.v;
    const oldH = current()?.h;
    const v = wasLatest ? next.versions[next.versions.length - 1].v : state.v;
    const nextH = next.versions.find((x) => x.v === v)?.h;
    if (v === state.v && nextH === oldH && next.versions.length === state.art.versions.length) {
      state.art = next;
      return;
    }
    show(next, v);
  }

  return { show, hide, refresh, isOpen: () => !root.hidden, openId: () => state.art?.id || "", openV: () => state.v };
}
