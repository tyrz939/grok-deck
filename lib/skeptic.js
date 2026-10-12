import crypto from "node:crypto";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { proofSummary, proofVerdict } from "./evidence.js";
import { getDataDir } from "./paths.js";
import { getTurn, isBusy, startTurn, turnEvents, viewTurn } from "./runner.js";
import { getMeta, loadTranscript, setSessionPrefs } from "./sessions.js";
import { queueFor } from "./queue.js";
import { isLongRun } from "./longrun.js";

// Skeptical review: after a turn that claims "done" on non-trivial or risky work, a separate `grok -p`
// process in a fresh context tries to refute the claims (reruns checks, tries edge cases) and returns a verdict.
// Design: SKEPTIC-DESIGN-2026-10-11.md.

const envMs = (name, fallback) => (process.env[name] != null && process.env[name] !== "" && Number.isFinite(Number(process.env[name])) ? Number(process.env[name]) : fallback);
const REVIEW_TIMEOUT_MS = envMs("GM_SKEPTIC_TIMEOUT_MS", 15 * 60 * 1000);
const COOLDOWN_MS = envMs("GM_SKEPTIC_COOLDOWN_MS", 5 * 60 * 1000);
const MAX_REVIEWS_RUNNING = 2;
const AGENT_FILE = process.env.GM_SKEPTIC_AGENT || path.join(path.dirname(new URL(import.meta.url).pathname), "..", "agents", "skeptic.md");
const MODES = new Set(["default", "off", "auto", "always"]);

export const DEFAULTS = { mode: "off", model: "auto", effort: "high", autoLoop: false, maxRounds: 2, maxPerHour: 6, budgetTokens: 400000 };

// This grok build rejects `--allowed-tools`. Bash patterns go through repeatable `--allow` rules.
// dontAsk denies every command that is not on this list, including git commit, git push, and the network.
const REVIEWER_ALLOW = [
  "Read", "Grep", "Glob",
  "Bash(git diff)", "Bash(git diff *)",
  "Bash(git log)", "Bash(git log *)",
  "Bash(git show)", "Bash(git show *)",
  "Bash(git status)", "Bash(git status *)",
  "Bash(npm test)", "Bash(npm test *)",
  "Bash(node)", "Bash(node *)",
  "Bash(python3)", "Bash(python3 *)",
  "Bash(ls)", "Bash(ls *)",
  "Bash(cat)", "Bash(cat *)",
  "Bash(grep)", "Bash(grep *)",
  "Bash(rg)", "Bash(rg *)",
];
const REVIEWER_DENY = [
  "Bash(git commit)", "Bash(git commit *)",
  "Bash(git push)", "Bash(git push *)",
  "Bash(git add)", "Bash(git add *)",
  "Bash(curl)", "Bash(curl *)",
  "Bash(wget)", "Bash(wget *)",
  "Bash(ssh)", "Bash(ssh *)",
];
export const VERDICT_SCHEMA = JSON.stringify({
  type: "object",
  required: ["verdict", "summary", "issues", "unverified", "ran"],
  properties: {
    verdict: { enum: ["pass", "issues"] },
    summary: { type: "string", maxLength: 240 },
    issues: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        required: ["severity", "title", "evidence"],
        properties: {
          severity: { enum: ["high", "medium", "low"] },
          title: { type: "string", maxLength: 160 },
          where: { type: "string" },
          claim: { type: "string" },
          evidence: { type: "string", maxLength: 600 },
          fix_hint: { type: "string", maxLength: 300 },
        },
      },
    },
    unverified: { type: "array", maxItems: 6, items: { type: "string", maxLength: 200 } },
    ran: { type: "array", maxItems: 12, items: { type: "object", properties: { command: { type: "string" }, exit: { type: "integer" } } } },
  },
});

export function reviewerArgs({ model, effort, packet, extra = {} }) {
  return [
    "--agent", extra.agentFile || AGENT_FILE,
    "-m", model,
    "--reasoning-effort", effort,
    "--max-turns", "25",
    "--no-subagents",
    "--permission-mode", "dontAsk",
    "--tools", "read_file,grep,list_dir,run_terminal_cmd",
    "--disallowed-tools", "search_replace,web_search,web_fetch,Write,Edit,DeleteFile,MultiEdit",
    ...REVIEWER_ALLOW.flatMap((rule) => ["--allow", rule]),
    ...REVIEWER_DENY.flatMap((rule) => ["--deny", rule]),
    "--output-format", "json",
    "--json-schema", VERDICT_SCHEMA,
    ...(extra.args || []),
    "-p", packet,
  ];
}

