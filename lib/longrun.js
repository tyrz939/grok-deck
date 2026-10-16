import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { getDataDir } from "./paths.js";
import { cancelTurn, getTurn, isBusy, pushEvent, startTurn, turnEvents, viewTurn } from "./runner.js";
import { getMeta } from "./sessions.js";
import { queueFor } from "./queue.js";
import { findSession } from "./sessions.js";
import { getSettings as skepticSettings, reviewForLongRun } from "./skeptic.js";

// Long run: a durable goal loop around ordinary turns.
// Grok keeps GOAL.md + PROGRESS.md in the project and commits local checkpoints; this supervisor
// starts the next turn until Grok reports LONGRUN: DONE / BLOCKED, or the hours/token budget is hit.
// A watchdog resumes after a crashed grok process, a stalled turn, or a service restart.

const STALL_MS = Number(process.env.GM_LONGRUN_STALL_MS) || 25 * 60 * 1000;
const WATCHDOG_MS = Number(process.env.GM_WATCHDOG_MS) || 30000;
const NEXT_MS = Number(process.env.GM_LONGRUN_NEXT_MS) || 5000;
const MAX_FAILS = 5;
const dir = () => path.join(getDataDir(), "longrun");
const runs = new Map();
const timers = new Map();
const MAX_QUIET_TOOL_MS = Number(process.env.GM_LONGRUN_TOOL_QUIET_MS) || 3 * 60 * 60 * 1000; // a single quiet build/test may run this long before it counts as stalled
const NO_PROGRESS_TURNS = 3;
let shuttingDown = false;
export function setShuttingDown() {
  shuttingDown = true;
}

export const LONG_RULES = [
  "LONG RUN MODE. This is an autonomous multi-hour run; the user is not watching. Work until the goal is met and verified.",
  "Durable state lives in the project folder, because your context will be compacted many times: GOAL.md holds the objective, a checklist, and a `## Checks` section listing one shell command per line (as `- \`command\``) that must all exit 0 when the goal is met; Grok Deck runs these itself before accepting DONE. PROGRESS.md holds Done / In progress / Next / Notes (decisions, dead ends, exact commands). Create them on the first turn, read both at the start of every turn, and update PROGRESS.md after every milestone.",
  "Checkpoints: at each milestone that passes its checks, make a local git commit (git init first if this folder is not a repo). Never push, never touch remotes, never deploy, send, purchase or spend. Stop at anything destructive outside this folder.",
  "Work in small verified steps (test first where it fits). If something fails, debug it, fix it and rerun; record dead ends in PROGRESS.md so you don't repeat them.",
  "In long-run mode it is correct to end a turn with open todos and `LONGRUN: CONTINUE`; don't cancel real todo items to get past a stop check.",
  "End every turn with exactly one status line as the LAST line: `LONGRUN: CONTINUE` (more to do; you will be resumed automatically), `LONGRUN: DONE` (every acceptance check in GOAL.md passed and you ran them this turn), or `LONGRUN: BLOCKED <reason>` (needs the user: missing access, destructive step, or out of scope). Before it, give a 2 to 5 line summary of this turn.",
];

function file(id) {
  return path.join(dir(), id + ".json");
}

async function save(run) {
  await fs.mkdir(dir(), { recursive: true, mode: 0o700 });
  const tmp = file(run.id) + "." + process.pid + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(run, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file(run.id));
  turnEvents.emit("changed", { id: run.id, what: "longrun", run: view(run) });
  pushEvent(run.id, { type: "longrun", run: view(run) });
}

export function view(run) {
  if (!run) return null;
  const turn = getTurn(run.id);
  return {
    status: run.status,
    goal: String(run.goal || "").slice(0, 300),
    hours: run.hours,
    tokens: run.tokens,
    startedAt: run.startedAt,
    turns: run.turns,
    usedTokens: run.usedTokens,
    skepticTokens: run.skepticTokens || 0,
    skepticRounds: run.skepticRounds || 0,
    skepticNote: run.skepticNote || "",
    resumes: run.resumes,
    lastActivity: Math.max(run.lastActivity || 0, run.heartbeat || 0, (turn && !turn.done && turn.lastEventAt) || 0),
    note: run.note || "",
    running: !!(turn && !turn.done),
  };
}

