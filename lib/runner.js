import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAgent } from "./acp.js";
import { invalidateAccount } from "./billing.js";
import { newProof, proofVerdict, trackProof } from "./evidence.js";
import { cleanImages, promptBlocks } from "./images.js";
import { attachFiles, cleanFileRefs } from "./uploads.js";
import { PSTACK_DIR, noteCommands, pstackPlugin } from "./skills.js";
import { applyQuestions, splitInjected } from "./history.js";
import { internTarget, remember as rememberMedia } from "./media.js";
import { findRefs, isLocalRef } from "../public/markdown.js";
import { asText, applyEvent, extractImages, plainText } from "../public/reduce.js";
import {
  applyManualTitle,
  cleanEffort,
  cleanMode,
  cleanModel,
  findSession,
  getMeta,
  isUuid,
  loadTranscript,
  realDirectory,
  rememberDir,
  setSessionPrefs,
  updateMeta,
} from "./sessions.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export { PSTACK_DIR };
export const ULTRA_PLUGIN_DIR = path.join(here, "..", "ultra-plugin");
export const MAX_SUBAGENTS = 4;

// Server-side listeners (push notifications, the send-next queue) hear about turn milestones here.
export const turnEvents = new EventEmitter();

// App-side events (long-run status, queue) go to clients but are not Grok activity, so they must not
// move lastEventAt: the long-run watchdog's own heartbeat would otherwise hide every stall.
export function pushEvent(id, ev) {
  const turn = turns.get(id);
  if (turn && !turn.done) push(turn, ev, false);
}

export const BASE_RULES = [
  // The end-of-turn rules live in ~/.grok/AGENTS.md; repeating them here only made them louder and conflicting.
  "Grok Deck runs this session from the user's phone or desktop browser. He reads only your final message, so the end-of-turn rules in AGENTS.md matter: finish and verify the ask, then lead with the outcome. In a long run the LONGRUN status line is the required last line.",
  "To show an image, write ![short alt](path). Grok Deck renders images from this session's images/ folder (use the exact path the image tool returned) and any image file inside the working folder, by relative or absolute path. Don't copy files around just to show them, and don't invent paths.",
  "Subagents: run at most " + MAX_SUBAGENTS + " at the same time (Grok queues extra spawns). Tell every subagent to end its turn with a short summary of at most 10 lines: what it did, files changed, how it verified, and what is left open.",
].join("\n");
const PERMISSION_TIMEOUT_MS = 30 * 60 * 1000;
// Setup calls must answer; a hung initialize/load would otherwise hold the session "starting" forever.
const SETUP_TIMEOUT_MS = Number(process.env.GM_ACP_SETUP_TIMEOUT_MS) || 3 * 60 * 1000;
const OPTION_TIMEOUT_MS = Number(process.env.GM_ACP_OPTION_TIMEOUT_MS) || 30 * 1000;
// Stop reasons that mean "cut off", not "finished": the recovery module continues these turns.
export const CUT_OFF_REASONS = new Set(["max_tokens", "max_turn_requests", "error"]);

const turns = new Map();

// Every session loads pstack as Grok skills (lib/skills.js). Grok lists their names and descriptions; this
// adds pstack's own router reminder (poteto-mode's `reminder:`, which Cursor injects) and the Cursor gaps.
export const PSTACK_RULES = [
  "pstack (poteto's skills) is loaded as Grok skills: they are in your skill list with a one-line description each. Read a skill's SKILL.md only when the task calls for it or the user types /name. pstack's router reminder: New task? Playbook match or rigor needed -> apply /poteto-mode, which routes to the principle-* and other pstack skills. Casual turn or user opts out -> don't.",
  "Adapting pstack to Grok Build: pstack was written for Cursor. Where it says subagent_type \"poteto-agent\", spawn a Grok subagent and tell it to read poteto-mode first. Where it names Cursor-only tools or plugins (AskQuestion, cursor-team-kit, deslop, control-ui, Cursor model names, /setup-pstack, Custom Modes), use the closest Grok tool or skip that step and say so in one line. Ask the user only for genuine product calls.",
].join("\n");

export const ULTRA_RULES = [
  "Ultra code mode is on for this session. Work through pstack's /poteto-mode router (the poteto-mode skill from the pstack plugin loaded for this run).",
  "Before anything else, read the poteto-mode SKILL.md in full, match the task to its playbook, and copy that playbook's steps into your todo list verbatim. Read each leaf skill (principles, how, architect, unslop, no-comments, tdd and so on) before you apply it.",
  "Delegate the stages to the Ultra subagents from the grok-deck-ultra plugin: grok-deck-ultra:planner for the plan, grok-deck-ultra:builder for each build unit, and grok-deck-ultra:reviewer for an independent review before you finish. Use pstack:poteto-agent only where a playbook step asks for it. Never run more than " + MAX_SUBAGENTS + " subagents at once.",
  "Hold the high bar: plan, build, verify by actually running tests or the program, review your own diff, then unslop the final reply. Never claim a step you did not do. Keep going until every todo is done or you are truly blocked.",
].join("\n\n");

export function redact(text) {
  return String(text || "")
    .replace(/xai-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(api[_-]?key|token|password|secret|authorization|cookie)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
}

function toolMeta(update) {
  return update?._meta?.["x.ai/tool"] || {};
}

function contentText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (content.type === "image") return "";
    if (typeof content.text === "string") return content.text;
    if (content.content != null) return contentText(content.content);
  }
  return "";
}

function inputText(rawInput) {
  if (rawInput == null) return "";
  if (typeof rawInput === "object" && typeof rawInput.command === "string") {
    return rawInput.command;
  }
  return asText(rawInput, 4000);
}

