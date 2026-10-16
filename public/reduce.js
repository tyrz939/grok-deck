import { findRefs, rewriteRefs } from "./markdown.js";

export function asText(value, limit = 1200) {
  if (value == null) return "";
  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  if (text.length > limit) return text.slice(0, limit) + "\n...";
  return text;
}

const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_IMAGES = 6;
const MAX_DATA = 900_000;

function sniffData(data) {
  if (data.startsWith("iVBORw0KGgo")) return "image/png";
  if (data.startsWith("/9j/")) return "image/jpeg";
  if (data.startsWith("R0lGOD")) return "image/gif";
  if (data.startsWith("UklGR")) return "image/webp";
  return "";
}

function pickImage(value) {
  const data = typeof value.data === "string" ? value.data.replace(/\s/g, "") : "";
  if (!data || data.length > MAX_DATA || !/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  const mime = String(value.mimeType || value.mime_type || sniffData(data) || "");
  const looks = value.type === "image" || value.mimeType || value.mime_type;
  if (!looks || !IMAGE_MIME.has(mime)) return null;
  return { mime, data };
}

function walkImages(value, bucket, seen) {
  if (value == null || bucket.length >= MAX_IMAGES || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) walkImages(item, bucket, seen);
    return;
  }
  const image = pickImage(value);
  if (image) {
    const key = image.data.length + ":" + image.data.slice(0, 40);
    if (!seen.has(key)) {
      seen.add(key);
      bucket.push(image);
    }
    return;
  }
  if (value.ImageContent) walkImages(value.ImageContent, bucket, seen);
  if (value.content != null) walkImages(value.content, bucket, seen);
}

export function extractImages(...values) {
  const bucket = [];
  const seen = new Set();
  for (const value of values) walkImages(value, bucket, seen);
  return bucket;
}

export function mergeImages(current, extra) {
  const out = Array.isArray(current) ? current.slice(0, MAX_IMAGES) : [];
  const seen = new Set(out.map((image) => image.data.length + ":" + image.data.slice(0, 40)));
  for (const image of extra || []) {
    if (!image?.data || !IMAGE_MIME.has(image.mime)) continue;
    const key = image.data.length + ":" + image.data.slice(0, 40);
    if (seen.has(key)) continue;
    if (out.length >= MAX_IMAGES) break;
    seen.add(key);
    out.push({ mime: image.mime, data: image.data });
  }
  return out;
}

export function plainText(value, limit = 1200) {
  const text = collectText(value).trim();
  if (!text) return "";
  if (text.length > limit) return text.slice(0, limit) + "\n...";
  return text;
}

function collectText(value) {
  if (value == null || typeof value === "number" || typeof value === "boolean") return value == null ? "" : String(value);
  if (typeof value === "string") return value;
  if (typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n");
  if (value.type === "image" || value.mime_type || (value.mimeType && value.data && !value.text)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (value.content != null) return collectText(value.content);
  return "";
}

function nid(state, prefix) {
  state.n = (state.n || 0) + 1;
  return prefix + ":" + state.n;
}

function closeOpen(state) {
  const last = state.messages[state.messages.length - 1];
  if (last && last.open) last.open = false;
}

function appendChunk(state, role, data) {
  const text = String(data ?? "");
  if (!text) return;
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === role && last.open) {
    if (text.startsWith(last.text) && text.length >= last.text.length) last.text = text;
    else last.text += text;
    return;
  }
  closeOpen(state);
  state.messages.push({ id: nid(state, role), role, text, open: true });
}

function findTool(state, toolCallId) {
  if (!toolCallId) return null;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message.role === "tool" && message.tool && message.tool.id === toolCallId) return message;
  }
  return null;
}

function ensureTool(state, ev) {
  let message = findTool(state, ev.toolCallId);
  if (message) return message;
  closeOpen(state);
  const id = ev.toolCallId || nid(state, "tool");
  message = {
    id: "tool:" + id,
    role: "tool",
    tool: { id, name: ev.toolName || ev.kind || "tool", title: ev.title || ev.toolName || "Tool", status: "in_progress", input: "", output: "" },
  };
  state.messages.push(message);
  return message;
}

const STOP_LABEL = {
  cancelled: "Stopped",
  denied: "Denied. Tell Grok what to do instead.",
  max_tokens: "Stopped: hit the output limit",
  max_turn_requests: "Stopped: hit the turn limit",
  refusal: "Grok declined this request",
  error: "Stopped with an error",
};

export function findSubagent(state, id) {
  if (!id) return null;
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    const message = state.messages[i];
    if (message.role === "subagent" && (message.sub.id === id || message.sub.child === id)) return message;
  }
  return null;
}

