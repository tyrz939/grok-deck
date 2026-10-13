// The media store. A local file an assistant message links to (a markdown link or image, or a path alone on a
// line) is copied, when the message arrives, into data/media/<sha256>.<ext> and the reference is rewritten to
// /api/media/<sha256>.<ext>?n=<name>. The agent moving or deleting the original later cannot break a past message,
// and the server serves nothing else. Whether a reference names a real file is decided by the filesystem.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { baseName, cleanTarget, embedKind, findRefs, isLocalRef, LIMIT_BYTES, LIMIT_PATH, MEDIA_PREFIX, rewriteRefs } from "../public/markdown.js";
import { sniff } from "./images.js";
import { getDataDir } from "./paths.js";

export const MAX_FILE = LIMIT_BYTES; // one file; over it the message gets a "too large" card
export const MAX_STORE = 2 * 1024 * 1024 * 1024; // the whole store; past it nothing new is copied
const MAX_INDEX = 50000;
const IMAGE_TYPE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const TYPES = {
  ...IMAGE_TYPE,
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac", flac: "audio/flac",
  pdf: "application/pdf",
};
const NAME = /^([0-9a-f]{64})\.([a-z0-9]{1,8})$/;

const dir = () => path.join(getDataDir(), "media");
const indexFile = () => path.join(dir(), "index.json");

// How a stored file is sent. Text and code go out as plain text so nothing in the store can run as a page.
export function mediaType(name) {
  const m = NAME.exec(String(name || ""));
  if (!m) return "";
  const ext = m[2];
  if (TYPES[ext]) return TYPES[ext];
  const kind = embedKind(ext);
  return kind === "markdown" || kind === "code" ? "text/plain; charset=utf-8" : "application/octet-stream";
}

export async function statMedia(name) {
  if (!NAME.test(String(name || ""))) return null;
  try {
    const file = path.join(dir(), name);
    const stat = await fs.stat(file);
    return stat.isFile() ? { file, size: stat.size } : null;
  } catch {
    return null;
  }
}

async function storeSize() {
  let total = 0;
  try {
    for (const name of await fs.readdir(dir())) {
      if (!NAME.test(name)) continue;
      total += (await fs.stat(path.join(dir(), name))).size;
    }
  } catch { /* no store yet */ }
  return total;
}

// The file a reference names, if it is a regular file inside the session's working folder or session folder.
async function sourceFor(target, { cwd, dir: sessionDir }) {
  const h = cleanTarget(target);
  if (!isLocalRef(h) || h.includes("\0")) return null;
  const roots = [];
  for (const r of [cwd, sessionDir]) {
    if (!r) continue;
    try { roots.push(await fs.realpath(r)); } catch { /* skip */ }
  }
  const tries = path.isAbsolute(h) ? [h] : roots.map((root) => path.join(root, h));
  for (const candidate of tries) {
    try {
      const real = await fs.realpath(candidate);
      const root = roots.find((r) => r !== "/" && real.startsWith(r + path.sep));
      if (!root || real.slice(root.length).split(path.sep).some((part) => part.startsWith("."))) continue;
      const stat = await fs.stat(real);
      if (stat.isFile() && stat.size > 0) return { real, size: stat.size };
    } catch { /* try the next */ }
  }
  return null;
}