const dir = () => path.join(getDataDir(), "skeptic");
const settingsFile = () => path.join(getDataDir(), "settings.json");
const states = new Map(); // sessionId -> { review, dismissed: [hash], round, dismissStreak, history: [{at,tokens}], lastLines, lastAt }
const running = new Map(); // sessionId -> { child, cancelled }
const loopPending = new Set(); // sessionIds whose current turn was sent by the auto-loop
const startedAt = []; // app-wide review start times for the hourly cap
let settingsCache = { ...DEFAULTS };

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

// ---------- settings ----------

export function cleanSettings(input, base = settingsCache) {
  const out = { ...base };
  const src = input && typeof input === "object" ? input : {};
  if (src.mode != null) out.mode = ["off", "auto", "always"].includes(src.mode) ? src.mode : base.mode;
  if (src.model != null) out.model = typeof src.model === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(src.model) ? src.model : "auto";
  if (src.effort != null) out.effort = ["low", "medium", "high", "xhigh"].includes(src.effort) ? src.effort : base.effort;
  if (src.autoLoop != null) out.autoLoop = !!src.autoLoop;
  const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(Math.max(Math.round(Number(v)), lo), hi) : d);
  if (src.maxRounds != null) out.maxRounds = num(src.maxRounds, 1, 4, base.maxRounds);
  if (src.maxPerHour != null) out.maxPerHour = num(src.maxPerHour, 1, 60, base.maxPerHour);
  if (src.budgetTokens != null) out.budgetTokens = num(src.budgetTokens, 50000, 20e6, base.budgetTokens);
  return out;
}

export async function loadSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile(), "utf8"));
    settingsCache = cleanSettings(saved.skeptic, { ...DEFAULTS });
  } catch {
    settingsCache = { ...DEFAULTS };
  }
  return settingsCache;
}

export function getSettings() {
  return { ...settingsCache };
}

export async function setSettings(patch) {
  settingsCache = cleanSettings(patch);
  let all = {};
  try {
    all = JSON.parse(await fs.readFile(settingsFile(), "utf8"));
  } catch {
    // first save
  }
  await writeJson(settingsFile(), { ...all, skeptic: settingsCache });
  return getSettings();
}

export function cleanSessionMode(value) {
  return MODES.has(value) ? value : "default";
}

function effective(prefs) {
  const mode = cleanSessionMode(prefs?.skeptic);
  const g = getSettings();
  const loop = prefs?.skepticLoop === "on" ? true : prefs?.skepticLoop === "off" ? false : g.autoLoop;
  return { ...g, mode: mode === "default" ? g.mode : mode, autoLoop: loop };
}

// ---------- state ----------

async function loadState(id) {
  let st = states.get(id);
  if (st) return st;
  st = { review: null, dismissed: [], round: 0, dismissStreak: 0, history: [], lastLines: 0, lastAt: 0 };
  try {
    st = { ...st, ...JSON.parse(await fs.readFile(path.join(dir(), id + ".json"), "utf8")) };
    // A review that was running when the service stopped never finished.
    if (st.review?.state === "running") st.review = { ...st.review, state: "error", note: "Interrupted by a service restart", finishedAt: Date.now() };
  } catch {
    // none yet
  }
  states.set(id, st);
  return st;
}

async function save(id, st) {
  states.set(id, st);
  await writeJson(path.join(dir(), id + ".json"), st).catch((error) => console.error("skeptic save failed", error?.code || "error"));
  turnEvents.emit("changed", { id, what: "skeptic", review: publicReview(st.review) });
}

export function publicReview(review) {
  return review ? { ...review, packet: undefined } : null;
}

export async function reviewFor(id) {
  return publicReview((await loadState(id)).review);
}