// Turns one ACP session/update into the app's compact event.
export function fromAcp(update) {
  if (!update || typeof update !== "object") return null;
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") return { type: "text", data: contentText(update.content) };
  if (kind === "agent_thought_chunk") return { type: "thought", data: contentText(update.content) };
  if (kind === "user_message_chunk") {
    const note = splitInjected(contentText(update.content)).note;
    return note ? { type: "note", data: note.slice(0, 4000) } : null;
  }
  if (kind === "hook_annotation" && update.message) return { type: "note", data: String(update.message).slice(0, 2000) };
  if (kind === "tool_call" || kind === "tool_call_update") {
    const meta = toolMeta(update);
    const images = extractImages(update.content, update.rawOutput);
    const out = contentText(update.content);
    const ev = {
      type: kind,
      toolCallId: update.toolCallId,
      toolName: meta.name || (kind === "tool_call" ? update.title : undefined),
      kind: update.kind,
      title: update.title,
      status: update.status || (kind === "tool_call" ? "in_progress" : undefined),
      rawInput: update.rawInput != null ? inputText(update.rawInput) : undefined,
      description: typeof update.rawInput?.description === "string" ? update.rawInput.description : undefined,
      content: images.length ? plainText(update.content, 6000) : out ? out.slice(0, 6000) : undefined,
    };
    // The first update after a tool_call often repeats the description as content; skip it.
    if (ev.content && ev.description && ev.content === ev.description && !update.status) ev.content = undefined;
    if (images.length) ev.images = images;
    return ev;
  }
  if (kind === "plan") return { type: "plan", entries: Array.isArray(update.entries) ? update.entries.slice(0, 40) : [] };
  if (kind === "session_info_update" && update.title) return { type: "title", title: String(update.title).slice(0, 120) };
  return null;
}

function slimEvent(ev) {
  if (!ev || typeof ev !== "object") return null;
  const type = ev.type;
  if (type === "note") return ev.data ? { type, data: String(ev.data).slice(0, 4000) } : null;
  if (type === "text" || type === "thought") {
    if (!ev.data) return null;
    return ev.sub ? { type, data: String(ev.data).slice(0, 200000), sub: ev.sub } : { type, data: String(ev.data).slice(0, 200000) };
  }
  if (type === "plan" && ev.sub) return { type, entries: Array.isArray(ev.entries) ? ev.entries.slice(0, 40) : [], sub: ev.sub };
  if (type === "tool_call" || type === "tool_call_update") {
    const row = { ...ev };
    for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
    return row;
  }
  if (type === "plan") return { type, entries: Array.isArray(ev.entries) ? ev.entries.slice(0, 40) : [] };
  if (type === "error") return { type, message: redact(ev.message || ev.data || "Something went wrong").slice(0, 500) };
  if (type === "end") return { type, stopReason: ev.stopReason || "" };
  if (type === "media") return { type, from: String(ev.from), to: String(ev.to) };
  if (type === "permission" || type === "permission_resolved" || type === "auto_approve" || type === "title" || type === "subagent" || type === "usage" || type === "queue" || type === "plan_ready" || type === "plan_resolved" || type === "question" || type === "question_resolved" || type === "longrun" || type === "evidence") return { ...ev };
  if (type === "settled" || type === "idle" || type === "max_turns_reached") return { type };
  return null;
}

function clipText(text, limit) {
  const value = String(text || "");
  return value.length > limit ? value.slice(0, limit) + "\n..." : value;
}

// Subagent lifecycle notifications (x.ai session notifications) -> one "subagent" event each.
export function subagentEvent(update) {
  const kind = update?.sessionUpdate;
  const id = update?.subagent_id || update?.child_session_id;
  if (!id) return null;
  if (kind === "subagent_spawned") {
    return {
      type: "subagent",
      id,
      child: update.child_session_id || id,
      name: String(update.description || update.subagent_type || "Subagent").slice(0, 80),
      agentType: update.subagent_type || "",
      model: update.model || "",
      status: "running",
      startedAt: Date.now(),
    };
  }
  if (kind === "subagent_progress") return { type: "subagent", id, status: "running" };
  if (kind === "subagent_finished") {
    return {
      type: "subagent",
      id,
      status: update.status || "completed",
      finishedAt: Date.now(),
      durationMs: Number(update.duration_ms) || undefined,
      tokens: Number(update.tokens_used) || undefined,
      toolCalls: Number(update.tool_calls) || undefined,
      summary: clipText(update.output || update.error || "", 4000),
    };
  }
  return null;
}

function createTurn(id) {
  return {
    id,
    events: [],
    listeners: new Set(),
    done: false,
    agent: null,
    acpSessionId: null,
    baseMessages: [],
    cwd: "",
    finishedAt: 0,
    draftTitle: "",
    pending: new Map(),
    mode: "default",
    autoKinds: new Set(),
    cancelled: false,
    subs: new Map(),
    childTools: new Map(),
    liveTools: new Set(),
    proof: newProof(),
  };
}

// SSE ids are global and time-seeded, so they only grow: across turns and across service restarts.
let eventSeq = Date.now() * 1000;
export function lastEventId(turn) {
  return turn.events.length ? turn.events[turn.events.length - 1].id : 0;
}

// Local files an assistant message links to are copied into the media store as soon as the reference is complete,
// before the agent can move them. The client hears it as a "media" event and swaps the reference. A message is the
// run of text chunks between two other events, as the reducer reads it. A path alone on its line is complete once
// the line ends (or the message does): "report.md" could still become "report.md.bak" while it streams.
const MEDIA_QUIET = new Set(["text", "media", "usage", "title", "ping", "queue", "longrun", "loops"]);

function scanMedia(turn, cur, final) {
  const seen = cur.text;
  cur.work = cur.work.then(async () => {
    // A file that was not there when its reference streamed is looked for again when the message closes.
    const fresh = (t) => !cur.pairs.has(t.target) || (final && cur.pairs.get(t.target) === "");
    const tokens = findRefs(seen).filter((t) => isLocalRef(t.target) && fresh(t)
      && (t.kind !== "bare" || final || seen.indexOf("\n", t.end) !== -1));
    if (!tokens.length) return;
    const found = await findSession(turn.id);
    const session = { cwd: turn.cwd || found?.cwd, dir: found?.dir };
    for (const token of tokens) {
      if (cur.pairs.get(token.target)) continue;
      cur.pairs.set(token.target, "");
      const url = await internTarget(token.target, session);
      if (!url) continue;
      cur.pairs.set(token.target, url);
      push(turn, { type: "media", from: token.target, to: url }, false);
    }
  }).catch(() => {});
}

function trackMedia(turn, ev) {
  if (ev.sub || !turn.id) return;
  if (ev.type !== "text") {
    if (!MEDIA_QUIET.has(ev.type)) closeMedia(turn);
    return;
  }
  const cur = turn.media || (turn.media = { text: "", pairs: new Map(), work: Promise.resolve() });
  const chunk = String(ev.data || "");
  cur.text = chunk.startsWith(cur.text) && chunk.length >= cur.text.length ? chunk : cur.text + chunk;
  scanMedia(turn, cur, false);
}

