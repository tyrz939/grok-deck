import { cleanThemeId } from "./theme.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readUpdatesFile } from "./history.js";
import { getDataDir } from "./paths.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function metaPath() {
  return path.join(getDataDir(), "meta.json");
}

let chain = Promise.resolve();

function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {}
  );
  return run;
}

async function readMeta() {
  try {
    return JSON.parse(await fs.readFile(metaPath(), "utf8"));
  } catch {
    return { sessions: {}, recentDirs: [] };
  }
}

async function writeMeta(meta) {
  const dir = getDataDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = metaPath();
  const tmp = file + ".tmp-" + process.pid;
  await fs.writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function updateMeta(fn) {
  return locked(async () => {
    const meta = await readMeta();
    if (!meta.sessions) meta.sessions = {};
    if (!Array.isArray(meta.recentDirs)) meta.recentDirs = [];
    const next = (await fn(meta)) || meta;
    await writeMeta(next);
    return next;
  });
}

export async function getMeta() {
  return locked(() => readMeta());
}

function sessionsRoot() {
  return path.join(process.env.GROK_HOME || path.join(os.homedir(), ".grok"), "sessions");
}

function bad(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// The real path must stay inside root. A symlink that leaves root is rejected.
export async function resolveInside(root, candidate) {
  const base = await fs.realpath(root);
  const real = await fs.realpath(candidate);
  if (real !== base && !real.startsWith(base + path.sep)) {
    const error = new Error("outside");
    error.code = "EPERM";
    throw error;
  }
  return real;
}

export async function realDirectory(cwd) {
  if (typeof cwd !== "string" || !cwd.trim()) throw bad(400, "Choose a directory");
  if (cwd.includes("\0")) throw bad(400, "Choose a directory");
  const resolved = path.resolve(cwd);
  let real;
  try {
    real = await fs.realpath(resolved);
  } catch {
    throw bad(400, "Directory does not exist");
  }
  const stat = await fs.stat(real);
  if (!stat.isDirectory()) throw bad(400, "Directory does not exist");
  return real;
}

async function groupCwd(dirName, groupPath) {
  const cwdFile = path.join(groupPath, ".cwd");
  try {
    const text = (await fs.readFile(cwdFile, "utf8")).trim();
    if (text) return text;
  } catch {
    // Folder name is the encoded path.
  }
  try {
    return decodeURIComponent(dirName);
  } catch {
    return dirName;
  }
}

export async function findSession(id) {
  if (!isUuid(id)) return null;
  const root = sessionsRoot();
  let groups;
  try {
    groups = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupPath = path.join(root, group.name);
    const sessionPath = path.join(groupPath, id);
    try {
      const stat = await fs.stat(path.join(sessionPath, "summary.json"));
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    let summary = {};
    try {
      summary = JSON.parse(await fs.readFile(path.join(sessionPath, "summary.json"), "utf8"));
    } catch {
      summary = {};
    }
    const cwd = summary?.info?.cwd || (await groupCwd(group.name, groupPath));
    return { id, dir: sessionPath, cwd, summary };
  }
  return null;
}

function titleFor(metaRow, summary) {
  if (metaRow?.title) return metaRow.title;
  if (summary?.generated_title) return summary.generated_title;
  if (summary?.session_summary) return summary.session_summary;
  if (metaRow?.draftTitle) return metaRow.draftTitle;
  return "New session";
}

function rowFrom(id, summary, metaRow, running) {
  const cwd = metaRow?.cwd || summary?.info?.cwd || "";
  return {
    id,
    title: titleFor(metaRow, summary),
    cwd,
    model: metaRow?.model || summary?.current_model_id || "grok-4.7",
    effort: metaRow?.effort || summary?.reasoning_effort || "high",
    permissionMode: cleanMode(metaRow?.permissionMode, "default"),
    ultra: !!metaRow?.ultra,
    plan: !!metaRow?.plan,
    theme: typeof metaRow?.theme === "string" ? metaRow.theme : "",
    archived: !!metaRow?.archived,
    autoApprove: Array.isArray(metaRow?.autoApprove) ? metaRow.autoApprove : [],
    skeptic: ["off", "auto", "always"].includes(metaRow?.skeptic) ? metaRow.skeptic : "default",
    skepticLoop: ["on", "off"].includes(metaRow?.skepticLoop) ? metaRow.skepticLoop : "default",
    waiting: !!metaRow?.waiting,
    createdAt: summary?.created_at || null,
    updatedAt: summary?.updated_at || summary?.last_active_at || summary?.created_at || null,
    running: !!running,
    tokens: 0,
    snippet: "",
  };
}

const SNIPPET_TAIL = 48 * 1024;

function chunkText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(chunkText).join("");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content) return chunkText(content.content);
  }
  return "";
}