export async function usageFor(id) {
  const st = await loadState(id);
  return { reviews: st.totalReviews || 0, tokens: st.totalTokens || 0, costUsd: st.totalCostUsd || 0 };
}

export function isReviewing(id) {
  return running.has(id);
}

export function reviewCount() {
  return running.size;
}

// ---------- gate (pure, unit tested) ----------

const CLAIM = /\b(done|finished|fixed|implemented|works|working|all (the )?tests? pass(ed|es)?|complete(d)?|ready|resolved|passes|shipped|deployed|verified)\b/i;
const RISK_PATH = /(auth|session|password|passwd|token|secret|credential|migrat|schema|\.sql\b|lock|race|concurren|payment|billing|money|\.service\b|systemd|crontab|sudoers|firewall|\bdelete|\brm\b)/i;
const RISK_CODE = /(rm\s+-rf|chmod\s|DROP\s+TABLE|ALTER\s+TABLE|BEGIN\s+TRANSACTION|flock\(|threading\.Lock|child_process|subprocess|eval\(|os\.system|setuid)/i;
const DOC_ONLY = /\.(md|txt|rst|adoc)$/i;

export function claimsDone(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  const tail = t.slice(-600);
  if (/\?\s*$/.test(tail) && !CLAIM.test(tail)) return false;
  return CLAIM.test(t);
}

// info: { files: [path], lines, hasDiff, riskCode, evidenceTone, ultra }
export function riskSignals(info) {
  const out = [];
  if ((info.files?.length || 0) > 3) out.push("more than 3 files changed");
  if ((info.lines || 0) > 80) out.push("more than 80 changed lines");
  if (info.evidenceTone === "warn") out.push("no passing check after the last edit");
  const hit = (info.files || []).find((f) => RISK_PATH.test(path.basename(f)) || RISK_PATH.test(f.split("/").slice(-2).join("/")));
  if (hit) out.push("risky path: " + path.basename(hit));
  if (info.riskCode) out.push("risky code pattern");
  if (info.ultra) out.push("Ultra session");
  return out;
}

// -> { run: bool, reason, signals }
export function shouldReview(input) {
  const { mode, manual, stopReason, summary, finalText, info, longRunDone } = input;
  if (manual) return { run: true, reason: "manual", signals: [] };
  if (mode === "off") return { run: false, reason: "off", signals: [] };
  if (stopReason !== "end_turn") return { run: false, reason: "turn did not end normally", signals: [] };
  if (!summary || summary.edits === 0) return { run: false, reason: "no files changed", signals: [] };
  if (!longRunDone && !claimsDone(finalText)) return { run: false, reason: "no completion claim", signals: [] };
  if (mode === "always") return { run: true, reason: "always", signals: [] };
  let signals = riskSignals(info);
  // Nothing to run for docs, so "no check after the edit" alone is not a reason.
  if ((info.files?.length || 0) > 0 && info.files.every((f) => DOC_ONLY.test(f))) {
    signals = signals.filter((x) => x !== "no passing check after the last edit");
    if (!signals.length) return { run: false, reason: "docs only", signals };
  }
  if (!signals.length) return { run: false, reason: "small change with a passing check", signals };
  return { run: true, reason: "risky or non-trivial", signals };
}

// ---------- git state ----------

function sh(cmd, cwd, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out = (out + c.toString("utf8")).slice(-400000)));
    child.stderr.on("data", () => {});
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // gone
      }
    }, timeoutMs);
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

const CACHE_NOISE = /(^|\/)(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|node_modules\/\.cache|\.cache)(\/|$)|\.pyc$/;