function closeMedia(turn) {
  const cur = turn.media;
  if (!cur) return;
  turn.media = null;
  scanMedia(turn, cur, true);
  cur.work.then(() => {
    const pairs = [...cur.pairs].filter(([, url]) => url);
    if (pairs.length) return rememberMedia(turn.id, cur.text, pairs);
  });
}

function push(turn, ev, fromGrok = true) {
  if (fromGrok) turn.lastEventAt = Date.now();
  trackMedia(turn, ev);
  if (ev?.type === "tool_call" || ev?.type === "tool_call_update") {
    if (ev.toolCallId && ev.status) {
      if (ev.status === "in_progress" || ev.status === "pending") turn.liveTools.add(ev.toolCallId);
      else turn.liveTools.delete(ev.toolCallId);
    }
  }
  const slim = slimEvent(ev);
  if (!slim) return;
  const row = { id: ++eventSeq, ev: slim };
  turn.events.push(row);
  for (const listener of turn.listeners) {
    try {
      listener(row);
    } catch {
      // A disconnected client must not break the turn.
    }
  }
}

export function getTurn(id) {
  return turns.get(id) || null;
}

export function activeMap() {
  const map = new Map();
  const now = Date.now();
  for (const [id, turn] of turns) {
    if (turn.done && now - turn.finishedAt > 15 * 60 * 1000) {
      turns.delete(id);
      continue;
    }
    if (!turn.done) map.set(id, { cwd: turn.cwd, draftTitle: turn.draftTitle, waiting: turn.pending.size > 0, subagents: new Set([...turn.subs.values()].filter((sub) => sub.status === "running").map((sub) => sub.id)).size });
  }
  for (const id of starting) if (!map.has(id)) map.set(id, { starting: true, waiting: false, subagents: 0 });
  return map;
}

export function isBusy(id) {
  const turn = turns.get(id);
  return starting.has(id) || !!(turn && !turn.done);
}

export function viewTurn(turn) {
  const state = {
    messages: turn.baseMessages.map((message) => ({
      ...message,
      images: message.images ? message.images.map((image) => ({ ...image })) : undefined,
      tool: message.tool
        ? { ...message.tool, images: message.tool.images ? message.tool.images.map((image) => ({ ...image })) : undefined }
        : undefined,
    })),
    n: turn.baseMessages.length,
  };
  for (const row of turn.events) applyEvent(state, row.ev);
  return {
    messages: state.messages,
    cursor: lastEventId(turn),
    running: !turn.done,
  };
}

// Groups permission requests so "Auto approve" covers similar ones.
export function permissionKind(params) {
  const call = params?.toolCall || {};
  const meta = toolMeta(call);
  const kind = call.kind || meta.kind || "other";
  if (kind === "execute") return "execute";
  if (kind === "edit" || kind === "delete" || kind === "move") return "edit";
  if (kind === "fetch") return "fetch";
  return meta.name ? "tool:" + meta.name : kind;
}

export function kindLabel(kind) {
  if (kind === "execute") return "terminal commands";
  if (kind === "edit") return "file edits";
  if (kind === "fetch") return "web fetches";
  if (kind.startsWith("tool:")) return kind.slice(5) + " calls";
  return kind + " requests";
}

function pickOption(options, kinds) {
  for (const kind of kinds) {
    const found = (options || []).find((option) => option.kind === kind);
    if (found) return found.optionId;
  }
  return null;
}

function selected(optionId) {
  return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
}

function describePermission(params) {
  const call = params?.toolCall || {};
  const meta = toolMeta(call);
  const raw = call.rawInput || meta.input || {};
  let detail = "";
  if (typeof raw.command === "string") detail = raw.command;
  else if (raw.target_file || raw.file_path || raw.path) {
    const file = raw.target_file || raw.file_path || raw.path;
    const body = raw.content ?? raw.new_string ?? raw.code_edit ?? raw.contents ?? "";
    detail = String(file) + (body ? "\n\n" + asText(body, 3000) : "");
  } else detail = asText(raw, 3000);
  return {
    toolCallId: call.toolCallId,
    toolName: meta.name || "",
    label: meta.label || "",
    title: call.title || meta.label || "Permission",
    description: typeof raw.description === "string" ? raw.description : "",
    detail: String(detail).slice(0, 6000),
  };
}

async function onPermission(turn, params, rpcId) {
  const kind = permissionKind(params);
  const options = params.options || [];
  const info = describePermission(params);
  const childSession = params.sessionId && turn.acpSessionId && params.sessionId !== turn.acpSessionId ? params.sessionId : turn.childTools.get(info.toolCallId);
  if (childSession) {
    const sub = turn.subs.get(childSession);
    info.sub = sub?.id || childSession;
    info.subName = sub?.name || "Subagent";
  }
  const auto =
    turn.mode === "bypassPermissions" ||
    turn.autoKinds.has("all") ||
    turn.autoKinds.has(kind) ||
    (turn.mode === "acceptEdits" && kind === "edit");
  if (turn.cancelled) return selected(null);
  // Auto approve may have been switched on from another device or an earlier turn: the saved prefs win.
  let saved = [];
  if (!auto) {
    try {
      saved = (await getMeta()).sessions?.[turn.id]?.autoApprove || [];
    } catch {
      saved = [];
    }
    if (Array.isArray(saved) && (saved.includes("all") || saved.includes(kind))) turn.autoKinds = new Set(saved);
  }
  if (auto || turn.autoKinds.has("all") || turn.autoKinds.has(kind)) {
    push(turn, { type: "auto_approve", toolCallId: info.toolCallId, kind, sub: info.sub });
    return selected(pickOption(options, ["allow_once", "allow_always"]));
  }
  // Between turns (a background subagent after the turn ended) no client shows a card, so a question
  // would sit unseen for PERMISSION_TIMEOUT_MS. Answer at once instead of blocking.
  if (turn.done) {
    console.log("turn", turn.id, "permission after the turn ended, denied", kind);
    return selected(pickOption(options, ["reject_once", "reject_always"]));
  }
  if (turn.mode === "dontAsk") {
    push(turn, { type: "permission_resolved", reqId: "r" + rpcId, toolCallId: info.toolCallId, decision: "deny", by: "read-only" });
    return selected(pickOption(options, ["reject_once", "reject_always"]));
  }
  const reqId = "r" + rpcId + "-" + Date.now().toString(36);
  push(turn, { type: "permission", reqId, kind, kindLabel: kindLabel(kind), ...info });
  if (info.sub) console.log("turn", turn.id, "subagent permission", info.subName);
  turnEvents.emit("permission", { id: turn.id, title: turn.draftTitle, kind, subName: info.subName, detail: info.detail || info.title || "" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      answerPermission(turn.id, reqId, "deny", "timeout");
    }, PERMISSION_TIMEOUT_MS);
    timer.unref?.();
    turn.pending.set(reqId, { resolve, options, kind, timer, toolCallId: info.toolCallId, sub: info.sub });
  });
}

