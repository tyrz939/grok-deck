import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { cleanImages } from "./images.js";
import { cleanFileRefs } from "./uploads.js";
import { getDataDir } from "./paths.js";
import { cancelTurn, isBusy, pushEvent, startTurn, turnEvents } from "./runner.js";

// "Send next": messages wait here while a turn runs and go out, in order, when it ends.
// "Send now" moves one to the front and stops the running turn so it goes straight away.
const queues = new Map();
const MAX_QUEUED = 10;
const RETRY_MS = Number(process.env.GM_QUEUE_RETRY_MS) || 5000;
const SWEEP_MS = Number(process.env.GM_QUEUE_SWEEP_MS) || 15000;

function view(id) {
  return (queues.get(id) || []).map((item) => ({ id: item.id, text: item.prompt.slice(0, 500), images: item.images?.length || 0, files: item.files?.length || 0, at: item.at, now: !!item.now, loop: item.loopId ? item.loopRun || true : undefined }));
}

// Saved to data/queue.json on every change, so a restart or deploy doesn't drop "Send next" messages.
const queueFile = () => path.join(getDataDir(), "queue.json");
let writing = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(Object.fromEntries([...queues].filter(([, list]) => list.length)));
  writing = writing.then(async () => {
    const tmp = queueFile() + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.rename(tmp, queueFile());
  }).catch((error) => console.error("queue save failed", error?.code || "error"));
  return writing;
}

export async function loadQueues() {
  try {
    const saved = JSON.parse(await fs.readFile(queueFile(), "utf8"));
    for (const [id, list] of Object.entries(saved)) if (Array.isArray(list) && list.length) queues.set(id, list);
  } catch {
    // nothing queued
  }
  for (const id of queues.keys()) setTimeout(() => drain(id), 3000).unref?.();
}

function announce(id) {
  persist();
  pushEvent(id, { type: "queue", items: view(id) });
  turnEvents.emit("changed", { id, what: "queue", items: view(id) });
}

export function queueFor(id) {
  return view(id);
}

function running(id) {
  return isBusy(id);
}

export function enqueue(id, body) {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  const images = cleanImages(body.images); // reject a bad image now, not when the queue drains
  const files = cleanFileRefs(body.files);
  if (!prompt && !images.length && !files.length) throw Object.assign(new Error("Write a message first"), { status: 400 });
  const list = queues.get(id) || [];
  if (list.length >= MAX_QUEUED) throw Object.assign(new Error("The queue is full"), { status: 400 });
  const item = {
    id: crypto.randomUUID(),
    prompt: prompt.slice(0, 100000),
    images,
    files,
    opts: { model: body.model, effort: body.effort, permissionMode: body.permissionMode, ultra: body.ultra },
    at: Date.now(),
  };
  if (body.loopId) {
    item.loopId = String(body.loopId);
    item.loopRun = Number(body.loopRun) || 0;
  }
  list.push(item);
  queues.set(id, list);
  announce(id);
  if (!running(id)) drain(id);
  return item.id;
}

// A loop never has more than one run waiting (lib/loops.js checks this before it queues).
export function hasLoopItem(id, loopId) {
  return (queues.get(id) || []).some((item) => item.loopId === loopId);
}

export function cancelQueued(id, qid) {
  const list = queues.get(id) || [];
  const next = list.filter((item) => item.id !== qid);
  if (next.length === list.length) return false;
  queues.set(id, next);
  announce(id);
  return true;
}

export function sendNow(id, qid) {
  const list = queues.get(id) || [];
  const index = list.findIndex((item) => item.id === qid);
  if (index < 0) return false;
  const [item] = list.splice(index, 1);
  item.now = true;
  list.unshift(item);
  queues.set(id, list);
  announce(id);
  if (running(id)) cancelTurn(id);
  else drain(id);
  return true;
}

let draining = new Set();

async function drain(id) {
  if (draining.has(id) || running(id)) return;
  const list = queues.get(id) || [];
  const item = list.shift();
  if (!item) return;
  queues.set(id, list);
  draining.add(id);
  try {
    turnEvents.emit("queueSent", { id, item });
    await startTurn({ sessionId: id, prompt: item.prompt, images: item.images, files: item.files, ...item.opts });
    console.log("queue", id, "sent", list.length, "left");
  } catch (error) {
    console.error("queue send failed", id, error?.message || "error");
    // A request Grok Deck itself rejects (bad input, missing session) would fail forever; drop it.
    // Anything else (busy, Grok failed to start) goes back to the front for the next try.
    if (!(error?.status >= 400 && error?.status < 500 && error.status !== 409)) {
      list.unshift(item);
      queues.set(id, list);
      // Nothing else would wake the queue if no turn is running: try again shortly.
      setTimeout(() => drain(id), RETRY_MS).unref?.();
    }
  } finally {
    draining.delete(id);
    announce(id);
  }
}

// Safety net: a queued message with no running turn must go out even if its "finished" event was missed
// (a turn that ended while the drain was busy, a start that failed, a race with a wake turn).
setInterval(() => {
  for (const [id, list] of queues) if (list.length && !running(id) && !draining.has(id)) drain(id);
}, SWEEP_MS).unref?.();

turnEvents.on("finished", ({ id }) => {
  if (!(queues.get(id) || []).length) return;
  setTimeout(() => drain(id), 800).unref?.();
});
