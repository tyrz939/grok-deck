// End-to-end tests against a real server on a spare port, with a fake Grok (test/fake-grok.mjs).
// Run: node test/e2e.mjs   (PORT defaults to 8799; uses a fresh temp data dir, never the live data/)
import assert from "node:assert/strict";
import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([len, name, data, crc]);
}
function widePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 3;
      raw[p] = 180;
      raw[p + 1] = 40;
      raw[p + 2] = 40;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function paintedOverlaps(page) {
  return page.evaluate(() => {
    const overlayOf = (el) => el.closest("#jump, #sheet, #setsheet, #confirm, #keys, #viewer, #update-note, #vv-debug, .picker");
    const clips = (value) => value === "auto" || value === "scroll" || value === "hidden" || value === "clip";
    const closedAway = (el) => {
      let node = el.parentElement;
      while (node) {
        if (node.tagName === "DETAILS" && !node.open) {
          const summary = node.querySelector(":scope > summary");
          if (!summary || !summary.contains(el)) return true;
        }
        node = node.parentElement;
      }
      return false;
    };
    const visibleRect = (el) => {
      if (closedAway(el) || el.closest("[hidden]")) return null;
      const s = getComputedStyle(el);
      if (s.display === "none" || s.visibility === "hidden" || Number(s.opacity) === 0) return null;
      let rect = el.getBoundingClientRect();
      if (s.position !== "fixed") {
        let node = el.parentElement;
        while (node && node !== document.body) {
          const cs = getComputedStyle(node);
          if (clips(cs.overflowX) || clips(cs.overflowY)) {
            const c = node.getBoundingClientRect();
            rect = {
              left: Math.max(rect.left, c.left),
              right: Math.min(rect.right, c.right),
              top: Math.max(rect.top, c.top),
              bottom: Math.min(rect.bottom, c.bottom),
            };
          }
          node = node.parentElement;
        }
      }
      const left = Math.max(rect.left, 0);
      const top = Math.max(rect.top, 0);
      const right = Math.min(rect.right, window.innerWidth);
      const bottom = Math.min(rect.bottom, window.innerHeight);
      if (right - left < 2 || bottom - top < 2) return null;
      return { left, top, right, bottom };
    };
    const ownText = (el) => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3 && node.textContent.trim()) return true;
      }
      return false;
    };
    const name = (el) => {
      const text = (el.innerText || el.getAttribute("aria-label") || el.id || "").trim().replace(/\s+/g, " ").slice(0, 32);
      const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/)[0] : "";
      return el.tagName.toLowerCase() + cls + (text ? " " + text : "");
    };
    const hit = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
    const out = [];
    const zones = document.querySelectorAll(".msg, .code, .toolcard, .steps, .row, .side-row, .switch-row, .subcard, .plancard, .queued, .perm, .swatch");
    for (const zone of zones) {
      if (zone.closest("[hidden]")) continue;
      const inside = [zone, ...zone.querySelectorAll("*")];
      for (const el of inside) {
        const pos = getComputedStyle(el).position;
        if (pos === "absolute" || pos === "fixed") out.push("position " + pos + " in flow: " + name(el));
      }
    }
    const nodes = [];
    for (const el of document.body.querySelectorAll("*")) {
      const interactive = el.matches("button, a, input, textarea, select, summary, [role='button'], [role='link'], [role='radio']");
      if (!interactive && !ownText(el)) continue;
      const rect = visibleRect(el);
      if (!rect) continue;
      nodes.push({ el, ...rect });
    }
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        if (overlayOf(a.el) !== overlayOf(b.el)) continue;
        if (!hit(a, b)) continue;
        out.push(name(a.el) + " overlaps " + name(b.el));
        if (out.length > 12) return out;
      }
    }
    return out;
  });
}
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
const SHOTS = path.join(process.env.HOME || "", "Projects/grok-deck/shots");
fs.mkdirSync(SHOTS, { recursive: true });

