import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parseUpdates } from "../lib/history.js";
import { cleanImages } from "../lib/images.js";
import { hostAllowedName, isAllowedIp, isPrivateLan, lanHostAllowed } from "../lib/net.js";
import { contrastText, cssColor, parseColors, prettifySlug, slugifyName, themeCss } from "../lib/theme.js";
import { applyEvent, extractImages, plainText } from "../public/reduce.js";
import { copyText } from "../public/clipboard.js";
import { composerAction, hasComposerContent } from "../public/composer.js";
import { hasDone, intervalLabel, parseInterval, parseLoopCommand, runLabel, validateLoop } from "../lib/loops.js";

// Hook scripts live outside this repo (default ~/.grok/hook-scripts); set GROK_HOOKS_DIR to point elsewhere.
const HOOK_DIR = process.env.GROK_HOOKS_DIR || path.join(homedir(), ".grok", "hook-scripts");
const hookTest = existsSync(path.join(HOOK_DIR, "evidence-gate.py")) ? test : test.skip;

test("allows only loopback and Tailscale", () => {
  for (const ip of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.100.10.20", "100.127.255.255"]) {
    assert.equal(isAllowedIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "10.1.2.3", "192.168.1.50", "172.16.0.1", "172.31.255.255", "1.1.1.1", "100.63.1.1", "100.128.0.1", "0.0.0.0", "", "not-an-ip"]) {
    assert.equal(isAllowedIp(ip), false, ip);
  }
});

test("LAN (RFC1918) clients are accepted only on the TLS listener", () => {
  for (const ip of ["10.1.2.3", "192.168.1.50", "::ffff:192.168.1.5", "172.16.0.1", "172.31.255.255"]) {
    assert.equal(isPrivateLan(ip), true, ip);
    assert.equal(isAllowedIp(ip), false, "plain " + ip);
    assert.equal(isAllowedIp(ip, { tls: true }), true, "tls " + ip);
  }
  for (const ip of ["172.32.0.1", "192.169.0.1", "8.8.8.8", "11.0.0.1", "", "1.2.3"]) {
    assert.equal(isPrivateLan(ip), false, ip);
    assert.equal(isAllowedIp(ip, { tls: true }), false, "tls " + ip);
  }
});

test("LAN host guard: LAN IP, hostname and .local on the TLS port only", () => {
  const names = ["192.168.1.50", "myhost", "myhost.local"];
  for (const h of ["192.168.1.50:8788", "myhost:8788", "MYHOST.local:8788", "myhost.local"]) assert.equal(lanHostAllowed(h, { names, port: 8788 }), true, h);
  for (const h of ["192.168.1.50:8787", "evil.example:8788", "myhost.evil:8788", "", "localhost:8788", "192.168.1.5:8788"]) assert.equal(lanHostAllowed(h, { names, port: 8788 }), false, h);
});

test("an unknown tailnet name does not allow every ts.net host", () => {
  assert.equal(hostAllowedName("evil.example.ts.net", { known: ["localhost"], tailnetName: "" }), false);
  assert.equal(hostAllowedName("myhost.tail.ts.net:443", { known: [], tailnetName: "myhost.tail.ts.net" }), true);
  assert.equal(hostAllowedName("evil.example.ts.net", { known: [], tailnetName: "myhost.tail.ts.net" }), false);
  assert.equal(hostAllowedName("localhost", { known: ["localhost"], tailnetName: "" }), true);
});