export async function answerPermission(id, reqId, decision, by = "user") {
  const turn = turns.get(id);
  if (!turn || turn.done) return { ok: false, status: 409, error: "Nothing is waiting" };
  const entry = turn.pending.get(reqId);
  if (!entry || entry.question || entry.plan) return { ok: false, status: 409, error: "That request was already answered" };
  if (!["deny", "once", "auto"].includes(decision)) return { ok: false, status: 400, error: "Unknown decision" };
  turn.pending.delete(reqId);
  clearTimeout(entry.timer);
  let optionId;
  if (decision === "deny") optionId = pickOption(entry.options, ["reject_once", "reject_always"]);
  else optionId = pickOption(entry.options, ["allow_once", "allow_always"]);
  if (decision === "auto") {
    // Auto approve covers the whole session: every tool, subagents and Ultra roles, until turned off.
    turn.autoKinds = new Set(["all"]);
    await setSessionPrefs(id, { autoApprove: ["all"] });
    turnEvents.emit("changed", { id, what: "prefs" });
  }
  if (decision === "deny") turn.denied = true;
  push(turn, { type: "permission_resolved", reqId, toolCallId: entry.toolCallId, decision, kind: entry.kind, kindLabel: kindLabel(entry.kind), by, sub: entry.sub });
  entry.resolve(selected(optionId));
  if (decision === "auto") {
    for (const [otherId, other] of [...turn.pending]) {
      if (other.plan || other.question) continue;
      turn.pending.delete(otherId);
      clearTimeout(other.timer);
      push(turn, { type: "permission_resolved", reqId: otherId, toolCallId: other.toolCallId, decision: "auto", kind: "all", by: "auto", sub: other.sub });
      other.resolve(selected(pickOption(other.options, ["allow_once", "allow_always"])));
    }
  }
  return { ok: true };
}

export function cancelTurn(id) {
  const turn = turns.get(id);
  if (!turn || turn.done || !turn.agent) return false;
  turn.cancelled = true;
  for (const [reqId, entry] of turn.pending) {
    clearTimeout(entry.timer);
    if (entry.plan) {
      push(turn, { type: "plan_resolved", reqId, decision: "revise", by: "stop" });
      entry.resolve({ outcome: "rejected" });
      continue;
    }
    if (entry.question) {
      resolveQuestion(turn, reqId, entry, { outcome: "cancelled" }, null, "stop");
      continue;
    }
    push(turn, { type: "permission_resolved", reqId, toolCallId: entry.toolCallId, decision: "deny", by: "stop" });
    entry.resolve(selected(null));
  }
  turn.pending.clear();
  if (turn.acpSessionId) turn.agent.notify("session/cancel", { sessionId: turn.acpSessionId });
  setTimeout(() => {
    if (!turn.done) {
      turn.killOnCancel = true;
      turn.agent.kill("SIGTERM");
    }
  }, 5000).unref?.();
  setTimeout(() => {
    if (!turn.done) turn.agent.kill("SIGKILL");
  }, 9000).unref?.();
  return true;
}

export async function cancelSubagent(id, subId) {
  const turn = turns.get(id);
  if (!turn || turn.done || !turn.agent) return { ok: false, status: 409, error: "Nothing is running" };
  const ids = subId === "all" ? [...new Set([...turn.subs.values()].filter((sub) => sub.status === "running").map((sub) => sub.id))] : [subId];
  if (!ids.length) return { ok: false, status: 409, error: "No subagent is running" };
  const results = [];
  for (const one of ids) {
    for (const [reqId, entry] of turn.pending) {
      if (entry.sub && (entry.sub === one || turn.subs.get(entry.sub)?.id === one)) {
        clearTimeout(entry.timer);
        turn.pending.delete(reqId);
        if (entry.question) {
          resolveQuestion(turn, reqId, entry, { outcome: "cancelled" }, null, "stop");
          continue;
        }
        push(turn, { type: "permission_resolved", reqId, toolCallId: entry.toolCallId, decision: "deny", by: "stop", sub: entry.sub });
        entry.resolve(selected(null));
      }
    }
    try {
      const result = await turn.agent.request("_x.ai/subagent/cancel", { sessionId: turn.acpSessionId, subagentId: one }, OPTION_TIMEOUT_MS);
      results.push({ id: one, cancelled: !!result?.result?.cancelled });
      push(turn, { type: "subagent", id: one, stopping: true });
    } catch (error) {
      results.push({ id: one, error: String(error?.message || "error") });
    }
  }
  console.log("turn", id, "cancel subagents", JSON.stringify(results));
  return { ok: true, results };
}

let shuttingDown = false;

// The stall watchdog's recovery: kill the silent Grok process; the exit ends the turn as an error
// and the recovery module resumes the session with a fresh process.
export function killStalled(id) {
  const turn = turns.get(id);
  if (!turn || turn.done || !turn.agent) return false;
  turn.stallKill = true;
  console.log("turn", id, "stalled, restarting Grok");
  turn.agent.kill("SIGTERM");
  setTimeout(() => {
    if (!turn.done) turn.agent.kill("SIGKILL");
  }, 3000).unref?.();
  setTimeout(() => {
    // The process is gone but the prompt promise never settled: end the turn ourselves.
    if (!turn.done) turn.finish("error");
  }, 8000).unref?.();
  return true;
}

export function liveTurns() {
  return [...turns.values()].filter((turn) => !turn.done && turn.started);
}

export async function stopAll() {
  shuttingDown = true;
  const pending = [];
  for (const turn of turns.values()) {
    if (turn.done || !turn.agent) continue;
    cancelTurn(turn.id);
    pending.push(
      new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000);
        turn.agent.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      })
    );
  }
  for (const id of [...agents.keys()]) closeAgent(id);
  await Promise.all(pending);
}

