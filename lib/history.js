import fs from "node:fs/promises";
import { extractImages, mergeImages } from "../public/reduce.js";
import { newProof, proofVerdict, trackProof } from "./evidence.js";

const TAIL_BYTES = 6_000_000;
const FILE_LIMIT = 12_000_000;

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOf).filter(Boolean).join("\n");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (content.content) return textOf(content.content);
  }
  return "";
}

function inputOf(raw) {
  if (raw == null) return "";
  if (typeof raw === "object" && typeof raw.command === "string") return raw.command;
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return "";
  }
}

function clip(text, limit) {
  const value = String(text || "");
  if (value.length <= limit) return value;
  return value.slice(0, limit) + "\n...";
}

function closeOpen(open) {
  if (open.msg) open.msg.open = false;
  open.msg = null;
  open.role = null;
}

function pushText(messages, open, role, text) {
  if (!text) return;
  if (open.role === role && open.msg) {
    open.msg.text += text;
    return;
  }
  closeOpen(open);
  const msg = { id: role + ":" + (messages.length + 1), role, text, open: true };
  messages.push(msg);
  open.role = role;
  open.msg = msg;
}

function pushImages(messages, open, role, images) {
  if (!images.length) return;
  if (open.role === role && open.msg) {
    open.msg.images = mergeImages(open.msg.images, images);
    return;
  }
  closeOpen(open);
  const msg = { id: role + ":" + (messages.length + 1), role, text: "", images, open: true };
  messages.push(msg);
  open.role = role;
  open.msg = msg;
}

function absorb(messages, open, role, content) {
  pushText(messages, open, role, textOf(content));
  pushImages(messages, open, role, extractImages(content));
}

// Harness-injected text (system reminders, task notices) is not something the user typed.
const INJECTED = /<(system-reminder|system|task-notification|command-output|local-command-stdout|user-prompt-submit-hook)>[\s\S]*?(<\/\1>|$)/g;
export function splitInjected(text) {
  const raw = String(text || "");
  if (!raw.includes("<")) return { note: "", rest: raw };
  const notes = [];
  const rest = raw.replace(INJECTED, (m) => {
    notes.push(m.replace(/<\/?[a-z-]+>/g, "").trim());
    return "";
  }).trim();
  return { note: notes.filter(Boolean).join("\n\n"), rest };
}