test("parses omarchy colors and names", () => {
  const colors = parseColors(`
# comment
mode = "dark"
accent = "#F3B77B"
background = '#151E26'
foreground = "#ECE5D8"
`);
  assert.equal(colors.mode, "dark");
  assert.equal(colors.accent, "#F3B77B");
  assert.equal(colors.background, "#151E26");
  assert.equal(prettifySlug("theme-liftoff"), "Theme Liftoff");
  assert.equal(slugifyName("Theme Liftoff"), "theme-liftoff");
  assert.equal(contrastText("#F3B77B"), "#16130f");
  assert.equal(contrastText("#1e66f5"), "#fffaf4");
  assert.equal(cssColor("#abc</style><form>", "#151E26"), "#151E26");
  assert.equal(cssColor("#abc", ""), "#abc");
  const css = themeCss({ vars: { "--bg": "#abc</style><form action=http://evil>", "--fg": "#ECE5D8", "color": "red" } });
  assert.equal(css.includes("</style>"), false);
  assert.match(css, /--fg:#ECE5D8/);
});

test("reduces streaming events without duplicating snapshots", () => {
  const state = { messages: [], n: 0 };
  applyEvent(state, { type: "thought", data: "Hmm" });
  applyEvent(state, { type: "thought", data: "Hmm." });
  applyEvent(state, { type: "text", data: "pon" });
  applyEvent(state, { type: "text", data: "g" });
  applyEvent(state, { type: "tool_call", toolCallId: "c1", toolName: "read_file", title: "Read", rawInput: { target_file: "SPEC.md" } });
  applyEvent(state, { type: "tool_call_update", toolCallId: "c1", status: "completed", rawOutput: { ok: true } });
  applyEvent(state, { type: "text", data: "Done" });
  applyEvent(state, { type: "end", stopReason: "end_turn" });
  assert.equal(state.messages.find((message) => message.role === "thought").text, "Hmm.");
  assert.equal(state.messages.filter((message) => message.role === "assistant").map((message) => message.text).join("|"), "pong|Done");
  const tool = state.messages.find((message) => message.role === "tool");
  assert.equal(tool.tool.status, "completed");
  assert.match(tool.tool.input, /SPEC.md/);
  assert.equal(state.ended, true);
});

test("parses saved session updates", () => {
  const messages = parseUpdates(
    [
      JSON.stringify({ params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Hi" } } } }),
      JSON.stringify({ params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Think" } } } }),
      JSON.stringify({ params: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } } } }),
      JSON.stringify({
        params: {
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "t1",
            title: "Read file",
            rawInput: { target_file: "a.txt" },
            _meta: { "x.ai/tool": { name: "read_file" } },
          },
        },
      }),
      JSON.stringify({
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "t1",
            status: "completed",
            content: [{ type: "text", text: "contents" }],
          },
        },
      }),
    ].join("\n")
  );
  assert.deepEqual(
    messages.map((message) => message.role),
    ["user", "thought", "assistant", "tool"]
  );
  assert.equal(messages[0].text, "Hi");
  assert.equal(messages[3].tool.name, "read_file");
  assert.equal(messages[3].tool.output, "contents");
  assert.equal(messages[3].tool.status, "completed");
});

test("keeps image blocks out of text and on the message", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const messages = parseUpdates(
    [
      JSON.stringify({ params: { update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Look" } } } }),
      JSON.stringify({ params: { update: { sessionUpdate: "image_dropped", notes: ["Image 1 was left out."] } } }),
      JSON.stringify({ params: { update: { sessionUpdate: "user_message_chunk", content: { type: "image", mimeType: "image/png", data: png } } } }),
      JSON.stringify({
        params: {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "shot",
            status: "completed",
            title: "Screenshot",
            content: [{ type: "content", content: { type: "image", mimeType: "image/png", data: png } }],
            rawOutput: { type: "ReadFile", ImageContent: { data: png, mime_type: "image/png" } },
          },
        },
      }),
    ].join("\n")
  );
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].text, "Look");
  assert.equal(messages[0].images[0].mime, "image/png");
  assert.equal(messages[1].text, "Image 1 was left out.");
  const tool = messages.find((message) => message.role === "tool");
  assert.equal(tool.tool.images.length, 1);
  assert.equal(tool.tool.images[0].data, png);
  assert.equal(String(tool.tool.output || "").includes(png), false);
  const found = extractImages({ ImageContent: { data: png, mime_type: "image/png" } });
  assert.equal(found[0].mime, "image/png");
  assert.equal(plainText({ type: "image", mimeType: "image/png", data: png }), "");
  const state = { messages: [], n: 0 };
  applyEvent(state, { type: "tool_call_update", toolCallId: "c2", status: "completed", images: found, content: "" });
  assert.equal(state.messages[0].tool.images[0].data, png);
  assert.equal(cleanImages([{ mime: "image/png", data: png }])[0].mime, "image/png");
  assert.throws(() => cleanImages([{ mime: "image/svg+xml", data: png }]), /JPEG/);
});

