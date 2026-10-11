import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./paths.js";
import { CUT_OFF_REASONS, isBusy, killStalled, liveTurns, startTurn, turnEvents } from "./runner.js";

// Keeps ordinary (non long-run) turns going to a real end:
// - stall watchdog: a turn with no Grok activity for STALL_MS (no approval waiting, no long tool) gets its
//   process restarted, and the session is resumed;
// - a Grok crash or a cut-off stop (error, max_tokens, max_turn_requests) resumes the session;
// - a service restart (deploy, crash, reboot) resumes turns that were running when it went down.
// Long runs have their own supervisor (lib/longrun.js) and are left alone. Resumes are capped per session.

const STALL_MS = Number(process.env.GM_STALL_MS) || 15 * 60 * 1000;
const TOOL_QUIET_MS = Number(process.env.GM_TOOL_QUIET_MS) || 3 * 60 * 60 * 1000;
const CHECK_MS = Number(process.env.GM_STALL_CHECK_MS) || 30 * 1000;
const RESUME_DELAY_MS = Number(process.env.GM_RESUME_DELAY_MS) || 2000;
const RESUME_MAX = Number(process.env.GM_RESUME_MAX) || 3;
const RESUME_WINDOW_MS = 60 * 60 * 1000;

export const RESUME_PROMPT =
  "Grok Deck: your previous turn was interrupted (WHY) before it finished. Continue my last request from where you left off: " +
  "check what is already done (files, git status, your todo list), finish the rest, verify it, then give the final answer.";

const runningFile = () => path.join(getDataDir(), "running-turns.json");
const running = new Set(); // interactive turns live right now, persisted so a restart can resume them
const resumes = new Map(); // id -> [timestamps]
let stopping = false;
let isLong = () => false;
let queued = () => false;

let writing = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify([...running]);
  writing = writing
    .then(async () => {
      const tmp = runningFile() + "." + process.pid + ".tmp";
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, runningFile());
    })
    .catch((error) => console.error("running-turns save failed", error?.code || "error"));
  return writing;
}

// Pure: should this finished turn be resumed, and why?
export function resumeReason(ev) {
  if (!ev || ev.longRun || ev.shutdown) return "";
  if (ev.stall) return "Grok went quiet and was restarted";
  if (CUT_OFF_REASONS.has(ev.stopReason)) return ev.stopReason === "error" ? "Grok exited mid-turn" : "stopped with " + ev.stopReason;
  return "";
}

// Pure: is this live turn stalled? Waiting on the user's approval is not a stall.
export function isStalled(turn, now = Date.now(), stallMs = STALL_MS, toolQuietMs = TOOL_QUIET_MS) {
  if (!turn || turn.done || !turn.started || turn.longRun || turn.cancelled || turn.stallKill) return false;
  if (turn.pending?.size) return false;
  const quiet = now - (turn.lastEventAt ?? now);
  return quiet > (turn.liveTools?.size ? toolQuietMs : stallMs);
}

function allowResume(id) {
  const now = Date.now();
  const list = (resumes.get(id) || []).filter((t) => now - t < RESUME_WINDOW_MS);
  if (list.length >= RESUME_MAX) {
    resumes.set(id, list);
    return false;
  }
  list.push(now);
  resumes.set(id, list);
  return true;
}

async function resume(id, why) {
  if (stopping) return;
  if (isBusy(id) || isLong(id)) return;
  if (queued(id)) return; // the user's queued message goes first and continues the work anyway
  if (!allowResume(id)) {
    console.log("recover", id, "resume cap reached, not resuming:", why);
    return;
  }
  try {
    await startTurn({ sessionId: id, prompt: RESUME_PROMPT.replace("WHY", why) });
    console.log("recover", id, "resumed:", why);
  } catch (error) {
    console.error("recover", id, "resume failed", error?.message || "error");
  }
}

export function setShuttingDown() {
  stopping = true;
}

export async function flushRunning() {
  await writing;
}

export async function startRecovery({ isLongRun, hasQueued } = {}) {
  if (isLongRun) isLong = isLongRun;
  if (hasQueued) queued = hasQueued;
  let leftover = [];
  try {
    leftover = JSON.parse(await fs.readFile(runningFile(), "utf8"));
  } catch {
    leftover = [];
  }
  turnEvents.on("started", ({ id, longRun }) => {
    if (longRun || stopping) return;
    running.add(id);
    persist();
  });
  turnEvents.on("finished", (ev) => {
    if (stopping || ev.shutdown) return; // keep the record: the restart resumes it
    if (running.delete(ev.id)) persist();
    if (ev.stopReason === "end_turn" && !ev.stall) resumes.delete(ev.id);
    const why = resumeReason(ev);
    if (why) setTimeout(() => resume(ev.id, why), RESUME_DELAY_MS).unref?.();
  });
  if (Array.isArray(leftover) && leftover.length) {
    for (const id of leftover) if (typeof id === "string") setTimeout(() => resume(id, "the Grok Deck service restarted"), RESUME_DELAY_MS).unref?.();
  }
  await persist();
  setInterval(() => {
    const now = Date.now();
    for (const turn of liveTurns()) if (isStalled(turn, now)) killStalled(turn.id);
  }, CHECK_MS).unref();
}
