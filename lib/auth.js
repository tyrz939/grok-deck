import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getDataDir } from "./paths.js";

const scryptAsync = promisify(scrypt);
const SESSION_MS = 180 * 24 * 60 * 60 * 1000;
const SLIDE_MS = 90 * 24 * 60 * 60 * 1000;
const SCRYPT_N = 32768;

function authPath() {
  return path.join(getDataDir(), "auth.json");
}

let chain = Promise.resolve();
let state = { password: null, sessions: {} };
let loadedMtime = null;

function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function readState() {
  const file = authPath();
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    state = { password: null, sessions: {} };
    loadedMtime = null;
    return state;
  }
  if (loadedMtime === stat.mtimeMs) return state;
  const parsed = JSON.parse(await fs.readFile(file, "utf8"));
  const now = Date.now();
  const sessions = {};
  for (const [key, value] of Object.entries(parsed.sessions || {})) {
    if (value && value.expires > now) sessions[key] = value;
  }
  state = { password: parsed.password || null, sessions };
  loadedMtime = stat.mtimeMs;
  return state;
}

async function writeState() {
  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = authPath();
  const tmp = file + ".tmp-" + process.pid;
  await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(tmp, file);
  const stat = await fs.stat(file);
  loadedMtime = stat.mtimeMs;
}

export function needsSetup(current = state) {
  return !current.password;
}

export async function getAuthStatus() {
  return locked(async () => {
    const current = await readState();
    return { needsSetup: needsSetup(current) };
  });
}

export async function setPassword(password) {
  return locked(async () => {
    const current = await readState();
    if (current.password) {
      const error = new Error("Password is already set");
      error.status = 409;
      throw error;
    }
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, 64, {
      N: SCRYPT_N,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024,
    });
    current.password = {
      salt: salt.toString("base64"),
      hash: hash.toString("base64"),
      N: SCRYPT_N,
      r: 8,
      p: 1,
    };
    current.sessions = {};
    await writeState();
  });
}

export async function verifyPassword(password) {
  return locked(async () => {
    const current = await readState();
    if (!current.password) return false;
    const record = current.password;
    const hash = await scryptAsync(password, Buffer.from(record.salt, "base64"), 64, {
      N: record.N,
      r: record.r,
      p: record.p,
      maxmem: 128 * 1024 * 1024,
    });
    const expected = Buffer.from(record.hash, "base64");
    if (hash.length !== expected.length) return false;
    return timingSafeEqual(hash, expected);
  });
}

function tokenKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createSession() {
  return locked(async () => {
    const current = await readState();
    const token = randomBytes(32).toString("hex");
    current.sessions[tokenKey(token)] = { created: Date.now(), expires: Date.now() + SESSION_MS };
    await writeState();
    return { token, maxAge: Math.floor(SESSION_MS / 1000) };
  });
}

export async function sessionFromToken(token) {
  if (!token) return null;
  return locked(async () => {
    const current = await readState();
    const key = tokenKey(token);
    const record = current.sessions[key];
    if (!record) return null;
    if (record.expires < Date.now()) {
      delete current.sessions[key];
      await writeState();
      return null;
    }
    if (record.expires - Date.now() < SLIDE_MS) {
      record.expires = Date.now() + SESSION_MS;
      await writeState();
    }
    return { ok: true };
  });
}

export async function destroySession(token) {
  return locked(async () => {
    const current = await readState();
    if (!token) return;
    delete current.sessions[tokenKey(token)];
    await writeState();
  });
}

export function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (key === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return "";
}

export function sessionCookie(token, maxAge, secure = false) {
  const parts = [
    "gm_session=" + encodeURIComponent(token),
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    "Max-Age=" + maxAge,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(secure = false) {
  const parts = ["gm_session=", "HttpOnly", "SameSite=Strict", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