test("stores a scrypt hash and a session cookie secret", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "grok-mobile-auth-"));
  process.env.DATA_DIR = dir;
  try {
    const auth = await import("../lib/auth.js");
    assert.equal((await auth.getAuthStatus()).needsSetup, true);
    await auth.setPassword("correct horse battery");
    await assert.rejects(auth.setPassword("another password here"), /already set/);
    assert.equal(await auth.verifyPassword("wrong password"), false);
    assert.equal(await auth.verifyPassword("correct horse battery"), true);
    const session = await auth.createSession();
    assert.equal(typeof session.token, "string");
    assert.equal((await auth.sessionFromToken(session.token))?.ok, true);
    await auth.destroySession(session.token);
    assert.equal(await auth.sessionFromToken(session.token), null);
    const raw = await import("node:fs/promises").then((fs) => fs.readFile(path.join(dir, "auth.json"), "utf8"));
    assert.equal(raw.includes("correct horse battery"), false);
    assert.match(raw, /scrypt|hash/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("maps ACP updates and approvals", async () => {
  const { fromAcp, permissionKind } = await import("../lib/runner.js");
  const call = fromAcp({
    sessionUpdate: "tool_call",
    toolCallId: "t9",
    title: "run_terminal_command",
    rawInput: { command: "uptime", description: "Check load" },
    _meta: { "x.ai/tool": { name: "run_terminal_command", kind: "execute" } },
  });
  assert.equal(call.toolName, "run_terminal_command");
  assert.equal(call.rawInput, "uptime");
  assert.equal(fromAcp({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }).data, "hi");
  assert.equal(permissionKind({ toolCall: { kind: "execute" } }), "execute");
  assert.equal(permissionKind({ toolCall: { kind: "edit" } }), "edit");
  const state = { messages: [], n: 0 };
  applyEvent(state, call);
  applyEvent(state, { type: "permission", reqId: "r1", toolCallId: "t9", kind: "execute", detail: "uptime" });
  assert.equal(state.messages[0].tool.status, "waiting");
  assert.equal(state.messages[0].tool.waiting.reqId, "r1");
  applyEvent(state, { type: "permission_resolved", reqId: "r1", toolCallId: "t9", decision: "deny", by: "user" });
  applyEvent(state, { type: "tool_call_update", toolCallId: "t9", status: "failed", content: "User rejected the execution" });
  assert.equal(state.messages[0].tool.status, "denied");
  assert.equal(state.messages[0].tool.waiting, undefined);
  applyEvent(state, { type: "end", stopReason: "denied" });
  assert.match(state.messages.at(-1).text, /Denied/);
});

test("tracks subagents, nested steps and their approvals", async () => {
  const { subagentEvent } = await import("../lib/runner.js");
  const { applyEvent } = await import("../public/reduce.js");
  const { parseUpdates } = await import("../lib/history.js");
  const spawned = subagentEvent({ sessionUpdate: "subagent_spawned", subagent_id: "s1", child_session_id: "s1", description: "plan it", subagent_type: "grok-mobile-ultra:planner" });
  assert.equal(spawned.name, "plan it");
  const state = { messages: [] };
  applyEvent(state, spawned);
  applyEvent(state, { type: "tool_call", toolCallId: "c1", title: "ls", sub: "s1" });
  applyEvent(state, { type: "permission", reqId: "r1", toolCallId: "c1", kind: "execute", sub: "s1" });
  assert.equal(state.waiting, 1);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].sub.messages[0].tool.status, "waiting");
  applyEvent(state, { type: "permission_resolved", reqId: "r1", toolCallId: "c1", decision: "auto", kind: "execute", sub: "s1" });
  assert.equal(state.waiting, 0);
  assert.deepEqual(state.autoApprove, ["all"]);
  const done = subagentEvent({ sessionUpdate: "subagent_finished", subagent_id: "s1", status: "completed", tokens_used: 1200, output: "Plan ready." });
  applyEvent(state, done);
  assert.equal(state.messages[0].sub.status, "completed");
  assert.equal(state.messages[0].sub.tokens, 1200);
  assert.equal(state.messages[0].sub.messages[0].tool.status, "completed");
  const hist = parseUpdates([
    JSON.stringify({ params: { update: { sessionUpdate: "subagent_spawned", subagent_id: "s2", description: "review" } } }),
    JSON.stringify({ params: { update: { sessionUpdate: "subagent_finished", subagent_id: "s2", status: "completed", tokens_used: 5, output: "Ship it." } } }),
  ].join("\n"));
  assert.equal(hist[0].role, "subagent");
  assert.equal(hist[0].sub.summary, "Ship it.");
});

import { buildPacket, claimsDone, extractVerdict, issuesPrompt, normalizeVerdict, riskSignals, shouldReview } from "../lib/skeptic.js";
import { isCheckCommand, newProof, proofSummary, proofVerdict, trackProof } from "../lib/evidence.js";
import { longrunKeyword, ranClean } from "../lib/longrun.js";
import { reviewerArgs } from "../lib/skeptic.js";
import { canOpenWake, noteSubagentTokens, watchPayload } from "../lib/runner.js";
import { clearCookie } from "../lib/auth.js";
import { resolveInside } from "../lib/sessions.js";
import { spawnSync } from "node:child_process";
import { mkdir, symlink, writeFile } from "node:fs/promises";

