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

export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  let html = "";
  let i = 0;
  const fence = (lang, code) =>
    '<div class="code"><button type="button" class="copy">Copy</button><pre><code' +
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
      !lines[i].startsWith(">")
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    html += "<p>" + inline(buf.join(" ")) + "</p>";
  }
  return html;
}