export function longRunFor(id) {
  return view(runs.get(id));
}

export function isLongRun(id) {
  const run = runs.get(id);
  return !!run && run.status === "running";
}

export async function loadRuns() {
  try {
    for (const name of await fs.readdir(dir())) {
      if (!name.endsWith(".json")) continue;
      try {
        const run = JSON.parse(await fs.readFile(path.join(dir(), name), "utf8"));
        if (run?.id) {
          // In-memory flags from the previous process mean nothing now.
          run.verifying = false;
          run.restarting = false;
          runs.set(run.id, run);
        }
      } catch {
        // skip a torn file
      }
    }
  } catch {
    // none yet
  }
  // After a service restart, running long runs resume on the next watchdog tick.
}

export async function beginLongRun(id, { goal, hours, tokens, prefs, resume }) {
  const old = runs.get(id);
  if (resume && old) {
    old.status = "running";
    old.fails = 0;
    old.idle = 0;
    old.skepticRounds = 0;
    old.note = "Resumed by the user";
    if (Number(hours) > 0) old.hours = Math.min(Math.max(Number(hours), 0.1), 48);
    old.lastActivity = Date.now();
    await save(old);
    return view(old);
  }
  const run = {
    id,
    goal: String(goal || "").slice(0, 20000),
    hours: Math.min(Math.max(Number(hours) || 12, 0.1), 48),
    tokens: Math.min(Math.max(Number(tokens) || 40e6, 1e5), 500e6),
    prefs: prefs || {},
    status: "running",
    startedAt: Date.now(),
    lastActivity: Date.now(),
    turns: 1,
    usedTokens: 0,
    resumes: 0,
    fails: 0,
    note: "",
  };
  runs.set(id, run);
  await save(run);
  return view(run);
}

export async function stopLongRun(id, why = "Stopped by the user") {
  const run = runs.get(id);
  if (!run) return null;
  run.status = "stopped";
  run.note = why;
  clearTimeout(timers.get(id));
  await save(run);
  return view(run);
}

function lastAssistant(id) {
  const turn = getTurn(id);
  if (!turn) return "";
  try {
    const msgs = viewTurn(turn).messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") return String(msgs[i].text || "");
  } catch {
    // fall through
  }
  return "";
}

// Each turn's tokens are added once, whether the turn finished normally or was cut off by a shutdown.
function countTokens(run) {
  const turn = getTurn(run.id);
  if (!turn || turn.tokensCounted) return;
  turn.tokensCounted = true;
  run.usedTokens += turnTokens(run.id);
}

// Called on shutdown, after turns are stopped: process.exit would otherwise beat the async "finished" handler.
export async function flushRuns() {
  for (const run of runs.values()) {
    if (run.status !== "running") continue;
    countTokens(run);
    await save(run).catch(() => {});
  }
}

function turnTokens(id) {
  const turn = getTurn(id);
  return (Number(turn?.tokensUsed || 0) || 0) + (Number(turn?.subTokensUsed || 0) || 0);
}

const CONTINUE = (run) =>
  "Continue the long run. First read GOAL.md and PROGRESS.md (your context may have been compacted or the process restarted). " +
  "Pick the next unchecked item, do it, verify it, update PROGRESS.md and commit a local checkpoint at each milestone. " +
  "Elapsed " + Math.round((Date.now() - run.startedAt) / 60000) + " min of a " + run.hours + " h budget. End with the LONGRUN status line.";

async function next(run, prompt, notify) {
  clearTimeout(timers.get(run.id));
  timers.set(
    run.id,
    setTimeout(async () => {
      if (run.status !== "running") return;
      if (isBusy(run.id) || queueFor(run.id).length) return; // the user's queued message or a live turn wins
      try {
        await startTurn({ sessionId: run.id, prompt, ...run.prefs, extraRules: LONG_RULES.join("\n"), longRun: true });
        run.turns += 1;
        run.lastActivity = Date.now();
        await save(run);
      } catch (error) {
        run.fails += 1;
        run.note = "Couldn't resume: " + (error?.message || "error");
        if (run.fails >= MAX_FAILS) {
          run.status = "stalled";
          notify?.(run, "Long run stalled", run.note);
        }
        await save(run);
        if (run.status === "running") next(run, prompt, notify);
      }
    }, Math.min(NEXT_MS * 2 ** run.fails, 5 * 60 * 1000)),
  );
}