test("skeptic gate: only risky or larger turns with a completion claim", () => {
  const edited = { edits: 1, files: [] };
  const base = { mode: "auto", stopReason: "end_turn", summary: edited, finalText: "Fixed the bug and all tests pass.", info: { files: ["a.js"], lines: 10, evidenceTone: "ok" } };
  assert.equal(shouldReview(base).run, false);
  assert.equal(shouldReview({ ...base, mode: "off" }).run, false);
  assert.equal(shouldReview({ ...base, mode: "off", manual: true }).run, true);
  assert.equal(shouldReview({ ...base, info: { ...base.info, files: ["a", "b", "c", "d"] } }).run, true);
  assert.equal(shouldReview({ ...base, info: { ...base.info, lines: 200 } }).run, true);
  assert.equal(shouldReview({ ...base, info: { ...base.info, evidenceTone: "warn" } }).run, true);
  assert.equal(shouldReview({ ...base, info: { ...base.info, files: ["lib/auth.js"] } }).run, true);
  assert.equal(shouldReview({ ...base, info: { ...base.info, files: ["README.md"], lines: 5 } }).run, false);
  assert.equal(shouldReview({ ...base, info: { ...base.info, files: ["README.md"], evidenceTone: "warn" } }).run, false);
  assert.equal(shouldReview({ ...base, info: { ...base.info, files: ["README.md"], lines: 300 } }).run, true);
  assert.equal(shouldReview({ ...base, stopReason: "cancelled", info: { ...base.info, lines: 200 } }).run, false);
  assert.equal(shouldReview({ ...base, summary: { edits: 0 }, info: { ...base.info, lines: 200 } }).run, false);
  assert.equal(shouldReview({ ...base, finalText: "Which option do you want?", info: { ...base.info, lines: 200 } }).run, false);
  assert.equal(shouldReview({ ...base, mode: "always", info: { files: ["a.js"], lines: 1 } }).run, true);
  assert.deepEqual(riskSignals({ files: ["x.js"], lines: 1 }), []);
  assert.ok(claimsDone("All done, tests pass") && !claimsDone("") && !claimsDone("I looked around."));
});

test("skeptic verdict parsing demotes issues without evidence", () => {
  const text = 'Thinking {not json} then {"verdict":"issues","summary":"s","issues":[{"severity":"high","title":"A","evidence":"ran x, exit 1 with a stack trace"},{"severity":"high","title":"B","evidence":""},{"severity":"low","title":"C","where":"f:1","evidence":"file f line 1 shows the bug"}],"unverified":["u"],"ran":[{"command":"x","exit":1}]}';
  const clean = normalizeVerdict(extractVerdict(text));
  assert.equal(clean.verdict, "issues");
  assert.deepEqual(clean.issues.map((i) => i.title), ["A", "C"]);
  assert.ok(clean.unverified.some((u) => u.startsWith("B")));
  assert.equal(normalizeVerdict(extractVerdict('{"verdict":"issues","issues":[{"title":"x","evidence":""}]}')).verdict, "pass");
  assert.equal(extractVerdict("no json here"), null);
  assert.ok(issuesPrompt(clean).includes("[high] A"));
  assert.ok(buildPacket({ cwd: "/p", asked: "do x", finalText: "done", files: ["a"], execs: [{ command: "npm test", code: 0 }], evidenceText: "ok", state: { git: true, lines: 3 } }).includes("exit 0: npm test"));
});

test("proof summary tracks edited files and checks after the last edit", () => {
  const proof = newProof();
  trackProof(proof, { sessionUpdate: "tool_call", toolCallId: "1", title: "search_replace", _meta: { "x.ai/tool": { name: "search_replace" } } });
  trackProof(proof, { sessionUpdate: "tool_call_update", toolCallId: "1", status: "completed", content: [{ type: "diff", path: "/p/a.js" }], rawOutput: { type: "SearchReplace" } });
  assert.deepEqual(proofSummary(proof), { edits: 1, files: ["/p/a.js"], commands: 0, checkedAfterEdit: false, lastCheckFailed: false });
  trackProof(proof, { sessionUpdate: "tool_call_update", toolCallId: "2", status: "completed", rawOutput: { type: "Bash", command: "npm test", exit_code: 1 } });
  const s = proofSummary(proof);
  assert.equal(s.checkedAfterEdit, true);
  assert.equal(s.lastCheckFailed, true);
  trackProof(proof, { sessionUpdate: "tool_call_update", toolCallId: "3", status: "completed", rawOutput: { type: "Bash", command: "true", exit_code: 0 } });
  assert.equal(proofVerdict(proof).tone, "warn");
  trackProof(proof, { sessionUpdate: "tool_call_update", toolCallId: "4", status: "completed", rawOutput: { type: "Bash", command: "git status && npm test", exit_code: 0 } });
  assert.equal(proofVerdict(proof).tone, "ok");
});