// The last user or assistant message, one line. Reads only the tail of updates.jsonl.
export function lastMessageSnippet(jsonl) {
  const parts = [];
  let role = "";
  const lines = String(jsonl || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const update = row?.params?.update || row.update || row;
    const kind = update?.sessionUpdate || update?.type || "";
    if (kind !== "agent_message_chunk" && kind !== "user_message_chunk") {
      if (parts.length) break;
      continue;
    }
    if (role && kind !== role) break;
    role = kind;
    const text = chunkText(update.content);
    if (text) parts.push(text);
    if (parts.join("").length > 180) break;
  }
  const flat = parts.reverse().join("").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > 140 ? flat.slice(0, 137).trimEnd() + "..." : flat;
}

async function messageSnippet(dir) {
  const file = path.join(dir, "updates.jsonl");
  let handle;
  try {
    const stat = await fs.stat(file);
    const length = Math.min(SNIPPET_TAIL, stat.size);
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
    let text = buffer.toString("utf8");
    if (stat.size > length) {
      const newline = text.indexOf("\n");
      if (newline !== -1) text = text.slice(newline + 1);
    }
    return lastMessageSnippet(text);
  } catch {
    return "";
  } finally {
    if (handle) await handle.close();
  }
}

// Token use for the sidebar. Reads the two small files only, not the transcript.
async function usageGlance(dir) {
  const out = { tokens: 0 };
  try {
    const usage = JSON.parse(await fs.readFile(path.join(dir, "usage.json"), "utf8"));
    out.tokens = Number(usage.session?.totalTokens) || 0;
  } catch {
    // No usage file yet.
  }
  try {
    const sig = JSON.parse(await fs.readFile(path.join(dir, "signals.json"), "utf8"));
    const used = Number(sig.contextTokensUsed) || 0;
    const window = Number(sig.contextWindowTokens) || 0;
    if (window) out.context = { used, window };
  } catch {
    // No context sample yet.
  }
  return out;
}

export async function listSessions(activeIds = new Map()) {
  const meta = await getMeta();
  const root = sessionsRoot();
  const rows = [];
  const pending = [];
  const seen = new Set();
  let groups = [];
  try {
    groups = await fs.readdir(root, { withFileTypes: true });
  } catch {
    groups = [];
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupPath = path.join(root, group.name);
    let children = [];
    try {
      children = await fs.readdir(groupPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const cwdFallback = await groupCwd(group.name, groupPath);
    for (const child of children) {
      if (!child.isDirectory() || !isUuid(child.name)) continue;
      const summaryPath = path.join(groupPath, child.name, "summary.json");
      let summary;
      try {
        summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
      } catch {
        continue;
      }
      if (summary.session_kind === "subagent") continue;
      if (!summary.info) summary.info = {};
      if (!summary.info.cwd) summary.info.cwd = cwdFallback;
      const live = activeIds.get(child.name);
      const metaRow = live ? { ...(meta.sessions?.[child.name] || {}), waiting: live.waiting } : meta.sessions?.[child.name];
      const row = rowFrom(child.name, summary, metaRow, activeIds.has(child.name));
      rows.push(row);
      const dir = path.join(groupPath, child.name);
      pending.push(Promise.all([usageGlance(dir), messageSnippet(dir)]).then(([glance, snippet]) => {
        Object.assign(row, glance);
        row.snippet = snippet;
      }));
      seen.add(child.name);
    }
  }
  for (const [id, extra] of activeIds) {
    if (seen.has(id)) continue;
    const metaRow = { ...(meta.sessions?.[id] || {}), ...(extra || {}) };
    rows.push(rowFrom(id, {}, metaRow, true));
  }
  await Promise.all(pending);
  rows.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1;
    return Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0);
  });
  return rows.slice(0, 200);
}

export async function sessionRecord(id, running = false) {
  const found = await findSession(id);
  const meta = await getMeta();
  const metaRow = meta.sessions?.[id];
  if (!found && !metaRow && !running) return null;
  return rowFrom(id, found?.summary || {}, { ...metaRow, cwd: metaRow?.cwd || found?.cwd }, running);
}

export async function loadTranscript(id) {
  const found = await findSession(id);
  if (!found) return { messages: [] };
  const file = path.join(found.dir, "updates.jsonl");
  return readUpdatesFile(file);
}

export async function applyManualTitle(id, title) {
  const found = await findSession(id);
  if (!found) return false;
  let summary;
  try {
    summary = JSON.parse(await fs.readFile(path.join(found.dir, "summary.json"), "utf8"));
  } catch {
    return false;
  }
  if (!summary.session_summary || summary.session_summary === summary.generated_title) {
    summary.session_summary = title;
  }
  summary.generated_title = title;
  summary.title_is_manual = true;
  const file = path.join(found.dir, "summary.json");
  const tmp = file + ".tmp-" + process.pid;
  await fs.writeFile(tmp, JSON.stringify(summary, null, 2) + "\n");
  await fs.rename(tmp, file);
  return true;
}

export async function setSessionPrefs(id, patch) {
  return updateMeta((meta) => {
    const prev = meta.sessions[id] || {};
    meta.sessions[id] = { ...prev, ...patch };
    return meta;
  });
}

export async function rememberDir(dir) {
  return updateMeta((meta) => {
    meta.recentDirs = [dir, ...meta.recentDirs.filter((item) => item !== dir)].slice(0, 12);
    return meta;
  });
}

