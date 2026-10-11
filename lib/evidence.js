// What a turn proved: file edits versus the commands that ran after the last one.
// Same rules as ~/.grok/hook-scripts/evidence-gate.py, so the app shows what the stop hook enforces.

const EDIT_TYPES = new Set(["SearchReplace", "Write", "WriteFile", "DeleteFile", "Delete", "Move", "EditFile"]);
const EDIT_NAMES = new Set(["write", "search_replace", "edit", "edit_file", "delete_file", "move_file", "multi_edit"]);
// One read-only command. Callers split on &&, ||, ; and | first, so a later command is not hidden by a read-only prefix.
const READ_ONLY = /^\s*(?:cd\s+\S+\s*&&\s*)*(cat|ls|ll|head|tail|less|grep|rg|ag|find|fd|wc|echo|printf|pwd|tree|stat|file|which|type|diff|sed\s+-n|awk\s+'\{print|git\s+(status|diff|log|show|branch|remote|rev-parse|ls-files))\b/;
const NOOP = /^(?:true|:|exit\s+0)$/;
const CD_ONLY = /^cd\s+\S+$/;
// Notes are not code: editing only these never needs a check. Same list as evidence-gate.py.
const NOTE_EXT = /\.(?:md|markdown|mdx|txt|rst|org|adoc)$/i;
const NOTE_BASE = /^(?:PLAN|PROGRESS|NOTES|TODO|CHANGELOG|README|MEMORY)(?:[-_.][^/]*)?$/i;
const NOTE_DIR = /(?:^|\/)(?:memory|memories|topics|notes)\//i;

export function isNotePath(path) {
  const p = String(path || "").replace(/\\/g, "/");
  if (!p) return false;
  const base = p.split("/").pop();
  return NOTE_EXT.test(base) || NOTE_BASE.test(base) || NOTE_DIR.test(p);
}

function commandSegments(command) {
  return String(command || "")
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function harmlessSegment(part) {
  const text = part.replace(/^(?:cd\s+\S+\s*&&\s*)+/, "").trim();
  if (!text || NOOP.test(text) || CD_ONLY.test(text)) return true;
  return READ_ONLY.test(text);
}

// A real check executes something. `true`, `:`, and `exit 0` do not. `git status && npm test` does.
export function isCheckCommand(command) {
  const parts = commandSegments(command);
  return parts.length > 0 && parts.some((part) => !harmlessSegment(part));
}

export function newProof() {
  return { names: new Map(), seq: [], files: new Set() };
}

// Feed every raw ACP update of the main session. Returns nothing; read the result with proofVerdict().
export function trackProof(proof, update) {
  const kind = update?.sessionUpdate;
  if (kind === "tool_call") {
    const name = update._meta?.["x.ai/tool"]?.name || update.title || "";
    proof.names.set(update.toolCallId, name);
    const raw = update.rawInput && typeof update.rawInput === "object" ? update.rawInput : {};
    const path = raw.file_path || raw.target_file || raw.path || "";
    if (!proof.paths) proof.paths = new Map();
    if (typeof path === "string" && path) proof.paths.set(update.toolCallId, path);
    return;
  }
  if (kind !== "tool_call_update" || !["completed", "failed"].includes(update.status)) return;
  const raw = update.rawOutput && typeof update.rawOutput === "object" ? update.rawOutput : {};
  if (EDIT_TYPES.has(raw.type) || EDIT_NAMES.has(proof.names.get(update.toolCallId) || "")) {
    const touched = [];
    for (const part of Array.isArray(update.content) ? update.content : []) if (part?.type === "diff" && typeof part.path === "string") touched.push(part.path);
    const known = proof.paths?.get(update.toolCallId);
    if (known) touched.push(known);
    // An edit counts as a note only when every path it touched is known and is a note; unknown paths count as code.
    const note = touched.length > 0 && touched.every(isNotePath);
    proof.seq.push({ edit: true, note });
    for (const path of touched) if (proof.files.size < 200) proof.files.add(path);
  }
  const result = raw.type === "Bash" ? raw : raw.type === "TaskOutput" ? raw.Result : null;
  if (result && typeof result.command === "string" && Number.isInteger(result.exit_code)) proof.seq.push({ command: result.command.trim(), code: result.exit_code });
}

// null when the turn changed no files; otherwise { tone: "ok" | "warn", text }.
const isCodeEdit = (step) => !!step.edit && !step.note;

export function proofVerdict(proof) {
  const lastEdit = proof.seq.map(isCodeEdit).lastIndexOf(true);
  if (lastEdit < 0) return null; // no edits, or only notes changed
  const checks = proof.seq.slice(lastEdit + 1).filter((step) => step.command && isCheckCommand(step.command));
  const short = (command) => {
    const first = command.split("\n")[0].trim();
    return first.length > 70 || first !== command ? first.slice(0, 67) + "..." : first;
  };
  if (!checks.length) return { tone: "warn", text: "Unverified: files changed and nothing ran after the last edit" };
  const last = checks[checks.length - 1];
  if (last.code !== 0) return { tone: "warn", text: "Last check failed: " + short(last.command) + " (exit " + last.code + ")" };
  return { tone: "ok", text: "Checked after the last edit: " + checks.length + (checks.length === 1 ? " command" : " commands") + ", last " + short(last.command) + " (exit 0)" };
}

// For the skeptical-review gate: how much the turn edited and whether a check ran after the last edit.
export function proofSummary(proof) {
  const lastEdit = proof.seq.map(isCodeEdit).lastIndexOf(true);
  const commands = proof.seq.filter((step) => step.command && isCheckCommand(step.command));
  const after = lastEdit < 0 ? [] : proof.seq.slice(lastEdit + 1).filter((step) => step.command && isCheckCommand(step.command));
  return {
    edits: proof.seq.filter(isCodeEdit).length,
    files: [...proof.files],
    commands: commands.length,
    checkedAfterEdit: after.length > 0,
    lastCheckFailed: after.length > 0 && after[after.length - 1].code !== 0,
  };
}