function ensureSubagent(state, id) {
  let message = findSubagent(state, id);
  if (message) return message;
  closeOpen(state);
  message = { id: "sub:" + id, role: "subagent", sub: { id, child: id, name: "Subagent", status: "running", messages: [] } };
  state.messages.push(message);
  return message;
}

const SUB_FIELDS = ["child", "name", "agentType", "model", "status", "startedAt", "finishedAt", "durationMs", "tokens", "liveTokens", "toolCalls", "summary", "stopping"];

export function applyEvent(state, ev) {
  if (!ev || typeof ev !== "object") return state;
  const type = ev.type;
  if (ev.sub && type !== "subagent") {
    const holder = ensureSubagent(state, ev.sub).sub;
    const inner = { ...ev };
    delete inner.sub;
    applyEvent(holder, inner);
    if (type === "permission") state.waiting = (state.waiting || 0) + 1;
    if (type === "permission_resolved") {
      state.waiting = Math.max(0, (state.waiting || 0) - 1);
      if (ev.decision === "auto") state.autoApprove = ["all"];
    }
    return state;
  }
  if (type === "subagent") {
    const sub = ensureSubagent(state, ev.id).sub;
    for (const key of SUB_FIELDS) if (ev[key] !== undefined) sub[key] = ev[key];
    if (sub.status !== "running") {
      delete sub.stopping;
      for (const message of sub.messages || []) {
        if (message.role !== "tool") continue;
        if (message.tool.waiting) delete message.tool.waiting;
        if (["in_progress", "pending", "waiting"].includes(message.tool.status)) message.tool.status = sub.status === "completed" ? "completed" : "cancelled";
      }
    }
  } else if (type === "plan_ready") {
    state.messages.push({ id: "plan:" + ev.reqId, role: "planreview", reqId: ev.reqId, plan: String(ev.plan || ""), status: "waiting" });
    state.waiting = (state.waiting || 0) + 1;
  } else if (type === "question") {
    closeOpen(state);
    // The tool call that raised it is the card now: its step goes, and later updates to it are not drawn.
    if (ev.toolCallId) {
      (state.askTools = state.askTools || new Set()).add(ev.toolCallId);
      state.messages = state.messages.filter((m) => !(m.role === "tool" && m.tool && m.tool.id === ev.toolCallId));
    }
    state.messages.push({ id: "question:" + ev.reqId, role: "question", reqId: ev.reqId, questions: ev.questions || [], from: ev.from || "", status: "waiting" });
    state.waiting = (state.waiting || 0) + 1;
  } else if (type === "question_resolved") {
    const card = state.messages.find((m) => m.role === "question" && m.reqId === ev.reqId);
    if (card && card.status === "waiting") {
      card.status = ev.outcome === "accepted" ? "answered" : "cancelled";
      card.answers = ev.answers;
      card.by = ev.by || "";
      state.waiting = Math.max(0, (state.waiting || 0) - 1);
    }
  } else if (type === "plan_resolved") {
    const card = state.messages.find((m) => m.role === "planreview" && m.reqId === ev.reqId);
    if (card && card.status === "waiting") {
      card.status = ev.decision === "approve" ? "approved" : "revise";
      state.waiting = Math.max(0, (state.waiting || 0) - 1);
    }
  } else if (type === "usage") {
    const used = (Number(ev.tokens) || 0) + (state.pendingTokens || 0);
    const step = [...(state.messages || [])].reverse().find((m) => m.role === "tool" || m.role === "thought" || m.role === "plan");
    if (step) {
      step.tokens = (step.tokens || 0) + used;
      state.pendingTokens = 0;
    } else state.pendingTokens = used;
  } else if (type === "media") {
    // A local image reference was copied into the media store: the newest assistant message that names it now points there.
    for (let i = state.messages.length - 1; i >= 0; i -= 1) {
      const message = state.messages[i];
      if (message.role !== "assistant" || !findRefs(message.text).some((token) => token.target === ev.from)) continue;
      message.text = rewriteRefs(message.text, new Map([[ev.from, ev.to]]));
      break;
    }
  } else if (type === "text") appendChunk(state, "assistant", ev.data);
  else if (type === "thought") appendChunk(state, "thought", ev.data);
  else if (type === "note") {
    state.messages = state.messages || [];
    state.messages.push({ id: "note:" + state.messages.length + ":" + Date.now(), role: "note", text: String(ev.data || "") });
  }
  else if ((type === "tool_call" || type === "tool_call_update") && state.askTools?.has(ev.toolCallId)) {
    // The question card stands for this tool call.
  } else if (type === "tool_call" || type === "tool_call_update") {
    const message = ensureTool(state, ev);
    const tool = message.tool;
    if (ev.status) tool.status = ev.status;
    if (ev.title) tool.title = ev.title;
    if (ev.toolName) tool.name = ev.toolName;
    if (ev.kind) tool.kind = ev.kind;
    if (ev.description) tool.description = ev.description;
    if (ev.rawInput) tool.input = asText(ev.rawInput, 4000);
    const output = ev.content != null && ev.content !== "" ? asText(ev.content, 6000) : ev.rawOutput ? asText(ev.rawOutput, 6000) : "";
    if (output) tool.output = output;
    if (tool.status === "failed" && tool.permission === "denied") tool.status = "denied";
    if (tool.status && tool.status !== "pending" && tool.waiting && tool.status !== "in_progress") delete tool.waiting;
    const images = mergeImages(tool.images, ev.images);
    if (images.length) tool.images = images;
  } else if (type === "permission") {
    const message = ensureTool(state, ev);
    message.tool.waiting = {
      reqId: ev.reqId,
      kind: ev.kind,
      kindLabel: ev.kindLabel,
      title: ev.title,
      detail: ev.detail,
      description: ev.description,
    };
    if (!message.tool.input && ev.detail) message.tool.input = ev.detail;
    if (ev.description && !message.tool.description) message.tool.description = ev.description;
    message.tool.status = "waiting";
    state.waiting = (state.waiting || 0) + 1;
  } else if (type === "permission_resolved") {
    const message = findTool(state, ev.toolCallId);
    if (message) {
      const tool = message.tool;
      if (tool.waiting && (!ev.reqId || tool.waiting.reqId === ev.reqId || ev.by !== "user")) delete tool.waiting;
      if (ev.decision === "deny") {
        tool.permission = "denied";
        tool.status = "denied";
        tool.deniedBy = ev.by || "user";
      } else {
        tool.permission = ev.decision === "auto" ? "auto" : "once";
        if (tool.status === "waiting") tool.status = "in_progress";
      }
    }
    if (ev.decision === "auto") {
      state.autoApprove = ["all"];
    }
    state.waiting = Math.max(0, (state.waiting || 0) - 1);
  } else if (type === "auto_approve") {
    const message = findTool(state, ev.toolCallId);
    if (message) message.tool.permission = "auto";
  } else if (type === "title") {
    state.title = ev.title;
  } else if (type === "plan") {
    closeOpen(state);
    const entries = Array.isArray(ev.entries) ? ev.entries : [];
    const lines = entries.map((entry) => {
      if (typeof entry === "string") return entry;
      const mark = entry.status === "completed" ? "[x]" : entry.status === "in_progress" ? "[>]" : "[ ]";
      return mark + " " + (entry.content || entry.title || "");
    });
    const text = lines.filter(Boolean).join("\n") || "Plan updated";
    const last = [...state.messages].reverse().find((message) => message.role === "plan");
    if (last && state.messages[state.messages.length - 1] === last) last.text = text;
    else state.messages.push({ id: nid(state, "plan"), role: "plan", text });
  } else if (type === "error") {
    closeOpen(state);
    state.messages.push({
      id: nid(state, "error"),
      role: "error",
      text: String(ev.message || ev.data || "Something went wrong"),
    });
  } else if (type === "evidence") {
    closeOpen(state);
    state.messages.push({ id: nid(state, "status"), role: "status", tone: ev.tone === "warn" ? "warn" : "ok", text: String(ev.text || "") });
  } else if (type === "max_turns_reached") {
    closeOpen(state);
    state.messages.push({ id: nid(state, "status"), role: "status", text: "Max turns reached" });
  } else if (typeof type === "string" && type.startsWith("auto_compact")) {
    const already = state.messages.some((message) => message.role === "status" && message.text === "Compacting context");
    if (!already) {
      closeOpen(state);
      state.messages.push({ id: nid(state, "status"), role: "status", text: "Compacting context" });
    }
  } else if (type === "end") {
    closeOpen(state);
    state.ended = true;
    for (const card of state.messages) {
      if (card.role === "question" && card.status === "waiting") {
        card.status = "cancelled";
        state.waiting = Math.max(0, (state.waiting || 0) - 1);
      }
    }
    state.stopReason = ev.stopReason || "";
    for (const message of state.messages) {
      if (message.role === "subagent" && message.sub.status === "running") {
        applyEvent(state, { type: "subagent", id: message.sub.id, status: ev.stopReason === "end_turn" ? "completed" : "cancelled" });
      }
      if (message.role !== "tool") continue;
      if (message.tool.waiting) delete message.tool.waiting;
      if (message.tool.status === "in_progress" || message.tool.status === "pending" || message.tool.status === "waiting") {
        message.tool.status = ev.stopReason === "end_turn" ? "completed" : "cancelled";
      }
    }
    if (ev.stopReason && ev.stopReason !== "end_turn") {
      const label = STOP_LABEL[ev.stopReason] || "Stopped (" + ev.stopReason + ")";
      state.messages.push({ id: nid(state, "status"), role: "status", text: label });
    }
  }
  return state;
}
