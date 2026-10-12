// A small syntax highlighter for the code and text files a message links to. It reads the file's own text, token by
// token, for the extension's language family; an unknown family is shown plain.
function escapeHtml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const C_WORDS = "as async await break case catch class const continue default delete do else enum export extends false finally fn for from function func go if impl import in instanceof interface let match mod mut new null nil of package private protected pub public return self static struct super switch this throw true try type typeof undefined use var void while with yield int long float double char bool string".split(" ");
const PY_WORDS = "and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield self".split(" ");
const SH_WORDS = "if then else elif fi for while do done case esac function in return exit export local echo cd set unset source".split(" ");
const SQL_WORDS = "select from where insert into values update set delete create table alter drop index join left right inner outer on group by order having limit as and or not null is in like distinct union primary key".split(" ");
const DATA_WORDS = ["true", "false", "null", "yes", "no"];

const FAMILIES = {
  c: { words: C_WORDS, line: ["//"], block: ["/*", "*/"], quotes: "\"'`" },
  py: { words: PY_WORDS, line: ["#"], quotes: "\"'", triple: true },
  sh: { words: SH_WORDS, line: ["#"], quotes: "\"'" },
  data: { words: DATA_WORDS, line: ["#"], quotes: "\"'" },
  json: { words: DATA_WORDS, line: [], quotes: "\"" },
  sql: { words: SQL_WORDS, line: ["--"], block: ["/*", "*/"], quotes: "'\"", nocase: true },
  css: { words: [], line: [], block: ["/*", "*/"], quotes: "\"'" },
  markup: { words: [], line: [], quotes: "\"'", markup: true },
  diff: { diff: true },
};
const BY_EXT = {
  js: "c", mjs: "c", cjs: "c", ts: "c", tsx: "c", jsx: "c", java: "c", c: "c", h: "c", cpp: "c", hpp: "c", rs: "c", go: "c", swift: "c", kt: "c", php: "c",
  py: "py", rb: "py", sh: "sh", bash: "sh", zsh: "sh", yml: "data", yaml: "data", toml: "data", ini: "data", json: "json",
  sql: "sql", css: "css", html: "markup", htm: "markup", xml: "markup", svg: "markup", diff: "diff", patch: "diff",
};

const span = (cls, text) => '<span class="tok-' + cls + '">' + escapeHtml(text) + "</span>";

function highlightDiff(code) {
  return code.split("\n").map((line) => {
    if (line.startsWith("@@")) return span("key", line);
    if (line.startsWith("+") && !line.startsWith("+++")) return span("add", line);
    if (line.startsWith("-") && !line.startsWith("---")) return span("del", line);
    return escapeHtml(line);
  }).join("\n");
}

export function highlight(code, ext) {
  const family = FAMILIES[BY_EXT[String(ext || "").toLowerCase()]];
  const src = String(code);
  if (!family) return escapeHtml(src);
  if (family.diff) return highlightDiff(src);
  const words = new Set(family.nocase ? family.words.map((w) => w.toLowerCase()) : family.words);
  let out = "";
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i, i + 4);
    if (family.markup && src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const stop = end === -1 ? src.length : end + 3;
      out += span("com", src.slice(i, stop));
      i = stop;
      continue;
    }
    if (family.markup && src[i] === "<" && /[A-Za-z/!?]/.test(src[i + 1] || "")) {
      let j = i + 1;
      while (j < src.length && src[j] !== ">") {
        if (src[j] === '"' || src[j] === "'") {
          const q = src[j];
          const end = src.indexOf(q, j + 1);
          j = end === -1 ? src.length : end + 1;
        } else j += 1;
      }
      const stop = Math.min(src.length, j + 1);
      out += tagHtml(src.slice(i, stop));
      i = stop;
      continue;
    }
    const lineStart = (family.line || []).find((mark) => src.startsWith(mark, i));
    if (lineStart) {
      const end = src.indexOf("\n", i);
      const stop = end === -1 ? src.length : end;
      out += span("com", src.slice(i, stop));
      i = stop;
      continue;
    }
    if (family.block && src.startsWith(family.block[0], i)) {
      const end = src.indexOf(family.block[1], i + family.block[0].length);
      const stop = end === -1 ? src.length : end + family.block[1].length;
      out += span("com", src.slice(i, stop));
      i = stop;
      continue;
    }
    const ch = src[i];
    if (family.quotes && family.quotes.includes(ch)) {
      const triple = family.triple && rest.startsWith(ch.repeat(3));
      const closer = triple ? ch.repeat(3) : ch;
      let j = i + closer.length;
      while (j < src.length && !src.startsWith(closer, j) && (triple || ch === "`" || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
      const stop = Math.min(src.length, j + closer.length);
      out += span("str", src.slice(i, stop));
      i = stop;
      continue;
    }
    if (/[0-9]/.test(ch) && !/[A-Za-z_]/.test(src[i - 1] || "")) {
      const m = /^(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?)/.exec(src.slice(i, i + 40));
      out += span("num", m[0]);
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80));
      const word = m[0];
      out += words.has(family.nocase ? word.toLowerCase() : word) ? span("key", word) : escapeHtml(word);
      i += word.length;
      continue;
    }
    out += escapeHtml(ch);
    i += 1;
  }
  return out;
}

function tagHtml(tag) {
  const m = /^(<\/?[^\s>/]*)([\s\S]*?)(\/?>)?$/.exec(tag);
  if (!m) return escapeHtml(tag);
  const attrs = m[2].replace(/("[^"]*"|'[^']*')/g, "\u0000$1\u0001");
  const painted = escapeHtml(attrs).replace(/\u0000(.*?)\u0001/g, (_all, text) => '<span class="tok-str">' + text + "</span>");
  return span("key", m[1]) + painted + (m[3] ? span("key", m[3]) : "");
}
