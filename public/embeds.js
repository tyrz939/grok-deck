// Cards for the files a message links to, drawn by type. markdown.js leaves a placeholder
// <span class="embed" data-src data-kind data-name> for every stored file that is not a picture; this fills it in.
import { highlight } from "./highlight.js";
import { parseMedia, renderMarkdown } from "./markdown.js";

const TEXT_CAP = 400 * 1024; // the most of a text file drawn in a card; the rest is a download away
const OPEN_LINES = 24; // a document up to this long starts open
const sizes = new Map();

export function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function iconButton(ui, icon, label, onClick) {
  const b = el("button", "icon-btn embed-btn");
  b.type = "button";
  b.setAttribute("aria-label", label);
  b.append(ui.icon(icon));
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

function head(ui, icon, name, meta) {
  const row = el("div", "embed-head");
  const glyph = el("span", "embed-icon");
  glyph.append(ui.icon(icon));
  const label = el("span", "embed-name", name);
  const size = el("span", "embed-meta", meta || "");
  row.append(glyph, label, size);
  return { row, size };
}

async function sizeOf(src) {
  if (sizes.has(src)) return sizes.get(src);
  try {
    const res = await fetch(src, { method: "HEAD", cache: "reload" });
    if (res.status === 404) return -1; // not kept: the store file is gone
    const n = Number(res.headers.get("content-length")) || 0;
    sizes.set(src, n);
    return n;
  } catch {
    return 0;
  }
}

async function textOf(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error("gone");
  const text = await res.text();
  return text.length > TEXT_CAP ? { text: text.slice(0, TEXT_CAP), cut: true, bytes: text.length } : { text, cut: false, bytes: new Blob([text]).size };
}

function missing(title, line) {
  const card = el("span", "md-missing");
  card.append(el("span", "md-missing-title", title), el("span", "md-missing-name", line));
  return card;
}

function segmented(labels, onPick) {
  const wrap = el("div", "embed-seg");
  wrap.setAttribute("role", "group");
  labels.forEach((label, index) => {
    const b = el("button", "embed-seg-btn", label);
    b.type = "button";
    b.setAttribute("aria-pressed", index === 0 ? "true" : "false");
    b.addEventListener("click", () => {
      for (const other of wrap.children) other.setAttribute("aria-pressed", other === b ? "true" : "false");
      onPick(index);
    });
    wrap.append(b);
  });
  return wrap;
}

// What a document or code file shows, as a function of the view chosen: used by the card and by the full screen.
export function docBody(kind, text, ext, view) {
  const body = el("div", "embed-body");
  if (kind === "markdown" && view === 0) {
    body.classList.add("md-doc");
    body.innerHTML = renderMarkdown(text, { embeds: false });
  } else {
    const pre = el("pre", "embed-code");
    const code = el("code");
    code.innerHTML = kind === "markdown" ? highlightPlain(text) : highlight(text, ext);
    pre.append(code);
    body.append(pre);
  }
  return body;
}

function highlightPlain(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function textCard(ui, info, kind, src, name) {
  const ext = info.ext;
  const card = el("details", "embed-card embed-doc");
  const summary = el("summary", "embed-summary");
  const h = head(ui, kind === "markdown" ? "doc" : "code", name, "");
  const chev = el("span", "chev");
  chev.append(ui.icon("chevron"));
  summary.append(h.row, chev);
  const tools = el("div", "embed-tools");
  const holder = el("div", "embed-holder");
  card.append(summary, tools, holder);
  let loaded = null;
  let view = 0;
  const paint = () => {
    if (!loaded) return;
    holder.replaceChildren(docBody(kind, loaded.text, ext, view));
    if (loaded.cut) holder.append(el("p", "embed-note", "Showing the first " + sizeText(TEXT_CAP) + ". Download for the rest."));
  };
  const actions = el("div", "embed-actions");
  if (kind === "markdown") {
    tools.append(segmented(["Rendered", "Raw"], (index) => { view = index; paint(); }));
  }
  actions.append(
    iconButton(ui, "expand", "Open " + name + " full screen", () => loaded && ui.openDoc({ kind, text: loaded.text, ext, name, src, cut: loaded.cut })),
    iconButton(ui, "download", "Download " + name, () => { window.location.href = src + "?download=1&n=" + encodeURIComponent(name); }),
  );
  tools.append(actions);
  textOf(src).then((got) => {
    loaded = got;
    h.size.textContent = sizeText(got.bytes);
    card.open = got.text.split("\n").length <= OPEN_LINES;
    paint();
  }, () => card.replaceWith(missing("File moved or deleted", name)));
  return card;
}

function pdfCard(ui, src, name) {
  const card = el("div", "embed-card embed-pdf");
  const h = head(ui, "doc", name, "");
  const frame = el("iframe", "embed-frame");
  frame.src = src;
  frame.title = name;
  frame.loading = "lazy";
  const tools = el("div", "embed-tools");
  const actions = el("div", "embed-actions");
  actions.append(
    iconButton(ui, "expand", "Open " + name + " full screen", () => ui.openDoc({ kind: "pdf", name, src })),
    iconButton(ui, "download", "Download " + name, () => { window.location.href = src + "?download=1&n=" + encodeURIComponent(name); }),
  );
  tools.append(actions);
  card.append(h.row, frame, tools);
  sizeOf(src).then((n) => (n < 0 ? card.replaceWith(missing("File moved or deleted", name)) : (h.size.textContent = n ? sizeText(n) : "")));
  return card;
}

function playerCard(ui, kind, src, name) {
  const card = el("div", "embed-card embed-" + kind);
  const h = head(ui, kind === "video" ? "video" : "audio", name, "");
  const player = el(kind);
  player.controls = true;
  player.preload = "metadata";
  if (kind === "video") player.playsInline = true;
  player.src = src;
  player.setAttribute("aria-label", name);
  // A file that will not decode keeps its player; only a store file that is gone becomes the "moved or deleted" card.
  const gone = () => card.replaceWith(missing("File moved or deleted", name));
  card.append(h.row, player);
  sizeOf(src).then((n) => (n < 0 ? gone() : (h.size.textContent = n ? sizeText(n) : "")));
  return card;
}

function fileCard(ui, src, name) {
  const card = el("a", "embed-card embed-file");
  card.href = src + "?download=1&n=" + encodeURIComponent(name);
  card.setAttribute("download", name);
  const h = head(ui, "file", name, "");
  const go = el("span", "embed-go");
  go.append(ui.icon("download"));
  card.append(h.row, go);
  sizeOf(src).then((n) => (n < 0 ? card.replaceWith(missing("File moved or deleted", name)) : (h.size.textContent = n ? sizeText(n) : "")));
  return card;
}

function build(ui, holder) {
  const src = holder.dataset.src;
  const kind = holder.dataset.kind;
  const name = holder.dataset.name || "file";
  const info = parseMedia(src) || { ext: "" };
  if (kind === "markdown" || kind === "code") return textCard(ui, info, kind, src, name);
  if (kind === "pdf") return pdfCard(ui, src, name);
  if (kind === "video" || kind === "audio") return playerCard(ui, kind, src, name);
  return fileCard(ui, src, name);
}

// Fills every placeholder under root. A card already built for a source is reused, so a message that is drawn
// again while it streams does not reload its players.
export function hydrateEmbeds(root, cache, ui) {
  for (const holder of root.querySelectorAll(".embed[data-src]")) {
    const key = holder.dataset.src;
    let card = cache.get(key);
    if (!card) {
      card = build(ui, holder);
      cache.set(key, card);
    }
    holder.replaceWith(card);
  }
}