test("a no-op is not a check and a read-only prefix does not hide one", () => {
  assert.equal(isCheckCommand("true"), false);
  assert.equal(isCheckCommand(":"), false);
  assert.equal(isCheckCommand("exit 0"), false);
  assert.equal(isCheckCommand("git status"), false);
  assert.equal(isCheckCommand("cd /tmp && true"), false);
  assert.equal(isCheckCommand("git status && npm test"), true);
  assert.equal(isCheckCommand("npm test && git status"), true);
  assert.equal(isCheckCommand("npm test"), true);
});

test("ask-mode DONE ignores a passing check that is followed by an edit", () => {
  const turn = { proof: { seq: [
    { edit: true },
    { command: "test -f ok.txt", code: 0 },
    { command: "grep -q yes ok.txt", code: 0 },
    { edit: true },
  ] } };
  assert.equal(ranClean(turn, "test -f ok.txt"), false);
  assert.equal(ranClean({ proof: { seq: [{ edit: true }, { command: "test -f ok.txt", code: 0 }] } }, "test -f ok.txt"), true);
  assert.equal(ranClean({ proof: { seq: [{ command: "cd . && grep -q yes ok.txt", code: 0 }] } }, "grep -q yes ok.txt"), true);
  assert.equal(longrunKeyword("body\nLONGRUN: DONE\ntrailing prose"), "");
  assert.equal(longrunKeyword("LONGRUN: CONTINUE (not DONE yet)"), "CONTINUE");
  assert.equal(longrunKeyword("summary\nLONGRUN: DONE\n"), "DONE");
});

test("the reviewer is dontAsk with a bash allowlist and the watch frame keeps the verdict", () => {
  const args = reviewerArgs({ model: "grok-4.7", effort: "high", packet: "review this" });
  assert.equal(args.includes("bypassPermissions"), false);
  assert.ok(args.includes("dontAsk"));
  assert.ok(args.includes("--json-schema"));
  assert.ok(args.includes("Bash(git status)"));
  assert.ok(args.includes("Bash(git commit)"));
  assert.equal(args.at(-2), "-p");
  const frame = watchPayload({ id: "s", what: "skeptic", review: { state: "issues", issues: [{ title: "x" }] } });
  assert.equal(frame.what, "skeptic");
  assert.equal(frame.review.state, "issues");
  assert.deepEqual(JSON.parse(JSON.stringify(frame)).review.issues, [{ title: "x" }]);
});

