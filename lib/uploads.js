// Files the user attaches to a message. Each upload goes into the content-addressed media store (so the chat can
// show it as an embed card for good) and, when the message is sent, a copy goes into the session's working folder
// under .grok-deck/uploads/ so the agent can open it. The prompt names the copy and carries the file's text where
// that is sensible: text and code as they are, PDF through pdftotext, Office files through a small extractor.
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { embedKind, LIMIT_BYTES, MEDIA_PREFIX } from "../public/markdown.js";
import { putBuffer, statMedia } from "./media.js";
import { zipEntries, zipRead } from "./zip.js";

export const MAX_UPLOAD = LIMIT_BYTES; // 25 MB
export const MAX_FILES = 8;
const TEXT_PER_FILE = 20000; // characters of one file's text in the prompt
const TEXT_TOTAL = 60000; // characters of all attached text in one prompt
export const TAG = "deck-attachments";

function bad(status, message) {
  return Object.assign(new Error(message), { status });
}

export function sizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

export function cleanFileName(raw) {
  const base = String(raw || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, "_").replace(/^\.+/, "").trim();
  return (base || "file").slice(-120);
}

const extOf = (name) => ((/\.([A-Za-z0-9]{1,8})$/.exec(name) || [])[1] || "bin").toLowerCase();

// Called with the whole body of an upload. Stores it and says what it is.
export async function saveUpload(body, rawName) {
  const name = cleanFileName(rawName);
  if (!body.length) throw bad(400, name + " is empty.");
  if (body.length > MAX_UPLOAD) throw bad(413, name + " is " + sizeLabel(body.length) + ", over the " + sizeLabel(MAX_UPLOAD) + " limit.");
  const ext = extOf(name);
  const id = await putBuffer(body, ext);
  if (!id) throw bad(507, "The media store is full.");
  return { id, name, size: body.length, kind: embedKind(ext), url: MEDIA_PREFIX + id + "?n=" + encodeURIComponent(name) };
}

// --- text out of a file -------------------------------------------------------------------------------------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlText(xml) {
  return xml
    .replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>|<\/w:p>|<\/a:p>|<\/si>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function officeText(buffer, ext) {
  const entries = zipEntries(buffer);
  const read = (entry) => zipRead(buffer, entry)?.toString("utf8") || "";
  if (ext === "docx") {
    const doc = entries.find((e) => e.name === "word/document.xml");
    return doc ? xmlText(read(doc)) : "";
  }
  if (ext === "pptx") {
    const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name)).sort((a, b) => parseInt(a.name.replace(/\D/g, ""), 10) - parseInt(b.name.replace(/\D/g, ""), 10));
    return slides.map((e, i) => "Slide " + (i + 1) + ":\n" + xmlText(read(e))).join("\n\n");
  }
  if (ext === "xlsx") {
    const strings = entries.find((e) => e.name === "xl/sharedStrings.xml");
    return strings ? xmlText(read(strings)) : "";
  }
  return "";
}

function pdfText(file) {
  return new Promise((resolve) => {
    execFile("pdftotext", ["-layout", "-nopgbrk", "-q", file, "-"], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : String(stdout)));
  });
}

// The text of a file as far as it can be read: "" when there is none to give (a picture, a zip, a PDF with no text).
export async function textOfFile(file, ext, buffer) {
  const kind = embedKind(ext);
  if (kind === "code" || kind === "markdown") {
    const head = buffer.subarray(0, TEXT_PER_FILE * 4);
    return head.includes(0) ? "" : head.toString("utf8");
  }
  if (kind === "pdf") return pdfText(file);
  if (["docx", "pptx", "xlsx"].includes(ext)) return officeText(buffer, ext);
  return "";
}

// --- into the working folder, and into the prompt -------------------------------------------------------------

const KIND_LABEL = { image: "image", video: "video", audio: "audio", pdf: "PDF", markdown: "Markdown", code: "text", file: "file" };