function bad(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

// One grok ACP process per session, kept alive across turns so Grok's background tasks, monitors,
// /loop and background subagents survive the end of a turn and can wake it again.
const starting = new Set();
const agents = new Map(); // sessionId -> { agent, acpId, sig, holder, idleTimer }
const AGENT_IDLE_MS = Number(process.env.GM_AGENT_IDLE_MS) || 45 * 60 * 1000;

function armIdle(entry) {
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    const turn = entry.holder.turn;
    if (turn && !turn.done) return armIdle(entry);
    if (turn && turn.subs && [...turn.subs.values()].some((sub) => sub.status === "running")) return armIdle(entry);
    console.log("agent idle, closing", entry.acpId);
    entry.agent.kill("SIGTERM");
    setTimeout(() => entry.agent.kill("SIGKILL"), 3000).unref?.();
  }, AGENT_IDLE_MS);
  entry.idleTimer.unref?.();
}

export function closeAgent(id) {
  const entry = agents.get(id);
  if (!entry) return;
  agents.delete(id);
  clearTimeout(entry.idleTimer);
  entry.agent.kill("SIGTERM");
  setTimeout(() => entry.agent.kill("SIGKILL"), 3000).unref?.();
}

function makeFinish(turn, entryRef) {
  return async (stopReason, code) => {
    if (turn.done) return;
    if (stopReason === "cancelled" && turn.denied && !turn.cancelled) stopReason = "denied";
    invalidateAccount();
    turn.done = true;
    turn.finishedAt = Date.now();
    for (const [reqId, entry] of turn.pending) {
      clearTimeout(entry.timer);
      // A question still open when the turn ends is closed, and the agent (if it is still there) is told no answer is coming.
      if (entry.question) resolveQuestion(turn, reqId, entry, { outcome: "cancelled" }, null, "turn ended");
    }
    turn.pending.clear();
    if (stopReason === "end_turn") {
      const verdict = proofVerdict(turn.proof);
      if (verdict) push(turn, { type: "evidence", ...verdict });
    }
    push(turn, { type: "end", stopReason });
    if (stopReason === "error") {
      const detail = redact(entryRef.stderrTail || "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-3)
        .join(" ")
        .slice(0, 500);
      push(turn, { type: "error", message: turn.errorMessage || detail || "Grok exited with an error" });
    }
    push(turn, { type: "settled" });
    const entry = agents.get(turn.id);
    if (entry && entry.agent === turn.agent && !entryRef.exited) {
      if (turn.cancelled && stopReason === "cancelled" && turn.killOnCancel) closeAgent(turn.id);
      else armIdle(entry);
    }
    try {
      const saved = await getMeta();
      const manual = saved.sessions?.[turn.id]?.title;
      if (manual) await applyManualTitle(turn.id, manual);
    } catch (error) {
      console.error("rename failed", turn.id, error?.code || "error");
    }
    console.log("turn", turn.id, "end", stopReason, code ?? "");
    turnEvents.emit("changed", { id: turn.id, what: "turn" });
    turnEvents.emit("finished", { id: turn.id, stopReason, title: turn.draftTitle, error: stopReason === "error" ? turn.errorMessage || "Grok exited with an error" : "", longRun: !!turn.longRun, stall: !!turn.stallKill, shutdown: shuttingDown });
  };
}

function spawnAgent({ real, args, env, holder, entryRef }) {
  return startAgent({
    cwd: real,
    args,
    env,
    onRequest: async (method, params, rpcId) => {
      const turn = holder.turn;
      if (method === "session/request_permission") return onPermission(turn, params, rpcId);
      if (method === "_x.ai/exit_plan_mode") return onPlanReady(turn, params, rpcId);
      if (method === ASK_METHOD) return onQuestion(turn, params, rpcId);
      // Anything else Grok asks of a client is logged, so a request nothing answers can be seen and then built.
      console.log("acp request not handled:", method, redact(JSON.stringify(params)).slice(0, 1500));
      if (method === "_x.ai/mcp/elicit") return { action: "decline" }; // an MCP form: nothing here can fill it in yet
      const error = new Error("Method not found: " + method);
      error.code = -32601;
      throw error;
    },
    onNotify: (method, params) => {
      if (params?.update?.sessionUpdate === "available_commands_update") {
        noteCommands(params.sessionId, params.update.availableCommands);
        return;
      }
      if (holder.loading) return;
      let turn = holder.turn;
      const update = params.update || {};
      // Any notification is Grok being alive (compaction, subagent progress, usage), even ones the app doesn't show.
      if (turn && !turn.done) turn.lastEventAt = Date.now();
      // Grok woke itself (background task, monitor, /loop): open a new turn record for it.
      if (canOpenWake(turn, params.sessionId, update.sessionUpdate, starting)) {
        turn = openWakeTurn(holder, turn);
      }
      // Grok sends turn_completed as _x.ai/session_notification (checked on the wire), so test it before any method filter.
      if (update.sessionUpdate === "turn_completed" && turn.wake && !turn.done && params.sessionId === turn.acpSessionId) {
        turn.finish("end_turn");
        return;
      }
      recordExec(turn, update.rawOutput);
      if (params.sessionId === turn.acpSessionId) trackProof(turn.proof, update);
      if (/session_notification$/.test(method)) {
        const sev = subagentEvent(update);
        if (sev) {
          const prev = turn.subs.get(sev.child || sev.id) || turn.subs.get(sev.id) || {};
          const next = { ...prev, ...sev };
          turn.subs.set(sev.id, next);
          if (next.child) turn.subs.set(next.child, next);
          noteSubagentTokens(turn, prev, sev);
          if (sev.status === "running" && prev.status === "running" && !sev.name) return;
          push(turn, sev);
          return;
        }
        const childId = params.sessionId;
        if (update.sessionUpdate === "response_completed") {
          const u = update.usage || {};
          const used = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
          if (childId && childId !== turn.acpSessionId && turn.subs.has(childId)) {
            const sub = turn.subs.get(childId);
            sub.liveTokens = (sub.liveTokens || 0) + used;
            turn.subTokensUsed = (turn.subTokensUsed || 0) + used;
            push(turn, { type: "subagent", id: sub.id, liveTokens: sub.liveTokens });
          } else if (used) {
            turn.tokensUsed = (turn.tokensUsed || 0) + used;
            push(turn, { type: "usage", tokens: used });
          }
        }
        return;
      }
      if (method !== "session/update") return;
      const ev = fromAcp(update);
      if (!ev) return;
      if (params.sessionId && turn.acpSessionId && params.sessionId !== turn.acpSessionId) {
        if (ev.type === "title") return;
        const sub = turn.subs.get(params.sessionId);
        ev.sub = sub?.id || params.sessionId;
        if (ev.toolCallId) turn.childTools.set(ev.toolCallId, params.sessionId);
        push(turn, ev);
        return;
      }
      if (ev.type === "title") turn.draftTitle = ev.title;
      push(turn, ev);
    },
    onExit: (code, sig, stderr) => {
      entryRef.exited = true;
      entryRef.stderrTail = stderr;
      const entry = agents.get(holder.turn?.id);
      if (entry && entry.agent === holder.turn?.agent) {
        clearTimeout(entry.idleTimer);
        agents.delete(holder.turn.id);
      }
      const turn = holder.turn;
      if (turn && !turn.done && turn.started) {
        if (!turn.errorMessage) turn.errorMessage = turn.stallKill ? "Grok went quiet for too long; restarting it" : "Grok exited mid-turn (" + (sig || "code " + code) + ")";
        turn.finish(turn.cancelled ? "cancelled" : "error", code);
      }
    },
  });
}

// Exit codes of shell commands this turn (Bash and background TaskOutput results), so the long-run
// supervisor can check that GOAL.md's checks really ran and passed.
function recordExec(turn, raw) {
  if (!raw || typeof raw !== "object") return;
  const result = raw.type === "Bash" ? raw : raw.type === "TaskOutput" ? raw.Result : null;
  if (!result || typeof result.command !== "string" || !Number.isInteger(result.exit_code)) return;
  if (!turn.execs) turn.execs = [];
  turn.execs.push({ command: result.command.slice(0, 2000), code: result.exit_code });
  if (turn.execs.length > 400) turn.execs.shift();
}

export function watchPayload(change) {
  const data = { what: change?.what };
  if (change?.items !== undefined) data.items = change.items;
  if (change?.review !== undefined) data.review = change.review;
  if (change?.run !== undefined) data.run = change.run;
  if (change?.loops !== undefined) data.loops = change.loops;
  return data;
}

// A wake must not open a second turn while startTurn is still awaiting session setup.
export function canOpenWake(turn, sessionId, updateKind, startingIds) {
  return !!(
    turn?.done &&
    !turn.cancelled &&
    !startingIds?.has(turn.id) &&
    sessionId === turn.acpSessionId &&
    /^(agent_message_chunk|agent_thought_chunk|tool_call|user_message_chunk)$/.test(updateKind || "")
  );
}

// subagent_finished tokens count toward the long-run budget unless response_completed already added them.
export function noteSubagentTokens(turn, prev, sev) {
  const tokens = Number(sev?.tokens) || 0;
  if (!tokens || sev.status === "running") return;
  const already = Number(prev?.liveTokens) || 0;
  const extra = Math.max(0, tokens - already);
  if (extra) turn.subTokensUsed = (turn.subTokensUsed || 0) + extra;
}

function openWakeTurn(holder, prev) {
  const turn = createTurn(prev.id);
  Object.assign(turn, {
    id: prev.id,
    acpSessionId: prev.acpSessionId,
    agent: prev.agent,
    cwd: prev.cwd,
    mode: prev.mode,
    autoKinds: prev.autoKinds,
    longRun: prev.longRun,
    lastEventAt: Date.now(),
    draftTitle: prev.draftTitle,
    started: true,
    wake: true,
    baseMessages: viewTurn(prev).messages,
  });
  turn.finish = makeFinish(turn, holder.entryRef);
  holder.turn = turn;
  turns.set(turn.id, turn);
  const entry = agents.get(turn.id);
  if (entry) clearTimeout(entry.idleTimer);
  console.log("turn", turn.id, "start wake (Grok resumed on its own)");
  turnEvents.emit("changed", { id: turn.id, what: "turn" });
  return turn;
}

export async function startTurn({ sessionId, cwd, prompt, images: imageInput, files: fileInput, model, effort, permissionMode, ultra, plan, title, extraRules, longRun }) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  const images = cleanImages(imageInput);
  const files = cleanFileRefs(fileInput);
  if (!text && !images.length && !files.length) throw bad(400, "Message is empty");
  if (text.length > 100000) throw bad(400, "Message is too long");
  if (sessionId && !isUuid(sessionId)) throw bad(400, "Unknown session");
  if (sessionId) {
    // Reserve synchronously, before any await, so two starts can't both launch Grok on one session.
    if (isBusy(sessionId)) throw bad(409, "A turn is already running");
    starting.add(sessionId);
  }
  try {
    return await startTurnInner({ sessionId, cwd, text, images, files, model, effort, permissionMode, ultra, plan, title, extraRules, longRun });
  } finally {
    if (sessionId) starting.delete(sessionId);
  }
}