export function startSupervisor(notify) {
  turnEvents.on("finished", async ({ id, stopReason }) => {
    const run = runs.get(id);
    if (!run || run.status !== "running") return;
    if (shuttingDown) return; // a service restart leaves the run "running"; flushRuns() saves it and the watchdog resumes it
    run.lastActivity = Date.now();
    countTokens(run);
    const text = lastAssistant(id);
    // The status line has to be the last line. "LONGRUN: CONTINUE (not DONE yet)" is a CONTINUE.
    const keyword = longrunKeyword(text);
    const status = keyword ? String(text).split("\n").map((item) => item.trim()).filter(Boolean).pop() : "";
    const elapsedH = (Date.now() - run.startedAt) / 3600000;
    if (run.restarting) {
      run.restarting = false;
      run.resumes += 1;
      run.note = run.restartWhy || "Resumed";
      await save(run);
      return next(run, CONTINUE(run), notify);
    }
    if (stopReason === "cancelled") {
      run.status = "paused";
      run.note = "Paused: the turn was stopped. Resume from the + menu.";
      await save(run);
      return;
    }
    if (keyword === "DONE") {
      run.verifying = true; // the watchdog leaves the run alone while checks run (up to 15 min each)
      let verdict;
      try {
        verdict = await verifyGoal(run);
      } finally {
        run.verifying = false;
      }
      run.lastActivity = Date.now();
      if (verdict.ok) {
        // Second gate: a skeptical reviewer in a fresh context (only when the session or app setting has it on).
        run.verifying = true;
        run.note = "Checks passed; skeptic reviewing before DONE";
        await save(run);
        let skeptic = { skip: true };
        try {
          const cwd = await runCwd(run);
          const goalText = await fs.readFile(path.join(cwd, "GOAL.md"), "utf8").catch(() => "");
          skeptic = await reviewForLongRun(run, goalText, cwd);
        } catch (error) {
          skeptic = { ok: true, summary: "skeptic unavailable: " + (error?.message || "error"), tokens: 0 };
        } finally {
          run.verifying = false;
        }
        run.lastActivity = Date.now();
        run.skepticTokens = (run.skepticTokens || 0) + (skeptic.tokens || 0);
        if (skeptic.skip || skeptic.ok) {
          run.status = "done";
          run.skepticNote = skeptic.skip ? "" : skeptic.summary;
          run.note = "Goal verified after " + run.turns + " turns (" + verdict.summary + (skeptic.skip ? "" : "; " + skeptic.summary) + ")";
          await save(run);
          return notify?.(run, "Long run done", run.note);
        }
        run.skepticRounds = (run.skepticRounds || 0) + 1;
        run.rejects = (run.rejects || 0) + 1;
        run.skepticNote = skeptic.summary;
        if (run.skepticRounds >= skepticSettings().maxRounds) {
          run.status = "blocked";
          run.note = "Skeptic still disagrees after " + run.skepticRounds + " round" + (run.skepticRounds === 1 ? "" : "s") + ": " + skeptic.summary;
          await save(run);
          return notify?.(run, "Long run needs you", run.note);
        }
        if (await noProgress(run, notify)) return;
        run.note = "DONE rejected by the skeptic: " + skeptic.summary;
        await save(run);
        return next(run, "Your LONGRUN: DONE passed the checks but was not accepted by an independent skeptical reviewer.\n\n" + skeptic.detail.slice(0, 6000) + "\n\nVerify each finding yourself, fix the real ones (never weaken a check in GOAL.md to pass), rerun the checks, update PROGRESS.md, then end with the LONGRUN status line.", notify);
      }
      run.rejects = (run.rejects || 0) + 1;
      if (await noProgress(run, notify)) return;
      run.note = "DONE rejected: " + verdict.summary;
      await save(run);
      return next(run, "Your LONGRUN: DONE was not accepted. " + verdict.summary + "\n\n" + verdict.detail.slice(0, 6000) + "\n\nFix this, keep GOAL.md ## Checks honest (never weaken a check to pass), update PROGRESS.md, then end with the LONGRUN status line.", notify);
    }
    if (keyword === "BLOCKED") {
      run.status = "blocked";
      run.note = status.replace(/LONGRUN:\s*BLOCKED/i, "").trim() || "Needs the user";
      await save(run);
      return notify?.(run, "Long run needs you", run.note);
    }
    if (elapsedH >= run.hours || run.usedTokens + (run.skepticTokens || 0) >= run.tokens) {
      run.status = "budget";
      run.note = elapsedH >= run.hours ? "Time budget reached" : "Token budget reached";
      await save(run);
      return notify?.(run, "Long run stopped at budget", run.note);
    }
    if (stopReason === "error") {
      run.fails += 1;
      run.resumes += 1;
      run.note = "Grok exited with an error; resuming";
      if (run.fails >= MAX_FAILS) {
        run.status = "stalled";
        await save(run);
        return notify?.(run, "Long run stalled", "Grok kept failing");
      }
    } else run.fails = 0;
    if (await noProgress(run, notify)) return;
    await save(run);
    next(run, CONTINUE(run), notify);
  });

  // Watchdog: resume runs that have no live turn (service restart, lost process), and restart stalled turns.
  // Grok streams long reasoning without ACP updates, but it keeps writing events.jsonl; count that as activity.
  const diskActivity = async (id) => {
    try {
      const found = await findSession(id);
      return found ? (await fs.stat(path.join(found.dir, "events.jsonl"))).mtimeMs : 0;
    } catch {
      return 0;
    }
  };
  setInterval(async () => {
    for (const run of runs.values()) {
      if (run.status !== "running" || run.verifying) continue;
      const turn = getTurn(run.id);
      if (isBusy(run.id) && (!turn || turn.done)) continue; // a start is in progress
      if (!turn || turn.done) {
        if (!timers.get(run.id) || Date.now() - run.lastActivity > 10 * 60000) {
          run.resumes += 1;
          run.note = "Watchdog resumed the run";
          run.lastActivity = Date.now();
          save(run).catch(() => {});
          next(run, CONTINUE(run), notify);
        }
        continue;
      }
      const seen = Math.max(turn.lastEventAt || 0, run.lastActivity || 0, await diskActivity(run.id));
      run.heartbeat = seen;
      const quiet = Date.now() - seen;
      const waitingOnJohn = turn.pending && turn.pending.size > 0;
      const toolRunning = turn.liveTools && turn.liveTools.size > 0;
      pushEvent(run.id, { type: "longrun", run: view(run) });
      if (!waitingOnJohn && quiet > (toolRunning ? MAX_QUIET_TOOL_MS : STALL_MS) && !run.restarting) {
        run.restarting = true;
        run.restartWhy = "Watchdog restarted a stalled turn (" + Math.round(quiet / 60000) + " min quiet)";
        cancelTurn(run.id);
      }
    }
  }, WATCHDOG_MS).unref();
}