// Tracked-diff hash plus the untracked list (minus caches). Also the changed-line count and file names.
export async function workState(cwd, fallbackFiles = []) {
  if (!cwd) return { git: false, hash: "", files: fallbackFiles, lines: 0, untracked: [], riskCode: false };
  const probe = await sh("git rev-parse --is-inside-work-tree 2>/dev/null", cwd);
  if (probe.code !== 0) {
    const stats = [];
    for (const f of fallbackFiles.slice(0, 100)) {
      try {
        const s = await fs.stat(f);
        stats.push(f + ":" + s.size + ":" + Math.round(s.mtimeMs));
      } catch {
        stats.push(f + ":gone");
      }
    }
    return { git: false, hash: crypto.createHash("sha1").update(stats.join("\n")).digest("hex"), files: fallbackFiles, lines: 0, untracked: [], riskCode: false };
  }
  const status = (await sh("git status --porcelain=v1 -uall 2>/dev/null", cwd)).out;
  const rows = status.split("\n").filter(Boolean).map((l) => ({ code: l.slice(0, 2), file: l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop() }));
  const untracked = rows.filter((r) => r.code === "??" && !CACHE_NOISE.test(r.file)).map((r) => r.file).sort();
  const files = [...new Set([...rows.filter((r) => !CACHE_NOISE.test(r.file)).map((r) => r.file), ...fallbackFiles.map((f) => (f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f))])];
  const diff = (await sh("git diff HEAD 2>/dev/null", cwd, 30000)).out;
  const added = diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  let lines = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).length;
  const content = crypto.createHash("sha1");
  for (const f of untracked.slice(0, 50)) {
    const t = await fs.readFile(path.join(cwd, f), "utf8").catch(() => "");
    content.update(f + "\0" + t.slice(0, 200000));
    lines += t.split("\n").length;
    added.push(...t.split("\n").slice(0, 400));
  }
  const hash = crypto.createHash("sha1").update(diff + "\n" + untracked.join("\n") + "\n" + content.digest("hex")).digest("hex");
  return { git: true, hash, files, lines, untracked, riskCode: RISK_CODE.test(added.join("\n")) };
}

// ---------- packet and reviewer ----------

// Messages of the latest turn: live turn if we have it, else the saved transcript (after a restart).
async function lastMessages(id) {
  let messages = [];
  const turn = getTurn(id);
  try {
    messages = turn ? viewTurn(turn).messages || [] : (await loadTranscript(id)).messages || [];
  } catch {
    // none
  }
  const find = (role) => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === role) return String(messages[i].text || "");
    return "";
  };
  return { asked: find("user"), finalText: find("assistant") };
}

export function buildPacket({ cwd, asked, finalText, files, execs, evidenceText, state, goal }) {
  const cmds = (execs || []).slice(-40).map((e) => "  - exit " + e.code + ": " + String(e.command).split("\n")[0].slice(0, 200));
  return [
    "Folder: " + cwd,
    "",
    "The agent was asked:",
    String(asked || "(not available)").slice(0, 3000),
    "",
    "The agent's final message (its claims):",
    String(finalText || "(none)").slice(0, 4000),
    "",
    "What the app observed this turn:",
    "- Files edited: " + (files.length ? files.slice(0, 40).join(", ") : "(none seen)"),
    "- Commands run and exit codes:" + (cmds.length ? "\n" + cmds.join("\n") : " (none)"),
    "- App evidence verdict: " + (evidenceText || "n/a"),
    "- Work state: " + (state.git ? "git repo; run `git status` and `git diff HEAD` yourself; about " + state.lines + " changed lines" : "not a git repo; read the edited files"),
    goal ? "\nLong run goal and acceptance checks (GOAL.md): " + goal.slice(0, 3000) : "",
    "",
    "Review this per your rules. Finish with one JSON object and nothing after it:",
    '{"verdict":"pass"|"issues","summary":"<=240 chars","issues":[{"severity":"high"|"medium"|"low","title":"","where":"file:line","claim":"","evidence":"command output or file:line","fix_hint":""}],"unverified":["claim you could not confirm"],"ran":[{"command":"","exit":0}]}',
  ].join("\n");
}

// Last balanced JSON object that has a "verdict" key.
export function extractVerdict(text) {
  const s = String(text || "");
  const starts = [];
  for (let i = s.indexOf("{"); i >= 0; i = s.indexOf("{", i + 1)) starts.push(i);
  for (const start of starts.reverse()) {
    let depth = 0;
    let inStr = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const obj = JSON.parse(s.slice(start, i + 1));
          if (obj && typeof obj === "object" && "verdict" in obj) return obj;
        } catch {
          // not this one
        }
        break;
      }
    }
  }
  return null;
}