test("logout can mark the cookie Secure, and a public symlink cannot leave its directory", async () => {
  assert.match(clearCookie(true), /Secure/);
  assert.equal(clearCookie(false).includes("Secure"), false);
  const root = await mkdtemp(path.join(tmpdir(), "gm-inside-"));
  const outside = await mkdtemp(path.join(tmpdir(), "gm-out-"));
  await writeFile(path.join(outside, "secret.txt"), "OUTSIDE");
  await writeFile(path.join(root, "ok.txt"), "in");
  await symlink(path.join(outside, "secret.txt"), path.join(root, "leak.txt"));
  assert.equal(await resolveInside(root, path.join(root, "ok.txt")), path.join(root, "ok.txt"));
  await assert.rejects(() => resolveInside(root, path.join(root, "leak.txt")), /outside/);
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test("subagent tokens and a wake during start are counted and blocked", () => {
  const turn = { id: "s", subTokensUsed: 0, done: true, cancelled: false, acpSessionId: "s" };
  noteSubagentTokens(turn, {}, { status: "completed", tokens: 40 });
  assert.equal(turn.subTokensUsed, 40);
  noteSubagentTokens(turn, { liveTokens: 40 }, { status: "completed", tokens: 40 });
  assert.equal(turn.subTokensUsed, 40);
  const starting = new Set(["s"]);
  assert.equal(canOpenWake(turn, "s", "agent_message_chunk", starting), false);
  assert.equal(canOpenWake(turn, "s", "agent_message_chunk", new Set()), true);
});

hookTest("evidence hook blocks a no-op and allows a real check after the edit", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gm-hook-"));
  const sid = "sid-evidence-1";
  const dir = path.join(home, "sessions", "proj", sid);
  await mkdir(dir, { recursive: true });
  const row = (update) => JSON.stringify({ params: { update } }) + "\n";
  const base = [
    row({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "fix it" } }),
    row({ sessionUpdate: "tool_call", toolCallId: "w1", _meta: { "x.ai/tool": { name: "write" } }, rawInput: { file_path: "a.js" } }),
    row({ sessionUpdate: "tool_call_update", toolCallId: "w1", status: "completed", rawOutput: { type: "Write" } }),
  ];
  const run = async (command) => {
    await writeFile(path.join(dir, "updates.jsonl"), base.concat(row({ sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed", rawOutput: { type: "Bash", command, exit_code: 0 } })).join(""));
    return spawnSync("python3", [HOOK_DIR + "/evidence-gate.py"], {
      input: JSON.stringify({ sessionId: sid, reason: "end_turn", lastAssistantMessage: "Done." }),
      encoding: "utf8",
      env: { ...process.env, GROK_HOME: home, HOME: home },
    });
  };
  const noop = await run("true");
  assert.match(noop.stdout, /Evidence check/);
  const hidden = await run("git status && npm test");
  assert.equal(hidden.stdout, "");
  await rm(home, { recursive: true, force: true });
});

hookTest("open todos still block a let-me-know stop, and subagent_stop is a subagent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gm-hook2-"));
  const sid = "sid-continue-1";
  const dir = path.join(home, "sessions", "proj", sid);
  await mkdir(dir, { recursive: true });
  const row = (update) => JSON.stringify({ params: { update } }) + "\n";
  await writeFile(path.join(dir, "updates.jsonl"), [
    row({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do the work" } }),
    row({ sessionUpdate: "plan", entries: [{ content: "finish the thing", status: "pending" }] }),
  ].join(""));
  const hook = HOOK_DIR + "/continue-until-done.py";
  const env = { ...process.env, GROK_HOME: home, HOME: home };
  const todo = spawnSync("python3", [hook], {
    input: JSON.stringify({ sessionId: sid, reason: "end_turn", lastAssistantMessage: "let me know if you want edits" }),
    encoding: "utf8",
    env,
  });
  assert.match(todo.stdout, /open items/);
  const sid2 = "sid-continue-2";
  await mkdir(path.join(home, "sessions", "proj", sid2), { recursive: true });
  await writeFile(path.join(home, "sessions", "proj", sid2, "updates.jsonl"), row({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "go" } }));
  const sub = spawnSync("python3", [hook], {
    input: JSON.stringify({ sessionId: sid2, reason: "end_turn", hookEventName: "subagent_stop", lastAssistantMessage: "" }),
    encoding: "utf8",
    env,
  });
  assert.equal(sub.stdout, "");
  await rm(home, { recursive: true, force: true });
});

// ---- Reliability (2026-10-11): notes-only proof line, recovery decisions, ACP timeouts, hook caps ----
import { isNotePath } from "../lib/evidence.js";
import { isStalled, resumeReason } from "../lib/recover.js";
import { startAgent } from "../lib/acp.js";

const editOf = (proof, id, file) => {
  trackProof(proof, { sessionUpdate: "tool_call", toolCallId: id, _meta: { "x.ai/tool": { name: "search_replace" } }, rawInput: { file_path: file } });
  trackProof(proof, { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "diff", path: file }], rawOutput: { type: "SearchReplace" } });
};

test("proof line: notes-only turns are not flagged, code edits still are", () => {
  for (const p of ["/h/proj/topics/notes.md", "PLAN.md", "PROGRESS", "notes.txt", "/h/.grok/memory/x.json", "a/notes/b"]) assert.ok(isNotePath(p), p);
  for (const p of ["src/app.js", "main.py", "Makefile", "", "PLANNER.js"]) assert.ok(!isNotePath(p), p);
  const notes = newProof();
  editOf(notes, "a", "/p/topics/notes.md");
  editOf(notes, "b", "/p/PROGRESS.md");
  assert.equal(proofVerdict(notes), null);
  assert.equal(proofSummary(notes).edits, 0);
  const mixed = newProof();
  editOf(mixed, "a", "/p/app.js");
  editOf(mixed, "b", "/p/NOTES.md");
  assert.equal(proofVerdict(mixed).tone, "warn");
  // An edit whose path is unknown counts as code.
  const unknown = newProof();
  trackProof(unknown, { sessionUpdate: "tool_call_update", toolCallId: "z", status: "completed", rawOutput: { type: "Write" } });
  assert.equal(proofVerdict(unknown).tone, "warn");
});