export async function listDirs() {
  const meta = await getMeta();
  const recentFromSessions = [];
  const rows = await listSessions();
  for (const row of rows) {
    if (row.cwd) recentFromSessions.push(row.cwd);
  }
  const home = os.homedir();
  const seeds = [...(meta.recentDirs || []), ...recentFromSessions, path.join(home, "Projects"), home];
  const out = [];
  const seen = new Set();
  for (const dir of seeds) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    try {
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    out.push(dir);
    if (out.length >= 20) break;
  }
  return out;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh"]);
const MODES = new Set(["default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]);

export function cleanEffort(value, fallback = "high") {
  return EFFORTS.has(value) ? value : fallback;
}

export function cleanMode(value, fallback = "default") {
  return MODES.has(value) ? value : fallback;
}

export function cleanModel(value, fallback = "grok-4.7") {
  if (typeof value !== "string") return fallback;
  if (value.startsWith("-")) return fallback;
  if (!/^[A-Za-z0-9._:-]{1,64}$/.test(value)) return fallback;
  return value;
}

export function cleanTitle(value) {
  if (typeof value !== "string") return "";
  const title = value.replace(/[\u0000-\u001f]/g, "").trim();
  return title.slice(0, 120);
}

// Version 2 runs grok over ACP with real approvals. Sessions that only had the
// old read-only default move to Ask; a mode the user picked himself stays.
export async function migrateMeta() {
  return updateMeta((meta) => {
    if (meta.version >= 2) return meta;
    for (const row of Object.values(meta.sessions || {})) {
      if (row.permissionMode === "dontAsk" || row.permissionMode === "plan" || !row.permissionMode) row.permissionMode = "default";
    }
    meta.version = 2;
    return meta;
  });
}

export async function getThemePref() {
  const meta = await getMeta();
  return cleanThemeId(meta.appTheme, "purple");
}

export async function setThemePref(pref) {
  const value = cleanThemeId(pref, "purple");
  await updateMeta((meta) => {
    meta.appTheme = value;
    return meta;
  });
  return value;
}

export function cleanAppearance(value) {
  return value === "light" ? "light" : "dark";
}

export async function getAppearance() {
  const meta = await getMeta();
  return cleanAppearance(meta.appAppearance);
}

export async function setAppearance(value) {
  const next = cleanAppearance(value);
  await updateMeta((meta) => {
    meta.appAppearance = next;
    return meta;
  });
  return next;
}

// Delete moves Grok's session folder into Grok Deck's trash (data/trash), so a slip can be undone by hand.
export async function trashSession(id) {
  const found = await findSession(id);
  const trash = path.join(getDataDir(), "trash");
  await fs.mkdir(trash, { recursive: true, mode: 0o700 });
  if (found) {
    const dest = path.join(trash, id + "-" + Date.now().toString(36));
    await fs.rename(found.dir, dest);
    await fs.writeFile(path.join(dest, ".origin"), found.dir + "\n").catch(() => {});
  }
  await updateMeta((meta) => {
    if (meta.sessions) delete meta.sessions[id];
    return meta;
  });
  return !!found;
}

// Tokens and time for one session, from Grok's own usage.json and turn records.
export async function sessionUsage(id) {
  const found = await findSession(id);
  const out = { tokens: 0, turns: 0, ms: 0, subagentTokens: 0, costUsd: 0 };
  if (!found) return out;
  try {
    const usage = JSON.parse(await fs.readFile(path.join(found.dir, "usage.json"), "utf8"));
    out.tokens = Number(usage.session?.totalTokens) || 0;
    out.turns = Number(usage.session?.turnCount) || 0;
    out.costUsd = (Number(usage.session?.costUsdTicks) || 0) / 1e10;
  } catch {
    // No usage file yet.
  }
  try {
    const text = await fs.readFile(path.join(found.dir, "updates.jsonl"), "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("subagent_spawned") && /"subagent_type":"(strong|ultra-[a-z]+)"|"description":"(Strong|Ultra)\b/.test(line)) out.escalations = (out.escalations || 0) + 1;
      else if (line.includes("grok-escalate ") && line.includes('"sessionUpdate":"tool_call"')) out.escalations = (out.escalations || 0) + 1;
      if (!line.includes("turn_completed") && !line.includes("subagent_finished")) continue;
      try {
        const update = JSON.parse(line)?.params?.update || {};
        if (update.sessionUpdate === "turn_completed") out.ms += Number(update.elapsed_ms) || 0;
        if (update.sessionUpdate === "subagent_finished") out.subagentTokens += Number(update.tokens_used) || 0;
      } catch {
        // Skip a torn line.
      }
    }
  } catch {
    // No updates yet.
  }
  try {
    const sig = JSON.parse(await fs.readFile(path.join(found.dir, "signals.json"), "utf8"));
    const used = Number(sig.contextTokensUsed) || 0;
    const window = Number(sig.contextWindowTokens) || 0;
    if (window) out.context = { used, window };
  } catch {
    // No signals yet.
  }
  return out;
}
