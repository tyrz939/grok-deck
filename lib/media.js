// The media store. A local file an assistant message links to (a markdown link or image, or a path alone on a
// line) is copied, when the message arrives, into data/media/<sha256>.<ext> and the reference is rewritten to
// /api/media/<sha256>.<ext>?n=<name>. The agent moving or deleting the original later cannot break a past message,
// and the server serves nothing else. Whether a reference names a real file is decided by the filesystem.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
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

// --- which files a reference may name -------------------------------------------------------------------------
// Any readable file under the user's home folder (and the session's own folders, wherever they are) except what
// holds secrets. 13 Oct 2026: a reply linked $HOME/Projects/other-project/NOTES.md from a session in
// $HOME/Projects/my-project; the file was a sibling project, outside the working folder, so it showed "moved or deleted".

const SECRET_NAME = [
  /^\.env(\.|$)/i, /^\.(netrc|npmrc|pypirc|pgpass|git-credentials)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /\.(pem|key|p12|pfx|crt|cer|der|jks|keystore|kdbx|asc|gpg|ppk|token)$/i,
  /^(secrets?|credentials?|tokens?|auth)\.(json|ya?ml|toml|txt|ini|env)$/i,
];
// A folder whose name starts with a dot is private by default; these are the ones that hold things worth showing.
const DOT_OK = [[".grok-deck"], [".grok", "sessions"], [".claude", "plans"], [".claude", "projects"]];

function dotFolderAllowed(parts, at) {
  return DOT_OK.some((want) => want.every((name, i) => parts[at + i] === name));
}

async function denied(real, root, dataDir) {
  const parts = real.slice(root.length).split(path.sep).filter(Boolean); // below the folder it was found in
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].startsWith(".") && !dotFolderAllowed(parts, i)) return true;
  }
  if (SECRET_NAME.some((rule) => rule.test(parts[parts.length - 1] || ""))) return true;
  return !!dataDir && (real === dataDir || real.startsWith(dataDir + path.sep)); // Grok Deck's own data holds the login and TLS keys
}

const real = async (p) => {
  try { return await fs.realpath(p); } catch { return ""; }
};

// The file a reference names: a regular file the filesystem can find, relative to the session's working folder
// first, then its session folder; absolute; or ~/. Spaces and %-encoding are read both ways.
async function sourceFor(target, { cwd, dir: sessionDir }) {
  const h = cleanTarget(target);
  if (!isLocalRef(h) || h.includes("\0")) return null;
  const home = await real(os.homedir());
  const roots = [];
  for (const r of [cwd, sessionDir, home]) {
    const resolved = r ? await real(r) : "";
    if (resolved && resolved !== "/") roots.push(resolved);
  }
  const dataDir = await real(getDataDir());
  const raw = String(target || "").trim().replace(/^<|>$/g, "").replace(/^file:\/\//i, "");
  const tries = [];
  for (const form of new Set([h, raw])) {
    if (form === "~" || form.startsWith("~/")) tries.push(path.join(os.homedir(), form.slice(1)));
    else if (path.isAbsolute(form)) tries.push(form);
    else for (const base of [cwd, sessionDir]) if (base) tries.push(path.join(base, form));
  }
  for (const candidate of tries) {
    const resolved = await real(candidate);
    const root = roots.filter((r) => resolved.startsWith(r + path.sep)).sort((x, y) => y.length - x.length)[0];
    if (!root || (await denied(resolved, root, dataDir))) continue;
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile() && stat.size > 0) return { real: resolved, size: stat.size };
    } catch { /* try the next */ }
  }
  return null;
}

// Names go into a markdown link target, so nothing in them may end or split it.
function safeName(name) {
  return encodeURIComponent(name).replace(/[()'!*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

const limitUrl = (target, size, why) => LIMIT_PATH + "?size=" + size + "&n=" + safeName(baseName(target)) + (why ? "&why=" + why : "");

// Puts bytes in the store under their own hash. Returns the store name, or "" when the store is full.
export async function putBuffer(body, ext) {
  const name = crypto.createHash("sha256").update(body).digest("hex") + "." + ext;
  const file = path.join(dir(), name);
  try {
    await fs.access(file);
  } catch {
    if ((await storeSize()) + body.length > MAX_STORE) return "";
    await fs.mkdir(dir(), { recursive: true });
    const tmp = file + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  return name;
}

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
  const name = await putBuffer(body, ext);
  if (!name) return limitUrl(target, body.length, "store");
  return MEDIA_PREFIX + name + "?n=" + safeName(baseName(target));
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
