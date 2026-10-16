import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseUpdates } from "../lib/history.js";
import { cleanImages } from "../lib/images.js";
import { hostAllowedName, isAllowedIp, isPrivateLan, lanHostAllowed } from "../lib/net.js";
import { contrastText, cssColor, neutralThemeColor, neutralVars, parseColors, prettifySlug, slugifyName, themeCss } from "../lib/theme.js";
import { applyEvent, extractImages, plainText } from "../public/reduce.js";
import { copyText } from "../public/clipboard.js";
import { composerAction, hasComposerContent } from "../public/composer.js";
import { applyReasoning, longRunActive, modeChoice, reasoningChoice, reasoningChipText, ULTRA_HELP } from "../public/options.js";
import { findRefs, parseMedia, renderMarkdown, rewriteRefs } from "../public/markdown.js";
import { accountBody, createBillingCache, parseBilling, planUsageLabel } from "../lib/billing.js";
import { lastMessageSnippet } from "../lib/sessions.js";
import { buildSkillPlugin, frontmatterField, skillsFromCommands } from "../lib/skills.js";
import fsp from "node:fs/promises";
import { hasDone, intervalLabel, parseInterval, parseLoopCommand, runLabel, validateLoop } from "../lib/loops.js";

test("allows only loopback and Tailscale", () => {
  for (const ip of ["127.0.0.1", "127.0.0.2", "::1", "::ffff:127.0.0.1", "100.64.0.1", "100.82.195.43", "100.127.255.255"]) {
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
  const dark = themeCss({ vars: neutralVars("dark") });
  const light = themeCss({ vars: neutralVars("light") });
  assert.match(dark, /--bg:#000000/);
  assert.match(dark, /--accent:#ffffff/);
  assert.match(light, /--bg:#ffffff/);
  assert.match(light, /--accent:#000000/);
  assert.equal(neutralThemeColor("light"), "#ffffff");
  assert.equal(neutralThemeColor("nope"), "#000000");
  assert.equal(dark.includes("#7aa2f7"), false);
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
  const dir = await mkdtemp(path.join(tmpdir(), "grok-deck-auth-"));
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
    const sessions = await import("../lib/sessions.js");
    assert.equal(sessions.cleanAppearance("light"), "light");
    assert.equal(sessions.cleanAppearance("dark"), "dark");
    assert.equal(sessions.cleanAppearance("nope"), "dark");
    assert.equal(await sessions.getAppearance(), "dark");
    assert.equal(await sessions.setAppearance("light"), "light");
    assert.equal(await sessions.getAppearance(), "light");
    assert.equal(await sessions.setAppearance("nope"), "dark");
    const meta = await import("node:fs/promises").then((fs) => fs.readFile(path.join(dir, "meta.json"), "utf8"));
    assert.match(meta, /"appAppearance": "dark"/);
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
  const spawned = subagentEvent({ sessionUpdate: "subagent_spawned", subagent_id: "s1", child_session_id: "s1", description: "plan it", subagent_type: "grok-deck-ultra:planner" });
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

test("evidence hook blocks a no-op and allows a real check after the edit", async () => {
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
    return spawnSync("python3", [`${process.env.HOME}/.grok/hook-scripts/evidence-gate.py`], {
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

test("open todos still block a let-me-know stop, and subagent_stop is a subagent", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gm-hook2-"));
  const sid = "sid-continue-1";
  const dir = path.join(home, "sessions", "proj", sid);
  await mkdir(dir, { recursive: true });
  const row = (update) => JSON.stringify({ params: { update } }) + "\n";
  await writeFile(path.join(dir, "updates.jsonl"), [
    row({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "do the work" } }),
    row({ sessionUpdate: "plan", entries: [{ content: "finish the thing", status: "pending" }] }),
  ].join(""));
  const hook = `${process.env.HOME}/.grok/hook-scripts/continue-until-done.py`;
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
  for (const p of ["/h/vm/topics/population.md", "PLAN.md", "PROGRESS", "notes.txt", "/h/.grok/memory/x.json", "a/notes/b"]) assert.ok(isNotePath(p), p);
  for (const p of ["src/app.js", "main.py", "Makefile", "", "PLANNER.js"]) assert.ok(!isNotePath(p), p);
  const notes = newProof();
  editOf(notes, "a", "/p/topics/population.md");
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

const HOOKS = path.join(process.env.HOME, ".grok", "hook-scripts");
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

test("evidence-gate hook: notes-only turns pass, code edits are still gated", async () => {
  const notes = await hookHome([user("update notes"), ...edit("a", "/p/topics/population.md"), ...edit("b", "/p/PLAN.md")]);
  assert.equal(runHook("evidence-gate.py", notes, { lastAssistantMessage: "Updated the notes." }), "");
  const code = await hookHome([user("fix it"), ...edit("a", "/p/server.js"), ...edit("b", "/p/NOTES.md")]);
  assert.match(runHook("evidence-gate.py", code, { lastAssistantMessage: "Fixed." }), /"decision": "block"/);
  await rm(notes, { recursive: true, force: true });
  await rm(code, { recursive: true, force: true });
});

test("continue hook: a continue count from an earlier turn does not cap the new turn", async () => {
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

test("markdown tables scroll in their own box and fences stay code", () => {
  const html = renderMarkdown(
    [
      "Before the table.",
      "",
      "| Name | Value |",
      "| :--- | ---: |",
      "| alpha | beta |",
      "",
      "```",
      "code | still | code",
      "```",
      "",
      "After.",
    ].join("\n"),
  );
  assert.match(html, /<div class="table-wrap"><table>/);
  assert.match(html, /<th style="text-align:right">Value<\/th>/);
  assert.match(html, /<td>alpha<\/td>/);
  assert.match(html, /<td style="text-align:right">beta<\/td>/);
  assert.match(html, /<div class="code">/);
  assert.match(html, /code \| still \| code/);
  assert.match(html, /<p>Before the table\.<\/p>/);
  assert.match(html, /<p>After\.<\/p>/);
  assert.doesNotMatch(html, /<p>[^<]*\| Name/);
  const stored = "/api/media/" + "a".repeat(64) + ".png";
  const img = renderMarkdown("![wide](" + stored + ")");
  assert.match(img, /class="shots md-shot"/);
  assert.match(img, new RegExp('src="' + stored.replaceAll("/", "\\/") + '"'));
  // A local path still in the text means the source was gone when the message arrived: a card, never a broken box.
  const gone = renderMarkdown("![wide](wide.png)");
  assert.match(gone, /class="md-missing"/);
  assert.match(gone, /Image moved or deleted/);
  assert.doesNotMatch(gone, /<img/);
  assert.match(renderMarkdown("![x](https://example.com/a.png)"), /<a href="https:\/\/example\.com\/a\.png"/);
});

test("image references are found and rewritten by position, outside code", () => {
  const text = "a ![x](images/a.png) `![no](b.png)`\n```\n![no2](c.png)\n```\n![y](</tmp/d e.png>) ![z](https://x/y.png)";
  assert.deepEqual(findRefs(text).map((t) => t.target), ["images/a.png", "</tmp/d e.png>", "https://x/y.png"]);
  const out = rewriteRefs(text, new Map([["images/a.png", "/api/media/h.png"]]));
  assert.equal(out, text.replace("images/a.png", "/api/media/h.png"));
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

test("composer toolbar: mode priority and Ultra reasoning", () => {
  assert.deepEqual(reasoningChoice({ effort: "high", ultra: false }), { id: "high", label: "high", effort: "high", ultra: false });
  assert.deepEqual(reasoningChoice({ effort: "low", ultra: true }), { id: "ultra", label: "Ultra", effort: "xhigh", ultra: true });
  assert.deepEqual(reasoningChoice({}), { id: "high", label: "high", effort: "high", ultra: false });
  assert.deepEqual(reasoningChoice({ effort: "nope" }), { id: "high", label: "high", effort: "high", ultra: false });
  assert.deepEqual(applyReasoning("ultra"), { effort: "xhigh", ultra: true });
  assert.deepEqual(applyReasoning("xhigh"), { effort: "xhigh", ultra: false });
  assert.deepEqual(applyReasoning("low"), { effort: "low", ultra: false });
  assert.deepEqual(applyReasoning("medium"), { effort: "medium", ultra: false });
  assert.deepEqual(applyReasoning("nope"), { effort: "high", ultra: false });
  assert.equal(longRunActive({ status: "running" }), true);
  assert.equal(longRunActive({ status: "paused" }), true);
  assert.equal(longRunActive({ status: "done" }), false);
  assert.equal(longRunActive(true), true);
  assert.equal(longRunActive(null), false);
  assert.deepEqual(modeChoice({}), { id: "normal", label: "Normal" });
  assert.deepEqual(modeChoice({ plan: true }), { id: "plan", label: "Plan" });
  assert.deepEqual(modeChoice({ plan: true, longRun: { status: "running" } }), { id: "long", label: "Long run" });
  assert.deepEqual(modeChoice({ plan: true, longRun: { status: "done" }, loops: [{ status: "active" }] }), { id: "plan", label: "Plan" });
  assert.deepEqual(modeChoice({ longRun: { status: "stopped" }, loops: [{ status: "paused" }] }), { id: "normal", label: "Normal" });
  assert.deepEqual(modeChoice({ loops: [{ status: "active" }] }), { id: "loops", label: "Loops" });
  assert.deepEqual(modeChoice({ longRun: true, plan: true }), { id: "long", label: "Long run" });
  assert.match(ULTRA_HELP, /pstack's poteto-mode/);
  assert.match(ULTRA_HELP, /plan, build, review, and unslop/);
  assert.equal(ULTRA_HELP.includes("\u2014"), false);
  assert.equal(reasoningChipText("high", "grok-4.7"), "Grok 4.7 High");
  assert.equal(reasoningChipText("ultra", "grok-4.7"), "Ultra");
  assert.equal(reasoningChipText("xhigh", "grok-4.7-build-fast"), "Grok 4.7 Fast Extra high");
  assert.equal(reasoningChipText("low", "grok-4.5"), "Grok 4.5 Low");
  assert.equal(reasoningChipText("medium", "grok-4.6"), "Grok 4.6 Medium");
  assert.equal(reasoningChipText("high", ""), "Grok 4.7 High");
  assert.equal(reasoningChipText("nope", "custom-model"), "Custom Model High");
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

test("session list reports token use without reading the transcript", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "gm-tokens-"));
  const data = await mkdtemp(path.join(tmpdir(), "gm-tokens-data-"));
  const withUse = "11111111-2222-4333-8444-555555555555";
  const bare = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  try {
    const group = path.join(home, "sessions", "proj");
    await mkdir(path.join(group, withUse), { recursive: true });
    await mkdir(path.join(group, bare), { recursive: true });
    await writeFile(path.join(group, withUse, "summary.json"), JSON.stringify({ generated_title: "Token session", info: { cwd: "/tmp/proj" } }));
    await writeFile(path.join(group, withUse, "usage.json"), JSON.stringify({ session: { totalTokens: 128000 } }));
    await writeFile(path.join(group, withUse, "signals.json"), JSON.stringify({ contextTokensUsed: 12000, contextWindowTokens: 128000 }));
    await writeFile(path.join(group, bare, "summary.json"), JSON.stringify({ generated_title: "Empty session", info: { cwd: "/tmp/proj" } }));
    await writeFile(path.join(group, bare, "usage.json"), "{");
    const mod = new URL("../lib/sessions.js", import.meta.url).href;
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", `import { listSessions } from ${JSON.stringify(mod)};\nconst rows = await listSessions();\nprocess.stdout.write(JSON.stringify(rows));`], {
      env: { ...process.env, GROK_HOME: home, DATA_DIR: data },
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const rows = JSON.parse(run.stdout);
    const used = rows.find((row) => row.id === withUse);
    const empty = rows.find((row) => row.id === bare);
    assert.equal(used.title, "Token session");
    assert.equal(used.tokens, 128000);
    assert.deepEqual(used.context, { used: 12000, window: 128000 });
    assert.equal(empty.title, "Empty session");
    assert.equal(empty.tokens, 0);
    assert.equal(empty.context, undefined);
    assert.equal(used.snippet, "");
    assert.equal(empty.snippet, "");
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(data, { recursive: true, force: true });
  }
});

test("session list snippet is the last message, one line", () => {
  const line = (update) => JSON.stringify({ params: { update } });
  const chunk = (kind, text) => line({ sessionUpdate: kind, content: { type: "text", text } });
  const text = [
    chunk("user_message_chunk", "earlier question"),
    chunk("agent_message_chunk", "Hello "),
    chunk("agent_message_chunk", "there\nfriend"),
    line({ sessionUpdate: "tool_call", title: "run" }),
  ].join("\n");
  assert.equal(lastMessageSnippet(text), "Hello there friend");
  const long = "snippet ".repeat(40);
  assert.equal(lastMessageSnippet(chunk("agent_message_chunk", long)).endsWith("..."), true);
  assert.ok(lastMessageSnippet(chunk("agent_message_chunk", long)).length <= 140);
  assert.equal(lastMessageSnippet("not json\n"), "");
  assert.equal(lastMessageSnippet(""), "");
});

test("plan quota percent comes from billing config, not from session totals", async () => {
  const weekly = parseBilling({
    config: { creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } },
    subscription_tier: "Example",
    session: { totalTokens: 128000 },
  });
  assert.deepEqual(weekly, { percent: 42, period: "week" });
  assert.equal(planUsageLabel(weekly), "42% this week");
  assert.deepEqual(accountBody({ config: { creditUsagePercent: 42, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } }), {
    available: true,
    percent: 42,
    period: "week",
    label: "42% this week",
  });
  const monthly = parseBilling({ config: { creditUsagePercent: 7.2, currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY" } } });
  assert.equal(monthly.period, "month");
  assert.equal(planUsageLabel(monthly), "7% this month");
  const other = parseBilling({ config: { creditUsagePercent: 0, currentPeriod: { type: "CUSTOM" } } });
  assert.deepEqual(other, { percent: 0, period: null });
  assert.equal(planUsageLabel(other), "0% of plan");
  assert.equal(planUsageLabel(parseBilling({ config: { creditUsagePercent: 140.4, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY" } } })), "140% this week");
  for (const raw of [null, {}, { config: {} }, { config: { creditUsagePercent: "42" } }, { creditUsagePercent: 42 }, { config: { creditUsagePercent: Number.NaN } }, { session: { totalTokens: 128000 } }]) {
    assert.equal(parseBilling(raw), null, JSON.stringify(raw));
    assert.deepEqual(accountBody(raw), { available: false });
  }

  let calls = 0;
  let now = 0;
  const cache = createBillingCache({
    load: async () => {
      calls += 1;
      return { available: true, percent: calls, period: "week", label: calls + "% this week" };
    },
    now: () => now,
    ttlMs: 1000,
    failTtlMs: 50,
  });
  const [a, b] = await Promise.all([cache.get(), cache.get()]);
  assert.equal(calls, 1);
  assert.equal(a.percent, 1);
  assert.deepEqual(b, a);
  now = 999;
  assert.equal((await cache.get()).percent, 1);
  assert.equal(calls, 1);
  cache.invalidate();
  assert.equal((await cache.get()).percent, 2);
  now = 1998;
  assert.equal((await cache.get()).percent, 2);
  now = 1999;
  assert.equal((await cache.get()).percent, 3);

  const pending = [];
  const raced = createBillingCache({
    load: () => new Promise((resolve) => pending.push(resolve)),
    now: () => 0,
    ttlMs: 1000,
    failTtlMs: 50,
  });
  const first = raced.get();
  await Promise.resolve();
  assert.equal(pending.length, 1);
  raced.invalidate();
  const second = raced.get();
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[0]({ available: true, percent: 9, period: "week", label: "9% this week" });
  pending[1]({ available: true, percent: 4, period: "week", label: "4% this week" });
  assert.equal((await first).percent, 9);
  assert.equal((await second).percent, 4);
  assert.equal((await raced.get()).percent, 4);
  assert.equal(pending.length, 2);

  let fail = true;
  let fails = 0;
  const down = createBillingCache({
    load: async () => {
      fails += 1;
      if (fail) throw new Error("nope");
      return { available: true, percent: 1, period: "month", label: "1% this month" };
    },
    now: () => now,
    ttlMs: 1000,
    failTtlMs: 50,
  });
  now = 0;
  assert.deepEqual(await down.get(), { available: false });
  now = 49;
  assert.deepEqual(await down.get(), { available: false });
  assert.equal(fails, 1);
  now = 50;
  fail = false;
  assert.equal((await down.get()).label, "1% this month");
  assert.equal(fails, 2);
});

test("media store: any local file a message links to is copied once, survives its source moving, and only files in the folder are taken", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "gm-media-"));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "gm-work-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "gm-out-"));
  process.env.DATA_DIR = data;
  const media = await import("../lib/media.js?" + Date.now());
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  await fs.writeFile(path.join(work, "shot.png"), png);
  await fs.writeFile(path.join(work, "fake.png"), "not an image at all");
  await fs.writeFile(path.join(work, "notes.md"), "# Notes\n\n| a | b |\n| - | - |\n| 1 | 2 |\n");
  await fs.writeFile(path.join(work, "report.pdf"), "%PDF-1.4 fake");
  await fs.writeFile(path.join(work, ".secret.txt"), "hidden");
  await fs.writeFile(path.join(outside, "secret.png"), png);
  await fs.writeFile(path.join(outside, "secret.md"), "outside");
  const session = { cwd: work, dir: work };
  const text = [
    "Here: ![shot](shot.png) and ![fake](fake.png) and [out](" + path.join(outside, "secret.md") + ") and ![gone](nope.png)",
    "[the report](report.pdf) and [dot](.secret.txt)",
    path.join(work, "notes.md"),
    "see notes.md in prose",
  ].join("\n");
  const first = await media.internMessages([{ role: "assistant", text }], "s1", session);
  const out = first[0].text;
  assert.match(out, /!\[shot\]\(\/api\/media\/[0-9a-f]{64}\.png\?n=shot\.png\)/);
  assert.match(out, /\[the report\]\(\/api\/media\/[0-9a-f]{64}\.pdf\?n=report\.pdf\)/);
  assert.match(out, /^\[notes\.md\]\(\/api\/media\/[0-9a-f]{64}\.md\?n=notes\.md\)$/m, "a path alone on its line becomes a link to the stored file");
  assert.match(out, /!\[fake\]\(fake\.png\)/); // not an image: left as written
  assert.match(out, /!\[gone\]\(nope\.png\)/); // missing: left as written
  assert.ok(out.includes("](" + path.join(outside, "secret.md") + ")"), "outside the folder is never read");
  assert.ok(out.includes("[dot](.secret.txt)"), "a dot file is never read");
  assert.ok(out.endsWith("see notes.md in prose"), "a path inside prose is not an embed");
  assert.equal((await fs.readdir(data + "/media")).filter((n) => /^[0-9a-f]{64}\./.test(n)).length, 3);
  // The agent moves the files; the same message read back still points at the stored copies.
  await fs.rename(path.join(work, "shot.png"), path.join(work, "moved.png"));
  await fs.rm(path.join(work, "report.pdf"));
  const again = await media.internMessages([{ role: "assistant", text }], "s1", session);
  assert.equal(again[0].text, out);
  const [, name] = /\/api\/media\/([0-9a-f]{64}\.png)/.exec(out);
  assert.deepEqual((await fs.readFile((await media.statMedia(name)).file)), png);
  assert.equal(await media.statMedia("../index.json"), null);
  assert.equal(media.mediaType(name), "image/png");
  assert.equal(media.mediaType("a".repeat(64) + ".md"), "text/plain; charset=utf-8");
  assert.equal(media.mediaType("a".repeat(64) + ".html"), "text/plain; charset=utf-8", "a page never runs from the store");
  assert.equal(media.mediaType("a".repeat(64) + ".zip"), "application/octet-stream");
  // Over the cap: not copied, and the reference says how big it was.
  await fs.writeFile(path.join(work, "big.mp4"), Buffer.alloc(media.MAX_FILE + 1));
  const big = await media.internTarget("big.mp4", session);
  assert.match(big, /^\/api\/media\/limit\?size=\d+&n=big\.mp4$/);
  assert.match(renderMarkdown("[v](" + big + ")"), /File too large to keep/);
});

test("stored files render by type, and documents keep their own text out of the chat's embeds", () => {
  const h = "a".repeat(64);
  const embed = (ext, n) => renderMarkdown("[x](/api/media/" + h + "." + ext + "?n=" + n + ")");
  assert.match(embed("pdf", "r.pdf"), /data-kind="pdf" data-name="r\.pdf"/);
  assert.match(embed("mp4", "v.mp4"), /data-kind="video"/);
  assert.match(embed("mp3", "a.mp3"), /data-kind="audio"/);
  assert.match(embed("md", "n.md"), /data-kind="markdown"/);
  assert.match(embed("py", "a.py"), /data-kind="code"/);
  assert.match(embed("zip", "a.zip"), /data-kind="file"/);
  assert.match(embed("png", "a.png"), /class="shots md-shot"/);
  assert.match(renderMarkdown("[x](/gone/a.zip)"), /File moved or deleted/);
  assert.equal(renderMarkdown("[x](/gone/a.zip)", { embeds: false }), "<p>x</p>");
  assert.equal(parseMedia("/api/media/" + h + ".md?n=n.md").label, "n.md");
});

// A zip with stored entries, enough to stand in for a .docx or .pptx.
function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

test("attachments: files are stored, copied into the working folder, read into the prompt, and read back from history", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "gm-up-data-"));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), "gm-up-work-"));
  process.env.DATA_DIR = data;
  const up = await import("../lib/uploads.js?" + Date.now());
  assert.equal(up.cleanFileName("../../etc/pass wd?.md"), "pass wd_.md");
  assert.equal(up.cleanFileName(".hidden"), "hidden");
  const docx = makeZip({ "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Quarterly &amp; plan</w:t></w:r></w:p><w:p><w:r><w:t>Second line</w:t></w:r><w:tab/><w:r><w:t>after tab</w:t></w:r></w:p></w:body></w:document>" });
  const pptx = makeZip({ "ppt/slides/slide2.xml": "<p><a:p><a:t>Two</a:t></a:p></p>", "ppt/slides/slide1.xml": "<p><a:p><a:t>One</a:t></a:p></p>" });
  const uploads = [
    await up.saveUpload(Buffer.from("# Notes\n\nhello from markdown"), "notes.md"),
    await up.saveUpload(Buffer.from("a,b\n1,2\n"), "table.csv"),
    await up.saveUpload(docx, "plan.docx"),
    await up.saveUpload(pptx, "deck.pptx"),
    await up.saveUpload(Buffer.alloc(3000, 1), "bundle.zip"),
    await up.saveUpload(Buffer.from("x".repeat(30000)), "big.txt"),
  ];
  assert.deepEqual(uploads.map((u) => u.kind), ["markdown", "code", "file", "file", "file", "code"]);
  await assert.rejects(up.saveUpload(Buffer.alloc(up.MAX_UPLOAD + 1), "huge.bin"), /over the 25 MB limit/);
  await assert.rejects(up.saveUpload(Buffer.alloc(0), "empty.txt"), /is empty/);
  const { files, block } = await up.attachFiles(uploads.map((u) => ({ id: u.id, name: u.name })), work);
  assert.equal(files.length, 6);
  assert.equal(await fs.readFile(path.join(work, ".grok-deck/uploads/notes.md"), "utf8"), "# Notes\n\nhello from markdown");
  assert.equal(await fs.readFile(path.join(work, ".grok-deck/.gitignore"), "utf8"), "*\n");
  assert.ok(block.includes(path.join(work, ".grok-deck/uploads/notes.md")), "the prompt names the copy");
  assert.match(block, /hello from markdown/);
  assert.match(block, /a,b\n1,2/);
  assert.match(block, /Quarterly & plan\nSecond line\tafter tab/);
  assert.match(block, /Slide 1:\nOne\n\nSlide 2:\nTwo/);
  assert.ok(!/bundle\.zip\)[^]*Text of bundle/.test(block), "a zip carries its path and no text");
  assert.match(block, /Text of big\.txt \(the first part; read the file for the rest\)/);
  assert.ok(block.length < 70000, "the text is bounded: " + block.length);
  // The same name with other content does not overwrite the first.
  const other = await up.saveUpload(Buffer.from("different"), "notes.md");
  const again = await up.attachFiles([{ id: other.id, name: "notes.md" }], work);
  assert.notEqual(path.basename(again.files[0].name), "");
  assert.equal(await fs.readFile(path.join(work, ".grok-deck/uploads/notes.md"), "utf8"), "# Notes\n\nhello from markdown");
  assert.equal((await fs.readdir(path.join(work, ".grok-deck/uploads"))).filter((n) => n.startsWith("notes")).length, 2);
  await assert.rejects(up.attachFiles([{ id: "0".repeat(64) + ".md", name: "gone.md" }], work), /no longer available/);
  assert.throws(() => up.cleanFileRefs([{ id: "../../x", name: "a" }]), /Unknown file/);
  assert.throws(() => up.cleanFileRefs(Array.from({ length: 9 }, () => ({ id: "a".repeat(64) + ".md", name: "a.md" }))), /up to 8 files/);
  // History hands the files back and hides the block.
  const back = up.extractAttachments("Please read these\n\n" + block);
  assert.equal(back.text, "Please read these");
  assert.deepEqual(back.files.map((f) => f.name), ["notes.md", "table.csv", "plan.docx", "deck.pptx", "bundle.zip", "big.txt"]);
  assert.deepEqual(up.extractAttachments("no block here"), { files: [], text: "no block here" });
  const messages = parseUpdates(JSON.stringify({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Look\n\n" + block } }) + "\n");
  assert.equal(messages[0].text, "Look");
  assert.equal(messages[0].files.length, 6);
});

test("media store: files under the home folder are read, secrets and Grok Deck's own data never are", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const home = await fs.mkdtemp(path.join(os.homedir(), "gm-sc-"));
  try {
    const cwd = path.join(home, "proj");
    const data = path.join(home, "deckdata");
    for (const d of [cwd, data, path.join(home, "notes"), path.join(home, ".ssh"), path.join(home, ".claude", "plans"), path.join(home, ".claude"), path.join(cwd, ".grok-deck", "uploads"), path.join(cwd, ".git")]) await fs.mkdir(d, { recursive: true });
    process.env.DATA_DIR = data;
    const media = await import("../lib/media.js?" + Date.now());
    const put = (p, t = "text\n") => fs.writeFile(p, t);
    await put(path.join(home, "notes", "Classic difficulty backlog.md"));
    await put(path.join(cwd, ".grok-deck", "uploads", "up.md"));
    await put(path.join(home, ".claude", "plans", "plan.md"));
    await put(path.join(home, ".claude", ".credentials.json"));
    await put(path.join(home, ".claude", "settings.md"));
    await put(path.join(home, ".ssh", "a.md"));
    await put(path.join(cwd, ".git", "config.txt"));
    await put(path.join(data, "auth.json"));
    await put(path.join(data, "notes.md"));
    await put(path.join(home, "notes", "key.pem"));
    await put(path.join(home, "notes", ".env"));
    await put(path.join(home, "notes", "secrets.json"));
    const session = { cwd, dir: cwd };
    const ok = async (t) => (await media.internTarget(t, session)).startsWith("/api/media/");
    assert.ok(await ok(path.join(home, "notes", "Classic difficulty backlog.md")), "a sibling folder under home");
    assert.ok(await ok(path.join(home, "notes", "Classic%20difficulty%20backlog.md")), "percent-encoded");
    assert.ok(await ok("~/" + path.relative(os.homedir(), path.join(home, "notes", "Classic difficulty backlog.md"))), "~ expands");
    assert.ok(await ok("../notes/Classic difficulty backlog.md"), "relative to the working folder, up and over");
    assert.ok(await ok(".grok-deck/uploads/up.md"), "an uploaded copy");
    assert.ok(await ok(path.join(home, ".claude", "plans", "plan.md")), "plans are shown");
    for (const no of [[".claude", ".credentials.json"], [".claude", "settings.md"], [".ssh", "a.md"], ["proj", ".git", "config.txt"], ["deckdata", "auth.json"], ["deckdata", "notes.md"], ["notes", "key.pem"], ["notes", ".env"], ["notes", "secrets.json"]]) {
      assert.equal(await media.internTarget(path.join(home, ...no), session), "", "refused: " + no.join("/"));
    }
    assert.equal(await media.internTarget("/etc/hostname.txt", session), "", "outside home and the working folder");
    assert.equal(await media.internTarget(path.join(home, "notes", "nope.md"), session), "", "not there");
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("helper sessions: headless and tagged ones are not listed, and only the reviewer's strays are moved to the trash", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "gm-help-data-"));
  const grok = await fs.mkdtemp(path.join(os.tmpdir(), "gm-help-grok-"));
  process.env.DATA_DIR = data;
  process.env.GROK_HOME = grok;
  const sessions = await import("../lib/sessions.js");
  const skeptic = await import("../lib/skeptic.js");
  const cwd = "/work/proj";
  const group = path.join(grok, "sessions", encodeURIComponent(cwd));
  const id = (n) => "0000000" + n + "-aaaa-bbbb-cccc-dddddddddddd";
  const at = Date.now();
  const make = async (n, extra) => {
    const dir = path.join(group, id(n));
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "summary.json"), JSON.stringify({ info: { id: id(n), cwd }, created_at: new Date(at - 1000).toISOString(), ...extra }));
  };
  await make(1, {});                                                   // the user's own session
  await make(2, { session_kind: "headless", agent_name: "skeptic" });  // a reviewer run, inside the review window
  await make(3, { session_kind: "headless", agent_name: "someone-else" }); // another headless run: not ours to move
  await make(4, { session_kind: "subagent" });
  await make(5, { session_kind: "headless", agent_name: "skeptic", created_at: new Date(at - 3 * 3600 * 1000).toISOString() }); // long before any review
  await sessions.setSessionPrefs(id(1), { cwd });
  await fs.mkdir(path.join(data, "skeptic"), { recursive: true });
  await fs.writeFile(path.join(data, "skeptic", id(1) + ".json"), JSON.stringify({ history: [{ at, tokens: 1 }] }));
  const listed = async () => (await sessions.listSessions()).map((row) => row.id).sort();
  assert.deepEqual(await listed(), [id(1)], "headless and subagent sessions are never top-level");
  assert.equal(sessions.isHelperSession(id(1), { session_kind: "headless" }, {}), true);
  assert.equal(sessions.isHelperSession(id(1), {}, { helpers: { [id(1)]: { parent: "x" } } }), true, "a tag with a parent hides it too");
  assert.equal(sessions.isHelperSession(id(1), {}, {}), false);
  assert.equal(await skeptic.sweepStrayReviewSessions(), 1);
  const trashed = await fs.readdir(path.join(data, "trash"));
  assert.equal(trashed.length, 1);
  assert.ok(trashed[0].startsWith(id(2)));
  for (const n of [1, 3, 4, 5]) await fs.access(path.join(group, id(n), "summary.json"));
  assert.equal(await skeptic.sweepStrayReviewSessions(), 0, "a second sweep finds nothing");
  // A run that just ended is tagged with the session it served.
  await make(6, { session_kind: "headless", agent_name: "skeptic", created_at: new Date(Date.now() + 2000).toISOString() });
  assert.deepEqual(await sessions.tagHelperSessions({ cwd, since: Date.now() + 1000, parent: id(1), kind: "review" }), [id(6)]);
  assert.equal((await sessions.getMeta()).helpers[id(6)].parent, id(1));
});

test("ask_user_question: the reducer shows one card in place of the tool step, and history rebuilds it with what was answered", async () => {
  const { applyQuestions } = await import("../lib/history.js");
  const questions = [{ question: "Which colour?", multiSelect: false, options: [{ label: "Red", description: "R" }] }];
  const state = { messages: [], n: 0 };
  applyEvent(state, { type: "tool_call", toolCallId: "t1", toolName: "ask_user_question", title: "ask_user_question" });
  applyEvent(state, { type: "question", reqId: "q1", toolCallId: "t1", questions, from: "" });
  assert.deepEqual(state.messages.map((m) => m.role), ["question"], "the tool step is replaced by the card");
  assert.equal(state.waiting, 1);
  applyEvent(state, { type: "tool_call_update", toolCallId: "t1", status: "completed" });
  assert.deepEqual(state.messages.map((m) => m.role), ["question"], "later updates to the tool call are not drawn");
  applyEvent(state, { type: "question_resolved", reqId: "q1", outcome: "accepted", answers: ["Red"], by: "user" });
  assert.deepEqual([state.messages[0].status, state.messages[0].answers, state.waiting], ["answered", ["Red"], 0]);
  const other = { messages: [], n: 0 };
  applyEvent(other, { type: "question", reqId: "q2", toolCallId: "t2", questions });
  applyEvent(other, { type: "end", stopReason: "end_turn" });
  assert.equal(other.messages[0].status, "cancelled", "a question still open when the turn ends is closed");
  const disk = [{ id: "tool:t1", role: "tool", tool: { id: "t1", name: "ask_user_question", status: "completed", input: JSON.stringify({ questions }) } }, { id: "tool:x", role: "tool", tool: { id: "x", name: "bash", status: "completed", input: "{}" } }];
  const rebuilt = applyQuestions(disk, { t1: { status: "answered", answers: ["Red"], by: "user" } });
  assert.deepEqual(rebuilt.map((m) => m.role), ["question", "tool"]);
  assert.deepEqual([rebuilt[0].status, rebuilt[0].answers, rebuilt[0].questions[0].options[0].label], ["answered", ["Red"], "Red"]);
  assert.equal(applyQuestions(disk, {})[0].status, "answered", "no record: the tool finished, so it was answered");
  assert.equal(applyQuestions([{ ...disk[0], tool: { ...disk[0].tool, status: "failed" } }], {})[0].status, "cancelled");
});

// A small pstack-shaped plugin: user-only skills, a sibling reference folder, a link to another skill.
async function fakePstack(dir) {
  const skill = async (name, head, body) => {
    await fsp.mkdir(path.join(dir, "skills", name), { recursive: true });
    await fsp.writeFile(path.join(dir, "skills", name, "SKILL.md"), "---\n" + head + "\n---\n" + body);
  };
  await skill("poteto-mode", "name: Poteto Mode\ndescription: poteto's agent style. Use for /poteto-mode.\ndisable-model-invocation: true\nmode: true", "Read [Fix Root Causes](../principle-fix-root-causes/SKILL.md) and playbooks/bug.md.\n");
  await skill("principle-fix-root-causes", "name: principle-fix-root-causes\ndescription: >\n  Apply when debugging.\n  Trace each symptom to its root.\ndisable-model-invocation: true", "Ask why five times.\n");
  await fsp.mkdir(path.join(dir, "skills", "poteto-mode", "playbooks"), { recursive: true });
  await fsp.writeFile(path.join(dir, "skills", "poteto-mode", "playbooks", "bug.md"), "Reproduce first.\n");
  await fsp.mkdir(path.join(dir, ".cursor-plugin"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "pstack", version: "9.9.9", author: { name: "Lauren Tan" } }));
  await fsp.writeFile(path.join(dir, "README.md"), "pstack readme\n");
}

test("pstack skills become model-invocable Grok skills without touching the vendored copy", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "gm-pstack-"));
  try {
    const src = path.join(dir, "pstack");
    await fakePstack(src);
    const before = await fsp.readFile(path.join(src, "skills", "poteto-mode", "SKILL.md"), "utf8");
    const out = await buildSkillPlugin(src, { root: path.join(dir, "plugins") });
    const skill = await fsp.readFile(path.join(out, "skills", "poteto-mode", "SKILL.md"), "utf8");
    assert.doesNotMatch(skill, /disable-model-invocation/);
    assert.equal(frontmatterField(skill, "description"), "poteto's agent style. Use for /poteto-mode.");
    assert.equal(skill.split("\n---\n")[1], before.split("\n---\n")[1], "the body is unchanged");
    assert.match(skill, /mode: true/);
    // Links inside a skill still resolve from the mirror.
    assert.equal(await fsp.readFile(path.join(out, "skills", "poteto-mode", "..", "principle-fix-root-causes", "SKILL.md"), "utf8").then((t) => frontmatterField(t, "description")), "Apply when debugging. Trace each symptom to its root.");
    assert.equal(await fsp.readFile(path.join(out, "skills", "poteto-mode", "playbooks", "bug.md"), "utf8"), "Reproduce first.\n");
    assert.equal(await fsp.readFile(path.join(out, "README.md"), "utf8"), "pstack readme\n");
    assert.equal(JSON.parse(await fsp.readFile(path.join(out, ".grok-plugin", "plugin.json"), "utf8")).name, "pstack");
    assert.equal(await fsp.readFile(path.join(src, "skills", "poteto-mode", "SKILL.md"), "utf8"), before, "vendored file untouched");
    // Same pstack, same folder; a changed pstack gets a new one and the old stays for running processes.
    assert.equal(await buildSkillPlugin(src, { root: path.join(dir, "plugins") }), out);
    await fsp.appendFile(path.join(src, "skills", "principle-fix-root-causes", "SKILL.md"), "More.\n");
    const next = await buildSkillPlugin(src, { root: path.join(dir, "plugins") });
    assert.notEqual(next, out);
    assert.match(await fsp.readFile(path.join(next, "skills", "principle-fix-root-causes", "SKILL.md"), "utf8"), /More\./);
    await fsp.access(path.join(out, "skills", "poteto-mode", "SKILL.md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the skill picker lists Grok's skills, never its built-in commands", () => {
  const list = skillsFromCommands([
    { name: "always-approve", description: "Toggle always-approve mode", input: { hint: "on|off" } },
    { name: "deep-research", description: "Research", _meta: { workflowSource: "builtin", workflowPath: "/x/deep-research.rhai" } },
    { name: "user:interrogate", description: "Mine", _meta: { scope: "user", path: "/home/j/.grok/skills/interrogate/SKILL.md" } },
    { name: "tdd", description: "Use only when\n the user asks for TDD.", _meta: { scope: "local", path: "/d/plugins/pstack-0123456789ab/skills/tdd/SKILL.md" } },
    { name: "pstack:interrogate", description: "pstack's", _meta: { scope: "local", path: "/d/plugins/pstack-0123456789ab/skills/interrogate/SKILL.md" } },
  ]);
  assert.deepEqual(list.map((s) => [s.name, s.source]), [["pstack:interrogate", "pstack"], ["tdd", "pstack"], ["user:interrogate", "user"]]);
  assert.equal(list[1].description, "Use only when the user asks for TDD.");
  assert.deepEqual(skillsFromCommands(null), []);
});
