#!/usr/bin/env node
// A fake `grok agent stdio` for end-to-end tests. Speaks just enough ACP for lib/runner.js.
// Each prompt's behaviour comes from [[directives]] in the prompt text, or else from the next
// entry of fake-turns.json in the working folder (used for long-run CONTINUE prompts).
//
// Directives: [[say TEXT]]  [[sleep MS]]  [[exec CODE CMD]]  [[run CMD]] (really runs CMD, records its exit)
//             [[wake MS TEXT]] (Grok wakes itself MS after the turn)  [[perm]] (asks for approval)
//             [[ask JSON]] (ask_user_question: {questions:[{question,options:[{label,description}],multiSelect}]})
//             [[mv FROM TO]]  [[rm FILE]] (files in the working folder)
//             [[quiettool MS]] (a tool call that stays silent for MS)  [[write PATH TEXT]]  [[commit MSG]]
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";


// Skeptical reviewer mode: `grok --agent ... -p <packet> --output-format json`. The verdict comes from a
// SKFAKE:<kind> marker in the packet (the agent's own final message carries it in the tests).
if (process.argv[2] !== "agent") {
  const argv = process.argv.slice(2);
  const packet = argv[argv.indexOf("-p") + 1] || "";
  fs.appendFileSync(path.join(process.env.GROK_HOME, "skeptic.log"), JSON.stringify({ argv: argv.filter((a) => a !== packet), packet }) + "\n");
  // Real Grok saves a headless `-p` run as a session of its own, in the folder it ran in.
  if (!process.env.FAKE_NO_HEADLESS_SESSION) {
    const id = crypto.randomUUID();
    const dir = path.join(process.env.GROK_HOME, "sessions", encodeURIComponent(process.cwd()), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ info: { id, cwd: process.cwd() }, session_kind: "headless", agent_name: "skeptic", generated_title: "Verify the claims", created_at: new Date().toISOString(), num_messages: 12 }));
  }
  const kind = (packet.match(/SKFAKE:(\w+)/) || [])[1] || "pass";
  const out = (text, extra = {}) => process.stdout.write(JSON.stringify({ text, stopReason: "end_turn", usage: { total_tokens: 1234 }, total_cost_usd: 0.0123, ...extra }), () => process.exit(0));
  const issue = { severity: "high", title: "Empty input crashes", where: "app.js:3", claim: "handles empty", evidence: "node app.js '' exited 1 with TypeError" };
  if (kind === "slow") setTimeout(() => out(JSON.stringify({ verdict: "pass", summary: "late", issues: [], unverified: [], ran: [] })), 60000);
  else {
    if (kind === "taint") fs.appendFileSync(path.join(process.cwd(), "app.js"), "// reviewer touched this\n");
    if (kind === "junk") out("I looked at it and it seems fine.");
    else if (kind === "wait") setTimeout(() => out(JSON.stringify({ verdict: "pass", summary: "Claims hold", issues: [], unverified: [], ran: [{ command: "npm test", exit: 0 }] })), 1500);
    else if (kind === "issues" || kind === "taint2") out("Reviewing.\n" + JSON.stringify({ verdict: "issues", summary: "Empty input crashes", issues: [issue], unverified: ["handles unicode"], ran: [{ command: "npm test", exit: 0 }] }));
    else if (kind === "noevidence") out(JSON.stringify({ verdict: "issues", summary: "vague", issues: [{ severity: "high", title: "Might be slow", evidence: "" }], unverified: [], ran: [] }));
    else if (kind === "fixed") out(JSON.stringify({ verdict: "pass", summary: "Rechecked: fine", issues: [], unverified: [], ran: [{ command: "npm test", exit: 0 }] }));
    else out(JSON.stringify({ verdict: "pass", summary: "Claims hold", issues: [], unverified: [], ran: [{ command: "npm test", exit: 0 }] }));
  }
  await new Promise(() => {});
}