test("recovery: which finished turns resume, and what counts as a stall", () => {
  assert.equal(resumeReason({ stopReason: "end_turn" }), "");
  assert.equal(resumeReason({ stopReason: "cancelled" }), "");
  assert.equal(resumeReason({ stopReason: "denied" }), "");
  assert.match(resumeReason({ stopReason: "error" }), /exited/);
  assert.match(resumeReason({ stopReason: "max_tokens" }), /max_tokens/);
  assert.match(resumeReason({ stopReason: "error", stall: true }), /quiet/);
  assert.equal(resumeReason({ stopReason: "error", longRun: true }), "", "long runs have their own supervisor");
  assert.equal(resumeReason({ stopReason: "cancelled", shutdown: true }), "", "shutdown is resumed by the restart path");
  const base = { started: true, done: false, pending: new Map(), liveTools: new Set(), lastEventAt: 0 };
  assert.ok(isStalled(base, 10_000, 5_000, 50_000));
  assert.ok(!isStalled({ ...base, lastEventAt: 8_000 }, 10_000, 5_000, 50_000));
  assert.ok(!isStalled({ ...base, pending: new Map([["r", {}]]) }, 10_000, 5_000, 50_000), "waiting on the user is not a stall");
  assert.ok(!isStalled({ ...base, liveTools: new Set(["t"]) }, 10_000, 5_000, 50_000), "a long tool gets the longer limit");
  assert.ok(!isStalled({ ...base, longRun: true }, 10_000, 5_000, 50_000));
  assert.ok(!isStalled({ ...base, stallKill: true }, 10_000, 5_000, 50_000), "already being restarted");
});

test("ACP: a request with a timeout rejects instead of hanging forever", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gm-acp-"));
  const bin = path.join(dir, "silent.mjs");
  await writeFile(bin, "#!/usr/bin/env node\nprocess.stdin.resume();\n", { mode: 0o755 });
  const prev = process.env.GROK_BIN;
  process.env.GROK_BIN = bin;
  const agent = startAgent({ cwd: dir });
  try {
    const t = Date.now();
    await assert.rejects(agent.request("initialize", {}, 300), (error) => error.timeout === true && /initialize/.test(error.message));
    assert.ok(Date.now() - t < 2000);
  } finally {
    agent.kill("SIGKILL");
    process.env.GROK_BIN = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

const HOOKS = HOOK_DIR;
async function hookHome(lines) {
  const home = await mkdtemp(path.join(tmpdir(), "gm-hook-"));
  const dir = path.join(home, "sessions", "cwd", "s1");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "updates.jsonl"), lines.map((u) => JSON.stringify({ method: "session/update", params: { sessionId: "s1", update: u } })).join("\n") + "\n");
  return home;
}
const runHook = (name, home, ev) => spawnSync("python3", [path.join(HOOKS, name)], { input: JSON.stringify({ sessionId: "s1", reason: "end_turn", ...ev }), env: { ...process.env, GROK_HOME: home, GM_LONGRUN: "" }, encoding: "utf8" }).stdout.trim();
const user = (text) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text } });
const edit = (id, file) => [
  { sessionUpdate: "tool_call", toolCallId: id, _meta: { "x.ai/tool": { name: "search_replace" } }, rawInput: { file_path: file } },
  { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", content: [{ type: "diff", path: file }], rawOutput: { type: "SearchReplace" } },
];

hookTest("evidence-gate hook: notes-only turns pass, code edits are still gated", async () => {
  const notes = await hookHome([user("update notes"), ...edit("a", "/p/topics/notes.md"), ...edit("b", "/p/PLAN.md")]);
  assert.equal(runHook("evidence-gate.py", notes, { lastAssistantMessage: "Updated the notes." }), "");
  const code = await hookHome([user("fix it"), ...edit("a", "/p/server.js"), ...edit("b", "/p/NOTES.md")]);
  assert.match(runHook("evidence-gate.py", code, { lastAssistantMessage: "Fixed." }), /"decision": "block"/);
  await rm(notes, { recursive: true, force: true });
  await rm(code, { recursive: true, force: true });
});

hookTest("continue hook: a continue count from an earlier turn does not cap the new turn", async () => {
  const plan = { sessionUpdate: "plan", entries: [{ content: "step two", status: "pending" }] };
  const home = await hookHome([user("old ask"), { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } }, user("new ask"), plan]);
  await mkdir(path.join(home, "hook-state"), { recursive: true });
  // Old format and an old turn's count both used to make n >= cap straight away.
  for (const stale of ["5", "1:5"]) {
    await writeFile(path.join(home, "hook-state", "s1.count"), stale);
    assert.match(runHook("continue-until-done.py", home, { stopHookActive: true, lastAssistantMessage: "Did step one." }), /open items/, "stale count " + stale);
  }
  // The cap still holds within one turn.
  await writeFile(path.join(home, "hook-state", "s1.count"), "2:5");
  assert.equal(runHook("continue-until-done.py", home, { stopHookActive: true, lastAssistantMessage: "Did step one." }), "");
  await rm(home, { recursive: true, force: true });
});