// Runs in its own process group so a timeout also kills what the check started (test runners, servers).
function sh(cmd, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    let out = "";
    const keep = (chunk) => {
      out = (out + chunk.toString("utf8")).slice(-3000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    let timedOut = false;
    const kill = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 3000).unref?.();
    }, timeoutMs);
    child.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : Number.isInteger(code) ? code : 1, out: timedOut ? out + "\n[timed out after " + Math.round(timeoutMs / 60000) + " min]" : out });
    });
  });
}

function commandMatches(command, cmd) {
  const text = String(command || "").trim();
  if (text === cmd) return true;
  const prefixed = text.match(/^(?:cd\s+[^;&|]+?\s*&&\s*)+([\s\S]*)$/);
  return !!prefixed && prefixed[1].trim() === cmd;
}

// The status word only counts when it is the last non-empty line, as LONG_RULES requires.
export function longrunKeyword(text) {
  const last = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).pop() || "";
  const match = last.match(/^LONGRUN:\s*(CONTINUE|DONE|BLOCKED)\b/i);
  return match ? match[1].toUpperCase() : "";
}

// A check counts only when this exact command (optionally after `cd dir &&`) exited 0 after the last edit.
// An earlier exit 0 does not survive a later write.
export function ranClean(turn, cmd) {
  const seq = turn?.proof?.seq;
  const runs = Array.isArray(seq) && seq.length
    ? seq.filter((step, index) => index > seq.reduce((last, step, i) => (step.edit ? i : last), -1) && step.command && commandMatches(step.command, cmd))
    : (turn?.execs || []).filter((exec) => commandMatches(exec.command, cmd));
  return runs.length > 0 && runs[runs.length - 1].code === 0;
}