const home = process.env.GROK_HOME;
fs.appendFileSync(path.join(home, "spawns.log"), process.pid + "\n");
const sessions = new Map(); // id -> { cwd, dir }
let nextId = 1000;
const waiting = new Map();
let current = null; // { id, sessionId, cancelled }

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const notify = (method, sessionId, update) => {
  send({ jsonrpc: "2.0", method, params: { sessionId, update } });
  const s = sessions.get(sessionId);
  if (s) fs.appendFileSync(path.join(s.dir, "updates.jsonl"), JSON.stringify({ method, params: { sessionId, update } }) + "\n");
};
const request = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (sid, text) => notify("session/update", sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const turnDone = (sid) => {
  notify("_x.ai/session_notification", sid, { sessionUpdate: "response_completed", usage: { input_tokens: 100, output_tokens: 10 } });
  notify("_x.ai/session_notification", sid, { sessionUpdate: "turn_completed", stop_reason: "end_turn" });
};

// Like real Grok: each --plugin-dir's skills become slash commands (available_commands_update), and only
// those without disable-model-invocation would reach the model's skill list (logged to plugins.log).
const pluginDirs = process.argv.flatMap((a, i) => (a === "--plugin-dir" ? [process.argv[i + 1]] : []));
const pluginSkills = pluginDirs.flatMap((dir) => {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, "skills"));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = path.join(dir, "skills", name, "SKILL.md");
    try {
      const head = fs.readFileSync(file, "utf8").split("\n---")[0];
      const description = ((head.match(/^description:\s*(.*)$/m) || [])[1] || "").replace(/^["']|["']$/g, "");
      return [{ name, description, file, model: !/^disable-model-invocation:\s*true/m.test(head) }];
    } catch {
      return [];
    }
  });
});
fs.appendFileSync(path.join(home, "plugins.log"), JSON.stringify({ pid: process.pid, dirs: pluginDirs, modelSkills: pluginSkills.filter((s) => s.model).map((s) => s.name) }) + "\n");
const advertise = (sid) =>
  notify("session/update", sid, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      { name: "always-approve", description: "Toggle always-approve mode", input: { hint: "on|off" } },
      { name: "notes", description: "Keep running notes", input: null, _meta: { scope: "user", path: path.join(home, "skills", "notes", "SKILL.md"), bareName: "notes" } },
      ...pluginSkills.map((s) => ({ name: s.name, description: s.description, input: null, _meta: { scope: "local", path: s.file, bareName: s.name } })),
    ],
  });

function ensureSession(id, cwd) {
  const dir = path.join(home, "sessions", encodeURIComponent(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, "summary.json"))) fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ info: { cwd }, created_at: new Date().toISOString() }));
  sessions.set(id, { cwd, dir });
}

function steps(text, cwd) {
  const found = [...text.matchAll(/\[\[(\w+)\s*([\s\S]*?)\]\]/g)].map((m) => [m[1], m[2]]);
  if (found.length) return found;
  // The position lives outside the project, so reading the script never looks like progress.
  const pos = path.join(home, "turnpos-" + crypto.createHash("sha1").update(cwd).digest("hex"));
  try {
    const list = JSON.parse(fs.readFileSync(path.join(cwd, "fake-turns.json"), "utf8"));
    const index = fs.existsSync(pos) ? Number(fs.readFileSync(pos, "utf8")) : 0;
    fs.writeFileSync(pos, String(index + 1));
    const step = list[index];
    if (step) return [...String(step).matchAll(/\[\[(\w+)\s*([\s\S]*?)\]\]/g)].map((m) => [m[1], m[2]]);
  } catch {
    // no script
  }
  return [["say", "ok"]];
}