async function loadChromium(label) {
  try {
    return (await import("playwright")).chromium;
  } catch {
    try {
      return (await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`)).chromium;
    } catch {
      console.log("  skip " + label + ": playwright is not installed");
      return null;
    }
  }
}

function launchChromium(chromium) {
  const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
  return chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
}

// The cog opens the shared popover; "Session settings" in it opens the full panel.
async function openSessionSettings(page) {
  await page.locator(".opt-cog").click();
  await page.locator("#sheet .sheet-item").filter({ hasText: /^Session settings/ }).click();
}

async function check(name, fn) {
  if (process.env.E2E_ONLY && !new RegExp(process.env.E2E_ONLY, "i").test(name)) return;
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
    const r = await api("POST", "/api/turns", { cwd: dir, prompt: "[[edit topics/population]][[edit PROGRESS.md]][[edit notes.txt]][[say noted]]", permissionMode: "bypassPermissions" });
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
    const beforePause = loopPrompts(id).length;
    // The first run is queued as the loop is created. Idle can return before that turn is marked running.
    await waitFor(async () => {
      const snap = await session(id);
      const queued = (snap.queue || []).some((item) => item.loop);
      return loopPrompts(id).length > beforePause && !snap.running && !queued;
    }, 15000, "first run of the loop finished");
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

  await check("visible controls and text do not overlap", async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip overlap: playwright is not installed");
        return;
      }
    }
    await api("PATCH", "/api/skeptic/settings", { mode: "off" });
    const dir = project("overlap", {
      turns: [
        "[[say Done.]]",
        "[[say Short line.\\n\\n```js\\nconst mode = \"dark\";\\nconst line = \"" + "x".repeat(72) + "\";\\n```\\n\\nAfter the block, this sentence stays clear of every Copy control.]]",
        "[[exec 0 npm test --runInBand]][[say Ran it.]]",
      ],
    });
    const created = await api("POST", "/api/turns", { cwd: dir, prompt: "Hi", permissionMode: "default" });
    const id = created.json.sessionId;
    await idle(id);
    await api("POST", "/api/turns", { sessionId: id, prompt: "Please look at this carefully and keep every line readable. ".repeat(8) });
    await idle(id);
    await api("POST", "/api/turns", { sessionId: id, prompt: "Show the block" });
    await waitFor(async () => {
      const view = await session(id);
      return !view.running && JSON.stringify(view.messages).includes("After the block");
    }, 20000, "code block");
    await api("POST", "/api/turns", { sessionId: id, prompt: "Run the check" });
    await idle(id);
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const problems = [];
      for (const [width, height] of [[390, 844], [1440, 900]]) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
        const overlaps = () => paintedOverlaps(page);
        await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".msg-copy");
        await page.waitForSelector(".code pre");
        await page.waitForSelector(".steps");
        let found = await overlaps();
        for (const item of found) problems.push(width + "x" + height + " chat " + item);
        const copyStyle = await page.evaluate(() => {
          const out = [];
          const probe = document.createElement("span");
          probe.style.color = "var(--chat-fg-dim)";
          document.body.append(probe);
          const dim = getComputedStyle(probe).color;
          probe.style.color = "var(--chat-fg)";
          const fg = getComputedStyle(probe).color;
          probe.remove();
          const buttons = [...document.querySelectorAll(".msg-copy")];
          if (!buttons.length) out.push("no copy button");
          for (const btn of buttons) {
            const msg = btn.closest(".msg");
            const text = msg && msg.querySelector(".msg-text, .body");
            const box = btn.getBoundingClientRect();
            const textBox = text ? text.getBoundingClientRect() : null;
            const style = getComputedStyle(btn);
            if ((btn.innerText || "").trim()) out.push("copy has a text label");
            if (btn.getAttribute("aria-label") !== "Copy message") out.push("copy label " + btn.getAttribute("aria-label"));
            if (style.borderTopWidth !== "0px" || style.borderLeftWidth !== "0px") out.push("copy has a border");
            if (style.position === "absolute" || style.position === "fixed") out.push("copy leaves flow");
            if (style.opacity !== "1") out.push("copy is not always visible");
            if (Math.abs(box.width - 32) > 1 || Math.abs(box.height - 32) > 1) out.push("copy tap " + Math.round(box.width) + "x" + Math.round(box.height));
            if (style.color !== dim) out.push("copy color is not muted");
            const icon = btn.querySelector(".ico-copy");
            const check = btn.querySelector(".ico-check");
            if (!icon || !check) out.push("copy missing icon");
            else {
              const iconBox = icon.getBoundingClientRect();
              if (iconBox.width < 16 || iconBox.width > 18.5 || Math.abs(iconBox.height - iconBox.width) > 1) out.push("copy icon " + iconBox.width.toFixed(1));
              if (getComputedStyle(check).display !== "none") out.push("check shows before copy");
            }
            if (!textBox) out.push("copy has no message");
            else {
              if (box.top < textBox.bottom - 1) out.push("copy is not under the message");
              if (Math.abs(box.left - textBox.left) > 2) out.push("copy is not left-aligned");
            }
          }
          return { out, fg };
        });
        for (const item of copyStyle.out) problems.push(width + "x" + height + " " + item);
        if (width === 390 && !copyStyle.out.length) {
          await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
          const btn = page.locator(".msg-copy").first();
          await btn.hover();
          await page.waitForTimeout(250);
          const hovered = await btn.evaluate((el) => getComputedStyle(el).color);
          if (hovered !== copyStyle.fg) problems.push(width + "x" + height + " copy does not brighten on hover " + hovered);
          await btn.click();
          const flashed = await page.waitForFunction(() => {
            const el = document.querySelector(".msg-copy");
            const label = el && el.getAttribute("aria-label");
            if (label !== "Copied" && label !== "Copy failed") return null;
            const check = el.querySelector(".ico-check");
            const icon = el.querySelector(".ico-copy");
            return {
              copied: el.classList.contains("copied"),
              label,
              check: check ? getComputedStyle(check).display : "",
              icon: icon ? getComputedStyle(icon).display : "",
            };
          }, null, { timeout: 3000 }).then((handle) => handle.jsonValue()).catch((error) => ({ error: error.message }));
          if (!flashed.copied || flashed.label !== "Copied" || flashed.check === "none" || flashed.icon !== "none") {
            problems.push(width + "x" + height + " copy check " + JSON.stringify(flashed));
          }
        }
        await page.locator("#input").fill("A long composer line ".repeat(12));
        await page.locator("#input").dispatchEvent("input");
        const tall = await page.locator(".composer-bar").evaluate((el) => el.classList.contains("tall"));
        if (!tall) problems.push(width + "x" + height + " composer did not grow");
        found = await overlaps();
        for (const item of found) problems.push(width + "x" + height + " composer " + item);
        await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
        await page.waitForSelector(width >= 1024 ? ".side-row" : ".row");
        found = await overlaps();
        for (const item of found) problems.push(width + "x" + height + " list " + item);
        await page.close();
      }
      assert.deepEqual(problems, []);
    } finally {
      await browser.close();
    }
  });

  await check("long text wraps and wide boxes scroll at 390", async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip wrap: playwright is not installed");
        return;
      }
    }
    await api("PATCH", "/api/skeptic/settings", { mode: "off" });
    const url = "https://example.com/" + "wrap/".repeat(40) + "end";
    const pathToken = `${process.env.HOME}/Projects/grok-deck/` + "nested/".repeat(28) + "file.txt";
    const hash = "ab".repeat(48);
    const codeLine = 'const token = "' + "y".repeat(220) + '";';
    const say = [
      "Path " + pathToken + " and hash " + hash + ".",
      "",
      "[" + url + "](" + url + ")",
      "",
      "```",
      codeLine,
      "```",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| path | " + pathToken + " |",
      "",
      "![wide](wide.png)",
    ].join("\n");
    const dir = project("wrap", { turns: ["[[say " + say + "]]"] });
    fs.writeFileSync(path.join(dir, "wide.png"), widePng(800, 40));
    const created = await api("POST", "/api/turns", { cwd: dir, prompt: url, permissionMode: "default" });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    const id = created.json.sessionId;
    await waitFor(async () => {
      const view = await session(id);
      const text = JSON.stringify(view.messages || []);
      return !view.running && text.includes(pathToken) && text.includes("wide.png");
    }, 20000, "wrap turn");
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".msg.user .msg-text");
      await page.waitForSelector(".table-wrap");
      await page.waitForSelector(".code pre");
      await page.waitForSelector(".msg.assistant img");
      await page.evaluate(() => document.querySelector(".msg.assistant img").scrollIntoView());
      await page.waitForFunction(() => {
        const img = document.querySelector(".msg.assistant img");
        return img && img.complete && img.naturalWidth > 390;
      });
      const problems = await page.evaluate((markers) => {
        const slack = 1;
        const grows = (el) => !!el && el.scrollWidth > el.clientWidth + slack;
        const out = [];
        const labelOf = (el) => el.id || el.tagName.toLowerCase();
        for (const el of [document.documentElement, document.body, document.querySelector("#app"), document.querySelector("#main")]) {
          if (grows(el)) out.push(labelOf(el) + " scrolls horizontally " + el.scrollWidth + ">" + el.clientWidth);
        }
        if (window.scrollX !== 0) out.push("window scrolled horizontally");
        const main = document.querySelector("#main");
        const mainBox = main.getBoundingClientRect();
        const escapes = (el, label) => {
          if (!el) {
            out.push("missing " + label);
            return;
          }
          const box = el.getBoundingClientRect();
          if (box.width < 2) out.push(label + " has no width");
          if (box.left < mainBox.left - slack || box.right > mainBox.right + slack) {
            out.push(label + " leaves the page " + Math.round(box.left) + ".." + Math.round(box.right));
          }
        };
        const user = [...document.querySelectorAll(".msg.user .msg-text")].find((el) => el.textContent.includes(markers.url));
        if (!user) out.push("missing long url");
        else {
          escapes(user.closest(".msg"), "url bubble");
          if (grows(user)) out.push("url does not wrap " + user.scrollWidth + ">" + user.clientWidth);
          if (getComputedStyle(user).overflowWrap !== "anywhere") out.push("url overflow-wrap " + getComputedStyle(user).overflowWrap);
        }
        const prose = [...document.querySelectorAll(".msg.assistant .body p")].find((el) => el.textContent.includes(markers.path));
        if (!prose) out.push("missing long path");
        else {
          escapes(prose, "path");
          if (grows(prose)) out.push("path does not wrap " + prose.scrollWidth + ">" + prose.clientWidth);
          if (!prose.textContent.includes(markers.hash)) out.push("missing hash");
          if (getComputedStyle(prose).overflowWrap !== "anywhere") out.push("path overflow-wrap " + getComputedStyle(prose).overflowWrap);
        }
        const link = [...document.querySelectorAll(".msg.assistant a")].find((el) => (el.textContent || "").includes(markers.url));
        const linkLine = link && link.closest("p");
        if (!link || !linkLine) out.push("missing url link");
        else {
          escapes(linkLine, "url link");
          if (grows(linkLine)) out.push("url link does not wrap " + linkLine.scrollWidth + ">" + linkLine.clientWidth);
          const line = linkLine.getBoundingClientRect();
          for (const rect of link.getClientRects()) {
            if (rect.width < 2) continue;
            if (rect.left < line.left - slack || rect.right > line.right + slack) out.push("url link leaves its line");
          }
        }
        const card = document.querySelector(".msg.assistant .code");
        const pre = card && card.querySelector("pre");
        if (!card || !pre) out.push("missing code");
        else {
          escapes(card, "code");
          if (pre.scrollWidth <= pre.clientWidth + slack) out.push("code does not scroll inside its box");
          if (grows(card)) out.push("code card widens the page " + card.scrollWidth + ">" + card.clientWidth);
          const flow = getComputedStyle(pre).overflowX;
          if (flow !== "auto" && flow !== "scroll") out.push("code overflow-x " + flow);
        }
        const wrap = document.querySelector(".table-wrap");
        const table = wrap && wrap.querySelector("table");
        if (!wrap || !table) out.push("missing table");
        else {
          escapes(wrap, "table");
          if (wrap.scrollWidth <= wrap.clientWidth + slack) out.push("table does not scroll inside its box");
          if (table.getBoundingClientRect().width <= wrap.clientWidth + slack) out.push("table is not wider than its box");
          const body = wrap.closest(".body");
          if (grows(body)) out.push("table widens the bubble " + body.scrollWidth + ">" + body.clientWidth);
          const flow = getComputedStyle(wrap).overflowX;
          if (flow !== "auto" && flow !== "scroll") out.push("table overflow-x " + flow);
        }
        const img = document.querySelector(".msg.assistant img");
        if (!img) out.push("missing image");
        else {
          escapes(img, "image");
          if (!(img.naturalWidth > 390)) out.push("image is not wider than the phone");
          const shown = img.getBoundingClientRect().width;
          if (shown > mainBox.width) out.push("image wider than the page");
          if (shown >= img.naturalWidth - slack) out.push("image did not shrink");
          if (getComputedStyle(img).maxWidth === "none") out.push("image max-width is none");
          const body = img.closest(".body");
          if (grows(body)) out.push("image widens the bubble");
        }
        for (const el of document.querySelectorAll(".msg, .code, .table-wrap")) {
          if (getComputedStyle(el).minWidth !== "0px") out.push("min-width on " + String(el.className).split(/\s+/)[0] + " is " + getComputedStyle(el).minWidth);
        }
        return out;
      }, { url, path: pathToken, hash });
      for (const part of [0, 0.5, 1]) {
        await page.evaluate((spot) => {
          const main = document.querySelector("#main");
          main.scrollTop = Math.max(0, (main.scrollHeight - main.clientHeight) * spot);
        }, part);
        for (const item of await paintedOverlaps(page)) problems.push("overlap at " + part + ": " + item);
      }
      assert.deepEqual(problems, []);
    } finally {
      await browser.close();
    }
  });

  await check("desktop sessions pane resizes from its handle", async () => {
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip sidebar: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      const measure = () => page.evaluate(() => {
        const sideEl = document.querySelector("#side");
        const handle = document.querySelector("#side-resize");
        const app = document.querySelector("#app");
        const sideBox = sideEl.getBoundingClientRect();
        const handleBox = handle.getBoundingClientRect();
        const appBox = app.getBoundingClientRect();
        return {
          side: Math.round(sideBox.width),
          handle: Math.round(handleBox.width),
          appLeft: Math.round(appBox.left),
          appRight: Math.round(appBox.right),
          handleLeft: Math.round(handleBox.left),
          sideRight: Math.round(sideBox.right),
          grid: getComputedStyle(document.body).display,
          sidePos: getComputedStyle(sideEl).position,
          handlePos: getComputedStyle(handle).position,
          cursor: getComputedStyle(handle).cursor,
          hidden: handle.hidden || sideEl.hidden,
          stored: localStorage.getItem("gm-sidebar-w"),
          now: handle.getAttribute("aria-valuenow"),
        };
      });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#side-resize:not([hidden])");
      await page.waitForSelector(".side-row, .hint");
      let box = await measure();
      assert.equal(box.hidden, false);
      assert.equal(box.grid, "grid");
      assert.equal(box.sidePos, "relative");
      assert.notEqual(box.handlePos, "absolute");
      assert.notEqual(box.handlePos, "fixed");
      assert.equal(box.cursor, "col-resize");
      assert.equal(box.side, 280);
      assert.equal(box.handle, 8);
      assert.ok(Math.abs(box.handleLeft - box.sideRight) <= 1, JSON.stringify(box));
      assert.ok(Math.abs(box.appLeft - (box.handleLeft + box.handle)) <= 1, JSON.stringify(box));
      assert.ok(box.appRight >= 1430, JSON.stringify(box));
      const handle = page.locator("#side-resize");
      await handle.focus();
      await page.keyboard.press("ArrowRight");
      box = await measure();
      assert.equal(box.side, 296);
      assert.equal(box.stored, "296");
      await page.keyboard.press("ArrowLeft");
      box = await measure();
      assert.equal(box.side, 280);
      const grip = await handle.boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + 80);
      await page.mouse.down();
      await page.mouse.move(grip.x + grip.width / 2 + 80, grip.y + 80);
      await page.mouse.up();
      box = await measure();
      assert.ok(Math.abs(box.side - 360) <= 2, JSON.stringify(box));
      assert.equal(box.stored, String(box.side));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#side:not([hidden])");
      box = await measure();
      assert.ok(Math.abs(box.side - 360) <= 2, "stored width " + JSON.stringify(box));
      await handle.dblclick();
      box = await measure();
      assert.equal(box.side, 280);
      assert.equal(box.stored, null);
      await handle.focus();
      for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
      box = await measure();
      assert.equal(box.side, 480);
      assert.equal(box.now, "480");
      for (let i = 0; i < 25; i++) await page.keyboard.press("ArrowLeft");
      box = await measure();
      assert.equal(box.side, 220);
      await page.setViewportSize({ width: 1100, height: 800 });
      await page.waitForFunction(() => !document.querySelector("#side").hidden);
      await handle.focus();
      for (let i = 0; i < 20; i++) await page.keyboard.press("ArrowRight");
      box = await measure();
      assert.equal(box.side, 440, JSON.stringify(box));
      assert.equal(box.now, "440");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => document.querySelector("#side").hidden && document.querySelector("#side-resize").hidden);
      const phone = await page.evaluate(() => {
        const app = document.querySelector("#app").getBoundingClientRect();
        return {
          grid: getComputedStyle(document.body).display,
          left: Math.round(app.left),
          width: Math.round(app.width),
        };
      });
      assert.notEqual(phone.grid, "grid");
      assert.ok(phone.left <= 1 && phone.width >= 380 && phone.width <= 390, JSON.stringify(phone));
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("desktop chat has no top bar and the sidebar marks the session", async () => {
    const dir = project("desk-chrome");
    const started = await api("POST", "/api/turns", {
      cwd: dir,
      prompt: "[[say hello from the desk]]",
      permissionMode: "default",
      theme: "catppuccin",
      skeptic: "off",
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    const patched = await api("PATCH", "/api/sessions/" + id, { plan: true, theme: "catppuccin", skeptic: "off" });
    assert.equal(patched.status, 200, JSON.stringify(patched.json));
    const sessDir = fs.readdirSync(path.join(GHOME, "sessions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(GHOME, "sessions", entry.name, id))
      .find((candidate) => fs.existsSync(path.join(candidate, "summary.json")));
    assert.ok(sessDir, "session dir for " + id);
    fs.writeFileSync(path.join(sessDir, "usage.json"), JSON.stringify({ session: { totalTokens: 128000 } }));
    fs.writeFileSync(path.join(sessDir, "signals.json"), JSON.stringify({ contextTokensUsed: 12000, contextWindowTokens: 128000 }));
    const listed = await api("GET", "/api/sessions");
    const row = (listed.json.sessions || []).find((item) => item.id === id);
    assert.equal(row && row.tokens, 128000, JSON.stringify(row));
    assert.equal(row.context && row.context.used, 12000);
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip desktop chrome: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".side-row.on .side-title");
      await page.waitForFunction(() => {
        const mark = document.querySelector(".side-row.on .side-mark");
        const pill = document.querySelector("#chat-meta .ctx");
        if (!mark || !pill) return false;
        const bg = getComputedStyle(mark).backgroundColor;
        return bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      });
      const desk = await page.evaluate(() => {
        const row = document.querySelector(".side-row.on");
        const title = row.querySelector(".side-title");
        const mark = getComputedStyle(row.querySelector(".side-mark")).backgroundColor;
        const dot = getComputedStyle(row.querySelector(".side-dot")).backgroundColor;
        const top = document.querySelector("#top");
        const meta = document.querySelector("#chat-meta");
        const rows = [...document.querySelectorAll(".side-row")].map((el) => ({
          on: el.classList.contains("on"),
          weight: getComputedStyle(el.querySelector(".side-title")).fontWeight,
          menu: !!el.querySelector(".side-menu"),
          pos: getComputedStyle(el).position,
        }));
        return {
          topDisplay: getComputedStyle(top).display,
          topH: Math.round(top.getBoundingClientRect().height),
          metaHidden: meta.hidden,
          metaText: meta.innerText.replace(/\s+/g, " ").trim(),
          use: row.querySelector(".side-snippet").textContent,
          status: row.querySelector(".side-status").textContent,
          weight: getComputedStyle(title).fontWeight,
          bg: getComputedStyle(row).backgroundColor,
          mark,
          dot,
          menu: row.querySelector(".side-menu").getAttribute("aria-label"),
          plus: document.querySelector("#attach").getAttribute("aria-label"),
          mode: document.querySelector("#optbar [data-mode]")?.textContent || "",
          planBadge: !!document.querySelector(".badge.plan"),
          rows,
          flow: [...row.querySelectorAll("*")].filter((el) => {
            const pos = getComputedStyle(el).position;
            return pos === "absolute" || pos === "fixed";
          }).map((el) => el.className),
        };
      });
      assert.equal(desk.topDisplay, "none", JSON.stringify(desk));
      assert.equal(desk.topH, 0);
      assert.equal(desk.metaHidden, false);
      assert.equal(desk.planBadge, false, JSON.stringify(desk));
      assert.equal(desk.mode, "Plan", JSON.stringify(desk));
      assert.equal(desk.metaText.includes("Plan"), false, desk.metaText);
      assert.match(desk.metaText, /12k \/ 128k/);
      assert.match(desk.use, /hello from the desk/);
      assert.equal(desk.status, "Idle");
      assert.equal(desk.weight, "600");   // the one bold weight
      assert.notEqual(desk.bg, "rgba(0, 0, 0, 0)");
      assert.equal(desk.mark, desk.dot);
      assert.notEqual(desk.mark, "rgba(0, 0, 0, 0)");
      assert.equal(desk.menu, "Session menu");
      assert.equal(desk.plus, "Add photo");
      assert.deepEqual(desk.flow, []);
      const active = desk.rows.filter((item) => item.on);
      const rest = desk.rows.filter((item) => !item.on);
      assert.equal(active.length, 1);
      assert.equal(active[0].weight, "600");
      assert.equal(active[0].menu, true);
      assert.equal(active[0].pos, "static");
      for (const item of rest) {
        assert.equal(item.weight, "600");
        assert.equal(item.menu, false);
      }
      await page.locator(".side-row.on .side-menu").click();
      await page.waitForSelector("#sheet:not([hidden])");
      const labels = await page.locator("#sheet .sheet-item").allTextContents();
      assert.ok(labels.some((text) => text.includes("Add photo")), labels.join(" | "));
      for (const gone of ["Session settings", "Plan mode", "Long run", "Loops"]) {
        assert.equal(labels.some((text) => text.includes(gone)), false, gone + " still in the menu: " + labels.join(" | "));
      }
      await page.keyboard.press("Escape");
      await page.waitForSelector("#sheet", { state: "hidden" });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => {
        const top = document.querySelector("#top");
        const side = document.querySelector("#side");
        return getComputedStyle(top).display !== "none" && side.hidden && top.querySelector("h1") && !top.querySelector(".badge.plan") && top.querySelector(".ctx") && document.querySelector("#optbar [data-mode]")?.textContent === "Plan";
      });
      const phone = await page.evaluate(() => {
        const top = document.querySelector("#top");
        const box = top.getBoundingClientRect();
        return {
          display: getComputedStyle(top).display,
          height: Math.round(box.height),
          title: top.querySelector("h1").textContent,
          metaHidden: document.querySelector("#chat-meta").hidden,
          plus: document.querySelector("#attach").getAttribute("aria-label"),
          sideHidden: document.querySelector("#side").hidden,
        };
      });
      assert.notEqual(phone.display, "none");
      assert.ok(phone.height >= 44, JSON.stringify(phone));
      assert.ok(phone.title.length > 0);
      assert.equal(phone.metaHidden, true);
      assert.equal(phone.plus, "Menu");
      assert.equal(phone.sideHidden, true);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#top button[aria-label='App settings']");
      await page.locator("#top button[aria-label='App settings']").click();
      await page.waitForSelector("#setsheet:not([hidden])");
      const appText = await page.locator("#setsheet").innerText();
      assert.match(appText, /appearance/i);
      assert.match(appText, /Dark/);
      assert.match(appText, /Light/);
      assert.match(appText, /Log out/);
      await page.locator("#setsheet .set-done").click();
      await page.waitForSelector("#setsheet", { state: "hidden" });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#side button[aria-label='App settings']");
      const home = await page.evaluate(() => ({
        rows: document.querySelectorAll("#main .row").length,
        text: document.querySelector("#main").innerText,
        top: getComputedStyle(document.querySelector("#top")).display,
      }));
      assert.equal(home.rows, 0, JSON.stringify(home));
      assert.match(home.text, /Choose a session/);
      assert.equal(home.top, "none", JSON.stringify(home));
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("composer toolbar sets mode and reasoning", async () => {
    const dir = project("optbar");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hello]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    const before = await session(id);
    assert.equal(before.session.plan, false);
    assert.equal(before.session.effort, "high");
    assert.equal(before.session.ultra, false);
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip optbar: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    const shotDir = "/tmp/deck-shots";
    fs.mkdirSync(shotDir, { recursive: true });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#optbar:not([hidden])");
      const layout = await page.evaluate(() => {
        const barEl = document.querySelector(".composer-bar");
        const fieldEl = document.querySelector("#input");
        const optEl = document.querySelector("#optbar");
        const plusEl = document.querySelector("#attach");
        const sendEl = document.querySelector("#send");
        const cog = document.querySelector(".opt-cog");
        const mode = optEl.querySelector("[data-mode]");
        const reason = optEl.querySelector("[data-reasoning]");
        const box = (el) => el.getBoundingClientRect();
        const bar = box(barEl);
        const field = box(fieldEl);
        const opt = box(optEl);
        const plus = box(plusEl);
        const send = box(sendEl);
        const cogBox = box(cog);
        const reasonBox = box(reason);
        const mid = (r) => r.top + r.height / 2;
        const pos = (el) => getComputedStyle(el).position;
        const bg = (el) => getComputedStyle(el).backgroundColor;
        const wide = (el) => el.scrollWidth > el.clientWidth + 1;
        return {
          inside: opt.height > 20 && field.height > 10 && opt.top >= field.bottom - 1 && opt.bottom <= bar.bottom + 1 && opt.left >= bar.left - 1 && opt.right <= bar.right + 1,
          sameRow: Math.abs(mid(plus) - mid(opt)) <= 8 && Math.abs(mid(send) - mid(opt)) <= 8,
          plusLeft: plus.right <= cogBox.left + 1,
          sendRight: send.left >= reasonBox.right - 1,
          optPos: pos(optEl),
          cogPos: pos(cog),
          modePos: pos(mode),
          radius: parseFloat(getComputedStyle(barEl).borderTopLeftRadius),
          chipBg: bg(mode),
          plusBg: bg(plusEl),
          barBg: bg(barEl),
          mode: mode.textContent,
          modeLabel: mode.getAttribute("aria-label"),
          reason: reason.textContent,
          reasonLabel: reason.getAttribute("aria-label"),
          cog: cog.getAttribute("aria-label"),
          cogH: Math.round(cogBox.height),
          chipH: Math.round(box(mode).height),
          plusW: Math.round(plus.width),
          mic: !!document.querySelector("[aria-label*='Mic' i], [aria-label*='Voice' i]"),
          wide: [document.documentElement, document.body, document.querySelector("#app"), document.querySelector("#main")].filter(wide).map((el) => el.id || el.tagName),
        };
      });
      assert.equal(layout.inside, true, JSON.stringify(layout));
      assert.equal(layout.sameRow, true, JSON.stringify(layout));
      assert.equal(layout.plusLeft, true, JSON.stringify(layout));
      assert.equal(layout.sendRight, true, JSON.stringify(layout));
      assert.equal(layout.optPos, "static");
      assert.equal(layout.cogPos, "static");
      assert.equal(layout.modePos, "static");
      assert.ok(layout.radius >= 24, JSON.stringify(layout));
      assert.notEqual(layout.chipBg, "rgba(0, 0, 0, 0)", JSON.stringify(layout));
      assert.notEqual(layout.plusBg, "rgba(0, 0, 0, 0)", JSON.stringify(layout));
      assert.notEqual(layout.chipBg, layout.barBg, JSON.stringify(layout));
      assert.equal(layout.mode, "Normal");
      assert.equal(layout.modeLabel, "Mode, Normal");
      assert.equal(layout.reason, "Grok 4.7 High");
      assert.equal(layout.reasonLabel, "Reasoning, Grok 4.7 High");
      assert.equal(layout.cog, "Session settings");
      assert.equal(layout.mic, false, JSON.stringify(layout));
      assert.deepEqual(layout.wide, [], JSON.stringify(layout));
      assert.ok(layout.cogH >= 28 && layout.cogH <= 36, JSON.stringify(layout));
      assert.ok(layout.chipH >= 28 && layout.chipH <= 36, JSON.stringify(layout));
      assert.ok(layout.plusW >= 32 && layout.plusW <= 40, JSON.stringify(layout));
      await page.locator("#optbar [data-mode]").click();
      await page.waitForSelector("#sheet:not([hidden])");
      const modeNames = (await page.locator("#sheet .sheet-item").allTextContents()).map((text) => text.replace("  ✓", "").trim());
      assert.deepEqual(modeNames, ["Normal", "Plan", "Long run", "Loops"]);
      await page.locator("#sheet .sheet-item").filter({ hasText: /^Plan/ }).click();
      await page.waitForFunction(() => document.querySelector("#optbar [data-mode]")?.textContent === "Plan");
      await page.locator("#optbar [data-reasoning]").click();
      await page.waitForSelector("#sheet:not([hidden])");
      const reasonText = await page.locator("#sheet").innerText();
      assert.match(reasonText, /pstack's poteto-mode/);
      const reasonNames = (await page.locator("#sheet .sheet-item").allTextContents()).map((text) => text.replace("  ✓", "").trim());
      assert.deepEqual(reasonNames, ["Low", "Medium", "High", "Extra high", "Ultra"]);
      await page.locator("#sheet .sheet-item").filter({ hasText: /^Ultra/ }).click();
      await page.waitForFunction(() => document.querySelector("#optbar [data-reasoning]")?.textContent === "Ultra");
      const after = await session(id);
      assert.equal(after.session.effort, "xhigh");
      assert.equal(after.session.ultra, true);
      assert.equal(after.session.plan, true);
      await page.locator("#attach").click();
      await page.waitForSelector("#sheet:not([hidden])");
      const menu = await page.locator("#sheet .sheet-item").allTextContents();
      assert.ok(menu.some((text) => text.includes("Add photo")), menu.join(" | "));
      assert.ok(menu.some((text) => text.includes("Archive")), menu.join(" | "));
      for (const gone of ["Plan mode", "Long run", "Session settings", "Loops"]) {
        assert.equal(menu.some((text) => text.includes(gone)), false, gone + " " + menu.join(" | "));
      }
      await page.keyboard.press("Escape");
      await page.waitForSelector("#sheet", { state: "hidden" });
      await openSessionSettings(page);
      await page.waitForSelector("#setsheet:not([hidden])");
      assert.equal(await page.locator("#setsheet [role='dialog']").getAttribute("aria-label"), "Session settings");
      const settingsText = await page.locator("#setsheet").innerText();
      assert.match(settingsText, /theme/i);
      assert.match(settingsText, /Dark/);
      assert.match(settingsText, /Light/);
      assert.match(settingsText, /model/i);
      assert.equal(/Plan mode/.test(settingsText), false, settingsText);
      assert.equal(/Ultra code/.test(settingsText), false, settingsText);
      assert.equal(settingsText.includes("Archive"), false, settingsText);
      await page.locator("#setsheet .set-done").click();
      await page.waitForSelector("#setsheet", { state: "hidden" });
      await sleep(300);
      await page.screenshot({ path: path.join(shotDir, "optbar-390.png") });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForFunction(() => getComputedStyle(document.querySelector("#top")).display === "none" && !document.querySelector("#optbar").hidden);
      const desk = await page.evaluate(() => {
        const barEl = document.querySelector(".composer-bar");
        const field = document.querySelector("#input").getBoundingClientRect();
        const opt = document.querySelector("#optbar").getBoundingClientRect();
        const bar = barEl.getBoundingClientRect();
        const wide = (el) => el.scrollWidth > el.clientWidth + 1;
        return {
          top: getComputedStyle(document.querySelector("#top")).display,
          mode: document.querySelector("#optbar [data-mode]").textContent,
          reason: document.querySelector("#optbar [data-reasoning]").textContent,
          inside: opt.height > 20 && opt.top >= field.bottom - 1 && opt.bottom <= bar.bottom + 1,
          pos: getComputedStyle(document.querySelector("#optbar")).position,
          radius: parseFloat(getComputedStyle(barEl).borderTopLeftRadius),
          wide: [document.documentElement, document.body, document.querySelector("#app"), document.querySelector("#main")].filter(wide).map((el) => el.id || el.tagName),
        };
      });
      assert.equal(desk.top, "none");
      assert.equal(desk.mode, "Plan");
      assert.equal(desk.reason, "Ultra");
      assert.equal(desk.inside, true, JSON.stringify(desk));
      assert.equal(desk.pos, "static");
      assert.ok(desk.radius >= 24, JSON.stringify(desk));
      assert.deepEqual(desk.wide, [], JSON.stringify(desk));
      await sleep(300);
      await page.screenshot({ path: path.join(shotDir, "optbar-1440.png") });
      await page.locator("#optbar [data-mode]").click();
      await page.waitForSelector("#sheet:not([hidden])");
      await page.locator("#sheet .sheet-item").filter({ hasText: /^Loops/ }).click();
      await page.waitForSelector("#sheet input[aria-label='Loop interval']");
      await page.waitForSelector("#sheet input[aria-label='Loop prompt']");
      const loopLabels = await page.locator("#sheet .sheet-item").allTextContents();
      assert.equal(loopLabels.includes("Close"), false, "outside tap and Esc close it: " + loopLabels.join(" | "));
      assert.equal(loopLabels.includes("Back"), false);
      assert.equal(await page.locator("#sheet .sheet-form button").innerText(), "Create");
      await page.keyboard.press("Escape");
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE + "/new", { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const main = document.querySelector("#main");
        const bar = document.querySelector(".composer-bar");
        const opt = document.querySelector("#optbar");
        if (!main || !bar || !opt || opt.hidden || bar.getBoundingClientRect().height < 20) return false;
        return /Directory/.test(main.innerText || "");
      });
      const fresh = await page.evaluate(() => {
        const bar = document.querySelector(".composer-bar").getBoundingClientRect();
        const field = document.querySelector("#input").getBoundingClientRect();
        const opt = document.querySelector("#optbar").getBoundingClientRect();
        const plus = document.querySelector("#attach").getBoundingClientRect();
        const send = document.querySelector("#send").getBoundingClientRect();
        return {
          mode: document.querySelector("#optbar [data-mode]").textContent,
          reason: document.querySelector("#optbar [data-reasoning]").textContent,
          selects: document.querySelectorAll("#main select").length,
          directory: [...document.querySelectorAll("#main .field")].some((el) => el.firstChild && el.firstChild.textContent === "Directory"),
          inside: opt.height > 20 && field.height > 10 && opt.top >= field.bottom - 1 && opt.bottom <= bar.bottom + 1,
          plusLeft: plus.right <= opt.left + 1,
          sendRight: send.left >= opt.right - 1,
        };
      });
      assert.equal(fresh.mode, "Normal", JSON.stringify(fresh));
      assert.equal(fresh.reason, "Grok 4.7 High", JSON.stringify(fresh));
      assert.equal(fresh.selects, 0, JSON.stringify(fresh));
      assert.equal(fresh.directory, true, JSON.stringify(fresh));
      assert.equal(fresh.inside, true, JSON.stringify(fresh));
      assert.equal(fresh.plusLeft, true, JSON.stringify(fresh));
      assert.equal(fresh.sendRight, true, JSON.stringify(fresh));
      await openSessionSettings(page);
      await page.waitForSelector("#setsheet:not([hidden]) [role='dialog']");
      const draftText = await page.locator("#setsheet").innerText();
      assert.match(draftText, /Context use appears after the first turn/);
      assert.match(draftText, /Light/);
      assert.match(draftText, /model/i);
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("composer sits on the safe area at 390", async () => {
    const dir = project("composer-gap");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hello]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip composer gap: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#composer:not([hidden]) .composer-bar");
      const measure = () => page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.cssText = "position:fixed;left:0;bottom:0;width:0;height:env(safe-area-inset-bottom);pointer-events:none;";
        document.body.appendChild(probe);
        const inset = probe.getBoundingClientRect().height;
        probe.remove();
        const bottom = document.querySelector("#composer").getBoundingClientRect().bottom;
        return {
          inset,
          gap: window.innerHeight - bottom,
          keyboard: document.documentElement.classList.contains("keyboard"),
          height: getComputedStyle(document.documentElement).getPropertyValue("--vv-height").trim(),
        };
      });
      const resting = await measure();
      assert.ok(Math.abs(resting.gap - resting.inset) <= 2, "resting " + JSON.stringify(resting));
      await page.evaluate(() => window.__gm.applyViewport({ offsetTop: 0, height: window.innerHeight - 120 }));
      const stuck = await measure();
      assert.equal(stuck.keyboard, false, "stuck visual viewport was treated as a keyboard " + JSON.stringify(stuck));
      assert.ok(Math.abs(stuck.gap - stuck.inset) <= 2, "stuck " + JSON.stringify(stuck));
      await page.focus("#input");
      await page.evaluate(() => window.__gm.applyViewport({ offsetTop: 0, height: window.innerHeight - 300 }));
      const keyboard = await measure();
      assert.equal(keyboard.keyboard, true, JSON.stringify(keyboard));
      assert.ok(Math.abs(keyboard.gap - 300) <= 2, "keyboard " + JSON.stringify(keyboard));
      await page.evaluate(() => document.activeElement.blur());
      await page.evaluate(() => window.__gm.handleViewport());
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("keyboard open then closed keeps the page still and the composer on the bottom edge at 390", async () => {
    const dir = project("keyboard-390");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hello]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    const chromium = await loadChromium("keyboard");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      page.on("pageerror", (error) => console.log("  PAGEERROR " + error.message));
      page.on("crash", () => console.log("  PAGE CRASHED"));
      // An iPhone keeps the layout 844 high, shrinks visualViewport, and scrolls the document to reveal the field.
      await page.addInitScript(() => {
        const vv = new EventTarget();
        const state = { cut: 0, top: 0, scroll: 0, scrolled: 0, innerCut: 0 };
        // Installed iOS can leave window.innerHeight short after the keyboard closes (and shrink it while open).
        const realInner = Object.getOwnPropertyDescriptor(window, "innerHeight").get.bind(window);
        Object.defineProperty(window, "innerHeight", { get: () => realInner() - state.innerCut, configurable: true });
        Object.defineProperties(vv, {
          height: { get: () => realInner() - state.cut },
          width: { get: () => window.innerWidth },
          offsetTop: { get: () => state.top },
          offsetLeft: { value: 0 },
          scale: { value: 1 },
        });
        Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
        Object.defineProperty(window, "scrollY", { get: () => state.scroll, configurable: true });
        window.scrollTo = (x, y) => {
          const to = typeof x === "object" ? x.top || 0 : y || 0;
          if (to) state.scrolled += 1;
          state.scroll = to;
        };
        const fire = () => {
          vv.dispatchEvent(new Event("resize"));
          vv.dispatchEvent(new Event("scroll"));
        };
        window.__kb = {
          state,
          get full() { return realInner(); },
          open(px, pan, innerToo) {
            state.cut = px;
            state.innerCut = innerToo ? px : 0;
            state.scroll = pan ? 0 : px;
            state.top = pan ? px : 0;
            fire();
          },
          close(residue, staleInner) {
            state.cut = residue;
            state.innerCut = staleInner ? residue : 0;
            state.scroll = 0;
            state.top = 0;
            if (residue === 0) fire();
          },
        };
      });
      const cdp = await page.context().newCDPSession(page);
      let inset = 0;
      try {
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
        inset = 34;
      } catch {}
      await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#composer:not([hidden]) .composer-bar");
      const measure = () => page.evaluate(() => {
        const rect = document.querySelector("#composer").getBoundingClientRect();
        const shell = document.querySelector("#app").getBoundingClientRect();
        return {
          composerBottom: Math.round(rect.bottom * 10) / 10,
          shellBottom: Math.round(shell.bottom * 10) / 10,
          layout: window.__kb.full,
          inner: window.innerHeight,
          inlineHeight: document.documentElement.style.getPropertyValue("--vv-height"),
          vvBottom: window.__kb.state.top + window.visualViewport.height,
          scrollY: window.scrollY,
          docScroll: (document.scrollingElement || document.documentElement).scrollTop,
          keyboard: document.documentElement.classList.contains("keyboard"),
          input: document.activeElement && document.activeElement.id,
          htmlOverflow: getComputedStyle(document.documentElement).overflow,
          bodyOverflow: getComputedStyle(document.body).overflow,
          mainOverflow: getComputedStyle(document.querySelector("#main")).overflowY,
        };
      });
      const rest = await measure();
      assert.equal(rest.htmlOverflow, "hidden", JSON.stringify(rest));
      assert.equal(rest.bodyOverflow, "hidden", JSON.stringify(rest));
      assert.equal(rest.mainOverflow, "auto", JSON.stringify(rest));
      assert.ok(Math.abs(rest.layout - rest.composerBottom - inset) <= 2, "resting " + JSON.stringify(rest));
      for (const [pan, innerToo] of [[false, false], [true, false], [false, true]]) {
        await page.locator("#input").tap();
        await page.evaluate(([p, inner]) => window.__kb.open(336, p, inner), [pan, innerToo]);
        let open = await measure();
        assert.equal(open.scrollY, 0, "the page must not stay scrolled, pan " + pan + " inner " + innerToo + " " + JSON.stringify(open));
        assert.equal(open.keyboard, true, JSON.stringify(open));
        assert.equal(open.input, "input", JSON.stringify(open));
        assert.ok(Math.abs(open.composerBottom - open.vvBottom) <= 2, "composer rides the keyboard, pan " + pan + " " + JSON.stringify(open));
        await page.waitForTimeout(700);
        open = await measure();
        assert.equal(open.scrollY, 0, "still at 0 after the settle timers " + JSON.stringify(open));
        assert.ok(Math.abs(open.composerBottom - open.vvBottom) <= 2, "still on the keyboard " + JSON.stringify(open));
        if (!pan) {
          await page.evaluate(() => {
            const box = document.createElement("div");
            box.id = "fake-keyboard";
            box.style.cssText = "position:fixed;left:0;right:0;bottom:0;height:336px;background:#cfd2d9;z-index:99;";
            document.body.append(box);
          });
          await page.screenshot({ path: path.join(SHOTS, "keyboard-390.png") });
          await page.evaluate(() => document.querySelector("#fake-keyboard").remove());
        }
        // Closing: an installed app often leaves visualViewport short and sends nothing.
        await page.evaluate(() => window.__kb.close(70, true));   // visualViewport and innerHeight both stay short
        await page.evaluate(() => document.activeElement.blur());
        await page.waitForTimeout(700);
        const closed = await measure();
        assert.equal(closed.inner, closed.layout - 70, "innerHeight really is stale in this run " + JSON.stringify(closed));
        assert.equal(closed.inlineHeight, "", "closed: no inline height, CSS owns the shell " + JSON.stringify(closed));
        assert.equal(closed.keyboard, false, JSON.stringify(closed));
        assert.equal(closed.scrollY, 0, JSON.stringify(closed));
        assert.ok(Math.abs(closed.layout - closed.composerBottom - inset) <= 2, "no gap under the composer after close, pan " + pan + " " + JSON.stringify(closed));
        assert.ok(Math.abs(closed.shellBottom - closed.layout) <= 1, "shell is the full height again " + JSON.stringify(closed));
      }
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("swipe left on a session row reveals Delete, one row open at a time, delete goes to trash at 390", async () => {
    const dir = project("swipe-delete");
    const make = async (word, extra = "") => {
      const started = await api("POST", "/api/turns", { cwd: dir, prompt: extra + "[[say " + word + "]]", permissionMode: "default", skeptic: "off" });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      return started.json.sessionId;
    };
    const alpha = await make("swipe-alpha");
    const bravo = await make("swipe-bravo");
    const fill = [];
    for (let i = 0; i < 14; i++) fill.push(await make("swipe-fill-" + i));
    for (const id of [alpha, bravo, ...fill]) await idle(id);
    const busy = await make("swipe-running", "[[sleep 8000]]");
    await waitFor(async () => (await session(busy)).running, 5000, "running turn");
    const chromium = await loadChromium("swipe delete");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      const cdp = await page.context().newCDPSession(page);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.locator(".row-wrap").first().waitFor();
      const wrapFor = (word) => page.locator(".row-wrap").filter({ hasText: word });
      const left = (word) => wrapFor(word).evaluate((el) => Math.round(el.scrollLeft));
      // A finger: touchStart, ten small moves, touchEnd.
      const drag = async (x, y, dx, dy) => {
        const point = (px, py) => [{ x: px, y: py }];
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(x, y) });
        for (let i = 1; i <= 10; i++) {
          await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x + (dx * i) / 10, y + (dy * i) / 10) });
          await page.waitForTimeout(16);
        }
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      };
      const swipe = async (word, dx) => {
        await wrapFor(word).scrollIntoViewIfNeeded();
        const box = await wrapFor(word).boundingBox();
        await drag(box.x + box.width * 0.85, box.y + box.height / 2, dx, 0);
        await page.waitForTimeout(450);
      };
      // The row is one flex child and Delete sits beside it, so nothing overlaps and nothing is absolutely placed.
      const shape = await wrapFor("swipe-alpha").evaluate((el) => {
        const row = el.querySelector(".row");
        const del = el.querySelector(".row-delete");
        return { rowPos: getComputedStyle(row).position, delPos: getComputedStyle(del).position, delLeft: del.getBoundingClientRect().left, width: el.clientWidth, rowRight: row.getBoundingClientRect().right };
      });
      assert.equal(shape.rowPos, "static", JSON.stringify(shape));
      assert.equal(shape.delPos, "static", JSON.stringify(shape));
      assert.ok(shape.delLeft >= shape.rowRight - 1, "Delete is beside the row, not under it " + JSON.stringify(shape));
      assert.equal(await left("swipe-alpha"), 0);
      await swipe("swipe-alpha", -140);
      const open = await left("swipe-alpha");
      assert.ok(open >= 80 && open <= 110, "alpha swiped open, scrollLeft " + open + " " + JSON.stringify(await wrapFor("swipe-alpha").evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX, kids: [...el.children].map((c) => c.className + ":" + Math.round(c.getBoundingClientRect().width)) }))));
      const del = await wrapFor("swipe-alpha").locator(".row-delete").evaluate((el) => {
        const r = el.getBoundingClientRect();
        const [red, green, blue] = getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number);
        return { left: r.left, right: r.right, label: el.textContent, red, green, blue };
      });
      assert.ok(del.right <= 390 && del.left >= 390 - 120 && del.right - del.left >= 90, "Delete is on screen and tappable " + JSON.stringify(del));
      assert.ok(del.red > 200 && del.green < 120 && del.blue < 120, "Delete is red " + JSON.stringify(del));
      assert.equal(del.label, "Delete");
      // One row open at a time.
      await swipe("swipe-bravo", -140);
      assert.ok((await left("swipe-bravo")) >= 80, "bravo is open");
      assert.equal(await left("swipe-alpha"), 0, "alpha closed itself when bravo opened");
      await page.screenshot({ path: path.join(SHOTS, "swipe-delete-390.png") });
      // Vertical scrolling still works over the rows, and does not open one.
      await page.locator("#main").click({ position: { x: 20, y: 5 } });
      await page.waitForTimeout(450);
      const before = await page.evaluate(() => document.querySelector(".list-body").scrollTop);
      const listBox = await page.locator(".list-body").boundingBox();
      await drag(listBox.x + 120, listBox.y + listBox.height * 0.3, 0, 260);
      await page.waitForTimeout(350);
      const scrolled = await page.evaluate(() => ({ top: document.querySelector(".list-body").scrollTop, open: [...document.querySelectorAll(".row-wrap")].filter((el) => el.scrollLeft > 4).length }));
      assert.ok(Math.abs(scrolled.top - before) > 50, "the list scrolled " + JSON.stringify({ before, scrolled }));
      assert.equal(scrolled.open, 0, "a vertical swipe opened a row " + JSON.stringify(scrolled));
      // Tap Delete: a confirm names the session; Cancel leaves it; Esc and the backdrop also leave it.
      await swipe("swipe-bravo", -140);
      await wrapFor("swipe-bravo").locator(".row-delete").click();
      await page.waitForSelector("#confirm:not([hidden])");
      const dialog = await page.locator("#confirm .confirm-panel").evaluate((el) => ({
        role: el.getAttribute("role"),
        title: el.querySelector("h2").textContent,
        buttons: [...el.querySelectorAll("button")].map((b) => b.textContent),
        danger: el.querySelector(".confirm-go").classList.contains("danger"),
      }));
      assert.equal(dialog.role, "alertdialog");
      assert.match(dialog.title, /swipe-bravo/);
      assert.deepEqual(dialog.buttons, ["Delete", "Cancel"]);
      assert.equal(dialog.danger, true);
      await page.locator("#confirm .confirm-cancel").click();
      await page.waitForSelector("#confirm", { state: "hidden" });
      assert.equal(await wrapFor("swipe-bravo").count(), 1, "Cancel keeps the session");
      await wrapFor("swipe-bravo").locator(".row-delete").click({ force: true });
      await page.waitForSelector("#confirm:not([hidden])");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#confirm", { state: "hidden" });
      assert.equal((await api("GET", "/api/sessions/" + bravo)).status, 200, "Esc keeps the session");
      // Running: the confirm says stop first and offers no Delete; the server refuses too.
      await swipe("swipe-running", -140);
      await wrapFor("swipe-running").locator(".row-delete").click();
      await page.waitForSelector("#confirm:not([hidden])");
      const warn = await page.locator("#confirm .confirm-panel").evaluate((el) => ({ title: el.querySelector("h2").textContent, buttons: [...el.querySelectorAll("button")].map((b) => b.textContent) }));
      assert.equal(warn.title, "Stop it first");
      assert.deepEqual(warn.buttons, ["OK"]);
      await page.locator("#confirm .confirm-cancel").click();
      assert.equal((await api("DELETE", "/api/sessions/" + busy, {})).status, 409);
      // Delete for real: the row goes, and the folder is in data/trash.
      await wrapFor("swipe-bravo").locator(".row-delete").click({ force: true });
      await page.waitForSelector("#confirm:not([hidden])");
      await page.locator("#confirm .confirm-go").click();
      await page.waitForSelector("#confirm", { state: "hidden" });
      await wrapFor("swipe-bravo").waitFor({ state: "detached" });
      assert.equal((await api("GET", "/api/sessions/" + bravo)).status, 404);
      const trashed = fs.readdirSync(path.join(DATA, "trash")).filter((name) => name.startsWith(bravo));
      assert.equal(trashed.length, 1, "bravo is in data/trash: " + trashed);
      await wrapFor("swipe-alpha").waitFor();
      assert.equal(await wrapFor("swipe-alpha").count(), 1, "the other rows stay");
      await idle(busy);
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("desktop: a row's trash button deletes with the same confirm at 1440", async () => {
    const dir = project("trash-desktop");
    const made = [];
    for (const word of ["trash-one", "trash-two"]) {
      const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say " + word + "]]", permissionMode: "default", skeptic: "off" });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      made.push(started.json.sessionId);
    }
    for (const id of made) await idle(id);
    const chromium = await loadChromium("desktop delete");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(BASE + "/s/" + made[0], { waitUntil: "domcontentloaded" });
      const rowFor = (word) => page.locator("#side .side-row").filter({ hasText: word });
      await rowFor("trash-two").waitFor();
      assert.equal(await rowFor("trash-two").locator(".side-del").isVisible(), false, "trash stays hidden until hover");
      await rowFor("trash-two").hover();
      assert.equal(await rowFor("trash-two").locator(".side-del").isVisible(), true);
      assert.equal(await rowFor("trash-one").locator(".side-del").count(), 0, "the open session has one way to delete: its menu");
      await rowFor("trash-two").locator(".side-del").click();
      await page.waitForSelector("#confirm:not([hidden])");
      assert.match(await page.locator("#confirm h2").innerText(), /trash-two/);
      await page.locator("#confirm .confirm-cancel").click();
      assert.equal(await rowFor("trash-two").count(), 1);
      await rowFor("trash-two").hover();
      await rowFor("trash-two").locator(".side-del").click();
      await page.locator("#confirm .confirm-go").click();
      await rowFor("trash-two").waitFor({ state: "detached" });
      assert.equal((await api("GET", "/api/sessions/" + made[1])).status, 404);
      assert.equal(fs.readdirSync(path.join(DATA, "trash")).filter((name) => name.startsWith(made[1])).length, 1);
      // Deleting the open session leaves it.
      await rowFor("trash-one").locator(".side-menu").click();
      await page.locator("#sheet .sheet-item").filter({ hasText: /^Delete session/ }).click();
      await page.waitForSelector("#confirm:not([hidden])");
      assert.match(await page.locator("#confirm h2").innerText(), /trash-one/);
      await page.locator("#confirm .confirm-go").click();
      await page.waitForURL(BASE + "/");
      await rowFor("trash-one").waitFor({ state: "detached" });
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("composer menus are one frosted popover above their button, at 390 and 1440, light and dark", async () => {
    const dir = project("popover-menus");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hello]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    const chromium = await loadChromium("popover menus");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      const menus = [
        ["+", "#attach", { icons: true, checks: 0 }],
        ["Mode", "#optbar [data-mode]", { icons: true, checks: 1 }],
        ["Reasoning", "#optbar [data-reasoning]", { icons: true, checks: 1 }],
        ["settings", ".opt-cog", { icons: true, checks: 1 }],
      ];
      for (const [width, height] of [[390, 844], [1440, 900]]) {
        for (const appearance of ["dark", "light"]) {
          const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
          await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
          await page.addInitScript((mode) => localStorage.setItem("gm-appearance", mode), appearance);
          await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          await page.waitForFunction((mode) => document.documentElement.dataset.appearance === mode, appearance);
          const tag = width + " " + appearance;
          for (const [name, trigger, want] of menus) {
            await page.locator(trigger).click();
            await page.waitForSelector("#sheet:not([hidden]) .sheet-panel");
            const m = await page.evaluate((sel) => {
              const panel = document.querySelector("#sheet .sheet-panel");
              const btn = document.querySelector(sel).getBoundingClientRect();
              const box = panel.getBoundingClientRect();
              const cs = getComputedStyle(panel);
              const rows = [...panel.querySelectorAll(".sheet-item")];
              const fg = getComputedStyle(document.documentElement).getPropertyValue("--chat-fg").trim();
              const probe = document.createElement("i");
              probe.style.color = fg;
              document.body.append(probe);
              const ink = getComputedStyle(probe).color;
              probe.remove();
              const alpha = (c) => {
                const slash = c.match(/\/\s*([\d.]+)\s*\)/);
                if (slash) return Number(slash[1]);
                return c.match(/rgba?\(([^)]+)\)/)?.[1].split(",").map(Number)[3] ?? 1;
              };
              return {
                width: window.innerWidth,
                gap: Math.round(btn.top - box.bottom),
                left: Math.round(box.left),
                right: Math.round(box.right),
                top: Math.round(box.top),
                position: cs.position,
                radius: parseFloat(cs.borderTopLeftRadius),
                blur: (cs.backdropFilter || cs.webkitBackdropFilter || "").includes("blur"),
                border: cs.borderTopWidth,
                translucent: alpha(cs.backgroundColor) < 1,
                overlay: getComputedStyle(document.querySelector("#sheet")).backgroundColor,
                rows: rows.map((r) => ({ h: Math.round(r.getBoundingClientRect().height), border: getComputedStyle(r).borderBottomWidth, weight: getComputedStyle(r.querySelector(".sheet-label")).fontWeight, icon: !!r.querySelector(":scope > .ico"), ink: getComputedStyle(r.querySelector(".sheet-label")).color, danger: r.classList.contains("danger") })),
                checks: panel.querySelectorAll(".sheet-check").length,
                checked: panel.querySelectorAll("[aria-checked='true']").length,
                fgInk: ink,
                chrome: panel.querySelectorAll("button.close, .sheet-item.close").length,
              };
            }, trigger);
            const where = tag + " " + name + " " + JSON.stringify(m);
            assert.equal(m.position, "fixed", where);
            assert.ok(m.gap >= 4 && m.gap <= 16, "above the button " + where);
            assert.ok(m.left >= 8 - 1 && m.right <= m.width - 8 + 1 && m.top >= 8 - 1, "clamped on screen " + where);
            assert.ok(m.radius >= 24, "radius " + where);
            assert.equal(m.blur, true, "frosted " + where);
            assert.equal(m.border, "1px", where);
            assert.equal(m.translucent, true, "translucent " + where);
            assert.match(m.overlay, /rgba\(0, 0, 0, 0\)|transparent/, "no dim " + where);
            assert.ok(m.rows.length >= 2, where);
            for (const row of m.rows) {
              assert.ok(row.h >= 44 && row.h <= 48, "row height " + where);
              assert.equal(row.border, "0px", "no dividers " + where);
              assert.equal(row.weight, "400", "regular weight " + where);
              assert.equal(row.icon, true, "line icon " + where);
              if (!row.danger) assert.equal(row.ink, m.fgInk, "label follows the " + appearance + " token " + where);
            }
            assert.equal(m.checks, want.checks, "one selected row " + where);
            assert.equal(m.checked, want.checks, where);
            assert.equal(m.chrome, 0, "no Close row " + where);
            if (name === "Reasoning") {
              assert.match(await page.locator("#sheet").innerText(), /pstack's poteto-mode/);
              if (appearance === "dark") await page.screenshot({ path: path.join(SHOTS, width === 390 ? "menus-390.png" : "menus-1440.png") });
            }
            // Outside tap closes; Esc closes.
            await page.mouse.click(width - 4, 4);
            await page.waitForSelector("#sheet", { state: "hidden" });
            await page.locator(trigger).click();
            await page.waitForSelector("#sheet:not([hidden]) .sheet-panel");
            await page.keyboard.press("Escape");
            await page.waitForSelector("#sheet", { state: "hidden" });
          }
          // The settings icon is a gear, not a sun: eight teeth in one outline, and a hub.
          const gear = await page.evaluate(() => [".opt-cog svg", ].map((sel) => {
            const paths = [...document.querySelector(sel).querySelectorAll("path")].map((el) => el.getAttribute("d"));
            return { teeth: (paths[0].match(/L/g) || []).length, rays: paths.some((d) => d.includes("v2.1")), size: document.querySelector(sel).getBoundingClientRect().width };
          })[0]);
          assert.ok(gear.teeth >= 30 && !gear.rays && gear.size === 18, tag + " " + JSON.stringify(gear));
          await page.close();
        }
      }
      // A narrow phone: the popover still fits.
      const narrow = await browser.newPage({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 1 });
      await narrow.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await narrow.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await narrow.waitForSelector("#optbar:not([hidden])");
      await narrow.locator("#optbar [data-reasoning]").click();
      const fit = await narrow.locator("#sheet .sheet-panel").evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: window.innerWidth, h: window.innerHeight };
      });
      assert.ok(fit.left >= 7 && fit.right <= fit.w - 7 && fit.top >= 7 && fit.bottom <= fit.h, JSON.stringify(fit));
      await narrow.close();
    } finally {
      await browser.close();
    }
  });

  await check("usage footer sits 12px above the bottom safe area, phone and desktop", async () => {
    const chromium = await loadChromium("usage footer padding");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
      await phone.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      const cdp = await phone.context().newCDPSession(phone);
      let inset = 0;
      try {
        await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 47, bottom: 34, left: 0, right: 0 } });
        inset = 34;
      } catch {}
      await phone.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await phone.locator("#main .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      const m = await phone.evaluate(() => {
        const foot = document.querySelector(".list-foot");
        const bar = document.querySelector(".list-foot .plan-usage").getBoundingClientRect();
        const app = document.querySelector("#app");
        return { padding: parseFloat(getComputedStyle(foot).paddingBottom), shell: parseFloat(getComputedStyle(app).paddingBottom), room: window.innerHeight - bar.bottom, layout: window.innerHeight };
      });
      assert.equal(m.shell, 0, "the shell does not add the inset a second time " + JSON.stringify(m));
      assert.equal(m.padding, 12 + inset, JSON.stringify(m));
      assert.ok(Math.abs(m.room - (12 + inset)) <= 5, "the usage bar clears the bottom by the inset plus the padding " + JSON.stringify(m));
      await phone.screenshot({ path: path.join(SHOTS, "sessions-390-v3.png") });
      await phone.close();
      const desk = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await desk.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await desk.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await desk.locator("#side .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      const side = await desk.evaluate(() => parseFloat(getComputedStyle(document.querySelector("#side .side-foot")).paddingBottom));
      assert.equal(side, 12);
      await desk.close();
    } finally {
      await browser.close();
    }
  });

  // The consistency pass, kept as a test so it stays true: on every screen, at 390 and 1440, light and dark, spacing is on
  // the scale, radii are from one set, icons are 18px with a 1.5px stroke, text has contrast 4:1 on its own background, no
  // two controls share a name, and a selected control does not look like the ones beside it.
  await check("consistency: spacing, radii, icons, contrast, duplicates and active states on every screen", async () => {
    const dir = project("audit");
    const made = [];
    for (const word of ["audit one", "audit two"]) {
      const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say " + word + "]]", permissionMode: "default", skeptic: "off" });
      made.push(started.json.sessionId);
    }
    const richAudit = await api("POST", "/api/turns", {
      cwd: dir, prompt: "[[run echo hello]][[write notes.txt a]][[say Done. Snippet:\n\n```js\nconst answer = 42;\n```\n\n- one\n- two]]", permissionMode: "default", skeptic: "off",
    });
    for (const id of [...made, richAudit.json.sessionId]) await idle(id);
    const askAudit = await api("POST", "/api/turns", { cwd: dir, prompt: "[[perm]]", permissionMode: "default", skeptic: "off" });
    await waitFor(async () => (await session(askAudit.json.sessionId)).running, 5000, "approval turn");
    const chromium = await loadChromium("audit");
    const browser = await launchChromium(chromium);
    const found = new Map();
    const note = (key, where) => found.set(key, (found.get(key) || new Set()).add(where));
    try {
      const token = cookie.split("=")[1];
      for (const [width, height] of [[390, 844], [1440, 900]]) {
        for (const appearance of ["dark", "light"]) {
          const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
          await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
          await page.addInitScript((mode) => localStorage.setItem("gm-appearance", mode), appearance);
          const scan = async (screen) => {
            await page.waitForTimeout(300);   // let 200ms transitions finish before measuring colours
            const rows = await page.evaluate((screenName) => {
              const out = [];
              const root = getComputedStyle(document.documentElement);
              const px = (v) => parseFloat(v);
              const visible = (el) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && !el.closest("[hidden]");
              };
              const classes = (el) => (el.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
              const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (classes(el) ? "." + classes(el) : "") + (el.tagName.toLowerCase() === "svg" && el.parentElement ? " in " + el.parentElement.tagName.toLowerCase() + (el.parentElement.id ? "#" + el.parentElement.id : "") + (classes(el.parentElement) ? "." + classes(el.parentElement) : "") : "");
              for (const el of document.querySelectorAll("body *")) {
                if (!visible(el)) continue;
                if (el.tagName === "path" || el.tagName === "rect" || el.tagName === "circle" || el.closest("svg") && el.tagName.toLowerCase() !== "svg") continue;
                const cs = getComputedStyle(el);
                if (el instanceof SVGElement && el.tagName.toLowerCase() === "svg") {
                  const r = el.getBoundingClientRect();
                  out.push({ screen: screenName, el: name(el), kind: "icon", w: Math.round(r.width), h: Math.round(r.height), stroke: cs.strokeWidth });
                  continue;
                }
                out.push({
                  screen: screenName, el: name(el), kind: "box",
                  radius: cs.borderTopLeftRadius, pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(px),
                  gap: cs.rowGap === "normal" ? 0 : px(cs.rowGap), cgap: cs.columnGap === "normal" ? 0 : px(cs.columnGap),
                  h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width), fs: cs.fontSize, fw: cs.fontWeight,
                });
              }
              // Text against the nearest opaque background behind it (WCAG contrast).
              const rgb = (c) => {
                const m = c.match(/rgba?\(([^)]+)\)/);
                if (m) { const [r, g, b, a] = m[1].split(",").map(Number); return { r, g, b, a: a === undefined ? 1 : a }; }
                const k = c.match(/color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)/);
                return k ? { r: k[1] * 255, g: k[2] * 255, b: k[3] * 255, a: k[4] === undefined ? 1 : Number(k[4]) } : null;
              };
              const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
              const behind = (el) => {
                for (let n = el; n; n = n.parentElement) {
                  const c = rgb(getComputedStyle(n).backgroundColor);
                  if (c && c.a >= 0.5) return c;
                }
                return { r: 255, g: 255, b: 255 };
              };
              for (const el of document.querySelectorAll("body *")) {
                if (!visible(el) || el instanceof SVGElement) continue;
                const own = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(" ");
                if (!own) continue;
                const fg = rgb(getComputedStyle(el).color);
                if (!fg) continue;
                const bg = behind(el);
                const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
                const ratio = (hi + 0.05) / (lo + 0.05);
                if (ratio < 4) out.push({ screen: screenName, kind: "contrast", el: name(el), text: own.slice(0, 28), ratio: Math.round(ratio * 10) / 10 });
                const cs = getComputedStyle(el);
                out.push({ screen: screenName, kind: "type", el: name(el), text: own.slice(0, 22), size: parseFloat(cs.fontSize), weight: cs.fontWeight, family: cs.fontFamily.split(",")[0].replace(/["']/g, "").trim() });
              }
              for (const el of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
                if (!visible(el) || el.type === "hidden") continue;
                const ph = getComputedStyle(el, "::placeholder");
                out.push({ screen: screenName, kind: "type", el: name(el) + "::placeholder", text: el.getAttribute("placeholder").slice(0, 22), size: parseFloat(ph.fontSize), weight: ph.fontWeight, family: ph.fontFamily.split(",")[0].replace(/["']/g, "").trim() });
              }
              // Duplicate controls: two visible controls with the same name, other than the per-row ones that repeat on purpose.
              const names = new Map();
              for (const el of document.querySelectorAll("button, a[href], input, select, textarea")) {
                if (!visible(el) || el.closest(".msg, .toolcard, .code, .steps, .row-wrap, .side-row, .swatch, #sheet, .picker, .perm, .subcard, .step")) continue;
                const label = (el.getAttribute("aria-label") || el.textContent || el.getAttribute("placeholder") || "").trim().replace(/\s+/g, " ");
                if (!label) continue;
                names.set(label, (names.get(label) || 0) + 1);
              }
              for (const [label, count] of names) if (count > 1) out.push({ screen: screenName, kind: "duplicate", label, count });
              // Active states: a selected control has to look different from the ones beside it.
              const look = (el) => { const cs = getComputedStyle(el); return [cs.backgroundColor, cs.color, cs.boxShadow, cs.borderTopColor, cs.fontWeight, cs.outlineStyle].join("|"); };
              for (const on of document.querySelectorAll(".on, [aria-pressed='true'], [aria-selected='true'], [aria-current='page']")) {
                if (!visible(on) || on.closest("svg")) continue;
                const siblings = [...on.parentElement.children].filter((el) => el !== on && el.tagName === on.tagName && visible(el) && !el.classList.contains("on"));
                if (siblings.length && siblings.every((el) => look(el) === look(on))) out.push({ screen: screenName, kind: "active", el: name(on) });
              }
              return out;
            }, screen);
            for (const r of rows) {
              if (r.kind === "type") {
                // The type scale (see "Type scale" in app.css): one size and weight per role; mono only for code.
                const scale = ["13/400", "13/600", "14/600", "16/400", "16/600", "17/600", "20/700"];
                const mono = ["13/400", "13.5/400"];
                const pair = r.size + "/" + r.weight;
                const isMono = /mono|menlo|consolas|courier/i.test(r.family);
                if (r.size > 0 && !(isMono ? mono : scale).includes(pair)) note("type " + pair + (isMono ? " mono" : "") + " " + r.el + " '" + r.text + "'", width + appearance + " " + r.screen);
                continue;
              }
              if (r.kind === "duplicate") { note("duplicate control '" + r.label + "' x" + r.count, width + appearance + " " + screen); continue; }
              if (r.kind === "active") { note("selected state looks like the rest: " + r.el, width + appearance + " " + screen); continue; }
              if (r.kind === "contrast") { note("contrast " + r.ratio + " " + r.el + " '" + r.text + "'", width + appearance + " " + screen); continue; }
              if (r.kind === "icon") {
                if (r.w !== r.h || ![18, 16, 14].includes(r.w) || r.stroke !== "1.5px") note("icon " + r.el + " " + r.w + "x" + r.h + " stroke " + r.stroke, width + appearance + " " + screen);
                continue;
              }
              const allowedRadius = ["0px", "4px", "6px", "8px", "12px", "16px", "20px", "24px", "28px", "50%", "999px"];
              const radius = r.radius.includes("e+") || parseFloat(r.radius) > 900 ? "999px" : r.radius;
              // A bar or a grip a few pixels tall rounds to its own height.
              if (!allowedRadius.includes(radius) && !(r.h <= 8 && parseFloat(radius) <= 4) && !(r.w <= 8 && parseFloat(radius) <= 4)) note("radius " + r.el + " " + r.radius, width + appearance + " " + screen);
              const scale = [0, 4, 8, 12, 16, 20, 24, 32];
              // Padding past 40px is the reading column centring itself on a wide window, not a spacing choice.
              for (const v of [...r.pad, r.gap, r.cgap]) if (!scale.includes(v) && !(v === 1 || v === 2) && v <= 40) note("space " + r.el + " " + v + "px", width + appearance + " " + screen);
            }
          };
          await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
          await page.waitForFunction((mode) => document.documentElement.dataset.appearance === mode, appearance);
          await page.waitForTimeout(500);
          await scan("home");
          await page.locator("input.list-search, input.side-search").first().fill("zzzz-no-such-session");
          await scan("home no matches");
          await page.goto(BASE + "/new", { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          await scan("new");
          await page.goto(BASE + "/s/" + made[0], { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          await scan("chat");
          await page.goto(BASE + "/s/" + richAudit.json.sessionId, { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          await page.locator(".steps summary, .steps").first().click().catch(() => {});
          await page.waitForTimeout(400);
          await scan("rich chat");
          await page.goto(BASE + "/s/" + askAudit.json.sessionId, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(".perm, .toolcard.asking", { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(400);
          await scan("approval");
          await page.goto(BASE + "/s/" + made[0], { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          for (const [name, trigger] of [["plus", "#attach"], ["mode", "#optbar [data-mode]"], ["reason", "#optbar [data-reasoning]"], ["cog", ".opt-cog"]]) {
            await page.locator(trigger).click();
            await page.waitForSelector("#sheet:not([hidden]) .sheet-panel");
            await scan("popover " + name);
            await page.keyboard.press("Escape");
          }
          await openSessionSettings(page);
          await page.waitForSelector("#setsheet:not([hidden]) .swatch");
          await scan("session settings");
          await page.locator("#setsheet .set-done").click();
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
    await api("POST", "/api/sessions/" + askAudit.json.sessionId + "/cancel", {}).catch(() => {});
    const lines = [...found.entries()].map(([key, where]) => key + "   <- " + [...where].slice(0, 4).join(" | ") + (where.size > 4 ? " +" + (where.size - 4) : "")).sort();
    assert.deepEqual(lines, [], "inconsistent:\n" + lines.join("\n"));
  });

  await check("consistency shots: every screen, 390 and 1440, light and dark", async () => {
    const dir = project("cons-shots");
    const rich = await api("POST", "/api/turns", {
      cwd: dir,
      prompt: "[[run echo hello]][[write notes.txt a]][[say Done. Here is a snippet:\n\n```js\nconst answer = 42;\nconsole.log(answer);\n```\n\nAnd a list:\n\n- one\n- two]]",
      permissionMode: "default",
      skeptic: "off",
    });
    const plain = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say second session]]", permissionMode: "default", skeptic: "off" });
    await idle(rich.json.sessionId);
    await idle(plain.json.sessionId);
    const ask = await api("POST", "/api/turns", { cwd: dir, prompt: "[[perm]]", permissionMode: "default", skeptic: "off" });
    await waitFor(async () => (await session(ask.json.sessionId)).running, 5000, "approval turn");
    const chromium = await loadChromium("consistency shots");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      for (const [width, height] of [[390, 844], [1440, 900]]) {
        for (const appearance of ["dark", "light"]) {
          const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
          await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
          await page.addInitScript((mode) => localStorage.setItem("gm-appearance", mode), appearance);
          const shot = async (name) => page.screenshot({ path: path.join(SHOTS, "cons-" + name + "-" + width + "-" + appearance + ".png") });
          await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
          await page.waitForFunction((mode) => document.documentElement.dataset.appearance === mode, appearance);
          await page.waitForTimeout(600);
          await shot("home");
          await page.goto(BASE + "/s/" + rich.json.sessionId, { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          await page.waitForTimeout(500);
          await shot("chat");
          await page.locator(".steps > summary").first().click();
          await page.locator(".steps[open] .toolcard, .steps[open] .step").first().waitFor();
          for (const detail of await page.locator(".steps[open] details.tool > summary").all()) await detail.click().catch(() => {});
          await page.waitForTimeout(300);
          await page.locator(".steps[open]").first().evaluate((el) => el.scrollIntoView({ block: "start" }));
          await page.waitForTimeout(200);
          await shot("steps");
          await page.goto(BASE + "/s/" + ask.json.sessionId, { waitUntil: "domcontentloaded" });
          await page.waitForSelector(".perm, .toolcard.asking", { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(500);
          await shot("approval");
          await page.goto(BASE + "/new", { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          await shot("new");
          await page.goto(BASE + "/s/" + plain.json.sessionId, { waitUntil: "domcontentloaded" });
          await page.waitForSelector("#optbar:not([hidden])");
          await openSessionSettings(page);
          await page.waitForSelector("#setsheet:not([hidden]) .swatch");
          await page.waitForTimeout(300);
          await shot("settings");
          await page.locator("#setsheet .set-done").click();
          await page.locator("#attach").click();
          await page.waitForSelector("#sheet:not([hidden]) .sheet-panel");
          await shot("menu");
          await page.keyboard.press("Escape");
          await page.locator("#optbar [data-mode]").click();
          await page.locator("#sheet .sheet-item").filter({ hasText: /^Loops/ }).click();
          await page.waitForSelector("#sheet input[aria-label='Loop interval']");
          await shot("loops");
          await page.keyboard.press("Escape");
          await page.close();
        }
      }
      await api("POST", "/api/sessions/" + ask.json.sessionId + "/cancel", {}).catch(() => {});
    } finally {
      await browser.close();
    }
  });

  await check("?debug=vv shows the viewport numbers, and only then", async () => {
    const dir = project("debug-vv");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hello]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    const chromium = await loadChromium("debug overlay");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#composer:not([hidden]) .composer-bar");
      assert.equal(await page.locator("#vv-debug").count(), 0, "no overlay unless asked for");
      await page.goto(BASE + "/s/" + id + "?debug=vv", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#vv-debug");
      await page.waitForFunction(() => /shell h\s+\d/.test(document.querySelector("#vv-debug").textContent));
      const shown = await page.locator("#vv-debug").evaluate((el) => ({
        text: el.textContent,
        pointer: getComputedStyle(el).pointerEvents,
        position: getComputedStyle(el).position,
      }));
      for (const label of ["innerHeight", "100vh probe", "vv.height", "vv.offsetTop", "scrollY", "shell h", "composer bottom", "--vv-height", "keyboard", "focus", "standalone"]) {
        assert.ok(shown.text.includes(label), label + " in " + shown.text);
      }
      assert.match(shown.text, /innerHeight\s+844/);
      assert.match(shown.text, /shell h\s+844/);
      assert.match(shown.text, /--vv-height\s+\(css\)/, "closed: the CSS owns the shell");
      assert.equal(shown.pointer, "none", "it never takes a tap");
      assert.equal(shown.position, "fixed");
      await page.locator("#input").tap();
      await page.evaluate(() => window.__gm.applyViewport({ offsetTop: 0, height: window.innerHeight - 336 }));
      await page.waitForTimeout(600);
      assert.match(await page.locator("#vv-debug").innerText(), /focus\s+textarea/);
      await page.screenshot({ path: path.join(SHOTS, "debug-vv-390.png") });
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("session settings: grouped cards, inline name, chip segments, tidy theme grid, no dividers, 390 and 1440", async () => {
    const dir = project("settings-design");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say settings design]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    const chromium = await loadChromium("settings design");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      for (const [width, height, appearance] of [[390, 844, "dark"], [390, 844, "light"], [1440, 900, "dark"], [1440, 900, "light"]]) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
        await page.addInitScript((mode) => localStorage.setItem("gm-appearance", mode), appearance);
        await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#optbar:not([hidden])");
        await page.waitForFunction((mode) => document.documentElement.dataset.appearance === mode, appearance);
        await openSessionSettings(page);
        await page.waitForSelector("#setsheet:not([hidden]) .swatch");
        await page.waitForFunction(() => document.querySelector("#usage .usage-grid"));
        await page.mouse.move(0, 0);
        await page.waitForTimeout(350);
        const tag = width + " " + appearance;
        const m = await page.evaluate(() => {
          const tok = (name) => {
            const probe = document.createElement("i");
            probe.style.color = "var(" + name + ")";
            document.body.append(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          };
          const box = (el) => el.getBoundingClientRect();
          const panel = document.querySelector("#setsheet .set-panel");
          const head = panel.querySelector(".set-head");
          const groups = [...panel.querySelectorAll(".set-group")];
          const swatches = [...panel.querySelectorAll(".swatch")];
          const on = swatches.filter((el) => el.classList.contains("on"));
          const segments = [...panel.querySelectorAll(".appearance-opt")];
          const name = panel.querySelector("#set-name");
          const nameStyle = getComputedStyle(name);
          const grid = panel.querySelector(".theme-grid");
          const vw = window.innerWidth;
          const inCard = (el) => !!el.closest(".set-card");
          return {
            vw, vh: window.innerHeight,
            panel: { left: box(panel).left, right: box(panel).right, top: box(panel).top, bottom: box(panel).bottom, width: box(panel).width, radius: parseFloat(getComputedStyle(panel).borderTopLeftRadius), bg: getComputedStyle(panel).backgroundColor, bgToken: tok("--chat-bg") },
            head: { title: head.querySelector("h2").textContent, border: getComputedStyle(head).borderBottomWidth, doneRight: box(head.querySelector(".set-done")).right, titleRight: box(head.querySelector("h2")).right, doneLeft: box(head.querySelector(".set-done")).left, doneH: Math.round(box(head.querySelector(".set-done")).height), doneRadius: parseFloat(getComputedStyle(head.querySelector(".set-done")).borderTopLeftRadius), panelRight: box(panel).right },
            labels: groups.map((g) => g.querySelector(":scope > h2").textContent),
            labelStyle: groups.map((g) => { const cs = getComputedStyle(g.querySelector(":scope > h2")); return { transform: cs.textTransform, size: parseFloat(cs.fontSize), color: cs.color }; }),
            dim: tok("--chat-fg-dim"),
            card: groups.map((g) => { const c = g.querySelector(":scope > .set-card"); const cs = getComputedStyle(c); return { ok: !!c, radius: parseFloat(cs.borderTopLeftRadius), bg: cs.backgroundColor, pad: parseFloat(cs.paddingTop), border: cs.borderTopWidth }; }),
            cardToken: tok("--chat-card"),
            bodyGap: getComputedStyle(panel.querySelector(".set-body")).rowGap,
            dividers: [...panel.querySelectorAll("hr, .set-group, .set-head")].filter((el) => el.tagName === "HR" || parseFloat(getComputedStyle(el).borderTopWidth) > 0 || parseFloat(getComputedStyle(el).borderBottomWidth) > 0).map((el) => el.className || el.tagName),
            looseControls: [...panel.querySelectorAll("input, select, .swatch, .appearance-opt, textarea")].filter((el) => !inCard(el)).map((el) => el.id || el.className),
            name: { inCard: inCard(name), border: nameStyle.borderTopWidth, bg: nameStyle.backgroundColor },
            segments: { n: segments.length, widths: segments.map((el) => Math.round(box(el).width)), tops: segments.map((el) => Math.round(box(el).top)), heights: segments.map((el) => Math.round(box(el).height)), radius: segments.map((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)), icons: segments.map((el) => !!el.querySelector(":scope > .ico")), onShadow: segments.filter((el) => el.classList.contains("on")).map((el) => getComputedStyle(el).boxShadow), offBg: segments.filter((el) => !el.classList.contains("on")).map((el) => getComputedStyle(el).backgroundColor), chipFill: tok("--chip-fill"), texts: segments.map((el) => el.textContent.trim()) },
            themes: { n: swatches.length, cols: getComputedStyle(grid).gridTemplateColumns.split(" ").length, gap: getComputedStyle(grid).columnGap, rowGap: getComputedStyle(grid).rowGap, widths: [...new Set(swatches.map((el) => Math.round(box(el).width)))], maxH: Math.max(...swatches.map((el) => Math.round(box(el).height))), radius: [...new Set(swatches.map((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius)))], names: swatches.every((el) => el.querySelector(".sw-name").textContent.trim().length > 0), on: on.length, onChecked: on.map((el) => el.getAttribute("aria-checked")), checkShown: swatches.map((el) => getComputedStyle(el.querySelector(".sw-check")).display !== "none").filter(Boolean).length, ring: on.map((el) => getComputedStyle(el).boxShadow !== "none"), checkSize: on.map((el) => Math.round(box(el.querySelector(".sw-check")).width)) },
          };
        });
        const where = tag + " " + JSON.stringify(m);
        // header: title left, Done right, in one row, no line under it
        assert.equal(m.head.title, "Session settings", where);
        assert.ok(m.head.titleRight <= m.head.doneLeft + 1 && m.head.panelRight - m.head.doneRight <= 24, "title and Done share the row " + where);
        assert.ok(m.head.doneH >= 40 && m.head.doneRadius >= 20, "Done is a pill " + where);
        assert.equal(m.head.border, "0px", where);
        assert.equal(m.panel.bg, m.panel.bgToken, "the sheet is the page colour " + where);
        // groups: small muted caps over a rounded card, in this order
        assert.deepEqual(m.labels, ["Name", "Appearance", "Theme", "Model", "Approvals", "Skeptical review", "Usage", "Directory"], where);
        for (const label of m.labelStyle) {
          assert.equal(label.transform, "uppercase", where);
          assert.ok(label.size <= 13, where);
          assert.equal(label.color, m.dim, "label is muted " + where);
        }
        for (const card of m.card) {
          assert.ok(card.ok && card.radius === 16 && card.bg === m.cardToken && card.pad === 16 && card.border === "1px", "rounded card " + where);
        }
        assert.equal(m.bodyGap, "20px", "the gap between cards is the only separator " + where);
        assert.deepEqual(m.dividers, [], "no stray dividers " + where);
        assert.deepEqual(m.looseControls, [], "every control sits in a card " + where);
        // name: the card is the field
        assert.ok(m.name.inCard && m.name.border === "0px" && m.name.bg === "rgba(0, 0, 0, 0)", "inline name " + where);
        // appearance: two chips in one row, the app's chip fill, a ring on the selected one
        assert.equal(m.segments.n, 2, where);
        assert.ok(Math.abs(m.segments.widths[0] - m.segments.widths[1]) <= 1 && m.segments.tops[0] === m.segments.tops[1], "two equal chips on one row " + where);
        assert.deepEqual(m.segments.heights, [44, 44], where);
        assert.ok(m.segments.radius.every((r) => r >= 20) && m.segments.icons.every(Boolean), where);
        assert.deepEqual(m.segments.texts, ["Dark", "Light"], where);
        assert.ok(m.segments.onShadow.length === 1 && m.segments.onShadow[0].includes("inset") && m.segments.onShadow[0].includes("1.5px"), "selected chip has the ring " + where);
        assert.ok(m.segments.offBg.every((bg) => bg === m.segments.chipFill), "unselected chip uses the chip fill " + where);
        // themes: three equal columns, 8px gaps, small tiles, one ring and one check
        assert.equal(m.themes.cols, 3, where);
        assert.ok(m.themes.gap === "8px" && m.themes.rowGap === "8px" && m.themes.widths.length === 1, "consistent gaps and widths " + where);
        assert.ok(m.themes.maxH <= 90, "tiles are small " + where);
        assert.deepEqual(m.themes.radius, [12], where);
        assert.ok(m.themes.names && m.themes.on === 1 && m.themes.onChecked[0] === "true" && m.themes.checkShown === 1 && m.themes.ring[0] === true, "one selected tile with a ring and a check " + where);
        // placement: a bottom sheet on the phone, a right panel on desktop
        if (width < 1024) {
          assert.ok(Math.abs(m.panel.bottom - m.vh) <= 1 && m.panel.radius >= 24 && Math.abs(m.panel.width - Math.min(600, m.vw)) <= 2, "bottom sheet " + where);
        } else {
          assert.ok(Math.abs(m.panel.right - m.vw) <= 1 && m.panel.width === 420 && Math.abs(m.panel.bottom - m.vh) <= 1 && m.panel.top <= 1, "right panel " + where);
        }
        if (appearance === "dark" && width === 390) await page.screenshot({ path: path.join(SHOTS, "settings-390-dark.png") });
        if (appearance === "light" && width === 390) await page.screenshot({ path: path.join(SHOTS, "settings-390-light.png") });
        if (appearance === "dark" && width === 1440) await page.screenshot({ path: path.join(SHOTS, "settings-1440.png") });
        await page.close();
      }
      // It works: the name saves, a theme saves, Light switches the app.
      const live = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await live.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await live.addInitScript(() => localStorage.setItem("gm-appearance", "dark"));
      await live.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await live.waitForSelector("#optbar:not([hidden])");
      await openSessionSettings(live);
      await live.waitForSelector("#setsheet:not([hidden]) .swatch");
      {
        const page = live;
        // it works: the name saves, a theme saves, Light switches the app
        {
          await page.locator("#set-name").fill("Settings redesign");
          await page.locator("#set-name").blur();
          await waitFor(async () => (await session(id)).session.title === "Settings redesign", 5000, "name saved");
          await page.locator(".swatch").filter({ hasText: "Nord" }).click();
          await waitFor(async () => (await session(id)).session.theme === "nord", 5000, "theme saved");
          assert.equal(await page.locator(".swatch.on").count(), 1);
          assert.equal(await page.locator(".swatch.on .sw-name").innerText(), "Nord");
          await page.locator(".appearance-opt", { hasText: "Light" }).click();
          await page.waitForFunction(() => document.documentElement.dataset.appearance === "light");
          assert.equal(await page.locator(".appearance-opt.on").innerText(), "Light");
          await api("PATCH", "/api/sessions/" + id, { theme: "" });
          await api("POST", "/api/theme", { appearance: "dark", pref: (await api("GET", "/api/theme")).json.pref || "purple" });   // the server remembers Light
        }
      }
      await live.close();
    } finally {
      await browser.close();
    }
  });

  await check("sessions list type matches the chat, composer and menu text, phone and desktop", async () => {
    const dir = project("list-type");
    const made = [];
    for (const word of ["list type one", "list type two", "list type three"]) {
      const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say " + word + "]]", permissionMode: "default", skeptic: "off" });
      made.push(started.json.sessionId);
    }
    for (const id of made) await idle(id);
    const chromium = await loadChromium("list type");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      const type = (el, pseudo) => { const cs = getComputedStyle(el, pseudo); return [parseFloat(cs.fontSize), cs.fontWeight, cs.fontFamily.split(",")[0].replace(/["']/g, "").trim()].join("/"); };
      for (const [width, height, appearance] of [[390, 844, "dark"], [390, 844, "light"], [1440, 900, "dark"], [1440, 900, "light"]]) {
        const phone = width < 1024;
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: phone ? 2 : 1 });
        await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
        await page.addInitScript((mode) => localStorage.setItem("gm-appearance", mode), appearance);
        // What the chat, the composer and the menus use.
        await page.goto(BASE + "/s/" + made[0], { waitUntil: "domcontentloaded" });
        await page.waitForSelector("#optbar:not([hidden])");
        await page.locator("#attach").click();
        await page.waitForSelector("#sheet:not([hidden]) .sheet-label");
        const chat = await page.evaluate((src) => {
          const type = new Function("el", "pseudo", "return (" + src + ")(el, pseudo)");
          const header = document.querySelector("#top h1");
          return {
            header: header && getComputedStyle(header).display !== "none" ? type(header) : null,
            body: type(document.querySelector(".msg-text")),
            menu: type(document.querySelector("#sheet .sheet-label")),
            composerPlaceholder: type(document.querySelector("#input"), "::placeholder"),
            chip: type(document.querySelector(".opt-chip")),
          };
        }, "(el, pseudo) => { const cs = getComputedStyle(el, pseudo); return [parseFloat(cs.fontSize), cs.fontWeight, cs.fontFamily.split(',')[0].replace(/[\"']/g, '').trim()].join('/'); }");
        await page.keyboard.press("Escape");
        await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
        await page.locator(phone ? ".row-wrap" : "#side .side-row").first().waitFor();
        await page.locator("#main .plan-usage-label, #side .plan-usage-label").first().waitFor();
        await page.mouse.move(0, 0);
        await page.waitForTimeout(300);
        const list = await page.evaluate((src) => {
          const type = new Function("el", "pseudo", "return (" + src + ")(el, pseudo)");
          const pick = (sel) => { const el = document.querySelector(sel); return el ? type(el) : null; };
          const root = phone => phone;
          return {
            title: pick(window.innerWidth < 1024 ? "#top h1" : "#side .side-head h2"),
            name: pick(".row-title, .side-title"),
            snippet: pick(".row-snippet, .side-snippet"),
            time: pick(".row-time, .side-time"),
            status: pick(".row-status, .side-status"),
            group: pick(".list-group"),
            search: (() => { const el = document.querySelector("input.list-search, input.side-search"); return { value: type(el), placeholder: type(el, "::placeholder") }; })(),
            create: pick("button.list-new, button.side-new"),
            footer: pick(".plan-usage-label"),
            footerLink: pick("#side .side-foot .linkish"),
            tops: [...document.querySelectorAll(".row-time, .side-time")].map((el) => type(el)),
          };
        }, "(el, pseudo) => { const cs = getComputedStyle(el, pseudo); return [parseFloat(cs.fontSize), cs.fontWeight, cs.fontFamily.split(',')[0].replace(/[\"']/g, '').trim()].join('/'); }");
        await page.locator("input.list-search, input.side-search").first().fill("zzzz-nothing");
        const empty = await page.evaluate((src) => {
          const type = new Function("el", "pseudo", "return (" + src + ")(el, pseudo)");
          return { title: type(document.querySelector(".list-empty-title")), sub: type(document.querySelector(".list-empty-sub")) };
        }, "(el, pseudo) => { const cs = getComputedStyle(el, pseudo); return [parseFloat(cs.fontSize), cs.fontWeight, cs.fontFamily.split(',')[0].replace(/[\"']/g, '').trim()].join('/'); }");
        const where = width + " " + appearance + " " + JSON.stringify({ chat, list, empty });
        assert.equal(list.title, "17/600/Inter", "header title is the title role " + where);
        if (chat.header) assert.equal(list.title, chat.header, "list header matches the chat header " + where);
        assert.equal(list.name, "16/600/Inter", "session name is body size, strong " + where);
        assert.equal(list.name.split("/")[0], chat.body.split("/")[0], "session name is the chat's text size " + where);
        assert.equal(list.name.split("/")[0], chat.menu.split("/")[0], "session name is the menu's text size " + where);
        assert.equal(list.name.split("/")[1], chat.header ? chat.header.split("/")[1] : "600", "one bold weight " + where);
        for (const part of ["snippet", "time", "status", "footer"]) assert.equal(list[part], "13/400/Inter", part + " is the caption role " + where);
        assert.equal(list.group, chat.chip, "group heading matches the chat chips " + where);
        assert.equal(list.search.value, chat.composerPlaceholder.replace(/\/\d+$/, "/Inter").replace(/^(\d+)\/(\d+)\/.*/, "$1/$2/Inter"), "search text matches the composer text " + where);
        assert.equal(list.search.placeholder, chat.composerPlaceholder, "search placeholder matches the composer placeholder " + where);
        assert.equal(list.search.placeholder.split("/")[0], "16", where);
        assert.equal(list.create, "14/600/Inter", "the New button is the label role " + where);
        if (!phone) assert.equal(list.footerLink, "14/600/Inter", where);
        assert.equal(empty.title, "16/600/Inter", where);
        assert.equal(empty.sub, "13/400/Inter", where);
        assert.ok(list.tops.every((t) => t === "13/400/Inter"), where);
        if (phone && appearance === "dark") {
          await page.locator("input.list-search").fill("");
          await page.locator("input.list-search").blur();
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(SHOTS, "sessions-390-v4.png") });
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  await check("expanded steps: a rail of flat rows, icon status, one box for input and output, at 390 and 1440", async () => {
    const dir = project("steps-open");
    const started = await api("POST", "/api/turns", {
      cwd: dir, prompt: "[[run echo hello]][[write notes.txt a]][[say Done.\n\n```js\nconst answer = 42;\n```]]", permissionMode: "default", skeptic: "off",
    });
    const id = started.json.sessionId;
    await idle(id);
    const chromium = await loadChromium("expanded steps");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      for (const [width, height, appearance] of [[390, 844, "dark"], [390, 844, "light"], [1440, 900, "dark"], [1440, 900, "light"]]) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
        await page.addInitScript((mode) => localStorage.setItem("gm-appearance", mode), appearance);
        await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".steps");
        const closed = await page.locator(".steps > summary .chev .ico").evaluate((el) => getComputedStyle(el).transform);
        await page.locator(".steps > summary").click();
        for (const row of await page.locator(".steps[open] details.tool > summary").all()) await row.click();
        await page.waitForTimeout(350);
        const m = await page.evaluate(() => {
          const tok = (name) => { const probe = document.createElement("i"); probe.style.color = "var(" + name + ")"; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; };
          const steps = document.querySelector(".steps[open]");
          const body = steps.querySelector(".steps-body");
          const rows = [...steps.querySelectorAll("details.step.tool")];
          const box = (el) => el.getBoundingClientRect();
          const font = (el) => { const cs = getComputedStyle(el); return parseFloat(cs.fontSize) + "/" + cs.fontWeight; };
          return {
            rail: getComputedStyle(body).borderLeftWidth + " " + getComputedStyle(body).borderRightWidth,
            rows: rows.length,
            flat: rows.every((el) => { const cs = getComputedStyle(el); return cs.borderTopWidth === "0px" && cs.backgroundColor === "rgba(0, 0, 0, 0)"; }),
            boxes: [...steps.querySelectorAll(".toolcard, details.step.tool, .tool-body, .tool-block")].filter((el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0).length,
            icon: rows.map((el) => { const i = el.querySelector(".tool-status > .ico"); const r = i && box(i); return { ok: !!i, w: r && Math.round(r.width), h: r && Math.round(r.height), words: el.querySelector(".tool-status").getAttribute("aria-label"), visible: el.querySelector(".tool-status").textContent.trim() === "" && el.querySelector(".tool-status").getAttribute("role") === "img" && !el.querySelector(".tool-status .sr"), title: el.querySelector(".tool-status").title, state: el.querySelector(".tool-status").dataset.s, color: getComputedStyle(el.querySelector(".tool-status")).color, ok_ink: tok("--ok-ink") }; }),
            name: rows.map((el) => font(el.querySelector(".tool-name"))),
            line: rows.map((el) => { const l = el.querySelector(".tool-line"); return { text: l.textContent, display: getComputedStyle(l).display, size: font(l), dup: l.textContent.toLowerCase() === el.querySelector(".tool-name").textContent.toLowerCase() }; }),
            chev: rows.map((el) => { const c = el.querySelector("summary .chev"); const s = box(el.querySelector("summary")); return { toRight: Math.round(s.right - box(c).right), open: getComputedStyle(c.querySelector(".ico")).transform }; }),
            caps: [...steps.querySelectorAll(".tool-cap")].map((el) => ({ font: font(el), upper: getComputedStyle(el).textTransform, color: getComputedStyle(el).color })),
            dim: tok("--chat-fg-dim"),
            pre: [...steps.querySelectorAll(".tool-pre")].map((el) => { const cs = getComputedStyle(el); return { radius: parseFloat(cs.borderTopLeftRadius), border: cs.borderTopWidth, bg: cs.backgroundColor, size: parseFloat(cs.fontSize), pad: [cs.paddingTop, cs.paddingLeft].join(" ") }; }),
            codeToken: tok("--chat-code"),
            count: font(steps.querySelector(".steps-count")),
            noteInHead: rows.every((el) => el.querySelectorAll("summary .tool-name").length === 1),
          };
        });
        const where = width + " " + appearance + " " + JSON.stringify(m);
        assert.equal(m.rows, 2, where);
        assert.equal(m.rail, "1px 0px", "steps hang off a rail " + where);
        assert.equal(m.flat, true, "step rows are flat, not cards " + where);
        assert.equal(m.boxes, 0, "no card, body or block is boxed inside the steps " + where);
        for (const icon of m.icon) {
          assert.ok(icon.ok && icon.w === 18 && icon.h === 18, "status is an 18px icon " + where);
          assert.equal(icon.words, "done", "the words are its aria-label " + where);
          assert.equal(icon.title, "done", where);
          assert.equal(icon.visible, true, "no text is drawn beside the icon " + where);
          assert.equal(icon.color, icon.ok_ink, "done is the ok colour " + where);
        }
        assert.ok(m.name.every((f) => f === "14/600"), "tool name is the label role " + where);
        for (const line of m.line) {
          assert.ok(!line.dup || line.display === "none", "a description that repeats the name is not shown " + where);
          if (line.display !== "none") assert.equal(line.size, "13/400", where);
        }
        assert.ok(m.chev.every((c) => c.toRight <= 12), "chevron sits at the row's right edge " + where);
        assert.ok(m.caps.length >= 3 && m.caps.every((c) => c.font === "13/600" && c.upper === "uppercase" && c.color === m.dim), "labels are small muted caps " + where);
        assert.ok(m.pre.length >= 3 && m.pre.every((p) => p.radius === 12 && p.border === "1px" && p.bg === m.codeToken && p.size === 13.5 && p.pad === "12px 16px"), "input and output are the only boxes " + where);
        assert.equal(m.count, "13/400", where);
        assert.notEqual(m.chev[0].open, closed, "the chevron turns when opened " + where);
        if (width === 390 && appearance === "dark") {
          await page.locator(".steps[open]").first().evaluate((el) => { el.scrollIntoView({ block: "start" }); document.querySelector("#main").scrollTop -= 16; });
          await page.waitForTimeout(200);
          await page.screenshot({ path: path.join(SHOTS, "steps-390-dark.png") });
        }
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  await check("a code block's copy button is an icon, and says Copied with a check", async () => {
    const dir = project("code-copy");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say Here:\n\n```js\nconst answer = 42;\n```]]", permissionMode: "default", skeptic: "off" });
    const id = started.json.sessionId;
    await idle(id);
    const chromium = await loadChromium("code copy");
    if (!chromium) return;
    const browser = await launchChromium(chromium);
    try {
      const token = cookie.split("=")[1];
      for (const [width, height, appearance] of [[390, 844, "dark"], [390, 844, "light"], [1440, 900, "dark"]]) {
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.addInitScript((mode) => localStorage.setItem("gm-appearance", mode), appearance);
        await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
        await page.waitForSelector(".code .copy");
        const shape = await page.locator(".code .copy").evaluate((el) => {
          const box = el.getBoundingClientRect();
          const icon = (sel) => { const i = el.querySelector(sel); const r = i.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(i).display, stroke: getComputedStyle(i).strokeWidth }; };
          const msg = document.querySelector(".msg-copy");
          return {
            text: el.textContent.trim(), label: el.getAttribute("aria-label"), box: [Math.round(box.width), Math.round(box.height)], fontSize: getComputedStyle(el).fontSize,
            copy: icon(".ico-copy"), check: icon(".ico-check"),
            sameAsMessage: !!msg && msg.querySelector(".ico-copy").innerHTML === el.querySelector(".ico-copy").innerHTML,
            bg: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth,
          };
        });
        const where = width + " " + appearance + " " + JSON.stringify(shape);
        assert.equal(shape.text, "", "no word on the button " + where);
        assert.equal(shape.label, "Copy code", where);
        assert.deepEqual(shape.box, [32, 32], where);
        assert.equal(shape.copy.w, 18, where);
        assert.equal(shape.copy.stroke, "1.5px", where);
        assert.equal(shape.check.display, "none", where);
        assert.ok(shape.sameAsMessage, "the same icon as the message copy " + where);
        assert.equal(shape.bg, "rgba(0, 0, 0, 0)", where);
        assert.equal(shape.border, "0px", where);
        await page.locator(".code .copy").click();
        await page.waitForFunction(() => document.querySelector(".code .copy").getAttribute("aria-label") === "Copied");
        const copied = await page.locator(".code .copy").evaluate((el) => ({ copied: el.classList.contains("copied"), icon: getComputedStyle(el.querySelector(".ico-copy")).display, check: getComputedStyle(el.querySelector(".ico-check")).display, text: el.textContent.trim() }));
        assert.deepEqual(copied, { copied: true, icon: "none", check: "block", text: "" }, "copied state " + JSON.stringify(copied));
        const clip = await page.evaluate(() => navigator.clipboard.readText());
        assert.equal(clip.trim(), "const answer = 42;", "clipboard " + JSON.stringify(clip));
        await page.waitForFunction(() => document.querySelector(".code .copy").getAttribute("aria-label") === "Copy code", null, { timeout: 3000 });
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });

  await check("light mode controls use the light tokens", async () => {
    const dir = project("light-controls");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hello]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip light controls: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.addInitScript(() => localStorage.setItem("gm-appearance", "light"));
      const surfaces = () => page.evaluate(() => {
        const threshold = 0.45;
        const lin = (channel) => {
          const x = channel / 255;
          return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
        };
        const paint = (bg) => {
          const match = String(bg || "").match(/rgba?\(([^)]+)\)/);
          if (!match) return null;
          const parts = match[1].split(",").map((part) => Number.parseFloat(part));
          const alpha = parts.length > 3 ? parts[3] : 1;
          if (!(alpha > 0)) return null;
          const cover = alpha >= 0.98 ? 1 : alpha;
          const rest = 1 - cover;
          return {
            r: parts[0] * cover + 255 * rest,
            g: parts[1] * cover + 255 * rest,
            b: parts[2] * cover + 255 * rest,
          };
        };
        const luminance = (bg) => {
          const rgb = paint(bg);
          if (!rgb) return null;
          return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
        };
        const resolved = (el, value) => {
          const probe = document.createElement("span");
          probe.style.backgroundColor = value;
          (el || document.body).append(probe);
          const bg = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return bg;
        };
        const accentButton = (el) => el.matches("button.primary, button.set-done, .appearance-opt.on, #jump, .sk-btn.primary, #send:not(.stop-mode), .row-delete, .confirm-go.danger");
        const overlay = document.querySelector("#setsheet:not([hidden]), #sheet:not([hidden]), .picker");
        const seen = new Set();
        const bad = [];
        const consider = (el) => {
          if (seen.has(el) || accentButton(el)) return;
          if (el.closest("[hidden]")) return;
          if (el.matches("#composer #input, input[type='checkbox'], input[type='radio'], input[type='file'], input[type='hidden']")) return;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return;
          const inside = !!(overlay && overlay.contains(el));
          if (!inside) {
            const rect = el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) return;
            const x = Math.min(Math.max(rect.left + rect.width / 2, 0), window.innerWidth - 1);
            const y = Math.min(Math.max(rect.top + Math.min(rect.height / 2, 20), 0), window.innerHeight - 1);
            if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
            const top = document.elementFromPoint(x, y);
            if (!top || (top !== el && !el.contains(top) && !top.contains(el))) return;
          }
          seen.add(el);
          const value = luminance(style.backgroundColor);
          if (value == null || value >= threshold) return;
          const text = (el.getAttribute("aria-label") || el.innerText || el.id || el.className || "").toString().trim().replace(/\s+/g, " ").slice(0, 40);
          bad.push(value.toFixed(2) + " " + el.tagName.toLowerCase() + (text ? " " + text : "") + " " + style.backgroundColor);
        };
        const selector = "button, input, textarea, select, .sheet-panel, .set-panel, .keys-box, .picker, .swatch, .composer-bar";
        for (const el of document.querySelectorAll(selector)) consider(el);
        const card = resolved(document.documentElement, "var(--chat-card)");
        const inset = resolved(document.documentElement, "var(--chat-bg)");
        const name = document.querySelector("#setsheet:not([hidden]) #set-name");
        const segment = [...document.querySelectorAll("#setsheet:not([hidden]) .appearance-opt")].find((el) => !el.classList.contains("on"));
        const swatches = [...document.querySelectorAll("#setsheet:not([hidden]) .swatch, .picker:not([hidden]) .swatch")];
        const stripes = swatches.map((swatch) => {
          const bar = swatch.querySelector(".sw-bar");
          return {
            card: getComputedStyle(swatch).backgroundColor === inset,
            stripe: !!bar && getComputedStyle(bar).backgroundColor === resolved(swatch, "var(--sw-accent)"),
            different: !!bar && getComputedStyle(bar).backgroundColor !== getComputedStyle(swatch).backgroundColor,
          };
        });
        return {
          appearance: document.documentElement.dataset.appearance,
          bad,
          card,
          name: name ? getComputedStyle(name.closest(".set-card")).backgroundColor : "",
          segment: segment ? getComputedStyle(segment).backgroundColor : "",
          stripes,
        };
      });
      const assertSurface = async (where, shape = {}) => {
        const report = await surfaces();
        assert.equal(report.appearance, "light", where);
        assert.deepEqual(report.bad, [], where + " " + report.bad.join(" | "));
        // The name is the card (no box in the box); theme tiles are inset on the page colour, both from the tokens.
        if (shape.name) assert.equal(report.name, report.card, where + " name " + JSON.stringify(report));
        if (shape.segment) assert.equal(report.segment, report.card, where + " segment " + JSON.stringify(report));
        if (shape.themes) {
          assert.ok(report.stripes.length > 0, where + " themes " + JSON.stringify(report));
          assert.ok(report.stripes.every((stripe) => stripe.card && stripe.stripe && stripe.different), where + " stripes " + JSON.stringify(report));
        }
        return report;
      };
      await page.goto(BASE + "/s/" + id, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#composer:not([hidden]) .composer-bar");
      await page.waitForFunction(() => document.documentElement.dataset.appearance === "light");
      await assertSurface("chat");
      await openSessionSettings(page);
      await page.waitForSelector("#setsheet:not([hidden]) #set-name");
      await page.waitForSelector("#setsheet .swatch");
      await assertSurface("session settings", { name: true, segment: true, themes: true });
      await page.locator("#setsheet .set-done").click();
      await page.waitForSelector("#setsheet", { state: "hidden" });
      await page.locator("#optbar [data-mode]").click();
      await page.waitForSelector("#sheet:not([hidden]) .sheet-item");
      await assertSurface("mode");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#sheet", { state: "hidden" });
      await page.locator("#optbar [data-reasoning]").click();
      await page.waitForSelector("#sheet:not([hidden]) .sheet-item");
      await assertSurface("reasoning");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#sheet", { state: "hidden" });
      await page.locator("#attach").click();
      await page.waitForSelector("#sheet:not([hidden]) .sheet-item");
      await assertSurface("menu");
      await page.locator("#sheet .sheet-item").filter({ hasText: /Skeptical review/ }).click();
      await page.locator("#sheet .sheet-item").filter({ hasText: "Review this turn now" }).waitFor();
      await assertSurface("skeptical review");
      await page.locator("#sheet .sheet-item").filter({ hasText: /^Back$/ }).click();
      await page.locator("#sheet .sheet-item").filter({ hasText: "Add photo" }).waitFor();
      await assertSurface("menu again");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#sheet", { state: "hidden" });
      await page.locator("#optbar [data-mode]").click();
      await page.waitForSelector("#sheet:not([hidden]) .sheet-item");
      await page.locator("#sheet .sheet-item").filter({ hasText: /^Loops/ }).click();
      await page.waitForSelector("#sheet input[aria-label='Loop interval']");
      await assertSurface("loops");
      await page.keyboard.press("Escape");
      await page.waitForSelector("#sheet", { state: "hidden" });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[aria-label='App settings']");
      await assertSurface("list");
      await page.locator("[aria-label='App settings']").click();
      await page.waitForSelector("#setsheet:not([hidden]) .swatch");
      await page.waitForFunction(() => document.querySelectorAll("#setsheet select").length >= 1);
      await assertSurface("app settings", { segment: true, themes: true });
      await page.locator("#setsheet .set-done").click();
      await page.waitForSelector("#setsheet", { state: "hidden" });
      await page.goto(BASE + "/new", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("[aria-label='Browse folders']");
      await assertSurface("new session");
      await page.locator("[aria-label='Browse folders']").click();
      await page.waitForSelector(".picker");
      await assertSurface("folder picker");
      await page.locator(".picker").getByRole("button", { name: "Cancel" }).click();
      await page.waitForSelector(".picker", { state: "hidden" });
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("sessions list shows plan quota from billing", async () => {
    const dir = project("plan-quota");
    const started = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hi]]", permissionMode: "default", skeptic: "off" });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    await idle(started.json.sessionId);
    const before = spawns();
    const first = await api("GET", "/api/account");
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.deepEqual(first.json, { available: true, percent: 42, period: "week", label: "42% this week" });
    assert.equal(spawns(), before + 1, "billing starts one agent");
    const second = await api("GET", "/api/account");
    assert.deepEqual(second.json, first.json);
    assert.equal(spawns(), before + 1, "a second read uses the cache");
    const listed = await api("GET", "/api/sessions");
    assert.equal(JSON.stringify(listed.json).includes("this week"), false);
    const again = await api("POST", "/api/turns", { cwd: dir, prompt: "[[say hi]]", permissionMode: "default", skeptic: "off" });
    assert.equal(again.status, 200, JSON.stringify(again.json));
    await idle(again.json.sessionId);
    const afterTurn = spawns();
    const third = await api("GET", "/api/account");
    assert.deepEqual(third.json, first.json);
    assert.equal(spawns(), afterTurn + 1, "quota refreshes after a turn");
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip plan quota layout: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      const readMeter = (root) => page.evaluate((sel) => {
        const box = document.querySelector(sel);
        if (!box || box.hidden) return null;
        const label = box.querySelector(".plan-usage-label");
        const track = box.querySelector(".plan-usage-track");
        const fill = box.querySelector(".plan-usage-fill");
        const probe = document.createElement("span");
        probe.style.color = "var(--chat-fg-dim)";
        probe.style.background = "var(--chat-line)";
        document.body.append(probe);
        const dim = getComputedStyle(probe).color;
        const line = getComputedStyle(probe).backgroundColor;
        probe.style.background = "var(--chat-fg)";
        const ink = getComputedStyle(probe).backgroundColor;
        probe.remove();
        const foot = box.parentElement;
        return {
          label: label.textContent,
          width: fill.style.width,
          hidden: box.hidden,
          pos: getComputedStyle(box).position,
          labelColor: getComputedStyle(label).color,
          track: getComputedStyle(track).backgroundColor,
          fill: getComputedStyle(fill).backgroundColor,
          dim,
          line,
          ink,
          aria: track.getAttribute("aria-label"),
          now: track.getAttribute("aria-valuenow"),
          last: foot.lastElementChild === box,
          foot: foot.classList.contains("side-foot"),
        };
      }, root);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.locator("#main .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      const phone = await readMeter("#main .plan-usage");
      assert.equal(phone.label, "42% this week");
      assert.equal(phone.width, "42%");
      assert.equal(phone.pos, "static");
      assert.equal(phone.hidden, false);
      assert.equal(phone.labelColor, phone.dim);
      assert.equal(phone.track, phone.line);
      assert.equal(phone.fill, phone.ink);
      assert.equal(phone.aria, "42% this week");
      assert.equal(phone.now, "42");
      assert.equal(phone.last, true);
      assert.equal(phone.foot, false);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.locator("#side .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      const desk = await readMeter("#side .plan-usage");
      assert.equal(desk.label, "42% this week");
      assert.equal(desk.width, "42%");
      assert.equal(desk.pos, "static");
      assert.equal(desk.last, true);
      assert.equal(desk.foot, true);
      assert.equal(desk.labelColor, desk.dim);
      assert.equal(desk.track, desk.line);
      assert.equal(desk.fill, desk.ink);
      const sideHidden = await page.evaluate(() => document.querySelector("#main .plan-usage"));
      assert.equal(sideHidden, null);
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("sessions list is grouped and does not overflow", async () => {
    const sessionDir = (id) => fs.readdirSync(path.join(GHOME, "sessions"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(GHOME, "sessions", entry.name, id))
      .find((candidate) => fs.existsSync(path.join(candidate, "summary.json")));
    const longName = "Name".repeat(30);
    assert.equal(longName.length, 120);
    const oldTitle = "EarlierListPolish";
    const todayDir = project("list-polish");
    const started = await api("POST", "/api/turns", {
      cwd: todayDir,
      prompt: "[[say " + "snippet ".repeat(40) + "]]",
      permissionMode: "default",
      skeptic: "off",
    });
    assert.equal(started.status, 200, JSON.stringify(started.json));
    const id = started.json.sessionId;
    await idle(id);
    const renamed = await api("PATCH", "/api/sessions/" + id, { title: longName });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    const olderDir = project("list-polish-old");
    const older = await api("POST", "/api/turns", {
      cwd: olderDir,
      prompt: "[[say older note]]",
      permissionMode: "default",
      skeptic: "off",
    });
    assert.equal(older.status, 200, JSON.stringify(older.json));
    const oldId = older.json.sessionId;
    await idle(oldId);
    const oldNamed = await api("PATCH", "/api/sessions/" + oldId, { title: oldTitle });
    assert.equal(oldNamed.status, 200, JSON.stringify(oldNamed.json));
    const oldPath = sessionDir(oldId);
    assert.ok(oldPath, "session dir for the earlier row");
    const summary = JSON.parse(fs.readFileSync(path.join(oldPath, "summary.json"), "utf8"));
    summary.updated_at = new Date(Date.now() - 2 * 86400000).toISOString();
    fs.writeFileSync(path.join(oldPath, "summary.json"), JSON.stringify(summary));
    const listed = await api("GET", "/api/sessions");
    const row = (listed.json.sessions || []).find((item) => item.id === id);
    const oldRow = (listed.json.sessions || []).find((item) => item.id === oldId);
    assert.equal(row && row.title, longName);
    assert.equal(typeof row.snippet, "string");
    assert.equal(row.snippet.includes("\n"), false);
    assert.equal(row.snippet.includes("snippet"), true);
    assert.equal(row.snippet.endsWith("..."), true);
    assert.ok(row.snippet.length <= 140, "snippet length " + row.snippet.length);
    assert.equal(oldRow && oldRow.snippet.includes("older note"), true);
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip sessions list layout: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      const measure = (mode) => page.evaluate(({ mode, longName, oldTitle }) => {
        const problems = [];
        const slack = 1;
        const phone = mode === "phone";
        const grows = (el) => !!el && el.scrollWidth > el.clientWidth + slack;
        const labelOf = (el) => (el && el.id) || (el ? el.tagName.toLowerCase() : "missing");
        for (const el of [document.documentElement, document.body, document.querySelector("#app"), document.querySelector("#main")]) {
          if (grows(el)) problems.push(labelOf(el) + " scrolls horizontally " + el.scrollWidth + ">" + el.clientWidth);
        }
        const side = document.querySelector("#side");
        if (side && !side.hidden && getComputedStyle(side).display !== "none" && grows(side)) {
          problems.push("side scrolls horizontally " + side.scrollWidth + ">" + side.clientWidth);
        }
        const probe = document.createElement("span");
        document.body.append(probe);
        const paint = (prop, token) => {
          probe.style.color = "";
          probe.style.background = "";
          probe.style[prop] = token;
          const style = getComputedStyle(probe);
          return prop === "color" ? style.color : style.backgroundColor;
        };
        const fg = paint("color", "var(--chat-fg)");
        const dim = paint("color", "var(--chat-fg-dim)");
        const bg = paint("backgroundColor", "var(--chat-bg)");
        const card = paint("backgroundColor", "var(--chat-card)");
        const ink = paint("backgroundColor", "var(--chat-fg)");
        const paper = paint("color", "var(--chat-bg)");
        probe.remove();
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        if (bodyBg !== bg) problems.push("body bg " + bodyBg);
        const root = phone ? document.querySelector("#main") : document.querySelector("#side");
        const titleSel = phone ? ".row-title" : ".side-title";
        const labels = [...root.querySelectorAll(".list-group")].map((el) => el.textContent);
        if (labels[0] !== "Today" || labels.indexOf("Earlier") < labels.indexOf("Today")) problems.push("groups " + labels.join(", "));
        const rows = [...root.querySelectorAll(phone ? "button.row" : ".side-row")];
        if (!rows.length) problems.push("no rows");
        const frame = root.getBoundingClientRect();
        for (const item of rows) {
          const height = Math.round(item.getBoundingClientRect().height);
          const name = (item.querySelector(titleSel)?.textContent || "").slice(0, 20);
          if (height < 56 || height > 64) problems.push("row height " + height + " " + name);
          const box = item.getBoundingClientRect();
          if (box.width > 2 && (box.left < frame.left - slack || box.right > frame.right + slack)) {
            problems.push("row leaves the frame " + name);
          }
        }
        const title = [...root.querySelectorAll(titleSel)].find((el) => el.textContent === longName);
        if (!title) problems.push("missing long name");
        else {
          const row = title.closest(phone ? "button.row" : ".side-row");
          const style = getComputedStyle(title);
          if (style.fontWeight !== "600") problems.push("title weight " + style.fontWeight);   // the one bold weight
          if (style.whiteSpace !== "nowrap") problems.push("title white-space " + style.whiteSpace);
          if (style.textOverflow !== "ellipsis") problems.push("title ellipsis " + style.textOverflow);
          if (style.color !== fg) problems.push("title color " + style.color);
          if (title.scrollWidth <= title.clientWidth + slack) problems.push("long name fits without clipping " + title.scrollWidth + "<=" + title.clientWidth);
          const snippet = row.querySelector(phone ? ".row-snippet" : ".side-snippet");
          const snippetStyle = getComputedStyle(snippet);
          if (snippetStyle.whiteSpace !== "nowrap") problems.push("snippet white-space " + snippetStyle.whiteSpace);
          if (snippetStyle.color !== dim) problems.push("snippet color " + snippetStyle.color);
          if (!snippet.textContent.includes("snippet")) problems.push("snippet text missing");
          if (snippet.getClientRects().length > 1) problems.push("snippet draws " + snippet.getClientRects().length + " lines");
          const status = row.querySelector(phone ? ".row-status" : ".side-status");
          if (status.textContent !== "Idle") problems.push("status " + status.textContent);
          if (getComputedStyle(status).whiteSpace !== "nowrap") problems.push("status wraps");
          const time = row.querySelector(phone ? ".row-time" : ".side-time");
          if (!time || !/^(just now|\d+[mhd])$/.test(time.textContent)) problems.push("time " + (time && time.textContent));
          const dot = row.querySelector(phone ? ".row-dot" : ".side-dot");
          const dotBox = dot.getBoundingClientRect();
          if (Math.round(dotBox.width) !== 10 || Math.round(dotBox.height) !== 10) problems.push("dot " + dotBox.width + "x" + dotBox.height);
          let group = (row.closest(".row-wrap") || row).previousElementSibling;
          while (group && !group.classList.contains("list-group")) group = group.previousElementSibling;
          if (!group || group.textContent !== "Today") problems.push("long name group " + (group && group.textContent));
        }
        const old = [...root.querySelectorAll(titleSel)].find((el) => el.textContent === oldTitle);
        if (!old) problems.push("missing earlier row");
        else {
          const row = old.closest(phone ? "button.row" : ".side-row");
          let group = (row.closest(".row-wrap") || row).previousElementSibling;
          while (group && !group.classList.contains("list-group")) group = group.previousElementSibling;
          if (!group || group.textContent !== "Earlier") problems.push("earlier group " + (group && group.textContent));
        }
        const fresh = document.querySelector(phone ? "button.list-new" : "#side button.side-new");
        if (!fresh || fresh.getAttribute("aria-label") !== "New session") problems.push("new session control missing");
        else if (phone) {
          const style = getComputedStyle(fresh);
          if (style.backgroundColor !== ink) problems.push("new session fill " + style.backgroundColor);
          if (style.color !== paper) problems.push("new session text " + style.color);
          if (parseFloat(style.borderTopLeftRadius) < 20) problems.push("new session radius " + style.borderTopLeftRadius);
          if (fresh.getBoundingClientRect().height < 44) problems.push("new session height " + Math.round(fresh.getBoundingClientRect().height));
        } else {
          const fill = getComputedStyle(fresh).backgroundColor;
          const parts = (fill.match(/rgba?\(([^)]+)\)/) || [])[1];
          const alpha = parts && parts.split(",").length > 3 ? Number.parseFloat(parts.split(",")[3]) : (fill === "rgba(0, 0, 0, 0)" ? 0 : 1);
          if (alpha > 0) problems.push("new session is filled " + fill);
        }
        const search = document.querySelector(phone ? ".list-search" : ".side-search");
        if (!search || search.getAttribute("aria-label") !== "Search sessions") problems.push("search missing");
        else if (getComputedStyle(search).backgroundColor !== card) problems.push("search bg " + getComputedStyle(search).backgroundColor);
        if (phone) {
          const screen = document.querySelector(".list-screen");
          const usage = document.querySelector("#main .plan-usage");
          const list = document.querySelector(".list-body");
          const space = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-4"));
          const edge = document.querySelector("#app").getBoundingClientRect().left + space;
          for (const [name, el] of [
            ["title", document.querySelector("#top h1")],
            ["search", document.querySelector(".list-search")],
            ["row", document.querySelector("button.row")],
            ["new", fresh],
          ]) {
            if (!el) problems.push("missing " + name + " for the left edge");
            else {
              const left = el.getBoundingClientRect().left;
              if (Math.abs(left - edge) > slack) problems.push(name + " left " + Math.round(left) + " expected " + edge);
            }
          }
          const foot = document.querySelector(".list-foot");
          if (!screen || !foot || !usage || usage.parentElement !== foot || screen.lastElementChild !== foot) problems.push("phone usage is not in the footer");
          if (list && usage && list.contains(usage)) problems.push("phone usage scrolls with the list");
          if (usage && getComputedStyle(usage).position !== "static") problems.push("phone usage position " + getComputedStyle(usage).position);
          if (foot && getComputedStyle(foot).position !== "static") problems.push("phone footer position " + getComputedStyle(foot).position);
          const scrolling = list && getComputedStyle(list);
          if (!scrolling || (scrolling.overflowY !== "auto" && scrolling.overflowY !== "scroll")) problems.push("list does not scroll");
          if (parseFloat(scrolling && scrolling.flexGrow) < 1) problems.push("list does not fill the column");
          const appPad = getComputedStyle(document.querySelector("#app")).paddingBottom;
          if (appPad !== "0px") problems.push("shell also pads the safe area " + appPad);
          const probe = document.createElement("div");
          probe.style.paddingBottom = "env(safe-area-inset-bottom)";
          document.body.append(probe);
          const inset = getComputedStyle(probe).paddingBottom;
          probe.remove();
          // The footer carries the safe area once, plus 12px of its own.
          if (foot && parseFloat(getComputedStyle(foot).paddingBottom) !== parseFloat(inset) + 12) problems.push("footer inset " + getComputedStyle(foot).paddingBottom);
          if (foot && !usage.hidden) {
            const box = foot.getBoundingClientRect();
            const frame = document.querySelector("#app").getBoundingClientRect();
            if (box.top < frame.top - slack || box.bottom > frame.bottom + slack) problems.push("footer leaves the page");
          }
        } else {
          const foot = document.querySelector("#side .side-foot");
          const usage = document.querySelector("#side .plan-usage");
          const sideList = document.querySelector(".side-list");
          if (!foot || !usage || foot.lastElementChild !== usage) problems.push("desktop usage is not last");
          if (sideList && usage && sideList.contains(usage)) problems.push("desktop usage scrolls with the list");
          if (usage && getComputedStyle(usage).position !== "static") problems.push("desktop usage position " + getComputedStyle(usage).position);
          if (foot) {
            const box = foot.getBoundingClientRect();
            const frame = document.querySelector("#side").getBoundingClientRect();
            if (box.top < frame.top - slack || box.bottom > frame.bottom + slack) problems.push("desktop footer leaves the sidebar");
          }
          if (document.querySelector("#main .plan-usage") || document.querySelector("#main .row")) problems.push("desktop repeats the list");
        }
        return problems;
      }, mode);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.locator(".row-title", { hasText: longName }).waitFor();
      await page.locator("#main .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      const phoneProblems = await measure({ mode: "phone", longName, oldTitle });
      for (const item of await paintedOverlaps(page)) phoneProblems.push("overlap " + item);
      await page.locator(".list-search").fill("zzz-no-such-session");
      await page.locator(".list-empty-title").filter({ hasText: "No matches" }).waitFor();
      const emptyPhone = await page.evaluate(() => {
        const problems = [];
        const slack = 1;
        const grows = (el) => !!el && el.scrollWidth > el.clientWidth + slack;
        for (const el of [document.documentElement, document.body, document.querySelector("#app"), document.querySelector("#main")]) {
          if (grows(el)) problems.push((el.id || el.tagName.toLowerCase()) + " scrolls horizontally");
        }
        const title = document.querySelector(".list-empty-title");
        const sub = document.querySelector(".list-empty-sub");
        if (!title || title.textContent !== "No matches") problems.push("empty title " + (title && title.textContent));
        if (!sub || sub.textContent !== "Try a different search.") problems.push("empty sub");
        return problems;
      });
      phoneProblems.push(...emptyPhone);
      await page.locator(".list-search").fill("");
      await page.locator(".row-title", { hasText: longName }).waitFor();
      await page.evaluate(() => localStorage.setItem("gm-appearance", "light"));
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.locator(".row-title", { hasText: longName }).waitFor();
      const lightPhone = await measure({ mode: "phone", longName, oldTitle });
      phoneProblems.push(...lightPhone.map((item) => "light " + item));
      for (const item of await paintedOverlaps(page)) phoneProblems.push("light overlap " + item);
      assert.deepEqual(phoneProblems, []);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.locator(".side-title", { hasText: longName }).waitFor();
      await page.locator("#side .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      const deskProblems = await measure({ mode: "desk", longName, oldTitle });
      for (const item of await paintedOverlaps(page)) deskProblems.push("overlap " + item);
      await page.locator(".side-search").fill("zzz-no-such-session");
      await page.locator("#side .list-empty-title").filter({ hasText: "No matches" }).waitFor();
      const emptyDesk = await page.evaluate(() => {
        const title = document.querySelector("#side .list-empty-title");
        const problems = [];
        const slack = 1;
        const side = document.querySelector("#side");
        if (side && side.scrollWidth > side.clientWidth + slack) problems.push("side scrolls horizontally");
        if (!title || title.textContent !== "No matches") problems.push("empty title");
        if (document.querySelector("#main .row")) problems.push("desktop repeats the list");
        return problems;
      });
      deskProblems.push(...emptyDesk);
      await page.locator(".side-search").fill("");
      await page.locator(".side-title", { hasText: longName }).waitFor();
      const restored = await measure({ mode: "desk", longName, oldTitle });
      deskProblems.push(...restored.map((item) => "restored " + item));
      assert.deepEqual(deskProblems, []);
      await page.close();
    } finally {
      await browser.close();
    }
  });

  await check("plan usage footer stays visible with 30 sessions", async () => {
    const dir = project("usage-foot");
    const ids = [];
    for (let i = 0; i < 30; i++) {
      const started = await api("POST", "/api/turns", {
        cwd: dir,
        prompt: "[[say footer row " + i + "]]",
        permissionMode: "default",
        skeptic: "off",
      });
      assert.equal(started.status, 200, JSON.stringify(started.json));
      ids.push(started.json.sessionId);
    }
    for (const id of ids) await idle(id);
    let chromium;
    try {
      ({ chromium } = await import("playwright"));
    } catch {
      try {
        ({ chromium } = await import(`${process.env.HOME}/.local/share/mise/installs/npm-playwright/1.64.0/node_modules/playwright/index.mjs`));
      } catch {
        console.log("  skip usage footer: playwright is not installed");
        return;
      }
    }
    const chrome = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`;
    const browser = await chromium.launch({ headless: true, executablePath: fs.existsSync(chrome) ? chrome : undefined });
    try {
      const token = cookie.split("=")[1];
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      await page.context().addCookies([{ name: "gm_session", value: token, url: BASE, httpOnly: true, sameSite: "Strict" }]);
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.locator("#main .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      await page.locator("button.row").nth(29).waitFor();
      const phone = await page.evaluate(() => {
        const problems = [];
        const slack = 1;
        const list = document.querySelector(".list-body");
        const foot = document.querySelector(".list-foot");
        const usage = document.querySelector("#main .plan-usage");
        const rows = document.querySelectorAll("button.row");
        if (rows.length < 30) problems.push("rows " + rows.length);
        if (!list || !foot || !usage) problems.push("footer missing");
        else {
          if (list.contains(usage) || usage.parentElement !== foot) problems.push("usage is not the footer");
          if (getComputedStyle(usage).position !== "static" || getComputedStyle(foot).position !== "static") problems.push("footer is taken out of flow");
          if (list.scrollHeight <= list.clientHeight + slack) problems.push("list does not overflow");
          const frame = document.querySelector("#app").getBoundingClientRect();
          const before = foot.getBoundingClientRect();
          if (before.bottom > frame.bottom + slack || before.top < frame.top) problems.push("footer starts off the page");
          const last = rows[rows.length - 1].getBoundingClientRect();
          if (last.bottom <= list.getBoundingClientRect().bottom + slack) problems.push("the long list fits without scrolling");
          list.scrollTop = list.scrollHeight;
          const after = foot.getBoundingClientRect();
          if (Math.abs(after.top - before.top) > slack || Math.abs(after.bottom - before.bottom) > slack) problems.push("footer moved when the list scrolled");
          if (list.scrollTop <= 0) problems.push("list did not scroll");
          if (document.querySelector("#main").scrollTop !== 0) problems.push("the page scrolled instead of the list");
        }
        return problems;
      });
      assert.deepEqual(phone, []);
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
      await page.locator("#side .plan-usage-label").filter({ hasText: "42% this week" }).waitFor();
      await page.locator(".side-row").nth(29).waitFor();
      const desk = await page.evaluate(() => {
        const problems = [];
        const slack = 1;
        const list = document.querySelector(".side-list");
        const foot = document.querySelector("#side .side-foot");
        const usage = document.querySelector("#side .plan-usage");
        if (!list || !foot || !usage || usage.parentElement !== foot) problems.push("desktop footer missing");
        else if (list.scrollHeight <= list.clientHeight + slack) problems.push("sidebar list does not overflow");
        else {
          const frame = document.querySelector("#side").getBoundingClientRect();
          const before = foot.getBoundingClientRect();
          if (before.bottom > frame.bottom + slack || before.top < frame.top) problems.push("desktop footer starts off the sidebar");
          if (getComputedStyle(usage).position !== "static") problems.push("desktop usage position " + getComputedStyle(usage).position);
          list.scrollTop = list.scrollHeight;
          const after = foot.getBoundingClientRect();
          if (Math.abs(after.top - before.top) > slack || Math.abs(after.bottom - before.bottom) > slack) problems.push("desktop footer moved when the list scrolled");
        }
        return problems;
      });
      assert.deepEqual(desk, []);
      await page.close();
    } finally {
      await browser.close();
    }
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