async function startTurnInner({ sessionId, cwd, text: typed, images, files, model, effort, permissionMode, ultra, plan, title, extraRules, longRun }) {
  const existing = sessionId ? await findSession(sessionId) : null;
  if (sessionId && !existing) throw bad(404, "Session not found");
  const meta = await getMeta();
  const prev = (sessionId && meta.sessions?.[sessionId]) || {};
  const real = await realDirectory(existing?.cwd || prev.cwd || cwd);
  // Attached files are copied into the working folder, where the agent can read them; the prompt names the copies.
  const attached = await attachFiles(files, real);
  const text = typed || (attached.files.length ? "See the attached file" + (attached.files.length > 1 ? "s" : "") + "." : "");
  const promptText = attached.block ? text + "\n\n" + attached.block : text;
  const useUltra = ultra != null ? !!ultra : !!prev.ultra;
  const prefs = {
    cwd: real,
    model: cleanModel(model, prev.model || "grok-4.7"),
    effort: cleanEffort(effort, prev.effort || "high"),
    permissionMode: cleanMode(permissionMode, cleanMode(prev.permissionMode, "default")),
    ultra: useUltra,
    plan: plan === undefined || plan === null ? !!prev.plan : !!plan,
  };
  // Ultra code always runs at Extra high; the session keeps its own effort for lean turns.
  const effortUsed = useUltra ? "xhigh" : prefs.effort;

  // Approvals are always decided here (never --always-approve), so a mode change applies at once.
  const args = [];
  const skills = await pstackPlugin();
  if (skills) args.push("--plugin-dir", skills);
  if (useUltra) {
    if (!skills) throw bad(500, "pstack is not installed for Ultra code");
    args.push("--plugin-dir", ULTRA_PLUGIN_DIR);
  }
  let rules = skills ? BASE_RULES + "\n\n" + PSTACK_RULES : BASE_RULES;
  if (useUltra) rules += "\n\n" + ULTRA_RULES;
  if (extraRules) rules += "\n\n" + String(extraRules);
  // autoMode is only read at session load, so switching to or from Auto needs a fresh process.
  const sig = JSON.stringify({ args, rules, longRun: !!longRun, auto: prefs.permissionMode === "auto" });

  const turn = createTurn(sessionId || "pending");
  turn.cwd = real;
  turn.longRun = !!longRun;
  turn.mode = prefs.permissionMode;
  turn.autoKinds = new Set(Array.isArray(prev.autoApprove) ? prev.autoApprove : []);

  let entry = sessionId ? agents.get(sessionId) : null;
  if (entry && (entry.sig !== sig || entry.entryRef.exited)) {
    closeAgent(sessionId);
    entry = null;
  }
  let acpId;
  if (entry) {
    clearTimeout(entry.idleTimer);
    acpId = entry.acpId;
    turn.agent = entry.agent;
    turn.finish = makeFinish(turn, entry.entryRef);
    entry.holder.turn = turn;
  } else {
    const holder = { turn, loading: false };
    const entryRef = { exited: false, stderrTail: "" };
    holder.entryRef = entryRef;
    const agent = spawnAgent({ real, args, env: { ...process.env, GROK_MOBILE: "1", GM_LONGRUN: longRun ? "1" : "" }, holder, entryRef });
    turn.agent = agent;
    turn.finish = makeFinish(turn, entryRef);
    try {
      await agent.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "grok-build-web", version: "3.0" },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        },
        SETUP_TIMEOUT_MS
      );
      const sessionMeta = { yoloMode: false, autoMode: prefs.permissionMode === "auto", rules };
      if (existing) {
        holder.loading = true;
        await agent.request("session/load", { sessionId, cwd: real, mcpServers: [], _meta: sessionMeta }, SETUP_TIMEOUT_MS);
        holder.loading = false;
        acpId = sessionId;
      } else {
        const created = await agent.request("session/new", { cwd: real, mcpServers: [], _meta: sessionMeta }, SETUP_TIMEOUT_MS);
        acpId = created?.sessionId;
        if (!isUuid(acpId)) throw new Error("Grok did not return a session id");
      }
    } catch (error) {
      holder.loading = false;
      agent.kill("SIGKILL");
      if (entryRef.exited && /auth|login/i.test(entryRef.stderrTail)) throw bad(502, "Grok needs you to log in again on the computer");
      console.error("agent start failed", error?.message || "error");
      throw bad(502, "Could not start Grok: " + redact(error?.message || "error").slice(0, 200));
    }
    entry = { agent, acpId, sig, holder, entryRef, idleTimer: null };
    agents.set(acpId, entry);
  }
  try {
    // Plan mode is Grok's own: read-only until the plan is approved through exit_plan_mode.
    if (prefs.plan || prev.planUsed) {
      try {
        await turn.agent.request("session/set_mode", { sessionId: acpId, modeId: prefs.plan ? "plan" : "default" }, OPTION_TIMEOUT_MS);
      } catch (error) {
        console.error("set_mode", error?.message || "error");
      }
    }
    for (const [configId, value] of [
      ["model", prefs.model],
      ["reasoning_effort", effortUsed],
    ]) {
      try {
        await turn.agent.request("session/set_config_option", { sessionId: acpId, configId, value }, OPTION_TIMEOUT_MS);
      } catch (error) {
        console.error("config", configId, error?.message || "error");
      }
    }
  } catch {
    // options are best effort
  }

  const id = acpId;
  turn.id = id;
  turn.acpSessionId = acpId;
  const history = existing ? await loadTranscript(id) : { messages: [] };
  const userMessage = { id: "user:" + (history.messages.length + 1), role: "user", text, open: false };
  if (images.length) userMessage.images = images.map((image) => ({ mime: image.mime, data: image.data }));
  if (attached.files.length) userMessage.files = attached.files;
  turn.baseMessages = [...applyQuestions(history.messages, prev.asked), userMessage];
  turn.draftTitle = (title || prev.title || prev.draftTitle || text.split("\n")[0] || (images.length ? "Photo" : attached.files[0]?.name || "New session")).slice(0, 80);
  turns.set(id, turn);
  turnEvents.emit("changed", { id, what: "turn" });

  const save = { ...prefs, planUsed: prefs.plan || !!prev.planUsed, draftTitle: prev.title ? prev.draftTitle : turn.draftTitle };
  if (title) save.title = title;
  await setSessionPrefs(id, save);
  await rememberDir(real);

  let blocks = promptBlocks(promptText, images);
  if (useUltra) {
    const first = blocks[0];
    const routed = "/poteto-mode " + (first?.type === "text" ? first.text : "");
    if (first?.type === "text") blocks = [{ type: "text", text: routed }, ...blocks.slice(1)];
    else blocks = [{ type: "text", text: "/poteto-mode" }, ...blocks];
  }
  turn.started = true;
  turn.lastEventAt = Date.now();
  turnEvents.emit("started", { id, longRun: !!longRun });
  console.log("turn", id, "start", prefs.permissionMode, prefs.model, effortUsed, useUltra ? "ultra" : "lean", images.length ? "images " + images.length : "text", entry.reused ? "reuse" : "");
  entry.reused = true;
  turn.agent
    .request("session/prompt", { sessionId: acpId, prompt: blocks })
    .then((result) => turn.finish(turn.cancelled ? "cancelled" : result?.stopReason || "end_turn"))
    .catch((error) => {
      if (turn.done) return;
      turn.errorMessage = redact(error?.message || "").slice(0, 300);
      turn.finish(turn.cancelled ? "cancelled" : "error");
    });
  return { sessionId: id, cursor: 0 };
}