// Issues without evidence are demoted to "unverified"; the verdict follows the filtered list.
export function normalizeVerdict(raw) {
  const sev = new Set(["high", "medium", "low"]);
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  const issues = [];
  const unverified = (Array.isArray(raw?.unverified) ? raw.unverified : []).map((u) => str(u, 200)).filter(Boolean);
  for (const item of Array.isArray(raw?.issues) ? raw.issues : []) {
    const evidence = str(item?.evidence, 600).trim();
    const title = str(item?.title, 160).trim();
    if (!title) continue;
    if (evidence.length < 15) {
      unverified.push(title + " (no evidence given)");
      continue;
    }
    issues.push({ severity: sev.has(item.severity) ? item.severity : "medium", title, where: str(item.where, 160), claim: str(item.claim, 200), evidence, fixHint: str(item.fix_hint || item.fixHint, 300) });
  }
  const order = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    verdict: issues.length ? "issues" : "pass",
    summary: str(raw?.summary, 240),
    issues: issues.slice(0, 6),
    unverified: unverified.slice(0, 6),
    ran: (Array.isArray(raw?.ran) ? raw.ran : []).slice(0, 12).map((r) => ({ command: str(r?.command, 200), exit: Number.isInteger(r?.exit) ? r.exit : null })),
  };
}

async function pickModel(setting, sessionModel) {
  if (setting && setting !== "auto") return setting;
  // Prefer a different model from the session's (self-preference bias); fall back to the default model.
  try {
    const cache = JSON.parse(await fs.readFile(path.join(process.env.GROK_HOME || path.join(process.env.HOME || "", ".grok"), "models_cache.json"), "utf8"));
    const ids = (Array.isArray(cache) ? cache : cache.models || cache.data || []).map((m) => (typeof m === "string" ? m : m.id || m.name)).filter((m) => typeof m === "string" && /^grok-\d/.test(m) && !/fast|mini|vision|image|imagine/.test(m));
    const other = ids.find((m) => m !== sessionModel && !m.startsWith(sessionModel + "-"));
    if (other) return other;
  } catch {
    // no cache
  }
  return sessionModel || "grok-4.7";
}

// extra: { agentFile, args, env } lets the benchmark run the same reviewer under a sandbox profile and a private GROK_HOME.
export function runReviewer({ cwd, model, effort, packet, onChild, extra = {} }) {
  return new Promise((resolve) => {
    const args = reviewerArgs({ model, effort, packet, extra });
    const child = spawn(process.env.GROK_BIN || "grok", args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(extra.env || {}), GM_LONGRUN: "1", GM_SKEPTIC: "1", PYTHONDONTWRITEBYTECODE: "1", CI: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    });
    onChild?.(child);
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out = (out + c.toString("utf8")).slice(-2_000_000)));
    child.stderr.on("data", (c) => (err = (err + c.toString("utf8")).slice(-2000)));
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // gone
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGINT");
      setTimeout(() => kill("SIGKILL"), 4000).unref?.();
    }, REVIEW_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ error: "Could not start Grok: " + (e?.message || "error") });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        // maybe NDJSON or text
      }
      resolve({ code, timedOut, json, raw: out, err });
    });
  });
}

// ---------- review ----------