async function prompt(sid, text, turn) {
  const { cwd } = sessions.get(sid);
  fs.appendFileSync(path.join(home, "prompts.log"), sid + " " + JSON.stringify(text.slice(0, 300)) + "\n");
  fs.appendFileSync(path.join(home, "prompts-full.jsonl"), JSON.stringify({ sid, text }) + "\n"); // the whole prompt, for tests
  notify("session/update", sid, { sessionUpdate: "user_message_chunk", content: { type: "text", text } });
  let wake = null;
  for (const [kind, arg] of steps(text, cwd)) {
    if (turn.cancelled) break;
    if (kind === "say") {
      say(sid, arg.replace(/\\n/g, "\n"));
      notify("_x.ai/session_notification", sid, { sessionUpdate: "response_completed", usage: { input_tokens: 50, output_tokens: 5 } });
    }
    else if (kind === "sleep") await sleep(Number(arg));
    else if (kind === "mv") {
      const [from, to] = arg.split(" ");
      fs.renameSync(path.join(cwd, from), path.join(cwd, to)); // the agent tidies up: the file a message named is gone
    } else if (kind === "rm") fs.rmSync(path.join(cwd, arg.trim()), { force: true });
    else if (kind === "die") process.exit(Number(arg) || 1); // a crash mid-turn
    else if (kind === "hang") await new Promise(() => {}); // silent forever: no updates, no reply
    else if (kind === "compact") {
      // Compaction: activity the app doesn't render, spread over arg ms.
      for (let t = 0; t < Number(arg); t += 500) {
        notify("_x.ai/session_notification", sid, { sessionUpdate: "auto_compact_progress" });
        await sleep(500);
      }
    }
    else if (kind === "exec") {
      const [code, ...cmd] = arg.split(" ");
      notify("session/update", sid, { sessionUpdate: "tool_call", toolCallId: "t" + nextId, title: "run", kind: "execute", status: "in_progress", rawInput: { command: cmd.join(" ") } });
      notify("session/update", sid, { sessionUpdate: "tool_call_update", toolCallId: "t" + nextId++, status: "completed", rawOutput: { type: "Bash", command: cmd.join(" "), exit_code: Number(code) } });
    } else if (kind === "run") {
      let code = 0;
      try {
        execSync(arg, { cwd, stdio: "ignore" });
      } catch (error) {
        code = error.status ?? 1;
      }
      notify("session/update", sid, { sessionUpdate: "tool_call_update", toolCallId: "t" + nextId++, status: "completed", rawOutput: { type: "Bash", command: arg, exit_code: code } });
    } else if (kind === "edit") {
      const id = "e" + nextId++;
      notify("session/update", sid, { sessionUpdate: "tool_call", toolCallId: id, title: "search_replace", _meta: { "x.ai/tool": { name: "search_replace" } }, rawInput: { file_path: path.join(cwd, arg) } });
      fs.appendFileSync(path.join(cwd, arg), "edited\n");
      notify("session/update", sid, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "diff", path: path.join(cwd, arg) }], rawOutput: { type: "SearchReplace", EditsApplied: {} } });
    } else if (kind === "write") {
      const [file, ...rest] = arg.split(" ");
      const full = path.join(cwd, file);
      fs.writeFileSync(full, rest.join(" ") + "\n");
      const id = "w" + nextId++;
      notify("session/update", sid, { sessionUpdate: "tool_call", toolCallId: id, title: "write", _meta: { "x.ai/tool": { name: "write" } }, rawInput: { file_path: full } });
      notify("session/update", sid, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "diff", path: full }], rawOutput: { type: "Write" } });
    } else if (kind === "commit") execSync("git add -A && git commit -qm " + JSON.stringify(arg || "checkpoint"), { cwd });
    else if (kind === "wake") {
      const [ms, ...rest] = arg.split(" ");
      wake = { ms: Number(ms), text: rest.join(" ") };
    } else if (kind === "quiettool") {
      const id = "q" + nextId++;
      notify("session/update", sid, { sessionUpdate: "tool_call", toolCallId: id, title: "long build", kind: "execute", status: "in_progress", rawInput: { command: "make" } });
      for (let t = 0; t < Number(arg) && !turn.cancelled; t += 200) await sleep(200);
      notify("session/update", sid, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
    } else if (kind === "ask") {
      // ask_user_question as Grok 1.0.50 sends it (captured 13 Oct 2026): the agent then says what it was answered.
      const spec = JSON.parse(arg);
      const callId = "call-q" + nextId++;
      const meta = { "x.ai/tool": { version: 1, name: "ask_user_question", kind: "ask_user", namespace: "grok_build", label: "Ask User", read_only: true } };
      notify("session/update", spec.child || sid, { sessionUpdate: "tool_call", toolCallId: callId, title: "ask_user_question", rawInput: { questions: spec.questions }, _meta: meta });
      const result = await request("_x.ai/ask_user_question", { sessionId: spec.child || sid, toolCallId: callId, questions: spec.questions, mode: "default" });
      const text = result?.outcome === "accepted" ? "User has answered your questions: " + JSON.stringify(result.answers) : "User declined to answer the questions.";
      notify("session/update", spec.child || sid, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text } }] });
      say(sid, "answer:" + JSON.stringify(result));
    } else if (kind === "perm") {
      const result = await request("session/request_permission", {
        sessionId: sid,
        toolCall: { toolCallId: "p" + nextId, title: "rm -rf build", kind: "execute", rawInput: { command: "rm -rf build" } },
        options: [
          { optionId: "allow", kind: "allow_once", name: "Allow" },
          { optionId: "deny", kind: "reject_once", name: "Deny" },
        ],
      });
      say(sid, "permission:" + (result?.outcome?.optionId || result?.outcome?.outcome));
    }
  }
  turnDone(sid);
  if (wake) {
    setTimeout(() => {
      say(sid, wake.text);
      turnDone(sid);
    }, wake.ms);
  }
  return turn.cancelled ? "cancelled" : "end_turn";
}

readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const msg = JSON.parse(line);
  if (msg.id != null && !msg.method) {
    waiting.get(msg.id)?.(msg.result);
    waiting.delete(msg.id);
    return;
  }
  const p = msg.params || {};
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      if (fs.existsSync(path.join(home, "hang-initialize"))) return; // never answer
      return reply({ protocolVersion: 1 });
    case "_x.ai/billing":
      return reply({
        config: {
          creditUsagePercent: 42,
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-10-06", end: "2026-10-13" },
        },
        subscription_tier: "Test",
      });
    case "session/new": {
      const id = crypto.randomUUID();
      ensureSession(id, p.cwd);
      reply({ sessionId: id });
      return advertise(id);
    }
    case "session/load":
      ensureSession(p.sessionId, p.cwd);
      reply({});
      return advertise(p.sessionId);
    case "session/set_mode":
    case "session/set_config_option":
      return reply({});
    case "session/prompt": {
      const text = (p.prompt || []).map((b) => b.text || "").join("\n");
      const turn = { sessionId: p.sessionId, cancelled: false };
      current = turn;
      const stopReason = await prompt(p.sessionId, text, turn);
      return reply({ stopReason });
    }
    case "session/cancel":
      if (current) current.cancelled = true;
      return;
    default:
      if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  }
});