async function runCwd(run) {
  const turn = getTurn(run.id);
  if (turn?.cwd) return turn.cwd;
  const meta = await getMeta();
  return meta.sessions?.[run.id]?.cwd || "";
}

// "Done" is decided here, not by the model: run GOAL.md's ## Checks in the project folder.
// Only when approvals wouldn't be asked anyway (always-approve or Auto approve on); otherwise the
// next turn is asked to run them, so they still go through the user's approvals.
async function verifyGoal(run) {
  const cwd = await runCwd(run);
  let goal = "";
  try {
    goal = await fs.readFile(path.join(cwd, "GOAL.md"), "utf8");
  } catch {
    return { ok: false, summary: "GOAL.md is missing", detail: "Create GOAL.md with a ## Checks section." };
  }
  const section = (goal.split(/^##\s+Checks\s*$/im)[1] || "").split(/^##\s/m)[0];
  const cmds = [...section.matchAll(/^\s*[-*]\s+`([^`]+)`/gm)].map((m) => m[1].trim()).filter(Boolean).slice(0, 12);
  if (!cmds.length) return { ok: false, summary: "GOAL.md has no ## Checks commands", detail: "Add one `- \`command\`` line per acceptance check." };
  const meta = await getMeta();
  const prefs = meta.sessions?.[run.id] || {};
  const unattended = prefs.permissionMode === "bypassPermissions" || (Array.isArray(prefs.autoApprove) && prefs.autoApprove.includes("all"));
  if (!unattended) {
    // Under the user's approvals the app doesn't run commands itself; it reads the exit codes Grok actually got this turn.
    const turn = getTurn(run.id);
    const missing = cmds.filter((cmd) => !ranClean(turn, cmd));
    if (!missing.length) return { ok: true, summary: cmds.length + "/" + cmds.length + " checks passed in Grok's own run (exit codes read from the turn)", detail: "" };
    return { ok: false, summary: missing.length + " of " + cmds.length + " checks not shown passing this turn", detail: "Run each of these exactly as written (one command per terminal call, no pipes), confirm exit 0, and only then end with LONGRUN: DONE:\n" + missing.map((c) => "- " + c).join("\n") };
  }
  const results = [];
  for (const cmd of cmds) {
    const r = await sh(cmd, cwd, 15 * 60 * 1000);
    results.push({ cmd, ...r });
    if (r.code !== 0) break;
  }
  const failed = results.find((r) => r.code !== 0);
  if (!failed) return { ok: true, summary: results.length + "/" + cmds.length + " checks passed", detail: "" };
  return { ok: false, summary: "check failed: " + failed.cmd + " (exit " + failed.code + ")", detail: failed.out };
}

// Pauses the run after NO_PROGRESS_TURNS finished turns in a row with the same repo state and PROGRESS.md.
async function noProgress(run, notify) {
  const mark = await progressMark(run);
  if (mark && mark === run.lastMark) run.idle = (run.idle || 0) + 1;
  else run.idle = 0;
  run.lastMark = mark;
  if (run.idle < NO_PROGRESS_TURNS) return false;
  run.status = "paused";
  run.note = "Paused: " + NO_PROGRESS_TURNS + " turns with no new commit, no file change and no PROGRESS.md change";
  await save(run);
  notify?.(run, "Long run paused (no progress)", run.note);
  return true;
}

async function progressMark(run) {
  const cwd = await runCwd(run);
  if (!cwd) return "";
  // HEAD plus the content of uncommitted changes, so editing the same files counts as progress.
  const head = await sh("git rev-parse HEAD 2>/dev/null; git status --porcelain 2>/dev/null; git diff HEAD 2>/dev/null | sha1sum", cwd, 20000);
  let progress = "";
  try {
    progress = await fs.readFile(path.join(cwd, "PROGRESS.md"), "utf8");
  } catch {
    // none yet
  }
  return crypto.createHash("sha1").update(head.out + "\n" + progress).digest("hex");
}