export function forgetTurn(id) {
  closeAgent(id);
  const turn = turns.get(id);
  if (turn && turn.done) turns.delete(id);
}

// Grok asks the client to approve its plan (ACP ext method _x.ai/exit_plan_mode).
function onPlanReady(turn, params, rpcId) {
  const plan = String(params?.planContent || "").slice(0, 40000);
  const reqId = "p" + rpcId + "-" + Date.now().toString(36);
  push(turn, { type: "plan_ready", reqId, plan });
  turnEvents.emit("permission", { id: turn.id, title: turn.draftTitle, kind: "plan", detail: "Plan ready for review" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => answerPlan(turn.id, reqId, "revise", "timeout"), PERMISSION_TIMEOUT_MS);
    timer.unref?.();
    turn.pending.set(reqId, { resolve: (value) => resolve(value), plan: true, timer, options: [] });
  });
}

// ask_user_question. Captured from Grok 1.0.50 (13 Oct 2026), one request per call of the tool:
//   method  _x.ai/ask_user_question
//   params  { sessionId, toolCallId, mode: "default",
//             questions: [{ question, options: [{ label, description }], multiSelect: true | null }] }
//   answer  { outcome: "accepted", answers: { "<question text>": "<label>" | ["<label>", ...] | "<typed text>" } }
//           or { outcome: "cancelled" }   (Grok tells the model the user declined)
// A typed "Other" answer is just the text in place of a label. sessionId is the asking session: a subagent's own
// id when a subagent asks.
const ASK_METHOD = "_x.ai/ask_user_question";
const QUESTION_TIMEOUT_MS = Number(process.env.GM_QUESTION_TIMEOUT_MS) || 30 * 60 * 1000;

