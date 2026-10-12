function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Files an assistant message points at are served only from the media store (lib/media.js). The server copies a
// local file the message links to into the store when the message arrives and rewrites the reference to
// /api/media/<sha256>.<ext>?n=<name>. A local reference still in the text means the source was already gone.
export const MEDIA_PREFIX = "/api/media/";
export const LIMIT_PATH = "/api/media/limit";
const HAS_EXT = /\.([A-Za-z0-9]{1,8})$/;

const KINDS = {
  image: ["png", "jpg", "jpeg", "webp", "gif"],
  video: ["mp4", "webm", "mov", "m4v"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac", "flac", "opus"],
  pdf: ["pdf"],
  markdown: ["md", "markdown"],
  code: ["txt", "log", "csv", "tsv", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "sh", "bash", "zsh", "css", "html", "htm", "xml", "svg", "yml", "yaml", "toml", "ini", "rs", "go", "java", "c", "h", "cpp", "hpp", "rb", "php", "sql", "swift", "kt", "diff", "patch"],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([kind, list]) => list.map((ext) => [ext, kind])));

// How a stored file is shown: by its type. Anything unknown is a download card.
export function embedKind(ext) {
  return KIND_OF.get(String(ext || "").toLowerCase()) || "file";
}

export function cleanTarget(href) {
  let h = String(href || "").trim().replace(/^<|>$/g, "").replace(/^file:\/\//i, "");
  try { h = decodeURI(h); } catch { /* keep raw */ }
  return h;
}

// A path on the machine (not a URL, an anchor or one of our own routes) that names a file by its extension. Whether
// the file exists is for the server's filesystem to say.
export function isLocalRef(target) {
  const h = cleanTarget(target);
  if (!h || h.length > 1000 || h.startsWith("#") || h.startsWith("//") || h.startsWith("/api/")) return false;
  return !/^[a-z][a-z0-9+.-]*:/i.test(h) && HAS_EXT.test(h);
}

// What a stored reference says: the store name, its type, the file's own name, or that it was over the cap.
export function parseMedia(href) {
  const text = String(href || "");
  if (!text.startsWith(MEDIA_PREFIX)) return null;
  const [route, query = ""] = text.slice(MEDIA_PREFIX.length).split("?");
  const params = new URLSearchParams(query);
  if (route === "limit") return { limit: true, size: Number(params.get("size")) || 0, label: params.get("n") || "file", reason: params.get("why") || "" };
  const ext = (route.split(".")[1] || "").toLowerCase();
  return { name: route, ext, kind: embedKind(ext), label: params.get("n") || route, url: MEDIA_PREFIX + route, href: text };
}

// Every reference to a local file in the text, found the way renderMarkdown reads it: markdown links and images, and
// a path alone on its line. Fenced code and `code spans` are skipped.
export function findRefs(text) {
  const src = String(text ?? "");
  const found = [];
  let fenced = false;
  let offset = 0;
  for (const line of src.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (line.trim().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const before = found.length;
    let i = 0;
    while (i < line.length) {
      if (line[i] === "`") {
        const end = line.indexOf("`", i + 1);
        if (end > i + 1) {
          i = end + 1;
          continue;
        }
      }
      const image = line[i] === "!" && line[i + 1] === "[";
      if (image || line[i] === "[") {
        const open = image ? i + 2 : i + 1;
        const close = line.indexOf("]", open);
        const end = close > i && line[close + 1] === "(" ? line.indexOf(")", close + 2) : -1;
        if (end !== -1) {
          const raw = line.slice(close + 2, end);
          const lead = raw.length - raw.trimStart().length;
          found.push({
            kind: image ? "image" : "link",
            start: lineStart + i,
            end: lineStart + end + 1,
            label: line.slice(open, close),
            target: raw.trim(),
            targetStart: lineStart + close + 2 + lead,
            targetEnd: lineStart + close + 2 + lead + raw.trim().length,
          });
          i = end + 1;
          continue;
        }
      }
      i += 1;
    }
    if (found.length === before) {
      const m = /^(\s*(?:[-*+]|\d+[.)])\s+)?(`?)([^\s`<>|*?"'()\[\]]+)\2\s*$/.exec(line);
      if (m && /[./]/.test(m[3]) && isLocalRef(m[3])) {
        const start = lineStart + (m[1] || "").length;
        found.push({ kind: "bare", start, end: start + m[2].length * 2 + m[3].length, label: "", target: m[3], targetStart: start + m[2].length, targetEnd: start + m[2].length + m[3].length });
      }
    }
  }
  return found;
}

export function baseName(target) {
  return cleanTarget(target).split(/[\\/]/).filter(Boolean).pop() || "file";
}

// New text with the given targets swapped (map: old target -> stored URL), by position and never by search. A path
// alone on its line becomes a link to the stored file, named as the file was.
export function rewriteRefs(text, map) {
  let out = String(text ?? "");
  for (const ref of findRefs(out).filter((r) => map.has(r.target)).reverse()) {
    const url = map.get(ref.target);
    if (ref.kind === "bare") out = out.slice(0, ref.start) + "[" + baseName(ref.target).replace(/[\[\]]/g, "") + "](" + url + ")" + out.slice(ref.end);
    else out = out.slice(0, ref.targetStart) + url + out.slice(ref.targetEnd);
  }
  return out;
}

function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function noteCard(title, line) {
  return '<span class="md-missing"><span class="md-missing-title">' + escapeHtml(title) + '</span><span class="md-missing-name">' + escapeHtml(line) + "</span></span>";
}

function missingCard(label, target) {
  return noteCard("Image moved or deleted".replace("Image", /\.(png|jpe?g|webp|gif)$/i.test(cleanTarget(target)) ? "Image" : "File"), label || baseName(target));
}

function limitCard(info) {
  const why = info.reason === "store" ? "The media store is full." : "Over the " + sizeText(LIMIT_BYTES) + " limit.";
  return noteCard("File too large to keep", info.label + " · " + sizeText(info.size) + ". " + why);
}

export const LIMIT_BYTES = 25 * 1024 * 1024;

// The card for a stored reference. Pictures are drawn here; every other type is a placeholder the page fills in.
function mediaEmbed(info, label) {
  if (info.limit) return limitCard(info);
  if (info.kind === "image") return '<span class="shots md-shot"><img src="' + escapeHtml(info.href) + '" alt="' + escapeHtml(label || info.label) + '" loading="lazy" /></span>';
  return '<span class="embed" data-src="' + escapeHtml(info.url) + '" data-kind="' + info.kind + '" data-name="' + escapeHtml(info.label) + '"></span>';
}

let embedsOn = true;

function inline(raw) {
  const src = String(raw);
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src[i] === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        out += "<code>" + escapeHtml(src.slice(i + 1, end)) + "</code>";
        i = end + 1;
        continue;
      }
    }
    if (src.startsWith("**", i)) {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        out += "<strong>" + inline(src.slice(i + 2, end)) + "</strong>";
        i = end + 2;
        continue;
      }
    }
    if (src[i] === "!" && src[i + 1] === "[") {
      const close = src.indexOf("]", i + 2);
      const end = close > i && src[close + 1] === "(" ? src.indexOf(")", close + 2) : -1;
      const target = end !== -1 ? src.slice(close + 2, end).trim() : "";
      const alt = end !== -1 ? src.slice(i + 2, close) : "";
      const info = parseMedia(target);
      if (info || isLocalRef(target)) {
        out += !embedsOn ? escapeHtml(alt || baseName(target)) : info ? mediaEmbed(info, alt) : missingCard(alt, target);
        i = end + 1;
        continue;
      }
    }
    if (src[i] === "[") {
      const close = src.indexOf("]", i + 1);
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        const href = end === -1 ? "" : src.slice(close + 2, end).trim();
        const info = end === -1 ? null : parseMedia(href);
        if (end !== -1 && (info || isLocalRef(href))) {
          const text = src.slice(i + 1, close);
          out += !embedsOn ? escapeHtml(text || baseName(href)) : info ? mediaEmbed(info, text) : missingCard(text, href);
          i = end + 1;
          continue;
        }
        if (end !== -1 && /^https?:\/\//i.test(href)) {
          out +=
            '<a href="' +
            escapeHtml(href) +
            '" target="_blank" rel="noopener noreferrer">' +
            inline(src.slice(i + 1, close)) +
            "</a>";
          i = end + 1;
          continue;
        }
      }
    }
    if (src[i] === "*" && src[i + 1] !== "*") {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1) {
        out += "<em>" + inline(src.slice(i + 1, end)) + "</em>";
        i = end + 1;
        continue;
      }
    }
    const next = src.slice(i).search(/[`*\[!]/);
    if (next === -1) {
      out += escapeHtml(src.slice(i));
      break;
    }
    if (next === 0) {
      out += escapeHtml(src[i]);
      i += 1;
      continue;
    }
    out += escapeHtml(src.slice(i, i + next));
    i += next;
  }
  return out;
}

function splitCells(line) {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isDelimiterRow(line) {
  if (!line.includes("|")) return false;
  const cells = splitCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function tableAlign(cell) {
  const text = cell.trim();
  const left = text.startsWith(":");
  const right = text.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "";
}

function isTableStart(lines, index) {
  return index + 1 < lines.length && lines[index].includes("|") && isDelimiterRow(lines[index + 1]);
}

function renderTable(header, aligns, rows) {
  const cell = (tag, text, align) =>
    "<" + tag + (align ? ' style="text-align:' + align + '"' : "") + ">" + inline(text) + "</" + tag + ">";
  const head = "<thead><tr>" + header.map((text, i) => cell("th", text, aligns[i])).join("") + "</tr></thead>";
  const body =
    "<tbody>" +
    rows.map((row) => "<tr>" + row.map((text, i) => cell("td", text, aligns[i])).join("") + "</tr>").join("") +
    "</tbody>";
  return '<div class="table-wrap"><table>' + head + body + "</table></div>";
}

// Icon-only copy button, the same two squares and check as the one under a message (app.js copyIcons).
const COPY_ICONS =
  '<svg class="ico ico-copy" viewBox="0 0 18 18" aria-hidden="true"><rect x="6.25" y="2.25" width="9.5" height="9.5" rx="1.5"/><rect x="2.25" y="6.25" width="9.5" height="9.5" rx="1.5"/></svg>' +
  '<svg class="ico ico-check" viewBox="0 0 18 18" aria-hidden="true"><path d="M4 9.5 7.5 13 14 5.5"/></svg>';

// embeds: false is for a document's own text, whose links are relative to that document and not to the chat.
export function renderMarkdown(src, { embeds = true } = {}) {
  embedsOn = embeds;
  try {
    return renderBlocks(src);
  } finally {
    embedsOn = true;
  }
}

function renderBlocks(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  const fence = (lang, code) =>
    '<div class="code"><button type="button" class="copy" aria-label="Copy code">' + COPY_ICONS + "</button><pre><code" +
    (lang ? ' data-lang="' + escapeHtml(lang) + '"' : "") +
    ">" +
    escapeHtml(code) +
    "</code></pre></div>";

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const buf = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      html += fence(lang, buf.join("\n"));
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      html += "<hr>";
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      html += "<h" + level + ">" + inline(heading[2]) + "</h" + level + ">";
      i += 1;
      continue;
    }
    if (line.startsWith(">")) {
      const buf = [];
      while (i < lines.length && lines[i].startsWith(">")) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i += 1;
      }
      html += "<blockquote><p>" + inline(buf.join(" ")) + "</p></blockquote>";
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      html += "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        html += "<li>" + inline(lines[i].replace(/^\s*[-*]\s+/, "")) + "</li>";
        i += 1;
      }
      html += "</ul>";
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      html += "<ol>";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        html += "<li>" + inline(lines[i].replace(/^\s*\d+\.\s+/, "")) + "</li>";
        i += 1;
      }
      html += "</ol>";
      continue;
    }
    if (isTableStart(lines, i)) {
      const header = splitCells(lines[i]);
      const aligns = splitCells(lines[i + 1]).map(tableAlign);
      i += 2;
      const rows = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        lines[i].includes("|") &&
        !isDelimiterRow(lines[i]) &&
        !lines[i].trim().startsWith("```")
      ) {
        rows.push(splitCells(lines[i]));
        i += 1;
      }
      html += renderTable(header, aligns, rows);
      continue;
    }
    if (!line.trim()) {
      i += 1;
      continue;
    }
    const buf = [line];
    i += 1;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith("```") &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !lines[i].startsWith(">") &&
      !isTableStart(lines, i)
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    html += "<p>" + inline(buf.join(" ")) + "</p>";
  }
  return html;
}