// Names go into a markdown link target, so nothing in them may end or split it.
function safeName(name) {
  return encodeURIComponent(name).replace(/[()'!*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

const limitUrl = (target, size, why) => LIMIT_PATH + "?size=" + size + "&n=" + safeName(baseName(target)) + (why ? "&why=" + why : "");

// Copies the file a reference names into the store. Returns its stable URL, the "too large" URL when it is over the
// cap, or "" when there is nothing to copy (no such file, not inside the folder, not what its extension says).
export async function internTarget(target, session) {
  const found = await sourceFor(target, session);
  if (!found) return "";
  const ext = (/\.([A-Za-z0-9]{1,8})$/.exec(found.real) || [])[1]?.toLowerCase();
  if (!ext) return "";
  if (found.size > MAX_FILE) return limitUrl(target, found.size);
  let body;
  try { body = await fs.readFile(found.real); } catch { return ""; }
  if (body.length > MAX_FILE) return limitUrl(target, body.length);
  if (IMAGE_TYPE[ext] && sniff(body) !== IMAGE_TYPE[ext]) return "";
  const name = crypto.createHash("sha256").update(body).digest("hex") + "." + ext;
  const file = path.join(dir(), name);
  try {
    await fs.access(file);
  } catch {
    if ((await storeSize()) + body.length > MAX_STORE) return limitUrl(target, body.length, "store");
    await fs.mkdir(dir(), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  return MEDIA_PREFIX + name + "?n=" + safeName(baseName(target));
}

// A user attachment. The extension is taken from the file name; an image extension that is not that image
// is stored as .bin so the store never serves a mismatched picture. Every other type is kept as named.
export const MAX_UPLOADS = 8;

export function storeExt(filename) {
  const base = baseName(filename);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "bin";
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext.length > 8) return "bin";
  for (let i = 0; i < ext.length; i++) {
    const code = ext.charCodeAt(i);
    const ok = (code >= 48 && code <= 57) || (code >= 97 && code <= 122);
    if (!ok) return "bin";
  }
  return ext;
}

function sizeLabel(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
}

function oneLine(value) {
  const text = String(value || "").split("\r").join(" ").split("\n").join(" ").trim();
  return text.slice(0, 180) || "file";
}

export function uploadName(value) {
  const raw = String(value || "");
  let text = raw;
  try { text = decodeURIComponent(raw); } catch { text = raw; }
  return oneLine(baseName(text));
}

function rejectUpload(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export async function storeUpload(body, filename) {
  const label = uploadName(filename);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body || []);
  if (bytes.length > MAX_FILE) throw rejectUpload(label + " is over the 25 MB limit.", 413);
  let ext = storeExt(label);
  if (IMAGE_TYPE[ext] && sniff(bytes) !== IMAGE_TYPE[ext]) ext = "bin";
  const name = crypto.createHash("sha256").update(bytes).digest("hex") + "." + ext;
  const file = path.join(dir(), name);
  try {
    await fs.access(file);
  } catch {
    if ((await storeSize()) + bytes.length > MAX_STORE) throw rejectUpload("The media store is full.", 413);
    await fs.mkdir(dir(), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  return { name, url: MEDIA_PREFIX + name + "?n=" + safeName(label), size: bytes.length, label, path: file };
}

export function cleanUploads(input) {
  if (input == null) return [];
  if (!Array.isArray(input)) throw rejectUpload("Files must be a list", 400);
  if (input.length > MAX_UPLOADS) throw rejectUpload("Attach up to " + MAX_UPLOADS + " files", 400);
  const files = [];
  for (const item of input) {
    const name = String(item?.name || "");
    if (!NAME.test(name)) throw rejectUpload("Unknown attachment", 400);
    const label = oneLine(item?.label || "file");
    files.push({ name, label, url: MEDIA_PREFIX + name + "?n=" + safeName(label) });
  }
  return files;
}

export async function resolveUploads(input) {
  const listed = cleanUploads(input);
  const out = [];
  for (const item of listed) {
    const stat = await statMedia(item.name);
    if (!stat) throw rejectUpload("Attachment is missing", 400);
    out.push({ name: item.name, label: item.label, url: item.url, size: stat.size, path: stat.file });
  }
  return out;
}

// Text added to the prompt so the agent can open each file. The path is the stored file.
export function attachmentNote(files) {
  if (!files?.length) return "";
  const lines = ["Attached files. Read each file at its path:"];
  for (const file of files) {
    lines.push("- " + file.label + " (" + sizeLabel(file.size) + "): " + file.path);
    lines.push("  " + file.url);
  }
  return lines.join("\n");
}

// --- which store file a past message's reference meant -----------------------------------------------------
// Keyed by the session, the message's own text and the reference, so a path the agent later reuses for another
// image does not change what an older message showed.

const key = (sessionId, text, target) =>
  crypto.createHash("sha1").update([sessionId, String(text).replace(/\s+/g, " ").trim(), target].join("\0")).digest("hex");

let chain = Promise.resolve();
let cache = null;

async function loadIndex() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(indexFile(), "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

export function remember(sessionId, text, pairs) {
  chain = chain.then(async () => {
    const index = await loadIndex();
    for (const [target, url] of pairs) index[key(sessionId, text, target)] = url;
    const keys = Object.keys(index);
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_INDEX))) delete index[old];
    await fs.mkdir(dir(), { recursive: true });
    const tmp = indexFile() + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(index), { mode: 0o600 });
    await fs.rename(tmp, indexFile());
  }).catch(() => {});
  return chain;
}

async function known(sessionId, text, target) {
  await chain;
  const url = (await loadIndex())[key(sessionId, text, target)];
  if (!url) return "";
  if (url.startsWith(LIMIT_PATH)) return url;
  return (await statMedia(url.slice(MEDIA_PREFIX.length).split("?")[0])) ? url : "";
}

// A message read back from disk: each local image reference becomes the store URL it had when the message
// arrived; one that never got copied is copied now if its file is still there. What cannot be found stays as
// written, and the client shows the "moved or deleted" card for it.
export async function internMessages(messages, sessionId, session) {
  for (const message of messages || []) {
    if (message.role !== "assistant" || !message.text) continue;
    const map = new Map();
    const fresh = [];
    for (const token of findRefs(message.text)) {
      if (!isLocalRef(token.target) || map.has(token.target)) continue;
      const url = (await known(sessionId, message.text, token.target)) || (await internTarget(token.target, session));
      if (url) {
        map.set(token.target, url);
        fresh.push([token.target, url]);
      }
    }
    if (map.size) {
      await remember(sessionId, message.text, fresh);
      message.text = rewriteRefs(message.text, map);
    }
  }
  return messages;
}