test("copyText uses clipboard when available and falls back to a textarea", async () => {
  const writes = [];
  const okNav = {
    navigator: { clipboard: { writeText: async (t) => { writes.push(t); } } },
    document: null,
  };
  assert.equal(await copyText("hello **md**", okNav), true);
  assert.deepEqual(writes, ["hello **md**"]);

  let exec = "";
  const kids = [];
  const failNav = {
    navigator: { clipboard: { writeText: async () => { throw new Error("denied"); } } },
    document: {
      body: {
        appendChild(el) { kids.push(el); },
      },
      createElement(tag) {
        assert.equal(tag, "textarea");
        return {
          value: "",
          style: { cssText: "" },
          setAttribute() {},
          focus() {},
          select() {},
          remove() { kids.pop(); },
        };
      },
      execCommand(cmd) { exec = cmd; return true; },
    },
  };
  assert.equal(await copyText("raw markdown\n\n- item", failNav), true);
  assert.equal(exec, "copy");
  assert.equal(kids.length, 0);

  const nowhere = { navigator: {}, document: null };
  assert.equal(await copyText("nope", nowhere), false);
});

test("composer action slot: Send / Stop / Send now swap (images count as content)", () => {
  assert.deepEqual(composerAction({}), { label: "Send", mode: "send" });
  assert.deepEqual(composerAction({ running: true, chat: false, hasContent: true }), { label: "Send", mode: "send" });
  assert.deepEqual(composerAction({ running: false, chat: true, hasContent: true }), { label: "Send", mode: "send" });
  assert.deepEqual(composerAction({ running: true, chat: true, hasContent: false }), { label: "Stop", mode: "stop" });
  assert.deepEqual(composerAction({ running: true, chat: true, hasContent: true }), { label: "Send now", mode: "now" });
  assert.equal(hasComposerContent("  ", 0), false);
  assert.equal(hasComposerContent("", 0), false);
  assert.equal(hasComposerContent("hi", 0), true);
  assert.equal(hasComposerContent("  ", 1), true);
  assert.equal(hasComposerContent("", 2), true);
});


test("loop command grammar: interval first or 'every' last, x<N> and until DONE", () => {
  assert.deepEqual(parseLoopCommand("/loop 30m check the build"), { action: "create", minutes: 30, prompt: "check the build", maxRuns: 0, untilDone: false });
  assert.deepEqual(parseLoopCommand("/loop 2h x10 until DONE fix it"), { action: "create", minutes: 120, prompt: "fix it", maxRuns: 10, untilDone: true });
  assert.deepEqual(parseLoopCommand("/loop check deploy every 1d"), { action: "create", minutes: 1440, prompt: "check deploy", maxRuns: 0, untilDone: false });
  assert.equal(parseLoopCommand("/loop 45min tidy").minutes, 45);
  assert.equal(parseLoopCommand("/loop just a prompt").action, "error");
  assert.equal(parseLoopCommand("/loop stop").action, "stop");
  assert.equal(parseLoopCommand("/loops").action, "list");
  assert.equal(parseLoopCommand("/loopy 5m x"), null);
  assert.equal(parseLoopCommand("hello /loop 5m x"), null);
  assert.equal(parseInterval("300s"), 5);
  assert.equal(parseInterval("0m"), null);
  assert.equal(intervalLabel(90), "90m");
  assert.equal(intervalLabel(120), "2h");
});

test("loop limits, run labels and DONE detection", () => {
  assert.match(validateLoop({ minutes: 4, prompt: "x" }), /5 minutes/);
  assert.equal(validateLoop({ minutes: 5, prompt: "x" }), "");
  assert.match(validateLoop({ minutes: 60 * 24 * 8, prompt: "x" }), /7 days/);
  assert.match(validateLoop({ minutes: 5, prompt: " " }), /prompt/);
  assert.match(validateLoop({ minutes: 5, prompt: "x", maxRuns: 0.5 }), /Max runs/);
  assert.equal(runLabel({ minutes: 30, maxRuns: 10 }, 3), "Loop run 3 of 10 · every 30m");
  assert.equal(runLabel({ minutes: 60, maxRuns: 0, untilDone: true }, 1), "Loop run 1 · every 1h · until DONE");
  assert.equal(hasDone("All checks pass. DONE"), true);
  assert.equal(hasDone("not done yet"), false);
  assert.equal(hasDone("UNDONE"), false);
});