export function parseUpdates(jsonl, { trimmed } = {}) {
  const messages = [];
  const tools = new Map();
  const subs = new Map();
  let lastPlan = "";
  const open = { role: null, msg: null };
  let proof = newProof();
  if (trimmed) {
    messages.push({
      id: "status:trimmed",
      role: "status",
      text: "Earlier messages were left out of this view.",
    });
  }
  for (const line of String(jsonl || "").split("\n")) {
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const update = row?.params?.update || row.update || row;
    const kind = update.sessionUpdate || update.type;
    trackProof(proof, update);
    if (kind === "tool_call" && typeof update.rawInput?.file_path === "string" && update.rawInput.file_path.endsWith("/plan.md") && (update.rawInput.new_string || update.rawInput.content)) {
      lastPlan = String(update.rawInput.new_string || update.rawInput.content).slice(0, 40000);
    }
    if (kind === "tool_call" && update.title === "exit_plan_mode" && lastPlan) {
      closeOpen(open);
      messages.push({ id: "plan:" + (update.toolCallId || messages.length), role: "planreview", plan: lastPlan, status: "history" });
      continue;
    }
    if (kind === "user_message_chunk") {
      const { note, rest } = splitInjected(textOf(update.content));
      if (note) {
        closeOpen(open);
        messages.push({ id: "note:" + messages.length, role: "note", text: clip(note, 4000) });
      }
      if (rest) proof = newProof(); // a real user message starts a new turn
      if (rest || extractImages(update.content).length) {
        if (note) absorb(messages, open, "user", rest);
        else absorb(messages, open, "user", update.content);
      }
    } else if (kind === "hook_annotation" && update.message) {
      closeOpen(open);
      messages.push({ id: "note:" + messages.length, role: "note", text: clip(String(update.message), 2000) });
    }
    else if (kind === "agent_message_chunk") absorb(messages, open, "assistant", update.content);
    else if (kind === "agent_thought_chunk") absorb(messages, open, "thought", update.content);
    else if (kind === "image_dropped") {
      const notes = Array.isArray(update.notes) ? update.notes.map((note) => String(note || "").trim()).filter(Boolean).join(" ") : "";
      messages.push({
        id: "status:image" + messages.length,
        role: "status",
        text: clip(notes || "An image was left out.", 500),
      });
    } else if (kind === "subagent_spawned" || kind === "subagent_finished") {
      const id = update.subagent_id || update.child_session_id;
      if (!id) continue;
      let msg = subs.get(id);
      if (!msg) {
        closeOpen(open);
        msg = { id: "sub:" + id, role: "subagent", sub: { id, child: update.child_session_id || id, name: "Subagent", status: "running", messages: [] } };
        subs.set(id, msg);
        messages.push(msg);
      }
      const stamp = row.timestamp ?? row.ts;
      const at = typeof stamp === "number" ? (stamp < 1e12 ? stamp * 1000 : stamp) : Date.parse(stamp || "") || undefined;
      if (kind === "subagent_spawned") {
        msg.sub.name = clip(update.description || update.subagent_type || "Subagent", 80);
        msg.sub.agentType = update.subagent_type || "";
        if (at) msg.sub.startedAt = at;
      } else {
        msg.sub.status = update.status || "completed";
        msg.sub.tokens = Number(update.tokens_used) || undefined;
        msg.sub.durationMs = Number(update.duration_ms) || undefined;
        msg.sub.toolCalls = Number(update.tool_calls) || undefined;
        msg.sub.summary = clip(update.output || update.error || "", 4000);
        if (at) msg.sub.finishedAt = at;
      }
    } else if (kind === "turn_completed") {
      const verdict = proofVerdict(proof);
      if (verdict) {
        closeOpen(open);
        messages.push({ id: "status:proof" + messages.length, role: "status", tone: verdict.tone, text: verdict.text });
      }
      proof = newProof();
      const used = Number(update.usage?.totalTokens) || 0;
      for (let i = messages.length - 1; i >= 0 && used; i--) {
        const m = messages[i];
        if (m.role === "user") break;
        if (m.role === "tool" || m.role === "thought" || m.role === "plan") {
          m.tokens = used;
          m.turnTokens = true;
          break;
        }
      }
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const id = update.toolCallId || "tool" + messages.length;
      let msg = tools.get(id);
      if (!msg) {
        closeOpen(open);
        const meta = update._meta?.["x.ai/tool"] || {};
        msg = {
          id: "tool:" + id,
          role: "tool",
          tool: {
            id,
            name: meta.name || update.kind || update.toolName || "tool",
            title: update.title || meta.label || "Tool",
            status: update.status || "in_progress",
            input: clip(inputOf(update.rawInput), 4000),
            output: "",
          },
        };
        if (typeof update.rawInput?.description === "string") msg.tool.description = update.rawInput.description;
        if (msg.tool.input === "{}" || msg.tool.input === '""') msg.tool.input = "";
        tools.set(id, msg);
        messages.push(msg);
      } else {
        if (update.status) msg.tool.status = update.status;
        if (update.kind) msg.tool.kind = update.kind;
        if (update.title) msg.tool.title = update.title;
        const meta = update._meta?.["x.ai/tool"];
        if (meta?.name) msg.tool.name = meta.name;
      }
      const images = extractImages(update.content, update.rawOutput);
      if (images.length) msg.tool.images = mergeImages(msg.tool.images, images);
      let output = textOf(update.content);
      if (output && output === msg.tool.description && !update.status) output = "";
      if (update.status === "failed" && /^User (rejected|cancelled) the execution/.test(output)) msg.tool.status = "denied";
      const rawText = !output && update.rawOutput != null && !images.length ? textOf(update.rawOutput) || JSON.stringify(update.rawOutput) : "";
      if (output || rawText) msg.tool.output = clip(output || rawText, 6000);
    }
  }
  closeOpen(open);
  capImages(messages);
  for (const message of messages) {
    if (message.role === "user" || message.role === "assistant" || message.role === "thought") {
      message.text = clip(message.text, 40000);
    }
  }
  return messages;
}

function capImages(messages) {
  const lists = [];
  for (const message of messages) {
    if (message.images) lists.push(message.images);
    if (message.tool?.images) lists.push(message.tool.images);
  }
  let count = lists.reduce((sum, list) => sum + list.length, 0);
  if (count <= 24) return;
  for (const list of lists) {
    while (list.length && count > 24) {
      list.shift();
      count -= 1;
    }
  }
  messages.unshift({
    id: "status:images",
    role: "status",
    text: "Some older images were left out of this view.",
  });
}

export async function readUpdatesFile(file) {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return { messages: [], trimmed: false };
  }
  let trimmed = false;
  let text;
  if (stat.size > FILE_LIMIT) {
    const handle = await fs.open(file, "r");
    try {
      const length = Math.min(TAIL_BYTES, stat.size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      text = buffer.toString("utf8");
      const newline = text.indexOf("\n");
      if (newline !== -1) text = text.slice(newline + 1);
      trimmed = true;
    } finally {
      await handle.close();
    }
  } else {
    text = await fs.readFile(file, "utf8");
  }
  return { messages: parseUpdates(text, { trimmed }), trimmed };
}