function tokensOf(json) {
  const u = json?.usage || {};
  return Number(u.total_tokens) || (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
}

function dayTokens(st) {
  const since = Date.now() - 24 * 3600 * 1000;
  return st.history.filter((h) => h.at > since).reduce((sum, h) => sum + h.tokens, 0);
}

function hourStarts() {
  const since = Date.now() - 3600 * 1000;
  while (startedAt.length && startedAt[0] < since) startedAt.shift();
  return startedAt.length;
}

async function sessionPrefs(id) {
  const meta = await getMeta();
  return meta.sessions?.[id] || {};
}

// Runs a review for the session's latest turn. Returns the saved review. trigger: auto | manual | longrun.
// opts.goal: long-run GOAL.md text. opts.force skips caps/cooldown/dismissal (manual and long-run).
export async function startReview(id, trigger, opts = {}) {
  const st = await loadState(id);
  if (running.has(id)) return publicReview(st.review);
  if (running.size >= MAX_REVIEWS_RUNNING) return publicReview(st.review);
  const turn = getTurn(id);
  const prefs = await sessionPrefs(id);
  const cfg = effective(prefs);
  const cwd = turn?.cwd || prefs.cwd || "";
  if (!cwd) throw Object.assign(new Error("No folder for this session"), { status: 409 });
  const summary = turn ? proofSummary(turn.proof) : { files: [] };
  const state = await workState(cwd, summary.files);
  const forced = trigger !== "auto";
  if (!forced) {
    if (st.dismissed.includes(state.hash) || st.review?.hash === state.hash) return publicReview(st.review);
    if (hourStarts() >= cfg.maxPerHour) return skipped(id, st, state, "Skipped: hourly cap of " + cfg.maxPerHour + " reviews reached");
    if (dayTokens(st) >= cfg.budgetTokens) return skipped(id, st, state, "Skipped: daily skeptic token budget reached");
    const grew = state.lines - (st.lastLines || 0) > 40;
    if (Date.now() - (st.lastAt || 0) < COOLDOWN_MS && !grew) return publicReview(st.review);
  }
  const model = await pickModel(cfg.model, prefs.model || "grok-4.7");
  const effort = opts.effort || cfg.effort;
  const review = {
    id: crypto.randomUUID(),
    state: "running",
    trigger,
    round: st.round + 1,
    hash: state.hash,
    model,
    effort,
    startedAt: Date.now(),
    signals: opts.signals || [],
    summary: "",
    issues: [],
    unverified: [],
    ran: [],
    tokens: 0,
    costUsd: 0,
    note: "",
    sent: false,
    dismissed: false,
  };
  st.review = review;
  st.lastAt = Date.now();
  st.lastLines = state.lines;
  startedAt.push(Date.now());
  await save(id, st);
  const before = state;
  const msgs = await lastMessages(id);
  const packet = buildPacket({
    cwd,
    asked: msgs.asked,
    finalText: msgs.finalText,
    files: before.files.length ? before.files : summary.files,
    execs: turn?.execs || [],
    evidenceText: turn ? proofVerdict(turn.proof)?.text : "",
    state: before,
    goal: opts.goal,
  });
  const slot = { child: null, cancelled: false };
  running.set(id, slot);
  console.log("skeptic", id, "start", trigger, model, effort);
  try {
    const result = await runReviewer({ cwd, model, effort, packet, onChild: (child) => (slot.child = child) });
    const done = { ...review, finishedAt: Date.now() };
    done.tokens = tokensOf(result.json);
    done.costUsd = Number(result.json?.total_cost_usd) || 0;
    if (slot.cancelled) {
      Object.assign(done, { state: "cancelled", note: slot.note || "Cancelled" });
    } else if (result.error) {
      Object.assign(done, { state: "error", note: result.error });
    } else if (result.timedOut) {
      Object.assign(done, { state: "error", note: "Timed out after " + Math.round(REVIEW_TIMEOUT_MS / 60000) + " min" });
    } else {
      const text = result.json?.text || result.raw;
      const verdict = extractVerdict(text);
      if (!verdict) Object.assign(done, { state: "error", note: result.json?.stopReason === "cancelled" ? "Reviewer stopped early" : "Reviewer did not return a verdict" });
      else {
        const clean = normalizeVerdict(verdict);
        const after = await workState(cwd, summary.files);
        const changed = after.hash !== before.hash;
        if (changed) Object.assign(done, { state: "error", note: "Tainted: files changed while the review ran, so the verdict was discarded" });
        else Object.assign(done, { state: clean.verdict, summary: clean.summary, issues: clean.issues, unverified: clean.unverified, ran: clean.ran });
      }
    }
    const fresh = await loadState(id);
    fresh.review = done;
    fresh.history.push({ at: Date.now(), tokens: done.tokens });
    fresh.totalReviews = (fresh.totalReviews || 0) + 1;
    fresh.totalTokens = (fresh.totalTokens || 0) + done.tokens;
    fresh.totalCostUsd = (fresh.totalCostUsd || 0) + done.costUsd;
    fresh.history = fresh.history.filter((h) => h.at > Date.now() - 48 * 3600 * 1000);
    if (done.state === "pass") {
      fresh.round = 0;
      fresh.dismissStreak = 0;
    }
    await save(id, fresh);
    console.log("skeptic", id, "end", done.state, done.tokens, "tokens");
    return publicReview(done);
  } finally {
    running.delete(id);
  }
}

async function skipped(id, st, state, note) {
  if (st.review?.state === "skipped" && st.review.note === note && Date.now() - st.review.finishedAt < 3600 * 1000) return publicReview(st.review);
  st.review = { id: crypto.randomUUID(), state: "skipped", trigger: "auto", round: st.round, hash: state.hash, note, startedAt: Date.now(), finishedAt: Date.now(), issues: [], unverified: [], ran: [], tokens: 0, costUsd: 0, sent: false, dismissed: false };
  await save(id, st);
  return publicReview(st.review);
}

export function cancelReview(id, note = "Cancelled") {
  const slot = running.get(id);
  if (!slot) return false;
  slot.cancelled = true;
  slot.note = note;
  try {
    process.kill(-slot.child.pid, "SIGINT");
  } catch {
    // gone
  }
  setTimeout(() => {
    try {
      process.kill(-slot.child.pid, "SIGKILL");
    } catch {
      // gone
    }
  }, 4000).unref?.();
  return true;
}

export function cancelAll() {
  for (const id of [...running.keys()]) cancelReview(id, "Service shutting down");
}

// ---------- send issues, dismiss, auto-loop ----------

export function issuesPrompt(review) {
  const lines = [
    "An independent reviewer rechecked your last turn and found problems. Verify each one yourself, fix the real ones, rerun the checks, and reply with what you changed. If you think a finding is wrong, say why with evidence.",
    "",
  ];
  review.issues.forEach((issue, i) => {
    lines.push(i + 1 + ". [" + issue.severity + "] " + issue.title + (issue.where ? " (" + issue.where + ")" : ""));
    lines.push("   Evidence: " + issue.evidence);
  });
  if (review.unverified?.length) lines.push("", "Claims the reviewer could not confirm; prove them or retract them: " + review.unverified.join("; "));
  return lines.join("\n");
}

export async function sendIssues(id, { auto = false } = {}) {
  const st = await loadState(id);
  const review = st.review;
  if (!review || review.state !== "issues") throw Object.assign(new Error("No issues to send"), { status: 409 });
  if (review.sent) throw Object.assign(new Error("Already sent"), { status: 409 });
  if (isBusy(id)) throw Object.assign(new Error("A turn is already running"), { status: 409 });
  st.review = { ...review, sent: true, sentAuto: auto };
  st.round = review.round;
  st.dismissStreak = 0;
  if (auto) loopPending.add(id);
  await save(id, st);
  try {
    await startTurn({ sessionId: id, prompt: issuesPrompt(review) });
  } catch (error) {
    loopPending.delete(id);
    st.review = { ...review, sent: false };
    await save(id, st);
    throw error;
  }
  return publicReview(st.review);
}

export async function dismiss(id) {
  const st = await loadState(id);
  if (!st.review) return null;
  const was = st.review;
  st.review = { ...was, dismissed: true };
  if (was.hash && !st.dismissed.includes(was.hash)) st.dismissed = [...st.dismissed, was.hash].slice(-50);
  if (was.state === "issues") st.dismissStreak += 1;
  let turnedOff = false;
  if (st.dismissStreak >= 3) {
    const prefs = await sessionPrefs(id);
    if (effective(prefs).mode === "auto") {
      await setSessionPrefs(id, { skeptic: "off" });
      turnEvents.emit("changed", { id, what: "prefs" });
      turnedOff = true;
    }
    st.dismissStreak = 0;
  }
  if (turnedOff) st.review.note = "Skeptical review turned off for this session after 3 dismissals. Turn it back on from the + menu.";
  await save(id, st);
  return publicReview(st.review);
}

// A message from the user resets the loop; a running review of the old diff is stale.
export function userSent(id) {
  cancelReview(id, "Cancelled: you sent a new message");
  states.get(id) && (states.get(id).round = 0);
}

async function afterReview(id, review) {
  if (!review || review.state !== "issues") return;
  const prefs = await sessionPrefs(id);
  const cfg = effective(prefs);
  if (!cfg.autoLoop || review.trigger === "longrun") return;
  const st = await loadState(id);
  const note = async (text) => {
    st.review = { ...st.review, note: text };
    await save(id, st);
  };
  if (!review.issues.some((i) => i.severity === "high" || i.severity === "medium")) return;
  if (review.round >= cfg.maxRounds) return note("Still has issues after " + review.round + " round" + (review.round === 1 ? "" : "s") + ": your call");
  if (st.prevTitles && st.prevTitles === titlesKey(review)) return note("Same issues as the last round: not sending again");
  st.prevTitles = titlesKey(review);
  await save(id, st);
  if (queueFor(id).length || isBusy(id)) return;
  try {
    await sendIssues(id, { auto: true });
  } catch (error) {
    console.error("skeptic auto-send failed", error?.message || "error");
  }
}

function titlesKey(review) {
  return review.issues.map((i) => i.title.toLowerCase().replace(/\W+/g, " ").trim()).sort().join("|");
}

// ---------- long run ----------

// Used by the long-run DONE gate. -> { ok, summary, detail, tokens, review }
export async function reviewForLongRun(run, goalText, cwd) {
  const prefs = await sessionPrefs(run.id);
  const cfg = effective(prefs);
  if (cfg.mode === "off") return { skip: true };
  const turn = getTurn(run.id);
  const info = turn ? proofSummary(turn.proof) : { edits: 0, files: [] };
  const state = await workState(cwd, info.files);
  const st = await loadState(run.id);
  if (st.review?.hash === state.hash && st.review.trigger === "longrun" && st.review.state === "pass") return { ok: true, summary: "skeptic pass (unchanged since last review)", detail: "", tokens: 0 };
  let review;
  try {
    review = await startReview(run.id, "longrun", { goal: goalText, effort: cfg.effort, round: run.skepticRounds || 0, signals: ["long run DONE"] });
  } catch (error) {
    return { ok: true, summary: "skeptic unavailable: " + (error?.message || "error"), detail: "", tokens: 0 };
  }
  if (review.state === "pass") return { ok: true, summary: "skeptic pass", detail: "", tokens: review.tokens, review };
  if (review.state === "issues" && review.issues.some((i) => i.severity !== "low")) {
    return { ok: false, summary: review.issues.length + " issue(s) from the skeptic", detail: issuesPrompt(review), tokens: review.tokens, review };
  }
  if (review.state === "issues") return { ok: true, summary: "skeptic pass (low issues only)", detail: "", tokens: review.tokens, review };
  return { ok: true, summary: "skeptic " + (review.state === "error" ? "unavailable: " + review.note : review.state), detail: "", tokens: review.tokens, review };
}

// ---------- wiring ----------

export function startSkeptic() {
  turnEvents.on("finished", async ({ id, stopReason }) => {
    try {
      const wasLoop = loopPending.delete(id);
      const st = await loadState(id);
      if (!wasLoop) st.round = 0;
      const turn = getTurn(id);
      if (!turn || running.has(id)) return;
      const prefs = await sessionPrefs(id);
      const cfg = effective(prefs);
      if (cfg.mode === "off") return;
      // The long-run supervisor reviews at DONE; CONTINUE turns are never reviewed.
      if (isLongRun(id)) return;
      const summary = proofSummary(turn.proof);
      const state = await workState(turn.cwd, summary.files);
      const evidence = proofVerdict(turn.proof);
      const decision = shouldReview({
        mode: cfg.mode,
        stopReason,
        summary,
        finalText: (await lastMessages(id)).finalText,
        info: { files: state.files, lines: state.lines, riskCode: state.riskCode, evidenceTone: evidence?.tone, ultra: !!prefs.ultra },
      });
      console.log("skeptic", id, "gate", decision.run ? "review" : "skip", decision.reason);
      if (!decision.run) return;
      const review = await startReview(id, "auto", { signals: decision.signals });
      await afterReview(id, review);
    } catch (error) {
      console.error("skeptic failed", error?.message || "error");
    }
  });
  // A new turn means the diff under review is stale.
  turnEvents.on("changed", ({ id, what }) => {
    if (what !== "turn") return;
    const turn = getTurn(id);
    if (turn && !turn.done && running.has(id) && !loopPending.has(id)) cancelReview(id, "Cancelled: a new turn started");
  });
}