// The files of a request, checked for shape only: [{ id, name }] as the upload endpoint gave them.
export function cleanFileRefs(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw bad(400, "Files must be a list");
  if (input.length > MAX_FILES) throw bad(400, "Attach up to " + MAX_FILES + " files.");
  return input.map((f) => {
    const id = String(f?.id || "");
    if (!/^[0-9a-f]{64}\.[a-z0-9]{1,8}$/.test(id)) throw bad(400, "Unknown file");
    return { id, name: cleanFileName(f?.name) };
  });
}

// files: [{ id, name }] as the upload endpoint gave them. Returns what was saved and the block for the prompt.
export async function attachFiles(files, cwd) {
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { files: [], block: "" };
  if (list.length > MAX_FILES) throw bad(400, "Attach up to " + MAX_FILES + " files.");
  const folder = path.join(cwd, ".grok-deck", "uploads");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(cwd, ".grok-deck", ".gitignore"), "*\n").catch(() => {}); // uploads never end up in the project's git
  const saved = [];
  const parts = [];
  let budget = TEXT_TOTAL;
  for (const item of list) {
    const id = String(item?.id || "");
    const stored = await statMedia(id);
    if (!stored) throw bad(400, cleanFileName(item?.name) + " is no longer available. Attach it again.");
    const name = cleanFileName(item.name);
    const ext = extOf(name);
    const body = await fs.readFile(stored.file);
    let target = path.join(folder, name);
    const existing = await fs.readFile(target).catch(() => null);
    if (existing && !existing.equals(body)) {
      const sha = crypto.createHash("sha256").update(body).digest("hex").slice(0, 8);
      target = path.join(folder, name.replace(/(\.[A-Za-z0-9]{1,8})?$/, (m) => "-" + sha + m));
    }
    if (!existing || !existing.equals(body)) await fs.writeFile(target, body);
    saved.push({ name, id, size: body.length, path: target });
    const kind = embedKind(ext);
    let line = "- " + target + " (" + (KIND_LABEL[kind] || "file") + ", " + sizeLabel(body.length) + ")";
    let text = budget > 0 ? (await textOfFile(target, ext, body)).replace(new RegExp("</" + TAG + ">", "gi"), "").trim() : "";
    if (text) {
      const cut = text.length > Math.min(TEXT_PER_FILE, budget);
      text = text.slice(0, Math.min(TEXT_PER_FILE, budget));
      budget -= text.length;
      line += "\nText of " + name + (cut ? " (the first part; read the file for the rest)" : "") + ":\n" + text;
    }
    parts.push(line);
  }
  const header = JSON.stringify(saved.map(({ name, id, size }) => ({ name, id, size })));
  const block = "<" + TAG + ">\n" + header + "\nAttached files, saved in the working folder:\n" + parts.join("\n\n") + "\n</" + TAG + ">";
  return { files: saved.map(({ name, id, size }) => ({ name, id, size })), block };
}

// A user message as it comes back from the session's history: the block is machinery, and the files in it become
// the message's attachments. Found by the tag, never by wording.
export function extractAttachments(text) {
  const raw = String(text || "");
  const open = raw.indexOf("<" + TAG + ">\n");
  if (open < 0) return { files: [], text: raw };
  const close = raw.indexOf("</" + TAG + ">", open);
  const inner = raw.slice(open + TAG.length + 3, close < 0 ? raw.length : close);
  let files = [];
  try {
    const parsed = JSON.parse(inner.split("\n", 1)[0]);
    if (Array.isArray(parsed)) files = parsed.filter((f) => f && typeof f.id === "string" && typeof f.name === "string").map((f) => ({ id: f.id, name: f.name, size: Number(f.size) || 0 }));
  } catch { /* a block we did not write: leave the text alone */ return { files: [], text: raw }; }
  const rest = (raw.slice(0, open) + (close < 0 ? "" : raw.slice(close + TAG.length + 3))).trim();
  return { files, text: rest };
}
