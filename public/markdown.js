function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let imageSession = "";

// Grok saves generated images in its session folder and links them as images/<file>.
export function setImageSession(id) {
  imageSession = /^[0-9a-f-]{36}$/i.test(id || "") ? id : "";
}

function imageSrc(href) {
  if (!imageSession) return "";
  let h = String(href || "").replace(/^<|>$/g, "").replace(/^file:\/\//i, "");
  try { h = decodeURI(h); } catch { /* keep raw */ }
  const m = h.match(/(?:^|\/)images\/([A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif))$/i);
  if (m && (!h.startsWith("/") || h.includes("/" + imageSession + "/images/"))) {
    return "/api/sessions/" + imageSession + "/image/" + encodeURIComponent(m[1]);
  }
  if (/^[a-z]+:/i.test(h) || !/\.(png|jpe?g|webp|gif)$/i.test(h)) return "";
  return "/api/sessions/" + imageSession + "/file?p=" + encodeURIComponent(h);
}

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
      const img = end !== -1 ? imageSrc(src.slice(close + 2, end).trim()) : "";
      if (img) {
        out += '<span class="shots md-shot"><img src="' + escapeHtml(img) + '" alt="' + escapeHtml(src.slice(i + 2, close)) + '" loading="lazy" /></span>';
        i = end + 1;
        continue;
      }
    }
    if (src[i] === "[") {
      const close = src.indexOf("]", i + 1);
      if (close > i && src[close + 1] === "(") {
        const end = src.indexOf(")", close + 2);
        const href = end === -1 ? "" : src.slice(close + 2, end).trim();
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

export function renderMarkdown(src) {
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