function cleanQuestions(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.slice(0, 8).map((q) => ({
    question: String(q?.question || "").slice(0, 600),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 12).map((o) => ({
      label: String(o?.label ?? o ?? "").slice(0, 200),
      description: String(o?.description || "").slice(0, 400),
    })).filter((o) => o.label),
  })).filter((q) => q.question);
}

function onQuestion(turn, params, rpcId) {
  const questions = cleanQuestions(params?.questions);
  if (!questions.length || turn.cancelled || turn.done) return { outcome: "cancelled" };
  const childSession = params.sessionId && turn.acpSessionId && params.sessionId !== turn.acpSessionId ? params.sessionId : "";
  const sub = childSession ? turn.subs.get(childSession) : null;
  const reqId = "q" + rpcId + "-" + Date.now().toString(36);
  // Shown as one card at the top level, with the subagent's name, whoever asked: a card inside a subagent's own
  // list would be easy to miss while a turn waits on it.
  push(turn, { type: "question", reqId, toolCallId: params.toolCallId, questions, from: childSession ? sub?.name || "Subagent" : "" });
  turnEvents.emit("permission", { id: turn.id, title: turn.draftTitle, kind: "question", subName: childSession ? sub?.name || "Subagent" : "", detail: questions[0].question });
  return new Promise((resolve) => {
    const timer = setTimeout(() => answerQuestion(turn.id, reqId, { cancel: true }, "timeout"), QUESTION_TIMEOUT_MS);
    timer.unref?.();
    turn.pending.set(reqId, { resolve, question: true, questions, timer, toolCallId: params.toolCallId, sub: sub?.id || childSession || undefined, options: [] });
  });
}

// Closes one parked question: tells the card, remembers what was answered (so the card survives the turn and a
// restart), and answers the agent.
function resolveQuestion(turn, reqId, entry, response, shown, by) {
  push(turn, { type: "question_resolved", reqId, outcome: response.outcome, answers: shown || undefined, by });
  if (entry.toolCallId) {
    const record = { status: response.outcome === "accepted" ? "answered" : "cancelled", answers: shown || undefined, by };
    updateMeta((meta) => {
      const prev = meta.sessions[turn.id] || {};
      const asked = { ...(prev.asked || {}), [entry.toolCallId]: record };
      const keys = Object.keys(asked);
      for (const old of keys.slice(0, Math.max(0, keys.length - 50))) delete asked[old];
      meta.sessions[turn.id] = { ...prev, asked };
      return meta;
    }).catch(() => {});
  }
  entry.resolve(response);
}

// body: { cancel: true } or { answers: [one per question: a label or typed text, or a list of them when multi-select] }.
export async function answerQuestion(id, reqId, body, by = "user") {
  const turn = turns.get(id);
  if (!turn || turn.done) return { ok: false, status: 409, error: "That question was already answered" };
  const entry = turn.pending.get(reqId);
  if (!entry || !entry.question) return { ok: false, status: 409, error: "That question was already answered" };
  let response;
  let shown = null;
  if (body?.cancel) {
    response = { outcome: "cancelled" };
  } else {
    const given = Array.isArray(body?.answers) ? body.answers : [];
    const answers = {};
    shown = [];
    for (let i = 0; i < entry.questions.length; i += 1) {
      const q = entry.questions[i];
      const value = given[i];
      const parts = (Array.isArray(value) ? value : [value]).map((v) => String(v ?? "").trim().slice(0, 4000)).filter(Boolean);
      if (!parts.length) return { ok: false, status: 400, error: "Answer every question" };
      if (!q.multiSelect && parts.length > 1) return { ok: false, status: 400, error: "Choose one answer for: " + q.question.slice(0, 80) };
      if (answers[q.question] !== undefined) return { ok: false, status: 400, error: "Two questions are the same" };
      answers[q.question] = q.multiSelect ? parts.slice(0, 12) : parts[0];
      shown.push(q.multiSelect ? parts.slice(0, 12) : parts[0]);
    }
    response = { outcome: "accepted", answers };
  }
  turn.pending.delete(reqId);
  clearTimeout(entry.timer);
  resolveQuestion(turn, reqId, entry, response, shown, by);
  return { ok: true };
}

export async function answerPlan(id, reqId, decision, by = "user") {
  const turn = turns.get(id);
  if (!turn || turn.done) return { ok: false, status: 409, error: "That plan was already answered" };
  const entry = turn.pending.get(reqId);
  if (!entry || !entry.plan) return { ok: false, status: 409, error: "That plan was already answered" };
  if (!["approve", "revise"].includes(decision)) return { ok: false, status: 400, error: "Unknown decision" };
  turn.pending.delete(reqId);
  clearTimeout(entry.timer);
  push(turn, { type: "plan_resolved", reqId, decision, by });
  if (decision === "approve") {
    await setSessionPrefs(id, { plan: false });
    turnEvents.emit("changed", { id, what: "prefs" });
    entry.resolve({ outcome: "approved" });
  } else {
    // Revise: stop this turn; plan mode stays on and the next message refines the plan.
    entry.resolve({ outcome: "rejected" });
    cancelTurn(id);
  }
  return { ok: true };
}
