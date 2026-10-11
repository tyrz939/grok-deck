import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./paths.js";
import { getTurn, turnEvents, viewTurn } from "./runner.js";

// Per-session loop scheduler: "/loop 30m check the build" re-sends a prompt on a fixed interval.
// Runs live server-side in data/loops.json and are rescheduled on boot. A due run goes through the
// Send next queue (never interrupts) and a loop never has more than one run waiting.
// Ideas from Amnibro/grok-remote's RemoteLoopManager (interval grammar, persisted jobs, no re-fire right
// after a restart), but with a 5 min floor, pause/resume, max runs and "until DONE".

const MINUTE = Number(process.env.GM_LOOP_MINUTE_MS) || 60000; // tests shrink a "minute"
export const MIN_MINUTES = 5;
export const MAX_MINUTES = 7 * 24 * 60;
const MAX_LOOPS = 20;
const UNITS = { s: 1 / 60, m: 1, h: 60, d: 1440 };

export function parseInterval(raw) {
  const m = String(raw || "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)?$/);
  if (!m) return null;
  const minutes = Number(m[1]) * UNITS[(m[2] || "m")[0]];
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.round(minutes * 60) / 60;
}

export function intervalLabel(minutes) {
  if (minutes % 1440 === 0) return minutes / 1440 + "d";
  if (minutes % 60 === 0) return minutes / 60 + "h";
  return Math.round(minutes) + "m";
}

// /loop 30m [x10] [until DONE] <prompt>   ·   /loop <prompt> every 30m   ·   /loop stop | list
export function parseLoopCommand(text) {
  const t = String(text || "").trim();
  if (!/^\/loops?(\s|$)/i.test(t)) return null;
  if (/^\/loops\s*$/i.test(t)) return { action: "list" };
  let body = t.replace(/^\/loop\s*/i, "").trim();
  if (!body || /^(list|ls|status)$/i.test(body)) return { action: "list" };
  if (/^(stop|off|clear|cancel)$/i.test(body)) return { action: "stop" };
  let interval = null;
  const lead = body.match(/^(\S+)\s+([\s\S]+)$/);
  if (lead && parseInterval(lead[1]) !== null) {
    interval = parseInterval(lead[1]);
    body = lead[2].trim();
  } else {
    const tail = body.match(/^([\s\S]+?)\s+every\s+(\S+)\s*$/i);
    if (tail && parseInterval(tail[2]) !== null) {
      interval = parseInterval(tail[2]);
      body = tail[1].trim();
    }
  }
  if (interval === null) return { action: "error", error: "Start with an interval, e.g. /loop 30m check the build" };
  let maxRuns = 0;
  let untilDone = false;
  for (;;) {
    let m = body.match(/^(?:x|max[=:\s]?)(\d+)\s+([\s\S]+)$/i);
    if (m) { maxRuns = Number(m[1]); body = m[2].trim(); continue; }
    m = body.match(/^until(?:[-\s]done|\s+DONE)\s+([\s\S]+)$/i);
    if (m) { untilDone = true; body = m[1].trim(); continue; }
    break;
  }
  if (!body) return { action: "error", error: "Add a prompt after the interval" };
  return { action: "create", minutes: interval, prompt: body, maxRuns, untilDone };
}

export function validateLoop({ minutes, prompt, maxRuns }) {
  if (!Number.isFinite(minutes) || minutes < MIN_MINUTES) return "The shortest interval is " + MIN_MINUTES + " minutes";
  if (minutes > MAX_MINUTES) return "The longest interval is 7 days";
  if (!String(prompt || "").trim()) return "Add a prompt";
  if (maxRuns && (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000)) return "Max runs must be 1 to 1000";
  return "";
}

export function runLabel(loop, n) {
  return "Loop run " + n + (loop.maxRuns ? " of " + loop.maxRuns : "") + " · every " + intervalLabel(loop.minutes) + (loop.untilDone ? " · until DONE" : "");
}

export function hasDone(text) {
  return /\bDONE\b/.test(String(text || ""));
}

const loops = new Map();
const timers = new Map();
const liveRun = new Map(); // sessionId -> loopId of the turn now running
let deps = { enqueue: null, hasLoopItem: () => false, notify: () => {} };
const file = () => path.join(getDataDir(), "loops.json");
let writing = Promise.resolve();

function persist() {
  const snapshot = JSON.stringify({ loops: [...loops.values()] });
  writing = writing.then(async () => {
    const tmp = file() + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.rename(tmp, file());
  }).catch((error) => console.error("loops save failed", error?.code || "error"));
  return writing;
}

export function flushLoops() {
  return writing;
}

function view(loop) {
  return { ...loop, label: intervalLabel(loop.minutes), pending: deps.hasLoopItem(loop.sessionId, loop.id) };
}

export function loopsFor(sessionId) {
  return [...loops.values()].filter((l) => l.sessionId === sessionId).map(view);
}

function announce(sessionId) {
  persist();
  turnEvents.emit("changed", { id: sessionId, what: "loops", loops: loopsFor(sessionId) });
}

function schedule(loop) {
  clearTimeout(timers.get(loop.id));
  timers.delete(loop.id);
  if (loop.status !== "active") return;
  const wait = Math.max(0, loop.nextAt - Date.now());
  const t = setTimeout(() => fire(loop.id), Math.min(wait, 2 ** 31 - 1));
  t.unref?.();
  timers.set(loop.id, t);
}

function finish(loop, status, note) {
  loop.status = status;
  loop.note = note || "";
  loop.nextAt = 0;
  schedule(loop);
}

function fire(loopId) {
  const loop = loops.get(loopId);
  if (!loop || loop.status !== "active") return;
  loop.nextAt = Date.now() + loop.minutes * MINUTE;
  if (deps.hasLoopItem(loop.sessionId, loop.id)) {
    loop.skipped = (loop.skipped || 0) + 1; // previous run still waiting: never stack
  } else if (loop.maxRuns && loop.runs >= loop.maxRuns) {
    finish(loop, "done", "Reached " + loop.maxRuns + " runs");
  } else {
    const n = loop.runs + 1;
    try {
      deps.enqueue(loop.sessionId, { prompt: "**" + runLabel(loop, n) + "**\n\n" + loop.prompt, loopId: loop.id, loopRun: n, ...loop.opts });
      loop.runs = n;
      loop.lastAt = Date.now();
      loop.lastError = "";
    } catch (error) {
      loop.lastError = String(error?.message || "error").slice(0, 200);
      deps.notify(loop, "Loop failed", loop.lastError);
    }
  }
  schedule(loop);
  announce(loop.sessionId);
}

export function createLoop(sessionId, { minutes, prompt, maxRuns = 0, untilDone = false, opts = {} }) {
  const bad = validateLoop({ minutes, prompt, maxRuns });
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  if (loops.size >= MAX_LOOPS) throw Object.assign(new Error("Too many loops"), { status: 400 });
  const loop = {
    id: crypto.randomUUID(),
    sessionId,
    prompt: String(prompt).trim().slice(0, 20000),
    minutes,
    maxRuns: maxRuns || 0,
    untilDone: !!untilDone,
    opts: { model: opts.model, effort: opts.effort, permissionMode: opts.permissionMode, ultra: opts.ultra },
    status: "active",
    runs: 0,
    skipped: 0,
    createdAt: Date.now(),
    lastAt: 0,
    nextAt: Date.now(), // first run straight away (queued if busy)
    lastError: "",
    note: "",
  };
  loops.set(loop.id, loop);
  fire(loop.id);
  return view(loop);
}

export function updateLoop(sessionId, loopId, action) {
  const loop = loops.get(loopId);
  if (!loop || loop.sessionId !== sessionId) return null;
  if (action === "pause" && loop.status === "active") {
    loop.status = "paused";
    loop.nextAt = 0;
  } else if (action === "resume" && loop.status !== "active") {
    if (loop.maxRuns && loop.runs >= loop.maxRuns) loop.maxRuns = 0; // resuming a finished capped loop lifts the cap
    loop.status = "active";
    loop.note = "";
    loop.nextAt = Date.now() + loop.minutes * MINUTE;
  } else if (action !== "pause" && action !== "resume") return null;
  schedule(loop);
  announce(sessionId);
  return view(loop);
}

export function deleteLoop(sessionId, loopId) {
  const doomed = [...loops.values()].filter((l) => l.sessionId === sessionId && (!loopId || l.id === loopId));
  for (const loop of doomed) {
    clearTimeout(timers.get(loop.id));
    timers.delete(loop.id);
    loops.delete(loop.id);
  }
  if (doomed.length) announce(sessionId);
  return doomed.length;
}

export function isLoopTurn(sessionId) {
  return liveRun.has(sessionId);
}

function lastAssistant(id) {
  const turn = getTurn(id);
  try {
    const msgs = turn ? viewTurn(turn).messages || [] : [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "assistant") return String(msgs[i].text || "");
  } catch {
    // none
  }
  return "";
}

export function onLoopFinished({ id, stopReason, error }) {
  const loopId = liveRun.get(id);
  if (!loopId) return;
  setImmediate(() => liveRun.delete(id)); // other "finished" listeners still see it as a loop turn
  const loop = loops.get(loopId);
  if (!loop) return;
  if (stopReason === "error") {
    loop.lastError = String(error || "Grok stopped with an error").slice(0, 200);
    deps.notify(loop, "Loop run " + loop.runs + " failed", loop.lastError);
  } else if (loop.untilDone && stopReason === "end_turn" && hasDone(lastAssistant(id))) {
    finish(loop, "done", "Reply said DONE on run " + loop.runs);
    deps.notify(loop, "Loop DONE", "Run " + loop.runs + " replied DONE");
  } else if (loop.maxRuns && loop.runs >= loop.maxRuns && loop.status === "active") {
    finish(loop, "done", "Reached " + loop.maxRuns + " runs");
  }
  announce(id);
}

export async function startLoops(options) {
  deps = { ...deps, ...options };
  try {
    const saved = JSON.parse(await fs.readFile(file(), "utf8"));
    for (const loop of saved.loops || []) if (loop?.id && loop.sessionId && loop.prompt) loops.set(loop.id, loop);
  } catch {
    // none yet
  }
  const now = Date.now();
  for (const loop of loops.values()) {
    // Overdue after downtime: one run soon (not a burst), then back on the interval.
    if (loop.status === "active" && loop.nextAt < now) loop.nextAt = now + 2000;
    schedule(loop);
  }
  turnEvents.on("queueSent", ({ id, item }) => {
    if (item?.loopId) liveRun.set(id, item.loopId);
    else liveRun.delete(id);
  });
  turnEvents.on("finished", onLoopFinished);
}

export function stopLoopTimers() {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
}
