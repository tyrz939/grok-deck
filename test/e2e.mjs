// End-to-end tests against a real server on a spare port, with a fake Grok (test/fake-grok.mjs).
// Run: node test/e2e.mjs   (PORT defaults to 8799; uses a fresh temp data dir, never the live data/)
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT || 8799);
const BASE = "http://127.0.0.1:" + PORT;
const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), "gm-e2e-"));
const DATA = path.join(tmp, "data");
const GHOME = path.join(tmp, "grokhome");
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(GHOME, { recursive: true });
fs.chmodSync(path.join(here, "fake-grok.mjs"), 0o755);

// LAN HTTPS listener: a throwaway self-signed cert in the temp data dir, bound to this machine's real LAN IPv4.
const TLS_PORT = Number(process.env.E2E_TLS_PORT || 8798);
const LAN_IP = Object.values(os.networkInterfaces()).flat().find((i) => i && (i.family === "IPv4" || i.family === 4) && !i.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address))?.address || "";
if (LAN_IP) {
  fs.mkdirSync(path.join(DATA, "tls"), { recursive: true, mode: 0o700 });
  execSync(`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout key.pem -out cert.pem -days 1 -subj /CN=e2e -addext subjectAltName=IP:${LAN_IP}`, { cwd: path.join(DATA, "tls"), stdio: "ignore" });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let logText = "";
function startServer() {
  server = spawn(process.execPath, [path.join(here, "..", "server.js")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TLS_PORT: String(TLS_PORT),
      GM_TLS_ADDRS: LAN_IP,
      DATA_DIR: DATA,
      GROK_HOME: GHOME,
      GROK_BIN: path.join(here, "fake-grok.mjs"),
      GM_WATCHDOG_MS: "1000",
      GM_LONGRUN_STALL_MS: "4000",
      GM_LONGRUN_TOOL_QUIET_MS: "60000",
      GM_LONGRUN_NEXT_MS: "300",
      GM_SKEPTIC_COOLDOWN_MS: "0",
      GM_STALL_MS: "6000",
      GM_STALL_CHECK_MS: "500",
      GM_RESUME_DELAY_MS: "300",
      GM_ACP_SETUP_TIMEOUT_MS: "2000",
      GM_QUEUE_RETRY_MS: "500",
      GM_QUEUE_SWEEP_MS: "1000",
      GM_SSE_PING_MS: "1000",
      GM_LOOP_MINUTE_MS: "200", // a 5 min loop fires every second
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (d) => (logText += d));
  server.stderr.on("data", (d) => (logText += d));
}
async function waitFor(fn, ms = 15000, label = "condition") {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error("timed out waiting for " + label + (last instanceof Error ? ": " + last.message : ""));
}

let cookie = "";
async function api(method, url, body, headers = {}) {
  const res = await fetch(BASE + url, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: res.status, json, res };
}
const session = (id) => api("GET", "/api/sessions/" + id).then((r) => r.json);
const idle = (id) => waitFor(async () => !(await session(id)).running, 20000, "turn to finish");
const spawns = () => (fs.existsSync(path.join(GHOME, "spawns.log")) ? fs.readFileSync(path.join(GHOME, "spawns.log"), "utf8").trim().split("\n").length : 0);
const prompts = (id) => (fs.existsSync(path.join(GHOME, "prompts.log")) ? fs.readFileSync(path.join(GHOME, "prompts.log"), "utf8").split("\n").filter((l) => l.startsWith(id)) : []);
const runFile = (id) => JSON.parse(fs.readFileSync(path.join(DATA, "longrun", id + ".json"), "utf8"));
function project(name, { git = false, goal = "", turns = [] } = {}) {
  const dir = path.join(tmp, "proj", name);
  fs.mkdirSync(dir, { recursive: true });
  if (goal) fs.writeFileSync(path.join(dir, "GOAL.md"), goal);
  fs.writeFileSync(path.join(dir, "PROGRESS.md"), "# Progress\n");
  fs.writeFileSync(path.join(dir, "fake-turns.json"), JSON.stringify(turns));
  if (git) execSync("git init -q && git -c user.email=t@t -c user.name=t add -A && git -c user.email=t@t -c user.name=t commit -qm init", { cwd: dir });
  if (git) execSync("git config user.email t@t && git config user.name t", { cwd: dir });
  return dir;
}
async function readStream(id, after, stopWhen, ms = 15000) {
  const res = await fetch(BASE + "/api/sessions/" + id + "/stream?after=" + after, { headers: { Cookie: cookie } });
  const reader = res.body.getReader();
  const rows = [];
  let buf = "";
  const end = Date.now() + ms;
  try {
    while (Date.now() < end) {
      const { value, done } = await Promise.race([reader.read(), sleep(end - Date.now()).then(() => ({ done: true }))]);
      if (done) break;
      buf += Buffer.from(value).toString("utf8");
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const id = Number((frame.match(/^id: (\d+)/m) || [])[1] || 0);
        const data = (frame.match(/^data: (.*)$/m) || [])[1];
        if (data) rows.push({ id, ev: JSON.parse(data) });
      }
      if (stopWhen(rows)) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return rows;
}

const results = [];
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push(["PASS", name, Date.now() - t]);
  } catch (error) {
    results.push(["FAIL", name, Date.now() - t, error.message]);
  }
  console.log(results.at(-1).slice(0, 2).join("  ") + (results.at(-1)[3] ? "  -> " + results.at(-1)[3] : ""));
}

if (await fetch(BASE + "/api/health").then(() => true, () => false)) {
  console.error("Port " + PORT + " is already in use; stop that server or set E2E_PORT.");
  process.exit(2);
}
startServer();
try {
  await waitFor(() => fetch(BASE + "/api/health").then((r) => r.ok), 10000, "server");
  const setup = await api("POST", "/api/auth/setup", { password: "test-password-123" });
  cookie = setup.res.headers.get("set-cookie").split(";")[0];
  const plain = project("plain");

  let sid;
  await check("turn runs and the Grok process is reused for the next turn", async () => {
    const r = await api("POST", "/api/turns", { cwd: plain, prompt: "[[say hello]]", permissionMode: "default" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    sid = r.json.sessionId;
    await idle(sid);
    const before = spawns();
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[say again]]" });
    await idle(sid);
    assert.equal(spawns(), before, "second turn spawned a new grok");
    assert.match(logText, /start .* reuse/);
  });

  await check("proof line: edits with no check warn; a passing check after the edit is shown as checked", async () => {
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[edit app.js]][[say done]]" });
    await idle(sid);
    const warn = (await session(sid)).messages.filter((m) => m.role === "status" && m.tone);
    assert.equal(warn.at(-1)?.tone, "warn", JSON.stringify(warn));
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[edit app.js]][[run cat app.js]][[run true]][[say done]]" });
    await idle(sid);
    const noop = (await session(sid)).messages.filter((m) => m.role === "status" && m.tone);
    assert.equal(noop.at(-1)?.tone, "warn", "true and cat are not checks: " + noop.at(-1)?.text);
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[edit app.js]][[run test -f app.js]][[say done]]" });
    await idle(sid);
    const ok = (await session(sid)).messages.filter((m) => m.role === "status" && m.tone);
    assert.equal(ok.at(-1)?.tone, "ok");
    assert.match(ok.at(-1).text, /test -f app.js/);
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[say just a question]]" });
    await idle(sid);
    assert.equal((await session(sid)).messages.filter((m) => m.role === "status" && m.tone).length, 3, "a turn without edits got a proof line");
  });

  await check("proof line: a turn that only changed notes (*.md, *.txt, topics/) gets no warning; code still does", async () => {
    const dir = project("notes-only");
    fs.mkdirSync(path.join(dir, "topics"), { recursive: true });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[edit topics/notes]][[edit PROGRESS.md]][[edit notes.txt]][[say noted]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await idle(id);
    assert.equal((await session(id)).messages.filter((m) => m.role === "status" && m.tone).length, 0, "notes-only turn was flagged");
    await api("POST", "/api/turns", { sessionId: id, prompt: "[[edit PLAN.md]][[edit main.py]][[say done]]" });
    await idle(id);
    const warn = (await session(id)).messages.filter((m) => m.role === "status" && m.tone);
    assert.equal(warn.at(-1)?.tone, "warn", "a code edit must still warn");
  });

  await check("crash mid-turn: Grok exiting is resumed automatically in the same session", async () => {
    const dir = project("crash", { turns: ["[[die 1]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say working]][[die 1]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await waitFor(() => prompts(id).some((l) => /was interrupted \(Grok exited mid-turn\)/.test(l)), 15000, "resume prompt");
    await idle(id);
    assert.match(logText, new RegExp("recover " + id + " resumed"));
  });

  await check("crash loop: resumes stop at the cap instead of looping forever", async () => {
    const dir = project("crashloop", { turns: ["[[die 1]]", "[[die 1]]", "[[die 1]]", "[[die 1]]", "[[die 1]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[die 1]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await waitFor(() => new RegExp("recover " + id + " resume cap reached").test(logText), 20000, "cap");
    assert.equal(prompts(id).filter((l) => /was interrupted/.test(l)).length, 3);
  });

  await check("stall watchdog: a silent Grok is restarted and the session resumed; compaction is not a stall", async () => {
    const dir = project("stall", { turns: ["[[say back after the stall]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say start]][[hang]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await waitFor(() => prompts(id).some((l) => /went quiet and was restarted/.test(l)), 20000, "stall resume");
    await idle(id);
    assert.match(JSON.stringify((await session(id)).messages), /back after the stall/);
    const c = await api("POST", "/api/turns", { cwd: project("compact"), prompt: "[[compact 8000]][[say compacted fine]]", permissionMode: "bypassPermissions" });
    await idle(c.json.sessionId);
    assert.equal(prompts(c.json.sessionId).filter((l) => /interrupted/.test(l)).length, 0, "compaction was treated as a stall");
  });

  await check("ACP timeout: a Grok that never answers initialize fails the start instead of wedging the session", async () => {
    fs.writeFileSync(path.join(GHOME, "hang-initialize"), "");
    try {
      const t = Date.now();
      const r = await api("POST", "/api/turns", { cwd: project("hanginit"), prompt: "[[say x]]" });
      assert.equal(r.status, 502, JSON.stringify(r.json));
      assert.ok(Date.now() - t < 8000, "took " + (Date.now() - t) + "ms");
      assert.match(logText, /agent start failed Grok did not answer initialize/);
    } finally {
      fs.rmSync(path.join(GHOME, "hang-initialize"), { force: true });
    }
  });

  await check("auto approve saved on the session approves at once, even when the turn started before it was set", async () => {
    const dir = project("autosaved");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hi]]", permissionMode: "default" });
    const id = r.json.sessionId;
    await idle(id);
    await api("POST", "/api/turns", { sessionId: id, prompt: "[[sleep 600]][[perm]]" });
    await api("PATCH", "/api/sessions/" + id, { autoApprove: ["all"] }); // set while the turn runs (another device)
    await idle(id);
    assert.match(JSON.stringify((await session(id)).messages), /permission:allow/);
  });

  await check("Send now: queue + /now interrupts the running turn and sends that message next", async () => {
    const dir = project("send-now");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[sleep 8000]][[say SLOW]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await sleep(400);
    const q = await api("POST", "/api/sessions/" + id + "/queue", { prompt: "[[say SENT-NOW]]" });
    assert.equal(q.status, 200);
    const now = await api("POST", "/api/sessions/" + id + "/queue/" + q.json.id + "/now", {});
    assert.equal(now.status, 200);
    await idle(id);
    // Drain can start the promoted message after the cancel; wait for it to finish too.
    await waitFor(async () => JSON.stringify((await session(id)).messages).includes("SENT-NOW"), 20000, "send-now message ran");
    await idle(id);
    const blob = JSON.stringify((await session(id)).messages);
    assert.match(blob, /SENT-NOW/);
  });

  await check("a queued message whose start fails is retried, not stranded", async () => {
    const dir = project("queue-retry", { turns: [] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say first]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await idle(id);
    await api("POST", "/api/turns", { sessionId: id, prompt: "[[sleep 600]][[say busy]]" });
    fs.writeFileSync(path.join(GHOME, "hang-initialize"), "");
    // Force a fresh Grok process for the queued send so its start fails while initialize hangs.
    await api("PATCH", "/api/sessions/" + id, { permissionMode: "auto" });
    const q = await api("POST", "/api/sessions/" + id + "/queue", { prompt: "[[say QUEUED-RETRY]]" });
    assert.equal(q.status, 200);
    await waitFor(() => /queue send failed/.test(logText), 15000, "first queued start fails");
    fs.rmSync(path.join(GHOME, "hang-initialize"), { force: true });
    await waitFor(async () => JSON.stringify((await session(id)).messages).includes("QUEUED-RETRY"), 20000, "queued message retried");
  });

  await check("SSE: a running turn's stream carries pings so a dead socket is noticed", async () => {
    const dir = project("ping");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[sleep 2500]][[say pinged]]", permissionMode: "bypassPermissions" });
    const rows = await readStream(r.json.sessionId, 0, (rs) => rs.some((x) => x.ev.type === "ping"), 5000);
    assert.ok(rows.some((x) => x.ev.type === "ping"), "no ping frame");
    await idle(r.json.sessionId);
  });

  await check("two concurrent sends start one turn (start race)", async () => {
    const before = spawns();
    const [a, b] = await Promise.all([
      api("POST", "/api/turns", { sessionId: sid, prompt: "[[sleep 800]][[say one]]" }),
      api("POST", "/api/turns", { sessionId: sid, prompt: "[[sleep 800]][[say two]]" }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    await idle(sid);
    assert.equal(spawns(), before);
  });

  await check("SSE ids grow across turns; a stale cursor still gets the whole next turn", async () => {
    const first = (await session(sid)).cursor;
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[say first-of-new-turn]][[sleep 300]][[say second]]" });
    const rows = await readStream(sid, first, (rs) => rs.some((r) => r.ev.type === "settled"));
    assert.ok(rows.length && rows.every((r) => r.id > first), "ids not above previous cursor");
    assert.ok(rows.some((r) => r.ev.type === "text" && /first-of-new-turn/.test(r.ev.data)), "missed the start of the turn");
    await idle(sid);
  });

  await check("Grok waking itself opens a turn that finishes (turn_completed via session_notification)", async () => {
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[say started bg]][[wake 1200 BACKGROUND-DONE]]" });
    await idle(sid);
    await waitFor(() => /start wake/.test(logText), 5000, "wake turn");
    await waitFor(async () => {
      const s = await session(sid);
      return !s.running && JSON.stringify(s.messages).includes("BACKGROUND-DONE");
    }, 8000, "wake turn to finish");
    const health = (await api("GET", "/api/health")).json;
    assert.equal(health.busy, 0);
  });

  await check("origin and host guard", async () => {
    assert.equal((await api("POST", "/api/sessions/" + sid + "/cancel", {}, { Origin: "http://evil.example" })).status, 403);
    assert.equal((await api("POST", "/api/sessions/" + sid + "/cancel", {}, { "Sec-Fetch-Site": "same-site" })).status, 403);
    const rebinding = await new Promise((resolve) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: PORT, path: "/api/health", headers: { Host: "attacker.example" } }, (res) => resolve(res.statusCode));
        req.end();
      });
    });
    assert.equal(rebinding, 403);
    const tsnet = await new Promise((resolve) => {
      import("node:http").then(({ request }) => {
        const req = request({ host: "127.0.0.1", port: PORT, path: "/api/health", headers: { Host: "evil.example.ts.net" } }, (res) => resolve(res.statusCode));
        req.end();
      });
    });
    assert.equal(tsnet, 403);
    assert.equal((await api("POST", "/api/sessions/" + sid + "/cancel", {}, { Origin: BASE })).status, 409); // same origin passes the guard
  });

  const raw = (mod, opts) => new Promise((resolve) => {
    import(mod).then(({ request }) => {
      const req = request({ rejectUnauthorized: false, timeout: 3000, ...opts }, (res) => {
        res.resume();
        resolve({ status: res.statusCode, headers: res.headers, encrypted: Boolean(res.socket?.encrypted) });
      });
      req.on("error", (error) => resolve({ error: error.code || error.message }));
      req.on("timeout", () => req.destroy(new Error("timeout")));
      if (opts.body) req.write(opts.body);
      req.end();
    });
  });
  await check("LAN: HTTPS listener serves the app on the LAN IP", async () => {
    assert.ok(LAN_IP, "no LAN IPv4 on this machine");
    const r = await raw("node:https", { host: LAN_IP, port: TLS_PORT, path: "/", headers: { Host: LAN_IP + ":" + TLS_PORT } });
    assert.equal(r.status, 200, JSON.stringify(r));
    assert.equal(r.encrypted, true);
    assert.match(String(r.headers["strict-transport-security"]), /max-age/);
  });

  await check("LAN: plain HTTP to the LAN IP is refused", async () => {
    const http1 = await raw("node:http", { host: LAN_IP, port: PORT, path: "/api/health" });
    assert.ok(http1.error, "plain HTTP on the app port answered: " + JSON.stringify(http1));
    const http2 = await raw("node:http", { host: LAN_IP, port: TLS_PORT, path: "/api/health", headers: { Host: LAN_IP + ":" + TLS_PORT } });
    assert.ok(http2.error || http2.status === 400, "plain HTTP on the TLS port answered: " + JSON.stringify(http2));
    assert.notEqual(http2.status, 200);
  });

  await check("LAN: host guard on the TLS listener", async () => {
    for (const host of ["attacker.example", LAN_IP + ":" + PORT, "myhost.example.ts.net", "localhost:" + TLS_PORT]) {
      const r = await raw("node:https", { host: LAN_IP, port: TLS_PORT, path: "/api/health", headers: { Host: host } });
      assert.equal(r.status, 403, host);
    }
    for (const host of [os.hostname() + ":" + TLS_PORT, os.hostname() + ".local:" + TLS_PORT, LAN_IP + ":" + TLS_PORT]) {
      const r = await raw("node:https", { host: LAN_IP, port: TLS_PORT, path: "/api/health", headers: { Host: host } });
      assert.equal(r.status, 200, host);
    }
  });

  await check("cookie is Secure on TLS and via loopback X-Forwarded-Proto, not on plain HTTP", async () => {
    const body = JSON.stringify({ password: "test-password-123" });
    const opts = { method: "POST", path: "/api/auth/login", body, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } };
    const tls = await raw("node:https", { ...opts, host: LAN_IP, port: TLS_PORT, headers: { ...opts.headers, Host: LAN_IP + ":" + TLS_PORT } });
    assert.equal(tls.status, 200, JSON.stringify(tls));
    assert.match(String(tls.headers["set-cookie"]), /;\s*Secure/i);
    const proxied = await raw("node:http", { ...opts, host: "127.0.0.1", port: PORT, headers: { ...opts.headers, "X-Forwarded-Proto": "https" } });
    assert.equal(proxied.status, 200);
    assert.match(String(proxied.headers["set-cookie"]), /;\s*Secure/i);
    const plainHttp = await raw("node:http", { ...opts, host: "127.0.0.1", port: PORT });
    assert.equal(plainHttp.status, 200);
    assert.doesNotMatch(String(plainHttp.headers["set-cookie"]), /Secure/i);
  });

  await check("Ask mode: approval reaches the app; Auto approve for edits does not approve commands", async () => {
    await api("PATCH", "/api/sessions/" + sid, { autoApprove: ["edit"], permissionMode: "default" });
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[perm]]" });
    const rows = await readStream(sid, 0, (rs) => rs.some((r) => r.ev.type === "permission"), 8000);
    const perm = rows.find((r) => r.ev.type === "permission");
    assert.ok(perm, "no permission request reached the app");
    const ans = await api("POST", "/api/sessions/" + sid + "/permission", { reqId: perm.ev.reqId, decision: "once" });
    assert.equal(ans.status, 200);
    await idle(sid);
    assert.match(JSON.stringify((await session(sid)).messages), /permission:allow/);
    await api("PATCH", "/api/sessions/" + sid, { autoApprove: [] });
  });

  const GOAL = "# Goal\nship it\n\n## Checks\n- `test -f ok.txt`\n- `grep -q yes ok.txt`\n";
  await check("long run (always-approve): DONE is rejected until GOAL.md checks pass", async () => {
    const dir = project("gate", { git: true, goal: GOAL, turns: ["[[write ok.txt yes]][[commit fix]][[say fixed it\\nLONGRUN: DONE]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say claim\\nLONGRUN: DONE]]", permissionMode: "bypassPermissions", longRun: { hours: 1 } });
    const id = r.json.sessionId;
    await waitFor(() => runFile(id).status === "done", 20000, "run done");
    const p = prompts(id);
    assert.ok(p.some((l) => /was not accepted/.test(l) && /test -f ok.txt/.test(l)), "rejection prompt missing");
    assert.match(runFile(id).note, /2\/2 checks passed/);
  });

  await check("long run (Ask mode): DONE needs the checks' real exit codes from the turn", async () => {
    const dir = project("gate-ask", {
      git: true,
      goal: GOAL,
      turns: ["[[exec 1 test -f ok.txt]][[say LONGRUN: DONE]]", "[[write ok.txt yes]][[run test -f ok.txt]][[run cd . && grep -q yes ok.txt]][[say LONGRUN: DONE]]"],
    });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say LONGRUN: DONE]]", permissionMode: "default", longRun: { hours: 1 } });
    const id = r.json.sessionId;
    await waitFor(() => runFile(id).status === "done", 20000, "run done");
    assert.equal(prompts(id).filter((l) => /was not accepted/.test(l)).length, 2);
    assert.match(runFile(id).note, /exit codes read from the turn/);
  });

  await check("long run (Ask mode): a check before a later edit does not count", async () => {
    const dir = project("gate-stale", {
      git: true,
      goal: GOAL,
      turns: ["[[write ok.txt yes]][[run test -f ok.txt]][[run grep -q yes ok.txt]][[say LONGRUN: DONE]]"],
    });
    const r = await api("POST", "/api/turns", {
      cwd: dir,
      prompt: "[[write ok.txt yes]][[run test -f ok.txt]][[run grep -q yes ok.txt]][[write ok.txt no]][[say LONGRUN: DONE]]",
      permissionMode: "default",
      longRun: { hours: 1 },
    });
    const id = r.json.sessionId;
    await waitFor(() => runFile(id).status === "done", 20000, "run done");
    assert.ok(prompts(id).some((l) => /was not accepted/.test(l)), "stale checks were accepted");
    assert.equal(fs.readFileSync(path.join(dir, "ok.txt"), "utf8").trim(), "yes");
  });

  await check("'LONGRUN: CONTINUE (not DONE yet)' is a CONTINUE", async () => {
    const dir = project("parse", { git: true, goal: GOAL, turns: ["[[write a.txt 1]][[say LONGRUN: BLOCKED need a key]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say LONGRUN: CONTINUE (not DONE yet)]]", permissionMode: "bypassPermissions", longRun: { hours: 1 } });
    const id = r.json.sessionId;
    await waitFor(() => runFile(id).status === "blocked", 15000, "blocked");
    assert.ok(!prompts(id).some((l) => /not accepted/.test(l)), "CONTINUE line was treated as DONE");
    assert.equal(runFile(id).note, "need a key");
    const resumed = await api("POST", "/api/sessions/" + id + "/longrun", { action: "resume" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.json));
    const stopped = await api("POST", "/api/sessions/" + id + "/longrun", { action: "stop" });
    assert.equal(stopped.status, 200);
    assert.equal(runFile(id).status, "stopped");
  });

  await check("no progress for 3 turns pauses the run; an uncommitted edit counts as progress", async () => {
    const c = "[[say nothing new\\nLONGRUN: CONTINUE]]";
    const dir = project("idle", { git: true, goal: GOAL, turns: [c, "[[write notes.txt edited]][[say LONGRUN: CONTINUE]]", c, c, c, c, c] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: c, permissionMode: "bypassPermissions", longRun: { hours: 1 } });
    const id = r.json.sessionId;
    await waitFor(() => runFile(id).status === "paused", 25000, "paused");
    assert.match(runFile(id).note, /no progress|no new commit/i);
    assert.equal(prompts(id).length, 6, "expected pause after turn 6 (turn 3 edited a file)");
  });

  await check("watchdog: a quiet tool and a pending approval are not stalls; a silent turn is restarted", async () => {
    const dir = project("dog", { git: true, goal: GOAL, turns: ["[[sleep 9000]][[say LONGRUN: CONTINUE]]", "[[write x.txt 1]][[say LONGRUN: BLOCKED stop here]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[quiettool 7000]][[perm]][[say LONGRUN: CONTINUE]]", permissionMode: "default", longRun: { hours: 1 } });
    const id = r.json.sessionId;
    const rows = await readStream(id, 0, (rs) => rs.some((x) => x.ev.type === "permission"), 15000);
    await sleep(6000); // approval pending well past the 4 s stall limit
    assert.equal(runFile(id).resumes, 0, "restarted during the quiet tool or the approval wait");
    await api("POST", "/api/sessions/" + id + "/permission", { reqId: rows.find((x) => x.ev.type === "permission").ev.reqId, decision: "once" });
    await waitFor(() => /stalled turn/.test(runFile(id).note) || runFile(id).status === "blocked", 20000, "watchdog restart");
    await waitFor(() => runFile(id).status === "blocked", 20000, "blocked");
    assert.ok(runFile(id).resumes >= 1, "silent turn was not restarted");
  });


  const loopsOf = (id) => api("GET", "/api/sessions/" + id + "/loops").then((r) => r.json.loops || []);
  const loopCmd = (id, command) => api("POST", "/api/sessions/" + id + "/loops", { command });
  const loopPrompts = (id) => prompts(id).filter((l) => /Loop run \d+/.test(l));

  await check("loop: /loop runs on the interval, labels each run, stops at max runs; under 5 min is refused", async () => {
    const dir = project("loop-max");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hi]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await idle(id);
    assert.equal((await loopCmd(id, "/loop 4m [[say too fast]]")).status, 400);
    assert.equal((await loopCmd(id, "/loop [[say no interval]]")).status, 400);
    const made = await loopCmd(id, "/loop 5m x3 [[say tick]]");
    assert.equal(made.status, 200, JSON.stringify(made.json));
    assert.equal(made.json.loop.maxRuns, 3);
    await waitFor(async () => (await loopsOf(id))[0]?.status === "done", 20000, "loop done");
    await idle(id);
    await sleep(1500);
    const lp = loopPrompts(id);
    assert.equal(lp.length, 3, lp.join("|"));
    assert.match(lp[0], /Loop run 1 of 3/);
    assert.match(lp[2], /Loop run 3 of 3/);
    const msgs = JSON.stringify((await session(id)).messages);
    assert.match(msgs, /Loop run 2 of 3/, "label missing from the chat");
    assert.match((await loopsOf(id))[0].note, /Reached 3 runs/);
  });

  await check("loop: a due run while busy waits as Send next, never interrupts and never stacks", async () => {
    const dir = project("loop-busy");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say first]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await idle(id);
    await api("POST", "/api/turns", { sessionId: id, prompt: "[[sleep 5000]][[say SLOW-DONE]]" });
    await sleep(300);
    const made = await loopCmd(id, "/loop 5m [[say looped]]");
    assert.equal(made.status, 200);
    await sleep(3500); // three or more due times pass while the slow turn runs
    const q = (await session(id)).queue;
    assert.equal(q.filter((i) => i.loop).length, 1, "loop runs stacked: " + JSON.stringify(q));
    assert.ok((await loopsOf(id))[0].skipped >= 2, "due times while waiting should be skipped");
    await waitFor(() => loopPrompts(id).length >= 1, 15000, "loop run sent after the turn");
    const blob = JSON.stringify((await session(id)).messages);
    assert.match(blob, /SLOW-DONE/, "the running turn was interrupted");
    assert.equal((await api("DELETE", "/api/sessions/" + id + "/loops/" + made.json.loop.id)).status, 200);
    assert.equal((await loopsOf(id)).length, 0);
    await idle(id);
  });

  await check("loop: 'until DONE' stops when the reply contains DONE; pause and resume work", async () => {
    const dir = project("loop-done");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hi]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await idle(id);
    const made = await loopCmd(id, "/loop 5m until DONE [[say all DONE here]]");
    assert.equal(made.json.loop.untilDone, true);
    await waitFor(async () => (await loopsOf(id))[0]?.status === "done", 15000, "done");
    await sleep(2000);
    assert.equal(loopPrompts(id).length, 1, "kept running after DONE");
    const lid = (await loopsOf(id))[0].id;
    const p2 = await loopCmd(id, "/loop 10m [[say paused one]]");
    const pid = p2.json.loop.id;
    await idle(id);
    const paused = await api("PATCH", "/api/sessions/" + id + "/loops/" + pid, { action: "pause" });
    assert.equal(paused.json.loop.status, "paused");
    const n = loopPrompts(id).length;
    await sleep(3000);
    assert.equal(loopPrompts(id).length, n, "a paused loop ran");
    const resumed = await api("PATCH", "/api/sessions/" + id + "/loops/" + pid, { action: "resume" });
    assert.equal(resumed.json.loop.status, "active");
    assert.ok(resumed.json.loop.nextAt > Date.now());
    await waitFor(() => loopPrompts(id).length > n, 10000, "resumed loop ran");
    assert.equal((await loopCmd(id, "/loop stop")).json.removed, 2);
    await idle(id);
    void lid;
  });

  await check("loop: loops persist in data/loops.json and are rescheduled after a restart", async () => {
    const dir = project("loop-restart");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hi]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await idle(id);
    const made = await loopCmd(id, "/loop 15m x4 [[say persisted]]"); // 3 s apart in the test
    await waitFor(() => loopPrompts(id).length >= 1, 10000, "first run");
    await idle(id);
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    const saved = JSON.parse(fs.readFileSync(path.join(DATA, "loops.json"), "utf8"));
    assert.ok(saved.loops.some((l) => l.id === made.json.loop.id && l.runs >= 1), "loop not saved");
    startServer();
    await waitFor(() => fetch(BASE + "/api/health").then((x) => x.ok), 10000, "server back");
    assert.equal((await loopsOf(id))[0]?.id, made.json.loop.id);
    await waitFor(async () => (await loopsOf(id))[0]?.status === "done", 30000, "loop finished after restart");
    await idle(id);
    await sleep(800);
    assert.equal(loopPrompts(id).length, 4, loopPrompts(id).join("|"));
  });

  await check("queued messages survive a restart and still send; bad images are refused at queue time", async () => {
    await api("POST", "/api/turns", { sessionId: sid, prompt: "[[sleep 4000]][[say busy]]" });
    const q = await api("POST", "/api/sessions/" + sid + "/queue", { prompt: "[[say FROM-QUEUE]]" });
    assert.equal(q.status, 200);
    const bad = await api("POST", "/api/sessions/" + sid + "/queue", { prompt: "x", images: [{ mime: "image/png", data: "AAAA" }] });
    assert.equal(bad.status, 400);
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    assert.match(fs.readFileSync(path.join(DATA, "queue.json"), "utf8"), /FROM-QUEUE/);
    startServer();
    await waitFor(() => fetch(BASE + "/api/health").then((x) => x.ok), 10000, "server back");
    await waitFor(async () => JSON.stringify((await session(sid)).messages).includes("FROM-QUEUE"), 20000, "queued message sent after restart");
    await idle(sid);
    assert.equal(fs.readFileSync(path.join(DATA, "queue.json"), "utf8"), "{}");
  });

  await check("a service restart mid-turn resumes the interrupted (non long-run) turn", async () => {
    const dir = project("restart-turn", { turns: ["[[say resumed after restart]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say working]][[sleep 20000]]", permissionMode: "bypassPermissions" });
    const id = r.json.sessionId;
    await sleep(800);
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    assert.match(fs.readFileSync(path.join(DATA, "running-turns.json"), "utf8"), new RegExp(id));
    startServer();
    await waitFor(() => fetch(BASE + "/api/health").then((x) => x.ok), 10000, "server back");
    await waitFor(() => prompts(id).some((l) => /service restarted/.test(l)), 15000, "resumed after restart");
    await idle(id);
    assert.match(JSON.stringify((await session(id)).messages), /resumed after restart/);
  });

  await check("a service restart leaves a running long run running, and it resumes", async () => {
    const dir = project("restart", { git: true, goal: GOAL, turns: ["[[write r.txt 1]][[say LONGRUN: BLOCKED resumed ok]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say working]][[sleep 20000]]", permissionMode: "bypassPermissions", longRun: { hours: 1 } });
    const id = r.json.sessionId;
    await sleep(800);
    server.kill("SIGTERM");
    await new Promise((resolve) => server.once("exit", resolve));
    assert.equal(runFile(id).status, "running");
    assert.ok(runFile(id).usedTokens > 0, "tokens of the interrupted turn were not counted");
    startServer();
    await waitFor(() => fetch(BASE + "/api/health").then((x) => x.ok), 10000, "server back");
    await waitFor(() => runFile(id).status === "blocked", 20000, "resumed after restart");
    assert.equal(runFile(id).note, "resumed ok");
  });

  // ---- Skeptical review (fake reviewer: test/fake-grok.mjs, verdict chosen by SKFAKE:<kind> in the agent's message) ----
  const skLog = () => (fs.existsSync(path.join(GHOME, "skeptic.log")) ? fs.readFileSync(path.join(GHOME, "skeptic.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const skState = async (id) => (await session(id)).skeptic;
  const skProject = (name, extra = {}) => project(name, { git: true, ...extra });
  const skTurn = async (dir, say, extra = {}) => {
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[edit app.js]]" + (extra.run === false ? "" : "[[run test -f app.js]]") + "[[say " + say + "]]", permissionMode: "default", ...extra.body });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await idle(r.json.sessionId);
    return r.json.sessionId;
  };
  await api("PATCH", "/api/skeptic/settings", { mode: "off", maxPerHour: 60, autoLoop: false });

  await check("skeptic is off by default: no review, and a bad mode is ignored", async () => {
    const before = skLog().length;
    const id = await skTurn(skProject("sk-off"), "Done, fixed. SKFAKE:issues", { run: false });
    await sleep(800);
    assert.equal(skLog().length, before);
    assert.equal(await skState(id), null);
    const bad = await api("PATCH", "/api/skeptic/settings", { mode: "nonsense", maxRounds: 99 });
    assert.equal(bad.json.settings.mode, "off");
    assert.equal(bad.json.settings.maxRounds, 4);
  });

  let skId;
  await check("auto: an unverified 'done' is reviewed in a fresh process; Issues card, tokens and cost", async () => {
    await api("PATCH", "/api/skeptic/settings", { mode: "auto" });
    const before = skLog().length;
    skId = await skTurn(skProject("sk-issues"), "Done, fixed the crash. SKFAKE:issues", { run: false });
    const r = await waitFor(async () => {
      const s = await skState(skId);
      return s && s.state !== "running" && s;
    }, 15000, "skeptic verdict");
    assert.equal(r.state, "issues");
    assert.equal(r.issues.length, 1);
    assert.deepEqual(r.unverified, ["handles unicode"]);
    assert.equal(r.tokens, 1234);
    assert.ok(r.costUsd > 0);
    const calls = skLog().slice(before);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].argv.includes("--no-subagents") && !calls[0].argv.includes("--resume"), "reviewer must be fresh and without subagents");
    assert.ok(calls[0].argv.includes("--disallowed-tools"));
    assert.ok(!calls[0].argv.includes("bypassPermissions"), "reviewer must not run always-approve");
    assert.ok(calls[0].argv.includes("dontAsk"));
    assert.ok(calls[0].argv.includes("--json-schema"));
    assert.ok(calls[0].argv.includes("Bash(git status)"));
    assert.ok(calls[0].argv.includes("Bash(git commit)"));
    assert.equal(calls[0].argv.filter((arg) => arg === "--deny")[0], "--deny");
    assert.match(calls[0].packet, /Done, fixed the crash/);
    assert.match(calls[0].packet, /nothing ran after the last edit/i);
    assert.equal((await api("GET", "/api/sessions/" + skId + "/usage")).json.skeptic.reviews, 1);
  });

  await check("open chat watch receives the skeptic verdict", async () => {
    const dir = skProject("sk-watch");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[edit app.js]][[say Done. SKFAKE:wait]]", permissionMode: "default" });
    const id = started.json.sessionId;
    const res = await fetch(BASE + "/api/sessions/" + id + "/watch", { headers: { Cookie: cookie } });
    const reader = res.body.getReader();
    let buf = "";
    const frames = [];
    const end = Date.now() + 8000;
    try {
      while (Date.now() < end) {
        const { value, done } = await Promise.race([reader.read(), sleep(Math.max(1, end - Date.now())).then(() => ({ done: true }))]);
        if (done || !value) break;
        buf += Buffer.from(value).toString("utf8");
        let split;
        while ((split = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, split);
          buf = buf.slice(split + 2);
          const data = (frame.match(/^data: (.*)$/m) || [])[1];
          if (data) frames.push(JSON.parse(data));
        }
        if (frames.some((msg) => msg.what === "skeptic" && msg.review && msg.review.state === "pass")) break;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
    assert.ok(frames.some((msg) => msg.what === "skeptic" && msg.review && msg.review.state === "pass" && !("packet" in (msg.review || {}))), JSON.stringify(frames));
    await idle(id);
  });

  await check("send issues: a normal turn goes to Grok; the card says sent", async () => {
    const r = await api("POST", "/api/sessions/" + skId + "/skeptic", { action: "send" });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    await waitFor(() => prompts(skId).some((l) => /independent reviewer rechecked/.test(l) && /Empty input crashes/.test(l)), 10000, "issues prompt");
    await idle(skId);
    assert.equal((await skState(skId)).sent, true);
    const again = await api("POST", "/api/sessions/" + skId + "/skeptic", { action: "send" });
    assert.equal(again.status, 409);
  });

  await check("clean turns and docs-only turns are not reviewed", async () => {
    const before = skLog().length;
    await skTurn(skProject("sk-clean"), "Done. SKFAKE:issues");
    const dir = skProject("sk-docs");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[edit NOTES.md]][[say Done. SKFAKE:issues]]", permissionMode: "default" });
    await idle(r.json.sessionId);
    await sleep(800);
    assert.equal(skLog().length, before, "reviewed a turn that should be skipped");
  });

  await check("dismiss is sticky for the same diff; manual review still works; pass is a Pass", async () => {
    const id = await skTurn(skProject("sk-dismiss"), "Done. SKFAKE:issues", { run: false });
    await waitFor(async () => (await skState(id))?.state === "issues", 15000, "issues");
    const d = await api("POST", "/api/sessions/" + id + "/skeptic", { action: "dismiss" });
    assert.equal(d.json.skeptic.dismissed, true);
    const n = skLog().length;
    const m = await api("POST", "/api/sessions/" + id + "/skeptic", { action: "run" });
    assert.equal(m.status, 200);
    await waitFor(async () => skLog().length === n + 1 && (await skState(id)).state !== "running", 15000, "manual review");
    assert.equal((await skState(id)).trigger, "manual");
  });

  await check("bad reviewer output, issues without evidence and a tainted tree never block or mislead", async () => {
    const junk = await skTurn(skProject("sk-junk"), "Done. SKFAKE:junk", { run: false });
    await waitFor(async () => (await skState(junk))?.state === "error", 15000, "junk");
    assert.match((await skState(junk)).note, /did not return a verdict/);
    const vague = await skTurn(skProject("sk-vague"), "Done. SKFAKE:noevidence", { run: false });
    await waitFor(async () => (await skState(vague))?.state === "pass", 15000, "pass");
    assert.ok((await skState(vague)).unverified.some((u) => /Might be slow/.test(u)));
    const taint = await skTurn(skProject("sk-taint"), "Done. SKFAKE:taint", { run: false });
    await waitFor(async () => (await skState(taint))?.state === "error", 15000, "taint");
    assert.match((await skState(taint)).note, /Tainted/);
  });

  await check("cancel stops a running review; a new message cancels it too", async () => {
    const id = await skTurn(skProject("sk-slow"), "Done. SKFAKE:slow", { run: false });
    await waitFor(async () => (await skState(id))?.state === "running", 10000, "running");
    assert.ok((await api("GET", "/api/health")).json.busy >= 1, "a running review must count as busy so deploys wait");
    await api("POST", "/api/sessions/" + id + "/skeptic", { action: "cancel" });
    await waitFor(async () => (await skState(id)).state === "cancelled", 10000, "cancelled");
    const id2 = await skTurn(skProject("sk-slow2"), "Done. SKFAKE:slow", { run: false });
    await waitFor(async () => (await skState(id2))?.state === "running", 10000, "running 2");
    await api("POST", "/api/turns", { sessionId: id2, prompt: "[[say hi]]" });
    await waitFor(async () => (await skState(id2)).state === "cancelled", 10000, "cancelled by message");
    assert.match((await skState(id2)).note, /new message|new turn/);
  });

  await check("per-session mode overrides the app default", async () => {
    await api("PATCH", "/api/skeptic/settings", { mode: "off" });
    const before = skLog().length;
    const dir = skProject("sk-session-on");
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say first]]" });
    const id = r.json.sessionId;
    await idle(id);
    const p = await api("PATCH", "/api/sessions/" + id, { skeptic: "always" });
    assert.equal(p.json.session.skeptic, "always");
    await api("POST", "/api/turns", { sessionId: id, prompt: "[[edit app.js]][[run test -f app.js]][[say Done SKFAKE:pass]]" });
    await waitFor(async () => (await skState(id))?.state === "pass", 15000, "pass");
    assert.equal(skLog().length, before + 1);
    await api("PATCH", "/api/skeptic/settings", { mode: "auto" });
  });

  await check("auto-loop: issues go back by themselves, round 2 passes, and the loop stops", async () => {
    await api("PATCH", "/api/skeptic/settings", { autoLoop: true, maxRounds: 2 });
    const dir = skProject("sk-loop", { turns: ["[[edit app.js]][[say Fixed it. SKFAKE:fixed]]"] });
    const id = await skTurn(dir, "Done. SKFAKE:issues", { run: false });
    await waitFor(async () => (await skState(id))?.round === 2 && (await skState(id)).state === "pass", 25000, "round 2 pass");
    assert.ok(prompts(id).some((l) => /independent reviewer rechecked/.test(l)));
    await sleep(600);
    assert.equal((await skState(id)).state, "pass");
    await api("PATCH", "/api/skeptic/settings", { autoLoop: false });
  });

  await check("auto-loop stops at the round limit and says so", async () => {
    await api("PATCH", "/api/skeptic/settings", { autoLoop: true, maxRounds: 1 });
    const id = await skTurn(skProject("sk-limit", { turns: ["[[edit app.js]][[say again SKFAKE:issues]]"] }), "Done. SKFAKE:issues", { run: false });
    await waitFor(async () => (await skState(id))?.state === "issues" && /your call/.test((await skState(id)).note || ""), 15000, "round limit note");
    assert.equal(prompts(id).filter((l) => /independent reviewer rechecked/.test(l)).length, 0, "maxRounds 1 must not auto-send");
    await api("PATCH", "/api/skeptic/settings", { autoLoop: false });
  });

  await check("long run: DONE passes the checks, then the skeptic rejects it once, then accepts", async () => {
    await api("PATCH", "/api/skeptic/settings", { autoLoop: false, maxRounds: 2 });
    const dir = skProject("sk-long", { goal: GOAL, turns: ["[[write ok.txt yes]][[say fixed SKFAKE:fixed\\nLONGRUN: DONE]]"] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[write ok.txt yes]][[say claim SKFAKE:issues\\nLONGRUN: DONE]]", permissionMode: "bypassPermissions", longRun: { hours: 1 } });
    const id = r.json.sessionId;
    await waitFor(() => runFile(id).status === "done", 40000, "run done").catch((e) => { throw new Error(e.message + " " + JSON.stringify(runFile(id)).slice(0, 600) + " " + prompts(id).join("|").slice(-900)); });
    const p = prompts(id);
    assert.ok(p.some((l) => /independent skeptical reviewer/.test(l)), "skeptic rejection prompt missing");
    assert.match(runFile(id).note, /skeptic pass/);
    assert.ok(runFile(id).skepticTokens > 0);
    assert.equal(runFile(id).skepticRounds, 1);
  });

  await check("long run: a skeptic that keeps rejecting blocks the run for the user", async () => {
    await api("PATCH", "/api/skeptic/settings", { maxRounds: 1 });
    const dir = skProject("sk-long-block", { goal: GOAL, turns: [] });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[write ok.txt yes]][[say claim SKFAKE:issues\\nLONGRUN: DONE]]", permissionMode: "bypassPermissions", longRun: { hours: 1 } });
    await waitFor(() => runFile(r.json.sessionId).status === "blocked", 40000, "blocked");
    assert.match(runFile(r.json.sessionId).note, /Skeptic still disagrees/);
  });

  await check("long run with the skeptic off is unchanged", async () => {
    await api("PATCH", "/api/skeptic/settings", { mode: "off", maxRounds: 2 });
    const before = skLog().length;
    const dir = skProject("sk-long-off", { goal: GOAL });
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[write ok.txt yes]][[say claim SKFAKE:issues\\nLONGRUN: DONE]]", permissionMode: "bypassPermissions", longRun: { hours: 1 } });
    await waitFor(() => runFile(r.json.sessionId).status === "done", 30000, "done");
    assert.equal(skLog().length, before);
  });
} finally {
  server?.kill("SIGTERM");
  await sleep(500);
  if (!process.env.E2E_KEEP) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log("kept", tmp);
}
if (process.env.E2E_VERBOSE) console.log(logText.split("\n").filter((l) => new RegExp(process.env.E2E_VERBOSE).test(l)).join("\n"));
const failed = results.filter((r) => r[0] === "FAIL");
console.log("\n" + (results.length - failed.length) + "/" + results.length + " passed");
process.exit(failed.length ? 1 : 0);
